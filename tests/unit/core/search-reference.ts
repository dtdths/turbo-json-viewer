/**
 * search-reference — 搜索语义的**独立参考实现**（仅测试资产，不进 bundle、不参与冒烟运行时）。
 *
 * 与 `core/search.ts` 刻意用不同结构，才能当 parity oracle（同一实现互证没有意义）：
 *   1) 先把值图按前序**展平**成 `(path, key, isIndex, isRoot, kind, node)` 数组；
 *   2) 再顺序匹配、**收集全部命中**，最后按 `limit` 切片并判定 `truncated`。
 * `core/search.ts` 则是单趟 DFS 栈、边走边判、命中到 `limit` 立即中断。
 *
 * 已对齐的边界口径（与 core 逐条一致，见 parity 测试）：
 *   - 空 query / 非法 limit（`!Number.isFinite || <= 0`）先于正则编译 → 直接空结果、不抛错；
 *   - 键名命中优先于值命中；数组下标（`isIndex`）与根（`isRoot`）不参与键名匹配；
 *   - 值命中 = 字符串内容 / 标量的**显示文本**（number → JSON.stringify，BigInt → 十进制串，
 *     boolean → 'true'/'false'，null → 'null'；ADR-0023 §1）；
 *   - 命中模型：一个 entry 最多一条命中，优先级 key > value > path（ADR-0023 §3）；
 *   - `keysOnly` 只搜键名（值/路径都不收）；
 *   - 路径命中（ADR-0023 §2）：仅查询含 `.` / `[` / `$` 时启用，字面量模式 `path` 以 query
 *     结尾（大小写按 `Aa`），正则模式对整条 path `test()`；普通词查询完全不碰路径；
 *   - `truncated = 命中总数 >= limit`（**恰好等于 limit 时也为 true**，core 现状口径）；
 *   - `total` 是截断后的命中数（`hits.length`），不是全量命中数。
 *
 * 显式不覆盖（ADR-0014 §2.4）：不复制灾难性回溯**静态筛查**——复制一份启发式 = 重复实现，
 * import `regexSafetyError` = 同函数自证。因此参考实现只对「语法错 / 超长」抛
 * `ReferencePatternError`；被筛查拒绝的模式（`(a+)+` 等）不在 parity 矩阵里，由
 * `tests/unit/core/search.test.ts` 的既有用例兜底。
 */
import type { JsonKind } from '../../../src/protocol/types';
import { SEARCH_LIMIT, SEARCH_PATTERN_MAX } from '../../../src/protocol/versions';
import { appendIndex, appendKey, ROOT_PATH } from '../../../src/shared/path';

export interface ReferenceEntry {
  path: string;
  key: string;
  isIndex: boolean;
  isRoot: boolean;
  kind: JsonKind;
  node: unknown;
}

export interface ReferenceHit {
  path: string;
  key: string;
  kind: JsonKind;
  field: 'key' | 'value' | 'path';
}

export interface ReferenceResult {
  hits: ReferenceHit[];
  total: number;
  truncated: boolean;
}

export interface ReferenceOpts {
  caseSensitive?: boolean;
  regex?: boolean;
  keysOnly?: boolean;
  limit?: number;
}

/** core 的 `BAD_PATTERN` 在参考实现里的对等物（只用于「两边都拒绝」的 parity 断言）。 */
export class ReferencePatternError extends Error {
  readonly code = 'BAD_PATTERN';

  constructor(message: string) {
    super(message);
    this.name = 'ReferencePatternError';
  }
}

function kindOf(node: unknown): JsonKind {
  if (node === null) return 'null';
  switch (typeof node) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'bigint':
      return 'number'; // 无损数字（ADR-0020）：BigInt 归 number 类
    case 'boolean':
      return 'boolean';
    case 'object':
      return Array.isArray(node) ? 'array' : 'object';
    default:
      return 'null';
  }
}

/**
 * 前序展平：根 → 对象按 `Object.keys` 顺序 / 数组按下标升序递归。
 * 路径格式化复用 `shared/path`（其往返/转义已有单测），参考实现不重写路径语义。
 */
