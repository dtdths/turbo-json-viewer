/**
 * viewmodel/search-state 单测 — 搜索状态机（slice 4，契约 §2）。
 *
 * 覆盖：seq 过期丢弃、docRevision 不匹配清空 + stale、过滤/计数/夹紧、
 * 环状 next/prev、current=-1、view 四态、hitPaths（未过滤 + 同批同实例）、
 * indexOfPath、computeResultWindow 边界、contentHeight、truncated 贯穿。
 *
 * 纯 viewmodel 单测：无 DOM、无 jsdom、无定时器。
 */
import { describe, expect, it } from 'vitest';
import {
  SearchState,
  computeResultWindow,
  SEARCH_RESULT_OVERSCAN,
  SEARCH_RESULT_ROW_HEIGHT,
  type SearchReplyInput,
  type SearchStateOptions,
} from '../../../src/viewmodel/search-state';
import type { Hit } from '../../../src/protocol/types';

const ROW_H = SEARCH_RESULT_ROW_HEIGHT; // 44

function makeHit(path: string, field: 'key' | 'value' | 'path' = 'key'): Hit {
  return {
    path,
    key: path,
    kind: 'string',
    preview: `preview:${path}`,
    field,
  };
}

function makeHits(...specs: Array<string | [string, 'key' | 'value' | 'path']>): Hit[] {
  return specs.map((spec) => (Array.isArray(spec) ? makeHit(spec[0], spec[1]) : makeHit(spec, 'key')));
}

function makeReply(seq: number, over: Partial<SearchReplyInput> = {}): SearchReplyInput {
  return {
    seq,
    docRevision: 1,
    hits: [],
    total: 0,
    truncated: false,
    ...over,
  };
}

/** 建一个已完成一次「begin + apply」的状态机，默认 docRevision = 1。 */
function readyState(
  hits: Hit[],
  over: Partial<SearchReplyInput> = {},
  opts?: SearchStateOptions,
): { state: SearchState; seq: number } {
  const state = new SearchState(opts);
  const seq = state.begin('hotel');
  const accepted = state.apply(makeReply(seq, { hits, total: hits.length, ...over }), 1);
  expect(accepted).toBe(true);
  return { state, seq };
}

describe('computeResultWindow — 窗口计算', () => {
  it('常量：结果行高 44、overscan 4', () => {
    expect(SEARCH_RESULT_ROW_HEIGHT).toBe(44);
    expect(SEARCH_RESULT_OVERSCAN).toBe(4);
  });

  it('size <= 0 → 空窗口（与 scrollTop / viewport 无关）', () => {
    expect(computeResultWindow(0, 0, 10)).toEqual({ start: 0, count: 0 });
    expect(computeResultWindow(-3, 500, 10)).toEqual({ start: 0, count: 0 });
    expect(computeResultWindow(0, -100, 0)).toEqual({ start: 0, count: 0 });
  });

  it('顶部：start=0，count = viewportRows + 2*overscan', () => {
    expect(computeResultWindow(100, 0, 10)).toEqual({ start: 0, count: 18 });
  });

  it('中间：start = floor(scrollTop/rowHeight) - overscan', () => {
    expect(computeResultWindow(1000, 100 * ROW_H, 10)).toEqual({ start: 96, count: 18 });
  });

  it('scrollTop 负值按 0；viewportRows 向下取整', () => {
    expect(computeResultWindow(100, -100, 10.9)).toEqual({ start: 0, count: 18 });
    expect(computeResultWindow(100, 0, 0.9)).toEqual({ start: 0, count: 8 });
  });

  it('底部：start 夹到 size，count 不超过 size-start', () => {
    expect(computeResultWindow(10, 1_000_000, 10)).toEqual({ start: 10, count: 0 });
    expect(computeResultWindow(100, (100 - 10) * ROW_H, 10)).toEqual({ start: 86, count: 14 });
  });

  it('自定义 rowHeight / overscan', () => {
    expect(computeResultWindow(1000, 320, 5, { rowHeight: 32, overscan: 2 })).toEqual({
      start: 8,
      count: 9,
    });
  });

  it('overscan = 0：start 恰好对齐视口首行，count = viewportRows', () => {
    expect(computeResultWindow(100, 400, 3, { rowHeight: 40, overscan: 0 })).toEqual({
      start: 10,
      count: 3,
    });
  });
});

