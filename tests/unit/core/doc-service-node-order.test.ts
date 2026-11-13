/**
 * DocService — 单节点子键排序覆盖（#41 / ADR-0024 修订 2026-11-13 / v1.1）。
 *
 * 契约要点：
 *   - 新命令 `setNodeOrder { rootId, path, order: SortOrder | null }` 走既有 `mutateRoot`
 *     （intent='view'，回包复用 `EditReply`，不新增回包类型）；
 *   - 版本纪律：只有覆盖真的变化才推 `rowVersion`，`docRevision` 不动（no-op 零抖动）；
 *   - 折叠容器上的覆盖变化也推 `rowVersion`（保证后续展开 / 大纲 / 其他视图一致）；
 *   - `outline` 按**被查询容器**的生效顺序分页（嵌套容器各用各的；数组恒索引序）；
 *   - 表达式根是独立 RowModel：覆盖不跨根共享。
 */
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { DocService } from '../../../src/core/doc-service';
import type { Command, LoadReply, LoadOptions } from '../../../src/protocol/messages';

async function errorOf(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (err) {
    return err as CoreError;
  }
  throw new Error('expected the command to reject');
}

async function load(svc: DocService, data: string, loadId = 1, opts?: LoadOptions): Promise<LoadReply> {
  return svc.dispatch({ t: 'load', loadId, source: 'paste', data, name: 'doc.json', opts });
}

function windowPaths(rows: { path: string }[]): string[] {
  return rows.map((row) => row.path);
}

async function windowOf(
  svc: DocService,
  rootId: string,
  rowVersion: number,
  count = 100,
): Promise<string[]> {
  const win = await svc.dispatch({ t: 'window', rootId, rowVersion, seq: 1, start: 0, count });
  return windowPaths(win.rows);
}

function stats(svc: DocService, rootId: string) {
  return svc.dispatch({ t: 'stats', rootId });
}

/** 单节点覆盖命令的简写。 */
function nodeOrder(
  rootId: string,
  path: string,
  order: 'raw' | 'key-asc' | 'key-desc' | null,
): Extract<Command, { t: 'setNodeOrder' }> {
  return { t: 'setNodeOrder', rootId, path, order };
}

