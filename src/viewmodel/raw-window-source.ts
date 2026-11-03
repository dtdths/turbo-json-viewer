/**
 * viewmodel/raw-window-source — 原始文本视图的行窗口状态机（ADR-0003 修订 2026-11-03 §4）。
 *
 * 与 RowWindowSource 同纪律：
 *   - 像素 scrollTop ↔ 起始行换算（唯一进入逻辑层的视觉参数是 RawMetrics）
 *   - 单飞 + 合并：同一时刻最多 1 个 in-flight，新目标覆盖排队目标
 *   - seq 单调：迟到 / 乱序回包丢弃且不 notify，随后按当前目标重取
 *   - epoch：open 竞态（换根 / 重进原文视图）时旧回包一律作废
 *   - 失败降级：stale=true 保留上一帧，view 显示细提示而不是空白列表
 *
 * 与树视图的差异（ADR-0003 修订 §4）：
 *   - 原文**没有 rowVersion**：源文本只在文档被替换时消失，doc 生命周期即版本；
 *   - `open()` 是两次往返的第一步（rawOpen 建/取索引 → rawWindow 取首窗），
 *     rawOpen 未就绪前不发行窗口，`ready` 标志挡住「把空文档误当已就绪」；
 *   - 不做方向预取：原文窗口只是一段行文本切片，count = viewportRows + 1 + 2 × overscan，
 *     渲染行数因此恰好等于「屏行 + 两倍 overscan」（ADR-0003 §7 冒烟口径）。
 *
 * 不依赖 DOM，不依赖定时器（可单测）。
 */
import type { CoreApi } from '../protocol/core-api';
import { CoreError } from '../protocol/errors';
import type { RawMeta, RawMode, RawWindow, RootId } from '../protocol/types';
import { OVERSCAN, ROW_HEIGHT } from '../protocol/versions';

/** 唯一允许从 view 进入逻辑层的视觉参数 */
export interface RawMetrics {
  rowHeight: number;
  viewportRows: number;
}

/** 原文视图一帧：行文本逐字来自 Worker（≤ RAW_LINE_DISPLAY_MAX 字符/行）。 */
export interface RawSnapshot {
  rootId: RootId;
  mode: RawMode;
  /** 本窗口的行文本（逐字，不可在 view 侧加工） */
  lines: string[];
  /** 与 lines 对齐：该行被截掉的字符数（0 = 完整） */
  truncated: number[];
  /** 本窗口第一行的绝对行号（0-based） */
  start: number;
  totalLines: number;
  /** true = 当前帧可能过期或尚未就绪（失败 / 重取中） */
  stale: boolean;
  scrollTopPx: number;
}

export interface RawWindowOptions {
  rowHeight?: number;
  overscan?: number;
}

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

/** STALE_* 连续重取上限：根已消失时不要打成失败/消息风暴。 */
const MAX_STALE_RESENDS = 3;

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const EMPTY_SNAPSHOT: RawSnapshot = {
  rootId: '',
  mode: 'source',
  lines: [],
  truncated: [],
  start: 0,
  totalLines: 0,
  stale: false,
  scrollTopPx: 0,
};

/** 把回包的 truncated（可缺省 / 可短）对齐成与 lines 等长的数组。 */
function alignTruncated(count: number, source?: number[]): number[] {
  const out = new Array<number>(count).fill(0);
  if (!source) return out;
  const n = Math.min(count, source.length);
  for (let i = 0; i < n; i++) out[i] = source[i] ?? 0;
  return out;
}

export class RawWindowSource {
  private readonly api: CoreApi;
  private readonly overscan: number;
  private rowHeight: number;
  private viewportRows = 0;

  private rootId: RootId | null = null;
  /** rawOpen 成功且 meta 已落地的标志：之前不发 rawWindow（totalLines 还未知） */
  private ready = false;
  private totalLines = 0;

  private current: RawSnapshot = { ...EMPTY_SNAPSHOT };
  private readonly listeners = new Set<(snapshot: RawSnapshot) => void>();

  private scrollTopPx = 0;

  private seq = 0;
  private epoch = 0;
  private inFlight: SentRequest | null = null;
  private desired: Target | null = null;
  private lastSent: Target | null = null;

  private lastFailure: CoreError | null = null;
  private staleResends = 0;

  constructor(api: CoreApi, opts: RawWindowOptions = {}) {
    this.api = api;
    this.rowHeight = opts.rowHeight && opts.rowHeight > 0 ? opts.rowHeight : ROW_HEIGHT;
    this.overscan = Math.max(0, Math.floor(opts.overscan ?? OVERSCAN));
  }

