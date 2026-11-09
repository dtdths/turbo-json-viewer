/**
 * protocol/core-api — viewmodel 唯一依赖的核心 interface。
 *
 * 两种适配器实现它：
 *   - ModelInProcess（直接持有 core 的 DocService，单测/bench 用）
 *   - WorkerTransport（MessageChannel，生产用）
 * 两者共享本文件的 commandCore() 映射，保证调用面一致。
 */
import type {
  Command,
  CoreEvent,
  CopyReply,
  EditReply,
  ExpandReply,
  ExportReply,
  FidelityReply,
  LoadOptions,
  LoadReply,
  NodeJsonReply,
  ReplyOf,
  SearchReply,
  StatsReply,
  TrailReply,
} from './messages';
import type {
  CopyFormat,
  DocumentProfile,
  OutlineReply,
  Path,
  RawLocateReply,
  RawMeta,
  RawSourceReply,
  RawWindow,
  Rev,
  RootId,
  RowWindow,
  SearchOpts,
} from './types';

export interface LoadRequest {
  loadId: number;
  source: 'paste' | 'file' | 'clipboard';
  data: ArrayBuffer | string;
  name?: string;
  /** 导入选项（ADR-0011 §5）：缺省 = 全开 */
  opts?: LoadOptions;
}
export interface WindowRequest {
  rootId: RootId;
  rowVersion: Rev;
  seq: number;
  start: number;
  count: number;
}
export interface ToggleRequest {
  rootId: RootId;
  path: Path;
  open: boolean;
}
export interface ReplaceRequest {
  rootId: RootId;
  path: Path;
  docRevision: Rev;
  jsonText: string;
}
export interface SearchRequest {
  rootId: RootId;
  seq: number;
  query: string;
  opts?: SearchOpts;
}
/** 大纲页请求（ADR-0013）：按容器分页取子项；只读。 */
export interface OutlineRequest {
  rootId: RootId;
  /** 被查询容器路径（根 `$`） */
  path: Path;
  /** 起始子项下标；core 夹取到 [0, total] */
  start: number;
  /** 本页数量；core 夹取到 [0, OUTLINE_PAGE_MAX] */
  count: number;
}

export interface CoreApi {
  load(req: LoadRequest): Promise<LoadReply>;
  cancelLoad(loadId: number): void;

  window(req: WindowRequest): Promise<RowWindow>;
  toggle(req: ToggleRequest): Promise<EditReply>;
  expandTo(req: { rootId: RootId; path: Path }): Promise<ExpandReply>;
  expandAll(rootId: RootId): Promise<EditReply>;
  collapseAll(rootId: RootId): Promise<EditReply>;

  search(req: SearchRequest): Promise<SearchReply>;
  cancelSearch(seq: number): void;

  /** 大纲页（ADR-0013）：按容器分页取子项；只读、不推版本，不依赖树展开态。 */
  outline(req: OutlineRequest): Promise<OutlineReply>;

  getNodeJson(req: { rootId: RootId; path: Path }): Promise<NodeJsonReply>;
  /** 复制四格式（ADR-0010）：文本在 core 侧生成；只读，不推进版本。 */
  copyNode(req: { rootId: RootId; path: Path; format: CopyFormat; indent?: number }): Promise<CopyReply>;
  replaceNode(req: ReplaceRequest): Promise<EditReply>;
  undo(rootId: RootId): Promise<EditReply>;
  redo(rootId: RootId): Promise<EditReply>;
  reset(rootId: RootId): Promise<EditReply>;
  /** 导出当前值图 JSON（Worker stringify，-edited 下载；不受编辑器 5MB 限制） */
  exportDoc(rootId: RootId, indent?: number): Promise<ExportReply>;

