/**
 * app/dev-hook — 测试钩子（`window.__tjv`）工厂（ADR-0008 修订 2026-11-09）。
 *
 * 只在 HTTP 冒烟页面安装（扩展里不安装）。职责只有两件事：
 *   1. **转发**：调 app 的真实入口（导入 / 搜索 / 编辑 / 导出 / 原文…），不重写链路。
 *   2. **组装快照**：把各 module 自报的状态拼成冒烟断言需要的形状。
 * 模块真值（树当前命中、原文可见行、搜索面板计数、大纲开合）一律问 module，不从全局 DOM 反推；
 * 保留的 DOM 读取只有**视觉/布局断言**（computed style、CSS 变量、元素文本）——那是浏览器
 * harness 的分工（ADR-0008 §6）。
 *
 * 兼容性：成员名 / 参数 / 返回形状与历史 `window.__tjv` 逐字一致（13 套冒烟零改动）。
 */
import { CoreError } from '../protocol/errors';
import type { CoreApi } from '../protocol/core-api';
import type {
  CopyFormat,
  DocumentMeta,
  FidelityReport,
  JsonKind,
  RawLocateReply,
  RawMeta,
  RawWindow,
  Row,
} from '../protocol/types';
import type { SearchFilter, SearchState } from '../viewmodel/search-state';
import type { OutlineState } from '../viewmodel/outline-state';
import type { EditState } from '../viewmodel/edit-state';
import type { SettingsState, SettingsKey } from '../viewmodel/settings-state';
import type { DocSession } from './doc-session';
import type { RowWindowSource } from '../viewmodel/row-window-source';
import type { RawWindowSource } from '../viewmodel/raw-window-source';
import type { TreeView } from '../view/tree/tree-view';
import type { RawView } from '../view/raw/raw-view';
import type { SearchPanel } from '../view/panels/search-panel';
import type { OutlinePanel } from '../view/panels/outline-panel';
import type { SubtreeEditor } from '../view/panels/subtree-editor';
import type { NoticeBar } from '../view/panels/notice-bar';
import type { ExportMode } from '../viewmodel/export-state';

/** 面板 id（与 `UiState.panel` 同域）。 */
export type PanelId = 'none' | 'doc' | 'search' | 'outline' | 'settings';

/** 最近一次导出动作（dev hook / 验收用；不保留文本）。 */
export interface ExportLastAction {
  mode: ExportMode;
  name?: string;
  bytes?: number;
  copied?: boolean;
}

export interface CtxOpenState {
  hidden: boolean;
  items: { act: string; label: string; disabled: boolean; title: string }[];
}

export interface CtxClickState {
  clicked: boolean;
  toast: string;
  hidden: boolean;
}

export interface SettingsOpenState {
  panel: string | null;
  title: string;
  focused: boolean;
  rows: string[];
}

export interface TreeGeometryState {
  rowHeight: number;
  viewportRows: number;
  totalRows: number;
  rowHeightCss: string;
  rowHeightComputed: string;
  indentCss: string;
  typeColumnVisible: boolean;
  spacerHeight: string | null;
}

export interface StateSnapshot {
  rootId: string | null;
  totalRows: number;
  rowVersion: number;
  docRevision: number;
  selected: string | null;
  rendered: number;
  start: number;
  scrollTop: number;
  editCount: number;
  canUndo: boolean;
  canRedo: boolean;
  viewMode: 'tree' | 'raw';
}

/** 搜索诊断快照（契约见 docs/design/slice4-search-contract.md §5）。 */
export interface SearchDiagnostics {
  phase: string;
  query: string;
  total: number;
  size: number;
  current: number;
  counts: Record<string, number>;
  filter: string;
  truncated: boolean;
  stale: boolean;
  caseSensitive: boolean;
  regex: boolean;
  patternError: string | null;
  rendered: number;
  treeCurrentVisible: boolean;
  scrollTop: number;
  scrollHeight: number;
  listScrollTop: number;
  listScrollHeight: number;
  countText: string;
  posText: string;
  footText: string;
  path: string | null;
}

