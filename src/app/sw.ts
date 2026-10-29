/**
 * app/sw — 最小 Service Worker：只做 action.onClicked → 打开扩展页。
 * 不持文档、不转消息、不写 storage（文档只在页面创建的 module worker 内）。
 */
const chromeApi = (globalThis as unknown as {
  chrome?: {
    action?: { onClicked?: { addListener(fn: () => void): void } };
    tabs?: { create(props: { url: string }): void };
    runtime?: { getURL(path: string): string };
  };
}).chrome;

chromeApi?.action?.onClicked?.addListener(() => {
  const url = chromeApi?.runtime?.getURL('page.html');
  if (url) chromeApi?.tabs?.create({ url });
});
