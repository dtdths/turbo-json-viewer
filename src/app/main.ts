/**
 * app/main — 扩展页入口：创建 Worker、装配 viewmodel + view。
 * 唯一知道「用哪个适配器」的地方（架构蓝图 §3.5）。
 */
import '../view/styles/tokens.css';
import './styles/shell.css';
import '../view/tab-strip.css';
import '../view/tree/tree.css';
import '../view/panels/search-panel.css';
import '../view/panels/outline-panel.css';
import '../view/panels/settings-panel.css';
import '../view/panels/expression-panel.css';
import '../view/panels/profile-panel.css';
import '../view/raw/raw-view.css';

import { createWorkerCore } from './transport/worker-transport';
import { RowWindowSource } from '../viewmodel/row-window-source';
import { RawWindowSource } from '../viewmodel/raw-window-source';
import { SearchState, type SearchFilter } from '../viewmodel/search-state';
import { OutlineState } from '../viewmodel/outline-state';
import { TreeView } from '../view/tree/tree-view';
import { TabStrip } from '../view/tab-strip';
import { RawView } from '../view/raw/raw-view';
import { DomRowPool } from '../view/tree/row-renderer';
import { SearchPanel } from '../view/panels/search-panel';
import { OutlinePanel } from '../view/panels/outline-panel';
import { renderProfilePanel, type ProfilePanelState } from '../view/panels/profile-panel';
import { CoreError } from '../protocol/errors';
import {
  ImportLayerState,
  LIMIT_HINT_KEY,
  WARN_AFTER_KEY,
  WARN_BEFORE_KEY,
  type ImportLayerMode,
  type ImportTarget,
  type LayerContext,
  type LayerView,
  type OpenResult,
  type PendingImport,
} from './import/layer-state';
import { ImportLayer } from './import/layer';
import { ExpressionWorkspace } from './expression-workspace';
import { LARGE_DOC_WARN_BYTES } from '../protocol/versions';
import { parentPath, ROOT_PATH } from '../shared/path';
import {
  exportFileName,
  exprExportFileName,
  renameFromExport,
  sanitizeDocName,
  type ExportNameFlags,
} from '../shared/doc-name';
import { displayTitle } from '../view/doc-title';
import type {
  CopyFormat,
  DocumentMeta,
  FidelityHit,
  FidelityReport,
  JsonKind,
  RawMeta,
  Row,
  SortOrder,
} from '../protocol/types';
import type { EditReply, LoadReply, RootVersion } from '../protocol/messages';
import { DocSession, type LandingPlan } from './doc-session';
import type { ViewAnchor } from '../viewmodel/tab-view-data';
import { TabViewState } from './tab-view-state';
import {
  installDevHook,
  type DevHookDeps,
  type ExpressionHookState,
  type WorkspaceHookState,
} from './dev-hook';
import { EditState } from '../viewmodel/edit-state';
import {
  WorkspaceState,
  type TabInput,
  type TabRuntime,
  type TabState,
} from '../viewmodel/workspace-state';
import { SubtreeEditor } from '../view/panels/subtree-editor';
import { SettingsState, type SettingsKey } from '../viewmodel/settings-state';
import {
  CLIPBOARD_MAX_BYTES,
  clipboardRefusal,
  normalizeExportMode,
  type ExportMode,
} from '../viewmodel/export-state';
import { EXPORT_MODE_LABELS } from '../view/export-labels';
import { SettingsPanel } from '../view/panels/settings-panel';
import { NoticeBar } from '../view/panels/notice-bar';
import { ExpressionPanel } from '../view/panels/expression-panel';
import { ExpressionBar } from '../view/panels/expression-bar';
import { EXPR_COPY } from '../view/expression-copy';
import { createMenu } from '../view/menu';
import { createViewStateStore } from './storage';
import { currentLocale, formatNumber, initI18n, setLocalePref, t, type MessageKey } from '../i18n';
import { applyStaticMessages } from '../i18n/dom';
import type { LocalePref } from '../i18n/types';
import { patternErrorText, repairNoteText, repairSummaryText } from '../i18n/format';

const chromeApi = (globalThis as { chrome?: { runtime?: { id?: string; getURL(path: string): string } } }).chrome;
const isExtension = Boolean(chromeApi?.runtime?.id);

/** 文本强调节点（空态文件名用；样式走 `.empty__warn b` / `.empty__pending b`）。 */
function strongText(text: string): HTMLElement {
  const node = document.createElement('b');
  node.textContent = text;
  return node;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('missing #' + id);
  return node as T;
}

/* ---------------- DOM refs ---------------- */

const treeHost = el('tree');
const statusRows = el('statusRows');
const statusSize = el('statusSize');
const statusPath = el('statusPath');
const statusState = el('statusState');
const statusTheme = el('statusTheme');
const fileChip = el<HTMLButtonElement>('fileChip');
const fileName = el('fileName');
const fileMeta = el('fileMeta');
const exportBtn = el<HTMLButtonElement>('exportBtn');
const exportMenuBtn = el<HTMLButtonElement>('exportMenuBtn');
const exportMenu = el('exportMenu');
const expandAllBtn = el<HTMLButtonElement>('expandAllBtn');
const collapseAllBtn = el<HTMLButtonElement>('collapseAllBtn');
const editBadge = el<HTMLButtonElement>('editBadge');
const editModal = el('editModal');
const ctxMenu = el('ctxMenu');
const fileInput = el<HTMLInputElement>('fileInput');
const empty = el('empty');
const emptyInner = el('emptyInner');
const emptyTitle = el('emptyTitle');
const emptySub = el('emptySub');
const emptyWarn = el('emptyWarn');
const emptyError = el('emptyError');
const emptyPending = el('emptyPending');
const emptyPendingText = el('emptyPendingText');
const pendingNewTab = el<HTMLButtonElement>('pendingNewTab');
const pendingReplace = el<HTMLButtonElement>('pendingReplace');
const emptyBusy = el('emptyBusy');
const emptyClose = el<HTMLButtonElement>('emptyClose');
/** 导入落点 radio（#47 #1）：完整导入层的显式二选一，初始值 = 设置「导入位置」 */
const emptyTarget = el('emptyTarget');
const targetNewTab = el<HTMLInputElement>('targetNewTab');
const targetReplace = el<HTMLInputElement>('targetReplace');
/** 完整层提示行（#47 #1.4：标签已满自动降为替换） */
const emptyHint = el('emptyHint');
const importBtn = el<HTMLButtonElement>('importBtn');
const pickBtn = el<HTMLButtonElement>('pickBtn');
const dropzone = el('dropzone');
const toast = el('toast');
const searchHost = el('searchPanel');
const panelTitle = el('panelTitle');
const settingsHost = el('settingsPanel');
const outlineHost = el('outlinePanel');
const expressionHost = el('expressionPanel');
const exprBarRoot = el('exprBar');
const selPath = el('selPath');
const selMeta = el('selMeta');
const profilePanel = el('profilePanel');
const repairBar = el('repairBar');
const repairText = el('repairText');
const repairToggle = el<HTMLButtonElement>('repairToggle');
const repairOps = el('repairOps');
const repairClose = el<HTMLButtonElement>('repairClose');
const docWarnBar = el('docWarnBar');
const docWarnNotice = new NoticeBar(docWarnBar);
const fidelityBar = el('fidelityBar');
const fidelityNotice = new NoticeBar(fidelityBar);
const fidelityJump = el<HTMLButtonElement>('fidelityJump');
const fidelityClose = el<HTMLButtonElement>('fidelityClose');
const fidelityPrev = el<HTMLButtonElement>('fidelityPrev');
const fidelityNext = el<HTMLButtonElement>('fidelityNext');
const fidelityCount = el('fidelityCount');
const viewTreeBtn = el<HTMLButtonElement>('viewTreeBtn');
const viewRawBtn = el<HTMLButtonElement>('viewRawBtn');
const rawHost = el('raw');
const rawModeLabel = el('rawModeLabel');
const rawNotice = el('rawNotice');
const rawMetaLabel = el('rawMetaLabel');
const rawCopyBtn = el<HTMLButtonElement>('rawCopyBtn');
/** 原文行右键菜单（#30 / ADR-0019 键盘等价入口） */
const rawCtxMenu = el('rawCtxMenu');

/* ---------------- 设置（ADR-0011）：先读盘再装配，避免主题/布局闪烁 ---------------- */

const viewStateStore = createViewStateStore();
const settings = new SettingsState();
// ESM top-level await：拿不到（隐私模式/配额）就用默认值继续，不阻塞
await settings.load(viewStateStore);
// i18n 必须在装配 view / 首次渲染之前（ADR-0026 §2）：解析 locale → 按需 await 语言包 → 回填静态文案，
// 避免「先英文再闪成中文」。`<title>` 是品牌名，不翻译。
await initI18n(settings.get('locale'));
applyStaticMessages();
document.documentElement.lang = currentLocale();
if (settings.uiState().railCollapsed) {
  document.body.classList.add('rail-collapsed');
  el('railToggle').setAttribute('aria-pressed', 'false');
}

/* ---------------- core + viewmodel + view ---------------- */

const workerUrl = isExtension && chromeApi?.runtime ? chromeApi.runtime.getURL('worker.js') : './worker.js';
const worker = new Worker(workerUrl, { type: 'module' });
const workerCore = createWorkerCore(worker);
const core = workerCore.api;

/* ---------------- 工作区（#18 / ADR-0009）：每标签一份 runtime ---------------- */

/**
 * 每个标签私有的四份 adapter（行窗口 / 原文窗口 / 搜索 / 编辑）。
 * 切标签 = 换这组引用 + 换订阅目标（ADR-0009 §3），**不关根、不重解析**。
 * 下面的模块级 `let rowSource/searchState/editState/rawSource` 始终指向**活动标签**的实例；
 * 空工作区时指向 bootstrap（不会被真正取数，因为所有入口都有 session.rootId 守卫）。
 */
function createTabRuntime(): TabRuntime {
  return {
    rowSource: new RowWindowSource(core, { rowHeight: settings.get('rowHeight') }),
    rawSource: new RawWindowSource(core, { rowHeight: settings.get('rowHeight') }),
    searchState: new SearchState(),
    editState: new EditState(),
  };
}

const workspace = new WorkspaceState({ createRuntime: createTabRuntime });
/** 空工作区占位 runtime（关掉最后一个标签后回落到它）。 */
let emptyRuntime = createTabRuntime();

let rowSource: RowWindowSource = emptyRuntime.rowSource;
let rawSource: RawWindowSource = emptyRuntime.rawSource;
let searchState: SearchState = emptyRuntime.searchState;
let editState: EditState = emptyRuntime.editState;

/** 活动标签的对照锚点镜像（存档走 `TabViewData.anchor`；#30 / ADR-0019 §5） */
let rawTreeAnchor: ViewAnchor | null = null;

const tree = new TreeView(treeHost, {
  rowHeight: settings.get('rowHeight'),
  renderer: (host: HTMLElement) => new DomRowPool(host, { rowHeight: settings.get('rowHeight') }),
  onScroll: (top: number) => rowSource.scrollTo(top),
  onToggle: (path: string, open: boolean) => {
    void toggleNode(path, open);
  },
  onSelect: (path: string) => setSelection(path),
  // 表达式结果视图（ADR-0018 §1）：鼠标点击结果行 = 跳回原文档对应节点（键盘移动不触发）
  onRowClick: (path: string) => {
    if (expression.active) void expression.jumpFromRow(path);
  },
  onEdit: (path: string) => {
    void openEditor(path);
  },
  onContextMenu: (path: string, x: number, y: number, row: Row) => {
    setSelection(path);
    showContextMenu(path, x, y, row);
  },
  // 行尾浮条（ADR-0010 修订）：鼠标快路径；复制格式跟随设置（ADR-0011 §1 defaultCopyFormat）
  onRowAction: (path: string, action: 'copy' | 'edit' | 'raw') => {
    if (action === 'copy') void copyNodeToClipboard(path, settings.get('defaultCopyFormat'));
    else if (action === 'raw') void jumpTreeToRaw(path);
    else void openEditor(path);
  },
});
tree.mount();

/* 标签条（#18 / ADR-0009 §1）：只渲染 DOM；切换/关闭/新增的语义全在 app 层 */
const tabStrip = new TabStrip(el('tabStrip'), {
  onSelect: (id) => switchTab(id),
  onClose: (id) => {
    void closeTab(id);
  },
  onAdd: () => importLayer.openNewTab(),
  // 拖拽排序（#18 修订 2026-11-11）：顺序是工作区级状态，活动标签不变
  onMove: (id, toIndex) => {
    workspace.move(id, toIndex);
  },
  // 标签就地改名（#29 / ADR-0021）：清洗后写显示名；空串 = 保持原名
  onRename: (id, raw) => {
    applyDocRename(id, raw);
  },
});
tabStrip.mount();
workspace.subscribe((view) => tabStrip.render(view));
tabStrip.render(workspace.view());

/**
 * 把焦点交给树（a11y 单一真相）：`#tree` 只是骨架容器，`role=tree` / `tabindex` 挂在内层 `.tjv-tree`
 * 滚动容器上（TreeView.mount）。所有「焦点回树」的路径都走这里，避免一半聚焦外层、一半聚焦内层。
 */
function focusTree(): void {
  treeHost.querySelector<HTMLElement>('.tjv-tree')?.focus();
}

/* ---------------- 原始文本视图（#11 / ADR-0003 修订 2026-11-03） ---------------- */

/** 原文窗口状态机（单飞/合并/seq 丢弃/overscan；原文无 rowVersion——doc 生命周期即版本）。 */
const rawView = new RawView(rawHost, {
  rowHeight: settings.get('rowHeight'),
  onScroll: (top: number) => rawSource.scrollTo(top),
  // 双向定位（#30 / ADR-0019）：行号 gutter 按钮 → 树；行右键 → 菜单（键盘等价入口）
  onLocate: (line: number) => {
    void jumpRawToTree(line);
  },
  onContextMenu: (line: number, x: number, y: number) => showRawContextMenu(line, x, y),
});
rawView.mount();

/** 搜索面板的会话态选项（ADR-0014 §2.5：唯一真相在 app 层，不持久化，刷新回默认）。 */
let searchOpts: { caseSensitive: boolean; regex: boolean; wholeWord: boolean } = {
  caseSensitive: false,
  regex: false,
  wholeWord: false,
};

const searchPanel = new SearchPanel(searchHost, {
  onQueryChange: (query: string) => queueSearch(query),
  onFilterChange: (filter: SearchFilter) => applyFilter(filter),
  onSelect: (index: number) => {
    void gotoHit(index);
  },
  // 双击结果行 = 复制该命中节点（ADR-0010 修订；格式来自设置「搜索结果双击复制」）
  onCopyResult: (path: string) => {
    void copyNodeToClipboard(path, settings.get('searchCopyFormat'));
  },
  onPrev: () => {
    void searchPrev();
  },
  onNext: () => {
    void searchNext();
  },
  onSubmit: () => {
    void searchNext();
  },
  // Aa / .* 切换（ADR-0014）：快照后立即重跑当前查询（绕过 250ms debounce，空查询只重置状态）
  // 用输入框里的**当前**文本：用户可能刚输入、debounce 还没提交，不能拿旧 query 重跑。
  onOptionsChange: (opts) => {
    searchOpts = { ...opts };
    window.clearTimeout(searchTimer);
    void runSearch(searchPanel.currentQuery());
  },
  // 逐条隐藏 / 全部恢复（#53）：隐藏集在 viewmodel（每标签独立、不落盘），这里只负责落地
  onHideResult: (path) => {
    hideSearchHit(path);
  },
  onRestoreHidden: () => {
    restoreHiddenHits();
  },
});
searchPanel.mount();

/* ---------------- 大纲面板（ADR-0013）：结构导航器 ---------------- */

/**
 * 大纲状态机（viewmodel，无 DOM）：按容器分页 + 大纲自己的展开集合 + 扁平化行。
 * 数据源只注入 `outline(req)` 子集（ADR-0013 §5），真实实现是 Worker 侧 `core.outline`。
 */
const outlineState = new OutlineState({ outline: (req) => core.outline(req) });
const outlinePanel = new OutlinePanel(outlineHost, {
  rowHeight: settings.get('rowHeight'),
  // caret / 键盘 ←→：只改大纲自己的展开态，不影响树
  onToggle: (path, open) => {
    void outlineState.setOpen(path, open);
  },
  // 点击行 / Enter：跳转（与搜索跳转共用 jumpToPath）
  onActivate: (path) => {
    void jumpToPath(path);
  },
  // ↑↓/Home/End：移动大纲当前行 = 同步树选中（不跳树、不 expandTo）
  onSelect: (path) => setSelection(path),
  onLoadMore: (path) => {
    void outlineState.loadMore(path);
  },
});
outlinePanel.mount();
outlineState.subscribe((view) => outlinePanel.render(view));
outlinePanel.render(outlineState.view());

/** 子树编辑弹层（CM6 懒加载；见 src/view/panels/subtree-editor.ts）。 */
const subtreeEditor = new SubtreeEditor({
  modal: editModal,
  onApply: (text: string) => applyEditText(text),
  onClose: () => {
    editingPath = null;
  },
  onRestore: () => {
    /* 弹层内部已把文本复位到「打开时的值」，app 侧无需动作 */
  },
});

/* ---------------- session state ---------------- */

/** 回包落地会话（ADR-0008 修订 2026-11-09）：四个会话字段的唯一真相源；只在 applyLanding 前由 land() 更新。 */
const session = new DocSession();

let meta: DocumentMeta | null = null;
let selected: string | null = null;
let loadSeq = 0;
let searchTimer = 0;
/** 首次 next/prev/Enter 先跳到当前命中，之后才移动（编辑器惯例）。 */
let searchJumped = false;

/** 原文行索引元信息（null = 当前文档尚未进入原文视图 / 索引未构建） */
let rawMetaInfo: RawMeta | null = null;
/** 原文 open 竞态守卫（切视图 / 换文档时递增，迟到回包丢弃） */
let rawOpenSeq = 0;

