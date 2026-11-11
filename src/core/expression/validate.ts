/**
 * core/expression/validate — 静态白名单（default-deny）+ 调用点检查（ADR-0018 §3）。
 *
 * 不变量：
 * - **默认拒绝**：节点类型不在 `EXPR_NODE_TYPES` 里一律 `STATIC_ERR_NODE`；因此「表里没写的
 *   语法 = 不支持」，即使 acorn 解析得出来（赋值 / 循环 / new / 块体箭头 / 正则…）。
 * - **调用点理解接收者**：#14 §0 的两个真实陷阱——
 *   ① 属性名在方法白名单里会误杀 `Math.max(...)`（max 不是数组/字符串方法）→ 需要「全局命名空间
 *      接收者」规则；② 可选链外层是 `ChainExpression`，白名单必须显式包含它，否则合法 `a?.b` 被误杀。
 * - **深度重查**：parse 已测一次；这里按同口径再兜一次（本函数也可能被单独调用）。
 * - 只返回**第一个**错误（行内错误定位只需要一个），并带 1-based 行列。
 *
 * 错误 `params` 约定（Lead 2026-11-10 定稿）：节点类型不在白名单 → `[nodeType]`；
 * 被拒运算符 → `[operator]`；调用点非法 → `[calleeName]`（取不到属性名用 `'[]'` / `'<expr>'`）；
 * 正则 / BigInt 字面量 → `['RegExpLiteral']` / `['BigIntLiteral']`。`code` 严格按 ADR-0018 §5。
 */
import type { ExprError } from '../../protocol/types';
import { EXPR_AST_DEPTH_MAX } from '../../protocol/versions';
import {
  BINARY_OPERATORS,
  EXPR_NODE_TYPES,
  GLOBAL_NAMES,
  isArrayMethod,
  isMathMember,
  isStringMethod,
  LOGICAL_OPERATORS,
  UNARY_OPERATORS,
} from './whitelist';

type AstNode = { type: string } & Record<string, unknown>;

function asNode(value: unknown): AstNode | null {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
    ? (value as AstNode)
    : null;
}

/** 节点 1-based 行列（ESTree 的 loc.start 是 0-based column）。 */
export function nodeLocation(node: AstNode): { line: number; column: number } | null {
  const loc = node.loc as { start?: { line?: number; column?: number } } | undefined;
  const start = loc?.start;
  if (!start || typeof start.line !== 'number' || typeof start.column !== 'number') return null;
  return { line: start.line, column: start.column + 1 };
}

interface Fail {
  code: ExprError['code'];
  params: (string | number)[];
  candidates?: string[];
  node: AstNode;
}

/** 抛错前的统一构造：把当前节点 loc 带上。 */
function failWith(fail: Fail): ExprError {
  const error: ExprError = { code: fail.code, params: fail.params };
  const loc = nodeLocation(fail.node);
  if (loc) {
    error.line = loc.line;
    error.column = loc.column;
  }
  if (fail.candidates) error.candidates = fail.candidates;
  return error;
}

