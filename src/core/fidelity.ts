/**
 * core/fidelity — 保真失真扫描（#23 / ADR-0003 修订 2026-11-09 §2–§3）。
 *
 * 真相源仍是 `JSON.parse` 值图；本模块只**单趟线性扫描源文本**，找出会被 `JSON.parse`
 * 静默改写的字面量/键序，产出「小报告」（片段 + 源偏移），不建反向索引、不重解析值图。
 *
 * 检测范围（严格按 ADR 修订 §2 的表；不检测项见下）：
 *
 * | 类别 | 候选 | 精确判定 | 报告 |
 * |---|---|---|---|
 * | 大整数精度流失 | 整数字面量（无 `.`/指数）位数 > 15 | `BigInt(lit) !== BigInt(Number(lit))` | `number` / `precision` |
 * | 上溢 | 带指数且 `Number(lit)` 非有限 | `!isFinite(Number(lit))`（如 `1e400`） | `number` / `overflow` |
 * | 下溢 | 带指数且 `Number(lit)===0` 而有效数字非零 | 同上（如 `1e-400`） | `number` / `underflow` |
 * | 整数样式键重排 | 对象内出现数组下标样式的键（规范整数串且 < 2^32−1） | 去掉「整数键全部在前且升序」的无损情况；键先按 JSON 转义解码 | `key-order` |
 *
 * **v1 不检测（ADR 已记为差距，不要偷偷补）**：
 *   - 高精度**小数**（`0.1234567890123456789`）：BigInt 精确法不适用，字符串往返比较会误报；
 *   - 重复键 / `-0` / 孤立代理项（ADR §4：只记录不标记）。
 * 另：超长纯整数（`Number(lit)` 上溢为 Infinity）按 `overflow` 报——ADR 表只列了「带指数」，
 * 但那种字面量同样被 `JSON.parse` 改写成 `Infinity`，不报会漏；见实现报告。
 *
 * 实现纪律：
 *   - **一遍 charCode 扫描**（不逐字符正则）：字符串整段跳过（含 `\` 转义），只在结构层判断
 *     数字字面量与对象键；递归/容器状态全部用显式栈。
 *   - 每 `yieldEvery` 字符（默认 `FIDELITY_YIELD_BYTES` = 256 KB）`await onYield()` 并检查
 *     `shouldCancel()`；让出按字符块做，`i` 单调前进 → 状态机可恢复。取消返回 `null`（不抛错）。
 *     默认让出是**宏任务**（`macroYield()`，共享 MessageChannel）——微任务让出不会让 Worker
 *     处理排队的命令，会整段卡住窗口/大纲/搜索（实测 10MB 大纲 expand 1ms → 34ms）。
 *   - 源文本可能是**截断修复前的非法 JSON**（ADR 修订 2026-11-03 §2）：扫描器对非法文本
 *     只做宽松跳过，绝不抛错——保真报告不能拖垮已打开的文档。
 *   - 命中顺序 = 源文本出现顺序（数字命中边扫边出，键序命中在对象 `}` 处出，
 *     故最后按 `offset` 排一次；只排保留的 ≤100 条，成本可忽略）。
 */
import type { FidelityHit, FidelityReport } from '../protocol/types';

/** `hits` 片段上限（counts 不受限） */
export const FIDELITY_MAX_HITS = 100;
/** 单条片段最大字符数（UTF-16 code unit） */
export const FIDELITY_SNIPPET_MAX = 48;
/** 扫描让出事件循环的字符块大小（字符数即 UTF-16 计数；50MB ≈ 200 次让出） */
export const FIDELITY_YIELD_BYTES = 256 * 1024;

export interface FidelityScanOptions {
  /** `hits` 上限；缺省 `FIDELITY_MAX_HITS`（counts 始终全量） */
  maxHits?: number;
  /** 每让出一次检查；true → 立即返回 null */
  shouldCancel?: () => boolean;
  /** 让出间隔（字符）；缺省 `FIDELITY_YIELD_BYTES` */
  yieldEvery?: number;
  /** 每让出一次调用（默认 `macroYield()`：宏任务让出）；测试可注入计数 */
  onYield?: () => Promise<void>;
}

/* ------------------------------- 让出事件循环 ------------------------------- */

