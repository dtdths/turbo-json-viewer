/**
 * core/root-derived — 根级**派生状态**的唯一 owner（#54 后续 / ADR-0008 修订 2026-11-19）。
 *
 * 为什么单独成 module：DocService 里有五种「由根派生、可重算、可丢弃」的数据，原来各写一套
 * 「查 → 校验 → 算 → 存」，并存**三种失效方言**：
 *   - 按**根对象身份**（`WeakMap<Root, …>`）：源文本类（保真报告 / path↔offset 索引 / 单路径偏移），
 *     文档替换 = 旧根被丢弃 → 缓存随对象一起回收，无需清理；
 *   - 按**版本**（`Map<RootId, {docRevision, …}>`）：值图类（节点数 / 文档概要），
 *     编辑推进 `docRevision` 后自动失效，且必须显式释放。
 * 失效纪律原来靠各字段上的注释记住，释放散在 `close()` / `dropRootState()` 两处；新增一种派生数据
 * 要记得改两三处。这里把「哪种数据按什么失效」变成 `DERIVED_SLOTS` 一张表。
 *
 * 接口（6 个方法）：
 *   - `get(root, slot, compute)`：标量槽，miss 时算一次并存入（失效键由槽声明）；
 *   - `peek(root, slot)`：只读查询（异步派生用：保真扫描要先查缓存、`await` 后再 `set`）；
 *   - `set(root, slot, value)`：直接落值（一次采样喂两个槽，如 profile 回填 nodeCount）；
 *   - `getAt(root, slot, key, compute)`：子键槽（单路径偏移），模块内部管 per-root LRU；
 *   - `release(rootId)` / `clear()`：根死亡 / 服务关闭时释放显式条目（identity 槽随根对象 GC）。
 *
 * 不在这里的东西：`histories`（可变的 undo 栈）与 `latestSearchSeq`（单调 seq）不是派生数据，
 * 留在 DocService，但和本模块一起由 `releaseRootState(rootId)` 这一处统一释放。
 */
import type { DocumentProfile, FidelityReport, Path, RootId } from '../protocol/types';
import { RAW_PATH_CACHE_SIZE } from '../protocol/versions';
import type { SourcePathIndex } from './path-index';
import type { Root } from './root-store';

/** 一个派生槽的规格：失效键 + （子键槽才有）per-root LRU 容量。 */
interface SlotSpec {
  /**
   * `identity` = 挂在根对象上、随根对象 GC 回收（**只依赖源文本、不受编辑影响**）；
   * `docRevision` = 版本推进即失效（依赖值图）。
   */
  invalidation: 'identity' | 'docRevision';
  /** 有值 = 该槽按子键缓存（per-root LRU，容量 = 该值）。 */
  lru?: number;
}

/** 失效纪律表：新增一种派生数据只在这里加一行。 */
export const DERIVED_SLOTS = {
  /** 保真扫描报告（#23）：挂根身份，编辑不重扫（ADR-0003 修订 §1）。 */
  fidelity: { invalidation: 'identity' },
  /** 源文本 path↔offset 索引（#30 / ADR-0019）：只依赖源文本，惰性构建。 */
  pathIndex: { invalidation: 'identity' },
  /** 单路径 → 原文偏移（#30）：子键槽 + per-root LRU（`null` 也缓存）。 */
  offset: { invalidation: 'identity', lru: RAW_PATH_CACHE_SIZE },
  /** 文档节点数（表达式步数预算，ADR-0018 §3）：随 docRevision 失效，首求值才算。 */
  nodeCount: { invalidation: 'docRevision' },
  /** 文档概要采样（#43 / ADR-0025 §3）：随 docRevision 失效，不自动重采。 */
  profile: { invalidation: 'docRevision' },
} as const satisfies Record<string, SlotSpec>;

export type DerivedSlot = keyof typeof DERIVED_SLOTS;

/** 槽 → 值类型（调用点由泛型钉住，写错槽名或值类型编译期报错）。 */
export interface DerivedValues {
  fidelity: FidelityReport;
  pathIndex: SourcePathIndex;
  offset: number | null;
  nodeCount: number;
  profile: DocumentProfile;
}

type SpecOf<K extends DerivedSlot> = (typeof DERIVED_SLOTS)[K];
/** 标量槽（一个根一个值）：identity / docRevision 两种失效键都在这里。 */
type ScalarSlot = { [K in DerivedSlot]: 'lru' extends keyof SpecOf<K> ? never : K }[DerivedSlot];
/** 子键槽（一个根一张 LRU 表）。 */
type KeyedSlot = Exclude<DerivedSlot, ScalarSlot>;

