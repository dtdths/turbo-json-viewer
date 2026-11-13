/**
 * core/profile — 文档概要采样（Document Profile；#43 / ADR-0025）。
 *
 * 单一纯函数 `buildDocumentProfile(value)`，**两遍**同步显式栈遍历（禁用递归：
 * ADR-0020 有 100 万层深嵌套样本，递归会爆栈）：
 *
 * - 第 1 遍（无界）：全图计数 + 最大深度。`nodeCount` 口径 = `countDocumentNodes`
 *   （`{a:1}`=2、`[1,2,3]`=4），`maxDepth` 根 = 1（`{a:1}` → 2）。
 * - 第 2 遍（有界）：字段 / 路径样本收集。`nodeCount ≤ 50,000` → 覆盖全部节点、数组不截断；
 *   `> 50,000` → 只覆盖先序前 50,000 个节点，且每个数组只取前 32 个元素（第 1 遍仍遍历全图）。
 *
 * 硬上限（ADR-0025 §4）：路径 ≤ 2,000、字段条目 ≤ 20,000（按去重 `(路径, 字段名)` 条目计，
 * `freq` 累加不消耗条目）；超限停止收集**新**条目并置 `truncated = true`。
 * `sampled = sampledNodes < nodeCount`（只表示"有节点没参与字段收集"），
 * `truncated` 只表示上限被撞到——两者语义不同。
 *
 * 路径模板：从根的**键路径**，数组下标不参与（`$.items[3].room.price` → `['items','room','price']`），
 * 根 = `[]`。数组容器的 `members` = 元素对象字段并集、`samples` = 取样元素数；
 * 同名字段多类型 → `'mixed'`；`members` 按 `freq` 降序、同频按首次出现序（结果对同一文档完全确定）。
 *
 * 实现注意：路径用**帧链**（parent 指针）表示，只在新建路径样本时物化 `segments`
 * （路径数受 2,000 上限约束，深链不会产生 O(depth²) 物化）；数组元素复用数组的帧
 * （下标不进路径）。第 2 遍的节点预算只影响收集，不影响第 1 遍的精确计数。
 */
import type { DocumentProfile, FieldStat, JsonKind, PathSample } from '../protocol/types';
import { jsonKind } from './row-model';

/** 第 2 遍字段收集的节点预算（ADR-0025 §4）。 */
export const PROFILE_NODE_BUDGET = 50_000;
/** 大文档（> 50k 节点）每个数组参与收集的元素数（ADR-0025 §4）。 */
export const PROFILE_ARRAY_SAMPLE_N = 32;
/** 路径样本条目上限（ADR-0025 §4）。 */
export const PROFILE_MAX_PATHS = 2_000;
/** 字段条目上限：按去重后的 `(路径, 字段名)` 条目计（ADR-0025 §4）。 */
export const PROFILE_MAX_FIELDS = 20_000;

/** 纯 JSON 对象（与 `countDocumentNodes` 的判定一致；数组单独处理）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContainerValue(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

interface DepthCount {
  nodeCount: number;
  maxDepth: number;
}

/** 第 1 遍：精确节点数 + 最大深度（全图，无界；显式栈）。 */
function countNodesAndDepth(root: unknown): DepthCount {
  if (root === undefined) return { nodeCount: 0, maxDepth: 0 };
  let nodeCount = 0;
  let maxDepth = 0;
  const values: unknown[] = [root];
  const depths: number[] = [1];
  while (values.length > 0) {
    const value = values.pop();
    const depth = depths.pop() as number;
    nodeCount += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        values.push(value[i]);
        depths.push(depth + 1);
      }
    } else if (isPlainObject(value)) {
      const keys = Object.keys(value);
      for (let i = keys.length - 1; i >= 0; i--) {
        values.push(value[keys[i] as string]);
        depths.push(depth + 1);
      }
    }
  }
  return { nodeCount, maxDepth };
}

/** 一条路径样本的收集状态：协议形状 + 成员去重索引（freq 累加不消耗条目）。 */
interface PathRecord {
  sample: PathSample;
  byName: Map<string, FieldStat>;
}

/** 路径帧：指向父帧 + 本层键名；数组元素复用数组帧（下标不进路径）。 */
interface Frame {
  /** 帧序号（仅用于「父帧 + 键名」的路径 interning key，不跨调用） */
  id: number;
  parent: Frame | null;
  name: string;
  record: PathRecord;
}

/** 栈槽：容器子节点在**访问时**才建帧（保证路径首次出现序 = DFS 先序）；主条目直接给帧。 */
const LOOKUP = Symbol('profile-frame-lookup');
type FrameSlot = Frame | null | typeof LOOKUP;

interface CollectResult {
  sampledNodes: number;
  truncated: boolean;
  paths: PathSample[];
}

