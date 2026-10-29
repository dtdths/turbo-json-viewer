chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'page.html' });
});
