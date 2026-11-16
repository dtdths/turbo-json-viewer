/**
 * i18n/languages — 语言注册表（「有哪些语言」的唯一来源）。
 *
 * 每种语言各自一个**动态 import** 分块（含 en-US），首帧前由 `initI18n` / `setLocalePref`
 * 只加载**当前语言**（ADR-0026 §2）：`page.js` 不含任何词条，首屏体积与语言数无关。
 */
import type { Language, MessageTable } from './types';

/**
 * 空词条表：仅作 `t()` / 加载失败路径的统一「什么都没有」值。
 * **没有内联语言包**——所有语言（含回退语言 en-US）都走 loader（ADR-0026 §2）。
 */
export const EMPTY_TABLE: MessageTable = {};

export const LANGUAGES: readonly Language[] = [
  {
    tag: 'en-US',
    nativeName: 'English',
    load: async () => (await import('./messages/en/pack')).en,
  },
  {
    tag: 'zh-CN',
    nativeName: '简体中文',
    load: async () => (await import('./messages/zh-CN/pack')).zhCN,
  },
];

export function findLanguage(tag: string): Language | undefined {
  return LANGUAGES.find((language) => language.tag === tag);
}
