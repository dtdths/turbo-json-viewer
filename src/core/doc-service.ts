/**
 * core/doc-service — Worker 内的核心门面：Command → Reply。
 *
 * 版本语义（ir-spec §4.1）：
 *   - docRevision：导入 / 修复 / replaceNode / reset
 *   - rowVersion：展开 / 折叠 / replaceNode / reset
 *   - window 校验 rowVersion，不符抛 STALE_ROOT；seq 由主线程用于丢弃迟到回包（core 只回显）
 *   - load 以 loadId 抢占：旧 load 以 CANCELLED 结束，结果不采纳
 *
 * 骨架 slice：getNodeJson / replaceNode / undo / redo / reset / getTrail / profile 只保证签名，
 * 一律抛 BAD_COMMAND('not implemented in skeleton slice')。
 */
import { CoreError } from '../protocol/errors';
import type {
  Command,
  CoreEvent,
  EditReply,
  ExpandReply,
  LoadReply,
  ReplyOf,
  SearchReply,
  StatsReply,
} from '../protocol/messages';
import type { RowWindow } from '../protocol/types';
import { ADAPTIVE_EXPAND_ROWS } from '../protocol/versions';
import { loadDocument } from './import';
import { RowModel } from './row-model';
import { DOC_ROOT_ID, RootStore, type Root } from './root-store';
import { searchDocument } from './search';

type Cmd<K extends Command['t']> = Extract<Command, { t: K }>;

const NOT_IMPLEMENTED = 'not implemented in skeleton slice';

export class DocService {
  private readonly roots = new RootStore();
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  private readonly pendingLoads = new Map<number, { cancelled: boolean }>();
  private readonly cancelledSearches = new Set<number>();
  private latestLoadId = -1;
  private latestSearchSeq = -1;
  private closed = false;

  dispatch<C extends Command>(cmd: C): Promise<ReplyOf<C>> {
    return this.handle(cmd) as unknown as Promise<ReplyOf<C>>;
  }

