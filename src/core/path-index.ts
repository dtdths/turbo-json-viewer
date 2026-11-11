/**
 * core/path-index — 源文本结构索引：规范路径 ↔ 源文本偏移（#30 / ADR-0019 双向定位）。
 *
 * 为什么需要：值图来自 `JSON.parse`，**不保留源偏移**；原文视图是行级虚拟化（只有行号/行文本，
 * 没有节点身份）。所以「原文行 ↔ 树节点」必须重新扫源文本：
 *   - `offset → path`（原文→树）：检查点（每 `RAW_PATH_CP_NODES` 个节点 = 完整帧链 + 祖先键栈）
 *     + 从最近检查点续走，懒建一次；50MB 实测索引 ≈ 几十 KiB、命中 ≈ 0.1ms；
 *   - `path → offset`（树→原文）：路径在源文本里**没有单调性**，检查点帮不上，做单趟扫描；
 *     由调用方（`DocService`）按根做 LRU 缓存（重复跳同一节点 0ms）。
 *
 * 硬约束：只读、纯计算（不碰值图/行模型/行索引）、迭代实现（无递归栈限制）、零 DOM。
 * 扫描期键只存 `(contentStart, len)` 数字，**命中才解码拼路径**（避免为每个节点分配路径字符串）。
 *
 * 锚点定义（左右两侧共用，ADR-0019 §3）：对象成员 = 键起点；数组元素 / 根 = 值起点。
 * ``exact=false`` 只出现在「行首是容器开括号、键在上一行」的源码行模式下，path 仍是该容器。
 */
import type { Path } from '../protocol/types';
import type { PathSegment } from '../shared/path';
import { appendIndex, appendKey, parsePath } from '../shared/path';
import { CH, JsonLexer } from '../shared/json-lex';
import { RAW_PATH_CP_NODES } from '../protocol/versions';

/** `pathAtOffset` 命中：`exact` = 命中节点起点；false = 命中容器开括号（键在上一行）。 */
export interface PathAtOffsetHit {
  path: Path;
  exact: boolean;
}

interface Frame {
  isObj: boolean;
  closer: number;
  /** 下一个待处理子项位置（源偏移；可能指向空白/逗号之后） */
  pos: number;
  /** 数组下标 / 对象成员序号 */
  idx: number;
}

/** 扫描期段栈：kind 0=对象键 / 1=数组下标（与 shared/path 的段类型对齐） */
const SEG_KEY = 0;
const SEG_INDEX = 1;

const BACKSLASH = 92;

interface SourcePathIndexOptions {
  /** 检查点间隔（节点数）；单测注入小值验证续走边界可重放 */
  cpEvery?: number;
}

/**
 * 源文本 path↔offset 索引。构造后**惰性构建检查点**（首次 `pathAtOffset` 才扫一遍）。
 *
 * 只对「解析成功」的源文本有意义：plain 模式（截断修复后的文本）由调用方直接回 null，
 * 不要构造本索引（行结构与值图不对应）。
 */
export class SourcePathIndex {
  readonly text: string;
  readonly cpEvery: number;

  private built = false;
  private nodes = 0;

  /* 根节点信息（构造时算好，不依赖检查点） */
  private rootPos = -1;
  private rootScalar = true;
  private rootCloser = 0;

  /* 检查点（扁平 Int32Array：位置 / 帧链 / 段栈） */
  private cpPos = new Int32Array(0);
  private cpFrameOff = new Int32Array(0);
  private cpFrameData = new Int32Array(0);
  private cpStackOff = new Int32Array(0);
  private cpStackData = new Int32Array(0);

  /* 行走器状态（每次 walk 重置） */
  private readonly lex = new JsonLexer();
  private frames: Frame[] = [];
  private segKind: number[] = [];
  private segA: number[] = [];
  private segB: number[] = [];

