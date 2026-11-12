/**
 * viewmodel/settings-state — 设置的唯一真相源（无 DOM，ADR-0011 §2）。
 *
 * 职责：默认值 + 校验回落（非法值退回默认）+ 一次性 `load(ViewStateStore)` +
 *       `set()` 写穿持久化 + 订阅。**如何生效**（主题/CSS 变量/行高几何/协议参数）在 app 层。
 *
 * 红线：只存本地（chrome.storage.local / localStorage 兜底），永不存文档内容。
 */
import type { CopyFormat, ExprBudgetLevel, SortOrder } from '../protocol/types';
import { normalizeExportMode, type ExportMode } from './export-state';

export type SettingsKey =
  | 'theme'
  | 'rowHeight'
  | 'indent'
  | 'sortOrder'
  | 'typeColumn'
  | 'defaultCopyFormat'
  | 'jsonIndent'
  | 'searchCopyFormat'
  | 'exportMode'
  | 'repairTruncated'
  | 'adaptiveExpand'
  | 'advBudget'
  | 'escapeUnicode';

export interface Settings {
  theme: 'dark' | 'light';
  /** 行高（px）：20 / 22 / 24 / 26 */
  rowHeight: number;
  /** 树缩进（px）：12 / 16 / 20 */
  indent: number;
  /** 子键显示排序（第 13 项；ADR-0024 §3）：原始顺序 / 键名升序 / 键名降序 */
  sortOrder: SortOrder;
  /** 键右侧显示类型列 */
  typeColumn: boolean;
  /** 行尾浮条「复制」使用的格式（右键菜单仍是 4 项显式） */
  defaultCopyFormat: CopyFormat;
  /** JSON 缩进（ADR-0022）：0 = 紧凑 / 2 / 4；导出 + 整份复制 + 子树复制共用 */
  jsonIndent: number;
  /** 搜索结果行「双击复制」使用的格式（默认路径；与行尾浮条 defaultCopyFormat 相互独立） */
  searchCopyFormat: CopyFormat;
  /** 导出方式（ADR-0012 修订）：分体按钮主操作 + 设置面板「导出方式」 */
  exportMode: ExportMode;
  /** 导入时自动修复截断 JSON */
  repairTruncated: boolean;
  /** 小文档加载即全展开 */
  adaptiveExpand: boolean;
  /** 表达式高级预算档位（第 11 项；ADR-0018 §7）：宽松 / 标准（默认）/ 严格 */
  advBudget: ExprBudgetLevel;
  /** 导出时把非 ASCII 转义为 `\uXXXX`（第 12 项；ADR-0022 §2，默认关） */
  escapeUnicode: boolean;
}

/** 布局态（主题之外的工作区 UI 状态，ADR-0011 §2） */
export interface UiState {
  /** 左面板模式；`none` = 左面板关闭（大纲面板 = ADR-0013；表达式 = ADR-0018） */
  panel: 'none' | 'doc' | 'search' | 'outline' | 'settings' | 'expression';
  /** 右侧工作区折叠 */
  railCollapsed: boolean;
  /** 视图模式（ADR-0003 修订 2026-11-03）：树视图 / 原始文本视图 */
  viewMode: 'tree' | 'raw';
}

export const SETTINGS_STORAGE_KEY = 'tjv.settings.v1';
export const UI_STORAGE_KEY = 'tjv.ui.v1';

export const ROW_HEIGHT_OPTIONS = [20, 22, 24, 26] as const;
export const INDENT_OPTIONS = [12, 16, 20] as const;
/** 子键显示排序三档（顺序 = 面板展示顺序；原始顺序为默认；ADR-0024 §3） */
export const SORT_ORDER_OPTIONS = ['raw', 'key-asc', 'key-desc'] as const;
export const JSON_INDENT_OPTIONS = [0, 2, 4] as const;
/** 表达式预算档位（顺序 = 面板展示顺序；标准为默认） */
export const EXPR_BUDGET_OPTIONS = ['loose', 'standard', 'strict'] as const;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  rowHeight: 24,
  indent: 16,
  sortOrder: 'raw',
  typeColumn: false,
  defaultCopyFormat: 'subtree',
  jsonIndent: 2,
  searchCopyFormat: 'path',
  exportMode: 'file',
  repairTruncated: true,
  adaptiveExpand: true,
  advBudget: 'standard',
  escapeUnicode: false,
};

