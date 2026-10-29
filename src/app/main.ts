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
const fileInput = el<HTMLInputElement>('fileInput');
const empty = el('empty');
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

/* ---------------- import ---------------- */

async function importBuffer(
  source: 'file' | 'paste' | 'clipboard',
  data: ArrayBuffer | string,
  name: string,
): Promise<void> {
  const loadId = ++loadSeq;
  try {
    const reply = await core.load({ loadId, source, data, name });
    if (loadId !== loadSeq) return;
    onLoaded(reply);
  } catch (error) {
    showError(error);
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

  empty.classList.add('is-hidden');
  fileChip.hidden = false;
  fileName.textContent = reply.meta.name;
  fileMeta.textContent = formatBytes(reply.meta.bytes);
  exportBtn.disabled = false;

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

document.addEventListener('paste', (event: ClipboardEvent) => {
  const text = event.clipboardData?.getData('text/plain');
  if (!text || !text.trim()) return;
  event.preventDefault();
  void importBuffer('paste', text, '剪贴板.json');
});

window.addEventListener('dragover', (event: DragEvent) => {
  event.preventDefault();
});
window.addEventListener('drop', (event: DragEvent) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void importFile(file);
});

el('importBtn').addEventListener('click', () => fileInput.click());
el('pickBtn').addEventListener('click', () => fileInput.click());
fileChip.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void importFile(file);
  fileInput.value = '';
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

function showError(error: unknown): void {
  const coreError = CoreError.from(error);
  const detail = coreError.code === 'PARSE' && coreError.line ? `（第 ${coreError.line} 行）` : '';
  toast.textContent = `${coreError.code}: ${coreError.message}${detail}`;
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
    state: () => ({
      rootId,
      totalRows,
      rowVersion,
      docRevision,
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
