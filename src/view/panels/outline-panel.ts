/**
 * view/panels/outline-panel — 大纲面板的 DOM 层（ADR-0013 §4 / 「DOM 契约」）。
 *
 * 职责边界（与 search-panel 同构）：
 *   - 自建 DOM；page.html 只留 `<div class="panel panel--outline" id="outlinePanel">` 挂载点。
 *   - 只读 `OutlineView` 快照渲染；不发请求、不 import core、不读全局时钟。
 *   - 虚拟列表：行高跟随设置 `rowHeight`（20–26，默认 24）、overscan 6、
 *     spacer = 行数 × 行高；行节点池复用，滚动只重画窗口。
 *   - 只处理交互意图（caret 展开 / 行跳转 / 键盘），动作由 app 注入的回调执行。
 *
 * 硬约束：全部文本走 textContent / createElement / replaceChildren，**禁 innerHTML**。
 * DOM 契约的 id / class 由 app 与冒烟脚本依赖，不要改名。
 */
import type { OutlineRow, OutlineView } from '../../viewmodel/outline-state';
import {
  computeOutlineWindow,
  OUTLINE_OVERSCAN,
  OUTLINE_ROW_HEIGHT,
} from '../../viewmodel/outline-state';
import { MAX_SCROLL_PX } from '../../protocol/versions';
import { clampRowHeight } from '../../shared/num';

export interface OutlinePanelOptions {
  /** 行高（px）；默认 OUTLINE_ROW_HEIGHT，实际随设置由 `setRowHeight` 更新 */
  rowHeight?: number;
  overscan?: number;
  /** 点击 caret / 键盘 ←→：只改大纲展开态 */
  onToggle(path: string, open: boolean): void;
  /** 点击行 / 键盘 Enter：跳转到树（jumpToPath） */
  onActivate(path: string): void;
  /** 键盘 ↑↓/Home/End：移动大纲当前行（= 树选中同步，不跳转） */
  onSelect(path: string): void;
  /** 点击「加载更多」哨兵行：取下一页 */
  onLoadMore(path: string): void;
}

/* ---------------- 文案（冒烟断言依赖，不要改名） ---------------- */

const EMPTY_IDLE_TEXT = '导入文档后显示结构大纲';
const EMPTY_LOADING_TEXT = '加载中…';
const EMPTY_ERROR_TEXT = '大纲加载失败';

