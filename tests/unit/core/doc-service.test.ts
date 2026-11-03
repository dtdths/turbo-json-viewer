import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { DocService } from '../../../src/core/doc-service';
import type { Command, CoreEvent, LoadReply } from '../../../src/protocol/messages';

const DOC = { a: 1, b: { c: 2 } };
const JSON_TEXT = JSON.stringify(DOC);
const DOC_ROOT = 'doc';

/** > ADAPTIVE_EXPAND_ROWS(500) 节点的合成文档：load 后保持默认折叠，自适应展开不介入。 */
const COLLAPSED_DOC = JSON.stringify({ items: Array.from({ length: 600 }, (_, i) => i) });

async function errorOf(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (err) {
    return err as CoreError;
  }
  throw new Error('expected the command to reject');
}

async function load(svc: DocService, data: string | ArrayBuffer = JSON_TEXT, loadId = 1): Promise<LoadReply> {
  return svc.dispatch({ t: 'load', loadId, source: 'paste', data, name: 'doc.json' });
}

function windowPaths(reply: { rows: { path: string }[] }): string[] {
  return reply.rows.map((row) => row.path);
}

describe('DocService — load', () => {
  it('返回 LoadReply：doc 根、版本 1、totalRows = 自动展开后的行数、meta', async () => {
    const svc = new DocService();
    const reply = await load(svc);
    // DOC 只有 4 个节点（≤ 自适应阈值）→ load 即全展开，totalRows = 节点数
    expect(reply).toMatchObject({
      rootId: DOC_ROOT,
      docRevision: 1,
      rowVersion: 1,
      totalRows: 4,
    });
    expect(reply.meta).toMatchObject({ name: 'doc.json', source: 'paste' });
    expect(reply.meta.bytes).toBe(new TextEncoder().encode(JSON_TEXT).byteLength);
  });

  it('ArrayBuffer 输入用 TextDecoder 解码，bytes 取原始字节数', async () => {
    const svc = new DocService();
    const bytes = new TextEncoder().encode(JSON_TEXT);
    const reply = await svc.dispatch({ t: 'load', loadId: 1, source: 'file', data: bytes.buffer });
    expect(reply.meta.bytes).toBe(bytes.byteLength);
    expect(reply.meta.name).toBe('untitled.json'); // 无 name → 按 source 兜底
    expect(reply.totalRows).toBe(4); // 同 DOC：小文档自适应全展开
  });

  it('剪贴板来源的默认文件名', async () => {
    const svc = new DocService();
    const reply = await svc.dispatch({ t: 'load', loadId: 1, source: 'clipboard', data: '[]' });
    expect(reply.meta.name).toBe('clipboard.json');
    expect(reply.totalRows).toBe(1); // 空数组根：只有根行
  });

  it('PARSE：非法 JSON 带 line/column', async () => {
    const svc = new DocService();
    const err = await errorOf(
      svc.dispatch({ t: 'load', loadId: 1, source: 'file', data: '{\n  "a": 1,\n  bad\n}' }),
    );
    expect(err).toBeInstanceOf(CoreError);
    expect(err.code).toBe('PARSE');
    expect(err.line).toBe(3);
    expect(typeof err.column).toBe('number');
  });

  it('重新 load 替换 doc 根并重置版本', async () => {
    const svc = new DocService();
    await load(svc);
    const second = await load(svc, '{"x": 1, "y": 2}', 2);
    expect(second).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 3 });
    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 1, start: 0, count: 10 });
    expect(windowPaths(win)).toEqual(['$', '$.x', '$.y']);
  });
});

describe('DocService — window', () => {
  it('返回 RowWindow：回显 seq/start/count，rows 裁剪', async () => {
    const svc = new DocService();
    await load(svc);
    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 7, start: 0, count: 10 });
    expect(win).toMatchObject({ rootId: DOC_ROOT, rowVersion: 1, seq: 7, start: 0, count: 10, totalRows: 4 });
    expect(windowPaths(win)).toEqual(['$', '$.a', '$.b', '$.b.c']);

    const clipped = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 8, start: 2, count: 10 });
    expect(windowPaths(clipped)).toEqual(['$.b', '$.b.c']);
    expect(clipped.totalRows).toBe(4);
  });

  it('rowVersion 不符 → STALE_ROOT', async () => {
    const svc = new DocService();
    await load(svc);
    const err = await errorOf(
      svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 99, seq: 1, start: 0, count: 5 }),
    );
    expect(err.code).toBe('STALE_ROOT');
  });

  it('未知根 → NO_ROOT', async () => {
    const svc = new DocService();
    const err = await errorOf(
      svc.dispatch({ t: 'window', rootId: 'nope', rowVersion: 1, seq: 1, start: 0, count: 5 }),
    );
    expect(err.code).toBe('NO_ROOT');
  });
});