  constructor(text: string, opts: SourcePathIndexOptions = {}) {
    this.text = text;
    this.cpEvery = Math.max(1, Math.floor(opts.cpEvery ?? RAW_PATH_CP_NODES));
    this.probeRoot();
  }

  /** 扫描过的节点总数（诊断/验收用；未构建检查点前只有根节点计数）。 */
  get nodeCount(): number {
    return this.nodes;
  }

  get checkpointCount(): number {
    return this.cpPos.length;
  }

  /** 检查点内存占用（字节，诊断/验收用：ADR-0019 实测口径）。 */
  get memoryBytes(): number {
    return (
      this.cpPos.byteLength +
      this.cpFrameOff.byteLength +
      this.cpFrameData.byteLength +
      this.cpStackOff.byteLength +
      this.cpStackData.byteLength
    );
  }

  /**
   * 源文本偏移 → 该位置**节点**的路径。`null` = 不是任何节点的起点/容器开括号。
   *
   * 先按检查点二分（页码 = 节点序号），从最近检查点续走 ≤cpEvery 个节点；不命中就 null。
   */
  pathAtOffset(offset: number): PathAtOffsetHit | null {
    if (!Number.isFinite(offset)) return null;
    const target = Math.floor(offset);
    if (target < 0 || target >= this.text.length) return null;
    if (this.rootPos < 0) return null;
    if (target === this.rootPos) return { path: '$', exact: true };
    if (this.rootScalar) return null;
    this.ensureBuilt();

    let hit: PathAtOffsetHit | null = null;
    const resume = this.resumeFor(target);
    this.walk(resume, (anchor, valueStart) => {
      if (anchor === target) {
        hit = { path: this.pathFromStack(), exact: true };
        return true;
      }
      // 行首是成员的值起点（源码行模式下键在上一行）：仍归属该节点，exact=false
      if (valueStart === target) {
        hit = { path: this.pathFromStack(), exact: false };
        return true;
      }
      // 前序锚点单调递增：越过目标就不可能有命中（子节点锚点更大）
      if (anchor > target) return true;
      return false;
    });
    return hit;
  }

  /**
   * 路径 → 节点锚点偏移（**重复键取最后一个源位置**，与 `JSON.parse` 生效值一致）。
   * `null` = 源文本里没有这个路径。
   *
   * 用「祖先路径匹配」剪枝：只沿目标前缀比较，其余节点只走不比较（50MB ≈ 单趟词法成本）。
   */
  offsetOfPath(path: Path): number | null {
    if (this.rootPos < 0) return null;
    let segs: PathSegment[];
    try {
      segs = parsePath(path);
    } catch {
      return null;
    }
    if (segs.length === 0) return this.rootPos;

    let hit = -1;
    const onPath: boolean[] = [];
    this.walk(null, (anchor, _valueStart, _isContainer, depth) => {
      if (depth === 0) {
        onPath[0] = true;
        return false;
      }
      const parentOn = depth - 1 < onPath.length && onPath[depth - 1] === true;
      let matched = false;
      if (parentOn && depth <= segs.length) {
        matched = this.segMatches(depth - 1, segs[depth - 1] as PathSegment);
        if (matched && depth === segs.length) hit = anchor;
      }
      onPath[depth] = matched && depth < segs.length;
      return false;
    });
    return hit >= 0 ? hit : null;
  }

  // ---------------------------------------------------------------- 构建 / 续走

  private probeRoot(): void {
    const text = this.text;
    const pos = this.lex.skipWs(text, 0);
    if (pos >= text.length) return;
    this.rootPos = pos;
    this.nodes = 1;
    const c = text.charCodeAt(pos);
    if (c === CH.LBRACE || c === CH.LBRACK) {
      this.rootScalar = false;
      this.rootCloser = c === CH.LBRACE ? CH.RBRACE : CH.RBRACK;
    }
  }

