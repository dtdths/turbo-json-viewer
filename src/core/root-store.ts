/**
 * core/root-store — 多视图根的容器（ADR-0001 §3 / ADR-0002 §6）。
 *
 * 骨架 slice 只有 doc 根；接口按多根写：表达式结果根最多保留最近 3 个（LRU），
 * 修复文档根（repaired）也走同一张表。行模型/窗口/搜索都以 rootId 为坐标。
 */
import { CoreError } from '../protocol/errors';
import type { DocumentMeta, RootId } from '../protocol/types';
import type { RawTextIndex } from './raw-text';
import type { RowModel } from './row-model';

export type RootKind = 'doc' | 'expression' | 'repaired';

export const DOC_ROOT_ID: RootId = 'doc';

/** 表达式结果根保留最近 3 个（ir-spec §4.2） */
export const MAX_EXPRESSION_ROOTS = 3;

/** 导入时保留的源文本（ADR-0003 修订 2026-11-03 §2）：原文视图的唯一真相。 */
export interface RootSource {
  text: string;
  /** true = 源文本非法（截断修复后的文档）→ 原文视图只能 plain */
  damaged?: boolean;
  /** 惰性构建的行索引（首次 raw* 命令时创建）；文档替换时随根一起释放 */
  index?: RawTextIndex;
}

export interface Root {
  rootId: RootId;
  kind: RootKind;
  /** JSON.parse 值图（expression 根引用原节点，不复制） */
  value: unknown;
  rowModel: RowModel;
  /** 内容版本：导入 / 修复 / replaceNode / reset 时 +1 */
  docRevision: number;
  /** 行映射版本：展开 / 折叠 / replaceNode / reset 时 +1（窗口校验用） */
  rowVersion: number;
  /** expression / repaired 指回 doc */
  parentRootId?: RootId;
  meta?: DocumentMeta;
  /** 导入时保留的源文本（ADR-0003 修订 §2）：**临时修改不改变它**；无值图的根没有 */
  source?: RootSource;
  createdAt: number;
  lastUsedAt: number;
}

export class RootStore {
  private readonly roots = new Map<RootId, Root>();
  /** 非 doc 根的 LRU 顺序，最久未用在最前 */
  private readonly lru: RootId[] = [];

  get size(): number {
    return this.roots.size;
  }

  get(rootId: RootId): Root | undefined {
    return this.roots.get(rootId);
  }

  /** 取不到就抛 NO_ROOT（对应 CoreErrorCode）。 */
  require(rootId: RootId): Root {
    const root = this.roots.get(rootId);
    if (!root) throw new CoreError({ code: 'NO_ROOT', message: `unknown root: ${rootId}` });
    return root;
  }

  ids(): RootId[] {
    return [...this.roots.keys()];
  }

  values(): IterableIterator<Root> {
    return this.roots.values();
  }

  /**
   * 写入根。非 doc 根按 LRU(3) 淘汰最久未用的（返回被淘汰的根，调用方可发 stale/close）。
   * doc 根不参与 LRU、也不会被淘汰。
   */
  put(root: Root): Root[] {
    this.roots.set(root.rootId, root);
    if (root.kind === 'doc') return [];

    this.lru.push(root.rootId);
    const evicted: Root[] = [];
    while (this.lru.length > MAX_EXPRESSION_ROOTS) {
      const victimId = this.lru.shift() as RootId;
      const victim = this.roots.get(victimId);
      this.roots.delete(victimId);
      if (victim) evicted.push(victim);
    }
    return evicted;
  }

  /** 标记使用（LRU 重排 + lastUsedAt） */
  touch(rootId: RootId): void {
    const root = this.roots.get(rootId);
    if (!root) return;
    root.lastUsedAt = Date.now();
    if (root.kind === 'doc') return;
    const at = this.lru.indexOf(rootId);
    if (at >= 0) this.lru.splice(at, 1);
    this.lru.push(rootId);
  }

  delete(rootId: RootId): boolean {
    const at = this.lru.indexOf(rootId);
    if (at >= 0) this.lru.splice(at, 1);
    return this.roots.delete(rootId);
  }

  clear(): void {
    this.roots.clear();
    this.lru.length = 0;
  }
}
