/**
 * shared/menu 纯函数单测（ADR-0015）：定位矩阵 + 键盘导航索引。
 *
 * 这些是「菜单交互契约」里唯一不依赖 DOM 的部分；DOM 控制器（`view/menu.ts`）由冒烟兜底
 * （仓库不引 jsdom）。定位用例覆盖四边翻转 / clamp / 菜单大于视口 / 旧 clamp-only 模式。
 */
import { describe, expect, it } from 'vitest';
import {
  computeMenuPosition,
  isMenuNavKey,
  MENU_ANCHOR_GAP,
  MENU_VIEWPORT_MARGIN,
  menuTransformOrigin,
  nextMenuIndex,
  type MenuAnchor,
} from '../../../src/shared/menu';

const VIEWPORT = { width: 1200, height: 800 };

function point(x: number, y: number): MenuAnchor {
  return { kind: 'point', x, y };
}

function rect(left: number, top: number, right: number, bottom: number, align?: 'start' | 'end'): MenuAnchor {
  return { kind: 'rect', rect: { left, top, right, bottom }, align };
}

describe('computeMenuPosition — point（右键菜单，光标右下优先）', () => {
  it('常规：菜单左上角贴光标', () => {
    expect(computeMenuPosition(point(100, 100), { width: 200, height: 150 }, VIEWPORT)).toEqual({
      left: 100,
      top: 100,
      maxHeight: null,
    });
  });

  it('右边界：翻到光标左侧', () => {
    expect(computeMenuPosition(point(1100, 100), { width: 200, height: 150 }, VIEWPORT)).toEqual({
      left: 900,
      top: 100,
      maxHeight: null,
    });
  });

  it('下边界：翻到光标上方', () => {
    expect(computeMenuPosition(point(100, 750), { width: 200, height: 150 }, VIEWPORT)).toEqual({
      left: 100,
      top: 600,
      maxHeight: null,
    });
  });

  it('右下同时越界：双轴翻转', () => {
    expect(computeMenuPosition(point(1100, 750), { width: 200, height: 150 }, VIEWPORT)).toEqual({
      left: 900,
      top: 600,
      maxHeight: null,
    });
  });

  it('左上越界：clamp 到 8px margin', () => {
    expect(computeMenuPosition(point(0, 0), { width: 200, height: 150 }, VIEWPORT)).toEqual({
      left: MENU_VIEWPORT_MARGIN,
      top: MENU_VIEWPORT_MARGIN,
      maxHeight: null,
    });
  });

  it('菜单比视口宽：clamp 到 margin，不出现负坐标', () => {
    const placement = computeMenuPosition(point(0, 0), { width: 2000, height: 100 }, VIEWPORT);
    expect(placement).toEqual({ left: MENU_VIEWPORT_MARGIN, top: MENU_VIEWPORT_MARGIN, maxHeight: null });
  });

  it('菜单比视口高：给 maxHeight（视口减两倍 margin），top 贴 margin', () => {
    expect(computeMenuPosition(point(100, 100), { width: 200, height: 2000 }, VIEWPORT)).toEqual({
      left: 100,
      top: MENU_VIEWPORT_MARGIN,
      maxHeight: VIEWPORT.height - MENU_VIEWPORT_MARGIN * 2,
    });
  });

  it('自定义 margin / gap', () => {
    expect(computeMenuPosition(point(0, 0), { width: 100, height: 100 }, { width: 200, height: 200 }, { margin: 0 })).toEqual({
      left: 0,
      top: 0,
      maxHeight: null,
    });
    expect(computeMenuPosition(rect(900, 10, 1000, 34), { width: 200, height: 100 }, VIEWPORT, { gap: 10 })).toMatchObject({
      top: 44,
    });
  });

  it('旧 clamp-only 模式（flip:false）：不翻转，只夹到视口内', () => {
    expect(
      computeMenuPosition(point(1100, 750), { width: 200, height: 150 }, VIEWPORT, { flip: false }),
    ).toEqual({ left: 1200 - 200 - MENU_VIEWPORT_MARGIN, top: 800 - 150 - MENU_VIEWPORT_MARGIN, maxHeight: null });
  });
});

