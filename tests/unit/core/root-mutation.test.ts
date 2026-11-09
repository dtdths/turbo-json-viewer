/**
 * tests/unit/core/root-mutation — 根变更路径的版本矩阵与回包形状契约（ADR-0002 修订 2026-11-09）。
 *
 * 这里断言的是**不变量**，不是逐命令行为（行为断言仍留在 doc-service.test.ts）：
 *   1. 八条 EditReply 命令走同一条根变更路径：`history` 恒定在回包里（形状恒定）。
 *   2. 版本矩阵：view 意图只在可见行变化时推 rowVersion；value 意图推 docRevision + rowVersion，
 *      reset 的 N 步每步都推两版本。
 *   3. 报字段规则：changedRow / changedPath 只在对应命令上出现（与既有行为逐条一致）。
 *   4. 潜伏缺陷回归：值图编辑后再展开，展开回包不得把「已修改 N 处」的历史状态清零。
 */
import { describe, expect, it } from 'vitest';
import { DocService } from '../../../src/core/doc-service';
import type { EditHistoryState, EditReply, LoadReply } from '../../../src/protocol/messages';

const DOC_ROOT = 'doc';

/** > ADAPTIVE_EXPAND_ROWS(500)：load 后保持默认折叠，`$.items` 可单层展开。 */
const COLLAPSED_DOC = JSON.stringify({ items: Array.from({ length: 600 }, (_, i) => i) });
/** > 阈值 + 每个元素是容器：可验证整棵子树展开。 */
const SUBTREE_DOC = JSON.stringify({ items: Array.from({ length: 600 }, (_, i) => ({ id: i, even: i % 2 === 0 })) });
/** 小文档（≤ 阈值）：load 即全展开，用于值图编辑类命令。 */
const EDIT_DOC = { n: 1, s: 'x', b: true, nul: null, arr: [1], obj: { k: 1 } };
const EDIT_DOC_TEXT = JSON.stringify(EDIT_DOC);

const EMPTY_HISTORY: EditHistoryState = { applied: 0, canUndo: false, canRedo: false };

/** 回包必须始终带的核心字段（形状恒定）；changedRow / changedPath 按命令规则可选。 */
const REQUIRED_KEYS = ['rootId', 'docRevision', 'rowVersion', 'totalRows', 'history'];
const OPTIONAL_KEYS = ['changedRow', 'changedPath'];

async function load(svc: DocService, data: string): Promise<LoadReply> {
  return svc.dispatch({ t: 'load', loadId: 1, source: 'paste', data, name: 'doc.json' });
}

/** 读版本快照（stats 是只读命令，不推版本）。 */
async function stats(svc: DocService): Promise<{ docRevision: number; rowVersion: number; totalRows: number }> {
  return svc.dispatch({ t: 'stats', rootId: DOC_ROOT });
}

async function errorOf(promise: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string };
  }
  throw new Error('expected the command to reject');
}

interface MatrixCase {
  name: string;
  data: string;
  /** 命令前在同一 service 上跑的预置。 */
  prepare?: (svc: DocService) => Promise<void>;
  run: (svc: DocService) => Promise<EditReply>;
  /** 命令引起的版本增量（相对命令前的 stats）。 */
  docBump: number;
  rowBump: number;
  /** 期望的 changedRow / changedPath；undefined = 回包不得带该字段。 */
  changedRow?: number;
  changedPath?: string;
  history: EditHistoryState;
}

const replaceN: MatrixCase['run'] = (svc) =>
  svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });

