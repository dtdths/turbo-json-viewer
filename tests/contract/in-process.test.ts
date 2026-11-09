/**
 * tests/contract/in-process.test.ts — 契约适配器 (a)：ModelInProcess。
 * 同一份用例（core-transport.cases.ts）也打在 WorkerTransport + FakeWorker 上。
 */
import { createInProcessCore } from '../../src/app/transport/in-process-core';
import { DocService } from '../../src/core/doc-service';
import { runCoreContract } from './core-transport.cases';

runCoreContract('in-process', () => {
  const api = createInProcessCore(new DocService());
  return { api, close: () => api.close() };
});