  /** 构建检查点（幂等；一次全量迭代行走，热循环零分配）。 */
  private ensureBuilt(): void {
    if (this.built) return;
    this.built = true;

    const cpPos: number[] = [];
    const frameOff: number[] = [0];
    const frameData: number[] = [];
    const stackOff: number[] = [0];
    const stackData: number[] = [];
    const every = this.cpEvery;

    this.walk(
      null,
      () => false,
      (p, ordinal) => {
        if (ordinal % every !== 0) return;
        cpPos.push(p);
        for (const f of this.frames) {
          frameData.push(f.isObj ? 1 : 0, f.closer, f.pos, f.idx);
        }
        frameOff.push(frameData.length);
        const len = this.segKind.length;
        for (let i = 0; i < len; i++) stackData.push(this.segKind[i] as number, this.segA[i] as number, this.segB[i] as number);
        stackOff.push(stackData.length);
      },
    );

    this.cpPos = Int32Array.from(cpPos);
    this.cpFrameOff = Int32Array.from(frameOff);
    this.cpFrameData = Int32Array.from(frameData);
    this.cpStackOff = Int32Array.from(stackOff);
    this.cpStackData = Int32Array.from(stackData);
  }

  /** 取「锚点 ≤ offset」的最近检查点（含恢复所需的帧链/段栈/位置）；无 → null（从根走）。 */
  private resumeFor(offset: number): { pos: number; frames: Frame[]; kind: number[]; a: number[]; b: number[] } | null {
    const cps = this.cpPos;
    if (cps.length === 0) return null;
    let lo = 0;
    let hi = cps.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((cps[mid] as number) <= offset) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return null;

    const frames: Frame[] = [];
    const fStart = this.cpFrameOff[best] as number;
    const fEnd = this.cpFrameOff[best + 1] as number;
    for (let i = fStart; i < fEnd; i += 4) {
      frames.push({
        isObj: this.cpFrameData[i] === 1,
        closer: this.cpFrameData[i + 1] as number,
        pos: this.cpFrameData[i + 2] as number,
        idx: this.cpFrameData[i + 3] as number,
      });
    }
    const sStart = this.cpStackOff[best] as number;
    const sEnd = this.cpStackOff[best + 1] as number;
    const kind: number[] = [];
    const a: number[] = [];
    const b: number[] = [];
    for (let i = sStart; i < sEnd; i += 3) {
      kind.push(this.cpStackData[i] as number);
      a.push(this.cpStackData[i + 1] as number);
      b.push(this.cpStackData[i + 2] as number);
    }
    return { pos: cps[best] as number, frames, kind, a, b };
  }

  // ---------------------------------------------------------------- 行走器

