/**
 * core/row-model — 固定行高可见行模型（ADR-0002）。
 *
 * IR = JSON 值图（唯一真相源；ADR-0020 起数字载体是 `number | bigint`——BigInt 归
 * `number` 类、显示为十进制串）+ 展开集合。
 * 每个 open 容器维护一份 Fenwick（子项**可见行数**前缀和），窗口按「下潜 O(depth·log n)」定位：
 *   - 不建扁平行表；不建全局 parentMap；节点身份这里不需要（行只带路径）。
 *   - 根永远 open；load 后 totalRows = 1 + 根容器子项数（顶层字段可见、容器默认折叠）。
 *
 * 关键不变量：
 *   - 折叠时只释放该容器自己的 Fenwick，子容器的展开状态保留（重新展开后恢复）。
 *   - 任何会让 totalRows 超过 rowBudget 的展开/替换都抛 TOO_MANY_ROWS，且不产生部分修改。
 */
import { CoreError } from '../protocol/errors';
import { ROW_BUDGET } from '../protocol/versions';
import type { JsonKind, Path, Row, SortOrder } from '../protocol/types';
import { appendIndex, appendKey, parsePath, ROOT_PATH } from '../shared/path';
import { normalizeSortOrder, orderedKeys } from './order';

/** JSON 容器（对象或数组）。标量（含 null）不是容器。 */
export type Container = Record<string, unknown> | unknown[];

/** 折叠容器摘要：取前 N 项、总长上限 C 字符。 */
export const SUMMARY_ITEMS = 3;
export const SUMMARY_CHARS = 90;
/** 搜索命中预览上限（命中集可能 5 万条，预览必须短）。 */
export const HIT_PREVIEW_CHARS = 80;

export function isContainer(node: unknown): node is Container {
  return typeof node === 'object' && node !== null;
}

export function isArrayContainer(node: Container): node is unknown[] {
  return Array.isArray(node);
}

export function jsonKind(node: unknown): JsonKind {
  if (node === null) return 'null';
  switch (typeof node) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'bigint':
      // 无损数字（ADR-0020）：BigInt 归 `number` 类，不新增 JsonKind 成员
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return Array.isArray(node) ? 'array' : 'object';
    default:
      return 'null';
  }
}

export function childCountOf(container: Container): number {
  return Array.isArray(container) ? container.length : Object.keys(container).length;
}

/** 标量的 JSON 原文（字符串带引号/转义；数字用 JSON 规则，BigInt 用十进制串）。 */
export function scalarPreview(node: unknown): string {
  if (node === null) return 'null';
  switch (typeof node) {
    case 'string':
      return JSON.stringify(node);
    case 'number':
      return JSON.stringify(node);
    case 'bigint':
      // 无损数字（ADR-0020）：BigInt 不能走 JSON.stringify（会抛 TypeError）
      return node.toString();
    case 'boolean':
      return node ? 'true' : 'false';
    default:
      // 值图不产生 undefined/function/symbol；防御性兜底成 null
      return 'null';
  }
}

/** 摘要里的单值短形态：容器用 `{…}` / `[…]`，不递归。 */
export function inlinePreview(node: unknown): string {
  if (!isContainer(node)) return scalarPreview(node);
  const count = childCountOf(node);
  if (Array.isArray(node)) return count > 0 ? '[…]' : '[]';
  return count > 0 ? '{…}' : '{}';
}

/** 按字符截断（不切断代理对），超长补 `…`。 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // 别把 emoji 切成两半
  return text.slice(0, end) + '…';
}

/** 折叠容器摘要：对象 `"k": v, …`；数组 `v, v, …`。 */
export function summarizeContainer(node: Container): string {
  const count = childCountOf(node);
  if (count === 0) return Array.isArray(node) ? '[]' : '{}';
  const n = Math.min(SUMMARY_ITEMS, count);
  const parts: string[] = [];
  if (Array.isArray(node)) {
    for (let i = 0; i < n; i++) parts.push(inlinePreview(node[i]));
  } else {
    const keys = Object.keys(node);
    for (let i = 0; i < n; i++) {
      const key = keys[i] as string;
      parts.push(JSON.stringify(key) + ': ' + inlinePreview(node[key]));
    }
  }
  let out = parts.join(', ');
  if (count > n) out += ', …';
  return truncateText(out, SUMMARY_CHARS);
}

/** 行预览：标量 JSON 原文 / 空容器字面量 / 展开容器省略号 / 折叠容器摘要。 */
export function previewOf(node: unknown, open: boolean): string {
  if (!isContainer(node)) return scalarPreview(node);
  const count = childCountOf(node);
  if (count === 0) return Array.isArray(node) ? '[]' : '{}';
  if (open) return Array.isArray(node) ? '[…]' : '{…}';
  return summarizeContainer(node);
}

