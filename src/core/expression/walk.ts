/**
 * core/expression/walk — 手写 AST 解释器（ADR-0018 §3；#14 路线 A：acorn + 白名单 tree-walker）。
 *
 * 关键不变量（测试逐条钉住）：
 * 1. **绝不 eval / new Function**：只有显式白名单方法分派与 own-property 读，没有代码执行点。
 * 2. **步数确定性**：每个 AST 节点求值 +1，数组方法每处理一个元素 +1；时间只在每
 *    `EXPR_TIME_CHECK_EVERY` 步读一次 `opts.now()`（时间只做兜底刹车，步数优先）。
 * 3. **缺失字段分级**（#12 §2）：
 *    - 根级静态链（env 深度 0，即不在任何箭头函数体内）缺字段 → **恒** `EVAL_UNKNOWN_FIELD`；
 *    - 元素内部（箭头函数体内）缺字段 → `strict` 报错；非严格返回内部哨兵 `MISSING`。
 *      `MISSING` 作为运算/比较/成员基值继续传播；`filter/find/some/every` 当 falsy；
 *      `map` 丢弃该元素并 `skipped++`（只统计 MISSING，不统计用户显式 `undefined`）。
 * 4. **结果纯 JSON**：`undefined` / MISSING 不进结果（容器里省略；顶层 → `null`，`count=0`）；
 *    非有限数字按 JSON 语义 → `null`。
 * 5. **元素引用不复制**：结果里原样引用的文档容器 identity 不变；`origins.objects` 在「读到时」
 *    登记（容器 → 规范路径），`origins.top` 只记录**产出容器**的顶层子项来源。
 * 6. **三刹车**：超步 → `EVAL_STEP_LIMIT`；超时（检查点）→ `EVAL_TIME_LIMIT`；
 *    产出容器/字符串超 `maxResult` → 截断（继续执行但不追加，`truncated=true`，不抛错）。
 */
import type { ExprError, JsonKind } from '../../protocol/types';
import { EXPR_TIME_CHECK_EVERY } from '../../protocol/versions';
import { appendIndex, appendKey } from '../../shared/path';
import type { EvalBudget, EvalOrigins, EvalOutcome, EvaluateOptions } from './types';
import { isArrayMethod, isMathMember, isStringMethod, LENGTH_PROP } from './whitelist';
import { nodeLocation } from './validate';

type AstNode = { type: string } & Record<string, unknown>;

/* ---------------------------------- 内部哨兵 ---------------------------------- */

/** 元素内部缺失字段的哨兵（非严格模式）；只在引擎内流动，绝不进最终结果。 */
const MISSING: unique symbol = Symbol('expr.missing');
/** 可选链短路哨兵：仅在同一 ChainExpression 内部传播，根节点换算成 undefined。 */
const SHORT: unique symbol = Symbol('expr.short');

const MISSING_EV: Ev = { v: MISSING, p: null };
const SHORT_EV: Ev = { v: SHORT, p: null };

interface Namespace {
  readonly kind: 'namespace';
  readonly name: 'Math' | 'Array' | 'JSON';
}
interface Converter {
  readonly kind: 'converter';
  readonly name: 'Number' | 'String' | 'Boolean';
}
interface MethodRef {
  readonly kind: 'method';
  readonly name: string;
}
interface Closure {
  readonly kind: 'closure';
  readonly node: AstNode;
  readonly env: Env;
}

const MATH_NS: Namespace = { kind: 'namespace', name: 'Math' };
const ARRAY_NS: Namespace = { kind: 'namespace', name: 'Array' };
const JSON_NS: Namespace = { kind: 'namespace', name: 'JSON' };
const NUMBER_CTOR: Converter = { kind: 'converter', name: 'Number' };
const STRING_CTOR: Converter = { kind: 'converter', name: 'String' };
const BOOLEAN_CTOR: Converter = { kind: 'converter', name: 'Boolean' };
/** 只读方法作为「值」出现时（如 `(f => f)($.a.map)`）的占位；最终结果会变成 null。 */
const METHOD_REF: MethodRef = { kind: 'method', name: '' };

function isNamespace(value: unknown): value is Namespace {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'namespace';
}
function isConverter(value: unknown): value is Converter {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'converter';
}
function isMethodRef(value: unknown): value is MethodRef {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'method';
}
function isClosure(value: unknown): value is Closure {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'closure';
}

/* ---------------------------------- 作用域 ---------------------------------- */

interface Binding {
  v: unknown;
  /** 值的文档来源路径（回调参数 = 元素路径）；计算值 null。origins 依赖它。 */
  p: string | null;
}

interface Env {
  readonly vars: Map<string, Binding>;
  readonly parent: Env | null;
  /** 箭头函数嵌套深度：0 = 根级静态链；>0 = 元素内部（缺失字段分级依据）。 */
  readonly depth: number;
}

function lookup(env: Env, name: string): Binding | undefined {
  let cur: Env | null = env;
  while (cur !== null) {
    const found = cur.vars.get(name);
    if (found !== undefined) return found;
    cur = cur.parent;
  }
  return undefined;
}

/* ---------------------------------- 求值单元 ---------------------------------- */

interface Ev {
  v: unknown;
  /** 源路径（文档读 / 回调参数）；计算值 null。 */
  p: string | null;
  /** 仅「产出容器」携带：顶层子项来源路径（数组按序 / 对象按键）。 */
  kids?: (string | null)[] | Record<string, string | null>;
  /**
   * true = 该值由「根标识符 / `$` 起算的静态链」读到（`$`、裸顶层字段、以及从它们继续
   * 成员/下标读取）。用于缺失字段分级：根级静态链缺字段恒报错，即使写在箭头函数体内。
   * 回调参数在绑定处显式丢弃该标记（元素内部 → strict/MISSING）。
   */
  rootChain?: boolean;
}

function ev(v: unknown, p: string | null = null): Ev {
  return { v, p };
}

/* --------------------------------- 错误 / 预算 --------------------------------- */

class EvalFailure extends Error {
  readonly error: ExprError;
  constructor(error: ExprError) {
    super(error.code);
    this.name = 'EvalFailure';
    this.error = error;
  }
}

function raise(node: AstNode, code: ExprError['code'], params: (string | number)[], candidates?: string[]): never {
  const error: ExprError = { code, params };
  const loc = nodeLocation(node);
  if (loc) {
    error.line = loc.line;
    error.column = loc.column;
  }
  if (candidates && candidates.length > 0) error.candidates = candidates;
  throw new EvalFailure(error);
}

interface Machine {
  docRoot: unknown;
  strict: boolean;
  budget: EvalBudget;
  now: () => number;
  start: number;
  steps: number;
  truncated: boolean;
  skipped: number;
  origins: EvalOrigins;
}

/** 步数 +1，并做步数 / 时间（检查点）刹车。 */
function tick(m: Machine, node: AstNode): void {
  m.steps += 1;
  if (m.steps > m.budget.maxSteps) {
    raise(node, 'EVAL_STEP_LIMIT', [m.budget.maxSteps]);
  }
  if (m.steps % EXPR_TIME_CHECK_EVERY === 0) {
    const elapsed = m.now() - m.start;
    if (elapsed > m.budget.maxTimeMs) {
      raise(node, 'EVAL_TIME_LIMIT', [m.budget.maxTimeMs]);
    }
  }
}

/* ------------------------------- 拼写纠错候选 ------------------------------- */

