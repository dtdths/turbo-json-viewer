/**
 * view/incoming-copy — 选区导入失败文案的**单一来源**（#57 / ADR-0031 / ADR-0026 §1）。
 *
 * SW 只给错误码，文案在 view（i18n 词条）里组装——与 `view/expression-copy.exprErrorText` 同分工。
 */
import { t } from '../i18n/index';
import type { MessageKey } from '../i18n/index';
import type { IncomingErrorCode } from '../shared/incoming';

const TEMPLATE_KEYS: Record<IncomingErrorCode, MessageKey> = {
  'not-json': 'app.incoming.notJson',
  'too-large': 'app.incoming.tooLarge',
};

/** 错误码 → 页面 toast 文案。 */
export function incomingErrorText(code: IncomingErrorCode): string {
  return t(TEMPLATE_KEYS[code]);
}
