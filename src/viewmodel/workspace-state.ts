/**
 * viewmodel/workspace-state — 多文档工作区状态机（#18 / ADR-0009 §3）。
 *
 * 纯 TS、零 DOM：只持有「标签列表 + 活动标签 + 每标签文档字段」，以及每个标签自己的一份
 * runtime adapter（行窗口 / 搜索 / 编辑 / 原文窗口）。runtime 由 app 通过工厂注入
 * （`createRuntime`），本模块**不认识 CoreApi**——单测注入假对象即可脱 DOM 覆盖状态机。
 *
 * 分层：本文件只 import `protocol/*`（含 `MAX_DOC_TABS` 常量值）与同层 `viewmodel/*` 的 **type**，
 * 不 import `src/app/`（依赖方向 app → view → viewmodel → protocol，见 docs/architecture/seams.md §1）。
 *
 * 关键语义（ADR-0009 §3–§4）：
 *   - 每标签独立：rootId / 文档版本字段 / selected / runtime（seq、滚动、命中集、编辑历史）。
 *   - 工作区级全局状态（主题、面板开合、设置）不在本模块，由 app / settings 侧持有。
 *   - 标签 id 由页面分配、**单调不复用**（与 Worker 分配的 doc 根 rootId 是两套坐标）。
 *   - 软上限（默认 MAX_DOC_TABS = 8）：满了 `add` 返回 null，**不淘汰、不抛**。
 *   - 切标签只换活动标签与订阅目标，不关根、不重解析。
 *   - 空工作区（关闭最后一个标签）= activeId null，标签条隐藏。
 */
import type { DocumentMeta, RootId } from '../protocol/types';
import { MAX_DOC_TABS } from '../protocol/versions';
import type { RowWindowSource } from './row-window-source';
import type { RawWindowSource } from './raw-window-source';
import type { SearchState } from './search-state';
import type { EditState } from './edit-state';

/** 每个标签私有的四份 runtime adapter；切标签时整组替换（ADR-0009 §3）。 */
export interface TabRuntime {
  rowSource: RowWindowSource; // 每标签独立 seq / 滚动 / 窗口
  searchState: SearchState; // 每标签命中集 / 当前 / 过期
  editState: EditState; // 每标签「已修改 N 处」/ undo 可用性
  rawSource: RawWindowSource; // 每标签原文窗口
}

/** 新建 / 替换标签时由 app 提供的文档快照（恰好一次 load 回包的落地值）。 */
export interface TabInput {
  rootId: RootId;
  name: string;
  bytes: number;
  meta: DocumentMeta;
  docRevision: number;
  rowVersion: number;
  totalRows: number;
}

export interface TabState extends TabInput {
  /** 页面侧标签 id：'tab:1'、'tab:2'…（单调不复用） */
  id: string;
  runtime: TabRuntime;
  /** 选中节点 path（每标签独立，ADR-0009 §3） */
  selected: string | null;
}

export interface TabView {
  id: string;
  /** 显示名（默认 = 导入文件名；改过名后与 originalName 不同，2026-11-12 / ADR-0021） */
  name: string;
  /** 导入时的原文件名（只读，用于悬停「原名：…」追溯） */
  originalName: string;
  active: boolean;
}

export interface WorkspaceView {
  /** tabs.length < 2 → 标签条隐藏（单文档完全保持 C 形态） */
  hidden: boolean;
  tabs: TabView[];
  activeId: string | null;
  /** 活动标签存在且未满上限（驱动『＋』启用态） */
  canAdd: boolean;
  max: number;
}

export interface WorkspaceOptions {
  /** 缺省 MAX_DOC_TABS（从 ../protocol/versions 取，值 8） */
  max?: number;
  /** 为每个新标签创建一份 runtime（app 注入真实 adapter；单测注入假对象） */
  createRuntime(): TabRuntime;
}

/**
 * 工作区状态机。所有变更方法在**有效变更**后同步通知订阅者（`update` 即使没有字段变化也通知：
 * 订阅方 render 幂等，实现更简单）；对未知 id 的调用是 no-op，不通知。
 */
export class WorkspaceState {
  private readonly maxValue: number;
  private readonly makeRuntime: () => TabRuntime;
  /** 顺序 = 添加顺序（标签条渲染顺序） */
  private readonly tabs: TabState[] = [];
  private activeIdValue: string | null = null;
  /** 标签 id 序号：只增不减，remove 后不复用 */
  private nextSeq = 0;
  private readonly listeners = new Set<(view: WorkspaceView) => void>();

  constructor(opts: WorkspaceOptions) {
    const rawMax = opts.max ?? MAX_DOC_TABS;
    this.maxValue = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : MAX_DOC_TABS;
    // 包一层箭头：即使调用方传的是方法引用，也不会把 WorkspaceState 当 this 传进去。
    this.makeRuntime = () => opts.createRuntime();
  }

  get size(): number {
    return this.tabs.length;
  }

  get max(): number {
    return this.maxValue;
  }

  get activeId(): string | null {
    return this.activeIdValue;
  }

  /** 标签 id 列表（添加顺序）；返回副本，外部改不到内部。 */
  get ids(): string[] {
    return this.tabs.map((tab) => tab.id);
  }

  /** 活动标签；空工作区返回 null。 */
  active(): TabState | null {
    return this.find(this.activeIdValue) ?? null;
  }