  on(listener: (event: CoreEvent) => void): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.pendingLoads.clear();
    this.cancelledSearches.clear();
    this.roots.clear();
  }

  /* ------------------------------ dispatch ------------------------------ */

  private async handle(cmd: Command): Promise<unknown> {
    if (this.closed) throw new CoreError({ code: 'CLOSED', message: 'DocService is closed' });

    switch (cmd.t) {
      case 'load':
        return this.load(cmd);
      case 'cancelLoad':
        this.cancelLoad(cmd.loadId);
        return undefined;
      case 'window':
        return this.window(cmd);
      case 'toggle':
        return this.toggle(cmd);
      case 'expandTo':
        return this.expandTo(cmd);
      case 'expandAll':
        return this.expandAll(cmd);
      case 'collapseAll':
        return this.collapseAll(cmd);
      case 'search':
        return this.search(cmd);
      case 'cancelSearch':
        this.cancelSearch(cmd.seq);
        return undefined;
      case 'stats':
        return this.stats(cmd);
      case 'getNodeJson':
      case 'replaceNode':
      case 'undo':
      case 'redo':
      case 'reset':
      case 'getTrail':
      case 'profile':
        throw new CoreError({ code: 'BAD_COMMAND', message: NOT_IMPLEMENTED });
      default:
        throw new CoreError({ code: 'BAD_COMMAND', message: `unknown command: ${(cmd as { t: string }).t}` });
    }
  }

  /* -------------------------------- load -------------------------------- */

  private async load(cmd: Cmd<'load'>): Promise<LoadReply> {
    const loadId = cmd.loadId;
    this.latestLoadId = loadId;
    // 新 load 抢占所有在途旧 load
    for (const [id, ctrl] of this.pendingLoads) {
      if (id !== loadId) ctrl.cancelled = true;
    }
    const ctrl = { cancelled: false };
    this.pendingLoads.set(loadId, ctrl);

    try {
      this.emit({ t: 'load-progress', loadId, phase: 'decode' });
      const { value, meta } = loadDocument({ source: cmd.source, data: cmd.data, name: cmd.name });
      this.emit({ t: 'load-progress', loadId, phase: 'parse' });

      // 让出一个微任务：同一 tick 里后到的 load 可以抢占这次 load
      await Promise.resolve();
      if (ctrl.cancelled || this.latestLoadId !== loadId) {
        throw new CoreError({ code: 'CANCELLED', message: `load ${loadId} superseded` });
      }

      this.emit({ t: 'load-progress', loadId, phase: 'model' });
      const rowModel = new RowModel(value);
      // 自适应展开（ADR-0002 修订 / #9）：小文档加载即全展开；超阈值保持默认折叠。
      // 不抛错——自适应失败不能拖垮 load。
      rowModel.expandIfAtMost(ADAPTIVE_EXPAND_ROWS);
      const totalRows = rowModel.totalRows;

      const now = Date.now();
      const root: Root = {
        rootId: DOC_ROOT_ID,
        kind: 'doc',
        value,
        expanded: rowModel.expanded,
        rowModel,
        docRevision: 1,
        rowVersion: 1,
        meta,
        createdAt: now,
        lastUsedAt: now,
      };
      this.roots.put(root);
      return {
        rootId: root.rootId,
        docRevision: root.docRevision,
        rowVersion: root.rowVersion,
        totalRows,
        meta,
      };
    } finally {
      this.pendingLoads.delete(loadId);
    }
  }

  private cancelLoad(loadId: number): void {
    const pending = this.pendingLoads.get(loadId);
    if (pending) pending.cancelled = true;
    if (this.latestLoadId === loadId) this.latestLoadId = -1;
  }

  /* ------------------------------- window ------------------------------- */

  private window(cmd: Cmd<'window'>): RowWindow {
    const root = this.roots.require(cmd.rootId);
    if (cmd.rowVersion !== root.rowVersion) {
      throw new CoreError({
        code: 'STALE_ROOT',
        message: `window rowVersion ${cmd.rowVersion} != current ${root.rowVersion}`,
      });
    }
    const start = Number.isFinite(cmd.start) ? Math.max(0, Math.floor(cmd.start)) : 0;
    const count = Number.isFinite(cmd.count) ? Math.max(0, Math.floor(cmd.count)) : 0;
    const rows = root.rowModel.window(start, count);
    return {
      rootId: root.rootId,
      rowVersion: root.rowVersion,
      seq: cmd.seq,
      start,
      count,
      rows,
      totalRows: root.rowModel.totalRows,
    };
  }

  /* --------------------------- toggle/expand --------------------------- */

  private toggle(cmd: Cmd<'toggle'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const result = root.rowModel.toggle(cmd.path, cmd.open);
    // 只有行映射真的变了才推进 rowVersion（no-op 不制造 STALE_ROOT 抖动）
    if (result.changed) root.rowVersion += 1;
    const reply: EditReply = {
      rootId: root.rootId,
      docRevision: root.docRevision,
      rowVersion: root.rowVersion,
      totalRows: result.totalRows,
    };
    // 不可见路径（祖先折叠）时 result.row = -1，不塞进回包
    if (result.changed && result.row >= 0) reply.changedRow = result.row;
    return reply;
  }

  private expandTo(cmd: Cmd<'expandTo'>): ExpandReply {
    const root = this.roots.require(cmd.rootId);
    const result = root.rowModel.expandPath(cmd.path);
    if (result.changed) root.rowVersion += 1;
    return {
      rootId: root.rootId,
      rowVersion: root.rowVersion,
      row: result.row,
      totalRows: result.totalRows,
    };
  }

  /* ---------------------- expandAll / collapseAll ---------------------- */

  private expandAll(cmd: Cmd<'expandAll'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const result = root.rowModel.expandAll();
    if (result.changed) root.rowVersion += 1;
    return {
      rootId: root.rootId,
      docRevision: root.docRevision,
      rowVersion: root.rowVersion,
      totalRows: result.totalRows,
    };
  }

  private collapseAll(cmd: Cmd<'collapseAll'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const result = root.rowModel.collapseAll();
    if (result.changed) root.rowVersion += 1;
    return {
      rootId: root.rootId,
      docRevision: root.docRevision,
      rowVersion: root.rowVersion,
      totalRows: result.totalRows,
    };
  }

  /* ------------------------------- search ------------------------------- */

  private async search(cmd: Cmd<'search'>): Promise<SearchReply> {
    const root = this.roots.require(cmd.rootId);
    if (cmd.seq > this.latestSearchSeq) this.latestSearchSeq = cmd.seq;
    const seq = cmd.seq;
    try {
      // 让出一拍：同 tick 后到的搜索可以抢占
      await Promise.resolve();
      if (this.cancelledSearches.has(seq) || this.latestSearchSeq > seq) {
        throw new CoreError({ code: 'CANCELLED', message: `search ${seq} superseded` });
      }
      const result = searchDocument(root.value, cmd.query, {
        ...cmd.opts,
        shouldCancel: () => this.cancelledSearches.has(seq) || this.latestSearchSeq > seq,
      });
      return {
        seq,
        rootId: root.rootId,
        docRevision: root.docRevision,
        hits: result.hits,
        total: result.total,
        truncated: result.truncated,
      };
    } finally {
      this.cancelledSearches.delete(seq);
    }
  }

  private cancelSearch(seq: number): void {
    this.cancelledSearches.add(seq);
  }

  /* -------------------------------- stats ------------------------------- */

  private stats(cmd: Cmd<'stats'>): StatsReply {
    const root = this.roots.require(cmd.rootId);
    return {
      rootId: root.rootId,
      docRevision: root.docRevision,
      rowVersion: root.rowVersion,
      totalRows: root.rowModel.totalRows,
    };
  }

  /* ------------------------------- events ------------------------------- */

  private emit(event: CoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不能打断 core
      }
    }
  }
}
