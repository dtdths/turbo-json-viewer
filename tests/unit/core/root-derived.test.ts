/**
 * tests/unit/core/root-derived — 根级派生状态的失效矩阵（#54 后续 / ADR-0008 修订 2026-11-19）。
 *
 * 断言的是**纪律**，不是 DocService 的某个命令：
 *   1. identity 槽：挂根对象身份，同一根只算一次，换根对象重算，`release` 不碰它（随 GC）。
 *   2. docRevision 槽：版本推进即失效；`set` 可直接落值；`release` 后重算。
 *   3. 子键槽（单路径偏移）：per-root LRU——命中挪队尾、超容量淘汰最久未用、`null` 也算命中。
 *   4. `clear()`：所有槽清空。
 */
import { describe, expect, it } from 'vitest';
import { DERIVED_SLOTS, RootDerived } from '../../../src/core/root-derived';
import { RAW_PATH_CACHE_SIZE } from '../../../src/protocol/versions';
import type { Root } from '../../../src/core/root-store';

/** 最小假根：模块只读 `rootId` / `docRevision`，身份槽靠对象引用。 */
function fakeRoot(rootId: string, docRevision = 1): Root {
  return { rootId, docRevision } as Root;
}

describe('RootDerived — identity 槽（源文本类）', () => {
  it('首次算一次，二次命中；换根对象重算', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { nodes: calls } as never;
    };
    derived.get(a, 'pathIndex', compute);
    derived.get(a, 'pathIndex', compute);
    expect(calls).toBe(1);
    // 同一个 rootId 但换了根对象 = 新文档（ADR-0009 §2：根 id 单调不复用）
    derived.get(fakeRoot('doc:1'), 'pathIndex', compute);
    expect(calls).toBe(2);
  });

  it('docRevision 推进不影响 identity 槽（编辑不重扫源文本）', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    let calls = 0;
    derived.get(a, 'fidelity', () => {
      calls += 1;
      return { hits: [] } as never;
    });
    a.docRevision = 7;
    derived.get(a, 'fidelity', () => {
      calls += 1;
      return { hits: [] } as never;
    });
    expect(calls).toBe(1);
  });

  it('peek：未算过 = undefined；算过后返回值', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    expect(derived.peek(a, 'pathIndex')).toBeUndefined();
    derived.get(a, 'pathIndex', () => ({ ok: true }) as never);
    expect(derived.peek(a, 'pathIndex')).toEqual({ ok: true } as never);
  });

  it('release 不删 identity 槽（随根对象 GC），clear 才清空', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    derived.get(a, 'pathIndex', () => ({ first: true }) as never);
    derived.release('doc:1');
    expect(derived.peek(a, 'pathIndex')).toEqual({ first: true } as never);
    derived.clear();
    expect(derived.peek(a, 'pathIndex')).toBeUndefined();
  });
});

describe('RootDerived — docRevision 槽（值图类）', () => {
  it('命中；docRevision++ 后重算', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    let calls = 0;
    const compute = () => {
      calls += 1;
      return 42;
    };
    expect(derived.get(a, 'nodeCount', compute)).toBe(42);
    expect(derived.get(a, 'nodeCount', compute)).toBe(42);
    expect(calls).toBe(1);
    a.docRevision += 1;
    derived.get(a, 'nodeCount', compute);
    expect(calls).toBe(2);
  });

  it('peek 按版本判定：版本不匹配 = undefined（不删旧条目，等 set 覆盖）', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    derived.get(a, 'profile', () => ({ nodeCount: 3 }) as never);
    expect(derived.peek(a, 'profile')).toEqual({ nodeCount: 3 } as never);
    a.docRevision = 2;
    expect(derived.peek(a, 'profile')).toBeUndefined();
    expect(derived.get(a, 'profile', () => ({ nodeCount: 4 }) as never)).toEqual({ nodeCount: 4 } as never);
  });

  it('set 直接落值后按当前版本命中（一次采样喂两个槽）', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1', 3);
    derived.set(a, 'nodeCount', 99);
    expect(derived.peek(a, 'nodeCount')).toBe(99);
    a.docRevision = 4;
    expect(derived.peek(a, 'nodeCount')).toBeUndefined();
  });

  it('release 后重算', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    let calls = 0;
    const compute = () => {
      calls += 1;
      return calls;
    };
    derived.get(a, 'nodeCount', compute);
    derived.release('doc:1');
    expect(derived.get(a, 'nodeCount', compute)).toBe(2);
  });
});

