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
import { DOC_NAME_MAX, displayTitle } from '../shared/doc-name';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAB_SELECTOR = '.tabstrip__tab';
const CLOSE_SELECTOR = '.tabstrip__close';

/** 单个标签的视图数据（viewmodel 的 `TabView` 与之逐字对齐）。 */
export interface TabStripTab {
  id: string;
  name: string;
  originalName: string;
  active: boolean;
}

/** 标签条要渲染的纯视图数据（viewmodel 的 `WorkspaceView` 与之逐字对齐）。 */
export interface TabStripView {
  hidden: boolean;
  tabs: TabStripTab[];
  activeId: string | null;
  canAdd: boolean;
  max: number;
}

/** 交互回调：本模块只上报意图，具体状态流转在 app 层。 */
export interface TabStripOptions {
  onSelect(id: string): void;
  onClose(id: string): void;
  onAdd(): void;
  /** 拖拽排序（#18 修订 2026-11-11）：把 id 移到最终下标 toIndex；语义由 app/viewmodel 定 */
  onMove(id: string, toIndex: number): void;
  /** 标签改名（ADR-0021）：原始输入交 app 层清洗，空串 = 保持原名；语义由 app 定 */
  onRename(id: string, name: string): void;
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
  /** 拖拽中的标签 id（null = 当前不是内部标签拖拽；文件拖放走 window 的落点分流） */
  private dragId: string | null = null;
  /** 插入指示线（绝对定位在 host 内，不参与布局） */
  private dropEl: HTMLDivElement | null = null;
  /** 就地改名中的输入框（null = 未在改名）；重绘/切标签时静默丢弃 */
  private editing: { id: string; input: HTMLInputElement; title: HTMLElement; tabEl: HTMLElement } | null =
    null;

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
    this.host.addEventListener('dblclick', this.onDblClick);
    this.host.addEventListener('keydown', this.onKeyDown);
    // 拖拽排序：委托到 host（render 后不重复绑）；指示线是 host 的绝对定位子元素
    this.host.addEventListener('dragstart', this.onDragStart);
    this.host.addEventListener('dragover', this.onDragOver);
    this.host.addEventListener('dragleave', this.onDragLeave);
    this.host.addEventListener('drop', this.onDrop);
    this.host.addEventListener('dragend', this.onDragEnd);
    const drop = document.createElement('div');
    drop.className = 'tabstrip__drop';
    drop.hidden = true;
    drop.setAttribute('aria-hidden', 'true');
    this.host.appendChild(drop);
    this.dropEl = drop;
    this.mounted = true;
  }

  /** 幂等全量重绘（标签 ≤8，成本可忽略）。 */
  render(view: TabStripView): void {
    // 重绘会移除焦点所在节点，先记住焦点是否在条内（hidden 时不归还，避免抢导入层焦点）
    const hadFocus = !view.hidden && this.host.contains(document.activeElement);
    // 改名中的输入框会被整条重绘移除：静默丢弃（未提交即等于 Esc，且不抢焦点）
    this.editing = null;
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
    this.host.removeEventListener('dblclick', this.onDblClick);
    this.host.removeEventListener('keydown', this.onKeyDown);
    this.host.removeEventListener('dragstart', this.onDragStart);
    this.host.removeEventListener('dragover', this.onDragOver);
    this.host.removeEventListener('dragleave', this.onDragLeave);
    this.host.removeEventListener('drop', this.onDrop);
    this.host.removeEventListener('dragend', this.onDragEnd);
    this.clearDragState();
    this.dropEl?.remove();
    this.dropEl = null;
    this.items.replaceChildren();
    this.host.hidden = true;
    this.host.style.height = '';
    this.view = null;
    this.mounted = false;
  }

  /* ------------------------------ 内部 ------------------------------ */

  private buildTab(tab: TabStripTab, isTabStop: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tabstrip__tab';
    el.setAttribute('role', 'tab');
    el.dataset.tabId = tab.id;
    el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
    el.tabIndex = isTabStop ? 0 : -1;
    // 拖拽排序（#18 修订 2026-11-11）：标签本身可拖
    el.draggable = true;
    // 文件名超长时 CSS ellipsis 省略，悬停 title 看全名（改过名时附「原名」）
    el.title = displayTitle(tab.name, tab.originalName);

    const title = document.createElement('span');
    title.className = 'tabstrip__title';
    title.textContent = tab.name;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tabstrip__close';
    // roving tabindex：标签本身是唯一 Tab 停靠点，关闭按钮不进 Tab 序列
    // （键盘关闭走标签上的 Delete / Backspace，见 onKeyDown）
    close.tabIndex = -1;
    close.dataset.tabClose = tab.id;
    // 不带 ✕ 文案，读屏靠 aria-label；× 图标 visual 隐藏
    close.setAttribute('aria-label', `关闭 ${tab.name}`);
    // 从关闭按钮上拖不起标签（避免误拖）
    close.draggable = false;
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

  /* ---------------------------- 就地改名（ADR-0021） ---------------------------- */

  /**
   * 进入就地编辑：标题 span 换成 input（值 = 当前显示名，Enter 提交 / Esc 取消 / 失焦提交）。
   * 编辑期间关掉 `draggable`，避免与拖拽排序抢手势；只动 DOM，清洗与状态写入由 app 回调决定。
   */
  private beginRename(tabEl: HTMLElement): void {
    const id = tabEl.dataset.tabId;
    if (!id) return;
    if (this.editing) {
      if (this.editing.id === id) {
        this.editing.input.focus();
        this.editing.input.select();
        return;
      }
      this.cancelRename();
    }
    const title = tabEl.querySelector<HTMLElement>('.tabstrip__title');
    if (!title) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tabstrip__rename';
    input.value = title.textContent ?? '';
    input.maxLength = DOC_NAME_MAX;
    input.spellcheck = false;
    input.setAttribute('aria-label', '标签名（Enter 保存，Esc 取消）');
    // 编辑框自己吃掉键盘/点击，别让 roving tabindex 的宿主处理器把焦点抢走（抢走 = 立即失焦提交）
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitRename(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelRename();
      }
    });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('dblclick', (event) => event.stopPropagation());
    input.addEventListener('blur', () => {
      // 失焦提交：焦点已经/即将落到用户点击的地方，不抢回标签（Enter 提交才回焦点）
      if (this.editing?.input === input) this.commitRename(false);
    });
    tabEl.draggable = false;
    title.replaceWith(input);
    this.editing = { id, input, title, tabEl };
    input.focus();
    input.select();
  }

  /**
   * 提交改名意图（空串也上报，由 app 决定「保持原名」）并还原 DOM；状态刷新走 app 的 render。
   * `refocus` 只在键盘提交（Enter）时把焦点还给标签；失焦提交不抢焦点（否则会把焦点从用户
   * 刚点的地方拽回来）。
   */
  private commitRename(refocus: boolean): void {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const value = editing.input.value;
    this.restoreTitle(editing);
    this.opts.onRename(editing.id, value);
    if (refocus) this.focusTab(editing.id);
  }

  /** 取消改名：还原标题、丢弃输入、焦点回标签。 */
  private cancelRename(): void {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    this.restoreTitle(editing);
    this.focusTab(editing.id);
  }

  private restoreTitle(editing: { input: HTMLInputElement; title: HTMLElement; tabEl: HTMLElement }): void {
    editing.input.replaceWith(editing.title);
    editing.tabEl.draggable = true;
  }

  /* ---------------------------- 拖拽排序 ---------------------------- */

  private readonly onDragStart = (event: DragEvent): void => {
    const target = event.target;
    const tabEl = target instanceof Element ? target.closest<HTMLElement>(TAB_SELECTOR) : null;
    if (!tabEl || !this.items.contains(tabEl)) return;
    const id = tabEl.dataset.tabId;
    if (!id) return;
    this.dragId = id;
    tabEl.classList.add('is-dragging');
    // 标准 DnD 需要 setData 才能稳定启动（Chrome 里不带 data 的 dragstart 可能被取消）
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };

  private readonly onDragOver = (event: DragEvent): void => {
    if (this.dragId === null) return;
    const index = this.dropIndexAt(event.clientX);
    if (index === null) return;
    // 只有 preventDefault 才允许 drop
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.showDropIndicator(index);
  };

  private readonly onDragLeave = (event: DragEvent): void => {
    if (this.dragId === null) return;
    const related = event.relatedTarget;
    if (related instanceof Node && this.host.contains(related)) return;
    this.hideDropIndicator();
  };

  private readonly onDrop = (event: DragEvent): void => {
    // 只有内部标签拖拽才处理；文件拖放（无 dragId）继续冒泡给 window 的落点分流
    if (this.dragId === null) return;
    const index = this.dropIndexAt(event.clientX);
    const id = this.dragId;
    event.preventDefault();
    this.clearDragState();
    if (index === null) return;
    this.opts.onMove(id, index);
  };

  private readonly onDragEnd = (): void => {
    this.clearDragState();
  };

  /** 指针横坐标 → 插入下标（按每个标签中点判定）；不在标签条范围内 → null。 */
  private dropIndexAt(clientX: number): number | null {
    const box = this.items.getBoundingClientRect();
    if (clientX < box.left - 2 || clientX > box.right + 2) return null;
    const tabs = this.tabEls();
    for (let i = 0; i < tabs.length; i += 1) {
      const rect = tabs[i]!.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabs.length;
  }

  private showDropIndicator(index: number): void {
    const drop = this.dropEl;
    if (!drop) return;
    const tabs = this.tabEls();
    const hostRect = this.host.getBoundingClientRect();
    const last = tabs[tabs.length - 1];
    const x =
      index < tabs.length
        ? tabs[index]!.getBoundingClientRect().left
        : (last?.getBoundingClientRect().right ?? hostRect.left);
    drop.style.left = `${Math.round(x - hostRect.left)}px`;
    drop.hidden = false;
    this.items.dataset.dropIndex = String(index);
  }

  private hideDropIndicator(): void {
    if (this.dropEl) this.dropEl.hidden = true;
    delete this.items.dataset.dropIndex;
  }

  private clearDragState(): void {
    this.dragId = null;
    this.hideDropIndicator();
    for (const el of this.host.querySelectorAll<HTMLElement>('.is-dragging')) {
      el.classList.remove('is-dragging');
    }
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
      if (!id) return;
      // 双击的第二击（detail=2）就进改名：不依赖 dblclick 靶点——双击非活动标签时第一击
      // 会切标签并整条重绘，第一次点击的节点已被替换，dblclick 未必派发到标题上。
      if (event.detail === 2) {
        event.preventDefault();
        this.beginRename(tabEl);
        return;
      }
      this.activate(id);
    }
  };

  /**
   * 双击标签（标题位置）= 就地改名（单击仍是切换；关闭 / ＋不参与）。
   * 靶点取整个标签而不只是标题 span：双击非活动标签时第一击会切标签并整条重绘，
   * 第二击的 dblclick 可能落在新 DOM 的标签节点上。
   */
  private readonly onDblClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(CLOSE_SELECTOR) || target.closest('#tabAdd')) return;
    const tabEl = target.closest<HTMLElement>(TAB_SELECTOR);
    if (!tabEl || !this.items.contains(tabEl)) return;
    event.preventDefault();
    this.beginRename(tabEl);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const tabEl = target?.closest<HTMLElement>(TAB_SELECTOR) ?? null;
    if (!tabEl || !this.items.contains(tabEl)) return;

    const tabs = this.tabEls();
    const index = tabs.indexOf(tabEl);
    if (index < 0) return;

    // F2：就地改名（与双击标题等价，键盘入口；ADR-0021）
    if (event.key === 'F2') {
      event.preventDefault();
      this.beginRename(tabEl);
      return;
    }

    // Alt+←/→：把当前标签左/右移一位（拖拽排序的键盘等价入口，a11y）
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const id = tabEl.dataset.tabId;
      if (!id) return;
      event.preventDefault();
      const target = Math.max(0, Math.min(tabs.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
      if (target !== index) this.opts.onMove(id, target);
      return;
    }

    // 键盘关闭：Delete / Backspace 关当前（被聚焦的）标签（关闭按钮不进 Tab 序列）
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const id = tabEl.dataset.tabId;
      if (!id) return;
      event.preventDefault();
      this.opts.onClose(id);
      return;
    }

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
