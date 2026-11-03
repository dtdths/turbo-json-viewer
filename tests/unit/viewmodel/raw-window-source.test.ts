/**
 * viewmodel/raw-window-source 单测 — 原文窗口不变量（ADR-0003 修订 §4/§7）。
 *
 * 覆盖：open → rawOpen → 首窗（含 stale 帧、滚动复位）、单飞 + 合并、
 * seq / rootId 迟到回包丢弃且自动重取、open 竞态（epoch）、失败保留上一帧、
 * STALE_* 自动重取、metrics 变化重取、clear、空文档、truncated 对齐、同根重进保留旧行。
 *
 * 风格与 tests/unit/viewmodel/row-window-source.test.ts 一致：fake CoreApi 由测试手动 resolve/reject，
 * 用 setTimeout(0) flush 微任务。
 */
import { describe, expect, it, vi } from 'vitest';
import { RawWindowSource } from '../../../src/viewmodel/raw-window-source';
import type { CoreApi } from '../../../src/protocol/core-api';
import { CoreError } from '../../../src/protocol/errors';
import type { RawMeta, RawWindow, RootId } from '../../../src/protocol/types';

const ROW_H = 24;
const VIEWPORT = 40;
const OVERSCAN = 8;
const TOTAL_LINES = 10_000;
const BASE_COUNT = VIEWPORT + 1 + 2 * OVERSCAN; // 57

function makeLines(start: number, count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(`line-${start + i + 1}`);
  return lines;
}

interface OpenRequest {
  rootId: RootId;
}
interface WindowRequest {
  rootId: RootId;
  seq: number;
  start: number;
  count: number;
}

