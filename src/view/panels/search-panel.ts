/**
 * view/panels/search-panel — 搜索面板的 DOM 层（slice 4，C · 工作台）。
 *
 * 职责边界（docs/design/slice4-search-contract.md §3）：
 *   - 自建 DOM；page.html 只留 `<div class="panel panel--search" id="searchPanel">` 挂载点。
 *   - 只读 `SearchPanelView` 快照渲染；不发请求、不 import core、不读全局时钟。
 *   - 结果列表虚拟化：固定 44px 行、spacer = size × 44、窗口由 viewmodel 的
 *     `VirtualList` 计算；行节点池复用，滚动只重画窗口。
 *
 * 搜索选项（ADR-0014 §2.1）：查询框右侧三个真实 `<button>`——`Aa`（区分大小写）、`.*`（正则）、
 * `\b`（全字匹配， #53），`aria-pressed` 反映状态、Tab 顺序在查询框之后；点击只回调
 * `onOptionsChange`，**不发协议请求**。正则错误（`view.patternError`）只渲染成查询行
 * 下方的 `role="alert"` 内联错误行，并把输入框标 `aria-invalid`。
 *
 * 结果逐条隐藏（#53）：行尾 `×` 是 `<span aria-hidden>`（行本身是 `<button>`，不能再嵌
 * button），hover / 行聚焦时出现；键盘等价 = 行聚焦时按 `Delete`。隐藏按 path、不级联；
 * 计数（`可见/总`、四档 chips）与树高亮都按可见集，底栏出现「已隐藏 M 条 · 全部恢复」。
 *
 * 硬约束：全部文本走 textContent / createElement / replaceChildren，**禁 innerHTML**。
 * DOM 契约（§3.1）的 class / id 由 app 与 smoke 脚本依赖，不要改名。
 */
import { writeMarkedText } from '../highlight';
import { VirtualList, type VirtualPaint } from '../virtual-list';
import type { SearchFilter, SearchPanelView } from '../../viewmodel/search-state';
import {
  SEARCH_RESULT_OVERSCAN,
  SEARCH_RESULT_ROW_HEIGHT,
} from '../../viewmodel/search-state';
import { SEARCH_LIMIT } from '../../protocol/versions';
import type { Hit } from '../../protocol/types';
import { formatNumber, t } from '../../i18n/index';

export interface SearchPanelOptions {
  rowHeight?: number;
  overscan?: number;
  onQueryChange(query: string): void;
  onFilterChange(filter: SearchFilter): void;
  /** 点击结果行（过滤后下标） */
  onSelect(index: number): void;
  /** 双击结果行 = 复制该命中节点（ADR-0010 修订；具体格式由 app 按设置决定） */
  onCopyResult?(path: string): void;
  onPrev(): void;
  onNext(): void;
  /** 输入框 Enter */
  onSubmit(): void;
  /** `Aa` / `.*` / `\b` 切换；app 负责快照重跑当前查询（面板只回调，不发命令） */
  onOptionsChange?(opts: { caseSensitive: boolean; regex: boolean; wholeWord: boolean }): void;
  /** 逐条隐藏一条结果（#53；path 由行上的 data-path 给，app 写进 SearchState） */
  onHideResult?(path: string): void;
  /** 「全部恢复」被隐藏的结果（#53） */
  onRestoreHidden?(): void;
}

/* ---------------- 常量文案（全部在渲染时按当前 locale 取词条） ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** core.search 的命中上限（契约 §3.1：truncated 时总数显示 `50,000+`）；单一来源 = protocol/versions。 */
function truncatedCountText(): string {
  return `${formatNumber(SEARCH_LIMIT)}+`;
}

function truncatedHint(): string {
  return t('view.search.truncated', { n: SEARCH_LIMIT });
}

/** 过滤四档（ADR-0023：路径档常驻，普通查询下计数为 0，不 disable）。 */
const FILTER_VALUES: readonly SearchFilter[] = ['all', 'key', 'value', 'path'];

const FILTER_LABEL_KEYS = {
  all: 'view.search.filter.all',
  key: 'view.search.filter.key',
  value: 'view.search.filter.value',
  path: 'view.search.filter.path',
} as const;

function filterLabel(filter: SearchFilter): string {
  return t(FILTER_LABEL_KEYS[filter]);
}

/** 结果行「匹配说明」列的文案：Hit.field → 展示文本（ADR-0023 加 path）。 */
function fieldLabel(field: Hit['field']): string {
  return t(FILTER_LABEL_KEYS[field]);
}

