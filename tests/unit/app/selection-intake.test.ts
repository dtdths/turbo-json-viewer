import { describe, expect, it } from 'vitest';
import {
  INCOMING_KEY_PREFIX,
  INCOMING_MENU_ID,
  INCOMING_TTL_MS,
  SELECTION_MAX_CHARS,
  deliverSelection,
  isJsonCandidate,
  type SelectionIntakePort,
} from '../../../src/app/selection-intake';

interface FakePort extends SelectionIntakePort {
  bag: Map<string, unknown>;
  opened: string[];
  removed: string[][];
  failNextSet: boolean;
}

function port(now = 1_000): FakePort {
  const bag = new Map<string, unknown>();
  let uuidSeq = 0;
  const p: FakePort = {
    bag,
    opened: [],
    removed: [],
    failNextSet: false,
    storage: {
      get: async (keys) => {
        if (keys === null) return Object.fromEntries(bag);
        return keys in Object.fromEntries(bag) ? { [keys]: bag.get(keys) } : {};
      },
      set: async (items) => {
        if (p.failNextSet) {
          p.failNextSet = false;
          throw new Error('quota');
        }
        for (const [key, value] of Object.entries(items)) bag.set(key, value);
      },
      remove: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        p.removed.push(list);
        for (const key of list) bag.delete(key);
      },
    },
    open: (token) => p.opened.push(token),
    uuid: () => `uuid-${++uuidSeq}`,
    now: () => now,
  };
  return p;
}

describe('selection-intake · 候选判定', () => {
  it('只认以 { 或 [ 开头、长度够的选区', () => {
    expect(isJsonCandidate('{"a":1}')).toBe(false); // 太短
    expect(isJsonCandidate('   {"a": 1, "b": 2}  ')).toBe(true);
    expect(isJsonCandidate('[1,2,3,4,5,6,7,8]')).toBe(true);
    expect(isJsonCandidate('some prose that is long enough')).toBe(false);
    expect(isJsonCandidate('42, 43, 44, 45, 46, 47')).toBe(false);
  });
});

describe('selection-intake · 投递', () => {
  it('正常选区：写 token（trim、createdAt）并开页', async () => {
    const p = port(5_000);
    await deliverSelection(p, '  {"a":1,"b":2,"c":3}  ');
    expect(p.opened).toEqual(['uuid-1']);
    expect(p.bag.get(`${INCOMING_KEY_PREFIX}uuid-1`)).toEqual({
      text: '{"a":1,"b":2,"c":3}',
      createdAt: 5_000,
    });
  });

  it('不像 JSON 也投递错误 token（点了要有反馈）', async () => {
    const p = port();
    await deliverSelection(p, 'just some ordinary prose selection');
    expect(p.opened).toHaveLength(1);
    expect(p.bag.get(`${INCOMING_KEY_PREFIX}uuid-1`)).toEqual({ error: 'not-json', createdAt: 1_000 });
  });

  it('超过字符上限按 too-large 处理（不把大文本写进 storage）', async () => {
    const p = port();
    const big = `{${'1'.repeat(SELECTION_MAX_CHARS)}}`;
    await deliverSelection(p, big);
    expect(p.bag.get(`${INCOMING_KEY_PREFIX}uuid-1`)).toEqual({ error: 'too-large', createdAt: 1_000 });
  });

  it('清理超时残留，只碰自己的前缀', async () => {
    const now = 100 * INCOMING_TTL_MS;
    const p = port(now);
    p.bag.set(`${INCOMING_KEY_PREFIX}old`, { text: '{}', createdAt: now - INCOMING_TTL_MS - 1 });
    p.bag.set(`${INCOMING_KEY_PREFIX}fresh`, { text: '{}', createdAt: now - 1 });
    p.bag.set('tjv.settings.v1', { keep: true });
    await deliverSelection(p, '{"a":1,"b":2,"c":3}');
    expect(p.bag.has(`${INCOMING_KEY_PREFIX}old`)).toBe(false);
    expect(p.bag.has(`${INCOMING_KEY_PREFIX}fresh`)).toBe(true);
    expect(p.bag.has('tjv.settings.v1')).toBe(true);
    expect(p.removed).toEqual([[`${INCOMING_KEY_PREFIX}old`]]);
  });

  it('写 token 失败时退化成 too-large 错误 token，仍然开页', async () => {
    const p = port();
    p.failNextSet = true;
    await deliverSelection(p, '{"a":1,"b":2,"c":3}');
    expect(p.bag.get(`${INCOMING_KEY_PREFIX}uuid-1`)).toEqual({ error: 'too-large', createdAt: 1_000 });
    expect(p.opened).toHaveLength(1);
  });

  it('菜单 id 是稳定字符串（SW 与文档共用）', () => {
    expect(INCOMING_MENU_ID).toBe('tjv-open-selection');
  });
});