/** 命中预览：标量截断到 HIT_PREVIEW_CHARS；容器只给省略号形态。 */
export function shortPreview(node: unknown): string {
  if (!isContainer(node)) return truncateText(scalarPreview(node), HIT_PREVIEW_CHARS);
  const count = childCountOf(node);
  if (Array.isArray(node)) return count > 0 ? '[…]' : '[]';
  return count > 0 ? '{…}' : '{}';
}

/* ------------------------------------------------------------------------- */
/* Fenwick：子项可见行数前缀和                                                */
/* ------------------------------------------------------------------------- */

class Fenwick {
  readonly size: number;
  private readonly tree: Int32Array;

  constructor(sizes: readonly number[]) {
    this.size = sizes.length;
    this.tree = new Int32Array(this.size + 1);
    for (let i = 0; i < this.size; i++) this.add(i, sizes[i] as number);
  }

  total(): number {
    let sum = 0;
    for (let i = this.size; i > 0; i -= i & -i) sum += this.tree[i] as number;
    return sum;
  }

  /** [0, count) 的前缀和 */
  prefix(count: number): number {
    let sum = 0;
    for (let i = Math.min(Math.max(count, 0), this.size); i > 0; i -= i & -i) sum += this.tree[i] as number;
    return sum;
  }

  add(index: number, delta: number): void {
    if (delta === 0) return;
    for (let i = index + 1; i <= this.size; i += i & -i) this.tree[i] = (this.tree[i] as number) + delta;
  }

  /** 最大的 slot，使 prefix(slot) <= target < prefix(slot + 1)；要求 0 <= target < total() */
  lowerBound(target: number): number {
    let pos = 0;
    let rest = target;
    let step = 1;
    while (step * 2 <= this.size) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.size && (this.tree[next] as number) <= rest) {
        pos = next;
        rest -= this.tree[next] as number;
      }
    }
    return pos;
  }
}

/* ------------------------------------------------------------------------- */
/* 全展开计数（自适应展开 / expand-all 的 dry-run）                           */
/* ------------------------------------------------------------------------- */

interface WalkFrame {
  container: Container;
  /** 对象容器的键序（数组为 null）；键序即行序 */
  keys: string[] | null;
  slot: number;
  count: number;
}

interface BuildFrame extends WalkFrame {
  /** 子项可见行数（按 slot 顺序收集，结束时交给 Fenwick） */
  sizes: number[];
  /** 已收集子项的可见行数之和 */
  sum: number;
}

function frameOf(container: Container): WalkFrame {
  if (Array.isArray(container)) return { container, keys: null, slot: 0, count: container.length };
  const keys = Object.keys(container);
  return { container, keys, slot: 0, count: keys.length };
}

function childAtSlot(frame: WalkFrame): unknown {
  return frame.keys
    ? (frame.container as Record<string, unknown>)[frame.keys[frame.slot] as string]
    : (frame.container as unknown[])[frame.slot];
}

/**
 * 「全展开后的可见行数」= 值图节点数（全展开时每个节点恰好一行）。
 * 超过 limit 立即返回 limit + 1：早停保证大文档（50MB / 2.96M 节点）也只走 ≤ limit+1 个节点。
 */
export function countAllExpandedRows(value: unknown, limit: number): number {
  let count = 1;
  if (count > limit) return limit + 1;
  if (!isContainer(value)) return count;
  const stack: WalkFrame[] = [frameOf(value)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as WalkFrame;
    if (frame.slot >= frame.count) {
      stack.pop();
      continue;
    }
    const child = childAtSlot(frame);
    frame.slot += 1;
    count += 1;
    if (count > limit) return limit + 1;
    if (isContainer(child)) stack.push(frameOf(child));
  }
  return count;
}

/* ------------------------------------------------------------------------- */
/* RowModel                                                                  */
/* ------------------------------------------------------------------------- */

export interface RowModelOptions {
  /** 可见行预算（默认 ROW_BUDGET = 1,000,000）；测试可注入小值 */
  rowBudget?: number;
  /**
   * 子键显示顺序（#40 / ADR-0024）；缺省 `'raw'` = 与引入该选项前**逐行一致**。
   * 只改对象成员的显示 slot 序，值图 / 路径 / 复制 / 导出 / 编辑 / 搜索全部不变。
   */
  order?: SortOrder;
}

export interface ToggleResult {
  /** 该行在变更后的行号；-1 表示不可见 */
  row: number;
  changed: boolean;
  totalRows: number;
}