interface RevisionEntry {
  docRevision: number;
  value: unknown;
}

export class RootDerived {
  /** identity 标量槽：`WeakMap` 跟随根对象，文档替换 / 根被淘汰后自动回收。 */
  private identityScalar = new WeakMap<Root, Map<DerivedSlot, unknown>>();
  /** docRevision 标量槽：按 rootId 存，值里带 docRevision 做惰性失效。 */
  private readonly revisionScalar = new Map<RootId, Map<DerivedSlot, RevisionEntry>>();
  /** identity 子键槽：`WeakMap<Root, Map<slot, Map<subKey, value>>>`。 */
  private identityKeyed = new WeakMap<Root, Map<DerivedSlot, Map<string, unknown>>>();

  /** 标量槽取值：命中即返回（docRevision 槽先校验版本），miss 时算一次并存入。 */
  get<K extends ScalarSlot>(
    root: Root,
    slot: K,
    compute: () => DerivedValues[K],
  ): DerivedValues[K] {
    const cached = this.peek(root, slot);
    if (cached !== undefined) return cached;
    const value = compute();
    this.set(root, slot, value);
    return value;
  }

  /**
   * 只读查询（不改缓存）：
   * - identity 槽：有值就返回；
   * - docRevision 槽：`docRevision` 不匹配视为 miss（**不删旧条目**，下次 `set` 覆盖）。
   */
  peek<K extends ScalarSlot>(root: Root, slot: K): DerivedValues[K] | undefined {
    const spec: SlotSpec = DERIVED_SLOTS[slot];
    if (spec.invalidation === 'docRevision') {
      const entry = this.revisionScalar.get(root.rootId)?.get(slot);
      if (entry === undefined || entry.docRevision !== root.docRevision) return undefined;
      return entry.value as DerivedValues[K];
    }
    const byRoot = this.identityScalar.get(root);
    if (byRoot === undefined || !byRoot.has(slot)) return undefined;
    return byRoot.get(slot) as DerivedValues[K];
  }

  /** 直接落值（一次计算喂多个槽时用，如 `profile` 回填 `nodeCount`）。 */
  set<K extends ScalarSlot>(root: Root, slot: K, value: DerivedValues[K]): void {
    const spec: SlotSpec = DERIVED_SLOTS[slot];
    if (spec.invalidation === 'docRevision') {
      let byRoot = this.revisionScalar.get(root.rootId);
      if (byRoot === undefined) {
        byRoot = new Map();
        this.revisionScalar.set(root.rootId, byRoot);
      }
      byRoot.set(slot, { docRevision: root.docRevision, value });
      return;
    }
    let byRoot = this.identityScalar.get(root);
    if (byRoot === undefined) {
      byRoot = new Map();
      this.identityScalar.set(root, byRoot);
    }
    byRoot.set(slot, value);
  }

  /**
   * 子键槽取值（per-root LRU）：命中把该子键挪到队尾；miss 算一次并存入，超容量淘汰最久未用。
   * `null` 也是合法值且**算命中**（「源文本里没有这个路径」同样值得缓存）。
   */
  getAt<K extends KeyedSlot>(
    root: Root,
    slot: K,
    key: Path,
    compute: () => DerivedValues[K],
  ): DerivedValues[K] {
    let byRoot = this.identityKeyed.get(root);
    if (byRoot === undefined) {
      byRoot = new Map();
      this.identityKeyed.set(root, byRoot);
    }
    let cache = byRoot.get(slot);
    if (cache === undefined) {
      cache = new Map();
      byRoot.set(slot, cache);
    }
    if (cache.has(key)) {
      const hit = cache.get(key);
      // LRU：命中挪到队尾
      cache.delete(key);
      cache.set(key, hit);
      return hit as DerivedValues[K];
    }
    const value = compute();
    cache.set(key, value);
    const limit = (DERIVED_SLOTS[slot] as { lru: number }).lru;
    while (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return value;
  }

  /**
   * 释放一个根的**显式条目**（docRevision 槽）。identity 槽挂在根对象上，随根被丢弃 / GC
   * 自动回收——所以这里不需要（也无法）按 rootId 删。根死亡时由 `RootStore.onRelease` 调。
   */
  release(rootId: RootId): void {
    this.revisionScalar.delete(rootId);
  }

  /** 服务关闭：清空所有槽（identity WeakMap 直接换新，旧表随 GC 回收）。 */
  clear(): void {
    this.identityScalar = new WeakMap();
    this.identityKeyed = new WeakMap();
    this.revisionScalar.clear();
  }
}
