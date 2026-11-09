/**
 * view/panels/search-panel — 搜索面板的 DOM 层（slice 4，C · 工作台）。
 *
 * 职责边界（docs/design/slice4-search-contract.md §3）：
 *   - 自建 DOM；page.html 只留 `<div class="panel panel--search" id="searchPanel">` 挂载点。
 *   - 只读 `SearchPanelView` 快照渲染；不发请求、不 import core、不读全局时钟。
 *   - 结果列表虚拟化：固定 44px 行、spacer = size × 44、窗口由 viewmodel 的
 *     `computeResultWindow` 计算；行节点池复用，滚动只重画窗口。
 *
 * 搜索选项（ADR-0014 §2.1）：查询框右侧两个真实 `<button>`——`Aa`（区分大小写）与
 * `.*`（正则），`aria-pressed` 反映状态、Tab 顺序在查询框之后；点击只回调
 * `onOptionsChange`，**不发协议请求**。正则错误（`view.patternError`）只渲染成查询行
 * 下方的 `role="alert"` 内联错误行，并把输入框标 `aria-invalid`。
 *
 * 硬约束：全部文本走 textContent / createElement / replaceChildren，**禁 innerHTML**。
 * DOM 契约（§3.1）的 class / id 由 app 与 smoke 脚本依赖，不要改名。
 */
import { writeMarkedText } from '../highlight';
import type { SearchFilter, SearchPanelView } from '../../viewmodel/search-state';
import {
  SEARCH_RESULT_OVERSCAN,
  SEARCH_RESULT_ROW_HEIGHT,
  computeResultWindow,
} from '../../viewmodel/search-state';
import { SEARCH_LIMIT } from '../../protocol/versions';

export interface SearchPanelOptions {
  rowHeight?: number;
  overscan?: number;
  onQueryChange(query: string): void;
  onFilterChange(filter: SearchFilter): void;
  /** 点击结果行（过滤后下标） */
  onSelect(index: number): void;
  onPrev(): void;
  onNext(): void;
  /** 输入框 Enter */
  onSubmit(): void;
  /** `Aa` / `.*` 切换；app 负责快照重跑当前查询（面板只回调，不发命令） */
  onOptionsChange?(opts: { caseSensitive: boolean; regex: boolean }): void;
}

/* ---------------- 常量文案 ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** core.search 的命中上限（契约 §3.1：truncated 时总数显示 `50,000+`）；单一来源 = protocol/versions。 */
const SEARCH_LIMIT_LABEL = SEARCH_LIMIT.toLocaleString('en-US');
const TRUNCATED_COUNT_TEXT = `${SEARCH_LIMIT_LABEL}+`;
const TRUNCATED_HINT = `已截断（上限 ${SEARCH_LIMIT_LABEL}）`;

const EMPTY_IDLE_TEXT = '输入关键词搜索键名或字符串值';
const EMPTY_SEARCHING_TEXT = '搜索中…';
const EMPTY_STALE_TEXT = '文档已修改，请重新搜索';

const FILTER_ITEMS: ReadonlyArray<{ value: SearchFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'key', label: '键名' },
  { value: 'value', label: '值' },
];

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

