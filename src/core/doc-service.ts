/**
 * core/doc-service — Worker 内的核心门面：Command → Reply。
 *
 * 版本语义（ir-spec §4.1）：
 *   - docRevision：导入 / 修复 / replaceNode / reset
 *   - rowVersion：展开 / 折叠 / replaceNode / reset
 *   - window 校验 rowVersion，不符抛 STALE_ROOT；seq 由主线程用于丢弃迟到回包（core 只回显）
 *   - load 以 loadId 抢占：旧 load 以 CANCELLED 结束，结果不采纳
 *
 * 根变更路径（ADR-0002 修订 2026-11-09）：八条 EditReply 命令（toggle / toggleSubtree /
 * expandAll / collapseAll / replaceNode / undo / redo / reset）共用一条私有路径 `mutateRoot`：
 * 应用变更 → 按意图（view / value）推版本 → 组装形状恒定的 EditReply（`history` 恒定）。
 * 命令体只描述「改什么、意图是什么」；报字段（changedRow / changedPath）规则也只在此收口。
 * `expandTo` 是跳转查询（独立回包 ExpandReply），不属于这条路径。
 *
 * 原文视图（ADR-0003 修订 2026-11-03 §4）：rawOpen/rawWindow/rawLocate/rawSource 全部**只读**，
 * 不推进 docRevision / rowVersion；doc 根生命周期即原文版本（原文不随展开/临时编辑变化）。
 *
 * 大纲（ADR-0013 §3）：`outline` 只读，按容器**分页**枚举子项；不推任何版本、不依赖树展开态、不缓存。
 *
 * 保真（#23 / ADR-0003 修订 2026-11-09）：`fidelity` 只读扫描源文本，**不推版本**；
 * 报告按根对象身份缓存（源文本不变不重扫），文档替换/关闭即取消（CANCELLED）。
 *
 * 多文档标签（#18 / ADR-0009 §2）：doc 根 id 由 Worker 单调分配（`doc:1`、`doc:2`…，**永不复用**），
 * 第二次 load 得到**新根**而非原地覆盖；迟到的窗口/搜索回包靠「rootId 不复用 + 页面按 rootId 丢弃」
 * 判定，不能依赖版本号巧合。`closeRoot` 显式释放一个根（未知根幂等），连带丢弃 `parentRootId`
 * 指向它的 expression 根；search 抢占 seq 因此**按根独立**（每个标签的 seq 都从 1 起）。
 *
 * 骨架 slice：getNodeJson / replaceNode / undo / redo / reset / getTrail / profile 只保证签名，
 * 一律抛 BAD_COMMAND('not implemented in skeleton slice')。
 */
import { CoreError } from '../protocol/errors';
import type {
  CloseRootReply,
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
  CompleteReply,
  EvalReply,
  ExprCompletion,
  ExprLocateReply,
  FidelityReport,
  JsonKind,
  OutlineReply,
  Path,
  RawLocateReply,
  RawMeta,
  RawOffsetOfReply,
  RawPathAtReply,
  RawSourceReply,
  RawWindow,
  RootId,
  RowWindow,
} from '../protocol/types';
import { ADAPTIVE_EXPAND_ROWS, EDIT_MAX_BYTES, exprBudget, RAW_PATH_CACHE_SIZE } from '../protocol/versions';
import { clampInt } from '../shared/num';
import { copyNodeText } from './copy';
import {
  deepEqualJson,
  LosslessParseError,
  parseLossless,
  serializeLossless,
} from './lossless-json';
import { EditHistory } from './edit-history';
import { byteLengthOf, loadDocument, parseErrorPosition } from './import';
import { scanFidelity } from './fidelity';
import { jsonSizeLowerBoundChars } from './measure';
import { childCountOf, isContainer, jsonKind, RowModel, type ReplaceResult } from './row-model';
import { outlinePage } from './outline';
import { RootStore, type ExprRootMeta, type Root, type RootSource } from './root-store';
import { buildRawIndex, type RawTextIndex } from './raw-text';
import { SourcePathIndex } from './path-index';
import { searchDocument } from './search';
import { evaluateExpression, countDocumentNodes } from './expression/engine';
import { getCompletions } from './expression/complete';
import { locateOriginalPath } from './expression/locate';

type Cmd<K extends Command['t']> = Extract<Command, { t: K }>;