// ---------------------------------------------------------------- helpers

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 千分位跟随当前 locale（`37,189`；zh / en 观感一致）。 */
function formatCount(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return formatNumber(n);
}

function createSvg(viewBox: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

function createStrokePath(d: string, strokeWidth = '1.4'): SVGPathElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', strokeWidth);
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  return path;
}

function createSearchIcon(): SVGSVGElement {
  const svg = createSvg('0 0 16 16');
  svg.classList.add('ic');
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '7.1');
  circle.setAttribute('cy', '7.1');
  circle.setAttribute('r', '4.2');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'currentColor');
  circle.setAttribute('stroke-width', '1.3');
  svg.append(circle, createStrokePath('m10.4 10.4 3 3', '1.3'));
  return svg;
}

function createChevronIcon(up: boolean): SVGSVGElement {
  const svg = createSvg('0 0 16 16');
  svg.classList.add('ic');
  svg.append(createStrokePath(up ? 'M4.5 9.5 8 6l3.5 3.5' : 'M4.5 6.5 8 10l3.5-3.5'));
  return svg;
}

/**
 * 把 text 写入 el，命中片段包进 `<mark class="result__hit">`。
 * 匹配由 shared/highlight 计算、DOM 写入由 view/highlight 统一承担（下标基于原串，全部走 textContent）。
 * 路径（key）与值预览共用本函数。
 */
function writeHighlighted(el: HTMLElement, text: string, term: string, wholeWord: boolean): void {
  writeMarkedText(el, text, term, 'result__hit', { wholeWord });
}

interface ResultSlot {
  readonly el: HTMLButtonElement;
  readonly hideEl: HTMLSpanElement;
  readonly pathEl: HTMLSpanElement;
  readonly fieldEl: HTMLSpanElement;
  readonly valueEl: HTMLSpanElement;
  readonly kindEl: HTMLSpanElement;
}

// ---------------------------------------------------------------- panel

export class SearchPanel {
  readonly rowHeight: number;
  readonly overscan: number;

  private readonly host: HTMLElement;
  private readonly opts: SearchPanelOptions;

  private mounted = false;
  private view: SearchPanelView | null = null;
  /** 虚拟列表：spacer / 槽位池 / 隐藏与复用清理（seams S3b） */
  private list: VirtualList | null = null;

  private input!: HTMLInputElement;
  private optsEl!: HTMLElement;
  private caseBtn!: HTMLButtonElement;
  private regexBtn!: HTMLButtonElement;
  private wholeWordBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  /** 面板侧乐观态：点击即翻转，下一次 render 由 viewmodel 快照回填为准 */
  private caseSensitiveOn = false;
  private regexOn = false;
  private wholeWordOn = false;
  private countValue!: HTMLElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private posEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private readonly filterButtons = new Map<
    SearchFilter,
    { button: HTMLButtonElement; count: HTMLSpanElement }
  >();
  /** 过滤按钮的标签文本节点（relabel 时改文本，保持 childNodes[0] 契约） */
  private readonly filterLabelNodes = new Map<SearchFilter, Text>();
  private scroller!: HTMLElement;
  private spacer!: HTMLElement;
  private windowEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private footEl!: HTMLElement;
  private footRendered!: HTMLElement;
  private footTotal!: HTMLElement;
  private footTruncated!: HTMLElement;
  private footInfo!: HTMLElement;
  private footHidden!: HTMLElement;
  private footHiddenText!: HTMLElement;
  private footRestore!: HTMLButtonElement;
  /** 底栏「已隐藏 M 条」当前渲染的 M（-1 = 未渲染；只在变化时重建，避免每帧重建按钮） */
  private footHiddenRendered = -1;
  /** 底栏前缀文本节点（`虚拟滚动 · 已渲染 `），relabel 时改文本 */
  private footPrefixNode: Text | null = null;

  /** 槽位元素 → 内部引用（池由 VirtualList 持有，这里只认元素） */
  private readonly slotRefs = new WeakMap<HTMLElement, ResultSlot>();
  /** 已创建的槽位元素（relabel / destroy 用；池只增不缩，所以与池等长） */
  private readonly slotNodes: HTMLElement[] = [];

  constructor(host: HTMLElement, opts: SearchPanelOptions) {
    this.host = host;
    this.opts = opts;
    const rowHeight = opts.rowHeight ?? SEARCH_RESULT_ROW_HEIGHT;
    const overscan = opts.overscan ?? SEARCH_RESULT_OVERSCAN;
    this.rowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : SEARCH_RESULT_ROW_HEIGHT;
    this.overscan = Number.isFinite(overscan) && overscan >= 0 ? Math.floor(overscan) : SEARCH_RESULT_OVERSCAN;
  }

