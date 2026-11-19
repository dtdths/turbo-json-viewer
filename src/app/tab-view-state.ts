/**
 * app/tab-view-state — 「活动标签镜像 ↔ 每标签存档」的唯一搬运点
 * （候选 2 / ADR-0008 修订 2026-11-19）。
 *
 * 背景：`main.ts` 的模块级 `let` 是活动标签的**实时镜像**（读点直接读，零包装）；
 * 存档在 `WorkspaceState.TabState.view`。此前三张手写清单（`saveActiveSession` /
 * `bindTab` / `resetTabStateForNewDoc`）各自抄一遍字段名，加一个 per-tab 字段要改 6–7 处。
 *
 * 本模块：字段名只出现在一张 `VIEW_FIELD_KEYS` / `TabViewAccessors` 表里，
 * `capture` / `restore` / `reset` / `syncVersions` 循环这张表。
 * 加字段 = 类型 1 行（`TabViewData`）+ 表 1 行（`VIEW_FIELD_KEYS`）+ 镜像 `let` 1 行，
 * 全在两个文件的相邻块。
 *
 * 归属纪律（Q4）：**活状态问 `DocSession`，存档问本模块**。所以本模块不碰 `session.*`，
 * 只通过 `live()` 取一次「版本 + 选中」快照写进标签，`syncVersions` 也只改存档侧。
 *
 * 纯 TS、零 DOM：滚动位置由调用方以闭包注入（`treeScrollTopPx` / `rawScrollTopPx`），
 * 单测注入假闭包即可脱 DOM。
 */
import type { RootVersion } from '../protocol/messages';
import {
  defaultTabViewData,
  type TabViewData,
} from '../viewmodel/tab-view-data';
import type { TabState, WorkspaceState } from '../viewmodel/workspace-state';

/**
 * 有模块级镜像的字段（`capture` / `restore` 循环的就是这 10 个）。
 * 滚动位置刻意不在表内：它们没有镜像，`restoreActiveTabView` 直接从存档读（见 `active()`）。
 * `UnclassifiedViewField` 是编译期守卫——`TabViewData` 新增字段忘了归类会在这里报错。
 */
export const VIEW_FIELD_KEYS = [
  'rawMetaInfo',
  'fidelity',
  'exprView',
  'searchOpts',
  'anchor',
  'exprLastText',
  'exprErrorState',
  'exprStatusState',
  'searchPatternCore',
  'fidelityIndex',
] as const;

/** 有镜像的视图字段名。 */
export type MirroredViewField = (typeof VIEW_FIELD_KEYS)[number];

/** 无镜像、只从存档直读的字段名（只有两个滚动位置）。 */
type DirectReadViewField = 'scrollTopPx' | 'rawScrollTopPx';

/**
 * 编译期守卫：必须为空。给 `TabViewData` 加字段时，进 `VIEW_FIELD_KEYS`（有镜像）
 * 或加进 `DirectReadViewField`（无镜像），否则这个类型变成那个字段名、下面的 `[]` 赋不过去。
 */
export type UnclassifiedViewField = Exclude<keyof TabViewData, MirroredViewField | DirectReadViewField>;
export const UNCLASSIFIED_VIEW_FIELDS: readonly UnclassifiedViewField[] = [];

/** 镜像字段的读 / 写访问器（`main.ts` 注入；闭包里就是那 5 个模块级 `let`）。 */
export type TabViewAccessors = {
  readonly [K in MirroredViewField]: {
    get(): TabViewData[K];
    set(value: TabViewData[K]): void;
  };
};

/** 活动标签的实时版本与选中（`capture` 时取一次快照写进 `TabState`）。 */
export interface TabViewLive {
  docRevision: number;
  rowVersion: number;
  totalRows: number;
  selected: string | null;
}

