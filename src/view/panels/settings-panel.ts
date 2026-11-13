/**
 * view/panels/settings-panel — 设置面板的 DOM 层（ADR-0011 §1 / §4）。
 *
 * 边界：
 *   - 自建 13 行 DOM（segmented / checkbox）；page.html 只留 `.panel.panel--settings` 挂载点。
 *   - 控件状态只从 `Settings` 快照同步；用户改动经 `opts.onChange` 上抛，由 app 调
 *     `SettingsState.set()`，再经订阅回到 `render()`。本模块不读写存储、不碰主题/CSS 变量。
 *
 * 硬约束：
 *   - 文本全部走 textContent / createElement，**禁 innerHTML**。
 *   - `render()` 只同步 active / checked，**绝不触发 onChange**；必须幂等、可反复调用。
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
import { EXPORT_MODE_LABELS } from '../../viewmodel/export-state';

export interface SettingsPanelOptions {
  /** 用户改了一项（只在用户交互时触发；render 不触发） */
  onChange(key: SettingsKey, value: Settings[SettingsKey]): void;
}

/** 13 项设置的任一值（= 各字段类型的联合） */
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
  /** 行下说明（可选；仅新的排序行使用，提示作用范围） */
  hint?: string;
}

interface CheckRowSpec {
  key: SettingsKey;
  label: string;
  hint: string;
}

/* ---------------- 13 行的固定顺序与文案（ADR-0011 §1 及其 2026-11-03 / 2026-11-10 修订 + ADR-0012 修订 + ADR-0022 + ADR-0024 §3） ---------------- */

const THEME_ITEMS: readonly SegItem[] = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '亮色' },
];

const ROW_HEIGHT_ITEMS: readonly SegItem[] = ROW_HEIGHT_OPTIONS.map((value) => ({
  value,
  label: String(value),
  ariaLabel: `${value}px`,
}));

const INDENT_ITEMS: readonly SegItem[] = INDENT_OPTIONS.map((value) => ({
  value,
  label: String(value),
  ariaLabel: `${value}px`,
}));

/** 子键显示排序（#40 / ADR-0024 §3）：原始顺序为默认；取值集合 = `SORT_ORDER_OPTIONS`
 *  （单一来源在 protocol/versions），文案按值显式映射、不依赖数组下标。 */
const SORT_ORDER_LABELS: Record<SortOrder, string> = {
  raw: '原始',
  'key-asc': '升序',
  'key-desc': '降序',
};
const SORT_ORDER_ITEMS: readonly SegItem[] = SORT_ORDER_OPTIONS.map((value) => ({
  value,
  label: SORT_ORDER_LABELS[value],
}));

const COPY_FORMAT_ITEMS: readonly SegItem[] = [
  { value: 'subtree', label: '子树 JSON' },
  { value: 'path', label: '路径' },
  { value: 'value', label: '原始值' },
  { value: 'key', label: '键名' },
];

/** JSON 缩进的展示顺序：2 → 4 → 紧凑（0）；值集合仍来自 `JSON_INDENT_OPTIONS`（ADR-0022 §2）。 */
const JSON_INDENT_RANK: Readonly<Record<number, number>> = { 2: 0, 4: 1, 0: 2 };

const JSON_INDENT_ITEMS: readonly SegItem[] = [...JSON_INDENT_OPTIONS]
  .sort((a, b) => JSON_INDENT_RANK[a] - JSON_INDENT_RANK[b])
  .map((value) => ({ value, label: value === 0 ? '紧凑' : `${value} 空格` }));

/** 导出方式（ADR-0012 修订）：与分体按钮菜单共享同一 SettingsState */
const EXPORT_MODE_ITEMS: readonly SegItem[] = [
  { value: 'file', label: EXPORT_MODE_LABELS.file },
  { value: 'clipboard', label: EXPORT_MODE_LABELS.clipboard },
];

/** 表达式高级预算（#12 / ADR-0018 §7）：预设档位、不可自定义数值，标准为默认。
 *  取值集合与 `EXPR_BUDGET_OPTIONS` 同源（normalizeSettings 会校验非法值回落默认）。 */
const EXPR_BUDGET_ITEMS: readonly SegItem[] = [
  { value: EXPR_BUDGET_OPTIONS[0], label: '宽松' },
  { value: EXPR_BUDGET_OPTIONS[1], label: '标准' },
  { value: EXPR_BUDGET_OPTIONS[2], label: '严格' },
];

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
    this.host.setAttribute('aria-label', '设置');
    this.host.tabIndex = -1;
    this.host.replaceChildren();

    this.host.append(
      this.buildSegRow({ key: 'theme', label: '主题', items: THEME_ITEMS }),
      this.buildSegRow({ key: 'rowHeight', label: '行高', items: ROW_HEIGHT_ITEMS, unit: 'px' }),
      this.buildSegRow({ key: 'indent', label: '缩进', items: INDENT_ITEMS, unit: 'px' }),
      // 第 13 行（#40 / ADR-0024 §3）：子键显示排序；只影响树/大纲/表达式结果树的显示顺序
      this.buildSegRow({
        key: 'sortOrder',
        label: '子键排序',
        items: SORT_ORDER_ITEMS,
        hint: '仅影响树、大纲与表达式结果树的显示顺序；复制、导出与路径不变',
      }),
      this.buildCheckRow({ key: 'typeColumn', label: '显示类型列', hint: '键右侧显示 JSON 类型' }),
      this.buildSegRow({
        key: 'defaultCopyFormat',
        label: '默认复制格式',
        items: COPY_FORMAT_ITEMS,
      }),
      this.buildSegRow({ key: 'jsonIndent', label: 'JSON 缩进', items: JSON_INDENT_ITEMS }),
      this.buildSegRow({
        key: 'searchCopyFormat',
        label: '搜索结果双击复制',
        items: COPY_FORMAT_ITEMS,
      }),
      this.buildSegRow({ key: 'exportMode', label: '导出方式', items: EXPORT_MODE_ITEMS }),
      this.buildCheckRow({
        key: 'repairTruncated',
        label: '导入时自动修复截断 JSON',
        hint: '关闭后截断文本直接报错',
      }),
      this.buildCheckRow({
        key: 'adaptiveExpand',
        label: '小文档自动全部展开',
        hint: '≤500 行，关闭后保持默认折叠',
      }),
      this.buildSegRow({
        key: 'advBudget',
        label: '高级预算',
        items: EXPR_BUDGET_ITEMS,
      }),
      // 第 12 行（ADR-0022 §2）：导出转义非 ASCII；默认关，输出仍是合法 JSON
      this.buildCheckRow({
        key: 'escapeUnicode',
        label: '导出转义非 ASCII',
        hint: '非 ASCII 输出为 \\uXXXX，仍是合法 JSON',
      }),
    );
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

  private buildSegRow(spec: SegRowSpec): HTMLDivElement {
    const row = rowEl(spec.key);

    const label = document.createElement('span');
    label.className = 'settings-panel__label';
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
    label.className = 'settings-panel__label';
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