class FakeRawCore {
  readonly opens: OpenRequest[] = [];
  readonly windows: WindowRequest[] = [];
  private readonly pendingOpens: Array<{
    request: OpenRequest;
    resolve: (meta: RawMeta) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly pendingWindows: Array<{
    request: WindowRequest;
    resolve: (reply: RawWindow) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(readonly totalLines: number = TOTAL_LINES) {}

  rawOpen(request: OpenRequest): Promise<RawMeta> {
    this.opens.push(request);
    return new Promise<RawMeta>((resolve, reject) => {
      this.pendingOpens.push({ request, resolve, reject });
    });
  }

  rawWindow(request: WindowRequest): Promise<RawWindow> {
    this.windows.push(request);
    return new Promise<RawWindow>((resolve, reject) => {
      this.pendingWindows.push({ request, resolve, reject });
    });
  }

  get pendingOpenCount(): number {
    return this.pendingOpens.length;
  }

  get pendingWindowCount(): number {
    return this.pendingWindows.length;
  }

  /** 回 open（FIFO）；overrides 模拟异常 meta（damaged / totalLines 变化）。 */
  resolveNextOpen(overrides: Partial<RawMeta> = {}): void {
    const next = this.pendingOpens.shift();
    if (!next) throw new Error('no pending rawOpen request');
    next.resolve({
      mode: 'source',
      totalLines: this.totalLines,
      chars: this.totalLines * 8,
      maxLineLength: 16,
      ...overrides,
    });
  }

  rejectNextOpen(error: unknown): void {
    const next = this.pendingOpens.shift();
    if (!next) throw new Error('no pending rawOpen request');
    next.reject(error);
  }

  /** 回窗口（FIFO）；默认按请求原样构造，overrides 模拟乱序 / 伪造回包。 */
  resolveNextWindow(overrides: Partial<RawWindow> = {}): void {
    const next = this.pendingWindows.shift();
    if (!next) throw new Error('no pending rawWindow request');
    const { request } = next;
    next.resolve({
      rootId: request.rootId,
      seq: request.seq,
      start: request.start,
      lines: makeLines(request.start, request.count),
      totalLines: this.totalLines,
      mode: 'source',
      ...overrides,
    });
  }

  rejectNextWindow(error: unknown): void {
    const next = this.pendingWindows.shift();
    if (!next) throw new Error('no pending rawWindow request');
    next.reject(error);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { totalLines?: number; overscan?: number; viewportRows?: number } = {}) {
  const api = new FakeRawCore(options.totalLines ?? TOTAL_LINES);
  const source = new RawWindowSource(api as unknown as CoreApi, {
    rowHeight: ROW_H,
    overscan: options.overscan ?? OVERSCAN,
  });
  source.setMetrics({ rowHeight: ROW_H, viewportRows: options.viewportRows ?? VIEWPORT });
  return { api, source };
}

/** open → 解析 rawOpen → 解析首窗，返回已就绪的 source。 */
async function openReady(api: FakeRawCore, source: RawWindowSource, rootId = 'doc'): Promise<void> {
  const opened = source.open(rootId);
  api.resolveNextOpen();
  await opened;
  await flush();
  api.resolveNextWindow();
  await flush();
}

describe('RawWindowSource — open → 首窗', () => {
  it('open 先 emit stale 空帧，rawOpen 成功后 pump 首窗（start=0）', async () => {
    const { api, source } = setup();
    const seen = vi.fn();
    source.subscribe(seen);

    const opened = source.open('doc');
    expect(api.opens).toEqual([{ rootId: 'doc' }]);
    // rawOpen 未回：stale 帧、totalLines 未知、不发行窗口
    expect(seen).toHaveBeenCalledTimes(1);
    expect(source.snapshot().stale).toBe(true);
    expect(source.snapshot().rootId).toBe('doc');
    expect(source.snapshot().totalLines).toBe(0);
    expect(source.snapshot().lines).toEqual([]);
    expect(api.windows).toHaveLength(0);

    api.resolveNextOpen();
    await opened;
    await flush();

    // meta 落地：再 emit 一帧（stale，totalLines 已知）并请求首窗
    expect(source.snapshot().stale).toBe(true);
    expect(source.snapshot().totalLines).toBe(TOTAL_LINES);
    expect(source.snapshot().mode).toBe('source');
    expect(api.windows).toHaveLength(1);
    expect(api.windows[0]).toMatchObject({ rootId: 'doc', start: 0, count: BASE_COUNT });

    api.resolveNextWindow();
    await flush();

    const snapshot = source.snapshot();
    expect(snapshot.stale).toBe(false);
    expect(snapshot.rootId).toBe('doc');
    expect(snapshot.start).toBe(0);
    expect(snapshot.lines).toHaveLength(BASE_COUNT);
    expect(snapshot.lines[0]).toBe('line-1');
    expect(snapshot.totalLines).toBe(TOTAL_LINES);
    expect(snapshot.scrollTopPx).toBe(0);
    expect(source.lastError()).toBeNull();
  });

  it('rendered 行数 ≤ viewportRows + 1 + 2×overscan，且末尾窗口不越界', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    // 滚到极底（远超 totalLines）
    source.scrollTo(1_000_000);
    expect(api.windows.at(-1)?.start).toBe(TOTAL_LINES - 1);
    api.resolveNextWindow();
    await flush();
    const snapshot = source.snapshot();
    expect(snapshot.start + snapshot.lines.length).toBeLessThanOrEqual(TOTAL_LINES);
    expect(snapshot.lines.length).toBeLessThanOrEqual(BASE_COUNT);
  });

  it('open 重置滚动，并按顶部重新请求（open 之后 start=0）', async () => {
    const { api, source } = setup();
    await openReady(api, source);

    source.scrollTo(100 * ROW_H);
    api.resolveNextWindow();
    await flush();
    expect(source.snapshot().scrollTopPx).toBe(100 * ROW_H);

    const before = api.windows.length;
    const reopened = source.open('doc');
    expect(source.snapshot().scrollTopPx).toBe(0);
    expect(source.snapshot().stale).toBe(true);
    expect(source.snapshot().lines.length).toBeGreaterThan(0); // 同根重进保留旧行（不闪白）

    api.resolveNextOpen();
    await reopened;
    await flush();
    expect(api.windows.length).toBe(before + 1);
    expect(api.windows.at(-1)?.start).toBe(0);

    api.resolveNextWindow();
    await flush();
    expect(source.snapshot().start).toBe(0);
    expect(source.snapshot().stale).toBe(false);
  });

  it('空文档：rawOpen 后不发行窗口，直接给空且非 stale 的帧', async () => {
    const { api, source } = setup({ totalLines: 0 });
    const opened = source.open('doc');
    api.resolveNextOpen();
    await opened;
    await flush();

    expect(api.windows).toHaveLength(0);
    expect(source.snapshot().stale).toBe(false);
    expect(source.snapshot().totalLines).toBe(0);
    expect(source.snapshot().lines).toEqual([]);
  });
});

describe('RawWindowSource — 单飞 + 合并', () => {
  it('连续 scrollTo 只保留一个在途请求，回包后补发最后一个目标', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const before = api.windows.length;

    source.scrollTo(10 * ROW_H);
    source.scrollTo(20 * ROW_H);
    expect(api.windows.length).toBe(before + 1); // 合并没有取消在途
    expect(api.pendingWindowCount).toBe(1);

    api.resolveNextWindow();
    await flush();

    expect(api.windows.length).toBe(before + 2);
    expect(api.windows.at(-1)?.start).toBe(20 - OVERSCAN);
  });

  it('requestWindow 幂等：已覆盖同一窗口时不重复请求', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const before = api.windows.length;

    source.requestWindow();
    source.requestWindow();
    expect(api.windows.length).toBe(before);
  });
});