describe('DocService — setNodeOrder：EditReply 版本纪律', () => {
  // { b: { z: 1, a: 2 }, c: 3 }：自适应全展开 → $, b, b.z, b.a, c（raw）
  const TEXT = JSON.stringify({ b: { z: 1, a: 2 }, c: 3 });

  it('changed 才推 rowVersion、docRevision 不动；no-op 零抖动；清覆盖回全局', async () => {
    const svc = new DocService();
    const loaded = await load(svc, TEXT);
    const before = await stats(svc, loaded.rootId);
    expect(before).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 5 });

    const set = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', 'key-asc'));
    expect(set).toEqual({
      rootId: loaded.rootId,
      docRevision: 1,
      rowVersion: before.rowVersion + 1,
      totalRows: 5,
      changedRow: 1,
      history: { applied: 0, canUndo: false, canRedo: false },
    });
    expect(await windowOf(svc, loaded.rootId, set.rowVersion)).toEqual([
      '$',
      '$.b',
      '$.b.a',
      '$.b.z',
      '$.c',
    ]);

    // 同覆盖 no-op：版本不动、无 changedRow、回包形状不变
    const again = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', 'key-asc'));
    expect(again).toEqual({
      rootId: loaded.rootId,
      docRevision: 1,
      rowVersion: set.rowVersion,
      totalRows: 5,
      history: { applied: 0, canUndo: false, canRedo: false },
    });

    // 清覆盖 → 回全局 raw（再次推版本）
    const cleared = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', null));
    expect(cleared).toMatchObject({ docRevision: 1, rowVersion: set.rowVersion + 1, changedRow: 1 });
    expect(await windowOf(svc, loaded.rootId, cleared.rowVersion)).toEqual([
      '$',
      '$.b',
      '$.b.z',
      '$.b.a',
      '$.c',
    ]);

    // 已无覆盖再清 → no-op，版本不动
    const clearAgain = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', null));
    expect(clearAgain).toMatchObject({ rowVersion: cleared.rowVersion });
    expect(clearAgain).not.toHaveProperty('changedRow');

    // setNodeOrder 全程不动内容版本 / 编辑历史（没有产生可撤销条目）
    expect(await stats(svc, loaded.rootId)).toMatchObject({ docRevision: 1, rowVersion: cleared.rowVersion });
    expect((await errorOf(svc.dispatch({ t: 'undo', rootId: loaded.rootId }))).code).toBe('NO_HISTORY');
  });

  it('根覆盖允许（changedRow=0）', async () => {
    const svc = new DocService();
    const loaded = await load(svc, TEXT);
    const set = await svc.dispatch(nodeOrder(loaded.rootId, '$', 'key-desc'));
    expect(set).toMatchObject({ docRevision: 1, rowVersion: 2, totalRows: 5, changedRow: 0 });
    // 根 desc：c > b → c 先；b 直接子键仍 raw
    expect(await windowOf(svc, loaded.rootId, set.rowVersion)).toEqual([
      '$',
      '$.c',
      '$.b',
      '$.b.z',
      '$.b.a',
    ]);
  });

  it('折叠容器上的覆盖也推 rowVersion；展开后按覆盖序', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ big: { k3: 1, k1: 2, k2: 3 }, x: 1 }), 1, {
      adaptiveExpand: false,
    });
    expect(await windowOf(svc, loaded.rootId, 1)).toEqual(['$', '$.big', '$.x']);

    const set = await svc.dispatch(nodeOrder(loaded.rootId, '$.big', 'key-desc'));
    expect(set).toMatchObject({ docRevision: 1, rowVersion: 2, totalRows: 3, changedRow: 1 });
    // 折叠态行序不变（行数也没变）
    expect(await windowOf(svc, loaded.rootId, set.rowVersion)).toEqual(['$', '$.big', '$.x']);

    // 展开后按覆盖序（k1 < k2 < k3 的自然序降序）
    const opened = await svc.dispatch({ t: 'toggle', rootId: loaded.rootId, path: '$.big', open: true });
    expect(opened).toMatchObject({ rowVersion: 3, totalRows: 6 });
    expect(await windowOf(svc, loaded.rootId, opened.rowVersion)).toEqual([
      '$',
      '$.big',
      '$.big.k3',
      '$.big.k2',
      '$.big.k1',
      '$.x',
    ]);
  });

  it('BAD_COMMAND（数组 / 标量 / 路径不存在）且不推版本', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ arr: [1, 2], s: 5 }));
    const before = await stats(svc, loaded.rootId);

    expect((await errorOf(svc.dispatch(nodeOrder(loaded.rootId, '$.arr', 'key-desc')))).code).toBe(
      'BAD_COMMAND',
    );
    expect((await errorOf(svc.dispatch(nodeOrder(loaded.rootId, '$.s', 'key-desc')))).code).toBe(
      'BAD_COMMAND',
    );
    expect((await errorOf(svc.dispatch(nodeOrder(loaded.rootId, '$.nope', 'key-desc')))).code).toBe(
      'BAD_COMMAND',
    );
    expect((await errorOf(svc.dispatch(nodeOrder(loaded.rootId, '$.arr[0]', 'key-desc')))).code).toBe(
      'BAD_COMMAND',
    );

    expect(await stats(svc, loaded.rootId)).toEqual(before);
  });
});

