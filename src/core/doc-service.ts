/**
 * core/doc-service — Worker 内的核心门面：Command → Reply。
 *
 * 版本语义（ir-spec §4.1）：
 *   - docRevision：导入 / 修复 / replaceNode / reset
 *   - rowVersion：展开 / 折叠 / replaceNode / reset
 *   - window 校验 rowVersion，不符抛 STALE_ROOT；seq 由主线程用于丢弃迟到回包（core 只回显）
 *   - load 以 loadId 抢占：旧 load 以 CANCELLED 结束，结果不采纳
 *
 * 原文视图（ADR-0003 修订 2026-11-03 §4）：rawOpen/rawWindow/rawLocate/rawSource 全部**只读**，
 * 不推进 docRevision / rowVersion；doc 根生命周期即原文版本（原文不随展开/临时编辑变化）。
 *
 * 大纲（ADR-0013 §3）：`outline` 只读，按容器**分页**枚举子项；不推任何版本、不依赖树展开态、不缓存。
 *
 * 保真（#23 / ADR-0003 修订 2026-11-09）：`fidelity` 只读扫描源文本，**不推版本**；
 * 报告按根对象身份缓存（源文本不变不重扫），文档替换/关闭即取消（CANCELLED）。
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
  FidelityReply,
  LoadReply,
  NodeJsonReply,
  ReplyOf,
  SearchReply,
  StatsReply,
} from '../protocol/messages';
import { ROOT_PATH } from '../shared/path';
import type {
  FidelityReport,
  OutlineReply,
  Path,
  RawLocateReply,
  RawMeta,
  RawSourceReply,
  RawWindow,
  RootId,
  RowWindow,
} from '../protocol/types';
import { ADAPTIVE_EXPAND_ROWS, EDIT_MAX_BYTES } from '../protocol/versions';
import { clampInt } from '../shared/num';
import { copyNodeText } from './copy';
import { EditHistory, type EditEntry } from './edit-history';
import { byteLengthOf, loadDocument, parseErrorPosition } from './import';
import { scanFidelity } from './fidelity';
import { jsonKind, RowModel } from './row-model';
import { outlinePage } from './outline';
import { DOC_ROOT_ID, RootStore, type Root, type RootSource } from './root-store';
import { buildRawIndex, type RawTextIndex } from './raw-text';
import { searchDocument } from './search';

type Cmd<K extends Command['t']> = Extract<Command, { t: K }>;

const NOT_IMPLEMENTED = 'not implemented in skeleton slice';

/** 把 start/count/offset 夹到 [min, max] 的整数（非有限值 → min）。 */
export class DocService {
  private readonly roots = new RootStore();
  /** 每根一份编辑历史（多文档标签时按 rootId 隔离；见 ADR-0009 预留） */
  private readonly histories = new Map<RootId, EditHistory>();
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  private readonly pendingLoads = new Map<number, { cancelled: boolean }>();
  private readonly cancelledSearches = new Set<number>();
  /**
   * 保真报告缓存（#23）：按**根对象身份**缓存——源文本不变就不重扫（编辑不重扫，ADR 修订 §1）。
   * 用 WeakMap 而不是 Root 字段：文档替换 = 旧根被丢弃 → 缓存随根一起可回收，无需清理代码。
   */
  private readonly fidelityCache = new WeakMap<Root, FidelityReport>();
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
      case 'outline':
        return this.outline(cmd);
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
      case 'rawOpen':
        return this.rawOpen(cmd);
      case 'rawWindow':
        return this.rawWindow(cmd);
      case 'rawLocate':
        return this.rawLocate(cmd);
      case 'rawSource':
        return this.rawSource(cmd);
      case 'fidelity':
        return this.fidelity(cmd);
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
      const { value, meta, text } = loadDocument({
        source: cmd.source,
        data: cmd.data,
        name: cmd.name,
        repair: cmd.opts?.repair,
      });
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
      // 设置可关（ADR-0011 §1 adaptiveExpand）；关闭时一律默认折叠。不抛错——自适应失败不能拖垮 load。
      if (cmd.opts?.adaptiveExpand !== false) rowModel.expandIfAtMost(ADAPTIVE_EXPAND_ROWS);
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
        // 源文本保留在 doc 根上（ADR-0003 修订 §2）：原文视图 / rawLocate 的真相源；惰性建索引
        source: { text, damaged: meta.repair !== undefined },
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
    const { text, bytes } = copyNodeText({
      format: cmd.format,
      path: cmd.path,
      value,
      indent: cmd.indent,
    });
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

  /* --------------------------- 原始文本视图 --------------------------- */

  /**
   * 惰性行索引：首次 raw* 命令才构建（不占首帧、不阻塞导入）。
   * 索引挂在 doc 根的 `source.index` 上，文档替换即随之释放。
   */
  private rawIndexOf(root: Root): RawTextIndex {
    const source = this.requireSource(root);
    if (!source.index) {
      source.index = buildRawIndex(source.text, { damaged: source.damaged === true });
    }
    return source.index;
  }

