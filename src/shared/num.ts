/**
 * shared/num — 纯函数数值小工具（零依赖，所有层可用；ADR-0008 分层）。
 */

/** 夹到 `[min, max]` 的整数；非有限值 → `min`。 */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(min, Math.floor(value)), max);
}

/** 行高兜底（树 / 原文共用）：12–48 取整，非法值回落 24（设置脏数据不撑坏几何）。 */
export function clampRowHeight(px: number): number {
  const n = Number(px);
  if (!Number.isFinite(n)) return 24;
  return Math.min(48, Math.max(12, Math.round(n)));
}
