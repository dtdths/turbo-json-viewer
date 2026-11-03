/**
 * app/main — 扩展页入口：创建 Worker、装配 viewmodel + view。
 * 唯一知道「用哪个适配器」的地方（架构蓝图 §3.5）。
 */
import '../view/styles/tokens.css';
import './styles/shell.css';
import '../view/tree/tree.css';
import '../view/panels/search-panel.css';
import '../view/panels/settings-panel.css';
import '../view/raw/raw-view.css';

import { createWorkerCore } from './transport/worker-transport';
import { RowWindowSource } from '../viewmodel/row-window-source';
import { RawWindowSource } from '../viewmodel/raw-window-source';
import { SearchState, type SearchFilter } from '../viewmodel/search-state';
import { TreeView } from '../view/tree/tree-view';
import { RawView } from '../view/raw/raw-view';
import { DomRowPool } from '../view/tree/row-renderer';
import { SearchPanel } from '../view/panels/search-panel';
import { CoreError } from '../protocol/errors';
import { ROOT_PATH } from '../shared/path';
import type { CopyFormat, DocumentMeta, JsonKind, RawMeta } from '../protocol/types';
import type { EditReply, LoadReply } from '../protocol/messages';
import { EditState } from '../viewmodel/edit-state';
import { SubtreeEditor } from '../view/panels/subtree-editor';
import { SettingsState, type SettingsKey } from '../viewmodel/settings-state';
import {
  CLIPBOARD_MAX_BYTES,
  clipboardRefusal,
  normalizeExportMode,
  type ExportMode,
} from '../viewmodel/export-state';
import { SettingsPanel } from '../view/panels/settings-panel';
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
const importBtn = el<HTMLButtonElement>('importBtn');
const pickBtn = el<HTMLButtonElement>('pickBtn');
const toast = el('toast');
const searchHost = el('searchPanel');
const panelTitle = el('panelTitle');
const settingsHost = el('settingsPanel');
const selPath = el('selPath');
const selMeta = el('selMeta');
const repairBar = el('repairBar');
const repairText = el('repairText');
const repairToggle = el<HTMLButtonElement>('repairToggle');
const repairOps = el('repairOps');
const repairClose = el<HTMLButtonElement>('repairClose');
const viewTreeBtn = el<HTMLButtonElement>('viewTreeBtn');
const viewRawBtn = el<HTMLButtonElement>('viewRawBtn');
const rawWrap = el('rawWrap');
const rawHost = el('raw');
const rawModeLabel = el('rawModeLabel');
const rawNotice = el('rawNotice');
const rawMetaLabel = el('rawMetaLabel');
const rawCopyBtn = el<HTMLButtonElement>('rawCopyBtn');

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

const rowSource = new RowWindowSource(core, { rowHeight: settings.get('rowHeight') });
const tree = new TreeView(treeHost, {
  rowHeight: settings.get('rowHeight'),
  renderer: (host: HTMLElement) => new DomRowPool(host, { rowHeight: settings.get('rowHeight') }),
  onScroll: (top: number) => rowSource.scrollTo(top),
  onToggle: (path: string, open: boolean) => {
    void toggleNode(path, open);
  },
  onSelect: (path: string) => setSelection(path),
  onEdit: (path: string) => {
    void openEditor(path);
  },
  onContextMenu: (path: string, x: number, y: number, kind: JsonKind) => {
    setSelection(path);
    showContextMenu(path, x, y, kind);
  },
  // 行尾浮条（ADR-0010 修订）：鼠标快路径；复制格式跟随设置（ADR-0011 §1 defaultCopyFormat）
  onRowAction: (path: string, action: 'copy' | 'edit') => {
    if (action === 'copy') void copyNodeToClipboard(path, settings.get('defaultCopyFormat'));
    else void openEditor(path);
  },
});
tree.mount();

/* ---------------- 原始文本视图（#11 / ADR-0003 修订 2026-11-03） ---------------- */

/** 原文窗口状态机（单飞/合并/seq 丢弃/overscan；原文无 rowVersion——doc 生命周期即版本）。 */
const rawSource = new RawWindowSource(core, { rowHeight: settings.get('rowHeight') });
const rawView = new RawView(rawHost, {
  rowHeight: settings.get('rowHeight'),
  onScroll: (top: number) => rawSource.scrollTo(top),
});
rawView.mount();
rawSource.subscribe((snapshot) => {
  rawView.render(snapshot);
  updateStatus();
});

/** 搜索状态机（viewmodel，无 DOM）：命中集/当前命中/过期判定/虚拟窗口。 */
const searchState = new SearchState();
const searchPanel = new SearchPanel(searchHost, {
  onQueryChange: (query: string) => queueSearch(query),
  onFilterChange: (filter: SearchFilter) => applyFilter(filter),
  onSelect: (index: number) => {
    void gotoHit(index);
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
});
searchPanel.mount();

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

let rootId: string | null = null;
let docRevision = 0;
let rowVersion = 0;
let totalRows = 0;
let meta: DocumentMeta | null = null;
let selected: string | null = null;
let loadSeq = 0;
let searchTimer = 0;
/** 首次 next/prev/Enter 先跳到当前命中，之后才移动（编辑器惯例）。 */
let searchJumped = false;

/** 视图模式（#11 / ADR-0003 修订）：`tree` = 树视图；`raw` = 原始文本视图（只读原文）。 */
let viewMode: 'tree' | 'raw' = 'tree';
/** 原文行索引元信息（null = 当前文档尚未进入原文视图 / 索引未构建） */
let rawMetaInfo: RawMeta | null = null;
/** 原文 open 竞态守卫（切视图 / 换文档时递增，迟到回包丢弃） */
let rawOpenSeq = 0;

/** 编辑会话（slice 5 / #16 / ADR-0006）：当前编辑目标 + 修改计数/撤销可用性。 */
const editState = new EditState();
editState.subscribe(renderEditBadge);
let editingPath: string | null = null;
let ctxPath: string | null = null;

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
  if (rootId) rowSource.requestWindow();
  // 原文视图与树共用行高（ADR-0003 修订：行高是唯一进入逻辑层的视觉参数）
  rawView.setRowHeight(current.rowHeight);
  rawSource.setMetrics(rawMetrics());
  if (rootId && viewMode === 'raw') rawSource.requestWindow();
  document.documentElement.style.setProperty('--row-indent', `${current.indent}px`);
  tree.setTypeColumn(current.typeColumn);
  settingsPanel.render(current);
  // 导出方式的唯一真相源是 Settings（ADR-0012 修订）：任一侧改动都经订阅回到这里
  syncExportUi();
}

