/**
 * core/json-graph — 值图（JSON Graph）的只读能力：IR 原语、预览、路径 → 值。
 *
 * 归属（候选 4 / ADR-0002 修订 2026-11-19）：本模块只回答「这份值图里有什么」，
 * 一个字节的**显示序**（`sortOrder` / 单节点覆盖）和**行几何**（Fenwick / 窗口 / toggle）
 * 都不在这里——那是 `core/row-model`。分成两个文件是为了让 `search` / `outline` /
 * `profile` / `doc-service` 不必只为几个纯函数 import 1000 行的行模型。
 *
 * 路径语法唯一来源：`walkPath` / `valueAt` 是一条**顺序无关**的解析器（对象用自有属性直取，
 * 数组按下标规则），几何需要的显示 slot 由 `RowModel` 自己按 `keysOf` 换算，不回流到这里。
 *
 * 分层：只 import `protocol/*` 与 `shared/path`；**不 import `core/order`**（显示序不进值图）。
 */
import { CoreError } from '../protocol/errors';
import type { JsonKind, Path } from '../protocol/types';
import { parsePath } from '../shared/path';

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
/* 全展开计数（自适应展开 / expand-all 的 dry-run）                            */
/* ------------------------------------------------------------------------- */

interface Frame {
  container: Container;
  /** 对象容器的键序（数组为 null）；值图顺序，与显示序无关 */
  keys: string[] | null;
  slot: number;
  count: number;
}

function frameOf(container: Container): Frame {
  if (Array.isArray(container)) return { container, keys: null, slot: 0, count: container.length };
  const keys = Object.keys(container);
  return { container, keys, slot: 0, count: keys.length };
}

function childAtSlot(frame: Frame): unknown {
  return frame.keys
    ? (frame.container as Record<string, unknown>)[frame.keys[frame.slot] as string]
    : (frame.container as unknown[])[frame.slot];
}

/**
 * 「全展开后的可见行数」= 值图节点数（全展开时每个节点恰好一行）。
 * 超过 limit 立即返回 limit + 1：早停保证大文档（50MB / 2.96M 节点）也只走 ≤ limit+1 个节点。
 *
 * 注：名字沿用了行模型时代的叫法（全展开 = 每个节点一行）；实际数是**节点数**，改名不在本票。
 */
export function countAllExpandedRows(value: unknown, limit: number): number {
  let count = 1;
  if (count > limit) return limit + 1;
  if (!isContainer(value)) return count;
  const stack: Frame[] = [frameOf(value)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
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
/* 路径 → 值（顺序无关）                                                      */
/* ------------------------------------------------------------------------- */

/** 路径的一步：父容器、对象键（数组为下标的十进制串）、该步的节点。 */
export interface PathStep {
  parent: Container;
  key: string;
  node: unknown;
}

function pathNotFound(path: Path): CoreError {
  return new CoreError({ code: 'BAD_COMMAND', message: `path not found: ${path}` });
}

/** 对象是否**自有**该键：只看自有可枚举之外的中毒键（`__proto__` / `constructor`）也不放行继承属性。 */
function hasOwnKey(container: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(container, key);
}

/**
 * 把路径解析成「从根的子项到目标」的链；任何一段缺失都抛 `BAD_COMMAND`。
 *
 * **顺序无关**：对象只问自有属性，数组只按下标规则（`Number` 强制、负/非整数/越界一律拒绝），
 * 与 `sortOrder` / 单节点覆盖完全无关。`parsePath` 对畸形路径串（不以 `$` 开头、`['…` 未闭合）
 * 仍抛普通 `Error`——与历史口径一致，由 Worker 边界折算成 `BAD_COMMAND`。
 */
export function walkPath(root: unknown, path: Path): PathStep[] {
  const segments = parsePath(path);
  const steps: PathStep[] = [];
  let container: unknown = root;
  for (const segment of segments) {
    if (!isContainer(container)) throw pathNotFound(path);
    if (Array.isArray(container)) {
      const slot = segment.kind === 'index' ? segment.index : Number(segment.key);
      if (segment.kind === 'key' && (segment.key.trim() === '' || !Number.isInteger(slot))) {
        throw pathNotFound(path);
      }
      if (!Number.isInteger(slot) || slot < 0 || slot >= container.length) throw pathNotFound(path);
      steps.push({ parent: container, key: String(slot), node: container[slot] });
    } else {
      const key = segment.kind === 'key' ? segment.key : String(segment.index);
      if (!hasOwnKey(container, key)) throw pathNotFound(path);
      steps.push({ parent: container, key, node: container[key] });
    }
    container = steps[steps.length - 1]?.node;
  }
  return steps;
}

/** 路径处的值；路径不存在抛 `BAD_COMMAND`（根路径返回根值）。 */
export function valueAt(root: unknown, path: Path): unknown {
  const steps = walkPath(root, path);
  return steps.length === 0 ? root : (steps[steps.length - 1] as PathStep).node;
}