/** 第 2 遍：有界字段 / 路径样本收集（显式栈；数组取样与上限见模块头）。 */
function collectSamples(root: unknown, largeDocument: boolean): CollectResult {
  const paths: PathSample[] = [];
  const frameIndex = new Map<string, Frame>();
  const rootRecord: PathRecord = {
    sample: { segments: [], kind: Array.isArray(root) ? 'array' : 'object', samples: 0, members: [] },
    byName: new Map(),
  };
  paths.push(rootRecord.sample);
  const rootFrame: Frame = { id: 0, parent: null, name: '', record: rootRecord };
  let nextFrameId = 1;
  let truncated = false;
  let totalFields = 0;

  const addMember = (record: PathRecord, name: string, kind: JsonKind): void => {
    const existing = record.byName.get(name);
    if (existing !== undefined) {
      existing.freq += 1;
      if (existing.kind !== 'mixed' && existing.kind !== kind) existing.kind = 'mixed';
      return;
    }
    if (totalFields >= PROFILE_MAX_FIELDS) {
      truncated = true;
      return;
    }
    const stat: FieldStat = { name, freq: 1, kind };
    record.byName.set(name, stat);
    record.sample.members.push(stat);
    totalFields += 1;
  };

  /** 访问容器子节点时建帧（同一路径模板 interning；撞路径上限 → null + truncated）。 */
  const frameFor = (parent: Frame, name: string, child: unknown): Frame | null => {
    const key = `${parent.id}\u0000${name}`;
    const existing = frameIndex.get(key);
    if (existing !== undefined) return existing;
    if (paths.length >= PROFILE_MAX_PATHS) {
      truncated = true;
      return null;
    }
    const segments: string[] = [];
    for (let frame: Frame | null = parent; frame !== null && frame.parent !== null; frame = frame.parent) {
      segments.push(frame.name);
    }
    segments.reverse();
    segments.push(name);
    const record: PathRecord = {
      sample: {
        segments,
        kind: Array.isArray(child) ? 'array' : 'object',
        samples: 0,
        members: [],
      },
      byName: new Map(),
    };
    paths.push(record.sample);
    const frame: Frame = { id: nextFrameId++, parent, name, record };
    frameIndex.set(key, frame);
    return frame;
  };

  const values: unknown[] = [root];
  const slots: FrameSlot[] = [rootFrame];
  const parents: Frame[] = [rootFrame];
  const names: string[] = [''];
  let visited = 0;

  /** 不跟踪路径的子树：只消耗节点预算（数组取样规则与是否跟踪无关）。 */
  const pushUntrackedChildren = (value: unknown): void => {
    if (Array.isArray(value)) {
      const count = largeDocument ? Math.min(value.length, PROFILE_ARRAY_SAMPLE_N) : value.length;
      for (let i = count - 1; i >= 0; i--) {
        values.push(value[i]);
        slots.push(null);
        parents.push(rootFrame);
        names.push('');
      }
    } else if (isPlainObject(value)) {
      const keys = Object.keys(value);
      for (let i = keys.length - 1; i >= 0; i--) {
        values.push(value[keys[i] as string]);
        slots.push(null);
        parents.push(rootFrame);
        names.push('');
      }
    }
  };

  while (values.length > 0) {
    if (visited >= PROFILE_NODE_BUDGET) break;
    const value = values.pop();
    let slot = slots.pop() as FrameSlot;
    const parent = parents.pop() as Frame;
    const name = names.pop() as string;
    visited += 1;

    if (slot === LOOKUP) {
      slot = frameFor(parent, name, value);
    }
    if (slot === null) {
      pushUntrackedChildren(value);
      continue;
    }
    const frame = slot;

    if (Array.isArray(value)) {
      // 数组节点本身不计 samples（数组路径的 samples = 取样元素数）；元素复用数组帧（下标不进路径）
      const count = largeDocument ? Math.min(value.length, PROFILE_ARRAY_SAMPLE_N) : value.length;
      for (let i = count - 1; i >= 0; i--) {
        values.push(value[i]);
        slots.push(frame);
        parents.push(frame);
        names.push('');
      }
    } else if (isPlainObject(value)) {
      frame.record.sample.samples += 1;
      const keys = Object.keys(value);
      for (const key of keys) addMember(frame.record, key, jsonKind(value[key]));
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i] as string;
        const child = value[key];
        if (isContainerValue(child)) {
          values.push(child);
          slots.push(LOOKUP);
          parents.push(frame);
          names.push(key);
        } else {
          // 标量字段没有路径样本，但仍计入节点预算（先序前 N 个节点口径）
          values.push(child);
          slots.push(null);
          parents.push(rootFrame);
          names.push('');
        }
      }
    } else {
      // 标量实例（根标量 / 数组元素标量）：落在所属路径模板上 → samples +1
      frame.record.sample.samples += 1;
    }
  }

  for (const sample of paths) sample.members.sort((a, b) => b.freq - a.freq);
  return { sampledNodes: visited, truncated, paths };
}

/**
 * 构建文档概要（纯函数；同步两遍遍历，结果对同一值图完全确定）。
 *
 * @param value 文档根值（JSON.parse / 无损解析产出；`undefined` 视为空文档，计数 0）
 */
export function buildDocumentProfile(value: unknown): DocumentProfile {
  if (value === undefined) {
    // 非 JSON 值（防御分支，文档根不可达）：契约要求 `paths` 至少一条根样本，给合法的零样本根。
    return {
      rootKind: 'null',
      nodeCount: 0,
      maxDepth: 0,
      sampled: false,
      sampledNodes: 0,
      truncated: false,
      paths: [{ segments: [], kind: 'object', samples: 0, members: [] }],
    };
  }
  const { nodeCount, maxDepth } = countNodesAndDepth(value);
  const { sampledNodes, truncated, paths } = collectSamples(value, nodeCount > PROFILE_NODE_BUDGET);
  return {
    rootKind: jsonKind(value),
    nodeCount,
    maxDepth,
    sampled: sampledNodes < nodeCount,
    sampledNodes,
    truncated,
    paths,
  };
}