/** 千分位固定 en-US（`37,189`），与契约示例、smoke 断言一致。 */
function formatCount(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return n.toLocaleString('en-US');
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
function writeHighlighted(el: HTMLElement, text: string, term: string): void {
  writeMarkedText(el, text, term, 'result__hit');
}

interface ResultSlot {
  readonly el: HTMLButtonElement;
  readonly pathEl: HTMLSpanElement;
  readonly fieldEl: HTMLSpanElement;
  readonly valueEl: HTMLSpanElement;
  readonly kindEl: HTMLSpanElement;
  index: number;
  visible: boolean;
}

// ---------------------------------------------------------------- panel

export class SearchPanel {
  readonly rowHeight: number;
  readonly overscan: number;

  private readonly host: HTMLElement;
  private readonly opts: SearchPanelOptions;

  private mounted = false;
  private view: SearchPanelView | null = null;
  private rendered = 0;

  private input!: HTMLInputElement;
  private optsEl!: HTMLElement;
  private caseBtn!: HTMLButtonElement;
  private regexBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  /** 面板侧乐观态：点击即翻转，下一次 render 由 viewmodel 快照回填为准 */
  private caseSensitiveOn = false;
  private regexOn = false;
  private countValue!: HTMLElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private posEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private readonly filterButtons = new Map<
    SearchFilter,
    { button: HTMLButtonElement; count: HTMLSpanElement }
  >();
  private scroller!: HTMLElement;
  private spacer!: HTMLElement;
  private windowEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private footEl!: HTMLElement;
  private footRendered!: HTMLElement;
  private footTotal!: HTMLElement;
  private footTruncated!: HTMLElement;

  private readonly slots: ResultSlot[] = [];
  private resizeObserver: ResizeObserver | null = null;

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
    this.input.placeholder = '搜索键名或字符串值…';
    this.input.setAttribute('aria-label', '搜索键名或字符串值');
    box.appendChild(this.input);

    /* 查询行右侧：Aa（区分大小写）/ .*（正则）——真实按钮，Tab 顺序在查询框之后 */
    this.optsEl = el('div', 'csearch__opts');
    this.optsEl.setAttribute('role', 'group');
    this.optsEl.setAttribute('aria-label', '搜索选项');

    this.caseBtn = el('button', 'csearch__toggle');
    this.caseBtn.id = 'searchCase';
    this.caseBtn.type = 'button';
    this.caseBtn.textContent = 'Aa';
    this.caseBtn.setAttribute('aria-label', '区分大小写');
    this.caseBtn.setAttribute('aria-pressed', 'false');
    this.caseBtn.title = '区分大小写（Aa）';

    this.regexBtn = el('button', 'csearch__toggle');
    this.regexBtn.id = 'searchRegex';
    this.regexBtn.type = 'button';
    this.regexBtn.textContent = '.*';
    this.regexBtn.setAttribute('aria-label', '使用正则表达式');
    this.regexBtn.setAttribute('aria-pressed', 'false');
    this.regexBtn.title = '使用正则表达式（.*）';

    this.optsEl.append(this.caseBtn, this.regexBtn);
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
    this.prevBtn.setAttribute('aria-label', '上一个命中');
    this.prevBtn.title = '上一个命中（⇧⌘G / ⇧F3）';
    this.prevBtn.appendChild(createChevronIcon(true));

    this.nextBtn = el('button', 'iconbtn');
    this.nextBtn.id = 'searchNext';
    this.nextBtn.type = 'button';
    this.nextBtn.disabled = true;
    this.nextBtn.setAttribute('aria-label', '下一个命中');
    this.nextBtn.title = '下一个命中（⌘G / F3）';
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

    /* ---- .results__filters：全部 / 键名 / 值 + counts ---- */
    this.filtersEl = el('div', 'results__filters');
    this.filtersEl.setAttribute('role', 'group');
    this.filtersEl.setAttribute('aria-label', '结果过滤');
    for (const item of FILTER_ITEMS) {
      const button = el('button', 'filter');
      button.type = 'button';
      button.dataset.filter = item.value;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = item.label;
      const count = el('span', 'filter__count');
      count.textContent = '0';
      button.appendChild(document.createTextNode(' '));
      button.appendChild(count);
      this.filtersEl.appendChild(button);
      this.filterButtons.set(item.value, { button, count });
    }

    /* ---- .results__scroll#resultsScroll：虚拟列表 ---- */
    this.scroller = el('div', 'results__scroll');
    this.scroller.id = 'resultsScroll';
    this.scroller.setAttribute('role', 'listbox');
    this.scroller.setAttribute('tabindex', '0');
    this.scroller.setAttribute('aria-label', '搜索结果，虚拟滚动列表');
    this.spacer = el('div', 'results__spacer');
    this.spacer.style.height = '0px';
    this.windowEl = el('div', 'results__window');
    this.spacer.appendChild(this.windowEl);
    this.emptyEl = el('div', 'results__empty');
    this.emptyEl.textContent = EMPTY_IDLE_TEXT;
    this.scroller.append(this.spacer, this.emptyEl);

    /* ---- .results__foot#resultsFoot ---- */
    this.footEl = el('div', 'results__foot');
    this.footEl.id = 'resultsFoot';
    this.footEl.hidden = true;
    this.footRendered = el('span');
    this.footRendered.id = 'resultsRendered';
    this.footRendered.textContent = '0';
    this.footTotal = el('span');
    this.footTotal.id = 'resultsTotal';
    this.footTotal.textContent = '0';
    this.footTruncated = el('span', 'results__truncated');
    this.footTruncated.textContent = '';
    this.footTruncated.hidden = true;
    this.footEl.append(
      document.createTextNode('虚拟滚动 · 已渲染 '),
      this.footRendered,
      document.createTextNode(' / '),
      this.footTotal,
      this.footTruncated,
    );

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
    this.scroller.addEventListener('scroll', this.handleScroll, { passive: true });
    this.filtersEl.addEventListener('click', this.handleFiltersClick);
    this.windowEl.addEventListener('click', this.handleRowClick);

    this.resizeObserver = new ResizeObserver(() => this.drawWindow());
    this.resizeObserver.observe(this.scroller);
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

    this.spacer.style.height = `${Math.max(0, view.size) * this.rowHeight}px`;
    if (hitsChanged) this.scroller.scrollTop = 0;

    // drawWindow 内部同步更新 rendered 与 foot（滚动重画时 foot 也保持准确）
    this.drawWindow();
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
    const height = this.scroller.clientHeight;
    const currentTop = this.scroller.scrollTop;

    let nextTop = currentTop;
    if (height <= 0) {
      nextTop = top;
    } else if (top < currentTop) {
      nextTop = top;
    } else if (top + this.rowHeight > currentTop + height) {
      nextTop = top + this.rowHeight - height;
    }

    if (nextTop !== currentTop) this.scroller.scrollTop = Math.max(0, nextTop);
    this.drawWindow();
  }

  resetScroll(): void {
    if (!this.mounted) return;
    this.scroller.scrollTop = 0;
    this.drawWindow();
  }

  /** 当前可见（非 hidden）结果行数。 */
  renderedCount(): number {
    return this.rendered;
  }

  listScrollTop(): number {
    return this.mounted ? this.scroller.scrollTop : 0;
  }

  scrollListTo(px: number): void {
    if (!this.mounted) return;
    const top = Number.isFinite(px) ? Math.max(0, px) : 0;
    this.scroller.scrollTop = top;
    this.drawWindow();
  }

  destroy(): void {
    if (!this.mounted) return;
    this.input.removeEventListener('input', this.handleInput);
    this.input.removeEventListener('keydown', this.handleKeydown);
    this.optsEl.removeEventListener('click', this.handleOptionsClick);
    this.prevBtn.removeEventListener('click', this.handlePrev);
    this.nextBtn.removeEventListener('click', this.handleNext);
    this.scroller.removeEventListener('scroll', this.handleScroll);
    this.filtersEl.removeEventListener('click', this.handleFiltersClick);
    this.windowEl.removeEventListener('click', this.handleRowClick);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.slots.length = 0;
    this.filterButtons.clear();
    this.host.replaceChildren();
    this.view = null;
    this.rendered = 0;
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
    this.syncToggle(this.caseBtn, view.caseSensitive);
    this.syncToggle(this.regexBtn, view.regex);
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
    this.countValue.textContent = view.truncated
      ? TRUNCATED_COUNT_TEXT
      : formatCount(view.total);

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
      const count =
        filter === 'all' ? view.counts.all : filter === 'key' ? view.counts.key : view.counts.value;
      entry.count.textContent = formatCount(count);
    }
  }

  private updateEmptyState(view: SearchPanelView): void {
    let text: string | null = null;
    if (view.phase === 'idle') text = EMPTY_IDLE_TEXT;
    else if (view.phase === 'searching') text = EMPTY_SEARCHING_TEXT;
    else if (view.phase === 'stale') text = EMPTY_STALE_TEXT;
    else if (view.phase === 'ready' && view.size === 0) text = `没有命中「${view.query}」`;

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
    if (view.size === 0) {
      this.footEl.hidden = true;
      this.footRendered.textContent = '0';
      this.footTotal.textContent = '0';
      this.footTruncated.hidden = true;
      this.footTruncated.textContent = '';
      return;
    }
    this.footEl.hidden = false;
    this.footRendered.textContent = formatCount(this.rendered);
    this.footTotal.textContent = formatCount(view.size);
    this.footTruncated.hidden = !view.truncated;
    // 带前导空格直接写进 truncate span，保证未截断时 foot.textContent 以数字结尾（无尾随空格）
    this.footTruncated.textContent = view.truncated ? ` ${TRUNCATED_HINT}` : '';
  }

  /** 只重画可见窗口：spacer 撑出总高度，窗口内行节点池复用。 */
  private drawWindow(): void {
    const view = this.view;
    if (!this.mounted || !view || view.size === 0) {
      this.hideSlotsFrom(0);
      this.rendered = 0;
      if (view) this.updateFoot(view);
      return;
    }

    const scrollTop = Math.max(0, this.scroller.scrollTop);
    const viewportRows = Math.floor(this.scroller.clientHeight / this.rowHeight);
    const window = computeResultWindow(view.size, scrollTop, viewportRows, {
      rowHeight: this.rowHeight,
      overscan: this.overscan,
    });

    this.ensurePool(window.count);

    const term = view.query;
    const current = view.current;
    let used = 0;
    for (let i = 0; i < window.count; i++) {
      const index = window.start + i;
      const hit = view.hits[index];
      if (!hit) break;

      const slot = this.slots[i];
      slot.index = index;
      slot.visible = true;
      slot.el.hidden = false;
      slot.el.style.top = `${index * this.rowHeight}px`;
      slot.el.dataset.index = String(index);
      slot.el.dataset.path = hit.path;
      slot.el.title = hit.path;
      const selected = index === current;
      slot.el.classList.toggle('is-selected', selected);
      slot.el.setAttribute('aria-selected', selected ? 'true' : 'false');

      writeHighlighted(slot.pathEl, hit.path, term);
      writeHighlighted(slot.valueEl, hit.preview, term);
      slot.fieldEl.textContent = hit.field === 'key' ? '键名' : '值';
      slot.kindEl.textContent = hit.kind;
      used++;
    }
    this.hideSlotsFrom(used);
    this.rendered = used;
    this.updateFoot(view);
  }

  private ensurePool(count: number): void {
    while (this.slots.length < count) {
      const elBtn = el('button', 'result');
      elBtn.type = 'button';
      elBtn.setAttribute('role', 'option');
      elBtn.tabIndex = -1;
      elBtn.hidden = true;
      elBtn.style.height = `${this.rowHeight}px`;

      const pathEl = el('span', 'result__path');
      const meta = el('span', 'result__meta');
      const fieldEl = el('span', 'result__field');
      const valueEl = el('span', 'result__value');
      const kindEl = el('span', 'result__kind');
      meta.append(fieldEl, valueEl, kindEl);
      elBtn.append(pathEl, meta);

      this.windowEl.appendChild(elBtn);
      this.slots.push({ el: elBtn, pathEl, fieldEl, valueEl, kindEl, index: -1, visible: false });
    }
  }

  private hideSlotsFrom(from: number): void {
    for (let i = from; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.visible && slot.el.hidden) continue;
      slot.visible = false;
      slot.index = -1;
      slot.el.hidden = true;
      slot.el.classList.remove('is-selected');
      slot.el.removeAttribute('aria-selected');
      // 不把隐藏行留在 `[data-index]` / `[data-path]` 选择器里（权重同失败态一样干净）
      delete slot.el.dataset.index;
      delete slot.el.dataset.path;
      slot.el.removeAttribute('title');
    }
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

  private readonly handleScroll = (): void => {
    this.drawWindow();
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
    };
    this.caseSensitiveOn = next.caseSensitive;
    this.regexOn = next.regex;
    this.syncToggle(this.caseBtn, next.caseSensitive);
    this.syncToggle(this.regexBtn, next.regex);
    this.opts.onOptionsChange?.(next);
  };

  private readonly handleFiltersClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.filter');
    if (!(button instanceof HTMLButtonElement)) return;
    const value = button.dataset.filter;
    if (value === 'all' || value === 'key' || value === 'value') {
      this.opts.onFilterChange(value);
    }
  };

  private readonly handleRowClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.result');
    if (!(row instanceof HTMLButtonElement)) return;
    const index = Number(row.dataset.index);
    if (!Number.isInteger(index)) return;
    this.opts.onSelect(index);
  };
}
