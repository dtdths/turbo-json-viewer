import { describe, expect, it } from 'vitest';
import {
  ROOT_PATH,
  appendIndex,
  appendKey,
  depthOf,
  formatPath,
  isIdentifierKey,
  lastSegment,
  parentPath,
  parsePath,
} from '../../../src/shared/path';

describe('shared/path', () => {
  it('formats root and identifier keys', () => {
    expect(ROOT_PATH).toBe('$');
    expect(appendKey(ROOT_PATH, 'data')).toBe('$.data');
    expect(appendKey(appendKey(ROOT_PATH, 'data'), 'hotel_list')).toBe('$.data.hotel_list');
  });

  it('uses bracket form for non-identifier keys and escapes quotes', () => {
    expect(isIdentifierKey('a-b')).toBe(false);
    expect(appendKey(ROOT_PATH, 'a b')).toBe("$['a b']");
    expect(appendKey(ROOT_PATH, "o'brien")).toBe("$['o\\'brien']");
    expect(parsePath("$['o\\'brien']")).toEqual([{ kind: 'key', key: "o'brien" }]);
  });

  it('formats array indices', () => {
    const p = appendIndex(appendKey(appendKey(ROOT_PATH, 'data'), 'hotel_list'), 1234);
    expect(p).toBe('$.data.hotel_list[1234]');
    expect(parsePath(p)).toEqual([
      { kind: 'key', key: 'data' },
      { kind: 'key', key: 'hotel_list' },
      { kind: 'index', index: 1234 },
    ]);
  });

  it('round-trips parse -> format', () => {
    const paths = ['$', '$.a', '$.a.b', "$['a b'].c", '$.arr[0].x', "$.x['y z'][3]"];
    for (const p of paths) expect(formatPath(parsePath(p))).toBe(p);
  });

  it('derives parent, last segment and depth', () => {
    expect(parentPath('$.a.b[2]')).toBe('$.a.b');
    expect(parentPath('$')).toBeNull();
    expect(lastSegment('$.a.b[2]')).toEqual({ kind: 'index', index: 2 });
    expect(depthOf('$.a.b[2]')).toBe(3);
  });
});
