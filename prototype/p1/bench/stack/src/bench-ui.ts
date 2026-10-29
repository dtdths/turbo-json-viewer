/** Mounts the hand-written UI parts and exposes a driver-friendly API. */
import { createMenu, type MenuItem } from './ui/menu';
import { createToastRegion } from './ui/toast';
import { createDialog } from './ui/dialog';
import { createSplitter } from './ui/splitter';
import { createToolbar } from './ui/toolbar';
import { createTreeNav } from './ui/treeNav';
import { createI18n } from './ui/i18n';

const actions: string[] = [];
const menuItems: MenuItem[] = [
  { label: 'Copy value', action: () => actions.push('copy-value') },
  { label: 'Copy path', action: () => actions.push('copy-path') },
  { label: 'Copy subtree JSON', action: () => actions.push('copy-json') },
  { label: 'Expand all', action: () => actions.push('expand-all') },
];
const menu = createMenu(menuItems);
const toast = createToastRegion();
const dialog = createDialog();
const toolbar = createToolbar(['Copy', 'Expand', 'Search', 'Export']);
const left = document.getElementById('pane-left') as HTMLElement;
const splitter = createSplitter({ left });
(document.getElementById('split-host') as HTMLElement).append(splitter.el, document.getElementById('pane-right') as HTMLElement);
const treeA = createTreeNav('activedescendant', Array.from({ length: 200 }, (_, i) => '"field_' + i + '"'));
const treeB = createTreeNav('roving', Array.from({ length: 200 }, (_, i) => '"field_' + i + '"'));
(document.getElementById('tree-a') as HTMLElement).append(treeA.el);
(document.getElementById('tree-b') as HTMLElement).append(treeB.el);
(document.getElementById('toolbar-host') as HTMLElement).append(toolbar.el);
const menuBtn = document.getElementById('menu-anchor') as HTMLButtonElement;
menuBtn.addEventListener('click', () => {
  const r = menuBtn.getBoundingClientRect();
  menu.open(r.left, r.bottom + 2);
});
const i18n = createI18n();
i18n.prime(['extName', 'rowCount']);

const outside = document.getElementById('outside-btn') as HTMLButtonElement;

function activeInfo() {
  const el = document.activeElement as HTMLElement | null;
  return {
    tag: el?.tagName ?? null,
    text: (el?.textContent ?? '').slice(0, 40),
    role: el?.getAttribute('role') ?? null,
    inDialog: !!el?.closest('dialog'),
    inMenu: !!el?.closest('.menu'),
  };
}

(window as unknown as { __uiBench: unknown }).__uiBench = {
  menu: {
    open(): void {
      menuBtn.focus();
      const r = menuBtn.getBoundingClientRect();
      menu.open(r.left, r.bottom + 2);
    },
    openAt(x: number, y: number): void {
      menu.open(x, y);
    },
    isOpen: () => menu.isOpen(),
    state: () => ({
      open: menu.isOpen(),
      active: activeInfo(),
      items: menu.itemEls().length,
      role: menu.el.getAttribute('role'),
      itemRole: menu.itemEls()[0]?.getAttribute('role'),
      rect: menu.el.getBoundingClientRect().toJSON(),
      hidden: menu.el.hidden,
    }),
    key(k: string): void {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      );
    },
    itemIndexFocused(): number {
      const els = menu.itemEls();
      return els.indexOf(document.activeElement as HTMLElement);
    },
    clickOutside(): void {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    },
    actions: () => actions.slice(),
  },
  toast: {
    show: (msg: string) => void toast.show(msg),
    state: () => ({
      live: toast.el.getAttribute('aria-live'),
      role: toast.el.getAttribute('role'),
      count: toast.count(),
      text: toast.el.textContent,
    }),
    clear: () => toast.clear(),
  },
  dialog: {
    open: () => void dialog.open('Import JSON', 'Drop a .json file or paste from clipboard.'),
    state: () => ({
      open: dialog.el.open,
      active: activeInfo(),
      role: dialog.el.getAttribute('role'),
      modal: dialog.el.matches(':modal'),
      inertBackground: (() => {
        outside.focus();
        return document.activeElement !== outside;
      })(),
    }),
    close: () => dialog.close(true),
    active: () => activeInfo(),
  },
  splitter: {
    rect: () => splitter.el.getBoundingClientRect().toJSON(),
    width: () => splitter.width(),
    attr: () => splitter.el.getAttribute('aria-valuenow'),
    role: () => splitter.el.getAttribute('role'),
    key(k: string): void {
      splitter.el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    },
  },
  toolbar: {
    state: () => ({
      role: toolbar.el.getAttribute('role'),
      active: toolbar.activeIndex(),
      focused: activeInfo(),
      tabbable: Array.from(toolbar.el.querySelectorAll('button')).filter((b) => b.tabIndex === 0).length,
    }),
    focusFirst: () => toolbar.focusFirst(),
    key(k: string): void {
      toolbar.el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    },
  },
  tree: {
    mount(which: 'activedescendant' | 'roving') {
      const nav = which === 'activedescendant' ? treeA : treeB;
      nav.el.focus();
      return nav.state();
    },
    key(which: 'activedescendant' | 'roving', k: string) {
      const nav = which === 'activedescendant' ? treeA : treeB;
      const ms = nav.key(k);
      return { ms, ...nav.state() };
    },
    state(which: 'activedescendant' | 'roving') {
      const nav = which === 'activedescendant' ? treeA : treeB;
      return nav.state();
    },
    focusEl(which: 'activedescendant' | 'roving') {
      const nav = which === 'activedescendant' ? treeA : treeB;
      nav.el.focus();
    },
  },
  i18n: {
    uiLanguage: () => chrome.i18n.getUILanguage(),
    name: () => i18n.t('extName'),
    raw1000: () => i18n.rawLookups(['extName', 'rowCount'], 500),
    cached1000: () => {
      const t0 = performance.now();
      let n = 0;
      for (let i = 0; i < 1000; i++) n += i18n.t(i % 2 ? 'extName' : 'rowCount').length;
      return performance.now() - t0 + (n === 0 ? 1e-9 : 0);
    },
  },
  activeInfo,
};
