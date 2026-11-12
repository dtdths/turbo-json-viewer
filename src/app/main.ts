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
import { CoreError } from '../protocol/errors';
import {
  EXPR_BUDGETS,
  EXPR_EXAMPLES_DOC,
  EXPR_EXAMPLES_GENERIC,
  LARGE_DOC_WARN_BYTES,
  exprWatchdogMs,
} from '../protocol/versions';
import { parentPath, ROOT_PATH } from '../shared/path';
import {
  displayTitle,
  exportFileName,
  exprExportFileName,
  renameFromExport,
  sanitizeDocName,
  type ExportNameFlags,
} from '../shared/doc-name';
import type {
  CopyFormat,
  DocumentMeta,
  EvalReply,
  EvalSuccess,
  ExprBudgetLevel,
  ExprCompletion,
  FidelityHit,
  FidelityReport,
  JsonKind,
  RawMeta,
  Row,
} from '../protocol/types';
import type { EditReply, LoadReply } from '../protocol/messages';
import { DocSession, type LandingPlan, type SessionState } from './doc-session';
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
import { SettingsPanel } from '../view/panels/settings-panel';
import { NoticeBar } from '../view/panels/notice-bar';
import { ExpressionPanel } from '../view/panels/expression-panel';
import { ExpressionBar } from '../view/panels/expression-bar';
import { EXPR_COPY, exprErrorText } from '../shared/expression-copy';
import { createMenu } from '../view/menu';
import { createViewStateStore } from './storage';

const chromeApi = (globalThis as { chrome?: { runtime?: { id?: string; getURL(path: string): string } } }).chrome;
const isExtension = Boolean(chromeApi?.runtime?.id);

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
const emptyWarnDoc = el('emptyWarnDoc');
const emptyError = el('emptyError');
const emptyPending = el('emptyPending');
const emptyPendingName = el('emptyPendingName');
const emptyPendingReplace = el<HTMLButtonElement>('emptyPendingReplace');
const emptyBusy = el('emptyBusy');
const emptyClose = el<HTMLButtonElement>('emptyClose');
/** 入口层「替换 ⇄ 新标签」切换（#18：单文档时标签条隐藏，这是开第 2 个标签的可见入口） */
const emptyModeToggle = el<HTMLButtonElement>('emptyModeToggle');
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

/** 每标签的非 adapter 视图态（原文索引元信息 / 保真报告 / 表达式结果视图 / 滚动位置）。 */
interface TabExtras {
  rawMetaInfo: RawMeta | null;
  fidelity: FidelityReport | null;
  /** 最近一次成功的表达式结果（会话内保留；换文档即清） */
  exprView: ExprViewState | null;
  /** 树的滚动位置（切回来时恢复，ADR-0009 §3「滚动锚点」） */
  scrollTopPx: number;
  /** 搜索选项（Aa / .*）：与每标签 SearchState 的选项快照同源，切标签不串味（ADR-0014 §2.5） */
  searchOpts: { caseSensitive: boolean; regex: boolean };
  /** 原文视图的滚动位置（切回来时恢复） */
  rawScrollTopPx: number;
  /** 双向定位的上次对照锚点（#30 / ADR-0019 §5）：内存、per-tab、不持久化 */
  anchor: { path: string; line: number } | null;
}
const tabExtras = new Map<string, TabExtras>();
/** 活动标签的对照锚点（切标签时随 TabExtras 存取；#30 / ADR-0019 §5） */
let rawTreeAnchor: { path: string; line: number } | null = null;

function extrasOf(tabId: string): TabExtras {
  let extras = tabExtras.get(tabId);
  if (!extras) {
    extras = {
      rawMetaInfo: null,
      fidelity: null,
      exprView: null,
      scrollTopPx: 0,
      rawScrollTopPx: 0,
      searchOpts: { caseSensitive: false, regex: false },
      anchor: null,
    };
    tabExtras.set(tabId, extras);
  }
  return extras;
}

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
    if (exprViewActive) void jumpFromExpressionRow(path);
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
  onAdd: () => openNewTabLayer(),
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
let searchOpts: { caseSensitive: boolean; regex: boolean } = { caseSensitive: false, regex: false };

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

/* ---------------- 工作区接线（#18 / ADR-0009）：活动标签 ↔ 模块级视图态 ---------------- */

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

/** 把会话字段 / 选中 / 滚动位置存回当前活动标签（切走前调用；不在热路径上，不制造额外重绘）。 */
function saveActiveSession(): void {
  const tab = activeTab();
  if (!tab) return;
  const extras = extrasOf(tab.id);
  extras.rawMetaInfo = rawMetaInfo;
  extras.fidelity = fidelity;
  extras.exprView = exprView;
  extras.scrollTopPx = tree.scrollTopPx();
  extras.rawScrollTopPx = rawView.scrollTopPx();
  extras.searchOpts = { ...searchOpts };
  extras.anchor = rawTreeAnchor;
  workspace.update(tab.id, {
    docRevision: session.docRevision,
    rowVersion: session.rowVersion,
    totalRows: session.totalRows,
    selected,
  });
}

/**
 * 绑定一个标签：换 adapter 引用 + 重挂订阅 + 恢复该标签的会话/选中/非 adapter 视图态。
 * 不取窗口、不重画面板（那部分在 `restoreActiveTabView`，加载路径用 applyLanding 自己推）。
 */
function bindTab(tab: TabState): void {
  const extras = extrasOf(tab.id);
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
  rawMetaInfo = extras.rawMetaInfo;
  fidelity = extras.fidelity;
  exprView = extras.exprView;
  searchOpts = { ...extras.searchOpts };
  rawTreeAnchor = extras.anchor;
  clearStatusHint();
  // 表达式结果视图不跨标签自动激活：切回来时若左面板是表达式，由 setPanel('expression') 的
  // 既有恢复链路决定（见 switchTab）；这里一律先按「文档树」绑定会话。
  exprViewActive = false;
  docSessionBeforeExpr = null;
  refreshHookDeps();
}