/** 保真报告（#23 / ADR-0003 修订）：只在当前文档会话内存；null = 未扫/无报告。 */
let fidelity: FidelityReport | null = null;
/** 保真条多命中导航的当前命中序号（#31 / ADR-0003 修订 2026-11-11 晚） */
let fidelityIndex = 0;
/** 扫描在途标记（dev hook / 冒烟判定用；不显示进度） */
let fidelityPending = false;
/** 保真扫描代次（换文档递增，迟到回包丢弃） */
let fidelitySeq = 0;

/** 编辑会话（slice 5 / #16 / ADR-0006）：当前编辑目标 + 修改计数/撤销可用性。 */
let editingPath: string | null = null;
/** 编辑器打开时所属的 doc 根（切标签 / 换文档后 Apply 必须丢弃，ADR-0009 §3） */
let editingRootId: string | null = null;
let ctxPath: string | null = null;
/** 右键菜单打开时该行的原文档路径（#47 #8）：只有表达式结果根的行有；`null` = 计算值 / 非表达式视图。 */
let ctxOriginPath: string | null = null;

/* ---------------- 工作区接线（#18 / ADR-0009）：活动标签 ↔ 模块级视图态 ---------------- */

/**
 * 每标签视图态的搬运点（#58 / ADR-0008 修订）：`TabViewData` 的 10 个镜像字段只在这张表里
 * 出现一次（一行一个字段），`capture` / `restore` / `reset` / `syncVersions` 都循环它。
 * 加字段 = 类型 1 行 + `VIEW_FIELD_KEYS` 1 行 + 这里 1 行。
 */
const tabView = new TabViewState({
  workspace,
  fields: {
    rawMetaInfo: { get: () => rawMetaInfo, set: (value) => { rawMetaInfo = value; } },
    fidelity: { get: () => fidelity, set: (value) => { fidelity = value; } },
    exprView: { get: () => expression.mirror.exprView.get(), set: (value) => { expression.mirror.exprView.set(value); } },
    // 搜索开关是唯一被就地改过的嵌套字段：存取都拷一份，存档 / 镜像不共享可变对象
    searchOpts: { get: () => ({ ...searchOpts }), set: (value) => { searchOpts = { ...value }; } },
    anchor: { get: () => rawTreeAnchor, set: (value) => { rawTreeAnchor = value; } },
    exprLastText: { get: () => expression.mirror.exprLastText.get(), set: (value) => { expression.mirror.exprLastText.set(value); } },
    exprErrorState: { get: () => expression.mirror.exprErrorState.get(), set: (value) => { expression.mirror.exprErrorState.set(value); } },
    exprStatusState: { get: () => expression.mirror.exprStatusState.get(), set: (value) => { expression.mirror.exprStatusState.set(value); } },
    searchPatternCore: { get: () => searchPatternCore, set: (value) => { searchPatternCore = value; } },
    fidelityIndex: { get: () => fidelityIndex, set: (value) => { fidelityIndex = value; } },
  },
  live: () => ({ docRevision: session.docRevision, rowVersion: session.rowVersion, totalRows: session.totalRows, selected }),
  treeScrollTopPx: () => tree.scrollTopPx(),
  rawScrollTopPx: () => rawView.scrollTopPx(),
  // 表达式结果视图不跨标签自动激活（重进表达式模式由 setPanel('expression') 的既有链路决定）
  resetTransient: () => expression.resetTransient(),
});

let unbindRowSource: (() => void) | null = null;
let unbindRawSource: (() => void) | null = null;
let unbindEditState: (() => void) | null = null;

/** 把三份订阅重挂到当前活动标签的 adapter（切标签时调用；旧订阅先退，避免双份渲染）。 */
function bindRuntimeSubscriptions(): void {
  unbindRowSource?.();
  unbindRawSource?.();
  unbindEditState?.();
  unbindRowSource = rowSource.subscribe((snapshot) => {
    tree.render(snapshot);
    updateStatus();
  });
  unbindRawSource = rawSource.subscribe((snapshot) => {
    rawView.render(snapshot);
    updateStatus();
  });
  unbindEditState = editState.subscribe(renderEditBadge);
  renderEditBadge();
}

function activeTab(): TabState | null {
  return workspace.active();
}

/**
 * 绑定一个标签：换 adapter 引用 + 重挂订阅 + 恢复该标签的会话/选中/非 adapter 视图态。
 * 不取窗口、不重画面板（那部分在 `restoreActiveTabView`，加载路径用 applyLanding 自己推）。
 */
function bindTab(tab: TabState): void {
  rowSource = tab.runtime.rowSource;
  rawSource = tab.runtime.rawSource;
  searchState = tab.runtime.searchState;
  editState = tab.runtime.editState;
  bindRuntimeSubscriptions();
  session.restore({
    rootId: tab.rootId,
    docRevision: tab.docRevision,
    rowVersion: tab.rowVersion,
    totalRows: tab.totalRows,
  });
  meta = tab.meta;
  selected = tab.selected;
  // 5 个视图字段 + 表达式视图的瞬时复位都在这里（accessor 表驱动，见 tabView 装配处）
  tabView.restore(tab);
  clearStatusHint();
  refreshHookDeps();
}

/** 行尾「在原文中定位」入口开关（#30）：表达式结果根无源文本；plain（修复文档）无可靠映射。 */
function syncLocateRaw(): void {
  tree.setLocateRaw(!expression.active && meta?.repair === undefined);
}

/** 工具栏 / 文件 chip / 三条常驻提示条 / 状态栏按活动标签重画。 */
function renderTabChrome(): void {
  const tab = activeTab();
  const hasDoc = tab !== null;
  fileChip.hidden = !hasDoc;
  if (tab) {
    // 显示名 = 标签名（默认 = 导入文件名；改名见 ADR-0021），原名只用于悬停追溯
    fileName.textContent = tab.name;
    fileChip.title = displayTitle(tab.name, tab.meta.name);
    fileMeta.textContent = formatBytes(tab.meta.bytes);
  }
  setExportButtonsDisabled(!hasDoc);
  syncExportUi();
  expandAllBtn.disabled = !hasDoc;
  collapseAllBtn.disabled = !hasDoc;
  viewTreeBtn.disabled = !hasDoc;
  viewRawBtn.disabled = !hasDoc;
  renderRepair();
  renderDocWarn();
  renderFidelity();
  renderRawChrome();
  syncLocateRaw();
  updateStatus();
}

/** 标签切换后统一重绘：树窗口 / 搜索 / 大纲 / 工具栏与提示条 / 原文视图。 */
function restoreActiveTabView(): void {
  const tab = activeTab();
  if (!tab) return;
  // 滚动位置没有模块级镜像：直接从该标签的存档读（唯一的两处「存档直读」）
  const view = tab.view;
  // 树：同根同版本时 WindowMachine 保留上一帧（切回不闪白），滚动位置按标签恢复
  rowSource.setMetrics(metrics());
  rowSource.setRoot(
    { rootId: tab.rootId, rowVersion: tab.rowVersion, totalRows: tab.totalRows },
    { scrollTopPx: view.scrollTopPx },
  );
  tree.scrollToPx(view.scrollTopPx);
  setSelection(selected);
  rowSource.requestWindow();
  // 搜索：命中集 / 面板输入框都换成本标签的（SearchPanel.render 会在输入框未聚焦时同步值）
  searchJumped = false;
  applySearchToTree();
  renderSearch();
  // 切回时该标签有在途搜索：Worker 侧回包早已丢失（seq 被新查询取代），重跑一次
  if (searchState.pending && searchState.query !== '') void runSearch(searchState.query);
  // 大纲：按新根重新打开（面板开合是工作区级，数据按标签）
  void outlineState.open(tab.rootId).then(() => {
    if (workspace.activeId === tab.id) setSelection(selected);
  });
  renderTabChrome();
  // 表达式结果条：新标签没有激活的结果视图 → 隐藏（结果本体按标签保留在存档）
  expression.renderBar();
  // 表达式行内反馈随标签（#58）：先抹掉上一个标签的错误/状态行，再按本标签存档回填
  // （面板是单实例，光恢复镜像不会重画这一行；切语言路径仍只走 applyInlineText）
  expression.renderAfterTabSwitch();
  // 原文视图：正看原文 → 为该标签重新 open（本标签已有索引元信息时 open 会复用 worker 侧索引）
  if (isRawView()) {
    const savedRaw = view.rawScrollTopPx;
    void setViewMode('raw', { persist: false }).then(() => {
      // 切标签期间别把滚动写到别的标签上；savedRaw=0 就是回顶（无需额外动作）
      if (workspace.activeId !== tab.id || !isRawView() || savedRaw <= 0) return;
      rawView.scrollToPx(savedRaw);
      rawSource.scrollTo(savedRaw);
      rawSource.requestWindow();
    });
  } else updateStatus();
  // 文档概要（#43 / ADR-0025 §2）：切标签 = 换目标根，清空后按需重采（右栏可见时）
  clearProfile();
  scheduleProfile();
}

/** 切标签：存档旧标签 → 换绑定 → 重绘（不关根、不重解析，ADR-0009 §3）。 */
function switchTab(id: string): void {
  if (id === workspace.activeId) return;
  if (activeTab()) {
    // 表达式结果视图是文档级临时视图：切走先回文档树（结果保留在本标签存档，重进可恢复）
    if (expression.active) expression.back({ silent: true });
    expression.cancel();
    tabView.capture();
  }
  if (!workspace.activate(id)) return;
  // 编辑器是文档级会话：切标签即关闭（半开的 Apply 不得落到新标签）
  if (subtreeEditor.isOpen()) subtreeEditor.close();
  editingPath = null;
  editingRootId = null;
  const tab = activeTab();
  if (!tab) return;
  bindTab(tab);
  restoreActiveTabView();
  if (document.body.dataset.panel === 'expression') setPanel('expression');
  focusTree();
}

/**
 * 关闭标签（ADR-0009 §4）：先释放 Worker 根（closeRoot，幂等），再从工作区移除；
 * 关的是活动标签 → 激活相邻标签（WorkspaceState 选右邻→左邻）；关掉最后一个 → 回空态。
 * 有未导出的临时修改时先确认（用户 2026-11-11 拍板：确认后关闭）。
 */
async function closeTab(id: string, opts: { force?: boolean } = {}): Promise<void> {
  const tab = workspace.get(id);
  if (!tab) return;
  if (
    !opts.force &&
    tab.runtime.editState.dirty &&
    !window.confirm(t('app.confirm.closeTab', { name: tab.name }))
  ) {
    return;
  }
  const wasActive = workspace.activeId === id;
  const result = workspace.remove(id);
  if (!result) return;
  // closeRoot 幂等（未知根回 closed:false）；失败不阻断关闭
  void core.closeRoot(result.removed.rootId).catch(() => undefined);
  // 关到只剩 1 个 → 标签条隐藏：焦点必须离开被移除的标签，回树（a11y）
  if (workspace.size === 1) focusTree();
  if (workspace.size === 0) {
    enterEmptyState();
    return;
  }
  if (!wasActive) return;
  expression.cancel();
  const next = activeTab();
  if (!next) return;
  bindTab(next);
  restoreActiveTabView();
  if (document.body.dataset.panel === 'expression') setPanel('expression');
  focusTree();
}

/** 关掉最后一个标签 → 回到初始空态（导入层 + 全部入口禁用，ADR-0009 §4）。 */
function enterEmptyState(): void {
  session.restore({ rootId: null, docRevision: 0, rowVersion: 0, totalRows: 0 });
  meta = null;
  selected = null;
  rawMetaInfo = null;
  fidelity = null;
  fidelityPending = false;
  fidelitySeq += 1;
  // 文档概要（#43 / ADR-0025 §8）：回空态 = 清空，不采
  clearProfile();
  rawOpenSeq += 1;
  // 表达式工作区先清（结果本体 + 行内反馈 + 在途闸门），再清每标签视图存档
  expression.clear();
  // 视图存档的镜像一并复位（#58：对照锚点 / 表达式反馈 / 搜索解析错误 / 保真下标）
  tabView.clear();
  editingPath = null;
  subtreeEditor.close();
  // adapter 回落到新的空 runtime（旧标签的 adapter 已随标签一起丢弃）
  emptyRuntime = createTabRuntime();
  rowSource = emptyRuntime.rowSource;
  rawSource = emptyRuntime.rawSource;
  searchState = emptyRuntime.searchState;
  editState = emptyRuntime.editState;
  bindRuntimeSubscriptions();
  // 视图复位
  tree.setSearch(null);
  tree.setSelected(null);
  rawView.scrollToPx(0);
  searchOpts = { caseSensitive: false, regex: false, wholeWord: false };
  resetSearch();
  outlineState.close();
  document.body.dataset.view = 'tree';
  viewTreeBtn.classList.add('is-active');
  viewTreeBtn.setAttribute('aria-pressed', 'true');
  viewRawBtn.classList.remove('is-active');
  viewRawBtn.setAttribute('aria-pressed', 'false');
  // 导入层回初始空态（渲染 + 显示；入场自动重播）
  importLayer.showInitial();
  fileChip.hidden = true;
  setExportButtonsDisabled(true);
  expandAllBtn.disabled = true;
  collapseAllBtn.disabled = true;
  viewTreeBtn.disabled = true;
  viewRawBtn.disabled = true;
  repairBar.hidden = true;
  docWarnNotice.hide();
  fidelityNotice.hide();
  fidelityNotice.setActionVisible(false);
  renderRawChrome();
  renderEditBadge();
  expression.renderBar();
  updateStatus();
  setPanel('doc');
  emptyInner.focus();
}

/**
 * 第 2+ 份大文档的内存提示（ADR-0009 §4）：8 × 50MB ≈ 584MB 上界，按标签线性增长。
 * 只在「工作区已有别的标签」且「本份或合计超过大文档阈值」时提示，不阻断导入。
 */
function maybeShowWorkspaceMemoryHint(tab: TabState): void {
  if (workspace.size < 2) return;
  const totalBytes = workspace.ids.reduce((sum, id) => sum + (workspace.get(id)?.bytes ?? 0), 0);
  if (tab.bytes < LARGE_DOC_WARN_BYTES && totalBytes < LARGE_DOC_WARN_BYTES) return;
  showToast(t('app.toast.workspaceMemory', { n: workspace.size }), 5000);
}

/**
 * 回包落地执行器（app 侧唯一副作用点）：把 `LandingPlan` 变成行窗口 / 视口 / 命中 / 状态栏动作。
 * 「意图 → 附加动作」全部由 `DocSession.land()` 决定，这里只照做（ADR-0008 修订 2026-11-09）。
 */
function applyLanding(plan: LandingPlan): void {
  const rootId = plan.state.rootId;
  if (!rootId) return;
  // 多标签（ADR-0009 §2）：回包按 rootId 路由——不是活动标签的根（旧根/别的标签/迟到回包）
  // 一律丢弃，绝不写进当前视图态。表达式结果根走下面各自的分支。
  const tab = activeTab();
  if (!tab) return;
  const forActiveDoc = rootId === tab.rootId;
  const forActiveExpr = expression.activeRootId() === rootId;
  if (!forActiveDoc && !forActiveExpr) return;
  // 表达式视图内的展开/折叠会推进 expr 根的 rowVersion：同步视图态（重进表达式模式时用）
  if (forActiveExpr) {
    expression.syncLandedRoot(rootId, plan.state.rowVersion, plan.state.totalRows);
  }
  rowSource.setRoot(
    { rootId, rowVersion: plan.state.rowVersion, totalRows: plan.state.totalRows },
    plan.scroll.kind === 'top' ? { scrollTopPx: 0 } : {},
  );
  if (plan.scroll.kind === 'top') tree.scrollToPx(0);
  else if (plan.scroll.kind === 'center') tree.scrollToPx(plan.scroll.scrollTopPx);
  else if (plan.scroll.kind === 'shift-anchor') rowSource.restoreAnchor(plan.scroll.anchor);
  rowSource.requestWindow();
  if (plan.reapplyHits) applySearchToTree();
  if (plan.refreshOutline) void outlineState.refresh();
  if (plan.markSearchStale) markSearchStale();
  // 文档概要失效（#43 / ADR-0025 §8）：任何时候 docRevision 推进都让概要失效；
  // staleProfile 内部比对 (rootId, docRevision)，无变化即 no-op——不借用搜索语义的 plan 标志。
  staleProfile();
  if (plan.history) editState.sync(plan.history);
  if (plan.clearSelection) setSelection(null);
  if (plan.selectPath) setSelection(plan.selectPath);
  if (plan.flashPath) {
    tree.setChangedPath(plan.flashPath);
    window.setTimeout(() => tree.setChangedPath(null), CHANGED_FLASH_MS);
  }
  updateStatus();
}

/**
 * 回包是否属于**当前显示根**（多标签 / ADR-0009 §2 + ADR-0018 §1）：
 * 切标签后，旧根的在途回包必须丢弃，不能写进新标签的会话（版本号巧合靠不住）。
 * 注意「显示根」可以是**活动标签的文档根**，也可以是**表达式结果根**（exprViewActive）——
 * 结果视图上的展开/收起/全部展开/跳转回包打的是 expr 根，不能被当成跨标签回包丢掉
 * （丢了 UI 不动但 Worker 的 rowVersion 已推进 → 后续窗口请求 STALE_ROOT）。
 */
function isActiveDocRoot(rootId: string): boolean {
  const tab = activeTab();
  if (!tab) return false;
  const shownRoot = expression.activeRootId() ?? tab.rootId;
  return rootId === shownRoot;
}

function metrics(): { rowHeight: number; viewportRows: number } {
  return { rowHeight: settings.get('rowHeight'), viewportRows: Math.max(1, tree.viewportRows()) };
}

function rawMetrics(): { rowHeight: number; viewportRows: number } {
  return { rowHeight: settings.get('rowHeight'), viewportRows: Math.max(1, rawView.viewportRows()) };
}

rowSource.subscribe((snapshot) => {
  tree.render(snapshot);
  updateStatus();
});

