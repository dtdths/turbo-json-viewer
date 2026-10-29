/**
 * core/search — 全文档搜索（键名 + 字符串值）。
 *
 * 深度优先 walk 整棵值图，不建 search root（ir-spec §4.3：命中集合是视图状态）。
 * 默认大小写不敏感；命中上限默认 SEARCH_LIMIT（50,000），超过则 truncated。
 * 预览必须短（命中集可能 5 万条），见 row-model.shortPreview。
 */
import { CoreError } from '../protocol/errors';
import { SEARCH_LIMIT } from '../protocol/versions';
import type { Hit, Path, SearchOpts } from '../protocol/types';
import { appendIndex, appendKey, ROOT_PATH } from '../shared/path';
import { isContainer, jsonKind, shortPreview } from './row-model';

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

interface Frame {
  node: unknown;
  path: Path;
  key: string;
  idx: boolean;
}

export function searchDocument(value: unknown, query: string, opts: SearchWalkOpts = {}): SearchWalkResult {
  const limit = opts.limit ?? SEARCH_LIMIT;
  const caseSensitive = opts.caseSensitive ?? false;
  const keysOnly = opts.keysOnly ?? false;
  const shouldCancel = opts.shouldCancel;

  const hits: Hit[] = [];
  let truncated = false;

  if (query.length === 0) return { hits, total: 0, truncated: false };
  if (!Number.isFinite(limit) || limit <= 0) return { hits, total: 0, truncated: false };

  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = (text: string): boolean =>
    caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle);

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

    let field: Hit['field'] | null = null;
    if (keyIsName && matches(frame.key)) field = 'key';
    else if (!keysOnly && kind === 'string' && matches(node as string)) field = 'value';

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