/** 小写编辑距离（字段名都很短，O(nm) 足够；不引依赖）。 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = new Array(b.length + 1);
  let cur: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] as number) + 1;
      const ins = (cur[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;
      cur[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length] as number;
}

/** 根键 / 对象键的相近者 ≤3 条；稳定排序（距离升序，同距离按原有键序）。 */
function suggestKeys(keys: readonly string[], field: string): string[] {
  if (keys.length === 0 || field.length === 0) return [];
  const threshold = Math.max(2, Math.ceil(field.length / 2));
  const scored: { key: string; index: number; distance: number }[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    const distance = editDistance(field, key);
    const nearPrefix = key.startsWith(field) || field.startsWith(key);
    if (distance <= threshold || nearPrefix) scored.push({ key, index: i, distance });
  }
  scored.sort((a, b) => (a.distance !== b.distance ? a.distance - b.distance : a.index - b.index));
  return scored.slice(0, 3).map((item) => item.key);
}

/**
 * 最终结果容器的 `maxResult` 截断（ADR-0018 §3：结果上限对**结果根**同样生效，
 * 包括原样引用的文档容器——切片 / 取前 N 键生成新容器，元素值仍引用原节点、不复制）。
 *
 * 新容器没有对象身份来源，所以必须逐项补 `origins.top`：
 * 数组 `appendIndex(root.p, i)`、对象 `appendKey(root.p, key)`；`root.p` 为 null 时退回产出
 * 容器的 `kids`。这样截断结果上的 `locate('$[0]')` 仍能回到 `$.big[0]`。
 */
function capFinalContainer(
  machine: Machine,
  root: Ev,
  value: unknown,
): { value: unknown; top: (string | null)[] | Record<string, string | null> | null } {
  const cap = machine.budget.maxResult;

  if (Array.isArray(value) && value.length > cap) {
    let top: (string | null)[];
    if (root.p !== null) {
      top = [];
      for (let i = 0; i < cap; i++) top.push(appendIndex(root.p, i));
    } else if (Array.isArray(root.kids)) {
      top = [];
      for (let i = 0; i < cap; i++) {
        const path = root.kids[i];
        top.push(path === undefined ? null : path);
      }
    } else {
      top = new Array(cap).fill(null);
    }
    machine.truncated = true;
    return { value: value.slice(0, cap), top };
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > cap) {
      const kids =
        root.kids !== undefined && !Array.isArray(root.kids)
          ? (root.kids as Record<string, string | null>)
          : undefined;
      const out: Record<string, unknown> = {};
      const top: Record<string, string | null> = {};
      for (const key of keys.slice(0, cap)) {
        defineOwn(out, key, value[key]);
        top[key] = root.p !== null ? appendKey(root.p, key) : kids && Object.hasOwn(kids, key) ? (kids[key] as string | null) : null;
      }
      machine.truncated = true;
      return { value: out, top };
    }
  }

  return { value, top: null };
}

/* -------------------------------- 文档读 / 路径 ------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDocumentContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** 读文档值：容器 + 已知路径 → 登记 origins.objects（元素引用不复制）。 */
function readDoc(m: Machine, value: unknown, path: string | null): Ev {
  if (path !== null && isDocumentContainer(value)) {
    m.origins.objects.set(value, path);
  }
  return { v: value, p: path };
}

/** 数组元素自身的来源路径（doc 数组 → base.p + [i]；产出数组 → kids[i]）。 */
function elementSourcePath(base: Ev, index: number): string | null {
  if (base.p !== null) return appendIndex(base.p, index);
  if (Array.isArray(base.kids)) {
    const path = base.kids[index];
    return path === undefined ? null : path;
  }
  return null;
}

/** 读数组元素（带来源路径 + 容器登记）。 */
function arrayElement(m: Machine, base: Ev, index: number): Ev {
  const arr = base.v as unknown[];
  const child = readDoc(m, arr[index], elementSourcePath(base, index));
  if (base.rootChain === true) child.rootChain = true;
  return child;
}

/* --------------------------------- 类型转换 --------------------------------- */

/** JS 字符串化（安全版：不调用文档对象上的 toString / valueOf）。 */
function display(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return value as string;
  if (type === 'number' || type === 'boolean') return String(value);
  if (Array.isArray(value)) {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (i > 0) out += ',';
      out += item === null || item === undefined ? '' : display(item);
    }
    return out;
  }
  if (isPlainObject(value)) return '[object Object]';
  return '';
}

/** ToPrimitive（JSON 值域内）：数组/对象 → 字符串形态。 */
function toPrimitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') return display(value);
  return value;
}

/** ToNumber（JS 语义的 JSON 值域子集）。 */
function toNumberValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value === null) return 0;
  if (value === undefined) return Number.NaN;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return Number(value);
  if (Array.isArray(value)) return Number(display(value));
  return Number.NaN;
}

function truthy(value: unknown): boolean {
  return Boolean(value);
}

/** JS `typeof`（JSON 值域 + 箭头函数）。 */
function typeofValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'object';
  if (Array.isArray(value)) return 'object';
  if (typeof value === 'object') return isClosure(value) ? 'function' : 'object';
  return typeof value;
}

/** 产出字符串的 `maxResult` 截断（继续执行但不追加，不抛错）。 */
function clampString(m: Machine, value: string): string {
  if (value.length <= m.budget.maxResult) return value;
  m.truncated = true;
  return value.slice(0, m.budget.maxResult);
}

/** 产出容器的 `maxResult` 截断：满了之后只置位不追加。 */
function appendCapped(
  m: Machine,
  values: unknown[],
  kids: (string | null)[],
  value: unknown,
  path: string | null,
): void {
  if (values.length >= m.budget.maxResult) {
    m.truncated = true;
    return;
  }
  values.push(value);
  kids.push(path);
}

/** 安全地定义 own property（`__proto__` 键不能走普通赋值，否则会改原型）。 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/* ------------------------------- 节点消费工具 ------------------------------- */

function asNode(value: unknown): AstNode | null {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
    ? (value as AstNode)
    : null;
}

function asNodeOrRaise(value: unknown, parent: AstNode): AstNode {
  const node = asNode(value);
  if (!node) raise(parent, 'PARSE_ERR_ROOT_SHAPE', ['root-shape']);
  return node;
}

/** computed 成员 key → 属性键字符串。 */
function toPropertyKey(node: AstNode, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  raise(node, 'EVAL_SHAPE_ERROR', ['index']);
}

/* --------------------------------- 成员读取 --------------------------------- */