describe('DocService — outline 按容器覆盖顺序分页', () => {
  const TEXT = JSON.stringify({
    b: { z: 1, a: 2, m: 3 },
    a: { y: 1, x: 2 },
    arr: [3, 1, 2],
  });

  it('嵌套容器各用各的顺序；数组恒索引序；只读、total 不变', async () => {
    const svc = new DocService();
    const loaded = await load(svc, TEXT, 1, { adaptiveExpand: false });
    await svc.dispatch(nodeOrder(loaded.rootId, '$.b', 'key-desc'));
    const before = await stats(svc, loaded.rootId);

    // 根无覆盖 → 全局 raw（b, a, arr）
    const root = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$', start: 0, count: 10 });
    expect(root.children.map((child) => child.key)).toEqual(['b', 'a', 'arr']);
    expect(root.total).toBe(3);

    // $.b 覆盖 desc：z > m > a
    const b = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.b', start: 0, count: 10 });
    expect(b.children.map((child) => child.key)).toEqual(['z', 'm', 'a']);
    expect(b.total).toBe(3);

    // 分页按显示序切页
    const bMid = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.b', start: 1, count: 1 });
    expect(bMid).toMatchObject({ total: 3, start: 1 });
    expect(bMid.children.map((child) => child.key)).toEqual(['m']);

    // 未覆盖容器 / 数组走全局规则
    expect(
      (await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.a', start: 0, count: 10 })).children.map(
        (child) => child.key,
      ),
    ).toEqual(['y', 'x']);
    expect(
      (await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.arr', start: 0, count: 10 })).children.map(
        (child) => child.key,
      ),
    ).toEqual(['[0]', '[1]', '[2]']);

    // 只读：不推任何版本
    expect(await stats(svc, loaded.rootId)).toEqual(before);
  });

  it('全局切档后：覆盖节点仍按覆盖、未覆盖节点跟随新全局档', async () => {
    const svc = new DocService();
    const loaded = await load(svc, TEXT, 1, { adaptiveExpand: false });
    await svc.dispatch(nodeOrder(loaded.rootId, '$.b', 'raw'));
    await svc.dispatch({ t: 'setOrder', order: 'key-desc' });

    // 根 desc：b > arr > a；b 显式 raw（z, a, m）；a 跟随全局 desc（y > x）
    const root = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$', start: 0, count: 10 });
    expect(root.children.map((child) => child.key)).toEqual(['b', 'arr', 'a']);
    const b = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.b', start: 0, count: 10 });
    expect(b.children.map((child) => child.key)).toEqual(['z', 'a', 'm']);
    const a = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.a', start: 0, count: 10 });
    expect(a.children.map((child) => child.key)).toEqual(['y', 'x']);
  });
});

describe('DocService — setNodeOrder：全局切档保留覆盖 / 编辑替换回全局', () => {
  it('全局 setOrder 不清覆盖；清覆盖后改跟全局', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ b: { a: 1, z: 2 }, c: 3 }));
    // 显式 raw 覆盖（全局此刻也是 raw）
    const override = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', 'raw'));
    expect(override).toMatchObject({ rowVersion: 2 });

    const sorted = await svc.dispatch({ t: 'setOrder', order: 'key-desc' });
    const rootSnap = sorted.roots.find((root) => root.rootId === loaded.rootId);
    expect(rootSnap?.rowVersion).toBe(3);
    // 根 desc（c 先），b 覆盖 raw（a, z）
    expect(await windowOf(svc, loaded.rootId, 3)).toEqual(['$', '$.c', '$.b', '$.b.a', '$.b.z']);

    const cleared = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', null));
    expect(cleared).toMatchObject({ rowVersion: 4 });
    // 清覆盖后 b 跟随全局 desc（z, a）
    expect(await windowOf(svc, loaded.rootId, 4)).toEqual(['$', '$.c', '$.b', '$.b.z', '$.b.a']);
  });

  it('编辑替换（replaceNode）后覆盖自动失效 → 回全局规则', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ b: { z: 1, a: 2 } }));
    await svc.dispatch({ t: 'setOrder', order: 'key-asc' });
    const override = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', 'key-desc'));
    expect(override).toMatchObject({ rowVersion: 3 });
    expect(await windowOf(svc, loaded.rootId, 3)).toEqual(['$', '$.b', '$.b.z', '$.b.a']);

    const replaced = await svc.dispatch({
      t: 'replaceNode',
      rootId: loaded.rootId,
      path: '$.b',
      docRevision: 1,
      jsonText: '{"z":9,"a":8}',
    });
    expect(replaced).toMatchObject({ docRevision: 2, rowVersion: 4 });
    // 新对象无覆盖 → 全局 asc
    expect(await windowOf(svc, loaded.rootId, 4)).toEqual(['$', '$.b', '$.b.a', '$.b.z']);
    expect(
      (await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.b', start: 0, count: 10 })).children.map(
        (child) => child.key,
      ),
    ).toEqual(['a', 'z']);
  });
});

