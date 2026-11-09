/**
 * shared/timing — 与宿主无关的计时小工具（core 的 raw-text / fidelity 共用）。
 *
 * `performance.now()` 在 Worker / 页面 / Node 都存在；缺失时退回 `Date.now()`。
 * 单独成文件是因为 raw-text 与 fidelity 各写过一份（code review 收口：Duplicated Code）。
 */

export function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** 毫秒保留 3 位小数（`RawMeta.buildMs` / `FidelityReport.scanMs` 同口径） */
export function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