/**
 * 让出**宏任务**（不是微任务）：`await Promise.resolve()` 只清微任务队列，Worker 里排在
 * 消息队列上的命令（窗口 / 大纲 / 搜索）都要等到下一个宏任务才会跑——用微任务让出等于
 * 整段扫描期间把 Worker 卡住（实测 10MB 时大纲 expand 从 1ms 退化到 34ms）。
 *
 * 用**共享的 MessageChannel** 做宏任务让出：`setTimeout(0)` 在连续调用 5 次后会被钳到
 * ~4ms（50MB 要 200 次让出 → 平白多 ~800ms），MessagePort 没有这个惩罚。
 * 无 MessageChannel 的环境（理论兜底）退回 `setTimeout(0)`。
 */
let yieldChannel: MessageChannel | null = null;
const yieldQueue: Array<() => void> = [];

function macroYield(): Promise<void> {
  const ChannelCtor = (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel;
  if (typeof ChannelCtor !== 'function') {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  if (yieldChannel === null) {
    yieldChannel = new ChannelCtor();
    yieldChannel.port1.onmessage = (): void => {
      const next = yieldQueue.shift();
      if (next !== undefined) next();
    };
  }
  const channel = yieldChannel;
  return new Promise<void>((resolve) => {
    yieldQueue.push(resolve);
    channel.port2.postMessage(0);
  });
}

/** 扫描结束后释放让出通道（避免 Worker/测试进程被常开的端口吊住）；有在途让出时跳过。 */
function releaseYieldChannel(): void {
  if (yieldChannel !== null && yieldQueue.length === 0) {
    yieldChannel.port1.close();
    yieldChannel.port2.close();
    yieldChannel = null;
  }
}

/* ------------------------------- 字符码 ------------------------------- */

const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_QUOTE = 34;
const CH_COMMA = 44;
const CH_MINUS = 45;
const CH_DOT = 46;
const CH_COLON = 58;
const CH_E_UPPER = 69;
const CH_LBRACK = 91;
const CH_BACKSLASH = 92;
const CH_RBRACK = 93;
const CH_E_LOWER = 101;
const CH_LBRACE = 123;
const CH_RBRACE = 125;

/** 数组下标键的上界（JS 规范：`< 2^32−1` 才是数组下标；等于上界不算） */
const MAX_ARRAY_INDEX = 4294967295;

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isSpace(c: number): boolean {
  return c === CH_SPACE || c === CH_LF || c === CH_CR || c === CH_TAB;
}

/** 毫秒保留 3 位小数（与 raw-text 的 buildMs 同口径） */
function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** ≤ FIDELITY_SNIPPET_MAX 字符；超出时留 47 字符 + `…`（总长恰好 48） */
function clip(text: string): string {
  return text.length <= FIDELITY_SNIPPET_MAX
    ? text
    : text.slice(0, FIDELITY_SNIPPET_MAX - 1) + '…';
}

/* ------------------------------ 键判定 ------------------------------ */

/**
 * 规范整数串（`0` 或 `[1-9][0-9]*`）且 `< 2^32−1` → 返回其数值；否则 -1。
 * 只看**解码后**的键文本（调用方负责转义解码）。
 */
function indexKeyValue(key: string): number {
  const n = key.length;
  if (n === 0 || n > 10) return -1;
  if (n > 1 && key.charCodeAt(0) === 48) return -1; // 前导零：不是规范整数串
  let value = 0;
  for (let i = 0; i < n; i++) {
    const digit = key.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return -1;
    value = value * 10 + digit;
  }
  return value >= MAX_ARRAY_INDEX ? -1 : value;
}

const HEX_DIGITS = '0123456789abcdefABCDEF';

/**
 * JSON 字符串转义解码（最小集：`\" \\ \/ \b \f \n \r \t \uXXXX`）。
 * 未知转义原样保留（宽松：源文本可能非法，不能抛错）。
 *
 * @param from 起始引号偏移
 * @param to   结束引号**之后**的偏移（未闭合时 = 文本末尾）
 */
function decodeKey(text: string, from: number, to: number): string {
  const innerEnd = to > from + 1 && text.charCodeAt(to - 1) === CH_QUOTE ? to - 1 : to;
  let out = '';
  for (let i = from + 1; i < innerEnd; i++) {
    const c = text.charCodeAt(i);
    if (c !== CH_BACKSLASH) {
      out += text[i];
      continue;
    }
    if (i + 1 >= innerEnd) break; // 悬空反斜杠（非法文本）：吞掉
    const esc = text.charCodeAt(i + 1);
    switch (esc) {
      case CH_QUOTE:
        out += '"';
        i += 1;
        break;
      case CH_BACKSLASH:
        out += '\\';
        i += 1;
        break;
      case 47: // /
        out += '/';
        i += 1;
        break;
      case 98: // b
        out += '\b';
        i += 1;
        break;
      case 102: // f
        out += '\f';
        i += 1;
        break;
      case 110: // n
        out += '\n';
        i += 1;
        break;
      case 114: // r
        out += '\r';
        i += 1;
        break;
      case 116: // t
        out += '\t';
        i += 1;
        break;
      case 117: {
        // \uXXXX
        const hex = text.slice(i + 2, i + 6);
        if (hex.length === 4 && [...hex].every((h) => HEX_DIGITS.includes(h))) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 5;
        } else {
          out += 'u'; // 非法 \u：宽松保留
          i += 1;
        }
        break;
      }
      default:
        out += text[i + 1];
        i += 1;
        break;
    }
  }
  return out;
}

/**
 * 键是否为数组下标样式（返回数值；非下标 → -1）。
 * 快速路径原地判字符（0 分配、遇首个非数字字符即拒绝）；只有遇到 `\` 转义才整串解码
 * （`\u0031` 必须当成 `"1"`）。注意不能先按「原始长度 > 10」拒绝：转义会让原始串变长。
 */
function keyIndexValue(text: string, from: number, to: number): number {
  const end = to > from + 1 && text.charCodeAt(to - 1) === CH_QUOTE ? to - 1 : to;
  const start = from + 1;
  if (end === start) return -1;
  // 前导零（未转义时的 `01`）：不是规范整数串
  if (end - start > 1 && text.charCodeAt(start) === 48) return -1;
  let value = 0;
  let digits = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (isDigit(c)) {
      digits += 1;
      if (digits > 10) return -1; // 解码后也必然 > 10 位
      value = value * 10 + (c - 48);
      continue;
    }
    if (c === CH_BACKSLASH) return indexKeyValue(decodeKey(text, from, to));
    return -1;
  }
  if (digits === 0) return -1;
  return value >= MAX_ARRAY_INDEX ? -1 : value;
}