/** 行尾「在原文中定位」入口开关（#30）：表达式结果根无源文本；plain（修复文档）无可靠映射。 */
function syncLocateRaw(): void {
  tree.setLocateRaw(!exprViewActive && meta?.repair === undefined);
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
  const extras = extrasOf(tab.id);
  // 树：同根同版本时 WindowMachine 保留上一帧（切回不闪白），滚动位置按标签恢复
  rowSource.setMetrics(metrics());
  rowSource.setRoot(
    { rootId: tab.rootId, rowVersion: tab.rowVersion, totalRows: tab.totalRows },
    { scrollTopPx: extras.scrollTopPx },
  );
  tree.scrollToPx(extras.scrollTopPx);
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
  // 表达式结果条：新标签没有激活的结果视图 → 隐藏（结果本体按标签保留在 extras）
  renderExpressionBar();
  // 原文视图：正看原文 → 为该标签重新 open（本标签已有索引元信息时 open 会复用 worker 侧索引）
  if (isRawView()) {
    const savedRaw = extras.rawScrollTopPx;
    void setViewMode('raw', { persist: false }).then(() => {
      // 切标签期间别把滚动写到别的标签上；savedRaw=0 就是回顶（无需额外动作）
      if (workspace.activeId !== tab.id || !isRawView() || savedRaw <= 0) return;
      rawView.scrollToPx(savedRaw);
      rawSource.scrollTo(savedRaw);
      rawSource.requestWindow();
    });
  } else updateStatus();
}

/** 切标签：存档旧标签 → 换绑定 → 重绘（不关根、不重解析，ADR-0009 §3）。 */
function switchTab(id: string): void {
  if (id === workspace.activeId) return;
  if (activeTab()) {
    // 表达式结果视图是文档级临时视图：切走先回文档树（结果保留在本标签 extras，重进可恢复）
    if (exprViewActive) backToDocTree({ silent: true });
    cancelInFlightExpression();
    saveActiveSession();
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
    !window.confirm(`「${tab.name}」有未导出的临时修改，关闭后将丢弃。确认关闭？`)
  ) {
    return;
  }
  const wasActive = workspace.activeId === id;
  const result = workspace.remove(id);
  if (!result) return;
  tabExtras.delete(id);
  // closeRoot 幂等（未知根回 closed:false）；失败不阻断关闭
  void core.closeRoot(result.removed.rootId).catch(() => undefined);
  // 关到只剩 1 个 → 标签条隐藏：焦点必须离开被移除的标签，回树（a11y）
  if (workspace.size === 1) focusTree();
  if (workspace.size === 0) {
    enterEmptyState();
    return;
  }
  if (!wasActive) return;
  cancelInFlightExpression();
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
  rawOpenSeq += 1;
  exprView = null;
  exprViewActive = false;
  docSessionBeforeExpr = null;
  cancelInFlightExpression();
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
  searchOpts = { caseSensitive: false, regex: false };
  resetSearch();
  outlineState.close();
  document.body.dataset.view = 'tree';
  viewTreeBtn.classList.add('is-active');
  viewTreeBtn.setAttribute('aria-pressed', 'true');
  viewRawBtn.classList.remove('is-active');
  viewRawBtn.setAttribute('aria-pressed', 'false');
  // 导入层回初始空态
  resetImportLayerView();
  empty.classList.remove('is-hidden');
  empty.classList.remove('is-busy');
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
  renderExpressionBar();
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
  showToast(
    `工作区现有 ${workspace.size} 个标签：内存按文档线性增长（50 MB ≈ 73 MB Worker 堆/份）。关闭不用的标签可释放。`,
    5000,
  );
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
  const forActiveExpr = exprViewActive && exprView !== null && rootId === exprView.rootId;
  if (!forActiveDoc && !forActiveExpr) return;
  // 表达式视图内的展开/折叠会推进 expr 根的 rowVersion：同步视图态（重进表达式模式时用）
  if (forActiveExpr && exprView) {
    exprView.rowVersion = plan.state.rowVersion;
    exprView.totalRows = plan.state.totalRows;
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
  const shownRoot = exprViewActive && exprView ? exprView.rootId : tab.rootId;
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
}

settings.subscribe(() => applySettings());
applySettings();

/* ---------------- 表达式视图（#12 / #27 / ADR-0018） ---------------- */

/**
 * 表达式结果视图态。`exprView` = **最近一次成功结果**的元信息（会话内保留，换文档即清）；
 * `exprViewActive` = 树区当前是否显示该结果根（「切文档树模式即回」后仍保留，重进表达式模式可恢复）。
 * 结果根本体在 worker 的 RootStore 里（LRU 3），页面只持坐标，不持文档。
 */
interface ExprViewState {
  rootId: string;
  docRevision: number;
  rowVersion: number;
  totalRows: number;
  count: number;
  kind: JsonKind;
  ms: number;
  steps: number;
  truncated: boolean;
  skipped: number;
  text: string;
  strict: boolean;
  budget: ExprBudgetLevel;
  seq: number;
}

let exprView: ExprViewState | null = null;
let exprViewActive = false;
/** 进入表达式视图前的文档会话（返回文档树时原样 restore；表达式视图不改文档根版本） */
let docSessionBeforeExpr: SessionState | null = null;
/** 求值序号：迟到回包丢弃（与 search 同口径） */
let exprSeq = 0;
let exprRunning = false;
/** 最近一次成功执行的表达式文本（「重新执行」用；面板被改过则以面板当前文本为准） */
let exprLastText = '';

/**
 * 作废在途求值（切标签 / 关标签 / 回空态时调用）：seq 自增让迟到回包被丢弃，
 * 同时解开 running 闸门（否则新标签面板会一直显示「执行中」且拒绝再执行）。
 */
function cancelInFlightExpression(): void {
  exprSeq += 1;
  exprRunning = false;
  expressionPanel.setRunning(false);
}

const expressionBar = new ExpressionBar(exprBarRoot);

const expressionPanel = new ExpressionPanel(expressionHost, {
  onRun: (text, strict) => {
    void runExpression(text, strict);
  },
  onComplete: (text, pos) => requestCompletions(text, pos),
  onTextChange: () => {
    // 输入变化即清旧错误（不让上一次的行内错误误导）
    expressionPanel.setError(null);
  },
  onStrictChange: () => {
    /* 严格模式是会话级、面板自持；执行时从面板读 */
  },
});

expressionBar.onBack(() => {
  backToDocTree();
  setPanel('doc');
});
expressionBar.onRerun(() => {
  void runExpression(expressionPanel.getText() || exprLastText, expressionPanel.getStrict());
});
expressionBar.onClose(() => {
  // 结果视图没有「只关条」的语义（关掉条会让人以为结果消失了）→ 等价「返回文档树」
  backToDocTree();
  setPanel('doc');
});

/** 文档根 id（表达式视图激活时 `session.rootId` 是 expr 根，不能用它求值/补全）。 */
function documentRootId(): string | null {
  if (exprViewActive) return docSessionBeforeExpr?.rootId ?? null;
  return session.rootId;
}

/** 当前文档版本的唯一口径（表达式视图激活时取进入前的文档会话）。 */
function currentDocRevision(): number {
  if (exprViewActive && docSessionBeforeExpr) return docSessionBeforeExpr.docRevision;
  return session.docRevision;
}

/** 结果是否过期：文档改过（docRevision 不匹配）→ stale banner + 「重新执行」，**不自动重跑**。 */
function exprIsStale(): boolean {
  return exprView !== null && !exprViewActive && exprView.docRevision !== currentDocRevision();
}

/** 引擎错误码 → 中文文案（唯一来源 shared/expression-copy.ts）。 */
function showExpressionError(error: { message: string; line?: number; column?: number }): void {
  expressionPanel.setError(error);
  expressionPanel.setStatus('');
}

/** 执行一次表达式（面板「执行」/ Enter / 结果条「重新执行」共用）。 */
async function runExpression(textArg?: string, strictArg?: boolean): Promise<void> {
  if (exprRunning) return;
  const rootId = documentRootId();
  if (!rootId) {
    showToast('请先导入文档，再执行表达式', 2500, 'error');
    return;
  }
  const text = (textArg ?? expressionPanel.getText()).trim();
  const strict = strictArg ?? expressionPanel.getStrict();
  if (!text) {
    expressionPanel.setError(null);
    expressionPanel.setStatus('');
    return;
  }
  const budget = settings.get('advBudget');
  const seq = ++exprSeq;
  exprRunning = true;
  expressionPanel.setRunning(true);
  expressionPanel.setError(null);
  expressionPanel.setStatus(EXPR_COPY.running);
  try {
    const reply = await evalWithWatchdog({ rootId, seq, text, strict, budget });
    if (seq !== exprSeq) return; // 迟到回包（又执行了一次）
    if (!reply.ok) {
      showExpressionError({
        message: exprErrorText(reply.error),
        line: reply.error.line,
        column: reply.error.column,
      });
      // 保留上一份结果视图（错误只作用于输入，不清已经跑出来的结果）
      return;
    }
    exprLastText = text;
    expressionPanel.addHistory(text);
    enterExpressionView(reply, text, strict, budget);
  } catch (error) {
    // watchdog 触发时页面会重载；其余错误照常提示
    if (CoreError.from(error).code !== 'CLOSED') showError(error);
  } finally {
    if (seq === exprSeq) {
      exprRunning = false;
      expressionPanel.setRunning(false);
    }
  }
}

/**
 * 求值 + 主线程硬看门狗（ADR-0018 §6）：`3 × maxTime` 仍无回包 → terminate + 页面重载。
 * 预算正常（引擎三刹车）时永不触发；这是「引擎自身 bug 导致真卡死」的最后兜底。
 */
async function evalWithWatchdog(req: {
  rootId: string;
  seq: number;
  text: string;
  strict: boolean;
  budget: ExprBudgetLevel;
}): Promise<EvalReply> {
  const timeoutMs = exprWatchdogMs(req.budget);
  return await new Promise<EvalReply>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      restartAfterWatchdog();
      reject(new Error('expression watchdog fired'));
    }, timeoutMs);
    core.eval(req).then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** watchdog 触发：终止 worker → 标记重载提示 → 重载页面（文档必须重新导入；沿用 ReDoS 差距）。 */