describe('DocService — toggle / expandTo 的版本语义', () => {
  it('toggle 后 rowVersion+1，旧 rowVersion 的窗口变 stale', async () => {
    const svc = new DocService();
    await load(svc, COLLAPSED_DOC); // > 500 节点：保持默认折叠，$.items 可展开
    const reply = await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true });
    expect(reply).toMatchObject({ docRevision: 1, rowVersion: 2, totalRows: 602, changedRow: 1 });

    const stale = await errorOf(
      svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 2, start: 0, count: 10 }),
    );
    expect(stale.code).toBe('STALE_ROOT');

    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 2, seq: 3, start: 0, count: 3 });
    expect(windowPaths(win)).toEqual(['$', '$.items', '$.items[0]']);
    expect(win.rowVersion).toBe(2);
  });

  it('no-op toggle 不推进 rowVersion', async () => {
    const svc = new DocService();
    await load(svc, COLLAPSED_DOC);
    await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true });
    const again = await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true });
    expect(again.rowVersion).toBe(2);
    expect(again.changedRow).toBeUndefined();
  });

  it('expandTo 展开祖先链并给出目标行号', async () => {
    const svc = new DocService();
    // > 500 节点：保持默认折叠，$.a.b 仍需展开
    await svc.dispatch({
      t: 'load',
      loadId: 1,
      source: 'paste',
      data: JSON.stringify({ a: { b: { c: 1 } }, pad: new Array(600).fill(0) }),
    });
    const reply = await svc.dispatch({ t: 'expandTo', rootId: DOC_ROOT, path: '$.a.b.c' });
    expect(reply).toMatchObject({ rootId: DOC_ROOT, rowVersion: 2, row: 3, totalRows: 5 });
    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 2, seq: 1, start: 0, count: 10 });
    expect(windowPaths(win)).toEqual(['$', '$.a', '$.a.b', '$.a.b.c', '$.pad']);
  });

  it('非容器 toggle → BAD_COMMAND', async () => {
    const svc = new DocService();
    await load(svc);
    const err = await errorOf(svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.a', open: true }));
    expect(err.code).toBe('BAD_COMMAND');
  });
});

describe('DocService — search / stats', () => {
  it('search 回包带 seq/rootId/docRevision，且命中语义来自 core/search', async () => {
    const svc = new DocService();
    await load(svc, '{"name":"alice","other":"ALICE"}');
    const reply = await svc.dispatch({ t: 'search', rootId: DOC_ROOT, seq: 42, query: 'alice' });
    expect(reply).toMatchObject({ seq: 42, rootId: DOC_ROOT, docRevision: 1, total: 2, truncated: false });
    expect(reply.hits.map((h) => h.path)).toEqual(['$.name', '$.other']);
  });

  it('stats 返回行数/版本', async () => {
    const svc = new DocService();
    await load(svc);
    const reply = await svc.dispatch({ t: 'stats', rootId: DOC_ROOT });
    expect(reply).toEqual({ rootId: DOC_ROOT, docRevision: 1, rowVersion: 1, totalRows: 4 });
  });

  it('新搜索抢占旧搜索（旧请求以 CANCELLED 结束）', async () => {
    const svc = new DocService();
    await load(svc, '{"name":"alice"}');
    const first = svc.dispatch({ t: 'search', rootId: DOC_ROOT, seq: 1, query: 'alice' });
    const second = svc.dispatch({ t: 'search', rootId: DOC_ROOT, seq: 2, query: 'alice' });
    expect((await errorOf(first)).code).toBe('CANCELLED');
    expect((await second).total).toBe(1);
  });
});

describe('DocService — load 抢占 / 取消', () => {
  it('后到的 load 抢占前一个，旧请求 CANCELLED、结果不采纳', async () => {
    const svc = new DocService();
    const first = svc.dispatch({ t: 'load', loadId: 10, source: 'paste', data: '{"a":1}' });
    const second = svc.dispatch({ t: 'load', loadId: 11, source: 'paste', data: '{"b":2}' });

    expect((await errorOf(first)).code).toBe('CANCELLED');
    const reply = await second;
    expect(reply.totalRows).toBe(2);

    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: reply.rowVersion, seq: 1, start: 0, count: 10 });
    expect(windowPaths(win)).toEqual(['$', '$.b']);
  });

  it('cancelLoad 取消在途 load', async () => {
    const svc = new DocService();
    const pending = svc.dispatch({ t: 'load', loadId: 20, source: 'paste', data: '{"a":1}' });
    await svc.dispatch({ t: 'cancelLoad', loadId: 20 });
    expect((await errorOf(pending)).code).toBe('CANCELLED');
  });

  it('未知根上的命令 → NO_ROOT', async () => {
    const svc = new DocService();
    expect((await errorOf(svc.dispatch({ t: 'stats', rootId: 'nope' }))).code).toBe('NO_ROOT');
  });
});

