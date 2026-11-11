/**
 * core/expression/complete — 静态补全（ADR-0018 §3；#3 §5.3：纯函数，CM6 自己 filter）。
 *
 * 规则（与 #27 任务书逐条对齐）：
 * - `<标识符前缀>` / 空文本 → 根字段（`ctx.rootKeys`，detail「根字段 · <kind>」）+ 全局名；
 * - `X.` / `X?.` → `Math` → `MATH_MEMBERS`；`Array` → `isArray`；`JSON` → `parse/stringify`；
 *   `Number/String/Boolean` → 无成员；其它 → `ARRAY_METHODS ∪ STRING_METHODS ∪ ['length']`；
 * - **不做前缀过滤**（CM6 会按前缀 filter），只把「前缀完全相同」的候选排到最前；
 * - 顺序：根字段在前、全局在后、方法按白名单顺序；`pos` 越界夹取。
 *
 * detail 是**固定格式**（Lead 定稿，main.ts 靠「根字段 · <kind>」生成动态示例）：
 * `根字段 · <kind>` / `array 方法` / `string 方法` / `Math 方法` / `JSON 方法` / `属性` / `全局`。
 */
import type { ExprCompletion } from '../../protocol/types';
import type { CompletionContext } from './types';
import { ARRAY_METHODS, GLOBAL_NAMES, LENGTH_PROP, MATH_MEMBERS, STRING_METHODS } from './whitelist';

/** 尾随标识符（可作为补全前缀 / 成员接收者）。 */
const TRAILING_IDENTIFIER = /([A-Za-z_$][A-Za-z0-9_$]*)$/;
/** `X.` / `X?.`（X 为标识符）结尾。 */
const MEMBER_ACCESS = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\.\s*$/;

function rootCompletions(ctx: CompletionContext): ExprCompletion[] {
  const items: ExprCompletion[] = [];
  const seen = new Set<string>();
  const rootKeys = Array.isArray(ctx.rootKeys) ? ctx.rootKeys : [];

  for (const key of rootKeys) {
    if (typeof key !== 'string' || seen.has(key)) continue;
    seen.add(key);
    const kind = ctx.rootKinds?.[key];
    items.push({ label: key, kind: 'field', detail: kind ? `根字段 · ${kind}` : '根字段' });
  }
  for (const name of GLOBAL_NAMES) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ label: name, kind: 'global', detail: '全局' });
  }
  return items;
}

/**
 * 成员访问（`X.` / `X?.`）的候选表。
 *
 * 特例：`$.` / `$?.` 是「根字段」入口，与裸标识符前缀一样给根字段 + 全局
 * （`$.data.items.` 这类才是方法并集）。
 */
function memberCompletions(receiver: string, ctx: CompletionContext): ExprCompletion[] {
  if (receiver === '$') return rootCompletions(ctx);
  if (receiver === 'Math') {
    return MATH_MEMBERS.map((name) => ({ label: name, kind: 'method' as const, detail: 'Math 方法' }));
  }
  if (receiver === 'Array') {
    return [{ label: 'isArray', kind: 'method', detail: 'array 方法' }];
  }
  if (receiver === 'JSON') {
    return [
      { label: 'parse', kind: 'method', detail: 'JSON 方法' },
      { label: 'stringify', kind: 'method', detail: 'JSON 方法' },
    ];
  }
  if (receiver === 'Number' || receiver === 'String' || receiver === 'Boolean') {
    return [];
  }

  // 其它接收者：数组/字符串方法并集（同名保留数组侧的说明）+ length 属性。
  const items: ExprCompletion[] = [];
  const seen = new Set<string>();
  for (const name of ARRAY_METHODS) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ label: name, kind: 'method', detail: 'array 方法' });
  }
  for (const name of STRING_METHODS) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ label: name, kind: 'method', detail: 'string 方法' });
  }
  if (!seen.has(LENGTH_PROP)) items.push({ label: LENGTH_PROP, kind: 'field', detail: '属性' });
  return items;
}

/**
 * 计算补全候选（纯静态；不执行表达式、不读整个文档）。
 *
 * @param text 编辑器全文
 * @param pos 光标位置（UTF-16 偏移；越界夹到 `[0, text.length]`）
 * @param ctx 文档根顶层字段 + 类型（由 doc-service 抽取）
 */
export function getCompletions(text: string, pos: number, ctx: CompletionContext): ExprCompletion[] {
  const source = typeof text === 'string' ? text : '';
  const rawPos = typeof pos === 'number' && Number.isFinite(pos) ? Math.trunc(pos) : 0;
  const cursor = Math.max(0, Math.min(rawPos, source.length));
  const before = source.slice(0, cursor);

  let prefix = '';
  let head = before;
  const identifier = TRAILING_IDENTIFIER.exec(before);
  if (identifier) {
    prefix = identifier[1] as string;
    head = before.slice(0, before.length - prefix.length);
  }

  const member = MEMBER_ACCESS.exec(head);
  const items = member ? memberCompletions(member[1] as string, ctx) : rootCompletions(ctx);

  // 「前缀完全相同」优先（稳定：同组内保持白名单/字段顺序）；其余交给 CM6 过滤。
  if (prefix.length === 0) return items;
  const exact: ExprCompletion[] = [];
  const rest: ExprCompletion[] = [];
  for (const item of items) {
    if (item.label === prefix) exact.push(item);
    else rest.push(item);
  }
  return exact.concat(rest);
}
