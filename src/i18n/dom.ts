/**
 * i18n/dom — 静态 HTML 文案回填（`data-i18n` / `data-i18n-attr`）。
 *
 * `page.html` 的静态文案默认写**英文**（语言包是异步加载的，默认文案保证加载期间不空白），
 * 启动时与切换语言时各跑一次，把标记节点改成当前语言。
 *
 * 标记约定：
 *   - `data-i18n="key"` → 写 `textContent`（只用于纯文本节点，禁止塞子元素）。
 *   - `data-i18n-attr="title:key,aria-label:key2"` → 逐项写属性。
 */
import { t, type MessageKey } from './index';

interface I18nElement extends HTMLElement {
  dataset: DOMStringMap;
}

/** 把一棵子树里的静态文案刷成当前语言（幂等；缺标记的节点不动）。 */
export function applyStaticMessages(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (!key) continue;
    node.textContent = t(key as MessageKey);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    const spec = node.dataset.i18nAttr;
    if (!spec) continue;
    for (const pair of spec.split(',')) {
      const colon = pair.indexOf(':');
      if (colon <= 0) continue;
      const attr = pair.slice(0, colon).trim();
      const key = pair.slice(colon + 1).trim();
      if (!attr || !key) continue;
      (node as I18nElement).setAttribute(attr, t(key as MessageKey));
    }
  }
}

/** `page.html` 里所有 `data-i18n` / `data-i18n-attr` 引用的 key（测试校验用）。 */
export function collectDomMessageKeys(root: ParentNode = document): string[] {
  const keys: string[] = [];
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    if (node.dataset.i18n) keys.push(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    const spec = node.dataset.i18nAttr;
    if (!spec) continue;
    for (const pair of spec.split(',')) {
      const colon = pair.indexOf(':');
      if (colon > 0) keys.push(pair.slice(colon + 1).trim());
    }
  }
  return keys;
}
