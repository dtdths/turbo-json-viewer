/**
 * core/repair — 截断 JSON 的保守修复（#8 / ADR-0004 修订 2026-11-03）。
 *
 * 只做**语法层闭合**：补未闭合容器的 `}`/`]`、补未闭合字符串的结束引号、删尾逗号、
 * 删悬空成员（键+冒号，它没有值可保留）、删半个字面量、数字只保留最长的合法前缀。
 * **绝不猜测内容**：不补值、不补键、不补字符、不把 `tru` 补成 `true`。
 *
 * 判定顺序 = docs/design/reassess-fidelity.md §6.2 的 6 条规则；驱动方式是单趟状态机
 * （容器栈 + 字符串/数字/字面量/成员槽位），不拿 V8 的报错串做字符串手术。
 * 自校验：修复结果必须 `JSON.parse` 通过才算 `repaired`，否则 `unrepairable`。
 *
 * 契约：纯函数，零依赖，不碰 DOM/Node，**不抛错**。
 * `status: 'none'` 只在原文本本来可解析时返回（调用方只需在 parse 失败时调用本模块）。
 * `ops[].at` 一律指向**原文本**偏移：delete 的 `text` = 原文切片，insert 的 `at` = 原文长度。
 */
import type { RepairCounts, RepairOp } from '../protocol/types';

export interface RepairAttempt {
  status: 'none' | 'repaired' | 'unrepairable';
  /** status='repaired' → 可 JSON.parse 的修复文本；status='none' 不返回文本（调用方用原文本） */
  text?: string;
  truncatedAt?: number;
  counts?: RepairCounts;
  ops?: RepairOp[];
  summaryText?: string;
  unrepairableReason?: 'not-eof' | 'still-invalid';
}

// ── charCode 常量（50MB 热路径用 code 比较，避免临时子串）──
const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_QUOTE = 0x22;
const CH_PLUS = 0x2b;
const CH_COMMA = 0x2c;
const CH_MINUS = 0x2d;
const CH_DOT = 0x2e;
const CH_COLON = 0x3a;
const CH_LBRACK = 0x5b;
const CH_BACKSLASH = 0x5c;
const CH_RBRACK = 0x5d;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const CH_ZERO = 0x30;
const CH_NINE = 0x39;
const CH_UPPER_A = 65;
const CH_UPPER_F = 70;
const CH_UPPER_Z = 90;
const CH_LOWER_A = 97;
const CH_LOWER_E = 101;
const CH_LOWER_F = 102;
const CH_LOWER_U = 117;
const CH_LOWER_Z = 122;

/** JSON 允许的转义字符：`" \ / b f n r t`（`u` 单独处理） */
function isEscapable(c: number): boolean {
  return (
    c === CH_QUOTE ||
    c === CH_BACKSLASH ||
    c === 0x2f || // /
    c === 0x62 || // b
    c === 0x66 || // f
    c === 0x6e || // n
    c === 0x72 || // r
    c === 0x74 // t
  );
}

const isWs = (c: number): boolean => c === CH_SPACE || c === CH_LF || c === CH_CR || c === CH_TAB;
const isDigit = (c: number): boolean => c >= CH_ZERO && c <= CH_NINE;
const isHex = (c: number): boolean =>
  isDigit(c) || (c >= CH_UPPER_A && c <= CH_UPPER_F) || (c >= CH_LOWER_A && c <= CH_LOWER_F);
const isLetter = (c: number): boolean => (c >= CH_UPPER_A && c <= CH_UPPER_Z) || (c >= CH_LOWER_A && c <= CH_LOWER_Z);
/** 数字 token 的贪婪扫描字符集：数字 / `.` / `e` / `E` / `+` / `-` */
const isNumberRun = (c: number): boolean =>
  isDigit(c) || c === CH_DOT || c === CH_LOWER_E || c === 0x45 /* E */ || c === CH_PLUS || c === CH_MINUS;

const LITERALS = new Set(['true', 'false', 'null']);

/** 一个容器帧：`{`/`[`、原文偏移、已完成的成员/元素数（仅用于判空容器） */
interface Frame {
  ch: number;
  at: number;
  count: number;
}

/** 最后消费的 token（EOF 处判「半个 token / 尾逗号」用） */
interface Token {
  type: 'number' | 'literal' | 'string' | 'close' | 'comma';
  at: number;
  end: number;
  isKey: boolean;
}

