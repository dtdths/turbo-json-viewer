/**
 * tests/unit/app/doc-session — 回包落地（Reply Landing）的意图矩阵（ADR-0008 修订 2026-11-09）。
 *
 * 这里断言的是**不变量**，不看 main.ts 的 DOM 副作用：
 *   1. 四个会话字段（rootId / docRevision / rowVersion / totalRows）只在 land() 里更新。
 *   2. 意图决定附加动作：重推命中 / 回顶 / 居中 / 锚点换算 / 大纲刷新 / 搜索 stale / 选中 / 闪改。
 *   3. changed 统一做 no-op 检测（替代 handler 里手抄的 rowVersionBefore）。
 *   4. 纯函数式：回复与 plan 都是数据，会话可脱 DOM 测。
 */
import { describe, expect, it } from 'vitest';
import { DocSession, type LandingIntent } from '../../../src/app/doc-session';
import type { Anchor } from '../../../src/viewmodel/row-window-source';

const ROOT = 'doc';

const LOAD_REPLY = { rootId: ROOT, docRevision: 1, rowVersion: 1, totalRows: 3 };

/** 已打开一份文档的会话（后续用例在此之上落地）。 */
function opened(): DocSession {
  const session = new DocSession();
  session.land(LOAD_REPLY, { kind: 'document' });
  return session;
}

interface Expectation {
  state: { rootId: string | null; docRevision: number; rowVersion: number; totalRows: number };
  changed: boolean;
  scroll: unknown;
  reapplyHits: boolean;
  refreshOutline: boolean;
  markSearchStale: boolean;
  clearSelection: boolean;
  selectPath?: string;
  flashPath?: string;
  history?: { applied: number; canUndo: boolean; canRedo: boolean };
}

