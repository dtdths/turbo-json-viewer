/**
 * protocol/messages — 主线程 ↔ Worker 的判别联合。
 * Command 是唯一跨线程写入口；CoreApi 是同一批操作的领域门面。
 */
import type {
  CopyFormat,
  DocumentMeta,
  DocumentProfile,
  FidelityReport,
  Hit,
  JsonKind,
  MapTrail,
  OutlineReply,
  Path,
  RawLocateReply,
  RawMeta,
  RawSourceReply,
  RawWindow,
  RepairProvenance,
  Rev,
  RootId,
  RowWindow,
  SearchOpts,
  SearchResult,
} from './types';
import type { CoreErrorShape } from './errors';

export type LoadSource = 'paste' | 'file' | 'clipboard';

/** 导入选项（ADR-0011 §5）：缺省 = 全开（保持既有行为）；设置面板落地后按偏好传入 */
export interface LoadOptions {
  /** false = 关闭截断自动修复（截断文本直接 PARSE） */
  repair?: boolean;
  /** false = 关闭小文档自适应展开（一律默认折叠） */
  adaptiveExpand?: boolean;
}

export type Command =
  | {
      t: 'load';
      loadId: number;
      source: LoadSource;
      data: ArrayBuffer | string;
      name?: string;
      opts?: LoadOptions;
    }
  | { t: 'cancelLoad'; loadId: number }
  | { t: 'window'; rootId: RootId; rowVersion: Rev; seq: number; start: number; count: number }
  | { t: 'toggle'; rootId: RootId; path: Path; open: boolean }
  | { t: 'expandTo'; rootId: RootId; path: Path }
  | { t: 'expandAll'; rootId: RootId }
  | { t: 'collapseAll'; rootId: RootId }
  | { t: 'search'; rootId: RootId; seq: number; query: string; opts?: SearchOpts }
  | { t: 'cancelSearch'; seq: number }
  | { t: 'getNodeJson'; rootId: RootId; path: Path }
  | { t: 'copyNode'; rootId: RootId; path: Path; format: CopyFormat; indent?: number }
  | { t: 'replaceNode'; rootId: RootId; path: Path; docRevision: Rev; jsonText: string }
  | { t: 'undo'; rootId: RootId }
  | { t: 'redo'; rootId: RootId }
  | { t: 'reset'; rootId: RootId }
  | { t: 'exportDoc'; rootId: RootId; indent?: number }
  | { t: 'getTrail'; rootId: RootId; path: Path | null }
  | { t: 'profile'; rootId: RootId }
  | { t: 'stats'; rootId: RootId }
  /* 大纲面板（ADR-0013）：按容器分页取子项；只读、不推任何版本 */
  | { t: 'outline'; rootId: RootId; path: Path; start: number; count: number }
  /* 原始文本视图（ADR-0003 修订 2026-11-03）：只读、不推任何版本 */
  | { t: 'rawOpen'; rootId: RootId }
  | { t: 'rawWindow'; rootId: RootId; seq: number; start: number; count: number }
  | { t: 'rawLocate'; rootId: RootId; offset: number }
  | { t: 'rawSource'; rootId: RootId; maxBytes?: number }
  /* 保真提示（#23 / ADR-0003 修订 2026-11-09）：只读、不推版本，首帧后由 app 显式调用 */
  | { t: 'fidelity'; rootId: RootId };

export interface LoadReply {
  rootId: RootId;
  docRevision: Rev;
  rowVersion: Rev;
  totalRows: number;
  meta: DocumentMeta;
}

/** 编辑历史状态（undo/redo/reset 与「已临时修改 N 处」徽标共用，见 #16 / ADR-0006） */
export interface EditHistoryState {
  /** 当前生效的编辑步数（撤销后减少，redo 后回增） */
  applied: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface EditReply {
  rootId: RootId;
  docRevision: Rev;
  rowVersion: Rev;
  totalRows: number;
  changedRow?: number;
  changedPath?: Path;
  history?: EditHistoryState;
}

/** 导出当前值图的 JSON 文本（`-edited` 下载用；不受编辑器 5MB 限制） */
export interface ExportReply {
  text: string;
  bytes: number;
}

export interface ExpandReply {
  rootId: RootId;
  rowVersion: Rev;
  row: number;
  totalRows: number;
}

export interface NodeJsonReply {
  text: string;
  bytes: number;
  /** 节点类型（编辑弹层标题用；见 #16） */
  kind?: JsonKind;
}

/** 复制回包（ADR-0010 §6）：文本在 core 侧生成，主线程只负责写剪贴板与反馈。 */
export interface CopyReply {
  text: string;
  /** UTF-8 字节数 */
  bytes: number;
  format: CopyFormat;
}

export interface TrailReply {
  trail: MapTrail;
}

export interface StatsReply {
  rootId: RootId;
  docRevision: Rev;
  rowVersion: Rev;
  totalRows: number;
}

export interface SearchReply extends SearchResult {
  seq: number;
  rootId: RootId;
}

/**
 * 保真回包（#23）：`report` 只描述**源文本**（临时修改不重扫）。
 * `docRevision` 只作诊断/兜底用途——**不要**用它判回包过期：编辑会推进 `docRevision`，
 * 但源文本不变、报告仍有效；app 用 `fidelitySeq` + `rootId` 丢弃迟到回包（见 `main.ts`）。
 */
export interface FidelityReply {
  rootId: RootId;
  docRevision: Rev;
  report: FidelityReport;
}

export interface ReplyByKind {
  load: LoadReply;
  cancelLoad: void;
  window: RowWindow;
  toggle: EditReply;
  expandTo: ExpandReply;
  expandAll: EditReply;
  collapseAll: EditReply;
  search: SearchReply;
  cancelSearch: void;
  getNodeJson: NodeJsonReply;
  copyNode: CopyReply;
  replaceNode: EditReply;
  undo: EditReply;
  redo: EditReply;
  reset: EditReply;
  exportDoc: ExportReply;
  getTrail: TrailReply;
  profile: DocumentProfile;
  stats: StatsReply;
  outline: OutlineReply;
  rawOpen: RawMeta;
  rawWindow: RawWindow;
  rawLocate: RawLocateReply;
  rawSource: RawSourceReply;
  fidelity: FidelityReply;
}

export type ReplyOf<C extends Command> = ReplyByKind[C['t']];

/** Worker → 主线程的异步事件（与 reply 无序）。 */
export type CoreEvent =
  | { t: 'load-progress'; loadId: number; phase: 'decode' | 'parse' | 'model' }
  | { t: 'repair'; repair: RepairProvenance }
  | { t: 'stale'; rootId: RootId; why: string }
  | { t: 'error'; error: CoreErrorShape };

/** 线上信封（structured-clone-safe） */
export type WireCommand = { kind: 'cmd'; id: number; cmd: Command };
export type WireReply =
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: CoreErrorShape }
  | { kind: 'event'; event: CoreEvent };
export type WireConnect = { kind: 'connect'; ctrl: MessagePort; win: MessagePort };

/** 搜索命中最小形状（worker 内 walk 时复用） */
export type HitDraft = Omit<Hit, 'row'> & { kind: JsonKind };