const MATRIX: MatrixCase[] = [
  {
    name: 'toggle：展开可见行 → view 意图只推 rowVersion，报 changedRow',
    data: COLLAPSED_DOC,
    run: (svc) => svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true }),
    docBump: 0,
    rowBump: 1,
    changedRow: 1,
    history: EMPTY_HISTORY,
  },
  {
    name: 'toggle no-op：可见行没变 → 两版本都不推，不报 changedRow',
    data: COLLAPSED_DOC,
    prepare: async (svc) => {
      await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true });
    },
    run: (svc) => svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true }),
    docBump: 0,
    rowBump: 0,
    history: EMPTY_HISTORY,
  },
  {
    name: 'toggleSubtree：整棵子树展开 → view 意图只推 rowVersion，报 changedRow',
    data: SUBTREE_DOC,
    run: (svc) => svc.dispatch({ t: 'toggleSubtree', rootId: DOC_ROOT, path: '$.items', open: true }),
    docBump: 0,
    rowBump: 1,
    changedRow: 1,
    history: EMPTY_HISTORY,
  },
  {
    name: 'toggleSubtree no-op：已全展开 → 两版本都不推，不报 changedRow',
    data: SUBTREE_DOC,
    prepare: async (svc) => {
      await svc.dispatch({ t: 'toggleSubtree', rootId: DOC_ROOT, path: '$.items', open: true });
    },
    run: (svc) => svc.dispatch({ t: 'toggleSubtree', rootId: DOC_ROOT, path: '$.items', open: true }),
    docBump: 0,
    rowBump: 0,
    history: EMPTY_HISTORY,
  },
  {
    name: 'expandAll：view 意图只推 rowVersion，不报 changedRow（回顶由 app 做）',
    data: COLLAPSED_DOC,
    run: (svc) => svc.dispatch({ t: 'expandAll', rootId: DOC_ROOT }),
    docBump: 0,
    rowBump: 1,
    history: EMPTY_HISTORY,
  },
  {
    name: 'collapseAll：view 意图只推 rowVersion，不报 changedRow',
    data: COLLAPSED_DOC,
    prepare: async (svc) => {
      await svc.dispatch({ t: 'expandAll', rootId: DOC_ROOT });
    },
    run: (svc) => svc.dispatch({ t: 'collapseAll', rootId: DOC_ROOT }),
    docBump: 0,
    rowBump: 1,
    history: EMPTY_HISTORY,
  },
  {
    name: 'replaceNode：value 意图推两版本，报 changedRow + changedPath + history',
    data: EDIT_DOC_TEXT,
    run: replaceN,
    docBump: 1,
    rowBump: 1,
    changedRow: 1,
    changedPath: '$.n',
    history: { applied: 1, canUndo: true, canRedo: false },
  },
  {
    name: 'replaceNode no-op（等价 JSON）：不是变更 → 两版本都不推，不报 changedRow/changedPath',
    data: EDIT_DOC_TEXT,
    run: (svc) =>
      svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.obj', docRevision: 1, jsonText: '{ "k": 1 }' }),
    docBump: 0,
    rowBump: 0,
    history: EMPTY_HISTORY,
  },
  {
    name: 'replaceNode 不可见节点（祖先折叠）：推两版本、给 changedPath 但不给 changedRow',
    data: COLLAPSED_DOC,
    run: (svc) =>
      svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.items[3]', docRevision: 1, jsonText: '99' }),
    docBump: 1,
    rowBump: 1,
    changedPath: '$.items[3]',
    history: { applied: 1, canUndo: true, canRedo: false },
  },
  {
    name: 'undo：value 意图推两版本，报被撤销条目的 changedRow + changedPath',
    data: EDIT_DOC_TEXT,
    prepare: async (svc) => {
      await replaceN(svc);
    },
    run: (svc) => svc.dispatch({ t: 'undo', rootId: DOC_ROOT }),
    docBump: 1,
    rowBump: 1,
    changedRow: 1,
    changedPath: '$.n',
    history: { applied: 0, canUndo: false, canRedo: true },
  },
  {
    name: 'redo：value 意图推两版本，报被重做条目的 changedRow + changedPath',
    data: EDIT_DOC_TEXT,
    prepare: async (svc) => {
      await replaceN(svc);
      await svc.dispatch({ t: 'undo', rootId: DOC_ROOT });
    },
    run: (svc) => svc.dispatch({ t: 'redo', rootId: DOC_ROOT }),
    docBump: 1,
    rowBump: 1,
    changedRow: 1,
    changedPath: '$.n',
    history: { applied: 1, canUndo: true, canRedo: false },
  },
  {
    name: 'reset：value 意图多步——每个回滚条目各推一次两版本，不报 changedRow/changedPath',
    data: EDIT_DOC_TEXT,
    prepare: async (svc) => {
      await replaceN(svc);
      await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.obj', docRevision: 2, jsonText: '[7]' });
    },
    run: (svc) => svc.dispatch({ t: 'reset', rootId: DOC_ROOT }),
    docBump: 2,
    rowBump: 2,
    history: EMPTY_HISTORY,
  },
  {
    name: 'reset 无编辑：no-op 回包，两版本都不推',
    data: EDIT_DOC_TEXT,
    run: (svc) => svc.dispatch({ t: 'reset', rootId: DOC_ROOT }),
    docBump: 0,
    rowBump: 0,
    history: EMPTY_HISTORY,
  },
];