describe('SearchState — 初始状态 / begin / clear', () => {
  it('初始：seq=0、idle、空结果、current=-1、filter=all、默认度量', () => {
    const state = new SearchState();
    expect(state.seq).toBe(0);
    expect(state.query).toBe('');
    expect(state.stale).toBe(false);
    expect(state.pending).toBe(false);
    expect(state.filter).toBe('all');
    expect(state.hits).toEqual([]);
    expect(state.allHits).toEqual([]);
    expect(state.counts).toEqual({ all: 0, key: 0, value: 0, path: 0 });
    expect(state.total).toBe(0);
    expect(state.size).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.current).toBe(-1);
    expect(state.currentHit()).toBeNull();
    expect(state.rowHeight).toBe(SEARCH_RESULT_ROW_HEIGHT);
    expect(state.overscan).toBe(SEARCH_RESULT_OVERSCAN);
    expect(state.contentHeight()).toBe(0);
    expect(state.view().phase).toBe('idle');
    expect(state.hitPaths().size).toBe(0);
    expect(state.indexOfPath('$.x')).toBe(-1);
  });

  it('自定义 options：rowHeight / overscan / 初始 filter 生效', () => {
    const state = new SearchState({ rowHeight: 32, overscan: 2, filter: 'key' });
    expect(state.rowHeight).toBe(32);
    expect(state.overscan).toBe(2);
    expect(state.filter).toBe('key');
  });

  it('begin(query)：seq 递增、query 更新、清空旧结果、进入 searching', () => {
    const { state } = readyState(makeHits('$.a', '$.b'));
    expect(state.size).toBe(2);

    const seq = state.begin('hotel');
    expect(seq).toBe(2);
    expect(state.seq).toBe(2);
    expect(state.query).toBe('hotel');
    expect(state.pending).toBe(true);
    expect(state.stale).toBe(false);
    expect(state.size).toBe(0);
    expect(state.allHits).toHaveLength(0);
    expect(state.counts).toEqual({ all: 0, key: 0, value: 0, path: 0 });
    expect(state.total).toBe(0);
    expect(state.current).toBe(-1);
    expect(state.view().phase).toBe('searching');
  });

  it('begin("")：seq 递增但待定结束，回到 idle', () => {
    const { state } = readyState(makeHits('$.a'));
    const seq = state.begin('');
    expect(seq).toBe(2);
    expect(state.pending).toBe(false);
    expect(state.stale).toBe(false);
    expect(state.query).toBe('');
    expect(state.size).toBe(0);
    expect(state.view().phase).toBe('idle');
  });

  it('clear：清空 query/结果/current/stale，seq 保持不变、filter 保留', () => {
    const { state, seq } = readyState(makeHits('$.a', '$.b'));
    state.setFilter('key');
    state.markStale();
    state.clear();

    expect(state.seq).toBe(seq); // 不变
    expect(state.query).toBe('');
    expect(state.pending).toBe(false);
    expect(state.stale).toBe(false);
    expect(state.size).toBe(0);
    expect(state.current).toBe(-1);
    expect(state.total).toBe(0);
    expect(state.filter).toBe('key'); // 过滤是用户偏好，不随 clear 重置
    expect(state.view().phase).toBe('idle');
  });
});