/* ---------------- 设置面板 + 应用（ADR-0011 §1/§4） ---------------- */

const settingsPanel = new SettingsPanel(settingsHost, {
  onChange: (key, value) => {
    // 单一写入口：set 会校验 + 持久化 + 通知订阅者；applySettings 负责落到 DOM/几何
    settings.set(key, value);
  },
});
settingsPanel.mount();

/**
 * 子键显示排序（#40 / ADR-0024 §5/§6）：切换设置 → `core.setOrder` → 全根版本回填 →
 * 活动根窗口重取 → 按路径还原视口锚点 → 大纲刷新。
 *
 * - `appliedOrder` 相同即 no-op：其它设置变化（行高 / 主题…）不得重复发重排请求；
 * - `sortSyncSeq` 让连续切档只落地最后一次回包（迟到的旧档回包丢弃）；
 * - 启动时 `appliedOrder = null`：即使还没有文档也发一次 `setOrder` 同步服务级规则，
 *   保证之后 load 的文档用对顺序；无活动根时跳过窗口 / 锚点动作。
 */
let appliedOrder: SortOrder | null = null;
let sortSyncSeq = 0;
/** 模块初始化完成后才允许读表达式视图态（applySettings 在初始化期首跑，见文件末尾显式同步）。 */
let orderSyncReady = false;

/** 切换前抓树视口锚点：顶端可见行的规范路径 + 行内像素偏移（原文视图不参与）。 */
function captureOrderAnchor(activeRoot: string | null): { path: string; offsetPx: number } | null {
  if (!activeRoot || isRawView()) return null;
  const snapshot = rowSource.snapshot();
  if (snapshot.rootId !== activeRoot || snapshot.rows.length === 0) return null;
  const rowHeight = tree.rowHeightPx();
  const scrollTopPx = tree.scrollTopPx();
  const topRow = Math.floor(scrollTopPx / rowHeight);
  const row = snapshot.rows[topRow - snapshot.start];
  if (!row) return null;
  return { path: row.path, offsetPx: scrollTopPx - topRow * rowHeight };
}

/**
 * 把 `setOrder` 回包的多根版本快照回填到所有持有者（#40 / ADR-0024 §6）：
 * 活动会话（唯一入口 `DocSession.syncRootVersion`）与活动表达式视图；存档侧统一交 `tabView.syncVersions`。
 */
function applyRootVersions(roots: readonly RootVersion[]): void {
  for (const entry of roots) {
    session.syncRootVersion(entry.rootId, entry.rowVersion, entry.totalRows);
  }
  // 活状态（文档会话存档 + 结果视图）由表达式工作区一处扇出
  expression.syncVersions(roots);
  // 存档侧（标签版本 + 非活动标签的表达式结果）统一由搬运模块扇出（#58 / ADR-0008 修订）
  tabView.syncVersions(roots);
}

/**
 * 切档后按路径还原视口（#40 全局切档 / #41 单节点覆盖共用）：
 * 有锚点 → `rowOfPath` 换算新行号 + 行内像素偏移还原；拿不到锚点或行不可见 → 显式回顶部
 * （原文视图不显示树，跳过）。`stillValid` 用于迟到回包 / 切标签守卫。
 */
async function restoreOrderAnchor(
  anchor: { path: string; offsetPx: number } | null,
  rootId: string,
  stillValid: () => boolean,
): Promise<void> {
  if (!anchor) {
    if (!isRawView()) {
      tree.scrollToPx(0);
      rowSource.scrollTo(0);
      rowSource.requestWindow();
    }
    return;
  }
  try {
    const { row } = await core.rowOfPath({ rootId, path: anchor.path });
    if (!stillValid()) return;
    const targetPx = row >= 0 ? row * tree.rowHeightPx() + anchor.offsetPx : 0;
    tree.scrollToPx(targetPx);
    rowSource.scrollTo(tree.scrollTopPx());
    rowSource.requestWindow();
  } catch {
    /* 锚点换算失败不阻断切档：保留上一帧，用户可继续滚动 */
  }
}

async function syncSortOrder(next: SortOrder): Promise<void> {
  if (next === appliedOrder) return;
  const seq = ++sortSyncSeq;
  const prevOrder = appliedOrder; // 失败回滚用（null = 首次同步）
  appliedOrder = next;
  const activeRoot = expression.activeRootId() ?? session.rootId;
  const anchor = captureOrderAnchor(activeRoot);
  try {
    const reply = await core.setOrder(next);
    if (seq !== sortSyncSeq) return; // 更晚的切档已接管：旧回包丢弃
    // 全根版本回填（docRevision 不变；rowVersion 是行映射的唯一失效令牌）
    applyRootVersions(reply.roots);
    // 大纲跟随显示序（#40 / ADR-0024 §4/§5）：重取已加载页（保留展开现场）；
    // 面板关着也要做——大纲状态随文档常驻，否则下次打开面板会看到旧顺序。
    void outlineState.refreshOrder();
    // 等待期间切了标签 / 进了表达式视图 → 显示根已变：只做版本回填，不碰当前窗口与视口
    if (!activeRoot || !isActiveDocRoot(activeRoot)) return;
    const version = reply.roots.find((entry) => entry.rootId === activeRoot);
    if (!version) return;
    // 先按新版本重取窗口（上一帧保留，防闪）；锚点行号换算后再把视口滚回原节点
    rowSource.setRoot(
      { rootId: activeRoot, rowVersion: version.rowVersion, totalRows: version.totalRows },
      {},
    );
    rowSource.requestWindow();
    await restoreOrderAnchor(anchor, activeRoot, () => seq === sortSyncSeq && isActiveDocRoot(activeRoot));
  } catch (error) {
    if (seq !== sortSyncSeq) return;
    // 失败不留「UI 新档 / core 旧档」的长期不一致：UI 与持久化回滚到上一次成功档
    // （core 这次没换挡）。回滚触发的 applySettings 会因 appliedOrder 相同而 no-op。
    appliedOrder = prevOrder;
    if (prevOrder !== null && settings.get('sortOrder') === next) settings.set('sortOrder', prevOrder);
    if (session.rootId) showStatusHint(t('app.toast.orderFailed', { detail: formatCoreError(error) }));
  }
}

/** 把当前设置落到 DOM/视图几何上（幂等；订阅变化后重放）。 */
function applySettings(): void {
  const current = settings.snapshot();
  setTheme(current.theme);
  tree.setRowHeight(current.rowHeight);
  rowSource.setMetrics(metrics());
  if (session.rootId) rowSource.requestWindow();
  // 原文视图与树共用行高（ADR-0003 修订：行高是唯一进入逻辑层的视觉参数）
  rawView.setRowHeight(current.rowHeight);
  rawSource.setMetrics(rawMetrics());
  if (session.rootId && isRawView()) rawSource.requestWindow();
  // 大纲行高跟随设置（20–26），spacer / 窗口重算在面板内部完成
  outlinePanel.setRowHeight(current.rowHeight);
  document.documentElement.style.setProperty('--row-indent', `${current.indent}px`);
  tree.setTypeColumn(current.typeColumn);
  settingsPanel.render(current);
  // 导出方式的唯一真相源是 Settings（ADR-0012 修订）：任一侧改动都经订阅回到这里
  syncExportUi();
  // 子键显示排序（#40 / ADR-0024）：内部按 appliedOrder 去重，非排序设置变化不会发重排请求。
  // 初始化期首跑不做（表达式视图态尚未就绪），由文件末尾的显式首同步接管。
  if (orderSyncReady) void syncSortOrder(current.sortOrder);
  // 界面语言（#45 / ADR-0026 §3）：设置变化 → 按需加载语言包 → 全量重渲染（异步，fire-and-forget）
  if (current.locale !== appliedLocalePref) {
    appliedLocalePref = current.locale;
    void switchLocale(current.locale);
  }
}

/** 当前生效的 locale 偏好（设置值；首跑由 applySettings 按 settings 初始化）。 */
let appliedLocalePref: LocalePref = 'auto';

/**
 * 切换界面语言（#45 / ADR-0026 §3）：加载语言包 → 换词条表 → 全量重渲染。
 * 失败 / `?lang=` 覆盖时 setLocalePref 自身会回退/覆盖，这里只负责重画。
 */
async function switchLocale(pref: LocalePref): Promise<void> {
  await setLocalePref(pref);
  rerenderChrome();
}

appliedLocalePref = settings.get('locale');
settings.subscribe(() => applySettings());
applySettings();

/* ---------------- 表达式工作区（#12 / #27 / ADR-0018；候选 6 / ADR-0008 修订 2026-11-20） ---------------- */

/**
 * 表达式的**全部会话规则**（结果视图态 / 文档会话存档 / 在途闸门 / watchdog / stale /
 * 补全 / 示例 / 原路径缓存）都在 `app/expression-workspace.ts`；这里只装配端口。
 * `rowSource` 是每标签可换的 adapter，端口必须动态取；其余（panel / bar / session / tree / core）是单实例。
 */
const EXPR_WATCHDOG_FLAG = 'tjv.expr.watchdog';

const expressionBar = new ExpressionBar(exprBarRoot);

const expressionPanel = new ExpressionPanel(expressionHost, {
  onRun: (text, strict) => {
    void expression.run(text, strict);
  },
  onComplete: (text, pos) => expression.completions(text, pos),
  onTextChange: () => {
    // 输入变化即清旧错误（不让上一次的行内错误误导）
    expressionPanel.setError(null);
  },
  onStrictChange: () => {
    /* 严格模式是会话级、面板自持；执行时从面板读 */
  },
});

const expression: ExpressionWorkspace = new ExpressionWorkspace({
  panel: expressionPanel,
  bar: expressionBar,
  session,
  rows: {
    setRoot: (next, opts) => rowSource.setRoot(next, opts),
    requestWindow: () => rowSource.requestWindow(),
    snapshot: () => rowSource.snapshot(),
  },
  tree,
  core,
  view: {
    land: (plan) => applyLanding(plan),
    select: (path) => setSelection(path),
    syncLocateRaw: () => syncLocateRaw(),
    updateStatus: () => updateStatus(),
    focusTree: () => focusTree(),
    isRaw: () => isRawView(),
    setTreeMode: () => {
      void setViewMode('tree');
    },
    setDocPanel: () => setPanel('doc'),
    jumpToPath: (path) => jumpToPath(path),
    selected: () => selected,
  },
  budget: () => settings.get('advBudget'),
  terminate: () => {
    try {
      workerCore.close();
    } catch {
      /* 已死 */
    }
  },
  toast: (text, ms, kind) => showToast(text, ms, kind),
  error: (error) => showError(error),
  watchdogFlag: EXPR_WATCHDOG_FLAG,
  reload: () => location.reload(),
});

expressionBar.onBack(() => {
  expression.back();
  setPanel('doc');
});
expressionBar.onRerun(() => {
  void expression.rerun();
});
expressionBar.onClose(() => {
  // 结果视图没有「只关条」的语义（关掉条会让人以为结果消失了）→ 等价「返回文档树」
  expression.back();
  setPanel('doc');
});


/* ---------------- 文档概要（#43 / ADR-0025 §7–§8）：按需采样 + 惰性失效 ---------------- */

/**
 * 右栏「文档概要」状态（只活在活动标签会话：不持久化、不跨标签缓存，ADR-0025 §8）。
 * - `rootId + docRevision` 是回包校验键：切标签 / 换文档 / 编辑推进版本后的迟到回包一律丢弃；
 * - profile 本体只在 ready 时持有（不常驻大对象；worker 侧按 (rootId, docRevision) 缓存）。
 */
let profileView: ProfilePanelState = { status: 'idle' };
let profileRootId: string | null = null;
let profileDocRev = 0;
/** 采样代次：清空 / 失效 / 重新触发都递增，迟到回包按代次丢弃（与 fidelitySeq 同口径）。 */
let profileSeq = 0;

/** 概要描述的目标 = **文档根**（表达式结果视图下也不采 expr 根；ADR-0025 §7）。 */
function profileTarget(): { rootId: string; docRevision: number } | null {
  const rootId = expression.documentRootId();
  return rootId ? { rootId, docRevision: expression.documentRevision() } : null;
}

function renderProfile(): void {
  renderProfilePanel(profilePanel, profileView);
}

/** 清空概要（切标签 / 换文档 / 回空态 / 采样失败）：不重采，等下次触发。 */
function clearProfile(): void {
  profileSeq += 1;
  profileRootId = null;
  profileDocRev = 0;
  profileView = { status: 'idle' };
  renderProfile();
}

/** 文档已修改（docRevision 推进）：清空 + 「概要待更新」，**不自动重采**（ADR-0025 §8）。 */
function staleProfile(): void {
  if (profileView.status === 'idle' || profileDocRev === expression.documentRevision()) return;
  profileSeq += 1;
  profileDocRev = expression.documentRevision();
  profileView = { status: 'stale' };
  renderProfile();
}

/**
 * 按需触发一次采样（ADR-0025 §2）：导入 / 切标签后的首帧之后、右栏由折叠展开、
 * 或首次进表达式模式（`force` = 右栏折叠也要采，补全需要）时调用。
 * 实际 `core.profile` 调用推迟到 `requestIdleCallback`（无则 `setTimeout 0`），导入路径零新增成本。
 */
function scheduleProfile(force = false): void {
  const target = profileTarget();
  if (!target || (!force && document.body.classList.contains('rail-collapsed'))) return;
  // 同一目标已在途 / 已就绪：不重复调度（编辑失效后状态是 stale，会正常重采）
  if (
    (profileView.status === 'loading' || profileView.status === 'ready') &&
    profileRootId === target.rootId &&
    profileDocRev === target.docRevision
  ) {
    return;
  }
  const seq = ++profileSeq;
  profileRootId = target.rootId;
  profileDocRev = target.docRevision;
  profileView = { status: 'loading' };
  renderProfile();
  const stillValid = (): boolean => {
    const now = profileTarget();
    return seq === profileSeq && now !== null && now.rootId === target.rootId && now.docRevision === target.docRevision;
  };
  const run = (): void => {
    if (!stillValid()) return;
    void core
      .profile(target.rootId)
      .then((profile) => {
        if (!stillValid()) return;
        profileView = { status: 'ready', profile };
        renderProfile();
      })
      .catch(() => {
        // 采样失败属辅助功能降级（根已换 / 取消是正常竞态）：回空态，下次触发再试
        if (!stillValid()) return;
        profileView = { status: 'idle' };
        renderProfile();
      });
  };
  const idle = (
    window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 2000 });
  else window.setTimeout(run, 0);
}

/* ---------------- import layer（文档入口层） ---------------- */

/** 当前能否开新标签（空工作区允许建第一个；#18 软上限 8）。 */
function canOpenNewTab(): boolean {
  return workspace.activeId === null || workspace.view().canAdd;
}

/** 策略只读这一份环境快照（打开层时取一次；状态机不读外部状态）。 */
function layerContext(): LayerContext {
  const tab = activeTab();
  return {
    hasDoc: Boolean(session.rootId),
    importTarget: settings.get('importTarget'),
    canAddTab: canOpenNewTab(),
    maxTabs: workspace.max,
    currentDoc: tab ? { name: tab.name, bytes: tab.meta.bytes } : null,
  };
}

/**
 * 导入入口层：状态机在 `./import/layer-state`（纯策略），DOM / 动效 / 焦点在
 * `./import/layer`（adapter）。外部入口（导入按钮 / file chip / ⌘O / 拖放 / 粘贴）
 * 仍在本文件——它们还要管「初始空态直接导入」「拖放落点分流」这些不属于层的事。
 */
const importLayer = new ImportLayer({
  dom: {
    root: empty,
    inner: emptyInner,
    title: emptyTitle,
    sub: emptySub,
    warn: emptyWarn,
    hint: emptyHint,
    target: emptyTarget,
    targetNewTab,
    targetReplace,
    close: emptyClose,
    pending: emptyPending,
    pendingText: emptyPendingText,
    pendingNewTab,
    pendingReplace,
    busy: emptyBusy,
    error: emptyError,
    pick: pickBtn,
    focusReturn: importBtn,
  },
  env: {
    t,
    formatBytes,
    formatError: formatCoreError,
    context: layerContext,
    canAddTab: canOpenNewTab,
    maxTabs: () => workspace.max,
  },
  actions: {
    onBeforeClose: () => {
      if (importLayer.isBusy()) loadSeq += 1;
    },
    onImport: (payload, target) => {
      if (payload.kind === 'file') void importFile(payload.file, target);
      else void importBuffer('paste', payload.text, payload.name, target);
    },
    confirmDiscard: confirmDiscardEdits,
    onLimitDenied: () => showToast(t('app.tabs.limit', { n: workspace.max }), 3000, 'error'),
  },
});

/* ---------------- import ---------------- */

/**
 * 本次导入应落到哪里：空工作区建第一个标签；完整层「新标签」形态 → 新增；
 * 精简确认层 / 替换层 → 替换当前；层关闭时回落设置「导入位置」（#47 #1）。
 */
function currentImportTarget(): ImportTarget {
  if (!workspace.activeId) return 'new-tab';
  if (importLayer.isOpen()) return importLayer.mode() === 'new-tab' ? 'new-tab' : 'replace';
  return settings.get('importTarget');
}

