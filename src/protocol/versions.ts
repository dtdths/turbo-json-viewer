/**
 * protocol/versions — 版本号语义与协议常量。
 */
import type { ExprBudgetLevel, SortOrder } from './types';

/** 固定行高（px）；唯一允许进入逻辑层的视觉参数之一 */
export const ROW_HEIGHT = 24;
/** 视口上下额外请求的行数（ADR-0001：overscan 8 → 平滑滚动空白率 0） */
export const OVERSCAN = 8;
/** 浏览器单容器 scrollHeight 上限 */
export const MAX_SCROLL_PX = 33_554_428;

/* --------------------- 子键显示顺序（#40 / ADR-0024） --------------------- */

/**
 * 子键显示排序三档（顺序 = 设置面板展示顺序；`raw` 为默认）。
 * **单一来源**：core 的白名单校验与 viewmodel 的设置项都从这里取，面板只补文案。
 */
export const SORT_ORDER_OPTIONS: readonly SortOrder[] = ['raw', 'key-asc', 'key-desc'];

/* --------------------- 多文档标签（#18 / ADR-0009） --------------------- */

/** 文档标签软上限：满 8 个后「＋」禁用并提示；**不自动淘汰**（ADR-0009 §4） */
export const MAX_DOC_TABS = 8;
/** 标签条高度（px）：仅 ≥2 个文档时显示，单文档的树视口高度不变（ADR-0009 §1） */
export const TAB_STRIP_HEIGHT = 32;
/** 可见行软预算：超过则拒绝继续「全部展开」 */
export const ROW_BUDGET = 1_000_000;
/** 子树编辑器文本上限 */
export const EDIT_MAX_BYTES = 5 * 1024 * 1024;
/** 编辑撤销栈深度上限（#16 / ADR-0006） */
export const EDIT_UNDO_DEPTH = 100;
/** 搜索命中上限 */
export const SEARCH_LIMIT = 50_000;
/** 搜索：正则模式下的模式串长度上限（ADR-0014 §2.4） */
export const SEARCH_PATTERN_MAX = 256;
/** 导入体积提示阈值（字节，十进制 50 MB）：超出则显示「源文本常驻内存」提示条（ADR-0003 修订 / #11） */
export const LARGE_DOC_WARN_BYTES = 50_000_000;
/** 自适应展开阈值：加载时「全展开行数」（= 节点数）不超过该值则直接全展开（ADR-0002 修订 / #9） */
export const ADAPTIVE_EXPAND_ROWS = 500;
/** 复制：子树 JSON 缩进（ADR-0010 §5；设置面板落地前固定 2，与 exportDoc 默认一致） */
export const COPY_INDENT = 2;
/** 复制：子树 JSON 字节上限（与编辑器 5MB 守卫同口径；超限引导用「导出」，不静默截断） */
export const COPY_MAX_BYTES = 5 * 1024 * 1024;

/* --------------------- 表达式视图（#12 / #27 / ADR-0018） --------------------- */

/** 表达式文本上限（字符） */
export const EXPR_TEXT_MAX = 4096;
/** 表达式 AST 深度上限（防解析器递归 + 解释器栈） */
export const EXPR_AST_DEPTH_MAX = 128;
/** 求值时间检查点间隔（步） */
export const EXPR_TIME_CHECK_EVERY = 4096;
/** 看门狗倍数：主线程等 `3 × maxTime` 仍无回包则 terminate worker（ADR-0018 §6） */
export const EXPR_WATCHDOG_FACTOR = 3;
/** 补全请求 debounce（ms，页面侧） */
export const EXPR_COMPLETE_DEBOUNCE = 150;
/** 会话级历史条数（不持久化） */
export const EXPR_HISTORY_MAX = 20;
/** 示例条数：文档顶层字段动态 3 条 + 通用语法 2 条（无文档只给通用 2 条） */
export const EXPR_EXAMPLES_DOC = 3;
export const EXPR_EXAMPLES_GENERIC = 2;