describe('RootDerived — 子键槽（单路径偏移，per-root LRU）', () => {
  it('子键 miss 算一次、命中不再算', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    let calls = 0;
    const compute = () => {
      calls += 1;
      return 10;
    };
    expect(derived.getAt(a, 'offset', '$.a', compute)).toBe(10);
    expect(derived.getAt(a, 'offset', '$.a', compute)).toBe(10);
    expect(calls).toBe(1);
    // 另一个路径各自成条
    expect(derived.getAt(a, 'offset', '$.b', compute)).toBe(10);
    expect(calls).toBe(2);
  });

  it('null 也是合法缓存值，同样算命中', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    let calls = 0;
    const compute = () => {
      calls += 1;
      return null;
    };
    expect(derived.getAt(a, 'offset', '$.missing', compute)).toBeNull();
    expect(derived.getAt(a, 'offset', '$.missing', compute)).toBeNull();
    expect(calls).toBe(1);
  });

  it('超容量淘汰最久未用；命中会把它挪到队尾', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    const computeFor = (value: number) => () => value;
    expect(RAW_PATH_CACHE_SIZE).toBe(512);

    // 填满容量
    for (let i = 0; i < RAW_PATH_CACHE_SIZE; i += 1) {
      derived.getAt(a, 'offset', `$.k${i}`, computeFor(i));
    }
    // 命中第一个 → 挪到队尾（变成最新）
    let recomputed = 0;
    derived.getAt(a, 'offset', '$.k0', () => {
      recomputed += 1;
      return -1;
    });
    expect(recomputed).toBe(0);
    // 再插入一个新键 → 淘汰的是 k1（最久未用），k0 仍在
    derived.getAt(a, 'offset', '$.new', computeFor(999));
    let k0Calls = 0;
    derived.getAt(a, 'offset', '$.k0', () => {
      k0Calls += 1;
      return -1;
    });
    expect(k0Calls).toBe(0);
    let k1Calls = 0;
    derived.getAt(a, 'offset', '$.k1', () => {
      k1Calls += 1;
      return -2;
    });
    expect(k1Calls).toBe(1);
  });

  it('不同根各自一份 LRU（不互相淘汰）', () => {
    const derived = new RootDerived();
    const a = fakeRoot('doc:1');
    const b = fakeRoot('doc:2');
    derived.getAt(a, 'offset', '$.a', () => 1);
    derived.getAt(b, 'offset', '$.a', () => 2);
    let calls = 0;
    expect(
      derived.getAt(a, 'offset', '$.a', () => {
        calls += 1;
        return 3;
      }),
    ).toBe(1);
    expect(calls).toBe(0);
  });
});

describe('RootDerived — 纪律表', () => {
  it('五种派生数据各有明确失效键', () => {
    expect(DERIVED_SLOTS.fidelity.invalidation).toBe('identity');
    expect(DERIVED_SLOTS.pathIndex.invalidation).toBe('identity');
    expect(DERIVED_SLOTS.offset.invalidation).toBe('identity');
    expect('lru' in DERIVED_SLOTS.offset).toBe(true);
    expect(DERIVED_SLOTS.nodeCount.invalidation).toBe('docRevision');
    expect(DERIVED_SLOTS.profile.invalidation).toBe('docRevision');
  });
});