/** 非 computed 成员名 / computed 字面量成员名（运行时调用点用）。 */
function staticMemberName(node: AstNode): string | null {
  if (!node.computed) {
    const prop = asNode(node.property);
    return prop && typeof prop.name === 'string' ? prop.name : null;
  }
  const prop = asNode(node.property);
  if (prop && prop.type === 'Literal') {
    const value = prop.value;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

function namespaceMember(node: AstNode, ns: Namespace, name: string): Ev {
  let allowed = false;
  if (ns.name === 'Math') allowed = isMathMember(name);
  else if (ns.name === 'Array') allowed = name === 'isArray';
  else allowed = name === 'parse' || name === 'stringify';
  if (!allowed) raise(node, 'EVAL_ILLEGAL_CALL', [name]);
  return { v: METHOD_REF, p: null };
}

function objectMember(m: Machine, node: AstNode, env: Env, base: Ev, key: string | number): Ev {
  const target = base.v as Record<string, unknown>;
  const name = typeof key === 'string' ? key : String(key);
  if (Object.hasOwn(target, name)) {
    const path = base.p !== null ? appendKey(base.p, name) : null;
    const child = readDoc(m, target[name], path);
    if (base.rootChain === true) child.rootChain = true;
    return child;
  }
  const keys = Object.keys(target);
  const candidates = suggestKeys(keys, name);
  // 根级静态链（从根标识符 / `$` 起算，含写在箭头函数体内的 `x => $.zzz`）：
  // 严格与否都报错（#12 §2 + Lead 2026-11-10 口径修订）。
  if (base.rootChain === true || env.depth === 0) {
    raise(node, 'EVAL_UNKNOWN_FIELD', [name], candidates);
  }
  // 元素内部（基值来自元素 / 回调参数）：严格模式报错；非严格返回 MISSING 由上层传播。
  if (m.strict) raise(node, 'EVAL_UNKNOWN_FIELD', [name], candidates);
  return MISSING_EV;
}

function arrayIndex(m: Machine, base: Ev, index: number): Ev {
  const arr = base.v as unknown[];
  if (index < 0 || index >= arr.length) return ev(undefined);
  return arrayElement(m, base, index);
}

function arrayMember(m: Machine, node: AstNode, base: Ev, key: string | number): Ev {
  const arr = base.v as unknown[];
  if (typeof key === 'string') {
    if (key === LENGTH_PROP) return ev(arr.length);
    if (isArrayMethod(key)) return { v: METHOD_REF, p: null };
    // 数字样式字符串按 JS ToPropertyKey 语义当索引（`arr['0'] === arr[0]`）。
    if (/^(0|[1-9]\d*)$/.test(key)) return arrayIndex(m, base, Number(key));
    raise(node, 'EVAL_SHAPE_ERROR', ['index']);
  }
  if (!Number.isInteger(key)) raise(node, 'EVAL_SHAPE_ERROR', ['index']);
  return arrayIndex(m, base, key);
}

function stringMember(node: AstNode, base: Ev, key: string | number): Ev {
  const text = base.v as string;
  if (typeof key === 'string') {
    if (key === LENGTH_PROP) return ev(text.length);
    if (isStringMethod(key)) return { v: METHOD_REF, p: null };
    if (/^(0|[1-9]\d*)$/.test(key)) {
      const index = Number(key);
      return ev(index < text.length ? text[index] : undefined);
    }
    raise(node, 'EVAL_SHAPE_ERROR', ['base-kind']);
  }
  if (!Number.isInteger(key)) raise(node, 'EVAL_SHAPE_ERROR', ['index']);
  return ev(key >= 0 && key < text.length ? text[key] : undefined);
}

function readProperty(m: Machine, node: AstNode, env: Env, base: Ev, key: string | number): Ev {
  const value = base.v;
  if (isNamespace(value)) return namespaceMember(node, value, String(key));
  if (Array.isArray(value)) return arrayMember(m, node, base, key);
  if (typeof value === 'string') return stringMember(node, base, key);
  if (isPlainObject(value)) return objectMember(m, node, env, base, key);
  // null / undefined / 数字 / 布尔 / 闭包 / 命名空间……都不允许取属性。
  raise(node, 'EVAL_SHAPE_ERROR', ['base-kind']);
}

/* --------------------------------- 节点求值 --------------------------------- */

function evalIdentifier(m: Machine, node: AstNode, env: Env): Ev {
  const name = typeof node.name === 'string' ? node.name : '';
  // `$` = 文档根（不是普通标识符；不参与全局/根键解析）。
  if (name === '$') {
    const root = readDoc(m, m.docRoot, '$');
    root.rootChain = true;
    return root;
  }

  // 1) 词法作用域（箭头参数）优先：`items.map(item => item.x)` 必须命中参数而不是根键。
  const binding = lookup(env, name);
  if (binding !== undefined) return { v: binding.v, p: binding.p };

  // 2) 全局白名单（命名冲突时全局优先：Math 永远是 Math）。
  switch (name) {
    case 'Math':
      return ev(MATH_NS);
    case 'Array':
      return ev(ARRAY_NS);
    case 'JSON':
      return ev(JSON_NS);
    case 'Number':
      return ev(NUMBER_CTOR);
    case 'String':
      return ev(STRING_CTOR);
    case 'Boolean':
      return ev(BOOLEAN_CTOR);
    case 'undefined':
      return ev(undefined);
    default:
      break;
  }

  // 3) 文档根 own property（裸顶层字段 = `$.字段`）。
  if (isPlainObject(m.docRoot) && Object.hasOwn(m.docRoot, name)) {
    const field = readDoc(m, m.docRoot[name], appendKey('$', name));
    field.rootChain = true;
    return field;
  }

  // 4) 都不匹配 → 未知字段（根级标识符恒报错，带拼写候选）。
  const keys = isPlainObject(m.docRoot) ? Object.keys(m.docRoot) : [];
  raise(node, 'EVAL_UNKNOWN_FIELD', [name], suggestKeys(keys, name));
}

function evalLiteral(m: Machine, node: AstNode): Ev {
  if (typeof node.bigint === 'string') raise(node, 'STATIC_ERR_NODE', ['BigIntLiteral']);
  if (node.regex !== undefined) raise(node, 'STATIC_ERR_NODE', ['RegExpLiteral']);
  const value = node.value;
  if (typeof value === 'string') return ev(clampString(m, value));
  return ev(value);
}

function evalTemplateLiteral(m: Machine, node: AstNode, env: Env): Ev {
  const quasis = Array.isArray(node.quasis) ? node.quasis : [];
  const expressions = Array.isArray(node.expressions) ? node.expressions : [];
  let out = '';
  for (let i = 0; i < quasis.length; i++) {
    const quasi = asNode(quasis[i]);
    if (quasi) {
      const value = quasi.value as { cooked?: string | null } | undefined;
      out += typeof value?.cooked === 'string' ? value.cooked : '';
    }
    if (i < expressions.length) {
      const expression = asNode(expressions[i]);
      if (!expression) continue;
      const result = evalNode(m, expression, env);
      if (result.v === SHORT) return SHORT_EV;
      // MISSING 在模板串里按空串处理（缺失字段不污染文案）。
      if (result.v === MISSING) continue;
      out += display(result.v);
    }
  }
  return ev(clampString(m, out));
}

function evalArrayExpression(m: Machine, node: AstNode, env: Env): Ev {
  const elements = Array.isArray(node.elements) ? node.elements : [];
  const values: unknown[] = [];
  const kids: (string | null)[] = [];

  for (const raw of elements) {
    if (raw === null) continue; // 稀疏数组空位 → undefined 省略
    const element = asNodeOrRaise(raw, node);
    if (element.type === 'SpreadElement') {
      const spread = evalNode(m, asNodeOrRaise(element.argument, element), env);
      if (spread.v === SHORT) return SHORT_EV;
      if (spread.v === MISSING) return MISSING_EV;
      expandSpreadInto(m, node, spread, values, kids, 'spread');
      continue;
    }
    const result = evalNode(m, element, env);
    if (result.v === SHORT) return SHORT_EV;
    if (result.v === MISSING || result.v === undefined) continue;
    appendCapped(m, values, kids, result.v, result.p);
  }

  return { v: values, p: null, kids };
}

/** 展开符：数组逐元素（带路径）/ 字符串逐字符；其它 → EVAL_ILLEGAL_CALL。 */
function expandSpreadInto(
  m: Machine,
  node: AstNode,
  spread: Ev,
  values: unknown[],
  kids: (string | null)[],
  method: string,
): void {
  const value = spread.v;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const path = elementSourcePath(spread, i);
      applyCapped(m, values, kids, value[i], path);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const char of value) applyCapped(m, values, kids, char, null);
    return;
  }
  raise(node, 'EVAL_ILLEGAL_CALL', [method]);
}

