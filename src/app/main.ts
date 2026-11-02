/**
 * app/main — 扩展页入口：创建 Worker、装配 viewmodel + view。
 * 唯一知道「用哪个适配器」的地方（架构蓝图 §3.5）。
 */
import '../view/styles/tokens.css';
import './styles/shell.css';
import '../view/tree/tree.css';
import '../view/panels/search-panel.css';

import { createWorkerCore } from './transport/worker-transport';
import { RowWindowSource } from '../viewmodel/row-window-source';
import { SearchState, type SearchFilter } from '../viewmodel/search-state';
import { TreeView } from '../view/tree/tree-view';
import { DomRowPool } from '../view/tree/row-renderer';
import { SearchPanel } from '../view/panels/search-panel';
import { CoreError } from '../protocol/errors';
import { ROW_HEIGHT } from '../protocol/versions';
import { ROOT_PATH } from '../shared/path';
import type { DocumentMeta } from '../protocol/types';
import type { EditReply, LoadReply } from '../protocol/messages';
import { EditState } from '../viewmodel/edit-state';
import { SubtreeEditor } from '../view/panels/subtree-editor';

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
const selPath = el('selPath');
const selMeta = el('selMeta');

/* ---------------- core + viewmodel + view ---------------- */

const workerUrl = isExtension && chromeApi?.runtime ? chromeApi.runtime.getURL('worker.js') : './worker.js';
const worker = new Worker(workerUrl, { type: 'module' });
const workerCore = createWorkerCore(worker);
const core = workerCore.api;

const rowSource = new RowWindowSource(core, { rowHeight: ROW_HEIGHT });
const tree = new TreeView(treeHost, {
  rowHeight: ROW_HEIGHT,
  renderer: (host: HTMLElement) => new DomRowPool(host, { rowHeight: ROW_HEIGHT }),
  onScroll: (top: number) => rowSource.scrollTo(top),
  onToggle: (path: string, open: boolean) => {
    void toggleNode(path, open);
  },
  onSelect: (path: string) => setSelection(path),
  onEdit: (path: string) => {
    void openEditor(path);
  },
  onContextMenu: (path: string, x: number, y: number) => {
    setSelection(path);
    showContextMenu(path, x, y);
  },
});
tree.mount();

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

/** 编辑会话（slice 5 / #16 / ADR-0006）：当前编辑目标 + 修改计数/撤销可用性。 */
const editState = new EditState();
editState.subscribe(renderEditBadge);
let editingPath: string | null = null;
let ctxPath: string | null = null;

function metrics(): { rowHeight: number; viewportRows: number } {
  return { rowHeight: ROW_HEIGHT, viewportRows: Math.max(1, tree.viewportRows()) };
}

rowSource.subscribe((snapshot) => {
  tree.render(snapshot);
  updateStatus();
});

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
    const reply = await core.load({ loadId, source, data, name });
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
  exportBtn.disabled = false;
  expandAllBtn.disabled = false;
  collapseAllBtn.disabled = false;
  // 新文档：清空编辑会话（slice 5）
  editingPath = null;
  subtreeEditor.close();
  editState.clear();
  renderEditBadge();

  rowSource.setRoot({ rootId: rid, rowVersion, totalRows });
  rowSource.setMetrics(metrics());
  rowSource.requestWindow();
  rowSource.scrollTo(0);
  setSelection(null);
  resetSearch();
  setPanel('doc');
  updateStatus();
  treeHost.focus();
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

exportBtn.addEventListener('click', () => {
  void exportDoc();
});
editBadge.addEventListener('click', () => {
  void resetEdits();
});
ctxMenu.addEventListener('click', (event: MouseEvent) => {
  const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
  if (!item) return;
  const path = ctxPath;
  hideContextMenu();
  if (item.dataset.act === 'edit' && path) void openEditor(path);
});
ctxMenu.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') hideContextMenu();
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
  exportBtn.title = count > 0 ? '导出当前值图（含临时修改，文件名带 -edited）' : '导出当前值图';
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