describe('SearchState — apply 采纳 / 过期', () => {
  it('采纳成功：写入 hits/total/truncated，重算 counts，current 指向首条', () => {
    const hits = makeHits(['$.a', 'key'], ['$.b', 'value']);
    const { state } = readyState(hits, { total: 2 });

    expect(state.pending).toBe(false);
    expect(state.stale).toBe(false);
    expect(state.view().phase).toBe('ready');
    expect(state.allHits).toHaveLength(2);
    expect(state.hits).toHaveLength(2);
    expect(state.counts).toEqual({ all: 2, key: 1, value: 1, path: 0 });
    expect(state.total).toBe(2);
    expect(state.size).toBe(2);
    expect(state.current).toBe(0);
    expect(state.currentHit()?.path).toBe('$.a');
  });

  it('seq 过期的回包被忽略，不改任何状态', () => {
    const state = new SearchState();
    const firstSeq = state.begin('a');
    const secondSeq = state.begin('b');
    expect(secondSeq).toBe(firstSeq + 1);

    const staleReply = makeReply(firstSeq, { hits: makeHits('$.a'), total: 1 });
    expect(state.apply(staleReply, 1)).toBe(false);

    expect(state.allHits).toHaveLength(0);
    expect(state.size).toBe(0);
    expect(state.current).toBe(-1);
    expect(state.total).toBe(0);
    expect(state.pending).toBe(true);
    expect(state.query).toBe('b');
    expect(state.view().phase).toBe('searching');
  });

  it('docRevision 不匹配：清空结果 + stale + 结束 pending，返回 false', () => {
    const { state, seq } = readyState(makeHits('$.a', '$.b'));
    expect(state.size).toBe(2);

    const accepted = state.apply(
      makeReply(seq, { hits: makeHits('$.old'), total: 1 }),
      99, // 文档已演进
    );

    expect(accepted).toBe(false);
    expect(state.size).toBe(0);
    expect(state.allHits).toHaveLength(0);
    expect(state.counts).toEqual({ all: 0, key: 0, value: 0, path: 0 });
    expect(state.total).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.current).toBe(-1);
    expect(state.pending).toBe(false);
    expect(state.stale).toBe(true);
    expect(state.query).toBe('hotel'); // 查询词保留，供用户重搜
    expect(state.view().phase).toBe('stale');
  });

  it('0 命中：采纳成功、phase=ready、current=-1（无命中态）', () => {
    const state = new SearchState();
    const seq = state.begin('nothing');
    expect(state.apply(makeReply(seq, { hits: [], total: 0 }), 1)).toBe(true);

    expect(state.view().phase).toBe('ready');
    expect(state.size).toBe(0);
    expect(state.current).toBe(-1);
    expect(state.currentHit()).toBeNull();
    expect(state.counts).toEqual({ all: 0, key: 0, value: 0, path: 0 });
  });

  it('truncated 贯穿：采纳、view、过滤后仍保持；新 begin 清掉', () => {
    const hits = makeHits('$.a', ['$.b', 'value']);
    const state = new SearchState();
    const seq = state.begin('big');
    expect(
      state.apply(makeReply(seq, { hits, total: 37_189, truncated: true }), 1),
    ).toBe(true);

    expect(state.truncated).toBe(true);
    expect(state.view().truncated).toBe(true);
    expect(state.total).toBe(37_189);
    expect(state.counts.all).toBe(2); // counts 统计的是回包 hits.length（截断后）

    state.setFilter('key');
    expect(state.truncated).toBe(true);

    state.begin('other');
    expect(state.truncated).toBe(false);
  });
});