describe('DocSession — 回包落地（版本状态 + 意图动作矩阵）', () => {
  it('初始状态：空会话（无根、版本 0）', () => {
    const session = new DocSession();
    expect(session.rootId).toBeNull();
    expect(session.docRevision).toBe(0);
    expect(session.rowVersion).toBe(0);
    expect(session.totalRows).toBe(0);
  });

  it('snapshot 返回副本：外部改动不污染会话', () => {
    const session = opened();
    const snapshot = session.snapshot;
    snapshot.rowVersion = 99;
    snapshot.rootId = 'other';
    expect(session.rowVersion).toBe(1);
    expect(session.rootId).toBe(ROOT);
  });

  const CASES: Array<{
    name: string;
    intent: LandingIntent;
    reply: {
      rootId: string;
      docRevision?: number;
      rowVersion: number;
      totalRows: number;
      changedRow?: number;
      changedPath?: string;
      history?: { applied: number; canUndo: boolean; canRedo: boolean };
    };
    anchor?: Anchor | null;
    viewportPx?: number;
    rowHeightPx?: number;
    /** true = 在空会话上落地（换文档边界）；默认在已打开会话上。 */
    fresh?: boolean;
    expect: Expectation;
  }> = [
    {
      name: 'document：换文档 → 回顶 + 清选中，没有编辑类附加动作',
      fresh: true,
      intent: { kind: 'document' },
      reply: { rootId: ROOT, docRevision: 2, rowVersion: 1, totalRows: 10 },
      expect: {
        state: { rootId: ROOT, docRevision: 2, rowVersion: 1, totalRows: 10 },
        changed: true,
        scroll: { kind: 'top' },
        reapplyHits: false,
        refreshOutline: false,
        markSearchStale: false,
        clearSelection: true,
      },
    },
    {
      name: 'toggle：只换版本与窗口，保持视口（不重推命中、不刷新大纲）',
      intent: { kind: 'toggle' },
      reply: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 9 },
      expect: {
        state: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 9 },
        changed: true,
        scroll: { kind: 'keep' },
        reapplyHits: false,
        refreshOutline: false,
        markSearchStale: false,
        clearSelection: false,
      },
    },
    {
      name: 'toggle no-op：rowVersion 没动 → changed=false（toast 判据）',
      intent: { kind: 'toggle' },
      reply: { rootId: ROOT, docRevision: 1, rowVersion: 1, totalRows: 3 },
      expect: {
        state: { rootId: ROOT, docRevision: 1, rowVersion: 1, totalRows: 3 },
        changed: false,
        scroll: { kind: 'keep' },
        reapplyHits: false,
        refreshOutline: false,
        markSearchStale: false,
        clearSelection: false,
      },
    },
    {
      name: 'subtree：保持视口但重推命中（新出现的行要带命中标记）',
      intent: { kind: 'subtree' },
      reply: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 30 },
      expect: {
        state: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 30 },
        changed: true,
        scroll: { kind: 'keep' },
        reapplyHits: true,
        refreshOutline: false,
        markSearchStale: false,
        clearSelection: false,
      },
    },
    {
      name: 'expandAll：回顶 + 重推命中',
      intent: { kind: 'expandAll' },
      reply: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 600 },
      expect: {
        state: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 600 },
        changed: true,
        scroll: { kind: 'top' },
        reapplyHits: true,
        refreshOutline: false,
        markSearchStale: false,
        clearSelection: false,
      },
    },
    {
      name: 'edit：变更行在锚点上方 → 按行数差平移锚点（视口不跳）',
      intent: { kind: 'edit' },
      anchor: { row: 5, offsetPx: 6 },
      reply: {
        rootId: ROOT,
        docRevision: 2,
        rowVersion: 2,
        totalRows: 6,
        changedRow: 2,
        changedPath: '$.x',
        history: { applied: 1, canUndo: true, canRedo: false },
      },
      expect: {
        state: { rootId: ROOT, docRevision: 2, rowVersion: 2, totalRows: 6 },
        changed: true,
        scroll: { kind: 'shift-anchor', anchor: { row: 8, offsetPx: 6 } },
        reapplyHits: false,
        refreshOutline: true,
        markSearchStale: true,
        clearSelection: false,
        flashPath: '$.x',
        history: { applied: 1, canUndo: true, canRedo: false },
      },
    },
    {
      name: 'edit：变更行在锚点下方 → 保持视口',
      intent: { kind: 'edit' },
      anchor: { row: 5, offsetPx: 6 },
      reply: {
        rootId: ROOT,
        docRevision: 2,
        rowVersion: 2,
        totalRows: 6,
        changedRow: 7,
        changedPath: '$.x',
        history: { applied: 1, canUndo: true, canRedo: false },
      },
      expect: {
        state: { rootId: ROOT, docRevision: 2, rowVersion: 2, totalRows: 6 },
        changed: true,
        scroll: { kind: 'keep' },
        reapplyHits: false,
        refreshOutline: true,
        markSearchStale: true,
        clearSelection: false,
        flashPath: '$.x',
        history: { applied: 1, canUndo: true, canRedo: false },
      },
    },
    {
      name: 'edit：没有视口锚点（未渲染）→ 保持视口',
      intent: { kind: 'edit' },
      anchor: null,
      reply: {
        rootId: ROOT,
        docRevision: 2,
        rowVersion: 2,
        totalRows: 6,
        changedRow: 1,
        changedPath: '$.a',
        history: { applied: 1, canUndo: true, canRedo: false },
      },
      expect: {
        state: { rootId: ROOT, docRevision: 2, rowVersion: 2, totalRows: 6 },
        changed: true,
        scroll: { kind: 'keep' },
        reapplyHits: false,
        refreshOutline: true,
        markSearchStale: true,
        clearSelection: false,
        flashPath: '$.a',
        history: { applied: 1, canUndo: true, canRedo: false },
      },
    },
    {
      name: 'jump（expandTo 回包无 docRevision）：版本不动、树居中、选中目标路径',
      intent: { kind: 'jump', path: '$.a.b', row: 100 },
      viewportPx: 900,
      rowHeightPx: 24,
      reply: { rootId: ROOT, rowVersion: 2, totalRows: 20 },
      expect: {
        state: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 20 },
        changed: true,
        // centerOffset = floor((900 - 24) / 2 / 24) * 24 = 432；100 × 24 − 432 = 1968
        scroll: { kind: 'center', scrollTopPx: 1968 },
        reapplyHits: false,
        refreshOutline: false,
        markSearchStale: false,
        clearSelection: false,
        selectPath: '$.a.b',
      },
    },
    {
      name: 'jump：目标行在顶部附近时居中值夹到 0',
      intent: { kind: 'jump', path: '$.a', row: 1 },
      viewportPx: 900,
      rowHeightPx: 24,
      reply: { rootId: ROOT, rowVersion: 2, totalRows: 20 },
      expect: {
        state: { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 20 },
        changed: true,
        scroll: { kind: 'center', scrollTopPx: 0 },
        reapplyHits: false,
        refreshOutline: false,
        markSearchStale: false,
        clearSelection: false,
        selectPath: '$.a',
      },
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const session = c.fresh ? new DocSession() : opened();
      const plan = session.land(
        c.reply,
        c.intent,
        c.anchor === undefined && c.viewportPx === undefined
          ? undefined
          : { anchor: c.anchor, viewportPx: c.viewportPx, rowHeightPx: c.rowHeightPx },
      );

      expect(plan.state).toEqual(c.expect.state);
      expect(session.rootId).toBe(c.expect.state.rootId);
      expect(session.docRevision).toBe(c.expect.state.docRevision);
      expect(session.rowVersion).toBe(c.expect.state.rowVersion);
      expect(session.totalRows).toBe(c.expect.state.totalRows);

      expect(plan.changed).toBe(c.expect.changed);
      expect(plan.scroll).toEqual(c.expect.scroll);
      expect(plan.reapplyHits).toBe(c.expect.reapplyHits);
      expect(plan.refreshOutline).toBe(c.expect.refreshOutline);
      expect(plan.markSearchStale).toBe(c.expect.markSearchStale);
      expect(plan.clearSelection).toBe(c.expect.clearSelection);
      expect(plan.selectPath).toBe(c.expect.selectPath);
      expect(plan.flashPath).toBe(c.expect.flashPath);
      expect(plan.history).toEqual(c.expect.history);
    });
  }

  it('order 意图：只换行版本（保持视口），不重推命中 / 不刷新大纲 / 不动搜索与选中（#41 / ADR-0024 v1.1）', () => {
    const session = opened();
    const plan = session.land(
      { rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 3 },
      { kind: 'order' },
    );
    // 会话版本照常落地（docRevision 不变：显示顺序不是值图变化）
    expect(session.snapshot).toEqual({ rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 3 });
    expect(plan.state).toEqual({ rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 3 });
    // changed 依 rowVersion 比较（1 → 2）= 真的换了行映射
    expect(plan.changed).toBe(true);
    // 滚动策略 = keep：锚点由 app 用 captureOrderAnchor + rowOfPath 按路径还原
    expect(plan.scroll).toEqual({ kind: 'keep' });
    // 附加动作全部关闭（行序变化不影响命中集 / 大纲数据 / 选中 / 编辑历史）
    expect(plan.reapplyHits).toBe(false);
    expect(plan.refreshOutline).toBe(false);
    expect(plan.markSearchStale).toBe(false);
    expect(plan.clearSelection).toBe(false);
    expect(plan.selectPath).toBeUndefined();
    expect(plan.flashPath).toBeUndefined();
    expect(plan.history).toBeUndefined();
  });

  it('order 意图 no-op：rowVersion 不变 → changed=false 且会话状态不变', () => {
    const session = opened();
    const before = session.snapshot;
    const plan = session.land(
      { rootId: ROOT, docRevision: 1, rowVersion: 1, totalRows: 3 },
      { kind: 'order' },
    );
    expect(plan.changed).toBe(false);
    expect(session.snapshot).toEqual(before);
    expect(plan.scroll).toEqual({ kind: 'keep' });
    expect(plan.reapplyHits).toBe(false);
    expect(plan.refreshOutline).toBe(false);
    expect(plan.markSearchStale).toBe(false);
    expect(plan.clearSelection).toBe(false);
    expect(plan.selectPath).toBeUndefined();
    expect(plan.flashPath).toBeUndefined();
    expect(plan.history).toBeUndefined();
  });

  it('jump 缺几何参数时退回保持视口（不猜行高）', () => {
    const session = opened();
    const plan = session.land({ rootId: ROOT, rowVersion: 2, totalRows: 20 }, { kind: 'jump', path: '$.a', row: 3 });
    expect(plan.scroll).toEqual({ kind: 'keep' });
  });

  it('syncRootVersion：只更新当前会话根，其它根的版本快照不碰（#40 / ADR-0024）', () => {
    const session = opened();
    expect(session.syncRootVersion('doc:other', 9, 99)).toBe(false);
    expect(session.rowVersion).toBe(session.snapshot.rowVersion);
    expect(session.syncRootVersion(ROOT, 7, 42)).toBe(true);
    expect(session.snapshot).toMatchObject({ rootId: ROOT, rowVersion: 7, totalRows: 42 });
    // docRevision / rootId 不动（显示排序不是值图变化）
    expect(session.docRevision).toBe(session.snapshot.docRevision);
    expect(session.rootId).toBe(ROOT);
  });

  it('连续落地：第二次 land 相对上一次的状态算 delta 与 changed', () => {
    const session = opened();
    session.land({ rootId: ROOT, docRevision: 1, rowVersion: 2, totalRows: 5 }, { kind: 'toggle' });
    const plan = session.land({ rootId: ROOT, docRevision: 1, rowVersion: 3, totalRows: 2 }, { kind: 'toggle' });
    expect(plan.changed).toBe(true);
    expect(session.totalRows).toBe(2);
    const noop = session.land({ rootId: ROOT, docRevision: 1, rowVersion: 3, totalRows: 2 }, { kind: 'toggle' });
    expect(noop.changed).toBe(false);
  });
});
