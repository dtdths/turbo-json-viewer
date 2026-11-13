/**
 * core/expression/complete — 静态补全（ADR-0018 §3；#43 / ADR-0025 §6：类型感知补全）。
 *
 * 规则：
 * - `<标识符前缀>` / 空文本 → 根字段 + 全局名；
 * - `X.` / `X?.` → 接收者解析：
 *   - **纯键链**（仅 `$` / 标识符 / `.` / `?.`，任意深：`items`、`data.items`、`$.data.items`）→
 *     去 `$` 后在 profile 的 `paths` 里精确匹配；命中给该路径的 `members`
 *     （`detail` = `` `${kind} · 采样 ${freq}/${samples}` ``，`kind === 'mixed'` 用「混合」）；
 *     未命中 / profile 未就绪 → 退化为 `ARRAY_METHODS ∪ STRING_METHODS ∪ ['length']`；
 *   - 内建对象：`Math` → `MATH_MEMBERS`；`Array` → `isArray`；`JSON` → `parse/stringify`；
 *     `Number/String/Boolean` → 无成员；
 *   - 其它（下标 `items[0].` / 调用 / 运算等，**不做部分求值**）→ 沿用旧行为：最后一段标识符
 *     按上面同一套回落（通常是方法并集）。
 * - **不做前缀过滤**（CM6 会按前缀 filter），只把「前缀完全相同」的候选排到最前；
 * - 顺序：命中路径的字段按 profile 的 `members` 序（freq 降序、同频首次出现序）；根字段在前、全局在后。
 *
 * detail 的**固定格式**（Lead 定稿，main.ts 靠「根字段 · <kind>」生成动态示例，勿改）：
 * `根字段 · <kind>`（根字段）/ `${kind} · 采样 ${freq}/${samples}`（路径样本成员）/
 * `array 方法` / `string 方法` / `Math 方法` / `JSON 方法` / `属性` / `全局`。
 */
import type { ExprCompletion, FieldStat, PathSample } from '../../protocol/types';
import type { CompletionContext } from './types';
import { ARRAY_METHODS, GLOBAL_NAMES, LENGTH_PROP, MATH_MEMBERS, STRING_METHODS } from './whitelist';

/** 尾随标识符（可作为补全前缀 / 成员接收者的最后一段）。 */
const TRAILING_IDENTIFIER = /([A-Za-z_$][A-Za-z0-9_$]*)$/;
/** 成员访问尾部：`.` / `?.`（可带空白）。 */
const MEMBER_TAIL = /\s*\??\.\s*$/;
/** 纯键链：`$` 或标识符开头，后接任意深 `.key` / `?.key`（无下标 / 调用 / 运算）。 */
const KEY_CHAIN = /^(\$|[A-Za-z_$][A-Za-z0-9_$]*)(?:\s*\??\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*$/;
/** 键链分隔（`.key` / `?.key`，允许空白）。 */
const CHAIN_SEPARATOR = /\s*\??\.\s*/;

/** detail 的 kind 文案：`mixed` → 「混合」。 */
function kindLabel(kind: FieldStat['kind']): string {
  return kind === 'mixed' ? '混合' : kind;
}

/** 路径样本成员的 detail（固定格式，ADR-0025 §6）。 */
function sampleDetail(member: FieldStat, samples: number): string {
  return `${kindLabel(member.kind)} · 采样 ${member.freq}/${samples}`;
}

/**
 * 解析纯键链：返回去掉根标记 `$` 后的 segments；非法（含下标 / 调用 / 运算）→ null。
 *
 * `$.a.b` / `$?.a.b` / `a.b` / `a?.b` 都合法；`items[0]` / `f()` / `a + b` 非法。
 */
function parseKeyChain(text: string): string[] | null {
  if (!KEY_CHAIN.test(text)) return null;
  const segments = text.split(CHAIN_SEPARATOR);
  if (segments[0] === '$') segments.shift();
  return segments;
}

/** 在 profile 的路径样本里按 segments 精确匹配。 */
function findPathSample(paths: PathSample[] | undefined, segments: string[]): PathSample | undefined {
  if (paths === undefined || segments.length === 0) return undefined;
  return paths.find(
    (sample) =>
      sample.segments.length === segments.length &&
      sample.segments.every((segment, index) => segment === segments[index]),
  );
}

/** 根级候选：profile 就绪 → 根路径样本的 members；否则退化到文档根顶层字段。 */
function rootCompletions(ctx: CompletionContext): ExprCompletion[] {
  const items: ExprCompletion[] = [];
  const seen = new Set<string>();
  const rootSample = ctx.paths?.[0];

  if (rootSample !== undefined) {
    // 根为数组 → 元素字段样本（detail 用采样格式）；根为对象 → 保持「根字段 · <kind>」
    for (const member of rootSample.members) {
      if (seen.has(member.name)) continue;
      seen.add(member.name);
      const detail =
        rootSample.kind === 'array' ? sampleDetail(member, rootSample.samples) : `根字段 · ${kindLabel(member.kind)}`;
      items.push({ label: member.name, kind: 'field', detail });
    }
  } else {
    const rootKeys = Array.isArray(ctx.rootKeys) ? ctx.rootKeys : [];
    for (const key of rootKeys) {
      if (typeof key !== 'string' || seen.has(key)) continue;
      seen.add(key);
      const kind = ctx.rootKinds?.[key];
      items.push({ label: key, kind: 'field', detail: kind ? `根字段 · ${kind}` : '根字段' });
    }
  }

  for (const name of GLOBAL_NAMES) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ label: name, kind: 'global', detail: '全局' });
  }
  return items;
}

