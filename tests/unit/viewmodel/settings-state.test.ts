import { describe, expect, it, vi } from 'vitest';
import {
  COPY_INDENT_OPTIONS,
  DEFAULT_SETTINGS,
  INDENT_OPTIONS,
  normalizeSettings,
  normalizeUiState,
  ROW_HEIGHT_OPTIONS,
  SETTINGS_STORAGE_KEY,
  SettingsState,
  UI_STORAGE_KEY,
  type SettingsStore,
} from '../../../src/viewmodel/settings-state';

/** 内存 fake store：记录写入，可预设读盘值/抛错。 */
function fakeStore(initial: Record<string, unknown> = {}, opts: { failRead?: boolean } = {}): SettingsStore & {
  writes: Array<{ key: string; value: unknown }>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    writes,
    async get<T>(key: string): Promise<T | undefined> {
      if (opts.failRead) throw new Error('storage unavailable');
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      writes.push({ key, value });
      data.set(key, value);
    },
  };
}

describe('settings-state — 默认值与校验', () => {
  it('默认值固定（ADR-0011 §1）', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'dark',
      rowHeight: 24,
      indent: 16,
      typeColumn: false,
      defaultCopyFormat: 'subtree',
      copyIndent: 2,
      searchCopyFormat: 'path',
      exportMode: 'file',
      repairTruncated: true,
      adaptiveExpand: true,
      advBudget: 'standard',
    });
  });

  it('advBudget：默认标准 / 合法保留 / 非法回落（#27 / ADR-0018 §7）', () => {
    expect(DEFAULT_SETTINGS.advBudget).toBe('standard');
    expect(normalizeSettings({}).advBudget).toBe('standard');
    expect(normalizeSettings({ advBudget: 'loose' }).advBudget).toBe('loose');
    expect(normalizeSettings({ advBudget: 'strict' }).advBudget).toBe('strict');
    expect(normalizeSettings({ advBudget: 'custom' }).advBudget).toBe('standard');
    expect(normalizeSettings({ advBudget: 1 }).advBudget).toBe('standard');
  });

  it('选项集合固定：行高 4 档 / 缩进 3 档 / 复制缩进 0-2-4', () => {
    expect([...ROW_HEIGHT_OPTIONS]).toEqual([20, 22, 24, 26]);
    expect([...INDENT_OPTIONS]).toEqual([12, 16, 20]);
    expect([...COPY_INDENT_OPTIONS]).toEqual([0, 2, 4]);
  });

  it('searchCopyFormat：默认路径 / 合法值保留 / 非法回落（ADR-0011 修订）', () => {
    expect(DEFAULT_SETTINGS.searchCopyFormat).toBe('path');
    expect(normalizeSettings({}).searchCopyFormat).toBe('path');
    expect(normalizeSettings({ searchCopyFormat: 'subtree' }).searchCopyFormat).toBe('subtree');
    expect(normalizeSettings({ searchCopyFormat: 'compact' }).searchCopyFormat).toBe('path');
    expect(normalizeSettings({ searchCopyFormat: 'value' }).searchCopyFormat).toBe('value');
  });

  it('normalizeSettings：非法/缺省/非对象 → 全部回落默认', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({
        theme: 'blue',
        rowHeight: 999,
        indent: 'big',
        typeColumn: 'yes',
        defaultCopyFormat: 'compact',
        copyIndent: 3,
        searchCopyFormat: 'compact',
        exportMode: 'download',
        repairTruncated: 1,
        adaptiveExpand: 'true',
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizeSettings：合法值保留，部分非法只回落那一项', () => {
    const s = normalizeSettings({ theme: 'light', rowHeight: 26, indent: 12, copyIndent: 0, adaptiveExpand: false, nope: 1 });
    expect(s.theme).toBe('light');
    expect(s.rowHeight).toBe(26);
    expect(s.indent).toBe(12);
    expect(s.copyIndent).toBe(0);
    expect(s.adaptiveExpand).toBe(false);
    expect(s.typeColumn).toBe(DEFAULT_SETTINGS.typeColumn); // 缺省回落
  });

  it('normalizeUiState：panel 枚举校验（含大纲，ADR-0013）+ railCollapsed 布尔 + viewMode 枚举（ADR-0003 修订）', () => {
    expect(normalizeUiState({ panel: 'settings', railCollapsed: true, viewMode: 'raw' })).toEqual({
      panel: 'settings',
      railCollapsed: true,
      viewMode: 'raw',
    });
    // 大纲面板模式（ADR-0013 §1）：持久化恢复
    expect(normalizeUiState({ panel: 'outline' })).toEqual({
      panel: 'outline',
      railCollapsed: false,
      viewMode: 'tree',
    });
    // UiState 不再持有 exportMode（ADR-0012 修订）：历史字段被忽略
    expect(normalizeUiState({ panel: 'bogus', railCollapsed: 'x', exportMode: 'clipboard' })).toEqual({
      panel: 'doc',
      railCollapsed: false,
      viewMode: 'tree',
    });
    expect(normalizeUiState({ viewMode: 'bogus' })).toEqual({ panel: 'doc', railCollapsed: false, viewMode: 'tree' });
    expect(normalizeUiState(undefined)).toEqual({ panel: 'doc', railCollapsed: false, viewMode: 'tree' });
  });
});

