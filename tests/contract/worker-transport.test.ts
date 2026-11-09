/**
 * tests/contract/worker-transport.test.ts — 只有 Worker 适配器能测的故障路径。
 *
 * 为什么不在共享契约里（core-transport.cases.ts）：
 *   - TIMEOUT / CLOSED / WORKER_CRASH 都由**传输层**制造（MessageChannel 无回包、close、worker onerror），
 *     in-process 适配器没有通道与 worker 生命周期，无从产生这三种错误；
 *   - 共享用例因此只放「两个适配器都能观察到的行为」，故障路径按 seams.md §2 不变式 5 单独守。
 *
 * 这里用 FakeWorker 的 `hold` 模式（只收命令、不回包）+ 可注入超时值来稳定复现，
 * 不 sleep 线上默认的 5s/2s。
 */
import { describe, expect, it } from 'vitest';
import { createWorkerCore } from '../../src/app/transport/worker-transport';
import { CoreError } from '../../src/protocol/errors';
import type { CoreEvent } from '../../src/protocol/messages';
import { FakeWorker } from './fake-worker';

async function errorOf(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof CoreError)) throw err;
    return err;
  }
  throw new Error('expected the command to reject');
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('WorkerTransport 故障路径（仅 worker 适配器可测）', () => {
  it('TIMEOUT：两档超时按注入值生效（默认 5s / 2s），且不自动重试', async () => {
    const fake = new FakeWorker({ mode: 'hold' }); // 只收不回 → 逼出超时
    const core = createWorkerCore(fake, { commandTimeoutMs: 30, windowTimeoutMs: 5 });
    try {
      const commandErr = await errorOf(core.api.stats('doc'));
      expect(commandErr.code).toBe('TIMEOUT');
      expect(commandErr.message).toContain('stats');
      expect(commandErr.message).toContain('30ms');

      const windowErr = await errorOf(
        core.api.window({ rootId: 'doc', rowVersion: 1, seq: 1, start: 0, count: 1 }),
      );
      expect(windowErr.code).toBe('TIMEOUT');
      expect(windowErr.message).toContain('window');
      expect(windowErr.message).toContain('5ms');

      await delay(10); // 让已 postMessage 的命令投递到 fake 侧
      // 不自动重试：每个命令只发一次
      expect(fake.commands.map((wire) => wire.cmd.t)).toEqual(['stats', 'window']);
    } finally {
      core.close();
    }
  });

  it('WORKER_CRASH：onerror 让全部 pending reject，之后新命令立即 reject 且不再走通道', async () => {
    const fake = new FakeWorker({ mode: 'hold' });
    const core = createWorkerCore(fake);
    try {
      const events: CoreEvent[] = [];
      core.api.on((event) => events.push(event));
      const first = core.api.stats('doc');
      const second = core.api.window({ rootId: 'doc', rowVersion: 1, seq: 1, start: 0, count: 1 });

      fake.triggerError(); // 等价 worker.onerror
      expect((await errorOf(first)).code).toBe('WORKER_CRASH');
      expect((await errorOf(second)).code).toBe('WORKER_CRASH');

      await delay(10);
      const sentBeforeCrash = fake.commands.length;
      // 之后新命令**立即** reject WORKER_CRASH，且不再 postMessage（文档已丢失）
      expect((await errorOf(core.api.stats('doc'))).code).toBe('WORKER_CRASH');
      await delay(10);
      expect(fake.commands.length).toBe(sentBeforeCrash);

      // 崩溃后事件也不再派发：fake 仍能往打开着的 port post，但 transport 必须丢弃
      fake.emitEvent({ t: 'load-progress', loadId: 1, phase: 'parse' });
      await delay(10);
      expect(events).toEqual([]);
    } finally {
      core.close(); // 崩溃后 close 仍应可用且幂等
    }
  });

  it('WORKER_CRASH：onmessageerror 同样收口（消息无法结构化克隆 = worker 不可用）', async () => {
    const fake = new FakeWorker({ mode: 'hold' });
    const core = createWorkerCore(fake);
    try {
      const pending = core.api.stats('doc');
      fake.triggerMessageError(); // 等价 worker.onmessageerror
      expect((await errorOf(pending)).code).toBe('WORKER_CRASH');
      expect((await errorOf(core.api.stats('doc'))).code).toBe('WORKER_CRASH');
    } finally {
      core.close();
    }
  });

  it('CLOSED：close() 幂等、pending 全 reject CLOSED、之后新命令立即 CLOSED、不再派 event', async () => {
    const fake = new FakeWorker({ mode: 'hold' });
    const core = createWorkerCore(fake);
    const events: CoreEvent[] = [];
    core.api.on((event) => events.push(event));

    const pending = core.api.stats('doc');
    await delay(10); // 确认命令已真正发出（fake 侧收到）
    core.close();
    expect((await errorOf(pending)).code).toBe('CLOSED');
    expect(() => core.close()).not.toThrow(); // 幂等

    // close 之后的新命令立即 CLOSED，且不存在「重开」路径
    expect((await errorOf(core.api.stats('doc'))).code).toBe('CLOSED');
    await delay(10);
    expect(fake.commands).toHaveLength(1); // 只有 close 前那一条真正发出过

    // 不再派 event：fake 仍往 port post，但 transport 已关闭，监听器不能被调用
    fake.emitEvent({ t: 'load-progress', loadId: 1, phase: 'decode' });
    await delay(10);
    expect(events).toEqual([]);
  });
});
