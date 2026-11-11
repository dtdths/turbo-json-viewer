/**
 * core/search — 全文档搜索（键名 + **字符串值 + 数字值**）。
 *
 * 深度优先 walk 整棵值图，不建 search root（ir-spec §4.3：命中集合是视图状态）。
 * 默认大小写不敏感；命中上限默认 SEARCH_LIMIT（50,000），超过则 truncated。
 * 预览必须短（命中集可能 5 万条），见 row-model.shortPreview。
 *
 * 数值匹配口径（2026-11-12 用户反馈修订，ADR-0014 修订）：数字（number / BigInt）按
 * **树里显示的文本**匹配（number → `JSON.stringify`，BigInt → 十进制串），所以搜
 * `297532588187238660` 能命中树里显示同串的大整数。布尔/null 仍不参与值匹配。
 *
 * 正则模式（ADR-0014 §2.2–§2.4）：`opts.regex === true` 时 query 按 ECMAScript RegExp
 * 解释，`caseSensitive` 只决定 `i` flag；语法错误 / 超长 / 被灾难性回溯静态筛查拒绝
 * 一律抛 `CoreError({ code: 'BAD_PATTERN' })`，不产出命中。匹配目标 = 键名 + 字符串值 + 数字显示文本。
 */
import { CoreError } from '../protocol/errors';
import { SEARCH_LIMIT, SEARCH_PATTERN_MAX } from '../protocol/versions';
import type { Hit, Path, SearchOpts } from '../protocol/types';
import { appendIndex, appendKey, ROOT_PATH } from '../shared/path';
import { isContainer, jsonKind, scalarPreview, shortPreview } from './row-model';

export interface SearchWalkOpts extends SearchOpts {
  /** 每 4096 个节点问一次；用于 cancelSearch / 新搜索抢占（骨架里同步 walk 不常用） */
  shouldCancel?: () => boolean;
}

export interface SearchWalkResult {
  hits: Hit[];
  total: number;
  truncated: boolean;
}

const CANCEL_CHECK_MASK = 4095;

/**
 * 「值搜索」用的文本：字符串 = 内容本身；数字 = **树里显示的文本**
 * （number → JSON.stringify，BigInt → 十进制串）；布尔/null 不参与值匹配。
 * 与 `row-model.scalarPreview` 同源，保证「搜到的 == 看到的」。
 */
function searchableValueText(node: unknown, kind: ReturnType<typeof jsonKind>): string | null {
  if (kind === 'string') return node as string;
  if (kind === 'number') return scalarPreview(node);
  return null;
}

/** 灾难性回溯静态筛查的拒绝原因（ADR-0014 §2.4；core 只给规则、文案由 app 映射）。 */
const CATASTROPHIC_BACKTRACK_MESSAGE = '该正则可能触发灾难性回溯';

interface Frame {
  node: unknown;
  path: Path;
  key: string;
  idx: boolean;
}

// ---------------------------------------------------------------- 正则安全筛查

/**
 * 若 `{n}` / `{n,}` / `{n,m}` 量词从 i 开始，返回结束 `}` 的下标；否则 -1。
 * 只做词法识别（不校验 n/m 大小关系，语法错误交给 `new RegExp`）。
 */
function quantifierBraceEnd(src: string, i: number): number {
  if (src[i] !== '{') return -1;
  let j = i + 1;
  const digitStart = j;
  while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
  if (j === digitStart) return -1; // `{,3}` 不是（合法）量词
  if (src[j] === '}') return j;
  if (src[j] !== ',') return -1;
  j += 1;
  while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
  return src[j] === '}' ? j : -1;
}

/**
 * 分组关闭后紧跟的量词是否把「组内量词」重复多次（源头上是回溯爆炸）：
 *   - `*` / `+` / `{n,}`：无界重复 → 指数级回溯；
 *   - `{n}` / `{n,m}` 且上界 ≥ 2：有界但多项式级（大文档同样能卡住 Worker）。
 *
 * `?` / `{0,1}` / `{1}` 最多让分组应用一次（内层只线性回溯，如 `(\d+)?`），放行以避免
 * 误杀常见写法——ADR-0014 的示例也全是无界外层量词。
 */
function repeatsGroup(src: string, i: number): boolean {
  const ch = src[i];
  if (ch === '*' || ch === '+') return true;
  if (ch !== '{') return false;
  const end = quantifierBraceEnd(src, i);
  if (end < 0) return false;
  const [minPart, maxPart] = src.slice(i + 1, end).split(',');
  if (maxPart === undefined) return Number(minPart) >= 2; // `{n}`
  if (maxPart === '') return true; // `{n,}` 无上界
  return Number(maxPart) >= 2; // `{n,m}`
}

/**
 * 灾难性回溯的**静态启发式**筛查（ADR-0014 §2.4）：拒绝「量词作用于含量词的分组」，
 * 如 `(a+)+`、`(a*)+`、`(a+)*`、`(?:a{1,})+`、`((a+))+`。
 *
 * 一遍扫描：跟踪分组栈（每层是否含量词）+ 分组关闭后是否紧跟量词；含量词的分组关闭时
 * 把该事实传播给父层（`((a+))+` 因此也能拒绝）。交替分支不含量词 → `(foo|bar)+` 放行。
 *
 * 已知差距（显式接受）：这是启发式而非完备 ReDoS 判定，`(a|a)+` 这类「重叠分支 + 量词」
 * 不拦（会误杀 `(foo|bar)+` 等常见合法写法）；漏网病态正则的兜底是命令超时。
 *
 * @returns 拒绝原因（可直接作为 `BAD_PATTERN` 的 message）；安全返回 null。
 */