describe('DocService — 事件 / 未实现命令 / 关闭', () => {
  it('load 期间发 load-progress 事件；退订后不再收到', async () => {
    const svc = new DocService();
    const events: CoreEvent[] = [];
    const off = svc.on((event) => events.push(event));
    await load(svc);
    off();
    await load(svc, '{"z":1}', 2);

    const phases = events
      .filter((event): event is Extract<CoreEvent, { t: 'load-progress' }> => event.t === 'load-progress')
      .map((event) => event.phase);
    expect(phases).toEqual(['decode', 'parse', 'model']);
  });

  it('仍未实现的命令（getTrail / profile）统一 BAD_COMMAND("not implemented in skeleton slice")', async () => {
    const svc = new DocService();
    await load(svc);
    const commands: Command[] = [
      { t: 'getTrail', rootId: DOC_ROOT, path: null },
      { t: 'profile', rootId: DOC_ROOT },
    ];
    for (const command of commands) {
      const err = await errorOf(svc.dispatch(command));
      expect(err.code).toBe('BAD_COMMAND');
      expect(err.message).toContain('not implemented in skeleton slice');
    }
  });

  it('close 之后所有命令 CLOSED', async () => {
    const svc = new DocService();
    await load(svc);
    svc.close();
    expect((await errorOf(svc.dispatch({ t: 'stats', rootId: DOC_ROOT }))).code).toBe('CLOSED');
    expect(() => svc.on(() => undefined)).not.toThrow();
  });
});

describe('DocService — load 自适应展开（#9 / ADR-0002 修订）', () => {
  it('小文档（≤500 节点）加载即全展开：totalRows = 节点数，窗口行全开', async () => {
    const svc = new DocService();
    const reply = await load(svc, JSON.stringify({ a: { b: 1 }, c: [2] }));
    expect(reply).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 5 }); // root,a,b,c,c[0]
    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 1, start: 0, count: 10 });
    expect(windowPaths(win)).toEqual(['$', '$.a', '$.a.b', '$.c', '$.c[0]']);
    expect(win.rows.map((row) => row.open)).toEqual([true, true, false, true, false]);
  });

  it('超过阈值的文档保持默认折叠（rootVersion 仍是 1）', async () => {
    const svc = new DocService();
    const reply = await load(svc, COLLAPSED_DOC);
    expect(reply).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 2 }); // 根 + items
    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 1, start: 0, count: 10 });
    expect(windowPaths(win)).toEqual(['$', '$.items']);
    expect(win.rows[1]?.open).toBe(false);
  });
});

describe('DocService — expandAll / collapseAll 命令', () => {
  it('expandAll：rowVersion+1、totalRows=节点数，旧 rowVersion 的窗口变 stale', async () => {
    const svc = new DocService();
    const loaded = await load(svc, COLLAPSED_DOC);
    expect(loaded).toMatchObject({ rowVersion: 1, totalRows: 2 });

    const reply = await svc.dispatch({ t: 'expandAll', rootId: DOC_ROOT });
    expect(reply).toMatchObject({ rootId: DOC_ROOT, docRevision: 1, rowVersion: 2, totalRows: 602 });

    const stale = await errorOf(
      svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 1, start: 0, count: 5 }),
    );
    expect(stale.code).toBe('STALE_ROOT');

    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 2, seq: 2, start: 0, count: 3 });
    expect(windowPaths(win)).toEqual(['$', '$.items', '$.items[0]']);
    expect(win.totalRows).toBe(602);
  });

  it('collapseAll：回到默认折叠；重复调用是 no-op（rowVersion 不抖）', async () => {
    const svc = new DocService();
    await load(svc, COLLAPSED_DOC);
    await svc.dispatch({ t: 'expandAll', rootId: DOC_ROOT });

    const collapsed = await svc.dispatch({ t: 'collapseAll', rootId: DOC_ROOT });
    expect(collapsed).toMatchObject({ rootId: DOC_ROOT, docRevision: 1, rowVersion: 3, totalRows: 2 });

    const again = await svc.dispatch({ t: 'collapseAll', rootId: DOC_ROOT });
    expect(again).toMatchObject({ rowVersion: 3, totalRows: 2 });
  });

  it('小文档 load 已全开：expandAll 是 no-op（rowVersion 不推进）', async () => {
    const svc = new DocService();
    const loaded = await load(svc, '{"a":{"b":1}}'); // 3 个节点 → load 即全开
    expect(loaded.totalRows).toBe(3);
    const reply = await svc.dispatch({ t: 'expandAll', rootId: DOC_ROOT });
    expect(reply).toMatchObject({ rowVersion: loaded.rowVersion, totalRows: 3 });
  });

  it('未知根 → NO_ROOT', async () => {
    const svc = new DocService();
    expect((await errorOf(svc.dispatch({ t: 'expandAll', rootId: 'nope' }))).code).toBe('NO_ROOT');
    expect((await errorOf(svc.dispatch({ t: 'collapseAll', rootId: 'nope' }))).code).toBe('NO_ROOT');
  });
});