export interface ExpandResult {
  row: number;
  changed: boolean;
  totalRows: number;
}

export interface ReplaceResult {
  row: number;
  changed: boolean;
  totalRows: number;
}

interface ChainEntry {
  container: Container;
  slot: number;
  node: unknown;
  path: Path;
}

export class RowModel {
  /**
   * 展开集合（根容器始终在此集合内）：**实现细节，不外露**。
   * 外部只通过 `isOpenAt(path)` / `openPaths()` 以 path 口径问展开态（ADR-0002 修订 2026-11-09）。
   */
  private readonly expanded = new Set<Container>();

  private readonly indexes = new Map<Container, Fenwick>();
  private keysCache = new WeakMap<Container, string[]>();
  private readonly rowBudget: number;
  /** 对象成员的显示顺序（#40 / ADR-0024）：`keysOf` 是它唯一的出口。 */
  private order: SortOrder;
  private rootValue: unknown;

  constructor(rootValue: unknown, options: RowModelOptions = {}) {
    this.rootValue = rootValue;
    this.rowBudget = options.rowBudget ?? ROW_BUDGET;
    this.order = normalizeSortOrder(options.order);
    if (isContainer(rootValue)) this.mountRoot(rootValue);
  }

  get value(): unknown {
    return this.rootValue;
  }

  /** 当前显示顺序（缺省 `'raw'`）。 */
  get sortOrder(): SortOrder {
    return this.order;
  }

  /**
   * 切换子键显示顺序（#40 / ADR-0024 §6）：返回是否真的换了挡（同挡 → false，不动任何缓存/索引）。
   *
   * 实现要点：**子树可见行数（Fenwick 总和）与顺序无关**，所以只需重置键缓存，
   * 再对 `expanded` 集合里每个对象容器独立 `measureChildren` 重建 Fenwick——不需要自底向上遍历值图。
   * 数组恒索引序，其 Fenwick 不受影响。
   */
  setOrder(order: SortOrder): boolean {
    const next = normalizeSortOrder(order);
    if (next === this.order) return false;
    this.order = next;
    this.keysCache = new WeakMap();
    for (const container of this.expanded) {
      if (Array.isArray(container)) continue;
      const { sizes } = this.measureChildren(container);
      this.indexes.set(container, new Fenwick(sizes));
    }
    return true;
  }

  /** 根可见行 + 根下所有可见子树行。 */
  get totalRows(): number {
    if (!isContainer(this.rootValue)) return 1;
    const rootIndex = this.indexes.get(this.rootValue);
    return 1 + (rootIndex ? rootIndex.total() : 0);
  }

  get budget(): number {
    return this.rowBudget;
  }

  /**
   * path 处的容器是否处于展开态（ADR-0002 修订 2026-11-09：展开态只以 path 口径回答）。
   * 根恒 open；标量 / 折叠容器 → false；路径非法 → BAD_COMMAND（与 `valueAt` / `rowOfPath` 同口径）。
   */
  isOpenAt(path: Path): boolean {
    const chain = this.locateChain(path);
    if (chain.length === 0) return true;
    const node = (chain[chain.length - 1] as ChainEntry).node;
    return isContainer(node) && this.expanded.has(node);
  }