function restartAfterWatchdog(): void {
  try {
    workerCore.close();
  } catch {
    /* 已死 */
  }
  try {
    sessionStorage.setItem(EXPR_WATCHDOG_FLAG, '1');
  } catch {
    /* 隐私模式 */
  }
  location.reload();
}

/** 结果成为树区当前视图根（复用 DocSession 的落地链路；文档根会话先存档）。 */
function enterExpressionView(
  reply: EvalSuccess,
  text: string,
  strict: boolean,
  budget: ExprBudgetLevel,
): void {
  const wasActive = exprViewActive;
  // 结果视图只有树形态：当前在原文视图时先切回树视图（此时 exprViewActive 仍为 false，
  // 走不到 setViewMode 顶部的「离开表达式 → 回文档树」守卫）
  if (!wasActive && isRawView()) void setViewMode('tree');
  if (!wasActive) docSessionBeforeExpr = session.snapshot;
  exprView = {
    rootId: reply.rootId,
    docRevision: reply.docRevision,
    rowVersion: reply.rowVersion,
    totalRows: reply.totalRows,
    count: reply.count,
    kind: reply.kind,
    ms: reply.ms,
    steps: reply.steps,
    truncated: reply.truncated,
    skipped: reply.skipped,
    text,
    strict,
    budget,
    seq: exprSeq,
  };
  exprViewActive = true;
  syncLocateRaw();
  const plan = session.land(reply, { kind: 'expression' });
  applyLanding(plan);
  renderExpressionBar();
  expressionPanel.setStatus(EXPR_COPY.status(reply.count, Math.round(reply.ms)));
  updateStatus();
}

/** 结果条文案/态（正常 / stale / 截断 + 跳过）。 */
function renderExpressionBar(stale = false): void {
  if (!exprView || !exprViewActive) {
    expressionBar.hide();
    return;
  }
  expressionBar.show({
    rootId: exprView.rootId,
    count: exprView.count,
    ms: exprView.ms,
    truncated: exprView.truncated,
    skipped: exprView.skipped,
    maxResult: EXPR_BUDGETS[exprView.budget].maxResult,
    stale,
  });
}

/** 返回文档树：恢复进入表达式视图前的文档会话；结果根保留在 worker LRU（可重进恢复）。 */
function backToDocTree(opts: { silent?: boolean } = {}): void {
  if (!exprViewActive) return;
  exprViewActive = false;
  syncLocateRaw();
  expressionBar.hide();
  const saved = docSessionBeforeExpr;
  docSessionBeforeExpr = null;
  if (saved) {
    session.restore(saved);
    const state = session.snapshot;
    if (state.rootId) {
      rowSource.setRoot(
        { rootId: state.rootId, rowVersion: state.rowVersion, totalRows: state.totalRows },
        { scrollTopPx: 0 },
      );
      tree.scrollToPx(0);
      rowSource.requestWindow();
    }
  }
  tree.setSelected(null);
  setSelection(null);
  updateStatus();
  if (!opts.silent) focusTree();
}

/** 表达式结果行 → 原文档节点（点结果行；ADR-0018 §1/§4.3）。 */
async function jumpFromExpressionRow(path: string): Promise<void> {
  if (!exprView || !exprViewActive) return;
  try {
    const reply = await core.exprLocate({ rootId: exprView.rootId, path });
    if (reply.path === null) {
      showToast(EXPR_COPY.noSource, 2500, 'error');
      return;
    }
    const target = reply.path;
    backToDocTree({ silent: true });
    setPanel('doc');
    await jumpToPath(target);
  } catch (error) {
    showError(error);
  }
}

/** 静态补全：worker 数据源；异常降级为空列表（补全不能打断输入）。 */
async function requestCompletions(text: string, pos: number): Promise<ExprCompletion[]> {
  const rootId = documentRootId();
  if (!rootId) return [];
  try {
    const reply = await core.complete({ rootId, text, pos });
    return reply.items;
  } catch {
    return [];
  }
}

