/**
 * viewmodel/settings-state — 设置的唯一真相源（无 DOM，ADR-0011 §2）。
 *
 * 职责：默认值 + 校验回落（非法值退回默认）+ 一次性 `load(ViewStateStore)` +
 *       `set()` 写穿持久化 + 订阅。**如何生效**（主题/CSS 变量/行高几何/协议参数）在 app 层。
 *
 * 红线：只存本地（chrome.storage.local / localStorage 兜底），永不存文档内容。
 */
import type { CopyFormat } from '../protocol/types';
import { normalizeExportMode, type ExportMode } from './export-state';

export type SettingsKey =
  | 'theme'
  | 'rowHeight'
  | 'indent'
  | 'typeColumn'
  | 'defaultCopyFormat'
  | 'copyIndent'
  | 'exportMode'
  | 'repairTruncated'
  | 'adaptiveExpand';

export interface Settings {
  theme: 'dark' | 'light';
  /** 行高（px）：20 / 22 / 24 / 26 */
  rowHeight: number;
  /** 树缩进（px）：12 / 16 / 20 */
  indent: number;
  /** 键右侧显示类型列 */
  typeColumn: boolean;
  /** 行尾浮条「复制」使用的格式（右键菜单仍是 4 项显式） */
  defaultCopyFormat: CopyFormat;
  /** 子树 JSON 缩进：0 = 紧凑 */
  copyIndent: number;
  /** 导出方式（ADR-0012 修订）：分体按钮主操作 + 设置面板「导出方式」 */
  exportMode: ExportMode;
  /** 导入时自动修复截断 JSON */
  repairTruncated: boolean;
  /** 小文档加载即全展开 */
  adaptiveExpand: boolean;
}

/** 布局态（主题之外的工作区 UI 状态，ADR-0011 §2） */
export interface UiState {
  /** 左面板模式；`none` = 左面板关闭 */
  panel: 'none' | 'doc' | 'search' | 'settings';
  /** 右侧工作区折叠 */
  railCollapsed: boolean;
}

export const SETTINGS_STORAGE_KEY = 'tjv.settings.v1';
export const UI_STORAGE_KEY = 'tjv.ui.v1';

export const ROW_HEIGHT_OPTIONS = [20, 22, 24, 26] as const;
export const INDENT_OPTIONS = [12, 16, 20] as const;
export const COPY_INDENT_OPTIONS = [0, 2, 4] as const;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  rowHeight: 24,
  indent: 16,
  typeColumn: false,
  defaultCopyFormat: 'subtree',
  copyIndent: 2,
  exportMode: 'file',
  repairTruncated: true,
  adaptiveExpand: true,
};

export const DEFAULT_UI_STATE: UiState = { panel: 'doc', railCollapsed: false };

/** `app/storage.ts` 的 ViewStateStore 结构化子集（便于单测注入 fake） */
export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

const THEMES = new Set(['dark', 'light']);
const COPY_FORMATS = new Set(['subtree', 'path', 'value', 'key']);

function pickNumber(value: unknown, allowed: readonly number[], fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return allowed.includes(n) ? n : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 任意读盘内容 → 合法 Settings（逐字段校验，非法回落默认；ADR-0011 §2） */
export function normalizeSettings(raw: unknown): Settings {
  const bag = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    theme: THEMES.has(bag.theme as string) ? (bag.theme as Settings['theme']) : DEFAULT_SETTINGS.theme,
    rowHeight: pickNumber(bag.rowHeight, ROW_HEIGHT_OPTIONS, DEFAULT_SETTINGS.rowHeight),
    indent: pickNumber(bag.indent, INDENT_OPTIONS, DEFAULT_SETTINGS.indent),
    typeColumn: pickBoolean(bag.typeColumn, DEFAULT_SETTINGS.typeColumn),
    defaultCopyFormat: COPY_FORMATS.has(bag.defaultCopyFormat as string)
      ? (bag.defaultCopyFormat as CopyFormat)
      : DEFAULT_SETTINGS.defaultCopyFormat,
    copyIndent: pickNumber(bag.copyIndent, COPY_INDENT_OPTIONS, DEFAULT_SETTINGS.copyIndent),
    exportMode: normalizeExportMode(bag.exportMode),
    repairTruncated: pickBoolean(bag.repairTruncated, DEFAULT_SETTINGS.repairTruncated),
    adaptiveExpand: pickBoolean(bag.adaptiveExpand, DEFAULT_SETTINGS.adaptiveExpand),
  };
}

/** 任意读盘内容 → 合法 UiState */
export function normalizeUiState(raw: unknown): UiState {
  const bag = (raw ?? {}) as Partial<Record<keyof UiState, unknown>>;
  const panel = bag.panel;
  return {
    panel: panel === 'none' || panel === 'doc' || panel === 'search' || panel === 'settings' ? panel : DEFAULT_UI_STATE.panel,
    railCollapsed: pickBoolean(bag.railCollapsed, DEFAULT_UI_STATE.railCollapsed),
  };
}

export class SettingsState {
  private current: Settings = { ...DEFAULT_SETTINGS };
  private ui: UiState = { ...DEFAULT_UI_STATE };
  private readonly listeners = new Set<(settings: Settings) => void>();
  private store: SettingsStore | null = null;
  /** 是否成功从本地读到过设置（dev hook / 冒烟断言用） */
  loadedFromStore = false;

  constructor(init: Partial<Settings> = {}) {
    this.current = normalizeSettings({ ...DEFAULT_SETTINGS, ...init });
  }

  /** 启动时一次性读盘；失败（隐私模式/配额）用默认值继续，不抛错 */
  async load(store: SettingsStore): Promise<void> {
    this.store = store;
    try {
      const [rawSettings, rawUi] = await Promise.all([
        store.get<unknown>(SETTINGS_STORAGE_KEY),
        store.get<unknown>(UI_STORAGE_KEY),
      ]);
      this.current = normalizeSettings(rawSettings);
      this.ui = normalizeUiState(rawUi);
      this.loadedFromStore = rawSettings !== undefined;
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
      this.ui = { ...DEFAULT_UI_STATE };
    }
  }

  snapshot(): Settings {
    return { ...this.current };
  }

  uiState(): UiState {
    return { ...this.ui };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.current[key];
  }

  /** 设置一项（值会按同一套规则校验）；返回是否真的变化。变化才持久化 + 通知订阅者。 */
  set<K extends keyof Settings>(key: K, value: unknown): boolean {
    const next = normalizeSettings({ ...this.current, [key]: value });
    if (next[key] === this.current[key]) return false;
    this.current = next;
    this.persistSettings();
    for (const listener of this.listeners) listener(this.snapshot());
    return true;
  }

  /** 更新布局态（面板模式/右栏折叠）；同样写穿持久化。 */
  setUi(patch: Partial<UiState>): void {
    const next = normalizeUiState({ ...this.ui, ...patch });
    this.ui = next;
    if (this.store) {
      void Promise.resolve(this.store.set(UI_STORAGE_KEY, next)).catch(() => undefined);
    }
  }

  subscribe(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private persistSettings(): void {
    if (!this.store) return;
    // 写盘失败不阻塞 UI（配额/隐私模式）：内存态已更新
    void Promise.resolve(this.store.set(SETTINGS_STORAGE_KEY, this.snapshot())).catch(() => undefined);
  }
}
