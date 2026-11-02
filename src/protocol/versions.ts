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
