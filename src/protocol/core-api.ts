/**
 * protocol/core-api — viewmodel 唯一依赖的核心 interface。
 *
 * 两种适配器实现它：
 *   - ModelInProcess（直接持有 core 的 DocService，单测/bench 用）
 *   - WorkerTransport（MessageChannel，生产用）
 * 两者共享本文件的 commandCore() 映射，保证调用面一致。
 */
import type {
  CloseRootReply,
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
  CompleteReply,
  CopyFormat,
  DocumentProfile,
  EvalReply,
  ExprBudgetLevel,
  ExprLocateReply,
  OutlineReply,
  Path,
  RawLocateReply,
  RawMeta,
  RawOffsetOfReply,
  RawPathAtReply,
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

/* ------------------------- 表达式视图请求（ADR-0018） ------------------------- */

/** 求值请求（#27 / ADR-0018 §3）：作用根恒为整份文档（`$`），不接受选中节点根。 */
export interface EvalRequest {
  rootId: RootId;
  /** 页面侧序号（丢弃迟到回包用） */
  seq: number;
  text: string;
  /** 严格模式：元素内部缺字段直接报错（会话级，不进设置持久化） */
  strict: boolean;
  /** 预算档位（设置第 11 项） */
  budget: ExprBudgetLevel;
}

/** 静态补全请求：`pos` 是表达式文本内的 UTF-16 偏移（CM6 `context.pos`）。 */
export interface CompleteRequest {
  rootId: RootId;
  text: string;
  pos: number;
}

/** 结果行 → 原文档路径（映射只在 worker 保留）。 */
export interface ExprLocateRequest {
  rootId: RootId;
  path: Path;
}

export interface CoreApi {
  load(req: LoadRequest): Promise<LoadReply>;
  cancelLoad(loadId: number): void;
  /**
   * 关闭根（#18 / ADR-0009 §2）：释放该根的行模型索引 / 展开集合 / 值图引用（让 GC 回收）。
   * 未知根幂等回 `{ closed: false }`（不抛）；关闭后该根上的命令一律 `NO_ROOT`。
   * 页面只关 doc 根；expression 根由 LRU 收口（关闭 doc 根会连带丢弃它的 expression 子根）。
   */
  closeRoot(rootId: RootId): Promise<CloseRootReply>;

  window(req: WindowRequest): Promise<RowWindow>;
  toggle(req: ToggleRequest): Promise<EditReply>;
  /** 子树批量展开/收起（#22 / ADR-0002 修订）：只作用于该容器子树，原子 + `ROW_BUDGET` 护栏 */
  toggleSubtree(req: ToggleRequest): Promise<EditReply>;
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
   * 原文显示行 → 树节点路径（#30 / ADR-0019 双向定位）：只读、不推版本。
   * plain 模式（截断修复后的源文本）没有可靠映射 → `path=null`；`exact=false` = 命中容器开括号。
   */
  rawPathAt(req: { rootId: RootId; line: number }): Promise<RawPathAtReply>;
  /**
   * 树节点路径 → 原文锚点偏移 + 行号（#30 / ADR-0019）：只读、不推版本。
   * 源文本没有该路径（临时修改新增节点 / plain 模式）→ `offset=null`；重复键取最后一个源位置。
   */
  rawOffsetOf(req: { rootId: RootId; path: Path }): Promise<RawOffsetOfReply>;

  /**
   * 保真扫描（#23 / ADR-0003 修订 2026-11-09）：只读、不推版本，首帧后由 app 显式调用。
   * 文档被替换 → 抛 `CANCELLED`（app 静默丢弃）；同一文档重复调用走 core 内缓存。
   */
  fidelity(req: { rootId: RootId }): Promise<FidelityReply>;

  getTrail(req: { rootId: RootId; path: Path | null }): Promise<TrailReply>;
  profile(rootId: RootId): Promise<DocumentProfile>;
  stats(rootId: RootId): Promise<StatsReply>;

  /* -------------------- 表达式视图（#12 / #27 / ADR-0018） -------------------- */
  /** 求值：成功时创建 / 复用 `expr:N` 结果根（元素引用原文档节点，LRU 3）。 */
  eval(req: EvalRequest): Promise<EvalReply>;
  /** 静态补全（全局白名单 + 根级顶层字段 + 方法字典；数据源在 worker）。 */
  complete(req: CompleteRequest): Promise<CompleteReply>;
  /** 结果行 → 原文档路径（路径映射只在 worker 保留，按需查询）。 */
  exprLocate(req: ExprLocateRequest): Promise<ExprLocateReply>;

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
    closeRoot: (rootId) => send({ t: 'closeRoot', rootId }),
    window: (req) => send({ t: 'window', ...req }),
    toggle: (req) => send({ t: 'toggle', ...req }),
    toggleSubtree: (req) => send({ t: 'toggleSubtree', ...req }),
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
    rawPathAt: (req) => send({ t: 'rawPathAt', ...req }),
    rawOffsetOf: (req) => send({ t: 'rawOffsetOf', ...req }),
    fidelity: (req) => send({ t: 'fidelity', ...req }),
    getTrail: (req) => send({ t: 'getTrail', ...req }),
    profile: (rootId) => send({ t: 'profile', rootId }),
    stats: (rootId) => send({ t: 'stats', rootId }),
    eval: (req) => send({ t: 'eval', ...req }),
    complete: (req) => send({ t: 'complete', ...req }),
    exprLocate: (req) => send({ t: 'exprLocate', ...req }),
    on: (listener) => (subscribe ? subscribe(listener) : () => undefined),
    close: () => undefined,
  };
}
