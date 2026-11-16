/**
 * tests/unit/view/tab-strip — #45 / ADR-0026 §3：标签条 `relabel()`（＋ 按钮 title/aria、关闭 aria）。
 *
 * 用极简 fake DOM；标签条只重绘 DOM，标签数据/激活态来自 render 的只读视图。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initI18n, setLocalePref } from '../../../src/i18n/index';
import { TabStrip, type TabStripView } from '../../../src/view/tab-strip';
import { installFakeDom, type FakeDomHandle, type FakeElement } from './fake-dom';

const VIEW: TabStripView = {
  hidden: false,
  tabs: [
    { id: 't1', name: '订单', originalName: 'order.json', active: true },
    { id: 't2', name: 'b.json', originalName: 'b.json', active: false },
  ],
  activeId: 't1',
  canAdd: true,
  max: 8,
};

let dom: FakeDomHandle;

beforeAll(async () => {
  dom = installFakeDom();
  await initI18n('zh-CN');
});

afterAll(() => {
  dom.restore();
});

function mountStrip(): { host: FakeElement; addBtn: FakeElement; strip: TabStrip } {
  const doc = dom.document;
  const host = doc.createElement('div');
  host.id = 'tabStrip';
  const items = doc.createElement('div');
  items.id = 'tabStripItems';
  const addBtn = doc.createElement('button');
  addBtn.id = 'tabAdd';
  host.append(items, addBtn);
  const strip = new TabStrip(host as unknown as HTMLElement, {
    onSelect: () => undefined,
    onClose: () => undefined,
    onAdd: () => undefined,
    onMove: () => undefined,
    onRename: () => undefined,
  });
  strip.mount();
  strip.render(VIEW);
  return { host, addBtn, strip };
}

function tabs(host: FakeElement): FakeElement[] {
  return host.querySelectorAll('.tabstrip__tab');
}

describe('TabStrip.relabel()', () => {
  it('中文：＋ title/aria、关闭 aria、改名原名提示逐字沿用', () => {
    const { host, addBtn } = mountStrip();
    expect(addBtn.title).toBe('新标签（⌘⇧O）');
    expect(addBtn.getAttribute('aria-label')).toBe('新标签');
    expect(tabs(host)[0]?.title).toBe('订单（原名：order.json）');
    const close = tabs(host)[0]?.querySelector('.tabstrip__close');
    expect(close?.getAttribute('aria-label')).toBe('关闭 订单');
  });

  it('切语言后 relabel：静态 title/aria 全换成新语言，标签数据不变', async () => {
    const { host, addBtn, strip } = mountStrip();
    await setLocalePref('en-US');
    strip.relabel();
    expect(addBtn.title).toBe('New tab (⌘⇧O)');
    expect(addBtn.getAttribute('aria-label')).toBe('New tab');
    expect(tabs(host)[0]?.title).toBe('订单 (original: order.json)');
    expect(tabs(host)[0]?.querySelector('.tabstrip__close')?.getAttribute('aria-label')).toBe(
      'Close 订单',
    );
    expect(tabs(host)).toHaveLength(2);
    expect(tabs(host)[0]?.getAttribute('aria-selected')).toBe('true');

    await setLocalePref('zh-CN');
    strip.relabel();
    expect(addBtn.title).toBe('新标签（⌘⇧O）');
  });
});
