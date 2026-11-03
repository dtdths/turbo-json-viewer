import { describe, expect, it } from 'vitest';
import {
  CLIPBOARD_MAX_BYTES,
  clipboardRefusal,
  DEFAULT_EXPORT_MODE,
  EXPORT_MODES,
  isExportMode,
  normalizeExportMode,
} from '../../../src/viewmodel/export-state';

const MB = 1024 * 1024;

describe('export-state — 模式枚举与校验（ADR-0012 §7）', () => {
  it('两种方式、默认文件导出', () => {
    expect([...EXPORT_MODES]).toEqual(['file', 'clipboard']);
    expect(DEFAULT_EXPORT_MODE).toBe('file');
  });

  it('isExportMode 只接受两值', () => {
    expect(isExportMode('file')).toBe(true);
    expect(isExportMode('clipboard')).toBe(true);
    expect(isExportMode('download')).toBe(false);
    expect(isExportMode('')).toBe(false);
    expect(isExportMode(undefined)).toBe(false);
    expect(isExportMode(null)).toBe(false);
  });

  it('normalizeExportMode：非法/缺省回落 file', () => {
    expect(normalizeExportMode('clipboard')).toBe('clipboard');
    expect(normalizeExportMode('file')).toBe('file');
    expect(normalizeExportMode('bogus')).toBe('file');
    expect(normalizeExportMode(undefined)).toBe('file');
    expect(normalizeExportMode(42)).toBe('file');
  });
});

describe('export-state — 剪贴板大小守卫（ADR-0012 §4）', () => {
  it('阈值 = 20MB', () => {
    expect(CLIPBOARD_MAX_BYTES).toBe(20 * MB);
  });

  it('边界：19.9MB / 20MB 可复制，20.1MB 拒绝', () => {
    expect(clipboardRefusal(0)).toBeNull();
    expect(clipboardRefusal(19.9 * MB)).toBeNull();
    expect(clipboardRefusal(CLIPBOARD_MAX_BYTES)).toBeNull();
    expect(clipboardRefusal(CLIPBOARD_MAX_BYTES + 1)).toMatch(/请用「导出 JSON 文件」/);
    expect(clipboardRefusal(50 * MB)).toContain('50.0 MB');
  });

  it('非有限数按可复制处理（防御：不让守卫误伤）', () => {
    expect(clipboardRefusal(Number.NaN)).toBeNull();
    expect(clipboardRefusal(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
