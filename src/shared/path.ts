/**
 * shared/path — 规范路径的解析/格式化。零依赖，core 与 view 共用。
 *
 *   $                     根
 *   $.data.hotel_list     标识符键
 *   $['a b'].x            非标识符键（单引号，内部 \' 与 \\ 转义）
 *   $.data.hotel_list[1234] 数组下标
 */

/** 规范路径字符串。shared 保持零 import：与 protocol/types 的 `Path` 同为 string 别名。 */
export type Path = string;

export type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number };

export const ROOT_PATH: Path = '$';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isIdentifierKey(key: string): boolean {
  return IDENT.test(key);
}

export function escapeKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 追加一个对象键段（字符串拼接，深树热路径） */
export function appendKey(parent: Path, key: string): Path {
  return isIdentifierKey(key) ? parent + '.' + key : parent + "['" + escapeKey(key) + "']";
}

/** 追加一个数组下标段 */
export function appendIndex(parent: Path, index: number): Path {
  return parent + '[' + index + ']';
}

export function parsePath(path: Path): PathSegment[] {
  if (path === ROOT_PATH) return [];
  if (path[0] !== ROOT_PATH) throw new Error('path must start with $: ' + path);
  const out: PathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      let j = i + 1;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      out.push({ kind: 'key', key: path.slice(i + 1, j) });
      i = j;
    } else if (ch === '[') {
      if (path[i + 1] === "'") {
        let j = i + 2;
        let key = '';
        for (;;) {
          if (j >= path.length) throw new Error('unterminated key in path: ' + path);
          const c = path[j];
          if (c === '\\') {
            key += path[j + 1] ?? '';
            j += 2;
            continue;
          }
          if (c === "'" && path[j + 1] === ']') {
            j += 2;
            break;
          }
          key += c;
          j++;
        }
        out.push({ kind: 'key', key });
        i = j;
      } else {
        let j = i + 1;
        while (j < path.length && path[j] !== ']') j++;
        const raw = path.slice(i + 1, j);
        out.push({ kind: 'index', index: Number(raw) });
        i = j + 1;
      }
    } else {
      throw new Error('unexpected char in path: ' + path);
    }
  }
  return out;
}

export function formatPath(segments: readonly PathSegment[]): Path {
  let p: Path = ROOT_PATH;
  for (const seg of segments) p = seg.kind === 'key' ? appendKey(p, seg.key) : appendIndex(p, seg.index);
  return p;
}

export function parentPath(path: Path): Path | null {
  if (path === ROOT_PATH) return null;
  const segs = parsePath(path);
  return formatPath(segs.slice(0, -1));
}

export function lastSegment(path: Path): PathSegment | null {
  if (path === ROOT_PATH) return null;
  const segs = parsePath(path);
  return segs[segs.length - 1] ?? null;
}

/** 段数（根为 0） */
export function depthOf(path: Path): number {
  return parsePath(path).length;
}
