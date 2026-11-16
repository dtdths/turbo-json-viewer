/**
 * i18n/locale — locale 解析（纯函数、零 DOM、零全局状态）。
 *
 * 优先级（高 → 低）由 `resolveLocale` 表达：
 *   1. `?lang=<tag>` 覆盖（仅测试/调试，不持久化）
 *   2. 设置里的显式语言（`Settings.locale !== 'auto'`）
 *   3. `auto` → `navigator.language` 归一（zh* → zh-CN，其余 → en-US）
 *   4. 兜底 en-US
 *
 * 归一规则：`zh` / `zh-*`（含 zh-TW / zh-HK，暂统一到简体）→ `zh-CN`；`en` / `en-*` → `en-US`。
 * 未知语言返回 null（由调用方决定兜底）。
 */
import { LANGUAGE_TAGS, type LanguageTag } from '../protocol/versions';
import type { LocalePref } from './types';

/** 支持的语言标签（派生自 `types.LANGUAGE_TAGS`，不另写字面量）。 */
export const SUPPORTED_TAGS: readonly LanguageTag[] = LANGUAGE_TAGS;

/** 原始标签归一：`zh-TW` → `zh-CN`、`en-GB` → `en-US`；不支持 → null。 */
export function normalizeLocaleTag(raw: string | undefined | null): LanguageTag | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === '') return null;
  if (lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_')) return 'zh-CN';
  if (lower === 'en' || lower.startsWith('en-') || lower.startsWith('en_')) return 'en-US';
  return null;
}

/** `?lang=` 覆盖：解析 location.search（无 window 时传空串）。 */
export function parseLangOverride(search: string | undefined | null): LanguageTag | null {
  if (!search) return null;
  // 去掉开头的 `?`，URLSearchParams 也接受带 `?` 的串，但统一一下
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return normalizeLocaleTag(params.get('lang'));
}

/** 系统语言归一（缺省/未知 → en-US）。 */
export function detectFromNavigator(navLang: string | undefined | null): LanguageTag {
  return normalizeLocaleTag(navLang) ?? 'en-US';
}

/**
 * 解析最终 locale。
 * `pref` 是设置值；非法/未知值按 `auto` 处理（设置层也会回落，这里再兜一层）。
 */
export function resolveLocale(
  pref: LocalePref,
  navLang: string | undefined | null,
  override: LanguageTag | null,
): LanguageTag {
  if (override) return override;
  if (pref !== 'auto') {
    const tag = normalizeLocaleTag(pref);
    if (tag) return tag;
  }
  return detectFromNavigator(navLang);
}
