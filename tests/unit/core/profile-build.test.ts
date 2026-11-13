import { describe, expect, it } from 'vitest';
import { countDocumentNodes } from '../../../src/core/expression/engine';
import { buildDocumentProfile } from '../../../src/core/profile';
import type { DocumentProfile, PathSample } from '../../../src/protocol/types';

/* -------------------------------- 夹具 / 辅助 -------------------------------- */

/** 路径签名（segments 以 `\u0000` 连接，避免键名里含 `/` 造成歧义）。 */
function sig(segments: string[]): string {
  return segments.join('\u0000');
}

function sampleOf(profile: DocumentProfile, segments: string[]): PathSample {
  const found = profile.paths.find((sample) => sig(sample.segments) === sig(segments));
  expect(found, `缺少路径样本：[${segments.join(', ')}]`).toBeDefined();
  return found as PathSample;
}

function pathSignatures(profile: DocumentProfile): string[] {
  return profile.paths.map((sample) => `/${sig(sample.segments)}`);
}

function names(sample: PathSample): string[] {
  return sample.members.map((member) => member.name);
}

/* ------------------------------ 节点数 / 深度口径 ------------------------------ */

describe('core/profile — 节点数与深度口径（ADR-0025 §4）', () => {
  it('nodeCount 与 countDocumentNodes 完全同口径', () => {
    const values: unknown[] = [
      1,
      'x',
      null,
      true,
      {},
      [],
      { a: 1 },
      { a: 1, b: 2 },
      [1, 2, 3],
      { a: { b: 1 }, c: [2, 3] },
      { items: [{ name: 'a', price: 1 }, { name: 'b' }] },
    ];
    for (const value of values) {
      expect(buildDocumentProfile(value).nodeCount).toBe(countDocumentNodes(value));
    }
  });

  it('maxDepth 根 = 1；{a:1} → 2', () => {
    expect(buildDocumentProfile(1).maxDepth).toBe(1);
    expect(buildDocumentProfile(null).maxDepth).toBe(1);
    expect(buildDocumentProfile({}).maxDepth).toBe(1);
    expect(buildDocumentProfile([]).maxDepth).toBe(1);
    expect(buildDocumentProfile({ a: 1 }).maxDepth).toBe(2);
    expect(buildDocumentProfile([1, 2, 3]).maxDepth).toBe(2);
    expect(buildDocumentProfile({ a: { b: { c: 1 } } }).maxDepth).toBe(4);
    expect(buildDocumentProfile({ a: { b: 1 }, c: [2, 3] }).maxDepth).toBe(3);
  });

  it('rootKind 取 jsonKind（object / array / null / 标量）', () => {
    expect(buildDocumentProfile({}).rootKind).toBe('object');
    expect(buildDocumentProfile([]).rootKind).toBe('array');
    expect(buildDocumentProfile(null).rootKind).toBe('null');
    expect(buildDocumentProfile(1).rootKind).toBe('number');
    expect(buildDocumentProfile('x').rootKind).toBe('string');
    expect(buildDocumentProfile(true).rootKind).toBe('boolean');
  });
});

/* -------------------------------- 根路径样本 -------------------------------- */

describe('core/profile — 根路径样本（根 = []）', () => {
  it('{a:1} 完整形状（单测钉住 ADR-0025 §4 口径）', () => {
    expect(buildDocumentProfile({ a: 1 })).toEqual({
      rootKind: 'object',
      nodeCount: 2,
      maxDepth: 2,
      sampled: false,
      sampledNodes: 2,
      truncated: false,
      paths: [
        {
          segments: [],
          kind: 'object',
          samples: 1,
          members: [{ name: 'a', freq: 1, kind: 'number' }],
        },
      ],
    });
  });

  it('根数组 [1,2,3]：kind=array、samples=元素数、members 为空（标量无字段）', () => {
    const profile = buildDocumentProfile([1, 2, 3]);
    expect(profile).toMatchObject({
      rootKind: 'array',
      nodeCount: 4,
      maxDepth: 2,
      sampled: false,
      sampledNodes: 4,
      truncated: false,
    });
    expect(profile.paths).toEqual([{ segments: [], kind: 'array', samples: 3, members: [] }]);
  });

  it('根标量 / 空对象：合法空结果（[] + kind=object + samples=1）', () => {
    for (const value of [null, 42, 'x', true, {}, [] as unknown[]]) {
      const profile = buildDocumentProfile(value);
      expect(profile.nodeCount).toBe(1);
      expect(profile.paths).toHaveLength(1);
      expect(profile.paths[0]).toEqual({
        segments: [],
        kind: Array.isArray(value) ? 'array' : 'object',
        samples: Array.isArray(value) ? 0 : 1,
        members: [],
      });
    }
  });

  it('非 JSON 值 undefined（防御分支）：nodeCount=0 且仍含根样本（契约不变式：paths 至少一条）', () => {
    const profile = buildDocumentProfile(undefined);
    expect(profile.nodeCount).toBe(0);
    expect(profile.maxDepth).toBe(0);
    expect(profile.paths).toHaveLength(1);
    expect(profile.paths[0]).toEqual({ segments: [], kind: 'object', samples: 0, members: [] });
  });

  it('根对象 fields 的 kind 取 jsonKind（object / array 也算）', () => {
    const profile = buildDocumentProfile({ obj: { a: 1 }, arr: [1], s: 'x', n: 1, b: true, z: null });
    expect(sampleOf(profile, []).members).toEqual([
      { name: 'obj', freq: 1, kind: 'object' },
      { name: 'arr', freq: 1, kind: 'array' },
      { name: 's', freq: 1, kind: 'string' },
      { name: 'n', freq: 1, kind: 'number' },
      { name: 'b', freq: 1, kind: 'boolean' },
      { name: 'z', freq: 1, kind: 'null' },
    ]);
  });
});

