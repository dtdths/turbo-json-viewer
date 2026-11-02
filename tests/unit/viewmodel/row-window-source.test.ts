/**
 * viewmodel/row-window-source 单测 — 窗口不变量（S2）。
 *
 * 覆盖：单飞 + 合并、seq 落后丢弃、rowVersion 不匹配丢弃且保留旧行、
 * 失败 → stale 保留旧行、overscan start 计算、方向预取 count。
 */
import { describe, expect, it, vi } from 'vitest';
import { RowWindowSource } from '../../../src/viewmodel/row-window-source';
import type { CoreApi, WindowRequest } from '../../../src/protocol/core-api';
import { CoreError } from '../../../src/protocol/errors';
import type { Row, RowWindow } from '../../../src/protocol/types';

const ROW_H = 24;
const VIEWPORT = 40;
const OVERSCAN = 8;
const TOTAL_ROWS = 10_000;
const BASE_COUNT = VIEWPORT + 1 + 2 * OVERSCAN; // 57

function makeRows(start: number, count: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const n = start + i;
    rows.push({
      path: `$[${n}]`,
      depth: 1,
      key: `[${n}]`,
      idx: true,
      kind: 'number',
      preview: String(n),
      count: 0,
      open: false,
      hasChildren: false,
    });
  }
  return rows;
}

class FakeCore {
  readonly requests: WindowRequest[] = [];
  private readonly pending: Array<{
    request: WindowRequest;
    resolve: (reply: RowWindow) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(private readonly totalRows: number = TOTAL_ROWS) {}

  window(request: WindowRequest): Promise<RowWindow> {
    this.requests.push(request);
    return new Promise<RowWindow>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
    });
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 回包默认按请求原样构造；overrides 模拟乱序/过期/伪造回包。 */
  resolveNext(overrides: Partial<RowWindow> = {}): void {
    const next = this.pending.shift();
    if (!next) throw new Error('no pending window request');
    const { request } = next;
    next.resolve({
      rootId: request.rootId,
      rowVersion: request.rowVersion,
      seq: request.seq,
      start: request.start,
      count: request.count,
      rows: makeRows(request.start, request.count),
      totalRows: this.totalRows,
      ...overrides,
    });
  }

  rejectNext(error: unknown): void {
    const next = this.pending.shift();
    if (!next) throw new Error('no pending window request');
    next.reject(error);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { totalRows?: number; overscan?: number } = {}) {
  const totalRows = options.totalRows ?? TOTAL_ROWS;
  const api = new FakeCore(totalRows);
  const source = new RowWindowSource(api as unknown as CoreApi, {
    rowHeight: ROW_H,
    overscan: options.overscan ?? OVERSCAN,
  });
  source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });
  source.setRoot({ rootId: 'doc', rowVersion: 1, totalRows });
  return { api, source };
}

describe('RowWindowSource — 窗口计算', () => {
  it('overscan：start = floor(scrollTop / rowHeight) - overscan（夹到 0）', () => {
    const { api, source } = setup();
    source.scrollTo(0);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.start).toBe(0);
    expect(api.requests[0]?.count).toBe(BASE_COUNT);
  });

  it('overscan：滚动后 start 前移 overscan 行', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    await api.resolveNext();
    await flush();

    source.scrollTo(100 * ROW_H);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.start).toBe(100 - OVERSCAN);
  });

  it('overscan：接近末尾时 start 夹到 totalRows - 1', async () => {
    const { api, source } = setup({ totalRows: 20 });
    source.scrollTo(0);
    await api.resolveNext();
    await flush();

    source.scrollTo(100 * ROW_H);
    expect(api.requests[1]?.start).toBe(19);
  });

  it('方向预取：ΔscrollTop 超过 overscan×rowHeight 时 count 多取一屏', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    expect(api.requests[0]?.count).toBe(BASE_COUNT);
    await api.resolveNext();
    await flush();

    // Δ = 200 行 > 8 行 → 预取一屏
    source.scrollTo(200 * ROW_H);
    expect(api.requests[1]?.count).toBe(BASE_COUNT + VIEWPORT);
    await api.resolveNext();
    await flush();

    // Δ = 1 行 → 不预取
    source.scrollTo(201 * ROW_H);
    expect(api.requests[2]?.count).toBe(BASE_COUNT);
  });

  it('方向预取：单次窗口上限 3 屏', async () => {
    const { api, source } = setup({ overscan: 20 });
    source.scrollTo(0);
    expect(api.requests[0]?.count).toBe(VIEWPORT + 1 + 2 * 20); // 81
    await api.resolveNext();
    await flush();

    source.scrollTo(200 * ROW_H);
    expect(api.requests[1]?.count).toBe(VIEWPORT * 3); // 预取 121 → 封顶 120
  });
});

describe('RowWindowSource — 单飞 + 合并', () => {
  it('连续 scrollTo 只保留一个在途请求，回包后补发最后一个目标', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    expect(api.requests).toHaveLength(1);
    expect(api.pendingCount).toBe(1);

    source.scrollTo(10 * ROW_H);
    source.scrollTo(20 * ROW_H);
    expect(api.requests).toHaveLength(1); // 合并没有取消在途
    expect(api.pendingCount).toBe(1);

    await api.resolveNext();
    await flush();

    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.start).toBe((20 - OVERSCAN) * 1);
  });

  it('requestWindow 幂等：已覆盖同一窗口时不重复请求', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    source.requestWindow();
    source.requestWindow();
    expect(api.requests).toHaveLength(1);

    await api.resolveNext();
    await flush();

    source.requestWindow();
    expect(api.requests).toHaveLength(1);
  });
});

