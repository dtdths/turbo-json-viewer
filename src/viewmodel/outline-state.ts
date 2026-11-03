/**
 * viewmodel/outline-state — 大纲面板状态机（ADR-0013 §5）。
 *
 * 纯 TS、零 DOM：持有「按容器分页取回的结构子项」、展开集合、选中路径，以及
 * 扁平化后的虚拟列表行（脏标记重建）。视图只消费 `view()` 快照与订阅通知。
 *
 * 数据源 seam（ADR-0013 §3）：注入 `OutlineSource`（`core.outline` 的结构子集），
 * 只读、按容器分页；大纲的展开集合 / 扁平化 / 窗口全部留在主线程（不建第二棵行模型）。
 *
 * 纪律（与 RowWindowSource / RawWindowSource 同构）：
 *   - `epoch`：`open` / `refresh` / `close` 时递增；迟到回包（旧文档 / 旧版本）一律丢弃且不通知；
 *   - 每容器单飞（`loading`）：同一容器 in-flight 时 `loadMore` / `setOpen` 不重复请求；
 *   - 根永远展开、不可折叠；折叠容器丢弃**子树**的页缓存与展开项（自身页缓存保留，
 *     重展开不重取——ADR-0013 §5「折叠容器时丢弃该子树的页缓存与展开项」）。
 *
 * 不依赖 DOM、不依赖定时器（可单测）。
 */
import type { JsonKind, OutlineChild, OutlineReply, Path, RootId } from '../protocol/types';
import { OUTLINE_PAGE } from '../protocol/versions';
import { ROOT_PATH } from '../shared/path';
import { computeVirtualWindow } from '../shared/window';

/** 大纲行高（px）默认值 = 设置默认行高；实际渲染行高由面板跟随 `Settings.rowHeight`。 */
export const OUTLINE_ROW_HEIGHT = 24;
/** 虚拟列表上下额外渲染的行数（ADR-0013 §1：overscan 6）。 */
export const OUTLINE_OVERSCAN = 6;

/** 大纲阶段：无文档（idle）/ 根页加载中（loading）/ 可交互（ready）/ 根页失败（error）。 */
export type OutlinePhase = 'idle' | 'loading' | 'ready' | 'error';

/** 一行（扁平化后）：根 / 容器成员 / 标量成员 / 「加载更多」哨兵。 */
export interface OutlineRow {
  /** 行代表的节点路径；哨兵行 = 所属容器路径 */
  path: Path;
  /** 缩进层级：根 = 0 */
  depth: number;
  /** 显示键：`$`（根）/ 对象键原文 / 数组下标 `[i]` / 哨兵行文案 */
  key: string;
  /** true = 数组下标样式（`--syntax-index`） */
  idx: boolean;
  /** 节点类型；哨兵行 = null */
  kind: JsonKind | null;
  /** 容器子项数；标量为 0 */
  count: number;
  /** 容器是否展开（根恒 true；哨兵行 false） */
  open: boolean;
  /** 是否可展开（容器且有子项；空容器 / 标量无 caret） */
  expandable: boolean;
  /** true = 「加载更多」哨兵行 */
  more: boolean;
}

/** 交给 `OutlinePanel.render()` 的只读快照。 */
export interface OutlineView {
  phase: OutlinePhase;
  rootId: RootId | null;
  /** 扁平化行（含根行 / 子行 / 哨兵行）；根页未就绪时为空数组 */
  rows: readonly OutlineRow[];
  /** 树选中同步过来的当前路径；替代方案见 ADR-0013 §4「当前节点高亮」 */
  selected: Path | null;
  /** 根页错误文案（phase === 'error' 时有值） */
  error: string | null;
  /** 已成功取回页的容器数（诊断） */
  loadedContainers: number;
  /** 已加载子项总行数（诊断） */
  loadedChildren: number;
}

/** 数据源注入点：`core.outline` 的结构子集（单测用 fake，不碰真实 core 单例）。 */
export interface OutlineSource {
  outline(req: { rootId: RootId; path: Path; start: number; count: number }): Promise<OutlineReply>;
}

export interface OutlineStateOptions {
  /** 每页子项数（默认 OUTLINE_PAGE；单测可调小） */
  page?: number;
}

/** 容器页缓存 + 单飞标志。 */
interface Container {
  kind: JsonKind;
  /** 子项总数（分页依据；首包前未知 → 0） */
  total: number;
  items: OutlineChild[];
  /** true = 有 in-flight 请求（每容器单飞） */
  loading: boolean;
  /** true = 至少成功取回过一页（根页未 loaded 前 phase = loading） */
  loaded: boolean;
  error: string | null;
  /** 在途请求（单飞时复用，避免调用方各自等不同 promise） */
  pending: Promise<void> | null;
}

