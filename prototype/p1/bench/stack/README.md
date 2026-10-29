# stack bench — 技术栈重评估的可复跑脚本

对应报告：`docs/design/reassess-stack.md`（共享任务 task-2）。
夹具扩展：`prototype/p1/fixtures/stack/`（MV3 扩展页，bench 脚本运行时由 Chrome 加载）。

## 装依赖（依赖只装在本目录，不要建根 package.json）

```bash
cd prototype/p1/bench/stack
npm install --registry=https://registry.npmjs.org --cache=/tmp/npm-cache-dsh
```

## 跑

```bash
node build.mjs              # esbuild 多入口：bench-dom / bench-ui / worker / sw / app → fixtures/stack/*.js
node build-cm6.mjs          # CM6 最小集 vs +lang、acorn、focus-trap、floating-ui 的体积/耗时 + splitting 对比
node build-cm6-layers.mjs   # CM6 逐包增量体积（state → view → autocomplete → commands → lang）

node bench-dom.mjs          # 真机 Chrome：5 种行渲染变体（~60s，含 600 帧 rAF）
node bench-dom.mjs --quick  # 冒烟版（几秒）
node bench-cm6.mjs          # 真机 Chrome：MV3 CSP / mount / 输入 / 补全 / textarea 基线
node bench-ui.mjs           # 真机 Chrome：菜单/对话框/Toast/分栏/工具条/树导航/AX/i18n
node bench-build.mjs        # 构建、watch 增量、vitest、tsc 时间

npx vitest run              # 12 个单测（行窗口算术 / 行模型 / tokenizer）
npx tsc --noEmit            # strict 类型检查
```

Chrome 由 `prototype/p1/lib/chrome.mjs` 启动（CfT 156，`--no-sandbox`），**不要手动起 Chrome**。
同一时刻只跑一个 Chrome bench（其它重负载实例会污染帧时间）。

## 产物

- `results/*.json`：每次运行的原始数字（报告里的表格都来自这里）。
- `results/layers/`：CM6 分层构建产物（js）。
- `fixtures/stack/*.js`：构建产物（可由 `node build.mjs` 重新生成，已 gitignore）。

## 目录

```
src/
  rows.ts            行模型 + 固定行高可见窗口算术（单测对象）
  tokenizer.ts       轻量 JSON 行 tokenizer（单测对象）
  renderer.ts        推荐的行渲染器（行节点池 + textContent）
  bench-dom.ts       5 种行渲染变体 + XSS/省略号/行高检查（扩展页内运行）
  bench-ui.ts        7 个 UI 部件挂载 + 驱动 API
  cm6-min.ts         CM6 最小集（state+view+autocomplete+commands）+ CSP 加载期探针
  cm6-lang.ts        CM6 + javascript 语言高亮
  cm6-completion.ts  基于文档概要的补全源
  textarea-baseline.ts  textarea + 自研补全（CM6 的对照组）
  app.ts             「应用形状」bundle（体积预算用）
  worker.ts          module Worker 入口
  sw.ts              MV3 module service worker 入口
  ui/                手写 UI 部件（menu/toast/dialog/splitter/toolbar/treeNav/i18n）
  layers/            CM6 逐包体积探针入口
test/                vitest 单测
lib/                 chrome 路径、gzip 体积、CDP 输入、watch 计时
```
