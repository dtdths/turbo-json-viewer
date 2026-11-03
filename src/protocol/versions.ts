/**
 * protocol/versions — 版本号语义与协议常量。
 */

/** 固定行高（px）；唯一允许进入逻辑层的视觉参数之一 */
export const ROW_HEIGHT = 24;
/** 视口上下额外请求的行数（ADR-0001：overscan 8 → 平滑滚动空白率 0） */
export const OVERSCAN = 8;
/** 浏览器单容器 scrollHeight 上限 */
export const MAX_SCROLL_PX = 33_554_428;
/** 可见行软预算：超过则拒绝继续「全部展开」 */
export const ROW_BUDGET = 1_000_000;
/** 子树编辑器文本上限 */
export const EDIT_MAX_BYTES = 5 * 1024 * 1024;
/** 编辑撤销栈深度上限（#16 / ADR-0006） */
export const EDIT_UNDO_DEPTH = 100;
/** 搜索命中上限 */
export const SEARCH_LIMIT = 50_000;
/** 自适应展开阈值：加载时「全展开行数」（= 节点数）不超过该值则直接全展开（ADR-0002 修订 / #9） */
export const ADAPTIVE_EXPAND_ROWS = 500;
/** 复制：子树 JSON 缩进（ADR-0010 §5；设置面板落地前固定 2，与 exportDoc 默认一致） */
export const COPY_INDENT = 2;
/** 复制：子树 JSON 字节上限（与编辑器 5MB 守卫同口径；超限引导用「导出」，不静默截断） */
export const COPY_MAX_BYTES = 5 * 1024 * 1024;

/* --------------------- 原始文本视图（ADR-0003 修订） --------------------- */

/** 原文行索引检查点间隔（行）：每 N 行一个 {lineIndex, srcOffset, depth} */
export const RAW_CP_EVERY = 2048;
/** 形状探测阈值：最长行 ≤ 该值 → 源码行虚拟化；否则走检查点 pretty 行走器 */
export const RAW_MAX_LINE_LENGTH = 4096;
/** 单行显示上限（字符；防 DOM 巨行）：超出截断显示，复制原文不受此限 */
export const RAW_LINE_DISPLAY_MAX = 4096;

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