describe('RowWindowSource — 过期回包', () => {
  it('seq 落后的回包被丢弃且不 notify', async () => {
    const { api, source } = setup();
    const seen = vi.fn();
    source.subscribe(seen);

    source.scrollTo(0);
    await api.resolveNext({ seq: 0 }); // 伪造落后 seq
    await flush();

    expect(seen).not.toHaveBeenCalled();
    expect(source.snapshot().rows).toHaveLength(0);
  });

  it('rowVersion 不匹配的回包被丢弃，保留旧行且不 notify', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    await api.resolveNext();
    await flush();
    const before = source.snapshot().rows.slice();
    expect(before.length).toBeGreaterThan(0);

    const seen = vi.fn();
    source.subscribe(seen);
    source.scrollTo(20 * ROW_H);
    await api.resolveNext({ rowVersion: 99 });
    await flush();

    expect(seen).not.toHaveBeenCalled();
    expect(source.snapshot().rows).toEqual(before);
    expect(source.snapshot().stale).toBe(false);
  });

  it('成功回包更新快照并 notify', async () => {
    const { api, source } = setup();
    const seen = vi.fn();
    source.subscribe(seen);
    source.scrollTo(0);
    await api.resolveNext();
    await flush();

    expect(seen).toHaveBeenCalledTimes(1);
    const snapshot = source.snapshot();
    expect(snapshot.stale).toBe(false);
    expect(snapshot.start).toBe(0);
    expect(snapshot.rows.length).toBe(BASE_COUNT);
    expect(snapshot.totalRows).toBe(TOTAL_ROWS);
  });
});

describe('RowWindowSource — 失败降级', () => {
  it('请求失败 → stale=true，保留旧行并 notify', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    await api.resolveNext();
    await flush();
    const before = source.snapshot().rows.slice();

    const seen = vi.fn();
    source.subscribe(seen);
    source.scrollTo(20 * ROW_H);
    await api.rejectNext(new CoreError({ code: 'TIMEOUT', message: 'window timeout' }));
    await flush();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(source.snapshot().stale).toBe(true);
    expect(source.snapshot().rows).toEqual(before);
    expect(source.lastError()?.code).toBe('TIMEOUT');
  });

  it('空文档不发请求，直接给空且非 stale 的窗口', () => {
    const { api, source } = setup({ totalRows: 0 });
    source.scrollTo(0);
    expect(api.requests).toHaveLength(0);
    expect(source.snapshot().stale).toBe(false);
    expect(source.snapshot().totalRows).toBe(0);
    expect(source.snapshot().rows).toHaveLength(0);
  });
});

describe('RowWindowSource — 度量 / 锚点 / 换根', () => {
  it('setMetrics 变化后重取；相同度量不重复请求', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    await api.resolveNext();
    await flush();

    source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });
    expect(api.requests).toHaveLength(1); // 无变化

    source.setMetrics({ rowHeight: ROW_H, viewportRows: 20 });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.count).toBe(20 + 1 + 2 * OVERSCAN);
  });

  it('anchor / restoreAnchor 保持 (行, 行内像素偏移)', async () => {
    const { api, source } = setup();
    source.scrollTo(100 * ROW_H + 5);
    expect(source.anchor()).toEqual({ row: 100, offsetPx: 5 });

    source.scrollTo(0);
    source.restoreAnchor({ row: 100, offsetPx: 5 });
    expect(source.snapshot().scrollTopPx).toBe(100 * ROW_H + 5);
    // 未 resolve 的在途请求清理掉，避免测试悬挂
    await api.resolveNext();
    await flush();
  });

  it('换根重置滚动；同根换版本保留滚动位置与上一帧（stale）', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    await api.resolveNext();
    await flush();

    source.scrollTo(10 * ROW_H);
    const rows = source.snapshot().rows.slice();

    source.setRoot({ rootId: 'doc', rowVersion: 2, totalRows: TOTAL_ROWS });
    expect(source.snapshot().scrollTopPx).toBe(10 * ROW_H);
    expect(source.snapshot().rows).toEqual(rows);
    expect(source.snapshot().stale).toBe(true);

    source.setRoot({ rootId: 'expr:1', rowVersion: 1, totalRows: 500 });
    expect(source.snapshot().scrollTopPx).toBe(0);
    expect(source.snapshot().rows).toHaveLength(0);
  });

  it('setRoot 带 scrollTopPx：锚点原子复位（回顶）、保留上一帧、只请求新锚点（#9 闪帧回归）', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    await api.resolveNext();
    await flush();

    // 滚到 200 行并拿到该窗口
    source.scrollTo(200 * ROW_H);
    await api.resolveNext();
    await flush();
    const rowsBefore = source.snapshot().rows.slice();
    expect(source.snapshot().start).toBe(200 - OVERSCAN);

    // 全部收起/展开：换 rowVersion + totalRows 骤降，同时明确「回到顶部」
    source.setRoot({ rootId: 'doc', rowVersion: 2, totalRows: 3 }, { scrollTopPx: 0 });

    expect(source.snapshot().scrollTopPx).toBe(0);
    // 复位后这一刻的上一帧必须锚在顶部（否则旧 start 的 85 行会被 spacer 裁到视口外 = 空白帧）
    expect(source.snapshot().start).toBe(0);
    expect(source.snapshot().rows).toEqual(rowsBefore); // 保留上一帧避免空白
    expect(source.snapshot().stale).toBe(true);

    // 紧接着取窗口：必须请求顶部窗口，而不是被夹到 totalRows-1 的旧锚点
    source.requestWindow();
    expect(api.requests.at(-1)?.start).toBe(0);
    expect(api.requests.at(-1)?.count).toBe(3);

    await api.resolveNext();
    await flush();
    expect(source.snapshot().start).toBe(0);
    expect(source.snapshot().rows).toHaveLength(3);
    expect(source.snapshot().stale).toBe(false);
  });
});
