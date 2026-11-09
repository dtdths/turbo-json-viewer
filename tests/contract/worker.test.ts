/**
 * tests/contract/worker.test.ts — 契约适配器 (b)：WorkerTransport + FakeWorker。
 *
 * FakeWorker 把 `{kind:'connect',ctrl,win}` 的两个 MessagePort 接到**真实** DocService.dispatch
 * （等价 app/worker.ts 的路由），因此这套用例实际穿过：commandCore → worker-transport 的
 * 序列化/超时/seq 表 → MessageChannel → worker 路由 → core 错误摊平 → CoreError 还原。
 */
import { createWorkerCore } from '../../src/app/transport/worker-transport';
import { FakeWorker } from './fake-worker';
import { runCoreContract } from './core-transport.cases';

runCoreContract('worker（createWorkerCore + FakeWorker）', () => {
  const core = createWorkerCore(new FakeWorker());
  return { api: core.api, close: () => core.close() };
});
