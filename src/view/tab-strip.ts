/**
 * view/tab-strip — 多文档标签条（#18 / ADR-0009 §1、direction.md §11）。
 *
 * 形态：工具栏正下方的 **32px 最简条**（文件名 + `×` + `＋`），**仅 ≥2 个文档时显示**；
 * 单文档时 host 带 `hidden`，不占高度，界面与 C 形态完全一致（不产生任何视觉变化）。
 *
 * 分工（与 app / viewmodel 层的边界）：
 *   - 本模块只做 DOM：全量重绘、事件委托、roving tabindex、重绘后焦点归还；
 *   - 标签数据与切换 / 关闭 / 新增的语义（发 `closeRoot`、激活相邻标签、打开新标签导入层）
 *     全在 app / viewmodel 层，这里只通过 `TabStripOptions` 回调出去，不读协议、不碰 core。
 *   - 高度单一真相 = `TAB_STRIP_HEIGHT`（`protocol/versions`）：`mount()` 写 host 的 inline
 *     height；CSS 不写死 height（只写显隐、边框、底色、对齐），避免两处真相漂移。
 *
 * DOM 契约见 `src/app/page.html` 的 `#tabStrip` 容器（id / class 不可改名，冒烟按此查询）：
 *   `#tabStrip`（role=tablist）> `#tabStripItems`（标签容器）+ `#tabAdd`（新标签按钮）。
 * 每个标签：`.tabstrip__tab[role=tab][data-tab-id]` > `.tabstrip__title` + `.tabstrip__close[data-tab-close]`。
 *
 * 键盘（a11y，仓库纪律）：roving tabindex（只有活动标签进 Tab 序列）；
 * 标签上 ArrowLeft / ArrowRight 移动并激活、Home / End 到首 / 尾；
 * 重绘时若焦点原本在条内，归还给活动标签（避免 render 丢焦点）。
 */
import { TAB_STRIP_HEIGHT } from '../protocol/versions';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAB_SELECTOR = '.tabstrip__tab';
const CLOSE_SELECTOR = '.tabstrip__close';

/** 标签条要渲染的纯视图数据（viewmodel 的 `WorkspaceView` 与之逐字对齐）。 */
export interface TabStripView {
  hidden: boolean;
  tabs: { id: string; name: string; active: boolean }[];
  activeId: string | null;
  canAdd: boolean;
  max: number;
}

/** 交互回调：本模块只上报意图，具体状态流转在 app 层。 */
export interface TabStripOptions {
  onSelect(id: string): void;
  onClose(id: string): void;
  onAdd(): void;
}

/** `＋` 图标（16 网格；尺寸由 CSS 的 `.iconbtn svg` 决定）。 */
function createAddIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 3.4v9.2M3.4 8h9.2');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

/** `×` 图标（与 page.html 里既有 close 图标同路径）。 */
function createCloseIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'm4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.35');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

export class TabStrip {
  private readonly host: HTMLElement;
  private readonly items: HTMLElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly opts: TabStripOptions;
  /** 最近一次 render 的视图（焦点归还与默认焦点目标用）。 */
  private view: TabStripView | null = null;
  private mounted = false;

  constructor(host: HTMLElement, opts: TabStripOptions) {
    const items = host.querySelector<HTMLElement>('#tabStripItems');
    const addBtn = host.querySelector<HTMLButtonElement>('#tabAdd');
    if (!items || !addBtn) {
      throw new Error('tab-strip: 缺少 #tabStripItems / #tabAdd（page.html DOM 契约不符）');
    }
    this.host = host;
    this.items = items;
    this.addBtn = addBtn;
    this.opts = opts;
  }

  /** 写 host 高度 + 绑事件委托。只在初始化时调一次（重复调用无副作用）。 */
  mount(): void {
    if (this.mounted) return;
    // 高度单一真相：只在这里写一次 inline height，CSS 不写 height
    this.host.style.height = `${TAB_STRIP_HEIGHT}px`;
    // 事件绑定在容器上（render 后不重复绑；标签 ≤8，委托不会有性能问题）
    this.host.addEventListener('click', this.onClick);
    this.host.addEventListener('keydown', this.onKeyDown);
    this.mounted = true;
  }

