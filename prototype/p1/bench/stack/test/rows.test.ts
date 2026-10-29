import { describe, expect, it } from 'vitest';
import { makeRows, visibleWindow, ROW_HEIGHT, VIEWPORT_ROWS } from '../src/rows';

describe('visibleWindow', () => {
  it('maps scrollTop to a 40-row window', () => {
    expect(visibleWindow(0, 24, 40, 1000)).toEqual({ first: 0, count: 40 });
    expect(visibleWindow(24 * 7, 24, 40, 1000)).toEqual({ first: 7, count: 40 });
    expect(visibleWindow(24 * 7 + 23.5, 24, 40, 1000)).toEqual({ first: 7, count: 40 });
  });
  it('clamps at the end of the list', () => {
    expect(visibleWindow(24 * 995, 24, 40, 1000)).toEqual({ first: 995, count: 5 });
    expect(visibleWindow(24 * 1000, 24, 40, 1000)).toEqual({ first: 1000, count: 0 });
  });
  it('supports overscan on both sides', () => {
    expect(visibleWindow(24 * 10, 24, 40, 1000, 4)).toEqual({ first: 6, count: 48 });
    expect(visibleWindow(0, 24, 40, 1000, 4)).toEqual({ first: 0, count: 48 }); // no preroll above row 0
    expect(visibleWindow(24 * 999, 24, 40, 1000, 4)).toEqual({ first: 995, count: 5 });
  });
  it('never returns a negative window for negative scroll (overscroll/rubber band)', () => {
    expect(visibleWindow(-120, 24, 40, 1000).first).toBe(0);
  });
});

describe('makeRows', () => {
  it('is deterministic and includes the truncation stress row', () => {
    const a = makeRows(200);
    const b = makeRows(200);
    expect(a).toEqual(b);
    expect(a.length).toBe(200);
    expect(a.some((r) => r.kind === 'string' && r.value.length > 300)).toBe(true);
    expect(new Set(a.map((r) => r.kind)).size).toBeGreaterThan(4);
  });
  it('keeps the documented fixed row height contract', () => {
    expect(ROW_HEIGHT).toBe(24);
    expect(VIEWPORT_ROWS).toBe(40);
  });
});
