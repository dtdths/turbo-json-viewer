/**
 * app/transport/worker-transport — CoreTransport 的生产适配器。
 * 控制命令走 ctrl 通道，行窗口/trail 走独立 win 通道（ADR-0001），共用一个 CoreApi 门面。
 *
 * 生命周期（seams.md §2 不变式 5）：
 *   - 超时：普通命令 5s、window/getTrail 2s，不自动重试（超时可注入，测试用）；
 *   - `onerror` / `onmessageerror` = Worker 崩溃：全部 pending reject `WORKER_CRASH`、清 timer、
 *     置 crashed，之后新命令**立即** reject `WORKER_CRASH`（不再 postMessage，文档已丢失）；
 *   - `close()` 幂等：pending reject `CLOSED`、清 timer、关闭端口、terminate，之后不再派 event。
 *
 * 可移植性：只用全局 `setTimeout/clearTimeout`（不依赖 `window`），Node 测试环境可直接跑。
 */
import { commandCore, type CoreApi } from '../../protocol/core-api';
import { CoreError } from '../../protocol/errors';
import type { Command, CoreEvent, ReplyOf, WireCommand, WireReply } from '../../protocol/messages';

/**
 * Worker 的最小结构接口：生产 `Worker` 天然兼容；Node 单测可注入 FakeWorker。
 * 只用到跨线程消息、两类 worker 级错误回调与可选的 terminate。
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  terminate?(): void;
}

/** 超时可注入（测试/仿真用小值）；缺省即 seams.md §2 不变式 5 的线上值，行为不变。 */
export interface WorkerCoreOptions {
  /** 普通命令超时，默认 5000ms */
  commandTimeoutMs?: number;
  /** window / getTrail 超时，默认 2000ms */
  windowTimeoutMs?: number;
}

export interface WorkerCore {
  api: CoreApi;
  close(): void;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_WINDOW_TIMEOUT_MS = 2000;

export function createWorkerCore(worker: WorkerLike, options: WorkerCoreOptions = {}): WorkerCore {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const windowTimeoutMs = options.windowTimeoutMs ?? DEFAULT_WINDOW_TIMEOUT_MS;

  const ctrlChannel = new MessageChannel();
  const winChannel = new MessageChannel();
  const ctrl = ctrlChannel.port1;
  const win = winChannel.port1;

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
  >();
  const listeners = new Set<(event: CoreEvent) => void>();
  let closed = false;
  /** Worker 已崩溃：文档丢失，新命令一律立即 reject WORKER_CRASH（seams §2 失败模式） */
  let crashed = false;

  const closedError = (): CoreError => new CoreError({ code: 'CLOSED', message: 'transport closed' });
  const crashError = (): CoreError =>
    new CoreError({ code: 'WORKER_CRASH', message: 'worker crashed; document lost' });

  /** reject 全部 pending 并清 timer（崩溃与 close 共用）。 */
  const rejectPending = (error: CoreError): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  /** Worker 崩溃（onerror / onmessageerror）：幂等；之后事件也不再派发（线程已不可信）。 */
  const crash = (): void => {
    if (closed || crashed) return;
    crashed = true;
    rejectPending(crashError());
  };

  // 先挂错误回调，再发 connect：worker 在握手阶段崩溃也要能收口。
  worker.onerror = () => crash();
  worker.onmessageerror = () => crash();

  worker.postMessage(
    { kind: 'connect', ctrl: ctrlChannel.port2, win: winChannel.port2 },
    [ctrlChannel.port2, winChannel.port2],
  );

  const handle = (data: WireReply): void => {
    if (!data || closed || crashed) return;
    if (data.kind === 'event') {
      for (const listener of listeners) listener(data.event);
      return;
    }
    if (data.kind !== 'reply') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.value);
    else entry.reject(new CoreError(data.error));
  };

  ctrl.onmessage = (event: MessageEvent) => handle(event.data as WireReply);
  win.onmessage = (event: MessageEvent) => handle(event.data as WireReply);
  ctrl.start();
  win.start();

  const send = <C extends Command>(cmd: C): Promise<ReplyOf<C>> => {
    // 崩溃 / 关闭后立即失败：不再往已死/已关的通道 postMessage（seams §2 不变式 1/5）
    if (closed) return Promise.reject(closedError());
    if (crashed) return Promise.reject(crashError());
    const id = nextId++;
    const onWindowChannel = cmd.t === 'window' || cmd.t === 'getTrail';
    const port = onWindowChannel ? win : ctrl;
    const timeoutMs = onWindowChannel ? windowTimeoutMs : commandTimeoutMs;
    return new Promise<ReplyOf<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new CoreError({ code: 'TIMEOUT', message: `command ${cmd.t} timed out after ${timeoutMs}ms` }));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const wire: WireCommand = { kind: 'cmd', id, cmd };
      port.postMessage(wire);
    });
  };

  const api = commandCore(send, (listener) => {
    // 崩溃/关闭后不再接受新监听者（也没有事件会来）
    if (closed || crashed) return () => undefined;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });

  return {
    api,
    close() {
      if (closed) return; // 幂等
      closed = true;
      rejectPending(closedError());
      listeners.clear();
      ctrl.close();
      win.close();
      worker.terminate?.();
    },
  };
}