function isContainerKind(kind: OutlineRow['kind']): boolean {
  return kind === 'object' || kind === 'array';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

interface RowSlot {
  readonly el: HTMLDivElement;
  readonly caret: HTMLSpanElement;
  readonly keyEl: HTMLSpanElement;
  readonly typeEl: HTMLSpanElement;
  readonly countEl: HTMLSpanElement;
  index: number;
  visible: boolean;
}

export class OutlinePanel {
  /** 当前渲染行高（px）；跟随设置 */
  rowHeight: number;
  readonly overscan: number;

  private readonly host: HTMLElement;
  private readonly opts: OutlinePanelOptions;

  private mounted = false;
  private view: OutlineView | null = null;
  private rendered = 0;

  private scroller!: HTMLDivElement;
  private spacer!: HTMLDivElement;
  private windowEl!: HTMLDivElement;
  private emptyEl!: HTMLDivElement;
  private footEl!: HTMLDivElement;
  private footRendered!: HTMLSpanElement;
  private footTotal!: HTMLSpanElement;

  private readonly slots: RowSlot[] = [];
  private resizeObserver: ResizeObserver | null = null;

  /** 上次已处理（滚入视口）的选中路径；选中变化才自动滚动，避免和用户滚动打架 */
  private revealedSelected: string | null | undefined = undefined;

  constructor(host: HTMLElement, opts: OutlinePanelOptions) {
    this.host = host;
    this.opts = opts;
    this.rowHeight = clampRowHeight(opts.rowHeight ?? OUTLINE_ROW_HEIGHT);
    const overscan = opts.overscan ?? OUTLINE_OVERSCAN;
    this.overscan = Number.isFinite(overscan) && overscan >= 0 ? Math.floor(overscan) : OUTLINE_OVERSCAN;
  }

  // -------------------------------------------------------------- lifecycle

  /** 在 host 内建 DOM（host 由 page.html 提供，挂载点自身已带 .panel.panel--outline）。 */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    this.host.classList.add('panel', 'panel--outline');
    this.host.replaceChildren();

    /* ---- #outlineScroll：虚拟滚动容器（role=tree） ---- */
    this.scroller = el('div', 'outline__scroll');
    this.scroller.id = 'outlineScroll';
    this.scroller.setAttribute('role', 'tree');
    this.scroller.setAttribute('tabindex', '0');
    this.scroller.setAttribute('aria-label', '文档大纲');
    this.scroller.style.setProperty('--outline-row-h', `${this.rowHeight}px`);

    this.spacer = el('div', 'outline__spacer');
    this.spacer.style.height = '0px';
    // 虚拟化包装层不参与 a11y 树（role=tree 的直接子节点只能是 treeitem / group）
    this.spacer.setAttribute('role', 'none');
    this.windowEl = el('div', 'outline__window');
    this.windowEl.setAttribute('role', 'none');
    this.spacer.appendChild(this.windowEl);
    this.scroller.appendChild(this.spacer);

    /* ---- #outlineEmpty：空态 / 加载中 / 错误 ---- */
    this.emptyEl = el('div', 'outline__empty');
    this.emptyEl.id = 'outlineEmpty';
    this.emptyEl.textContent = EMPTY_IDLE_TEXT;
    this.scroller.appendChild(this.emptyEl);

    /* ---- #outlineFoot：底栏「已渲染 R / N 行」 ---- */
    this.footEl = el('div', 'outline__foot');
    this.footEl.id = 'outlineFoot';
    this.footEl.hidden = true;
    this.footRendered = el('span');
    this.footRendered.id = 'outlineRendered';
    this.footRendered.textContent = '0';
    this.footTotal = el('span');
    this.footTotal.id = 'outlineTotal';
    this.footTotal.textContent = '0';
    this.footEl.append(
      document.createTextNode('已渲染 '),
      this.footRendered,
      document.createTextNode(' / '),
      this.footTotal,
      document.createTextNode(' 行'),
    );

    // 空态文案不能放进 role=tree（tree 的子节点只能是 treeitem），放面板层
    this.host.append(this.emptyEl, this.scroller, this.footEl);

    /* ---- 事件（行节点池复用：监听挂在容器上，事件委托） ---- */
    this.scroller.addEventListener('scroll', this.handleScroll, { passive: true });
    this.scroller.addEventListener('click', this.handleClick);
    this.scroller.addEventListener('keydown', this.handleKeydown);

    this.resizeObserver = new ResizeObserver(() => this.drawWindow());
    this.resizeObserver.observe(this.scroller);
  }

  /** 渲染一帧只读快照（行池复用：只重画可见窗口）。 */
  render(view: OutlineView): void {
    if (!this.mounted) this.mount();
    const selectedChanged = view.selected !== this.revealedSelected;
    this.view = view;

    this.updateSpacer();
    this.updateEmpty(view);
    this.drawWindow();

    if (selectedChanged) this.revealSelected();
  }

  /** 行高跟随设置（applySettings 调用）：更新 spacer / 行池几何并重画窗口。 */
  setRowHeight(px: number): void {
    const next = clampRowHeight(px);
    if (next === this.rowHeight) return;
    this.rowHeight = next;
    if (!this.mounted) return;
    this.scroller.style.setProperty('--outline-row-h', `${next}px`);
    for (const slot of this.slots) slot.el.style.height = `${next}px`;
    this.updateSpacer();
    this.drawWindow();
    this.revealSelected();
  }

  /** 面板由隐藏变可见时重画（display:none 下 clientHeight 为 0，窗口算不出来）。 */
  refresh(): void {
    if (!this.mounted || !this.view) return;
    this.updateSpacer();
    this.updateEmpty(this.view);
    this.drawWindow();
    this.revealSelected();
  }

  focus(): void {
    if (!this.mounted) this.mount();
    this.scroller.focus();
  }

  /** 当前窗口实际渲染（非 hidden）的行数。 */
  renderedCount(): number {
    return this.rendered;
  }

  scrollTopPx(): number {
    return this.mounted ? this.scroller.scrollTop : 0;
  }

  destroy(): void {
    if (!this.mounted) return;
    this.scroller.removeEventListener('scroll', this.handleScroll);
    this.scroller.removeEventListener('click', this.handleClick);
    this.scroller.removeEventListener('keydown', this.handleKeydown);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.slots.length = 0;
    this.host.replaceChildren();
    this.view = null;
    this.rendered = 0;
    this.revealedSelected = undefined;
    this.mounted = false;
  }

  // -------------------------------------------------------------- rendering

  private updateSpacer(): void {
    const size = this.view?.rows.length ?? 0;
    const height = Math.min(size * this.rowHeight, MAX_SCROLL_PX);
    this.spacer.style.height = `${height}px`;
  }

  private updateEmpty(view: OutlineView): void {
    let text: string | null = null;
    if (view.phase === 'idle') text = EMPTY_IDLE_TEXT;
    else if (view.phase === 'loading') text = EMPTY_LOADING_TEXT;
    else if (view.phase === 'error') text = EMPTY_ERROR_TEXT;

    if (text === null) {
      // 隐藏时清空文本：读 #outlineEmpty 永远不会看到过期态文案
      this.emptyEl.hidden = true;
      this.emptyEl.textContent = '';
    } else {
      this.emptyEl.hidden = false;
      this.emptyEl.textContent = text;
    }
  }

  private updateFoot(view: OutlineView): void {
    const size = view.rows.length;
    if (size === 0) {
      this.footEl.hidden = true;
      this.footRendered.textContent = '0';
      this.footTotal.textContent = '0';
      return;
    }
    this.footEl.hidden = false;
    this.footRendered.textContent = String(this.rendered);
    this.footTotal.textContent = String(size);
  }

  /** 只重画可见窗口：spacer 撑出总高度，窗口内行节点池复用。 */
  private drawWindow(): void {
    if (!this.mounted) return;
    const view = this.view;
    if (!view || view.rows.length === 0) {
      this.hideSlotsFrom(0);
      this.rendered = 0;
      this.scroller.removeAttribute('aria-activedescendant');
      if (view) this.updateFoot(view);
      return;
    }

    const scrollTop = Math.max(0, this.scroller.scrollTop);
    const viewportRows = Math.floor(this.scroller.clientHeight / this.rowHeight);
    const win = computeOutlineWindow(view.rows.length, scrollTop, viewportRows, {
      rowHeight: this.rowHeight,
      overscan: this.overscan,
    });

    this.ensurePool(win.count);

    let used = 0;
    let activeId: string | null = null;
    for (let i = 0; i < win.count; i++) {
      const index = win.start + i;
      const row = view.rows[index];
      if (!row) break;
      const slot = this.slots[i] as RowSlot;
      this.paintSlot(slot, row, index, view.selected);
      if (!row.more && view.selected !== null && row.path === view.selected) activeId = slot.el.id;
      used++;
    }
    this.hideSlotsFrom(used);
    // a11y：行不是焦点元素，scroller 用 aria-activedescendant 指向当前行
    if (activeId !== null) this.scroller.setAttribute('aria-activedescendant', activeId);
    else this.scroller.removeAttribute('aria-activedescendant');
    this.rendered = used;
    this.updateFoot(view);
  }

  private ensurePool(count: number): void {
    while (this.slots.length < count) {
      const rowEl = el('div', 'outline-row');
      rowEl.setAttribute('role', 'treeitem');
      // 行池槽位 id 稳定：scroller 的 aria-activedescendant 指向当前行（虚拟列表 a11y）
      rowEl.id = `outline-row-${this.slots.length}`;
      rowEl.tabIndex = -1;
      rowEl.hidden = true;
      rowEl.style.height = `${this.rowHeight}px`;

      // caret / type / count 按行内容挂载或卸载（见 paintSlot）：
      // 冒烟与 a11y 都依赖「标量行没有 .outline-row__caret / .outline-row__count」
      const caret = el('span', 'outline-row__caret');
      caret.setAttribute('aria-hidden', 'true');
      const keyEl = el('span', 'outline-row__key');
      const typeEl = el('span', 'outline-row__type');
      const countEl = el('span', 'outline-row__count');
      rowEl.append(keyEl);

      this.windowEl.appendChild(rowEl);
      this.slots.push({ el: rowEl, caret, keyEl, typeEl, countEl, index: -1, visible: false });
    }
  }

  /** 按需挂到行上（幂等）；caret 永远排最前，type/count 排在 key 之后。 */
  private attachChild(node: HTMLElement, child: HTMLElement, first: boolean): void {
    if (child.isConnected) return;
    if (first) node.insertBefore(child, node.firstChild);
    else node.appendChild(child);
  }

  private paintSlot(slot: RowSlot, row: OutlineRow, index: number, selected: string | null): void {
    const node = slot.el;
    slot.index = index;
    slot.visible = true;
    node.hidden = false;
    node.style.top = `${index * this.rowHeight}px`;
    node.style.height = `${this.rowHeight}px`;
    // 缩进用 CSS 变量（每行按层级）
    node.style.setProperty('--o-depth', String(row.depth));
    node.dataset.path = row.path;
    node.dataset.depth = String(row.depth);
    node.setAttribute('aria-level', String(row.depth + 1));
    node.title = row.path;
    node.classList.toggle('outline-row--more', row.more);
    node.classList.toggle('is-open', !row.more && row.open);
    const current = !row.more && selected !== null && row.path === selected;
    node.classList.toggle('is-current', current);
    node.setAttribute('aria-selected', current ? 'true' : 'false');

    if (row.more) {
      /* ---- 「加载更多」哨兵行：data-more="1"、data-path = 所属容器 ---- */
      node.dataset.more = '1';
      delete node.dataset.kind;
      delete node.dataset.count;
      node.removeAttribute('aria-expanded');
      node.setAttribute('aria-label', row.key);
      node.removeAttribute('aria-selected');
      slot.caret.remove();
      slot.typeEl.remove();
      slot.countEl.remove();
      slot.keyEl.textContent = row.key;
      return;
    }

    delete node.dataset.more;
    node.dataset.kind = row.kind ?? 'null';
    node.dataset.count = String(row.count);

    /* ---- caret：容器才有；根永远展开不可折叠，不显示 caret ---- */
    const showCaret = row.expandable && row.path !== '$';
    if (showCaret) this.attachChild(node, slot.caret, true);
    else slot.caret.remove();
    // aria-expanded 与树同口径：有子项的容器就有（根恒为展开态，但没有 caret）
    if (row.expandable) node.setAttribute('aria-expanded', row.open ? 'true' : 'false');
    else node.removeAttribute('aria-expanded');

    /* ---- 键 / 类型 / 项数（全部 textContent，禁 innerHTML） ---- */
    const container = isContainerKind(row.kind);
    slot.keyEl.textContent = row.key;
    this.attachChild(node, slot.typeEl, false);
    slot.typeEl.textContent = row.kind ?? '';
    if (container) this.attachChild(node, slot.countEl, false);
    else slot.countEl.remove();
    slot.countEl.textContent = container ? `${row.count} 项` : '';

    const label = container ? `${row.key} ${row.kind} ${row.count} 项` : `${row.key} ${row.kind}`;
    node.setAttribute('aria-label', label);
  }

  private hideSlotsFrom(from: number): void {
    for (let i = from; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.visible && slot.el.hidden) continue;
      slot.visible = false;
      slot.index = -1;
      slot.el.hidden = true;
      slot.el.classList.remove('is-open', 'is-current', 'outline-row--more');
      // 隐藏行不留在 [data-path] 等选择器里（冒烟按选择器数行数）
      delete slot.el.dataset.path;
      delete slot.el.dataset.depth;
      delete slot.el.dataset.kind;
      delete slot.el.dataset.count;
      delete slot.el.dataset.more;
      slot.el.removeAttribute('aria-level');
      slot.el.removeAttribute('aria-expanded');
      slot.el.removeAttribute('aria-selected');
      slot.el.removeAttribute('aria-label');
      slot.el.removeAttribute('title');
      slot.caret.remove();
      slot.caret.textContent = '';
      slot.typeEl.remove();
      slot.typeEl.textContent = '';
      slot.countEl.remove();
      slot.countEl.textContent = '';
      slot.keyEl.textContent = '';
    }
  }

  /**
   * 选中行滚入视口（仅当它在已加载扁平行里；不可见时不高亮也不滚动）。
   * 记录 `revealedSelected`：同一选中值只在首次出现时滚动。
   */
  private revealSelected(): void {
    const view = this.view;
    if (!view) return;
    if (view.selected === null) {
      this.revealedSelected = null;
      return;
    }
    const index = view.rows.findIndex((row) => !row.more && row.path === view.selected);
    if (index < 0) {
      // 未加载 / 祖先未展开：不高亮、不滚动；清掉「已揭示」标记，
      // 等该行随后变为可见（展开/翻页）时再滚一次
      this.revealedSelected = undefined;
      return;
    }
    this.revealedSelected = view.selected;
    this.revealIndex(index);
  }

  private revealIndex(index: number): void {
    const height = this.scroller.clientHeight;
    const top = index * this.rowHeight;
    const currentTop = this.scroller.scrollTop;
    if (height <= 0) {
      this.scroller.scrollTop = top;
    } else if (top < currentTop) {
      this.scroller.scrollTop = top;
    } else if (top + this.rowHeight > currentTop + height) {
      this.scroller.scrollTop = top + this.rowHeight - height;
    } else {
      return;
    }
    this.drawWindow();
  }

  // -------------------------------------------------------------- keyboard

  /** 可导航行下标（跳过「加载更多」哨兵行）。 */
  private navigableIndexes(): number[] {
    const rows = this.view?.rows ?? [];
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]?.more) out.push(i);
    }
    return out;
  }

  private rowOfSelected(): { row: OutlineRow; index: number } | null {
    const view = this.view;
    if (!view || view.selected === null) return null;
    const index = view.rows.findIndex((row) => !row.more && row.path === view.selected);
    const row = index >= 0 ? view.rows[index] : undefined;
    return row ? { row, index } : null;
  }

  private moveCurrent(direction: -1 | 1): void {
    const view = this.view;
    if (!view) return;
    const nav = this.navigableIndexes();
    if (nav.length === 0) return;
    const current = view.selected === null ? null : this.rowOfSelected();
    // 已加载末行继续按 ↓：等价点击「加载更多」哨兵行（键盘可达分页）
    if (current !== null && direction > 0 && current.index === nav[nav.length - 1]) {
      const nextRow = view.rows[current.index + 1];
      if (nextRow?.more) {
        this.opts.onLoadMore(nextRow.path);
        return;
      }
    }
    let next: number;
    if (current === null) {
      next = direction > 0 ? nav[0] : (nav[nav.length - 1] as number);
    } else {
      const pos = nav.indexOf(current.index);
      const target = pos < 0 ? 0 : Math.min(nav.length - 1, Math.max(0, pos + direction));
      next = nav[target] as number;
    }
    const row = view.rows[next];
    if (!row) return;
    this.revealIndex(next);
    this.opts.onSelect(row.path);
  }

  private moveToEdge(edge: 'first' | 'last'): void {
    const view = this.view;
    if (!view) return;
    const nav = this.navigableIndexes();
    if (nav.length === 0) return;
    const next = edge === 'first' ? nav[0] : (nav[nav.length - 1] as number);
    const row = view.rows[next];
    if (!row) return;
    this.revealIndex(next);
    this.opts.onSelect(row.path);
  }

  private activateSelected(): void {
    const view = this.view;
    if (!view) return;
    const current = this.rowOfSelected();
    if (current) {
      this.opts.onActivate(current.row.path);
      return;
    }
    const nav = this.navigableIndexes();
    const row = nav.length > 0 ? view.rows[nav[0] as number] : undefined;
    if (row) this.opts.onActivate(row.path);
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      // 输入法组合中的 Enter 不当作跳转
      if (event.isComposing || event.keyCode === 229) return;
    }
    const view = this.view;
    if (!view || view.rows.length === 0) return;
    const current = this.rowOfSelected();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveCurrent(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveCurrent(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.moveToEdge('first');
        break;
      case 'End':
        event.preventDefault();
        this.moveToEdge('last');
        break;
      case 'ArrowRight':
        if (current && current.row.expandable && !current.row.open && current.row.path !== '$') {
          event.preventDefault();
          this.opts.onToggle(current.row.path, true);
        }
        break;
      case 'ArrowLeft':
        if (current && current.row.open && current.row.path !== '$') {
          event.preventDefault();
          this.opts.onToggle(current.row.path, false);
        }
        break;
      case 'Enter':
        event.preventDefault();
        this.activateSelected();
        break;
      default:
        break;
    }
  };

  // -------------------------------------------------------------- events

  private readonly handleScroll = (): void => {
    this.drawWindow();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rowEl = target.closest<HTMLElement>('.outline-row');
    if (!rowEl) return;
    const path = rowEl.dataset.path;
    if (!path) return;
    this.scroller.focus();

    // caret 点击优先于跳转：只改大纲展开态
    if (target.closest('.outline-row__caret')) {
      this.opts.onToggle(path, !rowEl.classList.contains('is-open'));
      return;
    }
    // 「加载更多」哨兵行：取下一页
    if (rowEl.classList.contains('outline-row--more')) {
      this.opts.onLoadMore(path);
      return;
    }
    this.opts.onActivate(path);
  };
}