export interface OutlineWindow {
  start: number;
  count: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** `path` 是否为 `ancestor` 的严格后代（规范路径：段分隔为 `.` / `[`）。 */
function isDescendant(path: Path, ancestor: Path): boolean {
  if (path === ancestor || path.length <= ancestor.length) return false;
  if (!path.startsWith(ancestor)) return false;
  const next = path[ancestor.length];
  return next === '.' || next === '[';
}

/**
 * 大纲虚拟窗口（纯函数，测试友好）：口径见 `shared/window.computeVirtualWindow`。
 * 行高默认 OUTLINE_ROW_HEIGHT（24）、overscan 默认 OUTLINE_OVERSCAN（6）。
 */
export function computeOutlineWindow(
  size: number,
  scrollTop: number,
  viewportRows: number,
  opts: { rowHeight?: number; overscan?: number } = {},
): OutlineWindow {
  return computeVirtualWindow(size, scrollTop, viewportRows, {
    rowHeight: opts.rowHeight && opts.rowHeight > 0 ? opts.rowHeight : OUTLINE_ROW_HEIGHT,
    overscan: opts.overscan ?? OUTLINE_OVERSCAN,
  });
}

export class OutlineState {
  private readonly source: OutlineSource;
  /** 每页子项数 */
  private readonly page: number;

  private rootIdValue: RootId | null = null;
  private epochValue = 0;
  private selectedValue: Path | null = null;

  /** 容器页缓存（key = 容器自身路径）；首次取页时才建档 */
  private readonly containers = new Map<Path, Container>();
  /** 展开集合（根恒在；根不可折叠） */
  private expandedValue = new Set<Path>();

  /** 扁平化行缓存（脏标记重建，避免每次 view() 重走树） */
  private rowsCache: OutlineRow[] = [];
  private dirty = true;

  private readonly listeners = new Set<(view: OutlineView) => void>();

