/**
 * view/panels/settings-panel — 设置面板的 DOM 层（ADR-0011 §1 / §4）。
 *
 * 边界：
 *   - 自建 **14 行** DOM（segmented / checkbox；第 14 行 = 语言，#45 / ADR-0026 §3）；
 *     page.html 只留 `.panel.panel--settings` 挂载点。
 *   - 控件状态只从 `Settings` 快照同步；用户改动经 `opts.onChange` 上抛，由 app 调
 *     `SettingsState.set()`，再经订阅回到 `render()`。本模块不读写存储、不碰主题/CSS 变量。
 *
 * 硬约束：
 *   - 文本全部走 textContent / createElement，**禁 innerHTML**。
 *   - `render()` 只同步 active / checked，**绝不触发 onChange**；必须幂等、可反复调用。
 *   - `relabel()`：语言切换时重建整张表（事件随按钮重建、不重复注册），并按最近一次
 *     model 回填 active / checked；同样不触发 onChange、不改任何设置状态。
 */
import {
  EXPR_BUDGET_OPTIONS,
  INDENT_OPTIONS,
  JSON_INDENT_OPTIONS,
  ROW_HEIGHT_OPTIONS,
  SORT_ORDER_OPTIONS,
  type Settings,
  type SettingsKey,
} from '../../viewmodel/settings-state';
import type { SortOrder } from '../../protocol/types';
import { EXPORT_MODES, EXPORT_MODE_LABELS } from '../../viewmodel/export-state';
import { languageChoices, t, type MessageKey } from '../../i18n/index';

export interface SettingsPanelOptions {
  /** 用户改了一项（只在用户交互时触发；render 不触发） */
  onChange(key: SettingsKey, value: Settings[SettingsKey]): void;
}

/** 14 项设置的任一值（= 各字段类型的联合） */
type SettingValue = Settings[SettingsKey];
interface SegItem {
  value: SettingValue;
  label: string;
  /** 控件可读名（缺省即按钮文本）；行高/缩进用 `20px` 形式补单位 */
  ariaLabel?: string;
}

interface SegButton {
  value: SettingValue;
  button: HTMLButtonElement;
}

interface SegRowSpec {
  key: SettingsKey;
  label: string;
  items: readonly SegItem[];
  /** 行尾小字单位（如 `px`），不占按钮文案 */
  unit?: string;
  /** 行下说明（可选） */
  hint?: string;
}

interface CheckRowSpec {
  key: SettingsKey;
  label: string;
  hint: string;
}

/* ---------------- 选项值集合（文案在 build 时按当前 locale 取词条） ---------------- */

/** 子键显示排序（#40 / ADR-0024 §3）：原始顺序为默认；取值集合 = `SORT_ORDER_OPTIONS`
 *  （单一来源在 protocol/versions），文案按值显式映射、不依赖数组下标。 */
const SORT_ORDER_KEYS: Record<SortOrder, MessageKey> = {
  raw: 'view.settings.sort.raw',
  'key-asc': 'view.settings.sort.asc',
  'key-desc': 'view.settings.sort.desc',
};

/** JSON 缩进的展示顺序：2 → 4 → 紧凑（0）；值集合仍来自 `JSON_INDENT_OPTIONS`（ADR-0022 §2）。 */
const JSON_INDENT_RANK: Readonly<Record<number, number>> = { 2: 0, 4: 1, 0: 2 };

type BudgetLevel = (typeof EXPR_BUDGET_OPTIONS)[number];
const BUDGET_KEYS: Record<BudgetLevel, MessageKey> = {
  loose: 'view.settings.budget.loose',
  standard: 'view.settings.budget.standard',
  strict: 'view.settings.budget.strict',
};

type CopyFormatOption = 'subtree' | 'path' | 'value' | 'key';
const COPY_FORMAT_KEYS: Record<CopyFormatOption, MessageKey> = {
  subtree: 'view.settings.copy.subtree',
  path: 'view.settings.copy.path',
  value: 'view.settings.copy.value',
  key: 'view.settings.copy.key',
};

