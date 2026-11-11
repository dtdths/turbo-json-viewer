/**
 * tests/unit/core/root-store — 多视图根容器的淘汰 / 释放语义（ADR-0001 §3 / ADR-0009 §2）。
 *
 * 这里只断言 RootStore 自身不变量：
 *   1. doc 根不参与 LRU（多标签可同时存在任意多个，数量上限由页面软约束 = 8）；
 *   2. 表达式根 LRU(3) 行为不变（最久未用先淘汰，touch 重排）；
 *   3. close() 返回被删根、未知根返回 undefined（幂等），并**清掉 lru 邻接**——
 *      否则关闭后残留的 lru 条目会让后续 put 提前淘汰还活着的根。
 */
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../../src/protocol/errors';
import { RowModel } from '../../../src/core/row-model';
import { MAX_EXPRESSION_ROOTS, RootStore, type Root, type RootKind } from '../../../src/core/root-store';
import type { RootId } from '../../../src/protocol/types';

function makeRoot(rootId: RootId, kind: RootKind, parentRootId?: RootId): Root {
  const value = kind === 'expression' ? [1, 2, 3] : { a: 1, b: { c: 2 } };
  const now = Date.now();
  const root: Root = {
    rootId,
    kind,
    value,
    rowModel: new RowModel(value),
    docRevision: 1,
    rowVersion: 1,
    createdAt: now,
    lastUsedAt: now,
  };
  if (parentRootId !== undefined) root.parentRootId = parentRootId;
  return root;
}

function putAll(store: RootStore, ids: RootId[], kind: RootKind = 'expression'): void {
  for (const id of ids) store.put(makeRoot(id, kind));
}

describe('RootStore — doc 根不参与 LRU（多文档标签 / ADR-0009）', () => {
  it('连续 put 超过 MAX_EXPRESSION_ROOTS 个 doc 根：全部保留、无淘汰', () => {
    const store = new RootStore();
    for (let i = 1; i <= MAX_EXPRESSION_ROOTS + 2; i++) {
      // 每次 put 都回空数组（doc 根不产生淘汰；与 put 返回值契约一致）
      expect(store.put(makeRoot(`doc:${i}`, 'doc'))).toEqual([]);
    }
    expect(store.size).toBe(MAX_EXPRESSION_ROOTS + 2);
    expect(store.ids()).toEqual(['doc:1', 'doc:2', 'doc:3', 'doc:4', 'doc:5']);
  });

  it('doc 根与表达式根混放：doc 根不受表达式 LRU 影响', () => {
    const store = new RootStore();
    store.put(makeRoot('doc:1', 'doc'));
    store.put(makeRoot('doc:2', 'doc'));
    putAll(store, ['expr:1', 'expr:2', 'expr:3', 'expr:4']);

    // 表达式根按 LRU(3) 淘汰 expr:1；两个 doc 根仍在
    expect(store.ids()).toEqual(['doc:1', 'doc:2', 'expr:2', 'expr:3', 'expr:4']);
  });

  it('touch 任意 doc 根不会把它塞进 LRU，也不会触发淘汰', () => {
    const store = new RootStore();
    store.put(makeRoot('doc:1', 'doc'));
    putAll(store, ['expr:1', 'expr:2', 'expr:3']);
    store.touch('doc:1');
    expect(store.put(makeRoot('expr:4', 'expression')).map((root) => root.rootId)).toEqual(['expr:1']);
    expect(store.get('doc:1')).toBeDefined();
  });
});

describe('RootStore — 表达式根 LRU(3) 行为不变', () => {
  it('第 4 个表达式根淘汰最久未用的那个（put 返回被淘汰根）', () => {
    const store = new RootStore();
    putAll(store, ['expr:1', 'expr:2', 'expr:3']);
    expect(store.size).toBe(3);

    const evicted = store.put(makeRoot('expr:4', 'expression'));
    expect(evicted.map((root) => root.rootId)).toEqual(['expr:1']);
    expect(store.ids()).toEqual(['expr:2', 'expr:3', 'expr:4']);
  });

  it('touch 重排 LRU：最近用过的根不会被优先淘汰', () => {
    const store = new RootStore();
    putAll(store, ['expr:1', 'expr:2', 'expr:3']);

    store.touch('expr:1'); // 重排后顺序：expr:2, expr:3, expr:1
    const evicted = store.put(makeRoot('expr:4', 'expression'));
    expect(evicted.map((root) => root.rootId)).toEqual(['expr:2']);
    expect(store.ids()).toEqual(['expr:1', 'expr:3', 'expr:4']);
  });
});

describe('RootStore — close（#18 / ADR-0009 §2）', () => {
  it('关闭已知根：返回被删的根、根表与 lru 都清掉；require 之后抛 NO_ROOT', () => {
    const store = new RootStore();
    const root = makeRoot('expr:1', 'expression');
    store.put(root);

    expect(store.close('expr:1')).toBe(root);
    expect(store.size).toBe(0);
    expect(store.get('expr:1')).toBeUndefined();
    expect(() => store.require('expr:1')).toThrowError(CoreError);
    try {
      store.require('expr:1');
    } catch (err) {
      expect((err as CoreError).code).toBe('NO_ROOT');
    }
  });

  it('未知根幂等：close 两次，第二次返回 undefined（不抛）', () => {
    const store = new RootStore();
    store.put(makeRoot('doc:1', 'doc'));
    expect(store.close('doc:1')?.rootId).toBe('doc:1');
    expect(store.close('doc:1')).toBeUndefined();
    expect(store.close('nope')).toBeUndefined();
  });

  it('close 清 lru 邻接：关掉最近使用的根后，后续 put 不会提前淘汰活根', () => {
    const store = new RootStore();
    putAll(store, ['expr:1', 'expr:2', 'expr:3']);
    expect(store.close('expr:3')?.rootId).toBe('expr:3'); // 关掉最新根（lru 头部残留最容易伤人）

    // 若 lru 没清，这第 4 次 put 会误淘汰活着的 expr:1
    expect(store.put(makeRoot('expr:4', 'expression'))).toEqual([]);
    const evicted = store.put(makeRoot('expr:5', 'expression'));
    expect(evicted.map((root) => root.rootId)).toEqual(['expr:1']);
    expect(store.ids()).toEqual(['expr:2', 'expr:4', 'expr:5']);
  });

  it('关闭 doc 根不影响表达式根的 LRU 顺序', () => {
    const store = new RootStore();
    store.put(makeRoot('doc:1', 'doc'));
    putAll(store, ['expr:1', 'expr:2', 'expr:3']);
    expect(store.close('doc:1')?.rootId).toBe('doc:1');

    const evicted = store.put(makeRoot('expr:4', 'expression'));
    expect(evicted.map((root) => root.rootId)).toEqual(['expr:1']);
    expect(store.ids()).toEqual(['expr:2', 'expr:3', 'expr:4']);
  });
});