function applyCapped(
  m: Machine,
  values: unknown[],
  kids: (string | null)[],
  value: unknown,
  path: string | null,
): void {
  if (value === MISSING || value === undefined) return;
  appendCapped(m, values, kids, value, path);
}

function evalObjectExpression(m: Machine, node: AstNode, env: Env): Ev {
  const properties = Array.isArray(node.properties) ? node.properties : [];
  const target: Record<string, unknown> = {};
  const kids: Record<string, string | null> = {};
  const seen = new Set<string>();

  for (const raw of properties) {
    const property = asNodeOrRaise(raw, node);
    if (property.type === 'SpreadElement') {
      const spread = evalNode(m, asNodeOrRaise(property.argument, property), env);
      if (spread.v === SHORT) return SHORT_EV;
      if (spread.v === MISSING) return MISSING_EV;
      const value = spread.v;
      if (value === null || value === undefined) continue; // `{...null}` = {}
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const key = String(i);
          if (!spreadOwn(m, target, kids, seen, key, value[i], elementSourcePath(spread, i))) {
            // 截断标记已置位，继续处理（步数确定性）
          }
        }
        continue;
      }
      if (typeof value === 'string') {
        for (let i = 0; i < value.length; i++) {
          const char = value[i];
          spreadOwn(m, target, kids, seen, String(i), char, null);
        }
        continue;
      }
      if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
          const path = spread.p !== null ? appendKey(spread.p, key) : null;
          spreadOwn(m, target, kids, seen, key, value[key], path);
        }
      }
      continue;
    }

    if (property.type !== 'Property') raise(node, 'STATIC_ERR_NODE', [property.type]);
    if (property.kind !== 'init' || property.method === true) {
      raise(property, 'STATIC_ERR_NODE', ['Property']);
    }

    // 计算键先求值（JS 求值顺序：key 先于 value）。
    let key: string;
    if (property.computed === true) {
      const keyResult = evalNode(m, asNodeOrRaise(property.key, property), env);
      if (keyResult.v === SHORT) return SHORT_EV;
      if (keyResult.v === MISSING) continue;
      key = toPropertyKey(property, keyResult.v);
    } else {
      const keyNode = asNodeOrRaise(property.key, property);
      if (keyNode.type === 'Identifier') key = String(keyNode.name);
      else key = toPropertyKey(property, keyNode.value);
    }

    const valueResult = evalNode(m, asNodeOrRaise(property.value, property), env);
    if (valueResult.v === SHORT) return SHORT_EV;
    if (valueResult.v === MISSING || valueResult.v === undefined) continue;

    if (!Object.hasOwn(target, key) && seen.size >= m.budget.maxResult) {
      m.truncated = true;
      continue;
    }
    seen.add(key);
    defineOwn(target, key, valueResult.v);
    kids[key] = valueResult.p;
  }

  return { v: target, p: null, kids };
}

/** 对象展开时写入一个键（同样受 maxResult 截断；已存在的键允许覆盖）。 */
function spreadOwn(
  m: Machine,
  target: Record<string, unknown>,
  kids: Record<string, string | null>,
  seen: Set<string>,
  key: string,
  value: unknown,
  path: string | null,
): boolean {
  if (value === MISSING || value === undefined) return true;
  if (!Object.hasOwn(target, key) && seen.size >= m.budget.maxResult) {
    m.truncated = true;
    return false;
  }
  seen.add(key);
  defineOwn(target, key, value);
  kids[key] = path;
  return true;
}

function evalMemberExpression(m: Machine, node: AstNode, env: Env): Ev {
  const base = evalNode(m, asNodeOrRaise(node.object, node), env);
  if (base.v === SHORT) return SHORT_EV;
  if (base.v === MISSING) return MISSING_EV;

  // 可选链短路：`a?.b` 在 a 为 null/undefined 时返回 SHORT，由 ChainExpression 换算成 undefined。
  if (node.optional === true && (base.v === undefined || base.v === null)) return SHORT_EV;

  let key: string | number;
  if (node.computed === true) {
    const keyResult = evalNode(m, asNodeOrRaise(node.property, node), env);
    if (keyResult.v === SHORT) return SHORT_EV;
    if (keyResult.v === MISSING) return MISSING_EV;
    key = toPropertyKey(node, keyResult.v);
  } else {
    const property = asNodeOrRaise(node.property, node);
    key = String(property.name);
  }

  return readProperty(m, node, env, base, key);
}

function evalChainExpression(m: Machine, node: AstNode, env: Env): Ev {
  const inner = evalNode(m, asNodeOrRaise(node.expression, node), env);
  if (inner.v === SHORT) return ev(undefined);
  return inner;
}

function evalArrowFunction(node: AstNode, env: Env): Ev {
  const closure: Closure = { kind: 'closure', node, env };
  return ev(closure);
}

function evalUnaryExpression(m: Machine, node: AstNode, env: Env): Ev {
  const operator = String(node.operator);
  const argument = evalNode(m, asNodeOrRaise(node.argument, node), env);
  if (argument.v === SHORT) return SHORT_EV;
  if (argument.v === MISSING) return MISSING_EV;
  switch (operator) {
    case '-':
      return ev(-toNumberValue(argument.v));
    case '+':
      return ev(toNumberValue(argument.v));
    case '!':
      return ev(!truthy(argument.v));
    case 'typeof':
      return ev(typeofValue(argument.v));
    default:
      raise(node, 'STATIC_ERR_NODE', [operator]);
  }
}

function evalBinaryExpression(m: Machine, node: AstNode, env: Env): Ev {
  const operator = String(node.operator);
  const left = evalNode(m, asNodeOrRaise(node.left, node), env);
  if (left.v === SHORT) return SHORT_EV;
  if (left.v === MISSING) return MISSING_EV;
  const right = evalNode(m, asNodeOrRaise(node.right, node), env);
  if (right.v === SHORT) return SHORT_EV;
  if (right.v === MISSING) return MISSING_EV;

  switch (operator) {
    case '===':
      return ev(left.v === right.v);
    case '!==':
      return ev(left.v !== right.v);
    case '+': {
      const l = toPrimitive(left.v);
      const r = toPrimitive(right.v);
      if (typeof l === 'string' || typeof r === 'string') return ev(clampString(m, display(l) + display(r)));
      return ev(toNumberValue(l) + toNumberValue(r));
    }
    case '-':
      return ev(toNumberValue(left.v) - toNumberValue(right.v));
    case '*':
      return ev(toNumberValue(left.v) * toNumberValue(right.v));
    case '/':
      return ev(toNumberValue(left.v) / toNumberValue(right.v));
    case '%':
      return ev(toNumberValue(left.v) % toNumberValue(right.v));
    case '<':
    case '<=':
    case '>':
    case '>=':
      return ev(relational(operator, left.v, right.v));
    default:
      raise(node, 'STATIC_ERR_NODE', [operator]);
  }
}

function relational(operator: string, left: unknown, right: unknown): boolean {
  const l = toPrimitive(left);
  const r = toPrimitive(right);
  if (typeof l === 'string' && typeof r === 'string') {
    if (operator === '<') return l < r;
    if (operator === '<=') return l <= r;
    if (operator === '>') return l > r;
    return l >= r;
  }
  const ln = toNumberValue(l);
  const rn = toNumberValue(r);
  if (operator === '<') return ln < rn;
  if (operator === '<=') return ln <= rn;
  if (operator === '>') return ln > rn;
  return ln >= rn;
}

