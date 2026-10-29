/**
 * app/transport/worker-transport — CoreTransport 的生产适配器。
 * 控制命令走 ctrl 通道，行窗口/trail 走独立 win 通道（ADR-0001），共用一个 CoreApi 门面。
 */
import { commandCore, type CoreApi } from '../../protocol/core-api';
import { CoreError } from '../../protocol/errors';
import type { Command, CoreEvent, ReplyOf, WireCommand, WireReply } from '../../protocol/messages';

export interface WorkerCore {
  api: CoreApi;
  close(): void;
}

export function createWorkerCore(worker: Worker): WorkerCore {
  const ctrlChannel = new MessageChannel();
  const winChannel = new MessageChannel();
  const ctrl = ctrlChannel.port1;
  const win = winChannel.port1;

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void; timer: number }
  >();
  const listeners = new Set<(event: CoreEvent) => void>();

  // 响应超时（seams.md §2 不变式 5）：默认 5s；window/getTrail 2s；不自动重试。
  const COMMAND_TIMEOUT_MS = 5000;
  const WINDOW_TIMEOUT_MS = 2000;

  worker.postMessage(
    { kind: 'connect', ctrl: ctrlChannel.port2, win: winChannel.port2 },
    [ctrlChannel.port2, winChannel.port2],
  );

  const handle = (data: WireReply): void => {
    if (!data) return;
    if (data.kind === 'event') {
      for (const listener of listeners) listener(data.event);
      return;
    }
    if (data.kind !== 'reply') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    window.clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.value);
    else entry.reject(new CoreError(data.error));
  };

  ctrl.onmessage = (event: MessageEvent) => handle(event.data as WireReply);
  win.onmessage = (event: MessageEvent) => handle(event.data as WireReply);
  ctrl.start();
  win.start();

  const send = <C extends Command>(cmd: C): Promise<ReplyOf<C>> => {
    const id = nextId++;
    const onWindowChannel = cmd.t === 'window' || cmd.t === 'getTrail';
    const port = onWindowChannel ? win : ctrl;
    const timeoutMs = onWindowChannel ? WINDOW_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    return new Promise<ReplyOf<C>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
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
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });

  return {
    api,
    close() {
      const closed = new CoreError({ code: 'CLOSED', message: 'transport closed' });
      for (const [, entry] of pending) {
        window.clearTimeout(entry.timer);
        entry.reject(closed);
      }
      pending.clear();
      listeners.clear();
      ctrl.close();
      win.close();
      worker.terminate();
    },
  };
}