/** 示例（ADR-0018 §1）：文档顶层字段动态 3 条 + 通用 2 条；无文档只给通用 2 条。 */
async function buildExpressionExamples(): Promise<string[]> {
  const generic = [EXPR_EXAMPLES_GENERIC_LIST[0], EXPR_EXAMPLES_GENERIC_LIST[1]];
  const rootId = documentRootId();
  if (!rootId) return generic;
  try {
    const items = await requestCompletions('', 0);
    const fields = items.filter((item) => item.kind === 'field');
    const picks: string[] = [];
    for (const field of fields) {
      if (picks.length >= EXPR_EXAMPLES_DOC) break;
      const isArray = (field.detail ?? '').includes('array');
      picks.push(isArray ? `$.${field.label}.slice(0, 5)` : `$.${field.label}`);
    }
    if (picks.length < EXPR_EXAMPLES_DOC) picks.push('$');
    return [...picks.slice(0, EXPR_EXAMPLES_DOC), ...generic];
  } catch {
    return generic;
  }
}

/** 通用语法示例（ADR-0018 §1）：永远可执行，不需要文档特定字段。 */
const EXPR_EXAMPLES_GENERIC_LIST = [
  `$?.missing_field ?? 'fallback'`,
  `typeof $ === 'object' ? 'object' : typeof $`,
];

/** 刷新面板示例（打开面板 / 换文档时调用）。 */
function refreshExpressionExamples(): void {
  void buildExpressionExamples().then((items) => expressionPanel.setExamples(items));
}

/** watchdog 重载后的提示标记（sessionStorage 在重载后仍可读）。 */
const EXPR_WATCHDOG_FLAG = 'tjv.expr.watchdog';

function consumeWatchdogFlag(): void {
  try {
    if (sessionStorage.getItem(EXPR_WATCHDOG_FLAG) !== '1') return;
    sessionStorage.removeItem(EXPR_WATCHDOG_FLAG);
    showToast(EXPR_COPY.watchdog, 6000, 'error');
  } catch {
    /* 隐私模式 */
  }
}

/* ---------------- import layer（文档入口层） ---------------- */

const EMPTY_TITLE_INITIAL = '拖入 JSON，毫秒级开始查看';
const EMPTY_TITLE_REPLACE = '打开新文档';
const EMPTY_TITLE_NEW_TAB = '在新标签中打开';
const EMPTY_SUB_INITIAL = '本地只读 · 数据不经过网络 · 50 MB 文档由 Worker 常驻';
const EMPTY_SUB_REPLACE = '本地只读 · 数据不经过网络 · 原文件不受影响';
const EMPTY_SUB_NEW_TAB = '本地只读 · 新标签与当前文档并存，可随时切换';

/** 入口层三种形态（#18 / ADR-0009 §5）：空态 / 替换当前标签 / 新标签。 */
type ImportMode = 'initial' | 'replace' | 'new-tab';

/** 外部拖放 → 替换层里暂存的文件（等待用户确认，Q6-A） */
let pendingFile: File | null = null;

/** 入口层是否正在解析（busy 期间拒绝新的 paste / drop，避免并发导入互相抢占）。 */
function importLayerBusy(): boolean {
  return importLayerOpen() && empty.classList.contains('is-busy');
}

function importLayerOpen(): boolean {
  return !empty.classList.contains('is-hidden');
}

function importLayerMode(): ImportMode {
  const mode = empty.dataset.mode;
  if (mode === 'replace') return 'replace';
  if (mode === 'new-tab') return 'new-tab';
  return 'initial';
}

function setImportError(message: string | null): void {
  emptyError.textContent = message ?? '';
  emptyError.hidden = !message;
}

function setImportBusy(busy: boolean): void {
  emptyBusy.hidden = !busy;
  empty.classList.toggle('is-busy', busy);
  emptyPendingReplace.disabled = busy;
  pickBtn.disabled = busy;
  emptyModeToggle.disabled = busy;
}

function clearPendingFile(): void {
  pendingFile = null;
  emptyPending.hidden = true;
  emptyPendingName.textContent = '—';
}

/** 回到「初始空态」的文案/可见性（不改变 empty 整体显示/隐藏）。 */
function resetImportLayerView(): void {
  empty.dataset.mode = 'initial';
  empty.removeAttribute('role');
  empty.removeAttribute('aria-modal');
  empty.removeAttribute('aria-labelledby');
  emptyTitle.textContent = EMPTY_TITLE_INITIAL;
  emptySub.textContent = EMPTY_SUB_INITIAL;
  emptyWarn.hidden = true;
  emptyWarnDoc.textContent = '—';
  emptyClose.hidden = true;
  emptyModeToggle.hidden = true;
  emptyModeToggle.disabled = false;
  clearPendingFile();
  setImportError(null);
  setImportBusy(false);
}

/**
 * 把入口层切到指定形态（替换 / 新标签）：
 * - 替换：显示「将替换当前文档」警示（ADR-0004 导入层语义不变）；
 * - 新标签：**无覆盖警示**（ADR-0009 §5），复用同一张空态卡。
 * 两种形态之间用一个切换链接（`#emptyModeToggle`）互相可达——单文档时标签条隐藏，
 * 这是开第 2 个标签的可见入口（ADR-0009 §4「⌘O 新标签模式」的落地）。
 */
function applyImportLayerMode(mode: 'replace' | 'new-tab'): void {
  const isNew = mode === 'new-tab';
  empty.dataset.mode = mode;
  emptyTitle.textContent = isNew ? EMPTY_TITLE_NEW_TAB : EMPTY_TITLE_REPLACE;
  emptySub.textContent = isNew ? EMPTY_SUB_NEW_TAB : EMPTY_SUB_REPLACE;
  const active = activeTab();
  emptyWarnDoc.textContent = active ? `${active.name}（${formatBytes(active.meta.bytes)}）` : '当前文档';
  emptyWarn.hidden = isNew;
  emptyClose.hidden = false;
  emptyModeToggle.hidden = false;
  emptyModeToggle.textContent = isNew ? '改为替换当前文档' : '在新标签中打开';
}

/** 已打开文档时：打开入口层（替换 / 新标签两种形态）。返回是否真的打开。 */
function openImportLayer(target: 'replace' | 'new-tab' = 'replace'): boolean {
  if (!session.rootId || importLayerOpen()) return false;
  if (target === 'new-tab' && !workspace.view().canAdd) {
    showToast(`最多 ${workspace.max} 个标签，请先关闭不用的标签`, 3000, 'error');
    return false;
  }
  if (target === 'replace' && !confirmDiscardEdits()) return false;
  resetImportLayerView();
  applyImportLayerMode(target);
  empty.classList.remove('is-hidden');
  empty.setAttribute('role', 'dialog');
  empty.setAttribute('aria-modal', 'true');
  empty.setAttribute('aria-labelledby', 'emptyTitle');
  emptyInner.focus();
  return true;
}

