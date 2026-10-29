/** Module worker entry (built as its own ESM output). */
self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { type: string; text?: string; id?: number };
  if (msg.type === 'ping') {
    (self as unknown as { postMessage(v: unknown): void }).postMessage({ type: 'pong', id: msg.id });
    return;
  }
  if (msg.type === 'parse') {
    const t0 = performance.now();
    const value = JSON.parse(msg.text as string);
    const ms = performance.now() - t0;
    (self as unknown as { postMessage(v: unknown): void }).postMessage({
      type: 'parsed',
      id: msg.id,
      ms,
      nodes: countNodes(value),
    });
  }
};

function countNodes(v: unknown): number {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length) {
    const cur = stack.pop();
    n++;
    if (Array.isArray(cur)) for (const x of cur) stack.push(x);
    else if (cur && typeof cur === 'object') for (const k in cur as object) stack.push((cur as Record<string, unknown>)[k]);
  }
  return n;
}