/* ---------------------------- 数字判定 ---------------------------- */

/** JSON 数字字面量的结束偏移（最小文法：`-`? int frac? exp?）；非法起点返回 start。 */
function scanNumberEnd(text: string, start: number): number {
  const n = text.length;
  let i = start;
  if (text.charCodeAt(i) === CH_MINUS) i += 1;
  const intStart = i;
  while (i < n && isDigit(text.charCodeAt(i))) i += 1;
  if (i === intStart) return start; // 裸 `-` / 非数字：交给主循环逐字符跳过
  if (text.charCodeAt(i) === CH_DOT) {
    i += 1;
    while (i < n && isDigit(text.charCodeAt(i))) i += 1;
  }
  const c = text.charCodeAt(i);
  if (c === CH_E_UPPER || c === CH_E_LOWER) {
    i += 1;
    const sign = text.charCodeAt(i);
    if (sign === 43 || sign === CH_MINUS) i += 1;
    while (i < n && isDigit(text.charCodeAt(i))) i += 1;
  }
  return i;
}

/**
 * 数字字面量 → 失真类别 + 「解析后」对照（不失真返回 null）。
 * 高精度小数（含 `.` 且无指数）v1 不报（ADR 修订 §2）。
 * 只返回判定结果、不构造 `FidelityHit`：海量命中时只为保留的 ≤100 条分配片段。
 */