function evalLogicalExpression(m: Machine, node: AstNode, env: Env): Ev {
  const operator = String(node.operator);
  const left = evalNode(m, asNodeOrRaise(node.left, node), env);
  if (left.v === SHORT) return SHORT_EV;
  if (left.v === MISSING) return MISSING_EV;

  if (operator === '&&') {
    if (!truthy(left.v)) return left;
    return evalNode(m, asNodeOrRaise(node.right, node), env);
  }
  if (operator === '||') {
    if (truthy(left.v)) return left;
    return evalNode(m, asNodeOrRaise(node.right, node), env);
  }
  if (operator === '??') {
    if (left.v !== null && left.v !== undefined) return left;
    return evalNode(m, asNodeOrRaise(node.right, node), env);
  }
  raise(node, 'STATIC_ERR_NODE', [operator]);
}

function evalConditionalExpression(m: Machine, node: AstNode, env: Env): Ev {
  const test = evalNode(m, asNodeOrRaise(node.test, node), env);
  if (test.v === SHORT) return SHORT_EV;
  if (test.v === MISSING) return MISSING_EV;
  const branch = truthy(test.v) ? node.consequent : node.alternate;
  return evalNode(m, asNodeOrRaise(branch, node), env);
}

/* ---------------------------------- 调用 ---------------------------------- */

/** 求值实参（展开符按数组/字符串展开，元素带来源路径）。 */
function evalArguments(m: Machine, node: AstNode, env: Env): Ev[] {
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  const out: Ev[] = [];
  for (const raw of args) {
    const arg = asNodeOrRaise(raw, node);
    if (arg.type !== 'SpreadElement') {
      out.push(evalNode(m, arg, env));
      continue;
    }
    const spread = evalNode(m, asNodeOrRaise(arg.argument, arg), env);
    if (spread.v === SHORT) {
      out.push(SHORT_EV);
      continue;
    }
    if (spread.v === MISSING) {
      out.push(MISSING_EV);
      continue;
    }
    if (Array.isArray(spread.v)) {
      for (let i = 0; i < spread.v.length; i++) {
        out.push(readDoc(m, spread.v[i], elementSourcePath(spread, i)));
      }
    } else if (typeof spread.v === 'string') {
      for (const char of spread.v) out.push(ev(char));
    } else {
      raise(arg, 'EVAL_ILLEGAL_CALL', ['spread']);
    }
  }
  return out;
}

function callClosure(m: Machine, closure: Closure, args: Ev[]): Ev {
  const arrow = closure.node;
  const params = Array.isArray(arrow.params) ? arrow.params : [];
  const vars = new Map<string, Binding>();
  for (let i = 0; i < params.length; i++) {
    const param = asNode(params[i]);
    if (!param) continue;
    const arg = args[i];
    vars.set(String(param.name), { v: arg ? arg.v : undefined, p: arg ? arg.p : null });
  }
  const env: Env = { vars, parent: closure.env, depth: closure.env.depth + 1 };
  return evalNode(m, asNodeOrRaise(arrow.body, arrow), env);
}

function callCallback(m: Machine, node: AstNode, callback: Ev | undefined, args: Ev[], method: string): Ev {
  // 缺参数 / 参数不是箭头闭包（如 `$.items.map(1)`）→ 语义上非法调用。
  if (!callback || !isClosure(callback.v)) raise(node, 'EVAL_ILLEGAL_CALL', [method]);
  return callClosure(m, callback.v, args);
}

function predicatePasses(result: Ev): boolean {
  if (result.v === MISSING || result.v === SHORT) return false;
  return truthy(result.v);
}

/** 数值参数（slice/at/flat 等）：非数字 → EVAL_SHAPE_ERROR ['index']。 */
function numericArg(node: AstNode, value: unknown): number {
  if (typeof value !== 'number') raise(node, 'EVAL_SHAPE_ERROR', ['index']);
  if (Number.isFinite(value)) return Math.trunc(value);
  // Infinity / -Infinity 在 slice 语义里是「到头」；直接返回由各方法夹取。
  return value;
}

function toIntegerOrInfinity(value: number): number {
  if (Number.isFinite(value)) return Math.trunc(value);
  return value;
}

/** 夹取类数组边界（JS slice 语义）。 */
function clampRange(start: number, end: number, length: number): [number, number] {
  let from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  let to = end < 0 ? Math.max(length + end, 0) : Math.min(end, length);
  if (!Number.isFinite(from)) from = start > 0 ? length : 0;
  if (!Number.isFinite(to)) to = end > 0 ? length : 0;
  if (to < from) to = from;
  return [from, to];
}

function mathCall(node: AstNode, name: string, args: Ev[]): Ev {
  const nums = args.map((arg) => toNumberValue(arg.v));
  switch (name) {
    case 'abs':
      return ev(Math.abs(nums[0] as number));
    case 'ceil':
      return ev(Math.ceil(nums[0] as number));
    case 'floor':
      return ev(Math.floor(nums[0] as number));
    case 'round':
      return ev(Math.round(nums[0] as number));
    case 'trunc':
      return ev(Math.trunc(nums[0] as number));
    case 'sqrt':
      return ev(Math.sqrt(nums[0] as number));
    case 'sign':
      return ev(Math.sign(nums[0] as number));
    case 'log':
      return ev(Math.log(nums[0] as number));
    case 'pow':
      return ev(Math.pow(nums[0] as number, nums[1] as number));
    case 'max':
      return ev(nums.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...nums));
    case 'min':
      return ev(nums.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...nums));
    default:
      raise(node, 'EVAL_ILLEGAL_CALL', [name]);
  }
}

function namespaceCall(m: Machine, node: AstNode, ns: Namespace, name: string, args: Ev[]): Ev {
  if (ns.name === 'Math') {
    if (!isMathMember(name)) raise(node, 'EVAL_ILLEGAL_CALL', [name]);
    return mathCall(node, name, args);
  }
  if (ns.name === 'Array') {
    if (name !== 'isArray') raise(node, 'EVAL_ILLEGAL_CALL', [name]);
    return ev(args.length > 0 ? Array.isArray(args[0]?.v) : false);
  }
  // JSON.*
  if (name === 'parse') {
    const arg = args[0];
    if (!arg || typeof arg.v !== 'string') raise(node, 'EVAL_ILLEGAL_CALL', ['JSON.parse']);
    let parsed: unknown;
    try {
      parsed = JSON.parse(arg.v);
    } catch {
      raise(node, 'EVAL_ILLEGAL_CALL', ['JSON.parse']);
    }
    // 解析结果的容器尺寸也受 maxResult 约束（防大字符串炸内存）。
    if (countDocumentNodes(parsed) > m.budget.maxResult) {
      raise(node, 'EVAL_ILLEGAL_CALL', ['JSON.parse']);
    }
    return ev(parsed);
  }
  if (name === 'stringify') {
    const value = args.length > 0 ? args[0]?.v : undefined;
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      raise(node, 'EVAL_ILLEGAL_CALL', ['JSON.stringify']);
    }
    if (text === undefined) return ev(undefined);
    return ev(clampString(m, text));
  }
  raise(node, 'EVAL_ILLEGAL_CALL', [name]);
}

/* ------------------------------ 数组方法实现 ------------------------------ */

