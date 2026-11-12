/**
 * DocService — 服务级显示顺序 / setOrder / rowOfPath（#40 / ADR-0024 §6）。
 *
 * 契约要点：
 *   - 服务级 `order`（默认 'raw'）：load 与 evalExpression 创建 RowModel 时套用；
 *   - `setOrder { order }` 全局生效：对**全部活根**重排并各自 `rowVersion++`；
 *     无变化时 `changed=false`（版本不动）但仍回全量 roots 快照；
 *   - `rowOfPath { rootId, path }` 只读：不推任何版本；祖先折叠 → -1；路径不存在 → BAD_COMMAND；
 *   - `outline` 透传 order（分页按显示序）。
 */
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { DocService } from '../../../src/core/doc-service';
import type { LoadReply, LoadOptions } from '../../../src/protocol/messages';
import type { SortOrder } from '../../../src/protocol/types';

async function errorOf(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (err) {
    return err as CoreError;
  }
  throw new Error('expected the command to reject');
}

async function load(
  svc: DocService,
  data: string,
  loadId = 1,
  opts?: LoadOptions,
): Promise<LoadReply> {
  return svc.dispatch({ t: 'load', loadId, source: 'paste', data, name: 'doc.json', opts });
}

function windowPaths(rows: { path: string }[]): string[] {
  return rows.map((row) => row.path);
}

async function windowOf(svc: DocService, reply: LoadReply | { rootId: string; rowVersion: number }, count = 100) {
  return svc.dispatch({
    t: 'window',
    rootId: reply.rootId,
    rowVersion: reply.rowVersion,
    seq: 1,
    start: 0,
    count,
  });
}

describe('DocService — 服务级 order（默认 raw / 建根时套用）', () => {
  it('默认 raw：load 后行序 = 值图键序', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ b: 1, a: 2 }));
    expect(windowPaths((await windowOf(svc, loaded)).rows)).toEqual(['$', '$.b', '$.a']);
  });

  it('load 前 setOrder：新 doc 根按该档建行模型（roots 空时 changed=true）', async () => {
    const svc = new DocService();
    expect(await svc.dispatch({ t: 'setOrder', order: 'key-asc' })).toEqual({
      order: 'key-asc',
      changed: true,
      roots: [],
    });

    const loaded = await load(svc, JSON.stringify({ b: 1, a: 2 }));
    expect(windowPaths((await windowOf(svc, loaded)).rows)).toEqual(['$', '$.a', '$.b']);

    // 后续 load 也继承服务级 order
    const next = await load(svc, JSON.stringify({ y: 1, x: 2 }), 2);
    expect(windowPaths((await windowOf(svc, next)).rows)).toEqual(['$', '$.x', '$.y']);
  });

  it('表达式结果根也套用服务级 order', async () => {
    const svc = new DocService();
    await svc.dispatch({ t: 'setOrder', order: 'key-desc' });
    const loaded = await load(svc, JSON.stringify({ data: { b: 1, a: 2 }, z: 0 }));

    // doc 根（自适应全展开）按降序：z > data；data 子键 b > a
    expect(windowPaths((await windowOf(svc, loaded)).rows)).toEqual([
      '$',
      '$.z',
      '$.data',
      '$.data.b',
      '$.data.a',
    ]);

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
    // expr 根引用原对象 {b, a}：新根未自适应展开，但顶层键按降序
    expect(evaled.totalRows).toBe(3);
    const win = await svc.dispatch({
      t: 'window',
      rootId: evaled.rootId,
      rowVersion: evaled.rowVersion,
      seq: 2,
      start: 0,
      count: 10,
    });
    expect(windowPaths(win.rows)).toEqual(['$', '$.b', '$.a']);
  });
});