function classifyNumber(
  text: string,
  start: number,
  end: number,
): { reason: 'precision' | 'overflow' | 'underflow'; parsed: string } | null {
  const lit = text.slice(start, end);
  const sign = lit.charCodeAt(0) === CH_MINUS ? 1 : 0;

  // 一次小遍扫：找 `.` / 指数，同时判有效数字里是否有非零（下溢用）
  let hasDot = false;
  let hasExp = false;
  let mantissaNonZero = false;
  for (let i = sign; i < lit.length; i++) {
    const c = lit.charCodeAt(i);
    if (c === CH_DOT) hasDot = true;
    else if (c === CH_E_UPPER || c === CH_E_LOWER) {
      hasExp = true;
      break;
    } else if (c >= 49 && c <= 57) mantissaNonZero = true;
  }

  const value = Number(lit);

  if (hasExp) {
    if (!Number.isFinite(value)) return { reason: 'overflow', parsed: String(value) };
    if (value === 0 && mantissaNonZero) return { reason: 'underflow', parsed: String(value) };
    return null;
  }
  // 高精度小数：v1 已知差距（ADR 修订 §2），不做字符串往返比较
  if (hasDot) return null;

  // 纯整数：候选 = 去掉符号与前导零后位数 > 15；精确判定用 BigInt
  let digitStart = sign;
  while (digitStart < lit.length && lit.charCodeAt(digitStart) === 48) digitStart += 1;
  if (lit.length - digitStart <= 15) return null;
  // >15 位的整数也可能直接把 double 撑爆（如 400 位）：同样被 JSON.parse 改写，报 overflow
  if (!Number.isFinite(value)) return { reason: 'overflow', parsed: String(value) };
  let exact: bigint;
  try {
    exact = BigInt(lit);
  } catch {
    return null; // 非法整数文本（如 `0123`）：宽松跳过，不误报
  }
  if (exact === BigInt(value)) return null;
  return { reason: 'precision', parsed: String(value) };
}

/* ------------------------------ 扫描 ------------------------------ */

/** 显式容器栈的一帧（对象用全部字段；数组只用到 kind） */
interface Frame {
  kind: 'object' | 'array';
  /** `{` / `[` 的源偏移（键序命中的 offset） */
  open: number;
  /** 下一个字符串是否按「对象键」处理 */
  expectKey: boolean;
  /** 已经出现过非下标键（之后再出现下标键 = 重排） */
  sawNonIndex: boolean;
  /** 上一个下标键数值（-1 = 尚无） */
  lastIndex: number;
  /** 已判定为重排（每对象最多 1 条） */
  broken: boolean;
  /** 键片段（追加到 ≤48 字符即停，只用于报告） */
  snippet: string;
}

function newFrame(kind: 'object' | 'array', open: number): Frame {
  return {
    kind,
    open,
    expectKey: kind === 'object',
    sawNonIndex: false,
    lastIndex: -1,
    broken: false,
    snippet: '',
  };
}