export interface OutlineHookState {
  phase: string;
  rows: number;
  current: string | null;
  expanded: string[];
  loadedContainers: number;
  loadedChildren: number;
  panel: { open: boolean; rendered: number; scrollTop: number };
}

/** 原文视图快照（契约见 ADR-0003 修订 §7）。 */
export interface RawHookState {
  mode: 'tree' | 'raw';
  view: string | null;
  buttons: {
    tree: { active: boolean; pressed: string | null; disabled: boolean };
    raw: { active: boolean; pressed: string | null; disabled: boolean };
  };
  raw: RawMeta | null;
  totalLines: number;
  start: number;
  rendered: number;
  stale: boolean;
  scrollTop: number;
  viewportRows: number;
  notice: string;
  metaLabel: string;
  modeLabel: string;
  copyDisabled: boolean;
  flash: number | null;
  statusRows: string;
  lines: Array<{ line: number; text: string }>;
}

export interface RepairHookState {
  status: string;
  visible: boolean;
  text: string;
  expanded: boolean;
  ops: string[];
  opsDetail: unknown[];
  summary: string | null;
  counts: unknown;
  truncatedAt: number | null;
  exportName: string | null;
  statusState: string;
}

export interface FidelityHookState {
  pending: boolean;
  status: string | null;
  counts: unknown;
  hits: unknown[];
  scanMs: number | null;
  truncated: boolean | null;
  barVisible: boolean;
  barText: string;
  jumpVisible: boolean;
  viewMode: 'tree' | 'raw';
  statusRows: string;
}

export interface ExportHookState {
  mode: ExportMode;
  menuOpen: boolean;
  menuItems: { mode: string; label: string; checked: boolean; focused: boolean }[];
  mainLabel: string;
  mainText: string;
  disabled: { main: boolean; caret: boolean };
  lastAction: ExportLastAction | null;
  clipboardMaxBytes: number;
}

/** 钩子成员类型（= 冒烟脚本消费的契约；也是 `createDevHook` 的返回类型）。 */
export interface DevHook {
  loadText(text: string, name?: string): Promise<void>;
  scrollToPx(px: number): void;
  togglePath(path: string, open: boolean): Promise<void>;
  expandAll(): Promise<void>;
  collapseAll(): Promise<void>;
  state(): StateSnapshot;

  search(term: string): Promise<{ ms: number; ok: boolean } & SearchDiagnostics>;
  searchNext(): Promise<{ ms: number; index: number } & SearchDiagnostics>;
  searchPrev(): Promise<{ ms: number; index: number } & SearchDiagnostics>;
  searchJump(index: number): Promise<{ ms: number; index: number } & SearchDiagnostics>;
  searchMarkStale(): { changed: boolean } & SearchDiagnostics;
  setSearchFilter(filter: SearchFilter): SearchDiagnostics;
  searchPanel(): SearchDiagnostics;
  searchListScrollTo(px: number): SearchDiagnostics;

  outlineState(): OutlineHookState;
  outlineOpen(): void;
  outlineToggle(path: string, open?: boolean): Promise<{ ok: boolean; rows: number; open: boolean }>;
  outlineLoadMore(path: string): Promise<{ ok: boolean; rows: number }>;
  outlineJump(path: string): Promise<{ ok: boolean; row: number }>;

  editOpen(path: string): Promise<{ open: boolean; path: string | null; text: string | null }>;
  editText(): string | null;
  editSetText(text: string): string;
  editClickApply(): { open: boolean };
  editApplyText(text: string): Promise<StateSnapshot & { open: boolean }>;
  editClose(): boolean;
  undo(): Promise<{ ok: boolean } & StateSnapshot>;
  redo(): Promise<{ ok: boolean } & StateSnapshot>;
  resetEdits(): Promise<{ ok: boolean } & StateSnapshot>;
  exportDocText(): Promise<{ bytes: number; text: string; name: string | null } | null>;
  editBadgeText(): { hidden: boolean; text: string | null };

  ctxOpen(path: string, fallbackKind?: JsonKind): CtxOpenState;
  ctxClick(act: string): Promise<CtxClickState>;
  copyResolve(
    path: string,
    format: CopyFormat,
  ): Promise<
    | { text: string; bytes: number; format: CopyFormat }
    | { error: { code: string; message: string; bytes?: number } }
  >;
  clipboardText(): Promise<string | null>;
  toastText(): string;

