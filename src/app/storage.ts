/**
 * app/storage — ViewStateStore 的 chrome.storage.local 适配器（localStorage 兜底）。
 * 只存视图状态；永不存文档内容（ADR-0003/0006 红线）。
 */
export interface ViewStateStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createViewStateStore(): ViewStateStore {
  const chromeApi = (globalThis as { chrome?: { storage?: { local?: StorageArea } } }).chrome;
  const area = chromeApi?.storage?.local;

  if (area) {
    return {
      async get<T>(key: string): Promise<T | undefined> {
        const bag = await area.get(key);
        return bag?.[key] as T | undefined;
      },
      async set<T>(key: string, value: T): Promise<void> {
        await area.set({ [key]: value });
      },
      async remove(key: string): Promise<void> {
        await area.remove(key);
      },
    };
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      globalThis.localStorage?.removeItem(key);
    },
  };
}
