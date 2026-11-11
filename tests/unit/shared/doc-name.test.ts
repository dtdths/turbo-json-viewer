import { describe, expect, it } from 'vitest';
import {
  DOC_NAME_MAX,
  baseNameFromExport,
  displayTitle,
  exportFileName,
  exprExportFileName,
  renameFromExport,
  sanitizeDocName,
} from '../../../src/shared/doc-name';

describe('shared/doc-name', () => {
  describe('sanitizeDocName', () => {
    it('trims and strips a single trailing .json (case-insensitive)', () => {
      expect(sanitizeDocName('  sample.json  ')).toBe('sample');
      expect(sanitizeDocName('DATA.JSON')).toBe('DATA');
      expect(sanitizeDocName('a.json.json')).toBe('a.json');
    });

    it('replaces filesystem-illegal characters with dashes', () => {
      expect(sanitizeDocName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    });

    it('removes control characters and trailing dots/spaces', () => {
      expect(sanitizeDocName('a\u0000b\u001fc\u007fd')).toBe('abcd');
      expect(sanitizeDocName('  name. ')).toBe('name');
    });

    it('strips trailing dots before and after the .json suffix', () => {
      expect(sanitizeDocName('a.json.')).toBe('a');
      expect(sanitizeDocName('a.json.json')).toBe('a.json');
      expect(sanitizeDocName('a .json')).toBe('a');
      expect(sanitizeDocName('  name.  ')).toBe('name');
    });

    it('returns empty string for blank input', () => {
      expect(sanitizeDocName('')).toBe('');
      expect(sanitizeDocName('   ')).toBe('');
      expect(sanitizeDocName(' .json ')).toBe('');
    });

    it('keeps dots inside the name and non-ASCII text', () => {
      expect(sanitizeDocName('v1.2.3')).toBe('v1.2.3');
      expect(sanitizeDocName('订单 数据')).toBe('订单 数据');
    });

    it('caps at DOC_NAME_MAX code points without splitting surrogate pairs', () => {
      const long = 'x'.repeat(200);
      expect(sanitizeDocName(long)).toHaveLength(DOC_NAME_MAX);
      const emoji = '😀'.repeat(200);
      expect(Array.from(sanitizeDocName(emoji))).toHaveLength(DOC_NAME_MAX);
    });
  });

  describe('exportFileName', () => {
    it('returns the base name with .json when the document is untouched', () => {
      expect(exportFileName('ok.json', {})).toBe('ok.json');
      expect(exportFileName('ok', {})).toBe('ok.json');
    });

    it('appends repaired then edited, matching the legacy exportName order', () => {
      expect(exportFileName('cut.json', { edited: true })).toBe('cut-edited.json');
      expect(exportFileName('cut.json', { repaired: true })).toBe('cut-truncated-repaired.json');
      expect(exportFileName('cut.json', { edited: true, repaired: true })).toBe(
        'cut-truncated-repaired-edited.json',
      );
    });

    it('falls back to untitled when the base is empty and caps the final length', () => {
      expect(exportFileName('   ', {})).toBe('untitled.json');
      const long = exportFileName('x'.repeat(200), { edited: true, repaired: true });
      expect(long.length).toBeLessThanOrEqual(DOC_NAME_MAX);
      expect(long.endsWith('.json')).toBe(true);
    });
  });

  describe('exprExportFileName', () => {
    it('appends the expr root id as a suffix', () => {
      expect(exprExportFileName('sample.json', 'expr:1')).toBe('sample-expr-1.json');
      expect(exprExportFileName('订单', 'expr:12')).toBe('订单-expr-12.json');
    });

    it('shares the DOC_NAME_MAX cap and the untitled fallback', () => {
      expect(exprExportFileName('   ', 'expr:1')).toBe('untitled-expr-1.json');
      const long = exprExportFileName('x'.repeat(200), 'expr:1');
      expect(long.length).toBeLessThanOrEqual(DOC_NAME_MAX);
      expect(long.endsWith('-expr-1.json')).toBe(true);
    });
  });

  describe('baseNameFromExport', () => {
    it('strips .json and the suffixes implied by the flags', () => {
      expect(baseNameFromExport('sample.json', {})).toBe('sample');
      expect(baseNameFromExport('sample-edited.json', { edited: true })).toBe('sample');
      expect(baseNameFromExport('sample-truncated-repaired-edited.json', { edited: true, repaired: true })).toBe(
        'sample',
      );
    });

    it('does not strip a suffix the flags do not claim', () => {
      expect(baseNameFromExport('sample-edited.json', { repaired: true })).toBe('sample-edited');
      // 改过的文档但用户删了 -edited：只剥 .json
      expect(baseNameFromExport('sample.json', { edited: true })).toBe('sample');
    });

    it('strips a repaired-only suffix', () => {
      expect(baseNameFromExport('x-truncated-repaired.json', { repaired: true })).toBe('x');
    });
  });

  describe('displayTitle', () => {
    it('keeps the plain name when it was never renamed', () => {
      expect(displayTitle('sample.json', 'sample.json')).toBe('sample.json');
    });

    it('appends the original filename after a rename', () => {
      expect(displayTitle('订单', 'sample.json')).toBe('订单（原名：sample.json）');
    });
  });

  describe('renameFromExport', () => {
    it('returns null when the final name equals the prefill (no rename)', () => {
      expect(renameFromExport('sample-edited.json', 'sample-edited.json', { edited: true })).toBeNull();
    });

    it('derives the new base name from a changed filename', () => {
      expect(renameFromExport('报告-2024-edited.json', 'sample-edited.json', { edited: true })).toBe('报告-2024');
      expect(renameFromExport('report.json', 'sample-edited.json', { edited: true })).toBe('report');
    });

    it('returns null for a name that sanitizes to empty', () => {
      expect(renameFromExport('  .json ', 'sample-edited.json', { edited: true })).toBeNull();
    });

    it('round-trips base -> export name -> base', () => {
      for (const opts of [{}, { edited: true }, { repaired: true }, { edited: true, repaired: true }]) {
        const file = exportFileName('订单', opts);
        expect(baseNameFromExport(file, opts)).toBe('订单');
      }
    });
  });
});
