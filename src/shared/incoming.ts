/**
 * shared/incoming — 页面选区导入的**共享类型**（#57 / ADR-0031）。
 *
 * 只有类型：SW（`app/selection-intake`）与页面（`app/incoming-selection`）各写一份键前缀
 * 常量（共享**值**会让 esbuild 在 `page.js` / `sw.js` 之间拆出首屏共享 chunk），
 * 但「条目的形状」与 `storage.session` 的端口形状是同一份，避免两边各写一套再对不上。
 */

/** 选区导入的两类「有反馈的失败」。 */
export type IncomingErrorCode = 'not-json' | 'too-large';

/**
 * `storage.session` 里一次性 token 的值：判别联合，读到 `kind` 就知道该导入还是该提示。
 * `createdAt` 只用于清理残留（不是安全边界）。
 */
export type IncomingPayload =
  | { kind: 'text'; text: string; createdAt: number }
  | { kind: 'error'; error: IncomingErrorCode; createdAt: number };

/** `chrome.storage.session` 的形状（SW 侧 = 全量；页面侧只用 `IncomingStore` 子集）。 */
export interface SessionStorageLike {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** 页面读一次 token 所需的最小子集。 */
export interface IncomingStore {
  get(keys: string): Promise<Record<string, unknown>>;
  remove(keys: string): Promise<void>;
}