  /** 幂等全量重绘（标签 ≤8，成本可忽略）。 */
  render(view: TabStripView): void {
    // 重绘会移除焦点所在节点，先记住焦点是否在条内（hidden 时不归还，避免抢导入层焦点）
    const hadFocus = !view.hidden && this.host.contains(document.activeElement);
    this.view = view;

    this.host.hidden = view.hidden;

    const frag = document.createDocumentFragment();
    // roving tabindex 的 Tab 入口：活动标签；无活动标签（异常态）退回第一个
    const tabStop = view.activeId ?? view.tabs[0]?.id ?? null;
    for (const tab of view.tabs) frag.appendChild(this.buildTab(tab, tab.id === tabStop));
    this.items.replaceChildren(frag);

    this.addBtn.disabled = !view.canAdd;
    this.addBtn.title = view.canAdd ? '新标签（⌘⇧O）' : `最多 ${view.max} 个标签`;

    if (hadFocus) this.focusTab(view.activeId ?? view.tabs[0]?.id ?? null);
  }

  /** 解绑事件并清空条内 DOM（app 拆除时调用；之后可重新 mount）。 */
  dispose(): void {
    if (!this.mounted) return;
    this.host.removeEventListener('click', this.onClick);
    this.host.removeEventListener('keydown', this.onKeyDown);
    this.items.replaceChildren();
    this.host.hidden = true;
    this.host.style.height = '';
    this.view = null;
    this.mounted = false;
  }

  /* ------------------------------ 内部 ------------------------------ */

  private buildTab(tab: { id: string; name: string; active: boolean }, isTabStop: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tabstrip__tab';
    el.setAttribute('role', 'tab');
    el.dataset.tabId = tab.id;
    el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
    el.tabIndex = isTabStop ? 0 : -1;
    // 文件名超长时 CSS ellipsis 省略，悬停 title 看全名
    el.title = tab.name;

    const title = document.createElement('span');
    title.className = 'tabstrip__title';
    title.textContent = tab.name;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tabstrip__close';
    close.dataset.tabClose = tab.id;
    // 不带 ✕ 文案，读屏靠 aria-label；× 图标 visual 隐藏
    close.setAttribute('aria-label', `关闭 ${tab.name}`);
    close.appendChild(createCloseIcon());

    el.append(title, close);
    return el;
  }

  private tabEls(): HTMLElement[] {
    return Array.from(this.items.querySelectorAll<HTMLElement>(TAB_SELECTOR));
  }

  private findTab(id: string | null): HTMLElement | null {
    if (id === null) return null;
    return this.tabEls().find((el) => el.dataset.tabId === id) ?? null;
  }

  /** 激活意图上报；随后把焦点落到目标标签（上层同步 render 时再被 render 的归还逻辑接管）。 */
  private activate(id: string): void {
    this.opts.onSelect(id);
    this.focusTab(id);
  }

  /** 焦点落到指定标签；`tabindex=-1` 的节点也能被程序化聚焦，roving 由 render 修正。 */
  private focusTab(id: string | null): void {
    const el = this.findTab(id);
    el?.focus({ preventScroll: true });
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // 关闭优先：先拦下，避免同时触发 select（按钮在标签内，事件会冒泡到标签）
    const closeEl = target.closest<HTMLElement>(CLOSE_SELECTOR);
    if (closeEl && this.host.contains(closeEl)) {
      const id = closeEl.dataset.tabClose;
      if (!id) return;
      event.stopPropagation();
      this.opts.onClose(id);
      return;
    }

    if (target.closest('#tabAdd')) {
      this.opts.onAdd();
      return;
    }

    const tabEl = target.closest<HTMLElement>(TAB_SELECTOR);
    if (tabEl && this.items.contains(tabEl)) {
      const id = tabEl.dataset.tabId;
      if (id) this.activate(id);
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const tabEl = target?.closest<HTMLElement>(TAB_SELECTOR) ?? null;
    if (!tabEl || !this.items.contains(tabEl)) return;

    const tabs = this.tabEls();
    const index = tabs.indexOf(tabEl);
    if (index < 0) return;

    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = index - 1;
        break;
      case 'ArrowRight':
        next = index + 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    // 两端夹取不循环（与 VSCode 标签条一致；避免首尾跳跃意外循环）
    const clamped = Math.max(0, Math.min(tabs.length - 1, next));
    const id = tabs[clamped]?.dataset.tabId;
    if (!id) return;
    this.activate(id);
  };
}
