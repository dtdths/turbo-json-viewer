/**
 * app/doc-session — 回包落地（Reply Landing）：app 侧唯一把 Worker 回包变成
 * 「会话版本状态 + 视图动作」的地方（ADR-0008 修订 2026-11-09）。
 *
 * 纯 TS、零 DOM：`land()` 只更新四个会话字段并返回纯数据 `LandingPlan`；副作用由
 * `main.ts` 的唯一执行器 `applyLanding(plan)` 完成。会话因此可脱 DOM 单测，handler 只回答
 * 「这是哪种落地意图」。
 *
 * 字段归属：只持有 rootId / docRevision / rowVersion / totalRows（与走查报告 sketch 一致）；
 * meta / 选中 / 编辑目标 / 滚动锚点仍归 app——锚点作为 ctx 传入，plan 只回算好的目标 px。
 */
import type { EditHistoryState } from '../protocol/messages';
import type { Anchor } from '../viewmodel/row-window-source';

/** 会话版本状态（唯一真相源；只在 `land()` 里更新）。 */
export interface SessionState {
  rootId: string | null;
  docRevision: number;
  rowVersion: number;
  totalRows: number;
}

/** 可落地回包：`LoadReply` / `EditReply` / `ExpandReply` 的最小交集。 */
export interface VersionedReply {
  rootId: string;
  rowVersion: number;
  totalRows: number;
  /** 跳转回包（`ExpandReply`）没有 docRevision：沿用会话现值。 */
  docRevision?: number;
  changedRow?: number;
  changedPath?: string;
  history?: EditHistoryState;
}

/** 回包落地意图：决定附加动作（重推命中 / 回顶 / 居中 / 锚点换算 / 大纲刷新…）。 */
export type LandingIntent =
  | { kind: 'document' } // load：换文档
  | { kind: 'toggle' } // 单节点展开 / 折叠
  | { kind: 'subtree' } // 整棵子树展开 / 收起
  | { kind: 'expandAll' } // 全部展开 / 收起（回顶）
  | { kind: 'edit' } // 值图编辑（replaceNode / undo / redo / reset）
  | { kind: 'jump'; path: string; row: number }; // expandTo 跳转（居中 + 选中）

/** 滚动策略（目标 px 已算好；执行器只照做）。 */
export type ScrollPlan =
  | { kind: 'keep' }
  | { kind: 'top' }
  | { kind: 'center'; scrollTopPx: number }
  | { kind: 'shift-anchor'; anchor: Anchor };

/** 落地上下文：意图需要的几何 / 视口信息（app 提供；纯数据）。 */
export interface LandingContext {
  /** 落地前的视口顶端锚点（edit 用；其余意图忽略）。 */
  anchor?: Anchor | null;
  /** 视口高度 px 与行高 px（jump 居中用；缺省退回 keep）。 */
  viewportPx?: number;
  rowHeightPx?: number;
}

/** 一次落地的完整计划：会话新状态 + 附加动作。 */
export interface LandingPlan {
  state: SessionState;
  /** 回包是否真的推进了 rowVersion（统一 no-op 检测；toast 判据）。 */
  changed: boolean;
  scroll: ScrollPlan;
  reapplyHits: boolean;
  refreshOutline: boolean;
  markSearchStale: boolean;
  clearSelection: boolean;
  selectPath?: string;
  flashPath?: string;
  /** 值图编辑的历史状态（只有 edit 意图给；展开态回包的历史已恒定但不需要再同步）。 */
  history?: EditHistoryState;
}

const EMPTY: SessionState = { rootId: null, docRevision: 0, rowVersion: 0, totalRows: 0 };

export class DocSession {
  private state: SessionState = { ...EMPTY };

  get rootId(): string | null {
    return this.state.rootId;
  }

  get docRevision(): number {
    return this.state.docRevision;
  }

  get rowVersion(): number {
    return this.state.rowVersion;
  }

  get totalRows(): number {
    return this.state.totalRows;
  }

  /** 拷贝：外部改动不影响会话。 */
  get snapshot(): SessionState {
    return { ...this.state };
  }

  /**
   * 落地一次回包：更新会话字段，返回视图动作计划（**不做任何副作用**）。
   * `ctx` 只在需要几何的意图（edit / jump）上读取。
   */
  land(reply: VersionedReply, intent: LandingIntent, ctx: LandingContext = {}): LandingPlan {
    const before = this.state;
    const delta = reply.totalRows - before.totalRows;
    const next: SessionState = {
      rootId: reply.rootId,
      docRevision: reply.docRevision ?? before.docRevision,
      rowVersion: reply.rowVersion,
      totalRows: reply.totalRows,
    };
    this.state = next;

    const edit = intent.kind === 'edit';
    return {
      state: { ...next },
      changed: reply.rowVersion !== before.rowVersion,
      scroll: scrollPlanFor(intent, ctx, reply, delta),
      reapplyHits: intent.kind === 'subtree' || intent.kind === 'expandAll',
      refreshOutline: edit,
      markSearchStale: edit,
      clearSelection: intent.kind === 'document',
      selectPath: intent.kind === 'jump' ? intent.path : undefined,
      flashPath: edit ? reply.changedPath : undefined,
      history: edit ? reply.history : undefined,
    };
  }
}

/** 滚动策略：意图决定（回顶 / 居中 / 按锚点平移 / 保持视口）。 */
function scrollPlanFor(
  intent: LandingIntent,
  ctx: LandingContext,
  reply: VersionedReply,
  delta: number,
): ScrollPlan {
  if (intent.kind === 'document' || intent.kind === 'expandAll') return { kind: 'top' };

  if (intent.kind === 'jump') {
    const viewportPx = ctx.viewportPx;
    const rowH = ctx.rowHeightPx;
    if (viewportPx === undefined || rowH === undefined || !(rowH > 0) || !Number.isFinite(viewportPx)) {
      return { kind: 'keep' };
    }
    // 与旧实现同式：目标行居中（视口高度不足一行时 offset 为 0）
    const centerOffset = Math.max(0, Math.floor((viewportPx - rowH) / 2 / rowH)) * rowH;
    return { kind: 'center', scrollTopPx: Math.max(0, intent.row * rowH - centerOffset) };
  }

  if (intent.kind === 'edit') {
    const anchor = ctx.anchor;
    const changeRow = reply.changedRow;
    // 变更出现在视口上方：按行数差平移锚点，保持视口内容不跳
    if (!anchor || changeRow === undefined || changeRow < 0 || changeRow >= anchor.row) return { kind: 'keep' };
    return {
      kind: 'shift-anchor',
      anchor: { row: Math.max(0, anchor.row + delta), offsetPx: anchor.offsetPx },
    };
  }

  return { kind: 'keep' };
}
