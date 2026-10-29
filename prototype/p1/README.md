# P-1 spike harness（真机 Chrome 自动化）

这套目录给「重评估 / P-1 spike」用：本机品牌版 Chrome ≥137 忽略 `--load-extension`，
所以自动下载了 **Chrome for Testing 156** 到 `.spike/cft/`（gitignored），用
headless + CDP 加载未打包扩展、打开扩展页、在页面里执行 JS 并取回结果。

## 快速开始

```bash
# 冒烟（约 6s，验证 harness 可用）
node prototype/p1/smoke.mjs
```

```js
import { withChrome, extensionUrl, SAMPLES } from './lib/chrome.mjs';
import { startStaticServer } from './lib/http.mjs';
import path from 'node:path';

await withChrome({ extensionDirs: ['prototype/p1/fixtures/runtime'] }, async (chrome) => {
  const page = await chrome.openPage();
  await page.goto(extensionUrl('prototype/p1/fixtures/runtime', 'page.html'));
  await page.waitFor('globalThis.__bench?.done === true', { timeoutMs: 120000 });
  const result = await page.eval('globalThis.__bench.result', { timeout: 180000 });
  console.log(JSON.stringify(result, null, 2));
});
```

- `launchChrome({ extensionDirs, windowSize, keepProfile, extraArgs })` → `{ openPage, close }`
- `page.goto(url)`, `page.eval(expr)`（支持 awaitPromise / returnByValue）, `page.waitFor(expr)`,
  `page.logs` / `page.exceptions`
- `extensionId(dir)` / `extensionUrl(dir, 'page.html')`
- `startStaticServer(dir)` → `{ base, close }`；页面/worker 可 `fetch(base + '/10mb.json')`
  （服务端带 `Access-Control-Allow-Origin: *`，扩展无 host_permissions 也能取）
- 样本：`.spike/samples/{2mb,10mb,50mb}.json`（50MB ≈ 2.96M 节点，**勿提交**）；
  真实形态样本 `.mock/1.json`（0.93MiB）。

## 约定

- **不要**用 `--no-sandbox` 以外的方式启动 Chrome；harness 已处理 profile（workspace 内）与清理。
- 每次测量取中位数 + p95，变体**交错**执行，避免顺序/预热偏置；报告里写清口径。
- 50MB 样本只从 `.spike/` 读，不复制进 repo；`.spike/` 已在 `.gitignore`。
- 同一时刻只跑一个重负载 Chrome 实例，避免 CPU 争用污染延迟数据（其他组的轻量构建可并行）。

## npm

公共源可用；本机 `.npmrc` 指向不可达的内网 Nexus，需显式覆盖：

```bash
npm install --registry=https://registry.npmjs.org --cache=/tmp/npm-cache-dsh
```
