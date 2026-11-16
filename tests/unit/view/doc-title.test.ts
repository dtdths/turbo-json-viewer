/**
 * tests/unit/view/doc-title — 文档标题「原名追溯」文案（#29 / ADR-0021；i18n 归 view 层）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { displayTitle } from '../../../src/view/doc-title';
import { initI18n } from '../../../src/i18n/index';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('displayTitle（原名追溯）', () => {
  it('未改名 → 原名本身', () => {
    expect(displayTitle('sample.json', 'sample.json')).toBe('sample.json');
  });

  it('改过名 → 追加「原名：…」（当前 locale 词条）', () => {
    expect(displayTitle('订单', 'sample.json')).toBe('订单（原名：sample.json）');
  });

  it('英文 locale：括号与用词跟随词条', async () => {
    await initI18n('en-US');
    expect(displayTitle('order', 'order.json')).toBe('order (original: order.json)');
    await initI18n('zh-CN');
  });
});