describe('DocService — setOrder（全局 / 版本推进 / 幂等）', () => {
  it('对全部活根重排并各自 rowVersion++，docRevision 不动；旧 rowVersion → STALE_ROOT', async () => {
    const svc = new DocService();
    const d1 = await load(svc, JSON.stringify({ data: { a: 1, b: 2 } }), 1);
    const d2 = await load(svc, JSON.stringify({ data: { a: 1, b: 2 } }), 2);
    const evaled = await svc.dispatch({
      t: 'eval',
      rootId: d1.rootId,
      seq: 1,
      text: '$.data',
      strict: false,
      budget: 'standard',
    });
    expect(evaled.ok).toBe(true);
    if (evaled.ok !== true) return;

    const reply = await svc.dispatch({ t: 'setOrder', order: 'key-desc' });
    expect(reply).toEqual({
      order: 'key-desc',
      changed: true,
      roots: [
        { rootId: d1.rootId, rowVersion: 2, totalRows: 4 },
        { rootId: d2.rootId, rowVersion: 2, totalRows: 4 },
        { rootId: evaled.rootId, rowVersion: 2, totalRows: 3 },
      ],
    });

    // 每个活根都按新档出窗口
    expect(windowPaths((await windowOf(svc, { ...d1, rowVersion: 2 })).rows)).toEqual([
      '$',
      '$.data',
      '$.data.b',
      '$.data.a',
    ]);
    expect(windowPaths((await windowOf(svc, { ...d2, rowVersion: 2 })).rows)).toEqual([
      '$',
      '$.data',
      '$.data.b',
      '$.data.a',
    ]);
    expect(windowPaths((await windowOf(svc, { ...evaled, rowVersion: 2 })).rows)).toEqual(['$', '$.b', '$.a']);

    // 旧版本一律失效（rowVersion 是行映射唯一失效令牌）
    expect(
      (await errorOf(svc.dispatch({ t: 'window', rootId: d1.rootId, rowVersion: 1, seq: 1, start: 0, count: 5 })))
        .code,
    ).toBe('STALE_ROOT');

    // 只推行版本、不推内容版本
    expect(await svc.dispatch({ t: 'stats', rootId: d1.rootId })).toMatchObject({
      docRevision: 1,
      rowVersion: 2,
    });
  });

  it('幂等：同档 changed=false、版本不动，但仍回全量 roots 快照', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ a: 1, b: 2 }));
    await svc.dispatch({ t: 'setOrder', order: 'key-asc' });
    const before = await svc.dispatch({ t: 'stats', rootId: loaded.rootId });

    const again = await svc.dispatch({ t: 'setOrder', order: 'key-asc' });
    expect(again).toEqual({
      order: 'key-asc',
      changed: false,
      roots: [{ rootId: loaded.rootId, rowVersion: before.rowVersion, totalRows: 3 }],
    });
    expect(await svc.dispatch({ t: 'stats', rootId: loaded.rootId })).toEqual(before);
  });

  it('非法档位归一化为 raw：order 回落、算一次真实切档', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ a: 1, b: 2 }));
    await svc.dispatch({ t: 'setOrder', order: 'key-asc' });
    const asc = await svc.dispatch({ t: 'stats', rootId: loaded.rootId });

    const reply = await svc.dispatch({ t: 'setOrder', order: 'nope' as unknown as SortOrder });
    expect(reply).toMatchObject({ order: 'raw', changed: true });
    expect(reply.roots[0]).toEqual({
      rootId: loaded.rootId,
      rowVersion: asc.rowVersion + 1,
      totalRows: 3,
    });
    // 回落 raw 后行序回到值图序
    const win = await svc.dispatch({
      t: 'window',
      rootId: loaded.rootId,
      rowVersion: reply.roots[0]?.rowVersion as number,
      seq: 1,
      start: 0,
      count: 5,
    });
    expect(windowPaths(win.rows)).toEqual(['$', '$.a', '$.b']);

    // 已是 raw 再发非法值 → no-op
    const noop = await svc.dispatch({ t: 'setOrder', order: 'bogus' as unknown as SortOrder });
    expect(noop).toMatchObject({ order: 'raw', changed: false });
  });

  it('只覆盖活根：closeRoot 掉的不再出现在 roots 快照里', async () => {
    const svc = new DocService();
    const a = await load(svc, JSON.stringify({ a: 1 }), 1);
    const b = await load(svc, JSON.stringify({ b: 1 }), 2);
    await svc.dispatch({ t: 'closeRoot', rootId: a.rootId });

    const reply = await svc.dispatch({ t: 'setOrder', order: 'key-asc' });
    expect(reply.roots.map((root) => root.rootId)).toEqual([b.rootId]);
  });
});

