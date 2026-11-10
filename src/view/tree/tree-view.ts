/**
 * view/tree/tree-view — 固定行高树视图（S3 的宿主）。
 *
 * 职责边界（docs/architecture/seams.md §3/§4）：
 *   - 只消费 WindowSnapshot；**不自己请求窗口**——滚动只回调 onScroll，由 app 层转给 RowWindowSource。
 *   - 滚动容器 + spacer（min(totalRows × rowHeight, MAX_SCROLL_PX)）+ 行池渲染器。
 *   - 行渲染器由 app 以 factory 注入：TreeView 在 mount 时创建行容器并交给 factory，
 *     所以 DOM adapter 不需要知道树的外壳（S3「app 注入 adapter」）。
 *   - 行绝对定位 top = (start + i) × rowHeight，行池按槽位复用。
 *   - click 委托：caret / 项数标 → onToggle(path, !open)；行 → onSelect(path)。
 *   - 最小键盘：↑/↓ 移动选中、←/→ 折叠/展开、Enter 切换。
 */
import { clampRowHeight } from '../../shared/num';
import type { JsonKind, Row } from '../../protocol/types';
import { MAX_SCROLL_PX } from '../../protocol/versions';
import type { WindowSnapshot } from '../../viewmodel/row-window-source';
import type { RowContext, RowHandle, RowRenderer, RowRendererFactory } from './row-renderer';

export type { RowRendererFactory } from './row-renderer';

export interface TreeViewOptions {
  /** 行渲染器工厂：TreeView 提供行容器，app 决定用哪个 adapter */
  renderer: RowRendererFactory;
  rowHeight: number;
  onScroll(scrollTopPx: number): void;
  onToggle(path: string, open: boolean): void;
  onSelect(path: string): void;
  /** 编辑意图（slice 5）：行双击 / F2。不提供时该入口静默不可用。 */
  onEdit?(path: string): void;
  /** 行右键（slice 5 / ADR-0010）：app 负责弹菜单；上报路径、屏幕坐标与**该行数据**（菜单启用态用）。 */
  onContextMenu?(path: string, x: number, y: number, row: Row): void;
  /** 行尾浮条动作（ADR-0010 修订）：鼠标快路径 copy=子树 JSON / edit=弹层；未提供时按钮无动作。 */
  onRowAction?(path: string, action: 'copy' | 'edit'): void;
}

export interface TreeSearchState {
  term?: string;
  hitPaths?: Iterable<string>;
  /** 搜索的「当前命中」路径（可空） */
  currentPath?: string | null;
}

export class TreeView {
  private readonly host: HTMLElement;
  private readonly opts: TreeViewOptions;

  private scroller: HTMLDivElement | null = null;
  private spacer: HTMLDivElement | null = null;
  private rowsHost: HTMLDivElement | null = null;
  private renderer: RowRenderer | null = null;
  private mounted = false;

  /** 行高真值（RowMetricsSource，ADR-0011 §6）：构造时取 opts.rowHeight，设置变化后 setRowHeight 同步 */
  private rowHeight: number;
  private handles: Array<RowHandle | null> = [];
  private rows: Row[] = [];
  private lastSnapshot: WindowSnapshot | null = null;
  private totalRows = 0;

  private selectedPath: string | null = null;
  /** Apply 后短暂高亮的路径（行池复用下按路径匹配，见 applyChangedClass） */
  private changedPath: string | null = null;
  private hitPaths = new Set<string>();
  private currentHitPath: string | null = null;
  private searchTerm: string | undefined;
  private typeColumn = false;
  private showActions = true;

  private readonly onScrollBound = (): void => {
    if (!this.scroller) return;
    this.opts.onScroll(this.scroller.scrollTop);
  };

  private readonly onClickBound = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const rowEl = target.closest('.row') as HTMLElement | null;
    if (!rowEl) return;
    const path = rowEl.dataset.path;
    if (!path) return;

