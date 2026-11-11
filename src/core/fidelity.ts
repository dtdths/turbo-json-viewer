/**
 * core/fidelity — 保真失真扫描（#23 / ADR-0003 修订 2026-11-09 §2–§3）。
 *
 * 真相源是**无损解析值图**（ADR-0020：整数超安全范围用 BigInt）；本模块只**单趟线性扫描源文本**，
 * 找出仍会被解析改写的字面量/键序，产出「小报告」（片段 + 源偏移），不建反向索引、不重解析值图。
 *
 * 检测范围（ADR-0020 §7；规则与 parser 共用 `analyzeNumberLiteral`，禁止两处漂移）：
 *
 * | 类别 | 候选 | 精确判定 | 报告 |
 * |---|---|---|---|
 * | 数字上溢 | 整数超展开位数上限（`BIGINT_DIGIT_CAP`）；非整数小数 `Number(lit)` 非有限 | `analyzeNumberLiteral(lit).overflow` | `number` / `overflow` |
 * | 数字下溢 | 非整数小数 `Number(lit)===0` 而有效数字非零（如 `1e-400`） | `analyzeNumberLiteral(lit).underflow` | `number` / `underflow` |
 * | 整数样式键重排 | 对象内出现数组下标样式的键（规范整数串且 < 2^32−1） | 去掉「整数键全部在前且升序」的无损情况；键先按 JSON 转义解码 | `key-order` |
 *
 * **整数精度流失（原 `precision`）已退场**（ADR-0020 Q6/Q7）：无损 parser 保证整数精确，
 * 整数只会因「超展开位数上限」被降级成 `Infinity`（报 overflow）。自检移到单测。
 * **v1 不检测（ADR-0020 §8 已知差距，不要偷偷补）**：
 *   - 高精度**小数**（`0.1234567890123456789`）：仍按 Number 丢精度，字符串往返比较会误报；
 *   - 重复键 / `-0` / 孤立代理项：只记录不标记。
 *
 * 实现纪律：
 *   - **一遍 charCode 扫描**（不逐字符正则）：字符串整段跳过（含 `\` 转义），只在结构层判断
 *     数字字面量与对象键；递归/容器状态全部用显式栈。
 *   - 每 `yieldEvery` 字符（默认 `FIDELITY_YIELD_CHARS` = 256K 字符）`await onYield()` 并检查
 *     `shouldCancel()`；让出按字符块做，`i` 单调前进 → 状态机可恢复。取消返回 `null`（不抛错）。
 *     默认让出是**宏任务**（`macroYield()`，共享 MessageChannel）——微任务让出不会让 Worker
 *     处理排队的命令，会整段卡住窗口/大纲/搜索（实测 10MB 大纲 expand 1ms → 34ms）。
 *   - 源文本可能是**截断修复前的非法 JSON**（ADR 修订 2026-11-03 §2）：扫描器对非法文本
 *     只做宽松跳过，绝不抛错——保真报告不能拖垮已打开的文档。
 *   - 命中顺序 = **源文本顺序最靠前的 ≤maxHits 条**：数字边扫边出（offset 递增，走 O(1) 快路径），
 *     键序命中在对象 `}` 处才产出（offset 是 `{`，可能比已收数字更早），故按 offset **有序插入**并
 *     淘汰最大 offset，内存恒为 maxHits 条（code review 收口：原先「先截断再排序」会漏掉晚产出但更早的键序命中）。
 */
import type { FidelityHit, FidelityReport } from '../protocol/types';
import { analyzeNumberLiteral } from './number-literal';
import { now, roundMs } from '../shared/timing';

/** `hits` 片段上限（counts 不受限） */
export const FIDELITY_MAX_HITS = 100;
/** 单条片段最大字符数（UTF-16 code unit） */
export const FIDELITY_SNIPPET_MAX = 48;
/** 扫描让出事件循环的字符块大小（UTF-16 code unit 数，不是字节；50MB ≈ 200 次让出） */
export const FIDELITY_YIELD_CHARS = 256 * 1024;
/**
 * 单对象「已见下标键」集合的上限：超过后放弃重复键追踪（超大数组样式对象），
 * 此时重复键可能被误判成键序回退——已知边界，记 ADR 修订 §5。
 */
export const FIDELITY_KEY_TRACK_MAX = 4096;

