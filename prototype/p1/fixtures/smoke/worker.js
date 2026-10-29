self.onmessage = (e) => {
  const t = performance.now();
  const value = JSON.parse(e.data.text);
  const parseMs = performance.now() - t;
  self.postMessage({
    parseMs,
    keys: Object.keys(value),
    jsonLen: JSON.stringify(value).length,
    workerChrome: typeof chrome,
  });
};