/** 一档预算：时间为主刹车，步数是兜底，结果尺寸是内存/渲染护栏。 */
export interface ExprBudgetSpec {
  maxTimeMs: number;
  /** 步数 = max(stepBase, stepPerNode × 文档节点数) */
  stepBase: number;
  stepPerNode: number;
  /** 结果 / 中间容器的元素（或字符串长度）上限；超过即截断（带标记） */
  maxResult: number;
}

/** 三档预算（#12 spec §3；数值待 #15 真机压测微调，修订需显式拍板——ADR-0013 先例）。 */
export const EXPR_BUDGETS: Record<ExprBudgetLevel, ExprBudgetSpec> = {
  loose: { maxTimeMs: 1000, stepBase: 2_000_000, stepPerNode: 100, maxResult: 500_000 },
  standard: { maxTimeMs: 500, stepBase: 1_000_000, stepPerNode: 50, maxResult: 200_000 },
  strict: { maxTimeMs: 200, stepBase: 500_000, stepPerNode: 20, maxResult: 50_000 },
};

/** 把档位 + 文档节点数换算成一次求值的实际预算（步数 = max(base, k×N)）。 */
export function exprBudget(level: ExprBudgetLevel, nodeCount: number): ExprBudgetSpec & { level: ExprBudgetLevel; maxSteps: number } {
  const spec = EXPR_BUDGETS[level];
  const nodes = Number.isFinite(nodeCount) && nodeCount > 0 ? Math.floor(nodeCount) : 0;
  return { ...spec, level, maxSteps: Math.max(spec.stepBase, spec.stepPerNode * nodes) };
}

/** 看门狗时限：`3 × maxTimeMs`（ADR-0018 §6）。 */
export function exprWatchdogMs(level: ExprBudgetLevel): number {
  return EXPR_BUDGETS[level].maxTimeMs * EXPR_WATCHDOG_FACTOR;
}

/** 结果为标量时的等价展示：顶层子项数 */
export const EXPR_SCALAR_COUNT = 0;

/* --------------------- 原始文本视图（ADR-0003 修订） --------------------- */

/** 原文行索引检查点间隔（行）：每 N 行一个 {lineIndex, srcOffset, depth} */
export const RAW_CP_EVERY = 2048;
/** 形状探测阈值：最长行 ≤ 该值 → 源码行虚拟化；否则走检查点 pretty 行走器 */
export const RAW_MAX_LINE_LENGTH = 4096;
/** 单行显示上限（字符；防 DOM 巨行）：超出截断显示，复制原文不受此限 */
export const RAW_LINE_DISPLAY_MAX = 4096;

/* --------------------- 双向定位（#30 / ADR-0019） --------------------- */

/** 源文本 path↔offset 索引：每 N 个节点一个检查点（帧链 + 祖先键栈） */
export const RAW_PATH_CP_NODES = 2048;
/** 树→原文（path→offset）结果缓存：每个根保留最近 N 个路径（LRU） */
export const RAW_PATH_CACHE_SIZE = 512;

/* --------------------- 大纲面板（ADR-0013） --------------------- */

/** 大纲分页：默认每页子项数（「加载更多」每次取一页） */
export const OUTLINE_PAGE = 200;
/** 大纲分页：单次 `outline` 请求允许的最大 count（超出由 core 夹取） */
export const OUTLINE_PAGE_MAX = 500;

/** 行窗口回包是否过期：seq 之后到、或 rowVersion 不符 */
export function isStaleRow(
  reply: { rowVersion: number; seq: number },
  current: { rowVersion: number; seq: number },
): boolean {
  return reply.rowVersion !== current.rowVersion || reply.seq < current.seq;
}

/** 内容版本不匹配（表达式结果 / 搜索命中过期） */
export function isStaleDoc(replyDocRevision: number, currentDocRevision: number): boolean {
  return replyDocRevision !== currentDocRevision;
}