  /**
   * 一趟迭代行走：`visit(anchor, brace, isContainer, depth)` 返回 true 则停止；
   * `boundary(p)` 在每个成员起点调用（检查点用；此时段栈只含祖先）。
   *
   * `resume` 从检查点恢复（帧链/段栈），不重复访问根；否则从头访问根。
   */
  private walk(
    resume: { pos: number; frames: Frame[]; kind: number[]; a: number[]; b: number[] } | null,
    visit: (anchor: number, valueStart: number, isContainer: boolean, depth: number) => boolean,
    boundary?: (p: number, ordinal: number) => void,
  ): void {
    const text = this.text;
    const n = text.length;
    const lex = this.lex;
    const frames = this.frames;
    const segKind = this.segKind;
    const segA = this.segA;
    const segB = this.segB;
    // 完整走（非续走）时重算节点数：根为 1，每访问一个成员 +1（局部计数，热循环不写实例字段）
    let nodeCount = 1;

    if (resume) {
      frames.length = 0;
      for (const f of resume.frames) frames.push(f);
      segKind.length = 0;
      segA.length = 0;
      segB.length = 0;
      for (let i = 0; i < resume.kind.length; i++) {
        segKind.push(resume.kind[i] as number);
        segA.push(resume.a[i] as number);
        segB.push(resume.b[i] as number);
      }
      const top = frames[frames.length - 1];
      // 检查点的 pos 是「下一个成员起点」——顶层帧从这里继续
      if (top) top.pos = resume.pos;
      else return;
    } else {
      frames.length = 0;
      segKind.length = 0;
      segA.length = 0;
      segB.length = 0;
      const rootPos = this.rootPos;
      if (rootPos < 0) return;
      if (this.rootScalar) {
        visit(rootPos, rootPos, false, 0);
        return;
      }
      // 根容器：先看空容器
      const p0 = lex.skipWs(text, rootPos + 1);
      const empty = text.charCodeAt(p0) === this.rootCloser;
      if (visit(rootPos, rootPos, true, 0)) return;
      if (empty) return;
      frames.push({ isObj: text.charCodeAt(rootPos) === CH.LBRACE, closer: this.rootCloser, pos: p0, idx: 0 });
    }

    for (;;) {
      const f = frames[frames.length - 1];
      if (!f) break;
      let p = lex.skipWs(text, f.pos);
      if (p >= n) break;
      const c = text.charCodeAt(p);

      if (c === f.closer) {
        frames.pop();
        popSeg(segKind, segA, segB); // 容器自身的段（根容器没有段，pop 为 no-op）
        const parent = frames[frames.length - 1];
        if (parent) {
          parent.pos = lex.skipWs(text, p + 1);
          if (text.charCodeAt(parent.pos) === CH.COMMA) parent.pos++;
          parent.idx++;
        }
        continue;
      }

      boundary?.(p, nodeCount);

      if (f.isObj) {
        // 对象成员：锚点 = 键起点
        const keyStart = p;
        const keyEnd = lex.lexToken(text, p);
        pushSeg(segKind, segA, segB, SEG_KEY, keyStart + 1, keyEnd - keyStart - 2);
        let q = lex.skipWs(text, keyEnd);
        if (text.charCodeAt(q) === CH.COLON) q = lex.skipWs(text, q + 1);
        const vc = text.charCodeAt(q);
        if (vc === CH.LBRACE || vc === CH.LBRACK) {
          const closer = vc === CH.LBRACE ? CH.RBRACE : CH.RBRACK;
          const p0 = lex.skipWs(text, q + 1);
          const empty = text.charCodeAt(p0) === closer;
          nodeCount++;
          if (visit(keyStart, q, true, segKind.length)) return;
          if (empty) {
            popSeg(segKind, segA, segB);
            f.pos = lex.skipWs(text, p0 + 1);
            if (text.charCodeAt(f.pos) === CH.COMMA) f.pos++;
            f.idx++;
          } else {
            frames.push({ isObj: vc === CH.LBRACE, closer, pos: p0, idx: 0 });
          }
        } else {
          lex.lexToken(text, q);
          const ve = lex.last.end;
          nodeCount++;
          if (visit(keyStart, q, false, segKind.length)) return;
          popSeg(segKind, segA, segB);
          f.pos = lex.skipWs(text, ve);
          if (text.charCodeAt(f.pos) === CH.COMMA) f.pos++;
          f.idx++;
        }
      } else {
        // 数组元素：锚点 = 值起点
        pushSeg(segKind, segA, segB, SEG_INDEX, f.idx, 0);
        const vc = text.charCodeAt(p);
        if (vc === CH.LBRACE || vc === CH.LBRACK) {
          const closer = vc === CH.LBRACE ? CH.RBRACE : CH.RBRACK;
          const p0 = lex.skipWs(text, p + 1);
          const empty = text.charCodeAt(p0) === closer;
          nodeCount++;
          if (visit(p, p, true, segKind.length)) return;
          if (empty) {
            popSeg(segKind, segA, segB);
            f.pos = lex.skipWs(text, p0 + 1);
            if (text.charCodeAt(f.pos) === CH.COMMA) f.pos++;
            f.idx++;
          } else {
            frames.push({ isObj: vc === CH.LBRACE, closer, pos: p0, idx: 0 });
          }
        } else {
          lex.lexToken(text, p);
          const ve = lex.last.end;
          nodeCount++;
          if (visit(p, p, false, segKind.length)) return;
          popSeg(segKind, segA, segB);
          f.pos = lex.skipWs(text, ve);
          if (text.charCodeAt(f.pos) === CH.COMMA) f.pos++;
          f.idx++;
        }
      }
    }
    this.nodes = nodeCount;
  }