describe('DocService — 表达式根的覆盖独立', () => {
  it('doc 根的覆盖不影响 expr 根；expr 根可独立覆盖且版本互不影响', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ data: { z: 1, a: 2 }, z: 0 }));
    // doc 全展开 raw：$, data, data.z, data.a, z
    const evaled = await svc.dispatch({
      t: 'eval',
      rootId: loaded.rootId,
      seq: 1,
      text: '$.data',
      strict: false,
      budget: 'standard',
    });
    expect(evaled.ok).toBe(true);
    if (evaled.ok !== true) return;
    expect(evaled.rowVersion).toBe(1);
    expect(evaled.totalRows).toBe(3);

    // doc 根覆盖 data 升序 → 只影响 doc 树
    const docSet = await svc.dispatch(nodeOrder(loaded.rootId, '$.data', 'key-asc'));
    expect(docSet).toMatchObject({ docRevision: 1, rowVersion: 2 });
    expect(await windowOf(svc, loaded.rootId, 2)).toEqual([
      '$',
      '$.data',
      '$.data.a',
      '$.data.z',
      '$.z',
    ]);

    // expr 根是独立 RowModel：共享容器对象但覆盖表不共享 → 仍 raw
    expect(await stats(svc, evaled.rootId)).toMatchObject({ rowVersion: 1 });
    expect(await windowOf(svc, evaled.rootId, 1)).toEqual(['$', '$.z', '$.a']);

    // expr 根自己的覆盖：只推 expr 根版本
    const exprSet = await svc.dispatch(nodeOrder(evaled.rootId, '$', 'key-asc'));
    expect(exprSet).toMatchObject({ docRevision: 1, rowVersion: 2, totalRows: 3 });
    expect(await windowOf(svc, evaled.rootId, 2)).toEqual(['$', '$.a', '$.z']);
    // doc 根版本不受 expr 覆盖影响
    expect(await stats(svc, loaded.rootId)).toMatchObject({ rowVersion: 2 });
    // expr 根大纲按自己的覆盖顺序
    expect(
      (await svc.dispatch({ t: 'outline', rootId: evaled.rootId, path: '$', start: 0, count: 10 })).children.map(
        (child) => child.key,
      ),
    ).toEqual(['a', 'z']);
  });
});

describe('DocService — 编辑替换后覆盖失效（含 undo 恢复旧值）', () => {
  it('replaceNode → undo：旧值回来了也回全局规则（覆盖按编辑失效）', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ b: { z: 1, a: 2 } }));
    await svc.dispatch({ t: 'setOrder', order: 'key-asc' });
    const override = await svc.dispatch(nodeOrder(loaded.rootId, '$.b', 'key-desc'));
    expect(await windowOf(svc, loaded.rootId, override.rowVersion)).toEqual([
      '$',
      '$.b',
      '$.b.z',
      '$.b.a',
    ]);

    const replaced = await svc.dispatch({
      t: 'replaceNode',
      rootId: loaded.rootId,
      path: '$.b',
      docRevision: 1,
      jsonText: '{"z":9,"a":8}',
    });
    expect(await windowOf(svc, loaded.rootId, replaced.rowVersion)).toEqual([
      '$',
      '$.b',
      '$.b.a',
      '$.b.z',
    ]);

    const undone = await svc.dispatch({ t: 'undo', rootId: loaded.rootId });
    expect(undone).toMatchObject({ docRevision: 3 });
    // 旧对象 `{ z, a }` 回来了，但覆盖已在编辑时失效 → 全局 asc
    expect(await windowOf(svc, loaded.rootId, undone.rowVersion)).toEqual([
      '$',
      '$.b',
      '$.b.a',
      '$.b.z',
    ]);
    expect(
      (await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$.b', start: 0, count: 10 })).children.map(
        (child) => child.key,
      ),
    ).toEqual(['a', 'z']);
  });
});