function exportName(name: string, edited: boolean): string {
  const base = name.replace(/\.json$/i, '');
  return `${base}${edited ? '-edited' : ''}.json`;
}

/** 导出当前值图（唯一落盘动作；`-edited` 后缀；ADR-0006 §2）。 */
async function exportDoc(): Promise<void> {
  if (!rootId || !meta) return;
  exportBtn.disabled = true;
  try {
    const { text } = await core.exportDoc(rootId, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportName(meta.name, editState.dirty);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showError(error);
  } finally {
    exportBtn.disabled = false;
  }
}

function showContextMenu(path: string, x: number, y: number): void {
  ctxPath = path;
  ctxMenu.hidden = false;
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  ctxMenu.querySelector<HTMLElement>('[data-act="edit"]')?.focus();
}

function hideContextMenu(): void {
  if (ctxMenu.hidden) return;
  ctxMenu.hidden = true;
  ctxPath = null;
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

function setPanel(panel: 'doc' | 'search'): void {
  document.body.dataset.panel = panel;
  const buttons = document.querySelectorAll<HTMLElement>('.actbtn[data-panel-btn]');
  buttons.forEach((button) => {
    const active = button.dataset.panelBtn === panel;
    button.classList.toggle('is-active', active);
    // a11y（direction §8）：活动栏当前模式同步 aria-current，而不是只有 class
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (panel === 'search') searchPanel.focusInput();
}

document.querySelectorAll<HTMLElement>('[data-panel-btn]').forEach((button) => {
  button.addEventListener('click', () => {
    const panel = button.dataset.panelBtn;
    setPanel(panel === 'search' ? 'search' : 'doc');
  });
});
document.querySelectorAll<HTMLElement>('[data-panel-close]').forEach((button) => {
  button.addEventListener('click', () => setPanel('doc'));
});

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
  const hit = searchState.hits[index];
  if (!hit) return -1;
  try {
    const reply = await core.expandTo({ rootId, path: hit.path });
    rowVersion = reply.rowVersion;
    totalRows = reply.totalRows;
    rowSource.setRoot({ rootId, rowVersion, totalRows });
    rowSource.requestWindow();

    const viewportPx = tree.clientHeightPx();
    const centerOffset = Math.max(0, Math.floor((viewportPx - ROW_HEIGHT) / 2 / ROW_HEIGHT)) * ROW_HEIGHT;
    tree.scrollToPx(Math.max(0, reply.row * ROW_HEIGHT - centerOffset));

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
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

function toggleRail(): void {
  const collapsed = document.body.classList.toggle('rail-collapsed');
  el('railToggle').setAttribute('aria-pressed', collapsed ? 'false' : 'true');
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

function updateStatus(): void {
  if (!rootId || !meta) {
    statusRows.textContent = '未打开文档';
    statusSize.textContent = '—';
    statusPath.textContent = '';
    statusState.textContent = '只读 · 原文件不变';
    return;
  }
  const snapshot = rowSource.snapshot();
  statusRows.textContent = `${totalRows.toLocaleString()} 行 · 已渲染 ${snapshot.rows.length}`;
  statusSize.textContent = `${formatBytes(meta.bytes)} · v${docRevision}`;
  statusPath.textContent = selected ?? ROOT_PATH;
  statusPath.title = selected ?? ROOT_PATH;
  statusState.textContent = editState.dirty
    ? `临时修改 ${editState.count} 处 · 原文件不变`
    : '只读 · 原文件不变';
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

function showError(error: unknown): void {
  toast.textContent = formatCoreError(error);
  toast.hidden = false;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

/* ---------------- resize ---------------- */

const resizeObserver = new ResizeObserver(() => {
  rowSource.setMetrics(metrics());
  rowSource.requestWindow();
});
resizeObserver.observe(treeHost);

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
  });

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
      return { bytes: reply.bytes, text: reply.text, name: exportName(meta?.name ?? 'doc.json', editState.dirty) };
    },
    editBadgeText: () => ({ hidden: editBadge.hidden, text: editBadge.textContent }),
  };
}
