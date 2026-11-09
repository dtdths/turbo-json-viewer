/**
 * tests/contract/fake-worker — 测试用 WorkerLike：把 connect 的 ctrl/win 两个 MessagePort
 * 接到真实 `DocService.dispatch`，等价 `src/app/worker.ts` 的路由（命令 → dispatch → reply；
 * service 事件**只从 ctrl** 发出，win 只承载 window/getTrail 回包）。
 *
 * 两种模式：
 *   - route（默认）：收到命令就 dispatch 并回包，跑正常契约；
 *   - hold：只收命令、不回包，由测试手动 `releaseHeld()` / 触发崩溃 / 超时。
 */
import { DocService } from '../../src/core/doc-service';
import { CoreError } from '../../src/protocol/errors';
import type { CoreEvent, WireCommand, WireReply } from '../../src/protocol/messages';
import type { WorkerLike } from '../../src/app/transport/worker-transport';

export type FakeWorkerMode = 'route' | 'hold';

export interface FakeWorkerOptions {
  mode?: FakeWorkerMode;
}

export class FakeWorker implements WorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  /** 真实 core：所有命令都打到它（契约测试不做任何状态替身）。 */
  readonly service = new DocService();
  /** 实际收到的命令（用于断言「没有重试」「崩溃/关闭后不再 postMessage」）。 */
  readonly commands: WireCommand[] = [];
  readonly ports: MessagePort[] = [];

  private readonly mode: FakeWorkerMode;
  private readonly held: Array<{ port: MessagePort; wire: WireCommand }> = [];
  private readonly offService: () => void;
  /** 等价 app/worker.ts：事件只从第一个 attach 的 port（ctrl）发，避免 ctrl+win 各一份 */
  private eventPort: MessagePort | null = null;

  constructor(options: FakeWorkerOptions = {}) {
    this.mode = options.mode ?? 'route';
    // 等价 app/worker.ts：DocService 的每个事件只发到 eventPort（ctrl）；win 只走 window 回包
    this.offService = this.service.on((event) => this.broadcast({ kind: 'event', event }));
  }

  /** 只处理主机侧的 connect 握手（命令本身走 MessagePort，与生产一致）。 */
  postMessage(message: unknown): void {
    const data = message as { kind?: string; ctrl?: MessagePort; win?: MessagePort } | null;
    if (!data || data.kind !== 'connect' || !data.ctrl || !data.win) return;
    this.attach(data.ctrl);
    this.attach(data.win);
  }

  /** 手动触发 worker 级错误回调（Node 无 ErrorEvent 全局；transport 的回调不读事件内容）。 */
  triggerError(): void {
    this.onerror?.({} as ErrorEvent);
  }

  triggerMessageError(): void {
    this.onmessageerror?.({} as MessageEvent);
  }

  /** hold 模式下放行全部已收起命令的回包。 */
  releaseHeld(): void {
    const items = this.held.splice(0);
    for (const item of items) void this.reply(item.port, item.wire);
  }

  /** 从 ctrl（eventPort）直接派一个事件（用于验证崩溃/关闭后 transport 不再派发）。 */
  emitEvent(event: CoreEvent): void {
    this.broadcast({ kind: 'event', event });
  }

  /** 等价真实 worker 终止：解绑 service 事件并关闭文档服务（端口由 transport 侧关闭）。 */
  terminate(): void {
    this.offService();
    this.service.close();
  }

  private attach(port: MessagePort): void {
    if (this.eventPort === null) this.eventPort = port; // connect 时先 attach ctrl → 事件走 ctrl
    this.ports.push(port);
    port.onmessage = (event: MessageEvent) => this.onCommand(port, event.data as WireCommand);
    port.start();
  }

  private onCommand(port: MessagePort, message: WireCommand): void {
    if (!message || message.kind !== 'cmd') return;
    this.commands.push(message);
    if (this.mode === 'hold') {
      this.held.push({ port, wire: message });
      return;
    }
    void this.reply(port, message);
  }

  private async reply(port: MessagePort, message: WireCommand): Promise<void> {
    try {
      const value = await this.service.dispatch(message.cmd);
      this.post(port, { kind: 'reply', id: message.id, ok: true, value });
    } catch (error) {
      this.post(port, { kind: 'reply', id: message.id, ok: false, error: CoreError.from(error).toShape() });
    }
  }

  private broadcast(message: WireReply): void {
    if (this.eventPort !== null) this.post(this.eventPort, message);
  }

  private post(port: MessagePort, message: WireReply): void {
    try {
      port.postMessage(message);
    } catch {
      /* port closed */
    }
  }
}
