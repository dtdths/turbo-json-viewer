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
  CopyReply,
  CoreEvent,
  EditReply,
  ExpandReply,
  ExportReply,
  LoadReply,
  NodeJsonReply,
  ReplyOf,
  SearchReply,
  StatsReply,
} from '../protocol/messages';
import { ROOT_PATH } from '../shared/path';
import type { Path, RootId, RowWindow } from '../protocol/types';
import { ADAPTIVE_EXPAND_ROWS, EDIT_MAX_BYTES } from '../protocol/versions';
import { copyNodeText } from './copy';
import { EditHistory, type EditEntry } from './edit-history';
import { byteLengthOf, loadDocument, parseErrorPosition } from './import';
import { jsonKind, RowModel } from './row-model';
import { DOC_ROOT_ID, RootStore, type Root } from './root-store';
import { searchDocument } from './search';

type Cmd<K extends Command['t']> = Extract<Command, { t: K }>;

const NOT_IMPLEMENTED = 'not implemented in skeleton slice';

export class DocService {
  private readonly roots = new RootStore();
  /** 每根一份编辑历史（多文档标签时按 rootId 隔离；见 ADR-0009 预留） */
  private readonly histories = new Map<RootId, EditHistory>();
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
    this.histories.clear();
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
        return this.getNodeJson(cmd);
      case 'copyNode':
        return this.copyNode(cmd);
      case 'replaceNode':
        return this.replaceNode(cmd);
      case 'undo':
        return this.undo(cmd);
      case 'redo':
        return this.redo(cmd);
      case 'reset':
        return this.reset(cmd);
      case 'exportDoc':
        return this.exportDoc(cmd);
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
      // 截断修复（#8 / ADR-0004 修订）：provenance 已挂在 meta 上，事件供 UI 即时提示（与 LoadReply 冗余但不冲突）
      if (meta.repair?.status === 'repaired') this.emit({ t: 'repair', repair: meta.repair });

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

  /* ------------------------------ 子树编辑 ------------------------------ */

  private getNodeJson(cmd: Cmd<'getNodeJson'>): NodeJsonReply {
    const root = this.roots.require(cmd.rootId);
    const value = root.rowModel.valueAt(cmd.path);
    const text = JSON.stringify(value, null, 2);
    const bytes = byteLengthOf(text);
    if (bytes > EDIT_MAX_BYTES) {
      throw new CoreError({
        code: 'TOO_LARGE',
        message: `node JSON is ${bytes} bytes (> ${EDIT_MAX_BYTES}); pick a smaller subtree`,
        bytes,
      });
    }
    return { text, bytes, kind: jsonKind(value) };
  }

  /* -------------------------------- 复制 -------------------------------- */

  /**
   * 复制四格式（ADR-0010 §6）：**只读**——不推进 docRevision / rowVersion、不触发搜索 stale。
   * 文本生成全部在 `core/copy.ts`：主线程看不到值图，路径/键名必须与 `shared/path` 同源。
   */
  private copyNode(cmd: Cmd<'copyNode'>): CopyReply {
    const root = this.roots.require(cmd.rootId);
    const value = root.rowModel.valueAt(cmd.path);
    const { text, bytes } = copyNodeText({ format: cmd.format, path: cmd.path, value });
    return { text, bytes, format: cmd.format };
  }

  /**
   * Apply 一次子树替换（ADR-0006 / edit-spec §3）：
   * docRevision 校验 → 5MB 文本守卫 → JSON.parse（PARSE 带行列）→ no-op 判定 → 行模型增量替换
   * → 版本推进 → 记编辑历史。no-op 与错误都不产生任何修改。
   */
  private replaceNode(cmd: Cmd<'replaceNode'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    if (cmd.docRevision !== root.docRevision) {
      throw new CoreError({
        code: 'STALE_DOC',
        message: `replaceNode docRevision ${cmd.docRevision} != current ${root.docRevision}`,
      });
    }
    const bytes = byteLengthOf(cmd.jsonText);
    if (bytes > EDIT_MAX_BYTES) {
      throw new CoreError({
        code: 'TOO_LARGE',
        message: `edit text is ${bytes} bytes (> ${EDIT_MAX_BYTES}); pick a smaller subtree`,
        bytes,
      });
    }
    const parsed = this.parseEditText(cmd.jsonText);
    const oldValue = root.rowModel.valueAt(cmd.path); // 路径不存在 → BAD_COMMAND
    // no-op：规范化后的 JSON 等价（用户没改内容）→ 不推进版本、不记历史、无 changedRow
    if (JSON.stringify(oldValue, null, 2) === JSON.stringify(parsed, null, 2)) {
      return this.editReply(root);
    }

    const row = this.applyReplace(root, cmd.path, parsed);
    root.docRevision += 1;
    root.rowVersion += 1;
    this.historyOf(root.rootId).apply({ path: cmd.path, oldValue, newValue: parsed });
    return this.editReply(root, { row, path: cmd.path });
  }

