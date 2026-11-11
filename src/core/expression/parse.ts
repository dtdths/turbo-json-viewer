/**
 * core/expression/parse — acorn 封装（ADR-0018 §3）。
 *
 * 只做四件事，**不做语义校验**（那是 validate 的职责）：
 * 1. 文本长度上限 `EXPR_TEXT_MAX`（解析前拦截，避免长文本进 acorn）；
 * 2. `ecmaVersion:'latest'` + `locations:true` 解析；
 * 3. AST 深度上限 `EXPR_AST_DEPTH_MAX`（解析后迭代测量，防解释器递归爆栈）；
 * 4. 错误转码：acorn 的 `err.pos` / `err.loc` → `PARSE_ERR_SYNTAX`；栈溢出 / 超深 → `PARSE_ERR_ROOT_SHAPE`。
 *
 * acorn 只允许出现在 `src/core/expression/` 内（这个目录只会被 worker 侧 doc-service 引用），
 * 因此首屏不背 57KB gz。错误对象是 `ExprError`（引擎级失败走正常回包），不是 CoreError。
 */
import { parse } from 'acorn';
import { EXPR_AST_DEPTH_MAX, EXPR_TEXT_MAX } from '../../protocol/versions';
import type { ExprError } from '../../protocol/types';

/** 解析成功 / 失败的判别联合（`engine.ts` 门面第一步）。 */
export type ParseResult = { ok: true; ast: unknown } | { ok: false; error: ExprError };

/** 判断任意值是否 ESTree 节点（对象且 `type` 为字符串；loc / literal.value 不是）。 */
function isAstNode(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * 迭代式测 AST 最大深度（根 Program = 1）。
 *
 * 用显式栈而不是递归：这个函数本身就是「防递归爆栈」的一环，自己递归就失去意义。
 * 只遍历 `.type` 为字符串的对象（acorn 的 `loc.start` / Literal 的 `value` 会被跳过）。
 */
export function measureAstDepth(ast: unknown): number {
  if (!isAstNode(ast)) return 0;
  type Frame = { node: unknown; depth: number };
  const stack: Frame[] = [{ node: ast, depth: 1 }];
  let max = 0;
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const node = frame.node as Record<string, unknown>;
    if (frame.depth > max) max = frame.depth;
    const keys = Object.keys(node);
    for (const key of keys) {
      const child = node[key];
      if (isAstNode(child)) {
        stack.push({ node: child, depth: frame.depth + 1 });
      } else if (Array.isArray(child)) {
        for (const item of child) {
          if (isAstNode(item)) stack.push({ node: item, depth: frame.depth + 1 });
        }
      }
    }
  }
  return max;
}

/** acorn 的 SyntaxError 形态（类型包不自带 pos/loc 的精确声明，这里收窄）。 */
interface AcornSyntaxError extends SyntaxError {
  pos?: number;
  loc?: { line: number; column: number };
}

/**
 * 解析一条表达式文本。
 *
 * 错误定位口径（ADR-0018 §2）：`line` 1-based（acorn 原生），`column` 1-based（acorn 原生 0-based，+1 换算）。
 */
export function parseExpression(text: string): ParseResult {
  const source = typeof text === 'string' ? text : '';

  if (source.length > EXPR_TEXT_MAX) {
    return { ok: false, error: { code: 'PARSE_ERR_ROOT_SHAPE', params: ['text-length'] } };
  }

  let ast: unknown;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      locations: true,
      sourceType: 'script',
      // 子集只允许单表达式，函数体外 return / 顶层 await 都不进语法面。
      allowReturnOutsideFunction: false,
      allowAwaitOutsideFunction: false,
    });
  } catch (err) {
    if (err instanceof RangeError) {
      // acorn 自身递归栈被打爆（超深嵌套）——归到「表达式过深/过复杂」。
      return { ok: false, error: { code: 'PARSE_ERR_ROOT_SHAPE', params: ['root-shape'] } };
    }
    const syntax = err as AcornSyntaxError;
    const error: ExprError = {
      code: 'PARSE_ERR_SYNTAX',
      params: [typeof syntax.message === 'string' ? syntax.message : 'syntax error'],
    };
    if (syntax.loc) {
      error.line = syntax.loc.line;
      error.column = syntax.loc.column + 1;
    }
    return { ok: false, error };
  }

  const depth = measureAstDepth(ast);
  if (depth > EXPR_AST_DEPTH_MAX) {
    return { ok: false, error: { code: 'PARSE_ERR_ROOT_SHAPE', params: ['depth'] } };
  }

  return { ok: true, ast };
}
