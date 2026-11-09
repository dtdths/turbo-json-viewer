/**
 * viewmodel/row-window-source 单测 — S2 树侧 adapter（ADR-0008 修订 2026-11-09）。
 *
 * 共享窗口不变量（单飞/合并、seq/版本/根丢弃、失败降级、空窗口、重试上限、metrics）
 * 走 `window-source.contract.ts` 契约，对 row/raw 各跑一遍；本文件只留树侧专有行为：
 * 方向预取与 3 屏上限、锚点、换根保留帧、`scrollTopPx` 回顶闪帧回归。
 */
import { describe, expect, it } from 'vitest';
import { RowWindowSource } from '../../../src/viewmodel/row-window-source';
import type { CoreApi, WindowRequest } from '../../../src/protocol/core-api';
import type { Row, RowWindow } from '../../../src/protocol/types';
import {
  BASE_COUNT,
  OVERSCAN,
  ROW_H,
  TOTAL_ROWS,
  VIEWPORT,
  flush,
  runWindowSourceContract,
  type ContractHarness,
  type ContractHarnessFactoryOptions,
  type ContractReplyOverrides,
  type ContractSource,
} from './window-source.contract';

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

  /** 回包默认按请求原样构造；patch 模拟落后 seq / 版本不符 / 错根。 */
  resolveNext(patch: ContractReplyOverrides = {}): void {
    const next = this.pending.shift();
    if (!next) throw new Error('no pending window request');
    const { request } = next;
    next.resolve({
      rootId: patch.wrongRoot ? 'other-root' : request.rootId,
      rowVersion: patch.wrongVersion ? request.rowVersion + 1 : request.rowVersion,
      seq: request.seq + (patch.seqDelta ?? 0),
      start: request.start,
      count: request.count,
      rows: makeRows(request.start, request.count),
      totalRows: this.totalRows,
    });
  }

  rejectNext(error: unknown): void {
    const next = this.pending.shift();
    if (!next) throw new Error('no pending window request');
    next.reject(error);
  }
}

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

/** 共享契约：树侧 adapter 与原文侧 adapter 跑同一套窗口不变量。 */
function rowContractHarness(opts: ContractHarnessFactoryOptions): ContractHarness {
  const api = new FakeCore(opts.totalRows);
  const source = new RowWindowSource(api as unknown as CoreApi, {
    rowHeight: ROW_H,
    overscan: opts.overscan ?? OVERSCAN,
  });
  return {
    source: source as unknown as ContractSource,
    requests: api.requests,
    view() {
      const snapshot = source.snapshot();
      return {
        stale: snapshot.stale,
        start: snapshot.start,
        payload: snapshot.rows.length,
        total: snapshot.totalRows,
        scrollTopPx: snapshot.scrollTopPx,
      };
    },
    resolveNext(patch = {}) {
      api.resolveNext(patch);
    },
    rejectNext(error) {
      api.rejectNext(error);
    },
    seed() {
      source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });
      source.setRoot({ rootId: 'doc', rowVersion: 1, totalRows: opts.totalRows });
      source.scrollTo(0);
    },
  };
}

runWindowSourceContract('RowWindowSource', rowContractHarness);

describe('RowWindowSource — 方向预取 / 单次上限（adapter 配置）', () => {
  it('ΔscrollTop 超过 overscan×rowHeight 时 count 多取一屏；小幅滚动不预取', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    expect(api.requests[0]?.count).toBe(BASE_COUNT);
    api.resolveNext();
    await flush();

    // Δ = 200 行 > 8 行 → 预取一屏
    source.scrollTo(200 * ROW_H);
    expect(api.requests[1]?.count).toBe(BASE_COUNT + VIEWPORT);
    api.resolveNext();
    await flush();

    // Δ = 1 行 → 不预取
    source.scrollTo(201 * ROW_H);
    expect(api.requests[2]?.count).toBe(BASE_COUNT);
    api.resolveNext();
    await flush();
  });

  it('单次窗口上限 3 屏', async () => {
    const { api, source } = setup({ overscan: 20 });
    source.scrollTo(0);
    expect(api.requests[0]?.count).toBe(VIEWPORT + 1 + 2 * 20);
    api.resolveNext();
    await flush();

    source.scrollTo(200 * ROW_H);
    expect(api.requests[1]?.count).toBe(VIEWPORT * 3); // 预取 121 → 封顶 120
    api.resolveNext();
    await flush();
  });
});

describe('RowWindowSource — 锚点 / 换根', () => {
  it('anchor / restoreAnchor 保持 (行, 行内像素偏移)', async () => {
    const { api, source } = setup();
    source.scrollTo(100 * ROW_H + 5);
    expect(source.anchor()).toEqual({ row: 100, offsetPx: 5 });

    source.scrollTo(0);
    source.restoreAnchor({ row: 100, offsetPx: 5 });
    expect(source.snapshot().scrollTopPx).toBe(100 * ROW_H + 5);
    // 未 resolve 的在途请求清理掉，避免测试悬挂
    api.resolveNext();
    await flush();
  });

  it('换根重置滚动；同根换版本保留滚动位置与上一帧（stale）', async () => {
    const { api, source } = setup();
    source.scrollTo(0);
    api.resolveNext();
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
    api.resolveNext();
    await flush();

    // 滚到 200 行并拿到该窗口
    source.scrollTo(200 * ROW_H);
    api.resolveNext();
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

    api.resolveNext();
    await flush();
    expect(source.snapshot().start).toBe(0);
    expect(source.snapshot().rows).toHaveLength(3);
    expect(source.snapshot().stale).toBe(false);
  });
});
