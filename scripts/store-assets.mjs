/**
 * scripts/store-assets.mjs — 生成 Chrome Web Store 提交素材（可重跑，不靠手工截图）。
 *
 *   node build.mjs && node scripts/store-assets.mjs      # npm run assets
 *
 * 产出（`.spike/store/`，已 gitignore；商店上传时从这里取）：
 *   - shot-01-tree.png      1280×800  树视图 + 选中节点 + 类型列（深色）
 *   - shot-02-search.png    1280×800  搜索面板 + 命中高亮（深色）
 *   - shot-03-expression.png 1280×800 表达式结果视图（深色）
 *   - shot-04-workspace.png 1280×800  两个文档标签（深色）
 *   - shot-05-edit.png      1280×800  子树编辑弹层（浅色，顺带展示双主题）
 *   - promo-440x280.png     440×280   商店 small promo tile（品牌 + 一句话）
 *
 * 商店硬性要求（docs/research/mv3-store.md §12-C）：截图 ≥1、≤5 张，1280×800 或
 * 640×400、全出血无留白；small promo tile 440×280 必填。
 *
 * 样本数据在脚本内生成（不依赖 `.spike/samples/`，那目录不在版本库里）：
 * 一份像样的订单导出，覆盖对象 / 数组 / 数字 / 布尔 / null / 长字符串，足够让
 * 树、搜索、表达式三张图都「有内容」。
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';
import { startStaticServer } from '../prototype/p1/lib/http.mjs';

const OUT = path.join(REPO_ROOT, '.spike', 'store');
const SHOTS = path.join(OUT, 'screens');
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 样本数据 ------------------------------ */

const STATUSES = ['shipped', 'pending', 'refunded', 'shipped', 'shipped'];
const CITIES = ['Shanghai', 'Shenzhen', 'Hangzhou', 'Chengdu', 'Beijing'];
const NAMES = ['Li Wei', 'Chen Yu', 'Wang Fang', 'Zhao Min', 'Liu Yang'];

function demoDoc() {
  const orders = [];
  for (let i = 0; i < 240; i += 1) {
    const total = Math.round((40 + i * 3.37) * 100) / 100;
    orders.push({
      id: 'ORD-' + (1000 + i),
      status: STATUSES[i % STATUSES.length],
      total,
      currency: 'CNY',
      paid: i % 7 !== 0,
      refundedAt: i % 11 === 0 ? null : undefined,
      customer: {
        id: 4200 + i,
        name: NAMES[i % NAMES.length],
        city: CITIES[i % CITIES.length],
        vip: i % 9 === 0,
        email: 'customer' + i + '@example.com',
      },
      tags: i % 3 === 0 ? ['priority', 'gift'] : ['standard'],
      items: [
        { sku: 'SKU-' + (200 + (i % 17)), qty: 1 + (i % 4), price: 19.9 },
        { sku: 'SKU-' + (300 + (i % 13)), qty: 1, price: 12.5 },
      ],
      note:
        i % 5 === 0
          ? 'Deliver before 18:00; leave at the front desk if nobody answers the door.'
          : undefined,
    });
    orders[orders.length - 1] = Object.fromEntries(
      Object.entries(orders[orders.length - 1]).filter(([, v]) => v !== undefined),
    );
  }
  return {
    meta: {
      exportName: 'orders-2024.json',
      exportedAt: '2024-11-20T09:41:00+08:00',
      version: 3,
      source: 'orders-api',
      timezone: 'Asia/Shanghai',
    },
    summary: { count: orders.length, revenue: 184920.5, refundRate: 0.043 },
    orders,
  };
}

/* ------------------------------ 页面操作 ------------------------------ */

