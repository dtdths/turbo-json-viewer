/**
 * core/order — 对象成员的**显示顺序**规则（#40 / ADR-0024 §3/§6）。
 *
 * 语义：显示顺序是**根级视图状态**（与展开集合同类），只改 RowModel 的 slot 序；
 * 值图键序、路径、节点身份、复制 / 导出 / 编辑 / 搜索 / 保真全部不变（ADR-0024 §1）。
 * 只有对象成员参与排序；数组恒索引序（ADR-0024 §2）。
 *
 * 比较器是**自研确定性自然序**（不用 `Intl.Collator` / `localeCompare`，避免 ICU 版本漂移）：
 *   1. 键切成「数字段 / 非数字段」交替的段序列；
 *   2. 数字段按**数值**比较（前导零被数值吸收；超长数字段用「长度 + 字典序」比较，不过 Number）；
 *   3. 非数字段按**折小写后**的码元序比较（忽略大小写）；
 *   4. 同一位置数字段排在非数字段前（固定规则，保证可比）；
 *   5. 前缀更短者在前；
 *   6. 全部平局用**原码元序**兜底。
 *
 * 平局兜底保证不同键永不为 0 ⇒ 严格全序（传递、反对称），排序结果与平台/调用顺序无关。
 * 中文 / 非 ASCII 键按码元序（不做拼音、不做 locale 排序，ADR-0024「已知差距」）。
 */
import type { SortOrder } from '../protocol/types';

export type { SortOrder };

/** 三档规则（协议值）。 */
const ORDERS: readonly SortOrder[] = ['raw', 'key-asc', 'key-desc'];

/** 把任意输入归一化为合法档位：只接受三档协议值，其余一律回落 `'raw'`（白名单）。 */
export function normalizeSortOrder(order: unknown): SortOrder {
  return ORDERS.includes(order as SortOrder) ? (order as SortOrder) : 'raw';
}

interface KeySegment {
  /** true = 纯 ASCII 数字段（按数值比较） */
  numeric: boolean;
  text: string;
}

const ZERO = 0x30;
const NINE = 0x39;

function isAsciiDigit(code: number): boolean {
  return code >= ZERO && code <= NINE;
}

/** 把键切成数字段 / 非数字段交替的序列（保持原始大小写与前导零）。 */
function segmentsOf(key: string): KeySegment[] {
  const segments: KeySegment[] = [];
  let start = 0;
  while (start < key.length) {
    const numeric = isAsciiDigit(key.charCodeAt(start));
    let end = start + 1;
    while (end < key.length && isAsciiDigit(key.charCodeAt(end)) === numeric) end += 1;
    segments.push({ numeric, text: key.slice(start, end) });
    start = end;
  }
  return segments;
}

/** 数字段的规范文本（去前导零 → 数值相等的段 canonical 相等，长度比较即可定位数值大小）。 */
function canonicalDigits(digits: string): string {
  let i = 0;
  while (i < digits.length - 1 && digits.charCodeAt(i) === ZERO) i += 1;
  return digits.slice(i);
}

/** 比较两个数字段：先按位数（= 数值大小），位数相同再按字典序。 */
function compareDigitSegments(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 非数字段：折小写后按 UTF-16 码元序比较（忽略大小写）。 */
function compareTextSegments(a: string, b: string): number {
  const loweredA = a.toLowerCase();
  const loweredB = b.toLowerCase();
  return loweredA < loweredB ? -1 : loweredA > loweredB ? 1 : 0;
}

function compareSegments(a: KeySegment, b: KeySegment): number {
  // 同一位置：数字段在前（固定规则；让 '1' < 'a' 之类有确定答案）
  if (a.numeric !== b.numeric) return a.numeric ? -1 : 1;
  if (a.numeric) return compareDigitSegments(canonicalDigits(a.text), canonicalDigits(b.text));
  return compareTextSegments(a.text, b.text);
}

/**
 * 确定性自然序比较器（升序）：负数 = a 在 b 前，正数 = a 在 b 后，0 = 同一个键。
 * 严格全序：不同键永不返回 0（最后有原码元序兜底）。
 */
export function compareNaturalKeys(a: string, b: string): number {
  if (a === b) return 0;
  const segmentsA = segmentsOf(a);
  const segmentsB = segmentsOf(b);
  const shared = Math.min(segmentsA.length, segmentsB.length);
  for (let i = 0; i < shared; i++) {
    const order = compareSegments(segmentsA[i] as KeySegment, segmentsB[i] as KeySegment);
    if (order !== 0) return order;
  }
  // 前缀更短者在前
  if (segmentsA.length !== segmentsB.length) return segmentsA.length < segmentsB.length ? -1 : 1;
  // 全平局（如大小写 / 前导零差异）→ 原码元序兜底，保证全序
  return a < b ? -1 : 1;
}

/** 对象容器 → 显示键序（`raw` = `Object.keys` 顺序；asc / desc 用自然序）。 */
export function orderedKeys(container: Record<string, unknown>, order: SortOrder = 'raw'): string[] {
  const keys = Object.keys(container);
  const normalized = normalizeSortOrder(order);
  if (normalized === 'raw') return keys;
  if (normalized === 'key-asc') return keys.sort(compareNaturalKeys);
  return keys.sort((a, b) => compareNaturalKeys(b, a));
}