const NOT_IMPLEMENTED = 'not implemented in skeleton slice';

/* ---------------------------- 根变更路径的类型 ---------------------------- */

/** 根变更单步结果：`changed` 决定 view 意图是否推 rowVersion；`row` 用于报 changedRow。 */
interface MutationStep {
  changed: boolean;
  /** 变更后该行的行号；-1 / 缺省 = 不可见或不报 changedRow。 */
  row?: number;
}

/** 根变更意图：决定推进哪些版本（见 `mutateRoot`）。 */
type MutationIntent = 'view' | 'value';

/** 一次根变更计划：命令体只描述「改什么、意图是什么」。 */
interface RootMutation {
  intent: MutationIntent;
  /** 执行一步变更（必须原子）。reset 由调用方逐步调用本路径，每步各自推版本。 */
  run(): MutationStep;
  /** 回包附带 changedPath（只有值图变更才有）。 */
  path?: Path;
  /** 历史记账：仅在 run() 成功后调用。 */
  record?(): void;
}

/** 把 start/count/offset 夹到 [min, max] 的整数（非有限值 → min）。 */
export class DocService {
  private readonly roots = new RootStore();
  /** 每根一份编辑历史（多文档标签按 rootId 隔离；closeRoot 时随根释放，ADR-0009 §2） */
  private readonly histories = new Map<RootId, EditHistory>();
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  private readonly pendingLoads = new Map<number, { cancelled: boolean }>();
  private readonly cancelledSearches = new Set<number>();
  /**
   * 保真报告缓存（#23）：按**根对象身份**缓存——源文本不变就不重扫（编辑不重扫，ADR 修订 §1）。
   * 用 WeakMap 而不是 Root 字段：文档替换 = 旧根被丢弃 → 缓存随根一起可回收，无需清理代码。
   */
  private readonly fidelityCache = new WeakMap<Root, FidelityReport>();
  /**
   * 双向定位（#30 / ADR-0019）：源文本 path↔offset 索引按**根对象身份**惰性构建。
   * WeakMap → 文档替换 / 关闭即随旧根回收，无需显式清理；只依赖源文本、不受临时编辑影响。
   */
  private readonly pathIndexCache = new WeakMap<Root, SourcePathIndex>();
  /** 树→原文（path→offset）结果缓存：每根 LRU(RAW_PATH_CACHE_SIZE)；null 也缓存（避免反复全扫） */
  private readonly offsetCache = new WeakMap<Root, Map<Path, number | null>>();
  /** 表达式根 id 序号（`expr:1`、`expr:2`…；LRU 由 RootStore 收口） */
  private nextExprId = 0;
  /**
   * doc 根 id 序号（`doc:1`、`doc:2`…）：**单调不复用**，所以「旧根被关闭后再 load」不会拿到旧 id。
   * 迟到的窗口/搜索回包因此不可能命中新根（ADR-0009 §2 / §后果）。
   */
  private nextDocId = 0;
  /**
   * 文档节点数缓存（表达式步数预算用，ADR-0018 §3）：键 = doc 根 id，
   * 值 = { docRevision, count }——编辑推进 docRevision 后自动失效重算；首求值才计算（不拖慢导入）。
   */
  private readonly nodeCountCache = new Map<RootId, { docRevision: number; count: number }>();
  private latestLoadId = -1;
  /**
   * 搜索抢占 seq：**按根各自单调**（`Map<rootId, seq>`）。
   * 多标签下每个标签的 `SearchState.seq` 都从 1 起——若共用全局 number，B 标签的 seq=1 会被
   * A 标签的 seq=5 当成过期（CANCELLED），属多文档致命 bug（ADR-0009 §后果）。
   * `cancelSearch(seq)` 的全局 Set 保留原语义（app 不调用它）。
   */
  private readonly latestSearchSeq = new Map<RootId, number>();
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
    this.latestSearchSeq.clear();
    this.roots.clear();
    this.histories.clear();
    this.nodeCountCache.clear();
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
      case 'closeRoot':
        return this.closeRoot(cmd);
      case 'window':
        return this.window(cmd);
      case 'toggle':
        return this.toggle(cmd);
      case 'toggleSubtree':
        return this.toggleSubtree(cmd);
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
      case 'rawPathAt':
        return this.rawPathAt(cmd);
      case 'rawOffsetOf':
        return this.rawOffsetOf(cmd);
      case 'fidelity':
        return this.fidelity(cmd);
      case 'eval':
        return this.evalExpression(cmd);
      case 'complete':
        return this.complete(cmd);
      case 'exprLocate':
        return this.exprLocate(cmd);
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
    // 新 load 抢占所有在途旧 load。注意 loadId 抢占是**全局**的（不是按标签）：页面侧用入口层 busy
    // 拒绝并发导入（paste/drop 在 busy 时直接 return），并把「已被作废的 load 回包」用 closeRoot 释放，
    // 因此不会留下孤儿 doc 根；若将来要支持并发导入，需要按标签排队而不是靠抢占。
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
      // doc 根 id 由 Worker **单调分配、永不复用**（`doc:1`、`doc:2`…，ADR-0009 §2）：第二次 load
      // 得到一个新根而不是原地覆盖旧根；旧根由页面在新 load 成功后发 `closeRoot` 释放。
      // 新 id 天然干净 → 不需要清上一份文档的历史 / 节点数缓存，也**不能**丢弃别的标签的
      // expression 根（它们仍引用各自 doc 根的活值图）。
      const rootId: RootId = `doc:${++this.nextDocId}`;
      const root: Root = {
        rootId,
        kind: 'doc',
        value,
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

  /* ------------------------------ closeRoot ------------------------------ */

  /**
   * 关闭根（#18 / ADR-0009 §2）：释放该根的行模型索引 / 展开集合 / 值图引用（让 GC 回收 73MB 级堆）。
   *
   * - **幂等**：未知根 → `{ rootId, closed: false }`，不抛错（页面重复关 / 迟到关都安全）。
   * - **连带丢弃子根**：先删除 `parentRootId === 该根` 的 expression 根——它们的元素引用父根值图，
   *   父根一关即失效（不删会变成悬空的活引用，既泄漏又可能被 LRU 留着）。
   * - **真释放**：编辑历史 / 节点数缓存 / 搜索抢占 seq 一并删除（这些都是按 rootId 的旁路状态）。
   * - doc 根与 expression 根都允许关（页面只关 doc 根；表达式根平时由 LRU 收口）。
   * - 在途窗口/搜索回包不在这里取消：由页面按 rootId 丢弃（ADR-0009 §2，不需要新错误码）；
   *   在途 fidelity 扫描靠根身份校验自然变成 CANCELLED。
   */
  private closeRoot(cmd: Cmd<'closeRoot'>): CloseRootReply {
    const root = this.roots.get(cmd.rootId);
    if (root === undefined) return { rootId: cmd.rootId, closed: false };

    // 连带丢弃直接子根（当前只有 expression 用 parentRootId；本轮 id 快照避免边遍历边改）
    for (const rootId of this.roots.ids()) {
      if (rootId !== root.rootId && this.roots.get(rootId)?.parentRootId === root.rootId) {
        this.roots.close(rootId);
        this.dropRootState(rootId);
      }
    }
    this.roots.close(root.rootId);
    this.dropRootState(root.rootId);
    return { rootId: root.rootId, closed: true };
  }

  /** 释放一个根的旁路状态（编辑历史 / 节点数缓存 / 搜索抢占 seq）；不负责从 RootStore 删根。 */
  private dropRootState(rootId: RootId): void {
    this.histories.delete(rootId);
    this.nodeCountCache.delete(rootId);
    this.latestSearchSeq.delete(rootId);
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

  /**
   * 唯一根变更路径（ADR-0002 修订 2026-11-09）：应用变更 → 按意图推版本 → 组装恒定 EditReply。
   *
   * - `view`（展开态）：可见行真的变了（step.changed）才 `rowVersion++`；`docRevision` 不动
   *   （no-op 不制造 STALE_ROOT 抖动）。
   * - `value`（值图）：每一步都推 `docRevision++` + `rowVersion++`——reset 的 N 步即 N 次，
   *   迟到的行窗口回包因此全部 stale。
   * - 回包形状恒定：`history` 永远在（展开态命令不再另成方言）。
   * - 报字段：`changedRow` 取最后一步（要求 changed 且行可见）；`changedPath` 只由值图变更给。
   *
   * `run()` 抛错时不得留下部分修改（命令体负责原子性）。reset 逐步调用本路径：每个历史条目
   * 应用后立即推版本——中途失败时，已落地步骤的版本已推进，迟到的行窗口回包因此 stale
   * （与旧实现同口径；不回退版本，避免客户端把「半重置」的模型当成最新）。
   */
  private mutateRoot(root: Root, mutation: RootMutation): EditReply {
    const step = mutation.run();
    // view 意图只在可见结果真的变了时推版本；value 意图每步必推（值图变了就是变了）
    if (mutation.intent === 'value' || step.changed) {
      if (mutation.intent === 'value') root.docRevision += 1;
      root.rowVersion += 1;
    }
    mutation.record?.();

    const changed: { row?: number; path?: Path } = {};
    // changedRow：view 意图要求 changed；value 意图只看行是否可见（与旧实现 replace/undo/redo 一致）
    if (step.row !== undefined && step.row >= 0 && (mutation.intent === 'value' || step.changed)) {
      changed.row = step.row;
    }
    if (mutation.path !== undefined) changed.path = mutation.path;
    return this.editReply(root, changed);
  }

  private toggle(cmd: Cmd<'toggle'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    return this.mutateRoot(root, {
      intent: 'view',
      run: () => root.rowModel.toggle(cmd.path, cmd.open),
    });
  }

  /**
   * 子树批量展开 / 收起（#22 / ADR-0002 修订）：意图 = view，版本纪律与 `toggle` 完全一致——
   * 只有可见结果真的变了（`changed`）才 `rowVersion++`（`docRevision` 不动；no-op 不制造
   * STALE_ROOT 抖动），`changed` 且目标行可见（row >= 0）才填 `changedRow`；不可见节点上的
   * 惰性状态变化不回包。
   */
  private toggleSubtree(cmd: Cmd<'toggleSubtree'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    return this.mutateRoot(root, {
      intent: 'view',
      run: () => root.rowModel.toggleSubtree(cmd.path, cmd.open),
    });
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
    return this.mutateRoot(root, { intent: 'view', run: () => root.rowModel.expandAll() });
  }

  private collapseAll(cmd: Cmd<'collapseAll'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    return this.mutateRoot(root, { intent: 'view', run: () => root.rowModel.collapseAll() });
  }

  /* ------------------------------- search ------------------------------- */

  private async search(cmd: Cmd<'search'>): Promise<SearchReply> {
    const root = this.roots.require(cmd.rootId);
    // seq 抢占**按根**：多标签下每个标签的 seq 都从 1 起，共用全局 number 会互相误杀（ADR-0009 §后果）
    if (cmd.seq > (this.latestSearchSeq.get(root.rootId) ?? -1)) {
      this.latestSearchSeq.set(root.rootId, cmd.seq);
    }
    const seq = cmd.seq;
    // 同一根内「后到抢占先到」+ 全局取消集合（cancelSearch 保持原语义）
    const isSuperseded = (): boolean =>
      this.cancelledSearches.has(seq) || (this.latestSearchSeq.get(root.rootId) ?? -1) > seq;
    try {
      // 让出一拍：同 tick 后到的搜索可以抢占
      await Promise.resolve();
      if (isSuperseded()) {
        throw new CoreError({ code: 'CANCELLED', message: `search ${seq} superseded` });
      }
      const result = searchDocument(root.value, cmd.query, {
        ...cmd.opts,
        shouldCancel: isSuperseded,
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

  /**
   * 取子树的规范 pretty JSON（编辑弹层数据源；edit-spec §7 / ADR-0006 §5），两段判据：
   *
   *   1. **预扫描（分配无关）**：`jsonSizeLowerBoundChars` 用显式栈累加字符**下界**，
   *      跨过 `EDIT_MAX_BYTES` 立即早停 → 直接 TOO_LARGE。下界 ≤ 真实 UTF-8 字节数（论证见 core/measure.ts），
   *      所以这里的拒绝**零误拒**；同时避免「先 stringify 整棵超大树、再被拒」的分配峰值（README §11 已知差距）。
   *   2. **精确判据（达标路径）**：下界没超预算才 stringify，再用 `byteLengthOf` 判真实字节数——口径与旧实现一致。
   *
   * 注意：预扫描拒绝时**没有**精确 bytes，错误里的 `bytes` 是**字符下界**（≤ 真实字节数），
   * 仅供 UI 展示量级（`formatBytes`）与「超 5MB」判定，不承诺等于真实字节数。
   */
  private getNodeJson(cmd: Cmd<'getNodeJson'>): NodeJsonReply {
    const root = this.roots.require(cmd.rootId);
    const value = root.rowModel.valueAt(cmd.path);
    const lowerBoundChars = jsonSizeLowerBoundChars(value, EDIT_MAX_BYTES);
    if (lowerBoundChars > EDIT_MAX_BYTES) {
      throw new CoreError({
        code: 'TOO_LARGE',
        message: `node JSON char lower bound is ${lowerBoundChars} (> ${EDIT_MAX_BYTES} bytes); pick a smaller subtree`,
        bytes: lowerBoundChars,
      });
    }
    const text = serializeLossless(value, 2) ?? 'null';
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
   * docRevision 校验 → 5MB 文本守卫 → 无损解析（PARSE 带行列；ADR-0020）→ no-op 判定 → 行模型增量替换
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
    // no-op：结构化等价（用户没改内容）→ 不推进版本、不记历史、无 changedRow。
    // 不能用 JSON.stringify 比较：BigInt 会抛（ADR-0020），且深比较对键序/`-0` 的判定更明确。
    if (deepEqualJson(oldValue, parsed)) {
      return this.editReply(root);
    }

    return this.mutateRoot(root, {
      intent: 'value',
      path: cmd.path,
      run: () => this.applyReplace(root, cmd.path, parsed),
      record: () => this.historyOf(root.rootId).apply({ path: cmd.path, oldValue, newValue: parsed }),
    });
  }

  /** 无损解析编辑文本（ADR-0020）；失败 → PARSE（带 line/column）。 */
  private parseEditText(text: string): unknown {
    try {
      return parseLossless(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const position =
        err instanceof LosslessParseError
          ? { line: err.line, column: err.column }
          : parseErrorPosition(text, message);
      throw new CoreError({
        code: 'PARSE',
        message: `JSON parse failed: ${message}`,
        ...position,
      });
    }
  }

  /** 行模型替换 + `Root.value` 同步（根替换后 search/profile 仍读新值图）。返回行模型结果。 */
  private applyReplace(root: Root, path: Path, value: unknown): ReplaceResult {
    const result = root.rowModel.replaceNode(path, value);
    if (path === ROOT_PATH) root.value = value;
    return result;
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
    return this.mutateRoot(root, {
      intent: 'value',
      path: entry.path,
      run: () => {
        try {
          return this.applyReplace(root, entry.path, entry.oldValue);
        } catch (err) {
          history.redo();
          throw err;
        }
      },
    });
  }

  /** 重做一步：取历史条目后用 newValue 正向替换（失败时指针退回，理由同 undo）。 */
  private redo(cmd: Cmd<'redo'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const history = this.historyOf(root.rootId);
    const entry = history.redo();
    if (!entry) throw new CoreError({ code: 'NO_HISTORY', message: 'nothing to redo' });
    return this.mutateRoot(root, {
      intent: 'value',
      path: entry.path,
      run: () => {
        try {
          return this.applyReplace(root, entry.path, entry.newValue);
        } catch (err) {
          history.undo();
          throw err;
        }
      },
    });
  }

  /**
   * 丢弃全部编辑：按 LIFO 反向应用每个已生效条目的 oldValue（edit-spec §5）。
   * 意图 = value 的 N 步：每步都推进 docRevision/rowVersion——reset 期间的任何迟到窗口回包都
   * stale，避免主线程把「半重置」的状态当成最新。反向序列经过的都是曾经被接受的合法状态，
   * 因此不会触发 TOO_MANY_ROWS；无编辑时按 no-op 回包（UI 不弹错）。
   */
  private reset(cmd: Cmd<'reset'>): EditReply {
    const root = this.roots.require(cmd.rootId);
    const history = this.historyOf(root.rootId);
    const applied = history.reset();
    if (applied.length === 0) return this.editReply(root);
    for (let i = applied.length - 1; i >= 0; i--) {
      const entry = applied[i];
      // 每个条目各自走一次根变更路径：应用成功后立即推两版本（中途失败时前面已落地的步骤已 stale）
      this.mutateRoot(root, {
        intent: 'value',
        run: () => this.applyReplace(root, entry.path, entry.oldValue),
      });
    }
    // 回包只表达「已回到打开时状态」：不带 changedRow / changedPath（与旧实现一致）
    return this.editReply(root);
  }

  /**
   * 导出当前值图（`-edited` 下载；edit-spec §5）。Worker 内 stringify，**不受**编辑器 5MB 限制；
   * 用 `rowModel.value` 而不是 `root.value`：根替换后二者同步，但前者始终是行模型的真相源。
   */
  private exportDoc(cmd: Cmd<'exportDoc'>): ExportReply {
    const root = this.roots.require(cmd.rootId);
    const text = serializeLossless(root.rowModel.value, cmd.indent ?? 2) ?? 'null';
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

  /* --------------------------- 双向定位（#30 / ADR-0019） --------------------------- */

  /** 源文本结构索引（path↔offset）：首次双向定位命令才构建（50MB ≈ 一次词法扫描 + 检查点）。 */
  private pathIndexOf(root: Root): SourcePathIndex {
    let index = this.pathIndexCache.get(root);
    if (!index) {
      index = new SourcePathIndex(this.requireSource(root).text);
      this.pathIndexCache.set(root, index);
    }
    return index;
  }

  /**
   * 原文显示行 → 树节点路径（ADR-0019 §3）：锚点 = 行首第一个 token 所属节点。
   * plain 模式（截断修复后的源文本，行结构与值图不对应）→ `path=null`，不建索引。
   */
  private rawPathAt(cmd: Cmd<'rawPathAt'>): RawPathAtReply {
    const root = this.roots.require(cmd.rootId);
    this.requireSource(root);
    const index = this.rawIndexOf(root);
    const line = clampInt(cmd.line, 1, Math.max(1, index.totalLines));
    if (index.mode === 'plain') return { rootId: root.rootId, line, path: null, exact: false };
    const offset = index.tokenStartAt(line);
    if (offset === null) return { rootId: root.rootId, line, path: null, exact: false };
    const hit = this.pathIndexOf(root).pathAtOffset(offset);
    return { rootId: root.rootId, line, path: hit?.path ?? null, exact: hit?.exact ?? false };
  }

  /**
   * 树节点路径 → 原文锚点偏移 + 行号（ADR-0019 §3）：重复键取**最后一个**源位置
   * （与无损 parser 生效值一致，ADR-0020）。源文本没有该路径（临时修改新增 / plain）→ null。
   * 结果按根做 LRU 缓存：同一节点来回对照第二次起 0ms（树→原文是单趟扫描，见 ADR §2）。
   */
  private rawOffsetOf(cmd: Cmd<'rawOffsetOf'>): RawOffsetOfReply {
    const root = this.roots.require(cmd.rootId);
    this.requireSource(root);
    const index = this.rawIndexOf(root);
    if (index.mode === 'plain') {
      return { rootId: root.rootId, path: cmd.path, offset: null, line: null };
    }
    let cache = this.offsetCache.get(root);
    if (!cache) {
      cache = new Map<Path, number | null>();
      this.offsetCache.set(root, cache);
    }
    const cached = cache.get(cmd.path);
    let offset: number | null;
    if (cached !== undefined || cache.has(cmd.path)) {
      offset = cached as number | null;
      // LRU：命中挪到队尾
      cache.delete(cmd.path);
      cache.set(cmd.path, offset);
    } else {
      offset = this.pathIndexOf(root).offsetOfPath(cmd.path);
      cache.set(cmd.path, offset);
      if (cache.size > RAW_PATH_CACHE_SIZE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    if (offset === null) return { rootId: root.rootId, path: cmd.path, offset: null, line: null };
    return { rootId: root.rootId, path: cmd.path, offset, line: index.locate(offset) };
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

  /* ------------------------- 表达式视图（#12 / #27 / ADR-0018） ------------------------- */

  /** eval / complete 只接受**文档根**（表达式根不能再求值；`$` 恒指整份文档）。 */
  private requireDocRoot(rootId: RootId): Root {
    const root = this.roots.require(rootId);
    if (root.kind !== 'doc' && root.kind !== 'repaired') {
      throw new CoreError({
        code: 'BAD_COMMAND',
        message: `expression commands require a document root, got ${root.rootId} (${root.kind})`,
      });
    }
    return root;
  }

  /**
   * 文档节点数（步数预算的基数）：**首次求值才惰性计算**，按 (rootId, docRevision) 缓存；
   * 编辑推进 docRevision 后自动失效。50MB ≈3M 节点，估 30–60ms（ADR-0018 §3 已知差距）。
   */
  private docNodeCount(root: Root): number {
    const cached = this.nodeCountCache.get(root.rootId);
    if (cached !== undefined && cached.docRevision === root.docRevision) return cached.count;
    const count = countDocumentNodes(root.rowModel.value);
    this.nodeCountCache.set(root.rootId, { docRevision: root.docRevision, count });
    return count;
  }

  /**
   * 求值（ADR-0018 §3/§4）：doc 根 → 预算（档位 × 节点数）→ 引擎（parse/validate/walk）→
   * 成功才创建 `expr:N` 结果根（元素引用原节点，不复制；LRU 3 由 RootStore 收口）。
   * 引擎级失败是**正常回包**（`{ok:false,error}`），不抛 CoreError。
   */
  private evalExpression(cmd: Cmd<'eval'>): EvalReply {
    const docRoot = this.requireDocRoot(cmd.rootId);
    const budget = exprBudget(cmd.budget, this.docNodeCount(docRoot));
    const outcome = evaluateExpression(cmd.text, docRoot.rowModel.value, {
      strict: cmd.strict,
      budget,
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };

    const rootId: RootId = `expr:${++this.nextExprId}`;
    const rowModel = new RowModel(outcome.value);
    const now = Date.now();
    const expr: ExprRootMeta = {
      text: cmd.text,
      strict: cmd.strict,
      budget: cmd.budget,
      truncated: outcome.truncated,
      skipped: outcome.skipped,
      ms: outcome.ms,
      steps: outcome.steps,
      seq: cmd.seq,
      origins: outcome.origins,
    };
    const root: Root = {
      rootId,
      kind: 'expression',
      value: outcome.value,
      rowModel,
      docRevision: docRoot.docRevision,
      rowVersion: 1,
      parentRootId: docRoot.rootId,
      createdAt: now,
      lastUsedAt: now,
      expr,
    };
    const evicted = this.roots.put(root);
    // 被 LRU 淘汰的根：通知页面（页面若还看着它会话视图会自动回文档树；见 ADR-0018 §4）
    for (const victim of evicted) {
      this.emit({ t: 'stale', rootId: victim.rootId, why: 'expression root evicted (LRU 3)' });
    }
    return {
      ok: true,
      rootId,
      docRevision: docRoot.docRevision,
      rowVersion: root.rowVersion,
      totalRows: rowModel.totalRows,
      count: isContainer(outcome.value) ? childCountOf(outcome.value) : 0,
      kind: outcome.kind,
      ms: outcome.ms,
      steps: outcome.steps,
      truncated: outcome.truncated,
      skipped: outcome.skipped,
    };
  }

  /**
   * 静态补全（ADR-0018 §2/§3）：数据源在 worker（根级顶层字段 + 全局白名单 + 方法字典），
   * 只读、不推版本、不缓存。`pos` 夹到文本范围（CM6 的 `context.pos`）。
   */
  private complete(cmd: Cmd<'complete'>): CompleteReply {
    const docRoot = this.requireDocRoot(cmd.rootId);
    const value = docRoot.rowModel.value;
    const rootKeys: string[] = [];
    const rootKinds: Record<string, JsonKind> = {};
    if (isContainer(value) && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      for (const key of Object.keys(object)) {
        rootKeys.push(key);
        rootKinds[key] = jsonKind(object[key]);
      }
    }
    const pos = clampInt(cmd.pos, 0, cmd.text.length);
    return { items: getCompletions(cmd.text, pos, { rootKeys, rootKinds }) };
  }

  /**
   * 结果行 → 原文档路径（ADR-0018 §4.3）：来源映射只在 worker 保留（`Root.expr.origins`），
   * 页面按需查询（多一次 round-trip ≈1–2ms）。只读、不推版本。
   */
  private exprLocate(cmd: Cmd<'exprLocate'>): ExprLocateReply {
    const root = this.roots.require(cmd.rootId);
    if (root.kind !== 'expression' || root.expr === undefined) {
      throw new CoreError({
        code: 'BAD_COMMAND',
        message: `exprLocate requires an expression root, got ${root.rootId} (${root.kind})`,
      });
    }
    return { path: locateOriginalPath(root.rowModel.value, root.expr.origins, cmd.path) };
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