  // -------------------------------------------------------------- lifecycle

  /** 在 host 内建 DOM（host 由 page.html 提供，挂载点自身已带 .panel.panel--search）。 */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    this.host.classList.add('panel', 'panel--search');
    this.host.replaceChildren();

    /* ---- .csearch：搜索框 + 总数 + 上一个/下一个 + n / total ---- */
    const csearch = el('div', 'csearch');

    const box = el('div', 'csearch__box');
    box.appendChild(createSearchIcon());

    this.input = el('input', 'csearch__input');
    this.input.id = 'searchInput';
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.placeholder = t('view.search.placeholder');
    this.input.setAttribute('aria-label', t('view.search.placeholder'));
    box.appendChild(this.input);

    /* 查询行右侧：Aa（区分大小写）/ .*（正则）——真实按钮，Tab 顺序在查询框之后 */
    this.optsEl = el('div', 'csearch__opts');
    this.optsEl.setAttribute('role', 'group');
    this.optsEl.setAttribute('aria-label', t('view.search.options.label'));

    this.caseBtn = el('button', 'csearch__toggle');
    this.caseBtn.id = 'searchCase';
    this.caseBtn.type = 'button';
    this.caseBtn.textContent = 'Aa';
    this.caseBtn.setAttribute('aria-label', t('view.search.case.label'));
    this.caseBtn.setAttribute('aria-pressed', 'false');
    this.caseBtn.title = t('view.search.case.title');

    this.regexBtn = el('button', 'csearch__toggle');
    this.regexBtn.id = 'searchRegex';
    this.regexBtn.type = 'button';
    this.regexBtn.textContent = '.*';
    this.regexBtn.setAttribute('aria-label', t('view.search.regex.label'));
    this.regexBtn.setAttribute('aria-pressed', 'false');
    this.regexBtn.title = t('view.search.regex.title');

    this.wholeWordBtn = el('button', 'csearch__toggle');
    this.wholeWordBtn.id = 'searchWholeWord';
    this.wholeWordBtn.type = 'button';
    this.wholeWordBtn.textContent = '\\b';
    this.wholeWordBtn.setAttribute('aria-label', t('view.search.wholeWord.label'));
    this.wholeWordBtn.setAttribute('aria-pressed', 'false');
    this.wholeWordBtn.title = t('view.search.wholeWord.title');

    this.optsEl.append(this.caseBtn, this.regexBtn, this.wholeWordBtn);
    box.appendChild(this.optsEl);

    const countEl = el('span', 'csearch__count');
    countEl.id = 'searchCount';
    this.countValue = el('b');
    this.countValue.textContent = '0';
    countEl.appendChild(this.countValue);
    box.appendChild(countEl);

    const row = el('div', 'csearch__row');
    this.prevBtn = el('button', 'iconbtn');
    this.prevBtn.id = 'searchPrev';
    this.prevBtn.type = 'button';
    this.prevBtn.disabled = true;
    this.prevBtn.setAttribute('aria-label', t('view.search.prev.label'));
    this.prevBtn.title = t('view.search.prev.title');
    this.prevBtn.appendChild(createChevronIcon(true));

    this.nextBtn = el('button', 'iconbtn');
    this.nextBtn.id = 'searchNext';
    this.nextBtn.type = 'button';
    this.nextBtn.disabled = true;
    this.nextBtn.setAttribute('aria-label', t('view.search.next.label'));
    this.nextBtn.title = t('view.search.next.title');
    this.nextBtn.appendChild(createChevronIcon(false));

    this.posEl = el('span', 'csearch__pos');
    this.posEl.id = 'searchPos';
    this.posEl.textContent = '0 / 0';

    row.append(this.prevBtn, this.nextBtn, this.posEl);

    /* 正则错误行：查询行下方，仅 patternError 非空时显示（ADR-0014 §2.3） */
    this.errorEl = el('div', 'csearch__error');
    this.errorEl.id = 'searchPatternError';
    this.errorEl.setAttribute('role', 'alert');
    this.errorEl.hidden = true;

    csearch.append(box, this.errorEl, row);

