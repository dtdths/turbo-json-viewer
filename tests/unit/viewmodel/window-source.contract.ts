/**
 * viewmodel/window-source 共享契约（S2 / ADR-0008 修订 2026-11-09）。
 *
 * 一份用例 × 两个 adapter：`RowWindowSource` 与 `RawWindowSource` 都跑同一套窗口不变量，
 * 防止两份实现各自漂移。adapter 专有行为（row 的方向预取/锚点/闪帧；raw 的 open/ready/
 * alignTruncated）留在各自的测试文件里，不进本契约。
 */
import { describe, expect, it, vi } from 'vitest';
import type { WindowMetrics } from '../../../src/viewmodel/window-machine';
import { CoreError, type CoreErrorCode } from '../../../src/protocol/errors';

export const ROW_H = 24;
export const VIEWPORT = 40;
export const OVERSCAN = 8;
export const TOTAL_ROWS = 10_000;
export const BASE_COUNT = VIEWPORT + 1 + 2 * OVERSCAN; // 57

export interface ContractSnapshot {
  stale: boolean;
  start: number;
  payload: number;
  total: number;
  scrollTopPx: number;
}

export interface ContractReplyOverrides {
  /** 回包 seq 偏移（-1 = 落后） */
  seqDelta?: number;
  wrongVersion?: boolean;
  wrongRoot?: boolean;
}

export interface ContractSource {
  setMetrics(next: WindowMetrics): void;
  scrollTo(scrollTopPx: number): void;
  requestWindow(): void;
  snapshot(): unknown;
  subscribe(listener: (snapshot: unknown) => void): () => void;
  lastError(): CoreError | null;
}

export interface ContractHarness {
  source: ContractSource;
  requests: ReadonlyArray<{ start: number; count: number }>;
  view(): ContractSnapshot;
  resolveNext(overrides?: ContractReplyOverrides): void;
  rejectNext(error: unknown): void;
  /** 建立 root（row: setRoot；raw: open + rawOpen 回包）并触发首窗请求 */
  seed(): Promise<void> | void;
}

export interface ContractHarnessFactoryOptions {
  totalRows: number;
  overscan?: number;
}

export type ContractHarnessFactory = (opts: ContractHarnessFactoryOptions) => ContractHarness;

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const staleError = (code: CoreErrorCode): CoreError => new CoreError({ code, message: `${code} (contract)` });

