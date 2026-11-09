/**
 * protocol/errors — 跨线程错误码。core 说「哪条规则不满足」，viewmodel/view 决定降级与文案。
 */

export type CoreErrorCode =
  | 'STALE_ROW'
  | 'STALE_ROOT'
  | 'STALE_DOC'
  | 'TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'PARSE'
  | 'TIMEOUT'
  | 'WORKER_CRASH'
  | 'CANCELLED'
  | 'CLOSED'
  | 'NO_ROOT'
  | 'BAD_COMMAND'
  | 'BAD_PATTERN'
  | 'NO_HISTORY';

export interface CoreErrorShape {
  code: CoreErrorCode;
  message: string;
  line?: number;
  column?: number;
  bytes?: number;
  totalRows?: number;
}

/** 可跨线程序列化的错误；transport 负责摊平/还原。 */
export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly line?: number;
  readonly column?: number;
  readonly bytes?: number;
  readonly totalRows?: number;

  constructor(shape: CoreErrorShape) {
    super(shape.message);
    this.name = 'CoreError';
    this.code = shape.code;
    this.line = shape.line;
    this.column = shape.column;
    this.bytes = shape.bytes;
    this.totalRows = shape.totalRows;
  }

  toShape(): CoreErrorShape {
    const out: CoreErrorShape = { code: this.code, message: this.message };
    if (this.line !== undefined) out.line = this.line;
    if (this.column !== undefined) out.column = this.column;
    if (this.bytes !== undefined) out.bytes = this.bytes;
    if (this.totalRows !== undefined) out.totalRows = this.totalRows;
    return out;
  }

  static from(err: unknown): CoreError {
    if (err instanceof CoreError) return err;
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      return new CoreError(err as CoreErrorShape);
    }
    return new CoreError({ code: 'BAD_COMMAND', message: String(err) });
  }
}