/** 记录一个对象键：更新「下标键在前且升序」这一无损判定，并攒键片段。 */
function recordKey(frame: Frame, text: string, keyFrom: number, keyTo: number): void {
  const index = keyIndexValue(text, keyFrom, keyTo);
  if (index >= 0) {
    // 非下标键之后又出现下标键，或下标键**降序** → 该对象重排。
    // 重复下标键（`{"1":a,"1":b}`）不算顺序损失：可见损失是重复键吞并（ADR §4 只记录不标记），
    // 且 JSON.parse 的键序在这种输入里并没有变（只有 "1" 一个键），所以用严格 `<`。
    if (frame.sawNonIndex || (frame.lastIndex >= 0 && index < frame.lastIndex)) frame.broken = true;
    frame.lastIndex = index;
  } else {
    frame.sawNonIndex = true;
  }
  if (frame.snippet.length < FIDELITY_SNIPPET_MAX) {
    const raw = text.slice(keyFrom, keyTo);
    frame.snippet += (frame.snippet === '' ? '' : ',') + raw.slice(0, FIDELITY_SNIPPET_MAX + 1);
  }
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * 单趟扫描源文本；被取消返回 `null`（不抛错）。
 *
 * 只读、纯函数（不碰值图/行模型）；调用方（`DocService.fidelity`）负责把 `null` 映射成
 * `CANCELLED` 错误，并把报告缓存在文档根上（源文本不变 → 不必重扫）。
 */
export async function scanFidelity(
  text: string,
  opts: FidelityScanOptions = {},
): Promise<FidelityReport | null> {
  const rawMaxHits = opts.maxHits;
  const maxHits =
    rawMaxHits === undefined || !Number.isFinite(rawMaxHits)
      ? FIDELITY_MAX_HITS
      : Math.max(0, Math.floor(rawMaxHits));
  const rawYieldEvery = opts.yieldEvery;
  const yieldEvery =
    rawYieldEvery === undefined || !Number.isFinite(rawYieldEvery) || rawYieldEvery < 1
      ? FIDELITY_YIELD_BYTES
      : Math.floor(rawYieldEvery);
  const onYield = opts.onYield;
  const shouldCancel = opts.shouldCancel;

  const t0 = now();
  if (shouldCancel?.()) return null;

  const n = text.length;
  const stack: Frame[] = [];
  const hits: FidelityHit[] = [];
  let numberCount = 0;
  let keyOrderCount = 0;
  let nextYieldAt = yieldEvery;

  /** 计一条数字命中；只有前 maxHits 条才构造片段（counts 永远全量） */
  const addNumberHit = (
    start: number,
    end: number,
    cls: NonNullable<ReturnType<typeof classifyNumber>>,
  ): void => {
    numberCount += 1;
    if (hits.length >= maxHits) return;
    const literal = clip(text.slice(start, end));
    hits.push({
      kind: 'number',
      reason: cls.reason,
      offset: start,
      snippet: literal,
      literal,
      parsed: clip(cls.parsed),
    });
  };

  /** 计一条键序命中（同一对象最多 1 条，offset = 对象 `{`） */
  const addKeyOrderHit = (frame: Frame): void => {
    keyOrderCount += 1;
    if (hits.length < maxHits) {
      hits.push({ kind: 'key-order', offset: frame.open, snippet: clip(frame.snippet) });
    }
  };

  /** 让出一拍；返回 true = 已被取消 */
  const yieldStep = async (): Promise<boolean> => {
    await (onYield ? onYield() : macroYield());
    return shouldCancel?.() === true;
  };

  let i = 0;
  while (i < n) {
    if (i >= nextYieldAt) {
      nextYieldAt = i + yieldEvery;
      if (await yieldStep()) {
        releaseYieldChannel();
        return null;
      }
    }

    const c = text.charCodeAt(i);

    if (isSpace(c)) {
      i += 1;
      continue;
    }

    if (c === CH_LBRACE) {
      stack.push(newFrame('object', i));
      i += 1;
      continue;
    }
    if (c === CH_LBRACK) {
      stack.push(newFrame('array', i));
      i += 1;
      continue;
    }
    if (c === CH_RBRACE || c === CH_RBRACK) {
      const frame = stack.pop();
      if (frame !== undefined && frame.kind === 'object' && frame.broken) addKeyOrderHit(frame);
      i += 1;
      continue;
    }
    if (c === CH_COMMA) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.kind === 'object') top.expectKey = true;
      i += 1;
      continue;
    }
    if (c === CH_COLON) {
      // 值前分隔符：键后面必然是值（expectKey 已在键出栈时清掉）
      i += 1;
      continue;
    }

    if (c === CH_QUOTE) {
      // 字符串整段跳过（处理 `\` 转义；跳过 `\uXXXX` 的 4 个十六进制字符也无妨，
      // 里面不可能出现裸引号），只在字符串结束后判断它是不是对象键。
      let p = i + 1;
      while (p < n) {
        if (p >= nextYieldAt) {
          nextYieldAt = p + yieldEvery;
          if (await yieldStep()) {
            releaseYieldChannel();
            return null;
          }
        }
        const cc = text.charCodeAt(p);
        if (cc === CH_BACKSLASH) {
          p += 2;
          continue;
        }
        if (cc === CH_QUOTE) {
          p += 1;
          break;
        }
        p += 1;
      }
      const top = stack[stack.length - 1];
      if (top !== undefined && top.kind === 'object' && top.expectKey) {
        recordKey(top, text, i, p);
        top.expectKey = false;
      }
      i = p;
      continue;
    }

    if (c === CH_MINUS || isDigit(c)) {
      const end = scanNumberEnd(text, i);
      if (end === i) {
        i += 1; // 防御：裸 `-` 等非法字符，逐字符跳过
        continue;
      }
      const cls = classifyNumber(text, i, end);
      if (cls !== null) addNumberHit(i, end, cls);
      const top = stack[stack.length - 1];
      if (top !== undefined && top.kind === 'object') top.expectKey = false;
      i = end;
      continue;
    }

    // true / false / null / 其它非法字符：宽松跳过（源文本可能是截断修复前的非法 JSON）
    i += 1;
  }

  // 键序命中在对象 `}` 处才产出（offset 是 `{`），与数字命中混排后需按源顺序排一次
  hits.sort((a, b) => a.offset - b.offset);

  const total = numberCount + keyOrderCount;
  const report: FidelityReport = {
    status: total > 0 ? 'found' : 'none',
    counts: { number: numberCount, keyOrder: keyOrderCount, total },
    hits,
    truncated: total > hits.length,
    scanMs: roundMs(now() - t0),
  };
  releaseYieldChannel();
  return report;
}