/** 「新标签」入口（标签条 `＋` / ⌘⇧O / 替换层里的切换链接）。 */
function openNewTabLayer(): void {
  if (!session.rootId) return;
  if (importLayerOpen()) {
    if (importLayerMode() !== 'new-tab') toggleImportLayerMode();
    return;
  }
  openImportLayer('new-tab');
}

/** 入口层内「替换 ⇄ 新标签」切换。 */
function toggleImportLayerMode(): void {
  if (!importLayerOpen()) return;
  const next = importLayerMode() === 'new-tab' ? 'replace' : 'new-tab';
  if (next === 'replace' && !confirmDiscardEdits()) return;
  if (next === 'new-tab' && !workspace.view().canAdd) {
    showToast(`最多 ${workspace.max} 个标签，请先关闭不用的标签`, 3000, 'error');
    return;
  }
  applyImportLayerMode(next);
  setImportError(null);
  // 拖放已经暂存了文件时，切到「新标签」= 用户已经选定落点：立即以新标签导入。
  // 否则用户会遇到「点了在新标签中打开没反应，还要再点一次『替换』」的死循环感（用户反馈 2026-11-11）。
  const staged = pendingFile;
  if (next === 'new-tab' && staged) {
    clearPendingFile();
    void importFile(staged, 'new-tab');
  }
}

/** 取消入口层：丢弃在途导入回包，回到文档视图。 */
function closeImportLayer(): void {
  if (!session.rootId || !importLayerOpen()) return;
  if (empty.classList.contains('is-busy')) loadSeq += 1;
  empty.classList.add('is-hidden');
  resetImportLayerView();
  importBtn.focus();
}

/** 导入成功后隐藏入口层（初始空态、替换层或新标签层）。 */
function hideImportLayer(): void {
  empty.classList.add('is-hidden');
  resetImportLayerView();
}

/* ---------------- import ---------------- */

/** 本次导入应落到哪里：空工作区建第一个标签；入口层「新标签」形态 → 新增；其余 → 替换当前。 */
function currentImportTarget(): 'replace' | 'new-tab' {
  if (!workspace.activeId) return 'new-tab';
  const mode = importLayerOpen() ? importLayerMode() : 'replace';
  return mode === 'new-tab' ? 'new-tab' : 'replace';
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
    showToast(`最多 ${workspace.max} 个标签，请先关闭不用的标签`, 3000, 'error');
    return;
  }
  const loadId = ++loadSeq;
  const inLayer = importLayerOpen();
  if (inLayer) {
    clearPendingFile();
    setImportError(null);
    setImportBusy(true);
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
      setImportError(formatCoreError(error));
      setImportBusy(false);
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
 * 新标签不需要（runtime 是新建的），只清 extras。
 */
function resetTabStateForNewDoc(tab: TabState): void {
  tab.runtime.searchState.begin('', searchOpts);
  tab.runtime.editState.clear();
  tab.runtime.rawSource.clear();
  const extras = extrasOf(tab.id);
  extras.rawMetaInfo = null;
  extras.fidelity = null;
  extras.exprView = null;
  extras.scrollTopPx = 0;
  extras.rawScrollTopPx = 0;
  extras.searchOpts = { caseSensitive: false, regex: false };
  extras.anchor = null;
  rawOpenSeq += 1;
  fidelitySeq += 1;
  fidelityPending = false;
  cancelInFlightExpression();
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
  // 0) 表达式结果视图是临时换根：先回文档树，否则下面 saveActiveSession 会把 expr 根的
  //    rowVersion/totalRows/selected 当成文档版本存进标签（切回来 STALE_ROOT + 行数错）
  if (exprViewActive) backToDocTree({ silent: true });
  // 1) 切走前存档当前活动标签（版本字段 / 选中 / 滚动）
  if (active) saveActiveSession();
  const oldRootId = replaceTarget?.rootId ?? null;

  // 2) 会话落地（document 意图：换版本 + 回顶 + 清选中）
  const plan = session.land(reply, { kind: 'document' });

  // 3) 绑定标签（替换保留 id/runtime；新标签新建 runtime）
  const tab = replaceTarget ? workspace.replace(replaceTarget.id, input) : workspace.add(input);
  if (!tab) {
    // 兜底：软上限在 UI 已禁用；真发生则释放刚建的根，工作区保持不变
    void core.closeRoot(reply.rootId).catch(() => undefined);
    hideImportLayer();
    showToast(`最多 ${workspace.max} 个标签，未打开新文档`, 3000, 'error');
    return;
  }
  workspace.activate(tab.id);
  // 4) 替换场景：复用 runtime，但必须清掉上一份文档的全部状态
  if (replaceTarget) resetTabStateForNewDoc(tab);
  else tabExtras.delete(tab.id);
  bindTab(tab);
  editingPath = null;
  subtreeEditor.close();

  // 5) 旧根释放（幂等；失败不影响新文档）
  if (oldRootId !== null && oldRootId !== reply.rootId) {
    void core.closeRoot(oldRootId).catch(() => undefined);
  }

  // 6) 视图重画
  hideImportLayer();
  renderTabChrome();
  applyLanding(plan);
  rowSource.setMetrics(metrics());
  rowSource.requestWindow();
  resetSearch();
  // 新文档：重置大纲并加载根页（面板此刻可能未打开，数据先备好）
  void outlineState.open(reply.rootId);
  setPanel('doc');
  // 新文档：表达式示例按新顶层字段重算（面板未打开也先备好）
  refreshExpressionExamples();
  focusTree();
  void setViewMode(settings.uiState().viewMode === 'raw' ? 'raw' : 'tree', { persist: false });
  // 保真扫描按新根重排（resetFidelity 递增 seq 丢弃旧在途），再调度首帧后扫描
  resetFidelity();
  scheduleFidelityScan();
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
  if (importLayerBusy()) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text || !text.trim()) return;
  if (!session.rootId) {
    // 初始空态：粘贴 = 打开文档
    event.preventDefault();
    void importBuffer('paste', text, '剪贴板.json');
    return;
  }
  // 文档已打开：只有入口层内才接受粘贴；层关闭时完全不处理（Q5-A）。
  // 层形态决定落点（替换当前标签 / 新标签），#18 / ADR-0009 §5。
  if (!importLayerOpen() || importLayerMode() === 'initial') return;
  event.preventDefault();
  void importBuffer('paste', text, '剪贴板.json');
});