describe('SearchState — 过滤 / 计数 / 夹紧', () => {
  it('setFilter 按 field 过滤；counts 始终统计未过滤的 allHits', () => {
    const { state } = readyState(makeHits('$.a', '$.b', ['$.c', 'value']));
    expect(state.counts).toEqual({ all: 3, key: 2, value: 1, path: 0 });

    state.setFilter('key');
    expect(state.filter).toBe('key');
    expect(state.size).toBe(2);
    expect(state.hits.every((hit) => hit.field === 'key')).toBe(true);
    expect(state.counts).toEqual({ all: 3, key: 2, value: 1, path: 0 });
    expect(state.total).toBe(3);

    state.setFilter('value');
    expect(state.size).toBe(1);
    expect(state.hits[0]?.path).toBe('$.c');
    expect(state.view().filter).toBe('value');

    state.setFilter('all');
    expect(state.size).toBe(3);
    expect(state.view().filter).toBe('all');
  });

  it('path 档：counts 从 allHits 重算（all = key + value + path），path 命中只被 path/all 档保留', () => {
    const { state } = readyState(
      makeHits(
        ['$.a', 'key'],
        ['$.b.c', 'value'],
        ['$.data.hotel_list[3]', 'path'],
        ['$[0]', 'path'],
      ),
    );
    expect(state.counts).toEqual({ all: 4, key: 1, value: 1, path: 2 });
    expect(state.counts.all).toBe(
      state.counts.key + state.counts.value + state.counts.path,
    ); // 口径：从同一批 allHits 重算

    state.setFilter('path');
    expect(state.filter).toBe('path');
    expect(state.view().filter).toBe('path');
    expect(state.size).toBe(2);
    expect(state.hits.every((hit) => hit.field === 'path')).toBe(true);
    expect(state.hits.map((hit) => hit.path)).toEqual(['$.data.hotel_list[3]', '$[0]']);
    expect(state.counts).toEqual({ all: 4, key: 1, value: 1, path: 2 }); // 过滤不改 counts

    state.setFilter('value');
    expect(state.size).toBe(1);

    state.setFilter('all'); // all 档包含路径命中
    expect(state.size).toBe(4);
    expect(state.hits.some((hit) => hit.field === 'path')).toBe(true);
  });

  it('path 档无命中：size=0、current=-1；切回 all 恢复', () => {
    const { state } = readyState(makeHits('$.a', ['$.b', 'value']));
    expect(state.counts.path).toBe(0);

    state.setFilter('path');
    expect(state.size).toBe(0);
    expect(state.current).toBe(-1);

    state.setFilter('all');
    expect(state.size).toBe(2);
    expect(state.current).toBe(0);
  });

  it('path 命中参与 hitPaths；过滤到 path 档后仍保留全部未过滤路径', () => {
    const { state } = readyState(makeHits('$.a', ['$.data.hotel_list[3]', 'path']));
    expect(state.hitPaths().has('$.data.hotel_list[3]')).toBe(true);

    state.setFilter('path');
    expect(state.hits.map((hit) => hit.path)).toEqual(['$.data.hotel_list[3]']);
    expect(state.hitPaths().has('$.a')).toBe(true); // hitPaths 始终未过滤
  });

  it('setFilter 把 current 夹到 [0, size-1]；size=0 → -1；回到非空夹回 0', () => {
    const { state } = readyState(makeHits('$.a', '$.b', '$.c', ['$.d', 'value'], ['$.e', 'value']));
    state.select(4);
    expect(state.current).toBe(4);

    state.setFilter('key'); // size 3
    expect(state.current).toBe(2);

    state.setFilter('value'); // size 2
    expect(state.current).toBe(1);

    state.setFilter('key');
    state.setFilter('value');
    expect(state.current).toBe(1);
  });

  it('setFilter 后列表为空 → current=-1；再切到非空回到 0', () => {
    const { state } = readyState(makeHits(['$.v1', 'value'], ['$.v2', 'value']));
    state.setFilter('key'); // 无 key 命中
    expect(state.size).toBe(0);
    expect(state.current).toBe(-1);

    state.setFilter('value');
    expect(state.size).toBe(2);
    expect(state.current).toBe(0);
  });
});

describe('SearchState — hitPaths / indexOfPath', () => {
  it('hitPaths 是未过滤的全部命中；同一批返回同一 Set 实例，过滤不重建', () => {
    const hits = makeHits('$.a', '$.b', ['$.c', 'value']);
    const { state } = readyState(hits);

    const paths = state.hitPaths();
    expect(paths.size).toBe(3);
    expect(paths.has('$.a')).toBe(true);
    expect(paths.has('$.c')).toBe(true);
    expect(state.hitPaths()).toBe(paths); // 同批同实例

    state.setFilter('key');
    expect(state.hitPaths()).toBe(paths); // 过滤不重算/不重建
    expect(state.hitPaths().has('$.c')).toBe(true); // 未过滤

    state.setFilter('value');
    expect(state.hitPaths()).toBe(paths);
  });

  it('新一批回包后 hitPaths 是新实例', () => {
    const hits = makeHits('$.a');
    const { state } = readyState(hits);
    const first = state.hitPaths();

    const seq = state.begin('hotel2');
    state.apply(makeReply(seq, { hits: makeHits('$.b'), total: 1 }), 1);

    const second = state.hitPaths();
    expect(second).not.toBe(first);
    expect(second.has('$.b')).toBe(true);
    expect(second.has('$.a')).toBe(false);
  });

  it('indexOfPath 用未过滤命中下标；找不到 -1', () => {
    const { state } = readyState(makeHits('$.a', ['$.b', 'value'], '$.c'));

    expect(state.indexOfPath('$.a')).toBe(0);
    expect(state.indexOfPath('$.b')).toBe(1);
    expect(state.indexOfPath('$.c')).toBe(2);
    expect(state.indexOfPath('$.missing')).toBe(-1);

    state.setFilter('key'); // 过滤后 '$.b' 不在 hits 里，但 indexOfPath 仍用未过滤
    expect(state.indexOfPath('$.b')).toBe(1);
  });
});

