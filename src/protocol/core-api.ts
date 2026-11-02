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
  EditReply,
  ExpandReply,
  LoadReply,
  NodeJsonReply,
  ReplyOf,
  SearchReply,
  StatsReply,
  TrailReply,
} from './messages';
import type {
  DocumentProfile,
  Path,
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

  getNodeJson(req: { rootId: RootId; path: Path }): Promise<NodeJsonReply>;
  replaceNode(req: ReplaceRequest): Promise<EditReply>;
  undo(rootId: RootId): Promise<EditReply>;
  redo(rootId: RootId): Promise<EditReply>;
  reset(rootId: RootId): Promise<EditReply>;

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
    getNodeJson: (req) => send({ t: 'getNodeJson', ...req }),
    replaceNode: (req) => send({ t: 'replaceNode', ...req }),
    undo: (rootId) => send({ t: 'undo', rootId }),
    redo: (rootId) => send({ t: 'redo', rootId }),
    reset: (rootId) => send({ t: 'reset', rootId }),
    getTrail: (req) => send({ t: 'getTrail', ...req }),
    profile: (rootId) => send({ t: 'profile', rootId }),
    stats: (rootId) => send({ t: 'stats', rootId }),
    on: (listener) => (subscribe ? subscribe(listener) : () => undefined),
    close: () => undefined,
  };
}