async function shot(page, name) {
  const file = path.join(SHOTS, name);
  await page.screenshot(file);
  console.log(`  ✓ ${path.relative(REPO_ROOT, file)}`);
  return file;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const server = await startStaticServer(REPO_ROOT);
  const chrome = await launchChrome({ windowSize: `${W},${H}` });
  const produced = [];
  try {
    const page = await chrome.openPage();
    await page.setViewport(W, H);
    await page.goto(`${server.base}/dist/page.html`, { timeoutMs: 30000 });
    await page.waitFor('document.readyState === "complete"', { timeoutMs: 15000 });
    await sleep(600);

    // 英文界面（listing 的默认语言；中文 listing 复用同一批图，UI 不重拍）
    await page.eval(`(async () => {
      const h = window.__tjv;
      h.setSetting('locale', 'en-US');
      h.setSetting('theme', 'dark');
      h.setSetting('typeColumn', true);
      window.__smokeDoc = ${JSON.stringify(JSON.stringify(demoDoc()))};
      return true;
    })()`);
    await sleep(700);

    // ---------- 1) 树视图：展开三层 + 选中一个节点 ----------
    await page.eval(`(async () => {
      const h = window.__tjv;
      const text = window.__smokeDoc;
      delete window.__smokeDoc;
      await h.loadText(text, 'orders-2024.json');
      await new Promise((r) => setTimeout(r, 700));
      for (const p of ['$.meta', '$.summary', '$.orders', '$.orders[0]', '$.orders[0].customer', '$.orders[0].items']) {
        await h.togglePath(p, true);
      }
      await new Promise((r) => setTimeout(r, 500));
      h.scrollToPx(0);
      await new Promise((r) => setTimeout(r, 200));
      const row = document.querySelector('.row[data-path="$.orders[0].customer"]');
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      return h.state();
    })()`);
    produced.push(await shot(page, 'shot-01-tree.png'));

    // ---------- 2) 搜索：真实输入 + 首个命中跳转 ----------
    await page.eval(`(async () => {
      const h = window.__tjv;
      document.querySelector('[data-panel-btn="search"]')?.click();
      await new Promise((r) => setTimeout(r, 300));
      const input = document.getElementById('searchInput');
      input.value = 'refunded';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      await h.search('refunded');
      await new Promise((r) => setTimeout(r, 600));
      await h.searchJump(1);
      await new Promise((r) => setTimeout(r, 600));
      return h.searchPanel();
    })()`);
    produced.push(await shot(page, 'shot-02-search.png'));

    // ---------- 3) 表达式：过滤结果作为一个结果根 ----------
    await page.eval(`(async () => {
      const h = window.__tjv;
      await h.expressionOpen();
      await new Promise((r) => setTimeout(r, 400));
      await h.expressionRunText('$.orders.filter(o => o.total > 700 && o.status === "shipped")');
      await new Promise((r) => setTimeout(r, 1200));
      return h.expressionState();
    })()`);
    produced.push(await shot(page, 'shot-03-expression.png'));

    // ---------- 4) 多标签 ----------
    await page.eval(`(async () => {
      const h = window.__tjv;
      await h.tabImportText(JSON.stringify({
        project: 'turbo-json-viewer',
        version: '0.1.0',
        settings: { theme: 'dark', locale: 'en-US', jsonIndent: 2 },
        features: ['search', 'expression', 'outline', 'edit', 'export'],
      }), 'config.json');
      await new Promise((r) => setTimeout(r, 900));
      return h.workspaceState();
    })()`);
    produced.push(await shot(page, 'shot-04-workspace.png'));

    // ---------- 5) 子树编辑（浅色主题） ----------
    await page.eval(`(async () => {
      const h = window.__tjv;
      h.setSetting('theme', 'light');
      h.setSetting('locale', 'en-US');
      const tab = h.workspaceState().tabs[0];
      h.tabSwitch(tab.id);
      await new Promise((r) => setTimeout(r, 700));
      const ws = h.workspaceState();
      const cfg = ws.tabs[1];
      h.tabSwitch(cfg.id);
      await new Promise((r) => setTimeout(r, 600));
      await h.editOpen('$.settings');
      await new Promise((r) => setTimeout(r, 1500));
      return h.editText();
    })()`);
    produced.push(await shot(page, 'shot-05-edit.png'));

    // ---------- promo tile 440×280：品牌 + 一句话，几何取自真实 brand SVG ----------
    const distHtml = await readFile(path.join(REPO_ROOT, 'dist/page.html'), 'utf8');
    const mark = /<span class="brand__mark"[^>]*>([\s\S]*?)<\/span>/.exec(distHtml)?.[1] ?? '';
    const tileHtml = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px;
    background:
      radial-gradient(120% 90% at 50% 0%, #1b2140 0%, #0e1119 55%, #0b0d12 100%);
    color: #e8ecf6;
    font-family: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .mark { width: 92px; height: 92px; filter: drop-shadow(0 10px 26px rgba(108, 124, 255, .35)); }
  .mark svg { width: 100%; height: 100%; display: block; }
  .name { font-size: 27px; font-weight: 640; letter-spacing: -0.01em; }
  .name b { font-weight: 640; color: #f2f4fa; }
  .sub { font-size: 14.5px; color: #9aa4bb; letter-spacing: 0.01em; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 2px; }
  .pill {
    font: 500 11.5px ui-monospace, "SF Mono", Menlo, monospace;
    color: #aab4d4; background: rgba(124, 140, 255, .10);
    border: 1px solid rgba(124, 140, 255, .26); border-radius: 999px;
    padding: 4px 10px;
  }
</style>
<div class="mark">${mark}</div>
<div class="name"><b>Turbo</b> JSON Viewer</div>
<div class="sub">Fast, local &mdash; your JSON never leaves this machine</div>
<div class="row"><span class="pill">50&nbsp;MB</span><span class="pill">no upload</span><span class="pill">expression filter</span></div>`;

    const tilePath = path.join(OUT, 'tile.html');
    await writeFile(tilePath, tileHtml);
    const tilePage = await chrome.openPage();
    await tilePage.setViewport(440, 280);
    await tilePage.goto(`${server.base}/${path.relative(REPO_ROOT, tilePath)}`, { timeoutMs: 20000 });
    await tilePage.waitFor('document.readyState === "complete"', { timeoutMs: 10000 });
    await sleep(400);
    produced.push(await shot(tilePage, 'promo-440x280.png'));

    console.log(`\nstore assets: ${produced.length} 张（${path.relative(REPO_ROOT, OUT)}/）`);
  } finally {
    await chrome.close();
    await server.close();
  }
}

await main();