  /* -------------------- 原始文本视图（ADR-0003 修订） -------------------- */
  /** 原文行索引元信息；首调惰性构建索引（幂等），只读、不推版本。 */
  rawOpen(req: { rootId: RootId }): Promise<RawMeta>;
  /** 原文窗口：只回行文本（≤ RAW_LINE_DISPLAY_MAX 字符/行）。seq 用于主线程丢弃迟到回包。 */
  rawWindow(req: { rootId: RootId; seq: number; start: number; count: number }): Promise<RawWindow>;
  /** 源文本偏移 → 1-based 源行号（修复摘要 `at` 跳行）。 */
  rawLocate(req: { rootId: RootId; offset: number }): Promise<RawLocateReply>;
  /** 整份源文本（复制原文）；超过 maxBytes 抛 TOO_LARGE。 */
  rawSource(req: { rootId: RootId; maxBytes?: number }): Promise<RawSourceReply>;

  /**
   * 保真扫描（#23 / ADR-0003 修订 2026-11-09）：只读、不推版本，首帧后由 app 显式调用。
   * 文档被替换 → 抛 `CANCELLED`（app 静默丢弃）；同一文档重复调用走 core 内缓存。
   */
  fidelity(req: { rootId: RootId }): Promise<FidelityReply>;

  getTrail(req: { rootId: RootId; path: Path | null }): Promise<TrailReply>;
  profile(rootId: RootId): Promise<DocumentProfile>;
  stats(rootId: RootId): Promise<StatsReply>;

  /** core → 主线程的异步事件（progress/repair/stale/error） */
  on(listener: (event: CoreEvent) => void): () => void;
  close(): void;
}

type Sender = <C extends Command>(cmd: C) => Promise<ReplyOf<C>>;

/** 把「按 Command 发送」适配成 CoreApi；两个 transport 共用，防止调用面漂移。 */
export function commandCore(send: Sender, subscribe?: (fn: (e: CoreEvent) => void) => () => void): CoreApi {
  const fire = (cmd: Command): void => {
    void Promise.resolve(send(cmd)).catch(() => {
      /* fire-and-forget：错误由事件通道/上层状态处理 */
    });
  };
  return {
    load: (req) => send({ t: 'load', ...req }),
    cancelLoad: (loadId) => fire({ t: 'cancelLoad', loadId }),
    window: (req) => send({ t: 'window', ...req }),
    toggle: (req) => send({ t: 'toggle', ...req }),
    expandTo: (req) => send({ t: 'expandTo', ...req }),
    expandAll: (rootId) => send({ t: 'expandAll', rootId }),
    collapseAll: (rootId) => send({ t: 'collapseAll', rootId }),
    search: (req) => send({ t: 'search', ...req }),
    cancelSearch: (seq) => fire({ t: 'cancelSearch', seq }),
    outline: (req) => send({ t: 'outline', ...req }),
    getNodeJson: (req) => send({ t: 'getNodeJson', ...req }),
    copyNode: (req) => send({ t: 'copyNode', ...req }),
    replaceNode: (req) => send({ t: 'replaceNode', ...req }),
    undo: (rootId) => send({ t: 'undo', rootId }),
    redo: (rootId) => send({ t: 'redo', rootId }),
    reset: (rootId) => send({ t: 'reset', rootId }),
    exportDoc: (rootId, indent) => send({ t: 'exportDoc', rootId, indent }),
    rawOpen: (req) => send({ t: 'rawOpen', ...req }),
    rawWindow: (req) => send({ t: 'rawWindow', ...req }),
    rawLocate: (req) => send({ t: 'rawLocate', ...req }),
    rawSource: (req) => send({ t: 'rawSource', ...req }),
    fidelity: (req) => send({ t: 'fidelity', ...req }),
    getTrail: (req) => send({ t: 'getTrail', ...req }),
    profile: (rootId) => send({ t: 'profile', rootId }),
    stats: (rootId) => send({ t: 'stats', rootId }),
    on: (listener) => (subscribe ? subscribe(listener) : () => undefined),
    close: () => undefined,
  };
}
