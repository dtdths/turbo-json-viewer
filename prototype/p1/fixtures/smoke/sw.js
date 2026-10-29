// Present so the extension has a background context; the probe only needs a page.
self.addEventListener('install', () => self.skipWaiting());
