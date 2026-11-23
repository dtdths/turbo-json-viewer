# 发布清单 — Turbo JSON Viewer（Chrome Web Store）

> 首次提交前的工作清单，分四块：**仓库侧**（能自动验证，已逐条跑过）、**素材与文案**（已生成，改文案只改单一来源）、
> **人工步骤**（仪表盘里只有你能做，走 `scripts/cws-submit-wizard.sh`）、**发布后冒烟**。
> 事实依据：`docs/research/mv3-store.md`（MV3 / 商店约束调研）、`docs/adr/`。当前版本 **0.1.0**，分发方式 **Unlisted 先行**。

## A. 仓库侧（2026-11-23 实测）

| 项 | 状态 | 证据 / 做法 |
|---|---|---|
| 包内无远程代码、无 `<script src="http…">`、无运行时拉取 JS/WASM | ✅ | `grep -rIo 'src="https\?://' dist/` 无输出；代码全部来自包内 |
| 无内联 `<script>`、无 `onclick=`、无 `javascript:` URL | ✅ | `dist/page.html` 只有一个 `<script type="module" src="./page.js">` |
| `eval(` / `new Function(` 审计 | ✅ | 唯一命中是 `core.eval(...)`（表达式求值的内部 RPC **方法名**，不是全局 `eval`）；无动态执行。已在 listing 的 test instructions 里向审核说明 |
| manifest：MV3、`default_locale: en`、`minimum_chrome_version: 120` | ✅ | `src/app/manifest.json` |
| 权限最小化：只有 `storage` + `contextMenus`，**无 host_permissions** | ✅ | 同上；ADR-0031 红线 |
| 图标 16 / 32 / 48 / 128 齐备且随包 | ✅ | `dist/icons/*.png`（`scripts/gen-icons.mjs` 是唯一来源，别手改 PNG） |
| `_locales` en / zh_CN 键完全对齐（各 4 条） | ✅ | 逐键比对，无缺漏 |
| 版本号合规（1–4 段点分整数） | ✅ | `0.1.0`；**每次上传必须严格大于上一版** |
| 构建产物无源码 / sourcemap 混入 | ✅ | 打包脚本对 `.map` / `.ts` / `.mjs` / `.md` 直接报错 |
| `manifest.json` 位于 zip 根目录 | ✅ | `unzip -l` 首行即 manifest |
| 可上传 zip + 确定性摘要 | ✅ | `npm run package` → `.spike/release/turbo-json-viewer-0.1.0.zip`，330 KB / 27 条目 / `sha256 3401ddb8…fa3b3`（同输入两次一致） |
| 单测 / 冒烟 | ✅ | `npm run check` 1575 / 68 文件；17 套冒烟串行全绿 |
| 品牌版本号与 manifest 不漂移 | ✅ | `page.html` 的 `{{TJV_VERSION}}` 由 `build.mjs` 用 `manifest.version` 替换（2026-11-23 由手写 `BETA` 改来），冒烟断言 `v<version>` |

## B. 素材与文案（已生成，都在 `.spike/`，不进版本库）

**商店素材** —— `npm run assets`（`scripts/store-assets.mjs`，可重跑）：

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `.spike/store/screens/shot-01-tree.png` | 1280×800 | 树视图 / 类型列 / 选中节点 / 文档概要 |
| `.spike/store/screens/shot-02-search.png` | 1280×800 | 搜索命中（键名 / 值 / 路径 + 树高亮） |
| `.spike/store/screens/shot-03-expression.png` | 1280×800 | 表达式结果作为独立视图 |
| `.spike/store/screens/shot-04-workspace.png` | 1280×800 | 两个文档标签 |
| `.spike/store/screens/shot-05-edit.png` | 1280×800 | 子树编辑弹层（浅色主题） |
| `.spike/store/screens/promo-440x280.png` | 440×280 | small promo tile（**必填**） |

商店要求：截图 ≥1、≤5 张，1280×800 或 640×400，**全出血无留白**；上面 5 张正好是上限，全部 1280×800。
截图里的界面语言是英文（与默认 listing 语言一致）；中文 listing 复用同一批图，不重拍。

**文案** —— 单一来源 `docs/release/listing.json`（`en` + `zh` 两套）：名称 / 摘要（≤132 字符）/ 详细描述 /
single purpose / 逐权限 justification / remote code = No / data usage 勾选口径 / test instructions / 截图说明。
改文案只改那个文件，`listing.md` 与 wizard 都从它读。

## C. 人工步骤（只有账号持有者能做）

```bash
scripts/cws-submit-wizard.sh        # 走一遍：预检 → 注册 → 建 item → 上传 → 列表 → 隐私 → 提交
```

要点（细节 wizard 会逐步打印）：

1. **开发者账号**：一次性注册费（官方正文未标金额，付款页为准；社区共识 US$5）。
2. **建 item 并上传** zip：`.spike/release/turbo-json-viewer-<version>.zip`。
3. **Store listing**：名称 / 摘要 / 详细描述 / 分类 **Developer Tools** / 语言 en + zh-CN / 5 张截图 / tile。
4. **Privacy practices**：single purpose、`storage` 与 `contextMenus` 的 justification、**Remote code = No**、
   data usage 如实勾选（本地处理也算处理用户数据，见调研 §8/§9）、隐私政策 URL
   `https://dtdths.github.io/turbo-json-viewer/privacy/`。
5. **Distribution**：先 **Unlisted** → 审核通过、真机跑一轮后再切 Public。
6. **提交审核**：记录提交时间；超过 3 周无进展可联系支持。

### 只能上台实测的项（调研 §12-E）

