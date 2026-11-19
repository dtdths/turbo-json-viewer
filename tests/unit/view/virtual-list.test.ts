import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SCROLL_PX } from '../../../src/protocol/versions';
import { VirtualList, type VirtualPaint } from '../../../src/view/virtual-list';
import { installFakeDom, type FakeDomHandle, type FakeElement } from './fake-dom';

/**
 * view/virtual-list — 纯几何 + 池化（候选 5 / seams S3b）。
 *
 * 用仓库自带的极简 fake DOM（不引 jsdom）；`drawOnResize: false` 避开 ResizeObserver，
 * 滚动用 `emit('scroll')` 触发（模块自己挂的监听）。
 */
let dom: FakeDomHandle;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  dom.restore();
});

type ScrollHost = HTMLElement & { scrollTop: number; clientHeight: number; emit(type: string): void };

function scroller(heightPx: number): ScrollHost {
  const el = dom.document.createElement('div') as unknown as ScrollHost;
  el.clientHeight = heightPx;
  el.scrollTop = 0;
  el.style.height = `${heightPx}px`;
  return el;
}

interface Harness {
  list: VirtualList;
  scroller: ScrollHost;
  spacer: FakeElement;
  host: FakeElement;
  paints: VirtualPaint[];
  cleared: HTMLElement[];
  created: number;
}

function makeHarness(opts: {
  rowHeight?: number;
  overscan?: number;
  viewportPx?: number;
  drawOnScroll?: boolean;
  onScroll?: (px: number) => void;
} = {}): Harness {
  const rowHeight = opts.rowHeight ?? 10;
  const scrollerEl = scroller(opts.viewportPx ?? 100);
  const spacer = dom.document.createElement('div');
  const host = dom.document.createElement('div');
  spacer.appendChild(host);
  const paints: VirtualPaint[] = [];
  const cleared: HTMLElement[] = [];
  const h: Harness = {
    list: undefined as unknown as VirtualList,
    scroller: scrollerEl,
    spacer,
    host,
    paints,
    cleared,
    created: 0,
  };
  h.list = new VirtualList({
    scroller: scrollerEl,
    spacer: spacer as unknown as HTMLElement,
    host: host as unknown as HTMLElement,
    rowHeight,
    overscan: opts.overscan ?? 0,
    createSlot: () => {
      h.created += 1;
      const el = dom.document.createElement('div');
      el.className = 'slot';
      return el as unknown as HTMLElement;
    },
    paint: (ctx) => {
      paints.push(ctx);
      (ctx.el as unknown as FakeElement).textContent = `row ${ctx.index}`;
      (ctx.el as unknown as FakeElement).dataset.index = String(ctx.index);
    },
    clearSlot: (el) => {
      cleared.push(el);
      const fake = el as unknown as FakeElement;
      fake.textContent = '';
      delete fake.dataset.index;
      fake.removeAttribute('title');
      fake.classList.remove('is-selected');
    },
    onScroll: opts.onScroll,
    drawOnScroll: opts.drawOnScroll,
    drawOnResize: false,
  });
  return h;
}

describe('spacer 与窗口', () => {
  it('spacer 高度 = size × rowHeight', () => {
    const h = makeHarness();
    h.list.setSize(100);
    expect(h.spacer.style.height).toBe('1000px');
  });

  it('一屏可见 = floor(视口 / 行高) + overscan', () => {
    const h = makeHarness({ rowHeight: 10, overscan: 2, viewportPx: 100 });
    h.list.setSize(100);
    // 视口 100 / 行高 10 = 10 行，两侧各 2 行 overscan → 14
    expect(h.list.rendered).toBe(14);
    expect(h.created).toBe(14);
  });

  it('滚动后窗口起点 = floor(scrollTop / rowHeight) - overscan', () => {
    const h = makeHarness({ rowHeight: 10, overscan: 2, viewportPx: 100 });
    h.list.setSize(100);
    h.scroller.scrollTop = 300;
    h.list.draw();
    // 起点 30 - 2 = 28，窗口 14 行 → 最后一个 index 是 28 + 13
    expect(h.paints.at(-1)?.index).toBe(28 + 13);
  });

  it('spacer 封顶在 MAX_SCROLL_PX', () => {
    const h = makeHarness({ rowHeight: 40 });
    h.list.setSize(2_000_000);
    expect(h.spacer.style.height).toBe(`${MAX_SCROLL_PX}px`);
  });

  it('setRowHeight 同时更新槽位高度、spacer 与窗口', () => {
    const h = makeHarness({ rowHeight: 10, overscan: 0, viewportPx: 100 });
    h.list.setSize(100);
    expect(h.list.rendered).toBe(10);
    h.list.setRowHeight(20);
    expect(h.list.rowHeight).toBe(20);
    expect(h.spacer.style.height).toBe('2000px');
    expect(h.list.rendered).toBe(5);
    for (const slot of h.host.children) expect(slot.style.height).toBe('20px');
    expect(h.paints.at(-1)?.top).toBe(4 * 20);
  });

  it('setRowHeight 收到非法值时保持原行高', () => {
    const h = makeHarness({ rowHeight: 10 });
    h.list.setSize(10);
    h.list.setRowHeight(0);
    h.list.setRowHeight(Number.NaN);
    expect(h.list.rowHeight).toBe(10);
  });
});