  /** JSON.parse 编辑文本；失败 → PARSE（尽力还原 line/column，见 import.ts）。 */
  private parseEditText(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const position = parseErrorPosition(text, message);
      throw new CoreError({
        code: 'PARSE',
        message: `JSON.parse failed: ${message}`,
        ...position,
      });
    }
  }

  /** 行模型替换 + `Root.value` 同步（根替换后 search/profile 仍读新值图）。返回目标行号。 */
  private applyReplace(root: Root, path: Path, value: unknown): number {
    const result = root.rowModel.replaceNode(path, value);
    if (path === ROOT_PATH) root.value = value;
    return result.row;
  }

  /**
   * 撤销一步：取历史条目后用 oldValue 反向替换。若行模型拒绝（理论上不会：反向替换回到
   * 曾经被接受过的状态），把历史指针退回去再抛，保证历史与值图不脱节。
   */
  private undo(cmd: Cmd<'undo'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const history = this.historyOf(root.rootId);
    const entry = history.undo();
    if (!entry) throw new CoreError({ code: 'NO_HISTORY', message: 'nothing to undo' });
    let row: number;
    try {
      row = this.applyReplace(root, entry.path, entry.oldValue);
    } catch (err) {
      history.redo();
      throw err;
    }
    root.docRevision += 1;
    root.rowVersion += 1;
    return this.editReply(root, { row, path: entry.path });
  }

  /** 重做一步：取历史条目后用 newValue 正向替换（失败时指针退回，理由同 undo）。 */
  private redo(cmd: Cmd<'redo'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const history = this.historyOf(root.rootId);
    const entry = history.redo();
    if (!entry) throw new CoreError({ code: 'NO_HISTORY', message: 'nothing to redo' });
    let row: number;
    try {
      row = this.applyReplace(root, entry.path, entry.newValue);
    } catch (err) {
      history.undo();
      throw err;
    }
    root.docRevision += 1;
    root.rowVersion += 1;
    return this.editReply(root, { row, path: entry.path });
  }

  /**
   * 丢弃全部编辑：按 LIFO 反向应用每个已生效条目的 oldValue（edit-spec §5）。
   * 每步都推进 docRevision/rowVersion：reset 期间的任何迟到窗口回包都 stale，
   * 避免主线程把「半重置」的状态当成最新。反向序列经过的都是曾经被接受的合法状态，
   * 因此不会触发 TOO_MANY_ROWS；无编辑时按 no-op 回包（UI 不弹错）。
   */
  private reset(cmd: Cmd<'reset'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const history = this.historyOf(root.rootId);
    const applied = history.reset();
    if (applied.length === 0) return this.editReply(root);
    for (let i = applied.length - 1; i >= 0; i--) {
      const entry = applied[i] as EditEntry;
      this.applyReplace(root, entry.path, entry.oldValue);
      root.docRevision += 1;
      root.rowVersion += 1;
    }
    return this.editReply(root);
  }

  /**
   * 导出当前值图（`-edited` 下载；edit-spec §5）。Worker 内 stringify，**不受**编辑器 5MB 限制；
   * 用 `rowModel.value` 而不是 `root.value`：根替换后二者同步，但前者始终是行模型的真相源。
   */
  private exportDoc(cmd: Cmd<'exportDoc'>): ExportReply {
    const root = this.roots.require(cmd.rootId);
    const text = JSON.stringify(root.rowModel.value, null, cmd.indent ?? 2);
    return { text, bytes: byteLengthOf(text) };
  }

  private historyOf(rootId: RootId): EditHistory {
    let history = this.histories.get(rootId);
    if (!history) {
      history = new EditHistory();
      this.histories.set(rootId, history);
    }
    return history;
  }

  /** 统一 EditReply：版本 + 总行数 + 历史状态（UI 的「已临时修改 N 处」/ undo/redo 可用性）。 */
  private editReply(root: Root, changed?: { row?: number; path?: Path }): EditReply {
    const reply: EditReply = {
      rootId: root.rootId,
      docRevision: root.docRevision,
      rowVersion: root.rowVersion,
      totalRows: root.rowModel.totalRows,
      history: this.historyOf(root.rootId).state(),
    };
    if (changed?.row !== undefined && changed.row >= 0) reply.changedRow = changed.row;
    if (changed?.path !== undefined) reply.changedPath = changed.path;
    return reply;
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
