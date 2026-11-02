# 工程结构与测试策略（#13）

> 状态：Accepted（2026-10-28）
> 关联：[README.md](README.md)（分层与 seam）、[seams.md](seams.md)（接口草案）；ADR-0001/0002/0005/0007；视觉定稿 `prototype/visual/c/`
> 口径：性能数字来自 Chrome for Testing 156 / Apple M4 / 32GB、`headless=new`（`prototype/p1`），与 `docs/design/tech-reassessment.md` 一致；未测项一律标「待实测」，不估数。
> 红线：仅 `storage` 权限、无网络/AI、禁 eval、文档不落盘（ADR-0003/0005）。

## 1. 仓库布局

```
turbo-json-viewer/
├── src/
│   ├── app/                  # MV3 装配：唯一知道"用哪个适配器"的地方
│   │   ├── main.ts           #   扩展页入口：建 Worker、装配 viewmodel + view
│   │   ├── worker.ts         #   module worker 入口：DocService + 传输适配器
│   │   ├── sw.ts             #   最小 SW：action.onClicked → 打开 page.html
│   │   ├── page.html         #   扩展页（非 popup），显式 <link page.css>
│   │   ├── manifest.json     #   MV3 清单（见 §2）
│   │   ├── transport/        #   CoreTransport：worker-transport / in-process-transport
│   │   ├── storage/          #   ViewStateStore：chrome.storage.local 实现
│   │   └── import/           #   粘贴 / 拖放 / 文件选择 → arrayBuffer transfer
│   ├── view/                 # DOM 视图层（只认 RowWindowSource 的快照）
│   │   ├── tree/             #   TreeView、RowRenderer、RowMetrics（行池 + textContent）
│   │   ├── shell/            #   ActivityBar / Toolbar / StatusBar / RepairBanner / EmptyState
│   │   ├── panels/           #   Search / Outline / Settings / Selection / Profile / Edits
│   │   ├── map/              #   JsonMapView（Canvas 层级塔，DPR/主题适配）
│   │   ├── editor/           #   ExprDrawer、SubtreeEditor、CodeEditor（CM6 懒加载）
│   │   └── styles/           #   tokens.css（从 prototype/visual/c 迁移）+ 组件样式
│   ├── viewmodel/            # 主线程状态（无 DOM、可纯单测）
│   │   ├── row-window-source.ts   # 单飞/合并/seq/版本/overscan/锚点
│   │   ├── selection.ts      #   选中句柄 + 键盘意图
│   │   ├── search-state.ts   #   命中集、当前命中、docRevision 过期
│   │   ├── panel-state.ts    #   C 布局：活动栏 / 左面板 / 右工作区
│   │   ├── theme-state.ts    #   主题 + 视图状态持久化
│   │   └── edit-state.ts     #   修改计数、undo/redo 可用性、stale 提示
│   ├── protocol/             # 消息与类型（零依赖，任何层可 import）
│   │   ├── messages.ts       #   Command / Reply / Event 判别联合
│   │   ├── types.ts          #   Row / RowWindow / MapTrail / Path / NodeHandle
│   │   ├── versions.ts       #   docRevision / rowVersion / seq + 校验谓词
│   │   └── errors.ts         #   STALE_ROW / STALE_ROOT / TOO_LARGE / PARSE / TIMEOUT …
│   ├── core/                 # Worker 内核心（无 DOM，纯 TS 可单测）
│   │   ├── doc-service.ts    #   唯一门面：路由命令、维护版本、广播事件（S1）
│   │   ├── root-store.ts     #   多根注册表（doc/expr:N/repaired，LRU 3）
│   │   ├── row-model.ts      #   per-open Fenwick、窗口下潜、toggle、增量替换
│   │   ├── identity.ts       #   懒 id + (parent, slot) 句柄；不建 parentMap
│   │   ├── import/           #   pipeline / repair / fidelity（BigInt 精确判定）
│   │   ├── search.ts         #   全文档扫描 → 命中集（不建根）
│   │   ├── expr/             #   acorn + 白名单 walker + 预算
│   │   ├── edit-history.ts   #   replaceNode 的 undo/redo/reset（深度 100）
│   │   ├── trail.ts          #   选中 → MapTrail（O(depth)，兄弟 ±2）
│   │   ├── copy.ts           #   子树 JSON / 路径 / 原值 / 键名
│   │   └── profile.ts        #   Document Profile 采样（异步、不阻塞首帧）
│   └── shared/               # 纯工具（零依赖）：path parse/format、i18n、assert
├── tests/
│   ├── unit/                 # 按层镜像 src：core / viewmodel / protocol / shared
│   ├── contract/             # CoreTransport 共享用例 + 两种适配器跑法
│   └── fixtures/             # 截断 JSON fixture、合成行数据、memory 替身
├── bench/                    # 性能基准（Node 驱动 CfT），结果落 .spike/，不进 CI
├── build.mjs                 # esbuild 配置 + 静态拷贝 + 体积门禁
├── docs/ · prototype/ · scripts/  # 设计/harness/向导：保留但不进入 dist、不发布
└── dist/                     # 构建产物（不进版本库；.gitignore 待补）
```

