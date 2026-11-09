/**
 * viewmodel/window-machine — S2：窗口状态机（2026-11-09 收口，ADR-0008 修订）。
 *
 * 行窗口与原文行窗口共用的**唯一**一份规则实现：
 *   - 几何：像素 scrollTop ↔ 起始行换算（overscan / 可选方向预取 / 可选单次屏数上限）
 *   - 单飞 + 合并：同一时刻最多 1 个 in-flight，新目标覆盖排队目标
 *   - `epoch` / `seq` 丢弃：换根、迟到回包一律丢弃、不 notify
 *   - 统一过期重试：`STALE_ROW`/`STALE_ROOT`/`STALE_DOC` 自动重取、上限 3、成功清零
 *   - 失败降级：`stale=true` 保留上一帧，view 显示细的「加载中」而不是空白列表
 *   - 空窗口帧：目标计数为 0 时发空且非 stale 的帧
 *   - 滚动锚点：toggle / replaceNode 前后记 (row, offsetPx)，视口不跳
 *
 * 两个 adapter（`RowWindowSource` / `RawWindowSource`）只供四个能力：
 *   `fetchWindow`（发请求）、`validate`（判迟到/错根/错版本）、
 *   `toSnapshot`（回包 → 不可变快照 + 元信息）、`frame`（空窗口 / 保留帧 / stale 降级帧）。
 * 不依赖 DOM、不依赖定时器（可单测）。
 *
 * 契约见 docs/architecture/seams.md §3；版本语义见 docs/adr/0001；
 * 决策见 ADR-0008 修订（2026-11-09）。
 */
import type { RootId } from '../protocol/types';
import { CoreError } from '../protocol/errors';
import { OVERSCAN, ROW_HEIGHT } from '../protocol/versions';
import { clampInt } from '../shared/num';

/** 唯一允许从 view 进入逻辑层的视觉参数 */
export interface WindowMetrics {
  rowHeight: number;
  viewportRows: number;
}

export interface Target {
  start: number;
  count: number;
}

export interface Anchor {
  row: number;
  offsetPx: number;
}

export interface MachineOptions {
  rowHeight?: number;
  overscan?: number;
  /** 方向预取：跨过 overscan 个行高时多取 1 屏 */
  prefetch?: boolean;
  /** 单次窗口最多几屏（不设 = 不封顶） */
  maxScreens?: number;
}

/** 传给 adapter 的请求上下文（machine 持有的根/版本 + 本次请求的 seq/目标） */
export interface RequestContext {
  rootId: RootId;
  version: number;
  seq: number;
  target: Target;
  scrollTopPx: number;
}

/** 非成功帧（空窗口 / 保留上一帧 / stale 降级）的元信息 */
export interface FrameMeta {
  rootId: RootId;
  total: number;
  version: number;
  start: number;
  stale: boolean;
  scrollTopPx: number;
}

export interface SnapshotResult<P> {
  snapshot: P;
  total: number;
  version: number;
  start: number;
}

/**
 * S2 adapter：只做映射，不持有窗口规则。
 * - `validate` 返回 false = 迟到/错根/错版本 → machine 丢弃并按当前目标重取（不 notify）
 * - `frame(meta, prev)`：`prev` 非空 = 保留上一帧（只改元信息）；空 = 空帧
 */
export interface WindowAdapter<P, R> {
  fetchWindow(target: Target, ctx: RequestContext): Promise<R>;
  validate(reply: R, ctx: RequestContext): boolean;
  toSnapshot(reply: R, ctx: { scrollTopPx: number }): SnapshotResult<P>;
  frame(meta: FrameMeta, prev: P | null): P;
}

interface SentRequest {
  seq: number;
  epoch: number;
  target: Target;
  scrollTopPx: number;
}

/** 过期/竞争类错误：自动重取（不标 stale），上限 3 次防风暴 */
const STALE_CODES = new Set(['STALE_ROW', 'STALE_ROOT', 'STALE_DOC']);
const MAX_STALE_RESENDS = 3;

export class WindowMachine<P, R> {
  private readonly adapter: WindowAdapter<P, R>;
  private readonly overscan: number;
  private readonly prefetch: boolean;
  private readonly maxScreens: number | null;
  private rowHeight: number;
  private viewportRows = 0;

  private rootId: RootId | null = null;
  private version = 0;
  private total = 0;

  private current: P;
  private currentStale = true;
  private currentStart = 0;
  /** 当前帧是否带 payload（决定空窗口/换版本时是否值得保留上一帧） */
  private payloadPresent = false;
  private readonly listeners = new Set<(snapshot: P) => void>();