describe('槽位池', () => {
  it('槽位只增不缩：size 变小只是隐藏并清理，不销毁', () => {
    const h = makeHarness();
    h.list.setSize(100);
    const poolSize = h.created;
    h.list.setSize(3);
    expect(h.created).toBe(poolSize);
    expect(h.list.rendered).toBe(3);
    expect(h.cleared.length).toBe(poolSize - 3);
    for (let i = 3; i < h.host.children.length; i++) {
      expect(h.host.children[i]?.hidden).toBe(true);
    }
  });

  it('再次放大不新建槽位（复用）', () => {
    const h = makeHarness();
    h.list.setSize(100);
    const poolSize = h.created;
    h.list.setSize(3);
    h.list.setSize(100);
    expect(h.created).toBe(poolSize);
    expect(h.list.rendered).toBe(10);
  });

  it('隐藏时清掉面板内容（clearSlot 是清理的唯一时机）', () => {
    const h = makeHarness();
    h.list.setSize(100);
    const last = h.host.children.at(-1) as FakeElement;
    expect(last.textContent).toBe('row 9');
    h.list.setSize(3);
    expect(last.textContent).toBe('');
    expect(last.dataset.index).toBeUndefined();
    expect(last.hidden).toBe(true);
  });

  it('size = 0 不建槽位、spacer 归零', () => {
    const h = makeHarness();
    h.list.setSize(0);
    expect(h.created).toBe(0);
    expect(h.list.rendered).toBe(0);
    expect(h.spacer.style.height).toBe('0px');
  });

  it('repeat setSize 同值不重复建槽位', () => {
    const h = makeHarness();
    h.list.setSize(20);
    const poolSize = h.created;
    h.list.setSize(20);
    expect(h.created).toBe(poolSize);
  });
});

describe('paint 上下文', () => {
  it('给出 index / top / el，并已写入 style.top 与 hidden', () => {
    const h = makeHarness();
    h.list.setSize(5);
    const first = h.paints[0] as VirtualPaint;
    expect(first.index).toBe(0);
    expect(first.top).toBe(0);
    expect(first.el).toBe(h.host.children[0]);
    expect((first.el as unknown as FakeElement).style.top).toBe('0px');
    expect(first.el.hidden).toBe(false);
  });

  it('reuse 标出「这个槽位上一帧就是同一个 index」', () => {
    const h = makeHarness();
    h.list.setSize(100);
    h.paints.length = 0;
    h.list.draw();
    expect(h.paints[0]?.reuse).toBe(true);
    h.scroller.scrollTop = 500;
    h.paints.length = 0;
    h.list.draw();
    expect(h.paints[0]?.index).toBe(50);
    expect(h.paints[0]?.reuse).toBe(false);
  });
});

describe('滚动与销毁', () => {
  it('drawOnScroll 默认开启：滚动事件触发重画', () => {
    const h = makeHarness();
    h.list.setSize(100);
    const before = h.paints.length;
    h.scroller.scrollTop = 200;
    h.scroller.emit('scroll');
    expect(h.paints.length).toBeGreaterThan(before);
    expect(h.list.scrollTop).toBe(200);
  });

  it('drawOnScroll=false 时滚动不重画，但仍回调 onScroll（树 / 原文的口径）', () => {
    const seen: number[] = [];
    const h = makeHarness({ drawOnScroll: false, onScroll: (px) => seen.push(px) });
    h.list.setSize(100);
    const before = h.paints.length;
    h.scroller.scrollTop = 120;
    h.scroller.emit('scroll');
    expect(h.paints.length).toBe(before);
    expect(seen).toEqual([120]);
  });

  it('scrollTop setter 把负值 / NaN 夹成 0', () => {
    const h = makeHarness();
    h.list.setSize(100);
    h.list.scrollTop = -50;
    expect(h.scroller.scrollTop).toBe(0);
    h.list.scrollTop = Number.NaN;
    expect(h.scroller.scrollTop).toBe(0);
    h.list.scrollTop = 42;
    expect(h.scroller.scrollTop).toBe(42);
  });

  it('destroy 解绑监听并清空可见槽位', () => {
    const h = makeHarness();
    h.list.setSize(100);
    h.list.destroy();
    expect(h.list.rendered).toBe(0);
    expect(h.cleared.length).toBeGreaterThan(0);
    for (const slot of h.host.children) expect(slot.hidden).toBe(true);
    const before = h.paints.length;
    h.scroller.emit('scroll');
    expect(h.paints.length).toBe(before);
  });
});