  exportState(): ExportHookState;
  exportMenuOpen(): ExportHookState;
  exportClick(): boolean;
  exportChoose(mode: ExportMode): boolean;

  settingsState(): Record<string, unknown>;
  setSetting(key: SettingsKey, value: unknown): { changed: boolean } & Record<string, unknown>;
  settingsOpen(): SettingsOpenState;
  treeGeometry(): TreeGeometryState;

  repairState(): RepairHookState;
  repairToggle(): boolean;
  repairClose(): boolean;

  fidelityState(): FidelityHookState;
  fidelityJump(): Promise<{ ms: number } & RawHookState & { fidelity: { barVisible: boolean } }>;
  fidelityClose(): boolean;

  rawState(): RawHookState;
  setViewMode(mode: 'tree' | 'raw'): Promise<{ ms: number } & RawHookState>;
  rawScrollTo(px: number): RawHookState;
  rawWindowText(start: number, count: number): Promise<(RawWindow & { ms: number }) | null>;
  rawLocate(offset: number): Promise<RawLocateReply | null>;
  rawRevealAt(offset: number): Promise<{ ms: number; line: number } & RawHookState>;
  rawRepairAt(index: number): { clicked: boolean; count: number };
  rawCopyText(
    maxBytes?: number,
  ): Promise<
    | { bytes: number; chars: number; text: string }
    | { error: { code: string; message: string; bytes?: number } }
    | null
  >;
  rawCopy(): Promise<{ toast: string } & RawHookState>;

  /** 允许按名探测（冒烟脚本 `Object.keys` / `typeof hook[k]`）。 */
  [key: string]: unknown;
}

/** 组装钩子所需的 app 装配面：模块句柄 + 真实入口 + 静态 UI 元素。 */
export interface DevHookDeps {
  session: DocSession;
  core: CoreApi;

  /* ---- app 可变状态（getter/setter；避免第二真相源） ---- */
  meta(): DocumentMeta | null;
  selected(): string | null;
  editingPath(): string | null;
  setEditingPath(path: string | null): void;
  isRawView(): boolean;
  /** `document.body.dataset.view`（视觉/接线探针）。 */
  viewModeAttr(): string | null;
  rawMetaInfo(): RawMeta | null;
  fidelityReport(): FidelityReport | null;
  fidelityPending(): boolean;
  exportLastAction(): ExportLastAction | null;
  /** 导出文件名（含 -edited / -truncated-repaired 后缀）。 */
  exportFileName(): string | null;

  /* ---- 模块句柄（状态由模块自报） ---- */
  tree: TreeView;
  rowSource: RowWindowSource;
  rawView: RawView;
  rawSource: RawWindowSource;
  searchState: SearchState;
  searchPanel: SearchPanel;
  outlineState: OutlineState;
  outlinePanel: OutlinePanel;
  editState: EditState;
  subtreeEditor: SubtreeEditor;
  settings: SettingsState;

  /* ---- app 入口（真实链路，hook 只转发） ---- */
  entries: {
    importText(text: string, name: string): Promise<void>;
    toggleNode(path: string, open: boolean): Promise<void>;
    expandAll(open: boolean): Promise<void>;
    runSearch(term: string): Promise<boolean>;
    searchNext(): Promise<number>;
    searchPrev(): Promise<number>;
    gotoHit(index: number): Promise<number>;
    applyFilter(filter: SearchFilter): void;
    /** 文档已修改：清空命中 + stale 提示；返回状态是否真的变了。 */
    markSearchStale(): boolean;
    setPanel(panel: PanelId): void;
    jumpToPath(path: string): Promise<{ ok: boolean; row: number }>;
    openEditor(path: string): Promise<void>;
    applyEditText(text: string): Promise<void>;
    undo(): Promise<boolean>;
    redo(): Promise<boolean>;
    resetEdits(): Promise<boolean>;
    setViewMode(mode: 'tree' | 'raw'): Promise<void>;
    revealRepairOffset(offset: number): Promise<number>;
    openSettings(): SettingsOpenState;
    treeGeometry(): TreeGeometryState;
    contextMenu: {
      menu: HTMLElement;
      items(): HTMLButtonElement[];
      show(path: string, x: number, y: number, row: Row): void;
      rowElement(path: string): HTMLElement | null;
    };
    clipboardText(): Promise<string | null>;
  };

