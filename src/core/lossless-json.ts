/**
 * core/lossless-json — 无损 JSON 解析 / 序列化 / 深相等（ADR-0020）。
 *
 * 为什么自研：`JSON.parse` 会把超出安全整数范围的整数圆整（`297532588187238660` → double
 * `...656`，而 JS 打印又恰好回到 `...660`），信息一旦丢弃就无法后处理补救。ADR-0003 曾以
 * 「失去 V8 快路径 + 要自定义 -0/1e400 语义」否决自研 parser；ADR-0020 用 50MB 实测
 * （2.8–4.4× 时间、2.1–4.1× 值图堆）重新评估后推翻该否决。
 *
 * 三个导出：
 *   - `parseLossless`：**与 `JSON.parse` 语法接受面逐例一致**的解析器（硬不变式），数字走
 *     `core/number-literal` 判定（整数超安全范围 → BigInt；其余 Number）。**显式栈、非递归**，
 *     100 万层深嵌套不爆栈。字符串解码自己实现（不借 `JSON.parse`）。
 *   - `serializeLossless`：与 `JSON.stringify(value, null, indent)` 在**无 BigInt** 的普通 JSON
 *     值上逐字节等价；BigInt 输出裸十进制数字（`297532588187238660`，仍合法 JSON 数字）。
 *     递归实现 → 与 `JSON.stringify` 同样受调用栈限制（>1 万层 RangeError 是现状已知差距，
 *     ADR-0020 §8）；不处理 toJSON / replacer / 环引用（值图是 JSON 值域，无这些形态）。
 *   - `deepEqualJson`：子树编辑 no-op 判定（替代旧实现两次 `JSON.stringify` 比较）。
 *
 * 错误信息模仿 V8（含 `position N` 与 `(line L column C)`），上游 `core/import` 的
 * `parseErrorPosition` 与 `PARSE` 行列口径不变。
 */
import { analyzeNumberLiteral } from './number-literal';

/** 解析错误：位置与 1-based 行列随错误一起给出（供 CoreError 的 PARSE 行列使用）。 */
export class LosslessParseError extends Error {
  readonly position: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: number, line: number, column: number) {
    super(message);
    this.name = 'LosslessParseError';
    this.position = position;
    this.line = line;
    this.column = column;
  }
}

const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_QUOTE = 34;
const CH_COMMA = 44;
const CH_COLON = 58;
const CH_MINUS = 45;
const CH_DOT = 46;
const CH_0 = 48;
const CH_9 = 57;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const CH_LBRACE = 123;
const CH_RBRACE = 125;
const CH_E_UPPER = 69;
const CH_E_LOWER = 101;
const CH_T = 116;
const CH_F = 102;
const CH_N = 110;

function isDigit(c: number): boolean {
  return c >= CH_0 && c <= CH_9;
}

function isWhitespace(c: number): boolean {
  return c === CH_SPACE || c === CH_LF || c === CH_CR || c === CH_TAB;
}

interface SourceLoc {
  line: number;
  column: number;
}

/** 偏移 → 1-based 行列（只在报错路径调用，O(n) 可接受）。 */
function locate(text: string, position: number): SourceLoc {
  const end = Math.min(Math.max(position, 0), text.length);
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === CH_LF) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: end - lastNewline };
}

function fail(text: string, position: number, reason: string): never {
  const { line, column } = locate(text, position);
  throw new LosslessParseError(
    `${reason} in JSON at position ${position} (line ${line} column ${column})`,
    position,
    line,
    column,
  );
}

/** 读 4 位十六进制（`\uXXXX` 的 XXXX）。非法 → 在起始处报错。 */
function readHex4(text: string, start: number, len: number): number {
  if (start + 4 > len) fail(text, start, 'Bad escaped character');
  let code = 0;
  for (let k = 0; k < 4; k += 1) {
    const c = text.charCodeAt(start + k);
    let v: number;
    if (c >= CH_0 && c <= CH_9) v = c - CH_0;
    else if (c >= 65 && c <= 70) v = c - 65 + 10; // A-F
    else if (c >= 97 && c <= 102) v = c - 97 + 10; // a-f
    else return fail(text, start + k, 'Bad escaped character');
    code = code * 16 + v;
  }
  return code;
}

