/**
 * shared/menu — 菜单定位与键盘导航的纯函数（零 DOM、零依赖；ADR-0015）。
 *
 * 两个菜单（树行右键菜单 / 导出方式菜单）原先在 `app/main.ts` 各写一份定位与 ↑↓ 逻辑，
 * 已漂移（是否翻转 / 是否 clamp / 是否跳 disabled）。本模块只保留可单测的纯计算：
 *   - `computeMenuPosition`：point（光标）与 rect（触发按钮）两种锚点，翻转 + clamp + 超高 maxHeight；
 *   - `nextMenuIndex`：可用项列表内的循环导航（↑↓ / Home / End）。
 * DOM 事件编排（打开/关闭/失焦/焦点归还/单活）在 `view/menu.ts`。
 */

/** 菜单与视口边缘的最小间距（px） */
export const MENU_VIEWPORT_MARGIN = 8;
/** rect 锚点（触发按钮）与菜单之间的间距（px） */
export const MENU_ANCHOR_GAP = 4;

export interface MenuPointAnchor {
  kind: 'point';
  x: number;
  y: number;
}

export interface MenuRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MenuRectAnchor {
  kind: 'rect';
  rect: MenuRectLike;
  /** 与锚点哪一边对齐：`end`（默认，右对齐）或 `start`（左对齐） */
  align?: 'start' | 'end';
}

export type MenuAnchor = MenuPointAnchor | MenuRectAnchor;

export interface MenuSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** 菜单高于可用高度时给内联 max-height（px），否则 null（不写内联样式） */
  maxHeight: number | null;
}

export interface MenuPlacementOptions {
  /** 视口边缘间距，默认 `MENU_VIEWPORT_MARGIN` */
  margin?: number;
  /** rect 锚点间距，默认 `MENU_ANCHOR_GAP` */
  gap?: number;
  /**
   * 空间不足时是否翻转到另一侧（默认 true）。`false` 是旧的 clamp-only 口径
   * （右键菜单/导出菜单 2026-11-10 之前的行为，仅用于行为保持期对照）。
   */
  flip?: boolean;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 计算菜单左上角坐标（`position: fixed` 口径）。
 *
 * - point：默认把菜单左上角放在光标处（右下展开）；右侧放不下翻到光标左侧，下方放不下翻到光标上方；
 * - rect：默认右对齐锚点右边、放在锚点下方 `gap` 处；下方放不下翻到锚点上方；
 * - 两个方向最终都 clamp 进 `[margin, viewport - size - margin]`；
 * - 菜单比可用高度高时返回 `maxHeight = viewport.height - 2*margin`（调用方设 `overflow-y:auto`）。
 */
export function computeMenuPosition(
  anchor: MenuAnchor,
  menuSize: MenuSize,
  viewport: ViewportSize,
  opts: MenuPlacementOptions = {},
): MenuPlacement {
  const margin = Math.max(0, finiteOr(opts.margin ?? MENU_VIEWPORT_MARGIN, MENU_VIEWPORT_MARGIN));
  const gap = Math.max(0, finiteOr(opts.gap ?? MENU_ANCHOR_GAP, MENU_ANCHOR_GAP));
  const flip = opts.flip !== false;

  const vw = Math.max(0, finiteOr(viewport.width, 0));
  const vh = Math.max(0, finiteOr(viewport.height, 0));
  const width = Math.max(0, finiteOr(menuSize.width, 0));
  const rawHeight = Math.max(0, finiteOr(menuSize.height, 0));

  const availableHeight = Math.max(0, vh - margin * 2);
  const height = Math.min(rawHeight, availableHeight);
  const maxHeight = rawHeight > availableHeight ? availableHeight : null;

  const clampX = (value: number): number => Math.min(Math.max(value, margin), Math.max(margin, vw - width - margin));
  const clampY = (value: number): number => Math.min(Math.max(value, margin), Math.max(margin, vh - height - margin));

  let left: number;
  let top: number;
  if (anchor.kind === 'point') {
    const x = finiteOr(anchor.x, 0);
    const y = finiteOr(anchor.y, 0);
    left = x;
    top = y;
    if (flip) {
      if (left + width > vw - margin) left = x - width;
      if (top + height > vh - margin) top = y - height;
    }
  } else {
    const r = anchor.rect;
    left = anchor.align === 'start' ? finiteOr(r.left, 0) : finiteOr(r.right, 0) - width;
    top = finiteOr(r.bottom, 0) + gap;
    if (flip && top + height > vh - margin) top = finiteOr(r.top, 0) - gap - height;
  }

  return { left: clampX(left), top: clampY(top), maxHeight };
}

export type MenuNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/** 键盘导航键判定（`Enter` / `Space` 走按钮原生激活，不在此列）。 */
export function isMenuNavKey(key: string): key is MenuNavKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

/**
 * 可用项列表内的下一个焦点下标（循环；`length === 0` → -1）。
 * `current` 无效（< 0 / >= length / NaN）按「没有当前项」处理：↓ 落首项、↑ 落末项。
 */
export function nextMenuIndex(length: number, current: number, key: MenuNavKey): number {
  if (!Number.isFinite(length) || length <= 0) return -1;
  const size = Math.trunc(length);
  if (size <= 0) return -1;

  let index = Number.isFinite(current) ? Math.trunc(current) : -1;
  if (index < 0 || index >= size) index = -1;

  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return size - 1;
    case 'ArrowDown':
      return index < 0 ? 0 : (index + 1) % size;
    case 'ArrowUp':
      return index < 0 ? size - 1 : (index - 1 + size) % size;
    default:
      return -1;
  }
}
