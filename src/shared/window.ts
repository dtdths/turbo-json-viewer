/**
 * shared/window — 虚拟列表窗口计算（纯函数，零依赖，所有层可用；ADR-0008 分层）。
 *
 * 搜索结果的虚拟列表与大纲面板共用同一口径（原先两份逐行相同的实现，code review 收口）：
 *   - `size <= 0` / 非有限 size → 空窗口；
 *   - `start = clamp(floor(scrollTop / rowHeight) - overscan, 0, size)`；
 *   - `count = min(viewportRows + 2*overscan, size - start)`；
 *   - scrollTop 负值 / NaN → 0；viewportRows 非有限 / 负数 → 0。
 *
 * 行高 / overscan 是各视图自己的常量，由调用方传入（search 44/4、大纲 24/6）。
 */

export interface VirtualWindow {
  start: number;
  count: number;
}

export function computeVirtualWindow(
  size: number,
  scrollTop: number,
  viewportRows: number,
  opts: { rowHeight: number; overscan: number },
): VirtualWindow {
  if (!Number.isFinite(size) || size <= 0) return { start: 0, count: 0 };

  const rowHeight = Number.isFinite(opts.rowHeight) && opts.rowHeight > 0 ? opts.rowHeight : 1;
  const overscan = Math.max(0, Math.floor(Number.isFinite(opts.overscan) ? opts.overscan : 0));
  const rows = Math.max(0, Math.floor(Number.isFinite(viewportRows) ? viewportRows : 0));
  const scrollPx = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const start = Math.min(Math.max(0, Math.floor(scrollPx / rowHeight) - overscan), Math.floor(size));
  const count = Math.max(0, Math.min(rows + 2 * overscan, Math.floor(size) - start));
  return { start, count };
}
