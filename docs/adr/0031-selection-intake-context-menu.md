# ADR-0031：从网页选中的 JSON 一步打开（右键菜单 / `contextMenus`）

- 状态：Accepted（2026-11-20，实现随本 ADR 落地）
- 日期：2026-11-20
- 依据：**#57**（用户 2026-11-19 提出「先记下来，后续再定」；2026-11-20 两轮 grilling 拍板只做右键菜单）
- 相关：ADR-0004（导入管线与落点）、ADR-0009（多文档工作区 / `tabs.create`）、ADR-0026（i18n / `_locales`）、`docs/research/mv3-store.md`（权限与商店叙事）、`docs/architecture/build-and-test.md` §10（红线）

> 本文只记录**已拍板的首刀**（右键菜单）。浮动按钮（全站 content script）与「选中后点工具栏图标」（`activeTab` + `scripting`）都**没有**被本 ADR 接受，见「明确不做」。

## 背景

在任意网页上选中一段 JSON → 一步在 Turbo JSON Viewer 里打开。难点不是技术，是**权限叙事**：当前 manifest 只有 `["storage"]`，仓库红线是「绝不申请 `<all_urls>`」「没有 content script、不注入第三方页面」。

三个入口的代价差一个量级：

| 方案 | 入口 | 新增权限 | 商店警告 | 注入页面？ |
|---|---|---|---|---|
| A 浮动按钮 | 选中即浮出按钮 | `content_scripts: ["<all_urls>"]` | 升级为「读取和更改您在所有网站上的数据」 | 是（常驻） |
| A′ 选中 + 点图标 | 多一次点击 | `activeTab` + `scripting` | 无 | **是**（`executeScript`，一次） |
| **B 右键菜单** | 右键 → 菜单项 | `contextMenus` | 无 | **否** |

A′ 虽然无警告，但 `chrome.scripting.executeScript` 本身就是往第三方页面注入代码——它要改的正是 `build-and-test.md` §10「不注入第三方页面」。B 不注入：菜单回调直接给 `info.selectionText`，不需要 host 权限。

## 决策

### 1. 只做右键菜单（B）；不申请 host / `scripting` / `activeTab`

- manifest `permissions`：`["storage", "contextMenus"]`，两者都**无商店警告**；`host_permissions` 不声明（等同 `[]`），无 `content_scripts`。
- 菜单项 id 固定 `tjv-open-selection`，`contexts: ['selection']`——有选区才出现；Chrome 无法按选区内容显隐/禁用（内容检查只能发生在点开之后）。
- 注册时机：`runtime.onInstalled` 里 `removeAll()` → `create()`（安装/更新幂等；菜单跨浏览器重启持久，不需要 `onStartup`）。
- SW 仍然「不持文档、不转消息」；选区文本只在 `storage.session` 里停留到页面读完即删。

### 2. 数据通路（一次性 token，URL 只带 token）

```
info.selectionText（SW，菜单回调）
  → storage.session 写 { [tjv.incoming.<uuid>]: { kind:'text', text, createdAt } | { kind:'error', error, createdAt } }
  → tabs.create(page.html#incoming=<uuid>)
  → 页面启动读 hash → history.replaceState 抹掉 hash → 读并删条目 → 走现有 importBuffer
```

- **键前缀 `tjv.incoming.`**（`storage.session`；`settings` / `ui` 在 `storage.local`，键空间分开）。
- **单次使用**：页面读到即删；hash 先抹掉再读，刷新/回退不会重复导入。
- **TTL 清理**：SW 每次投递前清掉超过 1 小时的残留（值带 `createdAt`；`createdAt` 不合法的一并清掉；`storage.session` 本来就在浏览器重启时清空）。
- **不污染首屏**：page 侧不 import SW 的模块——共享**值**会让 esbuild 在 `page.js` / `sw.js` 之间拆出共享 chunk，首屏多一次请求，`--analyze` 也不会把它算进 `page.js`。所以键前缀在两个模块各写一份、注释互指；条目的形状与 `storage.session` 端口类型放在 `src/shared/incoming.ts`（**纯类型**，零运行时）。

### 3. 「点了要有反馈」（用户 2026-11-20 拍板）

菜单无法按内容显隐，点进来才发现不是 JSON 是常态；SW 又没有通知/剪贴板通道（要额外权限或离屏文档）。所以**失败也投递一条错误 token**，由页面开页 toast 解释：