/** 下一个期望：value / key / colon / commaOrEnd / done（顶层值已完成） */
type Slot = 'value' | 'key' | 'colon' | 'commaOrEnd' | 'done';

interface Scan {
  stack: Frame[];
  slot: Slot;
  last: Token | null;
  inString: boolean;
  stringStart: number;
  stringIsKey: boolean;
  /** 字符串末尾半个转义的反斜杠偏移；-1 = 没有 */
  escapeAt: number;
  /** 去掉尾随空白后的结束偏移（判「token 是否真的贴在 EOF 上」） */
  tEnd: number;
}

/**
 * 单趟状态机扫描；返回 null = 遇到**非 EOF 形态**的语法错误（不可修，不猜内容）。
 *
 * 「非 EOF 形态」= 非法字符 / 完整值之后还有内容 / 键位或冒号位被别的 token 占住 /
 * 数字或字面量在中途就已非法（如 `1.2.3`、`tru}`）。
 * 唯一例外：数字/字面量 token **正好结束在 EOF** 时允许它是「不完整前缀」，交给修整阶段。
 */
function scan(source: string): Scan | null {
  const n = source.length;
  let tEnd = n;
  while (tEnd > 0 && isWs(source.charCodeAt(tEnd - 1))) tEnd--;

  const stack: Frame[] = [];
  let slot: Slot = 'value';
  let last: Token | null = null;
  let inString = false;
  let stringStart = -1;
  let stringIsKey = false;
  let escapeAt = -1;

  /** 一个值完成：计入父容器的成员/元素数，并给出下一个槽位 */
  const valueDone = (): Slot => {
    if (stack.length === 0) return 'done';
    stack[stack.length - 1].count++;
    return 'commaOrEnd';
  };

  let i = 0;
  while (i < n) {
    const c = source.charCodeAt(i);

    // ── 字符串内部 ──
    if (inString) {
      if (c === CH_BACKSLASH) {
        if (i + 1 >= n) {
          // 末尾孤零零一个 `\`：半个转义，EOF 修整阶段删掉
          escapeAt = i;
          i = n;
          break;
        }
        const e = source.charCodeAt(i + 1);
        if (e === CH_LOWER_U) {
          if (i + 5 >= n) {
            // `\u00` 之类：字符不够，半个转义
            escapeAt = i;
            i = n;
            break;
          }
          let ok = true;
          for (let k = 2; k <= 5; k++) {
            if (!isHex(source.charCodeAt(i + k))) {
              ok = false;
              break;
            }
          }
          // `\u` 后面不是 4 个 hex → 坏转义（不是截断），拒绝修复
          if (!ok) return null;
          i += 6;
          continue;
        }
        if (!isEscapable(e)) return null;
        i += 2;
        continue;
      }
      if (c === CH_QUOTE) {
        inString = false;
        last = { type: 'string', at: stringStart, end: i + 1, isKey: stringIsKey };
        slot = stringIsKey ? 'colon' : valueDone();
        i++;
        continue;
      }
      // 原始控制字符（< 0x20）在 JSON 字符串里非法
      if (c < 0x20) return null;
      i++;
      continue;
    }

    if (isWs(c)) {
      i++;
      continue;
    }

    // ── 容器开 ──
    if (c === CH_LBRACE || c === CH_LBRACK) {
      if (slot !== 'value') return null;
      stack.push({ ch: c, at: i, count: 0 });
      slot = c === CH_LBRACE ? 'key' : 'value';
      i++;
      continue;
    }

    // ── 容器闭 ──
    if (c === CH_RBRACE || c === CH_RBRACK) {
      const want = c === CH_RBRACE ? CH_LBRACE : CH_LBRACK;
      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      if (top === null || top.ch !== want) return null;
      // 空容器（`{}` / `[]`）允许直接闭合；否则必须刚有一个完整值
      const empty = top.count === 0 && slot === (c === CH_RBRACE ? 'key' : 'value');
      if (!empty && slot !== 'commaOrEnd') return null;
      stack.pop();
      last = { type: 'close', at: i, end: i + 1, isKey: false };
      slot = valueDone();
      i++;
      continue;
    }

    // ── 逗号 ──
    if (c === CH_COMMA) {
      if (slot !== 'commaOrEnd') return null;
      const top = stack[stack.length - 1];
      if (top === undefined) return null;
      slot = top.ch === CH_LBRACE ? 'key' : 'value';
      last = { type: 'comma', at: i, end: i + 1, isKey: false };
      i++;
      continue;
    }

    // ── 冒号 ──
    if (c === CH_COLON) {
      if (slot !== 'colon') return null;
      slot = 'value';
      i++;
      continue;
    }

    // ── 字符串开 ──
    if (c === CH_QUOTE) {
      if (slot === 'key') stringIsKey = true;
      else if (slot === 'value') stringIsKey = false;
      else return null;
      inString = true;
      stringStart = i;
      escapeAt = -1;
      i++;
      continue;
    }

    // ── 数字 ──
    if (c === CH_MINUS || isDigit(c)) {
      if (slot !== 'value') return null;
      let j = i + 1;
      while (j < n && isNumberRun(source.charCodeAt(j))) j++;
      const lit = source.slice(i, j);
      // 中途就非法的数字（`1.2.3`、`01`）不是截断；只有贴在 EOF 上的才可能是半个 token
      if (!isCompleteNumber(lit) && j !== tEnd) return null;
      last = { type: 'number', at: i, end: j, isKey: false };
      slot = valueDone();
      i = j;
      continue;
    }

    // ── 字面量 ──
    if (isLetter(c)) {
      if (slot !== 'value') return null;
      let j = i + 1;
      while (j < n && isLetter(source.charCodeAt(j))) j++;
      const lit = source.slice(i, j);
      // `true/false/null` 之外：只有贴在 EOF 上且是它们的前缀才算截断
      if (!LITERALS.has(lit) && !(j === tEnd && isPartialLiteral(lit))) return null;
      last = { type: 'literal', at: i, end: j, isKey: false };
      slot = valueDone();
      i = j;
      continue;
    }

    // 其余字符（`'`、`@`、`X`、顶层值之后的垃圾……）→ 非 EOF 形态
    return null;
  }

  return { stack, slot, last, inString, stringStart, stringIsKey, escapeAt, tEnd };
}

