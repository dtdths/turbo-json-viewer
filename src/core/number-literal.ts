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

/**
 * 字面量是否严格符合 **JSON 数字语法**（`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`）。
 *
 * 动机（Standards 审查收口）：表达式引擎里的数字字面量是 **JS** 语法，acorn 还接受
 * `1_000`（数字分隔符）、`0x1f`/`0o17`/`0b1010`、sloppy legacy octal `0777`（真值 511）。
 * 这些写法**不能**喂给 `analyzeNumberLiteral`（它只认 JSON 语法）——否则 `1_000` 会落到
 * `Number('1_000') = NaN`、`0777` 会被当十进制 777。只有严格 JSON 语法的字面量才走无损判定，
 * 其余保持 acorn 的 `node.value`（JS 语义）。分隔符与合法 JSON 前缀不重叠，无需先剥 `_`。
 */
export function isJsonNumberLiteral(lit: string): boolean {
  let i = 0;
  const len = lit.length;
  if (lit.charCodeAt(i) === CH_MINUS) i += 1;
  if (i >= len) return false;
  const first = lit.charCodeAt(i);
  if (first === CH_0) {
    i += 1;
    // JSON 不允许前导零（后面不能紧跟数字；`.`/`e`/结束都合法）
    if (i < len && isDigit(lit.charCodeAt(i))) return false;
  } else if (first >= 49 && first <= 57) {
    i += 1;
    while (i < len && isDigit(lit.charCodeAt(i))) i += 1;
  } else {
    return false;
  }
  if (i < len && lit.charCodeAt(i) === CH_DOT) {
    i += 1;
    const dotStart = i;
    while (i < len && isDigit(lit.charCodeAt(i))) i += 1;
    if (i === dotStart) return false; // `1.` 非法
  }
  if (i < len) {
    const e = lit.charCodeAt(i);
    if (e === CH_E_UPPER || e === CH_E_LOWER) {
      i += 1;
      if (i < len && (lit.charCodeAt(i) === CH_PLUS || lit.charCodeAt(i) === CH_MINUS)) i += 1;
      const expStart = i;
      while (i < len && isDigit(lit.charCodeAt(i))) i += 1;
      if (i === expStart) return false;
    }
  }
  return i === len;
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
