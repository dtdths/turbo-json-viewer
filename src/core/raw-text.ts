/**
 * core/raw-text — 原文行索引（ADR-0003 修订 2026-11-03 §3 / reassess-fidelity §4.4–§4.5）。
 *
 * 一份源文本，三种行布局模式（**只读**、纯函数、无 DOM）：
 *   - `source`：源文本已有可用短行 → 源码行虚拟化（行文本 = 源切片，保留用户原始格式）；
 *   - `pretty`：源文本是 minified / 有超长行 → 检查点 pretty 行走器合成规范布局，
 *     行文本仍是源切片（大整数 / `\uXXXX` 转义 / 键序天然保真）；
 *   - `plain`：源文本非法（截断修复后的文档）→ 按 `\n` 分行 + 每行硬切
 *     `RAW_LINE_DISPLAY_MAX` 字符，纯文本、无语法高亮。
 *
 * 索引结构（reassess-fidelity §4.5）：
 *   - 形状探测一次 `indexOf('\n')` 扫描拿行数与最长行（50MB ≈ 7ms）；
 *   - 检查点每 `cpEvery`（默认 2048）行一个 `{lineIndex, srcOffset, depth}`（`Int32Array`），
 *     取窗口时从最近检查点重走 ≤cpEvery 行 —— 不存全量行偏移（3.33M 行只需 19.5KiB）。
 *
 * 行文本在取窗口时才 `slice`，不物化全文；单行显示上限 `RAW_LINE_DISPLAY_MAX`，
 * 超出部分截断显示并在 `truncated` 里记隐藏字符数（**复制原文**不受此限，走 `rawSource`）。
 *
 * 来源：`prototype/p1/bench/fidelity/lib/raw-view.mjs`（walkPretty / renderPrettyLine /
 * PrettyLineView / SourceLineView 的 TS 移植，lexer 复用 `src/shared/json-lex.ts`）。
 */
import type { RawMeta, RawMode } from '../protocol/types';
import { RAW_CP_EVERY, RAW_LINE_DISPLAY_MAX, RAW_MAX_LINE_LENGTH } from '../protocol/versions';
import { C, T, last, lexToken, skipWs } from '../shared/json-lex';

/** 行记录 kind：OPEN/CLOSE 单独成行；KEY = 键 + 值同一行；KEY_OPEN = 键 + 容器开括号；SCALAR = 标量/空容器 */
const K = {
  OPEN: 0,
  CLOSE: 1,
  KEY: 2,
  KEY_OPEN: 3,
  SCALAR: 4,
} as const;

type LineKind = (typeof K)[keyof typeof K];

/** 一行 pretty 布局记录；walker 内复用同一个对象，回调方不得持有 */
interface LineRec {
  start: number;
  end: number;
  depth: number;
  kind: LineKind;
}

export interface RawTextOptions {
  /** true = 源文本非法（截断修复后的文档）→ 只能 plain 展示 */
  damaged?: boolean;
  /** 检查点间隔（行）；单测注入小值验证检查点边界可重放 */
  cpEvery?: number;
  /** 源码行模式的最长行阈值；超过 → pretty（ADR-0003 修订 §3） */
  maxLineLength?: number;
}

/**
 * 形状探测：行数 = `\n` 数量 + 1，最长行 = 最大行字符数（一次 `indexOf` 扫描、零分配）。
 * 空文本 → 1 行、最长行 0；`\r` 计入行字符数（CRLF 原样，不做规范化）。
 */
export function probeText(text: string): { lines: number; maxLine: number } {
  const n = text.length;
  let lines = 1;
  let maxLine = 0;
  let lastNl = -1;
  let nl = text.indexOf('\n');
  while (nl >= 0) {
    lines++;
    const len = nl - lastNl - 1;
    if (len > maxLine) maxLine = len;
    lastNl = nl;
    nl = text.indexOf('\n', nl + 1);
  }
  const tail = n - lastNl - 1;
  if (tail > maxLine) maxLine = tail;
  return { lines, maxLine };
}