export interface FidelityScanOptions {
  /** `hits` 上限；缺省 `FIDELITY_MAX_HITS`（counts 始终全量） */
  maxHits?: number;
  /** 每让出一次检查；true → 立即返回 null */
  shouldCancel?: () => boolean;
  /** 让出间隔（字符）；缺省 `FIDELITY_YIELD_CHARS` */
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
const CH_PLUS = 43;
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
/**
 * 「规范整数串且 < 2^32−1」的**规范实现**（入参是已解码的键文本）。
 * `keyIndexValue` 是它的零分配快速路径（直接扫原始文本、遇转义才解码后落到这里）——
 * 两处形状相似是刻意的性能选择，不是重复代码（code review 备注）。
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
/** 宽松扫描数字终点（容错：源文本可能是截断修复前的非法 JSON）；判定统一走 analyzeNumberLiteral。 */
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
 * 把十进制字面量规范成 `{digits, exp}`（值 = digits × 10^exp；digits 去前导/尾随零，零 → `''`）。
 * 只用于「带指数的数字是否被 double 圆整」的精确比对：同一数值的不同写法会得到同一结果
 * （`0.5` / `5e-1` → `(5,-1)`；`1000` / `1e3` → `(1,3)`），因此可以直接判等。
 * 解析失败（非法文本）返回 null——调用方按「宽松跳过」处理。
 */
/**
 * 数字字面量 → 失真类别 + 「实际值」对照（不失真返回 null）。
 *
 * 判定与 parser 完全共用 `analyzeNumberLiteral`（ADR-0020 §7）：
 *   - 整数（含 `1e400`、`1.5e1`）：无损 parser 精确表示 → **不报**（原 precision 类别退场）；
 *   - 整数超展开位数上限 → parser 产出 `Infinity` → 报 `overflow`；
 *   - 非整数小数上溢 → `Infinity` → 报 `overflow`；下溢 → `0` → 报 `underflow`；
 *   - 高精度小数（仍按 Number 丢精度）：v1 已知差距，不报。
 * 只返回判定结果、不构造 `FidelityHit`：海量命中时只为保留的 ≤100 条分配片段。
 */
function classifyNumber(
  text: string,
  start: number,
  end: number,
): { reason: 'overflow' | 'underflow'; parsed: string } | null {
  const info = analyzeNumberLiteral(text.slice(start, end));
  if (info.overflow) return { reason: 'overflow', parsed: 'Infinity' };
  if (info.underflow) return { reason: 'underflow', parsed: '0' };
  return null;
}

/* ------------------------------ 扫描 ------------------------------ */

/**
 * 显式容器栈的一帧。判别联合而不是「一个类型装全部字段」：
 * 数组帧只需要 `open`，不必为 `snippet`/`seenIndex` 等对象专属状态分配（code review：Frame 瘦身）。
 */
interface FrameBase {
  /** `{` / `[` 的源偏移（键序命中的 offset 用） */
  open: number;
}

interface ObjectFrame extends FrameBase {
  kind: 'object';
  /** 下一个字符串是否按「对象键」处理 */
  expectKey: boolean;
  /** 已经出现过非下标键（之后再出现下标键 = 重排） */
  sawNonIndex: boolean;
  /** 上一个**新**下标键数值（-1 = 尚无；重复键不更新它） */
  lastIndex: number;
  /** 已见过的下标键（判断重复键；JSON.parse 会吞并重复键，键序不因此改变） */
  seenIndex: Set<number> | null;
  /** 已判定为重排（每对象最多 1 条） */
  broken: boolean;
  /** 键片段（追加到 ≤48 字符即停，只用于报告） */
  snippet: string;
}

interface ArrayFrame extends FrameBase {
  kind: 'array';
}

type Frame = ObjectFrame | ArrayFrame;

function newObjectFrame(open: number): ObjectFrame {
  return {
    kind: 'object',
    open,
    expectKey: true,
    sawNonIndex: false,
    lastIndex: -1,
    seenIndex: null,
    broken: false,
    snippet: '',
  };
}

function newArrayFrame(open: number): ArrayFrame {
  return { kind: 'array', open };
}

/** 记录一个对象键：更新「下标键在前且升序」这一无损判定，并攒键片段。 */
function recordKey(frame: ObjectFrame, text: string, keyFrom: number, keyTo: number): void {
  const index = keyIndexValue(text, keyFrom, keyTo);
  if (index >= 0) {
    // 只让**首次出现**的下标键参与顺序判定：JSON.parse 会吞并重复键（后者覆盖前者），
    // 键的枚举顺序只由「不同键的首现顺序」决定。例：`{"1":a,"2":b,"1":c}` → 键序 `1,2` 未变，
    // 真损失是重复键吞并（ADR §4 只记录类），不能报成 key-order。
    const seen = frame.seenIndex ?? (frame.seenIndex = new Set<number>());
    if (!seen.has(index)) {
      if (seen.size < FIDELITY_KEY_TRACK_MAX) seen.add(index);
      // 非下标键之后又出现下标键，或不同下标键**降序** → 该对象重排
      if (frame.sawNonIndex || (frame.lastIndex >= 0 && index < frame.lastIndex)) frame.broken = true;
      frame.lastIndex = index;
    }
  } else {
    frame.sawNonIndex = true;
  }
  if (frame.snippet.length < FIDELITY_SNIPPET_MAX) {
    const raw = text.slice(keyFrom, keyTo);
    frame.snippet += (frame.snippet === '' ? '' : ',') + raw.slice(0, FIDELITY_SNIPPET_MAX + 1);
  }
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
      ? FIDELITY_YIELD_CHARS
      : Math.floor(rawYieldEvery);
  const onYield = opts.onYield;
  const shouldCancel = opts.shouldCancel;

  const t0 = now();
  if (shouldCancel?.()) return null;

  const n = text.length;
  const stack: Frame[] = [];
  /** 保留的命中片段：**始终按 offset 升序**、长度 ≤ maxHits（见 pushHit） */
  const hits: FidelityHit[] = [];
  let overflowCount = 0;
  let underflowCount = 0;
  let keyOrderCount = 0;
  let nextYieldAt = yieldEvery;

  /**
   * 按 offset 有序收下一条片段，只保留**源文本最靠前**的 maxHits 条：
   * 数字的 offset 递增 → 常见路径 O(1) 追加/丢弃；键序命中在对象 `}` 处才产出（offset 是 `{`，
   * 可能比已收数字更早）→ 二分插入并淘汰最大 offset。内存恒为 maxHits 条。
   * （code review 收口：原先「先按发现顺序截断、最后再排序」会漏掉晚产出但源位置更早的键序命中。）
   */
  const pushHit = (hit: FidelityHit): void => {
    if (maxHits === 0) return;
    const size = hits.length;
    if (size >= maxHits) {
      if (hit.offset >= hits[size - 1].offset) return; // 满额且新的更晚 → 丢弃
    } else if (size === 0 || hit.offset > hits[size - 1].offset) {
      hits.push(hit);
      return;
    }
    let lo = 0;
    let hi = hits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hits[mid].offset <= hit.offset) lo = mid + 1;
      else hi = mid;
    }
    hits.splice(lo, 0, hit);
    if (hits.length > maxHits) hits.pop();
  };

  /** 计一条数字命中（按 reason 分别计数；片段只在进入保留集时才构造） */
  const addNumberHit = (
    start: number,
    end: number,
    cls: NonNullable<ReturnType<typeof classifyNumber>>,
  ): void => {
    if (cls.reason === 'overflow') overflowCount += 1;
    else underflowCount += 1;
    if (maxHits === 0) return;
    const literal = clip(text.slice(start, end));
    pushHit({
      kind: 'number',
      reason: cls.reason,
      offset: start,
      snippet: literal,
      literal,
      parsed: clip(cls.parsed),
    });
  };

  /** 计一条键序命中（同一对象最多 1 条，offset = 对象 `{`） */
  const addKeyOrderHit = (frame: ObjectFrame): void => {
    keyOrderCount += 1;
    if (maxHits === 0) return;
    pushHit({ kind: 'key-order', offset: frame.open, snippet: clip(frame.snippet) });
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
      stack.push(newObjectFrame(i));
      i += 1;
      continue;
    }
    if (c === CH_LBRACK) {
      stack.push(newArrayFrame(i));
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

  // hits 由 pushHit 维护为「offset 升序 + 只留最靠前 maxHits 条」，这里无需再排序
  const numberCount = overflowCount + underflowCount;
  const total = numberCount + keyOrderCount;
  const report: FidelityReport = {
    status: total > 0 ? 'found' : 'none',
    counts: {
      number: numberCount,
      overflow: overflowCount,
      underflow: underflowCount,
      keyOrder: keyOrderCount,
      total,
    },
    hits,
    truncated: total > hits.length,
    scanMs: roundMs(now() - t0),
  };
  releaseYieldChannel();
  return report;
}