settings.subscribe(() => applySettings());
applySettings();

/* ---------------- import layer（文档入口层） ---------------- */

const EMPTY_TITLE_INITIAL = '拖入 JSON，毫秒级开始查看';
const EMPTY_TITLE_REPLACE = '打开新文档';
const EMPTY_SUB_INITIAL = '本地只读 · 数据不经过网络 · 50 MB 文档由 Worker 常驻';
const EMPTY_SUB_REPLACE = '本地只读 · 数据不经过网络 · 原文件不受影响';

/** 外部拖放 → 替换层里暂存的文件（等待用户确认，Q6-A） */
let pendingFile: File | null = null;

function importLayerOpen(): boolean {
  return !empty.classList.contains('is-hidden');
}

function importLayerMode(): 'initial' | 'replace' {
  return empty.dataset.mode === 'replace' ? 'replace' : 'initial';
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
  clearPendingFile();
  setImportError(null);
  setImportBusy(false);
}

/** 已打开文档时：点「导入」/文件 chip / ⌘O 打开显式替换层。返回是否真的打开。 */
function openImportLayer(): boolean {
  if (!rootId || importLayerOpen()) return false;
  if (!confirmDiscardEdits()) return false;
  resetImportLayerView();
  empty.dataset.mode = 'replace';
  empty.classList.remove('is-hidden');
  empty.setAttribute('role', 'dialog');
  empty.setAttribute('aria-modal', 'true');
  empty.setAttribute('aria-labelledby', 'emptyTitle');
  emptyTitle.textContent = EMPTY_TITLE_REPLACE;
  emptySub.textContent = EMPTY_SUB_REPLACE;
  emptyWarnDoc.textContent = meta ? `${meta.name}（${formatBytes(meta.bytes)}）` : '当前文档';
  emptyWarn.hidden = false;
  emptyClose.hidden = false;
  emptyInner.focus();
  return true;
}

/** 取消替换层：丢弃在途导入回包，回到文档视图。 */
function closeImportLayer(): void {
  if (!rootId || !importLayerOpen()) return;
  if (empty.classList.contains('is-busy')) loadSeq += 1;
  empty.classList.add('is-hidden');
  resetImportLayerView();
  importBtn.focus();
}

/** 导入成功后隐藏入口层（初始空态或替换层）。 */
function hideImportLayer(): void {
  empty.classList.add('is-hidden');
  resetImportLayerView();
}

/* ---------------- import ---------------- */

async function importBuffer(
  source: 'file' | 'paste' | 'clipboard',
  data: ArrayBuffer | string,
  name: string,
): Promise<void> {
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
    if (loadId !== loadSeq) return;
    onLoaded(reply);
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

async function importFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  await importBuffer('file', buffer, file.name || 'document.json');
}

function onLoaded(reply: LoadReply): void {
  const rid = reply.rootId;
  rootId = rid;
  docRevision = reply.docRevision;
  rowVersion = reply.rowVersion;
  totalRows = reply.totalRows;
  meta = reply.meta;
  selected = null;

  hideImportLayer();
  fileChip.hidden = false;
  fileName.textContent = reply.meta.name;
  fileMeta.textContent = formatBytes(reply.meta.bytes);
  setExportButtonsDisabled(false);
  syncExportUi();
  expandAllBtn.disabled = false;
  collapseAllBtn.disabled = false;
  viewTreeBtn.disabled = false;
  viewRawBtn.disabled = false;
  // 新文档：清空编辑会话（slice 5）
  editingPath = null;
  subtreeEditor.close();
  editState.clear();
  renderEditBadge();
  renderRepair();

  // 新文档：旧原文索引随旧根丢弃（惰性重建）；恢复上次视图模式（ADR-0003 修订）
  rawOpenSeq += 1;
  rawMetaInfo = null;
  rawSource.clear();
  renderRawChrome();

  rowSource.setRoot({ rootId: rid, rowVersion, totalRows });
  rowSource.setMetrics(metrics());
  rowSource.requestWindow();
  rowSource.scrollTo(0);
  setSelection(null);
  resetSearch();
  setPanel('doc');
  updateStatus();
  treeHost.focus();
  void setViewMode(settings.uiState().viewMode === 'raw' ? 'raw' : 'tree', { persist: false });
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
  const text = event.clipboardData?.getData('text/plain');
  if (!text || !text.trim()) return;
  if (!rootId) {
    // 初始空态：粘贴 = 打开文档
    event.preventDefault();
    void importBuffer('paste', text, '剪贴板.json');
    return;
  }
  // 文档已打开：只有导入层内才接受粘贴；层关闭时完全不处理（Q5-A）
  if (!importLayerOpen() || importLayerMode() !== 'replace') return;
  event.preventDefault();
  void importBuffer('paste', text, '剪贴板.json');
});

