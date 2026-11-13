import { describe, expect, it } from 'vitest';
import { countDocumentNodes } from '../../../src/core/expression/engine';
import {
  buildDocumentProfile,
  PROFILE_ARRAY_SAMPLE_N,
  PROFILE_MAX_FIELDS,
  PROFILE_MAX_PATHS,
  PROFILE_NODE_BUDGET,
} from '../../../src/core/profile';
import type { PathSample } from '../../../src/protocol/types';

const sig = (segments: string[]): string => segments.join('\u0000');

function sampleOf(profile: { paths: PathSample[] }, segments: string[]): PathSample {
  const found = profile.paths.find((sample) => sig(sample.segments) === sig(segments));
  expect(found, `缺少路径样本：[${segments.join(', ')}]`).toBeDefined();
  return found as PathSample;
}

/* -------------------------------- 阈值分档 -------------------------------- */

describe('core/profile — 50k 阈值分档（ADR-0025 §4）', () => {
  it('常量口径', () => {
    expect(PROFILE_NODE_BUDGET).toBe(50_000);
    expect(PROFILE_ARRAY_SAMPLE_N).toBe(32);
    expect(PROFILE_MAX_PATHS).toBe(2_000);
    expect(PROFILE_MAX_FIELDS).toBe(20_000);
  });

  it('节点数 = 50,000（阈值内）→ 全量收集、数组不截断', () => {
    // nodeCount = 根 1 + arr 容器 1 + 元素 49_998 = 50_000
    const doc = { arr: Array.from({ length: 49_998 }, (_, i) => i) };
    expect(countDocumentNodes(doc)).toBe(PROFILE_NODE_BUDGET);
    const profile = buildDocumentProfile(doc);
    expect(profile.sampled).toBe(false);
    expect(profile.sampledNodes).toBe(PROFILE_NODE_BUDGET);
    expect(profile.nodeCount).toBe(PROFILE_NODE_BUDGET);
    expect(sampleOf(profile, ['arr'])).toMatchObject({ kind: 'array', samples: 49_998 });
  });

  it('节点数 = 50_001（刚超阈值）→ sampled + 数组只取前 32 个元素', () => {
    const doc = { arr: Array.from({ length: 49_999 }, (_, i) => i) };
    expect(countDocumentNodes(doc)).toBe(PROFILE_NODE_BUDGET + 1);
    const profile = buildDocumentProfile(doc);
    expect(profile.sampled).toBe(true);
    expect(profile.nodeCount).toBe(PROFILE_NODE_BUDGET + 1);
    expect(profile.sampledNodes).toBeLessThanOrEqual(PROFILE_NODE_BUDGET);
    expect(sampleOf(profile, ['arr'])).toMatchObject({ kind: 'array', samples: PROFILE_ARRAY_SAMPLE_N });
  });

  it('大文档：数组取样 N=32（第 33 个起不参与字段收集）', () => {
    // nodeCount = 根 1 + big 容器 1 + 30_000 元素对象 + 30_000 v + 1 flag = 60_003 > 50k
    const doc = {
      big: Array.from({ length: 30_000 }, (_, i) => (i === 40 ? { v: i, flag: true } : { v: i })),
    };
    expect(countDocumentNodes(doc)).toBeGreaterThan(PROFILE_NODE_BUDGET);
    const profile = buildDocumentProfile(doc);
    expect(profile.sampled).toBe(true);
    expect(profile.sampledNodes).toBeLessThanOrEqual(PROFILE_NODE_BUDGET);
    const big = sampleOf(profile, ['big']);
    expect(big.kind).toBe('array');
    expect(big.samples).toBe(PROFILE_ARRAY_SAMPLE_N);
    // flag 只出现在第 41 个元素（index 40）→ 取样不到
    expect(big.members).toEqual([{ name: 'v', freq: PROFILE_ARRAY_SAMPLE_N, kind: 'number' }]);
  });

  it('大文档：先序前 50k 节点预算（超出部分不参与字段收集）', () => {
    // 宽对象：根 1 + 60_000 标量 = 60_001 节点；字段上限先撞（20k），节点预算 50k 也截断
    const doc: Record<string, number> = {};
    for (let i = 0; i < 60_000; i++) doc[`k${i}`] = i;
    const profile = buildDocumentProfile(doc);
    expect(profile.sampled).toBe(true);
    expect(profile.sampledNodes).toBe(PROFILE_NODE_BUDGET);
    expect(profile.truncated).toBe(true);
    expect(profile.paths[0]?.members).toHaveLength(PROFILE_MAX_FIELDS);
  });
});

