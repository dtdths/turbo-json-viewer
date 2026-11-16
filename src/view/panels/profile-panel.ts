/**
 * view/panels/profile-panel — 右栏「文档概要」模块（#43 / ADR-0025 §5 / §7）。
 *
 * 职责边界：**纯格式化函数 + 一段 DOM 更新**；不发请求、不 import core、不读全局时钟。
 * 数据源 = worker 采样回包的 `DocumentProfile`；触发时机 / 失效策略接线在 `app/main.ts`。
 *
 * i18n（ADR-0026 §3）：所有文案在渲染时按当前 locale 取词条（没有模块级文案常量）；
 * 语言切换后由 app 用同一份 `ProfilePanelState` 再调一次 `renderProfilePanel` 即可
 * （本模块是无状态渲染函数：文案在 render 时取词条，切语言后重画即新语言）。
 *
 * DOM 契约：`#profilePanel`（page.html 提供）内部由本模块 `replaceChildren` 重建；
 * class 供冒烟断言，不要改名。全部文本走 textContent / createElement，**禁 innerHTML**。
 */
import { currentLocale, formatNumber, t } from '../../i18n/index';
import type { DocumentProfile } from '../../protocol/types';

/** 面板非数据态（ADR-0025 §7 四类空态；noFields = 已就绪但无成员可列）。 */
export type ProfileEmptyState = 'idle' | 'loading' | 'stale' | 'noFields';

/** 面板渲染态；ready 之外都只渲染一行空态文案。 */
export type ProfilePanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'stale' }
  | { status: 'ready'; profile: DocumentProfile };

/** 空态词条 key（渲染时取当前 locale）。 */
const EMPTY_KEYS = {
  idle: 'view.profile.empty.idle',
  loading: 'view.profile.empty.loading',
  stale: 'view.profile.empty.stale',
  noFields: 'view.profile.empty.noFields',
} as const;

/**
 * 紧凑计数：zh 用「万」习惯（<1 万原样；1 万起一位小数；≥100 万取整，2960000 → `296 万`）；
 * 其他 locale 用完整千分位数字（`2,960,000`），避免把中文计数单位带进英文界面。
 */
function compactCount(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  if (currentLocale() !== 'zh-CN') return formatNumber(n);
  if (n < 10_000) return String(n);
  const wan = n / 10_000;
  const unit = t('view.profile.wanUnit');
  return wan < 99.95 ? `${wan.toFixed(1)} ${unit}` : `${Math.round(wan)} ${unit}`;
}

/** 节点数文案：中文紧凑计数自带「万」时不再插空格（`296 万个节点` vs `9999 个节点`）。 */
function nodesText(count: number): string {
  const text = compactCount(count);
  const compact = currentLocale() === 'zh-CN' && count >= 10_000;
  return t(compact ? 'view.profile.nodesCompact' : 'view.profile.nodes', { nodes: text });
}

/** 元信息行：`296 万个节点 · 深度 5 · 已采样 2.0 万个节点`（sampled / truncated 各自独立追加）。 */
export function profileMetaText(profile: DocumentProfile): string {
  const parts = [nodesText(profile.nodeCount), t('view.profile.depth', { depth: profile.maxDepth })];
  if (profile.sampled) parts.push(t('view.profile.sampled', { nodes: nodesText(profile.sampledNodes) }));
  if (profile.truncated) parts.push(t('view.profile.truncated'));
  return parts.join(t('view.listSeparator'));
}

/** 字段行：名称 / 类型 / 频率（freq>1 才给 `×N`；mixed → 「混合」）。 */
export interface ProfileFieldRow {
  name: string;
  kindText: string;
  freqText: string;
}

/** 根样本（`segments = []`）的成员行；根为数组时语义 = 元素字段（见 profileFieldsTitle）。 */
export function profileFieldRows(profile: DocumentProfile): ProfileFieldRow[] {
  const root = profile.paths.find((path) => path.segments.length === 0);
  return (root?.members ?? []).map((member) => ({
    name: member.name,
    kindText: member.kind === 'mixed' ? t('view.profile.kind.mixed') : member.kind,
    freqText: member.freq > 1 ? t('view.profile.freq', { freq: member.freq }) : '',
  }));
}

/** 字段列表标题：根为数组 → 「元素字段」，其余 → 「根字段」。 */
export function profileFieldsTitle(profile: DocumentProfile): string {
  return profile.rootKind === 'array'
    ? t('view.profile.title.elements')
    : t('view.profile.title.fields');
}

/** 空态文案（ADR-0025 §7 口径）。 */
export function profileEmptyText(state: ProfileEmptyState): string {
  return t(EMPTY_KEYS[state]);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 重画 `#profilePanel` 模块体：空态一行，或「元信息 + 字段标题 + 字段行」。 */
export function renderProfilePanel(container: HTMLElement, state: ProfilePanelState): void {
  if (state.status !== 'ready') {
    container.replaceChildren(el('div', 'placeholder', profileEmptyText(state.status)));
    return;
  }
  const { profile } = state;
  const rows = profileFieldRows(profile);
  container.replaceChildren(el('div', 'profile__meta', profileMetaText(profile)));
  if (rows.length === 0) {
    container.append(el('div', 'placeholder', profileEmptyText('noFields')));
    return;
  }
  container.append(el('div', 'profile__title', profileFieldsTitle(profile)));
  const list = el('div', 'profile__rows');
  for (const row of rows) {
    const line = el('div', 'profile__row');
    line.append(el('span', 'profile__name', row.name), el('span', 'profile__kind', row.kindText));
    if (row.freqText !== '') line.append(el('span', 'profile__freq', row.freqText));
    list.append(line);
  }
  container.append(list);
}