async function importBuffer(
  source: 'file' | 'paste' | 'clipboard',
  data: ArrayBuffer | string,
  name: string,
  target?: 'replace' | 'new-tab',
): Promise<void> {
  const resolvedTarget = target ?? currentImportTarget();
  // 软上限在**解析前**判：满 8 个时不要先把 50MB 解析完再拒绝。
  // 注意空工作区的 canAdd 也是 false（activeId=null），第一个标签必须放行。
  if (resolvedTarget === 'new-tab' && workspace.activeId !== null && !workspace.view().canAdd) {
    showToast(t('app.tabs.limit', { n: workspace.max }), 3000, 'error');
    return;
  }
  const loadId = ++loadSeq;
  const inLayer = importLayer.isOpen();
  if (inLayer) {
    importLayer.setError(null);
    importLayer.setBusy(true);
  }
  try {
    const reply = await core.load({
      loadId,
      source,
      data,
      name,
      // ADR-0011 §1/§5：设置关闭修复/自适应时按偏好导入
      opts: { repair: settings.get('repairTruncated'), adaptiveExpand: settings.get('adaptiveExpand') },
    });
    if (loadId !== loadSeq) {
      // 回包已被更新的导入 / 关闭入口层作废：Worker 已经建好新根，必须释放，否则孤儿根泄漏
      void core.closeRoot(reply.rootId).catch(() => undefined);
      return;
    }
    onLoaded(reply, resolvedTarget);
  } catch (error) {
    if (loadId !== loadSeq) return;
    if (CoreError.from(error).code === 'CANCELLED') return;
    if (inLayer) {
      importLayer.setError(CoreError.from(error));
      importLayer.setBusy(false);
    } else {
      showError(error);
    }
  }
}

async function importFile(file: File, target?: 'replace' | 'new-tab'): Promise<void> {
  const buffer = await file.arrayBuffer();
  await importBuffer('file', buffer, file.name || 'document.json', target);
}

/**
 * 替换标签前的状态复位（复用 runtime，但上一份文档的搜索/编辑/原文/反馈都要清干净）。
 * 新标签不需要（runtime 是新建的，存档由 `WorkspaceState.add` 初始化）。
 */
function resetTabStateForNewDoc(tab: TabState): void {
  tab.runtime.searchState.begin('', searchOpts);
  tab.runtime.editState.clear();
  tab.runtime.rawSource.clear();
  // 视图存档已由 `workspace.replace` 就地复位（换文档 = 上一份作废，见 WorkspaceState.replace）
  rawOpenSeq += 1;
  fidelitySeq += 1;
  fidelityPending = false;
  expression.cancel();
}

/**
 * 一次 load 回包落到工作区（#18 / ADR-0009 §4–§5）：
 * - `new-tab`：新增标签并激活（新 runtime 天然干净）；
 * - `replace`：替换活动标签的根（保留标签 id / runtime；**先成功 load 再 closeRoot 旧根**，
 *   这样新文档解析失败时原标签不会被掏空）。
 * 之后统一按新文档重画：版本落地 / 提示条 / 搜索 / 大纲 / 原文 / 表达式示例 / 视图模式。
 */
function onLoaded(reply: LoadReply, target: 'replace' | 'new-tab'): void {
  const input: TabInput = {
    rootId: reply.rootId,
    name: reply.meta.name,
    bytes: reply.meta.bytes,
    meta: reply.meta,
    docRevision: reply.docRevision,
    rowVersion: reply.rowVersion,
    totalRows: reply.totalRows,
  };
  const active = workspace.active();
  const replaceTarget = target === 'replace' ? active : null;
  // 0) 表达式结果视图是临时换根：先回文档树，否则下面 tabView.capture() 会把 expr 根的
  //    rowVersion/totalRows/selected 当成文档版本存进标签（切回来 STALE_ROOT + 行数错）
  if (expression.active) expression.back({ silent: true });
  // 1) 切走前存档当前活动标签（版本字段 / 选中 / 滚动）
  if (active) tabView.capture();
  const oldRootId = replaceTarget?.rootId ?? null;

  // 2) 会话落地（document 意图：换版本 + 回顶 + 清选中）
  const plan = session.land(reply, { kind: 'document' });

  // 3) 绑定标签（替换保留 id/runtime；新标签新建 runtime）
  const tab = replaceTarget ? workspace.replace(replaceTarget.id, input) : workspace.add(input);
  if (!tab) {
    // 兜底：软上限在 UI 已禁用；真发生则释放刚建的根，工作区保持不变
    void core.closeRoot(reply.rootId).catch(() => undefined);
    importLayer.hide();
    showToast(t('app.tabs.limitNoOpen', { n: workspace.max }), 3000, 'error');
    return;
  }
  workspace.activate(tab.id);
  // 4) 替换场景：复用 runtime，但必须清掉上一份文档的全部状态
  if (replaceTarget) resetTabStateForNewDoc(tab);
  bindTab(tab);
  editingPath = null;
  subtreeEditor.close();

  // 5) 旧根释放（幂等；失败不影响新文档）
  if (oldRootId !== null && oldRootId !== reply.rootId) {
    void core.closeRoot(oldRootId).catch(() => undefined);
  }

  // 6) 视图重画
  importLayer.hide();
  renderTabChrome();
  applyLanding(plan);
  rowSource.setMetrics(metrics());
  rowSource.requestWindow();
  resetSearch();
  // 新文档：重置大纲并加载根页（面板此刻可能未打开，数据先备好）
  void outlineState.open(reply.rootId);
  setPanel('doc');
  // 新文档：表达式示例按新顶层字段重算（面板未打开也先备好）
  expression.refreshExamples();
  focusTree();
  void setViewMode(settings.uiState().viewMode === 'raw' ? 'raw' : 'tree', { persist: false });
  // 保真扫描按新根重排（resetFidelity 递增 seq 丢弃旧在途），再调度首帧后扫描
  resetFidelity();
  scheduleFidelityScan();
  // 文档概要（#43 / ADR-0025 §2）：换文档后首帧之后按需采样（右栏未折叠才调度）
  clearProfile();
  scheduleProfile();
  maybeShowWorkspaceMemoryHint(tab);
}

/**
 * 粘贴目标是输入控件时不劫持：让浏览器把文本粘进输入框（搜索框等）。
 * 否则全局「粘贴即导入 JSON」会把在搜索框里 ⌘V 一个 key 变成一次 PARSE 导入。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  const node = target instanceof HTMLElement ? target : null;
  if (!node) return false;
  if (node.isContentEditable) return true;
  return Boolean(
    node.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'),
  );
}

document.addEventListener('paste', (event: ClipboardEvent) => {
  if (isEditableTarget(event.target)) return;
  if (importLayer.isBusy()) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text || !text.trim()) return;
  if (!session.rootId) {
    // 初始空态：粘贴 = 打开文档
    event.preventDefault();
    void importBuffer('paste', text, t('app.clipboardFile'));
    return;
  }
  // 文档已打开（#47 #2）：层关闭时 ⌘V = 先弹**精简确认层**，确认后才覆盖当前页；
  // 完整层内粘贴仍是「层内即确认」（ADR-0004），落点由层形态决定。确认层已打开则忽略重复粘贴。
  const mode = importLayer.isOpen() ? importLayer.mode() : 'initial';
  if (mode === 'pending') return;
  event.preventDefault();
  if (mode === 'initial') {
    importLayer.openPending({ kind: 'text', text, name: t('app.clipboardFile') });
    return;
  }
  void importBuffer('paste', text, t('app.clipboardFile'));
});

window.addEventListener('dragover', (event: DragEvent) => {
  event.preventDefault();
});
window.addEventListener('drop', (event: DragEvent) => {
  event.preventDefault();
  if (importLayer.isBusy()) return;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!session.rootId) {
    // 初始空态：直接导入（建第一个标签）
    void importFile(file);
    return;
  }
  // 拖放按落点分流（ADR-0009 §5）：标签条空白 = 新标签；文档视图 = 替换当前标签（暂存确认）。
  // 注意 event.target 可能是 document / text 节点等非元素，不能直接 .closest（会抛 TypeError）。
  const target = event.target;
  const inTabStrip = target instanceof Element && target.closest('#tabStrip') !== null;
  if (inTabStrip) {
    void importFile(file, 'new-tab');
    return;
  }
  if (importLayer.isOpen() && importLayer.mode() !== 'initial') {
    // 完整层内拖放：层本身即确认（Q9-A），立即导入（落点由层形态决定）；
    // 精简确认层已打开时忽略重复拖入（保持第一份待确认数据）。
    if (importLayer.mode() !== 'pending') void importFile(file);
    return;
  }
  // 文档视图内拖放（#47 #2）：打开**精简确认层**，两个落点由用户当场选
  importLayer.openPending({ kind: 'file', file });
});

importBtn.addEventListener('click', () => {
  if (session.rootId) importLayer.open();
  else fileInput.click();
});
pickBtn.addEventListener('click', () => fileInput.click());
// 拖放区空白处点击 = 「选择文件」（鼠标便利路径；键盘入口仍是内层 #pickBtn，
// 容器自身不声明 button 语义）。点在 #pickBtn 上时由它自己处理，避免弹两次选择框。
dropzone.addEventListener('click', (event: MouseEvent) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button')) return;
  if (!pickBtn.disabled) fileInput.click();
});
fileChip.addEventListener('click', () => {
  if (session.rootId) importLayer.open();
  else fileInput.click();
});
// 层内交互（关闭 / 遮罩 / 落点 radio / pending 两个按钮 / 出场收尾）由 ./import/layer 接线
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void importFile(file);
  fileInput.value = '';
});

expandAllBtn.addEventListener('click', () => {
  void applyExpandAll(true);
});
collapseAllBtn.addEventListener('click', () => {
  void applyExpandAll(false);
});
viewTreeBtn.addEventListener('click', () => {
  void setViewMode('tree');
});
viewRawBtn.addEventListener('click', () => {
  void setViewMode('raw');
});
rawCopyBtn.addEventListener('click', () => {
  void copyRawSource();
});

exportBtn.addEventListener('click', () => {
  void runExportMode(currentExportMode());
});
exportMenuBtn.addEventListener('click', () => {
  if (exportMenuController.isOpen) exportMenuController.close('programmatic');
  else openExportMenu();
});
editBadge.addEventListener('click', () => {
  void resetEdits();
});
repairToggle.addEventListener('click', () => {
  const open = repairOps.hidden;
  repairOps.hidden = !open;
  repairToggle.setAttribute('aria-expanded', String(open));
});
repairClose.addEventListener('click', () => {
  // 只关提示条：provenance 仍留在 meta 上（状态栏角标 + 导出后缀继续生效）
  repairBar.hidden = true;
});
// 保真提示条（#23 / #31 修订）：主点击 / 上一处 / 下一处 = 跳对应失真行（与修复摘要 at 同链路）；
// 关闭只关条（报告保留，组件内处理）
fidelityNotice.onAction(() => {
  jumpFidelityHit(fidelityIndex);
});
fidelityPrev.addEventListener('click', () => {
  stepFidelityHit(-1);
});
fidelityNext.addEventListener('click', () => {
  stepFidelityHit(1);
});
// 修复摘要的 `at` → 跳到原文对应行（#8 / ADR-0003 修订 §5）
repairOps.addEventListener('click', (event: MouseEvent) => {
  const at = (event.target as HTMLElement | null)?.closest<HTMLElement>('.repairbar__at');
  if (!at) return;
  const offset = Number(at.dataset.at);
  if (!Number.isFinite(offset)) return;
  void revealRepairOffset(offset);
});
/* ---------------- tree intents ---------------- */

async function toggleNode(path: string, open: boolean): Promise<void> {
  if (!session.rootId) return;
  try {
    const reply = await core.toggle({ rootId: session.rootId, path, open });
    if (!isActiveDocRoot(reply.rootId)) return;
    applyLanding(session.land(reply, { kind: 'toggle' }));
  } catch (error) {
    showError(error);
  }
}

/**
 * 子树批量展开 / 收起（#22 / ADR-0002 修订 / ADR-0010 修订）：
 * core 负责语义与预算（`toggleSubtree`，超 `ROW_BUDGET` 抛 `TOO_MANY_ROWS` 且零部分修改）；
 * app 只做「换版本 + 重取窗口 + 反馈」。
 *
 * 与 `applyExpandAll` 的关键差异：**不滚回顶部**——右键点的那一行就在视口里，
 * 展开/收起只改变它下方的行，锚点（顶部行）内容不变，直接 `setRoot` 保持 scrollTop 即可。
 * no-op（已全展开/已全收起）用 `rowVersion` 是否变化判定，给中性 info toast（与 #9 同口径）。
 */
async function toggleSubtree(path: string, open: boolean): Promise<void> {
  if (!session.rootId) return;
  // 树动作：原文视图下先切回树（与「全部展开 / 收起」一致）
  if (isRawView()) await setViewMode('tree');
  try {
    // no-op 判据统一来自落地计划（rowVersion 是否真的推进），不再手抄 rowVersionBefore
    const reply = await core.toggleSubtree({ rootId: session.rootId, path, open });
    if (!isActiveDocRoot(reply.rootId)) return;
    const plan = session.land(reply, { kind: 'subtree' });
    if (!plan.changed) {
      showToast(t(open ? 'app.toast.subtreeExpanded' : 'app.toast.subtreeCollapsed'), 1800, 'info');
      return;
    }
    // 命中集按路径仍然有效（docRevision 未变），但新出现的行要重新带上命中标记（在 executor 内）
    applyLanding(plan);
  } catch (error) {
    showError(error);
  }
}

/**
 * 单节点子键排序覆盖（#41 / ADR-0024 修订 v1.1）：右键菜单三项 → `core.setNodeOrder`。
 *
 * - 覆盖只影响该节点的**直接子键**（不向下继承），且优先于全局设置；「恢复全局排序」传 null 清除；
 * - 覆盖是标签会话态（core 侧 WeakMap）：换文档 / 关标签丢弃，编辑替换后自动失效；
 * - 行序变化走 `{ kind: 'order' }` 落地（滚动策略 keep），再用与 #40 切档同口径的
 *   `captureOrderAnchor` + `rowOfPath` 按路径还原视口；拿不到锚点则显式回顶部；
 * - 大纲按容器生效顺序刷新（`outlineState.refreshOrder`），搜索结果高亮按路径天然正确（不重跑）。
 */
async function setNodeOrder(
  path: string,
  action: { order: SortOrder | null; done: MessageKey; noop: MessageKey },
): Promise<void> {
  if (!session.rootId) return;
  // 树动作：原文视图下先切回树（与 toggleSubtree 一致）
  if (isRawView()) await setViewMode('tree');
  const anchor = captureOrderAnchor(session.rootId);
  try {
    const reply = await core.setNodeOrder({ rootId: session.rootId, path, order: action.order });
    if (!isActiveDocRoot(reply.rootId)) return;
    // no-op 判据统一来自落地计划（rowVersion 是否真的推进；回包 EditReply 无 changed 字段）
    const plan = session.land(reply, { kind: 'order' });
    if (!plan.changed) {
      showToast(t(action.noop), 1800, 'info');
      return;
    }
    applyLanding(plan);
    void outlineState.refreshOrder();
    await restoreOrderAnchor(anchor, reply.rootId, () => isActiveDocRoot(reply.rootId));
    showToast(t(action.done), 2000, 'success');
  } catch (error) {
    showError(error);
  }
}

/**
 * 全部展开 / 全部收起（#9 / ADR-0002 修订）。
 * 预算护栏在 core（超 ROW_BUDGET 抛 TOO_MANY_ROWS，零部分修改）；失败走 toast。
 * Q7：成功后滚回顶部，选中路径保留、不强行滚动到选中行。
 *
 * 防重入用内部锁**不动按钮禁用态**：两个按钮共享一次命令，改成 disabled 会让它们
 * 一起灰一下（opacity .45）——用户反馈这就是「按钮闪」；视觉上保持稳定。
 */
let expandAllBusy = false;

async function applyExpandAll(open: boolean): Promise<void> {
  if (!session.rootId || expandAllBusy) return;
  // 展开/收起是树动作：原文视图下先切回树（按钮保持可用，不靠禁用态说话）
  if (isRawView()) await setViewMode('tree');
  expandAllBusy = true;
  try {
    // #9 收口：已是目标状态（core no-op → 不推进 rowVersion）时给一句中性反馈，
    // 不做无意义的换版本/回顶/重取窗口——此前点了完全没反应。
    // 判定口径 = 落地计划的 changed（core 只在 changed 时 rowVersion++，不额外加协议字段）。
    const reply = open ? await core.expandAll(session.rootId) : await core.collapseAll(session.rootId);
    if (!isActiveDocRoot(reply.rootId)) return;
    const plan = session.land(reply, { kind: 'expandAll' });
    if (!plan.changed) {
      showToast(t(open ? 'app.toast.allExpanded' : 'app.toast.allCollapsed'), 1800, 'info');
      return;
    }
    // 回顶与换版本同一拍完成（plan.scroll = top，executor 用 setRoot 的 scrollTopPx）：
    // 避免「旧 start 的保留帧被新 totalRows 裁到视口外」（空白帧）与 1 行闪帧。
    applyLanding(plan);
  } catch (error) {
    showError(error);
  } finally {
    expandAllBusy = false;
  }
}

/* ---------------- 编辑（slice 5 / #16 / ADR-0006） ---------------- */

const CHANGED_FLASH_MS = 900;

function renderEditBadge(): void {
  const count = editState.count;
  editBadge.hidden = count === 0;
  editBadge.textContent = t('app.edit.badge', { n: count });
  editBadge.classList.toggle('is-dirty', count > 0);
  syncExportUi();
  renderRawChrome();
}

/** 替换文档会丢弃临时修改：有修改时先确认（edit-spec §5）。 */
function confirmDiscardEdits(): boolean {
  if (!editState.dirty) return true;
  return window.confirm(t('app.confirm.discardEdits', { n: editState.count }));
}

function confirmReset(): boolean {
  if (!editState.dirty) return false;
  return window.confirm(t('app.confirm.resetEdits', { n: editState.count }));
}

/**
 * 编辑命令回包统一应用：版本/行数 + 窗口重取 + 锚点换算（edit-spec §4.4）
 * + 选中与短暂高亮 + 修改计数。search stale 由调用方按需补。
 */
function applyModelReply(reply: EditReply): void {
  if (!session.rootId || !isActiveDocRoot(reply.rootId)) return;
  // 锚点必须在换根前记录（edit-spec §4.4）；滚动策略与编辑类附加动作在 landing 内统一
  applyLanding(session.land(reply, { kind: 'edit' }, { anchor: rowSource.anchor() }));
}