export interface TabViewDeps {
  workspace: WorkspaceState;
  fields: TabViewAccessors;
  /** 实时会话版本 + 选中（读 `session.*` / `selected`） */
  live(): TabViewLive;
  /** 树 / 原文视图的当前滚动位置（读 DOM，所以必须注入） */
  treeScrollTopPx(): number;
  rawScrollTopPx(): number;
  /**
   * `restore` 之后的 app 侧瞬时复位：表达式结果视图不跨标签自动激活
   * （`exprViewActive = false` / `docSessionBeforeExpr = null`，与历史 `bindTab` 同口径）。
   */
  resetTransient(): void;
}

/** 镜像 → 存档（泛型单字段搬运：K 收窄后 `view[key]` 与 `fields[key].get()` 同型）。 */
function pullInto<K extends MirroredViewField>(deps: TabViewDeps, key: K, view: TabViewData): void {
  view[key] = deps.fields[key].get();
}

/** 存档 → 镜像。 */
function pushFrom<K extends MirroredViewField>(deps: TabViewDeps, key: K, view: TabViewData): void {
  deps.fields[key].set(view[key]);
}

export class TabViewState {
  private readonly deps: TabViewDeps;

  constructor(deps: TabViewDeps) {
    this.deps = deps;
  }

  /**
   * 活动标签的视图存档（空工作区 → null）。
   * 只用于**没有镜像**的字段（两个滚动位置）；其余字段以模块级镜像为准，
   * 它们的存档值在 `capture()` 之前是上一次切走时的快照。
   */
  active(): TabViewData | null {
    return this.deps.workspace.active()?.view ?? null;
  }

  /** 切走前存档：镜像 → 活动标签（版本 / 选中走 `workspace.update`，其余写 `view`）。 */
  capture(): void {
    const tab = this.deps.workspace.active();
    if (!tab) return;
    for (const key of VIEW_FIELD_KEYS) pullInto(this.deps, key, tab.view);
    tab.view.scrollTopPx = this.deps.treeScrollTopPx();
    tab.view.rawScrollTopPx = this.deps.rawScrollTopPx();
    this.deps.workspace.update(tab.id, { ...this.deps.live() });
  }

  /** 切回后恢复：存档 → 镜像（滚动位置的**应用**由 `restoreActiveTabView` 负责）。 */
  restore(tab: TabState): void {
    for (const key of VIEW_FIELD_KEYS) pushFrom(this.deps, key, tab.view);
    this.deps.resetTransient();
  }

  /** 换文档（复用标签与 runtime）：存档就地复位成默认值，保持 `view` 引用稳定。 */
  reset(tab: TabState): void {
    Object.assign(tab.view, defaultTabViewData());
  }

  /**
   * 回空态（关掉最后一个标签）：没有标签可存档，存档随标签一起没了，但**镜像还在**——
   * 全部复位成默认值，否则空态仍能读到上一个文档的对照锚点 / 表达式反馈 / 搜索解析错误。
   */
  clear(): void {
    const blank = defaultTabViewData();
    for (const key of VIEW_FIELD_KEYS) pushFrom(this.deps, key, blank);
    this.deps.resetTransient();
  }

  /**
   * 子键排序回包（#40 / ADR-0024 §6）的**存档侧**扇出：同一根的新版本要落到
   * 标签字段与非活动标签的表达式结果视图。活动会话（`DocSession`）与活动 `exprView`
   * 由 `app` 侧自己同步——那是「活状态」，不归本模块。
   */
  syncVersions(roots: readonly RootVersion[]): void {
    for (const entry of roots) {
      for (const id of this.deps.workspace.ids) {
        const tab = this.deps.workspace.get(id);
        if (tab === undefined) continue;
        const archived = tab.view.exprView;
        if (archived?.rootId === entry.rootId) {
          archived.rowVersion = entry.rowVersion;
          archived.totalRows = entry.totalRows;
        }
        if (tab.rootId === entry.rootId) {
          this.deps.workspace.update(id, { rowVersion: entry.rowVersion, totalRows: entry.totalRows });
        }
      }
    }
  }
}