window.addEventListener('dragover', (event: DragEvent) => {
  event.preventDefault();
});
window.addEventListener('drop', (event: DragEvent) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!rootId) {
    // 初始空态：直接导入
    void importFile(file);
    return;
  }
  if (importLayerOpen() && importLayerMode() === 'replace') {
    // 导入层内拖放：层本身即确认（Q9-A），立即导入
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
  if (rootId) openImportLayer();
  else fileInput.click();
});
pickBtn.addEventListener('click', () => fileInput.click());
fileChip.addEventListener('click', () => {
  if (rootId) openImportLayer();
  else fileInput.click();
});
emptyClose.addEventListener('click', () => closeImportLayer());
emptyPendingReplace.addEventListener('click', () => {
  const file = pendingFile;
  if (!file) return;
  clearPendingFile();
  void importFile(file);
});
empty.addEventListener('click', (event: MouseEvent) => {
  // 点遮罩（inner 之外）关闭替换层
  if (event.target === empty && rootId && importLayerMode() === 'replace') closeImportLayer();
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
  if (exportMenu.hidden) openExportMenu();
  else closeExportMenu();
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
// 修复摘要的 `at` → 跳到原文对应行（#8 / ADR-0003 修订 §5）
repairOps.addEventListener('click', (event: MouseEvent) => {
  const at = (event.target as HTMLElement | null)?.closest<HTMLElement>('.repairbar__at');
  if (!at) return;
  const offset = Number(at.dataset.at);
  if (!Number.isFinite(offset)) return;
  void revealRepairOffset(offset);
});
ctxMenu.addEventListener('click', (event: MouseEvent) => {
  const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
  if (!item) return;
  const act = item.dataset.act ?? '';
  const path = ctxPath;
  hideContextMenu();
  if (!path) return;
  const format = copyFormatOfAct(act);
  if (format) {
    void copyNodeToClipboard(path, format);
    return;
  }
  if (act === 'edit') void openEditor(path);
});
/** 菜单键盘（ADR-0010 §8）：↑/↓ 在可用项间循环、Home/End、Esc 关闭；Enter 由按钮原生触发。 */
ctxMenu.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    hideContextMenu();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
    return;
  }
  event.preventDefault();
  const items = enabledCtxItems();
  if (items.length === 0) return;
  const current = document.activeElement as HTMLElement | null;
  const index = current ? items.findIndex((item) => item === current) : -1;
  let next: number;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
  else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
  items[next]?.focus();
});
document.addEventListener(
  'pointerdown',
  (event: PointerEvent) => {
    if (!ctxMenu.hidden && !ctxMenu.contains(event.target as Node)) hideContextMenu();
  },
  true,
);

/* ---------------- tree intents ---------------- */

async function toggleNode(path: string, open: boolean): Promise<void> {
  if (!rootId) return;
  try {
    const reply = await core.toggle({ rootId, path, open });
    rowVersion = reply.rowVersion;
    totalRows = reply.totalRows;
    rowSource.setRoot({ rootId, rowVersion, totalRows });
    rowSource.requestWindow();
    updateStatus();
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
  if (!rootId || expandAllBusy) return;
  // 展开/收起是树动作：原文视图下先切回树（按钮保持可用，不靠禁用态说话）
  if (viewMode === 'raw') await setViewMode('tree');
  expandAllBusy = true;
  try {
    const reply = open ? await core.expandAll(rootId) : await core.collapseAll(rootId);
    rowVersion = reply.rowVersion;
    totalRows = reply.totalRows;
    // 回顶与换版本同一拍完成：避免「旧 start 的保留帧被新 totalRows 裁到视口外」（空白帧）
    // 与「按旧滚动位置算出的中间窗口」（1 行闪帧）。见 RowWindowSource.setRoot 的 opts.scrollTopPx。
    rowSource.setRoot({ rootId, rowVersion, totalRows }, { scrollTopPx: 0 });
    tree.scrollToPx(0);
    rowSource.requestWindow();
    // 命中集仍按路径有效（docRevision 未变），重推高亮
    applySearchToTree();
    updateStatus();
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
  if (!rootId) return;
  const anchor = rowSource.anchor();
  const delta = reply.totalRows - totalRows;
  docRevision = reply.docRevision;
  rowVersion = reply.rowVersion;
  totalRows = reply.totalRows;
  rowSource.setRoot({ rootId, rowVersion, totalRows });
  // 变更发生在视口上方：按行数差值平移锚点，保持视口内容不跳
  if (anchor && reply.changedRow !== undefined && reply.changedRow >= 0 && reply.changedRow < anchor.row) {
    rowSource.restoreAnchor({ row: Math.max(0, anchor.row + delta), offsetPx: anchor.offsetPx });
  }
  rowSource.requestWindow();
  if (reply.changedPath) {
    setSelection(reply.changedPath);
    tree.setChangedPath(reply.changedPath);
    window.setTimeout(() => tree.setChangedPath(null), CHANGED_FLASH_MS);
  }
  editState.sync(reply.history);
  updateStatus();
}

/** 文档已修改：清空搜索命中并提示重搜（edit-spec §6）。 */
function markSearchStale(): void {
  searchState.markStale();
  applySearchToTree();
  renderSearch();
}

async function openEditor(path: string): Promise<void> {
  if (!rootId || subtreeEditor.isOpen()) return;
  try {
    const reply = await core.getNodeJson({ rootId, path });
    editingPath = path;
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
  if (!rootId || !editingPath) return;
  const path = editingPath;
  subtreeEditor.setError(null);
  subtreeEditor.setBusy(true);
  try {
    const reply = await core.replaceNode({ rootId, path, docRevision, jsonText: text });
    applyModelReply(reply);
    markSearchStale();
    subtreeEditor.close();
    editingPath = null;
  } catch (error) {
    const coreError = CoreError.from(error);
    subtreeEditor.setError({ message: coreError.message, line: coreError.line, column: coreError.column });
  } finally {
    subtreeEditor.setBusy(false);
  }
}

async function undoEdit(): Promise<boolean> {
  if (!rootId) return false;
  try {
    const reply = await core.undo(rootId);
    applyModelReply(reply);
    markSearchStale();
    return true;
  } catch (error) {
    if (CoreError.from(error).code === 'NO_HISTORY') return false;
    showError(error);
    return false;
  }
}

async function redoEdit(): Promise<boolean> {
  if (!rootId) return false;
  try {
    const reply = await core.redo(rootId);
    applyModelReply(reply);
    markSearchStale();
    return true;
  } catch (error) {
    if (CoreError.from(error).code === 'NO_HISTORY') return false;
    showError(error);
    return false;
  }
}

/** 重置全部临时修改（反向撤销到打开时状态）；skipConfirm 供 dev hook 用。 */
async function resetEdits(skipConfirm = false): Promise<boolean> {
  if (!rootId || !editState.dirty) return false;
  if (!skipConfirm && !confirmReset()) return false;
  try {
    const reply = await core.reset(rootId);
    applyModelReply(reply);
    markSearchStale();
    return true;
  } catch (error) {
    if (CoreError.from(error).code !== 'NO_HISTORY') showError(error);
    return false;
  }
}

function exportName(name: string, edited: boolean, repaired = false): string {
  const base = name.replace(/\.json$/i, '');
  // ADR-0004 §7：修复过的文档导出带后缀（不往 JSON 里塞注释，保持可解析）
  return `${base}${repaired ? '-truncated-repaired' : ''}${edited ? '-edited' : ''}.json`;
}

/** 导出当前值图（唯一落盘动作；`-edited` 后缀；ADR-0006 §2）。 */
/* ---------------- 导出（ADR-0012）：下载文件 / 复制到剪贴板 分体按钮 ---------------- */

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

function positionExportMenu(): void {
  const anchor = exportMenuBtn.getBoundingClientRect();
  const rect = exportMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8));
  const top = Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 8);
  exportMenu.style.left = `${left}px`;
  exportMenu.style.top = `${Math.max(8, top)}px`;
}