/** 成员属性名（非 computed 取 Identifier；computed 取字面量 key）；取不到 → null。 */
function staticPropertyName(node: AstNode): string | null {
  const prop = asNode(node.property);
  if (!prop) return null;
  if (!node.computed) {
    if (prop.type === 'Identifier' && typeof prop.name === 'string') return prop.name;
    return null;
  }
  if (prop.type === 'Literal') {
    const value = prop.value;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

/** 调用点非法（STATIC_ERR_CALL）：能取到属性名就取属性名。 */
function illegalCallee(node: AstNode, calleeName: string): Fail {
  return { code: 'STATIC_ERR_CALL', params: [calleeName], node };
}

/** 调用点的静态检查（默认拒绝；只放行 ADR-0018 §3 列出的三类 callee）。 */
function checkCall(node: AstNode): ExprError | null {
  const callee = asNode(node.callee);
  if (!callee) return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'], node });

  if (callee.type === 'ArrowFunctionExpression') {
    // 立即调用箭头函数：`(x => x + 1)(1)`。箭头自身的合法性由主遍历检查。
    return null;
  }

  if (callee.type === 'Identifier') {
    const name = typeof callee.name === 'string' ? callee.name : '';
    // 只允许白名单全局转换函数；Math/Array/JSON 不是「直接可调用」，undefined 更不是。
    if (name === 'Number' || name === 'String' || name === 'Boolean') return null;
    return failWith(illegalCallee(callee, name || '<expr>'));
  }

  if (callee.type === 'MemberExpression') {
    const name = staticPropertyName(callee);
    if (name === null) return failWith(illegalCallee(callee, '[]'));

    const receiver = asNode(callee.object);
    const receiverName =
      receiver && receiver.type === 'Identifier' && typeof receiver.name === 'string' ? receiver.name : null;

    // 全局命名空间接收者：`Math.*` / `Array.isArray` / `JSON.parse|stringify`。
    if (receiverName !== null && GLOBAL_NAMES.includes(receiverName)) {
      let allowed = false;
      if (receiverName === 'Math') allowed = isMathMember(name);
      else if (receiverName === 'Array') allowed = name === 'isArray';
      else if (receiverName === 'JSON') allowed = name === 'parse' || name === 'stringify';
      // Number / String / Boolean / undefined 没有白名单成员。
      if (!allowed) return failWith(illegalCallee(callee, name));
      return null;
    }

    // 普通成员方法：数组 15 / 字符串 12 的并集（运行时再按接收者类型分派）。
    if (isArrayMethod(name) || isStringMethod(name)) return null;
    return failWith(illegalCallee(callee, name));
  }

  // 其余 callee 形态（CallExpression 结果 / ChainExpression / MemberExpression 之外的表达式）不开放。
  return failWith(illegalCallee(callee, '<expr>'));
}

/**
 * 静态校验整个 AST。通过返回 `null`，否则返回带 1-based 行列的 `ExprError`。
 *
 * 迭代实现（显式栈）：深度上限只有 128，但「防递归」不该由递归的校验器自己承担。
 */
export function validateAst(ast: unknown): ExprError | null {
  const root = asNode(ast);
  if (!root || root.type !== 'Program') {
    return { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] };
  }
  const body = root.body;
  if (!Array.isArray(body) || body.length !== 1) {
    return { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] };
  }
  const statement = asNode(body[0]);
  if (!statement || statement.type !== 'ExpressionStatement') {
    return { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] };
  }
  const expression = asNode(statement.expression);
  if (!expression) return { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] };

  type Frame = { node: AstNode; depth: number };
  const stack: Frame[] = [{ node: expression, depth: 3 }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop() as Frame;
    if (depth > EXPR_AST_DEPTH_MAX) {
      return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['depth'], node });
    }

    if (!EXPR_NODE_TYPES.has(node.type)) {
      return failWith({ code: 'STATIC_ERR_NODE', params: [node.type], node });
    }

    switch (node.type) {
      case 'Identifier':
        break;

      case 'Literal': {
        if (node.regex !== undefined) {
          return failWith({ code: 'STATIC_ERR_NODE', params: ['RegExpLiteral'], node });
        }
        if (typeof node.bigint === 'string') {
          return failWith({ code: 'STATIC_ERR_NODE', params: ['BigIntLiteral'], node });
        }
        break;
      }

      case 'TemplateLiteral': {
        const expressions = node.expressions;
        if (Array.isArray(expressions)) {
          for (const item of expressions) {
            const child = asNode(item);
            if (!child) return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'], node });
            stack.push({ node: child, depth: depth + 1 });
          }
        }
        break;
      }

      case 'TemplateElement':
        break;

      case 'ArrayExpression': {
        const elements = node.elements;
        if (!Array.isArray(elements)) break;
        for (const item of elements) {
          if (item === null) continue; // 稀疏数组的空位：求值时按 undefined 省略
          const child = asNode(item);
          if (!child) return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'], node });
          stack.push({ node: child, depth: depth + 1 });
        }
        break;
      }

      case 'ObjectExpression': {
        const properties = node.properties;
        if (Array.isArray(properties)) {
          for (const item of properties) {
            const child = asNode(item);
            if (!child) return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'], node });
            stack.push({ node: child, depth: depth + 1 });
          }
        }
        break;
      }

      case 'Property': {
        // 只允许 data property（`{a: 1}` / 简写 `{a}`）；getter/setter/method 拒绝。
        if (node.kind !== 'init' || node.method === true) {
          return failWith({ code: 'STATIC_ERR_NODE', params: ['Property'], node });
        }
        const key = asNode(node.key);
        if (!key) return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'], node });
        stack.push({ node: key, depth: depth + 1 });
        const value = asNode(node.value);
        if (value) stack.push({ node: value, depth: depth + 1 });
        break;
      }

      case 'SpreadElement': {
        const argument = asNode(node.argument);
        if (argument) stack.push({ node: argument, depth: depth + 1 });
        break;
      }

      case 'MemberExpression': {
        const object = asNode(node.object);
        if (object) stack.push({ node: object, depth: depth + 1 });
        if (node.computed) {
          const property = asNode(node.property);
          if (property) stack.push({ node: property, depth: depth + 1 });
        }
        break;
      }

      case 'ChainExpression': {
        const inner = asNode(node.expression);
        if (inner) stack.push({ node: inner, depth: depth + 1 });
        break;
      }

      case 'CallExpression': {
        const callError = checkCall(node);
        if (callError) return callError;
        const callee = asNode(node.callee);
        if (callee) stack.push({ node: callee, depth: depth + 1 });
        const args = node.arguments;
        if (Array.isArray(args)) {
          for (const item of args) {
            const child = asNode(item);
            if (!child) return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'], node });
            stack.push({ node: child, depth: depth + 1 });
          }
        }
        break;
      }

      case 'ArrowFunctionExpression': {
        // 仅单表达式体 + 简单标识符参数（无解构 / 默认值）。
        if (node.async === true || node.generator === true) {
          return failWith({ code: 'STATIC_ERR_NODE', params: ['ArrowFunctionExpression'], node });
        }
        const params = node.params;
        if (Array.isArray(params)) {
          for (const item of params) {
            const param = asNode(item);
            if (!param || param.type !== 'Identifier') {
              return failWith({
                code: 'STATIC_ERR_NODE',
                params: [param ? param.type : 'Param'],
                node: param ?? node,
              });
            }
          }
        }
        const arrowBody = asNode(node.body);
        if (!arrowBody) return failWith({ code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'], node });
        if (arrowBody.type === 'BlockStatement') {
          return failWith({ code: 'STATIC_ERR_NODE', params: ['BlockStatement'], node: arrowBody });
        }
        stack.push({ node: arrowBody, depth: depth + 1 });
        break;
      }

      case 'BinaryExpression': {
        const operator = String(node.operator);
        if (!BINARY_OPERATORS.has(operator)) {
          return failWith({ code: 'STATIC_ERR_NODE', params: [operator], node });
        }
        pushPair(stack, node, depth);
        break;
      }

      case 'LogicalExpression': {
        const operator = String(node.operator);
        if (!LOGICAL_OPERATORS.has(operator)) {
          return failWith({ code: 'STATIC_ERR_NODE', params: [operator], node });
        }
        pushPair(stack, node, depth);
        break;
      }

      case 'UnaryExpression': {
        const operator = String(node.operator);
        if (!UNARY_OPERATORS.has(operator)) {
          return failWith({ code: 'STATIC_ERR_NODE', params: [operator], node });
        }
        const argument = asNode(node.argument);
        if (argument) stack.push({ node: argument, depth: depth + 1 });
        break;
      }

      case 'ConditionalExpression': {
        for (const key of ['test', 'consequent', 'alternate'] as const) {
          const child = asNode(node[key]);
          if (child) stack.push({ node: child, depth: depth + 1 });
        }
        break;
      }

      default:
        // EXPR_NODE_TYPES 内其它节点（Program/ExpressionStatement）不会出现在嵌套位置。
        return failWith({ code: 'STATIC_ERR_NODE', params: [node.type], node });
    }
  }

  return null;
}

/** Binary/Logical 共用的左右子节点入栈。 */
function pushPair(stack: { node: AstNode; depth: number }[], node: AstNode, depth: number): void {
  const left = asNode(node.left);
  const right = asNode(node.right);
  if (left) stack.push({ node: left, depth: depth + 1 });
  if (right) stack.push({ node: right, depth: depth + 1 });
}
