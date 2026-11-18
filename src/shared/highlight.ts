/**
 * shared/highlight — 搜索命中的区间计算（**纯函数、零依赖、无 DOM**）。
 *
 * DOM 写入在 `view/highlight.ts`（`writeMarkedText`），本文件只算区间——保持 shared 层
 * 平台中立（worker 若将来要算区间也不会拖进 document）。
 *
 * 下标纪律（为什么不能 toLowerCase() 后拿 indexOf）：
 *   `İ`（U+0130）的 `toLowerCase()` 是 `i` + U+0307 两个码元，折叠串长度会漂移；
 *   拿折叠串里的下标去切原串会整体错位（`İstanbul xyz` 的 `xyz` 折叠后在下标 10、
 *   原串在下标 9）。所以：
 *     1. ASCII 快路径：text 与 term 都是 ASCII 时折叠不改码元数，indexOf 下标即原串下标；
 *     2. 含非 ASCII：用带 `giu` 的正则直接扫原串，`m.index` 就是原串坐标，绕开长度漂移。
 *   非重叠：快路径按命中长度前进，正则 global 扫描天然不重叠。
 */

import { isWholeWordMatch, isWordBoundaryActive, wordEdges } from './word';

/** 一段命中区间：`[start, end)`，下标基于原字符串（slice 语义）。 */
export interface HitRange {
  /** 命中起点（含） */
  readonly start: number;
  /** 命中终点（不含） */
  readonly end: number;
}

/** 非 ASCII 探测：快路径要求 text 与 term 都纯 ASCII，`toLowerCase()` 才不改码元数。 */
const NON_ASCII = /[^\x00-\x7F]/;

/** 正则元字符；转义只产出 SyntaxCharacter 的合法性转义，`u` 模式下同样成立。 */
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(term: string): string {
  return term.replace(REGEX_META, '\\$&');
}

/** `hitRanges` 选项（#53 / ADR-0014 修订）。 */
export interface HitRangeOptions {
  /**
   * 全字匹配：只标整词命中（词 = ASCII `[A-Za-z0-9_]`；边界只在 term 首/尾是词字符时强制，
   * 中文查询因此退化为包含匹配）。规则与 `core/search` 共用 `shared/word`。
   */
  wholeWord?: boolean;
}

/**
 * 计算 term 在 text 里的全部命中区间：大小写不敏感、非重叠、下标基于原字符串。
 * 空 term / 空 text / 未命中 → `[]`。`opts.wholeWord` 时只保留整词命中
 * （被边界拒绝的候选从它的下一个码元继续找，否则会漏掉「aab 里的 ab」这类重叠候选）。
 */
export function hitRanges(text: string, term: string, opts: HitRangeOptions = {}): HitRange[] {
  if (text.length === 0 || term.length === 0) return [];

  const edges = wordEdges(term);
  const wholeWord = opts.wholeWord === true && isWordBoundaryActive(edges);
  const ranges: HitRange[] = [];

  /** 收一条候选：整词不通过时返回 false（调用方决定怎么继续找） */
  const accept = (start: number, end: number): boolean => {
    if (wholeWord && !isWholeWordMatch(text, start, end, edges)) return false;
    ranges.push({ start, end });
    return true;
  };

  // 快路径：双方纯 ASCII，`toLowerCase()` 一一对应，indexOf 的下标可直接切原串。
  if (!NON_ASCII.test(text) && !NON_ASCII.test(term)) {
    const haystack = text.toLowerCase();
    const needle = term.toLowerCase();
    let cursor = 0;
    for (;;) {
      const hit = haystack.indexOf(needle, cursor);
      if (hit < 0) break;
      // 非重叠：命中后跳过整段；整词不通过时只前进一个码元（重叠候选可能成立）
      cursor = accept(hit, hit + needle.length) ? hit + needle.length : hit + 1;
    }
    return ranges;
  }

  // 含非 ASCII：正则扫原串，`m.index` 即原串坐标（İ/ẞ 之类的折叠长度漂移与此无关）。
  const pattern = new RegExp(escapeRegExp(term), 'giu');
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined) continue;
    accept(start, start + match[0].length);
  }
  return ranges;
}
