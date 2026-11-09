/**
 * viewmodel/raw-window-source 单测 — S2 原文侧 adapter（ADR-0003 修订 §4/§7 / ADR-0008 修订 2026-11-09）。
 *
 * 共享窗口不变量（单飞/合并、seq/根丢弃、失败降级、空窗口、重试上限、metrics）走
 * `window-source.contract.ts` 契约，对 row/raw 各跑一遍；本文件只留原文侧专有行为：
 * 两拍 `open`（rawOpen → rawWindow）、同根重进保留旧行、open 竞态（epoch）、rawOpen 失败、
 * clear、truncated 对齐、mode 跟随回包、末尾窗口不越界、STALE_ROW 自动重取。
 */
import { describe, expect, it, vi } from 'vitest';
import { RawWindowSource } from '../../../src/viewmodel/raw-window-source';
import type { CoreApi } from '../../../src/protocol/core-api';
import { CoreError } from '../../../src/protocol/errors';
import type { RawMeta, RawWindow, RootId } from '../../../src/protocol/types';
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

const TOTAL_LINES = TOTAL_ROWS;

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

  /** 回窗口（FIFO）；overrides 模拟乱序 / 伪造回包 / mode / truncated。 */
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

  /** 契约用：按 seq 偏移 / 错根构造回包。 */
  resolveNextWindowWith(patch: ContractReplyOverrides = {}): void {
    const next = this.pendingWindows.shift();
    if (!next) throw new Error('no pending rawWindow request');
    const { request } = next;
    next.resolve({
      rootId: patch.wrongRoot ? 'other-root' : request.rootId,
      seq: request.seq + (patch.seqDelta ?? 0),
      start: request.start,
      lines: makeLines(request.start, request.count),
      totalLines: this.totalLines,
      mode: 'source',
    });
  }

  rejectNextWindow(error: unknown): void {
    const next = this.pendingWindows.shift();
    if (!next) throw new Error('no pending rawWindow request');
    next.reject(error);
  }
}

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

/** 共享契约：原文侧 adapter 与树侧 adapter 跑同一套窗口不变量。 */
function rawContractHarness(opts: ContractHarnessFactoryOptions): ContractHarness {
  const api = new FakeRawCore(opts.totalRows);
  const source = new RawWindowSource(api as unknown as CoreApi, {
    rowHeight: ROW_H,
    overscan: opts.overscan ?? OVERSCAN,
  });
  return {
    source: source as unknown as ContractSource,
    requests: api.windows,
    view() {
      const snapshot = source.snapshot();
      return {
        stale: snapshot.stale,
        start: snapshot.start,
        payload: snapshot.lines.length,
        total: snapshot.totalLines,
        scrollTopPx: snapshot.scrollTopPx,
      };
    },
    resolveNext(patch = {}) {
      api.resolveNextWindowWith(patch);
    },
    rejectNext(error) {
      api.rejectNextWindow(error);
    },
    async seed() {
      source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });
      const opened = source.open('doc');
      api.resolveNextOpen();
      await opened;
      await flush();
    },
  };
}

runWindowSourceContract('RawWindowSource', rawContractHarness);

describe('RawWindowSource — open → 首窗（两拍）', () => {
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
});

describe('RawWindowSource — 首次进入：open 在途时的 metrics 不得毒化首窗', () => {
  it('rawOpen 回包前量到新视口 + requestWindow（totalLines 未知）→ 首窗仍按真实视口取行', async () => {
    // 真实 app 时序：进入原文视图时 setViewMode 先 settings.setUi → applySettings 同步
    // setMetrics(真实视口) + requestWindow；此时 rawSource.open() 的 rawOpen 还没回包，
    // machine.totalLines 仍是 0（placeholder）。首窗 count 不能被这个 0 夹成 1。
    const { api, source } = setup({ viewportRows: 1 });
    const opened = source.open('doc');

    source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });
    source.requestWindow();
    expect(api.windows).toHaveLength(0); // ready 门：rawOpen 落地前不发窗口

    api.resolveNextOpen();
    await opened;
    await flush();

    expect(api.windows).toHaveLength(1);
    expect(api.windows[0]).toMatchObject({ rootId: 'doc', start: 0, count: BASE_COUNT });
  });

  it('rawOpen 在途时发生 scroll（同样 totalLines 未知）→ 首窗仍是满视口', async () => {
    const { api, source } = setup({ viewportRows: 1 });
    const opened = source.open('doc');

    source.scrollTo(3 * ROW_H); // 例如浏览器恢复旧 scrollTop 触发 scroll
    source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });

    api.resolveNextOpen();
    await opened;
    await flush();

    expect(api.windows).toHaveLength(1);
    const first = api.windows[0];
    expect(first?.start).toBe(0); // open 已把锚点复位到顶部
    expect(first?.count).toBe(BASE_COUNT);
  });
});

describe('RawWindowSource — open 竞态（epoch）', () => {
  it('旧 rawOpen / 旧行窗口回包不污染新根', async () => {
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

describe('RawWindowSource — rawOpen 失败 / clear', () => {
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
});

describe('RawWindowSource — 回包细节', () => {
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

  it('STALE_ROW 视为迟到竞争 → 自动重取，不标记 stale / error', async () => {
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
});
