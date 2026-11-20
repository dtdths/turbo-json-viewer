import { describe, expect, it } from 'vitest';
import {
  INCOMING_HASH_PREFIX,
  SUSPECTED_TRUNCATED_CHARS,
  incomingTokenFromHash,
  suspectedTruncated,
  takeIncoming,
} from '../../../src/app/incoming-selection';
import type { IncomingStore } from '../../../src/shared/incoming';
import { INCOMING_KEY_PREFIX } from '../../../src/app/selection-intake';

interface FakeStore extends IncomingStore {
  bag: Map<string, unknown>;
  removed: string[];
  failGet?: boolean;
  failRemove?: boolean;
}

function store(initial: Record<string, unknown> = {}): FakeStore {
  const bag = new Map(Object.entries(initial));
  const s: FakeStore = {
    bag,
    removed: [],
    get: async (key) => {
      if (s.failGet) throw new Error('boom');
      return bag.has(key) ? { [key]: bag.get(key) } : {};
    },
    remove: async (key) => {
      if (s.failRemove) throw new Error('boom');
      s.removed.push(key);
      bag.delete(key);
    },
  };
  return s;
}

describe('incoming-selection · hash 解析', () => {
  it('只认 #incoming=<安全 token>，其余当没有', () => {
    expect(incomingTokenFromHash(`${INCOMING_HASH_PREFIX}0f8fad5b-d9cb-469f-a165-70867728950e`)).toBe(
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    );
    expect(incomingTokenFromHash('')).toBeNull();
    expect(incomingTokenFromHash('#other=1')).toBeNull();
    expect(incomingTokenFromHash(`${INCOMING_HASH_PREFIX}short`)).toBeNull();
    expect(incomingTokenFromHash(`${INCOMING_HASH_PREFIX}../../tjv.settings.v1`)).toBeNull();
  });
});

describe('incoming-selection · 取一次 token', () => {
  it('正常文本：返回 import 并删除条目（单次使用）', async () => {
    const s = store({ [`${INCOMING_KEY_PREFIX}abc12345`]: { kind: 'text', text: '{"a":1}', createdAt: 1 } });
    expect(await takeIncoming(s, 'abc12345')).toEqual({ kind: 'import', text: '{"a":1}', mode: 'view' });
    expect(s.bag.has(`${INCOMING_KEY_PREFIX}abc12345`)).toBe(false);
    expect(s.removed).toEqual([`${INCOMING_KEY_PREFIX}abc12345`]);
  });

  it('下载模式的 token 原样带出 mode', async () => {
    const s = store({ [`${INCOMING_KEY_PREFIX}abc12345`]: { kind: 'text', text: '{"a":1}', mode: 'download' } });
    expect(await takeIncoming(s, 'abc12345')).toEqual({
      kind: 'import',
      text: '{"a":1}',
      mode: 'download',
    });
  });

  it('错误 token：返回 error，同样删掉条目', async () => {
    const s = store({
      [`${INCOMING_KEY_PREFIX}abc12345`]: { kind: 'error', error: 'too-large', createdAt: 1 },
    });
    expect(await takeIncoming(s, 'abc12345')).toEqual({ kind: 'error', code: 'too-large' });
    expect(s.bag.size).toBe(0);
  });

  it('不存在 / 已消费：返回 null（刷新不应报错）', async () => {
    const s = store();
    expect(await takeIncoming(s, 'abc12345')).toBeNull();
    expect(await takeIncoming(null, 'abc12345')).toBeNull();
  });

  it('未知形状 / 读取异常：返回 null（不抛）', async () => {
    const s = store({ [`${INCOMING_KEY_PREFIX}abc12345`]: { kind: 'weird' } });
    expect(await takeIncoming(s, 'abc12345')).toBeNull();
    const broken = store({ [`${INCOMING_KEY_PREFIX}abc12345`]: { kind: 'text', text: '{}' } });
    broken.failGet = true;
    expect(await takeIncoming(broken, 'abc12345')).toBeNull();
  });

  it('删除失败不影响本次导入（SW 的 TTL 清理兜底）', async () => {
    const s = store({ [`${INCOMING_KEY_PREFIX}abc12345`]: { kind: 'text', text: '{"a":1}' } });
    s.failRemove = true;
    expect(await takeIncoming(s, 'abc12345')).toEqual({ kind: 'import', text: '{"a":1}', mode: 'view' });
  });
});

describe('incoming-selection · 截断判定', () => {
  it('长度达到阈值才提示「可能被截断」', () => {
    expect(suspectedTruncated('x'.repeat(SUSPECTED_TRUNCATED_CHARS - 1))).toBe(false);
    expect(suspectedTruncated('x'.repeat(SUSPECTED_TRUNCATED_CHARS))).toBe(true);
  });
});