/** 数字 DFA：返回状态号；-1 = 这个 token 不可能再被补成合法数字 */
const NUM_START = 0;
const NUM_SIGN = 1;
const NUM_ZERO = 2;
const NUM_INT = 3;
const NUM_DOT = 4;
const NUM_FRAC = 5;
const NUM_E = 6;
const NUM_EXP_SIGN = 7;
const NUM_EXP = 8;

function numberState(lit: string): number {
  let st = NUM_START;
  for (let k = 0; k < lit.length; k++) {
    const c = lit.charCodeAt(k);
    const digit = isDigit(c);
    switch (st) {
      case NUM_START:
        if (c === CH_MINUS) st = NUM_SIGN;
        else if (c === CH_ZERO) st = NUM_ZERO;
        else if (digit) st = NUM_INT;
        else return -1;
        break;
      case NUM_SIGN:
        if (c === CH_ZERO) st = NUM_ZERO;
        else if (digit) st = NUM_INT;
        else return -1;
        break;
      case NUM_ZERO:
        if (c === CH_DOT) st = NUM_DOT;
        else if (c === CH_LOWER_E || c === 0x45) st = NUM_E;
        else return -1;
        break;
      case NUM_INT:
        if (digit) st = NUM_INT;
        else if (c === CH_DOT) st = NUM_DOT;
        else if (c === CH_LOWER_E || c === 0x45) st = NUM_E;
        else return -1;
        break;
      case NUM_DOT:
        if (digit) st = NUM_FRAC;
        else return -1;
        break;
      case NUM_FRAC:
        if (digit) st = NUM_FRAC;
        else if (c === CH_LOWER_E || c === 0x45) st = NUM_E;
        else return -1;
        break;
      case NUM_E:
        if (c === CH_PLUS || c === CH_MINUS) st = NUM_EXP_SIGN;
        else if (digit) st = NUM_EXP;
        else return -1;
        break;
      case NUM_EXP_SIGN:
        if (digit) st = NUM_EXP;
        else return -1;
        break;
      default:
        if (digit) st = NUM_EXP;
        else return -1;
        break;
    }
  }
  return st;
}