  /**
   * 打开原文视图（换根 / 从树视图切回来）：回到顶部，先给一帧 stale（同根重进保留旧的不可变行文本，
   * 避免闪白），再 rawOpen 取索引元信息，成功后 pump 首窗。
   *
   * rawOpen 失败时：emit stale 帧 + 记录 lastError，然后 **reject**（调用方负责 catch / 展示错误）。
   */
  async open(rootId: RootId): Promise<RawMeta> {
    const epoch = ++this.epoch;
    const rootChanged = rootId !== this.rootId;

    this.rootId = rootId;
    this.ready = false;
    this.totalLines = 0;
    this.scrollTopPx = 0;
    this.inFlight = null;
    this.desired = null;
    this.lastSent = null;
    this.lastFailure = null;
    this.staleResends = 0;

    // 原文行文本在 doc 生命周期内不变：同根重进保留上一帧（stale），换根必须清空（不能显示旧文档）。
    // 保留帧连 start 一起保留 —— 行号是绝对行号，只留文本不留位置会让 gutter 说谎。
    const keep = !rootChanged && this.current.lines.length > 0;
    this.current = {
      rootId,
      mode: keep ? this.current.mode : 'source',
      lines: keep ? this.current.lines : [],
      truncated: keep ? this.current.truncated : [],
      start: keep ? this.current.start : 0,
      totalLines: keep ? this.current.totalLines : 0,
      stale: true,
      scrollTopPx: 0,
    };
    this.emit();

    let meta: RawMeta;
    try {
      meta = await this.api.rawOpen({ rootId });
    } catch (error) {
      const coreError = CoreError.from(error);
      if (epoch === this.epoch) {
        this.lastFailure = coreError;
        this.ready = false;
        this.current = { ...this.current, stale: true, scrollTopPx: 0 };
        this.emit();
      }
      throw coreError;
    }

    // 被更新的 open 取代：不改状态（状态已归新一次 open 所有）
    if (epoch !== this.epoch) return meta;

    this.ready = true;
    this.totalLines = Math.max(0, meta.totalLines);
    this.current = {
      ...this.current,
      rootId,
      mode: meta.mode,
      totalLines: this.totalLines,
      stale: true,
      scrollTopPx: 0,
    };
    this.emit();

    this.desired = this.computeTarget(0);
    this.pump();
    return meta;
  }

  /** 关闭原文视图 / 文档被替换：清空状态并使在途回包作废（seq 不回绕，迟到回包永远 seq 更小）。 */
  clear(): void {
    this.epoch += 1;
    this.rootId = null;
    this.ready = false;
    this.totalLines = 0;
    this.scrollTopPx = 0;
    this.inFlight = null;
    this.desired = null;
    this.lastSent = null;
    this.lastFailure = null;
    this.staleResends = 0;
    this.current = { ...EMPTY_SNAPSHOT };
    this.emit();
  }

  /** 行高 / 视口行数变化后必须重取（renderer 不自行感知）。 */
  setMetrics(next: RawMetrics): void {
    const rowHeight =
      Number.isFinite(next.rowHeight) && next.rowHeight > 0 ? next.rowHeight : this.rowHeight;
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

  snapshot(): RawSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: RawSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  metrics(): RawMetrics {
    return { rowHeight: this.rowHeight, viewportRows: this.viewportRows };
  }

  lastError(): CoreError | null {
    return this.lastFailure;
  }

  // ---------------------------------------------------------------- internal

  private computeTarget(scrollTopPx: number): Target {
    const maxStart = Math.max(0, this.totalLines - 1);
    const start = clamp(Math.floor(scrollTopPx / this.rowHeight) - this.overscan, 0, maxStart);
    const count = Math.max(
      1,
      Math.min(this.totalLines - start, this.viewportRows + 1 + 2 * this.overscan),
    );
    return { start, count };
  }

  private pump(): void {
    if (this.inFlight) return;
    if (this.rootId === null || !this.ready) return;

    // 空文档：不发请求，直接给空且非 stale 的窗口
    if (this.totalLines <= 0) {
      this.desired = null;
      if (this.current.stale || this.current.lines.length > 0) {
        this.current = {
          ...this.current,
          lines: [],
          truncated: [],
          start: 0,
          totalLines: 0,
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

    void this.api
      .rawWindow({ rootId: this.rootId, seq, start: target.start, count: target.count })
      .then(
        (reply) => {
          this.handleReply(sent, reply);
        },
        (error: unknown) => {
          this.handleError(sent, error);
        },
      );
  }

  private handleReply(sent: SentRequest, reply: RawWindow): void {
    if (this.inFlight !== sent) return; // 已被 open / clear 取代
    this.inFlight = null;

    if (sent.epoch !== this.epoch) {
      this.pump();
      return;
    }
    // 过期回包：seq 不符 / 根不符 → 丢弃且不 notify，按当前目标重取
    if (reply.seq !== sent.seq || reply.rootId !== this.rootId) {
      this.dropAndResend();
      return;
    }

    this.totalLines = Math.max(0, reply.totalLines);
    this.lastSent = sent.target;
    this.lastFailure = null;
    this.staleResends = 0;
    this.current = {
      rootId: reply.rootId,
      mode: reply.mode,
      lines: reply.lines,
      truncated: alignTruncated(reply.lines.length, reply.truncated),
      start: reply.start,
      totalLines: this.totalLines,
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

    // 过期/竞争：当作回包被丢弃，按当前目标重取（有上限，防根已消失时打成风暴）
    if (
      coreError.code === 'STALE_ROW' ||
      coreError.code === 'STALE_ROOT' ||
      coreError.code === 'STALE_DOC'
    ) {
      this.staleResends += 1;
      if (this.staleResends > MAX_STALE_RESENDS) {
        this.lastFailure = coreError;
        this.lastSent = null;
        this.current = { ...this.current, stale: true, scrollTopPx: this.scrollTopPx };
        this.emit();
        return;
      }
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