  private scrollTopPx = 0;
  private lastRequestScrollTopPx = 0;

  private seq = 0;
  private epoch = 0;
  private inFlight: SentRequest | null = null;
  private desired: Target | null = null;
  private lastSent: Target | null = null;

  private lastFailure: CoreError | null = null;
  private lastInvalidateReason: string | null = null;
  private staleResends = 0;

  constructor(adapter: WindowAdapter<P, R>, opts: MachineOptions = {}) {
    this.adapter = adapter;
    this.rowHeight = opts.rowHeight ?? ROW_HEIGHT;
    this.overscan = Math.max(0, Math.floor(opts.overscan ?? OVERSCAN));
    this.prefetch = opts.prefetch ?? false;
    this.maxScreens = opts.maxScreens ?? null;
    this.current = adapter.frame(
      { rootId: '', total: 0, version: 0, start: 0, stale: true, scrollTopPx: 0 },
      null,
    );
  }

  /**
   * 换根或换版本：`epoch++`、清空目标与在途目标；同根换版本且上一帧带 payload 时保留上一帧（stale）
   * 避免闪烁。`scrollTopPx`：与换版本同一拍复位滚动锚点（expand-all / collapse-all 的「回顶」）；
   * 不传时保持旧滚动位置（toggle 等「原地变化」路径）。传 0 时保留帧的 `start` 也必须归零，
   * 否则旧 start 的保留帧会被新的小 `total` 裁到视口外（空白帧）。
   */
  setRoot(rootId: RootId, next: { version: number; total: number; scrollTopPx?: number }): void {
    const rootChanged = rootId !== this.rootId;
    this.rootId = rootId;
    this.version = next.version;
    this.total = Math.max(0, next.total);
    this.epoch += 1;
    this.staleResends = 0;
    if (rootChanged) {
      this.scrollTopPx = 0;
      this.lastRequestScrollTopPx = 0;
    }
    const anchorPx =
      next.scrollTopPx !== undefined && Number.isFinite(next.scrollTopPx)
        ? Math.max(0, next.scrollTopPx)
        : null;
    if (anchorPx !== null) {
      this.scrollTopPx = anchorPx;
      this.lastRequestScrollTopPx = anchorPx;
    }

    // 旧 in-flight 不取消：靠 epoch 校验丢弃回包；排队目标清空
    this.inFlight = null;
    this.desired = null;
    this.lastSent = null;

    const keepFrame = !rootChanged && this.payloadPresent;
    if (rootChanged) this.payloadPresent = false;
    const start = anchorPx !== null ? Math.floor(anchorPx / this.rowHeight) : keepFrame ? this.currentStart : 0;
    this.current = this.adapter.frame(
      {
        rootId,
        total: this.total,
        version: this.version,
        start,
        stale: true,
        scrollTopPx: this.scrollTopPx,
      },
      keepFrame ? this.current : null,
    );
    this.currentStale = true;
    this.currentStart = start;
    // 显式锚点：目标窗口在 emit 前就算好，后续 requestWindow 不会从旧滚动位置取中间窗口
    if (anchorPx !== null) this.desired = this.computeTarget(this.scrollTopPx);
    this.emit();
  }

  /** 只改总数（原文 `open` 拿到 `rawOpen` 回包后用它续上首窗请求）；不清帧、不换 epoch。 */
  setTotal(total: number): void {
    this.total = Math.max(0, total);
    this.desired = null;
    this.lastSent = null;
    this.pump();
  }

  /** 清空根与帧（原文 `clear`）：`epoch++` 使在途回包作废。 */
  clear(): void {
    this.epoch += 1;
    this.rootId = null;
    this.version = 0;
    this.total = 0;
    this.scrollTopPx = 0;
    this.lastRequestScrollTopPx = 0;
    this.inFlight = null;
    this.desired = null;
    this.lastSent = null;
    this.lastFailure = null;
    this.staleResends = 0;
    this.payloadPresent = false;
    this.currentStart = 0;
    this.currentStale = true;
    this.current = this.adapter.frame(
      { rootId: '', total: 0, version: 0, start: 0, stale: true, scrollTopPx: 0 },
      null,
    );
  }

  /** 行高 / 视口行数变化后必须重取（renderer 不自行感知）。 */
  setMetrics(next: WindowMetrics): void {
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
    this.rebuildCurrentFrame();
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
    this.currentStale = true;
    this.rebuildCurrentFrame();
    this.lastSent = null;
    this.desired = this.computeTarget(this.scrollTopPx);
    this.emit();
    this.pump();
  }