  // ---------------------------------------------------------------- 段栈 / 路径

  /** 当前段栈 → 规范路径（只在命中时调用；转义键走 JSON.parse 解码）。 */
  private pathFromStack(): Path {
    let path: Path = '$';
    const len = this.segKind.length;
    for (let i = 0; i < len; i++) {
      path =
        this.segKind[i] === SEG_KEY
          ? appendKey(path, this.decodeKey(this.segA[i] as number, this.segB[i] as number))
          : appendIndex(path, this.segA[i] as number);
    }
    return path;
  }

  /** 源文本里的键（JSON 字符串字面量内容）与目标段比较（零分配；含转义解码）。 */
  private segMatches(segIndex: number, target: PathSegment): boolean {
    const kind = this.segKind[segIndex];
    if (kind === SEG_INDEX) return target.kind === 'index' && this.segA[segIndex] === target.index;
    return target.kind === 'key' && keyEquals(this.text, this.segA[segIndex] as number, this.segB[segIndex] as number, target.key);
  }

  private decodeKey(start: number, len: number): string {
    const text = this.text;
    const end = start + len;
    for (let i = start; i < end; i++) {
      if (text.charCodeAt(i) === BACKSLASH) {
        try {
          return JSON.parse('"' + text.slice(start, end) + '"') as string;
        } catch {
          return text.slice(start, end);
        }
      }
    }
    return text.slice(start, end);
  }
}

/* ------------------------------ 热路径小工具（零分配） ------------------------------ */

function pushSeg(kind: number[], a: number[], b: number[], k: number, av: number, bv: number): void {
  kind.push(k);
  a.push(av);
  b.push(bv);
}

function popSeg(kind: number[], a: number[], b: number[]): void {
  if (kind.length > 0) {
    kind.pop();
    a.pop();
    b.pop();
  }
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/**
 * 源文本 JSON 字符串内容（不带引号）与 JS 字符串比较；`\uXXXX` 等转义按 code unit 解码比较。
 * 零分配：不构造中间字符串（键比较在树→原文全量扫描的热路径上）。
 */
function keyEquals(text: string, start: number, len: number, target: string): boolean {
  const end = start + len;
  let i = start;
  let j = 0;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c !== BACKSLASH) {
      if (j >= target.length || target.charCodeAt(j) !== c) return false;
      i++;
      j++;
      continue;
    }
    const e = text.charCodeAt(i + 1);
    let decoded: number;
    if (e === 34) {
      decoded = 34;
      i += 2;
    } else if (e === BACKSLASH) {
      decoded = BACKSLASH;
      i += 2;
    } else if (e === 47) {
      decoded = 47;
      i += 2;
    } else if (e === 98) {
      decoded = 8;
      i += 2;
    } else if (e === 102) {
      decoded = 12;
      i += 2;
    } else if (e === 110) {
      decoded = 10;
      i += 2;
    } else if (e === 114) {
      decoded = 13;
      i += 2;
    } else if (e === 116) {
      decoded = 9;
      i += 2;
    } else if (e === 117) {
      decoded = 0;
      for (let k = i + 2; k < i + 6; k++) {
        const h = hexVal(text.charCodeAt(k));
        if (h < 0) return false;
        decoded = (decoded << 4) | h;
      }
      i += 6;
    } else {
      return false;
    }
    if (j >= target.length || target.charCodeAt(j) !== decoded) return false;
    j++;
  }
  return j === target.length;
}