/* ---------------- helpers ---------------- */

/** 行下说明（`.settings-panel__hint`）：seg / check 共用；id 规则 = `setting-<key>-hint`。 */
function appendRowHint(row: HTMLElement, key: SettingsKey, text: string, id = `setting-${key}-hint`): void {
  const hint = document.createElement('p');
  hint.className = 'settings-panel__hint';
  hint.id = id;
  hint.textContent = text;
  row.appendChild(hint);
}

function rowEl(key: SettingsKey): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'settings-panel__row';
  row.dataset.setting = key;
  return row;
}

/** 复制格式的 4 个选项（两处复用：默认复制格式 / 搜索结果双击复制）。 */
function copyFormatItems(): SegItem[] {
  return (Object.keys(COPY_FORMAT_KEYS) as CopyFormatOption[]).map((value) => ({
    value,
    label: t(COPY_FORMAT_KEYS[value]),
  }));
}

// ---------------------------------------------------------------- panel

export class SettingsPanel {
  private readonly host: HTMLElement;
  private readonly opts: SettingsPanelOptions;

  private mounted = false;
  private model: Settings | null = null;

  private readonly segs = new Map<SettingsKey, SegButton[]>();
  private readonly checks = new Map<SettingsKey, HTMLInputElement>();

  constructor(host: HTMLElement, opts: SettingsPanelOptions) {
    this.host = host;
    this.opts = opts;
  }

  // -------------------------------------------------------------- lifecycle