/* ============================= slice 5：子树编辑 ============================= */

const EDIT_DOC = { n: 1, s: 'x', b: true, nul: null, arr: [1], obj: { k: 1 } };
const EDIT_DOC_TEXT = JSON.stringify(EDIT_DOC);

async function loadEditDoc(svc: DocService): Promise<LoadReply> {
  return load(svc, EDIT_DOC_TEXT);
}

describe('DocService — getNodeJson', () => {
  it('返回规范 pretty JSON、UTF-8 字节数与节点类型（jsonKind）', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);

    // 期望文本是独立字面量（JSON.stringify(v, null, 2) 的规范形态），不从实现侧重算
    const expected: Array<[path: string, kind: string, text: string]> = [
      ['$', 'object', '{\n  "n": 1,\n  "s": "x",\n  "b": true,\n  "nul": null,\n  "arr": [\n    1\n  ],\n  "obj": {\n    "k": 1\n  }\n}'],
      ['$.n', 'number', '1'],
      ['$.s', 'string', '"x"'],
      ['$.b', 'boolean', 'true'],
      ['$.nul', 'null', 'null'],
      ['$.arr', 'array', '[\n  1\n]'],
      ['$.obj', 'object', '{\n  "k": 1\n}'],
    ];
    for (const [path, kind, text] of expected) {
      const reply = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path });
      expect(reply.kind).toBe(kind);
      expect(reply.text).toBe(text);
      expect(reply.bytes).toBe(new TextEncoder().encode(text).byteLength);
    }
  });

  it('路径不存在 → BAD_COMMAND', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    expect((await errorOf(svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.absent' }))).code).toBe(
      'BAD_COMMAND',
    );
  });

  it('子树文本 > EDIT_MAX_BYTES(5MB) → TOO_LARGE（带 bytes）', async () => {
    const svc = new DocService();
    await load(svc, JSON.stringify({ big: 'x'.repeat(6 * 1024 * 1024) }));
    const err = await errorOf(svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.big' }));
    expect(err.code).toBe('TOO_LARGE');
    expect(err.bytes).toBeGreaterThan(5 * 1024 * 1024);
  });
});

describe('DocService — replaceNode 基础', () => {
  it('替换标量：值图/版本/历史计数更新，窗口可读到新值', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);
    expect(loaded.totalRows).toBe(9); // root+n+s+b+nul+arr+arr[0]+obj+obj.k

    const reply = await svc.dispatch({
      t: 'replaceNode',
      rootId: DOC_ROOT,
      path: '$.n',
      docRevision: loaded.docRevision,
      jsonText: '42',
    });
    expect(reply).toMatchObject({
      rootId: DOC_ROOT,
      docRevision: 2,
      rowVersion: 2,
      totalRows: 9,
      changedPath: '$.n',
      changedRow: 1,
    });
    expect(reply.history).toEqual({ applied: 1, canUndo: true, canRedo: false });

    const node = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' });
    expect(node.text).toBe('42');
    expect(node.kind).toBe('number');

    // 旧 rowVersion 的窗口变 stale（主线程丢弃旧回包）
    expect(
      (await errorOf(svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 1, seq: 1, start: 0, count: 5 }))).code,
    ).toBe('STALE_ROOT');
  });

  it('替换子树（对象→数组）：totalRows 按新结构变化，行序/行号反映新值', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);

    // $.obj = {k:1}（2 节点）→ [1,2,3]（4 节点，S1 保留展开态 → 子项可见）：9 - 2 + 4 = 11
    const reply = await svc.dispatch({
      t: 'replaceNode',
      rootId: DOC_ROOT,
      path: '$.obj',
      docRevision: loaded.docRevision,
      jsonText: '[1, 2, 3]',
    });
    expect(reply).toMatchObject({ docRevision: 2, rowVersion: 2, totalRows: 11, changedRow: 7 });

    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 2, seq: 2, start: 0, count: 11 });
    expect(windowPaths(win)).toEqual([
      '$', '$.n', '$.s', '$.b', '$.nul', '$.arr', '$.arr[0]', '$.obj', '$.obj[0]', '$.obj[1]', '$.obj[2]',
    ]);
  });

  it('文本未变化（等价 JSON）→ no-op：不推进版本、不记历史、无 changedRow', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);

    const reply = await svc.dispatch({
      t: 'replaceNode',
      rootId: DOC_ROOT,
      path: '$.obj',
      docRevision: loaded.docRevision,
      jsonText: '{ "k": 1 }', // 与当前值等价（键序/空白不同）
    });
    expect(reply).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 9 });
    expect(reply.changedRow).toBeUndefined();
    expect(reply.history).toEqual({ applied: 0, canUndo: false, canRedo: false });
  });

  it('docRevision 不符 → STALE_DOC，且不修改值图', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    const err = await errorOf(
      svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 99, jsonText: '2' }),
    );
    expect(err.code).toBe('STALE_DOC');
    const node = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' });
    expect(node.text).toBe('1');
  });

  it('JSON 非法 → PARSE 带行列号，且不修改', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);
    const err = await errorOf(
      svc.dispatch({
        t: 'replaceNode',
        rootId: DOC_ROOT,
        path: '$.n',
        docRevision: loaded.docRevision,
        jsonText: '{\n  "a": 1,\n  "b": 01\n}',
      }),
    );
    expect(err.code).toBe('PARSE');
    expect(err.line).toBe(3);
    expect(err.column).toBe(9);

    const node = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' });
    expect(node.text).toBe('1');
  });

  it('jsonText > 5MB → TOO_LARGE（带 bytes），且不修改', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);
    const big = JSON.stringify('x'.repeat(6 * 1024 * 1024));
    const err = await errorOf(
      svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.s', docRevision: loaded.docRevision, jsonText: big }),
    );
    expect(err.code).toBe('TOO_LARGE');
    expect(err.bytes).toBeGreaterThan(5 * 1024 * 1024);

    const node = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.s' });
    expect(node.text).toBe('"x"');
  });

  it('路径不存在 → BAD_COMMAND', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);
    const err = await errorOf(
      svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.absent', docRevision: loaded.docRevision, jsonText: '1' }),
    );
    expect(err.code).toBe('BAD_COMMAND');
  });
});