function arrayMethodCall(m: Machine, node: AstNode, base: Ev, name: string, args: Ev[]): Ev {
  const arr = base.v as unknown[];

  switch (name) {
    case 'map': {
      const values: unknown[] = [];
      const kids: (string | null)[] = [];
      for (let i = 0; i < arr.length; i++) {
        tick(m, node);
        const element = arrayElement(m, base, i);
        const result = callCallback(m, node, args[0] as Ev, [element, ev(i), ev(arr, base.p)], 'map');
        if (result.v === SHORT) return SHORT_EV;
        if (result.v === MISSING) {
          // 只有 MISSING 哨兵导致的丢弃才计入 skipped。
          m.skipped += 1;
          continue;
        }
        if (result.v === undefined) continue; // 用户显式 undefined：省略但不计 skipped
        appendCapped(m, values, kids, result.v, result.p);
      }
      return { v: values, p: null, kids };
    }

    case 'filter': {
      const values: unknown[] = [];
      const kids: (string | null)[] = [];
      for (let i = 0; i < arr.length; i++) {
        tick(m, node);
        const element = arrayElement(m, base, i);
        const result = callCallback(m, node, args[0] as Ev, [element, ev(i), ev(arr, base.p)], 'filter');
        if (!predicatePasses(result)) continue;
        appendCapped(m, values, kids, element.v, element.p);
      }
      return { v: values, p: null, kids };
    }

    case 'find': {
      for (let i = 0; i < arr.length; i++) {
        tick(m, node);
        const element = arrayElement(m, base, i);
        const result = callCallback(m, node, args[0] as Ev, [element, ev(i), ev(arr, base.p)], 'find');
        if (predicatePasses(result)) return element;
      }
      return ev(undefined);
    }

    case 'findIndex': {
      for (let i = 0; i < arr.length; i++) {
        tick(m, node);
        const element = arrayElement(m, base, i);
        const result = callCallback(m, node, args[0] as Ev, [element, ev(i), ev(arr, base.p)], 'findIndex');
        if (predicatePasses(result)) return ev(i);
      }
      return ev(-1);
    }

    case 'some': {
      for (let i = 0; i < arr.length; i++) {
        tick(m, node);
        const element = arrayElement(m, base, i);
        const result = callCallback(m, node, args[0] as Ev, [element, ev(i), ev(arr, base.p)], 'some');
        if (predicatePasses(result)) return ev(true);
      }
      return ev(false);
    }

    case 'every': {
      for (let i = 0; i < arr.length; i++) {
        tick(m, node);
        const element = arrayElement(m, base, i);
        const result = callCallback(m, node, args[0] as Ev, [element, ev(i), ev(arr, base.p)], 'every');
        if (!predicatePasses(result)) return ev(false);
      }
      return ev(true);
    }

    case 'includes': {
      const search = args.length > 0 ? args[0]?.v : undefined;
      let from = 0;
      if (args.length > 1 && args[1]?.v !== undefined) from = toIntegerOrInfinity(numericArg(node, args[1]?.v));
      if (from < 0) from = Math.max(arr.length + from, 0);
      for (let i = from; i < arr.length; i++) if (arr[i] === search || (arr[i] !== arr[i] && search !== search)) return ev(true);
      return ev(false);
    }

    case 'indexOf': {
      const search = args.length > 0 ? args[0]?.v : undefined;
      let from = 0;
      if (args.length > 1 && args[1]?.v !== undefined) from = toIntegerOrInfinity(numericArg(node, args[1]?.v));
      if (from < 0) from = Math.max(arr.length + from, 0);
      for (let i = from; i < arr.length; i++) if (arr[i] === search) return ev(i);
      return ev(-1);
    }

    case 'lastIndexOf': {
      const search = args.length > 0 ? args[0]?.v : undefined;
      let from = arr.length - 1;
      if (args.length > 1 && args[1]?.v !== undefined) from = toIntegerOrInfinity(numericArg(node, args[1]?.v));
      if (from < 0) from = arr.length + from;
      for (let i = Math.min(from, arr.length - 1); i >= 0; i--) if (arr[i] === search) return ev(i);
      return ev(-1);
    }

    case 'slice': {
      let start = args.length > 0 && args[0]?.v !== undefined ? toIntegerOrInfinity(numericArg(node, args[0]?.v)) : 0;
      let end = args.length > 1 && args[1]?.v !== undefined ? toIntegerOrInfinity(numericArg(node, args[1]?.v)) : arr.length;
      [start, end] = clampRange(start, end, arr.length);
      const values: unknown[] = [];
      const kids: (string | null)[] = [];
      for (let i = start; i < end; i++) {
        appendCapped(m, values, kids, arr[i], elementSourcePath(base, i));
      }
      return { v: values, p: null, kids };
    }

    case 'concat': {
      const values: unknown[] = [];
      const kids: (string | null)[] = [];
      for (let i = 0; i < arr.length; i++) appendCapped(m, values, kids, arr[i], elementSourcePath(base, i));
      for (const arg of args) {
        if (Array.isArray(arg.v)) {
          for (let i = 0; i < arg.v.length; i++) {
            appendCapped(m, values, kids, arg.v[i], elementSourcePath(arg, i));
          }
        } else {
          appendCapped(m, values, kids, arg.v, arg.p);
        }
      }
      return { v: values, p: null, kids };
    }

    case 'join': {
      const separator = args.length > 0 && args[0]?.v !== undefined ? display(args[0]?.v) : ',';
      let out = '';
      for (let i = 0; i < arr.length; i++) {
        if (i > 0) out += separator;
        const item = arr[i];
        out += item === null || item === undefined ? '' : display(item);
      }
      return ev(clampString(m, out));
    }

    case 'flat': {
      const depth = args.length > 0 && args[0]?.v !== undefined ? toIntegerOrInfinity(numericArg(node, args[0]?.v)) : 1;
      const values: unknown[] = [];
      const kids: (string | null)[] = [];
      flattenInto(m, node, base, depth, values, kids);
      return { v: values, p: null, kids };
    }

    case 'at': {
      let index = args.length > 0 ? toIntegerOrInfinity(numericArg(node, args[0]?.v)) : 0;
      if (index < 0) index = arr.length + index;
      if (index < 0 || index >= arr.length) return ev(undefined);
      return arrayElement(m, base, index);
    }

    case 'reduce': {
      const hasInitial = args.length >= 2;
      if (!hasInitial && arr.length === 0) raise(node, 'EVAL_ILLEGAL_CALL', ['reduce']);
      let accumulator: unknown;
      let accumulatorPath: string | null;
      let start: number;
      if (hasInitial) {
        accumulator = args[1]?.v;
        accumulatorPath = args[1]?.p ?? null;
        start = 0;
      } else {
        const first = arrayElement(m, base, 0);
        accumulator = first.v;
        accumulatorPath = first.p;
        start = 1;
      }
      for (let i = start; i < arr.length; i++) {
        tick(m, node);
        const element = arrayElement(m, base, i);
        const result = callCallback(m, node, args[0] as Ev, [ev(accumulator, accumulatorPath), element, ev(i), ev(arr, base.p)], 'reduce');
        accumulator = result.v;
        accumulatorPath = result.p;
      }
      return { v: accumulator, p: accumulatorPath };
    }

    default:
      raise(node, 'EVAL_ILLEGAL_CALL', [name]);
  }
}