    /* ---- .results__filters：全部 / 键名 / 值 / 路径 + counts ---- */
    this.filtersEl = el('div', 'results__filters');
    this.filtersEl.setAttribute('role', 'group');
    this.filtersEl.setAttribute('aria-label', t('view.search.filters.label'));
    for (const filter of FILTER_VALUES) {
      const button = el('button', 'filter');
      button.type = 'button';
      button.dataset.filter = filter;
      button.setAttribute('aria-pressed', 'false');
      // childNodes[0] 是标签文本节点（smoke 按此取 label；relabel 直接改它）
      const label = document.createTextNode(filterLabel(filter));
      button.appendChild(label);
      const count = el('span', 'filter__count');
      count.textContent = '0';
      button.appendChild(document.createTextNode(' '));
      button.appendChild(count);
      this.filtersEl.appendChild(button);
      this.filterButtons.set(filter, { button, count });
      this.filterLabelNodes.set(filter, label);
    }

    /* ---- .results__scroll#resultsScroll：虚拟列表 ---- */
    this.scroller = el('div', 'results__scroll');
    this.scroller.id = 'resultsScroll';
    this.scroller.setAttribute('role', 'listbox');
    this.scroller.setAttribute('tabindex', '0');
    this.scroller.setAttribute('aria-label', t('view.search.list.label'));
    this.spacer = el('div', 'results__spacer');
    this.spacer.style.height = '0px';
    this.windowEl = el('div', 'results__window');
    this.spacer.appendChild(this.windowEl);
    this.emptyEl = el('div', 'results__empty');
    this.emptyEl.textContent = t('view.search.empty.idle');
    this.scroller.append(this.spacer, this.emptyEl);

    /* ---- .results__foot#resultsFoot ---- */
    this.footEl = el('div', 'results__foot');
    this.footEl.id = 'resultsFoot';
    this.footEl.hidden = true;
    this.footInfo = el('span', 'results__footinfo');
    this.footRendered = el('span');
    this.footRendered.id = 'resultsRendered';
    this.footRendered.textContent = '0';
    this.footTotal = el('span');
    this.footTotal.id = 'resultsTotal';
    this.footTotal.textContent = '0';
    this.footTruncated = el('span', 'results__truncated');
    this.footTruncated.textContent = '';
    this.footTruncated.hidden = true;
    this.footPrefixNode = document.createTextNode(t('view.search.foot.prefix'));
    this.footInfo.append(
      this.footPrefixNode,
      this.footRendered,
      document.createTextNode(' / '),
      this.footTotal,
      this.footTruncated,
    );
    // 已隐藏 M 条 · 全部恢复（#53）：内容按需重建（hidden 时清空，footText 不残留）
    this.footHidden = el('span', 'results__hidden');
    this.footHidden.id = 'resultsHidden';
    this.footHidden.hidden = true;
    this.footHiddenText = el('span', 'results__hidden-text');
    this.footRestore = el('button', 'results__restore');
    this.footRestore.type = 'button';
    this.footRestore.id = 'resultsRestore';
    this.footHidden.append(this.footHiddenText, this.footRestore);
    this.footEl.append(this.footInfo, this.footHidden);

    this.host.append(csearch, this.filtersEl, this.scroller, this.footEl);

    // 初始过滤态与 viewmodel 默认值一致（filter='all'）
    const all = this.filterButtons.get('all');
    if (all) {
      all.button.classList.add('is-on');
      all.button.setAttribute('aria-pressed', 'true');
    }

    /* ---- 事件 ---- */
    this.input.addEventListener('input', this.handleInput);
    this.input.addEventListener('keydown', this.handleKeydown);
    this.prevBtn.addEventListener('click', this.handlePrev);
    this.nextBtn.addEventListener('click', this.handleNext);
    this.optsEl.addEventListener('click', this.handleOptionsClick);
    this.filtersEl.addEventListener('click', this.handleFiltersClick);
    this.windowEl.addEventListener('click', this.handleRowClick);
    this.windowEl.addEventListener('dblclick', this.handleRowDblClick);
    // 挂在 scroller 上：行（windowEl 内）与列表自身（scroller）的 Delete 都要能收到
    this.scroller.addEventListener('keydown', this.handleRowKeydown);
    this.footRestore.addEventListener('click', this.handleRestoreHidden);

