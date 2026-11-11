/**
 * core/expression/types — 表达式引擎的**模块内**类型（ADR-0018 §3）。
 *
 * 与 `protocol/types.ts` 的区别：protocol 只放 structured-clone-safe 的跨线程形状；
 * 这里的 originate 映射（WeakMap）**只在 worker 内**存在，永不跨线程。
 */
import type { ExprBudgetLevel, ExprCompletion, ExprError, JsonKind } from '../../protocol/types';

/** 一次求值的实际预算（由 `protocol/versions.ts` 的 `exprBudget()` 换算）。 */
export interface EvalBudget {
  level: ExprBudgetLevel;
  maxTimeMs: number;
  maxSteps: number;
  maxResult: number;
}

/**
 * 结果来源映射（ADR-0018 §4.3）：用于「结果行 → 原文档路径」跳转，只在 worker 保留。
 *
 * - `top`：结果**顶层**子项的来源路径（数组按下标 / 对象按键；`null` = 计算值无来源）。
 *   标量元素（如 `items.map(x => x.name)` 产出的字符串）没有对象身份，只能靠这张表定位。
 * - `objects`：结果中**引用到的原文档容器** → 规范路径（元素引用不复制）。嵌套行优先用最深的
 *   已知容器来源 + 相对后缀还原。
 */
export interface EvalOrigins {
  top: (string | null)[] | Record<string, string | null>;
  objects: WeakMap<object, string>;
}

/** 求值成功：结果是纯 JSON 值 + 预算标记（确定性：同输入同预算同结果）。 */
export interface EvalOk {
  ok: true;
  value: unknown;
  kind: JsonKind;
  /** 结果顶层子项数（标量 = 0） */
  count: number;
  /** 解释器步数（每个 AST 节点 +1；数组方法每处理一个元素 +1） */
  steps: number;
  /** 引擎内计时（ms） */
  ms: number;
  /** 结果 / 中间容器被 `maxResult` 截断 */
  truncated: boolean;
  /** 严格模式关闭时，元素内部缺字段被跳过（省略）的条数 */
  skipped: number;
  origins: EvalOrigins;
}

export type EvalOutcome = EvalOk | { ok: false; error: ExprError };

/** 求值入口（同步；调用方负责放进 worker 与看门狗之下）。 */
export interface EvaluateOptions {
  /** 严格模式：元素内部缺字段直接报错（默认 false） */
  strict: boolean;
  budget: EvalBudget;
  /** 计时函数（单测可注入假时钟；缺省用 `performance.now`） */
  now?: () => number;
}

/** 静态补全上下文（由 doc-service 从文档根值抽取；不传整棵文档）。 */
export interface CompletionContext {
  /** 文档根顶层字段名（对象键序；根为数组时为空） */
  rootKeys: string[];
  /** 根字段类型（可选，仅用于 `detail` 文案） */
  rootKinds?: Record<string, JsonKind>;
}

export type { ExprCompletion };