export function regexSafetyError(src: string): string | null {
  /** 每层分组的内容里是否出现过量词 */
  const groups: boolean[] = [];
  let escaped = false;
  let inClass = false;
  /** 上一个 token 是 `(`：紧随的 `?` 属于分组前缀（`(?:` / `(?=` / `(?<name>`） */
  let justOpenedGroup = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;

    if (escaped) {
      escaped = false;
      justOpenedGroup = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      justOpenedGroup = false;
      continue;
    }
    // 字符类里的 `(` `)` `+` 等都是字面量（`[a+]` 不是量词）
    if (inClass) {
      if (ch === ']') inClass = false;
      justOpenedGroup = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      justOpenedGroup = false;
      continue;
    }
    if (ch === '(') {
      groups.push(false);
      justOpenedGroup = true;
      continue;
    }
    if (ch === '?') {
      // 分组前缀不是量词；其它位置的 `?` 是量词（含惰性修饰符，已由前面的量词置位）
      if (!(justOpenedGroup && groups.length > 0) && groups.length > 0) {
        groups[groups.length - 1] = true;
      }
      justOpenedGroup = false;
      continue;
    }
    if (ch === '*' || ch === '+') {
      justOpenedGroup = false;
      if (groups.length > 0) groups[groups.length - 1] = true;
      continue;
    }
    if (ch === '{') {
      justOpenedGroup = false;
      if (quantifierBraceEnd(src, i) < 0) continue; // 字面量 `{`
      if (groups.length > 0) groups[groups.length - 1] = true;
      continue;
    }
    if (ch === ')') {
      justOpenedGroup = false;
      const innerHasQuantifier = groups.pop() ?? false;
      // 含量词的分组是父层内容的一部分（`((a+))+` 的父层同样「含量词」）
      if (innerHasQuantifier && groups.length > 0) groups[groups.length - 1] = true;
      if (!innerHasQuantifier) continue;
      // 分组关闭后紧跟重复量词 → 该分组被重复，量词叠量词（回溯爆炸）
      if (repeatsGroup(src, i + 1)) return CATASTROPHIC_BACKTRACK_MESSAGE;
      continue;
    }
    justOpenedGroup = false;
  }

  return null;
}

/**
 * 编译正则匹配器；语法错误 / 超长 / 灾难性回溯一律抛 `BAD_PATTERN`（不产出命中）。
 * 不加 `g` flag：`RegExp.test` 因此无 lastIndex 状态，可在 walk 中反复调用。
 */
export function compileRegexMatcher(query: string, caseSensitive: boolean): (text: string) => boolean {
  if (query.length > SEARCH_PATTERN_MAX) {
    throw new CoreError({
      code: 'BAD_PATTERN',
      message: `正则过长（上限 ${SEARCH_PATTERN_MAX} 字符）`,
    });
  }

  let regex: RegExp;
  try {
    regex = new RegExp(query, caseSensitive ? '' : 'i');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CoreError({ code: 'BAD_PATTERN', message: `正则语法错误：${reason}` });
  }

  const unsafe = regexSafetyError(query);
  if (unsafe !== null) throw new CoreError({ code: 'BAD_PATTERN', message: unsafe });

  return (text: string): boolean => regex.test(text);
}

// ---------------------------------------------------------------- 搜索

export function searchDocument(value: unknown, query: string, opts: SearchWalkOpts = {}): SearchWalkResult {
  const limit = opts.limit ?? SEARCH_LIMIT;
  const caseSensitive = opts.caseSensitive ?? false;
  const keysOnly = opts.keysOnly ?? false;
  const regexMode = opts.regex ?? false;
  const shouldCancel = opts.shouldCancel;

  const hits: Hit[] = [];
  let truncated = false;

  if (query.length === 0) return { hits, total: 0, truncated: false };
  if (!Number.isFinite(limit) || limit <= 0) return { hits, total: 0, truncated: false };

  // 子串模式：默认大小写不敏感（slice 4 现状不变）；正则模式：编译 + 安全筛查（ADR-0014）
  let matches: (text: string) => boolean;
  if (regexMode) {
    matches = compileRegexMatcher(query, caseSensitive);
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    matches = (text: string): boolean =>
      caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle);
  }

  const stack: Frame[] = [{ node: value, path: ROOT_PATH, key: 'root', idx: false }];
  let visited = 0;

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    visited += 1;
    if (shouldCancel && (visited & CANCEL_CHECK_MASK) === 0 && shouldCancel()) {
      throw new CoreError({ code: 'CANCELLED', message: 'search cancelled' });
    }

    const node = frame.node;
    const kind = jsonKind(node);
    const keyIsName = !frame.idx && frame.path !== ROOT_PATH;

    // 键名优先于值：一条正则同时命中键名与字符串/数字值时，field 记为 key（与 slice 4 的判定顺序一致）
    let field: Hit['field'] | null = null;
    if (keyIsName && matches(frame.key)) field = 'key';
    else {
      const valueText = searchableValueText(node, kind);
      if (!keysOnly && valueText !== null && matches(valueText)) field = 'value';
    }

    if (field !== null) {
      hits.push({
        path: frame.path,
        key: frame.key,
        kind,
        preview: shortPreview(node),
        field,
      });
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
    }

    if (!isContainer(node)) continue;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        stack.push({ node: node[i], path: appendIndex(frame.path, i), key: '[' + i + ']', idx: true });
      }
    } else {
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i] as string;
        stack.push({ node: node[key], path: appendKey(frame.path, key), key, idx: false });
      }
    }
  }

  return { hits, total: hits.length, truncated };
}
