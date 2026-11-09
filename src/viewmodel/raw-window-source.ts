/**
 * viewmodel/raw-window-source — 原文视图的**窗口 adapter**（ADR-0003 修订 2026-11-03 §4 / ADR-0008 修订 2026-11-09）。
 *
 * 窗口规则（单飞 / 合并 / `seq` 丢弃 / `epoch` / stale 帧 / 过期重试 / overscan）已收口到
 * `WindowMachine`；本模块只剩原文侧的三件事：
 *   - **两拍 open**：`rawOpen` 建/取行索引 → `rawWindow` 取首窗；`rawOpen` 落地前不发窗口请求（ready 门）
 *   - 映射：`RawWindow` → `RawSnapshot { mode, lines, truncated, start, totalLines, stale, scrollTopPx }`
 *     （`truncated` 按 `lines` 对齐；`mode` 随回包更新）
 *   - 差异配置：不做方向预取（`count = viewportRows + 1 + 2 × overscan`，ADR-0003 §7 冒烟口径）
 *
 * 原文**没有 rowVersion**：源文本只在文档被替换时消失，doc 生命周期即版本。
 * 公开 interface 不变（调用方 app/view 不改）。
 */
import type { CoreApi } from '../protocol/core-api';
import { CoreError } from '../protocol/errors';
import type { RawMeta, RawMode, RawWindow, RootId } from '../protocol/types';
import { OVERSCAN, ROW_HEIGHT } from '../protocol/versions';
import { WindowMachine } from './window-machine';
import type { SnapshotResult, Target, WindowAdapter } from './window-machine';

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

/** 把回包的 truncated（可缺省 / 可短）对齐成与 lines 等长的数组。 */
function alignTruncated(count: number, source?: number[]): number[] {
  const out = new Array<number>(count).fill(0);
  if (!source) return out;
  const n = Math.min(count, source.length);
  for (let i = 0; i < n; i++) out[i] = source[i] ?? 0;
  return out;
}

/** 原文侧 adapter：只做 rawWindow 请求/校验/快照映射，不含窗口规则。 */
function createRawAdapter(api: CoreApi): WindowAdapter<RawSnapshot, RawWindow> {
  return {
    fetchWindow(target: Target, ctx): Promise<RawWindow> {
      return api.rawWindow({
        rootId: ctx.rootId,
        seq: ctx.seq,
        start: target.start,
        count: target.count,
      });
    },

    validate(reply, ctx): boolean {
      // 原文没有 rowVersion：seq / rootId 两重校验
      return reply.seq === ctx.seq && reply.rootId === ctx.rootId;
    },

    toSnapshot(reply, ctx): SnapshotResult<RawSnapshot> {
      return {
        snapshot: {
          rootId: reply.rootId,
          mode: reply.mode,
          lines: reply.lines,
          truncated: alignTruncated(reply.lines.length, reply.truncated),
          start: reply.start,
          totalLines: reply.totalLines,
          stale: false,
          scrollTopPx: ctx.scrollTopPx,
        },
        total: reply.totalLines,
        version: 0,
        start: reply.start,
      };
    },

    frame(meta, prev): RawSnapshot {
      // mode：`extra.mode`（rawOpen 回包）优先，其次沿用上一帧，首帧默认 source
      const mode = (meta.extra?.mode as RawMode | undefined) ?? (prev ? prev.mode : 'source');
      return {
        rootId: meta.rootId,
        mode,
        lines: prev ? prev.lines : [],
        truncated: prev ? prev.truncated : [],
        start: meta.start,
        totalLines: meta.total,
        stale: meta.stale,
        scrollTopPx: meta.scrollTopPx,
      };
    },
  };
}

export class RawWindowSource {
  private readonly api: CoreApi;
  private readonly machine: WindowMachine<RawSnapshot, RawWindow>;

  constructor(api: CoreApi, opts: RawWindowOptions = {}) {
    this.api = api;
    this.machine = new WindowMachine(createRawAdapter(api), {
      rowHeight: opts.rowHeight && opts.rowHeight > 0 ? opts.rowHeight : ROW_HEIGHT,
      overscan: Math.max(0, Math.floor(opts.overscan ?? OVERSCAN)),
      prefetch: false,
    });
  }

  /**
   * 打开原文视图（换根 / 从树视图切回来）：回到顶部，先给一帧 stale（同根重进保留旧的不可变行文本，
   * 避免闪白），再 `rawOpen` 取索引元信息，成功后 pump 首窗。
   *
   * `rawOpen` 失败时：emit stale 帧 + 记录 lastError，然后 **reject**（调用方负责 catch / 展示错误）。
   * 被后来者取代的 open 不改状态、也不 reject 伤害新一次 open。
   */
  async open(rootId: RootId): Promise<RawMeta> {
    const epoch = this.machine.openRoot(rootId);

    let meta: RawMeta;
    try {
      meta = await this.api.rawOpen({ rootId });
    } catch (error) {
      const coreError = CoreError.from(error);
      // 被更新的 open 取代：不改状态（状态已归新一次 open 所有）
      if (this.machine.isEpoch(epoch)) this.machine.failOpen(coreError);
      throw coreError;
    }

    // 被更新的 open 取代：不改状态
    if (!this.machine.isEpoch(epoch)) return meta;

    this.machine.refreshStale(meta.totalLines, { mode: meta.mode });
    this.machine.setReady(true);
    this.machine.requestWindow();
    return meta;
  }

  /** 关闭原文视图 / 文档被替换：清空状态并使在途回包作废（seq 不回绕，迟到回包永远 seq 更小）。 */
  clear(): void {
    this.machine.clear();
  }

  /** 行高 / 视口行数变化后必须重取（renderer 不自行感知）。 */
  setMetrics(next: RawMetrics): void {
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

  snapshot(): RawSnapshot {
    return this.machine.snapshot();
  }

  subscribe(listener: (snapshot: RawSnapshot) => void): () => void {
    return this.machine.subscribe(listener);
  }

  metrics(): RawMetrics {
    return this.machine.metrics();
  }

  lastError(): CoreError | null {
    return this.machine.lastError();
  }
}
