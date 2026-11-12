import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  INDENT_OPTIONS,
  JSON_INDENT_OPTIONS,
  normalizeSettings,
  normalizeUiState,
  ROW_HEIGHT_OPTIONS,
  SETTINGS_STORAGE_KEY,
  SettingsState,
  SORT_ORDER_OPTIONS,
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
      jsonIndent: 2,
      searchCopyFormat: 'path',
      exportMode: 'file',
      repairTruncated: true,
      adaptiveExpand: true,
      advBudget: 'standard',
      escapeUnicode: false,
      sortOrder: 'raw',
    });
  });

  it('sortOrder：默认原始顺序 / 三档合法保留 / 非法回落（#40 / ADR-0024 §3）', () => {
    expect(DEFAULT_SETTINGS.sortOrder).toBe('raw');
    expect(normalizeSettings({}).sortOrder).toBe('raw');
    expect(normalizeSettings({ sortOrder: 'raw' }).sortOrder).toBe('raw');
    expect(normalizeSettings({ sortOrder: 'key-asc' }).sortOrder).toBe('key-asc');
    expect(normalizeSettings({ sortOrder: 'key-desc' }).sortOrder).toBe('key-desc');
    expect(normalizeSettings({ sortOrder: 'bogus' }).sortOrder).toBe('raw');
    expect(normalizeSettings({ sortOrder: 'key_desc' }).sortOrder).toBe('raw');
    expect(normalizeSettings({ sortOrder: 1 }).sortOrder).toBe('raw');
    expect(normalizeSettings({ sortOrder: null }).sortOrder).toBe('raw');
  });

  it('sortOrder 选项集合固定：原始 / 升序 / 降序（ADR-0024 §3）', () => {
    expect([...SORT_ORDER_OPTIONS]).toEqual(['raw', 'key-asc', 'key-desc']);
  });

  it('advBudget：默认标准 / 合法保留 / 非法回落（#27 / ADR-0018 §7）', () => {
    expect(DEFAULT_SETTINGS.advBudget).toBe('standard');
    expect(normalizeSettings({}).advBudget).toBe('standard');
    expect(normalizeSettings({ advBudget: 'loose' }).advBudget).toBe('loose');
    expect(normalizeSettings({ advBudget: 'strict' }).advBudget).toBe('strict');
    expect(normalizeSettings({ advBudget: 'custom' }).advBudget).toBe('standard');
    expect(normalizeSettings({ advBudget: 1 }).advBudget).toBe('standard');
  });

  it('选项集合固定：行高 4 档 / 缩进 3 档 / JSON 缩进 0-2-4', () => {
    expect([...ROW_HEIGHT_OPTIONS]).toEqual([20, 22, 24, 26]);
    expect([...INDENT_OPTIONS]).toEqual([12, 16, 20]);
    expect([...JSON_INDENT_OPTIONS]).toEqual([0, 2, 4]);
  });

  it('jsonIndent：默认 2 / 三档保留 / 非法回落（#38 / ADR-0022 §2-§3）', () => {
    expect(DEFAULT_SETTINGS.jsonIndent).toBe(2);
    expect(normalizeSettings({}).jsonIndent).toBe(2);
    expect(normalizeSettings({ jsonIndent: 0 }).jsonIndent).toBe(0);
    expect(normalizeSettings({ jsonIndent: 2 }).jsonIndent).toBe(2);
    expect(normalizeSettings({ jsonIndent: 4 }).jsonIndent).toBe(4);
    expect(normalizeSettings({ jsonIndent: 3 }).jsonIndent).toBe(2);
    expect(normalizeSettings({ jsonIndent: -2 }).jsonIndent).toBe(2);
    expect(normalizeSettings({ jsonIndent: '4' }).jsonIndent).toBe(4); // 既有 pickNumber 口径：可强转的数字字符串
  });

  it('jsonIndent：旧键 copyIndent 迁移（读 jsonIndent ?? copyIndent，新键优先；ADR-0022 §3）', () => {
    expect(normalizeSettings({ copyIndent: 4 }).jsonIndent).toBe(4);
    expect(normalizeSettings({ copyIndent: 0 }).jsonIndent).toBe(0);
    expect(normalizeSettings({ copyIndent: 2 }).jsonIndent).toBe(2);
    expect(normalizeSettings({ jsonIndent: 0, copyIndent: 4 }).jsonIndent).toBe(0);
    expect(normalizeSettings({ jsonIndent: 4, copyIndent: 0 }).jsonIndent).toBe(4);
    expect(normalizeSettings({ copyIndent: 3 }).jsonIndent).toBe(2); // 旧键也走白名单校验
    expect(normalizeSettings({ jsonIndent: undefined, copyIndent: 4 }).jsonIndent).toBe(4);
  });

  it('normalizeSettings 返回值只含新键：不含 copyIndent（写盘快照只用新键）', () => {
    const migrated = normalizeSettings({ copyIndent: 4 });
    expect('copyIndent' in migrated).toBe(false);
    expect(migrated.jsonIndent).toBe(4);
    expect(Object.keys(normalizeSettings({})).sort()).not.toContain('copyIndent');
  });

  it('escapeUnicode：默认关 / 布尔保留 / 非布尔回落（ADR-0022 §2）', () => {
    expect(DEFAULT_SETTINGS.escapeUnicode).toBe(false);
    expect(normalizeSettings({}).escapeUnicode).toBe(false);
    expect(normalizeSettings({ escapeUnicode: true }).escapeUnicode).toBe(true);
    expect(normalizeSettings({ escapeUnicode: false }).escapeUnicode).toBe(false);
    expect(normalizeSettings({ escapeUnicode: 'true' }).escapeUnicode).toBe(false);
    expect(normalizeSettings({ escapeUnicode: 1 }).escapeUnicode).toBe(false);
    expect(normalizeSettings({ escapeUnicode: null }).escapeUnicode).toBe(false);
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
        jsonIndent: 3,
        copyIndent: 3,
        searchCopyFormat: 'compact',
        exportMode: 'download',
        repairTruncated: 1,
        adaptiveExpand: 'true',
        escapeUnicode: 'yes',
        sortOrder: 'bogus',
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizeSettings：合法值保留，部分非法只回落那一项', () => {
    const s = normalizeSettings({ theme: 'light', rowHeight: 26, indent: 12, jsonIndent: 0, escapeUnicode: true, adaptiveExpand: false, nope: 1 });
    expect(s.theme).toBe('light');
    expect(s.rowHeight).toBe(26);
    expect(s.indent).toBe(12);
    expect(s.jsonIndent).toBe(0);
    expect(s.escapeUnicode).toBe(true);
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

  it('load：旧存储 copyIndent 迁移到 jsonIndent（新键优先；写盘只写新键，ADR-0022 §3）', async () => {
    const store = fakeStore({ [SETTINGS_STORAGE_KEY]: { theme: 'light', copyIndent: 4 } });
    const state = new SettingsState();
    await state.load(store);
    expect(state.get('jsonIndent')).toBe(4);
    expect(state.get('theme')).toBe('light'); // 其余字段照常读回
    expect('copyIndent' in state.snapshot()).toBe(false);

    // 再改一项：写盘快照含新键 jsonIndent，不含旧键 copyIndent
    expect(state.set('jsonIndent', 0)).toBe(true);
    const written = store.writes.at(-1)?.value as Record<string, unknown>;
    expect(written.jsonIndent).toBe(0);
    expect('copyIndent' in written).toBe(false);
  });

  it('load：旧存储同时有新键时新键优先，不被旧键覆盖', async () => {
    const store = fakeStore({ [SETTINGS_STORAGE_KEY]: { jsonIndent: 0, copyIndent: 4 } });
    const state = new SettingsState();
    await state.load(store);
    expect(state.get('jsonIndent')).toBe(0);
  });

  it('jsonIndent / escapeUnicode：普通读写持久化（set 写穿 + 通知 + 同值 no-op）', async () => {
    const store = fakeStore();
    const state = new SettingsState();
    await state.load(store);
    const listener = vi.fn();
    state.subscribe(listener);

    expect(state.set('jsonIndent', 4)).toBe(true);
    expect(state.get('jsonIndent')).toBe(4);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.writes.at(-1)).toEqual({
      key: SETTINGS_STORAGE_KEY,
      value: expect.objectContaining({ jsonIndent: 4, escapeUnicode: false }),
    });

    expect(state.set('escapeUnicode', true)).toBe(true);
    expect(state.get('escapeUnicode')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.writes.at(-1)).toEqual({
      key: SETTINGS_STORAGE_KEY,
      value: expect.objectContaining({ jsonIndent: 4, escapeUnicode: true }),
    });

    expect(state.set('escapeUnicode', true)).toBe(false); // 同值 no-op
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('set：jsonIndent 非法值回落默认 2，而不是写进脏数据', () => {
    const state = new SettingsState();
    expect(state.set('jsonIndent', 3)).toBe(false); // 默认 2 → 非法回落 2 → 无变化
    expect(state.get('jsonIndent')).toBe(2);
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

  it('load：旧存储缺 sortOrder 键 → 回落 raw（ADR-0024 §3）', async () => {
    const store = fakeStore({ [SETTINGS_STORAGE_KEY]: { theme: 'light', rowHeight: 22 } });
    const state = new SettingsState();
    await state.load(store);
    expect(state.get('sortOrder')).toBe('raw');
    expect(state.get('theme')).toBe('light'); // 其余字段照常读回
    expect(state.snapshot().sortOrder).toBe('raw'); // 快照含新键（写盘只写新键）
  });

  it('sortOrder：写穿持久化 + 通知 + 重载读回 + 同值 no-op（ADR-0024 §3）', async () => {
    const store = fakeStore();
    const state = new SettingsState();
    await state.load(store);
    const listener = vi.fn();
    state.subscribe(listener);

    expect(state.get('sortOrder')).toBe('raw');
    expect(state.set('sortOrder', 'key-desc')).toBe(true);
    expect(state.get('sortOrder')).toBe('key-desc');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.writes.at(-1)).toEqual({
      key: SETTINGS_STORAGE_KEY,
      value: expect.objectContaining({ sortOrder: 'key-desc' }),
    });

    expect(state.set('sortOrder', 'key-desc')).toBe(false); // 同值 no-op
    expect(listener).toHaveBeenCalledTimes(1);

    // 非法值回落默认 raw（与其它字段同一纪律），而不是写进脏数据
    expect(state.set('sortOrder', 'bogus')).toBe(true);
    expect(state.get('sortOrder')).toBe('raw');

    // 重载：读回持久化的合法档位
    expect(state.set('sortOrder', 'key-asc')).toBe(true);
    const reloaded = new SettingsState();
    await reloaded.load(store);
    expect(reloaded.get('sortOrder')).toBe('key-asc');
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
