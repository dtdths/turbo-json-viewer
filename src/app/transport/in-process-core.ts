/**
 * app/transport/in-process-core — ModelInProcess 适配器（seam S1 的测试/bench 实现）。
 *
 * 直接持有 core 的 `DocService`（同线程、无 MessageChannel、无结构化克隆），
 * 与生产 `WorkerTransport` 共用 `commandCore()` 的命令映射，因此调用面不会漂移；
 * `tests/contract/` 用同一份用例分别打在本适配器与 `createWorkerCore(FakeWorker)` 上。
 *
 * 分层：本文件**不 import `core`**（只有 `worker.ts` 是 app 层里允许 import core 的装配点），
 * 用结构接口描述 DocService 的最小形状；DocService 天然满足。该适配器不进任何生产入口的
 * import 图（只被测试/bench 引用），构建时不会进 page/worker bundle。
 */
import { commandCore, type CoreApi } from '../../protocol/core-api';
import type { Command, CoreEvent, ReplyOf } from '../../protocol/messages';

/** `core/doc-service` 的 `DocService` 满足的最小结构接口（不依赖其实现文件）。 */
export interface InProcessDocLike {
  dispatch<C extends Command>(cmd: C): Promise<ReplyOf<C>>;
  on(listener: (event: CoreEvent) => void): () => void;
  close(): void;
}

/** 把「直接持有文档服务」适配成 `CoreApi`；`close()` 关闭文档服务（等价 worker 的销毁）。 */
export function createInProcessCore(doc: InProcessDocLike): CoreApi {
  const api = commandCore(
    <C extends Command>(cmd: C) => doc.dispatch(cmd),
    (listener) => doc.on(listener),
  );
  return {
    ...api,
    close: () => doc.close(),
  };
}