window.addEventListener('dragover', (event: DragEvent) => {
  event.preventDefault();
});
window.addEventListener('drop', (event: DragEvent) => {
  event.preventDefault();
  if (importLayerBusy()) return;
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
  if (importLayerOpen() && importLayerMode() !== 'initial') {
    // 入口层内拖放：层本身即确认（Q9-A），立即导入（落点由层形态决定）
    void importFile(file);
    return;
  }
  // 文档视图内拖放：打开替换层并暂存文件，等用户确认（Q6-A）
  if (!openImportLayer()) return;
  pendingFile = file;
  emptyPendingName.textContent = `${file.name || 'document.json'}（${formatBytes(file.size)}）`;
  emptyPending.hidden = false;
  emptyPendingReplace.focus();
});

importBtn.addEventListener('click', () => {
  if (session.rootId) openImportLayer();
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
  if (session.rootId) openImportLayer();
  else fileInput.click();
});
emptyClose.addEventListener('click', () => closeImportLayer());
emptyModeToggle.addEventListener('click', () => toggleImportLayerMode());
emptyPendingReplace.addEventListener('click', () => {
  const file = pendingFile;
  if (!file) return;
  clearPendingFile();
  void importFile(file);
});
empty.addEventListener('click', (event: MouseEvent) => {
  // 点遮罩（inner 之外）关闭入口层（替换层与新标签层都可取消）
  if (event.target === empty && session.rootId && importLayerMode() !== 'initial') closeImportLayer();
});
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
      showToast(open ? '整棵子树已经全部展开了' : '整棵子树已经全部收起了', 1800, 'info');
      return;
    }
    // 命中集按路径仍然有效（docRevision 未变），但新出现的行要重新带上命中标记（在 executor 内）
    applyLanding(plan);
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
      showToast(open ? '已经全部展开了' : '已经全部收起了', 1800, 'info');
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
  editBadge.textContent = `已修改 ${count} 处`;
  editBadge.classList.toggle('is-dirty', count > 0);
  syncExportUi();
  renderRawChrome();
}

/** 替换文档会丢弃临时修改：有修改时先确认（edit-spec §5）。 */
function confirmDiscardEdits(): boolean {
  if (!editState.dirty) return true;
  return window.confirm(`当前有 ${editState.count} 处未导出的临时修改，继续将丢失。继续？`);
}