function openExportMenu(): void {
  if (exportMenuBtn.disabled) return;
  exportMenu.hidden = false;
  exportMenuBtn.setAttribute('aria-expanded', 'true');
  positionExportMenu();
  const items = exportMenuItems();
  const target = items.find((item) => item.dataset.exportMode === currentExportMode()) ?? items[0];
  target?.focus();
}

function closeExportMenu(focusBack = false): void {
  if (exportMenu.hidden) return;
  exportMenu.hidden = true;
  exportMenuBtn.setAttribute('aria-expanded', 'false');
  if (focusBack) exportMenuBtn.focus();
}

/** 记住本次方式（写穿 Settings，持久化；订阅会触发 applySettings → 面板回显 + 按钮/勾选同步）。 */
function rememberExportMode(mode: ExportMode): void {
  settings.set('exportMode', mode);
}

async function runExportMode(mode: ExportMode): Promise<void> {
  if (mode === 'clipboard') await copyDocJson();
  else await exportDoc();
}

/** 文件导出（既有行为）：Blob + `<a download>`，文件名带 -edited / -truncated-repaired。 */
async function exportDoc(): Promise<void> {
  if (!rootId || !meta) return;
  setExportButtonsDisabled(true);
  try {
    const { text, bytes } = await core.exportDoc(rootId, 2);
    const name = exportName(meta.name, editState.dirty, meta.repair?.status === 'repaired');
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportLastAction = { mode: 'file', name, bytes };
  } catch (error) {
    showError(error);
  } finally {
    setExportButtonsDisabled(false);
  }
}

/**
 * 复制当前值图 JSON（ADR-0012 §2/§4）：与文件导出逐字同一份文本；
 * >20MB 拒绝并提示用文件导出；剪贴板写入复用 ADR-0010 §7 的零权限路径。
 */
async function copyDocJson(): Promise<void> {
  if (!rootId || !meta) return;
  setExportButtonsDisabled(true);
  try {
    const reply = await core.exportDoc(rootId, 2);
    const refusal = clipboardRefusal(reply.bytes);
    if (refusal) {
      exportLastAction = { mode: 'clipboard', bytes: reply.bytes, copied: false };
      showToast(refusal, 4000, 'error');
      return;
    }
    const copied = await writeClipboard(reply.text);
    exportLastAction = { mode: 'clipboard', bytes: reply.bytes, copied };
    if (copied) showToast('已复制：JSON', 2000, 'success');
    else showToast('复制失败：请改用「导出 JSON 文件」', 4000, 'error');
  } catch (error) {
    showError(error);
  } finally {
    setExportButtonsDisabled(false);
  }
}

exportMenu.addEventListener('click', (event: MouseEvent) => {
  const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-export-mode]');
  if (!item) return;
  const mode = normalizeExportMode(item.dataset.exportMode);
  closeExportMenu();
  rememberExportMode(mode);
  void runExportMode(mode);
});
exportMenu.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeExportMenu(true);
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
    return;
  }
  event.preventDefault();
  const items = exportMenuItems();
  const current = document.activeElement as HTMLElement | null;
  const index = current ? items.findIndex((item) => item === current) : -1;
  let next: number;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
  else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
  items[next]?.focus();
});
document.addEventListener(
  'pointerdown',
  (event: PointerEvent) => {
    if (exportMenu.hidden) return;
    const target = event.target as Node | null;
    if (target && (exportMenu.contains(target) || exportMenuBtn.contains(target))) return;
    closeExportMenu();
  },
  true,
);
window.addEventListener('resize', () => closeExportMenu());

function showContextMenu(path: string, x: number, y: number, kind: JsonKind): void {
  ctxPath = path;
  ctxMenu.hidden = false;
  // 启用规则（ADR-0010 §1）：容器没有原始值；根没有键名。其余项所有节点可用。
  setCtxItemDisabled(COPY_ACT.subtree, false);
  setCtxItemDisabled(COPY_ACT.path, false);
  setCtxItemDisabled(COPY_ACT.value, kind === 'object' || kind === 'array', '容器没有原始值，请用「复制子树 JSON」');
  setCtxItemDisabled(COPY_ACT.key, path === ROOT_PATH, '根节点没有键名');
  setCtxItemDisabled('edit', false);
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  // 焦点落第一个可用项（此前固定落「编辑」，现在「编辑」在最后）
  (enabledCtxItems()[0] ?? null)?.focus();
}

