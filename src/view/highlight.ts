/**
 * view/highlight — 搜索命中的 `<mark>` 写入（view 层唯一一份；树行与搜索结果共用）。
 *
 * 分工：区间计算是纯函数 `shared/highlight.hitRanges`（零依赖、node 可测）；
 * 本文件只负责把区间落到 DOM——全部走 textContent / createElement / replaceChildren，
 * **禁 innerHTML**（ADR-0005）。mark 的 class 由调用方给（树行 `row__hit`、
 * 搜索结果 `result__hit`，smoke 按 class 断言）。
 */
import { hitRanges } from '../shared/highlight';

/**
 * 把 text 写进 el：命中片段包成 `<mark class="markClass">`，其余原样拼回。
 * 无命中（或 term 为空）时退回纯 `textContent`。
 */
export function writeMarkedText(
  el: HTMLElement,
  text: string,
  term: string | undefined,
  markClass: string,
): void {
  const ranges = term ? hitRanges(text, term) : [];
  if (ranges.length === 0) {
    el.textContent = text;
    return;
  }

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
    }
    const mark = document.createElement('mark');
    mark.className = markClass;
    mark.textContent = text.slice(range.start, range.end);
    fragment.appendChild(mark);
    cursor = range.end;
  }
  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
  el.replaceChildren(fragment);
}
