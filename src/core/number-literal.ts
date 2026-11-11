/**
 * core/number-literal — JSON 数字字面量的**无损判定**（ADR-0020）。
 *
 * 单一来源：解析器（`lossless-json`）与保真扫描（`fidelity`）共用同一套规则，
 * 禁止两处各写一份（否则「parser 认为无损、保真报告认为失真」这类漂移无从发现）。
 *
 * 口径（ADR-0020 §4.1）：
 *   - 数值上是整数（含 `1.5e1` = 15、`1e400`）且超出安全整数范围 → `BigInt` 精确值；
 *   - 其余（安全整数、小数）→ `Number`（与 `JSON.parse` 完全一致）；
 *   - 整数展开位数 > `BIGINT_DIGIT_CAP` → 按 `JSON.parse` 语义变 `Infinity`（防内存炸弹）；
 *   - 非整数小数的上溢/下溢仍按 `Number` 语义（`1.5e400` → Infinity、`1e-400` → 0）。
 *
 * 高精度**小数**（`0.1234567890123456789`）不做无损（已知差距，ADR-0020 §8）：
 * 它们走 `Number`，精度仍丢且不检测。
 */

/** 整数按 BigInt 精确表示的最大展开位数；超过按 JSON.parse 语义变 Infinity */
export const BIGINT_DIGIT_CAP = 10_000;

/** 2^53−1：JS 安全整数上界（`Number.MAX_SAFE_INTEGER` 的 BigInt 形态） */
export const MAX_SAFE_BIGINT = 9_007_199_254_740_991n;

export interface NumberLiteralInfo {
  /** 数值上是整数（含 `1.5e1` = 15、`1e400`；不含 `1e-3`、`0.5`） */
  integerValued: boolean;
  /** number（安全整数/小数，含 ±Infinity）| bigint（超安全范围整数）| null（整数超展开位数上限） */
  value: number | bigint | null;
  /** true = 本字面量按 JSON.parse 会得到 Infinity（整数超 cap） */
  overflow: boolean;
  /** true = 非整数小数按 Number 变 0 但有效数字非零（下溢，如 1e-400） */
  underflow: boolean;
}

const CH_MINUS = 45;
const CH_PLUS = 43;
const CH_DOT = 46;
const CH_0 = 48;
const CH_9 = 57;
const CH_E_UPPER = 69;
const CH_E_LOWER = 101;

function isDigit(c: number): boolean {
  return c >= CH_0 && c <= CH_9;
}

interface Normalized {
  negative: boolean;
  /** 去掉前导零与尾随零后的有效数字（全零时为空串） */
  digits: string;
  /** 十进制指数：value = digits × 10^exp */
  exp: number;
}

/**
 * 十进制规范化：`-0.00120e+3` → `{negative:true, digits:'12', exp:-2}`（= -0.012 × 10^? 见实现）。
 * 非法文本返回 null（调用方应已做语法校验；这里只做宽容兜底，不抛错）。
 *
 * 语义与 `JSON.parse` 的数值解释一致：digits 去掉前导零与尾随零后，
 * `exp` 已把尾随零并入 10 的幂（所以 `1.50` → digits '15'、exp -1）。
 */
function normalizeDecimal(lit: string): Normalized | null {
  let i = 0;
  let negative = false;
  if (lit.charCodeAt(i) === CH_MINUS) {
    negative = true;
    i += 1;
  }
  const intStart = i;
  while (i < lit.length && isDigit(lit.charCodeAt(i))) i += 1;
  const intPart = lit.slice(intStart, i);

  let fracPart = '';
  if (lit.charCodeAt(i) === CH_DOT) {
    i += 1;
    const fracStart = i;
    while (i < lit.length && isDigit(lit.charCodeAt(i))) i += 1;
    fracPart = lit.slice(fracStart, i);
  }

  let exp = 0;
  const e = lit.charCodeAt(i);
  if (e === CH_E_UPPER || e === CH_E_LOWER) {
    i += 1;
    let expSign = 1;
    if (lit.charCodeAt(i) === CH_PLUS) i += 1;
    else if (lit.charCodeAt(i) === CH_MINUS) {
      expSign = -1;
      i += 1;
    }
    let raw = 0;
    let digitsCount = 0;
    while (i < lit.length && isDigit(lit.charCodeAt(i))) {
      raw = raw * 10 + (lit.charCodeAt(i) - CH_0);
      i += 1;
      digitsCount += 1;
    }
    if (digitsCount === 0) return null;
    exp = expSign * raw;
  }

  if (i !== lit.length || (intPart === '' && fracPart === '')) return null;

  let digits = (intPart + fracPart).replace(/^0+/, '');
  let power = exp - fracPart.length;
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === CH_0) end -= 1;
  power += digits.length - end;
  digits = digits.slice(0, end);
  return { negative, digits, exp: power };
}

/**
 * 判定一个**合法** JSON 数字字面量的无损表示（ADR-0020 §4.1）。
 *
 * 注意 `value` 的三种形态：`number`（含 ±Infinity）、`bigint`、`null`（整数超 cap）。
 * parser 对 `null` 必须产出 `Infinity`（与 `JSON.parse` 一致，且保真报告报 overflow）。
 */
export function analyzeNumberLiteral(lit: string): NumberLiteralInfo {
  const n = normalizeDecimal(lit);
  if (n === null) {
    // 非法文本：宽容兜底（真正语法错误由 parser 在更早的阶段报）
    return { integerValued: false, value: Number(lit), overflow: false, underflow: false };
  }
  const { negative, digits, exp } = n;

  // 零（`0` / `-0` / `0.0` / `0e5`）：Number 保留 -0 的符号
  if (digits === '') {
    return { integerValued: true, value: Number(lit), overflow: false, underflow: false };
  }

  if (exp >= 0) {
    // 整数型：展开位数 = 有效数字位数 + 指数
    if (digits.length + exp > BIGINT_DIGIT_CAP) {
      return { integerValued: true, value: null, overflow: true, underflow: false };
    }
    let exact = BigInt(digits) * 10n ** BigInt(exp);
    if (negative) exact = -exact;
    if (exact >= -MAX_SAFE_BIGINT && exact <= MAX_SAFE_BIGINT) {
      return { integerValued: true, value: Number(exact), overflow: false, underflow: false };
    }
    return { integerValued: true, value: exact, overflow: false, underflow: false };
  }

  // 非整数（含指数为负的写法）：与 JSON.parse 完全一致的 Number 语义
  const value = Number(lit);
  return {
    integerValued: false,
    value,
    overflow: !Number.isFinite(value),
    underflow: value === 0,
  };
}