describe('RawWindowSource — 过期回包', () => {
  it('seq 落后的回包被丢弃、不 notify、自动按当前目标重取', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const linesBefore = source.snapshot().lines.slice();
    const windowsBefore = api.windows.length;

    const seen = vi.fn();
    source.subscribe(seen);
    source.scrollTo(20 * ROW_H);
    api.resolveNextWindow({ seq: 0 }); // 伪造落后 seq
    await flush();

    expect(seen).not.toHaveBeenCalled();
    expect(source.snapshot().lines).toEqual(linesBefore);
    expect(source.snapshot().stale).toBe(false);
    expect(api.windows.length).toBe(windowsBefore + 2); // 丢弃后自动重取

    api.resolveNextWindow();
    await flush();
    expect(source.snapshot().start).toBe(20 - OVERSCAN);
  });

  it('rootId 不符的回包被丢弃、不 notify、自动重取', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const linesBefore = source.snapshot().lines.slice();
    const windowsBefore = api.windows.length;

    const seen = vi.fn();
    source.subscribe(seen);
    source.scrollTo(20 * ROW_H);
    api.resolveNextWindow({ rootId: 'doc:other' });
    await flush();

    expect(seen).not.toHaveBeenCalled();
    expect(source.snapshot().lines).toEqual(linesBefore);
    expect(api.windows.length).toBe(windowsBefore + 2);
  });

  it('open 竞态（epoch）：旧 rawOpen / 旧行窗口回包不污染新根', async () => {
    const { api, source } = setup();
    await openReady(api, source, 'doc:1');
    expect(api.windows.at(-1)?.rootId).toBe('doc:1');
    expect(api.pendingWindowCount).toBe(0);

    // 旧根的行窗口在途时切到 doc:2
    source.scrollTo(20 * ROW_H);
    const oldWindowCount = api.windows.length;
    const reopened = source.open('doc:2');

    // 旧回包到达：不应 notify、不应改快照
    const seen = vi.fn();
    source.subscribe(seen);
    api.resolveNextWindow(); // 属于 doc:1 的迟到回包
    await flush();
    expect(seen).not.toHaveBeenCalled();
    expect(source.snapshot().rootId).toBe('doc:2');
    expect(source.snapshot().lines).toEqual([]);
    expect(api.windows.length).toBe(oldWindowCount); // 没有按旧根再发

    // 新 rawOpen 回包后只取 doc:2 的窗口
    api.resolveNextOpen();
    await reopened;
    await flush();
    expect(api.windows.at(-1)?.rootId).toBe('doc:2');
    expect(api.windows.at(-1)?.start).toBe(0);

    api.resolveNextWindow();
    await flush();
    expect(source.snapshot().rootId).toBe('doc:2');
    expect(source.snapshot().stale).toBe(false);
  });

  it('被后来者取代的 rawOpen 失败：旧 open reject 但不 emit 旧帧、不改新根状态', async () => {
    const { api, source } = setup();
    const first = source.open('doc:1');
    const second = source.open('doc:2');
    expect(api.opens).toHaveLength(2);

    const seen = vi.fn();
    source.subscribe(seen);
    api.rejectNextOpen(new CoreError({ code: 'NO_ROOT', message: 'root gone' }));
    await expect(first).rejects.toMatchObject({ code: 'NO_ROOT' });
    await flush();

    expect(seen).not.toHaveBeenCalled(); // 旧 open 不再 emit
    expect(source.snapshot().rootId).toBe('doc:2');
    expect(source.snapshot().stale).toBe(true);
    expect(source.lastError()).toBeNull(); // 失败未记到新根上

    api.resolveNextOpen();
    await second;
    await flush();
    expect(api.windows.at(-1)?.rootId).toBe('doc:2');
  });
});