  /**
   * 全部处于展开态的容器路径（确定性前序）。
   *
   * 与「可见行里 open 的路径」不同：**折叠祖先下的惰性展开标记也算 open**（这正是 expanded
   * 集合的真相，S5 持久化需要它）。成本 O(值图节点数)——大文档不要每帧调用，仅供测试 /
   * 持久化等低频路径。
   */
  openPaths(): Path[] {
    const out: Path[] = [];
    if (!isContainer(this.rootValue)) return out;
    const stack: Array<{ node: Container; path: Path }> = [{ node: this.rootValue, path: ROOT_PATH }];
    while (stack.length > 0) {
      const { node, path } = stack.pop() as { node: Container; path: Path };
      if (this.expanded.has(node)) out.push(path);
      // 逆序入栈 → pop 出正序（确定性前序遍历）
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          const child: unknown = node[i];
          if (isContainer(child)) stack.push({ node: child, path: appendIndex(path, i) });
        }
      } else {
        const keys = this.keysOf(node);
        for (let i = keys.length - 1; i >= 0; i--) {
          const key = keys[i] as string;
          const child: unknown = node[key];
          if (isContainer(child)) stack.push({ node: child, path: appendKey(path, key) });
        }
      }
    }
    return out;
  }

  /** 行窗口；越界/负数裁剪，不抛错。 */
  window(start: number, count: number): Row[] {
    const rows: Row[] = [];
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) return rows;
    const total = this.totalRows;
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(total, from + Math.floor(count));
    for (let i = from; i < to; i++) {
      const row = this.rowAt(i);
      if (!row) break;
      rows.push(row);
    }
    return rows;
  }

  /** 路径处的值；路径不存在抛 BAD_COMMAND（根路径返回根值）。 */
  valueAt(path: Path): unknown {
    const chain = this.locateChain(path);
    return chain.length === 0 ? this.rootValue : (chain[chain.length - 1] as ChainEntry).node;
  }

  /** 路径的可见行号；不在视图中（祖先折叠）或不存在 → -1。 */
  rowOfPath(path: Path): number {
    const chain = this.locateChain(path);
    let row = 0;
    for (let j = 0; j < chain.length; j++) {
      const parent: unknown = j === 0 ? this.rootValue : (chain[j - 1] as ChainEntry).node;
      if (!isContainer(parent)) return -1;
      const index = this.indexes.get(parent);
      if (!index) return -1; // 祖先折叠：不可见
      row += 1 + index.prefix((chain[j] as ChainEntry).slot);
    }
    return row;
  }

  /** 展开/折叠一个容器。直接改该容器 Fenwick 并沿祖先链点更新。 */
  toggle(path: Path, open: boolean): ToggleResult {
    const chain = this.locateChain(path);
    if (chain.length === 0) {
      // 根永远 open，折叠根是 no-op
      return { row: 0, changed: false, totalRows: this.totalRows };
    }
    const target = chain[chain.length - 1] as ChainEntry;
    const node = target.node;
    if (!isContainer(node)) {
      throw new CoreError({ code: 'BAD_COMMAND', message: `toggle: not a container at ${path}` });
    }
    if (this.expanded.has(node) === open) {
      return { row: this.rowOfPath(path), changed: false, totalRows: this.totalRows };
    }

    if (open) {
      const { sizes, total } = this.measureChildren(node);
      const next = this.totalRows + total;
      if (next > this.rowBudget) throw this.tooManyRows(next);
      this.expanded.add(node);
      this.indexes.set(node, new Fenwick(sizes));
      this.propagate(chain, chain.length - 1, total);
    } else {
      const index = this.indexes.get(node);
      const delta = index ? -index.total() : 0;
      this.indexes.delete(node);
      this.expanded.delete(node);
      this.propagate(chain, chain.length - 1, delta);
    }
    return { row: this.rowOfPath(path), changed: true, totalRows: this.totalRows };
  }

  /**
   * 子树批量展开 / 收起（#22 / ADR-0002 修订 2026-11-09）：作用域**只有**该容器子树。
   *
   * - open=true：本容器（若折叠）+ 子树内所有**非空**容器进 `expanded` 并建 Fenwick（与
   *   `expandAll`/`rebuildAllOpen` 同口径，空容器不参与、手动开着的空容器复位）。子树外的展开态与
   *   索引原样保留；祖先链只做**一次** delta 传播，不重建整模型、不逐节点 toggle。
   * - open=false = 深度复位：子树内所有容器移出 `expanded`、释放索引，本节点折叠；
   *   下次展开只剩一层（不恢复上次展开现场）。
   * - 原子 + 预算：先 dry-run 数「子树全展开行数」，`totalRows + delta > rowBudget` 抛
   *   `TOO_MANY_ROWS` 且**零部分修改**；dry-run 受 rowBudget 早停封顶。
   * - changed 语义（可见结果口径，沿用 toggle/expandAll 纪律）：行数变了，或子树内有可见的空容器
   *   open 标记被复位，才算 changed；已全展开 / 已全收起 / 根 / 空容器 / 不可见节点 → changed=false
   *   （状态仍写入，只是无需推 rowVersion）。
   */
  toggleSubtree(path: Path, open: boolean): ToggleResult {
    const chain = this.locateChain(path);
    if (chain.length === 0) {
      // 根永远 open；根子树操作与工具栏「全部展开/收起」重复 → no-op（与 toggle('$') 同款）
      return { row: 0, changed: false, totalRows: this.totalRows };
    }
    const target = chain[chain.length - 1] as ChainEntry;
    const node = target.node;
    if (!isContainer(node)) {
      throw new CoreError({ code: 'BAD_COMMAND', message: `toggleSubtree: not a container at ${path}` });
    }
    if (this.childCount(node) === 0) {
      // 空容器：没有可展开内容，两个方向都按 no-op 处理（不制造行映射/版本抖动）
      return { row: this.rowOfPath(path), changed: false, totalRows: this.totalRows };
    }
    const visible = this.rowOfPath(path) >= 0;

    if (open) {
      const currentSize = this.sizeOf(node);
      // dry-run：目标「子树全展开」行数；limit = rowBudget 时返回值 > rowBudget 即「已超预算」
      const subtreeRows = countAllExpandedRows(node, this.rowBudget);
      const delta = subtreeRows - currentSize;
      const next = this.totalRows + delta;
      if (subtreeRows > this.rowBudget || next > this.rowBudget) throw this.tooManyRows(next);
      // 预算内才写入：单趟迭代后序重建子树索引（不做逐节点 toggle）
      const emptyReset = this.rebuildSubtreeOpen(node);
      this.propagate(chain, chain.length - 1, delta);
      return {
        row: this.rowOfPath(path),
        changed: visible && (delta !== 0 || emptyReset),
        totalRows: this.totalRows,
      };
    }

    // 深度复位：本节点 + 后代容器的展开态/索引/键缓存全部释放（本节点折叠）
    const index = this.indexes.get(node);
    const delta = index ? -index.total() : 0;
    this.releaseSubtree(node);
    this.propagate(chain, chain.length - 1, delta);
    // 不可见节点 / 本节点本就折叠（只清了惰性标记）→ 可见结果没变
    return { row: this.rowOfPath(path), changed: visible && delta !== 0, totalRows: this.totalRows };
  }

  /** 展开 path 上所有祖先容器（不含自身）；预算不足则回滚并抛 TOO_MANY_ROWS。 */
  expandPath(path: Path): ExpandResult {
    const chain = this.locateChain(path);
    const before = this.totalRows;
    const opened: { index: number; delta: number }[] = [];
    try {
      // 由深到浅打开：子节点先有索引，父节点建索引时读到的是最终尺寸
      for (let j = chain.length - 2; j >= 0; j--) {
        const node = (chain[j] as ChainEntry).node;
        if (!isContainer(node) || this.expanded.has(node)) continue;
        const { sizes, total } = this.measureChildren(node);
        const next = this.totalRows + total;
        if (next > this.rowBudget) throw this.tooManyRows(next);
        this.expanded.add(node);
        this.indexes.set(node, new Fenwick(sizes));
        this.propagate(chain, j, total);
        opened.push({ index: j, delta: total });
      }
    } catch (err) {
      for (let i = opened.length - 1; i >= 0; i--) {
        const { index: j, delta } = opened[i] as { index: number; delta: number };
        const node = (chain[j] as ChainEntry).node as Container;
        this.indexes.delete(node);
        this.expanded.delete(node);
        this.propagate(chain, j, -delta);
      }
      throw err;
    }
    return { row: this.rowOfPath(path), changed: this.totalRows !== before, totalRows: this.totalRows };
  }

  /**
   * 全部展开（#9 / ADR-0002 修订）：先 dry-run 计数，count > limit 抛 TOO_MANY_ROWS 且**零部分修改**；
   * 预算内一次性重建全 open 行模型（所有非空容器进 expanded 并建 Fenwick），不逐节点 toggle。
   * changed=false 表示本来就已全展开（视觉等价，不重建）。
   */
  expandAll(limit: number = this.rowBudget): { changed: boolean; totalRows: number } {
    // 显式 limit 只能收紧、不能绕过 rowBudget（行预算不变量）
    const effective = Math.min(limit, this.rowBudget);
    const count = countAllExpandedRows(this.rootValue, effective);
    if (count > effective) throw this.tooManyRows(count);
    if (!isContainer(this.rootValue)) return { changed: false, totalRows: this.totalRows };
    if (this.totalRows === count) return { changed: false, totalRows: count };
    this.rebuildAllOpen();
    return { changed: true, totalRows: count };
  }

  /**
   * 自适应展开（ADR-0002 修订 / Q3）：全展开行数 ≤ threshold 才展开，**不抛错**（load 不因自适应失败）。
   * 返回是否已处于全展开状态（标量根 / 超阈值返回 false）。
   */
  expandIfAtMost(threshold: number): boolean {
    const limit = Math.min(threshold, this.rowBudget);
    if (!isContainer(this.rootValue) || !Number.isFinite(limit) || limit < 1) return false;
    const count = countAllExpandedRows(this.rootValue, limit);
    if (count > limit) return false;
    if (this.totalRows === count) return true;
    this.rebuildAllOpen();
    return true;
  }

  /**
   * 全部收起（#9）：折叠除根外所有容器（根永远 open），复用 clear() 释放全部索引。
   * changed = 除根外是否有 open 容器；no-op 时不重建，避免制造行窗口抖动。
   */
  collapseAll(): { changed: boolean; totalRows: number } {
    let changed = false;
    for (const container of this.expanded) {
      if (container !== this.rootValue) {
        changed = true;
        break;
      }
    }
    if (!changed) return { changed: false, totalRows: this.totalRows };
    this.clear();
    return { changed: true, totalRows: this.totalRows };
  }

  /**
   * 子树整体替换（编辑语义，见 ADR-0006：S1 = 保留被替换节点自身展开态、子节点折叠）。
   * 骨架 slice 未接 DocService，但行模型语义先落地，供编辑实现复用。
   */
  replaceNode(path: Path, value: unknown): ReplaceResult {
    if (path === ROOT_PATH) {
      this.releaseSubtree(this.rootValue);
      this.expanded.clear();
      this.indexes.clear();
      this.keysCache = new WeakMap();
      this.rootValue = value;
      if (isContainer(value)) {
        const { sizes, total } = this.measureChildren(value);
        const next = 1 + total;
        if (next > this.rowBudget) throw this.tooManyRows(next);
        this.expanded.add(value);
        this.indexes.set(value, new Fenwick(sizes));
      }
      return { row: 0, changed: true, totalRows: this.totalRows };
    }

    const chain = this.locateChain(path);
    const target = chain[chain.length - 1] as ChainEntry;
    if (value === target.node) {
      // 同一个值图对象：没有结构变化，别让 release/rebuild 打乱展开态
      return { row: this.rowOfPath(path), changed: false, totalRows: this.totalRows };
    }
    const oldSize = this.sizeOf(target.node);
    const wasOpen = isContainer(target.node) && this.expanded.has(target.node);

    // 先算新尺寸（不修改模型），预算不够直接抛
    let newSize = 1;
    let newSizes: number[] | null = null;
    if (isContainer(value)) {
      const measured = this.measureChildren(value);
      newSizes = measured.sizes;
      if (wasOpen) newSize = 1 + measured.total;
    }
    const delta = newSize - oldSize;
    if (delta > 0) {
      const next = this.totalRows + delta;
      if (next > this.rowBudget) throw this.tooManyRows(next);
    }

    // 释放旧子树的状态，再写回值图
    this.releaseSubtree(target.node);
    if (Array.isArray(target.container)) {
      target.container[target.slot] = value;
    } else {
      const keys = this.keysOf(target.container);
      target.container[keys[target.slot] as string] = value;
    }

    // S1：被替换节点自身保留展开态，子节点默认折叠（新值来自 JSON.parse，天然无展开条目）
    if (wasOpen && isContainer(value) && newSizes) {
      this.expanded.add(value);
      this.indexes.set(value, new Fenwick(newSizes));
    }
    this.propagate(chain, chain.length - 1, delta);
    return { row: this.rowOfPath(path), changed: true, totalRows: this.totalRows };
  }

  /** 释放所有展开索引（根容器重新 open，保持与 load 后一致）。 */
  clear(): void {
    this.releaseSubtree(this.rootValue);
    this.expanded.clear();
    this.indexes.clear();
    this.keysCache = new WeakMap();
    if (isContainer(this.rootValue)) this.mountRoot(this.rootValue);
  }

  /* ------------------------------ internals ------------------------------ */

  private mountRoot(root: Container): void {
    // 计数与显示顺序无关：这里只数 Object.keys，**不在导入首帧为排序付成本**（ADR-0024 §7）；
    // 键序缓存留给首次真正需要 slot 序的窗口 / 展开（懒排序）。
    const count = childCountOf(root);
    if (1 + count > this.rowBudget) throw this.tooManyRows(1 + count);
    const sizes = new Array<number>(count).fill(1);
    this.expanded.add(root);
    this.indexes.set(root, new Fenwick(sizes));
  }

  /**
   * 一次性重建「全 open」行模型（expandAll 的实现；调用方已做预算检查）。
   * 迭代后序：先收集容器帧，子容器完成后把「子树行数」回填给父容器作可见尺寸；
   * 不使用递归（深 JSON 不爆栈）。expanded 只能 clear/add，不能重新赋值。
   */
  private rebuildAllOpen(): void {
    const root = this.rootValue as Container;
    for (const container of this.indexes.keys()) this.indexes.delete(container);
    this.expanded.clear();
    this.expanded.add(root);
    const rootCount = Array.isArray(root) ? root.length : Object.keys(root).length;
    if (rootCount === 0) {
      this.indexes.set(root, new Fenwick([]));
      return;
    }
    const stack: BuildFrame[] = [this.buildFrameOf(root)];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as BuildFrame;
      if (frame.slot < frame.count) {
        const child = childAtSlot(frame);
        frame.slot += 1;
        if (isContainer(child)) {
          const childCount = Array.isArray(child) ? child.length : Object.keys(child).length;
          if (childCount > 0) {
            this.expanded.add(child);
            stack.push(this.buildFrameOf(child));
            continue; // 父容器的该槽位在子帧结束时回填
          }
          // 空容器：1 行，且不进 expanded（没有可展开的内容，open=false 才符合语义）
        }
        // 标量或空容器：恰好 1 行
        frame.sizes.push(1);
        frame.sum += 1;
        continue;
      }
      this.indexes.set(frame.container, new Fenwick(frame.sizes));
      const subtreeRows = 1 + frame.sum;
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.sizes.push(subtreeRows);
        parent.sum += subtreeRows;
      }
    }
  }

  /**
   * 只重建**子树内**的索引并置全展开（toggleSubtree(open=true) 的写入段；调用方已做预算检查）。
   * 语义与 rebuildAllOpen 对齐：非空容器进 expanded 并按「子项可见行数」建 Fenwick；空容器不进
   * expanded（曾被手动 toggle 开的空容器在这里复位，返回 true 让调用方判断 changed）。
   * 单趟迭代后序：不用递归（深 JSON 不爆栈）；子树外的索引/展开态一概不碰。
   */
  private rebuildSubtreeOpen(subtree: Container): boolean {
    let emptyReset = false;
    const stack: BuildFrame[] = [this.buildFrameOf(subtree)];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as BuildFrame;
      if (frame.slot < frame.count) {
        const child = childAtSlot(frame);
        frame.slot += 1;
        if (isContainer(child)) {
          const childCount = Array.isArray(child) ? child.length : Object.keys(child).length;
          if (childCount > 0) {
            this.expanded.add(child);
            stack.push(this.buildFrameOf(child));
            continue; // 父容器的该槽位在子帧结束时回填
          }
          // 空容器：1 行，且不进 expanded（没有可展开的内容，open=false 才符合语义）
          if (this.expanded.delete(child)) emptyReset = true;
        }
        frame.sizes.push(1);
        frame.sum += 1;
        continue;
      }
      this.expanded.add(frame.container);
      this.indexes.set(frame.container, new Fenwick(frame.sizes));
      const subtreeRows = 1 + frame.sum;
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.sizes.push(subtreeRows);
        parent.sum += subtreeRows;
      }
    }
    return emptyReset;
  }

  private tooManyRows(totalRows: number): CoreError {
    return new CoreError({
      code: 'TOO_MANY_ROWS',
      message: `visible rows would exceed the budget (${totalRows} > ${this.rowBudget})`,
      totalRows,
    });
  }

  /**
   * 对象容器的**显示键序**（slot 序的唯一来源，ADR-0024 §1）：首次需要时才排序并缓存（懒排序）。
   * 数组没有键序概念，返回空数组（调用方用下标）。
   */
  private keysOf(container: Container): string[] {
    if (Array.isArray(container)) return [];
    let keys = this.keysCache.get(container);
    if (!keys) {
      keys = orderedKeys(container, this.order);
      this.keysCache.set(container, keys);
    }
    return keys;
  }

  private childCount(container: Container): number {
    // 计数与顺序无关，但复用键序缓存：raw 档这里就是 Object.keys（零排序成本），
    // 非 raw 档容器首次被需要时排一次并缓存（懒排序），此后所有窗口/展开共用。
    return Array.isArray(container) ? container.length : this.keysOf(container).length;
  }

  /** 迭代后序重建用的帧：对象容器的 `keys` 必须是**显示序**（Fenwick 的 slot 与 descend 同源）。 */
  private buildFrameOf(container: Container): BuildFrame {
    if (Array.isArray(container)) {
      return { container, keys: null, slot: 0, count: container.length, sizes: [], sum: 0 };
    }
    const keys = this.keysOf(container);
    return { container, keys, slot: 0, count: keys.length, sizes: [], sum: 0 };
  }

  private childAt(container: Container, slot: number): unknown {
    if (Array.isArray(container)) return container[slot];
    const keys = this.keysOf(container);
    return container[keys[slot] as string];
  }

  private pathOfSlot(container: Container, slot: number, base: Path): Path {
    return Array.isArray(container) ? appendIndex(base, slot) : appendKey(base, this.keysOf(container)[slot] as string);
  }

  private keyOfSlot(container: Container, slot: number): { key: string; idx: boolean } {
    if (Array.isArray(container)) return { key: '[' + slot + ']', idx: true };
    return { key: this.keysOf(container)[slot] as string, idx: false };
  }

  /** 子节点的可见行数：标量 1；容器 1 + （open 时其 Fenwick 总和）。 */
  private sizeOf(node: unknown): number {
    if (!isContainer(node)) return 1;
    const index = this.indexes.get(node);
    return index ? 1 + index.total() : 1;
  }

  private measureChildren(container: Container): { sizes: number[]; total: number } {
    const count = this.childCount(container);
    const sizes = new Array<number>(count);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const size = this.sizeOf(this.childAt(container, i));
      sizes[i] = size;
      total += size;
    }
    return { sizes, total };
  }

  /** 沿祖先链把 delta 加到每个 open 祖先的 Fenwick 上；遇折叠祖先即停。 */
  private propagate(chain: ChainEntry[], from: number, delta: number): void {
    if (delta === 0) return;
    for (let j = from; j >= 0; j--) {
      const parent: unknown = j === 0 ? this.rootValue : (chain[j - 1] as ChainEntry).node;
      if (!isContainer(parent)) return;
      const index = this.indexes.get(parent);
      if (!index) return;
      index.add((chain[j] as ChainEntry).slot, delta);
    }
  }

  private rowAt(index: number): Row | null {
    if (index === 0) return this.describeRow(this.rootValue, ROOT_PATH, 0, 'root', false);
    if (index < 0) return null;
    if (!isContainer(this.rootValue)) return null;
    const rootIndex = this.indexes.get(this.rootValue);
    if (!rootIndex) return null;
    return this.descend(this.rootValue, ROOT_PATH, 0, index - 1);
  }

  /** offset 是 container 子项区域内的 0-based 行偏移。 */
  private descend(container: Container, containerPath: Path, containerDepth: number, offset: number): Row | null {
    const index = this.indexes.get(container);
    if (!index || index.size === 0 || offset < 0 || offset >= index.total()) return null;
    const slot = index.lowerBound(offset);
    const local = offset - index.prefix(slot);
    const node = this.childAt(container, slot);
    const path = this.pathOfSlot(container, slot, containerPath);
    const { key, idx } = this.keyOfSlot(container, slot);
    const row = this.describeRow(node, path, containerDepth + 1, key, idx);
    if (local === 0) return row;
    if (!isContainer(node)) return null;
    return this.descend(node, path, containerDepth + 1, local - 1);
  }

  private describeRow(node: unknown, path: Path, depth: number, key: string, idx: boolean): Row {
    const container = isContainer(node);
    const open = container && this.expanded.has(node);
    const count = container ? this.childCount(node) : 0;
    return {
      path,
      depth,
      key,
      idx,
      kind: jsonKind(node),
      preview: previewOf(node, open),
      count,
      open,
      hasChildren: count > 0,
    };
  }

  /** 解析路径为「从根的子项到目标」的链；任何一段缺失都抛 BAD_COMMAND。 */
  private locateChain(path: Path): ChainEntry[] {
    const segments = parsePath(path);
    const chain: ChainEntry[] = [];
    let container: unknown = this.rootValue;
    let currentPath: Path = ROOT_PATH;
    for (const segment of segments) {
      if (!isContainer(container)) throw this.badPath(path);
      let slot: number;
      if (Array.isArray(container)) {
        if (segment.kind === 'index') {
          slot = segment.index;
        } else {
          slot = Number(segment.key);
          if (!Number.isInteger(slot) || segment.key.trim() === '') throw this.badPath(path);
        }
        if (!Number.isInteger(slot) || slot < 0 || slot >= container.length) throw this.badPath(path);
      } else {
        const key = segment.kind === 'key' ? segment.key : String(segment.index);
        slot = this.keysOf(container).indexOf(key);
        if (slot < 0) throw this.badPath(path);
      }
      const node = this.childAt(container, slot);
      currentPath = this.pathOfSlot(container, slot, currentPath);
      chain.push({ container, slot, node, path: currentPath });
      container = node;
    }
    return chain;
  }

  /** 释放子树内所有展开状态与键缓存（编辑替换前调用）。 */
  private releaseSubtree(node: unknown): void {
    if (!isContainer(node)) return;
    const stack: Container[] = [node];
    while (stack.length > 0) {
      const current = stack.pop() as Container;
      this.indexes.delete(current);
      this.expanded.delete(current);
      this.keysCache.delete(current);
      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i++) {
          const child = current[i];
          if (isContainer(child)) stack.push(child);
        }
      } else {
        const keys = Object.keys(current);
        for (const key of keys) {
          const child = current[key];
          if (isContainer(child)) stack.push(child);
        }
      }
    }
  }

  private badPath(path: Path): CoreError {
    return new CoreError({ code: 'BAD_COMMAND', message: `path not found: ${path}` });
  }
}
