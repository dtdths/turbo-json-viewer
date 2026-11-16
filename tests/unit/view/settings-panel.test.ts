/**
 * tests/unit/view/settings-panel — 设置面板 DOM 层：#45 / ADR-0026 §3 的第 14 行「语言」+ relabel。
 *
 * 用极简 fake DOM（仓库不引 jsdom）；只验证面板自己的契约：
 *   - 14 行顺序（locale 殿后）、`[data-setting="locale"]` + `[data-value]` 选项；
 *   - `relabel()` 重建静态文案（中 ↔ 英），不触发 onChange、按最近 model 回填 active/checked。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initI18n, setLocalePref } from '../../../src/i18n/index';
import { SettingsPanel } from '../../../src/view/panels/settings-panel';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/viewmodel/settings-state';
import { installFakeDom, type FakeDomHandle, type FakeElement } from './fake-dom';

const ROW_ORDER = [
  'theme',
  'rowHeight',
  'indent',
  'sortOrder',
  'typeColumn',
  'defaultCopyFormat',
  'jsonIndent',
  'searchCopyFormat',
  'exportMode',
  'repairTruncated',
  'adaptiveExpand',
  'advBudget',
  'escapeUnicode',
  'locale',
];

let dom: FakeDomHandle;

beforeAll(async () => {
  dom = installFakeDom();
  await initI18n('zh-CN');
});

afterAll(() => {
  dom.restore();
});

function mountPanel(): { host: FakeElement; panel: SettingsPanel; changes: Array<[string, unknown]> } {
  const host = dom.document.createElement('div');
  const changes: Array<[string, unknown]> = [];
  const panel = new SettingsPanel(host as unknown as HTMLElement, {
    onChange: (key, value) => changes.push([key, value]),
  });
  panel.mount();
  return { host, panel, changes };
}

function rows(host: FakeElement): FakeElement[] {
  return host.children.filter((child) => child.dataset.setting !== undefined);
}

function row(host: FakeElement, key: string): FakeElement {
  const found = rows(host).find((entry) => entry.dataset.setting === key);
  if (!found) throw new Error(`missing settings row: ${key}`);
  return found;
}

function segButtons(rowEl: FakeElement): FakeElement[] {
  const seg = rowEl.children.find((child) => child.className.includes('settings-panel__seg'));
  if (!seg) throw new Error('missing segmented control');
  return seg.children;
}

function activeValue(rowEl: FakeElement): string | null {
  return segButtons(rowEl).find((button) => button.classList.contains('is-active'))?.dataset.value ?? null;
}

describe('SettingsPanel — 第 14 行「语言」DOM 契约', () => {
  it('14 行按固定顺序排列，locale 是最后一行', () => {
    const { host } = mountPanel();
    expect(rows(host).map((entry) => entry.dataset.setting)).toEqual(ROW_ORDER);
    expect(host.getAttribute('aria-label')).toBe('设置');
  });

  it('locale 行：标签 + hint + auto / en-US / zh-CN 三个选项', () => {
    const { host } = mountPanel();
    const localeRow = row(host, 'locale');

    // 标签节点同时带对外契约类 .settings__label（smoke-i18n 按它取文案）
    const label = localeRow.children[0] as FakeElement;
    expect(label.classList.contains('settings__label')).toBe(true);
    expect(label.textContent).toBe('语言');

    expect(segButtons(localeRow).map((button) => button.dataset.value)).toEqual([
      'auto',
      'en-US',
      'zh-CN',
    ]);
    // auto 用词条，其余用各语言自称（不翻译）
    expect(segButtons(localeRow).map((button) => button.textContent)).toEqual([
      '跟随系统',
      'English',
      '简体中文',
    ]);

    const hint = localeRow.children.find((child) => child.className.includes('settings-panel__hint'));
    expect(hint?.textContent).toBe('切换后立即生效；跟随系统时按浏览器语言自动选择');
  });

  it('点击 locale 选项上抛 onChange("locale", value)', () => {
    const { host, changes } = mountPanel();
    const panelZh = segButtons(row(host, 'locale')).find((button) => button.dataset.value === 'zh-CN');
    expect(panelZh).toBeDefined();
    panelZh?.emit('click');
    expect(changes).toEqual([['locale', 'zh-CN']]);
  });

  it('render 只回填 active / checked，不触发 onChange', () => {
    const { host, panel, changes } = mountPanel();
    const model: Settings = {
      ...DEFAULT_SETTINGS,
      theme: 'light',
      escapeUnicode: true,
      locale: 'zh-CN',
    };
    panel.render(model);
    expect(activeValue(row(host, 'theme'))).toBe('light');
    expect(activeValue(row(host, 'locale'))).toBe('zh-CN');
    const checkbox = row(host, 'escapeUnicode').children.find(
      (child) => child.className.includes('settings-panel__checkbox'),
    );
    expect(checkbox?.checked).toBe(true);
    expect(changes).toEqual([]);
  });
});

describe('SettingsPanel — relabel()（运行时切换语言）', () => {
  it('重建静态文案为中 → 英，并保留 active / checked，不触发 onChange', async () => {
    const { host, panel, changes } = mountPanel();
    const model: Settings = {
      ...DEFAULT_SETTINGS,
      theme: 'light',
      escapeUnicode: true,
      locale: 'zh-CN',
    };
    panel.render(model);
    expect((row(host, 'theme').children[0] as FakeElement).textContent).toBe('主题');
    expect(changes).toEqual([]);

    await setLocalePref('en-US');
    panel.relabel();

    expect(host.getAttribute('aria-label')).toBe('Settings');
    expect((row(host, 'theme').children[0] as FakeElement).textContent).toBe('Theme');
    expect((row(host, 'locale').children[0] as FakeElement).textContent).toBe('Language');
    expect(segButtons(row(host, 'locale')).map((button) => button.textContent)).toEqual([
      'System',
      'English',
      '简体中文',
    ]);
    // 回填最近 model：active / checked 不丢
    expect(activeValue(row(host, 'theme'))).toBe('light');
    expect(activeValue(row(host, 'locale'))).toBe('zh-CN');
    const checkbox = row(host, 'escapeUnicode').children.find(
      (child) => child.className.includes('settings-panel__checkbox'),
    );
    expect(checkbox?.checked).toBe(true);
    // 重建 DOM 不代表用户交互
    expect(changes).toEqual([]);

    // 再切回来仍然幂等（行数不叠加、文案恢复中文）
    await setLocalePref('zh-CN');
    panel.relabel();
    expect(rows(host)).toHaveLength(14);
    expect((row(host, 'theme').children[0] as FakeElement).textContent).toBe('主题');
  });

  it('重建后把焦点还给同值的语言选项（键盘用户不丢焦点）', async () => {
    const { host, panel } = mountPanel();
    panel.render({ ...DEFAULT_SETTINGS, locale: 'zh-CN' });
    const focused = segButtons(row(host, 'locale')).find((button) => button.dataset.value === 'zh-CN');
    focused?.focus();
    expect(focused?.ownerDocument.activeElement).toBe(focused);

    await setLocalePref('en-US');
    panel.relabel();

    const restored = dom.document.activeElement;
    expect(restored?.dataset.value).toBe('zh-CN');
    expect(host.contains(restored)).toBe(true);
    await setLocalePref('zh-CN');
  });
});