  /** doc 根上保留的源文本；expression 根等没有源文本的根 → BAD_COMMAND。 */
  private requireSource(root: Root): RootSource {
    const source = root.source;
    if (!source) {
      throw new CoreError({
        code: 'BAD_COMMAND',
        message: `root ${root.rootId} has no retained source text`,
      });
    }
    return source;
  }

  /** 原文行索引元信息；幂等，只读。 */
  private rawOpen(cmd: Cmd<'rawOpen'>): RawMeta {
    return this.rawIndexOf(this.roots.require(cmd.rootId)).meta();
  }

  /**
   * 原文窗口：只回行文本（不物化全文）。start/count 夹到有效范围，回包 count = 实际行数；
   * seq 只回显，由主线程丢弃迟到回包。只读，不推版本。
   */
  private rawWindow(cmd: Cmd<'rawWindow'>): RawWindow {
    const root = this.roots.require(cmd.rootId);
    const index = this.rawIndexOf(root);
    const totalLines = index.totalLines;
    const start = clampInt(cmd.start, 0, totalLines);
    const count = clampInt(cmd.count, 0, totalLines - start);
    const { lines, truncated } = index.windowText(start, count);
    const reply: RawWindow = {
      rootId: root.rootId,
      seq: cmd.seq,
      start,
      lines,
      totalLines,
      mode: index.mode,
    };
    if (truncated) reply.truncated = truncated;
    return reply;
  }

  /** 源文本偏移 → 1-based 显示行号（修复摘要 `at` 跳行）；偏移夹到 [0, chars]。 */
  private rawLocate(cmd: Cmd<'rawLocate'>): RawLocateReply {
    const index = this.rawIndexOf(this.roots.require(cmd.rootId));
    return { line: index.locate(cmd.offset), totalLines: index.totalLines };
  }

  /**
   * 整份原文（「复制原文」）：`bytes` = UTF-8 字节数；maxBytes 给定时超限抛 TOO_LARGE（带 bytes，
   * 与 ADR-0012 复制 JSON 的 20MB 剪贴板守卫同口径）。
   */
  private rawSource(cmd: Cmd<'rawSource'>): RawSourceReply {
    const source = this.requireSource(this.roots.require(cmd.rootId));
    const bytes = byteLengthOf(source.text);
    if (cmd.maxBytes !== undefined && bytes > cmd.maxBytes) {
      throw new CoreError({
        code: 'TOO_LARGE',
        message: `raw source is ${bytes} bytes (> ${cmd.maxBytes})`,
        bytes,
      });
    }
    return { text: source.text, bytes };
  }

  /* ------------------------------ 保真提示 ------------------------------ */

  /**
   * 保真扫描（#23 / ADR-0003 修订 2026-11-09 §1）：单趟扫描**源文本**，报告失真字面量/键序。
   *
   * - **只读**：不推进 docRevision / rowVersion、不动行模型、不发事件。
   * - **缓存**：报告挂在当前根对象身份上（WeakMap）；同一文档重复调用直接回缓存。
   *   编辑（replaceNode/undo/reset）不重扫——失真针对源文本，源文本不变（ADR 修订 §1）。
   * - **取消**：扫描分段让出事件循环；`shouldCancel` 以「根对象还是不是当前根的同一个对象」
   *   判定——文档被替换/关闭即取消，抛 `CANCELLED`（与 load/search 同口径，app 静默丢弃）。
   * - 文档没有保留源文本（expression 根）→ `BAD_COMMAND`；未知根 → `NO_ROOT`。
   */
  private async fidelity(cmd: Cmd<'fidelity'>): Promise<FidelityReply> {
    const root = this.roots.require(cmd.rootId);
    const cached = this.fidelityCache.get(root);
    if (cached !== undefined) {
      return { rootId: root.rootId, docRevision: root.docRevision, report: cached };
    }
    const source = this.requireSource(root);
    const report = await scanFidelity(source.text, {
      shouldCancel: () => this.roots.get(cmd.rootId) !== root,
    });
    // 取消（文档被替换 / 关闭）：报告作废，回包由 app 静默丢弃
    if (report === null || this.roots.get(cmd.rootId) !== root) {
      throw new CoreError({
        code: 'CANCELLED',
        message: `fidelity scan for root ${cmd.rootId} cancelled`,
      });
    }
    this.fidelityCache.set(root, report);
    return { rootId: root.rootId, docRevision: root.docRevision, report };
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

  /* -------------------------------- 大纲 -------------------------------- */

  /**
   * 大纲页（ADR-0013 §3）：按容器**分页**返回子项。
   *
   * 只读：不推进 docRevision / rowVersion、不改变树展开态（折叠容器同样可查）、不缓存
   * （每页重新枚举，见 core/outline.ts）。路径解析沿用行模型：路径不存在 / 中间段穿越标量
   * → `rowModel.valueAt` 抛 BAD_COMMAND（与 getNodeJson 同口径）；标量路径合法，回 total 0。
   */
  private outline(cmd: Cmd<'outline'>): OutlineReply {
    const root = this.roots.require(cmd.rootId);
    const value = root.rowModel.valueAt(cmd.path);
    return { rootId: root.rootId, ...outlinePage(value, cmd.path, cmd.start, cmd.count) };
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