describe('DocService — 根变更路径：版本矩阵与形状契约（ADR-0002 修订 2026-11-09）', () => {
  for (const c of MATRIX) {
    it(c.name, async () => {
      const svc = new DocService();
      await load(svc, c.data);
      if (c.prepare) await c.prepare(svc);
      const before = await stats(svc);

      const reply = await c.run(svc);

      // 1) 版本矩阵：增量由意图决定
      expect(reply.rootId).toBe(DOC_ROOT);
      expect(reply.docRevision).toBe(before.docRevision + c.docBump);
      expect(reply.rowVersion).toBe(before.rowVersion + c.rowBump);

      // 2) 形状恒定：核心字段 + history 永远在；不允许出现矩阵之外的新字段
      for (const key of REQUIRED_KEYS) expect(reply).toHaveProperty(key);
      expect(reply.history).toEqual(c.history);
      for (const key of Object.keys(reply)) {
        expect([...REQUIRED_KEYS, ...OPTIONAL_KEYS]).toContain(key);
      }

      // 3) 报字段规则
      if (c.changedRow === undefined) {
        expect(reply.changedRow).toBeUndefined();
      } else {
        expect(reply.changedRow).toBe(c.changedRow);
      }
      if (c.changedPath === undefined) {
        expect(reply.changedPath).toBeUndefined();
      } else {
        expect(reply.changedPath).toBe(c.changedPath);
      }

      // 4) 回包自洽：totalRows 与命令后 stats 一致
      expect(reply.totalRows).toBe((await stats(svc)).totalRows);
    });
  }

  it('潜伏缺陷回归：值图编辑后再展开，回包仍带同一份 history（徽标不会被清零）', async () => {
    const svc = new DocService();
    await load(svc, EDIT_DOC_TEXT);
    await svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '42' });

    // 展开一个容器（view 意图）：不得把「已修改 1 处」清零
    const toggled = await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.obj', open: false });
    expect(toggled.history).toEqual({ applied: 1, canUndo: true, canRedo: false });

    // expandAll / collapseAll / toggleSubtree 同款
    const expanded = await svc.dispatch({ t: 'expandAll', rootId: DOC_ROOT });
    expect(expanded.history).toEqual({ applied: 1, canUndo: true, canRedo: false });
    const collapsed = await svc.dispatch({ t: 'collapseAll', rootId: DOC_ROOT });
    expect(collapsed.history).toEqual({ applied: 1, canUndo: true, canRedo: false });
    const subtree = await svc.dispatch({ t: 'toggleSubtree', rootId: DOC_ROOT, path: '$.obj', open: true });
    expect(subtree.history).toEqual({ applied: 1, canUndo: true, canRedo: false });
  });

  it('版本纪律：value 变更后旧 rowVersion 的窗口回包 stale（reset 的逐步推进同理）', async () => {
    const svc = new DocService();
    await load(svc, EDIT_DOC_TEXT); // rowVersion 1
    await replaceN(svc); // rowVersion 2
    const before = await stats(svc);

    const reset = await svc.dispatch({ t: 'reset', rootId: DOC_ROOT });
    expect(reset.rowVersion).toBe(before.rowVersion + 1);

    // 任意旧 rowVersion 的窗口都必须被拒（STALE_ROOT）
    const stale = await svc
      .dispatch({ t: 'window', rootId: DOC_ROOT, rowVersion: before.rowVersion, seq: 1, start: 0, count: 5 })
      .then(() => null)
      .catch((err: { code?: string }) => err.code);
    expect(stale).toBe('STALE_ROOT');
  });

  it('错误路径不推版本：校验/解析/守卫失败都不得改动 docRevision/rowVersion', async () => {
    const svc = new DocService();
    await load(svc, EDIT_DOC_TEXT);
    const before = await stats(svc);

    const failures: Array<[ReturnType<DocService['dispatch']>, string]> = [
      // docRevision 不符
      [svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 99, jsonText: '2' }), 'STALE_DOC'],
      // 非法 JSON
      [svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.n', docRevision: 1, jsonText: '{' }), 'PARSE'],
      // 路径不存在
      [svc.dispatch({ t: 'replaceNode', rootId: DOC_ROOT, path: '$.absent', docRevision: 1, jsonText: '1' }), 'BAD_COMMAND'],
      // 空历史
      [svc.dispatch({ t: 'undo', rootId: DOC_ROOT }), 'NO_HISTORY'],
      [svc.dispatch({ t: 'redo', rootId: DOC_ROOT }), 'NO_HISTORY'],
    ];
    for (const [promise, code] of failures) {
      expect((await errorOf(promise)).code).toBe(code);
    }
    expect(await stats(svc)).toEqual(before);
  });

  it('expandTo 仍在路径外：独立 ExpandReply（无 history / docRevision），只为跳转推 rowVersion', async () => {
    const svc = new DocService();
    const loaded = await load(svc, COLLAPSED_DOC);
    const reply = await svc.dispatch({ t: 'expandTo', rootId: DOC_ROOT, path: '$.items[5]' });
    expect(reply).toMatchObject({ rootId: DOC_ROOT, rowVersion: loaded.rowVersion + 1 });
    expect('history' in reply).toBe(false);
    expect('docRevision' in reply).toBe(false);
    expect((await stats(svc)).docRevision).toBe(loaded.docRevision);
  });

  it('回包形状恒定：同一条命令在 changed / no-op 两种结果下都带 history', async () => {
    const svc = new DocService();
    await load(svc, COLLAPSED_DOC);
    const opened = await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true });
    const noop = await svc.dispatch({ t: 'toggle', rootId: DOC_ROOT, path: '$.items', open: true });
    expect(opened.history).toEqual(EMPTY_HISTORY);
    expect(noop.history).toEqual(EMPTY_HISTORY);
  });
});