function confirmReset(): boolean {
  if (!editState.dirty) return false;
  return window.confirm(`重置全部 ${editState.count} 处临时修改？原文件不受影响。`);
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
  // 表达式结果只读（ADR-0018 §1）：结果根不是文档，禁编辑入口（F2 / 双击 / 右键「编辑」）
  if (exprViewActive) {
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
          message: `子树过大（${formatBytes(coreError.bytes ?? 0)}），超过 5 MB，请选择更小的子树`,
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
    showToast('文档已切换，本次编辑已取消', 3000, 'error');
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
  if (exprViewActive) return false;
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
  if (exprViewActive) return false;
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
  if (exprViewActive) return false;
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

/** 当前导出文件名：表达式结果视图导出 = `<名>-expr-N.json`（与文档导出区分，ADR-0018 §4）。 */
function currentExportName(): string | null {
  const base = currentBaseName();
  if (base === null) return null;
  if (exprViewActive && exprView) return exprExportFileName(base, exprView.rootId);
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
  const oneOff = exprViewActive && exprView !== null;
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
  const base = mode === 'file' ? '导出 JSON 文件' : '复制 JSON 到剪贴板';
  const hint = editState.dirty ? '（含临时修改）' : '';
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
    if (refusal) {
      exportLastAction = { mode: 'clipboard', bytes: reply.bytes, copied: false };
      showToast(refusal, 4000, 'error');
      return;
    }
    const copied = await writeClipboard(reply.text);
    exportLastAction = { mode: 'clipboard', bytes: reply.bytes, copied };
    // 截断结果必须带标记（ADR-0018 §4：截断不能静默发生）
    const suffix = exprViewActive && exprView?.truncated ? '（结果已截断）' : '';
    if (copied) showToast(`已复制：JSON${suffix}`, 2000, 'success');
    else showToast('复制失败：请改用「导出 JSON 文件」', 4000, 'error');
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
    if (act === 'edit') void openEditor(path);
    if (act === 'locate-raw') void jumpTreeToRaw(path);
  },
  onClose: () => {
    ctxPath = null;
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
  if (item) item.title = `第 ${line} 行 → 树视图`;
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
  setCtxItemDisabled(COPY_ACT.value, isContainerKind, '容器没有原始值，请用「复制子树 JSON」');
  setCtxItemDisabled(COPY_ACT.key, path === ROOT_PATH, '根节点没有键名');
  const canSubtree = isContainerKind && row.count > 0 && path !== ROOT_PATH;
  const subtreeWhy =
    path === ROOT_PATH
      ? '根节点请用工具栏「全部展开 / 全部收起」'
      : isContainerKind
        ? '该容器没有子节点'
        : '只能展开容器节点';
  // 文案「整棵子树」= 含该节点自身（收起时也会折叠它）+ 所有深度的子孙容器；不含更上层
  const subtreeHint = '含该节点自身；不含更上层';
  setCtxItemDisabled('expand-subtree', !canSubtree, subtreeWhy, subtreeHint);
  setCtxItemDisabled('collapse-subtree', !canSubtree, subtreeWhy, subtreeHint);
  // 表达式结果只读（ADR-0018 §1）：结果根上的编辑入口一律禁用（复制四格式照常可用）
  setCtxItemDisabled('edit', exprViewActive, '表达式结果只读');
  // 双向定位（#30）：表达式结果根没有源文本；plain（修复文档）没有可靠的行/路径映射
  setCtxItemDisabled(
    'locate-raw',
    exprViewActive || meta?.repair !== undefined,
    exprViewActive ? '表达式结果没有原文位置' : '原始文本被截断修复，无法定位到节点',
  );
  ctxMenuController.open({ kind: 'point', x, y });
}

/* ---------------- 复制四格式（ADR-0010） ---------------- */

const COPY_LABELS: Record<CopyFormat, string> = {
  subtree: '子树 JSON',
  path: '路径',
  value: '原始值',
  key: '键名',
};

/** 菜单 data-act ↔ 协议 format（固定顺序，见 ADR-0010 §1） */
const COPY_ACT: Record<CopyFormat, string> = {
  subtree: 'copy-subtree',
  path: 'copy-path',
  value: 'copy-value',
  key: 'copy-key',
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
    if (copied) showToast(`已复制：${COPY_LABELS[format]}`, 2000, 'success');
    else showToast('复制失败：请手动选中文本后按 ⌘C', 4000, 'error');
  } catch (error) {
    const coreError = CoreError.from(error);
    if (coreError.code === 'TOO_LARGE') {
      showError(
        new CoreError({
          code: 'TOO_LARGE',
          message: `子树过大（${formatBytes(coreError.bytes ?? 0)}），超过 5 MB，请用「导出」`,
        }),
      );
      return;
    }
    // 格式不适用（容器没有「原始值」、根没有「键名」）：树菜单靠禁用项规避，搜索双击会真触发
    if (coreError.code === 'BAD_COMMAND') {
      showToast('该节点不支持当前复制格式；可在设置里更换', 4000, 'error');
      return;
    }
    showError(error);
  }
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
  tree.setSelected(path);
  // 大纲当前高亮唯一来源 = 树选中路径（ADR-0013 §4）
  outlineState.setSelected(path);
  selPath.textContent = path ?? '—';
  selPath.title = path ?? '';
  // 表达式结果视图：选中行 = 「点一下跳回原文档」，不给编辑暗示（ADR-0018 §1）
  selMeta.textContent = path ? (exprViewActive ? '点击行跳回原文档' : 'F2 / 双击编辑') : '';
  updateStatus();
}

/* ---------------- search ---------------- */

const PANEL_TITLES: Record<
  'doc' | 'search' | 'outline' | 'settings' | 'expression',
  string
> = {
  doc: '文档',
  search: '搜索',
  outline: '大纲',
  settings: '设置',
  expression: EXPR_COPY.panelTitle,
};

type PanelId = 'doc' | 'search' | 'outline' | 'settings' | 'expression';

/** 左面板模式（ADR-0011 §2 持久化；expression = ADR-0018 §1）。 */
function setPanel(panel: PanelId): void {
  // 离开表达式模式 → 树区回文档树（结果根保留在 worker LRU；重进表达式模式可恢复最近结果）
  if (panel !== 'expression' && exprViewActive) backToDocTree({ silent: true });
  document.body.dataset.panel = panel;
  panelTitle.textContent = PANEL_TITLES[panel];
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
    // 结果视图只在树形态下有意义（原文视图下恢复结果根会看不见）→ 先切回树
    if (!exprViewActive && isRawView()) void setViewMode('tree');
    void expressionPanel.mount();
    expressionPanel.focus();
    refreshExpressionExamples();
    // 恢复最近一次结果视图（会话内 LRU；stale 时结果条变警告色 + 「重新执行」）
    if (exprView) {
      const stale = exprView.docRevision !== session.docRevision;
      exprViewActive = true;
      docSessionBeforeExpr = session.snapshot;
      session.restore({
        rootId: exprView.rootId,
        docRevision: exprView.docRevision,
        rowVersion: exprView.rowVersion,
        totalRows: exprView.totalRows,
      });
      const state = session.snapshot;
      rowSource.setRoot(
        { rootId: exprView.rootId, rowVersion: state.rowVersion, totalRows: state.totalRows },
        { scrollTopPx: 0 },
      );
      tree.scrollToPx(0);
      rowSource.requestWindow();
      renderExpressionBar(stale);
      expressionPanel.setStatus(EXPR_COPY.status(exprView.count, Math.round(exprView.ms)));
      updateStatus();
    }
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
    applySearchToTree();
    renderSearch();
    return accepted;
  } catch (error) {
    const coreError = CoreError.from(error);
    // 无效/不安全的正则（ADR-0014 §2.3）：内联错误行，不弹 toast、不当作「无命中」。
    // 不先 begin('')（会清 patternError）；markPatternError 自己清结果并回 idle。
    if (coreError.code === 'BAD_PATTERN') {
      searchState.markPatternError(coreError.message);
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
  statusTheme.textContent = theme === 'dark' ? '深色' : '亮色';
}

el('themeToggle').addEventListener('click', () => {
  settings.set('theme', settings.get('theme') === 'dark' ? 'light' : 'dark');
});

function toggleRail(): void {
  const collapsed = document.body.classList.toggle('rail-collapsed');
  el('railToggle').setAttribute('aria-pressed', collapsed ? 'false' : 'true');
  settings.setUi({ railCollapsed: collapsed });
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
    if (event.shiftKey) openNewTabLayer();
    else openImportLayer();
    return;
  }
  if (event.key === 'Escape' && session.rootId && importLayerOpen() && importLayerMode() !== 'initial') {
    event.preventDefault();
    closeImportLayer();
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
  repairText.textContent = repair.summaryText ?? '已修复截断（仅语法闭合，未修改任何已有值）';
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
    at.title = '跳到原文对应行';
    const note = document.createElement('span');
    note.textContent = op.note;
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
    `文档 ${formatBytesDecimal(bytes)}：源文本已常驻内存（UTF-16，最多约 ${formatBytesDecimal(bytes * 2)}）` +
      `供原文视图使用，值图另计。不需要原文视图时可关闭本条。`,
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
    fidelityCount.textContent = `${fidelityIndex + 1}/${hitCount}`;
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
  if (report.counts.overflow > 0) parts.push(`数字上溢 ${report.counts.overflow} 处`);
  if (report.counts.underflow > 0) parts.push(`数字下溢 ${report.counts.underflow} 处`);
  if (report.counts.keyOrder > 0) parts.push(`整数键顺序 ${report.counts.keyOrder} 处`);
  const tail = report.truncated ? `（仅列前 ${report.hits.length} 条）` : '';
  // 条内常驻显示**当前一处**的「原文 → 实际」对照（2026-11-11 晚用户反馈：状态栏太不明显）
  const current = hits[fidelityIndex];
  const detail = current ? ` · 第 ${fidelityIndex + 1}/${hitCount} 处：${describeFidelityHit(current).replace(/^失真：/, '')}` : '';
  fidelityNotice.show(`检测到 ${total} 处失真：${parts.join(' · ')}${tail}${detail}`);
}

/**
 * 一条失真的「人话解释」（#31 / ADR-0020 §7）：数字类给**原文 vs 实际值**
 * （上溢 → Infinity / 下溢 → 0；整数精度流失已退场）；键序类只说明被重排。
 */
function describeFidelityHit(hit: FidelityHit): string {
  if (hit.kind === 'key-order') return '失真：整数样式的键顺序被重排';
  const literal = hit.literal ?? hit.snippet;
  if (hit.reason === 'overflow') return `失真：原文 ${literal} → 实际 Infinity（数字上溢）`;
  if (hit.reason === 'underflow') return `失真：原文 ${literal} → 实际 0（数字下溢）`;
  return `失真：原文 ${literal} → 实际 ${hit.parsed ?? '?'}`;
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
    rawModeLabel.textContent = '原文';
    rawNotice.textContent = '';
    rawNotice.removeAttribute('title');
    rawMetaLabel.textContent = '';
    rawCopyBtn.disabled = true;
    return;
  }
  rawModeLabel.textContent =
    info.mode === 'source' ? '原文 · 源码行' : info.mode === 'pretty' ? '原文 · 规范布局' : '原文 · 纯文本';
  const notes: string[] = [];
  if (info.damaged) notes.push('原始文本被截断（已修复），此处显示原始字节');
  else if (info.mode === 'pretty') notes.push('源文本为单行（minified），按规范格式显示；行内容取自源文本');
  if (editState.dirty) notes.push('原始文件文本，不含临时修改');
  rawNotice.textContent = notes.join(' · ');
  if (notes.length > 0) rawNotice.title = notes.join('\n');
  else rawNotice.removeAttribute('title');
  // 索引构建耗时只在 dev hook / 冒烟里暴露，不进常驻 UI（ADR-0003 修订 §5）
  rawMetaLabel.textContent = `${info.totalLines.toLocaleString()} 行`;
  rawCopyBtn.disabled = false;
}

/**
 * 切视图（ADR-0003 修订 §5）：更新工具栏分段态 / body 视图标记 / 持久化；首次进入原文视图时
 * 惰性构建索引（Worker 内，50MB ≈300ms）。persist=false 用于「打开文档后恢复上次模式」。
 */
async function setViewMode(mode: 'tree' | 'raw', opts: { persist?: boolean } = {}): Promise<void> {
  if (!session.rootId) return;
  // 表达式视图只有树形态：切原文 = 先回文档树（原文永远指文档源文本，表达式根没有源文本）
  if (exprViewActive) {
    backToDocTree({ silent: true });
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
    statusRows.textContent = '正在构建原文索引…';
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
    if (copied) showToast('已复制：原始文本', 2000, 'success');
    else showToast('复制失败：请手动选中文本后按 ⌘C', 4000, 'error');
  } catch (error) {
    const coreError = CoreError.from(error);
    if (coreError.code === 'TOO_LARGE') {
      showError(
        new CoreError({
          code: 'TOO_LARGE',
          message: `原文过大（${formatBytes(coreError.bytes ?? 0)}），超过 ${formatBytes(CLIPBOARD_MAX_BYTES)}，无法复制到剪贴板`,
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
  if (!session.rootId || exprViewActive) return -1;
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
      showStatusHint('该节点来自临时修改，原文中没有对应位置');
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
      showStatusHint('该行没有对应的树节点');
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
      showStatusHint('树里找不到对应节点');
      return null;
    }
    if (fallback) showStatusHint('该位置已被临时修改，已定位到最近的祖先');
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

function updateStatus(): void {
  if (!session.rootId || !meta) {
    statusRows.textContent = '未打开文档';
    statusSize.textContent = '—';
    statusPath.textContent = '';
    statusState.textContent = '只读 · 原文件不变';
    return;
  }
  if (locateBusy) {
    statusRows.textContent = '正在定位…';
  } else if (isRawView()) {
    const rawSnapshot = rawSource.snapshot();
    const lines = rawMetaInfo?.totalLines ?? rawSnapshot.totalLines;
    statusRows.textContent = `${lines.toLocaleString()} 行 · 原文 · 已渲染 ${rawSnapshot.lines.length}`;
  } else {
    const snapshot = rowSource.snapshot();
    statusRows.textContent = `${session.totalRows.toLocaleString()} 行 · 已渲染 ${snapshot.rows.length}`;
  }
  statusSize.textContent = `${formatBytes(meta.bytes)} · v${session.docRevision}`;
  statusPath.textContent = selected ?? ROOT_PATH;
  statusPath.title = selected ?? ROOT_PATH;
  // 表达式结果视图：状态栏明确「这不是文档」（ADR-0018 §1）
  if (exprViewActive && exprView) {
    statusState.textContent = `表达式结果 ${exprView.rootId} · 只读 · 原文件不变`;
    return;
  }
  // 临时提示（双向定位失败/回退等）优先于常驻态（ADR-0019 §4）
  if (statusHint !== null) {
    statusState.textContent = statusHint;
    return;
  }
  // 修复角标独立于修复条显隐：数据仍不完整，状态栏要一直能看出来
  const repaired = meta.repair?.status === 'repaired';
  const repairedTag = repaired ? '已修复截断 · ' : '';
  statusState.textContent = editState.dirty
    ? `${repairedTag}临时修改 ${editState.count} 处 · 原文件不变`
    : `${repairedTag}只读 · 原文件不变`;
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
  const detail = coreError.code === 'PARSE' && coreError.line ? `（第 ${coreError.line} 行）` : '';
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
      importText: (text, name) => importBuffer('file', text, name),
      toggleNode,
      expandAll: applyExpandAll,
      runSearch,
      searchNext,
      searchPrev,
      gotoHit,
      applyFilter,
      markSearchStale,
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
      view: () => exprView,
      active: () => exprViewActive,
      stale: () => exprIsStale(),
      budget: () => settings.get('advBudget'),
      statusState: () => statusState.textContent ?? '',
      entries: {
        open: async () => {
          setPanel('expression');
          await expressionPanel.mount();
          refreshExpressionExamples();
        },
        setText: (text) => expressionPanel.setText(text),
        run: async () => {
          await runExpression(expressionPanel.getText(), expressionPanel.getStrict());
        },
        runText: async (text) => {
          expressionPanel.setText(text);
          await runExpression(text, expressionPanel.getStrict());
        },
        complete: async (text, pos) => {
          const current = text ?? expressionPanel.getText();
          return requestCompletions(current, pos ?? current.length);
        },
        setStrict: (strict) => {
          expressionPanel.setStrict(strict);
        },
        back: () => {
          backToDocTree({ silent: true });
          setPanel('doc');
        },
        rerun: async () => {
          await runExpression(expressionPanel.getText() || exprLastText, expressionPanel.getStrict());
        },
        locate: async (path) => {
          if (!exprView) return { path: null };
          const target = path ?? selected;
          if (!target) return { path: null };
          return core.exprLocate({ rootId: exprView.rootId, path: target });
        },
        setBudget: (level) => settings.set('advBudget', level),
      },
    },
    // 多文档工作区（#18 / ADR-0009 §9）
    workspace: {
      state: () => workspaceHookState(),
      entries: {
        openNewTab: () => openNewTabLayer(),
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
      const live = id === view.activeId && !exprViewActive;
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
      layer: { open: importLayerOpen(), mode: importLayerMode() },
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

consumeWatchdogFlag();
if (!isExtension) {
  hookDeps = buildDevHookDeps();
  installDevHook(hookDeps);
  refreshHookDeps();
}