/**
 * 从 `(pos, depth)` 起按 `JSON.stringify(value, null, 2)` 的行布局逐行吐出记录。
 * 无状态（只依赖 pos/depth）→ 可从任意检查点重放。
 *
 * @param lineIndex0 起始行号（检查点重放时与真实行号对齐）
 * @returns 走完的行数（回调提前返回 false 时 = 当前行 + 1）
 */
function walkPretty(
  text: string,
  pos: number,
  depth: number,
  cb: (rec: LineRec, lineIndex: number) => boolean | void,
  lineIndex0 = 0,
): number {
  const n = text.length;
  let lineIndex = lineIndex0;
  const rec: LineRec = { start: 0, end: 0, depth: 0, kind: K.SCALAR };
  for (;;) {
    pos = skipWs(text, pos);
    if (pos >= n) break;
    const c = text.charCodeAt(pos);

    if (c === C.RBRACE || c === C.RBRACK) {
      depth--;
      rec.start = pos;
      rec.end = pos + 1;
      rec.depth = depth;
      rec.kind = K.CLOSE;
      pos++;
    } else if (c === C.LBRACE || c === C.LBRACK) {
      const closer = c === C.LBRACE ? C.RBRACE : C.RBRACK;
      const p = skipWs(text, pos + 1);
      if (text.charCodeAt(p) === closer) {
        rec.start = pos;
        rec.end = p + 1;
        rec.depth = depth;
        rec.kind = K.SCALAR; // 空 {} / [] 单独一行
        pos = p + 1;
      } else {
        rec.start = pos;
        rec.end = pos + 1;
        rec.depth = depth;
        rec.kind = K.OPEN;
        depth++;
        pos++;
      }
    } else if (c === C.QUOTE) {
      // 字符串：可能是对象键（后跟 ':'），也可能是普通标量值
      const keyEnd = lexToken(text, pos);
      const ktype = last.type;
      let p = skipWs(text, keyEnd);
      if (ktype === T.STR && text.charCodeAt(p) === C.COLON) {
        p = skipWs(text, p + 1);
        const vc = text.charCodeAt(p);
        if (vc === C.LBRACE || vc === C.LBRACK) {
          const closer = vc === C.LBRACE ? C.RBRACE : C.RBRACK;
          const q = skipWs(text, p + 1);
          if (text.charCodeAt(q) === closer) {
            rec.start = pos;
            rec.end = q + 1;
            rec.depth = depth;
            rec.kind = K.KEY; // "k": {} / [] 同行
            pos = q + 1;
          } else {
            rec.start = pos;
            rec.end = p + 1;
            rec.depth = depth;
            rec.kind = K.KEY_OPEN; // "k": { 换行
            depth++;
            pos = p + 1;
          }
        } else {
          const ve = lexToken(text, p);
          rec.start = pos;
          rec.end = ve;
          rec.depth = depth;
          rec.kind = K.KEY; // "k": scalar
          pos = ve;
        }
      } else {
        rec.start = pos;
        rec.end = keyEnd;
        rec.depth = depth;
        rec.kind = K.SCALAR;
        pos = keyEnd;
      }
    } else {
      const ve = lexToken(text, pos);
      rec.start = pos;
      rec.end = ve;
      rec.depth = depth;
      rec.kind = K.SCALAR;
      pos = ve;
    }

    if (cb(rec, lineIndex) === false) return lineIndex + 1;
    lineIndex++;
    // 统一的尾巴处理：可选的逗号分隔本行与下一行
    pos = skipWs(text, pos);
    if (text.charCodeAt(pos) === C.COMMA) pos++;
  }
  return lineIndex;
}

