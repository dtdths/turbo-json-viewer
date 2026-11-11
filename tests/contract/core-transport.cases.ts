/**
 * tests/contract/core-transport.cases — CoreTransport 契约的**唯一一份**用例。
 *
 * 同一份断言分别打在两个适配器上（见 `in-process.test.ts` / `worker.test.ts`）：
 *   (a) ModelInProcess：`commandCore` + 真实 `DocService.dispatch`（同线程）；
 *   (b) WorkerTransport：`createWorkerCore(FakeWorker)`，FakeWorker 把 ctrl/win 两个
 *       MessagePort 接到真实 `DocService.dispatch`（等价 app/worker.ts 的路由）。
 *
 * 契约来源：docs/architecture/seams.md §2（不变式 1–6 + 错误模式归属）。
 * 只有 Worker 适配器才能制造的故障（TIMEOUT / CLOSED / WORKER_CRASH）不在本文件，
 * 放在 `worker.test.ts` 的独立 describe 并注明原因——in-process 没有通道，无从产生这些错误。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreApi } from '../../src/protocol/core-api';
import { CoreError } from '../../src/protocol/errors';
import type { CoreEvent } from '../../src/protocol/messages';
import { OUTLINE_PAGE_MAX } from '../../src/protocol/versions';

/** 一个适配器实例 = 一次独立会话；每个用例新建、用完 close。 */
export interface ContractHarness {
  api: CoreApi;
  close(): void;
}

export type HarnessFactory = () => ContractHarness;

/** doc 根 id 由 Worker 单调分配（`doc:1`、`doc:2`…，ADR-0009 §2）；断言一律用 LoadReply.rootId。 */
const DOC_ROOT_PATTERN = /^doc:\d+$/;

const BASIC_DOC = { a: 1, b: { c: 2 } };
const BASIC_TEXT = JSON.stringify(BASIC_DOC);

/** > ADAPTIVE_EXPAND_ROWS(500) 个节点：load 后保持默认折叠（自适应展开不介入）。 */
const COLLAPSED_DOC = { items: Array.from({ length: 600 }, (_, i) => i) };
const COLLAPSED_TEXT = JSON.stringify(COLLAPSED_DOC);

/** 子树编辑 fixture（9 行：root + 6 个顶层字段 + arr[0] + obj.k）。 */
const EDIT_DOC = { n: 1, s: 'x', b: true, nul: null, arr: [1], obj: { k: 1 } };
const EDIT_TEXT = JSON.stringify(EDIT_DOC);

/** 复制 fixture：覆盖标识符键 / 带点键 / 带引号键 / 数组元素 / 四种标量。 */
const COPY_DOC = {
  a: { 'b.c': 'x', n: 1 },
  "it's": 'quote',
  arr: [10, { k: null }],
  t: true,
  z: null,
};
const COPY_TEXT = JSON.stringify(COPY_DOC);

/** 原文视图 fixture：pretty 文本 → source 模式的逐行索引。 */
const RAW_DOC = { a: 1, b: [true, null], c: { d: 'x' } };
const RAW_TEXT = JSON.stringify(RAW_DOC, null, 2);
const RAW_LINES = RAW_TEXT.split('\n');

/** 保真 fixture：整数键重排 + 大整数精度流失（counts = number 1 / keyOrder 1）。 */
const FIDELITY_TEXT = '{"2":1,"b":2,"1":3,"big":1234567890123456789}';

/** 截断源：load 走 repair，同时发 load-progress×3 + repair 事件。 */
const TRUNCATED_TEXT = '{"a":1,"b":"hello wor';

/** 让跨端口的异步事件/回包全部落地（MessagePort 投递是宏任务）。 */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function errorOf(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof CoreError)) throw err;
    return err;
  }
  throw new Error('expected the command to reject');
}

function windowPaths(win: { rows: { path: string }[] }): string[] {
  return win.rows.map((row) => row.path);
}

function progressOf(events: CoreEvent[]): Array<Extract<CoreEvent, { t: 'load-progress' }>> {
  return events.filter((event): event is Extract<CoreEvent, { t: 'load-progress' }> => event.t === 'load-progress');
}