describe('DocService — undo / redo', () => {
  it('undo 恢复旧值、redo 恢复新值，版本与历史计数正确', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });

    const undo = await svc.dispatch({ t: 'undo', rootId: DOC_ROOT });
    expect(undo).toMatchObject({ docRevision: 3, rowVersion: 3, totalRows: 9, changedPath: '$.n' });
    expect(undo.history).toEqual({ applied: 0, canUndo: false, canRedo: true });
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' })).text).toBe('1');

    const redo = await svc.dispatch({ t: 'redo', rootId: DOC_ROOT });
    expect(redo).toMatchObject({ docRevision: 4, rowVersion: 4, totalRows: 9, changedPath: '$.n' });
    expect(redo.history).toEqual({ applied: 1, canUndo: true, canRedo: false });
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' })).text).toBe('42');
    expect(loaded.totalRows).toBe(9);
  });

  it('无可撤销 / 无可重做 → NO_HISTORY，且不推进版本', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);
    expect((await errorOf(svc.dispatch({ t: 'undo', rootId: DOC_ROOT }))).code).toBe('NO_HISTORY');
    expect((await errorOf(svc.dispatch({ t: 'redo', rootId: DOC_ROOT }))).code).toBe('NO_HISTORY');

    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: loaded.docRevision, jsonText: '42' });
    expect((await errorOf(svc.dispatch({ t: 'redo', rootId: DOC_ROOT }))).code).toBe('NO_HISTORY');
  });

  it('撤销后再编辑：redo 分支作废', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });
    await svc.dispatch({ t: 'undo', rootId: DOC_ROOT }); // docRevision 2 → 3

    const edited = await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 3, jsonText: '7' });
    expect(edited.history).toEqual({ applied: 1, canUndo: true, canRedo: false });
    expect((await errorOf(svc.dispatch({ t: 'redo', rootId: DOC_ROOT }))).code).toBe('NO_HISTORY');
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' })).text).toBe('7');
  });

  it('undo 多步按 LIFO 反向应用，版本每步推进', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.s', docRevision: 2, jsonText: '"y"' });

    const undo1 = await svc.dispatch({ t: 'undo', rootId: DOC_ROOT });
    expect(undo1).toMatchObject({ docRevision: 4, changedPath: '$.s' });
    expect(undo1.history).toEqual({ applied: 1, canUndo: true, canRedo: true });

    const undo2 = await svc.dispatch({ t: 'undo', rootId: DOC_ROOT });
    expect(undo2).toMatchObject({ docRevision: 5, changedPath: '$.n' });
    expect(undo2.history).toEqual({ applied: 0, canUndo: false, canRedo: true });
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' })).text).toBe('1');
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.s' })).text).toBe('"x"');
  });
});

