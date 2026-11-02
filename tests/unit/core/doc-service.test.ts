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

  it('骨架未实现命令统一 BAD_COMMAND("not implemented in skeleton slice")', async () => {
    const svc = new DocService();
    await load(svc);
    const commands: Command[] = [
      { t: 'getNodeJson', rootId: DOC_ROOT, path: '$' },
      { t: 'replaceNode', rootId: DOC_ROOT, path: '$', docRevision: 1, jsonText: '{}' },
      { t: 'undo', rootId: DOC_ROOT },
      { t: 'redo', rootId: DOC_ROOT },
      { t: 'reset', rootId: DOC_ROOT },
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
