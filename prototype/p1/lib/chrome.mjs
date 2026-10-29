/**
 * Minimal Chrome + CDP harness for the P-1 spike.
 *
 * Why: the DSH file sandbox blocks Chrome's own sandbox + default profile, but
 * `--no-sandbox` with a user-data-dir inside the workspace works (verified
 * 2026-10-27). This harness boots headless Chrome with the extension(s) loaded,
 * opens extension pages, and evaluates JS in them via the DevTools protocol.
 *
 * Node >= 22 (global WebSocket + fetch). No npm dependencies.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../../..');
// Branded Chrome (>=137) ignores --load-extension ("not allowed in Google
// Chrome, ignoring"), so we use Chrome for Testing, downloaded to .spike/cft.
const CFT_BIN = path.join(
  REPO,
  '.spike/cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);
const SYSTEM_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const CHROME_BIN =
  process.env.CHROME_BIN || (existsSync(CFT_BIN) ? CFT_BIN : SYSTEM_BIN);

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
export const SAMPLES = {
  '2mb': path.join(REPO_ROOT, '.spike/samples/2mb.json'),
  '10mb': path.join(REPO_ROOT, '.spike/samples/10mb.json'),
  '50mb': path.join(REPO_ROOT, '.spike/samples/50mb.json'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic unpacked-extension id: SHA-256 of the absolute dir path, 32 hex
 *  nibbles mapped 0-f → a-p. Matches what Chrome derives (verified against the
 *  id observed in issue #15). */
export function extensionId(dir) {
  const h = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function extensionUrl(dir, pagePath = 'page.html') {
  return `chrome-extension://${extensionId(dir)}/${pagePath.replace(/^\//, '')}`;
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), {
        once: true,
      });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      for (const cb of this.listeners.get(msg.method) || []) {
        try {
          cb(msg.params ?? {}, msg.sessionId);
        } catch {
          /* listener errors are not fatal */
        }
      }
    });
    return this;
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitForDevTools(port, deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(120);
  }
  throw new Error(`Chrome DevTools endpoint did not come up on :${port} (${lastErr})`);
}

/**
 * Launch headless Chrome with extensions loaded.
 * @param {{extensionDirs?: string[], profileDir?: string, windowSize?: string,
 *          extraArgs?: string[], keepProfile?: boolean, timeoutMs?: number}} opts
 */
export async function launchChrome(opts = {}) {
  const extensionDirs = (opts.extensionDirs || []).map((d) => path.resolve(d));
  const profileDir =
    opts.profileDir || path.join(REPO_ROOT, '.spike', `chrome-profile-${Date.now()}`);
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const port = opts.port ?? 9300 + Math.floor(Math.random() * 600);
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${opts.windowSize || '1440,900'}`,
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
  ];
  if (extensionDirs.length) {
    args.push(`--load-extension=${extensionDirs.join(',')}`);
    args.push(`--disable-extensions-except=${extensionDirs.join(',')}`);
  }
  args.push(...(opts.extraArgs || []));
  args.push('about:blank');

  const proc = spawn(CHROME_BIN, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += String(d)));

  const deadline = Date.now() + (opts.timeoutMs ?? 20000);
  let version;
  try {
    version = await waitForDevTools(port, deadline);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`${e.message}\nChrome stderr: ${stderr.slice(-2000)}`);
  }

  const browser = await new CDP(version.webSocketDebuggerUrl).connect();
  const pages = [];

  async function openPage(url, { loadTimeoutMs = 15000 } = {}) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const logs = [];
    const exceptions = [];
    browser.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid !== sessionId) return;
      const parts = (params.args || []).map((a) => a.value ?? a.description ?? a.type);
      logs.push({ type: params.type, text: parts.join(' ') });
    });
    browser.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid !== sessionId) return;
      exceptions.push(params.exceptionDetails?.text ?? 'exception');
    });

    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Page.enable', {}, sessionId);

    const page = {
      targetId,
      sessionId,
      logs,
      exceptions,
      async goto(targetUrl, { timeoutMs = loadTimeoutMs } = {}) {
        let timer;
        const loaded = new Promise((resolve) => {
          const off = browser.on('Page.loadEventFired', (_p, sid) => {
            if (sid !== sessionId) return;
            clearTimeout(timer);
            off();
            resolve(true);
          });
          timer = setTimeout(() => {
            off();
            resolve(false);
          }, timeoutMs);
        });
        const result = await browser.send('Page.navigate', { url: targetUrl }, sessionId);
        if (result.errorText) throw new Error(`navigate failed: ${result.errorText}`);
        await loaded;
        return page;
      },
      async eval(expression, { awaitPromise = true, returnByValue = true, timeout = 120000 } = {}) {
        let timerId;
        const timer = new Promise((resolve) => {
          timerId = setTimeout(() => resolve({ __timeout: true }), timeout);
        });
        const call = browser
          .send(
            'Runtime.evaluate',
            { expression, awaitPromise, returnByValue, userGesture: true },
            sessionId,
          )
          .then((r) => {
            if (r.exceptionDetails) {
              const d = r.exceptionDetails;
              throw new Error(
                `page eval threw: ${d.exception?.description || d.text || 'unknown'}`,
              );
            }
            return r.result?.value;
          });
        let out;
        try {
          out = await Promise.race([call, timer]);
        } finally {
          clearTimeout(timerId);
        }
        if (out && out.__timeout) throw new Error(`page eval timed out after ${timeout}ms`);
        return out;
      },
      async setViewport(width = 1440, height = 900, { deviceScaleFactor = 1, mobile = false } = {}) {
        await browser.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor, mobile },
          sessionId,
        );
      },
      async screenshot(file, { format = 'png', fullPage = false } = {}) {
        const params = { format, captureBeyondViewport: fullPage };
        if (fullPage) {
          const m = await browser.send('Page.getLayoutMetrics', {}, sessionId);
          const size = m.cssContentSize || m.contentSize;
          params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
        }
        const { data } = await browser.send('Page.captureScreenshot', params, sessionId);
        await writeFile(file, Buffer.from(data, 'base64'));
        return file;
      },
      async waitFor(expression, { timeoutMs = 15000, intervalMs = 50 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            if (await page.eval(expression)) return true;
          } catch {
            /* not ready yet */
          }
          await sleep(intervalMs);
        }
        throw new Error(`waitFor timed out: ${expression}`);
      },
      async close() {
        try {
          await browser.send('Target.closeTarget', { targetId });
        } catch {
          /* ignore */
        }
      },
    };
    pages.push(page);
    if (url && url !== 'about:blank') await page.goto(url);
    return page;
  }

  async function close() {
    const withTimeout = (p, ms) =>
      Promise.race([p.catch(() => {}), sleep(ms)]);
    for (const p of pages) await withTimeout(p.close(), 1500);
    await withTimeout(browser.send('Browser.close'), 2500);
    browser.close();
    proc.kill('SIGKILL');
    await sleep(200);
    if (!opts.keepProfile) await withTimeout(rm(profileDir, { recursive: true, force: true }), 5000);
  }

  return { browser, proc, port, profileDir, openPage, close };
}

/** Convenience wrapper: launch, run, always close. */
export async function withChrome(opts, fn) {
  const chrome = await launchChrome(opts);
  try {
    return await fn(chrome);
  } finally {
    await chrome.close();
  }
}
