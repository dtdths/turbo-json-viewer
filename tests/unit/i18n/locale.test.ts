/**
 * tests/unit/i18n/locale — locale 解析（纯函数，ADR-0026 §2）。
 */
import { describe, expect, it } from 'vitest';
import {
  detectFromNavigator,
  normalizeLocaleTag,
  parseLangOverride,
  resolveLocale,
  SUPPORTED_TAGS,
} from '../../../src/i18n/locale';
import { LANGUAGES } from '../../../src/i18n/languages';
import { LANGUAGE_TAGS } from '../../../src/i18n/types';

describe('normalizeLocaleTag', () => {
  it('zh / zh-* → zh-CN（zh-TW/HK 暂统一简体）', () => {
    expect(normalizeLocaleTag('zh')).toBe('zh-CN');
    expect(normalizeLocaleTag('zh-CN')).toBe('zh-CN');
    expect(normalizeLocaleTag('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocaleTag('zh-TW')).toBe('zh-CN');
    expect(normalizeLocaleTag('ZH_cn')).toBe('zh-CN');
  });

  it('en / en-* → en-US', () => {
    expect(normalizeLocaleTag('en')).toBe('en-US');
    expect(normalizeLocaleTag('en-GB')).toBe('en-US');
    expect(normalizeLocaleTag('EN_us')).toBe('en-US');
  });

  it('未知 / 空 → null', () => {
    expect(normalizeLocaleTag('de-DE')).toBeNull();
    expect(normalizeLocaleTag('ja')).toBeNull();
    expect(normalizeLocaleTag('')).toBeNull();
    expect(normalizeLocaleTag('   ')).toBeNull();
    expect(normalizeLocaleTag(undefined)).toBeNull();
    expect(normalizeLocaleTag(null)).toBeNull();
  });
});

describe('parseLangOverride', () => {
  it('解析 ?lang=，非法值忽略', () => {
    expect(parseLangOverride('?lang=en-US')).toBe('en-US');
    expect(parseLangOverride('lang=zh-CN&x=1')).toBe('zh-CN');
    expect(parseLangOverride('?lang=zh-TW')).toBe('zh-CN');
    expect(parseLangOverride('?lang=de')).toBeNull();
    expect(parseLangOverride('?foo=1')).toBeNull();
    expect(parseLangOverride('')).toBeNull();
    expect(parseLangOverride(undefined)).toBeNull();
  });
});

describe('detectFromNavigator', () => {
  it('系统语言归一，未知 → en-US', () => {
    expect(detectFromNavigator('zh-CN')).toBe('zh-CN');
    expect(detectFromNavigator('ja-JP')).toBe('en-US');
    expect(detectFromNavigator(undefined)).toBe('en-US');
  });
});

describe('resolveLocale（优先级：?lang > 设置 > navigator > en-US）', () => {
  it('override 最高优先（即使设置显式）', () => {
    expect(resolveLocale('zh-CN', 'en-US', 'en-US')).toBe('en-US');
    expect(resolveLocale('auto', 'zh-CN', 'en-US')).toBe('en-US');
  });

  it('显式设置优先于系统语言', () => {
    expect(resolveLocale('en-US', 'zh-CN', null)).toBe('en-US');
    expect(resolveLocale('zh-CN', 'en-US', null)).toBe('zh-CN');
  });

  it('auto 跟随系统；未知系统语言 → en-US', () => {
    expect(resolveLocale('auto', 'zh-CN', null)).toBe('zh-CN');
    expect(resolveLocale('auto', 'en-GB', null)).toBe('en-US');
    expect(resolveLocale('auto', 'fr-FR', null)).toBe('en-US');
    expect(resolveLocale('auto', undefined, null)).toBe('en-US');
  });

  it('设置的非法值按 auto 处理', () => {
    // 运行时兜底（设置层已有白名单，这里再兜一层）
    expect(resolveLocale('de-DE' as never, 'zh-CN', null)).toBe('zh-CN');
  });
});

describe('语言单一来源', () => {
  it('SUPPORTED_TAGS 派生自 LANGUAGE_TAGS', () => {
    expect([...SUPPORTED_TAGS]).toEqual([...LANGUAGE_TAGS]);
  });

  it('语言注册表覆盖全部 LANGUAGE_TAGS（新增语言不能只改一处）', () => {
    expect(LANGUAGES.map((language) => language.tag).sort()).toEqual([...LANGUAGE_TAGS].sort());
  });
});