function flattenInto(m: Machine, node: AstNode, base: Ev, depth: number, values: unknown[], kids: (string | null)[]): void {
  const arr = base.v as unknown[];
  for (let i = 0; i < arr.length; i++) {
    tick(m, node);
    const path = elementSourcePath(base, i);
    const value = arr[i];
    if (path !== null && isDocumentContainer(value)) m.origins.objects.set(value, path);
    if (depth > 0 && Array.isArray(value)) {
      flattenInto(m, node, { v: value, p: path }, depth - 1, values, kids);
      continue;
    }
    appendCapped(m, values, kids, value, path);
  }
}

/* ------------------------------ 字符串方法实现 ------------------------------ */

function stringMethodCall(m: Machine, node: AstNode, base: Ev, name: string, args: Ev[]): Ev {
  const text = base.v as string;
  const argAt = (index: number): unknown => (args.length > index ? args[index]?.v : undefined);

  switch (name) {
    case 'includes': {
      const position = args.length > 1 && argAt(1) !== undefined ? Math.trunc(numericArg(node, argAt(1))) : 0;
      return ev(text.includes(display(argAt(0)), position));
    }
    case 'startsWith': {
      const position = args.length > 1 && argAt(1) !== undefined ? Math.trunc(numericArg(node, argAt(1))) : 0;
      return ev(text.startsWith(display(argAt(0)), position));
    }
    case 'endsWith': {
      const endPosition = args.length > 1 && argAt(1) !== undefined ? Math.trunc(numericArg(node, argAt(1))) : text.length;
      return ev(text.endsWith(display(argAt(0)), endPosition));
    }
    case 'indexOf': {
      const position = args.length > 1 && argAt(1) !== undefined ? Math.trunc(numericArg(node, argAt(1))) : 0;
      return ev(text.indexOf(display(argAt(0)), position));
    }
    case 'slice': {
      const start = args.length > 0 && argAt(0) !== undefined ? numericArg(node, argAt(0)) : 0;
      const end = args.length > 1 && argAt(1) !== undefined ? numericArg(node, argAt(1)) : undefined;
      const result = end === undefined ? text.slice(start) : text.slice(start, end);
      return ev(clampString(m, result));
    }
    case 'toUpperCase':
      return ev(clampString(m, text.toUpperCase()));
    case 'toLowerCase':
      return ev(clampString(m, text.toLowerCase()));
    case 'trim':
      return ev(clampString(m, text.trim()));
    case 'split': {
      const separator = argAt(0);
      // 只接受字符串 / 省略（无正则参数 → 无 ReDoS 面）。
      if (separator !== undefined && typeof separator !== 'string') raise(node, 'EVAL_ILLEGAL_CALL', ['split']);
      const limit = args.length > 1 && argAt(1) !== undefined ? Math.trunc(numericArg(node, argAt(1))) : undefined;
      const parts = separator === undefined ? [text] : limit === undefined ? text.split(separator) : text.split(separator, limit);
      const values: unknown[] = [];
      const kids: (string | null)[] = [];
      for (const part of parts) appendCapped(m, values, kids, part, null);
      return { v: values, p: null, kids };
    }
    case 'replace': {
      const pattern = argAt(0);
      const replacement = argAt(1);
      // 只接受字符串参数（拒绝正则语义 → 无 ReDoS）。
      if (typeof pattern !== 'string' || typeof replacement !== 'string') {
        raise(node, 'EVAL_ILLEGAL_CALL', ['replace']);
      }
      return ev(clampString(m, text.replace(pattern, replacement)));
    }
    case 'charAt': {
      const index = args.length > 0 ? Math.trunc(numericArg(node, argAt(0))) : 0;
      return ev(text.charAt(index));
    }
    case 'substring': {
      const start = args.length > 0 && argAt(0) !== undefined ? Math.trunc(numericArg(node, argAt(0))) : 0;
      const end = args.length > 1 && argAt(1) !== undefined ? Math.trunc(numericArg(node, argAt(1))) : undefined;
      const result = end === undefined ? text.substring(start) : text.substring(start, end);
      return ev(clampString(m, result));
    }
    default:
      raise(node, 'EVAL_ILLEGAL_CALL', [name]);
  }
}

/* ------------------------------ 方法分派入口 ------------------------------ */

function callMethod(m: Machine, node: AstNode, base: Ev, name: string, args: Ev[]): Ev {
  if (Array.isArray(base.v)) {
    if (!isArrayMethod(name)) raise(node, 'EVAL_SHAPE_ERROR', ['base-kind']);
    return arrayMethodCall(m, node, base, name, args);
  }
  if (typeof base.v === 'string') {
    if (!isStringMethod(name)) raise(node, 'EVAL_SHAPE_ERROR', ['base-kind']);
    return stringMethodCall(m, node, base, name, args);
  }
  raise(node, 'EVAL_SHAPE_ERROR', ['base-kind']);
}

function callConverter(m: Machine, node: AstNode, name: string, args: Ev[]): Ev {
  const value = args.length > 0 ? args[0]?.v : undefined;
  if (name === 'Number') return ev(args.length > 0 ? toNumberValue(value) : 0);
  if (name === 'String') return ev(args.length > 0 ? clampString(m, display(value)) : '');
  if (name === 'Boolean') return ev(args.length > 0 ? truthy(value) : false);
  raise(node, 'EVAL_ILLEGAL_CALL', [name]);
}

function evalCallExpression(m: Machine, node: AstNode, env: Env): Ev {
  const callee = asNodeOrRaise(node.callee, node);

  // 1) 箭头函数立即调用：`(x => x + 1)(1)`。
  if (callee.type === 'ArrowFunctionExpression') {
    // 走 evalNode：与「箭头作为回调实参」同一计步口径（每个 AST 节点 +1）。
    const closureEv = evalNode(m, callee, env);
    const args = evalArguments(m, node, env);
    return finishCall(m, node, closureEv, args, '<arrow>');
  }

  // 2) 白名单全局转换函数：Number/String/Boolean(...)（词法作用域参数可遮蔽）。
  if (callee.type === 'Identifier') {
    const name = String(callee.name);
    const args = evalArguments(m, node, env);
    const sentinel = argumentSentinel(args);
    if (sentinel !== null) return sentinel;
    const shadow = lookup(env, name);
    if (shadow !== undefined) return finishCall(m, node, { v: shadow.v, p: shadow.p }, args, name);
    if (name === 'Number' || name === 'String' || name === 'Boolean') {
      return callConverter(m, node, name, args);
    }
    raise(node, 'STATIC_ERR_CALL', [name]);
  }

  // 3) 成员方法 / 全局命名空间成员。
  if (callee.type === 'MemberExpression') {
    const receiver = evalNode(m, asNodeOrRaise(callee.object, callee), env);
    if (receiver.v === SHORT) return SHORT_EV;
    // 调用短路：`a?.b()`（callee.optional）或 `a?.()`（node.optional）。
    const optionalLink = callee.optional === true || node.optional === true;
    if (optionalLink && (receiver.v === undefined || receiver.v === null)) return SHORT_EV;
    if (receiver.v === MISSING) return MISSING_EV;

    let name: string;
    if (callee.computed === true) {
      const keyResult = evalNode(m, asNodeOrRaise(callee.property, callee), env);
      if (keyResult.v === SHORT) return SHORT_EV;
      if (keyResult.v === MISSING) return MISSING_EV;
      name = toPropertyKey(callee, keyResult.v);
    } else {
      const staticName = staticMemberName(callee);
      if (staticName === null) raise(node, 'STATIC_ERR_CALL', ['[]']);
      name = staticName;
    }

    const args = evalArguments(m, node, env);
    const sentinel = argumentSentinel(args);
    if (sentinel !== null) return sentinel;
    if (isNamespace(receiver.v)) return namespaceCall(m, node, receiver.v, name, args);
    return callMethod(m, node, receiver, name, args);
  }

  raise(node, 'STATIC_ERR_CALL', ['<expr>']);
}