  snapshot(): P {
    return this.current;
  }

  subscribe(listener: (snapshot: P) => void): () => void {
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

  metrics(): WindowMetrics {
    return { rowHeight: this.rowHeight, viewportRows: this.viewportRows };
  }

  lastError(): CoreError | null {
    return this.lastFailure;
  }

  invalidateReason(): string | null {
    return this.lastInvalidateReason;
  }

  // ---------------------------------------------------------------- internal

  private rebuildCurrentFrame(): void {
    this.current = this.adapter.frame(
      {
        rootId: this.rootId ?? '',
        total: this.total,
        version: this.version,
        start: this.currentStart,
        stale: this.currentStale,
        scrollTopPx: this.scrollTopPx,
      },
      this.current,
    );
  }

  private computeTarget(scrollTopPx: number): Target {
    const maxStart = Math.max(0, this.total - 1);
    const start = clampInt(Math.floor(scrollTopPx / this.rowHeight) - this.overscan, 0, maxStart);

    const base = this.viewportRows + 1 + 2 * this.overscan;
    const delta = scrollTopPx - this.lastRequestScrollTopPx;
    const prefetch = this.prefetch && Math.abs(delta) > this.overscan * this.rowHeight ? 1 : 0;
    let count = base + prefetch * this.viewportRows;
    if (this.maxScreens !== null) {
      count = Math.min(count, Math.max(this.viewportRows * this.maxScreens, base));
    }
    count = Math.max(1, Math.min(this.total - start, count));
    return { start, count };
  }

  private pump(): void {
    if (this.inFlight) return;
    if (this.rootId === null) return;

    // 空窗口：不发请求，直接给一个空且非 stale 的帧（上一帧 stale 或带 payload 时才值得换）
    if (this.total <= 0) {
      this.desired = null;
      if (this.currentStale || this.payloadPresent) {
        this.current = this.adapter.frame(
          {
            rootId: this.rootId,
            total: 0,
            version: this.version,
            start: 0,
            stale: false,
            scrollTopPx: this.scrollTopPx,
          },
          this.payloadPresent ? this.current : null,
        );
        this.currentStale = false;
        this.currentStart = 0;
        this.payloadPresent = false;
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

    const ctx: RequestContext = {
      rootId: this.rootId,
      version: this.version,
      seq,
      target,
      scrollTopPx: sent.scrollTopPx,
    };
    void this.adapter.fetchWindow(target, ctx).then(
      (reply) => {
        this.handleReply(sent, reply);
      },
      (error: unknown) => {
        this.handleError(sent, error);
      },
    );
  }

  private handleReply(sent: SentRequest, reply: R): void {
    if (this.inFlight !== sent) return; // 已被更新的请求取代
    this.inFlight = null;

    if (sent.epoch !== this.epoch) {
      this.pump();
      return;
    }
    const ctx: RequestContext = {
      rootId: this.rootId as RootId,
      version: this.version,
      seq: sent.seq,
      target: sent.target,
      scrollTopPx: sent.scrollTopPx,
    };
    // 过期回包：seq 落后 / 根不符 / 版本不符 → 丢弃且不 notify（STALE_* 内部消化）
    if (!this.adapter.validate(reply, ctx)) {
      this.dropAndResend();
      return;
    }

    const result = this.adapter.toSnapshot(reply, { scrollTopPx: this.scrollTopPx });
    this.total = Math.max(0, result.total);
    this.version = result.version;
    this.currentStart = result.start;
    this.payloadPresent = true;
    this.lastSent = sent.target;
    this.lastFailure = null;
    this.staleResends = 0;
    this.current = result.snapshot;
    this.currentStale = false;
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

    // 过期/竞争：当作回包被丢弃，按当前目标重取；上限防「根已消失」时打成风暴
    if (STALE_CODES.has(coreError.code)) {
      this.staleResends += 1;
      if (this.staleResends > MAX_STALE_RESENDS) {
        this.degrade(coreError);
        return;
      }
      this.dropAndResend();
      return;
    }
    if (coreError.code === 'CANCELLED' || coreError.code === 'CLOSED') {
      this.lastSent = null;
      return;
    }

    this.degrade(coreError);
  }

  /** 失败降级：保留上一帧并 notify；不自动重试，避免失败风暴。 */
  private degrade(coreError: CoreError): void {
    this.lastFailure = coreError;
    this.lastSent = null;
    this.currentStale = true;
    this.rebuildCurrentFrame();
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
