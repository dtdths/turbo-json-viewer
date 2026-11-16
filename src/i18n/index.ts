/**
 * i18n/index — 运行时词条表与 locale 状态（唯一可变状态；无 DOM）。
 *
 * 生命周期：
 *   - 启动：`await initI18n(settings.get('locale'))` —— 解析 locale → 按需 await 语言包 → 换表。
 *   - 切换：`await setLocalePref(pref)` —— 同上 + 通知订阅者（app 做全量重渲染）。
 *   - 并发：`initI18n` / `setLocalePref` 用单调 `loadSeq` 丢弃过期的语言包加载结果，
 *     快速连点时不会出现「文案是新语言、activeTag 是旧语言」的错位。
 * 红线：worker 不 import 本模块（诊断文案在 worker 侧只产生结构化数据，见 ADR-0026 §4）。
 */
import type { LanguageTag, LocalePref, Message, MessageTable, Params } from './types';
import { EMPTY_TABLE, LANGUAGES, findLanguage } from './languages';
import type { MessageKey } from './messages/en/pack';
import { parseLangOverride, resolveLocale } from './locale';

export type { MessageKey } from './messages/en/pack';

/** 当前生效的 locale 与词条表（模块级单例；同一时刻只有一个界面语言）。 */
let activeTag: LanguageTag = 'en-US';
let activePref: LocalePref = 'auto';
let activeTable: MessageTable = EMPTY_TABLE;

const listeners = new Set<(tag: LanguageTag) => void>();
/** 已加载的语言包缓存（含 en；切换不重复请求）。 */
let loadSeq = 0;
const packs = new Map<LanguageTag, MessageTable>();
const pluralRules = new Map<LanguageTag, Intl.PluralRules>();
const numberFormats = new Map<LanguageTag, Intl.NumberFormat>();

function readNavigatorLanguage(): string | undefined {
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language;
}

function readLangOverride(): LanguageTag | null {
  const loc = (globalThis as { location?: { search?: string } }).location;
  return parseLangOverride(loc?.search);
}

/** 当前生效的语言标签。 */
export function currentLocale(): LanguageTag {
  return activeTag;
}

/** 当前语言偏好（`auto` = 跟随系统；用于设置面板回显 / dev hook）。 */
export function currentLocalePref(): LocalePref {
  return activePref;
}

/** 语言包是否已加载（dev hook / 冒烟断言用）。 */
export function isPackLoaded(tag: LanguageTag): boolean {
  return packs.has(tag);
}

/** 当前生效词条表的 key 数（dev hook / 冒烟断言用）。 */
export function messageCount(): number {
  return Object.keys(activeTable).length;
}

/** 订阅 locale 变化（返回取消订阅函数）。 */
export function subscribeLocale(fn: (tag: LanguageTag) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function rulesFor(tag: LanguageTag): Intl.PluralRules {
  let rules = pluralRules.get(tag);
  if (!rules) {
    rules = new Intl.PluralRules(tag);
    pluralRules.set(tag, rules);
  }
  return rules;
}

/** 按当前 locale 格式化数字（千分位等；替代散落的 `toLocaleString()`）。 */
export function formatNumber(value: number): string {
  let fmt = numberFormats.get(activeTag);
  if (!fmt) {
    fmt = new Intl.NumberFormat(activeTag);
    numberFormats.set(activeTag, fmt);
  }
  return fmt.format(value);
}

/** 数字参数在词条里的统一形态（`{n}` 专用）；非数字原样字符串化。 */
function paramText(name: string, value: string | number): string {
  if (name === 'n' && typeof value === 'number') return formatNumber(value);
  return String(value);
}

function interpolate(template: string, params: Params | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? paramText(name, params[name]) : whole,
  );
}

function selectForm(message: Message, locale: LanguageTag, params: Params | undefined): string {
  if (typeof message === 'string') return message;
  const n = typeof params?.n === 'number' ? params.n : Number(params?.n ?? 0);
  const category = Number.isFinite(n) ? rulesFor(locale).select(n) : 'other';
  return category === 'one' ? message.one : message.other;
}

/**
 * 取词条并插值。
 *
 * - 词条只从**当前语言包**取：随包发布的语言包必须完整（单测守护），缺 key 视为漏配 →
 *   返回 key 本身（冒烟/测试据此暴露问题）。
 * - `{n}` 会被按 locale 格式化（千分位 + 复数选形）；其余参数原样字符串化。
 */
export function t(key: MessageKey, params?: Params): string {
  const raw = activeTable[key];
  if (raw === undefined) return key;
  return interpolate(selectForm(raw, activeTag, params), params);
}

/** 有没有这个 key（语言包完整性守护 / DOM 标记校验用）。 */
export function hasMessage(key: string): key is MessageKey {
  return key in activeTable;
}

async function loadPack(tag: LanguageTag): Promise<MessageTable> {
  const cached = packs.get(tag);
  if (cached) return cached;
  const language = findLanguage(tag);
  if (!language) {
    packs.set(tag, EMPTY_TABLE);
    return EMPTY_TABLE;
  }
  try {
    // 语言包必须完整（单测守护 key 集/占位符）；不做「部分包 + en 兜底」运行时合并
    const table = await language.load();
    packs.set(tag, table);
    return table;
  } catch (error) {
    // 加载失败不阻塞启动：先回退 en 包，再退空表（= 显示 key 本身），并记一次 warn
    console.warn(`[i18n] failed to load locale pack "${tag}", falling back to en-US`, error);
    if (tag !== 'en-US') {
      try {
        const fallback = await loadPack('en-US');
        packs.set(tag, fallback);
        return fallback;
      } catch {
        // 落到空表
      }
    }
    packs.set(tag, EMPTY_TABLE);
    return EMPTY_TABLE;
  }
}

/**
 * 启动时解析并加载语言（首帧前 await；避免先英文再闪成中文）。
 * `pref` = 设置值（`auto` 表示跟随系统）；`?lang=` 覆盖优先级最高（测试/调试）。
 */
export async function initI18n(pref: LocalePref): Promise<LanguageTag> {
  const tag = resolveLocale(pref, readNavigatorLanguage(), readLangOverride());
  const seq = ++loadSeq;
  const table = await loadPack(tag);
  // 过期加载（更晚的 init/set 已发起）→ 不覆盖当前状态
  if (seq !== loadSeq) return activeTag;
  activeTag = tag;
  activePref = pref;
  activeTable = table;
  return tag;
}

/** 运行时切换语言（设置面板）；通知订阅者做全量重渲染。 */
export async function setLocalePref(pref: LocalePref): Promise<LanguageTag> {
  const tag = resolveLocale(pref, readNavigatorLanguage(), readLangOverride());
  const seq = ++loadSeq;
  const table = await loadPack(tag);
  // 快速连点（zh→en→zh）时只让最后一次落地，避免词条表与 activeTag 错位
  if (seq !== loadSeq) return activeTag;
  activeTag = tag;
  activePref = pref;
  activeTable = table;
  for (const fn of listeners) fn(tag);
  return tag;
}

/**
 * 设置面板的语言选项：`auto`（nativeName=null，由面板用 `view.settings.language.auto` 词条显示）
 * + 每种装载的语言（自称不翻译）。
 */
export function languageChoices(): readonly { value: LocalePref; nativeName: string | null }[] {
  return [
    { value: 'auto', nativeName: null },
    ...LANGUAGES.map((language) => ({
      value: language.tag as LocalePref,
      nativeName: language.nativeName,
    })),
  ];
}