/** 内建对象 / 原始类型的成员（单段接收者专用；`null` = 不是内建接收者）。 */
function builtinReceiverCompletions(receiver: string): ExprCompletion[] | null {
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
  if (receiver === 'Number' || receiver === 'String' || receiver === 'Boolean') return [];
  return null;
}

/** 数组/字符串方法并集 + length（未命中 / profile 未就绪时的退化行为）。 */
function methodCompletions(): ExprCompletion[] {
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
 * 命中 profile 路径样本 → 该路径的 members（detail 固定为采样格式）。
 *
 * 数组路径额外追加数组/字符串方法并集 + `length`（ADR-0025 §6）：这些方法对数组元素字段
 * 补全同样有效，且保证既有能力不回归（`$.big.` 这类标量数组命中时 members 为空，若不追加
 * 方法会得到空候选 = 退化成「没提示」）。对象路径只给成员字段（对象上没有数组/字符串方法）。
 */
function pathSampleCompletions(sample: PathSample): ExprCompletion[] {
  const items: ExprCompletion[] = sample.members.map((member) => ({
    label: member.name,
    kind: 'field' as const,
    detail: sampleDetail(member, sample.samples),
  }));
  if (sample.kind !== 'array') return items;
  const seen = new Set(items.map((item) => item.label));
  for (const item of methodCompletions()) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    items.push(item);
  }
  return items;
}

/**
 * 成员访问（`X.` / `X?.`）的候选表。
 *
 * @param chainText 尾部 `.` 之前的接收者文本（如 `items` / `$.data.items`）
 */
function memberCompletions(chainText: string, ctx: CompletionContext): ExprCompletion[] {
  const chain = parseKeyChain(chainText);
  if (chain === null) {
    // 含下标 / 调用 / 运算：不做部分求值（ADR-0025 §6 非目标）→ 沿用旧行为
    const lastIdentifier = TRAILING_IDENTIFIER.exec(chainText);
    if (lastIdentifier === null) return rootCompletions(ctx);
    return builtinReceiverCompletions(lastIdentifier[1] as string) ?? methodCompletions();
  }
  if (chain.length === 0) return rootCompletions(ctx); // `$.` / `$?.`
  if (chain.length === 1) {
    const builtin = builtinReceiverCompletions(chain[0] as string);
    if (builtin !== null) return builtin;
  }
  const sample = findPathSample(ctx.paths, chain);
  return sample !== undefined ? pathSampleCompletions(sample) : methodCompletions();
}

/**
 * 计算补全候选（纯静态；不执行表达式、不遍历文档）。
 *
 * @param text 编辑器全文
 * @param pos 光标位置（UTF-16 偏移；越界夹到 `[0, text.length]`）
 * @param ctx 文档根字段 / 根字段类型 / 缓存的 profile 路径样本（由 doc-service 拼装）
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

  const tail = MEMBER_TAIL.exec(head);
  const items = tail === null ? rootCompletions(ctx) : memberCompletions(head.slice(0, head.length - tail[0].length), ctx);

  // 「前缀完全相同」优先（稳定：同组内保持字段/白名单顺序）；其余交给 CM6 过滤。
  if (prefix.length === 0) return items;
  const exact: ExprCompletion[] = [];
  const rest: ExprCompletion[] = [];
  for (const item of items) {
    if (item.label === prefix) exact.push(item);
    else rest.push(item);
  }
  return exact.concat(rest);
}