describe('RawWindowSource — 失败降级', () => {
  it('普通错误 → stale=true、保留上一帧、notify、不自动重试', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const linesBefore = source.snapshot().lines.slice();
    const windowsBefore = api.windows.length;

    const seen = vi.fn();
    source.subscribe(seen);
    source.scrollTo(20 * ROW_H);
    api.rejectNextWindow(new CoreError({ code: 'TIMEOUT', message: 'rawWindow timeout' }));
    await flush();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(source.snapshot().stale).toBe(true);
    expect(source.snapshot().lines).toEqual(linesBefore);
    expect(source.lastError()?.code).toBe('TIMEOUT');
    expect(api.windows.length).toBe(windowsBefore + 1); // 不自动重试
  });

  it('STALE_ROW 视为迟到竞争 → 自动重取，不标记 stale/error', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const windowsBefore = api.windows.length;

    source.scrollTo(20 * ROW_H);
    api.rejectNextWindow(new CoreError({ code: 'STALE_ROW', message: 'stale' }));
    await flush();

    expect(api.windows.length).toBe(windowsBefore + 2); // 自动重取
    expect(source.snapshot().stale).toBe(false);
    expect(source.lastError()).toBeNull();

    api.resolveNextWindow();
    await flush();
    expect(source.snapshot().start).toBe(20 - OVERSCAN);
    expect(source.snapshot().stale).toBe(false);
  });

  it('STALE_ROOT 连续超过 3 次：停止重取，标记 stale + lastError（防风暴）', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const windowsBefore = api.windows.length;

    source.scrollTo(20 * ROW_H);
    for (let i = 0; i < 4; i++) {
      api.rejectNextWindow(new CoreError({ code: 'STALE_ROOT', message: 'root gone' }));
      await flush();
    }

    expect(api.windows.length).toBe(windowsBefore + 4); // 1 次原始 + 3 次重取
    expect(source.snapshot().stale).toBe(true);
    expect(source.lastError()?.code).toBe('STALE_ROOT');
  });

  it('rawOpen 失败：emit stale 帧、记录 lastError、reject 且不发窗口', async () => {
    const { api, source } = setup();
    const seen = vi.fn();
    source.subscribe(seen);

    const opened = source.open('doc');
    expect(seen).toHaveBeenCalledTimes(1); // 先 emit stale 帧
    api.rejectNextOpen(new CoreError({ code: 'TIMEOUT', message: 'rawOpen timeout' }));
    await expect(opened).rejects.toMatchObject({ code: 'TIMEOUT' });
    await flush();

    expect(seen).toHaveBeenCalledTimes(2); // 失败后再 emit 一帧（仍 stale）
    expect(source.snapshot().stale).toBe(true);
    expect(source.snapshot().rootId).toBe('doc');
    expect(source.snapshot().lines).toEqual([]);
    expect(source.lastError()?.code).toBe('TIMEOUT');
    expect(api.windows).toHaveLength(0);
  });
});

describe('RawWindowSource — metrics / clear / 回包细节', () => {
  it('setMetrics 变化后重取；相同度量不重复请求', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    const windowsBefore = api.windows.length;

    source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });
    expect(api.windows.length).toBe(windowsBefore); // 无变化

    source.setMetrics({ rowHeight: ROW_H, viewportRows: 20 });
    expect(api.windows.length).toBe(windowsBefore + 1);
    expect(api.windows.at(-1)?.count).toBe(20 + 1 + 2 * OVERSCAN);

    api.resolveNextWindow();
    await flush();
    expect(source.metrics()).toEqual({ rowHeight: ROW_H, viewportRows: 20 });
  });

  it('clear：清空快照并使在途回包作废', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    source.scrollTo(20 * ROW_H); // 在途

    const seen = vi.fn();
    source.subscribe(seen);
    source.clear();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(source.snapshot()).toMatchObject({
      rootId: '',
      mode: 'source',
      lines: [],
      truncated: [],
      start: 0,
      totalLines: 0,
      stale: false,
      scrollTopPx: 0,
    });
    expect(source.lastError()).toBeNull();

    // 迟到回包不得复活快照
    api.resolveNextWindow();
    await flush();
    expect(source.snapshot().rootId).toBe('');
    expect(source.snapshot().lines).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(1);

    // clear 后滚动 / requestWindow 不再发请求
    source.scrollTo(0);
    source.requestWindow();
    expect(api.pendingWindowCount).toBe(0);
  });

  it('truncated 与 lines 对齐（缺省补 0）', async () => {
    const { api, source } = setup();
    const opened = source.open('doc');
    api.resolveNextOpen();
    await opened;
    await flush();

    api.resolveNextWindow({ truncated: [0, 12] }); // 只给前两行
    await flush();
    const snapshot = source.snapshot();
    expect(snapshot.truncated).toHaveLength(snapshot.lines.length);
    expect(snapshot.truncated[0]).toBe(0);
    expect(snapshot.truncated[1]).toBe(12);
    expect(snapshot.truncated[2]).toBe(0);
  });

  it('mode 随回包更新（pretty / plain）', async () => {
    const { api, source } = setup();
    await openReady(api, source);
    expect(source.snapshot().mode).toBe('source');

    source.scrollTo(20 * ROW_H);
    api.resolveNextWindow({ mode: 'plain' });
    await flush();
    expect(source.snapshot().mode).toBe('plain');
  });
});