- 注册费实际金额；上传包大小上限；「不收集数据」时隐私政策 URL 是否仍为必填；YouTube 视频是否必填；Unlisted 的实际可见性。

## D. 发布后冒烟

- [ ] 用**无痕窗口**从商店 URL 安装，核对权限提示只有「存储」与右键菜单相关项，且与 listing 描述一致。
- [ ] 打开查看器 → 粘贴 10 MB JSON → 首帧正常、滚动跟手。
- [ ] 右键菜单：普通网页选中 JSON → 品牌子项 → 「打开查看」/「下载 JSON」。
- [ ] 卸载扩展 → 本地设置清除、无残留（`chrome.storage` 随卸载删除）。

## E. 真机手测清单（发布前建议，非硬阻塞）

> 2026-11-23 在一台 macOS 上跑过一轮：用 **Chrome for Testing 156**（headful 被系统遮挡，见下）
> + 真实 unpacked 扩展（`dist/`）实测。量到的数字如下，环境限制写在条目里。

- [ ] 真实右键点击（不是 CDP 合成）走完「打开查看 / 下载 JSON」（#63 的 headful 部分）。
      **2026-11-23：注册侧 ✅ / 点选侧 ⚠️**。注册侧（真实 unpacked 扩展的 service worker 里查）：
      三条 id `tjv-open-selection` / `-view` / `-download` 都存在，子项文案走 `_locales`
      得到「打开查看」/「下载 JSON」，不存在的 id 会报 `Cannot find menu item`（负例有效，说明探针本身有区分力）。
      点选侧未验证：本机桌面会话里 CfT 窗口始终被判为被遮挡
      （`document.visibilityState === 'hidden'`、`isOnScreen=false`，activate 后仍如此，屏幕录制权限也未授予），
      原生右键菜单因此不会弹出；**只能在有人值守的机器上点一次**，不阻塞提交。
      `manual-context-menu.sh` 会把窗口和扩展准备好、自动检测查看器是否被唤起并回填行数。
- [x] 系统缩放 125% / 150% 下行高与对齐（DPR ≠ 1）。**✅ 2026-11-23**：`--force-device-scale-factor`
      实测 DPR 1 / 1.25 / 1.5 / 2 四档，**CSS 像素几何完全一致**：树行高 24px、行间距 0（无 1px 缝或叠行）、
      行 top 全为整数、标签条 32px、状态栏 26px、标签条与树之间接缝 0px、`innerHeight` 757/758。
      没有出现半像素行高或行错位。
- [x] 真实文件选择 / 拖放导入 10 MB 与 50 MB（含截断修复路径）。**✅ 2026-11-23**（真实磁盘文件、
      走 `#fileInput` change → `importFile` 同一条链路；拖放用带 `files` 的 OS 拖放事件）：
      10 MB 首行 **114 ms**、状态栏稳定 633 ms；50 MB 首行 **612 ms**、稳定 ~633 ms；
      两者都无报错、状态栏 `10.0 MB / 50.0 MB · v1 · 只读·原文件不变`，堆 12 MB / 62 MB。
      截断路径：把 2 MB 样例切在 60% 处当真文件导入 → 顶部修复条
      「已修复：删除 9 个字符、补 4 个闭合符（仅语法闭合，未修改任何已有值）」，`详情` 可展开逐条定位。
- [x] 首帧与滚动期间无 >50ms 主线程长任务（DevTools Performance 抽查一次）。**✅ 2026-11-23**：
      2 MB 文档「全部展开」= 120,118 行（滚动内容 2,882,832 px），60 步滚到底：
      帧间隔中位 **16.7 ms**、最大 **18.1 ms**、**0 帧 >50ms**、`longtask` 计数 0。
      10 MB / 50 MB 导入期间 `longtask` 也是 0（解析在 worker，主线程不阻塞）。

复跑方式（量测脚本是 scratch，放在 `.spike/e2e/`，不进版本库；先 `node build.mjs`）：

```bash
DSF=1 PHASE=layout    node .spike/e2e/3-extension-e2e.mjs   # DPR：DSF=1.25 / 1.5 / 2
DSF=1 PHASE=import    node .spike/e2e/3-extension-e2e.mjs   # 10MB / 50MB 真实磁盘文件
DSF=1 PHASE=drop      node .spike/e2e/3-extension-e2e.mjs   # OS 拖放（带 files 的 dragData）
DSF=1 PHASE=truncated node .spike/e2e/3-extension-e2e.mjs   # 截断修复路径
DSF=1 PHASE=scroll    node .spike/e2e/3-extension-e2e.mjs   # 12 万行滚动帧/长任务
node .spike/e2e/menu-registration.mjs                       # 右键菜单注册（SW 侧，可自动）
.spike/e2e/manual-context-menu.sh                           # 右键菜单点选（需人坐在机器前）
```

## F. 版本号怎么改（每次上传都要更大）

1. 改 `src/app/manifest.json` 的 `version`（例如 `0.1.0` → `0.1.1`）。
2. `npm run package` —— zip 名字、页面 brand 上的 `v<version>` 都自动跟随（不要手改 `page.html` 里的版本）。
3. 冒烟会断言 brand 上的版本等于 `chrome.runtime.getManifest().version`，漂移会直接红。

## G. 与本次发布相关的文档

- 隐私政策（双语）：`docs/privacy/index.html`（GitHub Pages 上 `/privacy/`）。
- 文案单一来源：`docs/release/listing.json`；人读版：`docs/release/listing.md`。
- 商店约束调研：`docs/research/mv3-store.md` §9（隐私）/ §12（清单）/ §12-E（待实测）。
