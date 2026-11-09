/**
 * viewmodel/row-window-source — S2：**树**的行窗口 adapter。
 *
 * 2026-11-09（ADR-0008 修订）：窗口规则已收口到 `WindowMachine`；本模块只剩树侧的映射：
 *   - 请求：`CoreApi.window`（rowVersion + seq + target）
 *   - 校验：seq / rootId / rowVersion 三重一致
 *   - 快照：`WindowSnapshot { rows, totalRows, start, rowVersion, stale, scrollTopPx }`
 *   - 差异配置：方向预取 + 单次最多 3 屏（原文窗口两项都关）
 *
 * 公开 interface 与行为保持不变（调用方 app/view 不改）；契约见 docs/architecture/seams.md §3，
 * 版本语义见 docs/adr/0001，决策见 ADR-0008 修订（2026-11-09）。
 */
import type { CoreApi, WindowRequest } from '../protocol/core-api';
import type { RootId, Row, RowWindow } from '../protocol/types';
import { OVERSCAN, ROW_HEIGHT } from '../protocol/versions';
import { WindowMachine } from './window-machine';
import type { Anchor, SnapshotResult, Target, WindowAdapter } from './window-machine';

/** 唯一允许从 view 进入逻辑层的视觉参数 */
export interface RowMetrics {
  rowHeight: number;
  viewportRows: number;
}

export interface WindowSnapshot {
  rootId: RootId;
  rows: Row[];
  totalRows: number;
  /** 本窗口第一行在根内的行号 */
  start: number;
  rowVersion: number;
  /** true = 当前帧可能过期或尚未就绪（失败 / 重取中） */
  stale: boolean;
  scrollTopPx: number;
}

export type { Anchor };

export interface RowWindowOptions {
  rowHeight?: number;
  overscan?: number;
}

export const WINDOW_POLICY = {
  overscan: OVERSCAN,
  /** 方向预取：跨过 overscan 个行高时多取 1 屏 */
  prefetchScreens: 1,
  /** 单次窗口最多 3 屏 */
  maxScreens: 3,
} as const;

/** 树侧 adapter：只做 window 请求/校验/快照映射，不含任何窗口规则。 */
function createRowAdapter(api: CoreApi): WindowAdapter<WindowSnapshot, RowWindow> {
  return {
    fetchWindow(target: Target, ctx): Promise<RowWindow> {
      const request: WindowRequest = {
        rootId: ctx.rootId,
        rowVersion: ctx.version,
        seq: ctx.seq,
        start: target.start,
        count: target.count,
      };
      return api.window(request);
    },

    validate(reply, ctx): boolean {
      return reply.seq === ctx.seq && reply.rootId === ctx.rootId && reply.rowVersion === ctx.version;
    },

    toSnapshot(reply, ctx): SnapshotResult<WindowSnapshot> {
      return {
        snapshot: {
          rootId: reply.rootId,
          rows: reply.rows,
          totalRows: reply.totalRows,
          start: reply.start,
          rowVersion: reply.rowVersion,
          stale: false,
          scrollTopPx: ctx.scrollTopPx,
        },
        total: reply.totalRows,
        version: reply.rowVersion,
        start: reply.start,
      };
    },

    frame(meta, prev): WindowSnapshot {
      return {
        rootId: meta.rootId,
        rows: prev ? prev.rows : [],
        totalRows: meta.total,
        start: meta.start,
        rowVersion: meta.version,
        stale: meta.stale,
        scrollTopPx: meta.scrollTopPx,
      };
    },
  };
}

export class RowWindowSource {
  private readonly machine: WindowMachine<WindowSnapshot, RowWindow>;

  constructor(api: CoreApi, opts: RowWindowOptions = {}) {
    this.machine = new WindowMachine(createRowAdapter(api), {
      rowHeight: opts.rowHeight ?? ROW_HEIGHT,
      overscan: Math.max(0, Math.floor(opts.overscan ?? WINDOW_POLICY.overscan)),
      prefetch: true,
      maxScreens: WINDOW_POLICY.maxScreens,
    });
  }

  /**
   * 换根或换行版本：清空目标与在途目标；同根换版本时保留上一帧（stale）避免闪烁。
   * `opts.scrollTopPx`：与换版本同一拍复位滚动锚点（expand-all / collapse-all 的「回顶」）。
   */
  setRoot(
    next: { rootId: RootId; rowVersion: number; totalRows: number },
    opts: { scrollTopPx?: number } = {},
  ): void {
    this.machine.setRoot(next.rootId, {
      version: next.rowVersion,
      total: next.totalRows,
      scrollTopPx: opts.scrollTopPx,
    });
  }

  /** 行高 / 视口行数变化后必须重取（renderer 不自行感知）。 */
  setMetrics(next: RowMetrics): void {
    this.machine.setMetrics(next);
  }

  /** 只吃像素；scrollTop ↔ 行号换算在内部。目标变化才请求。 */
  scrollTo(scrollTopPx: number): void {
    this.machine.scrollTo(scrollTopPx);
  }

  /** 幂等；可每帧调用。in-flight 时只更新排队目标。 */
  requestWindow(): void {
    this.machine.requestWindow();
  }

  /** 模型变化（toggle / replaceNode）后强制重取；stale 保留上一帧。 */
  invalidate(reason: 'toggle' | 'replace' | 'stale' | (string & {})): void {
    this.machine.invalidate(reason);
  }

  snapshot(): WindowSnapshot {
    return this.machine.snapshot();
  }

  subscribe(listener: (snapshot: WindowSnapshot) => void): () => void {
    return this.machine.subscribe(listener);
  }

  /** 记录视口顶端的 (行, 行内像素偏移)，用于模型更新后还原视口。 */
  anchor(): Anchor | null {
    return this.machine.anchor();
  }

  restoreAnchor(anchor: Anchor | null): void {
    this.machine.restoreAnchor(anchor);
  }

  metrics(): RowMetrics {
    return this.machine.metrics();
  }

  lastError() {
    return this.machine.lastError();
  }

  invalidateReason(): string | null {
    return this.machine.invalidateReason();
  }
}