| 情形 | 判据 | 页面反馈 |
|---|---|---|
| 不像 JSON | trim 后首字符不是 `{` / `[` | 「选中的内容不是 JSON——请选中以 { 或 [ 开头的文本」 |
| 过大 | 文本 > **2,000,000** 字符（≈4MB UTF-16，远低于 10MB 配额，也避免卡住 SW） | 「选中内容过大——请复制后在插件里粘贴」 |
| 正常 | 其余 | 走导入；落点是现有 `importTarget` 链路（新开的查看器工作区为空，实际等同新标签；设置只在已有文档时才有区分），显示名固定 `selection.json` |
| 解析失败且长度 ≥ 16384 | 浏览器可能截断了 `selectionText` | 用「浏览器可能截断了选区——若解析失败，请改用复制粘贴」**取代**普通语法错误 toast（`showToast` 是同一条，不叠加） |
| token 缺失 / 已消费 | 刷新、重复打开 | 静默（不报错） |

- 写 token 失败（配额/隐私模式）时退化写一条极小的 `too-large` 错误 token；连错误都写不进才空开。
- 明确**不**碰剪贴板、**不**申请 `notifications` / `clipboardWrite`。

### 4. 数据保真的已知边界（写进票与产品叙事，不静默）

- `selectionText` 是**浏览器渲染后的文本**，不是原始字节：beautify 页面通常仍合法；带行号/省略号/高亮的可视化 JSON 会解析失败 → 落现有错误链路。
- **换行被压成空格**（Chrome 行为，社区与 issue 均可复现）。对合法 JSON 无害——字符串里的换行本来就只能是 `\n` 转义。
- **可能截断**：官方文档没写上限，社区有 16384 的说法，W3C 线程又说 Chrome 是完整的。**无法自动验证**（原生菜单没有点击 API），所以按「可能截断」设计第 3 条的提示，并在真机手测清单里留着。
- 覆盖不到：`chrome://*`、Chrome 应用商店、DevTools、PDF 阅读器；跨域 iframe 里的选区能否拿到 `selectionText` 未验证（列手测）。
- **识别不设长度下限**（评审收口）：`{}` / `[1]` 也是 JSON，菜单是用户显式点击，噪声由解析失败反馈承担；早先「≥16 字符」会把 `{"a":1,"b":2}` 这类短 JSON 误拒。

### 5. i18n

- 页面 toast 走语言包：`app.incoming.notJson` / `app.incoming.tooLarge` / `app.incoming.truncated`（en / zh-CN 全量镜像，守护测试覆盖）；错误码 → 词条的映射在 `view/incoming-copy.ts`（与 `view/expression-copy` 同分工，app 不拼文案）。
- 菜单文案走 `_locales`（原 `menuOpenSelection`；2026-11-20 修订后为子项 `menuView` / `menuDownload`，父项是品牌名不翻译）：**跟随浏览器语言，不跟随应用内语言**——SW 拿不到页面语言包。记为已知差距，不静默。

### 6. 测试策略

- SW 规则层 `app/selection-intake.ts`：纯 TS、零 `chrome`，假端口单测（候选判定 / 正常投递 / 错误 token / 上限 / TTL 清理 / 写失败退化）。
- 页面消费层 `app/incoming-selection.ts`：hash 解析（只认安全 token）/ 读一次即删 / 错误码 / 存储异常降级 / 截断阈值。
- `smoke-extension` 新增 phase：`contextMenus` 权限与菜单文案存在、无 `content_scripts` / `host_permissions`；seed `storage.session` + `page.html?x#incoming=<token>` → 文档导入成功、token 已删、hash 已清；错误 token → 开页 toast。
- **真实右键点击**只能手测（Chrome 无 API）；列为已知差距。

### 7. 预算

- `sw.js` 0.1 → **0.7KB gz**（无硬预算，记账）。
- `page.js` 56.7 → **57.1KB gz**：预算 **57 → 58**（用户 2026-11-20 拍板，余 0.9）。增量全部来自选区导入：hash 消费 + 3 条文案 + `importBuffer` 返回值。
- 语言包 en 6.4 → **6.5**、zh 7.2 → **7.4**（每包 ≤7.5）；懒加载 **145.9 / 146** 不变（拆掉了 page↔SW 共享常量导致的 0.4KB 共享 chunk）。

## 明确不做（本 ADR）

- **A 浮动按钮**（全站 content script）与 **A′ `activeTab` + `scripting`**：两者都需要改「不注入第三方页面」的红线，各自另开 ADR；A′ 的数据通路与本文完全一致，将来可复用。
- `optional_host_permissions` 按站点授权；任何 `host_permissions`。
- 剪贴板回退（`clipboardWrite` / 离屏文档）、`notifications` 反馈。
- 复用已有查看器标签（要 `tabs.query` 或额外权限）；每次都是新标签。
- 「识别选区是不是 JSON」的页面侧探测（不注入就拿不到 DOM）。

## 已知差距（记录，不静默豁免）

- 真实右键点击、`selectionText` 截断阈值、`chrome://` / PDF / 跨域 iframe 覆盖矩阵：只能真机手测。
- 菜单标题跟随浏览器语言，不跟随应用内语言。
- `selectionText` 是渲染后文本；可视化 JSON（行号/省略号）会解析失败。
- 跨域 iframe 内的选区未验证。
- 选择超过 ~16KB 时若浏览器确实截断，用户看到的是「可能被截断」提示（它会重现成同一条 toast 上的最终文案，**不是**语法错误后再补一条）。

## 验收

- `npm run check` 全绿：单测 **1557 → 1571**（+14：selection-intake 7 / incoming-selection 7）。
- `smoke-extension` **OK**（新增 phase，见 §6）；其余 16 套冒烟断言零改动（`smoke-export` 的 `menu:select-restores-focus` 为既有环境偶发）。
- 体积：`page.js` **57.1 / 58**、`sw.js` 0.7、语言包 6.5 / 7.3、懒加载 145.9 / 146。
- 真机手测（发布前）：普通页面选中 beautified JSON → 右键 → 打开；选中散文 → 开页 toast；选中 >2M 字符 → 过大提示；`chrome://` 页面无菜单项。

## 修订（2026-11-20）：二级菜单 + 菜单图标 + 「下载 JSON」（#63）

用户真机试用反馈（截图）：菜单文案整句过长、菜单项左侧无图标；并希望第二项能直接下载。

1. **结构**：父项 `Turbo JSON Viewer`（品牌名不翻译，hover 出子菜单）+ 子项「打开查看」/「下载 JSON」（`_locales`，跟随浏览器语言）。菜单 id 稳定：`tjv-open-selection` / `-view` / `-download`；`modeOfMenuItem()` 只认两个子项 id，父项与未知 id 返回 null。父项不可点（Chrome 子菜单语义）。
2. **图标**：manifest 加 `icons`（16/32/48/128）与 `action.default_icon`——Chrome 只在提供 16×16 图标时才在菜单项旁显示图标。图形是深色圆角方块 + 品牌蓝 `{}`，由一次性 canvas 脚本生成（不进构建依赖），PNG 提交在 `src/app/icons/`，build 原样复制到 `dist/icons`。
3. **下载（路线 A，零新权限）**：token 的 `{kind:'text'}` 带 `mode: 'view' | 'download'`；页面导入成功后直接 `core.exportDoc` + `<a download>` 落盘：
   - **不经保存对话框**——新开的标签页没有用户手势，`showSaveFilePicker` 会失败；CfT 实测无手势锚点下载可以落盘；
   - **不关闭标签页**（用户拍板）：语义是「先导入再导出」，文档留在标签页里供继续查看；
   - 解析失败不下载、保留标签页并走现有错误提示；
   - 文件名沿用导入名（`selection.json`），缩进/转义跟当前设置。
4. **测试**：单测 1571 → **1574**（+3：mode 透传 / 菜单 id → 动作 / 页面读 mode）；`smoke-extension` 增加下载 phase（CDP `Browser.setDownloadBehavior` + `downloadWillBegin`，断言文件落盘、标签页未关、token 已删、hash 已清、页面有导入结果）。
5. **体积**：`page.js` 57.1 → **57.2KB gz（仍 ≤58）**、`sw.js` 0.7 → **0.8**（无硬预算）、语言包 6.5 / 7.4 与懒加载 145.9 不变；图标 4 个 PNG 共 ~18KB（不计 gz 预算，随扩展分发）。