    this.list = new VirtualList({
      scroller: this.scroller,
      spacer: this.spacer,
      host: this.windowEl,
      rowHeight: this.rowHeight,
      overscan: this.overscan,
      createSlot: () => this.createSlot(),
      paint: (ctx) => this.paintSlot(ctx),
      clearSlot: (el) => this.clearSlot(el),
      // 底栏「已渲染 N」跟着每次重画刷新（含 ResizeObserver 触发的重画）
      afterDraw: () => {
        if (this.view) this.updateFoot(this.view);
      },
    });
  }

  /**
   * 语言切换：回填本面板持有的全部静态标签（placeholder / aria / title / 过滤档 / 底栏前缀），
   * 再按当前快照重画一帧（空态与已渲染文案随词条更新）。幂等、不动查询/结果状态。
   */
  relabel(): void {
    if (!this.mounted) return;
    this.input.placeholder = t('view.search.placeholder');
    this.input.setAttribute('aria-label', t('view.search.placeholder'));
    this.optsEl.setAttribute('aria-label', t('view.search.options.label'));
    this.caseBtn.setAttribute('aria-label', t('view.search.case.label'));
    this.caseBtn.title = t('view.search.case.title');
    this.regexBtn.setAttribute('aria-label', t('view.search.regex.label'));
    this.regexBtn.title = t('view.search.regex.title');
    this.wholeWordBtn.setAttribute('aria-label', t('view.search.wholeWord.label'));
    this.wholeWordBtn.title = t('view.search.wholeWord.title');
    this.footHiddenRendered = -1;
    this.prevBtn.setAttribute('aria-label', t('view.search.prev.label'));
    this.prevBtn.title = t('view.search.prev.title');
    this.nextBtn.setAttribute('aria-label', t('view.search.next.label'));
    this.nextBtn.title = t('view.search.next.title');
    this.filtersEl.setAttribute('aria-label', t('view.search.filters.label'));
    this.scroller.setAttribute('aria-label', t('view.search.list.label'));
    for (const [filter, node] of this.filterLabelNodes) node.textContent = filterLabel(filter);
    for (const node of this.slotNodes) {
      const slot = this.slotRefs.get(node);
      if (!slot) continue;
      slot.hideEl.title = t('view.search.hide.title');
      slot.el.setAttribute('aria-keyshortcuts', 'Delete');
    }
    if (this.footPrefixNode) this.footPrefixNode.textContent = t('view.search.foot.prefix');
    if (this.view) this.render(this.view);
  }

  /** 渲染一帧只读快照。`view.hits` 引用变化 → 列表回顶；同一命中集保持滚动位置。 */
  render(view: SearchPanelView): void {
    if (!this.mounted) this.mount();

    const hitsChanged = this.view === null || view.hits !== this.view.hits;
    this.view = view;

    this.updateInputValue(view);
    this.updateOptionToggles(view);
    this.updatePatternError(view);
    this.updateHeader(view);
    this.updateFilters(view);
    this.updateEmptyState(view);

    // 命中集换了 → 回顶；setSize 内部同步 spacer 并重画窗口，底栏计数由 afterDraw 刷新
    if (hitsChanged && this.list) this.list.scrollTop = 0;
    this.list?.setSize(view.size);
    this.updateFoot(view);
  }

  focusInput(): void {
    if (!this.mounted) this.mount();
    this.input.focus();
  }

  /**
   * 查询框当前文本（未 trim）。
   * app 在「切换 Aa/.* 立即重跑」时要读它：用户可能刚输入、250ms debounce 尚未提交，
   * 若用 viewmodel 里已提交的旧 query 重跑，会丢掉这次输入（ADR-0014 §2.1）。
   */
  currentQuery(): string {
    return this.mounted ? this.input.value : '';
  }

  /** 把过滤后第 index 行滚进列表视口（夹紧），并同步重画一帧窗口。 */
  scrollTo(index: number): void {
    const view = this.view;
    if (!this.mounted || !view || view.size === 0) return;

    const target = clamp(Math.trunc(index), 0, view.size - 1);
    const top = target * this.rowHeight;
    const height = this.list?.viewportPx() ?? 0;
    const currentTop = this.list?.scrollTop ?? 0;

    let nextTop = currentTop;
    if (height <= 0) {
      nextTop = top;
    } else if (top < currentTop) {
      nextTop = top;
    } else if (top + this.rowHeight > currentTop + height) {
      nextTop = top + this.rowHeight - height;
    }

    if (nextTop !== currentTop && this.list) this.list.scrollTop = Math.max(0, nextTop);
    this.list?.draw();
  }

  resetScroll(): void {
    if (!this.mounted || !this.list) return;
    this.list.scrollTop = 0;
    this.list.draw();
  }

  /** 当前可见（非 hidden）结果行数。 */
  renderedCount(): number {
    return this.list?.rendered ?? 0;
  }

  listScrollTop(): number {
    return this.mounted && this.list ? this.list.scrollTop : 0;
  }

  scrollListTo(px: number): void {
    if (!this.mounted || !this.list) return;
    this.list.scrollTop = Number.isFinite(px) ? Math.max(0, px) : 0;
    this.list.draw();
  }

  /** 面板自报的状态快照（dev hook 用）：渲染数 / 滚动几何 / 计数与页脚文本。 */
  state(): {
    rendered: number;
    listScrollTop: number;
    listScrollHeight: number;
    countText: string;
    posText: string;
    footText: string;
  } {
    return {
      rendered: this.list?.rendered ?? 0,
      listScrollTop: this.scroller?.scrollTop ?? 0,
      listScrollHeight: this.scroller?.scrollHeight ?? 0,
      countText: this.countValue?.textContent ?? '',
      posText: this.posEl?.textContent ?? '',
      footText: this.footEl?.textContent ?? '',
    };
  }

  destroy(): void {
    if (!this.mounted) return;
    this.input.removeEventListener('input', this.handleInput);
    this.input.removeEventListener('keydown', this.handleKeydown);
    this.optsEl.removeEventListener('click', this.handleOptionsClick);
    this.prevBtn.removeEventListener('click', this.handlePrev);
    this.nextBtn.removeEventListener('click', this.handleNext);
    this.list?.destroy();
    this.list = null;
    this.filtersEl.removeEventListener('click', this.handleFiltersClick);
    this.windowEl.removeEventListener('click', this.handleRowClick);
    this.windowEl.removeEventListener('dblclick', this.handleRowDblClick);
    this.scroller.removeEventListener('keydown', this.handleRowKeydown);
    this.footRestore.removeEventListener('click', this.handleRestoreHidden);
    this.slotNodes.length = 0;
    this.filterButtons.clear();
    this.filterLabelNodes.clear();
    this.footPrefixNode = null;
    this.host.replaceChildren();
    this.view = null;
    this.mounted = false;
  }

  // -------------------------------------------------------------- rendering

  private updateInputValue(view: SearchPanelView): void {
    // 输入框聚焦时用户正在输入，render 不覆盖；失焦后才跟随 viewmodel 的值同步。
    if (document.activeElement === this.input) return;
    if (this.input.value !== view.query) this.input.value = view.query;
  }

  /** 按快照回填两个 toggle 的 aria-pressed / is-on（viewmodel 是唯一真相）。 */
  private updateOptionToggles(view: SearchPanelView): void {
    this.caseSensitiveOn = view.caseSensitive;
    this.regexOn = view.regex;
    this.wholeWordOn = view.wholeWord;
    this.syncToggle(this.caseBtn, view.caseSensitive);
    this.syncToggle(this.regexBtn, view.regex);
    this.syncToggle(this.wholeWordBtn, view.wholeWord);
  }

  private syncToggle(button: HTMLButtonElement, on: boolean): void {
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** 正则错误行 + `aria-invalid`；无错误时整行 hidden 且清空文案。 */
  private updatePatternError(view: SearchPanelView): void {
    const message = view.patternError;
    if (message === null || message === '') {
      this.errorEl.hidden = true;
      this.errorEl.textContent = '';
      this.input.removeAttribute('aria-invalid');
      return;
    }
    if (this.errorEl.textContent !== message) this.errorEl.textContent = message;
    this.errorEl.hidden = false;
    this.input.setAttribute('aria-invalid', 'true');
  }

  private updateHeader(view: SearchPanelView): void {
    // 有隐藏时头部显示「可见/总」（#53）；没有隐藏时维持原来的单个总数（少一点噪音）
    const totalText = view.truncated ? truncatedCountText() : formatCount(view.total);
    this.countValue.textContent =
      view.hiddenCount > 0 ? `${formatCount(view.visibleTotal)}/${totalText}` : totalText;

    const pos = view.current >= 0 ? formatCount(view.current + 1) : '0';
    this.posEl.textContent = `${pos} / ${formatCount(view.size)}`;

    const disabled = view.size === 0;
    this.prevBtn.disabled = disabled;
    this.nextBtn.disabled = disabled;
  }

  private updateFilters(view: SearchPanelView): void {
    for (const [filter, entry] of this.filterButtons) {
      const on = view.filter === filter;
      entry.button.classList.toggle('is-on', on);
      entry.button.setAttribute('aria-pressed', on ? 'true' : 'false');
      entry.count.textContent = formatCount(view.counts[filter]);
    }
  }

  private updateEmptyState(view: SearchPanelView): void {
    let text: string | null = null;
    if (view.phase === 'idle') text = t('view.search.empty.idle');
    else if (view.phase === 'searching') text = t('view.search.empty.searching');
    else if (view.phase === 'stale') text = t('view.search.empty.stale');
    else if (view.phase === 'ready' && view.size === 0) {
      // 全是隐藏（#53）时别说「没有命中」——命中在，只是被用户逐条收起了
      if (view.hiddenCount > 0 && view.visibleTotal === 0) text = t('view.search.empty.allHidden');
      else if (
        view.filter !== 'all' &&
        view.counts[view.filter] === 0 &&
        view.hiddenCounts[view.filter] > 0 // 该档本来有命中、只是被隐藏光了
      ) {
        text = t('view.search.empty.filteredHidden', { n: view.hiddenCount });
      } else text = t('view.search.empty.noHits', { query: view.query });
    }

    if (text === null) {
      // 隐藏时清空文本：读 .results__empty 永远不会看到过期态文案
      this.emptyEl.hidden = true;
      this.emptyEl.textContent = '';
    } else {
      this.emptyEl.hidden = false;
      this.emptyEl.textContent = text;
    }
  }

  private updateFoot(view: SearchPanelView): void {
    // 结果全被隐藏时底栏仍要露出「全部恢复」（#53）
    const showFoot = view.size > 0 || view.hiddenCount > 0;
    this.footEl.hidden = !showFoot;
    this.footInfo.hidden = view.size === 0;
    if (view.size === 0) {
      this.footRendered.textContent = '0';
      this.footTotal.textContent = '0';
      this.footTruncated.hidden = true;
      this.footTruncated.textContent = '';
    } else {
      this.footRendered.textContent = formatCount(this.list?.rendered ?? 0);
      this.footTotal.textContent = formatCount(view.size);
      this.footTruncated.hidden = !view.truncated;
      // 带前导空格直接写进 truncate span，保证未截断时 foot.textContent 以数字结尾（无尾随空格）
      this.footTruncated.textContent = view.truncated ? ` ${truncatedHint()}` : '';
    }
    this.renderHiddenCount(view.hiddenCount);
  }

  /** 底栏「已隐藏 M 条 · 全部恢复」：只在 M 变化时重建内容（按钮不每帧重建/失焦）。 */
  private renderHiddenCount(count: number): void {
    if (count === this.footHiddenRendered) return;
    this.footHiddenRendered = count;
    if (count <= 0) {
      this.footHidden.hidden = true;
      this.footHiddenText.textContent = '';
      // 按钮文案也清掉：hidden 元素仍会被 textContent 读到，别污染 footText
      this.footRestore.textContent = '';
      return;
    }
    this.footHiddenText.textContent = t('view.search.hidden.count', { n: count });
    this.footRestore.textContent = t('view.search.hidden.restore');
    this.footHidden.hidden = false;
  }

  /** 造一个结果行（池由 VirtualList 持有；这里只负责 DOM 形状与内部引用表）。 */
  private createSlot(): HTMLElement {
    const elBtn = el('button', 'result');
    elBtn.type = 'button';
    elBtn.setAttribute('role', 'option');
    elBtn.tabIndex = -1;
    elBtn.hidden = true;

    const pathEl = el('span', 'result__path');
    const meta = el('span', 'result__meta');
    const fieldEl = el('span', 'result__field');
    const valueEl = el('span', 'result__value');
    const kindEl = el('span', 'result__kind');
    meta.append(fieldEl, valueEl, kindEl);
    // 行尾 ×（#53）：行本身是 <button>，这里只能是 span（aria-hidden）+ 行聚焦 Delete 等价
    const hideEl = el('span', 'result__hide');
    hideEl.setAttribute('aria-hidden', 'true');
    hideEl.title = t('view.search.hide.title');
    hideEl.textContent = '×';
    // 行不可 Tab 聚焦（listbox 模式），把键盘等价挂到行上供读屏/快捷键发现
    elBtn.setAttribute('aria-keyshortcuts', 'Delete');
    elBtn.append(pathEl, meta, hideEl);

    this.slotRefs.set(elBtn, { el: elBtn, hideEl, pathEl, fieldEl, valueEl, kindEl });
    this.slotNodes.push(elBtn);
    return elBtn;
  }

  /** 填一个可见槽位（`top` / `hidden` 由 VirtualList 写，这里只写内容与状态类）。 */
  private paintSlot(ctx: VirtualPaint): void {
    const view = this.view;
    const slot = this.slotRefs.get(ctx.el);
    if (!view || !slot) return;
    const index = ctx.index;
    const hit = view.hits[index];
    if (!hit) return;

    slot.el.dataset.index = String(index);
    slot.el.dataset.path = hit.path;
    slot.el.title = hit.path;
    const selected = index === view.current;
    slot.el.classList.toggle('is-selected', selected);
    slot.el.setAttribute('aria-selected', selected ? 'true' : 'false');

    writeHighlighted(slot.pathEl, hit.path, view.query, view.wholeWord);
    writeHighlighted(slot.valueEl, hit.preview, view.query, view.wholeWord);
    slot.fieldEl.textContent = fieldLabel(hit.field);
    slot.kindEl.textContent = hit.kind;
  }

  /** 槽位被窗口淘汰：清掉状态类与选择器属性（内容留着无所谓，下次 paint 会覆盖）。 */
  private clearSlot(el: HTMLElement): void {
    const slot = this.slotRefs.get(el);
    el.classList.remove('is-selected');
    el.removeAttribute('aria-selected');
    // 不把隐藏行留在 `[data-index]` / `[data-path]` 选择器里（权重同失败态一样干净）
    delete el.dataset.index;
    delete el.dataset.path;
    el.removeAttribute('title');
  }

  // -------------------------------------------------------------- events

  private readonly handleInput = (): void => {
    this.opts.onQueryChange(this.input.value);
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    // 输入法组合中的 Enter 用于上屏，不当作「提交/下一条」
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    this.opts.onSubmit();
  };

  private readonly handlePrev = (): void => {
    this.opts.onPrev();
  };

  private readonly handleNext = (): void => {
    this.opts.onNext();
  };

  private readonly handleOptionsClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.csearch__toggle');
    if (!(button instanceof HTMLButtonElement)) return;

    // 乐观翻转 + 立即回填（app 会同步 begin()+render()，两者一致）
    const next = {
      caseSensitive: button === this.caseBtn ? !this.caseSensitiveOn : this.caseSensitiveOn,
      regex: button === this.regexBtn ? !this.regexOn : this.regexOn,
      wholeWord: button === this.wholeWordBtn ? !this.wholeWordOn : this.wholeWordOn,
    };
    this.caseSensitiveOn = next.caseSensitive;
    this.regexOn = next.regex;
    this.wholeWordOn = next.wholeWord;
    this.syncToggle(this.caseBtn, next.caseSensitive);
    this.syncToggle(this.regexBtn, next.regex);
    this.syncToggle(this.wholeWordBtn, next.wholeWord);
    this.opts.onOptionsChange?.(next);
  };

  private readonly handleFiltersClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.filter');
    if (!(button instanceof HTMLButtonElement)) return;
    const value = button.dataset.filter;
    if (value === 'all' || value === 'key' || value === 'value' || value === 'path') {
      this.opts.onFilterChange(value);
    }
  };

  private readonly handleRowClick = (event: MouseEvent): void => {
    // 双击的第二击（detail≥2）不再重复跳转：一次双击只跳一次（否则多一次 expandTo/window），
    // 复制交给 dblclick。键盘触发的 click detail=0，不受影响。
    if (event.detail > 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // 行尾 ×（#53）：隐藏该条，不触发跳转
    const hideEl = target.closest('.result__hide');
    if (hideEl) {
      const owner = hideEl.closest('.result');
      if (owner instanceof HTMLButtonElement && owner.dataset.path) {
        event.preventDefault();
        this.hideRow(owner.dataset.path);
      }
      return;
    }
    const row = target.closest('.result');
    if (!(row instanceof HTMLButtonElement)) return;
    const index = Number(row.dataset.index);
    if (!Number.isInteger(index)) return;
    this.opts.onSelect(index);
  };

  /** 双击结果行 → 复制该命中节点（ADR-0010 修订：复制入口新增「搜索结果双击」）。 */
  private readonly handleRowDblClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.result');
    if (!(row instanceof HTMLButtonElement)) return;
    const hitPath = row.dataset.path;
    if (!hitPath) return;
    this.opts.onCopyResult?.(hitPath);
  };

  /** 逐条隐藏（#53）：回调 app 写状态机；行消失后焦点交给列表，Delete 仍可继续。 */
  private hideRow(path: string): void {
    this.opts.onHideResult?.(path);
    this.scroller.focus();
  }

  /**
   * 键盘等价：行聚焦时 `Delete` 隐藏该行；**列表本身聚焦**时 `Delete` 隐藏当前命中
   * （行不是 Tab 可达的，列表才是——否则纯键盘用户没有入口）。
   */
  private readonly handleRowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Delete') return;
    const target = event.target;
    const row = target instanceof Element ? target.closest('.result') : null;
    const path =
      row instanceof HTMLButtonElement
        ? (row.dataset.path ?? null)
        : target === this.scroller
          ? (this.view?.hits[this.view.current]?.path ?? null)
          : null;
    if (!path) return;
    event.preventDefault();
    this.hideRow(path);
  };

  private readonly handleRestoreHidden = (): void => {
    this.opts.onRestoreHidden?.();
  };
}
