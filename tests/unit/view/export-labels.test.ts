/**
 * tests/unit/view/export-labels — 导出方式文案（ADR-0012 修订；i18n 归 view 层）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_MODE_LABELS } from '../../../src/view/export-labels';
import { initI18n } from '../../../src/i18n/index';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('EXPORT_MODE_LABELS', () => {
  it('中文词条（与设置面板/菜单一致）', () => {
    expect(EXPORT_MODE_LABELS).toEqual({ file: '导出文件', clipboard: '复制到剪贴板' });
  });

  it('getter 跟随 locale（切英文后读新词条）', async () => {
    await initI18n('en-US');
    expect(EXPORT_MODE_LABELS).toEqual({ file: 'Export file', clipboard: 'Copy to clipboard' });
    await initI18n('zh-CN');
  });
});