describe('SearchState — select / next / prev', () => {
  it('select：向下取整 + 夹紧；size=0 → -1', () => {
    const { state } = readyState(makeHits('$.a', '$.b', '$.c'));

    expect(state.select(1.9)).toBe(1);
    expect(state.current).toBe(1);
    expect(state.select(-5)).toBe(0);
    expect(state.select(99)).toBe(2);

    const empty = new SearchState();
    empty.begin('q');
    expect(empty.select(3)).toBe(-1);
    expect(empty.current).toBe(-1);
  });

  it('next 环状：0→1→2→0', () => {
    const { state } = readyState(makeHits('$.a', '$.b', '$.c'));
    expect(state.current).toBe(0);
    expect(state.next()).toBe(1);
    expect(state.next()).toBe(2);
    expect(state.next()).toBe(0);
  });

  it('prev 环状：0→2→1', () => {
    const { state } = readyState(makeHits('$.a', '$.b', '$.c'));
    expect(state.prev()).toBe(2);
    expect(state.prev()).toBe(1);
    expect(state.prev()).toBe(0);
  });

  it('size=0：next/prev 均为 -1', () => {
    const { state } = readyState([]);
    expect(state.next()).toBe(-1);
    expect(state.prev()).toBe(-1);
    expect(state.current).toBe(-1);
  });
});

describe('SearchState — view / contentHeight / window', () => {
  it('view 四态：idle → searching → ready → stale', () => {
    const state = new SearchState();
    expect(state.view().phase).toBe('idle');

    const seq = state.begin('hotel');
    expect(state.view().phase).toBe('searching');

    state.apply(makeReply(seq, { hits: makeHits('$.a'), total: 1 }), 1);
    expect(state.view().phase).toBe('ready');

    state.markStale();
    expect(state.view().phase).toBe('stale');
  });

  it('view() 快照字段齐全，hits 在同一批内引用稳定', () => {
    const { state } = readyState(makeHits('$.a', ['$.b', 'value']), { total: 2 });
    const view = state.view();

    expect(view).toEqual({
      query: 'hotel',
      phase: 'ready',
      hits: state.hits,
      counts: { all: 2, key: 1, value: 1, path: 0 },
      total: 2,
      size: 2,
      current: 0,
      filter: 'all',
      truncated: false,
      caseSensitive: false,
      regex: false,
      patternError: null,
    });

    expect(state.view().hits).toBe(view.hits); // 同批同引用（面板据此判断是否回顶）
    state.setFilter('key');
    expect(state.view().hits).not.toBe(view.hits); // 过滤后是新列表

    const filteredHits = state.view().hits;
    const seq = state.begin('q2');
    state.apply(makeReply(seq, { hits: makeHits('$.c'), total: 1 }), 1);
    expect(state.view().hits).not.toBe(filteredHits); // 新批新引用（面板据此回顶）
  });

  it('contentHeight = size * rowHeight（含自定义 rowHeight）', () => {
    const { state } = readyState(makeHits('$.a', '$.b', '$.c'));
    expect(state.contentHeight()).toBe(3 * ROW_H);

    const custom = new SearchState({ rowHeight: 32 });
    const seq = custom.begin('x');
    custom.apply(makeReply(seq, { hits: makeHits('$.a', '$.b'), total: 2 }), 1);
    expect(custom.contentHeight()).toBe(2 * 32);
  });

  it('window() 委托 computeResultWindow（默认度量 + 空结果）', () => {
    const hits = Array.from({ length: 100 }, (_, index) => makeHit(`$[${index}]`));
    const { state } = readyState(hits);
    expect(state.window(0, 10)).toEqual({ start: 0, count: 18 });
    // 列表末尾：size-start 只有 4 行，count 被剩余行数夹住
    expect(state.window(100 * ROW_H, 10)).toEqual({ start: 96, count: 4 });
    expect(state.window(1_000_000, 10)).toEqual({ start: 100, count: 0 });

    const empty = new SearchState();
    expect(empty.window(0, 10)).toEqual({ start: 0, count: 0 });
  });

  it('window() 使用构造时自定义的 rowHeight / overscan', () => {
    const custom = new SearchState({ rowHeight: 32, overscan: 2 });
    const seq = custom.begin('x');
    const hits = Array.from({ length: 50 }, (_, index) => makeHit(`$[${index}]`));
    custom.apply(makeReply(seq, { hits, total: 50 }), 1);
    expect(custom.window(320, 5)).toEqual({ start: 8, count: 9 });
  });
});