describe('DocService — rowOfPath（只读 / 折叠 / 错误）', () => {
  /** 关掉自适应展开 → 容器保持折叠，能覆盖「祖先折叠 → -1」。 */
  const NESTED = JSON.stringify({ outer: { b: 1, a: 2 }, last: 3 });

  it('可见行号 / 祖先折叠 -1 / 根 0 / 只读不推版本', async () => {
    const svc = new DocService();
    const loaded = await load(svc, NESTED, 1, { adaptiveExpand: false });
    const before = await svc.dispatch({ t: 'stats', rootId: loaded.rootId });

    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$' })).toEqual({
      rootId: loaded.rootId,
      row: 0,
      totalRows: 3,
    });
    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.outer' })).toMatchObject({
      row: 1,
      totalRows: 3,
    });
    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.last' })).toMatchObject({
      row: 2,
    });
    // 祖先折叠 → 不可见
    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.outer.a' })).toMatchObject({
      row: -1,
      totalRows: 3,
    });

    // 只读：不推任何版本
    expect(await svc.dispatch({ t: 'stats', rootId: loaded.rootId })).toEqual(before);
  });

  it('路径不存在 → BAD_COMMAND（与 valueAt 同口径）', async () => {
    const svc = new DocService();
    const loaded = await load(svc, NESTED, 1, { adaptiveExpand: false });
    expect(
      (await errorOf(svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.nope' }))).code,
    ).toBe('BAD_COMMAND');
    expect(
      (await errorOf(svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.outer.a.b' }))).code,
    ).toBe('BAD_COMMAND');
    expect((await errorOf(svc.dispatch({ t: 'rowOfPath', rootId: 'doc:999', path: '$' }))).code).toBe('NO_ROOT');
  });

  it('切档 + 展开后行号按显示序（锚点换算口径）', async () => {
    const svc = new DocService();
    const loaded = await load(svc, NESTED, 1, { adaptiveExpand: false });

    const sorted = await svc.dispatch({ t: 'setOrder', order: 'key-asc' });
    const rowVersion = sorted.roots[0]?.rowVersion as number;
    // asc：last < outer（'l' < 'o'）
    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.last' })).toMatchObject({
      row: 1,
    });
    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.outer' })).toMatchObject({
      row: 2,
    });

    // 展开 outer（子键 asc：a < b）→ 行号随显示序
    const toggled = await svc.dispatch({
      t: 'toggle',
      rootId: loaded.rootId,
      path: '$.outer',
      open: true,
    });
    expect(toggled.rowVersion).toBe(rowVersion + 1);
    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.outer.a' })).toMatchObject({
      row: 3,
    });
    expect(await svc.dispatch({ t: 'rowOfPath', rootId: loaded.rootId, path: '$.outer.b' })).toMatchObject({
      row: 4,
    });
    // 窗口坐标与 rowOfPath 一致
    const win = await svc.dispatch({
      t: 'window',
      rootId: loaded.rootId,
      rowVersion: toggled.rowVersion,
      seq: 1,
      start: 3,
      count: 2,
    });
    expect(windowPaths(win.rows)).toEqual(['$.outer.a', '$.outer.b']);
  });
});

describe('DocService — outline 透传 order / 编辑后仍按当前档', () => {
  it('outline 按显示序分页，total 不变、只读', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ b: 1, a: 2, a10: 3 }), 1, { adaptiveExpand: false });
    const before = await svc.dispatch({ t: 'stats', rootId: loaded.rootId });
    await svc.dispatch({ t: 'setOrder', order: 'key-asc' });

    const page = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$', start: 0, count: 10 });
    expect(page).toMatchObject({ path: '$', kind: 'object', total: 3, start: 0 });
    expect(page.children.map((child) => child.key)).toEqual(['a', 'a10', 'b']);

    const second = await svc.dispatch({ t: 'outline', rootId: loaded.rootId, path: '$', start: 1, count: 1 });
    expect(second.children.map((child) => child.key)).toEqual(['a10']);

    // outline 只读：版本/行数不动（切档已推过一次，此后无变化）
    const after = await svc.dispatch({ t: 'stats', rootId: loaded.rootId });
    expect(after.docRevision).toBe(before.docRevision);
    expect(after.totalRows).toBe(before.totalRows);
  });

  it('编辑后（replaceNode）新子树按当前档排列', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ b: { y: 1 }, a: 2 }));
    await svc.dispatch({ t: 'setOrder', order: 'key-asc' });

    const replaced = await svc.dispatch({
      t: 'replaceNode',
      rootId: loaded.rootId,
      path: '$.b',
      docRevision: 1,
      jsonText: '{"z":9,"c":8}',
    });
    expect(replaced).toMatchObject({ docRevision: 2, rowVersion: 3 });
    const win = await svc.dispatch({
      t: 'window',
      rootId: loaded.rootId,
      rowVersion: replaced.rowVersion,
      seq: 1,
      start: 0,
      count: 10,
    });
    expect(windowPaths(win.rows)).toEqual(['$', '$.a', '$.b', '$.b.c', '$.b.z']);
  });
});