/**
 * 读一个字符串（`quotePos` = 开引号下标）。返回解码后的值与下一个待读下标。
 * 规则与 JSON 完全一致：控制字符 < 0x20 必须转义；`\uXXXX`；孤立代理项照常接受。
 */
function readString(text: string, len: number, quotePos: number): { value: string; next: number } {
  let j = quotePos + 1;
  const start = j;
  // 快路径：没有反斜杠/控制字符 → 直接切片
  while (j < len) {
    const c = text.charCodeAt(j);
    if (c === CH_QUOTE) return { value: text.slice(start, j), next: j + 1 };
    if (c === CH_BACKSLASH || c < 0x20) break;
    j += 1;
  }
  // 慢路径：逐段拼接
  let out = text.slice(start, j);
  for (;;) {
    if (j >= len) fail(text, len, 'Unterminated string');
    const c = text.charCodeAt(j);
    if (c === CH_QUOTE) return { value: out, next: j + 1 };
    if (c < 0x20) fail(text, j, 'Bad control character in string literal');
    if (c !== CH_BACKSLASH) {
      out += text[j];
      j += 1;
      continue;
    }
    const esc = text.charCodeAt(j + 1);
    switch (esc) {
      case 34: // \"
        out += '"';
        j += 2;
        break;
      case 92: // \\
        out += '\\';
        j += 2;
        break;
      case 47: // \/
        out += '/';
        j += 2;
        break;
      case 98: // \b
        out += '\b';
        j += 2;
        break;
      case 102: // \f
        out += '\f';
        j += 2;
        break;
      case 110: // \n
        out += '\n';
        j += 2;
        break;
      case 114: // \r
        out += '\r';
        j += 2;
        break;
      case 116: // \t
        out += '\t';
        j += 2;
        break;
      case 117: {
        // \uXXXX
        const code = readHex4(text, j + 2, len);
        out += String.fromCharCode(code);
        j += 6;
        break;
      }
      default:
        fail(text, j, 'Bad escaped character');
    }
  }
}

/**
 * 读一个数字（`start` = 首字符下标）。严格按 JSON 数字语法校验，然后交给
 * `analyzeNumberLiteral` 决定 number / bigint / Infinity。
 *
 * 注意：本函数的「**语法扫描**」与 `number-literal.normalizeDecimal`、`fidelity.scanNumberEnd`
 * 各扫一遍是有意的（parser 需要严格校验 + 精确报错位置；fidelity 需要对截断文本宽松容错）；
 * ADR-0020 §7 的「单一来源」钉的是**判定规则**（`analyzeNumberLiteral`），不是扫描实现。
 */
function readNumber(text: string, len: number, start: number): { value: number | bigint; next: number } {
  let j = start;
  if (text.charCodeAt(j) === CH_MINUS) j += 1;
  const first = text.charCodeAt(j);
  if (first === CH_0) {
    j += 1;
    // JSON 不允许前导零：`01` / `-01`
    if (j < len && isDigit(text.charCodeAt(j))) fail(text, j, 'Unexpected number');
  } else if (first >= 49 && first <= 57) {
    j += 1;
    while (j < len && isDigit(text.charCodeAt(j))) j += 1;
  } else {
    fail(text, j, 'Unexpected token');
  }
  if (text.charCodeAt(j) === CH_DOT) {
    j += 1;
    if (!isDigit(text.charCodeAt(j))) fail(text, j, 'Unexpected token');
    while (j < len && isDigit(text.charCodeAt(j))) j += 1;
  }
  const expChar = text.charCodeAt(j);
  if (expChar === CH_E_UPPER || expChar === CH_E_LOWER) {
    j += 1;
    const sign = text.charCodeAt(j);
    if (sign === 43 /* + */ || sign === CH_MINUS) j += 1;
    if (!isDigit(text.charCodeAt(j))) fail(text, j, 'Unexpected token');
    while (j < len && isDigit(text.charCodeAt(j))) j += 1;
  }
  const raw = text.slice(start, j);
  const info = analyzeNumberLiteral(raw);
  // 整数超展开位数上限：按 JSON.parse 语义变 Infinity（保真报告会报 overflow）
  return { value: info.value === null ? Infinity : info.value, next: j };
}

