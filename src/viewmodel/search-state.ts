/**
 * viewmodel/search-state — 搜索状态机（slice 4）。
 *
 * 纯 TS、零 DOM：持有命中集（未过滤 + 过滤后）、当前命中、docRevision 过期判定、
 * 以及结果列表虚拟窗口的纯计算。视图只消费 `view()` 快照与常量，不反向依赖。
 *
 * 过期语义（与 RowWindowSource 的 seq/rowVersion 校验同构）：
 *   - `begin()` 递增 seq 并清空旧结果 → 旧回包因 `reply.seq !== seq` 被丢弃；
 *   - `apply(reply, docRevision)` 校验 `reply.docRevision`，不匹配 → 清空 + stale
 *     （文档已变更，提示重搜）；
 *   - `markStale()` 用于文档变更时主动作废当前命中集。
 *
 * 契约：docs/design/slice4-search-contract.md §2（权威）。
 */
import type { Hit } from '../protocol/types';

export type SearchFilter = 'all' | 'key' | 'value';
export type SearchPhase = 'idle' | 'searching' | 'ready' | 'stale';

/** 结果行高（px）；虚拟列表 spacer = size × 行高 */
export const SEARCH_RESULT_ROW_HEIGHT = 44;
/** 结果列表上下额外渲染的行数 */
export const SEARCH_RESULT_OVERSCAN = 4;

export interface SearchCounts {
  all: number;
  key: number;
  value: number;
}

/** core.search 回包里与视图相关的最小形状 */
export interface SearchReplyInput {
  seq: number;
  docRevision: number;
  hits: Hit[];
  total: number;
  truncated: boolean;
}

export interface SearchWindow {
  start: number;
  count: number;
}

/** 交给 SearchPanel.render() 的只读快照 */
export interface SearchPanelView {
  query: string;
  phase: SearchPhase;
  /** 过滤后的命中（current 索引指向这个数组） */
  hits: readonly Hit[];
  counts: SearchCounts;
  /** 回包 total（未过滤） */
  total: number;
  /** 过滤后数量 = hits.length */
  size: number;
  /** -1 = 没有当前命中 */
  current: number;
  filter: SearchFilter;
  truncated: boolean;
}

export interface SearchStateOptions {
  rowHeight?: number; // 默认 SEARCH_RESULT_ROW_HEIGHT
  overscan?: number; // 默认 SEARCH_RESULT_OVERSCAN
  filter?: SearchFilter; // 默认 'all'
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const EMPTY_COUNTS: SearchCounts = { all: 0, key: 0, value: 0 };

/**
 * 结果列表虚拟窗口（纯函数，测试友好）：
 *   start = clamp(floor(scrollTop / rowHeight) - overscan, 0, size)
 *   count = min(viewportRows + 2*overscan, size - start)
 * size <= 0 → 空窗口；scrollTop 负值按 0；viewportRows 向下取整且 >= 0。
 */
export function computeResultWindow(
  size: number,
  scrollTop: number,
  viewportRows: number,
  opts: { rowHeight?: number; overscan?: number } = {},
): SearchWindow {
  const rowHeight = opts.rowHeight ?? SEARCH_RESULT_ROW_HEIGHT;
  const overscan = opts.overscan ?? SEARCH_RESULT_OVERSCAN;
  if (size <= 0) return { start: 0, count: 0 };

  const rows = Math.max(0, Math.floor(Number.isFinite(viewportRows) ? viewportRows : 0));
  const scrollPx = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const start = clamp(Math.floor(scrollPx / rowHeight) - overscan, 0, size);
  const count = Math.max(0, Math.min(rows + 2 * overscan, size - start));
  return { start, count };
}

export class SearchState {
  readonly rowHeight: number;
  readonly overscan: number;

  // seq：最近一次 begin 的序号；初始 0（第一次 begin 返回 1）
  private seqValue = 0;
  private queryValue = '';
  private phaseValue: SearchPhase = 'idle';
  private pendingValue = false;
  private staleValue = false;
  private filterValue: SearchFilter;