**依赖方向**（`npm run lint:layers` 用 ESLint `no-restricted-imports` + tsconfig paths 强制）：

| 层 | 可以 import | 禁止 |
|---|---|---|
| `app` | `view`、`viewmodel`、`protocol`、`shared`；**仅 `worker.ts`** import `core` | 反向依赖；在 `main.ts` 里 import `core` |
| `view` | `viewmodel`、`protocol`、`shared` | `core`、`app`、直接 `postMessage` |
| `viewmodel` | `protocol`、`shared` | `view`、`core`、`document`/`window` |
| `protocol` | 无（零依赖） | 任何层 |
| `core` | `protocol`、`shared` | DOM/window、`view`、`viewmodel`、`app` |
| `shared` | 无（零依赖） | 任何层 |

`prototype/` 保留作真机基线与视觉定稿，但**不进入 `dist/`、不发布**；构建只读 `src/`。

C 布局常量（CSS 变量，只有行高会被 `RowMetrics` 吸收进逻辑层）：活动栏 48 / 左面板 320 / 树 max 1280 居中 / 右工作区 300 / 状态栏 26 / 行高固定 24。

## 2. MV3 布局

### 2.1 `manifest.json` 草案

```json
{
  "manifest_version": 3,
  "name": "Turbo JSON Viewer",
  "version": "0.1.0",
  "description": "本地只读 JSON 查看器：Worker 常驻文档、固定行高虚拟化、搜索/表达式/临时编辑。",
  "minimum_chrome_version": "120",
  "action": { "default_title": "Turbo JSON Viewer" },
  "background": { "service_worker": "sw.js", "type": "module" },
  "permissions": ["storage"],
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

- 不写 `content_security_policy`：MV3 默认策略已是 `script-src 'self'; object-src 'self'`，天然禁 `eval`/远程代码，改它只会放宽，没理由改。
- 不写 `web_accessible_resources`、不写 `host_permissions`：没有 content script、不注入第三方页面；数据只来自粘贴与用户选择的本地文件。
- `minimum_chrome_version: "120"` 与 esbuild `target` 对齐；真机基线为 CfT 156（ADR-0005）。

### 2.2 页面 / Worker / SW 三个运行时

| 运行时 | 形态 | 职责 | 生命周期 |
|---|---|---|---|
| 扩展页 | `chrome-extension://<id>/page.html`（**非 popup**） | 装配一切：创建 Worker、挂载 view、持有 `RowWindowSource` | 用户关闭标签即销毁；选 tab 而非 popup，因为 popup 失焦即关，会连 Worker 一起杀掉 |
| module worker | `new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' })` | 文档常驻、解析、行模型、搜索、表达式、编辑、trail、复制 | 随页面创建/销毁；不跨页面复用（ADR-0001） |
| Service Worker | `sw.js`（`type: "module"`） | 只做 `action.onClicked → chrome.tabs.create({ url: runtime.getURL('page.html') })` | Chrome 随时可杀；**不持文档、不转消息、不写 storage** |

通道：窗口请求走独立 `MessageChannel`、控制命令走 `postMessage`（两者往返无性能差，11µs；分开只为隔离排队，ADR-0001）。SW 与 module worker 是两个概念，文档状态只在后者。

### 2.3 权限与红线核对

