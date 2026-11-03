import { describe, expect, it } from 'vitest';
import { CH, JsonLexer, TOK, type HighlightRun } from '../../../src/shared/json-lex';

function tokenize(text: string): { t: number; s: number; e: number; text: string }[] {
  const lex = new JsonLexer();
  const out: { t: number; s: number; e: number; text: string }[] = [];
  let i = lex.skipWs(text, 0);
  while (i < text.length) {
    const s = i;
    const e = lex.lexToken(text, i);
    out.push({ t: lex.last.type, s, e, text: text.slice(s, e) });
    i = lex.skipWs(text, e);
  }
  return out;
}

describe('shared/json-lex — lexToken', () => {
  it('识别结构 token 与偏移', () => {
    const tokens = tokenize('{"a":[1,true,null]}');
    expect(tokens.map((token) => token.t)).toEqual([
      TOK.OBJ,
      TOK.STR,
      TOK.COLON,
      TOK.ARR,
      TOK.NUM,
      TOK.COMMA,
      TOK.LIT,
      TOK.COMMA,
      TOK.LIT,
      TOK.ARR_END,
      TOK.OBJ_END,
    ]);
    expect(tokens[1]).toMatchObject({ s: 1, e: 4, text: '"a"' });
  });

  it('字符串里的转义引号不会提前结束 token', () => {
    const tokens = tokenize('"a\\"b\\\\c"');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ t: TOK.STR, text: '"a\\"b\\\\c"' });
  });

  it('数字吃掉指数/小数/正负号', () => {
    const tokens = tokenize('-1.25e+10 3');
    expect(tokens.map((token) => token.text)).toEqual(['-1.25e+10', '3']);
    expect(tokens.every((token) => token.t === TOK.NUM)).toBe(true);
  });

  it('未闭合字符串到 EOF 结束（截断源文本可 lex）', () => {
    const text = '{"a":"hello wor';
    const tokens = tokenize(text);
    expect(tokens.at(-1)).toMatchObject({ t: TOK.STR, e: text.length, text: '"hello wor' });
  });

  it('非法字符产出 BAD（不抛错）', () => {
    const tokens = tokenize('@');
    expect(tokens[0]?.t).toBe(TOK.BAD);
  });

  it('空文本 / 纯空白不产出 token', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' \n\t\r ')).toEqual([]);
  });

  it('EOF 时 type = EOF', () => {
    const lex = new JsonLexer();
    lex.lexToken('{}', 2);
    expect(lex.last.type).toBe(TOK.EOF);
  });

  it('lexer 状态是实例字段：两个实例互不串味（shared 无模块状态）', () => {
    const a = new JsonLexer();
    const b = new JsonLexer();
    a.lexToken('"a"', 0);
    expect(a.last.type).toBe(TOK.STR);
    b.lexToken('12', 0);
    expect(b.last.type).toBe(TOK.NUM);
    expect(a.last.type).toBe(TOK.STR);
  });
});

describe('shared/json-lex — lexLine（原文行高亮）', () => {
  it('缩进空白不进 run，run 偏移相对行文本', () => {
    const line = '  "key": [1, "x"]';
    const lex = new JsonLexer();
    const runs: HighlightRun[] = lex.lexLine(line);
    expect(runs[0]).toMatchObject({ t: TOK.STR, s: 2, e: 7 });
    // 每个 run 的偏移都落在行文本范围内
    for (const run of runs) {
      expect(run.s).toBeGreaterThanOrEqual(0);
      expect(run.e).toBeLessThanOrEqual(line.length);
      expect(run.e).toBeGreaterThan(run.s);
    }
    expect(runs.map((run) => run.t)).toEqual([
      TOK.STR,
      TOK.COLON,
      TOK.ARR,
      TOK.NUM,
      TOK.COMMA,
      TOK.STR,
      TOK.ARR_END,
    ]);
  });

  it('关键字字符常量与 lexer 分支一致', () => {
    expect(CH.QUOTE).toBe(34);
    expect(CH.LBRACE).toBe(123);
    expect(CH.COMMA).toBe(44);
  });
});
