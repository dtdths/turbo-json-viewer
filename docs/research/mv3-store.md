# Manifest V3 与 Chrome Web Store 上架约束 — 工程与审核事实清单

> 调研 ticket：[#4「调研：Manifest V3 与 Chrome Web Store 上架约束」](https://github.com/dtdths/turbo-json-viewer/issues/4)（map [#1](https://github.com/dtdths/turbo-json-viewer/issues/1) 的 research 子项）。AFK 调研，访问日期 **2026-09-09**。
> 消费方：G-7（模块架构）、G-6（表达式执行）、发布清单。
>
> **标注体系**（每一条事实都带出处）：
> - 【确证】＝ 一手来源（developer.chrome.com 文档 / Chrome Web Store 政策页 / 官方博客 / W3C 规范原文）明文可引；
> - 【需实测】＝ 官方文档未逐字背书、或来源相互矛盾、或只有真机运行一个真实 MV3 扩展才能定论（括号内给出建议的运行时实验）。
>
> 一手来源以链接形式给出；正文 URL 均为官方页面实际地址（部分经只读代理抓取原文核对）。汇总出处见文末「关键出处」。

## 0. 决策速览（先读这里）

1. **一切可执行代码（JS/WASM）必须随扩展包分发**。「远程托管代码（RHC）」在 MV3 政策下被禁；运行时只能拉取**不含逻辑的数据/配置**。→ JSON 解析库、表达式引擎全部本地打包，禁止 CDN 加载 JS，禁止远程 eval。
2. **extension_pages 的 CSP 被钉死**：允许值只有 `'self'`（+ `'wasm-unsafe-eval'`）。`unsafe-eval` / `unsafe-inline` / 任何远程源写进 manifest 即**安装报错**。HTML 里不能有内联 `<script>`、`onclick=`。
3. **`eval()`/`new Function()` 的唯一合法出口 = manifest `sandbox.pages` 沙箱页**（unique origin、无 chrome.* API、postMessage 通信、默认 CSP 允许 unsafe-eval）。G-6 若要执行用户表达式字符串，必须放进沙箱页而不是 popup/options 页；顺带获得「与扩展 API 隔离」的审查加分。
4. **WASM**：Chrome 103 起不再默认放行，需在 `extension_pages` 显式声明 `'wasm-unsafe-eval'`，且 .wasm 二进制随包；若在沙箱页实例化 WASM 可能免此声明（需实测）。
5. **扩展 Service Worker 能力面窄**：无 DOM、官方明言**不支持动态 `import()`**、无 `navigator.clipboard`。→ UI、文件、剪贴板一律放 popup / options / offscreen document。
6. **文件读取是零扩展权限**的：`<input type="file">` 与拖放走标准 Web File API，不在扩展权限模型内。不要为读文件申请 host_permissions（既触发警告又无必要；那只会让你能 fetch 那些站点）。
7. **剪贴板**：真实用户粘贴的 `paste` 事件读取一般不需要 `clipboardRead`；**编程**读剪贴板（`navigator.clipboard.read*`）才需要。写入优先走「聚焦的扩展页 + 用户手势 `navigator.clipboard.writeText()`」的免权限路径（需实测）；此路不通时再声明 `clipboardWrite` 并在仪表盘写 justification——它会产生安装警告「Modify data you copy and paste」。
8. **chrome.storage.local 配额 10 MB**（无 `unlimitedStorage` 时）；会话级缓存可放 `storage.session`（10 MB、内存、重启即失）。`storage` 权限**不产生安装警告**。
9. **i18n**：有 `_locales/` 目录就必须有 `default_locale`；消息缺失按「精确 locale → 语言 → default_locale」回退，因此 **default_locale 的 messages.json 必须全量**。上架稳妥做法：`default_locale: "en"`（官方未逐字强制英文，见 §7）。
10. **商店侧**：单一窄目的 + 描述/截图/权限与行为「言行一致」；纯本地工具**也建议**提供隐私政策 URL 并披露「不收集、不上传」；权限最小化、拒绝 broad host permissions；开发者账号一次性注册费（官方正文未标金额，需在付款页实测；社区共识 US$5）。素材硬性项：≥1 张截图（1280×800 或 640×400）、440×280 small promo tile、icons 16/32/48/128、名 ≤75 字符、摘要 ≤132 字符、Developer Tools 分类。

---

## 1. 扩展页 CSP 的精确限制（extension_pages）

### 1.1 策略本体
- **MV3 中 `content_security_policy` 是对象**（`extension_pages` + `sandbox` 两个子键），不再是 MV2 的字符串 — 【确证】 — 来源: [Improve extension security（MV3 迁移指南）](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
- **`extension_pages` 覆盖扩展的页面与 worker 上下文**：popup、background service worker、扩展打开的 tab/iframe 等 — 【确证】 — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **默认策略 = `script-src 'self'; object-src 'self';`** — 【确证】 — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **`script-src` / `object-src` / `worker-src` 只允许三类值**：`'self'`、`'wasm-unsafe-eval'`、以及仅限 unpacked 扩展的 localhost 源（`http://localhost`、`http://127.0.0.1` 任意端口）。即 Chrome 强制的最小/最大策略都是 `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`，**不可再加任何其他 script 源** — 【确证】 — 来源: [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)、[Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **`'unsafe-eval'` / `'unsafe-inline'` 对 extension_pages 绝对禁止**；写进 manifest 安装时报错原文：`'content_security_policy.extension_pages': Insecure CSP value "'unsafe-eval'" in directive 'script-src'.` — 【确证】 — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **MV2 历史对照**：MV2 默认同为 `script-src 'self'; object-src 'self';` 但 manifest **允许放宽**，官方示例即 `script-src 'self' 'unsafe-eval'; object-src 'self'`，也允许经 HTTPS 的远程 script 源；MV3 明言「disallows … values that allow remote code execution」— 【确证】(2016 年官方 MV2 存档) — 来源: [Content Security Policy（MV2 存档）](https://web.archive.org/web/20160818212547/https://developer.chrome.com/extensions/contentSecurityPolicy)、[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)

### 1.2 内联脚本与内联事件处理器
- **extension_pages 不执行内联 JS，且无法用 `'unsafe-inline'` 打开**（不在允许值清单内）；既禁内联 `<script>` 块也禁内联事件处理器（`<button onclick="...">`）— 【确证】 — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[Use eval() in sandboxed iframes](https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval)
- **替代方案**：逻辑拆到独立 `.js`、事件用 `addEventListener`、启动时机挂 `DOMContentLoaded`/`load` — 【确证】 — 来源: [Use eval() in sandboxed iframes](https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval)
- **唯一允许内联/字符串代码的扩展内上下文 = 沙箱页**（见 §2）— 【确证】 — 来源: [Manifest – Sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)

### 1.3 blob: / data: URL
- **把 `data:`/`blob:` 当数据读取**（fetch、`<img>` 等非脚本用途）：默认策略不设 `connect-src`/`default-src`，不受 CSP 拦；政策也明确允许运行时拉取不含逻辑的数据/配置/图片 — 【确证】 — 来源: [Program Policies: Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
- **把 `data:`/`blob:` 当脚本源**（`<script src="data:...">`、`new Worker(blobURL)`、`importScripts(blobURL)`）：默认 `script-src`/`worker-src` 仅 `'self'`，预期被拦（社区大量报告 `Refused to create a worker from blob … violates CSP`），但 Chrome 扩展官方文档无逐字说明 — 【需实测】(默认 CSP 页面执行 `new Worker(URL.createObjectURL(new Blob([...])))` 与 `<script src="data:...">`，记录确切报错文本与 directive 名) — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **`<img src="data:...">`**：默认策略文本只有 `script-src` 与 `object-src`，无 `img-src`/`default-src` → data: 图片不受拦截（规范推论）— 【确证】(基于默认策略文本的推论) — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **`<object>`/`<embed>`**：`object-src 'self'` → 只能加载包内资源，data: 对象被拦 — 【确证】 — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)

### 1.4 「不得有远程代码」细则（RHC）
- **官方定义**：RHC = 「anything that is executed by the browser that is loaded from someplace other than the extension's own files. Things like JavaScript and WASM. It does **not** include data or things like JSON or CSS.」；`chrome.scripting.executeScript` 注入远程字符串/自建解释器执行远程命令串、`<script>` 指向包外资源、eval 远程抓取的字符串均为典型违例；第一方/第三方库一视同仁（含 Firebase 反例）— 【确证】 — 来源: [Deal with remote hosted code violations](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)、[Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- **MV3 全量打包**：「In Manifest V3, all of your extension's logic must be part of the extension package. You can no longer load and execute remotely hosted files」；service worker 本身也必须在包内，不可从服务器加载 — 【确证】 — 来源: [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)、[Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)
- **允许的远程内容 = 无逻辑数据**：远程 A/B 配置、账号同步、不做求值的资源（如图片）、服务端计算；远程**执行**仅限文档化 API（Debugger API、User Scripts API）两个例外 — 【确证】 — 来源: [Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- **sandbox/iframe 豁免**：与扩展 API 隔离的上下文（iframes、sandboxed pages）**豁免远程代码禁令**、可以加载远程代码，但「按对外部服务器通信对待」——仍须满足用户数据/隐私政策，功能须可判别 — 【确证】 — 来源: [Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)（原文 "code run in contexts that are isolated from extension APIs (such as iframes and sandboxed pages) are exempt from the restriction on loading code from remote sources"）
- **代码可读性**：不得混淆/隐藏功能；允许压缩、缩短变量名、合并文件；「This also applies to any external code or resource fetched by the extension package.」— 【确证】 — 来源: [Code Readability Requirements](https://developer.chrome.com/docs/webstore/program-policies/code-readability)
- MV2 时代的 `minimum_chrome_version` 宽限机制：本次调研未能在当前或存档的一手来源中找到（该说法若存在出自 2020–2021 的 CWS 公告/FAQ）；**无论是否存在，MV3 政策文本中没有此类例外，对本项目不适用** — 【需实测】(web.archive.org 检索 2020-06 前后 CWS/Chromium 公告核实；结论不影响 MV3 决策) — 来源: [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)

---

## 2. 表达式求值：唯一合法出口 = 沙箱页（G-6 关键）

- **官方文档给出的唯一 eval 出口**：把 HTML 页列入 manifest `sandbox.pages`，页面在 **unique origin** 运行：无 chrome.* API、不能直接访问非沙箱上下文、只能 `postMessage()` 与主页面通信 — 【确证】 — 来源: [Manifest – Sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)、[Use eval() in sandboxed iframes](https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval)
- **沙箱页默认 CSP 允许 eval**：`sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';` → 沙箱页可用内联 script 与 `eval()`/`new Function()` — 【确证】 — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **自定义沙箱 CSP 必须含 `sandbox` 指令、不得含 `allow-same-origin`**（否则沙箱失效）— 【确证】 — 来源: [Manifest – Sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)
- **MV3 对 sandbox 值没有 extension_pages 那样的新限制**（官方原文 "Content security policy values for sandbox have no such new restrictions."）— 【确证】 — 来源: [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
- **沙箱页文件本身必须在包内并列入 manifest**；豁免的是「从远程加载并执行」的部分，不是让你省掉打包 — 【确证】 — 来源: [Manifest – Sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)
- 对本项目：求值对象是**用户本地粘贴的 JSON/表达式**，与「远程代码」无关 → 走沙箱页求值同时满足 CSP 硬约束与商店政策；不要让用户表达式触达 chrome.* API（沙箱天然隔离，属审查加分）— 【确证】(上述条文归纳，架构建议) — 来源: [Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)、[Manifest – Sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)

---

## 3. 扩展内 Worker / Service Worker 可用能力

- **extension_pages 策略明确覆盖 worker 上下文** → 扩展页创建的 dedicated worker 继承同一 CSP（同样不能 eval、不能远程）— 【确证】 — 来源: [Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- **扩展页用包内文件创建普通 dedicated Worker**（`new Worker(chrome.runtime.getURL('w.js'))`）：预期可行，但官方扩展文档没有「可以」的专段 — 【需实测】(popup/options 中创建并确认脚本运行)
- **worker 脚本 URL 由 `worker-src` 管控**（回退链 worker-src → child-src → script-src → default-src）；`worker-src` 也在扩展受限指令清单内 — 【确证】 — 来源: [CSP Level 3 (W3C)](https://www.w3.org/TR/CSP3/)、[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
- **Shared Worker**：扩展页能否使用无一手文档；扩展 **service worker 全局按 Web 标准不能创建任何 Worker/SharedWorker**（[whatwg/html#8362](https://github.com/whatwg/html/issues/8362) 正是请求放开此限制的开放 issue）— 【需实测】(扩展页 `new SharedWorker(...)` 看构造与消息往返；SW 内检查 Worker/SharedWorker 构造器是否存在)
- **chrome.\* API 在 dedicated worker 内**：官方无可用性文档；[w3c/webextensions#217](https://github.com/w3c/webextensions/issues/217) 仍在请求把 WebExtension API 暴露给打包文档生成的 WebWorkers（暗示现状默认不可用）。惯例：worker 内 `postMessage` 回页面，由页面调 chrome.\* API — 【需实测】(worker 内读 `chrome.runtime`/`chrome.storage` 观察是否 undefined)
- **Chrome 113 起 offscreen document 可 spawn worker**（reason `WORKERS`「needs to spawn workers」）；SW 无 DOM，UI/文件等一律放 popup/options/offscreen — 【确证】 — 来源: [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- **MV3 service worker 注册**：manifest `"background": {"service_worker": "sw.js"}`；扩展页面不能 `navigator.serviceWorker.register()` — 【确证】 — 来源: [Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)
- **module type SW 自 Chrome 92 起支持**（`"type": "module"` + 静态 import；import assertions 不支持）— 【确证】 — 来源: [What's new in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)、[Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)
- **动态 `import()` 在扩展 SW 中不支持**：官方原句 "Note that import(), often called a dynamic import, is not supported."（[w3c/webextensions#212](https://github.com/w3c/webextensions/issues/212) 仍在请求支持）→ **不要在主线程之外依赖动态 import 拆包** — 【确证】(文档原句) — 来源: [Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)
- **module SW 中调 `importScripts()` 会抛 TypeError**（module scripts 不支持 importScripts，Web 平台行为；官方扩展文档未直接说明）— 【需实测】(设 `"type": "module"` 后调 importScripts() 观察报错)
- **扩展页面（popup/options）对包内本地模块做动态 `import()`**：预期被 `script-src 'self'` 放行，但无官方专述 — 【需实测】(popup 中 `await import(chrome.runtime.getURL('m.js'))`；被拦则控制台指明违反的 directive)
- **WASM**：Chrome 102 起 `'wasm-unsafe-eval'` 可写入 MV3 CSP；**Chrome 103 起不再默认授予**（"Extensions that use WebAssembly must now explicitly add this directive and value to extension_pages"）。不声明时 "WebAssembly will be disabled"；外部 .wasm 属 RHC、必须随包 — 【确证】 — 来源: [What's new in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)、[Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[Deal with remote hosted code violations](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
- **在沙箱页编译/实例化 WASM**：默认沙箱 CSP 含 `'unsafe-eval'`，预期可行且无需 wasm-unsafe-eval（Chrome 视 unsafe-eval 放行 wasm 编译），但无官方逐字说明 — 【需实测】(沙箱页 `WebAssembly.instantiate` 打包的 .wasm 观察是否成功)

---

## 4. 文件读取：input / 拖放 / 粘贴

- **`<input type="file">` + FileReader 读用户所选文件 = 标准 Web File API，不在 MV3 权限模型内**：官方权限全集里不存在「读取用户所选文件」这类权限；host permissions 覆盖的是 `fetch()`/tabs/cookies 等主机级能力 — 【确证】(推论：权限列表为全集 + declare-permissions 对 host_permissions 用途的定义) — 来源: [Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)、[Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- **需要「file:// 访问权限 + 用户开关」的只是直接访问 file: URL**（如 fetch file: 或 chrome.tabs 打开本地文件），file input **不在其中** — 【确证】 — 来源: [What's new in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)（Chrome 99 起 SW 可 fetch file: scheme，须用户在 chrome://extensions 开「Allow access to File URLs」；Chrome 118 起 tabs/windows 打开 file:// 同受此开关约束，可用 `chrome.extension.isAllowedFileSchemeAccess()` 检测）
- **拖放读取**（drop 事件取 `dataTransfer.files`）：官方无逐字条目；理论上与普通页面一致（drop 即用户手势，File 对象读取不经 file: URL）— 【需实测】(popup 中拖入 .json，读 `dataTransfer.files[0].text()`，确认无权限弹窗、无 lastError)
- **MV3 SW 无 DOM**，无法承载 input/拖放/粘贴事件 → 文件导入 UI 放 popup/options/offscreen — 【确证】 — 来源: [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- **粘贴读取**：`paste` 事件的 `clipboardData` 只在文档聚焦、用户真实粘贴时携带数据；MV2 官方权限表把 `clipboardRead` 绑定在「程序化 paste（`document.execCommand('paste')`）」上，MV3 权限表把 clipboardRead 表述为对 Clipboard API 读取（`navigator.clipboard.readText()` 等）的授权——**两者都不绑定用户真实粘贴事件** — 【确证】(权限表述) — 来源: [MV2 Declare permissions](https://developer.chrome.com/docs/extensions/mv2/declare-permissions)、[Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- **「扩展 popup 里真实粘贴无需权限即可读」**：官方无逐字背书（paste 事件在 popup 失焦/无编辑区时的可达性也无专文）— 【需实测】(popup 内聚焦 textarea/contentEditable 后 Ctrl/Cmd+V，观察 onpaste 是否触发、clipboardData 是否非空；带/不带 clipboardRead 对照)
- **程序化打开文件选择器**（`input.click()`/`showPicker`）在扩展页是否需要 user activation：官方扩展文档未覆盖 — 【需实测】(popup 中分别用真实点击与 `input.click()` 打开选择器，观察是否被拦)

---

## 5. 剪贴板读写：MV3 权限口径与审核注意点

- **警告口径**：`clipboardWrite` → 安装警告「Modify data you copy and paste」；`clipboardRead` → 「Read data you copy and paste」。**两者都触发安装警告** — 【确证】 — 来源: [Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- **clipboardWrite 官方定义**："Lets the extension cut and copy items to the clipboard using the web platform Clipboard API."（MV2 旧表另注：用于 `document.execCommand('copy')`/`('cut')`）— 【确证】 — 来源: [Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)、[MV2 Declare permissions](https://developer.chrome.com/docs/extensions/mv2/declare-permissions)
- **无权限的 Web 写入路径（Chrome 官方博客）**：剪贴板仅对 active tab 可访问；"Pages in active tabs can write to the clipboard **without requesting permission**, but reading … always requires permission"。Chromium 实现上写入要求 `clipboard-write` 权限**或 transient activation** — 【确证】(web 页面语境) — 来源: [Unblocking clipboard access](https://web.dev/articles/async-clipboard)、[Clipboard API | MDN](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)
- **「扩展 popup/页面在聚焦 + 用户手势下不带 clipboardWrite 也能 `navigator.clipboard.writeText()` 成功」**：官方扩展文档无逐字表述（属上一条 web 语义在扩展页的延续，popup 是否算 focused+active 未定义）— 【需实测】(popup 按钮 click handler 内直接 writeText；并测无手势/后台场景是否 NotAllowedError)。若实测可写 → **不声明 clipboardWrite，实现零剪贴板警告**；否则声明并在仪表盘逐条 justify。
- **读取路径**：编程读剪贴板（`readText()`/`read()`）在 Chromium 中始终要求权限；**推荐路径是引导用户「聚焦输入区后自己粘贴」**，靠 paste 事件拿数据（免 clipboardRead）— 【确证】(web 语境) — 来源: [Unblocking clipboard access](https://web.dev/articles/async-clipboard)
- **`navigator.clipboard` 是窗口/文档 API，MV3 Service Worker 里不可用**；需要后台剪贴板交互时用 offscreen document（reason `CLIPBOARD`）— 【确证】 — 来源: [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- **审核注意点**：若声明 clipboardRead/clipboardWrite，仪表盘 Privacy → Permissions justification 要逐条写「为什么必须」；警告文案与产品行为必须一致（用户会看到安装警告，别让「只读」的扩展声明 clipboardWrite）。

---

## 6. chrome.storage 配额

- **storage.local**：`QUOTA_BYTES = 10,485,760`（**10 MB**；Chrome 114 起；113 及更早 5 MB）。计入方式：「JSON stringification of every value plus every key's length」；超限立即失败并置 `runtime.lastError` / reject Promise — 【确证】 — 来源: [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)、[What's new in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)
- **`unlimitedStorage`**：使 storage.local 配额被忽略（"This value will be ignored if the extension has the unlimitedStorage permission"），并对 storage.local、IndexedDB、Cache Storage、OPFS 提供无限配额与逐出豁免；**该权限不显示安装警告** — 但对本地 JSON 查看器无刚需，**不建议**加 — 【确证】 — 来源: [Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)、[Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- **storage.session**：`QUOTA_BYTES = 10,485,760`（Chrome 112 起；111 及更早 1 MB）；数据在内存、扩展被禁用/重载/更新或浏览器重启时清空；默认不暴露给 content scripts（`setAccessLevel()` 可改）— 适合放「当前文档/展开状态」这类会话态 — 【确证】 — 来源: [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- **storage.sync**：`QUOTA_BYTES = 102,400`（≈100 KB 总量）、单条 `8,192`（含 key）、`MAX_ITEMS = 512`、写入 120 次/分、1800 次/时 — 【确证】 — 来源: [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- **`storage` 权限不触发安装警告**（权限参考列表无 Warning 行）— 【确证】 — 来源: [Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- 大文档（如 100 MB JSON）不适合进 storage.local（10 MB 上限）：文件/文本应留在内存文档对象，需要落盘时走「导出保存」而非 chrome.storage — 【确证】(配额数据 + 架构建议)

---

## 7. i18n messages 机制与「默认语言英文」

- **结构**：`_locales/<locale>/messages.json`，每个 key 即消息名（仅允许 `A-Z a-z 0-9 _ @`、不能以 `@@` 开头——`@@` 前缀保留给预定义消息）；每条消息必需 `message`，可选 `description`、`placeholders`（占位符 `$xxx$`/`$1..$9`，字面 `$` 写作 `$$`）— 【确证】 — 来源: [Localization message formats](https://developer.chrome.com/docs/extensions/how-to/ui/localization-message-formats)
- **`__MSG_messagename__`** 用于 manifest.json 与 CSS；JS/UI 字符串用 `chrome.i18n.getMessage()`（Chrome 100 起 SW 上下文也支持）— 【确证】 — 来源: [chrome.i18n](https://developer.chrome.com/docs/extensions/reference/api/i18n)、[What's new in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)
- **`default_locale` 必填当且仅当有 `_locales/` 目录**（"required for localized extensions (those with a _locales directory), but must be absent in extensions that have no _locales directory"）；取值须对应 `_locales` 下子目录名 — 【确证】 — 来源: [Manifest – Default Locale](https://developer.chrome.com/docs/extensions/reference/manifest/default-locale)、[chrome.i18n](https://developer.chrome.com/docs/extensions/reference/api/i18n)
- **回退顺序**：用户精确 locale（如 `en_GB`）→ 去地区的语言（`en`）→ **default_locale**。default locale 的 messages.json 必须定义全部字符串，翻译再稀疏也不会坏 — 【确证】 — 来源: [chrome.i18n](https://developer.chrome.com/docs/extensions/reference/api/i18n)
- **locale 集合**：支持形如 `en`、`en_AU`、`zh_CN`（2 字母语言[_地区]）；商店不支持的 locale 选最接近替代（官方示例：default_locale 为 `de_CH` 时商店侧选 `de`）；未发现「目录名固定 4 字符」规则 — 【确证】 — 来源: [chrome.i18n](https://developer.chrome.com/docs/extensions/reference/api/i18n)
- **「default_locale 应设英文」**：本轮检索的官方 Chrome/CWS 文档**没有逐字强制**；能确证的是 default locale 必须全量、CWS listing 语言取自 `_locales` 且受商店支持语言约束。**把 en 设为 default_locale 仍是上架稳妥做法**（社区共识：未翻译语言一律回退英文、商店元数据默认语言可读性最高）— 【确证】(机制部分) + 【需实测】(若设非英文 default_locale，对照 CWS Dashboard 语言下拉验证 listing 回退行为) — 来源: [chrome.i18n](https://developer.chrome.com/docs/extensions/reference/api/i18n)、[Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)

---

## 8. Web Store 审核对「接收任意 JSON 本地求值」类扩展的审视角度

- **政策层面最相关的是 RHC / 单一目的 / 诚实描述 / 用户数据**四条线；逐条核对见 §1.4、§9 与本节 — 【确证】(政策页归纳) — 来源: [Program Policies](https://developer.chrome.com/docs/webstore/program-policies)
- **求值「用户本地输入的文本」不属于任何远程代码违例示例**：政策违例示例全部针对「从远程源抓取/执行」（指向包外资源的 `<script>`、eval 远程抓取字符串、自建解释器执行远程命令串）；文中无针对用户输入文本的禁止表述 — 【确证】(政策页文本比对) — 来源: [Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- **但评审会要求「扩展完整功能能从提交代码中清晰辨认」**；逻辑须自包含，若代码路径无法判别可拒审或下架 — 【确证】 — 来源: [Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- **Code Readability**：不得混淆/隐藏功能（别对表达式引擎做最小化+混淆提交）；允许普通压缩 — 【确证】 — 来源: [Code Readability Requirements](https://developer.chrome.com/docs/webstore/program-policies/code-readability)
- **Single Purpose / Quality Guidelines**：扩展必须「单一、窄且易理解」；把 JSON 查看 + 搜索 + 表达式求值写成**同一调试目的**并在描述与仪表盘 single purpose 字段讲清（不要宣称「任意代码执行平台」）— 【确证】 — 来源: [Quality Guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)
- **言行一致（faithful representation）**：标题/图标/描述/截图不得夸大或误导；功能描述必须直接（"Misleading or Unexpected Behavior" 政策可据此下架）— 【确证】 — 来源: [Misleading or Unexpected Behavior](https://developer.chrome.com/docs/webstore/program-policies/unexpected-behavior)
- **用户数据定义宽**：`user-generated content`（用户粘贴的 JSON）在官方示例内；「handle」= collect/transmit/use/share — 【确证】 — 来源: [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- **本地处理也必须披露**：FAQ 原句 "…data [that] is only processed or stored locally…? Yes"，且「仅本地存储或用 chrome.storage 仍要发隐私政策」——本地工具**并不能免掉披露义务** — 【确证】 — 来源: [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- 2026 政策更新（2026-07-01 公布、08-01 执行）：收集的数据须「严格必要于已披露的单一目的」并显著披露（Limited Use 方向收紧）— 【确证】(官方博客；建议按此口径从早设计) — 来源: [Chrome Web Store policy updates: Enhancing user privacy and platform integrity](https://developer.chrome.com/blog/cws-policy-updates-2026)

## 9. 隐私政策要点

- **触发条件**："If your Product handles any user data, then you must post an accurate and up to date privacy policy"，URL 填入仪表盘指定字段 — 【确证】 — 来源: [Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- **内容底线**（FAQ 要求）：收集什么（含自动收集/经权限 API 获取）、如何使用、何时与谁分享；建议附加安全实践、用户访问/删除、保留期 — 【确证】 — 来源: [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- **仪表盘字段**（Privacy practices）：Single purpose description（帮审阅者理解焦点）、逐权限 Permissions justification、Remote Code 声明（MV3 未用远程代码必须选 No）、Data usage 勾选认证、Privacy policy URL — 【确证】 — 来源: [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- **不填的后果**：商品显示「未提供该信息」，警告后 30 天不整改被停用；**披露、隐私政策、实际行为三者不一致 = 违反计划政策**，可致全部商品停用与账户封禁 — 【确证】 — 来源: [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- **Limited Use 披露**：请求用户数据的扩展须在主页或一键可达页面展示 Limited Use 合规声明 — 【确证】 — 来源: [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- **本地纯工具建议口径**：隐私政策写「不收集、不上传、无第三方共享，数据仅本地内存/本地存储处理，卸载即清除」——虽然内容短，但**仍提供 URL**，规避「披露缺失」与 FAQ #3/#14 的本地披露义务 — 【需实测】(仪表盘勾「不收集数据」时隐私政策 URL 是否仍为必填，UI 未公开) — 来源: [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

## 10. 最小权限原则与权限警告（决定 manifest 的依据）

- **政策**：只请求「实现功能所必需的最窄权限」；同功能多选一时取访问最少者；禁止为未实现功能 future-proof 预申请 — 【确证】 — 来源: [Use of Permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions)
- **optional permissions 同受最小化约束**；权限建议列在 listing 或 about 页并说明理由 — 【确证】 — 来源: [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- **仪表盘**：宽于必要的权限「可能导致扩展被拒绝」，且要逐权限 justify — 【确证】 — 来源: [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- **警告表（与本项目相关的项）**：
  | 权限 | 安装警告文案 | 有无警告 |
  |---|---|---|
  | `clipboardRead` | Read data you copy and paste. | 有 |
  | `clipboardWrite` | Modify data you copy and paste. | 有 |
  | `downloads` | Manage your downloads. | 有 |
  | `storage` | — | **无** |
  | `unlimitedStorage` | — | **无** |
  | `activeTab` | — | 无（不显示） |
  | broad host（`*://*/*`、`<all_urls>`） | — | 有，且显著加长审核 |
  — 【确证】 — 来源: [Permissions reference list](https://developer.chrome.com/docs/extensions/reference/permissions-list)、[chrome.permissions](https://developer.chrome.com/docs/extensions/reference/permissions)（"storage permission… does not include a warning"）、[Permission warning guidelines](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)
- **`downloads` 权限仅为 chrome.downloads API 所需**；「`<a download>` 锚点下载 / File System Access（`showSaveFilePicker`）保存无需 downloads 权限」无官方表述 — 【确证】(前半) + 【需实测】(后半：扩展页锚点下载与 showSaveFilePicker 是否免权限) — 来源: [chrome.downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)

## 11. 建议的最小权限 manifest 草案（建议稿，非政策文本）

以「本地 JSON 查看 + 粘贴/文件导入 + 搜索 + 表达式求值 + 复制/导出、零网络」为功能面：

```jsonc
{
  "manifest_version": 3,
  "name": "Turbo JSON Viewer",        // ≤75 字符
  "description": "Local JSON viewer: ... no data leaves your device.",  // ≤132 字符
  "version": "0.1.0",                  // 1-4 段点分整数，0-65535，不能全 0，不能以 0 开头（非零段）
  "version_name": "0.1.0",             // 可选，展示用
  "default_locale": "en",              // 有 _locales/ 时必填；见 §7
  "icons": { "16": "icons/16.png", "32": "icons/32.png",
             "48": "icons/48.png", "128": "icons/128.png" },
  "action": {
    "default_popup": "popup.html",
    "default_title": "__MSG_extName__"
  },
  // 需要后台常驻逻辑再加；纯查看器可无 SW
  // "background": { "service_worker": "sw.js" },

  "permissions": [],                   // 起步零权限；需要记住设置/最近文档再加 "storage"（无警告）
  "optional_permissions": [],          // 不要 future-proof
  "host_permissions": [],              // 不需要 —— 绝不申请 <all_urls> 之类

  // 仅当表达式求值需要 eval()/new Function() 时提供（G-6 关键）
  "sandbox": { "pages": ["eval-sandbox.html"] },

  // 仅当使用 WASM（如 simdjson 解析）时提供；否则整段省略
  // "content_security_policy": {
  //   "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  // }
}
```

配套决策与理由：
- **复制**：目标零权限——popup 聚焦内由按钮 click 触发 `navigator.clipboard.writeText()`（用户手势；§5，需实测）；不声明 `clipboardWrite`（避免「Modify data you copy and paste」警告）。兜底：确需时声明并在仪表盘 justify。
- **导入（读）**：`<input type="file">` / 拖放 / paste 事件——全部零权限（§4）。
- **导出/保存**：优先 `<a download>` 或 File System Access（需实测免权限）；不要为「下载」功能声明 `downloads`（有警告）除非走 chrome.downloads。
- **i18n**：`_locales/en/messages.json` 全量 + `default_locale: "en"`（§7）。
- **storage**：当前文档/展开状态这类易失数据放内存或 `storage.session`；持久偏好放 `storage.local`（10 MB 内）；大文件不进 chrome.storage（§6）。
- **不要**：`tabs`（除非读 URL，可用 activeTab+scripting 替代）、`scripting`（本项目可能不需要 content script 注入）、任何 host_permissions。

## 12. 上架检查清单（Store Release Checklist）

**A. 提交前代码审计（仓库内自查）**
- [ ] 包内无 `eval(`/`new Function(` 出现在 popup/options/SW/worker 代码（只允许出现在 sandbox 页）
- [ ] 无 `<script src="http…">`、无 `fetch(...).then(eval)`、无 `importScripts(远程)`、无运行时拉取 JS/WASM
- [ ] 无内联 `<script>`、`onclick=`、`javascript:` URL（CSP 会直接拦，先本地过一遍）
- [ ] 若含 WASM：CSP 显式含 `'wasm-unsafe-eval'` 且 .wasm 随包（§3）
- [ ] 若声明了 `sandbox`：页面文件在包内、CSP 含 `sandbox` 指令、无 `allow-same-origin`（§2）
- [ ] `zip` 打包后 `manifest.json` 位于根目录；`chrome://extensions` → Load unpacked 全流程冒烟、无 console 报错
- [ ] 版本号合规且递增（1–4 段点分整数、各段 0–65535、非零段不以 0 开头、不能全 0；每次上传必须大于上一版）

**B. 账号与费用**
- [ ] 注册 Chrome Web Store 开发者账号并支付**一次性注册费**——官方正文未标金额，付款页实测（社区共识 US$5）（[Register](https://developer.chrome.com/docs/webstore/register)）

**C. 发布素材（数值来自官方文档；出处见文末关键出处 6/15/16 及各条内联链接）**
- [ ] icons 16/32/48/128 PNG；商店图标 128×128（建议主体 96×96 + 四周 16px 透明留白）
- [ ] 截图 **≥1、≤5 张**，1280×800 或 640×400，全出血无留白（1280×800 更佳，展示前缩至 640×400）
- [ ] **small promo tile 440×280 必填**（PNG/JPEG）；marquee 1400×560 可选
- [ ] 名称 ≤75 字符；摘要（summary/description）≤132 字符；详细描述直接陈述功能（单一目的）
- [ ] 分类：Developer Tools（JSON 查看器落点）
- [ ] 年龄分级/成熟内容自评（现行流程为自评标记，见 C-6）
- [ ] YouTube 视频链接是否必填：官方两页矛盾——以仪表盘必填标记为准（需实测）

**D. Privacy / Distribution / 提交**
- [ ] Single purpose description 写清「本地 JSON 查看/搜索/表达式求值」
- [ ] 逐权限 justification（若最终有 clipboardWrite/storage 等）
- [ ] Remote code 声明 = No
- [ ] Data usage 认证：如实勾选（本地处理也算处理用户数据，见 §8/§9）；提供 privacy policy URL（写「不收集、不上传、本地处理、卸载清除」）
- [ ] Distribution：先 **Unlisted**（链接可装、不进商店列表、同一审核流程）→ 稳定后 Public；语言/地区与 `_locales` 对齐
- [ ] Test instructions（需要时填）；提交按钮 Submit for Review
- [ ] 提交后跟踪 Pending 状态与邮件（`chromewebstore-noreply@google.com`）；大部分几天、可能数周；**超过 3 周可联系支持**
- [ ] Rejected → 按 Status tab 说明整改重提（不影响已发布版本）；Takedown → 可 Appeal
- [ ] 发布后冒烟：私密窗口经商店 URL 安装，核对权限警告与描述一致

**E. 提交流程需实测项（归总）**
- 仪表盘 UI/必填标记/上传格式与体积上限/注册费金额/「不收集数据时隐私政策 URL 是否必填」/Unlisted 实际可见性（§4-C 各条已注）。

---

## 关键出处（汇总）

1. [Manifest – Content Security Policy | Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
2. [Improve extension security（MV3 迁移指南）](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)
3. [Manifest – Sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)
4. [Use eval() in sandboxed iframes](https://developer.chrome.com/docs/extensions/how-to/security/sandboxing-eval)
5. [Deal with remote hosted code violations](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
6. [Program Policies: Additional Requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
7. [Program Policies / User Data FAQ / Privacy Policies / Quality Guidelines / Use of Permissions / Listing Requirements](https://developer.chrome.com/docs/webstore/program-policies)
8. [Fill out the privacy fields（仪表盘）](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
9. [Permissions reference list（权限全集与警告文案）](https://developer.chrome.com/docs/extensions/reference/permissions-list)
10. [Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)
11. [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
12. [chrome.i18n / Localization message formats](https://developer.chrome.com/docs/extensions/reference/api/i18n)
13. [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
14. [What's new in Chrome Extensions](https://developer.chrome.com/docs/extensions/whats-new)
15. [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)
16. [Register your developer account](https://developer.chrome.com/docs/webstore/register)
17. [Unblocking clipboard access（Chrome 官方博客）](https://web.dev/articles/async-clipboard)
18. [W3C Clipboard API and events](https://w3c.github.io/clipboard-apis/)
