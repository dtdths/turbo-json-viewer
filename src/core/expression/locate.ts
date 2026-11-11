/**
 * core/expression/locate — 结果行 → 原文档路径（ADR-0018 §4 / §4.3）。
 *
 * 算法（自上而下、取最深的已知容器来源）：
 * 1. 解析 expr 根内规范路径（`shared/path.ts` 的 `parsePath`，必须以 `$` 开头；非法 → null）；
 * 2. 从结果根下探，每进入一个「在 `origins.objects` 里登记过的容器」就记一个候选：
 *    候选路径 = 该容器的原文档路径 + 已走段数之后剩余段数（相对后缀）；
 * 3. 结果根第一段若在 `origins.top` 有来源（标量/对象都算），也记一个候选；
 * 4. 取**最深**候选；没有任何来源 → null（计算值不可跳转）；
 * 5. 路径中途下探失败（键不存在 / 下标越界 / 落在标量上）→ null（不编造不存在的路径）。
 *
 * 为什么用「最深已知容器 + 相对后缀」：文档元素**引用不复制**，但 `map(x => ({...}))` 这类计算
 * 对象没有来源；只有沿结果树找到最深的文档容器，才能把剩余相对路径拼回原文，同时不复制路径表。
 */
import { appendIndex, appendKey, parsePath } from '../../shared/path';
import type { PathSegment } from '../../shared/path';
import type { EvalOrigins } from './types';

const NOT_FOUND: unique symbol = Symbol('locate.not-found');

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** 在容器上走一段；不存在 / 标量 → NOT_FOUND。 */
function step(value: unknown, segment: PathSegment): unknown {
  if (Array.isArray(value)) {
    if (segment.kind !== 'index') return NOT_FOUND;
    if (!Number.isInteger(segment.index) || segment.index < 0 || segment.index >= value.length) return NOT_FOUND;
    return value[segment.index];
  }
  if (isObject(value)) {
    if (segment.kind !== 'key') return NOT_FOUND;
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, segment.key)) return NOT_FOUND;
    return record[segment.key];
  }
  return NOT_FOUND;
}

/** 第一段在 `origins.top` 的来源（数组按 index / 对象按 key）。 */
function topOrigin(origins: EvalOrigins, segment: PathSegment): string | null {
  const top = origins.top;
  if (Array.isArray(top)) {
    if (segment.kind !== 'index') return null;
    const path = top[segment.index];
    return path === undefined ? null : path;
  }
  const key = segment.kind === 'key' ? segment.key : String(segment.index);
  if (!Object.hasOwn(top, key)) return null;
  const path = top[key];
  return path === undefined ? null : path;
}

/** 在已知路径上追加剩余段。 */
function appendSegments(base: string, segments: readonly PathSegment[]): string {
  let out = base;
  for (const segment of segments) {
    out = segment.kind === 'key' ? appendKey(out, segment.key) : appendIndex(out, segment.index);
  }
  return out;
}

/**
 * 把 expr 根内的结果路径还原成原文档路径。
 *
 * @param resultRoot 表达式结果根值
 * @param origins 求值时的来源映射（结果根顶层来源 + 被引用文档容器）
 * @param resultPath expr 根内规范路径（`$` 开头）
 * @returns 原文档规范路径；`null` = 计算值 / 不可定位
 */
export function locateOriginalPath(resultRoot: unknown, origins: EvalOrigins, resultPath: string): string | null {
  let segments: PathSegment[];
  try {
    segments = parsePath(resultPath);
  } catch {
    return null;
  }

  let current: unknown = resultRoot;
  let bestOrigin: string | null = null;
  let bestDepth = -1;

  const consider = (depth: number): void => {
    if (!isObject(current)) return;
    const origin = origins.objects.get(current);
    if (origin !== undefined && depth >= bestDepth) {
      bestOrigin = origin;
      bestDepth = depth;
    }
  };

  // 结果根本身可能就是被引用的文档容器（如 `$`）。
  consider(0);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as PathSegment;
    const next = step(current, segment);
    if (next === NOT_FOUND) return null;
    current = next;

    // 第一段：标量/对象都能靠 origins.top 定位（map 产出的标量元素没有对象身份）。
    if (i === 0) {
      const path = topOrigin(origins, segment);
      if (path !== null && 1 >= bestDepth) {
        bestOrigin = path;
        bestDepth = 1;
      }
    }
    consider(i + 1);
  }

  if (bestOrigin === null) return null;
  return appendSegments(bestOrigin, segments.slice(bestDepth));
}
