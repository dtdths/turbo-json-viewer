/**
 * tests/unit/view/expression-bar — #45 / ADR-0026 §3：结果条 `relabel()`（运行时切换语言）。
 *
 * 结果条只持最近一次数据；切语言时按新词条重画同一份数据（不重跑表达式、不改 stale 标记、
 * 不触发任何按钮回调）。用极简 fake DOM。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initI18n, setLocalePref } from '../../../src/i18n/index';
import { ExpressionBar, type ExpressionBarView } from '../../../src/view/panels/expression-bar';
import { installFakeDom, type FakeDomHandle, type FakeElement } from './fake-dom';

const VIEW: ExpressionBarView = {
  rootId: 'expr:1',
  count: 29,
  ms: 3,
  truncated: true,
  skipped: 2,
  maxResult: 50000,
  stale: true,
};

let dom: FakeDomHandle;

beforeAll(async () => {
  dom = installFakeDom();
  await initI18n('zh-CN');
});

afterAll(() => {
  dom.restore();
});

function makeBar(): { root: FakeElement; text: FakeElement; bar: ExpressionBar; clicks: string[] } {
  const doc = dom.document;
  const root = doc.createElement('div');
  root.hidden = true;
  const text = doc.createElement('span');
  text.id = 'exprBarText';
  root.append(text);
  const clicks: string[] = [];
  for (const id of ['exprBarRerun', 'exprBarBack', 'exprBarClose']) {
    const button = doc.createElement('button');
    button.id = id;
    root.append(button);
  }
  const bar = new ExpressionBar(root as unknown as HTMLElement);
  bar.onRerun(() => clicks.push('rerun'));
  bar.onBack(() => clicks.push('back'));
  bar.onClose(() => clicks.push('close'));
  return { root, text, bar, clicks };
}

describe('ExpressionBar.relabel()', () => {
  it('中文文案逐字沿用旧结果条（标题 · 状态 · 截断 · 跳过 · stale）', () => {
    const { root, text, bar } = makeBar();
    bar.show(VIEW);
    expect(root.hidden).toBe(false);
    expect(text.textContent).toBe(
      '表达式结果 · expr:1 · 29 项 · 3 ms · 已截断（上限 50,000） · 已跳过 2 项缺少该字段 · 文档已修改，结果可能过期',
    );
    expect(root.dataset.stale).toBe('1');
    expect(root.dataset.truncated).toBe('1');
  });

  it('切语言后按新词条重画同一份数据：标记保留、按钮回调不触发', async () => {
    const { root, text, bar, clicks } = makeBar();
    bar.show(VIEW);

    await setLocalePref('en-US');
    bar.relabel();

    expect(text.textContent).toBe(
      'Expression result · expr:1 · 29 items · 3 ms · Truncated (limit 50,000) · Skipped 2 items missing that field · Document changed; the result may be out of date',
    );
    expect(text.title).toBe(text.textContent);
    expect(root.dataset.stale).toBe('1');
    expect(root.dataset.truncated).toBe('1');
    expect(clicks).toEqual([]);

    await setLocalePref('zh-CN');
    bar.relabel();
    expect(text.textContent).toContain('表达式结果 · expr:1');
  });

  it('隐藏时 relabel 无副作用（占位仍是「—」）', async () => {
    const { text, bar } = makeBar();
    bar.show(VIEW);
    bar.hide();
    expect(text.textContent).toBe('—');
    await setLocalePref('en-US');
    bar.relabel();
    expect(text.textContent).toBe('—');
    await setLocalePref('zh-CN');
  });
});