/** 实参里的 SHORT / MISSING 哨兵传播（实参缺失时整个调用也是 MISSING）。 */
function argumentSentinel(args: Ev[]): Ev | null {
  for (const arg of args) {
    if (arg.v === SHORT) return SHORT_EV;
    if (arg.v === MISSING) return MISSING_EV;
  }
  return null;
}

/** 处理实参哨兵后调用一个可调用值。 */
function finishCall(m: Machine, node: AstNode, callable: Ev, args: Ev[], name: string): Ev {
  const sentinel = argumentSentinel(args);
  if (sentinel !== null) return sentinel;
  if (!isClosure(callable.v)) raise(node, 'EVAL_ILLEGAL_CALL', [name]);
  return callClosure(m, callable.v, args);
}

/* --------------------------------- 主分派 --------------------------------- */

function evalNode(m: Machine, node: AstNode, env: Env): Ev {
  tick(m, node);
  switch (node.type) {
    case 'Identifier':
      return evalIdentifier(m, node, env);
    case 'Literal':
      return evalLiteral(m, node);
    case 'TemplateLiteral':
      return evalTemplateLiteral(m, node, env);
    case 'ArrayExpression':
      return evalArrayExpression(m, node, env);
    case 'ObjectExpression':
      return evalObjectExpression(m, node, env);
    case 'MemberExpression':
      return evalMemberExpression(m, node, env);
    case 'ChainExpression':
      return evalChainExpression(m, node, env);
    case 'CallExpression':
      return evalCallExpression(m, node, env);
    case 'ArrowFunctionExpression':
      return evalArrowFunction(node, env);
    case 'BinaryExpression':
      return evalBinaryExpression(m, node, env);
    case 'LogicalExpression':
      return evalLogicalExpression(m, node, env);
    case 'UnaryExpression':
      return evalUnaryExpression(m, node, env);
    case 'ConditionalExpression':
      return evalConditionalExpression(m, node, env);
    default:
      raise(node, 'STATIC_ERR_NODE', [node.type]);
  }
}

/* ------------------------------- 结果归一化 ------------------------------- */

function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'null';
  }
}

/** 结果纯 JSON 化：MISSING/undefined 省略，非有限数字 → null，文档容器 identity 不变。 */
function sanitize(m: Machine, value: unknown): unknown {
  if (value === undefined || value === MISSING || value === SHORT) return undefined;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value as number) ? value : null;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'symbol' || type === 'bigint') return null;
  if (type !== 'object') return null;

  const object = value as object;
  // 原样引用的文档容器：不复制、不改写（元素引用不复制）。
  if (m.origins.objects.has(object)) return object;
  if (isNamespace(value) || isConverter(value) || isMethodRef(value) || isClosure(value)) return null;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const sanitized = sanitize(m, item);
      if (sanitized !== undefined) out.push(sanitized);
    }
    return out;
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const sanitized = sanitize(m, source[key]);
    if (sanitized !== undefined) defineOwn(out, key, sanitized);
  }
  return out;
}

/** 结果顶层子项来源：产出容器用 kids；文档容器交给 origins.objects。 */
function buildTop(root: Ev, value: unknown): (string | null)[] | Record<string, string | null> {
  if (Array.isArray(value)) {
    if (Array.isArray(root.kids)) {
      const out: (string | null)[] = [];
      for (let i = 0; i < value.length; i++) {
        const path = root.kids[i];
        out.push(path === undefined ? null : path);
      }
      return out;
    }
    return [];
  }
  if (typeof value === 'object' && value !== null) {
    if (root.kids !== undefined && !Array.isArray(root.kids)) {
      const source = root.kids as Record<string, string | null>;
      const out: Record<string, string | null> = {};
      for (const key of Object.keys(value)) out[key] = Object.hasOwn(source, key) ? (source[key] as string | null) : null;
      return out;
    }
    return {};
  }
  return [];
}

/* --------------------------------- 计数 --------------------------------- */

/**
 * 全量统计文档节点数（迭代式；文档无环）。
 *
 * 口径：**JSON 值节点数**（根 + 每个对象属性值 + 每个数组元素）。标量 1、空容器 1、
 * `{a:1}` 2、`[1,2,3]` 4。用于 `exprBudget(level, nodeCount)` 的步数兜底与 `JSON.parse` 尺寸检查，
 * 惰性一次后由 doc-service 按根对象缓存（本函数本身无缓存、纯函数）。
 */
export function countDocumentNodes(root: unknown): number {
  if (root === undefined) return 0;
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    count += 1;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) stack.push(value[i]);
    } else if (isPlainObject(value)) {
      for (const key of Object.keys(value)) stack.push(value[key]);
    }
  }
  return count;
}

/* ---------------------------------- 入口 ---------------------------------- */

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/**
 * 对已通过 validate 的 AST 求值（同步；预算三刹车在内部）。
 *
 * 失败返回 `{ok:false, error}`（引擎级失败是正常回包，不是 CoreError）。
 */
export function runExpression(ast: unknown, docRoot: unknown, opts: EvaluateOptions): EvalOutcome {
  const now = opts.now ?? defaultNow;
  const machine: Machine = {
    docRoot,
    strict: opts.strict,
    budget: opts.budget,
    now,
    start: now(),
    steps: 0,
    truncated: false,
    skipped: 0,
    origins: { top: [], objects: new WeakMap<object, string>() },
  };

  try {
    const program = asNode(ast);
    if (!program || program.type !== 'Program') {
      return { ok: false, error: { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] } };
    }
    const body = Array.isArray(program.body) ? program.body : [];
    const statement = asNode(body[0]);
    if (!statement || statement.type !== 'ExpressionStatement') {
      return { ok: false, error: { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] } };
    }
    const expression = asNodeOrRaise(statement.expression, statement);

    const rootEnv: Env = { vars: new Map(), parent: null, depth: 0 };
    let root = evalNode(machine, expression, rootEnv);
    if (root.v === SHORT) root = ev(undefined);

    let value = sanitize(machine, root.v);
    if (value === undefined) value = null;
    if (typeof value === 'string' && value.length > machine.budget.maxResult) {
      value = value.slice(0, machine.budget.maxResult);
      machine.truncated = true;
    }
    // 结果根容器（含原样引用的文档容器）：超过 maxResult → 截断并置位。
    const capped = capFinalContainer(machine, root, value);
    value = capped.value;

    const kind = kindOf(value);
    const count =
      kind === 'array' ? (value as unknown[]).length : kind === 'object' ? Object.keys(value as object).length : 0;
    const top = capped.top !== null ? capped.top : buildTop(root, value);

    return {
      ok: true,
      value,
      kind,
      count,
      steps: machine.steps,
      ms: machine.now() - machine.start,
      truncated: machine.truncated,
      skipped: machine.skipped,
      origins: { top, objects: machine.origins.objects },
    };
  } catch (err) {
    if (err instanceof EvalFailure) return { ok: false, error: err.error };
    if (err instanceof RangeError) {
      return { ok: false, error: { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] } };
    }
    // 兜底：引擎 bug 不该把 worker 弄崩（ADR：失败走正常回包）。
    return { ok: false, error: { code: 'EVAL_ILLEGAL_CALL', params: ['internal'] } };
  }
}