    if (target.closest('.row__caret')) {
      const row = this.findRow(path);
      if (row && row.hasChildren) this.opts.onToggle(path, !row.open);
      return;
    }
    // 项数标 = 展开/收起的第二入口（#9 / direction §5）：与 caret 等价，只 toggle、不改选中行。
    // 行内可点文本、不进 Tab 序列；空容器没有项数标（hasChildren=false）时保持原行为。
    if (target.closest('.row__count')) {
      const row = this.findRow(path);
      if (row && row.hasChildren) this.opts.onToggle(path, !row.open);
      return;
    }
    // 行尾浮条（ADR-0010 修订）：先选中该行（与右键菜单一致），再交给 app 执行动作
    const actionEl = target.closest<HTMLElement>('.row__action');
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action !== 'copy' && action !== 'edit') return;
      this.opts.onSelect(path);
      this.opts.onRowAction?.(path, action);
      return;
    }
    if (target.closest('.row__actions')) return;
    this.opts.onSelect(path);
  };

  private readonly onKeyDownBound = (event: KeyboardEvent): void => {
    const rows = this.rows;
    if (rows.length === 0) return;
    const index = this.indexOfSelected();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveSelection(Math.min(rows.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveSelection(Math.max(0, index - 1));
        break;
      case 'ArrowRight': {
        const row = index >= 0 ? rows[index] : undefined;
        if (row && row.hasChildren && !row.open) {
          event.preventDefault();
          this.opts.onToggle(row.path, true);
        }
        break;
      }
      case 'ArrowLeft': {
        const row = index >= 0 ? rows[index] : undefined;
        if (row && row.hasChildren && row.open) {
          event.preventDefault();
          this.opts.onToggle(row.path, false);
        }
        break;
      }
      case 'Enter': {
        const row = index >= 0 ? rows[index] : undefined;
        if (row && row.hasChildren) {
          event.preventDefault();
          this.opts.onToggle(row.path, !row.open);
        }
        break;
      }
      // 编辑（slice 5）：Enter 沿用「切换展开」的既有契约，编辑键用 F2（偏差见报告）
      case 'F2': {
        if (this.selectedPath !== null && this.opts.onEdit) {
          event.preventDefault();
          this.opts.onEdit(this.selectedPath);
        }
        break;
      }
      default:
        break;
    }
  };

  /** 行双击 → 编辑意图（caret/项数标/行操作按钮除外，避免与展开/操作冲突）。 */
  private readonly onDblClickBound = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const rowEl = target.closest('.row') as HTMLElement | null;
    if (!rowEl) return;
    // 项数标同 caret：双击它只应是两次 toggle，不弹编辑层（#9）
    if (
      target.closest('.row__caret') ||
      target.closest('.row__count') ||
      target.closest('.row__actions')
    ) {
      return;
    }
    const path = rowEl.dataset.path;
    if (!path || !this.opts.onEdit) return;
    event.preventDefault();
    this.opts.onEdit(path);
  };

  /** 行右键 → 菜单意图；只接管行上的 contextmenu，空白区保留浏览器默认菜单。 */
  private readonly onContextMenuBound = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const rowEl = target.closest('.row') as HTMLElement | null;
    if (!rowEl) return;
    const path = rowEl.dataset.path;
    if (!path || !this.opts.onContextMenu) return;
    // 只对当前窗口内的行开菜单：用行窗口数据（kind / open / count）判定启用态，
    // 不再从行 DOM 反查（DOM 只有 data-kind，撑不起「有没有子节点 / 是否展开」）。
    const row = this.findRow(path);
    if (!row) return;
    event.preventDefault();
    this.opts.onContextMenu(path, event.clientX, event.clientY, row);
  };

  constructor(host: HTMLElement, opts: TreeViewOptions) {
    this.host = host;
    this.opts = opts;
    this.rowHeight = clampRowHeight(opts.rowHeight);
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    const scroller = document.createElement('div');
    scroller.className = 'tjv-tree';
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'tree');
    scroller.setAttribute('aria-label', 'JSON 树视图');
    scroller.style.setProperty('--row-h', `${this.rowHeight}px`);

    const spacer = document.createElement('div');
    spacer.className = 'tjv-tree__spacer';

    const rowsHost = document.createElement('div');
    rowsHost.className = 'tjv-tree__rows';
    spacer.appendChild(rowsHost);

    scroller.appendChild(spacer);
    this.host.appendChild(scroller);

    this.scroller = scroller;
    this.spacer = spacer;
    this.rowsHost = rowsHost;

    const renderer = this.opts.renderer(rowsHost);
    this.renderer = renderer;
    renderer.create();

    scroller.addEventListener('scroll', this.onScrollBound, { passive: true });
    scroller.addEventListener('click', this.onClickBound);
    scroller.addEventListener('keydown', this.onKeyDownBound);
    scroller.addEventListener('dblclick', this.onDblClickBound);
    scroller.addEventListener('contextmenu', this.onContextMenuBound);
  }

  /** 渲染一帧窗口：只做定位与状态映射，不发请求。 */
  render(snapshot: WindowSnapshot): void {
    this.lastSnapshot = snapshot;
    this.rows = snapshot.rows.slice();
    this.totalRows = snapshot.totalRows;

    const scroller = this.scroller;
    const spacer = this.spacer;
    const renderer = this.renderer;
    if (!this.mounted || !scroller || !spacer || !renderer) return;

    const rowHeight = this.rowHeight;
    const contentPx = Math.min(this.totalRows * rowHeight, MAX_SCROLL_PX);
    spacer.style.height = `${contentPx}px`;
    scroller.classList.toggle('is-stale', snapshot.stale);

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i] as Row;
      const ctx: RowContext = {
        selected: row.path === this.selectedPath,
        hit: this.hitPaths.has(row.path),
        current: row.path === this.currentHitPath,
        // 只在命中行上渲染 <mark>：否则折叠容器摘要里的同词会被高亮成「无 is-hit 的 mark」
        searchTerm: this.hitPaths.has(row.path) ? this.searchTerm : undefined,
        typeColumn: this.typeColumn,
        showActions: this.showActions,
      };
      const handle = renderer.update(this.handles[i] ?? null, row, ctx);
      this.handles[i] = handle;
      renderer.setVisible(handle, true);
      renderer.setTop(handle, (snapshot.start + i) * rowHeight);
    }

    for (let i = this.rows.length; i < this.handles.length; i++) {
      const handle = this.handles[i];
      if (handle) renderer.setVisible(handle, false);
    }

    // 行池复用：每帧按路径重新打标记，滚出再滚回、以及隐藏槽位复用到别的行都不会留旧 class
    this.applyChangedClass();
  }

  setSelected(path: string | null): void {
    this.selectedPath = path;
    const renderer = this.renderer;
    if (!this.mounted || !renderer) return;

    const index = this.indexOfSelected();
    const handle = index >= 0 ? this.handles[index] ?? null : null;
    renderer.setSelected(handle);
  }

  /**
   * Apply 后的短暂高亮（slice 5）：给路径匹配的行加 `.is-changed`，null 清除。
   * 行池复用安全——每次 render 结束都按当前帧路径重打一遍，旧槽位不会残留。
   */
  setChangedPath(path: string | null): void {
    if (this.changedPath === path) return;
    this.changedPath = path;
    this.applyChangedClass();
  }

  setSearch(state: TreeSearchState | null): void {
    if (!state) {
      this.searchTerm = undefined;
      this.hitPaths = new Set();
      this.currentHitPath = null;
    } else {
      this.searchTerm = state.term;
      // 命中集可能很大（50k）：viewmodel 已经持有 Set 时直接复用，避免每次导航重拷贝。
      const next = state.hitPaths;
      this.hitPaths = next instanceof Set ? (next as Set<string>) : new Set(next ?? []);
      this.currentHitPath = state.currentPath ?? null;
    }
    this.refresh();
  }

  /**
   * 行高变化（设置面板 / RowMetricsSource，ADR-0011 §6）：更新 CSS 变量、spacer 高度并按当前快照重排。
   * 只影响渲染与滚动几何，不改行号/路径/选中。
   */
  setRowHeight(px: number): void {
    const next = clampRowHeight(px);
    if (next === this.rowHeight) return;
    this.rowHeight = next;
    this.scroller?.style.setProperty('--row-h', `${next}px`);
    if (this.spacer) {
      this.spacer.style.height = `${Math.min(this.totalRows * next, MAX_SCROLL_PX)}px`;
    }
    this.refresh();
  }

  rowHeightPx(): number {
    return this.rowHeight;
  }

  setTypeColumn(enabled: boolean): void {
    if (this.typeColumn === enabled) return;
    this.typeColumn = enabled;
    this.refresh();
  }

  setShowActions(enabled: boolean): void {
    if (this.showActions === enabled) return;
    this.showActions = enabled;
    this.refresh();
  }

  /** 用最近一帧快照重绘（搜索态/类型列等视图态变化，不重新请求窗口）。 */
  refresh(): void {
    if (this.lastSnapshot) this.render(this.lastSnapshot);
  }

  /**
   * 当前窗口里某行的行数据（`kind`/`open`/`count`/`hasChildren`）；不在窗口内返回 null。
   * 菜单启用态与 dev hook 都走这里，保证「菜单看到的行」与「右键的行」是同一份数据。
   */
  rowInfo(path: string): Row | null {
    return this.findRow(path) ?? null;
  }

  /** 直接设置滚动容器的 scrollTop；浏览器随后触发 scroll 事件，由 app 层请求窗口。 */
  /** 当前命中行是否已渲染在行池里（dev hook 用；模块自报，不查全局 DOM）。 */
  currentRowRendered(): boolean {
    return this.rowsHost?.querySelector('.row.is-current') !== null;
  }

  /** 类型列是否有可见单元格（dev hook 用）。 */
  typeColumnVisible(): boolean {
    const cells = this.rowsHost?.querySelectorAll<HTMLElement>('.row__type') ?? [];
    return [...cells].some((cell) => !cell.hidden);
  }

  /** spacer 高度（CSS 高度字符串；dev hook 断言滚动几何用）。 */
  spacerHeight(): string | null {
    return this.spacer?.style.height ?? null;
  }

  scrollToPx(top: number): void {
    const scroller = this.scroller;
    if (!scroller) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(Math.max(0, top), max);
  }

  scrollTopPx(): number {
    return this.scroller?.scrollTop ?? 0;
  }

  /** 当前视口可容纳的行数（供 RowWindowSource.setMetrics）。 */
  viewportRows(): number {
    const height = this.clientHeightPx();
    return Math.max(1, Math.floor(height / this.rowHeight));
  }

  clientHeightPx(): number {
    return this.scroller?.clientHeight ?? 0;
  }

  destroy(): void {
    if (!this.mounted) return;
    this.mounted = false;
    const scroller = this.scroller;
    if (scroller) {
      scroller.removeEventListener('scroll', this.onScrollBound);
      scroller.removeEventListener('click', this.onClickBound);
      scroller.removeEventListener('keydown', this.onKeyDownBound);
      scroller.removeEventListener('dblclick', this.onDblClickBound);
      scroller.removeEventListener('contextmenu', this.onContextMenuBound);
      scroller.remove();
    }
    this.renderer?.destroy();
    this.scroller = null;
    this.spacer = null;
    this.rowsHost = null;
    this.renderer = null;
    this.handles = [];
    this.rows = [];
    this.lastSnapshot = null;
  }

  // ---------------------------------------------------------------- internal

  private indexOfSelected(): number {
    if (this.selectedPath === null) return -1;
    for (let i = 0; i < this.rows.length; i++) {
      if ((this.rows[i] as Row).path === this.selectedPath) return i;
    }
    return -1;
  }

  private findRow(path: string): Row | undefined {
    for (const row of this.rows) if (row.path === path) return row;
    return undefined;
  }

  private moveSelection(index: number): void {
    const row = this.rows[index];
    if (!row) return;
    if (row.path === this.selectedPath) return;
    this.setSelected(row.path);
    this.opts.onSelect(row.path);
    this.scrollRowIntoView(index);
  }

  private scrollRowIntoView(index: number): void {
    const scroller = this.scroller;
    if (!scroller) return;
    const rowHeight = this.rowHeight;
    const start = this.lastSnapshot?.start ?? 0;
    const top = (start + index) * rowHeight;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    if (top < viewTop) {
      this.scrollToPx(top);
    } else if (top + rowHeight > viewBottom) {
      this.scrollToPx(top + rowHeight - scroller.clientHeight);
    }
  }

  /** 按路径匹配当前渲染行打 `.is-changed`（先清后加，行池/隐藏槽位都安全）。 */
  private applyChangedClass(): void {
    const host = this.rowsHost;
    if (!host) return;
    const target = this.changedPath;
    for (const el of host.querySelectorAll<HTMLElement>('.row')) {
      el.classList.toggle('is-changed', target !== null && el.dataset.path === target);
    }
  }
}