| 红线 | 落实 |
|---|---|
| 仅 `storage` | 只存主题/面板/视图状态与最近文档**元数据**（文件名/大小/时间），从不存文档内容 |
| 无网络/AI | manifest 无 host 权限、无 fetch 调用；CSP 禁远程脚本 |
| 禁 eval | 表达式用 acorn AST + 白名单 walker；构建产物断言 `eval(`/`new Function` 出现次数为 0 |
| 文档不落盘 | 解析后释放源文本（ADR-0003）；导出是唯一写文件动作，走用户手势 |
| 最小面 | 无 content script、无 `web_accessible_resources`、无 `tabs` 权限（`tabs.create` 不需要） |

## 3. 构建链（esbuild）

### 3.1 入口与产物

| 入口 | 输出 | 说明 |
|---|---|---|
| `src/app/main.ts` | `dist/page.js` + `page.css` | 扩展页首屏：app + view + viewmodel + protocol + shared |
| `src/app/worker.ts` | `dist/worker.js` | core + protocol + acorn；module worker |
| `src/app/sw.ts` | `dist/sw.js` | 十几行，只做 action 转发 |
| 动态 import | `dist/cm6-*.js`（chunk） | 首次打开表达式/子树编辑器才加载 |

静态件由 `build.mjs` 拷贝：`page.html`、`manifest.json`、`icons/`。`dist/` 不进版本库。

### 3.2 关键选项

| 选项 | 值 | 理由 |
|---|---|---|
| `bundle` / `format` | `true` / `"esm"` | module worker 与 `splitting` 都要求 ESM |
| `target` | `"chrome120"` | 与 manifest 下限一致；CfT 156 实测 |
| `splitting` | `true` | CM6 与 acorn 的公共块只打一次 |
| `sourcemap` | 开发 `"linked"`，发布关闭 | 商店包不带 map |
| `minify` | `true` | CWS Code Readability 允许 minification（删空白/缩短变量名/合并文件），禁止的是混淆与隐藏功能；本项目无 eval、无远程代码、发布不带 sourcemap，minify 合规。体积预算按 minify 后 gz 计（CM6 首开闭包 ≈129–131KB gz ≤140 预算；`minify:false` 会到 200.1KB 超预算） |
| `metafile` | `true` | `npm run size` 逐文件 gzip 后卡预算（CI 门禁） |
| `logLevel` | `"warning"` | 构建日志干净 |

### 3.3 chunk 划分与 CM6 懒加载

- `CodeEditor`（seam S5）是唯一入口；`view/editor/loader.ts` 里做动态 `import()`，`splitting` 自动把 `@codemirror/state|view|commands` 提到共享 `cm6-core` chunk。
- 首帧不加载 CM6/acorn；点「表达式」加载 `cm6-core + cm6-expr`，点「编辑节点」加载 `cm6-core + cm6-json`。
- 表达式框 v1 **不带** `@codemirror/lang-javascript`（+45.0KB gz，ADR-0005 列为产品取舍）；子树编辑器带 `@codemirror/lang-json`（ADR-0006）。

### 3.4 体积预算（gzip，`npm run size` 卡线）

| 产物 | 预算 | 依据 |
|---|---|---|
| 首屏 JS（`page.js`，不含 CM6/worker） | ≤45KB | ADR-0005：首屏 ≈37KB gz（acorn 33.7 + 自有 3.3）；本方案 acorn 下沉 worker，page 只剩 view/viewmodel/protocol/app，仍沿用 45KB 作硬上限（实际值以首次构建实测为准） |
| Worker（`worker.js`） | ≤50KB | acorn 实测 33.7KB gz + core 自写 + protocol；与首帧并行，不进 DOM 关键路径 |
| CM6 按需 chunk（单次进入编辑器合计） | ≤140KB | CM6 最小集实测 99.4KB gz（state 16.2 + view 49.1 + autocomplete 25.5 + commands 10.2）；`lang-json` 增量待实测（`lang-javascript` +45.0KB gz 为上界），留约 40KB |
| 总（page + CM6，gz） | ≤190KB | 45 + 140 = 185，留 5KB；worker/SW 单独核算（不同上下文，不参与页面加载） |

构建耗时预期：多入口 **67ms**、watch 稳态 **~104ms**（ADR-0005 实测），所以不做 HMR。

