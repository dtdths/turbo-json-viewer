/**
 * tests/unit/view/profile-panel — 右栏「文档概要」纯格式化函数（#43 / ADR-0025 §7）。
 *
 * 只测 node 环境可跑的纯函数（文案 / 行数据 / 空态），DOM 结构由冒烟断言，
 * 这里不 import DOM API、不测布局。
 */
import { describe, expect, it } from 'vitest';
import {
  profileEmptyText,
  profileFieldRows,
  profileFieldsTitle,
  profileMetaText,
} from '../../../src/view/panels/profile-panel';
import type { DocumentProfile, FieldStat, PathSample } from '../../../src/protocol/types';

function field(name: string, kind: FieldStat['kind'], freq = 1): FieldStat {
  return { name, kind, freq };
}

function sample(
  segments: string[],
  kind: 'object' | 'array',
  members: FieldStat[],
  samples = 1,
): PathSample {
  return { segments, kind, samples, members };
}

/** ADR-0025 §5 形状的最小夹具；用例只覆盖自己关心的字段。 */
function profile(partial: Partial<DocumentProfile> = {}): DocumentProfile {
  return {
    rootKind: 'object',
    nodeCount: 2,
    maxDepth: 2,
    sampled: false,
    sampledNodes: 2,
    truncated: false,
    paths: [sample([], 'object', [])],
    ...partial,
  };
}

describe('profileMetaText — 元信息行（节点数 · 最大深度 · 采样状态）', () => {
  it('小文档全量收集：只给节点数与最大深度，不带采样/截断标记', () => {
    expect(profileMetaText(profile({ nodeCount: 2, maxDepth: 2 }))).toBe('2 个节点 · 深度 2');
  });

  it('大文档：节点数用中文紧凑写法，sampled 时追加「已采样 N」', () => {
    const p = profile({
      nodeCount: 2_960_000,
      maxDepth: 5,
      sampled: true,
      sampledNodes: 20_000,
      paths: [sample([], 'object', [field('hotel_list', 'array')])],
    });
    expect(profileMetaText(p)).toBe('296 万个节点 · 深度 5 · 已采样 2.0 万个节点');
  });

  it('truncated 追加「已截断」；sampled 与 truncated 互相独立', () => {
    expect(profileMetaText(profile({ nodeCount: 50_000, maxDepth: 3, truncated: true }))).toBe(
      '5.0 万个节点 · 深度 3 · 已截断',
    );
    expect(
      profileMetaText(
        profile({ nodeCount: 50_000, maxDepth: 3, sampled: true, sampledNodes: 20_000, truncated: true }),
      ),
    ).toBe('5.0 万个节点 · 深度 3 · 已采样 2.0 万个节点 · 已截断');
  });

  it('计数紧凑写法边界：<1 万原样、1 万起一位小数、≥100 万取整', () => {
    expect(profileMetaText(profile({ nodeCount: 9_999, maxDepth: 1 }))).toBe('9999 个节点 · 深度 1');
    expect(profileMetaText(profile({ nodeCount: 10_000, maxDepth: 1 }))).toBe('1.0 万个节点 · 深度 1');
    expect(profileMetaText(profile({ nodeCount: 1_000_000, maxDepth: 1 }))).toBe('100 万个节点 · 深度 1');
  });
});

describe('profileFieldRows — 根字段行（名称 / 类型 / 频率）', () => {
  const rootSample = sample([], 'object', [
    field('items', 'array'),
    field('name', 'string', 3),
    field('price', 'mixed'),
    field('meta', 'object', 1),
  ]);

  it('映射根样本成员；freq>1 才给 ×N；mixed → 混合', () => {
    expect(profileFieldRows(profile({ paths: [rootSample] }))).toEqual([
      { name: 'items', kindText: 'array', freqText: '' },
      { name: 'name', kindText: 'string', freqText: '×3' },
      { name: 'price', kindText: '混合', freqText: '' },
      { name: 'meta', kindText: 'object', freqText: '' },
    ]);
  });

  it('保持成员既有顺序（排序由 core 的 freq 降序 / 首次出现序保证，UI 不重排）', () => {
    const rows = profileFieldRows(profile({ paths: [rootSample] }));
    expect(rows.map((row) => row.name)).toEqual(['items', 'name', 'price', 'meta']);
  });

  it('只取根样本（segments = []），忽略更深路径样本', () => {
    const deeper = sample(['items'], 'array', [field('room', 'object', 2)]);
    expect(profileFieldRows(profile({ paths: [rootSample, deeper] }))).toHaveLength(4);
  });

  it('根样本为空（根为标量 / 无可统计字段）→ 空数组', () => {
    expect(profileFieldRows(profile({ rootKind: 'string', paths: [sample([], 'object', [])] }))).toEqual([]);
  });
});

describe('profileFieldsTitle — 根为数组时标题语义 =「元素字段」', () => {
  it('对象根 → 根字段；数组根 → 元素字段', () => {
    expect(profileFieldsTitle(profile({ rootKind: 'object' }))).toBe('根字段');
    expect(profileFieldsTitle(profile({ rootKind: 'array' }))).toBe('元素字段');
  });
});

describe('profileEmptyText — 四类空态文案（ADR-0025 §7）', () => {
  it('未打开文档 / 采样中 / 已修改待更新 / 无可统计字段', () => {
    expect(profileEmptyText('idle')).toBe('未打开文档');
    expect(profileEmptyText('loading')).toBe('采样中…');
    expect(profileEmptyText('stale')).toBe('文档已修改，概要待更新');
    expect(profileEmptyText('noFields')).toBe('无可统计的字段');
  });
});