/** 文档已修改：清空搜索命中并提示重搜（edit-spec §6）。 */
function markSearchStale(): boolean {
  const changed = searchState.markStale();
  applySearchToTree();
  renderSearch();
  return changed;
}

async function openEditor(path: string): Promise<void> {
  // 表达式结果只读（ADR-0018 §1）：结果根不是文档，禁编辑入口（F2 / 右键「编辑」）
  if (expression.active) {
    showToast(EXPR_COPY.readonly, 2000, 'error');
    return;
  }
  if (!session.rootId || subtreeEditor.isOpen()) return;
  const rootId = session.rootId;
  try {
    const reply = await core.getNodeJson({ rootId, path });
    // 在途期间切了标签 / 换了文档：不再打开编辑器（否则会把旧文档的 path 用到新文档）
    if (rootId !== session.rootId || !isActiveDocRoot(rootId)) return;
    editingPath = path;
    editingRootId = rootId;
    await subtreeEditor.open({
      path,
      kind: reply.kind ?? 'object',
      bytes: reply.bytes,
      text: reply.text,
      readOnly: false,
    });
  } catch (error) {
    const coreError = CoreError.from(error);
    // 超过 5MB：只读提示、不打开编辑器（edit-spec §7）
    if (coreError.code === 'TOO_LARGE') {
      showError(
        new CoreError({
          code: 'TOO_LARGE',
          message: t('app.toast.subtreeTooLargeEdit', { size: formatBytes(coreError.bytes ?? 0) }),
        }),
      );
      return;
    }
    showError(error);
  }
}

async function applyEditText(text: string): Promise<void> {
  const rootId = editingRootId;
  if (!session.rootId || !editingPath || rootId === null) return;
  // 编辑器打开后换了标签 / 文档：拒绝写入（同一 path 在新文档里可能真的存在，core 拦不住）
  if (rootId !== session.rootId || !isActiveDocRoot(rootId)) {
    subtreeEditor.close();
    editingPath = null;
    editingRootId = null;
    showToast(t('app.toast.docSwitched'), 3000, 'error');
    return;
  }
  const path = editingPath;
  subtreeEditor.setError(null);
  subtreeEditor.setBusy(true);
  try {
    const reply = await core.replaceNode({ rootId, path, docRevision: session.docRevision, jsonText: text });
    // 搜索 stale / 大纲刷新已在 applyLanding（edit 意图的 landing 计划）内统一
    applyModelReply(reply);
    subtreeEditor.close();
    editingPath = null;
    editingRootId = null;
  } catch (error) {
    const coreError = CoreError.from(error);
    subtreeEditor.setError({ message: coreError.message, line: coreError.line, column: coreError.column });
  } finally {
    subtreeEditor.setBusy(false);
  }
}

async function undoEdit(): Promise<boolean> {
  if (expression.active) return false;
  if (!session.rootId) return false;
  try {
    const reply = await core.undo(session.rootId);
    // 搜索 stale / 大纲刷新已在 applyLanding（edit 意图的 landing 计划）内统一
    applyModelReply(reply);
    return true;
  } catch (error) {
    if (CoreError.from(error).code === 'NO_HISTORY') return false;
    showError(error);
    return false;
  }
}

async function redoEdit(): Promise<boolean> {
  if (expression.active) return false;
  if (!session.rootId) return false;
  try {
    const reply = await core.redo(session.rootId);
    // 搜索 stale / 大纲刷新已在 applyLanding（edit 意图的 landing 计划）内统一
    applyModelReply(reply);
    return true;
  } catch (error) {
    if (CoreError.from(error).code === 'NO_HISTORY') return false;
    showError(error);
    return false;
  }
}

/** 重置全部临时修改（反向撤销到打开时状态）；skipConfirm 供 dev hook 用。 */
async function resetEdits(skipConfirm = false): Promise<boolean> {
  if (expression.active) return false;
  if (!session.rootId || !editState.dirty) return false;
  if (!skipConfirm && !confirmReset()) return false;
  try {
    const reply = await core.reset(session.rootId);
    // 搜索 stale / 大纲刷新已在 applyLanding（edit 意图的 landing 计划）内统一
    applyModelReply(reply);
    return true;
  } catch (error) {
    if (CoreError.from(error).code !== 'NO_HISTORY') showError(error);
    return false;
  }
}

/* ---------------- 导出（ADR-0012）：下载文件 / 复制到剪贴板 分体按钮 ---------------- */

/** 当前显示名（标签名；改名只改页面侧显示，`meta.name` 保留导入原名，ADR-0021）。 */
function currentBaseName(): string | null {
  const tab = activeTab();
  return tab?.name ?? meta?.name ?? null;
}

/** 本次导出的后缀判据（签发一次，导出与预填名共用同一份）。 */
function currentNameFlags(): ExportNameFlags {
  return {
    edited: editState.dirty,
    repaired: meta?.repair?.status === 'repaired',
  };
}

/** 当前导出文件名：表达式结果视图导出 = 「文档名」-expr-N.json（与文档导出区分，ADR-0018 §4）。 */
function currentExportName(): string | null {
  const base = currentBaseName();
  if (base === null) return null;
  const resultRoot = expression.activeRootId();
  if (resultRoot !== null) return exprExportFileName(base, resultRoot);
  return exportFileName(base, currentNameFlags());
}

/** 系统「另存为」返回的最小句柄形状（File System Access API 的局部声明，避免 lib.dom 版本差异）。 */
interface SaveFileHandleLike {
  readonly name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
type SavePickerLike = (options: {
  suggestedName?: string;
  types?: { description?: string; accept?: Record<string, string[]> }[];
}) => Promise<SaveFileHandleLike>;

/** 有 File System Access API 时返回绑定好的 picker（真机扩展页实测可用；无则回落普通下载）。 */
function saveFilePicker(): SavePickerLike | null {
  const api = (window as unknown as { showSaveFilePicker?: SavePickerLike }).showSaveFilePicker;
  return typeof api === 'function' ? api.bind(window) : null;
}

/** 回落路径（无 File System Access API）：Blob + `<a download>`，文件名已在调用前定死。 */
function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 写显示名并刷新chrome（两处改名入口共用）：无名变化/未知标签时 no-op。 */
function writeDocName(tabId: string, name: string): void {
  const tab = workspace.get(tabId);
  if (!tab || name === '' || name === tab.name) return;
  workspace.update(tabId, { name });
  if (workspace.activeId === tabId) renderTabChrome();
}

/**
 * 标签改名（双击标题 / F2 入口）：清洗 → 写 `TabState.name`；
 * 空串（用户全删）= 保持原名；原名 `meta.name` 不动（只用于悬停追溯与导入语义）。
 */
function applyDocRename(tabId: string, raw: string): void {
  writeDocName(tabId, sanitizeDocName(raw));
}

/**
 * 系统「另存为」保存后：按最终文件名反推基名，写回标签显示名（ADR-0021）。
 * 表达式结果视图的导出是**一次性文件名**（结果根是派生视图），不回写文档名。
 */
function applyExportName(
  tabId: string | null,
  finalName: string,
  prefillName: string,
  flags: ExportNameFlags,
  oneOff: boolean,
): void {
  if (oneOff || tabId === null) return;
  const base = renameFromExport(finalName, prefillName, flags);
  if (base !== null) writeDocName(tabId, base);
}

/**
 * 文件导出（ADR-0012 / ADR-0021，2026-11-12 修订）：先弹系统「另存为」——预填默认名
 * （含 `-edited` / `-truncated-repaired` 后缀）、可改名字与保存位置，确认后才写入；
 * 取消 = 不导出、不改名、零副作用。无 FSA（或被环境/策略拒绝）时回落普通下载，
 * 无确认框、如实记录。
 */
async function exportDoc(): Promise<void> {
  if (!session.rootId || !meta) return;
  // 文件名必须在 await 前定：导出期间切标签会用新标签的名字命名旧内容
  const name = currentExportName();
  if (name === null) return;
  const tabId = activeTab()?.id ?? null;
  const flags = currentNameFlags();
  const oneOff = expression.view !== null && expression.active;
  const rootId = session.rootId;
  setExportButtonsDisabled(true);
  try {
    const picker = saveFilePicker();
    if (!picker) {
      const { text, bytes } = await core.exportDoc(rootId, settings.get('jsonIndent'), settings.get('escapeUnicode'));
      downloadText(name, text);
      exportLastAction = { mode: 'file', name, bytes };
      return;
    }
    let handle: SaveFileHandleLike | null = null;
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
    } catch (error) {
      // 用户取消系统对话框：零副作用（不导出、不改名、不报错）
      if ((error as { name?: string } | null)?.name === 'AbortError') return;
      // API 存在但被环境/企业策略拒绝：回落普通下载，导出不中断（如实记录在 ADR）
    }
    const { text, bytes } = await core.exportDoc(rootId, settings.get('jsonIndent'), settings.get('escapeUnicode'));
    if (!handle) {
      downloadText(name, text);
      exportLastAction = { mode: 'file', name, bytes };
      return;
    }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    exportLastAction = { mode: 'file', name: handle.name, bytes };
    applyExportName(tabId, handle.name, name, flags, oneOff);
  } catch (error) {
    showError(error);
  } finally {
    setExportButtonsDisabled(false);
  }
}

/** 上次执行的导出动作（dev hook / 验收用；不保留文本） */
let exportLastAction: { mode: ExportMode; name?: string; bytes?: number; copied?: boolean } | null = null;

function exportMenuItems(): HTMLButtonElement[] {
  return Array.from(exportMenu.querySelectorAll<HTMLButtonElement>('[data-export-mode]'));
}

function setExportButtonsDisabled(disabled: boolean): void {
  exportBtn.disabled = disabled;
  exportMenuBtn.disabled = disabled;
}

function currentExportMode(): ExportMode {
  return settings.get('exportMode');
}

/** 同步主按钮文案与菜单勾选（方式变化 / 临时修改计数变化时调用）。 */
function syncExportUi(): void {
  const mode = currentExportMode();
  const base = t(mode === 'file' ? 'app.export.mode.file' : 'app.export.mode.clipboard');
  const hint = editState.dirty ? t('app.export.edited') : '';
  exportBtn.title = `${base}${hint}`;
  exportBtn.setAttribute('aria-label', `${base}${hint}`);
  for (const item of exportMenuItems()) {
    const checked = item.dataset.exportMode === mode;
    item.setAttribute('aria-checked', String(checked));
    const check = item.querySelector<HTMLElement>('.exportmenu__check');
    if (check) check.textContent = checked ? '✓' : '';
  }
}

/**
 * 导出方式菜单控制器（ADR-0015）：定位/键盘/外部关闭/焦点归还收口到 `view/menu`。
 * 选中项后焦点归还放在动作完成之后：导出期间两个按钮被 disabled（不可聚焦），
 * 动作结束、按钮恢复后再把焦点还给箭头按钮；只有焦点确实掉到 body 时才归还，避免抢用户中途点的位置。
 */
const exportMenuController = createMenu({
  element: exportMenu,
  itemSelector: '[data-export-mode]',
  trigger: exportMenuBtn,
  onSelect: (item) => {
    const mode = normalizeExportMode(item.dataset.exportMode);
    rememberExportMode(mode);
    void runExportMode(mode).finally(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) exportMenuBtn.focus();
    });
  },
});

function openExportMenu(): void {
  if (exportMenuBtn.disabled) return;
  const items = exportMenuItems();
  const preferred = items.find((item) => item.dataset.exportMode === currentExportMode()) ?? items[0] ?? null;
  exportMenuController.open(
    { kind: 'rect', rect: exportMenuBtn.getBoundingClientRect(), align: 'end' },
    preferred,
  );
}

/** 记住本次方式（写穿 Settings，持久化；订阅会触发 applySettings → 面板回显 + 按钮/勾选同步）。 */
function rememberExportMode(mode: ExportMode): void {
  settings.set('exportMode', mode);
}

async function runExportMode(mode: ExportMode): Promise<void> {
  if (mode === 'clipboard') await copyDocJson();
  else await exportDoc();
}


/**
 * 复制当前值图 JSON（ADR-0012 §2/§4）：与文件导出逐字同一份文本；
 * >20MB 拒绝并提示用文件导出；剪贴板写入复用 ADR-0010 §7 的零权限路径。
 */
async function copyDocJson(): Promise<void> {
  if (!session.rootId || !meta) return;
  setExportButtonsDisabled(true);
  try {
    const reply = await core.exportDoc(session.rootId, settings.get('jsonIndent'), settings.get('escapeUnicode'));
    const refusal = clipboardRefusal(reply.bytes);
    if (refusal !== null) {
      exportLastAction = { mode: 'clipboard', bytes: reply.bytes, copied: false };
      showToast(
        t('view.export.clipboardRefusal', { mb: (refusal / (1024 * 1024)).toFixed(1) }),
        4000,
        'error',
      );
      return;
    }
    const copied = await writeClipboard(reply.text);
    exportLastAction = { mode: 'clipboard', bytes: reply.bytes, copied };
    // 截断结果必须带标记（ADR-0018 §4：截断不能静默发生）
    const suffix = expression.active && expression.view?.truncated ? t('app.export.truncated') : '';
    if (copied) showToast(t('app.toast.copyDone', { what: `JSON${suffix}` }), 2000, 'success');
    else showToast(t('app.toast.copyFailedExport'), 4000, 'error');
  } catch (error) {
    showError(error);
  } finally {
    setExportButtonsDisabled(false);
  }
}

/**
 * 树行右键菜单控制器（ADR-0015）：键盘/定位/外部关闭/焦点归还收口到 `view/menu`。
 * 右键菜单锚在光标 → 内层滚动关闭（`closeOnScroll`）；Esc/选中回树（`returnFocus`）。
 */
const ctxMenuController = createMenu({
  element: ctxMenu,
  itemSelector: '[data-act]',
  returnFocus: focusTree,
  returnFocusOnOutside: true,
  closeOnScroll: true,
  onSelect: (item) => {
    const act = item.dataset.act ?? '';
    const path = ctxPath;
    if (!path) return;
    if (act === 'copy-origin-path') {
      void copyOriginPathToClipboard();
      return;
    }
    const format = copyFormatOfAct(act);
    if (format) {
      void copyNodeToClipboard(path, format);
      return;
    }
    // 子树批量展开 / 收起（#22 / ADR-0002 修订）：两个固定项，不按状态翻转文案
    if (act === 'expand-subtree') {
      void toggleSubtree(path, true);
      return;
    }
    if (act === 'collapse-subtree') {
      void toggleSubtree(path, false);
      return;
    }
    // 单节点子键排序覆盖（#41 / ADR-0024 修订 v1.1）：三项固定，不做勾选态（点击后 toast 反馈规则）
    const orderAction = NODE_ORDER_ACTIONS[act];
    if (orderAction) {
      void setNodeOrder(path, orderAction);
      return;
    }
    if (act === 'edit') void openEditor(path);
    if (act === 'locate-raw') void jumpTreeToRaw(path);
  },
  onClose: () => {
    ctxPath = null;
    ctxOriginPath = null;
  },
});

/** 原文行右键菜单打开时的行号（1-based；关闭清理）。 */
let ctxRawLine: number | null = null;

/**
 * 原文行右键菜单控制器（#30 / ADR-0019）：只有一个动作「在树视图中定位」。
 * 交互契约复用 `view/menu`（ADR-0015）：Esc/选中回原文、外部关闭、内层滚动关闭。
 */
const rawCtxController = createMenu({
  element: rawCtxMenu,
  itemSelector: '[data-raw-act]',
  returnFocus: focusRaw,
  returnFocusOnOutside: true,
  closeOnScroll: true,
  onSelect: () => {
    const line = ctxRawLine;
    if (line === null) return;
    void jumpRawToTree(line);
  },
  onClose: () => {
    ctxRawLine = null;
  },
});

/** 弹原文行右键菜单（键盘等价入口；鼠标快路径是行号 gutter 按钮）。 */
function showRawContextMenu(line: number, x: number, y: number): void {
  rawCtxController.close('programmatic');
  ctxRawLine = line;
  const item = rawCtxMenu.querySelector<HTMLButtonElement>('[data-raw-act]');
  if (item) item.title = t('app.toast.lineToTree', { line });
  rawCtxController.open({ kind: 'point', x, y });
}

/**
 * 弹树行右键菜单。`row` = 该行的窗口数据（kind / open / count / hasChildren），
 * 菜单启用态一律以它为准（ADR-0010 修订 2026-11-09：#22 的子树项需要 count 判「有没有子孙」）。
 */