/* -------------------------------- 硬上限 -------------------------------- */

describe('core/profile — 路径 / 字段硬上限（ADR-0025 §4）', () => {
  it('路径 ≤ 2,000：超限停止收集新路径并置 truncated（节点计数不受影响）', () => {
    // nodeCount = 根 1 + 2_500 × (对象 1 + 标量 1) = 5_001 ≤ 50k → 全量遍历、sampled=false
    const doc: Record<string, { v: number }> = {};
    for (let i = 0; i < 2_500; i++) doc[`o${i}`] = { v: i };
    expect(countDocumentNodes(doc)).toBe(5_001);
    const profile = buildDocumentProfile(doc);
    expect(profile.sampled).toBe(false);
    expect(profile.sampledNodes).toBe(5_001);
    expect(profile.truncated).toBe(true);
    expect(profile.paths).toHaveLength(PROFILE_MAX_PATHS);
    expect(profile.paths[0]?.segments).toEqual([]);
  });

  it('字段 ≤ 20,000：按去重 (路径, 字段名) 条目计，超限置 truncated', () => {
    const doc: Record<string, number> = {};
    for (let i = 0; i < 20_001; i++) doc[`f${i}`] = i;
    expect(countDocumentNodes(doc)).toBe(20_002);
    const profile = buildDocumentProfile(doc);
    expect(profile.sampled).toBe(false);
    expect(profile.truncated).toBe(true);
    expect(profile.paths).toHaveLength(1);
    expect(profile.paths[0]?.members).toHaveLength(PROFILE_MAX_FIELDS);
  });

  it('freq 累加不消耗字段条目（同一 (路径, 字段名) 只算 1 条）', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ a: i, b: i }));
    const profile = buildDocumentProfile({ rows });
    expect(profile.truncated).toBe(false);
    const fields = profile.paths.reduce((sum, sample) => sum + sample.members.length, 0);
    // 根 items 1 + rows 路径 2
    expect(fields).toBe(3);
    expect(sampleOf(profile, ['rows']).members).toEqual([
      { name: 'a', freq: 500, kind: 'number' },
      { name: 'b', freq: 500, kind: 'number' },
    ]);
  });

  it('小文档全量收集时 sampled / truncated 都为 false', () => {
    const profile = buildDocumentProfile({ a: { b: 1 }, c: [1, 2] });
    expect(profile.sampled).toBe(false);
    expect(profile.truncated).toBe(false);
    expect(profile.sampledNodes).toBe(profile.nodeCount);
  });
});

/* ------------------------------ 深嵌套不爆栈 ------------------------------ */

describe('core/profile — 深嵌套（显式栈，禁递归）', () => {
  it('1,000,000 层对象链不爆栈；计数/深度精确，采样有界', () => {
    const depth = 1_000_000;
    let value: unknown = 1;
    for (let i = 0; i < depth; i++) value = { child: value };

    const profile = buildDocumentProfile(value);
    expect(profile.nodeCount).toBe(depth + 1);
    expect(profile.maxDepth).toBe(depth + 1);
    expect(profile.sampled).toBe(true);
    expect(profile.sampledNodes).toBe(PROFILE_NODE_BUDGET);
    // 第 2 遍在路径上限处停止收集新路径
    expect(profile.truncated).toBe(true);
    expect(profile.paths).toHaveLength(PROFILE_MAX_PATHS);
    expect(profile.paths[0]?.segments).toEqual([]);
  });

  it('1,000,000 层数组链不爆栈', () => {
    const depth = 1_000_000;
    let value: unknown = 1;
    for (let i = 0; i < depth; i++) value = [value];

    const profile = buildDocumentProfile(value);
    expect(profile.nodeCount).toBe(depth + 1);
    expect(profile.maxDepth).toBe(depth + 1);
    expect(profile.sampled).toBe(true);
  });
});