describe('DocService — reset', () => {
  it('reset 反向应用所有已生效编辑回原值，版本推进、历史清空', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.obj', docRevision: 2, jsonText: '[7]' });

    const reply = await svc.dispatch({ t: 'reset', rootId: DOC_ROOT });
    expect(reply.history).toEqual({ applied: 0, canUndo: false, canRedo: false });
    expect(reply.totalRows).toBe(9); // 回到原始结构
    expect(reply.docRevision).toBe(5); // 2 次编辑 + 2 步反向替换
    expect(reply.rowVersion).toBe(5);

    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' })).text).toBe('1');
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.obj' })).text).toBe('{\n  "k": 1\n}');
    expect((await errorOf(svc.dispatch({ t: 'undo', rootId: DOC_ROOT }))).code).toBe('NO_HISTORY');
  });

  it('部分撤销后 reset 只回滚仍生效的编辑', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.s', docRevision: 2, jsonText: '"y"' });
    await svc.dispatch({ t: 'undo', rootId: DOC_ROOT }); // 只回滚 $.s

    const reply = await svc.dispatch({ t: 'reset', rootId: DOC_ROOT });
    expect(reply.history).toEqual({ applied: 0, canUndo: false, canRedo: false });
    // $.s 已撤销，$.n 仍生效 → reset 后 n 回 1
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.n' })).text).toBe('1');
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.s' })).text).toBe('"x"');
    expect(reply.docRevision).toBe(5); // 2 编辑 + 1 undo + 1 reset 步
  });

  it('无编辑时 reset 是 no-op 回包（不抛错）', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    const reply = await svc.dispatch({ t: 'reset', rootId: DOC_ROOT });
    expect(reply).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 9 });
    expect(reply.history).toEqual({ applied: 0, canUndo: false, canRedo: false });
  });
});

describe('DocService — replaceNode 的行模型语义（S1）', () => {
  it('替换展开态容器：自身保持展开、其直接子项折叠、被删子路径不可见', async () => {
    const svc = new DocService();
    // 6 节点小文档 → 加载即全展开：a 与 b 都是展开态
    const loaded = await load(svc, JSON.stringify({ a: { b: [1, 2] }, c: 1 }));
    expect(loaded.totalRows).toBe(6);

    const reply = await svc.dispatch({
      t: 'replaceNode',
      rootId: DOC_ROOT,
      path: '$.a',
      docRevision: loaded.docRevision,
      jsonText: '{"x":{"y":1}}',
    });
    // 旧 a 子树 4 行 → 新 a（自身展开 + x 折叠）2 行：6 - 4 + 2 = 4
    expect(reply).toMatchObject({ totalRows: 4, changedRow: 1 });
    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: reply.rowVersion, seq: 1, start: 0, count: 4 });
    expect(windowPaths(win)).toEqual(['$', '$.a', '$.a.x', '$.c']);
    expect(win.rows.map((row) => row.open)).toEqual([true, true, false, false]);
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.a.x.y' })).text).toBe('1');
  });

  it('替换折叠态容器：保持折叠（新子项不可见）', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ a: { b: [1, 2] }, c: 1 }));
    await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.a', open: false });

    const reply = await svc.dispatch({
      t: 'replaceNode',
      rootId: DOC_ROOT,
      path: '$.a',
      docRevision: 1,
      jsonText: '{"x":1}',
    });
    // $.a 折叠着 → 仍折叠：1(a) + 1(c) + 1(root) = 3 行，$.a.x 不可见
    expect(reply.totalRows).toBe(3);
    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: reply.rowVersion, seq: 2, start: 0, count: 5 });
    expect(windowPaths(win)).toEqual(['$', '$.a', '$.c']);
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.a.x' })).text).toBe('1');
    expect(loaded.totalRows).toBe(6);
  });
});

