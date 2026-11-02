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
import type { LoadReply } from '../protocol/messages';

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

/** 已打开文档时：点「导入」/文件 chip / ⌘O 打开显式替换层。 */
function openImportLayer(): void {
  if (!rootId || importLayerOpen()) return;
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
  openImportLayer();
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
 */
async function applyExpandAll(open: boolean): Promise<void> {
  if (!rootId) return;
  // 防重入：命令在途时禁用两个按钮（同时给出「处理中」的视觉反馈）
  expandAllBtn.disabled = true;
  collapseAllBtn.disabled = true;
  try {
    const reply = open ? await core.expandAll(rootId) : await core.collapseAll(rootId);
    rowVersion = reply.rowVersion;
    totalRows = reply.totalRows;
    rowSource.setRoot({ rootId, rowVersion, totalRows });
    rowSource.requestWindow();
    rowSource.scrollTo(0);
    tree.scrollToPx(0);
    // 命中集仍按路径有效（docRevision 未变），重推高亮
    applySearchToTree();
    updateStatus();
  } catch (error) {
    showError(error);
  } finally {
    expandAllBtn.disabled = false;
    collapseAllBtn.disabled = false;
  }
}

function setSelection(path: string | null): void {
  selected = path;
  tree.setSelected(path);
  selPath.textContent = path ?? '—';
  selPath.title = path ?? '';
  selMeta.textContent = path ? '按 F2 编辑（下一 slice）' : '';
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
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
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
  statusState.textContent = '只读 · 原文件不变';
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

window.addEventListener('beforeunload', () => {
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

  (globalThis as unknown as { __tjv?: unknown }).__tjv = {
    loadText: (text: string, name = 'sample.json') => importBuffer('file', text, name),
    scrollToPx: (px: number) => tree.scrollToPx(px),
    togglePath: (path: string, open: boolean) => toggleNode(path, open),
    expandAll: () => applyExpandAll(true),
    collapseAll: () => applyExpandAll(false),
    state: () => ({
      rootId,
      totalRows,
      rowVersion,
      docRevision,
      selected,
      rendered: rowSource.snapshot().rows.length,
      start: rowSource.snapshot().start,
      scrollTop: tree.scrollTopPx(),
    }),

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
  };
}