describe('SearchState — markStale', () => {
  it('清空结果 + stale，返回 true；重复调用返回 false（幂等）', () => {
    const hits = makeHits('$.a', ['$.b', 'value']);
    const { state } = readyState(hits, { total: 2, truncated: true });
    const oldPaths = state.hitPaths();

    expect(state.markStale()).toBe(true);
    expect(state.stale).toBe(true);
    expect(state.pending).toBe(false);
    expect(state.view().phase).toBe('stale');
    expect(state.size).toBe(0);
    expect(state.allHits).toHaveLength(0);
    expect(state.counts).toEqual({ all: 0, key: 0, value: 0, path: 0 });
    expect(state.total).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.current).toBe(-1);
    expect(state.query).toBe('hotel'); // 查询词保留，提示「请重新搜索」
    expect(state.hitPaths().size).toBe(0);
    expect(state.hitPaths()).not.toBe(oldPaths);

    expect(state.markStale()).toBe(false); // 已经 stale + 空 → 无变化
  });

  it('pending 中的搜索被 markStale 结束：pending=false、phase=stale', () => {
    const state = new SearchState();
    state.begin('hotel');
    expect(state.pending).toBe(true);

    expect(state.markStale()).toBe(true);
    expect(state.pending).toBe(false);
    expect(state.stale).toBe(true);
    expect(state.view().phase).toBe('stale');
  });

  it('新一轮 begin 会清掉 stale', () => {
    const { state } = readyState(makeHits('$.a'));
    state.markStale();
    expect(state.stale).toBe(true);

    state.begin('again');
    expect(state.stale).toBe(false);
    expect(state.pending).toBe(true);
    expect(state.view().phase).toBe('searching');
  });
});

describe('SearchState — 选项快照（ADR-0014 §2.5）', () => {
  it('初始快照：caseSensitive=false、regex=false、patternError=null', () => {
    const state = new SearchState();
    expect(state.caseSensitive).toBe(false);
    expect(state.regex).toBe(false);
    expect(state.patternError).toBeNull();
    expect(state.view()).toMatchObject({ caseSensitive: false, regex: false, patternError: null });
  });

  it('begin(query, opts) 快照本轮选项，view() 暴露给面板回填', () => {
    const state = new SearchState();
    const seq = state.begin('hotel', { caseSensitive: true, regex: true });
    expect(state.seq).toBe(seq);
    expect(state.caseSensitive).toBe(true);
    expect(state.regex).toBe(true);
    expect(state.view()).toMatchObject({ caseSensitive: true, regex: true });
  });

  it('opts 缺省为 false；新一轮 begin 覆盖快照（开关是会话态、逐轮生效）', () => {
    const state = new SearchState();
    state.begin('a', { caseSensitive: true, regex: true });
    state.begin('b', { caseSensitive: true });
    expect(state.caseSensitive).toBe(true);
    expect(state.regex).toBe(false); // 未传 → 默认 false

    state.begin('c');
    expect(state.caseSensitive).toBe(false);
    expect(state.regex).toBe(false);
  });

  it('快照只随 begin 变：apply / setFilter / select 都不改', () => {
    const state = new SearchState();
    const seq = state.begin('hotel', { caseSensitive: true, regex: true });
    state.apply(makeReply(seq, { hits: makeHits('$.a'), total: 1 }), 1);
    state.setFilter('key');
    state.select(0);

    expect(state.caseSensitive).toBe(true);
    expect(state.regex).toBe(true);
    expect(state.view().caseSensitive).toBe(true);
    expect(state.view().regex).toBe(true);
  });
});