  /* ---- 静态 UI 元素与面板动作（浏览器断言；不反推模块真值） ---- */
  ui: {
    statusRows: HTMLElement;
    editBadge: HTMLElement;
    toast: HTMLElement;
    viewTreeBtn: HTMLButtonElement;
    viewRawBtn: HTMLButtonElement;
    rawNotice: HTMLElement;
    rawMetaLabel: HTMLElement;
    rawModeLabel: HTMLElement;
    rawCopyBtn: HTMLButtonElement;
    repairBar: HTMLElement;
    repairText: HTMLElement;
    repairOps: HTMLElement;
    repairToggle: HTMLButtonElement;
    repairClose: HTMLButtonElement;
    repairStatusState: HTMLElement;
    fidelityBar: HTMLElement;
    fidelityNotice: NoticeBar;
    fidelityJump: HTMLButtonElement;
    fidelityClose: HTMLButtonElement;
    exportBtn: HTMLButtonElement;
    exportMenu: HTMLElement;
    exportMenuBtn: HTMLButtonElement;
    exportMenuItems(): HTMLButtonElement[];
    currentExportMode(): ExportMode;
    chooseExport(mode: ExportMode): boolean;
    openExportMenu(): void;
    clickExportMain(): void;
    clipboardMaxBytes(): number;
  };
}

const ms = (since: number): number => Math.round((performance.now() - since) * 100) / 100;

