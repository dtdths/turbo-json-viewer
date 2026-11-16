/**
 * i18n/types — 词条与语言的公共类型（无 DOM、无运行时状态）。
 *
 * 约定：
 *   - 词条值 = 单数串，或复数两形 `{one, other}`（`Intl.PluralRules` 选形；zh 只用 other）。
 *   - 占位符统一 `{name}`；只有 `{n}` 会被按 locale 格式化（`formatNumber`），其余参数原样字符串化。
 *   - `en-US` 是**真相源**与回退语言；**每种语言都按需懒加载**（含 en），且必须覆盖全部 key。
 */
export type Message = string | { one: string; other: string };

/** 一个语言包 = 扁平 key → 词条。 */
export type MessageTable = Record<string, Message>;

/** 词条插值参数（`n` 参与复数与千分位格式）。 */
export type Params = Record<string, string | number>;

/**
 * 语言标签的单一来源在 `protocol/versions`（零依赖层）：i18n / settings 都从那里派生，
 * 避免 `viewmodel` 为了白名单 value-import i18n。这里 re-export 方便 i18n 内部与测试引用。
 */
export { LANGUAGE_TAGS, isLanguageTag } from '../protocol/versions';
export type { LanguageTag } from '../protocol/versions';
import type { LanguageTag } from '../protocol/versions';

/** 设置里的语言偏好：`auto` = 跟随系统。 */
export type LocalePref = 'auto' | LanguageTag;

/** 语言注册表条目（设置面板选项 + 懒加载入口）。 */
export interface Language {
  tag: LanguageTag;
  /** 语言自称（设置面板直接显示，不翻译） */
  nativeName: string;
  /** 语言包 loader（动态 import 的分块；每种语言都有——没有内联语言包） */
  load: () => Promise<MessageTable>;
}
