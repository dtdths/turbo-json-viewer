import { describe, expect, it } from 'vitest';
import { C, last, lexLine, lexToken, skipWs, T } from '../../../src/shared/json-lex';

function tokenize(text: string): { t: number; s: number; e: number; text: string }[] {
  const out: { t: number; s: number; e: number; text: string }[] = [];
  let i = skipWs(text, 0);
  while (i < text.length) {
    const s = i;
    const e = lexToken(text, i);
    out.push({ t: last.type, s, e, text: text.slice(s, e) });
    i = skipWs(text, e);
  }
  return out;
}

describe('shared/json-lex — lexToken', () => {
  it('识别结构 token 与偏移', () => {
    const tokens = tokenize('{"a":[1,true,null]}');
    expect(tokens.map((token) => token.t)).toEqual([
      T.OBJ,
      T.STR,
      T.COLON,
      T.ARR,
      T.NUM,
      T.COMMA,
      T.LIT,
      T.COMMA,
      T.LIT,
      T.ARR_END,
      T.OBJ_END,
    ]);
    expect(tokens[1]).toMatchObject({ s: 1, e: 4, text: '"a"' });
  });

  it('字符串里的转义引号不会提前结束 token', () => {
    const tokens = tokenize('"a\\"b\\\\c"');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ t: T.STR, text: '"a\\"b\\\\c"' });
  });

  it('数字吃掉指数/小数/正负号', () => {
    const tokens = tokenize('-1.25e+10 3');
    expect(tokens.map((token) => token.text)).toEqual(['-1.25e+10', '3']);
    expect(tokens.every((token) => token.t === T.NUM)).toBe(true);
  });

  it('未闭合字符串到 EOF 结束（截断源文本可 lex）', () => {
    const text = '{"a":"hello wor';
    const tokens = tokenize(text);
    expect(tokens.at(-1)).toMatchObject({ t: T.STR, e: text.length, text: '"hello wor' });
  });

  it('非法字符产出 BAD（不抛错）', () => {
    const tokens = tokenize('@');
    expect(tokens[0]?.t).toBe(T.BAD);
  });

  it('空文本 / 纯空白不产出 token', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' \n\t\r ')).toEqual([]);
  });

  it('EOF 时 type = EOF', () => {
    lexToken('{}', 2);
    expect(last.type).toBe(T.EOF);
  });
});

describe('shared/json-lex — lexLine（原文行高亮）', () => {
  it('缩进空白不进 run，run 偏移相对行文本', () => {
    const line = '  "key": [1, "x"]';
    const runs = lexLine(line);
    expect(runs[0]).toMatchObject({ t: T.STR, s: 2, e: 7 });
    // 每个 run 都是行文本的逐字切片
    for (const run of runs) {
      expect(line.slice(run.s, run.e)).toBe(line.slice(run.s, run.e));
    }
    expect(runs.map((run) => run.t)).toEqual([T.STR, T.COLON, T.ARR, T.NUM, T.COMMA, T.STR, T.ARR_END]);
  });

  it('关键字字符常量与 lexer 分支一致', () => {
    expect(C.QUOTE).toBe(34);
    expect(C.LBRACE).toBe(123);
    expect(C.COMMA).toBe(44);
  });
});