/** 用源切片重建一行 pretty 文本（≤ 2 个 token：补缩进 / 冒号 / 逗号，不做值序列化）。 */
function renderPrettyLine(text: string, rec: LineRec): string {
  const indent = rec.depth > 0 ? ' '.repeat(rec.depth * 2) : '';
  let body: string;
  if (rec.kind === K.KEY || rec.kind === K.KEY_OPEN) {
    const keyEnd = lexToken(text, rec.start);
    let p = skipWs(text, keyEnd);
    if (text.charCodeAt(p) === C.COLON) p = skipWs(text, p + 1);
    body = text.slice(rec.start, keyEnd) + ': ' + text.slice(p, rec.end);
  } else {
    body = text.slice(rec.start, rec.end);
  }
  // 源里紧跟在本行后的逗号（OPEN 行后面不会跟逗号）
  const p = skipWs(text, rec.end);
  const comma = text.charCodeAt(p) === C.COMMA;
  return indent + body + (comma && rec.kind !== K.OPEN ? ',' : '');
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** 毫秒保留 3 位小数（与原型 / RawMeta.buildMs 口径一致） */
function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** 把 start/count 夹到 [min, max] 的整数（非有限值 → min）。 */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(min, Math.floor(value)), max);
}

/**
 * 原文行索引：构造后 **惰性构建**（`build()` 幂等；`meta()/windowText()/locate()` 首次调用时自动构建）。
 *
 * 三个模式下 `cp` 的槽位含义：
 *   - source：[sourceLineIndex, srcOffset]（每 cpEvery 源行一个）
 *   - plain： [displayLineIndex, srcOffset]（每 cpEvery 显示行一个；硬切后的显示行坐标系）
 *   - pretty：[lineIndex, srcOffset, depth]（每 cpEvery 行一个）
 */
export class RawTextIndex {
  readonly text: string;
  readonly mode: RawMode;
  readonly chars: number;
  readonly damaged: boolean;
  readonly cpEvery: number;
  readonly maxLineLength: number;

  private readonly probe: { lines: number; maxLine: number };
  private built = false;
  private lineCount = 0;
  private cp = new Int32Array(0);
  private cpCount = 0;
  private buildMillis = 0;

  constructor(text: string, opts: RawTextOptions = {}) {
    this.text = text;
    this.chars = text.length;
    this.damaged = opts.damaged === true;
    this.cpEvery = Math.max(1, Math.floor(opts.cpEvery ?? RAW_CP_EVERY));
    this.maxLineLength = opts.maxLineLength ?? RAW_MAX_LINE_LENGTH;
    this.probe = probeText(text);
    // damaged 优先：修复后的文档行结构不可信，只能纯文本展示
    this.mode = this.damaged ? 'plain' : this.probe.maxLine <= this.maxLineLength ? 'source' : 'pretty';
  }

  /** 构建检查点索引（幂等；O(n) 一次 pass，热循环零分配）。 */
  build(): this {
    if (this.built) return this;
    const t0 = now();
    if (this.mode === 'plain') this.buildPlain();
    else if (this.mode === 'source') this.buildSource();
    else this.buildPretty();
    this.built = true;
    this.buildMillis = roundMs(now() - t0);
    return this;
  }

  /** 索引元信息（`rawOpen` 回包；不含行文本）。首调触发惰性构建。 */
  meta(): RawMeta {
    this.build();
    const meta: RawMeta = {
      mode: this.mode,
      totalLines: this.lineCount,
      chars: this.chars,
      maxLineLength: this.probe.maxLine,
      buildMs: this.buildMillis,
    };
    if (this.damaged) meta.damaged = true;
    return meta;
  }

  /** 总显示行数（滚动条唯一需要的数量）。 */
  get totalLines(): number {
    this.build();
    return this.lineCount;
  }

  /**
   * 取窗口行文本（每行 ≤ `RAW_LINE_DISPLAY_MAX`）。
   * `truncated` 与 `lines` 对齐（0 = 完整）；没有任何截断时缺省。
   */
  windowText(startLine: number, count: number): { lines: string[]; truncated?: number[] } {
    this.build();
    const total = this.lineCount;
    const start = clampInt(startLine, 0, total);
    const wanted = clampInt(count, 0, total - start);
    if (wanted === 0) return { lines: [] };

    const lines: string[] = [];
    const truncated: number[] = [];
    if (this.mode === 'plain') this.plainWindow(start, wanted, lines);
    else if (this.mode === 'source') this.sourceWindow(start, wanted, lines, truncated);
    else this.prettyWindow(start, wanted, lines, truncated);
    // 没有任何一行被截断 → truncated 缺省（不要回一包全 0）
    if (!truncated.some((hidden) => hidden > 0)) return { lines };
    return { lines, truncated };
  }

