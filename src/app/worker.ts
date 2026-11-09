/**
 * app/worker — module worker 入口：实例化 DocService，挂两个 MessagePort。
 * 文档常驻于此；页面关闭即销毁（ADR-0001）。不持任何 UI 状态。
 */
import { DocService } from '../core/doc-service';
import { CoreError } from '../protocol/errors';
import type { CoreEvent, WireCommand, WireReply } from '../protocol/messages';

const service = new DocService();
/**
 * 事件只从 **ctrl** 通道发（connect 时第一个 attach 的 port）。
 * 主线程的 `worker-transport` 把同一个 `handle` 挂在 ctrl/win 两个 port 上——若两个 port 都
 * 广播事件，订阅者会为每条事件收到两份；win 通道只承载 window/getTrail 回包（ADR-0001 的
 * 通道隔离不变）。命令路由仍按命令到达的 port 原路回包。
 */
let eventPort: MessagePort | null = null;

function post(port: MessagePort, message: WireReply): void {
  try {
    port.postMessage(message);
  } catch {
    /* port closed */
  }
}

function attach(port: MessagePort): void {
  if (eventPort === null) eventPort = port; // 先 attach ctrl → 事件固定走 ctrl
  port.onmessage = (event: MessageEvent) => {
    const message = event.data as WireCommand;
    if (!message || message.kind !== 'cmd') return;
    void (async () => {
      try {
        const value = await service.dispatch(message.cmd);
        post(port, { kind: 'reply', id: message.id, ok: true, value });
      } catch (error) {
        post(port, { kind: 'reply', id: message.id, ok: false, error: CoreError.from(error).toShape() });
      }
    })();
  };
  port.start();
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as { kind?: string; ctrl?: MessagePort; win?: MessagePort } | null;
  if (data && data.kind === 'connect' && data.ctrl && data.win) {
    attach(data.ctrl);
    attach(data.win);
  }
};

service.on((event: CoreEvent) => {
  if (eventPort !== null) post(eventPort, { kind: 'event', event });
});