  /** 按页面侧标签 id 查找；不存在返回 undefined。 */
  get(id: string): TabState | undefined {
    return this.find(id);
  }

  /** 追加并激活；满上限返回 null（不淘汰、不抛、不创建 runtime）。 */
  add(input: TabInput): TabState | null {
    if (this.tabs.length >= this.maxValue) return null;
    this.nextSeq += 1;
    const tab: TabState = {
      id: `tab:${this.nextSeq}`,
      rootId: input.rootId,
      name: input.name,
      bytes: input.bytes,
      meta: input.meta,
      docRevision: input.docRevision,
      rowVersion: input.rowVersion,
      totalRows: input.totalRows,
      runtime: this.makeRuntime(),
      selected: null,
    };
    this.tabs.push(tab);
    this.activeIdValue = tab.id;
    this.emit();
    return tab;
  }

  /** 激活已存在的标签；未知 id 返回 false（不通知）。重复激活同一标签也通知（render 幂等）。 */
  activate(id: string): boolean {
    if (!this.find(id)) return false;
    this.activeIdValue = id;
    this.emit();
    return true;
  }

  /**
   * 拖拽排序：把标签 `id` 移到 `toIndex`（最终位置，越界夹取到 [0, size-1]）。
   * 顺序真的变了才通知并返回 true；未知 id / 位置未变 → false 且不通知。
   * 活动标签不变（移动只改顺序，不切会话）。
   */
  move(id: string, toIndex: number): boolean {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) return false;
    const target = Number.isFinite(toIndex)
      ? Math.max(0, Math.min(this.tabs.length - 1, Math.floor(toIndex)))
      : from;
    if (target === from) return false;
    const [tab] = this.tabs.splice(from, 1);
    if (tab === undefined) return false;
    this.tabs.splice(target, 0, tab);
    this.emit();
    return true;
  }

  /**
   * 用新文档替换该标签的根（替换导入）：保留 id / runtime / 在列表中的位置，更新文档字段，
   * selected 清 null（旧根的节点 path 对新根无意义）。未激活标签上调用不影响 activeId。
   */
  replace(id: string, input: TabInput): TabState | null {
    const tab = this.find(id);
    if (!tab) return null;
    tab.rootId = input.rootId;
    tab.name = input.name;
    tab.bytes = input.bytes;
    tab.meta = input.meta;
    tab.docRevision = input.docRevision;
    tab.rowVersion = input.rowVersion;
    tab.totalRows = input.totalRows;
    tab.selected = null;
    this.emit();
    return tab;
  }

  /**
   * 移除标签。若移除的是活动标签 → 右邻优先、否则左邻、再否则 null（回空态）；
   * 返回被移除的标签（供 app 发 closeRoot）与移除后的 activeId；未知 id 返回 null。
   */
  remove(id: string): { removed: TabState; activeId: string | null } | null {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return null;
    const [removed] = this.tabs.splice(index, 1);
    if (removed === undefined) return null;
    if (this.activeIdValue === id) {
      // splice 后 index 位置即原右邻；没有右邻则取左邻；都没有（空）→ null
      const neighbor = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeIdValue = neighbor === null ? null : neighbor.id;
    }
    this.emit();
    return { removed, activeId: this.activeIdValue };
  }

  /**
   * 回包落地后同步字段（只允许 TabPatch 里的键，其余键会被忽略）。
   * 未知 id no-op；字段无变化也通知（见类注释）。
   */
  update(
    id: string,
    patch: Partial<
      Pick<TabInput, 'docRevision' | 'rowVersion' | 'totalRows' | 'meta' | 'name' | 'bytes'> & {
        selected: string | null;
      }
    >,
  ): void {
    const tab = this.find(id);
    // rootId 不在 TabPatch 里：换根只允许走 replace()（要连带清 selected），update 只做字段同步。
    if (!tab) return;
    if (patch.docRevision !== undefined) tab.docRevision = patch.docRevision;
    if (patch.rowVersion !== undefined) tab.rowVersion = patch.rowVersion;
    if (patch.totalRows !== undefined) tab.totalRows = patch.totalRows;
    if (patch.meta !== undefined) tab.meta = patch.meta;
    if (patch.name !== undefined) tab.name = patch.name;
    if (patch.bytes !== undefined) tab.bytes = patch.bytes;
    if (patch.selected !== undefined) tab.selected = patch.selected;
    this.emit();
  }

  /** 只读快照：每次调用都是新对象 / 新数组，外部改不到内部状态。 */
  view(): WorkspaceView {
    return {
      hidden: this.tabs.length < 2,
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        originalName: tab.meta.name,
        active: tab.id === this.activeIdValue,
      })),
      activeId: this.activeIdValue,
      canAdd: this.activeIdValue !== null && this.tabs.length < this.maxValue,
      max: this.maxValue,
    };
  }

  /** 订阅工作区视图变化（同一 listener 重复订阅按一次处理）；返回退订函数（可重复调用）。 */
  subscribe(listener: (view: WorkspaceView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- internal

  private find(id: string | null): TabState | undefined {
    if (id === null) return undefined;
    return this.tabs.find((tab) => tab.id === id);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const view = this.view();
    for (const listener of [...this.listeners]) listener(view);
  }
}
