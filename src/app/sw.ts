/**
 * app/sw — 最小 Service Worker：`action.onClicked` 打开扩展页；右键菜单把**选中的 JSON**
 * 经一次性 token 投递给页面（#57 / ADR-0031）。
 *
 * 仍然：不持文档、不转消息、不把文档写进 storage（选区文本只在 `storage.session` 里
 * 停留到页面读完即删）；**不注入任何页面**——菜单只读 `info.selectionText`。
 */
import {
  INCOMING_MENU_DOWNLOAD,
  INCOMING_MENU_ID,
  INCOMING_MENU_VIEW,
  deliverSelection,
  modeOfMenuItem,
  type SelectionIntakePort,
} from './selection-intake';
import type { SessionStorageLike } from '../shared/incoming';

type ContextMenuClick = { menuItemId: string | number; selectionText?: string };

const chromeApi = (
  globalThis as unknown as {
    chrome?: {
      action?: { onClicked?: { addListener(fn: () => void): void } };
      tabs?: { create(props: { url: string }): void };
      runtime?: {
        getURL(path: string): string;
        onInstalled?: { addListener(fn: () => void): void };
      };
      contextMenus?: {
        removeAll(callback: () => void): void;
        create(props: { id: string; title: string; contexts: string[]; parentId?: string }): void;
        onClicked?: { addListener(fn: (info: ContextMenuClick) => void): void };
      };
      i18n?: { getMessage(key: string): string };
      storage?: { session: SessionStorageLike };
    };
  }
).chrome;

function openViewer(token?: string): void {
  const base = chromeApi?.runtime?.getURL('page.html');
  if (!base) return;
  chromeApi?.tabs?.create({ url: token === undefined ? base : `${base}#incoming=${token}` });
}

chromeApi?.action?.onClicked?.addListener(() => {
  openViewer();
});

// 菜单跨浏览器重启持久；只需在安装 / 更新时（重）注册一次。`removeAll` 让改名与升级幂等。
// 结构（#63）：父项 = 品牌名（不翻译、hover 出子菜单）；子项 = 打开查看 / 下载 JSON。
// 子项文案走浏览器语言（`_locales`），不跟随应用内语言——SW 拿不到页面语言包（ADR-0031 已知差距）。
chromeApi?.runtime?.onInstalled?.addListener(() => {
  const menus = chromeApi?.contextMenus;
  if (!menus) return;
  const message = (key: string, fallback: string): string => chromeApi?.i18n?.getMessage(key) || fallback;
  menus.removeAll(() => {
    menus.create({ id: INCOMING_MENU_ID, title: 'Turbo JSON Viewer', contexts: ['selection'] });
    menus.create({
      id: INCOMING_MENU_VIEW,
      parentId: INCOMING_MENU_ID,
      title: message('menuView', 'Open in viewer'),
      contexts: ['selection'],
    });
    menus.create({
      id: INCOMING_MENU_DOWNLOAD,
      parentId: INCOMING_MENU_ID,
      title: message('menuDownload', 'Download JSON'),
      contexts: ['selection'],
    });
  });
});

chromeApi?.contextMenus?.onClicked?.addListener((info) => {
  const mode = modeOfMenuItem(info.menuItemId);
  if (mode === null) return;
  const session = chromeApi?.storage?.session;
  if (!session) return;
  const port: SelectionIntakePort = {
    storage: session,
    open: (token) => openViewer(token),
    uuid: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
  void deliverSelection(port, info.selectionText ?? '', mode);
});