function showContextMenu(path: string, x: number, y: number, row: Row): void {
  // 先关上一轮（controller.close 会走 onClose 清 ctxPath），再写本轮 path；
  // 否则「菜单已开着时再打开另一个行」会被 close 的清理把新 path 清掉。
  ctxMenuController.close('programmatic');
  ctxPath = path;
  const kind = row.kind;
  const isContainerKind = kind === 'object' || kind === 'array';
  // 启用规则（ADR-0010 §1 / 修订 §启用规则）：容器没有原始值；根没有键名；子树项只在「有子孙的容器」上可用。
  setCtxItemDisabled(COPY_ACT.subtree, false);
  setCtxItemDisabled(COPY_ACT.path, false);
  setCtxItemDisabled(COPY_ACT.value, isContainerKind, t('app.toast.reasonContainerValue'));
  setCtxItemDisabled(COPY_ACT.key, path === ROOT_PATH, t('app.toast.reasonRootKey'));
  const canSubtree = isContainerKind && row.count > 0 && path !== ROOT_PATH;
  const subtreeWhy =
    path === ROOT_PATH
      ? t('app.toast.reasonRootExpand')
      : isContainerKind
        ? t('app.toast.reasonEmptyContainer')
        : t('app.toast.reasonScalar');
  // 文案「整棵子树」= 含该节点自身（收起时也会折叠它）+ 所有深度的子孙容器；不含更上层
  const subtreeHint = t('app.title.subtreeHint');
  setCtxItemDisabled('expand-subtree', !canSubtree, subtreeWhy, subtreeHint);
  setCtxItemDisabled('collapse-subtree', !canSubtree, subtreeWhy, subtreeHint);
  // 单节点子键排序覆盖（#41 / ADR-0024 修订 v1.1）：只对「对象容器且直接成员 ≥ 2」可用；
  // 数组恒索引序；三项常显、不做勾选态（点击后用 toast 反馈规则）
  const canOrder = kind === 'object' && row.count >= 2;
  const orderWhy =
    kind === 'array'
      ? t('app.title.arrayOrder')
      : kind === 'object'
        ? t('app.title.orderMinTwo')
        : t('app.title.orderObjectOnly');
  const orderHint = t('app.title.nodeOrderHint');
  for (const act of Object.keys(NODE_ORDER_ACTIONS)) {
    setCtxItemDisabled(act, !canOrder, orderWhy, orderHint);
  }
  // 表达式结果只读（ADR-0018 §1）：结果根上的编辑入口一律禁用（复制四格式照常可用）
  setCtxItemDisabled('edit', expression.active, t('app.toast.exprReadonly'));
  // 双向定位（#30）：表达式结果根没有源文本；plain（修复文档）没有可靠的行/路径映射
  setCtxItemDisabled(
    'locate-raw',
    expression.active || meta?.repair !== undefined,
    expression.active ? t('app.toast.exprNoSource') : t('app.toast.rawPlainMode'),
  );
  // 原文档路径（#47 #8 / ADR-0027）：只有表达式结果根的行带 originPath 字段；计算值（null）无来源。
  // 非表达式视图下整项禁用（文档树的路径就是行自己的 path，用「复制路径」即可）。
  ctxOriginPath = 'originPath' in row && typeof row.originPath === 'string' ? row.originPath : null;
  setCtxItemDisabled(
    'copy-origin-path',
    ctxOriginPath === null,
    expression.active ? t('app.toast.reasonOriginComputed') : t('app.toast.reasonOriginExprOnly'),
  );
  ctxMenuController.open({ kind: 'point', x, y });
}

/* ---------------- 复制四格式（ADR-0010） ---------------- */

/** 复制格式的展示名（模块级常量只存 key，toast 里再 t()）。 */
const COPY_LABEL_KEYS: Record<CopyFormat, MessageKey> = {
  subtree: 'app.copy.format.subtree',
  path: 'app.copy.format.path',
  value: 'app.copy.format.value',
  key: 'app.copy.format.key',
};

/** 菜单 data-act ↔ 协议 format（固定顺序，见 ADR-0010 §1） */
const COPY_ACT: Record<CopyFormat, string> = {
  subtree: 'copy-subtree',
  path: 'copy-path',
  value: 'copy-value',
  key: 'copy-key',
};

/** v1.1 右键菜单「子键排序」三项：act → 协议 order + 成功 / no-op 文案（#41 / ADR-0024 修订）。 */
const NODE_ORDER_ACTIONS: Record<
  string,
  { order: SortOrder | null; done: MessageKey; noop: MessageKey }
> = {
  'order-asc': { order: 'key-asc', done: 'app.toast.orderAscDone', noop: 'app.toast.orderAscSame' },
  'order-desc': { order: 'key-desc', done: 'app.toast.orderDescDone', noop: 'app.toast.orderDescSame' },
  'order-global': { order: null, done: 'app.toast.orderGlobalDone', noop: 'app.toast.orderGlobalSame' },
};

function copyFormatOfAct(act: string): CopyFormat | null {
  switch (act) {
    case COPY_ACT.subtree:
      return 'subtree';
    case COPY_ACT.path:
      return 'path';
    case COPY_ACT.value:
      return 'value';
    case COPY_ACT.key:
      return 'key';
    default:
      return null;
  }
}

function ctxItems(): HTMLButtonElement[] {
  return Array.from(ctxMenu.querySelectorAll<HTMLButtonElement>('[data-act]'));
}

/**
 * 菜单项禁用态 + title：禁用时 `why` 说明原因；可用时 `hint` 说明作用域（如「含该节点自身；不含更上层」），无 hint 则清空。
 * 只碰树行菜单项，导出菜单的 `menuitemradio` 不走这里。
 */
function setCtxItemDisabled(act: string, disabled: boolean, why?: string, hint?: string): void {
  const item = ctxMenu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
  if (!item) return;
  item.disabled = disabled;
  if (disabled) {
    if (why) item.title = why;
    item.setAttribute('aria-disabled', 'true');
  } else {
    if (hint) item.title = hint;
    else item.removeAttribute('title');
    item.removeAttribute('aria-disabled');
  }
}

/**
 * 复制入口共用实现（右键菜单 4 格式 + 行尾浮条的子集快路径）：
 * core 生成文本（ADR-0010 §6）→ 零权限写剪贴板（§7）→ toast 反馈。
 * 只读操作，不推进版本；TOO_LARGE 引导用「导出」而不是静默截断。
 */
async function copyNodeToClipboard(path: string, format: CopyFormat): Promise<void> {
  if (!session.rootId) return;
  try {
    const reply = await core.copyNode({ rootId: session.rootId, path, format, indent: settings.get('jsonIndent') });
    const copied = await writeClipboard(reply.text);
    if (copied) showToast(t('app.toast.copyDone', { what: t(COPY_LABEL_KEYS[format]) }), 2000, 'success');
    else showToast(t('app.toast.copyFailedManual'), 4000, 'error');
  } catch (error) {
    const coreError = CoreError.from(error);
    if (coreError.code === 'TOO_LARGE') {
      showError(
        new CoreError({
          code: 'TOO_LARGE',
          message: t('app.toast.copyTooLarge', { size: formatBytes(coreError.bytes ?? 0) }),
        }),
      );
      return;
    }
    // 格式不适用（容器没有「原始值」、根没有「键名」）：树菜单靠禁用项规避，搜索双击会真触发
    if (coreError.code === 'BAD_COMMAND') {
      showToast(t('app.toast.formatUnsupported'), 4000, 'error');
      return;
    }
    showError(error);
  }
}

/** 复制表达式结果行的原文档路径（#47 #8）：剪贴板写入与 toast 复用四格式复制的口径。 */
async function copyOriginPathToClipboard(): Promise<void> {
  const origin = ctxOriginPath;
  if (!origin) return;
  const copied = await writeClipboard(origin);
  if (copied) showToast(t('app.toast.copyDone', { what: t('app.copy.format.originPath') }), 2000, 'success');
  else showToast(t('app.toast.copyFailedManual'), 4000, 'error');
}

/** 零权限剪贴板：clipboard.writeText → execCommand 兜底（不声明 clipboardWrite，ADR-0010 §7）。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 无剪贴板权限/非安全上下文 → 降级 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function setSelection(path: string | null): void {
  selected = path;
  expression.refreshOrigin();
  tree.setSelected(path);
  // 大纲当前高亮唯一来源 = 树选中路径（ADR-0013 §4）
  outlineState.setSelected(path);
  selPath.textContent = path ?? '—';
  selPath.title = path ?? '';
  // 表达式结果视图：选中行 = 「点一下跳回原文档」，不给编辑暗示（ADR-0018 §1）
  selMeta.textContent = path ? (expression.active ? t('app.sel.hint.expr') : t('app.sel.hint.edit')) : '';
  updateStatus();
}

/* ---------------- search ---------------- */

type PanelId = 'doc' | 'search' | 'outline' | 'settings' | 'expression';

/** 左面板标题（模块级常量只存 key，setPanel 时再 t()）。 */
const PANEL_TITLES: Record<PanelId, MessageKey> = {
  doc: 'app.panel.doc',
  search: 'app.panel.search',
  outline: 'app.panel.outline',
  settings: 'app.panel.settings',
  expression: 'app.panel.expression',
};

/** 左面板模式（ADR-0011 §2 持久化；expression = ADR-0018 §1）。 */
function setPanel(panel: PanelId): void {
  // 离开表达式模式 → 树区回文档树（结果根保留在 worker LRU；重进表达式模式可恢复最近结果）
  if (panel !== 'expression' && expression.active) expression.back({ silent: true });
  document.body.dataset.panel = panel;
  panelTitle.textContent = t(PANEL_TITLES[panel]);
  const buttons = document.querySelectorAll<HTMLElement>('.actbtn[data-panel-btn]');
  buttons.forEach((button) => {
    const active = button.dataset.panelBtn === panel;
    button.classList.toggle('is-active', active);
    // a11y（direction §8）：活动栏当前模式同步 aria-current，而不是只有 class
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (panel === 'search') searchPanel.focusInput();
  // 大纲：显示只负责重画（不重新取数，ADR-0013 §5）；键盘导航需要焦点
  if (panel === 'outline') {
    outlinePanel.refresh();
    outlinePanel.focus();
  }
  if (panel === 'settings') settingsPanel.focus();
  if (panel === 'expression') {
    // 进入表达式模式 = 补全需要 profile（ADR-0025 §2）：右栏折叠也按需采样一次
    scheduleProfile(true);
    void expressionPanel.mount();
    expressionPanel.focus();
    expression.refreshExamples();
    // 恢复最近一次结果视图（会话内 LRU；stale 时结果条变警告色 + 「重新执行」；幂等）
    expression.enterFromArchive();
  }
  // 布局态持久化（ADR-0011 §2）：下次启动恢复
  settings.setUi({ panel });
}

document.querySelectorAll<HTMLElement>('[data-panel-btn]').forEach((button) => {
  button.addEventListener('click', () => {
    const panel = button.dataset.panelBtn;
    // 点击当前已激活的模式 → 回到文档视图（与「关闭面板」一致）
    const next: PanelId =
      panel === 'search' || panel === 'outline' || panel === 'settings' || panel === 'expression'
        ? panel
        : 'doc';
    setPanel(document.body.dataset.panel === next ? 'doc' : next);
  });
});
document.querySelectorAll<HTMLElement>('[data-panel-close]').forEach((button) => {
  button.addEventListener('click', () => setPanel('doc'));
});

// 启动时恢复上次的左面板模式（放在 PANEL_TITLES / 视图都初始化之后，避免 TDZ）
{
  const restoredPanel = settings.uiState().panel;
  if (restoredPanel !== 'none') setPanel(restoredPanel);
}

/** 输入 250ms debounce；清空查询也走这里（清空结果 + 树高亮）。 */
function queueSearch(query: string): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    void runSearch(query);
  }, 250);
}

/**
 * 执行一次搜索（viewmodel 里 begin→apply 管理 seq/docRevision）：
 * 过期回包由 SearchState 丢弃；docRevision 不匹配 → 清空并提示重搜。
 */
/** 最近一次搜索的正则错误（结构化；切语言时重新格式化，ADR-0026 §3）。 */
let searchPatternCore: CoreError | null = null;

async function runSearch(query: string): Promise<boolean> {
  // 多标签（ADR-0009 §2）：切标签 / 换根后迟到回包必须丢弃，不能写进当前标签的命中集。
  // 判据只用 rootId（换文档必换根）；不再用 loadSeq——它是全局量，会把别的标签的在途搜索误杀。
  const rootAtStart = session.rootId;
  const trimmed = query.trim();
  const seq = searchState.begin(trimmed, searchOpts);
  applySearchToTree();
  renderSearch();

  if (!trimmed) return false;
  if (!session.rootId) {
    searchState.begin('', searchOpts);
    renderSearch();
    return false;
  }

  try {
    const reply = await core.search({ rootId: session.rootId, seq, query: trimmed, opts: searchOpts });
    if (rootAtStart !== session.rootId || reply.rootId !== session.rootId) return false;
    const accepted = searchState.apply(
      {
        seq: reply.seq,
        docRevision: reply.docRevision,
        hits: reply.hits,
        total: reply.total,
        truncated: reply.truncated,
      },
      session.docRevision,
    );
    searchJumped = false;
    searchPatternCore = null;
    applySearchToTree();
    renderSearch();
    return accepted;
  } catch (error) {
    const coreError = CoreError.from(error);
    // 无效/不安全的正则（ADR-0014 §2.3）：内联错误行，不弹 toast、不当作「无命中」。
    // 不先 begin('')（会清 patternError）；markPatternError 自己清结果并回 idle。
    if (coreError.code === 'BAD_PATTERN') {
      searchPatternCore = coreError;
      searchState.markPatternError(patternErrorText(coreError));
      searchJumped = false;
      applySearchToTree();
      renderSearch();
      return false;
    }
    if (coreError.code !== 'CANCELLED' && coreError.code !== 'CLOSED') {
      searchState.begin('', searchOpts);
      applySearchToTree();
      renderSearch();
      showError(error);
    }
    return false;
  }
}

/** 把命中集/当前命中推给树视图（只传状态，视图不请求）。 */
function applySearchToTree(): void {
  const view = searchState.view();
  if (view.phase === 'idle' || view.phase === 'stale' || searchState.allHits.length === 0) {
    tree.setSearch(null);
    return;
  }
  tree.setSearch({
    term: searchState.query,
    wholeWord: searchState.wholeWord,
    hitPaths: searchState.hitPaths(),
    currentPath: searchState.currentHit()?.path ?? null,
  });
}

function renderSearch(): void {
  searchPanel.render(searchState.view());
}

function applyFilter(filter: SearchFilter): void {
  searchState.setFilter(filter);
  searchJumped = false;
  applySearchToTree();
  renderSearch();
  const current = searchState.current;
  if (current >= 0) searchPanel.scrollTo(current);
}

/**
 * 逐条隐藏当前标签的一条命中（#53）。隐藏是**视图状态**：树高亮、chips、`⌘G` 全部按可见集走。
 * `searchJumped = false`：当前命中可能换人，下一次 ⌘G 应跳新的当前项而不是再往前。
 */
function hideSearchHit(path: string): boolean {
  if (!searchState.hide(path)) return false;
  afterHiddenChanged();
  return true;
}

/** 「全部恢复」（#53）：清空隐藏集，尽量回到原来那条命中。 */
function restoreHiddenHits(): boolean {
  if (!searchState.restoreHidden()) return false;
  afterHiddenChanged();
  return true;
}

/** 隐藏集变化后的视图收尾（树高亮 / 面板 / 当前项滚入视口；⌘G 从新的当前项重新开始）。 */
function afterHiddenChanged(): void {
  searchJumped = false;
  applySearchToTree();
  renderSearch();
  if (searchState.current >= 0) searchPanel.scrollTo(searchState.current);
}

/**
 * 跳转共享链路（搜索 gotoHit / 大纲点击行共用，ADR-0013 §4）：
 * expandTo 展开树祖先链 → 树滚动居中 → 选中。原文视图下先切回树。
 * 返回 `{ ok, row }`（row = 树内行号；失败 -1），错误已在内部提示。
 */
async function jumpToPath(
  path: string,
  opts: { silent?: boolean } = {},
): Promise<{ ok: boolean; row: number }> {
  if (!session.rootId) return { ok: false, row: -1 };
  // 跳转是树动作：原文视图下先切回树（ADR-0003 修订：两视图 v1 不联动）
  if (isRawView()) await setViewMode('tree');
  try {
    const reply = await core.expandTo({ rootId: session.rootId, path });
    if (!isActiveDocRoot(reply.rootId)) return { ok: false, row: -1 };
    // 居中 + 选中都在 landing 里（viewport 与行高作为纯数据传入）
    applyLanding(
      session.land(reply, { kind: 'jump', path, row: reply.row }, {
        viewportPx: tree.clientHeightPx(),
        rowHeightPx: settings.get('rowHeight'),
      }),
    );
    return { ok: true, row: reply.row };
  } catch (error) {
    // 双向定位的祖先回退会连续尝试多级路径：静默失败，由调用方决定最终提示（#30）
    if (!opts.silent) showError(error);
    return { ok: false, row: -1 };
  }
}

/** 搜索跳转：jumpToPath + 同步搜索态/结果列表（保持 slice 4 行为）。 */
async function gotoHit(index: number): Promise<number> {
  const hit = searchState.hits[index];
  if (!hit) return -1;
  // 根文档 / 原文视图守卫与「树滚动 + 选中 + updateStatus」都在 jumpToPath 内（单一链路）
  const jumped = await jumpToPath(hit.path);
  if (!jumped.ok) return -1;
  searchState.select(index);
  searchJumped = true;
  applySearchToTree();
  renderSearch();
  searchPanel.scrollTo(index);
  return index;
}

async function searchNext(): Promise<number> {
  if (searchState.size === 0) return -1;
  if (!searchJumped) return gotoHit(searchState.current >= 0 ? searchState.current : 0);
  return gotoHit(searchState.next());
}

async function searchPrev(): Promise<number> {
  if (searchState.size === 0) return -1;
  if (!searchJumped) return gotoHit(searchState.current >= 0 ? searchState.current : 0);
  return gotoHit(searchState.prev());
}

/** 重载/空查询：清空搜索态、在途回包因 seq 变化被丢弃。 */
function resetSearch(): void {
  window.clearTimeout(searchTimer);
  // 换文档保留用户选的 Aa/.*（会话内偏好，ADR-0014 §2.5；刷新/重开页面才回默认）
  searchState.begin('', searchOpts);
  searchJumped = false;
  tree.setSearch(null);
  searchPanel.resetScroll();
  renderSearch();
}

/* ---------------- theme / rail ---------------- */

function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  statusTheme.textContent = t(theme === 'dark' ? 'app.status.theme.dark' : 'app.status.theme.light');
}

el('themeToggle').addEventListener('click', () => {
  settings.set('theme', settings.get('theme') === 'dark' ? 'light' : 'dark');
});

function toggleRail(): void {
  const collapsed = document.body.classList.toggle('rail-collapsed');
  el('railToggle').setAttribute('aria-pressed', collapsed ? 'false' : 'true');
  settings.setUi({ railCollapsed: collapsed });
  // 右栏由折叠 → 展开：文档概要按需补采（ADR-0025 §2；已就绪 / 在途时 schedule 内部去重）
  if (!collapsed) scheduleProfile();
}

el('railToggle').addEventListener('click', toggleRail);
el('railCollapse').addEventListener('click', toggleRail);

