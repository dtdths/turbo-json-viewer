/**
 * view/tree/tree-view — 固定行高树视图（S3 的宿主）。
 *
 * 职责边界（docs/architecture/seams.md §3/§4）：
 *   - 只消费 WindowSnapshot；**不自己请求窗口**——滚动只回调 onScroll，由 app 层转给 RowWindowSource。
 *   - 滚动容器 + spacer（min(totalRows × rowHeight, MAX_SCROLL_PX)）+ 行池渲染器。
 *   - 行渲染器由 app 以 factory 注入：TreeView 在 mount 时创建行容器并交给 factory，
 *     所以 DOM adapter 不需要知道树的外壳（S3「app 注入 adapter」）。
 *   - 行绝对定位 top = (start + i) × rowHeight，行池按槽位复用。
 *   - click 委托：caret → onToggle(path, !open)；行 → onSelect(path)。
 *   - 最小键盘：↑/↓ 移动选中、←/→ 折叠/展开、Enter 切换。
 */
import type { Row } from '../../protocol/types';
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

  private handles: Array<RowHandle | null> = [];
  private rows: Row[] = [];
  private lastSnapshot: WindowSnapshot | null = null;
  private totalRows = 0;

  private selectedPath: string | null = null;
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
    if (target.closest('.row__actions')) return; // 行操作由 app 层接管
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
      default:
        break;
    }
  };

  constructor(host: HTMLElement, opts: TreeViewOptions) {
    this.host = host;
    this.opts = opts;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    const scroller = document.createElement('div');
    scroller.className = 'tjv-tree';
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'tree');
    scroller.setAttribute('aria-label', 'JSON 树视图');
    scroller.style.setProperty('--row-h', `${this.opts.rowHeight}px`);

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

    const rowHeight = this.opts.rowHeight;
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
  }

  setSelected(path: string | null): void {
    this.selectedPath = path;
    const renderer = this.renderer;
    if (!this.mounted || !renderer) return;

    const index = this.indexOfSelected();
    const handle = index >= 0 ? this.handles[index] ?? null : null;
    renderer.setSelected(handle);
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

  /** 直接设置滚动容器的 scrollTop；浏览器随后触发 scroll 事件，由 app 层请求窗口。 */
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
    return Math.max(1, Math.floor(height / this.opts.rowHeight));
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
    const rowHeight = this.opts.rowHeight;
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
}
