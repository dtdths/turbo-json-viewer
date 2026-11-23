# Store listing — 字段说明（文案本体在 `listing.json`）

> **单一来源**：`docs/release/listing.json`。本文件只说「哪一栏填什么、限制是什么」，
> 不复制文案——避免两处漂移。要读/复制当前文案：跑 `scripts/cws-submit-wizard.sh`
> （它会逐字段打印），或直接看 JSON。

## 一、仪表盘字段对照

| 仪表盘字段 | 取 `listing.json` 的 | 限制 / 说明 |
|---|---|---|
| Name | `locales.<lang>.name` | ≤75 字符；品牌名不翻译（ADR-0026 §5），两种语言都用 `Turbo JSON Viewer` |
| Summary | `locales.<lang>.summary` | **≤132 字符**（硬上限）；首屏唯一会被读完的一段 |
| Description | `locales.<lang>.description`（数组按行拼接） | 支持换行；我们按「大文件 / 查找 / 表达式 / 多文档 / 编辑导出 / 隐私」分段 |
| Category | `category` | **Developer Tools**（JSON 查看器的落点） |
| Language | `locales` 的键 | `en` 为默认，`zh` 走 zh-CN listing |
| Store icon | 无（随包） | 128×128 由 `manifest.icons.128` 提供 |
| Screenshots | 生成物 | `.spike/store/screens/shot-0*.png`（1280×800，全出血）；说明文字取 `screenshotCaptions` |
| Small promo tile | 生成物 | `.spike/store/screens/promo-440x280.png`（必填） |
| Marquee | 暂不提供 | 1400×560 可选，非必填 |

## 二、Privacy practices 页

| 字段 | 取 `listing.json` 的 | 口径 |
|---|---|---|
| Single purpose | `locales.<lang>.singlePurpose` | 一句话说清「本地打开/浏览/搜索/过滤 JSON，并导出或复制其一部分」 |
| `storage` justification | `permissions.storage` | 只存界面偏好，不存文档 |
| `contextMenus` justification | `permissions.contextMenus` | 一个针对选中文本的右键子菜单；不读页面、无 host 权限 |
| Remote code | `remoteCode` | **No** —— 包内无远程脚本、无网络请求 |
| Data usage | `dataUsage.collects` / `.disclosure` / `.limitedUse` | 不收集、不传输；勾选「不出售 / 不转交 / 不用于无关用途 / 不用于信用评估」 |
| Privacy policy URL | 固定 | `https://dtdths.github.io/turbo-json-viewer/privacy/`（源码 `docs/privacy/index.html`） |

> 注意（调研 §8/§9）：**本地处理也算「处理用户数据」**，所以不勾「不处理任何用户数据」，
> 而是如实写「仅本地处理、不收集、不上传」，并给出隐私政策 URL。

## 三、Test instructions

取 `testInstructions`（英文版），包含两条对审核特别重要的信息：

1. 五步走完的路径：打开 → 粘贴/拖放 → 搜索 → 表达式 → 右键菜单。
2. **包里唯一的 `eval` 是内部 RPC 方法名（`core.eval`），不是全局 `eval`**，且没有任何动态代码执行。

## 四、文案纪律

- 摘要 ≤132 字符、名称 ≤75 字符 —— 提交前 wizard 的预检会用 Node 数一遍，超了直接报错。
- 只描述**已实现**的能力：不要写「支持 JSON5」「支持 YAML」「自动抓取页面 JSON」（都不在 v1 范围）。
- 不承诺性能数字以外的东西；50 MB / 300 万节点是有实测依据的（#15）。
- 中英文两套必须**同时**更新：`listing.json` 的 `locales.en` 与 `locales.zh` 是并列真相。
