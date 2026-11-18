/**
 * shared/expression-copy — 表达式视图文案的**单一来源**（ADR-0018 §5 / ADR-0026 §1）。
 *
 * 引擎只给 code + params；所有用户可见文案在这里组装（面板内联错误 / 结果条 / toast 共用）。
 * i18n 之后文案走 `view.expr.*` 词条（zh-CN 与 i18n 化之前逐字一致，冒烟按此断言）。
 *
 * **对外形态保持兼容**：`EXPR_COPY` 的属性仍是可直接读的字符串（getter 每次按当前 locale 取词条），
 * `resultTitle` / `status` / `truncated` / `skipped` 仍是函数，`exprErrorText(error)` 签名不变。
 */
import { t, type MessageKey } from '../i18n/index';
import type { Params } from '../i18n/types';
import type { ExprError, ExprErrorCode } from '../protocol/types';

/** 错误码 → 文案词条（参数按错误码显式映射，保持与旧模板占位一致）。 */
const TEMPLATE_KEYS: Record<ExprErrorCode, MessageKey> = {
  PARSE_ERR_SYNTAX: 'view.expr.error.parseSyntax',
  PARSE_ERR_ROOT_SHAPE: 'view.expr.error.parseRootShape',
  STATIC_ERR_NODE: 'view.expr.error.staticNode',
  STATIC_ERR_CALL: 'view.expr.error.staticCall',
  EVAL_SHAPE_ERROR: 'view.expr.error.evalShape',
  EVAL_UNKNOWN_FIELD: 'view.expr.error.unknownField',
  EVAL_STEP_LIMIT: 'view.expr.error.stepLimit',
  EVAL_TIME_LIMIT: 'view.expr.error.timeLimit',
  EVAL_ILLEGAL_CALL: 'view.expr.error.illegalCall',
  EVAL_MIXED_NUMBER: 'view.expr.error.mixedNumber',
  EVAL_DIV_BY_ZERO: 'view.expr.error.divByZero',
  RESULT_TRUNCATED: 'view.expr.error.resultTruncated',
};

/** 参数补充说明（少数错误把参数翻译成人话；其余原样字符串化）。 */
function paramText(code: ExprErrorCode, param: string | number): string {
  if (code === 'STATIC_ERR_NODE') {
    if (param === 'depth') return t('view.expr.param.depth');
    if (param === 'text-length') return t('view.expr.param.textLength');
    if (param === 'root-shape') return t('view.expr.param.rootShape');
  }
  if (code === 'EVAL_SHAPE_ERROR') {
    if (param === 'base-kind') return t('view.expr.param.baseKind');
    if (param === 'index') return t('view.expr.param.index');
  }
  return String(param);
}

/** 按错误码把位置参数映射成词条占位符（缺省 → 空串，与旧模板行为一致）。 */
function errorParams(code: ExprErrorCode, params: readonly (string | number)[]): Params {
  const at = (index: number): string => {
    const value = params[index];
    return value === undefined ? '' : paramText(code, value);
  };
  switch (code) {
    case 'STATIC_ERR_NODE':
    case 'EVAL_SHAPE_ERROR':
      return { detail: at(0) };
    case 'STATIC_ERR_CALL':
    case 'EVAL_ILLEGAL_CALL':
      return { name: at(0) };
    case 'EVAL_UNKNOWN_FIELD':
      return { field: at(0) };
    case 'EVAL_STEP_LIMIT':
    case 'EVAL_TIME_LIMIT':
      return { budget: at(0) };
    case 'EVAL_MIXED_NUMBER':
      return { op: at(0) };
    case 'RESULT_TRUNCATED':
      return { max: at(0) };
    default:
      return {};
  }
}

/** 拼装错误文案；含可选「第 L 行第 C 列」。 */
export function exprErrorText(error: ExprError): string {
  const body = t(TEMPLATE_KEYS[error.code] ?? 'view.expr.error.parseSyntax', errorParams(error.code, error.params ?? []));
  const where =
    error.line !== undefined
      ? error.column !== undefined
        ? t('view.location.lineColumn', { line: error.line, column: error.column })
        : t('view.location.line', { line: error.line })
      : '';
  const base = body + where;
  // 拼写纠错候选（最多 3 条）：`字段不存在：nmae（你是不是想找 name？）`
  const candidates = error.candidates ?? [];
  if (candidates.length === 0) return base;
  const hint = candidates.slice(0, 3).join(' / ');
  return base + t('view.expr.candidates', { hint });
}

/**
 * 表达式视图固定文案。
 *
 * **形态兼容**：字符串属性用 getter（每次按当前 locale 取词条，切语言后重新读取即正确），
 * 带参文案保持函数调用方式不变（`main.ts` 直接消费 `panelTitle` / `running` 等属性）。
 */
export const EXPR_COPY = {
  get panelTitle(): string {
    return t('view.expr.panelTitle');
  },
  get run(): string {
    return t('view.expr.run');
  },
  get running(): string {
    return t('view.expr.running');
  },
  get strict(): string {
    return t('view.expr.strict');
  },
  get examplesTitle(): string {
    return t('view.expr.examplesTitle');
  },
  /** 多条件筛选引导（#47 #7）：不做自研条件行，指到 filter(...) 用法。 */
  get filterHint(): string {
    return t('view.expr.filterHint');
  },
  get historyTitle(): string {
    return t('view.expr.historyTitle');
  },
  get empty(): string {
    return t('view.expr.empty');
  },
  get stale(): string {
    return t('view.expr.stale');
  },
  get rerun(): string {
    return t('view.expr.rerun');
  },
  get back(): string {
    return t('view.expr.back');
  },
  /** 结果条标题 */
  resultTitle: (rootId: string): string => t('view.expr.resultTitle', { rootId }),
  /** 状态行：`N 项 · X ms` */
  status: (count: number, ms: number): string => t('view.expr.status', { count, ms }),
  truncated: (max: number): string => t('view.expr.truncated', { n: max }),
  skipped: (n: number): string => t('view.expr.skipped', { n }),
  get noSource(): string {
    return t('view.expr.noSource');
  },
  get readonly(): string {
    return t('view.expr.readonly');
  },
  get watchdog(): string {
    return t('view.expr.watchdog');
  },
};