describe('settings-state — load / set / 持久化', () => {
  it('load：读回合法设置 + UI 状态；loadedFromStore=true', async () => {
    const store = fakeStore({
      [SETTINGS_STORAGE_KEY]: { ...DEFAULT_SETTINGS, theme: 'light', rowHeight: 22 },
      [UI_STORAGE_KEY]: { panel: 'search', railCollapsed: true },
    });
    const state = new SettingsState();
    await state.load(store);
    expect(state.get('theme')).toBe('light');
    expect(state.get('rowHeight')).toBe(22);
    expect(state.uiState()).toEqual({ panel: 'search', railCollapsed: true, viewMode: 'tree' });
    expect(state.loadedFromStore).toBe(true);
  });

  it('load：读盘抛错 → 默认值继续，不抛错', async () => {
    const state = new SettingsState();
    state.set('theme', 'light'); // 内存态先改（无 store → 不写盘）
    await state.load(fakeStore({}, { failRead: true }));
    expect(state.snapshot()).toEqual(DEFAULT_SETTINGS);
    expect(state.loadedFromStore).toBe(false);
  });

  it('set：合法变化 → 持久化 + 通知；相同值 → 不写不通知', async () => {
    const store = fakeStore();
    const state = new SettingsState();
    await state.load(store);
    const listener = vi.fn();
    state.subscribe(listener);

    expect(state.set('theme', 'light')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.writes.at(-1)).toEqual({ key: SETTINGS_STORAGE_KEY, value: expect.objectContaining({ theme: 'light' }) });

    expect(state.set('theme', 'light')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.writes).toHaveLength(1);
  });

  it('set：非法值回落默认，而不是写进脏数据', async () => {
    const state = new SettingsState();
    // 当前 = 默认 24；999 非法 → 回落 24 → 无变化
    expect(state.set('rowHeight', 999)).toBe(false);
    expect(state.get('rowHeight')).toBe(24);

    const store = fakeStore();
    await state.load(store);
    expect(state.set('rowHeight', 26)).toBe(true);
    // 再写非法 999：回落默认 24（与当前 26 不同）→ 变化且持久化的是 24
    expect(state.set('rowHeight', 999)).toBe(true);
    expect(state.get('rowHeight')).toBe(24);
    expect(store.writes.at(-1)?.value).toMatchObject({ rowHeight: 24 });
  });

  it('setUi：写穿 UI 键；内存态即时更新', async () => {
    const store = fakeStore();
    const state = new SettingsState();
    await state.load(store);
    state.setUi({ panel: 'settings' });
    state.setUi({ railCollapsed: true });
    expect(state.uiState()).toEqual({ panel: 'settings', railCollapsed: true, viewMode: 'tree' });
    const last = store.writes.at(-1);
    expect(last?.key).toBe(UI_STORAGE_KEY);
    expect(last?.value).toEqual({ panel: 'settings', railCollapsed: true, viewMode: 'tree' });

    // 大纲面板同样写穿（ADR-0013 §1）
    state.setUi({ panel: 'outline' });
    expect(state.uiState().panel).toBe('outline');
    expect(store.writes.at(-1)?.value).toEqual({ panel: 'outline', railCollapsed: true, viewMode: 'tree' });
  });

  it('exportMode 是设置项（ADR-0012 修订）：写穿 settings 键 + 通知', async () => {
    const store = fakeStore();
    const state = new SettingsState();
    await state.load(store);
    const listener = vi.fn();
    state.subscribe(listener);
    expect(state.get('exportMode')).toBe('file');
    expect(state.set('exportMode', 'clipboard')).toBe(true);
    expect(state.get('exportMode')).toBe('clipboard');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.writes.at(-1)).toEqual({
      key: SETTINGS_STORAGE_KEY,
      value: expect.objectContaining({ exportMode: 'clipboard' }),
    });
    expect(state.set('exportMode', 'bogus')).toBe(true); // 非法 → 回落 file，算变化
    expect(state.get('exportMode')).toBe('file');
  });

  it('snapshot 返回拷贝（外部改不到内部状态）', () => {
    const state = new SettingsState();
    const snap = state.snapshot();
    snap.theme = 'light';
    expect(state.get('theme')).toBe('dark');
  });

  it('unsubscribe 后不再收到通知', () => {
    const state = new SettingsState();
    const listener = vi.fn();
    const off = state.subscribe(listener);
    state.set('theme', 'light');
    off();
    state.set('theme', 'dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
