import { describe, expect, it } from 'vitest';
import { analyzeNumberLiteral, BIGINT_DIGIT_CAP, MAX_SAFE_BIGINT } from '../../../src/core/number-literal';

describe('number-literal — 无损数字判定（ADR-0020 §4.1）', () => {
  it('安全范围内的整数 → number（精确）', () => {
    expect(analyzeNumberLiteral('0').value).toBe(0);
    expect(analyzeNumberLiteral('1').value).toBe(1);
    expect(analyzeNumberLiteral('-1').value).toBe(-1);
    expect(analyzeNumberLiteral('9007199254740991').value).toBe(9007199254740991);
    expect(analyzeNumberLiteral('-9007199254740991').value).toBe(-9007199254740991);
    expect(analyzeNumberLiteral('1e15').value).toBe(1e15);
    expect(analyzeNumberLiteral('1.5e1').value).toBe(15); // 数值上是整数
  });

  it('超安全范围的整数 → BigInt 精确值（不是 double）', () => {
    expect(analyzeNumberLiteral('9007199254740992').value).toBe(9007199254740992n);
    expect(analyzeNumberLiteral('1234567890123456789').value).toBe(1234567890123456789n);
    expect(analyzeNumberLiteral('297532588187238660').value).toBe(297532588187238660n);
    expect(analyzeNumberLiteral('-297532588187238660').value).toBe(-297532588187238660n);
    // 2^53+1：double 无法精确表示
    expect(analyzeNumberLiteral('9007199254740993').value).toBe(9007199254740993n);
  });

  it('带指数但数值上是整数 → 精确 BigInt（1e400 是 10^400，不是 Infinity）', () => {
    const info = analyzeNumberLiteral('1e400');
    expect(info.integerValued).toBe(true);
    expect(info.overflow).toBe(false);
    expect(info.value).toBe(10n ** 400n);
    expect(analyzeNumberLiteral('1.5e1').value).toBe(15);
    expect(analyzeNumberLiteral('1234567890123456789e0').value).toBe(1234567890123456789n);
  });

  it('整数展开位数超过 BIGINT_DIGIT_CAP → Infinity 语义（overflow，防内存炸弹）', () => {
    const over = analyzeNumberLiteral('1e10001'); // 10002 位 > 10000
    expect(over.integerValued).toBe(true);
    expect(over.value).toBeNull();
    expect(over.overflow).toBe(true);
    expect(over.underflow).toBe(false);
    // 恰好等于上限：1e9999 → 10000 位，允许 BigInt
    const atCap = analyzeNumberLiteral('1e9999');
    expect(atCap.overflow).toBe(false);
    expect(typeof atCap.value).toBe('bigint');
    expect((atCap.value as bigint).toString().length).toBe(BIGINT_DIGIT_CAP);
  });

  it('非整数小数 → Number（与 JSON.parse 一致），高精度小数不无损（已知差距）', () => {
    expect(analyzeNumberLiteral('0.5').value).toBe(0.5);
    expect(analyzeNumberLiteral('0.1234567890123456789').value).toBe(0.1234567890123456789);
    expect(analyzeNumberLiteral('1.5e-3').value).toBe(1.5e-3);
    expect(analyzeNumberLiteral('1e-3').integerValued).toBe(false);
  });

  it('整数型大数（含小数写法）按 BigInt 精确；非整数大数/小数上溢下溢按 Number 语义报类别', () => {
    // 1.5e400 = 15 × 10^399，数值上是整数 → BigInt 精确（不是 Infinity）
    const big = analyzeNumberLiteral('1.5e400');
    expect(big.integerValued).toBe(true);
    expect(big.value).toBe(15n * 10n ** 399n);
    expect(big.overflow).toBe(false);

    // 真正的非整数上溢：401 位整数部分 + 小数（Number 会变 Infinity）
    const nonIntegerOverflow = analyzeNumberLiteral('1' + '0'.repeat(400) + '.5');
    expect(nonIntegerOverflow.integerValued).toBe(false);
    expect(nonIntegerOverflow.value).toBe(Infinity);
    expect(nonIntegerOverflow.overflow).toBe(true);

    const underflow = analyzeNumberLiteral('1e-400');
    expect(underflow.value).toBe(0);
    expect(underflow.underflow).toBe(true);
    expect(analyzeNumberLiteral('0.0').underflow).toBe(false);
    expect(analyzeNumberLiteral('0e400').underflow).toBe(false);
  });

  it('零保留 -0 的符号', () => {
    expect(Object.is(analyzeNumberLiteral('-0').value, -0)).toBe(true);
    expect(Object.is(analyzeNumberLiteral('-0.0').value, -0)).toBe(true);
    expect(Object.is(analyzeNumberLiteral('0').value, 0)).toBe(true);
  });

  it('非法文本宽容兜底（不抛）', () => {
    expect(() => analyzeNumberLiteral('abc')).not.toThrow();
    expect(() => analyzeNumberLiteral('')).not.toThrow();
  });

  it('MAX_SAFE_BIGINT 常量与 Number.MAX_SAFE_INTEGER 对齐', () => {
    expect(MAX_SAFE_BIGINT).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });
});