window.addEventListener('keydown', (event: KeyboardEvent) => {
  // 子树编辑器打开时，快捷键交给 CM6（其 keymap 处理 Esc / Mod-Enter / 撤销）
  if (subtreeEditor.isOpen()) return;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  // 撤销/重做临时修改（输入控件内交给浏览器原生）
  if (mod && key === 'z' && !isEditableTarget(event.target)) {
    if (!session.rootId) return;
    event.preventDefault();
    if (event.shiftKey) void redoEdit();
    else void undoEdit();
    return;
  }
  if (mod && key === 'k') {
    event.preventDefault();
    setPanel('search');
    return;
  }
  // 打开导入层（已打开文档时的显式替换入口，Q11-B）；⌘⇧O = 新标签（#18 / ADR-0009 §4）
  if (mod && key === 'o') {
    if (!session.rootId) return;
    event.preventDefault();
    if (event.shiftKey) importLayer.openNewTab();
    else importLayer.open();
    return;
  }
  if (event.key === 'Escape' && session.rootId && importLayer.isOpen() && importLayer.mode() !== 'initial') {
    event.preventDefault();
    importLayer.close();
    return;
  }
  // 下一个/上一个命中：⌘G / ⇧⌘G，或 F3 / ⇧F3
  if ((mod && key === 'g') || key === 'f3') {
    if (!session.rootId) return;
    event.preventDefault();
    if (event.shiftKey) void searchPrev();
    else void searchNext();
  }
});

/* ---------------- status ---------------- */

/* ---------------- 截断修复提示条（#8 / ADR-0004 修订） ---------------- */

/**
 * 按 meta.repair 渲染顶部修复条：只有 repaired 才显示；摘要列表逐条展示 ops.note。
 * 关闭只隐藏提示（provenance 保留），重新导入时按新文档重渲染。
 */
function renderRepair(): void {
  const repair = meta?.repair;
  const repaired = repair?.status === 'repaired';
  repairBar.hidden = !repaired;
  repairOps.hidden = true;
  repairOps.replaceChildren();
  repairToggle.setAttribute('aria-expanded', 'false');
  if (!repaired) {
    repairText.textContent = '—';
    repairText.removeAttribute('title');
    repairToggle.hidden = true;
    return;
  }
  repairText.textContent = repairSummaryText(repair.counts);
  repairText.title = repairText.textContent;
  const ops = repair.ops ?? [];
  repairToggle.hidden = ops.length === 0;
  for (const op of ops) {
    const row = document.createElement('div');
    row.className = 'repairbar__op';
    const at = document.createElement('button');
    at.type = 'button';
    at.className = 'repairbar__at';
    at.dataset.at = String(op.at);
    at.textContent = `@${op.at}`;
    at.title = t('app.repair.jumpTitle');
    const note = document.createElement('span');
    note.textContent = repairNoteText(op.note);
    row.append(at, note);
    repairOps.appendChild(row);
  }
}

/* ---------------- 导入体积提示条（#11 / ADR-0003 修订 2026-11-09） ---------------- */

/**
 * 按 `meta.bytes` 渲染「源文本常驻内存」提示条：
 * 只有超过 `LARGE_DOC_WARN_BYTES`（50 MB 十进制）才显示；不阻断导入、无弹窗。
 * 关闭只隐藏条（源文本仍常驻，原文视图仍可用），换文档时按新文档重新判定。
 *
 * 口径：阈值是**十进制** 50 MB（50,000,000 B），所以本条的文件大小也用十进制显示，
 * 否则会出现「47.7 MB 触发 50 MB 提示」的自相矛盾；工具栏/状态栏仍沿用二进制 MiB。
 */
function renderDocWarn(): void {
  const bytes = meta?.bytes ?? 0;
  if (bytes <= LARGE_DOC_WARN_BYTES) {
    docWarnNotice.hide();
    return;
  }
  // 源文本是 UTF-16 常驻：纯 ASCII 时正好 2× 字节数，多字节字符略低；按 2× 给人的是上限
  docWarnNotice.show(
    t('app.docWarn.text', {
      size: formatBytesDecimal(bytes),
      max: formatBytesDecimal(bytes * 2),
    }),
  );
}

/* ---------------- 保真提示（#23 / ADR-0003 修订 2026-11-09） ---------------- */

function resetFidelity(): void {
  fidelitySeq += 1;
  fidelity = null;
  fidelityPending = false;
  fidelityIndex = 0;
  clearStatusHint();
  fidelityNotice.hide();
  fidelityNotice.setActionVisible(false);
  fidelityPrev.hidden = true;
  fidelityNext.hidden = true;
  fidelityCount.hidden = true;
}

/**
 * 首帧后异步扫描（ADR 修订 §1）：`requestIdleCallback`（2s 兜底）→ `core.fidelity`。
 * 不显示「检查中」进度；换文档用 `fidelitySeq` + rootId 双重判定丢弃迟到回包。
 */
function scheduleFidelityScan(): void {
  const rid = session.rootId;
  if (!rid) return;
  const seq = fidelitySeq;
  fidelityPending = true;
  const run = (): void => {
    if (rid !== session.rootId || seq !== fidelitySeq) return;
    void (async () => {
      try {
        const reply = await core.fidelity({ rootId: rid });
        if (rid !== session.rootId || seq !== fidelitySeq) return;
        // 不用 docRevision 判过期：编辑会推进它，但源文本不变、报告仍有效（ADR 修订 §1）
        fidelity = reply.report;
        fidelityPending = false;
        renderFidelity();
      } catch (error) {
        if (rid !== session.rootId || seq !== fidelitySeq) return;
        fidelityPending = false;
        const coreError = CoreError.from(error);
        // 取消 / 根已换是正常竞态，静默；其余是真错误
        if (coreError.code !== 'CANCELLED' && coreError.code !== 'NO_ROOT') showError(error);
      }
    })();
  };
  const idle = (
    window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 2000 });
  else window.setTimeout(run, 16);
}

/** 精确数量文案（ADR §3：误报会教用户忽略提示，所以必须给精确数）。 */
function renderFidelity(): void {
  const report = fidelity;
  const total = report?.counts.total ?? 0;
  const hits = report?.hits ?? [];
  const hitCount = hits.length;
  // 多命中导航（#31）：≥2 条命中才显示「‹ 1/N ›」；单条命中保持原样（零视觉变化）
  const nav = hitCount > 1;
  fidelityPrev.hidden = !nav;
  fidelityNext.hidden = !nav;
  fidelityCount.hidden = !nav;
  if (nav) {
    // 循环导航（2026-11-11 晚用户反馈）：首尾不禁用，到头再点回到另一端
    if (fidelityIndex > hitCount - 1) fidelityIndex = 0;
    if (fidelityIndex < 0) fidelityIndex = hitCount - 1;
    fidelityCount.textContent = `${fidelityIndex + 1}/${formatNumber(hitCount)}`;
    fidelityPrev.disabled = false;
    fidelityNext.disabled = false;
  } else {
    fidelityIndex = 0;
    fidelityCount.textContent = '';
  }
  fidelityNotice.setActionVisible(hitCount > 0);
  if (!report || total === 0) {
    fidelityNotice.hide();
    return;
  }
  // 精确数量必须**按类别**说（ADR-0020 起整数精度流失已退场，只剩上溢/下溢/键序）
  const parts: string[] = [];
  if (report.counts.overflow > 0) {
    parts.push(t('app.fidelity.overflow', { n: report.counts.overflow }));
  }
  if (report.counts.underflow > 0) {
    parts.push(t('app.fidelity.underflow', { n: report.counts.underflow }));
  }
  if (report.counts.keyOrder > 0) {
    parts.push(t('app.fidelity.keyOrder', { n: report.counts.keyOrder }));
  }
  const tail = report.truncated ? t('app.fidelity.tail', { n: report.hits.length }) : '';
  // 条内常驻显示**当前一处**的「原文 → 实际」对照（2026-11-11 晚用户反馈：状态栏太不明显）
  const current = hits[fidelityIndex];
  const detail = current
    ? t('app.fidelity.detail', {
        i: fidelityIndex + 1,
        n: hitCount,
        desc: fidelityDescription(current),
      })
    : '';
  fidelityNotice.show(
    t('app.fidelity.summary', { n: total, parts: parts.join(' · '), tail, detail }),
  );
}

/**
 * 一条失真的「人话解释」正文（#31 / ADR-0020 §7）：数字类给**原文 vs 实际值**
 * （上溢 → Infinity / 下溢 → 0；整数精度流失已退场）；键序类只说明被重排。
 */
function fidelityDescription(hit: FidelityHit): string {
  if (hit.kind === 'key-order') return t('app.fidelity.descKeyOrder');
  const literal = hit.literal ?? hit.snippet;
  if (hit.reason === 'overflow') return t('app.fidelity.descOverflow', { literal });
  if (hit.reason === 'underflow') return t('app.fidelity.descUnderflow', { literal });
  return t('app.fidelity.descParsed', { literal, parsed: hit.parsed ?? '?' });
}

/** 状态栏/提示条用的完整文案（带「失真：」前缀）。 */
function describeFidelityHit(hit: FidelityHit): string {
  return t('app.fidelity.status', { desc: fidelityDescription(hit) });
}

/**
 * 跳到第 index 条失真（#31 / ADR-0003 修订 2026-11-11 晚）：更新计数/按钮态 → 状态栏解释
 * （约 3s）→ 切原文并高亮对应行（复用 revealRepairOffset 的单一链路）。
 */
function jumpFidelityHit(index: number): void {
  const hits = fidelity?.hits ?? [];
  if (hits.length === 0) return;
  fidelityIndex = Math.max(0, Math.min(Math.floor(index), hits.length - 1));
  renderFidelity();
  const hit = hits[fidelityIndex];
  // 常驻差异提示（2026-11-11 晚用户反馈：3s 状态栏太不明显）——直到下一次跳转 / 换文档 / 切标签
  setStatusHintSticky(describeFidelityHit(hit));
  void revealRepairOffset(hit.offset);
}

/** 循环步进（用户 2026-11-11 晚：首尾也要能继续走，末条的下一条回到第一条）。 */
function stepFidelityHit(delta: number): void {
  const hitCount = fidelity?.hits.length ?? 0;
  if (hitCount === 0) return;
  jumpFidelityHit((fidelityIndex + delta + hitCount) % hitCount);
}

/* ---------------- 视图切换：树 / 原文（#11 / ADR-0003 修订） ---------------- */

/** 当前视图的唯一运行期真相 = `body[data-view]`（持久化走 SettingsState，不另存一份变量）。 */
function isRawView(): boolean {
  return document.body.dataset.view === 'raw';
}

/** 原文元信息 + 视图内提示（不新增常驻条；没有要说的就是空串）。 */
function renderRawChrome(): void {
  const info = rawMetaInfo;
  if (!info) {
    rawModeLabel.textContent = t('app.raw.mode');
    rawNotice.textContent = '';
    rawNotice.removeAttribute('title');
    rawMetaLabel.textContent = '';
    rawCopyBtn.disabled = true;
    return;
  }
  rawModeLabel.textContent = t(
    info.mode === 'source'
      ? 'app.raw.mode.source'
      : info.mode === 'pretty'
        ? 'app.raw.mode.pretty'
        : 'app.raw.mode.plain',
  );
  const notes: string[] = [];
  if (info.damaged) notes.push(t('app.raw.notice.plain'));
  else if (info.mode === 'pretty') notes.push(t('app.raw.notice.pretty'));
  if (editState.dirty) notes.push(t('app.raw.notice.clean'));
  rawNotice.textContent = notes.join(' · ');
  if (notes.length > 0) rawNotice.title = notes.join('\n');
  else rawNotice.removeAttribute('title');
  // 索引构建耗时只在 dev hook / 冒烟里暴露，不进常驻 UI（ADR-0003 修订 §5）
  rawMetaLabel.textContent = t('app.raw.lines', { n: info.totalLines });
  rawCopyBtn.disabled = false;
}

/**
 * 切视图（ADR-0003 修订 §5）：更新工具栏分段态 / body 视图标记 / 持久化；首次进入原文视图时
 * 惰性构建索引（Worker 内，50MB ≈300ms）。persist=false 用于「打开文档后恢复上次模式」。
 */
async function setViewMode(mode: 'tree' | 'raw', opts: { persist?: boolean } = {}): Promise<void> {
  if (!session.rootId) return;
  // 表达式视图只有树形态：切原文 = 先回文档树（原文永远指文档源文本，表达式根没有源文本）
  if (expression.active) {
    expression.back({ silent: true });
    if (mode === 'tree') {
      updateStatus();
      return;
    }
  }
  const changed = mode !== (isRawView() ? 'raw' : 'tree');
  document.body.dataset.view = mode;
  viewTreeBtn.classList.toggle('is-active', mode === 'tree');
  viewTreeBtn.setAttribute('aria-pressed', mode === 'tree' ? 'true' : 'false');
  viewRawBtn.classList.toggle('is-active', mode === 'raw');
  viewRawBtn.setAttribute('aria-pressed', mode === 'raw' ? 'true' : 'false');
  if (opts.persist !== false) settings.setUi({ viewMode: mode });

  if (mode === 'tree') {
    updateStatus();
    if (changed) focusTree();
    return;
  }

  // 原文：已构建则直接复用；否则先给「构建中」反馈（桌面读屏与冒烟都能看到）
  const rid = session.rootId;
  const seq = ++rawOpenSeq;
  if (!rawMetaInfo) {
    statusRows.textContent = t('app.raw.indexing');
    statusSize.textContent = meta ? `${formatBytes(meta.bytes)} · v${session.docRevision}` : '—';
  }
  try {
    const info = await rawSource.open(rid);
    // 迟到回包：已换文档 / 已切回树 / 有更新的 open → 丢弃
    if (seq !== rawOpenSeq || rid !== session.rootId || !isRawView()) return;
    rawMetaInfo = info;
    renderRawChrome();
    rawView.setRowHeight(settings.get('rowHeight'));
    // open() 已把内部滚动锚点复位到 0；.raw-wrap 曾 display:none，浏览器会恢复旧 scrollTop →
    // 不显式同步会出现「窗口在顶部、容器停在旧位置」且不触发 scroll 事件的错位。
    rawView.scrollToPx(0);
    rawSource.setMetrics(rawMetrics());
    rawSource.requestWindow();
    rawHost.querySelector<HTMLElement>('.tjv-raw')?.focus();
    updateStatus();
  } catch (error) {
    if (seq === rawOpenSeq) showError(error);
  }
}

/** 复制整份原文（ADR-0003 修订 §4：>maxBytes 由 core 抛 TOO_LARGE，与导出复制同口径）。 */
async function copyRawSource(): Promise<void> {
  if (!session.rootId) return;
  try {
    const reply = await core.rawSource({ rootId: session.rootId, maxBytes: CLIPBOARD_MAX_BYTES });
    const copied = await writeClipboard(reply.text);
    if (copied) showToast(t('app.raw.copied'), 2000, 'success');
    else showToast(t('app.raw.copyFailed'), 4000, 'error');
  } catch (error) {
    const coreError = CoreError.from(error);
    if (coreError.code === 'TOO_LARGE') {
      showError(
        new CoreError({
          code: 'TOO_LARGE',
          message: t('app.raw.copyTooLarge', {
            size: formatBytes(coreError.bytes ?? 0),
            max: formatBytes(CLIPBOARD_MAX_BYTES),
          }),
        }),
      );
      return;
    }
    showError(error);
  }
}

/**
 * 修复摘要 `at` → 原文对应行（#8「跳行随 #11」的落地，ADR-0003 修订 §5）：
 * 切原文视图 → rawLocate 偏移反查行号 → 滚到该行 + 短暂高亮。
 */
async function revealRepairOffset(offset: number): Promise<number> {
  if (!session.rootId) return -1;
  const rid = session.rootId;
  await setViewMode('raw');
  if (rid !== session.rootId) return -1;
  try {
    const located = await core.rawLocate({ rootId: rid, offset });
    if (rid !== session.rootId) return -1;
    rawView.flashLine(located.line);
    return located.line;
  } catch (error) {
    showError(error);
    return -1;
  }
}

/* ---------------- 双向定位：原文 ↔ 树（#30 / ADR-0019） ---------------- */

/** 焦点回原文视图（右键菜单关闭时归还；ADR-0015）。 */
function focusRaw(): void {
  rawHost.querySelector<HTMLElement>('.tjv-raw')?.focus();
}

/** 900ms 高亮（与 Apply 后的 changed 高亮同一视觉/时长）。 */
function flashTreePath(path: string): void {
  tree.setChangedPath(path);
  window.setTimeout(() => tree.setChangedPath(null), CHANGED_FLASH_MS);
}

let locateBusy = false;
let statusHint: string | null = null;
let statusHintTimer = 0;

/** 常驻状态栏提示（保真对照用）：不自动消失，下一次跳转 / 换文档 / 切标签时清除。 */
function setStatusHintSticky(text: string): void {
  window.clearTimeout(statusHintTimer);
  statusHint = text;
  updateStatus();
}

/** 清掉常驻/临时状态栏提示（换文档、切标签时调用）。 */
function clearStatusHint(): void {
  window.clearTimeout(statusHintTimer);
  statusHint = null;
}

/** 状态栏临时文案（ADR-0019 §4）：不新增提示条/对话框，约 3s 后恢复。 */
function showStatusHint(text: string): void {
  statusHint = text;
  updateStatus();
  window.clearTimeout(statusHintTimer);
  statusHintTimer = window.setTimeout(() => {
    statusHint = null;
    updateStatus();
  }, 3000);
}

/**
 * 树 → 原文（#30 / ADR-0019）：path→offset 由 worker 单趟扫描（结果按根 LRU 缓存）。
 * 同一节点来回对照走本标签记住的锚点，第二次起不扫（0ms）。
 */
