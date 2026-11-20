/**
 * app/incoming-selection — 页面侧消费右键菜单投递的选区（#57 / ADR-0031）。
 *
 * 只做「解析 hash → 读并删 `storage.session` 里的一次性 token」；导入与文案归 app。
 * 纯 TS、零 DOM：`location` / `history` 的清理由调用方（`main.ts`）做，单测可直喂 hash 与假存储。
 */
import type { IncomingErrorCode, IncomingMode, IncomingStore } from '../shared/incoming';

/**
 * 与 `app/selection-intake` 的 `INCOMING_KEY_PREFIX` **必须一致**。
 * 刻意不 import：共享**值**会让 esbuild 在 page.js 与 sw.js 之间拆出首屏共享 chunk；
 * 形状与端口类型在 `shared/incoming` 里，两边共用一份（只 import type，零运行时）。
 */
const INCOMING_KEY_PREFIX = 'tjv.incoming.';

/** 查看器页面 URL 的 hash 约定：`#incoming=<token>`。 */
export const INCOMING_HASH_PREFIX = '#incoming=';

/**
 * 浏览器右键菜单给的 `selectionText` 可能被截断（官方无文档上限，社区有 16384 的说法）。
 * 解析失败且达到这个长度时，页面给「可能被截断」的专门提示，而不是普通语法错误。
 */
export const SUSPECTED_TRUNCATED_CHARS = 16_384;

export type IncomingRead =
  | { kind: 'import'; text: string; mode: IncomingMode }
  | { kind: 'error'; code: IncomingErrorCode };

/** 从 `location.hash` 取 token；格式不对就当没有（不报错，避免把垃圾 hash 变成错误提示）。 */
export function incomingTokenFromHash(hash: string): string | null {
  if (!hash.startsWith(INCOMING_HASH_PREFIX)) return null;
  const token = hash.slice(INCOMING_HASH_PREFIX.length);
  // uuid v4（含连字符）或测试用的短 id；只允许安全字符，防止把任意 hash 当键拼进存储
  return /^[A-Za-z0-9-]{8,64}$/.test(token) ? token : null;
}

/**
 * 读一次 token 并**立即删除**（单次使用）：token 不存在返回 null（刷新 / 重复打开 / 已消费）；
 * 读到错误 token 返回 `error`；正常返回 `import`。
 */
export async function takeIncoming(store: IncomingStore | null, token: string): Promise<IncomingRead | null> {
  if (!store) return null;
  const key = INCOMING_KEY_PREFIX + token;
  let bag: Record<string, unknown>;
  try {
    bag = await store.get(key);
  } catch {
    return null;
  }
  const value = bag[key];
  try {
    await store.remove(key);
  } catch {
    /* 删除失败不影响本次导入（条目会由 SW 的 TTL 清理兜底） */
  }
  if (typeof value !== 'object' || value === null) return null;
  const payload = value as { kind?: unknown; text?: unknown; error?: unknown; mode?: unknown };
  if (payload.kind === 'text' && typeof payload.text === 'string') {
    // 旧 token 没有 mode：默认「打开查看」
    return { kind: 'import', text: payload.text, mode: payload.mode === 'download' ? 'download' : 'view' };
  }
  if (payload.kind === 'error' && (payload.error === 'not-json' || payload.error === 'too-large')) {
    return { kind: 'error', code: payload.error };
  }
  return null;
}

/** 解析失败时是否值得提示「可能被截断」。 */
export function suspectedTruncated(text: string): boolean {
  return text.length >= SUSPECTED_TRUNCATED_CHARS;
}