export const DEFAULT_UI_STATE: UiState = { panel: 'doc', railCollapsed: false, viewMode: 'tree' };

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

/**
 * 任意读盘内容 → 合法 Settings（逐字段校验，非法回落默认；ADR-0011 §2）。
 * 旧键迁移（ADR-0022 §3）：`jsonIndent` 缺失时读旧 `copyIndent`（新键优先），返回值只含新键。
 */
export function normalizeSettings(raw: unknown): Settings {
  const bag = (raw ?? {}) as Partial<Record<keyof Settings, unknown>> & { copyIndent?: unknown };
  return {
    theme: THEMES.has(bag.theme as string) ? (bag.theme as Settings['theme']) : DEFAULT_SETTINGS.theme,
    rowHeight: pickNumber(bag.rowHeight, ROW_HEIGHT_OPTIONS, DEFAULT_SETTINGS.rowHeight),
    indent: pickNumber(bag.indent, INDENT_OPTIONS, DEFAULT_SETTINGS.indent),
    sortOrder: (SORT_ORDER_OPTIONS as readonly string[]).includes(bag.sortOrder as string)
      ? (bag.sortOrder as SortOrder)
      : DEFAULT_SETTINGS.sortOrder,
    typeColumn: pickBoolean(bag.typeColumn, DEFAULT_SETTINGS.typeColumn),
    defaultCopyFormat: COPY_FORMATS.has(bag.defaultCopyFormat as string)
      ? (bag.defaultCopyFormat as CopyFormat)
      : DEFAULT_SETTINGS.defaultCopyFormat,
    jsonIndent: pickNumber(
      bag.jsonIndent ?? bag.copyIndent,
      JSON_INDENT_OPTIONS,
      DEFAULT_SETTINGS.jsonIndent,
    ),
    searchCopyFormat: COPY_FORMATS.has(bag.searchCopyFormat as string)
      ? (bag.searchCopyFormat as CopyFormat)
      : DEFAULT_SETTINGS.searchCopyFormat,
    exportMode: normalizeExportMode(bag.exportMode),
    repairTruncated: pickBoolean(bag.repairTruncated, DEFAULT_SETTINGS.repairTruncated),
    adaptiveExpand: pickBoolean(bag.adaptiveExpand, DEFAULT_SETTINGS.adaptiveExpand),
    advBudget: (EXPR_BUDGET_OPTIONS as readonly string[]).includes(bag.advBudget as string)
      ? (bag.advBudget as Settings['advBudget'])
      : DEFAULT_SETTINGS.advBudget,
    escapeUnicode: pickBoolean(bag.escapeUnicode, DEFAULT_SETTINGS.escapeUnicode),
  };
}

/** 任意读盘内容 → 合法 UiState */
export function normalizeUiState(raw: unknown): UiState {
  const bag = (raw ?? {}) as Partial<Record<keyof UiState, unknown>>;
  const panel = bag.panel;
  return {
    panel:
      panel === 'none' ||
      panel === 'doc' ||
      panel === 'search' ||
      panel === 'outline' ||
      panel === 'settings' ||
      panel === 'expression'
        ? panel
        : DEFAULT_UI_STATE.panel,
    railCollapsed: pickBoolean(bag.railCollapsed, DEFAULT_UI_STATE.railCollapsed),
    viewMode: bag.viewMode === 'raw' ? 'raw' : 'tree',
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
