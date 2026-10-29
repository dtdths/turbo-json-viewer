declare const chrome: {
  i18n: {
    getMessage(key: string, subs?: string[] | string): string;
    getUILanguage(): string;
  };
  runtime: {
    getURL(p: string): string;
    lastError?: { message: string };
    onInstalled: { addListener(cb: () => void): void };
    onMessage: { addListener(cb: (msg: unknown, sender: unknown, sendResponse: (v: unknown) => void) => boolean): void };
  };
  storage: { session: { set(v: Record<string, unknown>): Promise<void> } };
};