describe('DocService — 根替换', () => {
  it('根替换重建行模型：根展开、顶层字段可见、子级折叠；search 读到新值图', async () => {
    const svc = new DocService();
    const loaded = await loadEditDoc(svc);

    const reply = await svc.dispatch({
      t: 'replaceNode',
      rootId: DOC_ROOT,
      path: '$',
      docRevision: loaded.docRevision,
      jsonText: '{"q":[1,2],"r":{"s":3}}',
    });
    // 根重建语义：根展开、顶层字段可见、子级折叠 → totalRows = 1 + 顶层字段数(2) = 3
    expect(reply).toMatchObject({ docRevision: 2, rowVersion: 2, totalRows: 3, changedRow: 0, changedPath: '$' });
    expect(reply.history).toEqual({ applied: 1, canUndo: true, canRedo: false });

    const win = await svc.dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: 2, seq: 1, start: 0, count: 5 });
    expect(windowPaths(win)).toEqual(['$', '$.q', '$.r']);

    // 根替换后 search / getNodeJson 必须读新值图（Root.value 同步）
    const hit = await svc.dispatch({ t: 'search', rootId: DOC_ROOT, seq: 1, query: 'zzz' });
    expect(hit.total).toBe(0);
    const hitNew = await svc.dispatch({ t: 'search', rootId: DOC_ROOT, seq: 2, query: 's' });
    expect(hitNew.total).toBe(1);
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$.q' })).text).toBe('[\n  1,\n  2\n]');
  });

  it('根替换可 undo 回原文（含行数与值）', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$', docRevision: 1, jsonText: '[]' });
    expect((await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$' })).text).toBe('[]');

    const undo = await svc.dispatch({ t: 'undo', rootId: DOC_ROOT });
    // 撤销根替换同样走「根重建」：子级折叠 → 1 + 6 个顶层字段 = 7 行（不是编辑前的全展开 9 行）
    expect(undo).toMatchObject({ docRevision: 3, totalRows: 7, changedRow: 0, changedPath: '$' });
    const root = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$' });
    expect(JSON.parse(root.text)).toEqual(EDIT_DOC);
    const hit = await svc.dispatch({ t: 'search', rootId: DOC_ROOT, seq: 1, query: 'k' });
    expect(hit.total).toBe(1); // 原文的 $.obj.k 又回来了
  });
});

describe('DocService — exportDoc', () => {
  it('导出当前值图（pretty），字节数正确，反映编辑后的值', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });

    const reply = await svc.dispatch({ t: 'exportDoc', rootId: DOC_ROOT });
    const expected = JSON.stringify({ ...EDIT_DOC, n: 42 }, null, 2);
    expect(reply.text).toBe(expected);
    expect(reply.bytes).toBe(new TextEncoder().encode(expected).byteLength);
    expect(JSON.parse(reply.text)).toEqual({ ...EDIT_DOC, n: 42 });
  });

  it('indent 参数生效（0 = 紧凑）', async () => {
    const svc = new DocService();
    await loadEditDoc(svc);
    const compact = await svc.dispatch({ t: 'exportDoc', rootId: DOC_ROOT, indent: 0 });
    expect(compact.text).toBe(JSON.stringify(EDIT_DOC));
  });

  it('不受编辑器 5MB 限制：6MB 文档可导出', async () => {
    const svc = new DocService();
    const big = { big: 'x'.repeat(6 * 1024 * 1024) };
    await load(svc, JSON.stringify(big));
    const reply = await svc.dispatch({ t: 'exportDoc', rootId: DOC_ROOT });
    expect(reply.bytes).toBeGreaterThan(6 * 1024 * 1024);
    expect(reply.text.length).toBeGreaterThan(6 * 1024 * 1024);
    expect(JSON.parse(reply.text)).toEqual(big);
  });
});

/** 复制用例的 fixture：覆盖标识符键 / 带点键 / 带引号键 / 数组元素 / 四种标量。 */
const COPY_DOC = {
  a: { 'b.c': 'x', n: 1 },
  "it's": 'quote',
  arr: [10, { k: null }],
  t: true,
  z: null,
};

async function loadCopyDoc(svc: DocService): Promise<void> {
  await load(svc, JSON.stringify(COPY_DOC));
}

