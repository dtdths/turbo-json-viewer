/**
 * shared/expression-copy — 表达式视图的中文文案**单一来源**（ADR-0018 §5）。
 *
 * 引擎只给 code + params；所有用户可见文案在这里组装（面板内联错误 / 结果条 / toast 共用）。
 * 中英对照表见 #12 spec §7（本轮不引 i18n，只留中文）。
 */
import type { ExprError, ExprErrorCode } from '../protocol/types';

/** 错误码 → 文案模板（`{0}`/`{1}` 由 params 填充；无参数则无占位） */
const TEMPLATES: Record<ExprErrorCode, string> = {
  PARSE_ERR_SYNTAX: '语法错误',
  PARSE_ERR_ROOT_SHAPE: '只能是一个表达式',
  STATIC_ERR_NODE: '不支持的语法：{0}',
  STATIC_ERR_CALL: '不允许调用：{0}',
  EVAL_SHAPE_ERROR: '取值失败：{0}',
  EVAL_UNKNOWN_FIELD: '字段不存在：{0}',
  EVAL_STEP_LIMIT: '步数超限（预算 {0}）',
  EVAL_TIME_LIMIT: '已超时（预算 {0} ms）',
  EVAL_ILLEGAL_CALL: '调用不被允许：{0}',
  RESULT_TRUNCATED: '结果已截断（上限 {0}）',
};

/** 参数补充说明（少数错误把参数翻译成人话） */
function paramText(code: ExprErrorCode, param: string | number): string {
  if (code === 'STATIC_ERR_NODE') {
    if (param === 'depth') return '表达式嵌套过深';
    if (param === 'text-length') return '表达式过长';
    if (param === 'root-shape') return '只能是一个表达式';
  }
  if (code === 'EVAL_SHAPE_ERROR') {
    if (param === 'base-kind') return '在不可取字段的值上取字段';
    if (param === 'index') return '下标必须是非负整数';
  }
  return String(param);
}

/** 拼装错误文案；含可选「第 L 行第 C 列」。 */
export function exprErrorText(error: ExprError): string {
  const template = TEMPLATES[error.code] ?? String(error.code);
  const params = error.params ?? [];
  const body = template.replace(/\{(\d+)\}/g, (_, index: string) => {
    const value = params[Number(index)];
    return value === undefined ? '' : paramText(error.code, value);
  });
  const where =
    error.line !== undefined && error.column !== undefined
      ? `（第 ${error.line} 行第 ${error.column} 列）`
      : error.line !== undefined
        ? `（第 ${error.line} 行）`
        : '';
  const base = body + where;
  // 拼写纠错候选（最多 3 条）：`字段不存在：nmae（你是不是想找 name？）`
  const candidates = error.candidates ?? [];
  if (candidates.length === 0) return base;
  const hint = candidates.slice(0, 3).join(' / ');
  return `${base}（你是不是想找 ${hint}？）`;
}

export const EXPR_COPY = {
  panelTitle: '表达式',
  run: '执行',
  running: '执行中…',
  strict: '严格模式',
  examplesTitle: '示例',
  historyTitle: '历史',
  empty: '输入表达式后按 Enter 执行',
  stale: '文档已修改，结果可能过期',
  rerun: '重新执行',
  back: '返回文档树',
  /** 结果条标题 */
  resultTitle: (rootId: string): string => `表达式结果 · ${rootId}`,
  /** 状态行：`N 项 · X ms` */
  status: (count: number, ms: number): string => `${count} 项 · ${ms} ms`,
  truncated: (max: number): string => `已截断（上限 ${max.toLocaleString('en-US')}）`,
  skipped: (n: number): string => `已跳过 ${n} 项缺少该字段`,
  noSource: '该行是计算值，没有对应的原文档位置',
  readonly: '表达式结果只读',
  watchdog: '表达式执行超时，已终止 Worker；请重新导入文档',
} as const;
