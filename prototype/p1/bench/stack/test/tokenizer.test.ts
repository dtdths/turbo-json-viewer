import { describe, expect, it } from 'vitest';
import { tokenizeJsonLine } from '../src/tokenizer';

const types = (line: string) => tokenizeJsonLine(line).map((t) => t.type);
const slice = (line: string) => tokenizeJsonLine(line).map((t) => line.slice(t.start, t.end));

describe('tokenizeJsonLine', () => {
  it('splits a key/value line', () => {
    expect(types('  "a": 1,')).toEqual(['ws', 'key', 'punct', 'ws', 'number', 'punct']);
  });
  it('distinguishes keys from string values', () => {
    expect(types('"hotel_tags": ["x", "y"]')).toEqual([
      'key', 'punct', 'ws', 'punct', 'string', 'punct', 'ws', 'string', 'punct',
    ]);
  });
  it('handles escapes inside strings', () => {
    expect(slice('"a\\"b": "c\\\\d"')).toEqual(['"a\\"b"', ':', ' ', '"c\\\\d"']);
  });
  it('flags unterminated strings instead of throwing', () => {
    expect(types('"never closed')).toEqual(['error']);
  });
  it('recognizes booleans/null and numbers with exponents', () => {
    expect(types('true')).toEqual(['literal']);
    expect(types('null')).toEqual(['literal']);
    expect(types('-1.5e+10')).toEqual(['number']);
  });
  it('is linear: 10k tokens under 50ms (sanity, not a benchmark)', () => {
    const line = '    "some_field_name": "some value with \\"escape\\" inside",';
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 10_000; i++) n += tokenizeJsonLine(line).length;
    const ms = performance.now() - t0;
    expect(n).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });
});