describe('SearchState — markPatternError（ADR-0014 §2.3）', () => {
  it('置错：清空 hits/counts/current/total/stale，phase 回 idle，query 保留', () => {
    const { state } = readyState(makeHits('$.a', ['$.b', 'value']), { total: 2, truncated: true });
    expect(state.size).toBe(2);

    state.markPatternError('该正则可能触发灾难性回溯');

    expect(state.patternError).toBe('该正则可能触发灾难性回溯');
    expect(state.view().phase).toBe('idle');
    expect(state.size).toBe(0);
    expect(state.allHits).toHaveLength(0);
    expect(state.counts).toEqual({ all: 0, key: 0, value: 0, path: 0 });
    expect(state.total).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.current).toBe(-1);
    expect(state.currentHit()).toBeNull();
    expect(state.stale).toBe(false);
    expect(state.pending).toBe(false);
    expect(state.query).toBe('hotel'); // 查询词保留，用户可继续编辑
    expect(state.hitPaths().size).toBe(0);
  });

  it('markPatternError(null) 只清错误，不动查询与结果', () => {
    const state = new SearchState();
    state.begin('hotel');
    state.markPatternError('正则语法错误：x');
    expect(state.view().phase).toBe('idle');

    state.markPatternError(null);
    expect(state.patternError).toBeNull();
    expect(state.view().patternError).toBeNull();
    expect(state.view().phase).toBe('idle');
    expect(state.query).toBe('hotel');
  });

  it("begin('') 清除错误（清空查询回到空闲态）", () => {
    const state = new SearchState();
    state.begin('(', { regex: true });
    state.markPatternError('正则语法错误：x');

    state.begin('');
    expect(state.patternError).toBeNull();
    expect(state.view().phase).toBe('idle');
    expect(state.view().patternError).toBeNull();
  });

  it('新一轮 begin（编辑查询 / 切开关后重跑）清除错误', () => {
    const state = new SearchState();
    state.begin('(', { regex: true });
    state.markPatternError('该正则可能触发灾难性回溯');

    state.begin('(a', { regex: true });
    expect(state.patternError).toBeNull();
    expect(state.view().phase).toBe('searching');
  });

  it('clear() 清除错误', () => {
    const state = new SearchState();
    state.begin('(', { regex: true });
    state.markPatternError('正则语法错误：x');

    state.clear();
    expect(state.patternError).toBeNull();
    expect(state.view().phase).toBe('idle');
  });

  it('apply 成功清除错误（回包采纳后不再显示错误行）', () => {
    const state = new SearchState();
    const seq = state.begin('a+', { regex: true });
    state.markPatternError('该正则可能触发灾难性回溯');
    expect(state.view().phase).toBe('idle');

    const accepted = state.apply(makeReply(seq, { hits: makeHits('$.a'), total: 1 }), 1);
    expect(accepted).toBe(true);
    expect(state.patternError).toBeNull();
    expect(state.view().phase).toBe('ready');
    expect(state.size).toBe(1);
  });

  it('apply 的 docRevision 过期分支同样清错误（结果已清空、转入 stale）', () => {
    const state = new SearchState();
    const seq = state.begin('a+', { regex: true });
    state.markPatternError('该正则可能触发灾难性回溯');

    expect(state.apply(makeReply(seq, { hits: makeHits('$.a'), total: 1 }), 99)).toBe(false);
    expect(state.patternError).toBeNull();
    expect(state.view().phase).toBe('stale');
    expect(state.size).toBe(0);
  });

  it('seq 过期的回包不改任何状态：错误态保持不变', () => {
    const state = new SearchState();
    const staleSeq = state.begin('a');
    state.begin('(', { regex: true });
    state.markPatternError('正则语法错误：x');

    expect(state.apply(makeReply(staleSeq, { hits: makeHits('$.a'), total: 1 }), 1)).toBe(false);
    expect(state.patternError).toBe('正则语法错误：x');
    expect(state.view().phase).toBe('idle');
  });
});