export function flattenDocument(value: unknown): ReferenceEntry[] {
  const out: ReferenceEntry[] = [];
  const visit = (node: unknown, path: string, key: string, isIndex: boolean, isRoot: boolean): void => {
    out.push({ path, key, isIndex, isRoot, kind: kindOf(node), node });
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i], appendIndex(path, i), '[' + i + ']', true, false);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    for (const childKey of Object.keys(record)) {
      visit(record[childKey], appendKey(path, childKey), childKey, false, false);
    }
  };
  visit(value, ROOT_PATH, 'root', false, true);
  return out;
}

function compileMatcher(query: string, opts: ReferenceOpts): (text: string) => boolean {
  const caseSensitive = opts.caseSensitive ?? false;
  if (opts.regex === true) {
    if (query.length > SEARCH_PATTERN_MAX) {
      throw new ReferencePatternError(`正则过长（上限 ${SEARCH_PATTERN_MAX} 字符）`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ReferencePatternError(`正则语法错误：${reason}`);
    }
    // 不加 `g`：`RegExp.test` 因此无 lastIndex 状态，可在展平后的 entries 上反复调用。
    return (text: string): boolean => regex.test(text);
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return (text: string): boolean =>
    caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle);
}

/**
 * 值搜索文本（与 core 同口径、独立实现）：字符串原文 / 标量的树内显示文本。
 * 布尔/null 按 ADR-0023 §1 纳入：'true' / 'false' / 'null'。
 */
function referenceValueText(entry: ReferenceEntry): string | null {
  if (entry.kind === 'string') return entry.node as string;
  if (entry.kind === 'number') {
    return typeof entry.node === 'bigint' ? (entry.node as bigint).toString() : JSON.stringify(entry.node) ?? String(entry.node);
  }
  if (entry.kind === 'boolean') return entry.node === true ? 'true' : 'false';
  if (entry.kind === 'null') return 'null';
  return null;
}

export function referenceSearch(value: unknown, query: string, opts: ReferenceOpts = {}): ReferenceResult {
  const limit = opts.limit ?? SEARCH_LIMIT;
  const keysOnly = opts.keysOnly ?? false;

  if (query.length === 0) return { hits: [], total: 0, truncated: false };
  if (!Number.isFinite(limit) || limit <= 0) return { hits: [], total: 0, truncated: false };

  const matches = compileMatcher(query, opts);

  // 路径模式（ADR-0023 §2）：查询含 `.` / `[` / `$` 才构造路径匹配器；引用同一条命中判定链。
  const pathMode = query.includes('.') || query.includes('[') || query.includes('$');
  let matchesPath: ((path: string) => boolean) | null = null;
  if (pathMode && !keysOnly) {
    if (opts.regex === true) matchesPath = matches; // 整条路径 test()，用户可自行 `$` 锚定
    else {
      const caseSensitive = opts.caseSensitive ?? false;
      const needle = caseSensitive ? query : query.toLowerCase();
      matchesPath = (path: string): boolean =>
        (caseSensitive ? path : path.toLowerCase()).endsWith(needle);
    }
  }

  const all: ReferenceHit[] = [];
  for (const entry of flattenDocument(value)) {
    const keyIsName = !entry.isIndex && !entry.isRoot;
    let field: ReferenceHit['field'] | null = null;
    if (keyIsName && matches(entry.key)) field = 'key';
    else if (!keysOnly) {
      const valueText = referenceValueText(entry);
      if (valueText !== null && matches(valueText)) field = 'value';
      else if (matchesPath !== null && matchesPath(entry.path)) field = 'path';
    }
    if (field !== null) all.push({ path: entry.path, key: entry.key, kind: entry.kind, field });
  }

  // 与 core 同口径：命中数**达到** limit 即 truncated（恰好相等也算），total 为截断后数量。
  // core 的「达到」比较允许小数 limit（如 2.5 → 命中 3 条时截断）；切片按 ceil 对齐，
  // 避免 `slice(0, 2.5)` 被 ToInteger 截成 2 而与 core 的 3 条不一致。
  const truncated = all.length >= limit;
  const capped = Math.ceil(limit);
  const hits = truncated ? all.slice(0, capped) : all;
  return { hits, total: hits.length, truncated };
}