describe('computeMenuPosition — rect（导出菜单，箭头右对齐 + 下方 4px）', () => {
  it('常规：右对齐到锚点右边、下方 gap', () => {
    expect(computeMenuPosition(rect(900, 10, 1000, 34), { width: 200, height: 100 }, VIEWPORT)).toEqual({
      left: 800,
      top: 34 + MENU_ANCHOR_GAP,
      maxHeight: null,
    });
  });

  it('align=start：左对齐到锚点左边', () => {
    expect(computeMenuPosition(rect(900, 10, 1000, 34, 'start'), { width: 200, height: 100 }, VIEWPORT)).toEqual({
      left: 900,
      top: 34 + MENU_ANCHOR_GAP,
      maxHeight: null,
    });
  });

  it('下方放不下：翻到锚点上方', () => {
    expect(computeMenuPosition(rect(900, 700, 1000, 746), { width: 200, height: 100 }, VIEWPORT)).toEqual({
      left: 800,
      top: 700 - MENU_ANCHOR_GAP - 100,
      maxHeight: null,
    });
  });

  it('右边界越界：clamp 到视口', () => {
    expect(computeMenuPosition(rect(1100, 10, 1195, 34), { width: 200, height: 100 }, VIEWPORT)).toEqual({
      left: 1200 - 200 - MENU_VIEWPORT_MARGIN,
      top: 34 + MENU_ANCHOR_GAP,
      maxHeight: null,
    });
  });

  it('菜单比视口高：maxHeight + 顶部 clamp', () => {
    expect(computeMenuPosition(rect(900, 10, 1000, 34), { width: 200, height: 900 }, VIEWPORT)).toEqual({
      left: 800,
      top: MENU_VIEWPORT_MARGIN,
      maxHeight: VIEWPORT.height - MENU_VIEWPORT_MARGIN * 2,
    });
  });

  it('旧 clamp-only 模式（flip:false）：不翻到上方，只夹到视口内', () => {
    expect(
      computeMenuPosition(rect(900, 700, 1000, 746), { width: 200, height: 100 }, VIEWPORT, { flip: false }),
    ).toEqual({ left: 800, top: 800 - 100 - MENU_VIEWPORT_MARGIN, maxHeight: null });
  });

  it('退化视口（0×0）：坐标贴 margin，maxHeight=0', () => {
    expect(computeMenuPosition(point(100, 100), { width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({
      left: MENU_VIEWPORT_MARGIN,
      top: MENU_VIEWPORT_MARGIN,
      maxHeight: 0,
    });
  });
});

describe('nextMenuIndex — 可用项间的键盘导航（ADR-0015 §2.2）', () => {
  it('空列表 → -1', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const) {
      expect(nextMenuIndex(0, -1, key)).toBe(-1);
    }
  });

  it('没有当前项（-1）：↓ 落首项、↑ 落末项', () => {
    expect(nextMenuIndex(3, -1, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(3, -1, 'ArrowUp')).toBe(2);
  });

  it('循环移动', () => {
    expect(nextMenuIndex(3, 0, 'ArrowDown')).toBe(1);
    expect(nextMenuIndex(3, 1, 'ArrowDown')).toBe(2);
    expect(nextMenuIndex(3, 2, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(3, 0, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(3, 1, 'ArrowUp')).toBe(0);
  });

  it('Home / End', () => {
    expect(nextMenuIndex(3, 1, 'Home')).toBe(0);
    expect(nextMenuIndex(3, 1, 'End')).toBe(2);
  });

  it('单元素列表：所有键都落 0', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const) {
      expect(nextMenuIndex(1, 0, key)).toBe(0);
    }
  });

  it('当前下标越界 / 非数字：按「无当前项」处理', () => {
    expect(nextMenuIndex(3, 5, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(3, 5, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(3, Number.NaN, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(3, -2, 'ArrowUp')).toBe(2);
  });

  it('非法 length → -1', () => {
    expect(nextMenuIndex(-1, 0, 'ArrowDown')).toBe(-1);
    expect(nextMenuIndex(Number.NaN, 0, 'End')).toBe(-1);
  });
});

describe('isMenuNavKey', () => {
  it('只认四个导航键', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(isMenuNavKey(key)).toBe(true);
    }
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a', '']) {
      expect(isMenuNavKey(key)).toBe(false);
    }
  });
});

describe('menuTransformOrigin — 入场缩放从锚点侧展开（#52）', () => {
  const SIZE = { width: 200, height: 150 };

  it('point 常规：菜单贴光标右下 → origin 在左上角', () => {
    expect(menuTransformOrigin(point(100, 100), { left: 100, top: 100 }, SIZE)).toEqual({ x: 0, y: 0 });
  });

  it('point 右边界翻转：origin 落在右缘', () => {
    // 光标 1100 → 菜单翻到左侧（left 900），锚点在菜单内 x = 200
    expect(menuTransformOrigin(point(1100, 100), { left: 900, top: 100 }, SIZE)).toEqual({ x: 200, y: 0 });
  });

  it('point 下边界翻转：origin 落在下缘', () => {
    expect(menuTransformOrigin(point(100, 750), { left: 100, top: 600 }, SIZE)).toEqual({ x: 0, y: 150 });
  });

  it('point 贴边被 clamp：锚点在盒外 → origin 收进边缘', () => {
    // margin 8：光标 (5,5) 的菜单左上角 clamp 到 (8,8)，锚点相对坐标为负
    expect(menuTransformOrigin(point(5, 5), { left: 8, top: 8 }, SIZE)).toEqual({ x: 0, y: 0 });
  });

  it('rect 右对齐：origin 在触发按钮下方的右缘', () => {
    // 按钮 rect(800,20,900,44) → 菜单 left 700、top 48（gap 4）
    const anchor = rect(800, 20, 900, 44);
    expect(menuTransformOrigin(anchor, { left: 700, top: 48 }, SIZE)).toEqual({ x: 200, y: 0 });
  });

  it('rect 左对齐：origin 在按钮下方的左缘', () => {
    const anchor = rect(100, 20, 200, 44, 'start');
    expect(menuTransformOrigin(anchor, { left: 100, top: 48 }, SIZE)).toEqual({ x: 0, y: 0 });
  });

  it('rect 翻到上方：锚点落到下缘（盒外的 gap 被 clamp）', () => {
    // 按钮底 724 → 上方 top = 700 - 4 - 150 = 546，锚点 y = 724 - 546 = 178 → clamp 150
    const anchor = rect(800, 700, 900, 724);
    expect(menuTransformOrigin(anchor, { left: 700, top: 546 }, SIZE)).toEqual({ x: 200, y: 150 });
  });

  it('尺寸非有限：origin 收成 0（不产出 NaN 内联样式）', () => {
    const origin = menuTransformOrigin(point(100, 100), { left: 100, top: 100 }, {
      width: Number.NaN,
      height: Number.POSITIVE_INFINITY,
    });
    expect(origin.x).toBe(0);
    expect(Number.isFinite(origin.y)).toBe(true);
  });
});