  /** 在 host 内建 DOM；幂等（重复调用不重复建行）。 */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    this.host.classList.add('panel', 'panel--settings', 'settings-panel');
    // 宿主（page.html）按 ADR-0011 §4 加 role=group；缺省时补上，保证 aria-label 有意义
    if (!this.host.getAttribute('role')) this.host.setAttribute('role', 'group');
    this.host.tabIndex = -1;
    this.buildDom();
  }

  /**
   * 语言切换：重建整面板 DOM（文案现取词条）+ 按最近一次 model 回填 active/checked。
   * 幂等、不触发 onChange、不改设置状态；未 mount 时等价 mount。
   */
  relabel(): void {
    if (!this.mounted) {
      this.mount();
      return;
    }
    // 重建会替换掉焦点所在的按钮（用户刚点的语言选项）：记住并归还焦点；顺带保住滚动位置。
    const focus = this.captureFocus();
    const scrollTop = this.host.scrollTop ?? 0;
    this.buildDom();
    if (this.model) this.render(this.model);
    this.host.scrollTop = scrollTop;
    this.restoreFocus(focus);
  }

  /** 记住「焦点所在的设置行 + 选项值」（重建前调用）。 */
  private captureFocus(): { setting: string; value: string } | null {
    let node = document.activeElement as (HTMLElement & { dataset?: DOMStringMap }) | null;
    let setting: string | null = null;
    let value: string | null = null;
    while (node) {
      if (setting === null && node.dataset?.setting) setting = node.dataset.setting;
      if (value === null && node.dataset?.value) value = node.dataset.value;
      node = node.parentNode as (HTMLElement & { dataset?: DOMStringMap }) | null;
    }
    return setting !== null && value !== null ? { setting, value } : null;
  }

  /** 重建后把焦点还给同值的新按钮（找不到就不抢焦点）。 */
  private restoreFocus(focus: { setting: string; value: string } | null): void {
    if (!focus) return;
    const row = this.host.querySelector(`[data-setting="${focus.setting}"]`);
    const target = row?.querySelector<HTMLButtonElement>(`[data-value="${focus.value}"]`);
    target?.focus();
  }

  /** 只同步控件状态（active / checked），绝不触发 onChange；幂等。 */
  render(model: Settings): void {
    if (!this.mounted) this.mount();
    this.model = { ...model };

    for (const [key, buttons] of this.segs) {
      for (const entry of buttons) {
        const active = this.model[key] === entry.value;
        entry.button.classList.toggle('is-active', active);
        entry.button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    for (const [key, checkbox] of this.checks) {
      checkbox.checked = Boolean(this.model[key]);
    }
  }

  /** 面板打开时把焦点放到面板容器（tabindex="-1" 的根；不劫持 Tab 顺序）。 */
  focus(): void {
    if (!this.mounted) this.mount();
    this.host.focus();
  }

  // -------------------------------------------------------------- rendering

  /** 按当前 locale 重建 14 行（事件绑定随按钮一起重建，不会重复注册）。 */
  private buildDom(): void {
    this.host.replaceChildren();
    this.segs.clear();
    this.checks.clear();
    this.host.setAttribute('aria-label', t('view.settings.panelLabel'));

    this.host.append(
      this.buildSegRow({ key: 'theme', label: t('view.settings.theme'), items: this.themeItems() }),
      this.buildSegRow({
        key: 'rowHeight',
        label: t('view.settings.rowHeight'),
        items: this.rowHeightItems(),
        unit: 'px',
      }),
      this.buildSegRow({
        key: 'indent',
        label: t('view.settings.indent'),
        items: this.indentItems(),
        unit: 'px',
      }),
      // 第 13 项（#40 / ADR-0024 §3）：子键显示排序；只影响树/大纲/表达式结果树的显示顺序
      this.buildSegRow({
        key: 'sortOrder',
        label: t('view.settings.sortOrder'),
        items: this.sortOrderItems(),
        hint: t('view.settings.sortOrder.hint'),
      }),
      this.buildCheckRow({
        key: 'typeColumn',
        label: t('view.settings.typeColumn'),
        hint: t('view.settings.typeColumn.hint'),
      }),
      this.buildSegRow({
        key: 'defaultCopyFormat',
        label: t('view.settings.defaultCopyFormat'),
        items: copyFormatItems(),
      }),
      this.buildSegRow({
        key: 'jsonIndent',
        label: t('view.settings.jsonIndent'),
        items: this.jsonIndentItems(),
      }),
      this.buildSegRow({
        key: 'searchCopyFormat',
        label: t('view.settings.searchCopyFormat'),
        items: copyFormatItems(),
      }),
      this.buildSegRow({
        key: 'exportMode',
        label: t('view.settings.exportMode'),
        items: this.exportModeItems(),
      }),
      this.buildCheckRow({
        key: 'repairTruncated',
        label: t('view.settings.repairTruncated'),
        hint: t('view.settings.repairTruncated.hint'),
      }),
      this.buildCheckRow({
        key: 'adaptiveExpand',
        label: t('view.settings.adaptiveExpand'),
        hint: t('view.settings.adaptiveExpand.hint'),
      }),
      this.buildSegRow({
        key: 'advBudget',
        label: t('view.settings.advBudget'),
        items: this.budgetItems(),
      }),
      // 第 12 项（ADR-0022 §2）：导出转义非 ASCII；默认关，输出仍是合法 JSON
      this.buildCheckRow({
        key: 'escapeUnicode',
        label: t('view.settings.escapeUnicode'),
        hint: t('view.settings.escapeUnicode.hint'),
      }),
      // 第 14 项（#45 / ADR-0026 §3）：界面语言；`auto` 跟随系统，其余用各语言自称
      this.buildSegRow({
        key: 'locale',
        label: t('view.settings.language'),
        items: this.languageItems(),
        hint: t('view.settings.language.hint'),
      }),
    );
  }

  private themeItems(): SegItem[] {
    return [
      { value: 'dark', label: t('view.settings.theme.dark') },
      { value: 'light', label: t('view.settings.theme.light') },
    ];
  }

  private rowHeightItems(): SegItem[] {
    return ROW_HEIGHT_OPTIONS.map((value) => ({
      value,
      label: String(value),
      ariaLabel: `${value}px`,
    }));
  }

  private indentItems(): SegItem[] {
    return INDENT_OPTIONS.map((value) => ({
      value,
      label: String(value),
      ariaLabel: `${value}px`,
    }));
  }

  private sortOrderItems(): SegItem[] {
    return SORT_ORDER_OPTIONS.map((value) => ({ value, label: t(SORT_ORDER_KEYS[value]) }));
  }

  private jsonIndentItems(): SegItem[] {
    return [...JSON_INDENT_OPTIONS]
      .sort((a, b) => JSON_INDENT_RANK[a] - JSON_INDENT_RANK[b])
      .map((value) => ({
        value,
        label:
          value === 0
            ? t('view.settings.jsonIndent.compact')
            : t('view.settings.jsonIndent.spaces', { n: value }),
      }));
  }

  private exportModeItems(): SegItem[] {
    return EXPORT_MODES.map((value) => ({ value, label: EXPORT_MODE_LABELS[value] }));
  }

  private budgetItems(): SegItem[] {
    return EXPR_BUDGET_OPTIONS.map((value) => ({ value, label: t(BUDGET_KEYS[value]) }));
  }

  /** 语言选项：`auto` 用词条（「跟随系统」），其余用各语言**自称**（不翻译）。 */
  private languageItems(): SegItem[] {
    return languageChoices().map((choice) => ({
      value: choice.value,
      label: choice.nativeName ?? t('view.settings.language.auto'),
    }));
  }

  private buildSegRow(spec: SegRowSpec): HTMLDivElement {
    const row = rowEl(spec.key);

    const label = document.createElement('span');
    // `settings__label` 是对外 DOM 契约（smoke-i18n 按它取语言行标签）；`settings-panel__label` 负责样式
    label.className = 'settings-panel__label settings__label';
    label.id = `setting-${spec.key}-label`;
    label.textContent = spec.label;

    const seg = document.createElement('div');
    seg.className = 'settings-panel__seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-labelledby', label.id);
    if (spec.hint) seg.setAttribute('aria-describedby', `setting-${spec.key}-hint`);

    const buttons: SegButton[] = [];
    for (const item of spec.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-panel__segbtn';
      button.dataset.value = String(item.value);
      button.setAttribute('aria-pressed', 'false');
      button.textContent = item.label;
      if (item.ariaLabel) button.setAttribute('aria-label', item.ariaLabel);
      button.addEventListener('click', () => this.handleSegClick(spec.key, item.value));
      seg.appendChild(button);
      buttons.push({ value: item.value, button });
    }

    row.append(label, seg);
    if (spec.unit) {
      const unit = document.createElement('span');
      unit.className = 'settings-panel__unit';
      unit.textContent = spec.unit;
      unit.setAttribute('aria-hidden', 'true');
      row.appendChild(unit);
    }
    if (spec.hint) appendRowHint(row, spec.key, spec.hint);

    this.segs.set(spec.key, buttons);
    return row;
  }

  private buildCheckRow(spec: CheckRowSpec): HTMLDivElement {
    const row = rowEl(spec.key);

    const inputId = `setting-${spec.key}`;
    const hintId = `${inputId}-hint`;

    const label = document.createElement('label');
    label.className = 'settings-panel__label settings__label';
    label.htmlFor = inputId;
    label.textContent = spec.label;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'settings-panel__checkbox';
    checkbox.id = inputId;
    checkbox.setAttribute('aria-describedby', hintId);
    checkbox.addEventListener('change', () => this.handleCheckChange(spec.key, checkbox));

    row.append(label, checkbox);
    appendRowHint(row, spec.key, spec.hint, hintId);
    this.checks.set(spec.key, checkbox);
    return row;
  }

  // -------------------------------------------------------------- events

  /** 只在值真的变化时上抛（render 已经反映的值再点一次是 no-op）。 */
  private handleSegClick(key: SettingsKey, value: SettingValue): void {
    if (this.model && this.model[key] === value) return;
    this.opts.onChange(key, value);
  }

  /** change 只在用户真正拨动开关时触发，直接上抛原生 checked（ADR-0011 §4）。 */
  private handleCheckChange(key: SettingsKey, checkbox: HTMLInputElement): void {
    this.opts.onChange(key, checkbox.checked);
  }
}