  /**
   * 源文本偏移 → 1-based 显示行号（修复摘要 `at` 跳行）。
   * 偏移夹取到 `[0, chars]`；'\n' 属于它终止的那行；plain 下为硬切后的显示行。
   */
  locate(offset: number): number {
    this.build();
    const pos = clampInt(offset, 0, this.chars);
    if (this.mode === 'plain') return this.locatePlain(pos);
    if (this.mode === 'source') return this.locateSource(pos);
    return this.locatePretty(pos);
  }

  /* ------------------------------ 构建 ------------------------------ */

  private buildSource(): void {
    const text = this.text;
    const every = this.cpEvery;
    const tmp: number[] = [0, 0]; // lineIndex, srcOffset
    let line = 0;
    let pos = 0;
    for (;;) {
      const nl = text.indexOf('\n', pos);
      if (nl < 0) break;
      line++;
      pos = nl + 1;
      if (line % every === 0) tmp.push(line, pos);
    }
    this.lineCount = line + 1;
    this.cp = Int32Array.from(tmp);
    this.cpCount = tmp.length / 2;
  }

  private buildPlain(): void {
    const text = this.text;
    const n = this.chars;
    const every = this.cpEvery;
    const displayMax = RAW_LINE_DISPLAY_MAX;
    const tmp: number[] = [0, 0]; // displayLineIndex, srcOffset
    let display = 0;
    let pos = 0;
    for (;;) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl < 0 ? n : nl;
      const chunks = lineEnd > pos ? Math.ceil((lineEnd - pos) / displayMax) : 1; // 空行也是 1 个显示行
      for (let k = 0; k < chunks; k++) {
        if (display % every === 0) tmp.push(display, pos + k * displayMax);
        display++;
      }
      if (nl < 0) break;
      pos = nl + 1;
    }
    this.lineCount = display;
    this.cp = Int32Array.from(tmp);
    this.cpCount = tmp.length / 2;
  }

  private buildPretty(): void {
    const text = this.text;
    const every = this.cpEvery;
    const tmp: number[] = [0, skipWs(text, 0), 0]; // lineIndex, srcOffset, depth
    let count = 0;
    walkPretty(text, 0, 0, (rec, li) => {
      if (li > 0 && li % every === 0) tmp.push(li, rec.start, rec.depth);
      count = li + 1;
    });
    this.lineCount = count;
    this.cp = Int32Array.from(tmp);
    this.cpCount = tmp.length / 3;
  }

  /* ------------------------------ 取窗口 ------------------------------ */

  /** 把一行源/合成文本按显示上限截断（source / pretty 用；plain 已硬切不会超限）。 */
  private pushDisplayLine(line: string, lines: string[], truncated: number[]): void {
    if (line.length > RAW_LINE_DISPLAY_MAX) {
      lines.push(line.slice(0, RAW_LINE_DISPLAY_MAX));
      truncated.push(line.length - RAW_LINE_DISPLAY_MAX);
    } else {
      lines.push(line);
      truncated.push(0);
    }
  }

  private sourceWindow(start: number, need: number, lines: string[], truncated: number[]): void {
    const text = this.text;
    const n = this.chars;
    const cp = this.cp;
    // 二分：lineIndex <= start 的最近检查点
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 2] <= start) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let line = cp[best * 2];
    let pos = cp[best * 2 + 1];
    while (line < start) {
      const nl = text.indexOf('\n', pos);
      if (nl < 0) {
        pos = n;
        line = this.lineCount;
        break;
      }
      pos = nl + 1;
      line++;
    }
    let remaining = need;
    while (remaining > 0) {
      const nl = text.indexOf('\n', pos);
      const end = nl < 0 ? n : nl;
      this.pushDisplayLine(text.slice(pos, end), lines, truncated);
      pos = nl < 0 ? n : nl + 1;
      remaining--;
    }
  }

  private plainWindow(start: number, need: number, lines: string[]): void {
    const text = this.text;
    const n = this.chars;
    const displayMax = RAW_LINE_DISPLAY_MAX;
    const cp = this.cp;
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 2] <= start) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let display = cp[best * 2];
    let pos = cp[best * 2 + 1];
    // 从检查点前进到目标显示行（≤ cpEvery 个显示块）
    while (display < start) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl < 0 ? n : nl;
      if (pos + displayMax < lineEnd) pos += displayMax; // 还有后续块
      else pos = nl < 0 ? n : nl + 1; // 本行最后一块 → 下一源行
      display++;
    }
    while (display < this.lineCount && lines.length < need) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl < 0 ? n : nl;
      const end = Math.min(pos + displayMax, lineEnd);
      lines.push(text.slice(pos, end));
      pos = end >= lineEnd ? (nl < 0 ? n : nl + 1) : end;
      display++;
    }
  }

  private prettyWindow(start: number, need: number, lines: string[], truncated: number[]): void {
    const text = this.text;
    const cp = this.cp;
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 3] <= start) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const fromLine = cp[best * 3];
    const pos = cp[best * 3 + 1];
    const depth = cp[best * 3 + 2];
    walkPretty(
      text,
      pos,
      depth,
      (rec, li) => {
        if (li < start) return;
        this.pushDisplayLine(renderPrettyLine(text, rec), lines, truncated);
        return lines.length < need;
      },
      fromLine,
    );
  }

  /* ------------------------------ 定位 ------------------------------ */

  private locateSource(pos: number): number {
    const text = this.text;
    const cp = this.cp;
    // 二分：srcOffset <= pos 的最近检查点（cp 的 srcOffset 单调递增）
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 2 + 1] <= pos) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let line = cp[best * 2];
    let at = cp[best * 2 + 1];
    // 只数 pos 之前的 '\n'（pos 处的 '\n' 属于它终止的那行）
    for (;;) {
      const nl = text.indexOf('\n', at);
      if (nl < 0 || nl >= pos) break;
      line++;
      at = nl + 1;
    }
    return line + 1;
  }

  private locatePlain(pos: number): number {
    const text = this.text;
    const n = this.chars;
    const displayMax = RAW_LINE_DISPLAY_MAX;
    const cp = this.cp;
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 2 + 1] <= pos) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let display = cp[best * 2];
    let start = cp[best * 2 + 1];
    // 逐显示块前进到包含 pos 的块（≤ cpEvery 块）
    for (;;) {
      if (display >= this.lineCount) return this.lineCount;
      const nl = text.indexOf('\n', start);
      const lineEnd = nl < 0 ? n : nl;
      const chunkEnd = Math.min(start + displayMax, lineEnd);
      const lastChunk = chunkEnd >= lineEnd;
      // pos 落在本块内；本块是该源行最后一块时，pos == lineEnd（'\n'/EOF）也属于本行
      if (pos < chunkEnd || (lastChunk && pos === chunkEnd)) return display + 1;
      if (lastChunk) start = nl < 0 ? n : nl + 1;
      else start = chunkEnd;
      display++;
    }
  }

  private locatePretty(pos: number): number {
    const text = this.text;
    const cp = this.cp;
    let lo = 0;
    let hi = this.cpCount - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp[mid * 3 + 1] <= pos) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const fromLine = cp[best * 3];
    let line = fromLine;
    walkPretty(
      text,
      cp[best * 3 + 1],
      cp[best * 3 + 2],
      (rec, li) => {
        if (rec.start > pos) return false;
        line = li;
      },
      fromLine,
    );
    return Math.min(line + 1, this.lineCount);
  }
}

/** 构造并立即构建一份原文行索引（`rawOpen` 首调惰性构建用）。 */
export function buildRawIndex(text: string, opts: RawTextOptions = {}): RawTextIndex {
  return new RawTextIndex(text, opts).build();
}
