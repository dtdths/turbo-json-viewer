/**
 * core/expression/whitelist — 表达式子集的**单一来源**（ADR-0018 §3 / #3 §7 / #14 §1.4）。
 *
 * 为什么集中在这一份表：
 * - 引擎（validate / walk）与补全（complete）必须「提示什么 == 允许调什么」，任何一侧漂移都会
 *   出现「补全给了却执行报错」或反过来的体验；#3 §5.2 明确要求同表。
 * - 默认拒绝（default-deny）：不在 `EXPR_NODE_TYPES` 里的 AST 节点一律拒绝，因此「表里没写的
 *   语法 = 不支持」，即使 acorn 能解析（acorn 只是 parser，不负责子集）。
 *
 * 注意 `length`：它是数组/字符串的**属性**而不是方法，所以不在 `ARRAY_METHODS` / `STRING_METHODS`
 * 里；补全时单独追加（见 `complete.ts`）。
 *
 * 错误 `params` 约定（ADR-0018 §5 + Lead 2026-11-10 定稿，validate/walk 共同遵守）：
 * - 节点类型不在白名单 → `[nodeType]`（如 `'AssignmentExpression'`）；
 * - 运算符被拒 → `[operator]`（如 `'=='` / `'**'` / `'delete'` / `'void'` / `'&'`）；
 * - 调用点非法 → `[calleeName]`（能取到属性名取属性名；取不到用 `'[]'` / `'<expr>'`）；
 * - 正则字面量 → `['RegExpLiteral']`；BigInt 字面量（`123n`）自 ADR-0020 起允许（不再拒绝）。
 */

/** 数组只读方法 15（#14 §1.1：变异方法 push/sort/splice/pop/reverse 一律不进）。 */
export const ARRAY_METHODS: readonly string[] = [
  'map',
  'filter',
  'find',
  'findIndex',
  'some',
  'every',
  'includes',
  'indexOf',
  'lastIndexOf',
  'slice',
  'concat',
  'join',
  'flat',
  'at',
  'reduce',
];

/**
 * 数组**单参数回调**方法（回调参数 = 元素）：只用于补全的回调参数绑定（ADR-0025 修订 2026-11-13）。
 * 必须是 `ARRAY_METHODS` 的**子集**（单测钉住，避免「补全给了却执行报错」）；不含 `reduce`
 * （累加器语义）与引擎不支持的 `forEach` / `flatMap`。
 */
export const ELEMENT_CALLBACK_METHODS: readonly string[] = ['map', 'filter', 'find', 'findIndex', 'some', 'every'];

/** 字符串只读方法 12（#3 §5.2；无正则参数 → 无 ReDoS 面）。`length` 是属性，另列。 */
export const STRING_METHODS: readonly string[] = [
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'slice',
  'toUpperCase',
  'toLowerCase',
  'trim',
  'split',
  'replace',
  'charAt',
  'substring',
];

/** Math 白名单成员 11（ADR-0018「已知差距」口径）。 */
export const MATH_MEMBERS: readonly string[] = [
  'abs',
  'ceil',
  'floor',
  'round',
  'trunc',
  'max',
  'min',
  'pow',
  'sqrt',
  'sign',
  'log',
];

/**
 * 全局命名白名单 7（标识符解析时**优先于文档根 own property**：`Math` 永远是 Math）。
 * 其中可调用：`Number/String/Boolean(...)`；命名空间成员：`Math.* / Array.isArray / JSON.parse|stringify`。
 */
export const GLOBAL_NAMES: readonly string[] = [
  'Math',
  'Array',
  'JSON',
  'Number',
  'String',
  'Boolean',
  'undefined',
];

/** 属性名 `length`（数组/字符串共有；不是方法）。 */
export const LENGTH_PROP = 'length';

const arraySet: ReadonlySet<string> = new Set(ARRAY_METHODS);
const stringSet: ReadonlySet<string> = new Set(STRING_METHODS);
const mathSet: ReadonlySet<string> = new Set(MATH_MEMBERS);
const globalSet: ReadonlySet<string> = new Set(GLOBAL_NAMES);

export function isArrayMethod(name: string): boolean {
  return arraySet.has(name);
}

export function isStringMethod(name: string): boolean {
  return stringSet.has(name);
}

export function isMathMember(name: string): boolean {
  return mathSet.has(name);
}

/** 是否全局白名单名（Math / Array / JSON / Number / String / Boolean / undefined）。 */
export function isGlobalName(name: string): boolean {
  return globalSet.has(name);
}

/**
 * AST 节点类型白名单（17 项；#14 §1.1 原型口径 + `SpreadElement` 展开符）。
 *
 * `ChainExpression` 必须显式在表内：acorn 把整个 `a?.b` 包成 ChainExpression，
 * 漏掉它会把合法可选链误杀成 STATIC_ERR_NODE（#3 §7 实测陷阱）。
 */
export const EXPR_NODE_TYPES: ReadonlySet<string> = new Set([
  'Program',
  'ExpressionStatement',
  'Identifier',
  'Literal',
  'TemplateLiteral',
  'TemplateElement',
  'ArrayExpression',
  'ObjectExpression',
  'Property',
  'SpreadElement',
  'MemberExpression',
  'ChainExpression',
  'CallExpression',
  'ArrowFunctionExpression',
  'BinaryExpression',
  'LogicalExpression',
  'UnaryExpression',
  'ConditionalExpression',
]);

/** 二元运算符白名单（无 `==`/`!=`、无位运算、无 `**`、无 `in`/`instanceof`）。 */
export const BINARY_OPERATORS: ReadonlySet<string> = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '<=',
  '>',
  '>=',
  '===',
  '!==',
]);

/** 逻辑运算符白名单（`&&` / `||` / `??`）。 */
export const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(['&&', '||', '??']);

/** 一元运算符白名单（`-` / `!` / `typeof` / `+`；`delete`/`void`/`~` 拒绝）。 */
export const UNARY_OPERATORS: ReadonlySet<string> = new Set(['-', '!', 'typeof', '+']);