/** `__proto__` 必须定义成 own property（普通赋值会改原型）。 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

interface ArrayFrame {
  arr: unknown[];
}

interface ObjectFrame {
  obj: Record<string, unknown>;
  key: string;
}

type Frame = ArrayFrame | ObjectFrame;

function isArrayFrame(frame: Frame): frame is ArrayFrame {
  return (frame as ArrayFrame).arr !== undefined;
}

/**
 * 无损 JSON 解析（ADR-0020 §4.3）：与 `JSON.parse` 语法接受面逐例一致。
 * 显式栈 + 状态机（非递归）；字符串自己解码；数字走 `analyzeNumberLiteral`。
 */
export function parseLossless(text: string): unknown {
  const len = text.length;
  let i = 0;
  const stack: Frame[] = [];

  const skipWs = (): void => {
    while (i < len && isWhitespace(text.charCodeAt(i))) i += 1;
  };

  skipWs();
  if (i >= len) fail(text, len, 'Unexpected end of JSON input');

  for (;;) {
    // ---- 解析一个值 ----
    skipWs();
    if (i >= len) fail(text, len, 'Unexpected end of JSON input');
    const c = text.charCodeAt(i);
    let value: unknown;

    if (c === CH_LBRACKET) {
      i += 1;
      skipWs();
      if (text.charCodeAt(i) === CH_RBRACKET) {
        i += 1;
        value = [];
      } else {
        stack.push({ arr: [] });
        continue;
      }
    } else if (c === CH_LBRACE) {
      i += 1;
      skipWs();
      if (text.charCodeAt(i) === CH_RBRACE) {
        i += 1;
        value = {};
      } else {
        if (text.charCodeAt(i) !== CH_QUOTE) fail(text, i, "Expected property name or '}'");
        const keyRes = readString(text, len, i);
        i = keyRes.next;
        skipWs();
        if (text.charCodeAt(i) !== CH_COLON) fail(text, i, "Expected ':' after property name");
        i += 1;
        stack.push({ obj: {}, key: keyRes.value });
        continue;
      }
    } else if (c === CH_QUOTE) {
      const res = readString(text, len, i);
      i = res.next;
      value = res.value;
    } else if (c === CH_MINUS || isDigit(c)) {
      const res = readNumber(text, len, i);
      i = res.next;
      value = res.value;
    } else if (c === CH_T) {
      if (text.charCodeAt(i + 1) !== 114 || text.charCodeAt(i + 2) !== 117 || text.charCodeAt(i + 3) !== 101) {
        fail(text, i, 'Unexpected token');
      }
      i += 4;
      value = true;
    } else if (c === CH_F) {
      if (
        text.charCodeAt(i + 1) !== 97 ||
        text.charCodeAt(i + 2) !== 108 ||
        text.charCodeAt(i + 3) !== 115 ||
        text.charCodeAt(i + 4) !== 101
      ) {
        fail(text, i, 'Unexpected token');
      }
      i += 5;
      value = false;
    } else if (c === CH_N) {
      if (text.charCodeAt(i + 1) !== 117 || text.charCodeAt(i + 2) !== 108 || text.charCodeAt(i + 3) !== 108) {
        fail(text, i, 'Unexpected token');
      }
      i += 4;
      value = null;
    } else {
      fail(text, i, 'Unexpected token');
    }

    // ---- 把值交给父容器（可能连续关闭多层） ----
    for (;;) {
      if (stack.length === 0) {
        skipWs();
        if (i !== len) fail(text, i, 'Unexpected non-whitespace character after JSON');
        return value;
      }
      const frame = stack[stack.length - 1] as Frame;
      if (isArrayFrame(frame)) {
        frame.arr.push(value);
        skipWs();
        if (i >= len) fail(text, len, 'Unexpected end of JSON input');
        const next = text.charCodeAt(i);
        if (next === CH_COMMA) {
          i += 1;
          break; // 解析下一个元素
        }
        if (next === CH_RBRACKET) {
          i += 1;
          stack.pop();
          value = frame.arr;
          continue; // 容器交给上层
        }
        fail(text, i, "Expected ',' or ']' after array element");
      }
      const objFrame = frame as ObjectFrame;
      setOwn(objFrame.obj, objFrame.key, value);
      skipWs();
      if (i >= len) fail(text, len, 'Unexpected end of JSON input');
      const next = text.charCodeAt(i);
      if (next === CH_COMMA) {
        i += 1;
        skipWs();
        if (text.charCodeAt(i) !== CH_QUOTE) fail(text, i, "Expected property name or '}'");
        const keyRes = readString(text, len, i);
        i = keyRes.next;
        skipWs();
        if (text.charCodeAt(i) !== CH_COLON) fail(text, i, "Expected ':' after property name");
        i += 1;
        objFrame.key = keyRes.value;
        break; // 解析该键的值
      }
      if (next === CH_RBRACE) {
        i += 1;
        stack.pop();
        value = objFrame.obj;
        continue; // 容器交给上层
      }
      fail(text, i, "Expected ',' or '}' after property value");
    }
  }
}

