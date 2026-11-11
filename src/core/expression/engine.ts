/**
 * core/expression/engine — 引擎门面：`parse → validate → walk`（ADR-0018 §3）。
 *
 * 调用方（worker 侧 doc-service）只需要这一个入口 + `countDocumentNodes`：
 * - `evaluateExpression` 同步执行，返回 `EvalOutcome`（成功 = 纯 JSON 值 + 预算标记；
 *   失败 = `{ok:false,error}` 正常回包，不抛 CoreError）。
 * - `countDocumentNodes` 供 `exprBudget(level, nodeCount)` 的步数兜底使用；本函数无缓存，
 *   缓存（按根对象 WeakMap）由 doc-service 负责。
 *
 * 这里只负责「总耗时」：`EvalOk.ms` 按 ADR 口径包含 parse + validate + walk。
 */
import type { EvalOutcome, EvaluateOptions } from './types';
import { parseExpression } from './parse';
import { validateAst } from './validate';
import { runExpression } from './walk';

export { countDocumentNodes } from './walk';

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/**
 * 求值一条表达式（同步；调用方负责放进 worker 与看门狗之下）。
 *
 * @param text 用户输入（≤ EXPR_TEXT_MAX）
 * @param docRoot 文档根值（worker 常驻，零拷贝读取）
 * @param opts strict / budget / 可注入假时钟
 */
export function evaluateExpression(text: string, docRoot: unknown, opts: EvaluateOptions): EvalOutcome {
  const clock = opts.now ?? defaultNow;
  const start = clock();

  const parsed = parseExpression(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const invalid = validateAst(parsed.ast);
  if (invalid) return { ok: false, error: invalid };

  const outcome = runExpression(parsed.ast, docRoot, opts);
  if (outcome.ok) {
    // 用同一个时钟补上 parse + validate 的耗时（假时钟下仍确定性）。
    outcome.ms = clock() - start;
  }
  return outcome;
}