describe('DocService — copyNode（复制四格式 / ADR-0010）', () => {
  it('subtree：2 空格缩进，bytes 为 UTF-8 字节数', async () => {
    const svc = new DocService();
    await loadCopyDoc(svc);
    const reply = await svc.dispatch({
      t: 'copyNode',
      rootId: DOC_ROOT,
      path: '$.a',
      format: 'subtree',
    });
    const expected = JSON.stringify(COPY_DOC.a, null, 2);
    expect(reply.text).toBe(expected);
    expect(reply.bytes).toBe(new TextEncoder().encode(expected).byteLength);
    expect(reply.format).toBe('subtree');
  });

  it('path：返回规范路径原文（非标识符键 / 数组下标）', async () => {
    const svc = new DocService();
    await loadCopyDoc(svc);
    for (const path of ['$', '$.a', "$.a['b.c']", "$['it\\'s']", '$.arr[1]']) {
      const reply = await svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path, format: 'path' });
      expect(reply.text).toBe(path);
      expect(reply.bytes).toBe(new TextEncoder().encode(path).byteLength);
    }
  });

  it('value：标量文本值（字符串不带引号；数字/布尔/null 为 JSON 字面量）', async () => {
    const svc = new DocService();
    await loadCopyDoc(svc);
    const cases: Array<[string, string]> = [
      ['$.arr[0]', '10'],
      ["$['it\\'s']", 'quote'],
      ['$.a.n', '1'],
      ['$.t', 'true'],
      ['$.z', 'null'],
      ["$.a['b.c']", 'x'],
    ];
    for (const [path, expected] of cases) {
      const reply = await svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path, format: 'value' });
      expect(reply.text).toBe(expected);
      expect(reply.format).toBe('value');
    }
  });

  it('key：对象键原样；数组元素为下标数字；根 → BAD_COMMAND', async () => {
    const svc = new DocService();
    await loadCopyDoc(svc);
    expect(
      (await svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: "$.a['b.c']", format: 'key' })).text,
    ).toBe('b.c');
    expect(
      (await svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: '$.arr[1]', format: 'key' })).text,
    ).toBe('1');
    expect(
      (await svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: '$.a', format: 'key' })).text,
    ).toBe('a');
    const err = await errorOf(svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: '$', format: 'key' }));
    expect(err.code).toBe('BAD_COMMAND');
  });

  it('容器复制原始值 → BAD_COMMAND（不静默序列化）', async () => {
    const svc = new DocService();
    await loadCopyDoc(svc);
    const err = await errorOf(svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: '$.a', format: 'value' }));
    expect(err.code).toBe('BAD_COMMAND');
  });

  it('子树 JSON > 5MB → TOO_LARGE（不截断，引导导出）', async () => {
    const svc = new DocService();
    const big = { big: 'x'.repeat(6 * 1024 * 1024) };
    await load(svc, JSON.stringify(big));
    const err = await errorOf(svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: '$.big', format: 'subtree' }));
    expect(err.code).toBe('TOO_LARGE');
    expect(err.bytes).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('只读：复制不推进 docRevision / rowVersion，不改 totalRows', async () => {
    const svc = new DocService();
    await loadCopyDoc(svc);
    const before = await svc.dispatch({ t: 'stats', rootId: DOC_ROOT });
    for (const format of ['subtree', 'path', 'value', 'key'] as const) {
      await svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: '$.arr[0]', format });
    }
    const after = await svc.dispatch({ t: 'stats', rootId: DOC_ROOT });
    expect(after).toEqual(before);
  });

  it('未知路径 → 报错（不返回空文本）', async () => {
    const svc = new DocService();
    await loadCopyDoc(svc);
    await expect(
      svc.dispatch({ t: 'copyNode', rootId: DOC_ROOT, path: '$.nope', format: 'path' }),
    ).rejects.toBeTruthy();
  });
});

describe('DocService — 截断修复（#8 / ADR-0004 修订）', () => {
  it('截断源 → 值图可用 + meta.repair（repaired）+ repair 事件 + 摘要', async () => {
    const svc = new DocService();
    const events: CoreEvent[] = [];
    svc.on((event) => events.push(event));

    const reply = await load(svc, '{"a":1,"b":"hello wor');
    expect(reply.meta.repair).toMatchObject({ status: 'repaired', truncatedAt: 21 });
    expect(reply.meta.repair?.parseError).toBeTruthy();
    expect(reply.meta.repair?.summaryText).toContain('仅语法闭合');
    expect(reply.meta.repair?.ops?.length ?? 0).toBeGreaterThan(0);

    const repairEvents = events.filter((event) => event.t === 'repair');
    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0]).toMatchObject({ t: 'repair', repair: { status: 'repaired' } });

    // 值图 = 修复后的值
    const root = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$' });
    expect(JSON.parse(root.text)).toEqual({ a: 1, b: 'hello wor' });
    // 小文档自适应展开照常（4 个节点：根 + a + b + 值行？只断言 > 0）
    expect(reply.totalRows).toBeGreaterThan(0);
  });

  it('非 EOF 形态语法错误 → 仍抛 PARSE，不产生根（修复不猜内容）', async () => {
    const svc = new DocService();
    const err = await errorOf(
      svc.dispatch({ t: 'load', loadId: 1, source: 'paste', data: '{"a":1}XYZ' }),
    );
    expect(err.code).toBe('PARSE');
    expect(err.line).toBeDefined();
    const statsErr = await errorOf(svc.dispatch({ t: 'stats', rootId: DOC_ROOT }));
    expect(statsErr.code).toBe('NO_ROOT');
  });

  it('合法 JSON → 无 meta.repair（不产生修复痕迹）', async () => {
    const svc = new DocService();
    const reply = await load(svc);
    expect(reply.meta.repair).toBeUndefined();
  });

  it('修复后的文档可继续编辑（replaceNode 走正常版本语义）', async () => {
    const svc = new DocService();
    const reply = await load(svc, '{"a":1,"b":"hello wor');
    const edited = await svc.dispatch({
      t: 'replaceNode',
      rootId: DOC_ROOT,
      path: '$.a',
      docRevision: reply.docRevision,
      jsonText: '42',
    });
    expect(edited.docRevision).toBe(2);
    const root = await svc.dispatch({ t: 'getNodeJson', rootId: DOC_ROOT, path: '$' });
    expect(JSON.parse(root.text)).toEqual({ a: 42, b: 'hello wor' });
  });
});
