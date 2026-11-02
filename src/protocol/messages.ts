/**
 * protocol/messages — 主线程 ↔ Worker 的判别联合。
 * Command 是唯一跨线程写入口；CoreApi 是同一批操作的领域门面。
 */
import type {
  CopyFormat,
  DocumentMeta,
  DocumentProfile,
  Hit,
  JsonKind,
  MapTrail,
  Path,
  RepairProvenance,
  Rev,
  RootId,
  RowWindow,
  SearchOpts,
  SearchResult,
} from './types';
import type { CoreErrorShape } from './errors';

export type LoadSource = 'paste' | 'file' | 'clipboard';

export type Command =
  | { t: 'load'; loadId: number; source: LoadSource; data: ArrayBuffer | string; name?: string }
  | { t: 'cancelLoad'; loadId: number }
  | { t: 'window'; rootId: RootId; rowVersion: Rev; seq: number; start: number; count: number }
  | { t: 'toggle'; rootId: RootId; path: Path; open: boolean }
  | { t: 'expandTo'; rootId: RootId; path: Path }
  | { t: 'expandAll'; rootId: RootId }
  | { t: 'collapseAll'; rootId: RootId }
  | { t: 'search'; rootId: RootId; seq: number; query: string; opts?: SearchOpts }
  | { t: 'cancelSearch'; seq: number }
  | { t: 'getNodeJson'; rootId: RootId; path: Path }
  | { t: 'copyNode'; rootId: RootId; path: Path; format: CopyFormat }
  | { t: 'replaceNode'; rootId: RootId; path: Path; docRevision: Rev; jsonText: string }
  | { t: 'undo'; rootId: RootId }
  | { t: 'redo'; rootId: RootId }
  | { t: 'reset'; rootId: RootId }
  | { t: 'exportDoc'; rootId: RootId; indent?: number }
  | { t: 'getTrail'; rootId: RootId; path: Path | null }
  | { t: 'profile'; rootId: RootId }
  | { t: 'stats'; rootId: RootId };

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
