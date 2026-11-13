/**
 * view/panels/profile-panel — 右栏「文档概要」模块（#43 / ADR-0025 §5 / §7）。
 *
 * 职责边界：**纯格式化函数 + 一段 DOM 更新**；不发请求、不 import core、不读全局时钟。
 * 数据源 = worker 采样回包的 `DocumentProfile`；触发时机 / 失效策略接线在 `app/main.ts`。
 *
 * DOM 契约：`#profilePanel`（page.html 提供）内部由本模块 `replaceChildren` 重建；
 * class 供冒烟断言，不要改名。全部文本走 textContent / createElement，**禁 innerHTML**。
 */
import type { DocumentProfile } from '../../protocol/types';

/** 面板非数据态（ADR-0025 §7 四类空态；noFields = 已就绪但无成员可列）。 */
export type ProfileEmptyState = 'idle' | 'loading' | 'stale' | 'noFields';

/** 面板渲染态；ready 之外都只渲染一行空态文案。 */
export type ProfilePanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'stale' }
  | { status: 'ready'; profile: DocumentProfile };

const EMPTY_TEXT: Record<ProfileEmptyState, string> = {
  idle: '未打开文档',
  loading: '采样中…',
  stale: '文档已修改，概要待更新',
  noFields: '无可统计的字段',
};

/** 中文习惯的紧凑计数：<1 万原样；1 万起一位小数；≥100 万取整（2960000 → `296 万`）。 */
function compactCount(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  if (n < 10_000) return String(n);
  const wan = n / 10_000;
  return wan < 99.95 ? `${wan.toFixed(1)} 万` : `${Math.round(wan)} 万`;
}

/** 节点数文案：小文档 `2 个节点`，大文档 `296 万个节点`（紧凑计数自带「万」时不再插空格）。 */
function nodesText(count: number): string {
  const text = compactCount(count);
  return count < 10_000 ? `${text} 个节点` : `${text}个节点`;
}

/** 元信息行：`296 万个节点 · 深度 5 · 已采样 2.0 万个节点`（sampled / truncated 各自独立追加）。 */
export function profileMetaText(profile: DocumentProfile): string {
  const parts = [nodesText(profile.nodeCount), `深度 ${profile.maxDepth}`];
  if (profile.sampled) parts.push(`已采样 ${compactCount(profile.sampledNodes)} 个节点`);
  if (profile.truncated) parts.push('已截断');
  return parts.join(' · ');
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
    kindText: member.kind === 'mixed' ? '混合' : member.kind,
    freqText: member.freq > 1 ? `×${member.freq}` : '',
  }));
}

/** 字段列表标题：根为数组 → 「元素字段」，其余 → 「根字段」。 */
export function profileFieldsTitle(profile: DocumentProfile): string {
  return profile.rootKind === 'array' ? '元素字段' : '根字段';
}

/** 空态文案（ADR-0025 §7 口径）。 */
export function profileEmptyText(state: ProfileEmptyState): string {
  return EMPTY_TEXT[state];
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
    container.replaceChildren(el('div', 'placeholder', EMPTY_TEXT[state.status]));
    return;
  }
  const { profile } = state;
  const rows = profileFieldRows(profile);
  container.replaceChildren(el('div', 'profile__meta', profileMetaText(profile)));
  if (rows.length === 0) {
    container.append(el('div', 'placeholder', EMPTY_TEXT.noFields));
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
