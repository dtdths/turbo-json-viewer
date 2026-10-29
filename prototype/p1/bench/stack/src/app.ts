/** "Application-shaped" bundle for the size budget: acorn + tokenizer + row
 *  renderer + hand-written UI parts (no CodeMirror). */
import * as acorn from 'acorn';
import { makeRows, visibleWindow, ROW_HEIGHT, VIEWPORT_ROWS } from './rows';
import { tokenizeJsonLine } from './tokenizer';
import { createRowRenderer } from './renderer';
import { createMenu } from './ui/menu';
import { createToastRegion } from './ui/toast';
import { createDialog } from './ui/dialog';
import { createSplitter } from './ui/splitter';
import { createToolbar } from './ui/toolbar';
import { createTreeNav } from './ui/treeNav';
import { createI18n } from './ui/i18n';

export function validateExpression(src: string): { ok: boolean; errors: number } {
  try {
    const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module' });
    return { ok: true, errors: ast.body.length };
  } catch {
    return { ok: false, errors: 1 };
  }
}

export function boot(el: HTMLElement): void {
  const rows = makeRows(1000);
  const renderer = createRowRenderer(el, VIEWPORT_ROWS);
  renderer.render(rows.slice(0, VIEWPORT_ROWS), 0);
  const { first, count } = visibleWindow(0, ROW_HEIGHT, VIEWPORT_ROWS, rows.length, 4);
  el.dataset.window = first + ':' + count;
  el.dataset.tokens = String(tokenizeJsonLine('{"a": 1}').length);
  const menu = createMenu([{ label: 'Copy', action: () => {} }]);
  const toast = createToastRegion();
  const dialog = createDialog();
  const splitter = createSplitter({ left: el });
  const toolbar = createToolbar(['Copy', 'Expand']);
  const treeNav = createTreeNav('activedescendant', ['a']);
  const i18n = createI18n();
  el.append(menu.el, toast.el, dialog.el, splitter.el, toolbar.el, treeNav.el);
  toast.show(i18n.t('extName'));
  el.dataset.valid = String(validateExpression('data.hotel_tags.filter(x => x.price > 100)').ok);
}