export function runWindowSourceContract(label: string, factory: ContractHarnessFactory): void {
  const seed = async (opts: { totalRows?: number; overscan?: number } = {}): Promise<ContractHarness> => {
    const harness = factory({ totalRows: opts.totalRows ?? TOTAL_ROWS, overscan: opts.overscan });
    await harness.seed();
    return harness;
  };
  const settle = async (harness: ContractHarness): Promise<void> => {
    harness.resolveNext();
    await flush();
  };

  describe(`${label} — 窗口契约（共享）`, () => {
    it('首窗几何：start=0、count=viewport+1+2×overscan；此刻帧为 stale', async () => {
      const harness = await seed();
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]).toMatchObject({ start: 0, count: BASE_COUNT });
      expect(harness.view().stale).toBe(true);
    });

    it('滚动后 start 前移 overscan 行；接近末尾夹到 total-1', async () => {
      const harness = await seed();
      await settle(harness);

      harness.source.scrollTo(100 * ROW_H);
      expect(harness.requests).toHaveLength(2);
      expect(harness.requests[1]?.start).toBe(100 - OVERSCAN);
      await settle(harness);

      harness.source.scrollTo((TOTAL_ROWS - 1) * ROW_H);
      expect(harness.requests[2]?.start).toBe(TOTAL_ROWS - 1 - OVERSCAN);

      // 小文档滚过头：start 夹到 total-1
      const small = await seed({ totalRows: 20 });
      await settle(small);
      small.source.scrollTo(100 * ROW_H);
      expect(small.requests[1]?.start).toBe(19);
    });

    it('单飞 + 合并：在途时只排队最后一个目标，回包后补发', async () => {
      const harness = await seed();
      harness.source.scrollTo(10 * ROW_H);
      harness.source.scrollTo(20 * ROW_H);
      expect(harness.requests).toHaveLength(1);

      harness.resolveNext();
      await flush();
      expect(harness.requests).toHaveLength(2);
      expect(harness.requests[1]?.start).toBe(20 * 1 - OVERSCAN);
    });

    it('requestWindow 幂等：已覆盖同一窗口时不重复请求', async () => {
      const harness = await seed();
      await settle(harness);

      harness.source.requestWindow();
      harness.source.requestWindow();
      expect(harness.requests).toHaveLength(1);
    });

    it('seq 落后的回包被丢弃且不 notify，并按当前目标重取', async () => {
      const harness = await seed();
      await settle(harness);
      const seen = vi.fn();
      harness.source.subscribe(seen);

      harness.source.scrollTo(20 * ROW_H);
      harness.resolveNext({ seqDelta: -1 });
      await flush();

      expect(seen).not.toHaveBeenCalled();
      expect(harness.requests.length).toBe(3); // 丢弃后按当前目标重取
    });

    it('根不符的回包被丢弃且不 notify，并按当前目标重取', async () => {
      const harness = await seed();
      await settle(harness);
      const seen = vi.fn();
      harness.source.subscribe(seen);

      harness.source.scrollTo(20 * ROW_H);
      harness.resolveNext({ wrongRoot: true });
      await flush();

      expect(seen).not.toHaveBeenCalled();
      expect(harness.requests.length).toBe(3); // 丢弃后按当前目标重取
    });

    it('成功回包更新快照并 notify 一次', async () => {
      const harness = await seed();
      const seen = vi.fn();
      harness.source.subscribe(seen);
      harness.resolveNext();
      await flush();

      expect(seen).toHaveBeenCalledTimes(1);
      expect(harness.view()).toMatchObject({ stale: false, start: 0, total: TOTAL_ROWS });
      expect(harness.view().payload).toBeGreaterThan(0);
    });

    it('普通失败 → stale=true、保留上一帧、记录 lastError、不自动重试', async () => {
      const harness = await seed();
      await settle(harness);
      const before = harness.view();
      const seen = vi.fn();
      harness.source.subscribe(seen);

      harness.source.scrollTo(20 * ROW_H);
      harness.rejectNext(staleError('TIMEOUT'));
      await flush();

      expect(seen).toHaveBeenCalledTimes(1);
      expect(harness.view().stale).toBe(true);
      expect(harness.view().payload).toBe(before.payload);
      expect(harness.source.lastError()?.code).toBe('TIMEOUT');
    });

    it('空窗口：不发请求，直接给空且非 stale 的帧', async () => {
      const harness = await seed({ totalRows: 0 });
      await flush();

      expect(harness.requests).toHaveLength(0);
      expect(harness.view()).toMatchObject({ stale: false, start: 0, total: 0, payload: 0 });
    });

    it('过期重试上限 3：连续 STALE_ROOT 第 4 次降级为 stale，不再发请求', async () => {
      const harness = await seed();
      await settle(harness);
      const seen = vi.fn();
      harness.source.subscribe(seen);

      harness.source.scrollTo(20 * ROW_H);
      const before = harness.requests.length; // 2

      for (let i = 0; i < 3; i++) {
        harness.rejectNext(staleError('STALE_ROOT'));
        await flush();
      }
      expect(harness.requests.length).toBe(before + 3); // 3 次重取

      harness.rejectNext(staleError('STALE_ROOT'));
      await flush();
      expect(harness.requests.length).toBe(before + 3); // 第 4 次不再重取
      expect(harness.view().stale).toBe(true);
      expect(harness.source.lastError()?.code).toBe('STALE_ROOT');
      expect(seen).toHaveBeenCalledTimes(1); // 只有降级那一帧 notify
    });

    it('setMetrics：相同度量不重复请求；变化后按新视口重取', async () => {
      const harness = await seed();
      await settle(harness);

      harness.source.setMetrics({ rowHeight: ROW_H, viewportRows: VIEWPORT });
      expect(harness.requests).toHaveLength(1);

      harness.source.setMetrics({ rowHeight: ROW_H, viewportRows: 20 });
      expect(harness.requests).toHaveLength(2);
      expect(harness.requests[1]?.count).toBe(20 + 1 + 2 * OVERSCAN);
    });
  });
}
