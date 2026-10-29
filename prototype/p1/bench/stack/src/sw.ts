/** MV3 module service worker entry. */
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.set({ swBoot: Date.now() });
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  sendResponse({ echo: msg, from: 'sw' });
  return true;
});
