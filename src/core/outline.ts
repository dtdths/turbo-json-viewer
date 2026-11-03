/**
 * core/outline — 大纲页枚举（ADR-0013 §3）。
 *
 * 方案的 seam（ADR-0013 背景方案 B）：core 只加一条**只读**查询——按容器**按需**返回一页子项；
 * 大纲的展开集合 / 扁平化 / 虚拟窗口留在主线程 viewmodel。因此：
 *   - 不建第二棵行模型，不持「全文档形状」；
 *   - 不缓存：每页重新枚举该容器（数组按页取、对象 `Object.keys` 后按页取），
 *     实测 200 项/页在 10MB 样本上 <1ms，跨页重复扫描可接受；
 *   - 不依赖树展开态：折叠容器同样可查（与行窗口的「可见行坐标」语义不同）。
 *
 * 只读：不改值图、不推 docRevision / rowVersion；纯函数，`DocService.outline` 只做
 * 「取根 → valueAt → 调这里 → 补 rootId」。
 */
import type { OutlineChild, OutlineReply, Path } from '../protocol/types';
import { OUTLINE_PAGE_MAX } from '../protocol/versions';
import { clampInt } from '../shared/num';
import { appendIndex, appendKey } from '../shared/path';
import { childCountOf, isContainer, jsonKind } from './row-model';

/** 回包去掉 `rootId`（由 DocService 补）：纯函数不认识文档根。 */
export type OutlinePage = Omit<OutlineReply, 'rootId'>;

/**
 * 枚举 `node` 处容器的一页子项。
 *
 * - `total` = 容器子项数（数组 `length` / `Object.keys().length`）；标量 0。
 * - `start` 夹到 `[0, total]`；`count` 夹到 `[0, OUTLINE_PAGE_MAX]` 且不超过 `total - start`；
 *   回包 `start` 是实际起点，`children.length` 可少于 `count`（末页）。
 * - 标量节点是合法输入：`{ kind, total: 0, start: 0, children: [] }`（语义明确、便于测试）。
 * - 子项 `path` 与 `shared/path` 同源（`appendKey` / `appendIndex`），可直接回填 UI 跳转。
 */
export function outlinePage(node: unknown, path: Path, start: number, count: number): OutlinePage {
  const kind = jsonKind(node);
  if (!isContainer(node)) return { path, kind, total: 0, start: 0, children: [] };

  const total = childCountOf(node);
  const from = clampInt(start, 0, total);
  // 两个上限同时生效：单请求上限（OUTLINE_PAGE_MAX）与剩余项数（末页自然变短）
  const size = clampInt(count, 0, Math.min(OUTLINE_PAGE_MAX, total - from));
  const end = from + size;
  const children: OutlineChild[] = [];

  if (Array.isArray(node)) {
    for (let i = from; i < end; i++) {
      const child = node[i];
      children.push({
        key: '[' + i + ']',
        idx: true,
        kind: jsonKind(child),
        count: isContainer(child) ? childCountOf(child) : 0,
        path: appendIndex(path, i),
      });
    }
  } else {
    // 键序 = 值图顺序（Object.keys 真相），不做显示排序（ADR-0013 §2；#19/#23 另议）
    const keys = Object.keys(node);
    for (let i = from; i < end; i++) {
      const key = keys[i] as string;
      const child = node[key];
      children.push({
        key,
        idx: false,
        kind: jsonKind(child),
        count: isContainer(child) ? childCountOf(child) : 0,
        path: appendKey(path, key),
      });
    }
  }

  return { path, kind, total, start: from, children };
}