  /** 回包原序（未过滤） */
  private allHitsValue: Hit[] = [];
  /** 过滤后列表；同一批内引用稳定（面板据此判断是否回顶列表） */
  private hitsValue: readonly Hit[] = [];
  private countsValue: SearchCounts = EMPTY_COUNTS;
  private totalValue = 0;
  private truncatedValue = false;
  /** 过滤后下标；-1 = 无当前命中 */
  private currentValue = -1;

  // 派生缓存：同一批命中只建一次 Set / Map（37k 命中时避免每次导航重算）
  private hitPathsCache: ReadonlySet<string> | null = null;
  private indexCache: Map<string, number> | null = null;

  constructor(opts: SearchStateOptions = {}) {
    this.rowHeight = opts.rowHeight ?? SEARCH_RESULT_ROW_HEIGHT;
    this.overscan = opts.overscan ?? SEARCH_RESULT_OVERSCAN;
    this.filterValue = opts.filter ?? 'all';
  }

  get seq(): number {
    return this.seqValue;
  }

  get query(): string {
    return this.queryValue;
  }

  get stale(): boolean {
    return this.staleValue;
  }

  get pending(): boolean {
    return this.pendingValue;
  }

  get filter(): SearchFilter {
    return this.filterValue;
  }

  /** 过滤后命中（current 指向它） */
  get hits(): readonly Hit[] {
    return this.hitsValue;
  }

  /** 未过滤命中（回包原序） */
  get allHits(): readonly Hit[] {
    return this.allHitsValue;
  }

  get counts(): SearchCounts {
    return this.countsValue;
  }

  /** 回包 total（未过滤；truncated 时可能大于 allHits.length） */
  get total(): number {
    return this.totalValue;
  }

  get size(): number {
    return this.hitsValue.length;
  }

  get truncated(): boolean {
    return this.truncatedValue;
  }

  get current(): number {
    return this.currentValue;
  }

  currentHit(): Hit | null {
    return this.currentValue >= 0 ? (this.hitsValue[this.currentValue] ?? null) : null;
  }

  /** 全部命中（未过滤）的 path 集，树高亮用；同一批内返回同一 Set 实例。 */
  hitPaths(): ReadonlySet<string> {
    if (this.hitPathsCache === null) {
      const paths = new Set<string>();
      for (const hit of this.allHitsValue) paths.add(hit.path);
      this.hitPathsCache = paths;
    }
    return this.hitPathsCache;
  }

  /** 未过滤命中里的下标（bridge 到 core.rowOfPath 等）；找不到 -1。 */
  indexOfPath(path: string): number {
    if (this.indexCache === null) {
      const index = new Map<string, number>();
      for (let i = 0; i < this.allHitsValue.length; i += 1) {
        const hit = this.allHitsValue[i];
        if (hit && !index.has(hit.path)) index.set(hit.path, i);
      }
      this.indexCache = index;
    }
    return this.indexCache.get(path) ?? -1;
  }

  /**
   * 开始一次搜索：seq += 1、清空旧结果、pending=true；
   * query === '' 时 pending=false（idle，用于清空/重载）。
   */
  begin(query: string): number {
    this.seqValue += 1;
    this.queryValue = query;
    const idle = query === '';
    this.pendingValue = !idle;
    this.staleValue = false;
    this.clearResults();
    this.phaseValue = idle ? 'idle' : 'searching';
    return this.seqValue;
  }

  /**
   * 采纳回包。返回 true 表示已采纳：
   *   - reply.seq !== 当前 seq → 忽略，返回 false（不改任何状态）
   *   - reply.docRevision !== 入参 docRevision → 清空结果 + stale=true + pending=false，返回 false
   *   - 其它：写入 hits/total/truncated，重算 counts/过滤/hitPaths，current=首条或 -1，
   *     pending=false、stale=false，返回 true
   */
  apply(reply: SearchReplyInput, docRevision: number): boolean {
    if (reply.seq !== this.seqValue) return false;

    if (reply.docRevision !== docRevision) {
      this.clearResults();
      this.pendingValue = false;
      this.staleValue = true;
      this.phaseValue = 'stale';
      return false;
    }

    this.allHitsValue = reply.hits;
    this.totalValue = reply.total;
    this.truncatedValue = reply.truncated;
    this.recomputeCounts();
    this.rebuildFiltered();
    this.hitPathsCache = null;
    this.indexCache = null;
    this.currentValue = this.hitsValue.length > 0 ? 0 : -1;
    this.pendingValue = false;
    this.staleValue = false;
    this.phaseValue = 'ready';
    return true;
  }

