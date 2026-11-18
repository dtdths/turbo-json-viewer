/**
 * shared/word — 「全字匹配」（whole word）的边界判定（纯函数、零依赖；#53 / ADR-0014 修订）。
 *
 * 口径（用户 2026-11-18 拍板）：
 *   - **词字符 = ASCII `[A-Za-z0-9_]`**；中文 / 其它非 ASCII 字符一律**不是**词字符，
 *     因此中文查询退化为包含匹配（**不要用 `\b`**——JS 的 `\b` 只认 ASCII，中文查询会永远零命中）；
 *   - 边界**只在查询首/尾字符是词字符时强制那一侧**：`hotel` 两侧都查，`hotel!` 只查左侧，
 *     `中文` 两侧都不查（= 普通包含匹配）；
 *   - 与正则模式叠加时，边界看的是**正则源串**的首/尾字符（`^hotel$` 首 `^` 尾 `$` 都不是
 *     词字符 → 不额外加边界，用户已用锚点表达意图）。
 *
 * 本模块只回答「这段命中是否落在整词上」；怎么找到候选命中（`indexOf` 循环 / 正则 `g` 循环）
 * 由调用方决定——`core/search` 与 `shared/highlight` 共用同一份边界规则，避免两处漂移。
 */

/** 词边界需要检查的边（`false` = 该侧不强制）。 */
export interface WordEdges {
  /** 命中左侧必须是非词字符（或串首） */
  start: boolean;
  /** 命中右侧必须是非词字符（或串尾） */
  end: boolean;
}

/** 码点是否词字符（ASCII 字母 / 数字 / 下划线）；范围判断比正则快。 */
export function isWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/** 查询首/尾字符是否词字符（决定哪一侧要强制边界）。 */
export function wordEdges(term: string): WordEdges {
  if (term.length === 0) return { start: false, end: false };
  return {
    start: isWordCode(term.charCodeAt(0)),
    end: isWordCode(term.charCodeAt(term.length - 1)),
  };
}

/** 两侧都不需要检查 → 整词开关对这条查询没有任何效果（退化为包含匹配）。 */
export function isWordBoundaryActive(edges: WordEdges): boolean {
  return edges.start || edges.end;
}

/**
 * 命中 `[start, end)` 是否满足整词边界。
 * 串首 / 串尾天然算边界；只检查 `edges` 里开启的那一侧。
 */
export function isWholeWordMatch(text: string, start: number, end: number, edges: WordEdges): boolean {
  if (edges.start && start > 0 && isWordCode(text.charCodeAt(start - 1))) return false;
  if (edges.end && end < text.length && isWordCode(text.charCodeAt(end))) return false;
  return true;
}