  constructor(source: OutlineSource, opts: OutlineStateOptions = {}) {
    this.source = source;
    this.page = opts.page && opts.page > 0 ? Math.floor(opts.page) : OUTLINE_PAGE;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * 换文档：重置全部状态（展开现场 / 选中 / 页缓存）并加载根页。
   * 成功后 resolve（不 reject）；失败降级为 phase='error'，由视图显示「大纲加载失败」。
   */
  async open(rootId: RootId): Promise<void> {
    this.epochValue += 1;
    this.rootIdValue = rootId;
    this.containers.clear();
    this.expandedValue = new Set<Path>([ROOT_PATH]);
    this.selectedValue = null;
    this.dirty = true;
    this.emit();
    await this.loadPage(ROOT_PATH, 0);
  }

  /**
   * 编辑（docRevision 变化）后刷新：回到根展开、丢弃全部子页；选中路径保留
   * （树里仍选中同一节点，大纲行加载回来后继续高亮）。无文档时是空操作。
   */
  async refresh(): Promise<void> {
    if (this.rootIdValue === null) return;
    this.epochValue += 1;
    this.containers.clear();
    this.expandedValue = new Set<Path>([ROOT_PATH]);
    this.dirty = true;
    this.emit();
    await this.loadPage(ROOT_PATH, 0);
  }

  /** 关闭大纲（文档被替换 / 无文档）：清空状态，在途回包由 epoch 丢弃。 */
  close(): void {
    this.epochValue += 1;
    this.rootIdValue = null;
    this.containers.clear();
    this.expandedValue.clear();
    this.selectedValue = null;
    this.dirty = true;
    this.emit();
  }

  // ---------------------------------------------------------------- commands

  /**
   * 展开 / 折叠一个容器（只改大纲自己的展开态，不影响树——ADR-0013 §4）。
   * 返回是否生效：根折叠 / 标量 / 空容器 / 未知路径 → false。
   */
  async setOpen(path: Path, open: boolean): Promise<boolean> {
    if (this.rootIdValue === null) return false;
    // 根永远展开、不可折叠（与树一致）
    if (path === ROOT_PATH) return open;

    const info = this.childInfo(path);
    const container = this.containers.get(path);
    if (!info && !container) return false;
    const count = info ? info.count : (container?.total ?? 0);
    if (open && count <= 0) return false;

    if (open) {
      // 已展开过的容器若页请求失败过（loaded=false），再展开时重试，避免进入
      // 「caret 显示展开但无子行/无哨兵」的不可恢复死态（code review 收口）。
      if (this.expandedValue.has(path)) {
        if (!this.containers.get(path)?.loaded) await this.loadPage(path, 0);
        return this.isContainerLoaded(path);
      }
      this.expandedValue.add(path);
      this.dirty = true;
      this.emit();
      if (!this.containers.get(path)?.loaded) await this.loadPage(path, 0);
      return this.isContainerLoaded(path);
    }

    if (!this.expandedValue.has(path)) return true;
    this.expandedValue.delete(path);
    for (const key of [...this.expandedValue]) {
      if (isDescendant(key, path)) this.expandedValue.delete(key);
    }
    // 丢弃子树的页缓存（自身页缓存保留：重展开不重取，避免无谓往返）
    for (const key of [...this.containers.keys()]) {
      if (isDescendant(key, path)) this.containers.delete(key);
    }
    this.dirty = true;
    this.emit();
    return true;
  }

  /** 切换展开态；根 / 标量 / 空容器 / 未知路径返回 false。 */
  async toggle(path: Path): Promise<boolean> {
    if (path === ROOT_PATH) return false;
    if (this.isExpanded(path)) return this.setOpen(path, false);
    return this.setOpen(path, true);
  }

  /**
   * 「加载更多」：按页追加该容器的下一段子项。
   * 无 in-flight（单飞）、已到末页、容器未知 / 未加载 → false 且不发请求。
   */
  async loadMore(path: Path): Promise<boolean> {
    if (this.rootIdValue === null) return false;
    const container = this.containers.get(path);
    if (!container) return false;
    if (container.loading || !container.loaded) return false;
    if (container.items.length >= container.total) return false;
    await this.loadPage(path, container.items.length);
    // 失败不吞：页面级错误由调用方决定提示/重试（applyError 已记录，单飞已复位）
    return this.isContainerLoaded(path);
  }

  /** 树选中变化 → 大纲当前高亮（唯一来源；行不可见时视图不高亮——ADR-0013 §4）。 */
  setSelected(path: Path | null): void {
    if (this.selectedValue === path) return;
    this.selectedValue = path;
    this.emit();
  }

  // ---------------------------------------------------------------- read-only

  /** 一行只读快照（面板渲染 / dev hook 诊断）。 */
  view(): OutlineView {
    if (this.dirty) {
      this.rowsCache = this.flatten();
      this.dirty = false;
    }
    let loadedContainers = 0;
    let loadedChildren = 0;
    for (const container of this.containers.values()) {
      if (!container.loaded) continue;
      loadedContainers += 1;
      loadedChildren += container.items.length;
    }
    return {
      phase: this.phase(),
      rootId: this.rootIdValue,
      rows: this.rowsCache,
      selected: this.selectedValue,
      error: this.containers.get(ROOT_PATH)?.error ?? null,
      loadedContainers,
      loadedChildren,
    };
  }

  /** 扁平化行数（含哨兵行；dev hook / 冒烟断言用）。 */
  rowCount(): number {
    return this.view().rows.length;
  }

  /** 展开路径列表（根恒在；dev hook 用）。 */
  expandedPaths(): Path[] {
    return [...this.expandedValue];
  }

  isExpanded(path: Path): boolean {
    return this.expandedValue.has(path);
  }

  subscribe(listener: (view: OutlineView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- internal

  /** 容器页是否已成功取回（错误 / 已折叠丢弃 → false）。 */
  private isContainerLoaded(path: Path): boolean {
    const container = this.containers.get(path);
    return container !== undefined && container.loaded && container.error === null;
  }

  private phase(): OutlinePhase {
    if (this.rootIdValue === null) return 'idle';
    const root = this.containers.get(ROOT_PATH);
    if (!root) return 'loading';
    if (root.error) return 'error';
    if (!root.loaded) return 'loading';
    return 'ready';
  }

  /** 在已取回的任意容器页里找该路径的子项信息（判定类型 / 项数 / 可展开性）。 */
  private childInfo(path: Path): OutlineChild | null {
    for (const container of this.containers.values()) {
      for (const item of container.items) {
        if (item.path === path) return item;
      }
    }
    return null;
  }

  /**
   * 请求某容器的一页并写入缓存。每容器单飞：in-flight 时返回同一 promise。
   * 迟到回包 / 旧 epoch 回包由 `applyPage` 丢弃（不通知、不改状态）。
   */
  private loadPage(path: Path, start: number): Promise<void> {
    const rootId = this.rootIdValue;
    if (rootId === null) return Promise.resolve();

    let container = this.containers.get(path);
    if (!container) {
      container = { kind: 'object', total: 0, items: [], loading: false, loaded: false, error: null, pending: null };
      this.containers.set(path, container);
    }
    if (container.loading) return container.pending ?? Promise.resolve();

    const epoch = this.epochValue;
    container.loading = true;
    container.error = null;

    const request = this.source
      .outline({ rootId, path, start, count: this.page })
      .then(
        (reply) => {
          this.applyPage(epoch, path, reply);
        },
        (error: unknown) => {
          this.applyError(epoch, path, error);
        },
      );
    container.pending = request;
    return request;
  }

  /**
   * 采纳一页：epoch / 根 / 路径三重校验；分页按 start 追加或覆盖。
   * 说明：换文档 / 刷新会先清空 `containers` 并换 `rootId`，前两道检查通常已拦下迟到回包；
   * epoch 是第二重保险（防止未来改动去掉容器清理后旧回包串进新状态）。
   */
  private applyPage(epoch: number, path: Path, reply: OutlineReply): void {
    if (epoch !== this.epochValue) return; // 迟到回包：换文档 / 刷新 / 关闭 → 丢弃
    if (this.rootIdValue === null || reply.rootId !== this.rootIdValue) return;
    if (reply.path !== path) return;
    const container = this.containers.get(path);
    if (!container) return; // 容器已被折叠丢弃

    container.loading = false;
    container.pending = null;
    container.error = null;
    container.loaded = true;
    container.kind = reply.kind;
    container.total = Math.max(0, Math.trunc(reply.total));

    const start = Math.max(0, Math.trunc(reply.start));
    const children = Array.isArray(reply.children) ? reply.children : [];
    if (start <= container.items.length) {
      // 正常分页：追加；回包重叠 / 重取时按 start 覆盖尾部（幂等）
      container.items = container.items.slice(0, start).concat(children);
    } else {
      // 分页空洞（理论上不会发生）：丢弃本页，保留哨兵以便「加载更多」重试
      container.loaded = true;
    }
    // 回包可能少于 total（末页）：items 上限按 total 兜底
    if (container.items.length > container.total) container.items.length = container.total;

    this.dirty = true;
    this.emit();
  }

  /** 失败降级：记录错误（根页 → phase='error'），不自动重试，避免失败风暴。 */
  private applyError(epoch: number, path: Path, error: unknown): void {
    if (epoch !== this.epochValue) return;
    const container = this.containers.get(path);
    if (!container) return;
    container.loading = false;
    container.pending = null;
    container.error = errorMessage(error);
    this.dirty = true;
    this.emit();
  }

  /** 扁平化：根行 → 已展开容器的子行（递归）→ 「加载更多」哨兵行。 */
  private flatten(): OutlineRow[] {
    const rows: OutlineRow[] = [];
    const root = this.containers.get(ROOT_PATH);
    if (!root || !root.loaded) return rows; // 根页未就绪：空态（加载中 / 错误）由 phase 表达

    rows.push({
      path: ROOT_PATH,
      depth: 0,
      key: ROOT_PATH,
      idx: false,
      kind: root.kind,
      count: root.total,
      open: true,
      expandable: root.total > 0,
      more: false,
    });
    this.walkChildren(ROOT_PATH, root, 1, rows);
    return rows;
  }

  private walkChildren(containerPath: Path, container: Container, depth: number, rows: OutlineRow[]): void {
    for (const item of container.items) {
      const childContainer = this.containers.get(item.path);
      const open = item.count > 0 && this.expandedValue.has(item.path);
      rows.push({
        path: item.path,
        depth,
        key: item.key,
        idx: item.idx,
        kind: item.kind,
        count: item.count,
        open,
        expandable: item.count > 0,
        more: false,
      });
      // 展开但页尚未回包 / 已丢弃 → 先不铺子行（回包后 emit 重建）
      if (open && childContainer && childContainer.loaded) {
        this.walkChildren(item.path, childContainer, depth + 1, rows);
      }
    }

    // 分页哨兵：仅当已取过页、非加载中、且还有未加载项
    if (!container.loading && container.items.length < container.total) {
      const remaining = container.total - container.items.length;
      rows.push({
        path: containerPath,
        depth,
        key: `加载更多（还有 ${remaining} 项）`,
        idx: false,
        kind: null,
        count: 0,
        open: false,
        expandable: false,
        more: true,
      });
    }
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const view = this.view();
    for (const listener of [...this.listeners]) listener(view);
  }
}