/** 纯工厂：不碰全局状态（单测可直接调用）。 */
export function createDevHook(deps: DevHookDeps): DevHook {
  const { session, core, tree, rowSource, rawView, rawSource, ui } = deps;

  const searchDiagnostics = (): SearchDiagnostics => {
    const view = deps.searchState.view();
    const panel = deps.searchPanel.state();
    return {
      phase: view.phase,
      query: deps.searchState.query,
      total: view.total,
      size: view.size,
      current: view.current,
      counts: { ...view.counts },
      filter: view.filter,
      truncated: view.truncated,
      stale: deps.searchState.stale,
      // ADR-0014：Aa / 正则 / 内联错误（smoke 验收用）
      caseSensitive: view.caseSensitive,
      regex: view.regex,
      patternError: view.patternError,
      rendered: deps.searchPanel.renderedCount(),
      treeCurrentVisible: tree.currentRowRendered(),
      scrollTop: panel.listScrollTop,
      scrollHeight: panel.listScrollHeight,
      // 兼容别名（内部诊断用）
      listScrollTop: panel.listScrollTop,
      listScrollHeight: panel.listScrollHeight,
      countText: panel.countText,
      posText: panel.posText,
      footText: panel.footText,
      path: deps.searchState.currentHit()?.path ?? null,
    };
  };

  const outlineHookState = (): OutlineHookState => {
    const view = deps.outlineState.view();
    return {
      phase: view.phase,
      rows: view.rows.length,
      current: view.selected,
      expanded: deps.outlineState.expandedPaths(),
      loadedContainers: view.loadedContainers,
      loadedChildren: view.loadedChildren,
      panel: {
        open: deps.settings.uiState().panel === 'outline',
        rendered: deps.outlinePanel.renderedCount(),
        scrollTop: deps.outlinePanel.scrollTopPx(),
      },
    };
  };

  const stateOf = (): StateSnapshot => ({
    rootId: session.rootId,
    totalRows: session.totalRows,
    rowVersion: session.rowVersion,
    docRevision: session.docRevision,
    selected: deps.selected(),
    rendered: rowSource.snapshot().rows.length,
    start: rowSource.snapshot().start,
    scrollTop: tree.scrollTopPx(),
    editCount: deps.editState.count,
    canUndo: deps.editState.canUndo,
    canRedo: deps.editState.canRedo,
    viewMode: deps.isRawView() ? 'raw' : 'tree',
  });

  const rawHookState = (): RawHookState => {
    const snapshot = rawSource.snapshot();
    return {
      mode: deps.isRawView() ? 'raw' : 'tree',
      view: deps.viewModeAttr(),
      buttons: {
        tree: {
          active: ui.viewTreeBtn.classList.contains('is-active'),
          pressed: ui.viewTreeBtn.getAttribute('aria-pressed'),
          disabled: ui.viewTreeBtn.disabled,
        },
        raw: {
          active: ui.viewRawBtn.classList.contains('is-active'),
          pressed: ui.viewRawBtn.getAttribute('aria-pressed'),
          disabled: ui.viewRawBtn.disabled,
        },
      },
      raw: deps.rawMetaInfo(),
      totalLines: snapshot.totalLines,
      start: snapshot.start,
      rendered: snapshot.lines.length,
      stale: snapshot.stale,
      scrollTop: rawView.scrollTopPx(),
      viewportRows: rawView.viewportRows(),
      notice: ui.rawNotice.textContent ?? '',
      metaLabel: ui.rawMetaLabel.textContent ?? '',
      modeLabel: ui.rawModeLabel.textContent ?? '',
      copyDisabled: ui.rawCopyBtn.disabled,
      flash: rawView.flashedLine(),
      statusRows: ui.statusRows.textContent ?? '',
      lines: rawView.renderedLines(),
    };
  };

  const exportState = (): ExportHookState => {
    const items = ui.exportMenuItems();
    return {
      mode: ui.currentExportMode(),
      menuOpen: !ui.exportMenu.hidden,
      menuItems: items.map((item) => {
        // 去掉勾选列（✓ 与标签同属按钮 textContent），label 只保留动作文案
        const clone = item.cloneNode(true) as HTMLElement;
        clone.querySelector('.exportmenu__check')?.remove();
        return {
          mode: item.dataset.exportMode ?? '',
          label: (clone.textContent ?? '').trim(),
          checked: item.getAttribute('aria-checked') === 'true',
          focused: document.activeElement === item,
        };
      }),
      mainLabel: ui.exportBtn.getAttribute('aria-label') ?? '',
      mainText: ui.exportBtn.textContent ?? '',
      disabled: { main: ui.exportBtn.disabled, caret: ui.exportMenuBtn.disabled },
      lastAction: deps.exportLastAction(),
      clipboardMaxBytes: ui.clipboardMaxBytes(),
    };
  };

  const repairState = (): RepairHookState => {
    const meta = deps.meta();
    return {
      status: meta?.repair?.status ?? 'none',
      visible: !ui.repairBar.hidden,
      text: ui.repairText.textContent ?? '',
      expanded: !ui.repairOps.hidden,
      ops: Array.from(ui.repairOps.querySelectorAll('.repairbar__op')).map((n) => n.textContent ?? ''),
      // 结构化 ops（#11 原文跳行验收：at = 原文本偏移）
      opsDetail: meta?.repair?.ops ?? [],
      summary: meta?.repair?.summaryText ?? null,
      counts: meta?.repair?.counts ?? null,
      truncatedAt: meta?.repair?.truncatedAt ?? null,
      exportName: deps.exportFileName(),
      statusState: ui.repairStatusState.textContent ?? '',
    };
  };

  const fidelityState = (): FidelityHookState => {
    const fidelity = deps.fidelityReport();
    return {
      pending: deps.fidelityPending(),
      status: fidelity?.status ?? null,
      counts: fidelity?.counts ?? null,
      hits: fidelity?.hits ?? [],
      scanMs: fidelity?.scanMs ?? null,
      truncated: fidelity?.truncated ?? null,
      barVisible: !ui.fidelityBar.hidden,
      barText: ui.fidelityNotice.text(),
      jumpVisible: !ui.fidelityJump.hidden,
      viewMode: deps.viewModeAttr() === 'raw' ? 'raw' : 'tree',
      statusRows: ui.statusRows.textContent ?? '',
    };
  };

  return {
    loadText: (text: string, name = 'sample.json') => deps.entries.importText(text, name),
    scrollToPx: (px: number) => tree.scrollToPx(px),
    togglePath: (path: string, open: boolean) => deps.entries.toggleNode(path, open),
    expandAll: () => deps.entries.expandAll(true),
    collapseAll: () => deps.entries.expandAll(false),
    state: stateOf,

    // ---- slice 4：搜索 dev hook（契约见 docs/design/slice4-search-contract.md §5）----
    search: async (term: string) => {
      const started = performance.now();
      const ok = await deps.entries.runSearch(term);
      return { ms: ms(started), ok, ...searchDiagnostics() };
    },
    searchNext: async () => {
      const started = performance.now();
      const index = await deps.entries.searchNext();
      return { ms: ms(started), index, ...searchDiagnostics() };
    },
    searchPrev: async () => {
      const started = performance.now();
      const index = await deps.entries.searchPrev();
      return { ms: ms(started), index, ...searchDiagnostics() };
    },
    searchJump: async (index: number) => {
      const started = performance.now();
      const jumped = await deps.entries.gotoHit(index);
      return { ms: ms(started), index: jumped, ...searchDiagnostics() };
    },
    /** dev-only：模拟「文档已修改」→ 清空结果 + stale 提示。 */
    searchMarkStale: () => {
      const changed = deps.entries.markSearchStale();
      return { changed, ...searchDiagnostics() };
    },
    setSearchFilter: (filter: SearchFilter) => {
      deps.entries.applyFilter(filter);
      return searchDiagnostics();
    },
    searchPanel: () => searchDiagnostics(),
    searchListScrollTo: (px: number) => {
      deps.searchPanel.scrollListTo(px);
      return searchDiagnostics();
    },

    // ---- 大纲面板 dev hook（契约见 ADR-0013「dev hooks」）----
    outlineState: () => outlineHookState(),
    outlineOpen: () => {
      deps.entries.setPanel('outline');
    },
    outlineToggle: async (path: string, open?: boolean) => {
      const target = open ?? !deps.outlineState.isExpanded(path);
      const ok = await deps.outlineState.setOpen(path, target);
      return {
        ok,
        rows: deps.outlineState.view().rows.length,
        open: deps.outlineState.isExpanded(path),
      };
    },
    outlineLoadMore: async (path: string) => {
      const ok = await deps.outlineState.loadMore(path);
      return { ok, rows: deps.outlineState.view().rows.length };
    },
    outlineJump: async (path: string) => {
      const jumped = await deps.entries.jumpToPath(path);
      return { ok: jumped.ok, row: jumped.row };
    },

    // ---- slice 5：编辑 dev hook（契约见 docs/design/edit-spec.md §2/§8）----

    /** 打开某路径的子树编辑器（走真实 getNodeJson → SubtreeEditor.open 流程）。 */
    editOpen: async (path: string) => {
      await deps.entries.openEditor(path);
      return {
        open: deps.subtreeEditor.isOpen(),
        path: deps.editingPath(),
        text: deps.subtreeEditor.isOpen() ? deps.subtreeEditor.getValue() : null,
      };
    },
    /** 当前编辑器文本（未打开 → null）。 */
    editText: () => (deps.subtreeEditor.isOpen() ? deps.subtreeEditor.getValue() : null),
    /** 覆盖编辑器文本（模拟用户输入；JSON lint 异步生效）。 */
    editSetText: (text: string) => {
      deps.subtreeEditor.setValue(text);
      return deps.subtreeEditor.getValue();
    },
    /** 走 UI 的 Apply 按钮（等 lint/禁用态生效后点击）。 */
    editClickApply: () => {
      document.getElementById('editApply')?.click();
      return { open: deps.subtreeEditor.isOpen() };
    },
    /** 直接走 app 的 Apply 流程（等价编辑器 Apply，绕过按钮）；返回状态。 */
    editApplyText: async (text: string) => {
      await deps.entries.applyEditText(text);
      return { ...stateOf(), open: deps.subtreeEditor.isOpen() };
    },
    editClose: () => {
      deps.subtreeEditor.close();
      deps.setEditingPath(null);
      return true;
    },
    undo: async () => ({ ok: await deps.entries.undo(), ...stateOf() }),
    redo: async () => ({ ok: await deps.entries.redo(), ...stateOf() }),
    resetEdits: async () => ({ ok: await deps.entries.resetEdits(), ...stateOf() }),
    exportDocText: async () => {
      if (!session.rootId) return null;
      const reply = await core.exportDoc(session.rootId, 2);
      return { bytes: reply.bytes, text: reply.text, name: deps.exportFileName() };
    },
    editBadgeText: () => ({ hidden: ui.editBadge.hidden, text: ui.editBadge.textContent }),

    // ---- 复制四格式 dev hook（契约见 ADR-0010 §9）----

    /** 模拟右键打开菜单（走真实 showContextMenu）；返回菜单项文案/禁用态（DOM 顺序）。 */
    ctxOpen: (path: string, fallbackKind: JsonKind = 'object') => {
      const rowEl = deps.entries.contextMenu.rowElement(path);
      const rect = rowEl?.getBoundingClientRect();
      // 与真实右键同源：行数据来自 TreeView 的当前窗口缓存；不在窗口内才用行 DOM + 调用方兜底合成。
      const info: Row = tree.rowInfo(path) ?? {
        path,
        depth: 0,
        key: '',
        idx: false,
        kind: (rowEl?.dataset.kind as JsonKind | undefined) ?? fallbackKind,
        preview: '',
        count: 0,
        open: false,
        hasChildren: false,
      };
      deps.entries.contextMenu.show(path, (rect?.left ?? 40) + 24, (rect?.top ?? 80) + 12, info);
      const menu = deps.entries.contextMenu.menu;
      return {
        hidden: menu.hidden,
        items: deps.entries.contextMenu.items().map((item) => ({
          act: item.dataset.act ?? '',
          label: item.textContent ?? '',
          disabled: item.disabled,
          title: item.title,
        })),
      };
    },
    /** 点菜单项（真实 DOM click），等到 toast 变化后返回（复制是异步的）。 */
    ctxClick: async (act: string) => {
      const menu = deps.entries.contextMenu.menu;
      const item = menu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
      if (!item) return { clicked: false, toast: '', hidden: menu.hidden };
      const before = ui.toast.textContent ?? '';
      item.click();
      for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
        if ((ui.toast.textContent ?? '') !== before) break;
      }
      return {
        clicked: true,
        toast: ui.toast.hidden ? '' : (ui.toast.textContent ?? ''),
        hidden: menu.hidden,
      };
    },
    /** 走 core 的复制路径但不写剪贴板（逐字断言用）。 */
    copyResolve: async (path: string, format: CopyFormat) => {
      if (!session.rootId) return { error: { code: 'NO_ROOT', message: 'no document loaded' } };
      try {
        const reply = await core.copyNode({
          rootId: session.rootId,
          path,
          format,
          indent: deps.settings.get('copyIndent'),
        });
        return { text: reply.text, bytes: reply.bytes, format: reply.format };
      } catch (error) {
        const coreError = CoreError.from(error);
        return { error: { code: coreError.code, message: coreError.message, bytes: coreError.bytes } };
      }
    },
    clipboardText: () => deps.entries.clipboardText(),
    toastText: () => (ui.toast.hidden ? '' : (ui.toast.textContent ?? '')),

    // ---- 导出 dev hook（契约见 ADR-0012 §6/§7）----
    exportState: () => exportState(),
    exportMenuOpen: () => {
      ui.openExportMenu();
      return exportState();
    },
    exportClick: () => {
      ui.clickExportMain();
      return true;
    },
    exportChoose: (mode: ExportMode) => ui.chooseExport(mode),

    // ---- 设置 dev hook（契约见 ADR-0011 §7）----
    settingsState: () => ({
      ...deps.settings.snapshot(),
      ui: deps.settings.uiState(),
      loadedFromStore: deps.settings.loadedFromStore,
    }),
    setSetting: (key: SettingsKey, value: unknown) => {
      const changed = deps.settings.set(key, value);
      return { changed, ...deps.settings.snapshot() };
    },
    /** 打开设置面板（走真实 setPanel），返回面板状态与焦点位置。 */
    settingsOpen: () => deps.entries.openSettings(),
    /** 行高/缩进/类型列等几何视图态（冒烟断言用）。 */
    treeGeometry: () => deps.entries.treeGeometry(),
    repairState: () => repairState(),
    repairToggle: () => {
      ui.repairToggle.click();
      return !ui.repairOps.hidden;
    },
    repairClose: () => {
      ui.repairClose.click();
      return ui.repairBar.hidden;
    },

    // ---- 保真提示 dev hook（#23 / ADR-0003 修订）----
    /** 报告 + 提示条状态；`pending=true` 表示扫描在途（冒烟可轮询等它变 false）。 */
    fidelityState: () => fidelityState(),
    /** 点「查看原文」（真实 DOM click → 切原文 + rawLocate + 行 flash），等 200ms 后回快照。 */
    fidelityJump: async () => {
      const started = performance.now();
      ui.fidelityJump.click();
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      return { ms: ms(started), ...rawHookState(), fidelity: { barVisible: !ui.fidelityBar.hidden } };
    },
    fidelityClose: () => {
      ui.fidelityClose.click();
      return ui.fidelityBar.hidden;
    },

    // ---- 原始文本视图 dev hook（契约见 ADR-0003 修订 §7）----
    rawState: () => rawHookState(),
    /** 切视图（走真实 setViewMode；原文首开会等索引构建完成）。 */
    setViewMode: async (mode: 'tree' | 'raw') => {
      const started = performance.now();
      await deps.entries.setViewMode(mode);
      return { ms: ms(started), ...rawHookState() };
    },
    /** 滚到像素位置（真实 scroll → onScroll → rawSource.scrollTo）。 */
    rawScrollTo: (px: number) => {
      rawView.scrollToPx(px);
      return rawHookState();
    },
    /** 直接走 core 取原文窗口（逐字断言/性能用；不影响视图）。 */
    rawWindowText: async (start: number, count: number) => {
      if (!session.rootId) return null;
      const started = performance.now();
      const reply = await core.rawWindow({ rootId: session.rootId, seq: 0, start, count });
      return { ms: ms(started), ...reply };
    },
    /** 源文本偏移 → 行号（逐字断言用）。 */
    rawLocate: async (offset: number) => {
      if (!session.rootId) return null;
      return core.rawLocate({ rootId: session.rootId, offset });
    },
    /** 修复摘要跳行（走真实 revealRepairOffset：切视图 + locate + 高亮）。 */
    rawRevealAt: async (offset: number) => {
      const started = performance.now();
      const line = await deps.entries.revealRepairOffset(offset);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      return { ms: ms(started), line, ...rawHookState() };
    },
    /** 点第 N 个修复摘要 `at` 按钮（真实 DOM click）。 */
    rawRepairAt: (index: number) => {
      const buttons = [...ui.repairOps.querySelectorAll<HTMLElement>('.repairbar__at')];
      const button = buttons[index] ?? null;
      button?.click();
      return { clicked: Boolean(button), count: buttons.length };
    },
    /** 走 core 取整份原文（不写剪贴板；逐字断言与守卫用）。 */
    rawCopyText: async (maxBytes?: number) => {
      if (!session.rootId) return null;
      try {
        const reply = await core.rawSource({ rootId: session.rootId, maxBytes });
        return { bytes: reply.bytes, chars: reply.text.length, text: reply.text };
      } catch (error) {
        const coreError = CoreError.from(error);
        return { error: { code: coreError.code, message: coreError.message, bytes: coreError.bytes } };
      }
    },
    /** 点「复制原文」按钮并等 toast（剪贴板逐字读回走 click 后的 clipboardText）。 */
    rawCopy: async () => {
      const before = ui.toast.textContent ?? '';
      ui.rawCopyBtn.click();
      for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
        if ((ui.toast.textContent ?? '') !== before) break;
      }
      return { toast: ui.toast.hidden ? '' : (ui.toast.textContent ?? ''), ...rawHookState() };
    },
  };
}

/** 安装到 `window.__tjv`（只在 HTTP 冒烟页面调用）。 */
export function installDevHook(deps: DevHookDeps): void {
  (globalThis as unknown as { __tjv?: DevHook }).__tjv = createDevHook(deps);
}
