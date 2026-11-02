/**
 * viewmodel/row-window-source — S2：行窗口状态机。
 *
 * 视图只消费一个快照；这里负责：
 *   - 像素 scrollTop ↔ 起始行换算（唯一进入逻辑层的视觉参数是 RowMetrics）
 *   - 单飞 + 合并：同一时刻最多 1 个 in-flight，新目标覆盖排队目标
 *   - seq / rowVersion / rootId 校验：过期回包丢弃、不 notify
 *   - 失败降级：stale=true 保留上一帧，view 显示细的「加载中」而不是空白列表
 *   - 滚动锚点：toggle / replaceNode 前后记 (row, offsetPx)，视口不跳
 *
 * 不依赖 DOM，不依赖定时器（可单测）。
 *
 * 契约见 docs/architecture/seams.md §3；版本语义见 docs/adr/0001。
 */
import type { CoreApi, WindowRequest } from '../protocol/core-api';
import type { RootId, Row, RowWindow } from '../protocol/types';
import { CoreError } from '../protocol/errors';
import { OVERSCAN, ROW_HEIGHT } from '../protocol/versions';

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

export interface Anchor {
  row: number;
  offsetPx: number;
}

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

interface Target {
  start: number;
  count: number;
}

interface SentRequest {
  seq: number;
  epoch: number;
  target: Target;
  scrollTopPx: number;
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export class RowWindowSource {
  private readonly api: CoreApi;
  private readonly overscan: number;
  private rowHeight: number;
  private viewportRows = 0;

  private rootId: RootId | null = null;
  private rowVersion = 0;
  private totalRows = 0;

  private current: WindowSnapshot;
  private readonly listeners = new Set<(snapshot: WindowSnapshot) => void>();

  private scrollTopPx = 0;
  private lastRequestScrollTopPx = 0;

  private seq = 0;
  private epoch = 0;
  private inFlight: SentRequest | null = null;
  private desired: Target | null = null;
  private lastSent: Target | null = null;

  private lastFailure: CoreError | null = null;
  private lastInvalidateReason: string | null = null;

  constructor(api: CoreApi, opts: RowWindowOptions = {}) {
    this.api = api;
    this.rowHeight = opts.rowHeight ?? ROW_HEIGHT;
    this.overscan = Math.max(0, Math.floor(opts.overscan ?? WINDOW_POLICY.overscan));
    this.current = {
      rootId: '',
      rows: [],
      totalRows: 0,
      start: 0,
      rowVersion: 0,
      stale: true,
      scrollTopPx: 0,
    };
  }

  /**
   * 换根或换行版本：清空目标与在途目标；同根换版本时保留上一帧（stale）避免闪烁。
   * `opts.scrollTopPx`：与换版本同一拍复位滚动锚点（expand-all / collapse-all 的「回顶」）。
   * 不传时保持旧滚动位置（toggle 等「原地变化」路径不变）。传 0 时也必须把保留帧的
   * `start` 一起归零，否则旧 start 的保留帧会被新的小 `totalRows` 裁到视口外（空白帧），
   * 且紧接着的请求会按旧滚动位置算出一个被夹扁的中间窗口（1 行闪帧）。
   */
  setRoot(
    next: { rootId: RootId; rowVersion: number; totalRows: number },
    opts: { scrollTopPx?: number } = {},
  ): void {
    const rootChanged = next.rootId !== this.rootId;
    this.rootId = next.rootId;
    this.rowVersion = next.rowVersion;
    this.totalRows = Math.max(0, next.totalRows);
    this.epoch += 1;
    if (rootChanged) {
      this.scrollTopPx = 0;
      this.lastRequestScrollTopPx = 0;
    }
    const anchorPx =
      opts.scrollTopPx !== undefined && Number.isFinite(opts.scrollTopPx)
        ? Math.max(0, opts.scrollTopPx)
        : null;
    if (anchorPx !== null) {
      this.scrollTopPx = anchorPx;
      this.lastRequestScrollTopPx = anchorPx;
    }

    // 旧 in-flight 不取消：靠 epoch 校验丢弃回包；排队目标清空
    this.inFlight = null;
    this.desired = null;
    this.lastSent = null;

    if (!rootChanged && this.current.rows.length > 0) {
      this.current = {
        ...this.current,
        rootId: next.rootId,
        totalRows: this.totalRows,
        rowVersion: next.rowVersion,
        // 显式锚点时保留帧跟着锚点走（顶部），避免裁切出空白
        start: anchorPx !== null ? Math.floor(anchorPx / this.rowHeight) : this.current.start,
        stale: true,
        scrollTopPx: this.scrollTopPx,
      };
    } else {
      this.current = {
        rootId: next.rootId,
        rows: [],
        totalRows: this.totalRows,
        start: 0,
        rowVersion: next.rowVersion,
        stale: true,
        scrollTopPx: this.scrollTopPx,
      };
    }
    // 显式锚点：目标窗口在 emit 前就算好，后续 requestWindow 不会从旧滚动位置取中间窗口
    if (anchorPx !== null) this.desired = this.computeTarget(this.scrollTopPx);
    this.emit();
  }

  /** 行高 / 视口行数变化后必须重取（renderer 不自行感知）。 */
  setMetrics(next: RowMetrics): void {
    const rowHeight = next.rowHeight > 0 ? next.rowHeight : this.rowHeight;
    const viewportRows = Math.max(1, Math.floor(next.viewportRows));
    if (rowHeight === this.rowHeight && viewportRows === this.viewportRows) return;

    this.rowHeight = rowHeight;
    this.viewportRows = viewportRows;
    this.lastSent = null;
    this.desired = this.computeTarget(this.scrollTopPx);
    this.pump();
  }

  /** 只吃像素；scrollTop ↔ 行号换算在内部。目标变化才请求。 */
  scrollTo(scrollTopPx: number): void {
    const px = Number.isFinite(scrollTopPx) ? Math.max(0, scrollTopPx) : 0;
    this.scrollTopPx = px;
    this.current.scrollTopPx = px;
    if (this.rootId === null) return;

    this.desired = this.computeTarget(px);
    this.pump();
  }

  /** 幂等；可每帧调用。in-flight 时只更新排队目标。 */
  requestWindow(): void {
    if (this.rootId === null) return;
    if (this.desired === null) this.desired = this.computeTarget(this.scrollTopPx);
    this.pump();
  }

  /** 模型变化（toggle / replaceNode）后强制重取；stale 保留上一帧。 */
  invalidate(reason: 'toggle' | 'replace' | 'stale' | (string & {})): void {
    this.lastInvalidateReason = reason;
    this.current = { ...this.current, stale: true, scrollTopPx: this.scrollTopPx };
    this.lastSent = null;
    this.desired = this.computeTarget(this.scrollTopPx);
    this.emit();
    this.pump();
  }

  snapshot(): WindowSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: WindowSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 记录视口顶端的 (行, 行内像素偏移)，用于模型更新后还原视口。 */
  anchor(): Anchor | null {
    if (this.rootId === null) return null;
    const row = Math.floor(this.scrollTopPx / this.rowHeight);
    return { row, offsetPx: this.scrollTopPx - row * this.rowHeight };
  }

  restoreAnchor(anchor: Anchor | null): void {
    if (!anchor) return;
    this.scrollTo(anchor.row * this.rowHeight + anchor.offsetPx);
  }

  metrics(): RowMetrics {
    return { rowHeight: this.rowHeight, viewportRows: this.viewportRows };
  }

  lastError(): CoreError | null {
    return this.lastFailure;
  }

  invalidateReason(): string | null {
    return this.lastInvalidateReason;
  }

  // ---------------------------------------------------------------- internal

  private computeTarget(scrollTopPx: number): Target {
    const maxStart = Math.max(0, this.totalRows - 1);
    const start = clamp(
      Math.floor(scrollTopPx / this.rowHeight) - this.overscan,
      0,
      maxStart,
    );

    const base = this.viewportRows + 1 + 2 * this.overscan;
    const delta = scrollTopPx - this.lastRequestScrollTopPx;
    const prefetch = Math.abs(delta) > this.overscan * this.rowHeight ? 1 : 0;
    const cappedScreens = this.viewportRows * WINDOW_POLICY.maxScreens;
    const count = Math.max(
      1,
      Math.min(
        this.totalRows - start,
        Math.min(base + prefetch * this.viewportRows, Math.max(cappedScreens, base)),
      ),
    );
    return { start, count };
  }

  private pump(): void {
    if (this.inFlight) return;
    if (this.rootId === null) return;

    // 空文档：不发请求，直接给一个空且非 stale 的窗口
    if (this.totalRows <= 0) {
      this.desired = null;
      if (this.current.stale) {
        this.current = {
          ...this.current,
          rows: [],
          totalRows: 0,
          start: 0,
          stale: false,
          scrollTopPx: this.scrollTopPx,
        };
        this.emit();
      }
      return;
    }

    const target = this.desired;
    if (!target) return;
    // 已覆盖同一窗口（同 start 且行数不更少）就不再取
    if (this.lastSent && target.start === this.lastSent.start && target.count <= this.lastSent.count) {
      return;
    }
    if (target.count <= 0) return;
    this.send(target);
  }

  private send(target: Target): void {
    if (this.rootId === null) return;
    const seq = ++this.seq;
    const sent: SentRequest = {
      seq,
      epoch: this.epoch,
      target,
      scrollTopPx: this.scrollTopPx,
    };
    this.inFlight = sent;
    this.desired = target;
    this.lastRequestScrollTopPx = this.scrollTopPx;

    const request: WindowRequest = {
      rootId: this.rootId,
      rowVersion: this.rowVersion,
      seq,
      start: target.start,
      count: target.count,
    };
    void this.api.window(request).then(
      (reply) => {
        this.handleReply(sent, reply);
      },
      (error: unknown) => {
        this.handleError(sent, error);
      },
    );
  }

  private handleReply(sent: SentRequest, reply: RowWindow): void {
    if (this.inFlight !== sent) return; // 已被更新的请求取代
    this.inFlight = null;

    if (sent.epoch !== this.epoch) {
      this.pump();
      return;
    }
    // 过期回包：seq 落后 / 根不符 / rowVersion 不符 → 丢弃且不 notify（STALE_ROW 内部消化）
    if (reply.seq !== sent.seq || reply.rootId !== this.rootId || reply.rowVersion !== this.rowVersion) {
      this.dropAndResend();
      return;
    }

    this.totalRows = Math.max(0, reply.totalRows);
    this.lastSent = sent.target;
    this.lastFailure = null;
    this.current = {
      rootId: reply.rootId,
      rows: reply.rows,
      totalRows: this.totalRows,
      start: reply.start,
      rowVersion: reply.rowVersion,
      stale: false,
      scrollTopPx: this.scrollTopPx,
    };
    this.emit();
    this.pump();
  }

  private handleError(sent: SentRequest, error: unknown): void {
    if (this.inFlight !== sent) return;
    this.inFlight = null;

    if (sent.epoch !== this.epoch) {
      this.pump();
      return;
    }

    const coreError = CoreError.from(error);

    // 过期/竞争：当作回包被丢弃，重取即可，不标记 stale
    if (coreError.code === 'STALE_ROW' || coreError.code === 'STALE_ROOT') {
      this.dropAndResend();
      return;
    }
    if (coreError.code === 'CANCELLED' || coreError.code === 'CLOSED') {
      this.lastSent = null;
      return;
    }

    // 失败降级：保留上一帧并 notify；不自动重试，避免失败风暴
    this.lastFailure = coreError;
    this.lastSent = null;
    this.current = { ...this.current, stale: true, scrollTopPx: this.scrollTopPx };
    this.emit();
  }

  private dropAndResend(): void {
    this.lastSent = null;
    if (this.desired === null) this.desired = this.computeTarget(this.scrollTopPx);
    this.pump();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.current;
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}
