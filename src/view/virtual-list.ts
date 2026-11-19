/**
 * view/virtual-list — 虚拟列表的**几何与池化**（候选 5 / seams S3b，2026-11-19）。
 *
 * 四个列表（搜索结果 / 大纲 / 树 / 原文）此前各自手写「scroller + spacer、槽位池的增删、
 * 越界槽位隐藏、复用时的清理纪律、ResizeObserver、rendered 计数」，其中 search 与 outline
 * 几乎逐行同构。本模块把**「什么时候做什么」**收成一份，把**「长什么样」**留给面板：
 *
 *   - 模块只碰槽位元素的 `style.top` 与 `hidden`（`Q3`：DOM 形状是冒烟断言的依据）；
 *   - 槽位元素由面板经 `createSlot()` 造，内容由 `paint(ctx)` 填；
 *   - 槽位被窗口淘汰时调用 `clearSlot(el)`——**清理的时机**归模块，**清什么**归面板
 *     （幽灵 mark / 残留 title / 残留可点态是四份实现里最容易漏的地方）。
 *
 * 边界（`Q7`）：`size` 是**显示几条**，不是数据有几条。搜索结果的 size 是过滤后的可见命中数，
 * 而它索引的是全部命中数组；索引映射一律归面板，模块永不读数据数组。
 *
 * 行高与 overscan 由调用方给（树来自设置、search 44/4、大纲 24/6、原文固定行高）；
 * spacer 高度 = `min(size × rowHeight, MAX_SCROLL_PX)`（与树/原文/大纲既有口径一致；
 * 搜索的命中上限 5 万 × 44px 远小于上限，实际等价）。
 *
 * 滚动与尺寸变化：默认自己监听（search / 大纲是自包含列表）；树与原文的重画由 app 的窗口回包驱动，
 * 用 `drawOnScroll: false` / `drawOnResize: false` 关掉、只留 `onScroll` 回调去请求窗口。
 */
import { MAX_SCROLL_PX } from '../protocol/versions';
import { computeVirtualWindow } from '../shared/window';

/** 一次重画的上下文。`top` 是槽位的像素位置（模块已写入 `el.style.top`）。 */
export interface VirtualPaint {
  index: number;
  top: number;
  el: HTMLElement;
  /** true = 这个槽位上一帧显示的是同一个 index（面板可据此跳过重建；不强制） */
  reuse: boolean;
}

export interface VirtualListOptions {
  /** 滚动容器（面板已挂进 DOM） */
  scroller: HTMLElement;
  /** 撑高度的 spacer（scroller 的子节点） */
  spacer: HTMLElement;
  /** 槽位挂载点（spacer 的子节点） */
  host: HTMLElement;
  rowHeight: number;
  overscan: number;
  /** 造一个空槽位（class / role / 内部结构由面板决定），模块会 append 到 host */
  createSlot(): HTMLElement;
  /** 填一个可见槽位 */
  paint(ctx: VirtualPaint): void;
  /** 槽位被淘汰时的清理（类名 / dataset / 标题 / 高亮残留） */
  clearSlot(el: HTMLElement): void;
  /** 滚动后回调（树 / 原文用它请求窗口；search 与大纲不需要） */
  onScroll?(scrollTop: number): void;
  /** 每次 draw 结束后的收尾（大纲用它写 aria-activedescendant；search 不需要） */
  afterDraw?(): void;
  /** 默认 true；树 / 原文传 false（它们由 app 的窗口回包驱动重画） */
  drawOnScroll?: boolean;
  /** 默认 true；同上 */
  drawOnResize?: boolean;
}

interface Slot {
  el: HTMLElement;
  /** 上一帧的 index（-1 = 未使用） */
  index: number;
  visible: boolean;
}

export class VirtualList {
  private readonly opts: VirtualListOptions;
  private readonly slots: Slot[] = [];
  private sizeValue = 0;
  private rowHeightValue: number;
  private renderedValue = 0;
  private readonly onScrollBound: () => void;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(opts: VirtualListOptions) {
    this.opts = opts;
    this.rowHeightValue = normalizePositive(opts.rowHeight, 1);
    this.onScrollBound = () => {
      if (this.opts.drawOnScroll !== false) this.draw();
      if (this.opts.onScroll) this.opts.onScroll(this.scrollTop);
    };
    this.opts.scroller.addEventListener('scroll', this.onScrollBound, { passive: true });
    this.resizeObserver =
      opts.drawOnResize === false
        ? null
        : new ResizeObserver(() => {
            this.draw();
          });
    this.resizeObserver?.observe(opts.scroller);
    this.syncSpacer();
  }