function hideContextMenu(): void {
  if (ctxMenu.hidden) return;
  const hadFocus = ctxMenu.contains(document.activeElement);
  ctxMenu.hidden = true;
  ctxPath = null;
  // a11y：键盘关闭（Esc/激活项）后焦点还给树，避免掉到 body（opener 即树滚动容器）
  if (hadFocus) treeHost.querySelector<HTMLElement>('.tjv-tree')?.focus();
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

function enabledCtxItems(): HTMLButtonElement[] {
  return ctxItems().filter((item) => !item.disabled);
}

function setCtxItemDisabled(act: string, disabled: boolean, why?: string): void {
  const item = ctxMenu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
  if (!item) return;
  item.disabled = disabled;
  if (disabled) {
    if (why) item.title = why;
    item.setAttribute('aria-disabled', 'true');
  } else {
    item.removeAttribute('title');
    item.removeAttribute('aria-disabled');
  }
}

/**
 * 复制入口共用实现（右键菜单 4 格式 + 行尾浮条的子集快路径）：
 * core 生成文本（ADR-0010 §6）→ 零权限写剪贴板（§7）→ toast 反馈。
 * 只读操作，不推进版本；TOO_LARGE 引导用「导出」而不是静默截断。
 */
async function copyNodeToClipboard(path: string, format: CopyFormat): Promise<void> {
  if (!rootId) return;
  try {
    const reply = await core.copyNode({ rootId, path, format, indent: settings.get('copyIndent') });
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
  selPath.textContent = path ?? '—';
  selPath.title = path ?? '';
  selMeta.textContent = path ? 'F2 / 双击编辑' : '';
  updateStatus();
}

/* ---------------- search ---------------- */

const PANEL_TITLES: Record<'doc' | 'search' | 'settings', string> = {
  doc: '文档',
  search: '搜索',
  settings: '设置',
};

function setPanel(panel: 'doc' | 'search' | 'settings'): void {
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
  if (panel === 'settings') settingsPanel.focus();
  // 布局态持久化（ADR-0011 §2）：下次启动恢复
  settings.setUi({ panel });
}

document.querySelectorAll<HTMLElement>('[data-panel-btn]').forEach((button) => {
  button.addEventListener('click', () => {
    const panel = button.dataset.panelBtn;
    // 点击当前已激活的模式 → 回到文档视图（与「关闭面板」一致）
    const next = panel === 'search' || panel === 'settings' ? panel : 'doc';
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
  const loadAtStart = loadSeq;
  const trimmed = query.trim();
  const seq = searchState.begin(trimmed);
  applySearchToTree();
  renderSearch();

  if (!trimmed) return false;
  if (!rootId) {
    searchState.begin('');
    renderSearch();
    return false;
  }

  try {
    const reply = await core.search({ rootId, seq, query: trimmed });
    if (loadAtStart !== loadSeq) return false;
    const accepted = searchState.apply(
      {
        seq: reply.seq,
        docRevision: reply.docRevision,
        hits: reply.hits,
        total: reply.total,
        truncated: reply.truncated,
      },
      docRevision,
    );
    searchJumped = false;
    applySearchToTree();
    renderSearch();
    return accepted;
  } catch (error) {
    const coreError = CoreError.from(error);
    if (coreError.code !== 'CANCELLED' && coreError.code !== 'CLOSED') {
      searchState.begin('');
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

/** 跳转：展开祖先链 → 树滚动（当前行居中）→ 选中 → 同步高亮与结果列表。 */
async function gotoHit(index: number): Promise<number> {
  if (!rootId) return -1;
  // 搜索跳转是树动作：原文视图下先切回树（ADR-0003 修订：两视图 v1 不联动）
  if (viewMode === 'raw') await setViewMode('tree');
  const hit = searchState.hits[index];
  if (!hit) return -1;
  try {
    const reply = await core.expandTo({ rootId, path: hit.path });
    rowVersion = reply.rowVersion;
    totalRows = reply.totalRows;
    rowSource.setRoot({ rootId, rowVersion, totalRows });
    rowSource.requestWindow();

    const viewportPx = tree.clientHeightPx();
    const rowH = settings.get('rowHeight');
    const centerOffset = Math.max(0, Math.floor((viewportPx - rowH) / 2 / rowH)) * rowH;
    tree.scrollToPx(Math.max(0, reply.row * rowH - centerOffset));

    searchState.select(index);
    searchJumped = true;
    setSelection(hit.path);
    applySearchToTree();
    renderSearch();
    searchPanel.scrollTo(index);
    updateStatus();
    return index;
  } catch (error) {
    showError(error);
    return -1;
  }
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
  searchState.begin('');
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
    if (!rootId) return;
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
  // 打开导入层（已打开文档时的显式替换入口，Q11-B）
  if (mod && key === 'o') {
    if (!rootId) return;
    event.preventDefault();
    openImportLayer();
    return;
  }
  if (event.key === 'Escape' && rootId && importLayerOpen() && importLayerMode() === 'replace') {
    event.preventDefault();
    closeImportLayer();
    return;
  }
  // 下一个/上一个命中：⌘G / ⇧⌘G，或 F3 / ⇧F3
  if ((mod && key === 'g') || key === 'f3') {
    if (!rootId) return;
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

/* ---------------- 视图切换：树 / 原文（#11 / ADR-0003 修订） ---------------- */

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
  const buildMs = info.buildMs !== undefined ? ` · 索引 ${Math.round(info.buildMs)}ms` : '';
  rawMetaLabel.textContent = `${info.totalLines.toLocaleString()} 行${buildMs}`;
  rawCopyBtn.disabled = false;
}

/**
 * 切视图（ADR-0003 修订 §5）：更新工具栏分段态 / body 视图标记 / 持久化；首次进入原文视图时
 * 惰性构建索引（Worker 内，50MB ≈300ms）。persist=false 用于「打开文档后恢复上次模式」。
 */
async function setViewMode(mode: 'tree' | 'raw', opts: { persist?: boolean } = {}): Promise<void> {
  if (!rootId) return;
  const changed = mode !== viewMode;
  viewMode = mode;
  document.body.dataset.view = mode;
  viewTreeBtn.classList.toggle('is-active', mode === 'tree');
  viewTreeBtn.setAttribute('aria-pressed', mode === 'tree' ? 'true' : 'false');
  viewRawBtn.classList.toggle('is-active', mode === 'raw');
  viewRawBtn.setAttribute('aria-pressed', mode === 'raw' ? 'true' : 'false');
  if (opts.persist !== false) settings.setUi({ viewMode: mode });

  if (mode === 'tree') {
    updateStatus();
    if (changed) treeHost.querySelector<HTMLElement>('.tjv-tree')?.focus();
    return;
  }

  // 原文：已构建则直接复用；否则先给「构建中」反馈（桌面读屏与冒烟都能看到）
  const rid = rootId;
  const seq = ++rawOpenSeq;
  if (!rawMetaInfo) {
    statusRows.textContent = '正在构建原文索引…';
    statusSize.textContent = meta ? `${formatBytes(meta.bytes)} · v${docRevision}` : '—';
  }
  try {
    const info = await rawSource.open(rid);
    // 迟到回包：已换文档 / 已切回树 / 有更新的 open → 丢弃
    if (seq !== rawOpenSeq || rid !== rootId || viewMode !== 'raw') return;
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
  if (!rootId) return;
  try {
    const reply = await core.rawSource({ rootId, maxBytes: CLIPBOARD_MAX_BYTES });
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
  if (!rootId) return -1;
  const rid = rootId;
  await setViewMode('raw');
  if (rid !== rootId) return -1;
  try {
    const located = await core.rawLocate({ rootId: rid, offset });
    if (rid !== rootId) return -1;
    rawView.flashLine(located.line);
    return located.line;
  } catch (error) {
    showError(error);
    return -1;
  }
}

function updateStatus(): void {
  if (!rootId || !meta) {
    statusRows.textContent = '未打开文档';
    statusSize.textContent = '—';
    statusPath.textContent = '';
    statusState.textContent = '只读 · 原文件不变';
    return;
  }
  if (viewMode === 'raw') {
    const rawSnapshot = rawSource.snapshot();
    const lines = rawMetaInfo?.totalLines ?? rawSnapshot.totalLines;
    statusRows.textContent = `${lines.toLocaleString()} 行 · 原文 · 已渲染 ${rawSnapshot.lines.length}`;
  } else {
    const snapshot = rowSource.snapshot();
    statusRows.textContent = `${totalRows.toLocaleString()} 行 · 已渲染 ${snapshot.rows.length}`;
  }
  statusSize.textContent = `${formatBytes(meta.bytes)} · v${docRevision}`;
  statusPath.textContent = selected ?? ROOT_PATH;
  statusPath.title = selected ?? ROOT_PATH;
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

/** 导出视图态快照（dev hook 用；不返回文本本体，避免把大文本塞进协议）。 */
function exportHookState(): {
  mode: ExportMode;
  menuOpen: boolean;
  menuItems: { mode: string; label: string; checked: boolean; focused: boolean }[];
  mainLabel: string;
  mainText: string;
  disabled: { main: boolean; caret: boolean };
  lastAction: typeof exportLastAction;
  clipboardMaxBytes: number;
} {
  return {
    mode: currentExportMode(),
    menuOpen: !exportMenu.hidden,
    menuItems: exportMenuItems().map((item) => {
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
    mainLabel: exportBtn.getAttribute('aria-label') ?? '',
    mainText: exportBtn.textContent ?? '',
    disabled: { main: exportBtn.disabled, caret: exportMenuBtn.disabled },
    lastAction: exportLastAction,
    clipboardMaxBytes: CLIPBOARD_MAX_BYTES,
  };
}

/* ---------------- resize ---------------- */

const resizeObserver = new ResizeObserver(() => {
  rowSource.setMetrics(metrics());
  rowSource.requestWindow();
  rawSource.setMetrics(rawMetrics());
  if (viewMode === 'raw') rawSource.requestWindow();
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

if (!isExtension) {
  const ms = (since: number): number => Math.round((performance.now() - since) * 100) / 100;
  const searchDiagnostics = (): Record<string, unknown> => {
    const view = searchState.view();
    const scroller = document.getElementById('resultsScroll');
    const text = (id: string): string => document.getElementById(id)?.textContent ?? '';
    return {
      phase: view.phase,
      query: searchState.query,
      total: view.total,
      size: view.size,
      current: view.current,
      counts: { ...view.counts },
      filter: view.filter,
      truncated: view.truncated,
      stale: searchState.stale,
      rendered: searchPanel.renderedCount(),
      treeCurrentVisible: Boolean(document.querySelector('.row.is-current')),
      scrollTop: searchPanel.listScrollTop(),
      scrollHeight: scroller ? scroller.scrollHeight : 0,
      // 兼容别名（内部诊断用）
      listScrollTop: searchPanel.listScrollTop(),
      listScrollHeight: scroller ? scroller.scrollHeight : 0,
      countText: text('searchCount'),
      posText: text('searchPos'),
      footText: text('resultsFoot'),
      path: searchState.currentHit()?.path ?? null,
    };
  };

  const stateOf = (): Record<string, unknown> => ({
    rootId,
    totalRows,
    rowVersion,
    docRevision,
    selected,
    rendered: rowSource.snapshot().rows.length,
    start: rowSource.snapshot().start,
    scrollTop: tree.scrollTopPx(),
    editCount: editState.count,
    canUndo: editState.canUndo,
    canRedo: editState.canRedo,
    viewMode,
  });

  /** 原文视图 dev hook 共用的状态快照（契约见 ADR-0003 修订 §7）。 */
  const rawHookState = (): Record<string, unknown> => {
    const snapshot = rawSource.snapshot();
    // 行池隐藏槽位没有 data-line（且文本已清空），只统计可见行
    const rows = [...document.querySelectorAll<HTMLElement>('.raw-row[data-line]')];
    return {
      mode: viewMode,
      view: document.body.dataset.view ?? null,
      buttons: {
        tree: {
          active: viewTreeBtn.classList.contains('is-active'),
          pressed: viewTreeBtn.getAttribute('aria-pressed'),
          disabled: viewTreeBtn.disabled,
        },
        raw: {
          active: viewRawBtn.classList.contains('is-active'),
          pressed: viewRawBtn.getAttribute('aria-pressed'),
          disabled: viewRawBtn.disabled,
        },
      },
      raw: rawMetaInfo,
      totalLines: snapshot.totalLines,
      start: snapshot.start,
      rendered: snapshot.lines.length,
      stale: snapshot.stale,
      scrollTop: rawView.scrollTopPx(),
      viewportRows: rawView.viewportRows(),
      notice: rawNotice.textContent ?? '',
      metaLabel: rawMetaLabel.textContent ?? '',
      modeLabel: rawModeLabel.textContent ?? '',
      copyDisabled: rawCopyBtn.disabled,
      flash: document.querySelector<HTMLElement>('.raw-row.is-flash')?.dataset.line ?? null,
      statusRows: statusRows.textContent ?? '',
      lines: rows.map((row) => ({
        line: Number(row.dataset.line),
        text: row.querySelector<HTMLElement>('.raw-row__code')?.textContent ?? '',
      })),
    };
  };

  (globalThis as unknown as { __tjv?: unknown }).__tjv = {
    loadText: (text: string, name = 'sample.json') => importBuffer('file', text, name),
    scrollToPx: (px: number) => tree.scrollToPx(px),
    togglePath: (path: string, open: boolean) => toggleNode(path, open),
    expandAll: () => applyExpandAll(true),
    collapseAll: () => applyExpandAll(false),
    state: stateOf,

    // ---- slice 4：搜索 dev hook（契约见 docs/design/slice4-search-contract.md §5）----
    search: async (term: string) => {
      const started = performance.now();
      const ok = await runSearch(term);
      return { ms: ms(started), ok, ...searchDiagnostics() };
    },
    searchNext: async () => {
      const started = performance.now();
      const index = await searchNext();
      return { ms: ms(started), index, ...searchDiagnostics() };
    },
    searchPrev: async () => {
      const started = performance.now();
      const index = await searchPrev();
      return { ms: ms(started), index, ...searchDiagnostics() };
    },
    searchJump: async (index: number) => {
      const started = performance.now();
      const jumped = await gotoHit(index);
      return { ms: ms(started), index: jumped, ...searchDiagnostics() };
    },
    /** dev-only：模拟「文档已修改」→ 清空结果 + stale 提示（slice 5 编辑接入前仅测试用）。 */
    searchMarkStale: () => {
      const changed = searchState.markStale();
      applySearchToTree();
      renderSearch();
      return { changed, ...searchDiagnostics() };
    },
    setSearchFilter: (filter: SearchFilter) => {
      applyFilter(filter);
      return searchDiagnostics();
    },
    searchPanel: () => searchDiagnostics(),
    searchListScrollTo: (px: number) => {
      searchPanel.scrollListTo(px);
      return searchDiagnostics();
    },

    // ---- slice 5：编辑 dev hook（契约见 docs/design/edit-spec.md §2/§8）----

    /** 打开某路径的子树编辑器（走真实 getNodeJson → SubtreeEditor.open 流程）。 */
    editOpen: async (path: string) => {
      await openEditor(path);
      return { open: subtreeEditor.isOpen(), path: editingPath, text: subtreeEditor.isOpen() ? subtreeEditor.getValue() : null };
    },
    /** 当前编辑器文本（未打开 → null）。 */
    editText: () => (subtreeEditor.isOpen() ? subtreeEditor.getValue() : null),
    /** 覆盖编辑器文本（模拟用户输入；JSON lint 异步生效）。 */
    editSetText: (text: string) => {
      subtreeEditor.setValue(text);
      return subtreeEditor.getValue();
    },
    /** 走 UI 的 Apply 按钮（等 lint/禁用态生效后点击）。 */
    editClickApply: () => {
      document.getElementById('editApply')?.click();
      return { open: subtreeEditor.isOpen() };
    },
    /** 直接走 app 的 Apply 流程（等价编辑器 Apply，绕过按钮）；返回 socket 状态。 */
    editApplyText: async (text: string) => {
      await applyEditText(text);
      return { ...stateOf(), open: subtreeEditor.isOpen() };
    },
    editClose: () => {
      subtreeEditor.close();
      editingPath = null;
      return true;
    },
    undo: async () => ({ ok: await undoEdit(), ...stateOf() }),
    redo: async () => ({ ok: await redoEdit(), ...stateOf() }),
    resetEdits: async () => ({ ok: await resetEdits(true), ...stateOf() }),
    exportDocText: async () => {
      if (!rootId) return null;
      const reply = await core.exportDoc(rootId, 2);
      return {
        bytes: reply.bytes,
        text: reply.text,
        name: exportName(meta?.name ?? 'doc.json', editState.dirty, meta?.repair?.status === 'repaired'),
      };
    },
    editBadgeText: () => ({ hidden: editBadge.hidden, text: editBadge.textContent }),

    // ---- 复制四格式 dev hook（契约见 docs/adr/0010-copy-formats-and-clipboard.md §9）----

    /** 模拟右键打开菜单（走真实 showContextMenu）；返回菜单项文案/禁用态（DOM 顺序）。 */
    ctxOpen: (path: string, fallbackKind: JsonKind = 'object') => {
      const rowEl = treeHost.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(path)}"]`);
      const rect = rowEl?.getBoundingClientRect();
      // 与真实右键同源：优先取行 DOM 上的节点类型（row-renderer 写入），取不到才用调用方给的兜底
      const kind = (rowEl?.dataset.kind as JsonKind | undefined) ?? fallbackKind;
      showContextMenu(path, (rect?.left ?? 40) + 24, (rect?.top ?? 80) + 12, kind);
      return {
        hidden: ctxMenu.hidden,
        items: ctxItems().map((item) => ({
          act: item.dataset.act ?? '',
          label: item.textContent ?? '',
          disabled: item.disabled,
        })),
      };
    },
    /** 点菜单项（真实 DOM click），等到 toast 变化后返回（复制是异步的）。 */
    ctxClick: async (act: string) => {
      const item = ctxMenu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
      if (!item) return { clicked: false, toast: '', hidden: ctxMenu.hidden };
      const before = toast.textContent ?? '';
      item.click();
      for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
        if ((toast.textContent ?? '') !== before) break;
      }
      return {
        clicked: true,
        toast: toast.hidden ? '' : (toast.textContent ?? ''),
        hidden: ctxMenu.hidden,
      };
    },
    /** 走 core 的复制路径但不写剪贴板（逐字断言用）。 */
    copyResolve: async (path: string, format: CopyFormat) => {
      if (!rootId) return { error: { code: 'NO_ROOT', message: 'no document loaded' } };
      try {
        const reply = await core.copyNode({ rootId, path, format, indent: settings.get('copyIndent') });
        return { text: reply.text, bytes: reply.bytes, format: reply.format };
      } catch (error) {
        const coreError = CoreError.from(error);
        return { error: { code: coreError.code, message: coreError.message, bytes: coreError.bytes } };
      }
    },
    clipboardText: async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    },
    toastText: () => (toast.hidden ? '' : (toast.textContent ?? '')),

    // ---- 截断修复 dev hook（契约见 docs/adr/0004 修订 §6 验收）----
    // ---- 导出 dev hook（契约见 docs/adr/0012 §6/§7）----
    exportState: () => exportHookState(),
    exportMenuOpen: () => {
      exportMenuBtn.click();
      return exportHookState();
    },
    exportClick: () => {
      exportBtn.click();
      return true;
    },
    exportChoose: (mode: ExportMode) => {
      const item = exportMenuItems().find((entry) => entry.dataset.exportMode === normalizeExportMode(mode));
      item?.click();
      return Boolean(item);
    },

    // ---- 设置 dev hook（契约见 docs/adr/0011 §7）----
    settingsState: () => ({
      ...settings.snapshot(),
      ui: settings.uiState(),
      loadedFromStore: settings.loadedFromStore,
    }),
    setSetting: (key: SettingsKey, value: unknown) => {
      const changed = settings.set(key, value);
      return { changed, ...settings.snapshot() };
    },
    /** 打开设置面板（走真实 setPanel），返回面板状态与焦点位置。 */
    settingsOpen: () => {
      setPanel('settings');
      return {
        panel: document.body.dataset.panel ?? null,
        title: panelTitle.textContent ?? '',
        focused: settingsHost.contains(document.activeElement) || document.activeElement === settingsHost,
        rows: [...settingsHost.querySelectorAll<HTMLElement>('[data-setting]')].map((row) => row.dataset.setting ?? ''),
      };
    },
    /** 行高/缩进/类型列等几何视图态（冒烟断言用）。 */
    treeGeometry: () => {
      // --row-h 设在树滚动容器上（tree-view mount 时写入），不是 :root
      const scroller = document.querySelector<HTMLElement>('.tjv-tree');
      const firstRow = document.querySelector<HTMLElement>('.row');
      return {
        rowHeight: tree.rowHeightPx(),
        viewportRows: tree.viewportRows(),
        totalRows,
        rowHeightCss: scroller ? getComputedStyle(scroller).getPropertyValue('--row-h').trim() : '',
        rowHeightComputed: firstRow ? getComputedStyle(firstRow).height : '',
        indentCss: getComputedStyle(document.documentElement).getPropertyValue('--row-indent').trim(),
        typeColumnVisible: [...settingsHost.ownerDocument.querySelectorAll<HTMLElement>('.row__type')].some(
          (el) => !el.hidden,
        ),
        spacerHeight: document.querySelector<HTMLElement>('.tjv-tree__spacer')?.style.height ?? null,
      };
    },
    repairState: () => ({
      status: meta?.repair?.status ?? 'none',
      visible: !repairBar.hidden,
      text: repairText.textContent ?? '',
      expanded: !repairOps.hidden,
      ops: Array.from(repairOps.querySelectorAll('.repairbar__op')).map((n) => n.textContent ?? ''),
      // 结构化 ops（#11 原文跳行验收：at = 原文本偏移）
      opsDetail: meta?.repair?.ops ?? [],
      summary: meta?.repair?.summaryText ?? null,
      counts: meta?.repair?.counts ?? null,
      truncatedAt: meta?.repair?.truncatedAt ?? null,
      exportName: meta ? exportName(meta.name, editState.dirty, meta.repair?.status === 'repaired') : null,
      statusState: statusState.textContent ?? '',
    }),
    repairToggle: () => {
      repairToggle.click();
      return !repairOps.hidden;
    },
    repairClose: () => {
      repairClose.click();
      return repairBar.hidden;
    },

    // ---- 原始文本视图 dev hook（契约见 docs/adr/0003 修订 §7）----
    rawState: () => rawHookState(),
    /** 切视图（走真实 setViewMode；原文首开会等索引构建完成）。 */
    setViewMode: async (mode: 'tree' | 'raw') => {
      const started = performance.now();
      await setViewMode(mode);
      return { ms: ms(started), ...rawHookState() };
    },
    /** 滚到像素位置（真实 scroll → onScroll → rawSource.scrollTo）。 */
    rawScrollTo: (px: number) => {
      rawView.scrollToPx(px);
      return rawHookState();
    },
    /** 直接走 core 取原文窗口（逐字断言/性能用；不影响视图）。 */
    rawWindowText: async (start: number, count: number) => {
      if (!rootId) return null;
      const started = performance.now();
      const reply = await core.rawWindow({ rootId, seq: 0, start, count });
      return { ms: ms(started), ...reply };
    },
    /** 源文本偏移 → 行号（逐字断言用）。 */
    rawLocate: async (offset: number) => {
      if (!rootId) return null;
      return core.rawLocate({ rootId, offset });
    },
    /** 修复摘要跳行（走真实 revealRepairOffset：切视图 + locate + 高亮）。 */
    rawRevealAt: async (offset: number) => {
      const started = performance.now();
      const line = await revealRepairOffset(offset);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      return { ms: ms(started), line, ...rawHookState() };
    },
    /** 点第 N 个修复摘要 `at` 按钮（真实 DOM click）。 */
    rawRepairAt: (index: number) => {
      const buttons = [...document.querySelectorAll<HTMLElement>('.repairbar__at')];
      const button = buttons[index] ?? null;
      button?.click();
      return { clicked: Boolean(button), count: buttons.length };
    },
    /** 走 core 取整份原文（不写剪贴板；逐字断言与守卫用）。 */
    rawCopyText: async (maxBytes?: number) => {
      if (!rootId) return null;
      try {
        const reply = await core.rawSource({ rootId, maxBytes });
        return { bytes: reply.bytes, chars: reply.text.length, text: reply.text };
      } catch (error) {
        const coreError = CoreError.from(error);
        return { error: { code: coreError.code, message: coreError.message, bytes: coreError.bytes } };
      }
    },
    /** 点「复制原文」按钮并等 toast（剪贴板逐字读回走 click 后的 clipboardText）。 */
    rawCopy: async () => {
      const before = toast.textContent ?? '';
      rawCopyBtn.click();
      for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
        if ((toast.textContent ?? '') !== before) break;
      }
      return { toast: toast.hidden ? '' : (toast.textContent ?? ''), ...rawHookState() };
    },
  };
}
