/**
 * protocol/messages — 主线程 ↔ Worker 的判别联合。
 * Command 是唯一跨线程写入口；CoreApi 是同一批操作的领域门面。
 */
import type {
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
  | { t: 'replaceNode'; rootId: RootId; path: Path; docRevision: Rev; jsonText: string }
  | { t: 'undo'; rootId: RootId }
  | { t: 'redo'; rootId: RootId }
  | { t: 'reset'; rootId: RootId }
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

export interface EditReply {
  rootId: RootId;
  docRevision: Rev;
  rowVersion: Rev;
  totalRows: number;
  changedRow?: number;
  changedPath?: Path;
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
  replaceNode: EditReply;
  undo: EditReply;
  redo: EditReply;
  reset: EditReply;
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
