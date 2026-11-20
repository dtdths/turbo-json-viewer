/**
 * app/selection-intake — 右键菜单「用 Turbo JSON Viewer 打开选中的 JSON」的规则层
 * （#57 / ADR-0031）。
 *
 * 纯 TS、零 `chrome` 依赖：Service Worker 注入 `SelectionIntakePort`，单测用假端口。
 * 三条纪律：
 * - **不注入页面**：只读 `contextMenus` 回调给的 `info.selectionText`（浏览器渲染后的文本，
 *   换行被压成空格——对合法 JSON 无害，因为字符串里的换行本来就只能是 `\n` 转义）；
 * - **一次性 token**：`storage.session` 写一条、页面读完即删；`page.html#incoming=<token>`
 *   只带 token，不带文本；
 * - **点了要有反馈**：不像 JSON / 过大也投递一条**错误 token**，由页面开页 toast 解释
 *   （右键菜单无法按选区内容显隐，点进来才发现不是 JSON 是常态）。
 */
import type { IncomingPayload, SessionStorageLike } from '../shared/incoming';


/** 菜单项 id（`chrome.contextMenus` 的稳定标识）。 */
export const INCOMING_MENU_ID = 'tjv-open-selection';
/** `storage.session` 里一次性 token 的键前缀。 */
export const INCOMING_KEY_PREFIX = 'tjv.incoming.';
/** 选区文本上限（字符数 ≈ UTF-16 code unit）：远低于 `storage.session` 10MB 配额，也避免卡住 SW。 */
export const SELECTION_MAX_CHARS = 2_000_000;
/** 残留 token 的清理阈值：正常路径读完即删，这里只兜异常（页面没打开 / 读取失败）。 */
export const INCOMING_TTL_MS = 60 * 60 * 1000;

/** Service Worker 侧端口：只暴露投递真正需要的四件事。 */
export interface SelectionIntakePort {
  storage: SessionStorageLike;
  /** 打开查看器页面（`page.html#incoming=<token>`） */
  open(token: string): void;
  uuid(): string;
  now(): number;
}

/**
 * 是否值得当 JSON 投递：trim 后的首字符是 `{` / `[`。
 * 不设长度下限——`{}` / `[1]` 也是 JSON；菜单是用户显式点击，噪声由「解析失败」反馈承担。
 */
export function isJsonCandidate(text: string): boolean {
  const trimmed = text.trim();
  const first = trimmed.charAt(0);
  return first === '{' || first === '[';
}

/**
 * 投递一次选区：先清理残留，再写 token、开页。
 * 不像 JSON / 过大也写**错误 token**（页面 toast 解释），因为 SW 没有别的反馈通道
 * （通知要 `notifications` 权限、剪贴板要离屏文档）。
 */
export async function deliverSelection(port: SelectionIntakePort, raw: string): Promise<void> {
  const text = raw.trim();
  const createdAt = port.now();
  let payload: IncomingPayload;
  if (!isJsonCandidate(text)) payload = { kind: 'error', error: 'not-json', createdAt };
  else if (text.length > SELECTION_MAX_CHARS) payload = { kind: 'error', error: 'too-large', createdAt };
  else payload = { kind: 'text', text, createdAt };

  await pruneStale(port);
  const token = port.uuid();
  try {
    await port.storage.set({ [INCOMING_KEY_PREFIX + token]: payload });
  } catch {
    // 配额 / 隐私模式：退化成极小的错误 token，至少不让用户「点了没反应」。
    try {
      await port.storage.set({
        [INCOMING_KEY_PREFIX + token]: {
          kind: 'error',
          error: 'too-large',
          createdAt,
        } satisfies IncomingPayload,
      });
    } catch {
      /* 连错误也写不进：页面只能空开，没有别的通道 */
    }
  }
  port.open(token);
}

/** 清理超时残留（只碰 `tjv.incoming.` 前缀；`createdAt` 不合法的一并清掉）。 */
async function pruneStale(port: SelectionIntakePort): Promise<void> {
  let bag: Record<string, unknown>;
  try {
    bag = await port.storage.get(null);
  } catch {
    return;
  }
  const now = port.now();
  const stale: string[] = [];
  for (const [key, value] of Object.entries(bag)) {
    if (!key.startsWith(INCOMING_KEY_PREFIX)) continue;
    const createdAt = (value as { createdAt?: unknown } | null | undefined)?.createdAt;
    if (typeof createdAt !== 'number' || now - createdAt > INCOMING_TTL_MS) stale.push(key);
  }
  if (stale.length === 0) return;
  try {
    await port.storage.remove(stale);
  } catch {
    /* 清理失败不影响本次投递 */
  }
}
