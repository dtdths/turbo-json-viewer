/** _locales lookup, cached into a plain object at startup (getMessage per call
 *  is measurably slower; measure both). */
export function createI18n(): {
  t(key: string, subs?: string[]): string;
  prime(keys: string[]): number;
  rawLookups(keys: string[], times: number): number;
} {
  const cache: Record<string, string> = {};
  const msg = (key: string, subs?: string[]) => {
    const raw = chrome.i18n.getMessage(key, subs);
    return raw || key;
  };
  return {
    t(key, subs) {
      return cache[key] ?? msg(key, subs);
    },
    prime(keys) {
      const t0 = performance.now();
      for (const k of keys) cache[k] = msg(k);
      return performance.now() - t0;
    },
    rawLookups(keys, times) {
      const t0 = performance.now();
      let n = 0;
      for (let i = 0; i < times; i++) {
        for (const k of keys) n += msg(k).length;
      }
      return performance.now() - t0 + (n === 0 ? 1e-9 : 0);
    },
  };
}