/** `JSON.stringify` 的缩进语义：数字 → 夹取 [0,10] 个空格；其余 = 紧凑。 */
function gapOf(indent: number | undefined): string {
  if (typeof indent !== 'number' || !Number.isFinite(indent) || indent <= 0) return '';
  return ' '.repeat(Math.min(10, Math.floor(indent)));
}

function serializeValue(value: unknown, gap: string, depth: number): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // 与 JSON.stringify 一致：非有限 → null，-0 → "0"
      return JSON.stringify(value);
    case 'bigint':
      // 裸十进制数字（合法 JSON 数字；不带引号、不带 n）
      return value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      // undefined / function / symbol：对象里跳过、数组里变 null（由调用方处理）
      return undefined;
  }

  const isArray = Array.isArray(value);
  const entries: string[] = [];
  const nextDepth = depth + 1;
  if (isArray) {
    const arr = value as unknown[];
    for (let k = 0; k < arr.length; k += 1) {
      const item = serializeValue(arr[k], gap, nextDepth);
      entries.push(item === undefined ? 'null' : item);
    }
    if (entries.length === 0) return '[]';
  } else {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (let k = 0; k < keys.length; k += 1) {
      const key = keys[k] as string;
      const item = serializeValue(obj[key], gap, nextDepth);
      if (item === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${gap === '' ? '' : ' '}${item}`);
    }
    if (entries.length === 0) return '{}';
  }
  if (gap === '') return isArray ? `[${entries.join(',')}]` : `{${entries.join(',')}}`;
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const pad = gap.repeat(nextDepth);
  const closePad = gap.repeat(depth);
  return `${open}\n${pad}${entries.join(`,\n${pad}`)}\n${closePad}${close}`;
}

/**
 * 无损序列化：
 *   - 无 BigInt 的普通 JSON 值与 `JSON.stringify(value, null, indent)` **逐字节一致**；
 *   - BigInt → 裸十进制数字；
 *   - 顶层 undefined/function/symbol → `undefined`（与 JSON.stringify 一致）。
 */
export function serializeLossless(value: unknown, indent?: number): string | undefined {
  const gap = gapOf(indent);
  return serializeValue(value, gap, 0);
}

/**
 * 结构化深相等（编辑 no-op 判定）：类型严格（`number 5` ≠ `bigint 5n`）、数组按序、
 * 对象**键顺序也相同**（与旧实现两次 `JSON.stringify` 比较的语义一致）、`Object.is` 判 `-0`。
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  const ta = typeof a;
  if (ta !== typeof b) return false;
  if (ta !== 'object') return false;
  const aIsArr = Array.isArray(a);
  if (aIsArr !== Array.isArray(b)) return false;
  if (aIsArr) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let k = 0; k < aa.length; k += 1) {
      if (!deepEqualJson(aa[k], bb[k])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (let k = 0; k < aKeys.length; k += 1) {
    const key = aKeys[k] as string;
    if (key !== bKeys[k]) return false;
    if (!deepEqualJson(ao[key], bo[key])) return false;
  }
  return true;
}