  get size(): number {
    return this.sizeValue;
  }

  get rowHeight(): number {
    return this.rowHeightValue;
  }

  /** 当前可见槽位数（底栏「已渲染 N / 总数」用）。 */
  get rendered(): number {
    return this.renderedValue;
  }

  get scrollTop(): number {
    const value = this.opts.scroller.scrollTop;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  set scrollTop(px: number) {
    this.opts.scroller.scrollTop = Number.isFinite(px) ? Math.max(0, px) : 0;
  }

  /** 可视高度（px）。面板算「一屏几行」或做居中定位时用。 */
  viewportPx(): number {
    const value = this.opts.scroller.clientHeight;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  /** 显示条数变化：更新 spacer 并重画。 */
  setSize(size: number): void {
    const next = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0;
    this.sizeValue = next;
    this.syncSpacer();
    this.draw();
  }

  /** 行高变化（树切设置 / 大纲跟随设置）：槽位高度、spacer、窗口一起重排。 */
  setRowHeight(px: number): void {
    const next = normalizePositive(px, this.rowHeightValue);
    if (next === this.rowHeightValue) return;
    this.rowHeightValue = next;
    for (const slot of this.slots) slot.el.style.height = `${next}px`;
    this.syncSpacer();
    this.draw();
  }

  /** 面板由隐藏变可见时调用（display:none 下 clientHeight 为 0，窗口算不出来）。 */
  refresh(): void {
    this.syncSpacer();
    this.draw();
  }

  /** 按当前 size / rowHeight / 滚动位置重画可见窗口；空列表不建槽位。 */
  draw(): void {
    const size = this.sizeValue;
    if (size <= 0) {
      this.hideFrom(0);
      this.renderedValue = 0;
      this.opts.afterDraw?.();
      return;
    }
    const rowHeight = this.rowHeightValue;
    const win = computeVirtualWindow(size, this.scrollTop, Math.floor(this.viewportPx() / rowHeight), {
      rowHeight,
      overscan: this.opts.overscan,
    });
    this.ensurePool(win.count);
    let used = 0;
    for (let i = 0; i < win.count; i++) {
      const index = win.start + i;
      if (index >= size) break;
      const slot = this.slots[i] as Slot;
      const reuse = slot.index === index;
      slot.index = index;
      slot.visible = true;
      slot.el.hidden = false;
      slot.el.style.top = `${index * rowHeight}px`;
      this.opts.paint({ index, top: index * rowHeight, el: slot.el, reuse });
      used += 1;
    }
    this.hideFrom(used);
    this.renderedValue = used;
    this.opts.afterDraw?.();
  }

  /** 从 `from` 起隐藏并清理槽位（面板的 size 变小时用；重复调用是 no-op）。 */
  hideFrom(from: number): void {
    for (let i = from; i < this.slots.length; i++) {
      const slot = this.slots[i] as Slot;
      if (!slot.visible && slot.el.hidden && slot.index === -1) continue;
      slot.visible = false;
      slot.index = -1;
      slot.el.hidden = true;
      this.opts.clearSlot(slot.el);
    }
  }

  /** 解绑监听、断开 ResizeObserver（面板的 destroy 里调用）。 */
  destroy(): void {
    this.opts.scroller.removeEventListener('scroll', this.onScrollBound);
    this.resizeObserver?.disconnect();
    this.hideFrom(0);
    this.sizeValue = 0;
    this.renderedValue = 0;
  }

  // ---------------------------------------------------------------- internal

  private syncSpacer(): void {
    const height = Math.min(this.sizeValue * this.rowHeightValue, MAX_SCROLL_PX);
    this.opts.spacer.style.height = `${height}px`;
  }

  private ensurePool(count: number): void {
    while (this.slots.length < count) {
      const el = this.opts.createSlot();
      el.hidden = true;
      el.style.height = `${this.rowHeightValue}px`;
      this.opts.host.appendChild(el);
      this.slots.push({ el, index: -1, visible: false });
    }
  }
}

function normalizePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