/** 完整合法的 JSON 数字（可以就此结束） */
function isCompleteNumber(lit: string): boolean {
  const st = numberState(lit);
  return st === NUM_ZERO || st === NUM_INT || st === NUM_FRAC || st === NUM_EXP;
}

/** 合法数字的**前缀**（补更多字符还能变合法，如 `-`、`1.2e+`）；`01`、`1.2.3` 不是 */
function isPartialNumber(lit: string): boolean {
  return numberState(lit) >= 0 && !isCompleteNumber(lit);
}

/** 最长合法前缀；没有则返回 ''（如 `-`，此时整段丢弃，绝不补成 `0`） */
function longestValidNumberPrefix(lit: string): string {
  for (let k = lit.length - 1; k > 0; k--) {
    const head = lit.slice(0, k);
    if (isCompleteNumber(head)) return head;
  }
  return '';
}

function isPartialLiteral(lit: string): boolean {
  for (const word of LITERALS) if (word.startsWith(lit)) return true;
  return false;
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 保守修复入口。语义见文件头与 `RepairAttempt`；任何情况下都不抛错。
 */
export function repairTruncatedJson(source: string): RepairAttempt {
  // 原文本本来合法 → 无需修复（不返回文本，调用方继续用自己的 source）
  if (parses(source)) return { status: 'none' };

  const n = source.length;
  const st = scan(source);
  // 非 EOF 形态（垃圾在完整值后面 / 中途语法错 / 坏转义）：不猜内容
  if (st === null) return { status: 'unrepairable', unrepairableReason: 'not-eof' };

  const { stack, last, inString, stringStart, stringIsKey, escapeAt, tEnd } = st;
  let slot: Slot = st.slot;

  // 空文档 / 只有空白：没有半个结构可闭，不属于截断
  if (!inString && stack.length === 0 && slot === 'value' && last === null) {
    return { status: 'unrepairable', unrepairableReason: 'not-eof' };
  }

  // ── 编辑列表：全部记录**原文本**偏移，最后统一右到左应用 ──
  const ops: RepairOp[] = [];
  const insert = (at: number, text: string, scope: RepairOp['scope'], note: string): void => {
    ops.push({ at, op: 'insert', text, scope, note });
  };
  const remove = (at: number, end: number, scope: RepairOp['scope'], note: string): void => {
    if (end > at) ops.push({ at, op: 'delete', text: source.slice(at, end), scope, note });
  };
  /** 保留内容在原文本中的结束偏移（被删 token 的起点） */
  let cutEnd = tEnd;

  /** 删掉紧贴在 `before` 之前的尾随逗号（跳过空白），返回新的 cutEnd */
  const dropTrailingComma = (before: number): number => {
    let e = before;
    while (e > 0 && isWs(source.charCodeAt(e - 1))) e--;
    if (e > 0 && source.charCodeAt(e - 1) === CH_COMMA) {
      remove(e - 1, e, 'comma', '尾随逗号 → 删除');
      return e - 1;
    }
    return before;
  };

  // ── 规则 1：EOF 落在字符串里 ──
  if (inString) {
    if (stringIsKey) {
      // 键名没写完 → 这个成员没有值可保留：删整个成员（不补引号、不猜键名）
      remove(stringStart, n, 'member', '键名未写完且没有值可保留 → 丢弃整个成员（不补引号）');
      cutEnd = dropTrailingComma(stringStart);
      slot = 'commaOrEnd';
    } else {
      // 值字符串：先丢掉末尾半个转义（不猜测被截掉的字符），再补结束引号
      if (escapeAt >= 0) {
        remove(escapeAt, n, 'string', '末尾是不完整转义 → 丢弃（不猜测字符）');
        cutEnd = escapeAt;
      }
      insert(n, '"', 'string', '字符串未闭合 → 补结束引号');
      slot = 'commaOrEnd';
    }
  }

  // ── 规则 2：EOF 处是半个 token（只可能是贴在 EOF 上的最后一个 token）──
  if (!inString && last !== null && last.end === tEnd) {
    const lit = source.slice(last.at, last.end);
    if (last.type === 'literal' && !LITERALS.has(lit)) {
      if (!isPartialLiteral(lit)) return { status: 'unrepairable', unrepairableReason: 'not-eof' };
      remove(last.at, last.end, 'token', `不完整字面量 \`${lit}\` → 丢弃（不猜测 true/false/null）`);
      cutEnd = last.at;
      slot = 'value'; // 值槽空了 → 规则 4 接着删掉悬空成员
    } else if (last.type === 'number' && !isCompleteNumber(lit)) {
      if (!isPartialNumber(lit)) return { status: 'unrepairable', unrepairableReason: 'not-eof' };
      const keep = longestValidNumberPrefix(lit);
      if (keep === '') {
        remove(last.at, last.end, 'token', `不完整数字 \`${lit}\` → 整段丢弃（没有合法前缀可保留）`);
        cutEnd = last.at;
        slot = 'value';
      } else {
        remove(
          last.at + keep.length,
          last.end,
          'token',
          `不完整数字 \`${lit}\` → 只保留合法前缀 \`${keep}\`（不补数字）`,
        );
        cutEnd = last.at + keep.length;
        slot = 'commaOrEnd';
      }
    }
  }

  // ── 规则 3：逗号不可能出现在闭合符前 → 尾逗号删掉 ──
  if (!inString && last !== null && last.type === 'comma' && last.end === tEnd) {
    remove(last.at, last.end, 'comma', '尾随逗号 → 删除');
    cutEnd = last.at;
    slot = 'commaOrEnd';
  }

  // ── 规则 4：悬空成员（期待值却到 EOF）──
  if (!inString) {
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (slot === 'colon' && top !== null && top.ch === CH_LBRACE && last !== null && last.type === 'string' && last.isKey) {
      // 键已闭合但既没冒号也没值：删掉这个键（不补值）
      remove(last.at, last.end, 'member', '键已闭合但后面没有值 → 删除该键（不补值、不猜冒号）');
      cutEnd = dropTrailingComma(last.at);
      slot = 'commaOrEnd';
    } else if (slot === 'value') {
      if (top !== null && top.ch === CH_LBRACE) {
        // 对象：删「键 + 冒号」（+ 前一个逗号）
        let e = cutEnd;
        while (e > 0 && isWs(source.charCodeAt(e - 1))) e--;
        if (e > 0 && source.charCodeAt(e - 1) === CH_COLON) {
          let ke = e - 1;
          while (ke > 0 && isWs(source.charCodeAt(ke - 1))) ke--;
          let ks = -1;
          if (ke > 0 && source.charCodeAt(ke - 1) === CH_QUOTE) {
            ks = ke - 2;
            while (ks >= 0) {
              const kc = source.charCodeAt(ks);
              if (kc === CH_BACKSLASH) {
                ks -= 2;
                continue;
              }
              if (kc === CH_QUOTE) break;
              ks--;
            }
          }
          // 找不到键起点说明结构对不上（理论上不会发生）→ 保守拒绝
          if (ks < 0) return { status: 'unrepairable', unrepairableReason: 'not-eof' };
          remove(ks, e, 'member', '悬空的键（后面没有值）→ 连同冒号删除');
          cutEnd = dropTrailingComma(ks);
          slot = 'commaOrEnd';
        } else {
          // 没有冒号可删，只清理可能残留的尾逗号
          const after = dropTrailingComma(cutEnd);
          if (after !== cutEnd) {
            cutEnd = after;
            slot = 'commaOrEnd';
          }
        }
      } else {
        // 数组：元素槽空了（半个字面量/数字被删）→ 连带前一个逗号一起删
        const after = dropTrailingComma(cutEnd);
        if (after !== cutEnd) {
          cutEnd = after;
          slot = 'commaOrEnd';
        }
      }
    }
  }

  // ── 规则 5：按容器栈逆序补闭合符（一条 insert op）──
  if (stack.length > 0) {
    const closers = stack
      .map((f) => (f.ch === CH_LBRACE ? '}' : ']'))
      .reverse()
      .join('');
    const where = stack.map((f) => (f.ch === CH_LBRACE ? '{' : '[') + '@' + f.at).join(', ');
    insert(n, closers, 'container', `补 ${closers.length} 个闭合符 \`${closers}\`（对应未闭合的 ${where}）`);
  }

  // ── 自校验：应用编辑后必须真的可解析 ──
  const text = applyOps(source, ops);
  if (!parses(text)) return { status: 'unrepairable', unrepairableReason: 'still-invalid' };

  const counts = countOps(ops);
  // 对外按「离 EOF 近的在前」排（§6.3 的 ops 示例形态），便于摘要列表逐条展示；
  // 应用顺序与应用无关（applyOps 自己按偏移切片），同偏移的插入由 scope 定序。
  const ordered = ops.slice().sort((a, b) => b.at - a.at);
  return { status: 'repaired', text, truncatedAt: n, counts, ops: ordered, summaryText: summarize(counts) };
}

/** 插入文本在同一偏移上的先后：先补结束引号（string），再补闭合符（container） */
function insertRank(op: RepairOp): number {
  return op.scope === 'string' ? 0 : 1;
}

/**
 * 把编辑列表应用回原文本：delete 删区间，insert 在偏移处插入（同偏移按 scope 定序）。
 * 按编辑点切片拼接（不做逐字符 += ），大文档下也是 O(n) 的一次拷贝。
 */
function applyOps(source: string, ops: readonly RepairOp[]): string {
  const n = source.length;
  const insertsAt = new Map<number, RepairOp[]>();
  const deletes: { at: number; end: number }[] = [];
  for (const op of ops) {
    if (op.op === 'insert') {
      const list = insertsAt.get(op.at);
      if (list === undefined) insertsAt.set(op.at, [op]);
      else list.push(op);
    } else {
      deletes.push({ at: op.at, end: op.at + op.text.length });
    }
  }
  deletes.sort((a, b) => a.at - b.at);
  const insPos = [...insertsAt.keys()].sort((a, b) => a - b);

  let out = '';
  let pos = 0; // 尚未拷贝的原文位置
  let p = 0;
  let d = 0;
  while (p < insPos.length || d < deletes.length) {
    const insAt = p < insPos.length ? insPos[p] : n + 1;
    const delAt = d < deletes.length ? deletes[d].at : n + 1;
    const next = Math.min(insAt, delAt);
    if (next > pos) {
      out += source.slice(pos, next);
      pos = next;
    }
    if (insAt === next) {
      const list = insertsAt.get(next) as RepairOp[];
      // 稳定排序（ES2019+ sort 稳定）：结束引号永远排在闭合符之前
      list.sort((a, b) => insertRank(a) - insertRank(b));
      for (const op of list) out += op.text;
      p++;
    }
    if (delAt === next) {
      pos = Math.max(pos, deletes[d].end);
      d++;
      // 相邻/重叠的删除区间一次吃掉
      while (d < deletes.length && deletes[d].at <= pos) {
        pos = Math.max(pos, deletes[d].end);
        d++;
      }
    }
  }
  if (pos < n) out += source.slice(pos, n);
  return out;
}

/** counts：`brackets` = 补的闭合符个数，`quotes` = 补的结束引号个数，`commas` = 删的尾逗号个数 */
function countOps(ops: readonly RepairOp[]): RepairCounts {
  const counts: RepairCounts = { brackets: 0, quotes: 0, commas: 0, deletedChars: 0 };
  for (const op of ops) {
    if (op.op === 'insert') {
      if (op.scope === 'container') counts.brackets += op.text.length;
      else if (op.scope === 'string') counts.quotes += 1;
    } else {
      // deletedChars = 删掉的字符总数（含尾逗号；尾逗号另在 commas 里单列）
      counts.deletedChars += op.text.length;
      if (op.scope === 'comma') counts.commas += 1;
    }
  }
  return counts;
}

/** 一行中文摘要；零计数项省略，固定以「仅语法闭合，未修改任何已有值」收尾 */
function summarize(counts: RepairCounts): string {
  const bits: string[] = [];
  if (counts.deletedChars > 0) bits.push(`删除 ${counts.deletedChars} 个字符`);
  const closes: string[] = [];
  if (counts.brackets > 0) closes.push(`${counts.brackets} 个闭合符`);
  if (counts.quotes > 0) closes.push(`${counts.quotes} 个结束引号`);
  if (closes.length > 0) bits.push('补 ' + closes.join('、'));
  if (bits.length === 0) return '已修复（仅语法闭合，未修改任何已有值）';
  return `已修复：${bits.join('、')}（仅语法闭合，未修改任何已有值）`;
}