### 3.5 命令与"不引 Vite + CRXJS"

```bash
node build.mjs            # 生产构建（一次）
node build.mjs --watch    # 监听 + 扩展 reload（onEnd 触发，不做 HMR）
node build.mjs --analyze  # 打 metafile + gz 报告
```

不引 Vite+CRXJS（沿用 ADR-0005）：无框架、无 CSS 管线，esbuild 三入口已够快；CRXJS 的价值是 HMR，而 HMR 与"最小 SW 不持状态、Worker 随页面销毁"冲突——每次热更都得重载 SW 与整页，收益被成本吃掉。等样式迭代真的变慢再评估。

## 4. 测试策略

四层：**纯逻辑单测 → 传输契约 → 真机 harness → 性能/视觉基线**。越靠下越慢、越少跑。

### 4.1 vitest 单测（无 DOM，毫秒级）

| 模块 | 关键用例（每类 3–6 条） |
|---|---|
| `core/RowModel` | 折叠容器只占 1 行且 `totalRows` O(1) 正确；`window(start,count)` 与 `rowOfPath` 往返一致；toggle 后子项行出现/消失且 `rowVersion++`；超 1,000,000 行预算的展开返回 `TOO_MANY_ROWS`；`replaceNode` 按 S1 保留自身展开、子节点折叠 |
| `core/identity` + `shared/path` | 容器懒 id 稳定、释放后不复用；标量 `(parent,slot)` → 路径（标识符/非标识符/数组下标）；`parse(format(p)) === p`；根 `$` 与空 key 边界 |
| `core/ImportPipeline` | 18 个截断 fixture：16 检测 / 16 修复后可 parse / 0 内容猜测；BigInt 精确失真（20 位整数、`1e400`、超范围下溢）；整数键后跟字符串键不算失真；profile 采样后源文本释放 |
| `core/Expr` | 白名单外（`new`/`while`/赋值/函数声明）被拒；`data.hotel_list.filter(...)` 元素是原节点引用；步数/时间超限返回 `TIMEOUT`；顶层裸引用 `data ≡ $.data`，白名单冲突优先 |
| `core/EditHistory` | 语法错 JSON 不推进 `docRevision`；undo/redo 深度 100 后 FIFO 丢弃；reset 回到导入值；深度相等时 no-op |
| `viewmodel/RowWindowSource` | 连续 3 次请求只保留 1 个在途、最终目标是最后一次；`seq` 落后回包被丢弃；`rowVersion` 不匹配 → `STALE_ROW` 并重取；scrollTop 变化 > overscan×rowH 触发 1 屏方向预取；toggle 后按锚点行+像素偏移重设 scrollTop |
| `viewmodel/*State` | 活动栏切换 → 面板开合矩阵（搜索/大纲/设置/表达式/文档）；右栏折叠不改树锚点；主题/面板经 memory `ViewStateStore` 往返 |
| `protocol` | 消息结构可结构化克隆（无 class/函数）；`isStaleRow` 版本谓词；未知消息 → 错误事件而非崩溃 |
| `shared` | i18n zh/en 槽位一一对应；断言在 dev 抛错、prod 降级为事件 |

### 4.2 契约测试（`tests/contract/`）

同一套用例、两个适配器，保证线上 `WorkerTransport` 不漂移：

```
tests/contract/core-transport.cases.ts   # runContract(createTransport) 导出用例
tests/contract/in-process.spec.ts        # vitest：InProcessTransport → 直接 new DocService
tests/contract/worker-chrome.mjs         # CfT 加载 dist/，page 创建真实 module worker
```

用例：load → 首窗口行数与首行内容；toggle → `rowVersion` 递增且窗口重算；迟到窗口回包被丢弃；`replaceNode` 后 `getNodeJson` 返回新值；search 命中带 `docRevision`、改文档后判 stale；`cancelLoad` 后旧结果被忽略。InProcess 进 CI（快），Worker 版只在本地/夜间跑。

### 4.3 真机 harness（复用 `prototype/p1/lib`）

`launchChrome({ extensionDirs: ['dist'] })` + `extensionUrl('dist','page.html')`，`page.eval` 读指标、`page.screenshot` 留证；`startStaticServer` 以 CORS 提供样本（扩展无 host 权限也能 fetch，仅测试用）。