/* ------------------------------- 嵌套 / 数组字段 ------------------------------- */

describe('core/profile — 路径模板与数组元素字段（ADR-0025 §4）', () => {
  it('嵌套对象逐层建路径样本；标量不建路径', () => {
    const profile = buildDocumentProfile({ a: { b: 1 }, c: 2 });
    expect(pathSignatures(profile)).toEqual(['/', '/a']);
    expect(sampleOf(profile, [])).toEqual({
      segments: [],
      kind: 'object',
      samples: 1,
      members: [
        { name: 'a', freq: 1, kind: 'object' },
        { name: 'c', freq: 1, kind: 'number' },
      ],
    });
    expect(sampleOf(profile, ['a'])).toEqual({
      segments: ['a'],
      kind: 'object',
      samples: 1,
      members: [{ name: 'b', freq: 1, kind: 'number' }],
    });
  });

  it('数组容器 members = 元素对象字段并集，freq = 含该字段的元素数，samples = 元素数', () => {
    const doc = { items: [{ name: 'a', price: 1 }, { name: 'b' }, { name: 'c', price: 2 }] };
    const profile = buildDocumentProfile(doc);
    expect(profile.nodeCount).toBe(10);
    expect(profile.maxDepth).toBe(4);
    expect(sampleOf(profile, [])).toEqual({
      segments: [],
      kind: 'object',
      samples: 1,
      members: [{ name: 'items', freq: 1, kind: 'array' }],
    });
    const items = sampleOf(profile, ['items']);
    expect(items.kind).toBe('array');
    expect(items.samples).toBe(3);
    expect(items.members).toEqual([
      { name: 'name', freq: 3, kind: 'string' },
      { name: 'price', freq: 2, kind: 'number' },
    ]);
  });

  it('数组下标不进路径：list[].room.price → [list, room]', () => {
    const doc = { list: [{ room: { price: 1 } }, { room: { price: 2, extra: true } }] };
    const profile = buildDocumentProfile(doc);
    expect(pathSignatures(profile)).toEqual(['/', '/list', '/list\u0000room']);
    expect(sampleOf(profile, ['list'])).toMatchObject({ kind: 'array', samples: 2 });
    expect(names(sampleOf(profile, ['list']))).toEqual(['room']);
    const room = sampleOf(profile, ['list', 'room']);
    expect(room).toMatchObject({ kind: 'object', samples: 2 });
    expect(room.members).toEqual([
      { name: 'price', freq: 2, kind: 'number' },
      { name: 'extra', freq: 1, kind: 'boolean' },
    ]);
    // 任何 segments 都不含数组下标字样
    for (const sample of profile.paths) {
      for (const segment of sample.segments) expect(segment).not.toMatch(/^\d+$/);
    }
  });

  it('路径按首次出现序（DFS 先序）；相同路径只出现一次', () => {
    const doc = { a: { x: 1 }, b: { y: 2 }, c: [{ z: 3 }, { z: 4 }] };
    const profile = buildDocumentProfile(doc);
    expect(pathSignatures(profile)).toEqual(['/', '/a', '/b', '/c']);
    expect(sampleOf(profile, ['c']).samples).toBe(2);
    expect(profile.paths.filter((sample) => sig(sample.segments) === sig(['c']))).toHaveLength(1);
  });
});

/* ------------------------------ 类型归一 / 排序 ------------------------------ */

describe('core/profile — mixed 与确定性排序', () => {
  it('同名字段多类型 → mixed', () => {
    const profile = buildDocumentProfile({ a: [1, 'x', true], b: [{ k: 1 }, { k: 's' }, { k: 2 }] });
    expect(sampleOf(profile, ['a'])).toEqual({ segments: ['a'], kind: 'array', samples: 3, members: [] });
    expect(sampleOf(profile, ['b']).members).toEqual([{ name: 'k', freq: 3, kind: 'mixed' }]);
  });

  it('members 按 freq 降序、同频按首次出现序', () => {
    const profile = buildDocumentProfile({ items: [{ b: 1, a: 2 }, { c: 3, a: 4 }, { a: 5, c: 6 }] });
    // a freq 3 > c freq 2 > b freq 1（freq 优先，不能只按首次出现）
    expect(names(sampleOf(profile, ['items']))).toEqual(['a', 'c', 'b']);
  });

  it('同频并列保持首次出现序（稳定排序）', () => {
    const profile = buildDocumentProfile({ items: [{ b: 1, a: 2 }, { c: 3, a: 4 }] });
    expect(names(sampleOf(profile, ['items']))).toEqual(['a', 'b', 'c']);
  });

  it('确定性：同一文档两次构建完全一致（含顺序）', () => {
    const doc = {
      meta: { id: 'x', tags: ['a', 'b'] },
      rows: Array.from({ length: 50 }, (_, i) => ({ i, name: `n${i % 7}`, nested: { v: i % 3 } })),
    };
    const first = buildDocumentProfile(doc);
    const second = buildDocumentProfile(structuredClone(doc));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
