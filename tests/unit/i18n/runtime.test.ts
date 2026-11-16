/**
 * tests/unit/i18n/runtime — 运行时词条表：插值 / 复数 / 数字格式 / 语言切换 / 回退（ADR-0026 §2–§3）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentLocale,
  currentLocalePref,
  formatNumber,
  hasMessage,
  initI18n,
  isPackLoaded,
  languageChoices,
  messageCount,
  setLocalePref,
  subscribeLocale,
  t,
} from '../../../src/i18n/index';

beforeEach(async () => {
  // 固定 navigator.language（Node 会按系统 ICU 给 zh-CN，测试要确定性）
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
  });
  await initI18n('en-US');
});

describe('t() 基础', () => {
  it('英文语言包 + 中文语言包都可用', async () => {
    expect(t('app.toolbar.import')).toBe('Import');
    await initI18n('zh-CN');
    expect(t('app.toolbar.import')).toBe('导入');
    expect(currentLocale()).toBe('zh-CN');
  });

  it('插值：{name} 原样、{n} 按 locale 格式化', async () => {
    await initI18n('zh-CN');
    expect(t('app.confirm.closeTab', { name: 'a.json' })).toContain('「a.json」');
    expect(t('app.fidelity.overflow', { n: 1234 })).toBe('数字上溢 1,234 处');
  });

  it('英文千分位', () => {
    expect(t('app.fidelity.overflow', { n: 1234 })).toBe('1,234 numeric overflows');
  });

  it('未提供的占位符原样保留（便于测试暴露漏参）', () => {
    expect(t('app.fidelity.overflow')).toContain('{n}');
  });

  it('复数：en one/other 选形', () => {
    expect(t('app.edit.badge', { n: 1 })).toBe('1 edit');
    expect(t('app.edit.badge', { n: 2 })).toBe('2 edits');
    expect(t('app.edit.badge', { n: 0 })).toBe('0 edits');
  });

  it('复数：zh 两形同文', async () => {
    await initI18n('zh-CN');
    expect(t('app.edit.badge', { n: 1 })).toBe('已修改 1 处');
    expect(t('app.edit.badge', { n: 1200 })).toBe('已修改 1,200 处');
  });
});

describe('formatNumber', () => {
  it('跟随当前 locale', async () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    await initI18n('zh-CN');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('语言切换', () => {
  it('setLocalePref 换表并通知订阅者', async () => {
    const seen: string[] = [];
    const off = subscribeLocale((tag) => seen.push(tag));
    await setLocalePref('zh-CN');
    off();
    await setLocalePref('en-US');
    expect(seen).toEqual(['zh-CN']);
  });

  it('语言包按需加载并缓存（切换不重复 import）', async () => {
    await setLocalePref('zh-CN');
    expect(isPackLoaded('zh-CN')).toBe(true);
    const count = messageCount();
    expect(count).toBeGreaterThan(0);
    await setLocalePref('en-US');
    await setLocalePref('zh-CN');
    expect(messageCount()).toBe(count);
  });

  it('currentLocalePref 回显设置值', async () => {
    await setLocalePref('auto');
    expect(currentLocalePref()).toBe('auto');
    // 测试环境没有 navigator/location → auto 落到 en-US
    expect(currentLocale()).toBe('en-US');
  });
});

describe('注册表与守护辅助', () => {
  it('languageChoices：auto + 各自称（不自译）', () => {
    const choices = languageChoices();
    expect(choices[0]).toEqual({ value: 'auto', nativeName: null });
    expect(choices.map((choice) => choice.value)).toContain('zh-CN');
    expect(choices.find((choice) => choice.value === 'zh-CN')?.nativeName).toBe('简体中文');
  });

  it('hasMessage 只认词条表里的 key', () => {
    expect(hasMessage('app.toolbar.import')).toBe(true);
    expect(hasMessage('app.nope')).toBe(false);
  });

  it('语言包加载失败 → 回退 en（不抛错）', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.doMock('../../../src/i18n/languages', async (importOriginal) => {
        const mod = await importOriginal<typeof import('../../../src/i18n/languages')>();
        const patched = mod.LANGUAGES.map((language) =>
          language.tag === 'zh-CN'
            ? { ...language, load: async () => { throw new Error('boom'); } }
            : language,
        );
        return {
          ...mod,
          LANGUAGES: patched,
          // index.ts 用 findLanguage() 取 loader，mock 要连它一起换
          findLanguage: (tag: string) => patched.find((language) => language.tag === tag),
        };
      });
      const fresh = await import('../../../src/i18n/index');
      await fresh.initI18n('zh-CN');
      expect(fresh.currentLocale()).toBe('zh-CN');
      expect(fresh.t('app.toolbar.import')).toBe('Import'); // 回退到 en，不阻塞启动
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../../src/i18n/languages');
      vi.resetModules();
      warn.mockRestore();
    }
  });
});