| 指标 | 断言 | headless 基线（需 headful 复核） |
|---|---|---|
| 10MB 导入→首帧 | <800ms | 52ms |
| 50MB 导入→首帧 | <800ms | 150ms（p95 166ms） |
| 主线程 >50ms 长任务 | 0（导入/滚动/展开全程） | 0 |
| 平滑滚动空白行率 | 0%（overscan 8） | 0%（11.1% @overscan 2） |
| 随机跳转空白 | ≤1 帧 | 1 帧 |
| 行窗口端到端 | p95 ≈2ms | 2ms |
| toggle 18.5 万项 | ≤10ms | 9.2ms |
| DPR 2 / 缩放 125–150% | 行高 24±0.5px、无错位 | 待实测 |

### 4.4 性能基准（`bench/`，不进 CI）

| 脚本 | 测什么 |
|---|---|
| `bench/runtime.mjs` | parse、首帧、行窗口 p95、toggle、eval、search、复制 |
| `bench/fidelity.mjs` | 保真扫描成本、截断修复 fixture |
| `bench/README.md` | 口径与复跑方式（样本、中位数+p95、交错执行） |

样本：`.spike/samples/{2mb,10mb,50mb}.json`（50MB ≈ 2,958,550 节点）+ `.mock/1.json`（真实形态 0.93MiB，搜索 43–75ms 量级对照 bejson 的 44s）。结果写 `.spike/bench/*.json`，不提交；bench 约 2–4 分钟，手动触发。

### 4.5 视觉回归

- 基线 = `prototype/visual/shots/c-*.png`（16 张：1440×900 / 1280×720、dark+light、搜索/大纲/设置/折叠右栏）。
- 重截：`node prototype/visual/shoot.mjs c`（同 URL、同尺寸、同 `--force-device-scale-factor=1`）；v1 人工比对，像素差门禁等字体渲染稳定后再上（跨机器字体栈差异会误报）。

## 5. 开发命令与 CI

```bash
npm run build          # esbuild 构建 → dist/
npm run watch          # 监听重建 + 扩展 reload
npm run typecheck      # tsc --noEmit（project references）
npm test               # vitest：unit + in-process contract
npm run test:contract  # + worker-chrome.mjs（真实 module worker）
npm run lint:layers    # 依赖方向门禁（ESLint）
npm run size           # gz 体积预算门禁
npm run bench          # 需 .spike/samples，约 2–4 分钟
npm run shoot          # 视觉基线（需 Chrome for Testing）
```

CI（必需）：`typecheck → lint:layers → unit + in-process contract → build → size`。手动/夜间：worker contract、bench、视觉重截、真机 harness（需 CfT 下载，见 `prototype/p1/README.md`）。

## 6. 风险与未定

| 风险 | 现状 | 处理 |
|---|---|---|
| headful 复核未做 | ADR-0001 全部数字来自 headless | 发布前必须复测滚动空白/锚定/长任务/DPR（真机向导 `scripts/mv3-verify-wizard.sh`） |
| 真实磁盘 I/O 与剪贴板 | 未测（spike 中样本经 fetch 喂入） | 向导阶段测 file picker 与 `navigator.clipboard`；失败降级拖放/粘贴 |
| 50MB 内存上限 | Worker ≈73MB、主线程 0.72MB、文本 0 | 超 50MB 先提示预估再继续；保真/profile 异步；不保留源文本 |
| worker 生命周期 | 页面关闭即销毁 | 不在 SW 存文档；刷新 = 重新导入，避免"半状态" |
| CM6 体积取舍 | 最小集 99.4KB gz；`lang-javascript` +45.0KB | v1 表达式框不带 JS 高亮；`lang-json` 增量实测后再定 |
| `minify: true` 的体积代价 | 已量化（page.js 26.1→17.0KB gz；CM6 首开闭包 200.1→≈129–131KB gz；raw 字节约 −45%） | 代价 = 真机报错栈不可读（需要时本地临时 `minify:false` 构建复现），发布不含 sourcemap；`size` 门禁按 minify 后 gz 卡 |
| Windows 高对比度 / 屏幕阅读器 / IME | 未测 | 真机向导补；aria 结构先按 ADR-0005 的 tree/treeitem 实现 |
