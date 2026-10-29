/**
 * app/worker — module worker 入口：实例化 DocService，挂两个 MessagePort。
 * 文档常驻于此；页面关闭即销毁（ADR-0001）。不持任何 UI 状态。
 */
import { DocService } from '../core/doc-service';
import { CoreError } from '../protocol/errors';
import type { CoreEvent, WireCommand, WireReply } from '../protocol/messages';

const service = new DocService();
const ports: MessagePort[] = [];

function post(port: MessagePort, message: WireReply): void {
  try {
    port.postMessage(message);
  } catch {
    /* port closed */
  }
}

function attach(port: MessagePort): void {
  ports.push(port);
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
  for (const port of ports) post(port, { kind: 'event', event });
});