  /**
   * 文档已变更：清空结果 + stale=true；返回状态是否发生变化（已 stale 且无结果 → false）。
   * 查询词保留，视图据此提示「文档已修改，请重新搜索」。
   */
  markStale(): boolean {
    const changed = !this.staleValue || this.pendingValue || this.allHitsValue.length > 0;
    this.clearResults();
    this.pendingValue = false;
    this.staleValue = true;
    this.phaseValue = 'stale';
    return changed;
  }

  /** 清空 query/结果/current/stale（seq 不变；filter 是用户偏好，保留）。 */
  clear(): void {
    this.queryValue = '';
    this.pendingValue = false;
    this.staleValue = false;
    this.clearResults();
    this.phaseValue = 'idle';
  }

  /** 切换过滤；重建过滤列表、current 夹到 [0, size-1]（空 → -1）。counts 与过滤无关，不重算。 */
  setFilter(filter: SearchFilter): void {
    this.filterValue = filter;
    this.rebuildFiltered();
    this.currentValue =
      this.hitsValue.length === 0 ? -1 : clamp(this.currentValue, 0, this.hitsValue.length - 1);
  }

  /** 选中过滤后下标（向下取整 + 夹紧）；返回 current；size 为 0 → -1。 */
  select(index: number): number {
    const size = this.hitsValue.length;
    if (size === 0) {
      this.currentValue = -1;
      return -1;
    }
    const base = Number.isFinite(index) ? Math.floor(index) : 0;
    this.currentValue = clamp(base, 0, size - 1);
    return this.currentValue;
  }

  /** 环状导航：size 0 → -1；current<0 时 next→0；否则 +1 取模。 */
  next(): number {
    const size = this.hitsValue.length;
    if (size === 0) {
      this.currentValue = -1;
      return -1;
    }
    this.currentValue = this.currentValue < 0 ? 0 : (this.currentValue + 1) % size;
    return this.currentValue;
  }

  /** 环状导航：size 0 → -1；current<0 时 prev→size-1；否则 -1 取模。 */
  prev(): number {
    const size = this.hitsValue.length;
    if (size === 0) {
      this.currentValue = -1;
      return -1;
    }
    this.currentValue = this.currentValue < 0 ? size - 1 : (this.currentValue - 1 + size) % size;
    return this.currentValue;
  }

  view(): SearchPanelView {
    return {
      query: this.queryValue,
      phase: this.phaseValue,
      hits: this.hitsValue,
      counts: this.countsValue,
      total: this.totalValue,
      size: this.hitsValue.length,
      current: this.currentValue,
      filter: this.filterValue,
      truncated: this.truncatedValue,
    };
  }

  contentHeight(): number {
    return this.hitsValue.length * this.rowHeight;
  }

  window(scrollTop: number, viewportRows: number): SearchWindow {
    return computeResultWindow(this.hitsValue.length, scrollTop, viewportRows, {
      rowHeight: this.rowHeight,
      overscan: this.overscan,
    });
  }

  // ---------------------------------------------------------------- internal

  private clearResults(): void {
    this.allHitsValue = [];
    this.hitsValue = [];
    this.countsValue = EMPTY_COUNTS;
    this.totalValue = 0;
    this.truncatedValue = false;
    this.currentValue = -1;
    this.hitPathsCache = null;
    this.indexCache = null;
  }

  /** counts 始终统计未过滤的 allHits（不依赖 key+value=all 的假设）。 */
  private recomputeCounts(): void {
    let key = 0;
    let value = 0;
    for (const hit of this.allHitsValue) {
      if (hit.field === 'key') key += 1;
      else if (hit.field === 'value') value += 1;
    }
    this.countsValue = { all: this.allHitsValue.length, key, value };
  }

  private rebuildFiltered(): void {
    this.hitsValue =
      this.filterValue === 'all'
        ? this.allHitsValue
        : this.allHitsValue.filter((hit) => hit.field === this.filterValue);
  }
}