/**
 * 注册整套契约用例。`label` 进 describe 名（两个适配器各跑一遍，报告里能分开看）。
 */
export function runCoreContract(label: string, create: HarnessFactory): void {
  describe(`CoreApi 传输契约（${label}）`, () => {
    let h: ContractHarness;

    beforeEach(() => {
      h = create();
    });

    afterEach(() => {
      h.close();
    });

    const load = (data: string | ArrayBuffer, loadId = 1) =>
      h.api.load({ loadId, source: 'paste', data, name: 'doc.json' });

    /* ------------------------------- load ------------------------------- */

    it('load：文档根/版本/总行数/meta，首窗口按 rowVersion 返回行', async () => {
      const loaded = await load(BASIC_TEXT);
      expect(loaded.rootId).toMatch(DOC_ROOT_PATTERN);
      expect(loaded).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 4 });
      expect(loaded.meta).toMatchObject({ name: 'doc.json', source: 'paste' });
      expect(loaded.meta.bytes).toBe(new TextEncoder().encode(BASIC_TEXT).byteLength);

      const win = await h.api.window({
        rootId: loaded.rootId,
        rowVersion: loaded.rowVersion,
        seq: 1,
        start: 0,
        count: 10,
      });
      expect(win).toMatchObject({
        rootId: loaded.rootId,
        rowVersion: 1,
        seq: 1,
        start: 0,
        count: 10,
        totalRows: 4,
      });
      expect(windowPaths(win)).toEqual(['$', '$.a', '$.b', '$.b.c']);
    });

    it('load 坏 JSON：PARSE 带 line/column（错误形状跨适配器不丢字段）', async () => {
      const err = await errorOf(load('{\n  "a": 1,\n  bad\n}'));
      expect(err).toBeInstanceOf(CoreError);
      expect(err.code).toBe('PARSE');
      expect(err.line).toBe(3);
      expect(typeof err.column).toBe('number');
    });

    it('window：rowVersion 不符 → STALE_ROOT（不回旧数据）、未知根 → NO_ROOT', async () => {
      const loaded = await load(BASIC_TEXT);
      const stale = await errorOf(
        h.api.window({ rootId: loaded.rootId, rowVersion: 99, seq: 1, start: 0, count: 5 }),
      );
      expect(stale.code).toBe('STALE_ROOT');

      const noRoot = await errorOf(
        h.api.window({ rootId: 'no-such-root', rowVersion: 1, seq: 1, start: 0, count: 5 }),
      );
      expect(noRoot.code).toBe('NO_ROOT');
    });

    /* ----------------------------- closeRoot ----------------------------- */

    it('closeRoot：未知根幂等 closed:false；关闭后该根 window → NO_ROOT，重复关闭仍幂等', async () => {
      const loaded = await load(BASIC_TEXT);

      // 未知根：回包而不是抛错（页面重复关 / 迟到关都安全）
      expect(await h.api.closeRoot('no-such-root')).toEqual({ rootId: 'no-such-root', closed: false });

      expect(await h.api.closeRoot(loaded.rootId)).toEqual({ rootId: loaded.rootId, closed: true });

      const gone = await errorOf(
        h.api.window({ rootId: loaded.rootId, rowVersion: loaded.rowVersion, seq: 1, start: 0, count: 5 }),
      );
      expect(gone.code).toBe('NO_ROOT');

      // 幂等：再关一次 → closed:false（不抛）
      expect(await h.api.closeRoot(loaded.rootId)).toEqual({ rootId: loaded.rootId, closed: false });
    });

    it('多 doc 根：两次 load 得到不同 doc:N 且并存，关掉一根不影响另一根', async () => {
      const first = await load(BASIC_TEXT, 1);
      const second = await load(COLLAPSED_TEXT, 2);
      expect(first.rootId).toMatch(DOC_ROOT_PATTERN);
      expect(second.rootId).toMatch(DOC_ROOT_PATTERN);
      expect(second.rootId).not.toBe(first.rootId);

      // 两个根并存：各自 stats 独立
      expect(await h.api.stats(first.rootId)).toMatchObject({ rootId: first.rootId, totalRows: 4 });
      expect(await h.api.stats(second.rootId)).toMatchObject({ rootId: second.rootId, totalRows: 2 });

      expect((await h.api.closeRoot(first.rootId)).closed).toBe(true);
      expect((await errorOf(h.api.stats(first.rootId))).code).toBe('NO_ROOT');
      // 另一个标签的根照常可用
      expect(await h.api.stats(second.rootId)).toMatchObject({ rootId: second.rootId, docRevision: 1, rowVersion: 1 });
    });

    /* --------------------------- toggle / expand --------------------------- */

    it('toggle：changed 推进 rowVersion 并重算窗口；no-op 不推进', async () => {
      const loaded = await load(COLLAPSED_TEXT);
      expect(loaded.totalRows).toBe(2);

      const opened = await h.api.toggle({ rootId: loaded.rootId, path: '$.items', open: true });
      expect(opened).toMatchObject({ docRevision: 1, rowVersion: 2, totalRows: 602, changedRow: 1 });

      const again = await h.api.toggle({ rootId: loaded.rootId, path: '$.items', open: true });
      expect(again.rowVersion).toBe(2);
      expect(again.changedRow).toBeUndefined();

      const win = await h.api.window({ rootId: loaded.rootId, rowVersion: 2, seq: 2, start: 0, count: 3 });
      expect(windowPaths(win)).toEqual(['$', '$.items', '$.items[0]']);
    });

    it('toggleSubtree：子树展开 / 收起（changed 才推 rowVersion），标量 → BAD_COMMAND', async () => {
      const loaded = await load(COLLAPSED_TEXT);
      expect(loaded.totalRows).toBe(2);

      const opened = await h.api.toggleSubtree({ rootId: loaded.rootId, path: '$.items', open: true });
      expect(opened).toMatchObject({ docRevision: 1, rowVersion: 2, totalRows: 602, changedRow: 1 });

      const win = await h.api.window({ rootId: loaded.rootId, rowVersion: 2, seq: 1, start: 0, count: 3 });
      expect(windowPaths(win)).toEqual(['$', '$.items', '$.items[0]']);

      // 已全展开：no-op 不推版本、无 changedRow
      const again = await h.api.toggleSubtree({ rootId: loaded.rootId, path: '$.items', open: true });
      expect(again.rowVersion).toBe(2);
      expect(again.changedRow).toBeUndefined();

      const collapsed = await h.api.toggleSubtree({ rootId: loaded.rootId, path: '$.items', open: false });
      expect(collapsed).toMatchObject({ docRevision: 1, rowVersion: 3, totalRows: 2, changedRow: 1 });

      // 标量不可作为子树目标；失败不推版本
      const scalar = await errorOf(
        h.api.toggleSubtree({ rootId: loaded.rootId, path: '$.items[0]', open: true }),
      );
      expect(scalar.code).toBe('BAD_COMMAND');
      expect(await h.api.stats(loaded.rootId)).toMatchObject({ docRevision: 1, rowVersion: 3 });
    });

    it('expandTo：展开祖先链并返回目标行号', async () => {
      const loaded = await load(JSON.stringify({ a: { b: { c: 1 } }, pad: new Array(600).fill(0) }));
      const reply = await h.api.expandTo({ rootId: loaded.rootId, path: '$.a.b.c' });
      expect(reply).toMatchObject({ rootId: loaded.rootId, rowVersion: 2, row: 3, totalRows: 5 });

      const win = await h.api.window({ rootId: loaded.rootId, rowVersion: reply.rowVersion, seq: 1, start: 0, count: 10 });
      expect(windowPaths(win)).toEqual(['$', '$.a', '$.a.b', '$.a.b.c', '$.pad']);
    });

    it('expandAll / collapseAll：推 rowVersion，totalRows 跟随展开态；重复折叠是 no-op', async () => {
      const loaded = await load(COLLAPSED_TEXT);

      const expanded = await h.api.expandAll(loaded.rootId);
      expect(expanded).toMatchObject({ docRevision: 1, rowVersion: 2, totalRows: 602 });

      const collapsed = await h.api.collapseAll(loaded.rootId);
      expect(collapsed).toMatchObject({ docRevision: 1, rowVersion: 3, totalRows: 2 });

      const again = await h.api.collapseAll(loaded.rootId);
      expect(again).toMatchObject({ rowVersion: 3, totalRows: 2 });
    });

    /* ------------------------------- search ------------------------------- */

    it('search：命中带 seq/docRevision；正则语法错 → BAD_PATTERN', async () => {
      const loaded = await load(JSON.stringify({ name: 'alice', other: 'ALICE' }));
      const reply = await h.api.search({ rootId: loaded.rootId, seq: 42, query: 'alice' });
      expect(reply).toMatchObject({ seq: 42, rootId: loaded.rootId, docRevision: 1, total: 2, truncated: false });
      expect(reply.hits.map((hit) => hit.path)).toEqual(['$.name', '$.other']);

      const bad = await errorOf(
        h.api.search({ rootId: loaded.rootId, seq: 43, query: '(', opts: { regex: true } }),
      );
      expect(bad.code).toBe('BAD_PATTERN');
    });

    /* ------------------------------- outline ------------------------------- */

    it('outline：按容器分页（start/count 夹取、不依赖展开态、只读）', async () => {
      const loaded = await load(COLLAPSED_TEXT);

      const first = await h.api.outline({ rootId: loaded.rootId, path: '$.items', start: 0, count: 200 });
      expect(first).toMatchObject({ path: '$.items', kind: 'array', total: 600, start: 0 });
      expect(first.children).toHaveLength(200);
      expect(first.children[0]).toEqual({ key: '[0]', idx: true, kind: 'number', count: 0, path: '$.items[0]' });

      const tail = await h.api.outline({ rootId: loaded.rootId, path: '$.items', start: 550, count: 5000 });
      expect(tail).toMatchObject({ total: 600, start: 550 });
      expect(tail.children.map((child) => child.key)).toEqual(
        Array.from({ length: 50 }, (_, i) => `[${550 + i}]`),
      );

      const capped = await h.api.outline({ rootId: loaded.rootId, path: '$.items', start: 0, count: 5000 });
      expect(capped.children).toHaveLength(OUTLINE_PAGE_MAX);

      // 只读：版本/行数不动
      expect(await h.api.stats(loaded.rootId)).toMatchObject({ docRevision: 1, rowVersion: 1, totalRows: 2 });
    });

    /* --------------------------- 子树编辑 / 版本 --------------------------- */

    it('getNodeJson / replaceNode / undo / redo / reset：版本与 editCount 逐级正确', async () => {
      const loaded = await load(EDIT_TEXT);
      expect(loaded.totalRows).toBe(9);

      expect((await h.api.getNodeJson({ rootId: loaded.rootId, path: '$.n' })).text).toBe('1');

      const replaced = await h.api.replaceNode({
        rootId: loaded.rootId,
        path: '$.n',
        docRevision: loaded.docRevision,
        jsonText: '42',
      });
      expect(replaced).toMatchObject({ docRevision: 2, rowVersion: 2, totalRows: 9, changedPath: '$.n' });
      expect(replaced.history).toEqual({ applied: 1, canUndo: true, canRedo: false });
      expect((await h.api.getNodeJson({ rootId: loaded.rootId, path: '$.n' })).text).toBe('42');

      const undone = await h.api.undo(loaded.rootId);
      expect(undone).toMatchObject({ docRevision: 3, rowVersion: 3, totalRows: 9, changedPath: '$.n' });
      expect(undone.history).toEqual({ applied: 0, canUndo: false, canRedo: true });
      expect((await h.api.getNodeJson({ rootId: loaded.rootId, path: '$.n' })).text).toBe('1');

      const redone = await h.api.redo(loaded.rootId);
      expect(redone).toMatchObject({ docRevision: 4, rowVersion: 4, totalRows: 9 });
      expect(redone.history).toEqual({ applied: 1, canUndo: true, canRedo: false });

      const reset = await h.api.reset(loaded.rootId);
      expect(reset).toMatchObject({ docRevision: 5, rowVersion: 5, totalRows: 9 });
      expect(reset.history).toEqual({ applied: 0, canUndo: false, canRedo: false });
      expect((await h.api.getNodeJson({ rootId: loaded.rootId, path: '$.n' })).text).toBe('1');
    });

    it('replaceNode：docRevision 不符 → STALE_DOC 且值图不变（错误映射）', async () => {
      const loaded = await load(EDIT_TEXT);
      const err = await errorOf(
        h.api.replaceNode({
          rootId: loaded.rootId,
          path: '$.n',
          docRevision: loaded.docRevision + 100,
          jsonText: '2',
        }),
      );
      expect(err.code).toBe('STALE_DOC');
      expect((await h.api.getNodeJson({ rootId: loaded.rootId, path: '$.n' })).text).toBe('1');
    });

    /* --------------------------- 复制 / 导出 --------------------------- */

    it('copyNode：四种格式与字节数；不适用格式 → BAD_COMMAND', async () => {
      const loaded = await load(COPY_TEXT);

      const subtree = await h.api.copyNode({ rootId: loaded.rootId, path: '$.a', format: 'subtree' });
      const subtreeText = JSON.stringify(COPY_DOC.a, null, 2);
      expect(subtree).toMatchObject({ text: subtreeText, format: 'subtree' });
      expect(subtree.bytes).toBe(new TextEncoder().encode(subtreeText).byteLength);

      const pathCopy = await h.api.copyNode({ rootId: loaded.rootId, path: "$.a['b.c']", format: 'path' });
      expect(pathCopy).toMatchObject({ text: "$.a['b.c']", format: 'path' });

      const valueCopy = await h.api.copyNode({ rootId: loaded.rootId, path: '$.arr[0]', format: 'value' });
      expect(valueCopy).toMatchObject({ text: '10', format: 'value' });

      const keyCopy = await h.api.copyNode({ rootId: loaded.rootId, path: '$.arr[1]', format: 'key' });
      expect(keyCopy).toMatchObject({ text: '1', format: 'key' });

      expect(
        (await errorOf(h.api.copyNode({ rootId: loaded.rootId, path: '$', format: 'key' }))).code,
      ).toBe('BAD_COMMAND');
      expect(
        (await errorOf(h.api.copyNode({ rootId: loaded.rootId, path: '$.a', format: 'value' }))).code,
      ).toBe('BAD_COMMAND');
    });

    it('exportDoc：导出当前值图（前后加编辑也反映值图）', async () => {
      const loaded = await load(EDIT_TEXT);
      await h.api.replaceNode({
        rootId: loaded.rootId,
        path: '$.n',
        docRevision: loaded.docRevision,
        jsonText: '42',
      });

      const expected = JSON.stringify({ ...EDIT_DOC, n: 42 }, null, 2);
      const exported = await h.api.exportDoc(loaded.rootId);
      expect(exported.text).toBe(expected);
      expect(exported.bytes).toBe(new TextEncoder().encode(expected).byteLength);

      const compact = await h.api.exportDoc(loaded.rootId, 0);
      expect(compact.text).toBe(JSON.stringify({ ...EDIT_DOC, n: 42 }));
    });

    /* ----------------------------- 原始文本 ----------------------------- */

    it('rawOpen / rawWindow / rawLocate / rawSource：逐字回源、只读、超限 TOO_LARGE', async () => {
      const loaded = await load(RAW_TEXT);

      const meta = await h.api.rawOpen({ rootId: loaded.rootId });
      expect(meta).toMatchObject({ mode: 'source', totalLines: RAW_LINES.length, chars: RAW_TEXT.length });

      const win = await h.api.rawWindow({ rootId: loaded.rootId, seq: 9, start: 2, count: 4 });
      expect(win).toMatchObject({ seq: 9, start: 2, mode: 'source', totalLines: RAW_LINES.length });
      expect(win.lines).toEqual(RAW_LINES.slice(2, 6));

      expect(await h.api.rawLocate({ rootId: loaded.rootId, offset: 0 })).toEqual({
        line: 1,
        totalLines: RAW_LINES.length,
      });

      const source = await h.api.rawSource({ rootId: loaded.rootId });
      expect(source.text).toBe(RAW_TEXT);

      const tooLarge = await errorOf(h.api.rawSource({ rootId: loaded.rootId, maxBytes: source.bytes - 1 }));
      expect(tooLarge.code).toBe('TOO_LARGE');
      expect(tooLarge.bytes).toBe(source.bytes);
    });

    /* ------------------------------- 保真 ------------------------------- */

    it('fidelity：counts 全量分类、hits 源序，且不推版本', async () => {
      const loaded = await load(FIDELITY_TEXT);
      const before = await h.api.stats(loaded.rootId);

      const reply = await h.api.fidelity({ rootId: loaded.rootId });
      expect(reply).toMatchObject({ rootId: loaded.rootId, docRevision: 1 });
      expect(reply.report.counts).toMatchObject({
        number: 1,
        precision: 1,
        overflow: 0,
        underflow: 0,
        keyOrder: 1,
        total: 2,
      });
      expect(reply.report.hits.map((hit) => hit.kind)).toEqual(['key-order', 'number']);

      expect(await h.api.stats(loaded.rootId)).toEqual(before);
    });

    /* --------------------- getTrail / profile / stats --------------------- */

    it('stats 只读快照；getTrail / profile 的未实现错误映射为 BAD_COMMAND', async () => {
      const loaded = await load(BASIC_TEXT);
      expect(await h.api.stats(loaded.rootId)).toEqual({
        rootId: loaded.rootId,
        docRevision: 1,
        rowVersion: 1,
        totalRows: 4,
      });

      // 逐个创建 + await：worker 适配器的 rejection 在宏任务里落地，先建后 await 会触发
      // 「两条 pending 同时 reject」的未处理拒绝噪音。
      const notImplemented: Array<() => Promise<unknown>> = [
        () => h.api.getTrail({ rootId: loaded.rootId, path: null }),
        () => h.api.profile(loaded.rootId),
      ];
      for (const call of notImplemented) {
        const err = await errorOf(call());
        expect(err.code).toBe('BAD_COMMAND');
        expect(err.message).toContain('not implemented in skeleton slice');
      }
    });

    /* ------------------------------- 事件通道 ------------------------------- */

    it('on()：progress×3 + repair×1 的精确序列（不得 ×2）；退订后不再收到', async () => {
      const events: CoreEvent[] = [];
      const off = h.api.on((event) => events.push(event));
      const loaded = await load(TRUNCATED_TEXT);
      await nextTask(); // 跨 MessagePort 的事件投递是宏任务，等一拍再断言

      expect(loaded.meta.repair?.status).toBe('repaired');
      // 精确序列：DocService.load 的发射顺序是 decode → parse → (repair) → model。
      // 这条断言也是回归哨兵：worker.ts 曾把每个事件广播到 ctrl+win 两个 port，
      // 订阅者会收到两份（8 条而非 4 条）；现在事件只从 ctrl 发，两适配器都必须恰好 4 条。
      expect(events.map((event) => (event.t === 'load-progress' ? `progress:${event.phase}` : event.t))).toEqual([
        'progress:decode',
        'progress:parse',
        'repair',
        'progress:model',
      ]);
      expect(events).toHaveLength(4);

      const progress = progressOf(events);
      expect(progress).toHaveLength(3); // 三阶段各 1 次，不是各 2 次
      for (const event of progress) expect(event.loadId).toBe(1);

      const repairs = events.filter(
        (event): event is Extract<CoreEvent, { t: 'repair' }> => event.t === 'repair',
      );
      expect(repairs).toHaveLength(1);
      expect(repairs[0]?.repair.status).toBe('repaired');

      // 退订后不再收到：第二份同样会发 4 条事件的截断 load，一条都不该进数组
      off();
      await load(TRUNCATED_TEXT, 2);
      await nextTask();
      expect(events).toHaveLength(4);
    });
  });
}
