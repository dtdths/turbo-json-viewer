/**
 * core/import — 导入管线（v0 skeleton）。
 *
 * 真相源 = JSON.parse 值图；源文本解析后即释放（不保留原始文本视图，ADR-0003）。
 * 解码在 Worker 内做：ArrayBuffer → TextDecoder('utf-8')（ir-spec §5）。
 *
 * v0 不做截断修复：保守闭合 + 修复标记/摘要属于 #8 / ADR-0004，
 * 见 loadDocument 末尾的 TODO。输入不完整时这里直接抛 PARSE。
 */
import { CoreError } from '../protocol/errors';
import type { LoadSource } from '../protocol/messages';
import type { DocumentMeta } from '../protocol/types';

export interface LoadDocumentInput {
  source: LoadSource;
  data: ArrayBuffer | string;
  name?: string;
}

export interface LoadDocumentResult {
  value: unknown;
  meta: DocumentMeta;
}

const SOURCE_DEFAULT_NAME: Record<LoadSource, string> = {
  file: 'untitled.json',
  paste: 'pasted.json',
  clipboard: 'clipboard.json',
};

/** ArrayBuffer / 字符串 → UTF-8 文本。 */
export function decodeText(data: ArrayBuffer | string): string {
  if (typeof data === 'string') return data;
  // TODO(#11): >50MB 时改成分片/流式解码，避免一次性 2× 文本峰值（ir-spec §5）。
  return new TextDecoder('utf-8').decode(data);
}

/** 原始载荷字节数（和解码后的字符数不是一回事）。 */
export function byteLengthOf(data: ArrayBuffer | string): number {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
  return data.byteLength;
}

/** 从 JSON.parse 的错误信息里尽量还原 line/column（V8 会带 "(line X column Y)"）。 */
export function parseErrorPosition(text: string, message: string): { line?: number; column?: number } {
  const lc = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position\s+(\d+)/i.exec(message);
  if (!pos) return {};
  const offset = Number(pos[1]);
  if (!Number.isFinite(offset)) return {};
  return offsetToLineColumn(text, offset);
}

export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const pos = Math.min(Math.max(Math.floor(offset), 0), text.length);
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < pos; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: pos - lastNewline };
}

export function loadDocument(input: LoadDocumentInput): LoadDocumentResult {
  const text = decodeText(input.data);
  const bytes = input.data instanceof ArrayBuffer ? input.data.byteLength : byteLengthOf(input.data);

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const position = parseErrorPosition(text, message);
    const shape: { code: 'PARSE'; message: string; line?: number; column?: number } = {
      code: 'PARSE',
      message: `JSON.parse failed: ${message}`,
    };
    if (position.line !== undefined) shape.line = position.line;
    if (position.column !== undefined) shape.column = position.column;
    throw new CoreError(shape);
  }

  // TODO(#8 / ADR-0004): truncated-source repair (conservative brace/quote closing,
  // RepairProvenance marks, export suffix) is intentionally out of the skeleton slice.
  // v0: a truncated document is a PARSE error.

  const name = input.name?.trim() || SOURCE_DEFAULT_NAME[input.source] || 'untitled.json';
  const meta: DocumentMeta = { name, bytes, source: input.source };
  return { value, meta };
}