async function jumpTreeToRaw(path: string): Promise<number> {
  if (!session.rootId || expression.active) return -1;
  const rid = session.rootId;
  const remembered = rawTreeAnchor !== null && rawTreeAnchor.path === path ? rawTreeAnchor : null;
  if (remembered) {
    await setViewMode('raw');
    if (rid !== session.rootId || !isRawView()) return -1;
    rawView.flashLine(remembered.line);
    return remembered.line;
  }
  if (locateBusy) return -1;
  locateBusy = true;
  updateStatus();
  try {
    const reply = await core.rawOffsetOf({ rootId: rid, path });
    // 迟到回包：已换文档/标签（ADR-0009 §2 的 rootId 路由口径）
    if (rid !== session.rootId) return -1;
    if (reply.offset === null || reply.line === null) {
      showStatusHint(t('app.toast.locateEdited'));
      return -1;
    }
    rawTreeAnchor = { path, line: reply.line };
    await setViewMode('raw');
    if (rid !== session.rootId || !isRawView()) return -1;
    rawView.flashLine(reply.line);
    return reply.line;
  } catch (error) {
    showError(error);
    return -1;
  } finally {
    locateBusy = false;
    updateStatus();
  }
}

/**
 * 原文 → 树（#30 / ADR-0019）：行首 token 反查路径（检查点索引 ≈0.1ms），
 * 展开祖先 + 选中 + 居中 + 900ms 高亮；路径被临时修改删掉时回退到最近仍存在的祖先。
 */
async function jumpRawToTree(line: number): Promise<string | null> {
  if (!session.rootId || locateBusy) return null;
  const rid = session.rootId;
  locateBusy = true;
  updateStatus();
  try {
    const reply = await core.rawPathAt({ rootId: rid, line });
    if (rid !== session.rootId) return null;
    if (reply.path === null) {
      showStatusHint(t('app.toast.locateNoNode'));
      return null;
    }
    const sourcePath = reply.path;
    let target = sourcePath;
    // 静默尝试：源文本里的路径可能已被临时修改删掉/改名 → 逐级回退到仍存在的祖先
    let jumped = await jumpToPath(target, { silent: true });
    let fallback = false;
    while (!jumped.ok && target !== ROOT_PATH) {
      const parent = parentPath(target);
      if (!parent) break;
      target = parent;
      fallback = true;
      jumped = await jumpToPath(target, { silent: true });
    }
    if (!jumped.ok) {
      showStatusHint(t('app.toast.locateNoTree'));
      return null;
    }
    if (fallback) showStatusHint(t('app.toast.locateEditedAncestor'));
    flashTreePath(target);
    rawTreeAnchor = { path: sourcePath, line };
    return target;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    locateBusy = false;
    updateStatus();
  }
}

/**
 * 首帧动态文案（ADR-0026 §3）：page.html 默认只留英文；空态标题/副标题、编辑角标、原文
 * 视图文案与状态栏由 main.ts 渲染（不打 data-i18n 标记），启动时按当前 locale 回填一次。
 * 幂等：locale 切换后可安全重放（有文档时只重画状态栏/角标，不覆盖已渲染的空态形态）。
 */
function renderInitialChrome(): void {
  if (!session.rootId && importLayer.mode() === 'initial') {
    emptyTitle.textContent = t('app.empty.title.initial');
    emptySub.textContent = t('app.empty.sub.initial');
  }
  renderEditBadge();
  updateStatus();
}

/**
 * 界面语言切换后的全量重渲染（#45 / ADR-0026 §3）：静态标记 → 面板静态标签 → 动态文案。
 * 幂等；worker 诊断是结构化数据，重画即按新语言格式化（无需重发命令）。
 */
function rerenderChrome(): void {
  document.documentElement.lang = currentLocale();
  applyStaticMessages();
  // 左面板标题（活动栏 aria 由静态标记覆盖）
  const panel = (document.body.dataset.panel as PanelId | undefined) ?? 'doc';
  panelTitle.textContent = t(PANEL_TITLES[panel]);
  settingsPanel.relabel();
  searchPanel.relabel();
  outlinePanel.relabel();
  expressionPanel.relabel();
  expressionBar.relabel();
  tabStrip.relabel();
  tree.relabel();
  rawView.relabel();
  // 选中节点提示 / 状态栏主题文案也随语言（setTheme 同时写 dataset.theme，幂等）
  setTheme(settings.get('theme'));
  setSelection(selected);
  // 有文档：工具栏/文件 chip/三条提示条/原文头/状态栏；无文档：空态 + 状态栏
  renderTabChrome();
  renderEditBadge();
  renderProfile();
  renderInitialChrome();
  expression.applyInlineText();
  if (searchPatternCore && searchState.view().patternError) {
    searchState.markPatternError(patternErrorText(searchPatternCore));
    renderSearch();
  }
  // 入口层：状态机出 view（key 不是文案），adapter 重画即完成本地化（ADR-0026 §3）
  importLayer.relabel();
}

function updateStatus(): void {
  if (!session.rootId || !meta) {
    statusRows.textContent = t('app.status.rows.none');
    statusSize.textContent = '—';
    statusPath.textContent = '';
    statusState.textContent = t('app.status.readonly');
    return;
  }
  if (locateBusy) {
    statusRows.textContent = t('app.status.locating');
  } else if (isRawView()) {
    const rawSnapshot = rawSource.snapshot();
    const lines = rawMetaInfo?.totalLines ?? rawSnapshot.totalLines;
    statusRows.textContent = t('app.status.raw', { n: lines, rendered: rawSnapshot.lines.length });
  } else {
    const snapshot = rowSource.snapshot();
    statusRows.textContent = t('app.status.tree', {
      n: session.totalRows,
      rendered: snapshot.rows.length,
    });
  }
  statusSize.textContent = `${formatBytes(meta.bytes)} · v${session.docRevision}`;
  statusPath.textContent = selected ?? ROOT_PATH;
  statusPath.title = selected ?? ROOT_PATH;
  // 表达式结果视图：状态栏明确「这不是文档」（ADR-0018 §1），并并列该行的**原文档路径**（#47 #8 / ADR-0027）。
  // 原路径随行窗口回包（`originPath` 字段），页面不自算映射；计算值显示「计算值」。
  const resultRoot = expression.activeRootId();
  if (resultRoot !== null) {
    if (selected) {
      expression.refreshOrigin();
      const cached = expression.selectedOrigin;
      if (cached !== null && cached.path === selected && cached.rootId === resultRoot) {
        const originText = cached.origin ?? t('app.status.exprComputed');
        statusPath.textContent = `${selected} ← ${originText}`;
        statusPath.title = statusPath.textContent;
      }
    }
    statusState.textContent = t('app.status.expr', { rootId: resultRoot });
    return;
  }
  // 临时提示（双向定位失败/回退等）优先于常驻态（ADR-0019 §4）
  if (statusHint !== null) {
    statusState.textContent = statusHint;
    return;
  }
  // 修复角标独立于修复条显隐：数据仍不完整，状态栏要一直能看出来
  const repaired = meta.repair?.status === 'repaired';
  const repairedTag = repaired ? t('app.status.repaired') : '';
  statusState.textContent = editState.dirty
    ? repairedTag + t('app.status.edited', { n: editState.count })
    : repairedTag + t('app.status.readonly');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 十进制口径（1 MB = 10^6 B）：只给「导入体积提示条」用，与 50 MB 十进制阈值同单位。 */
function formatBytesDecimal(bytes: number): string {
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatCoreError(error: unknown): string {
  const coreError = CoreError.from(error);
  const detail =
    coreError.code === 'PARSE' && coreError.line ? t('app.error.lineSuffix', { line: coreError.line }) : '';
  return `${coreError.code}: ${coreError.message}${detail}`;
}

let toastTimer = 0;

/**
 * 短暂反馈；错误走 showError（4s）。共用 #toast，后到的消息重置计时。
 * tone 决定边框语义色（默认中性）：成功 = success、失败/错误 = danger。
 */
function showToast(text: string, ms = 2000, tone: 'info' | 'success' | 'error' = 'info'): void {
  toast.textContent = text;
  toast.dataset.tone = tone;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, ms);
}

function showError(error: unknown): void {
  showToast(formatCoreError(error), 4000, 'error');
}

/* ---------------- resize ---------------- */

const resizeObserver = new ResizeObserver(() => {
  rowSource.setMetrics(metrics());
  rowSource.requestWindow();
  rawSource.setMetrics(rawMetrics());
  if (isRawView()) rawSource.requestWindow();
});
resizeObserver.observe(treeHost);
resizeObserver.observe(rawHost);

window.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
  // 有未导出的临时修改：浏览器原生确认（edit-spec §5）
  if (editState.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
  // 经 transport close：reject 所有 pending（CLOSED）并关闭端口，再 terminate worker
  workerCore.close();
});

/* ---------------- dev-only hook (HTTP smoke harness) ---------------- */

/**
 * 测试钩子装配表（ADR-0008 修订 2026-11-09）：这里只列「钩子要哪些模块 / 入口 / 元素」，
 * 快照组装与转发逻辑在 `app/dev-hook.ts`。扩展构建不安装（smoke-extension 断言其不存在）。
 */
function buildDevHookDeps(): DevHookDeps {
  return {
    session,
    core,
    meta: () => meta,
    selected: () => selected,
    editingPath: () => editingPath,
    setEditingPath: (path) => {
      editingPath = path;
    },
    isRawView,
    viewModeAttr: () => document.body.dataset.view ?? null,
    rawMetaInfo: () => rawMetaInfo,
    fidelityReport: () => fidelity,
    fidelityPending: () => fidelityPending,
    fidelityIndex: () => fidelityIndex,
    exportLastAction: () => exportLastAction,
    // 与真实导出口径一致（表达式结果视图下也是 -expr-N.json，ADR-0021）
    exportFileName: () => currentExportName(),
    // 文档概要（#43 / ADR-0025）：冒烟直接向 worker 要当前文档根的 profile（null = 无文档）
    documentProfile: () => {
      const target = profileTarget();
      return target === null ? Promise.resolve(null) : core.profile(target.rootId);
    },
    tree,
    rowSource,
    rawView,
    rawSource,
    searchState,
    searchPanel,
    outlineState,
    outlinePanel,
    editState,
    subtreeEditor,
    settings,
    entries: {
      // dev hook 的 loadText 语义固定为「替换当前文档」（自动化既有契约；不跟随设置「导入位置」）
      importText: (text, name) => importBuffer('file', text, name, 'replace'),
      toggleNode,
      expandAll: applyExpandAll,
      runSearch,
      searchNext,
      searchPrev,
      gotoHit,
      applyFilter,
      markSearchStale,
      searchHide: hideSearchHit,
      searchRestoreHidden: restoreHiddenHits,
      setPanel: (panel) => {
        if (panel !== 'none') setPanel(panel);
      },
      jumpToPath,
      openEditor,
      applyEditText,
      undo: undoEdit,
      redo: redoEdit,
      resetEdits: () => resetEdits(true),
      setViewMode,
      revealRepairOffset,
      jumpTreeToRaw,
      jumpRawToTree,
      locateBusy: () => locateBusy,
      locateAnchor: () => rawTreeAnchor,
      rawCtxMenu,
      rawCtxOpen: showRawContextMenu,
      openSettings: () => {
        setPanel('settings');
        return {
          panel: document.body.dataset.panel ?? null,
          title: panelTitle.textContent ?? '',
          focused:
            settingsHost.contains(document.activeElement) || document.activeElement === settingsHost,
          rows: [...settingsHost.querySelectorAll<HTMLElement>('[data-setting]')].map(
            (row) => row.dataset.setting ?? '',
          ),
        };
      },
      treeGeometry: () => {
        // --row-h 设在树滚动容器上（tree-view mount 时写入），不是 :root
        const scroller = document.querySelector<HTMLElement>('.tjv-tree');
        const firstRow = document.querySelector<HTMLElement>('.row');
        return {
          rowHeight: tree.rowHeightPx(),
          viewportRows: tree.viewportRows(),
          totalRows: session.totalRows,
          rowHeightCss: scroller ? getComputedStyle(scroller).getPropertyValue('--row-h').trim() : '',
          rowHeightComputed: firstRow ? getComputedStyle(firstRow).height : '',
          indentCss: getComputedStyle(document.documentElement).getPropertyValue('--row-indent').trim(),
          typeColumnVisible: tree.typeColumnVisible(),
          spacerHeight: tree.spacerHeight(),
        };
      },
      contextMenu: {
        menu: ctxMenu,
        items: ctxItems,
        show: showContextMenu,
        rowElement: (path) =>
          treeHost.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(path)}"]`),
      },
      clipboardText: async () => {
        try {
          return await navigator.clipboard.readText();
        } catch {
          return null;
        }
      },
    },
    ui: {
      statusRows,
      editBadge,
      toast,
      viewTreeBtn,
      viewRawBtn,
      rawNotice,
      rawMetaLabel,
      rawModeLabel,
      rawCopyBtn,
      repairBar,
      repairText,
      repairOps,
      repairToggle,
      repairClose,
      repairStatusState: statusState,
      fidelityBar,
      fidelityNotice,
      fidelityJump,
      fidelityClose,
      fidelityPrev,
      fidelityNext,
      fidelityCount,
      exportBtn,
      exportMenu,
      exportMenuBtn,
      exportMenuItems,
      currentExportMode,
      chooseExport: (mode) => {
        const item = exportMenuItems().find(
          (entry) => entry.dataset.exportMode === normalizeExportMode(mode),
        );
        item?.click();
        return Boolean(item);
      },
      openExportMenu: () => exportMenuBtn.click(),
      clickExportMain: () => exportBtn.click(),
      clipboardMaxBytes: () => CLIPBOARD_MAX_BYTES,
    },
    // 表达式视图（#27 / ADR-0018 §9）：模块句柄 + 真实入口
    expression: {
      panel: expressionPanel,
      bar: expressionBar,
      view: () => expression.view,
      active: () => expression.active,
      stale: () => expression.stale(),
      budget: () => settings.get('advBudget'),
      statusState: () => statusState.textContent ?? '',
      entries: {
        open: async () => {
          setPanel('expression');
          await expressionPanel.mount();
          expression.refreshExamples();
        },
        setText: (text) => expressionPanel.setText(text),
        run: async () => {
          await expression.run();
        },
        runText: async (text) => {
          expressionPanel.setText(text);
          await expression.run(text);
        },
        complete: async (text, pos) => {
          const current = text ?? expressionPanel.getText();
          return expression.completions(current, pos ?? current.length);
        },
        setStrict: (strict) => {
          expressionPanel.setStrict(strict);
        },
        back: () => {
          expression.back({ silent: true });
          setPanel('doc');
        },
        rerun: async () => {
          await expression.rerun();
        },
        locate: async (path) => expression.locate(path ?? null),
        setBudget: (level) => settings.set('advBudget', level),
      },
    },
    // 多文档工作区（#18 / ADR-0009 §9）
    workspace: {
      state: () => workspaceHookState(),
      entries: {
        openNewTab: () => importLayer.openNewTab(),
        importText: (text, name) => importBuffer('file', text, name, 'new-tab'),
        switchTab: (id) => switchTab(id),
        closeTab: (id) => closeTab(id, { force: true }),
      },
    },
  };
}

/**
 * 工作区快照（dev hook）：标签数据来自 `WorkspaceState`（活动标签的版本字段取实时会话，
 * 其余标签取切走时存档值），strip 是**DOM/布局探针**（高度来自 inline style）。
 */
function workspaceHookState(): WorkspaceHookState {
  const view = workspace.view();
  const stripEl = el('tabStrip');
  const addBtn = document.querySelector<HTMLButtonElement>('#tabAdd');
  const rendered = [...stripEl.querySelectorAll<HTMLElement>('.tabstrip__tab')];
  return {
    size: workspace.size,
    max: workspace.max,
    activeId: view.activeId,
    canAdd: view.canAdd,
    hidden: view.hidden,
    tabs: workspace.ids.map((id) => {
      const tab = workspace.get(id);
      if (!tab) return null;
      const live = id === view.activeId && !expression.active;
      return {
        id,
        name: tab.name,
        active: id === view.activeId,
        rootId: tab.rootId,
        docRevision: live ? session.docRevision : tab.docRevision,
        totalRows: live ? session.totalRows : tab.totalRows,
        editCount: tab.runtime.editState.count,
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    strip: {
      hidden: stripEl.hidden,
      heightPx: Math.round(stripEl.getBoundingClientRect().height),
      styleHeightPx: Number.parseFloat(stripEl.style.height) || 0,
      role: stripEl.getAttribute('role'),
      rendered: rendered.length,
      addDisabled: addBtn?.disabled ?? true,
      addTitle: addBtn?.title ?? '',
      labels: rendered.map((node) => node.querySelector('.tabstrip__title')?.textContent ?? ''),
      selectedId:
        rendered.find((node) => node.getAttribute('aria-selected') === 'true')?.dataset.tabId ?? null,
      layer: importLayer.hookState(),
    },
  };
}

/**
 * 测试钩子 deps 只装配一次；切标签时把**可变模块句柄**改成活动标签的实例
 * （`rowSource` / `rawSource` / `searchState` / `editState` 会随标签替换，见 bindTab）。
 */
let hookDeps: DevHookDeps | null = null;

function refreshHookDeps(): void {
  if (!hookDeps) return;
  hookDeps.rowSource = rowSource;
  hookDeps.rawSource = rawSource;
  hookDeps.searchState = searchState;
  hookDeps.editState = editState;
}

expression.consumeWatchdogFlag();
if (!isExtension) {
  hookDeps = buildDevHookDeps();
  installDevHook(hookDeps);
  refreshHookDeps();
}

/* 模块初始化完成后的首次排序同步（#40 / ADR-0024）：此时表达式视图态已初始化，
 * 即使还没有文档也要发一次 setOrder，把持久化的规则同步给 Worker 服务级 order。 */
orderSyncReady = true;
void syncSortOrder(settings.get('sortOrder'));

/* 首帧动态文案按当前 locale 回填（空态标题/副标题、编辑角标、状态栏；ADR-0026 §3）。
 * page.html 的静态文案已由文件顶部的 applyStaticMessages() 回填。 */
renderInitialChrome();
