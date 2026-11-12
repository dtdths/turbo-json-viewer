# ADR-0022：导出/复制的 JSON 格式化配置（JSON 缩进 + 非 ASCII 转义；不做尾随逗号）

- 状态：**Accepted（设计定稿 2026-11-12；实现完成 2026-11-12，见 #38 验收）**
- 日期：2026-11-12
- 依据：`#34`（#11 收口残余项：导出/查看的格式化配置）；2026-11-12 grill 拍板（Q1–Q9，全部按推荐）
- 相关：#34（设计票）、#38（实现票，2026-11-12 已实现）、ADR-0011（设置与持久化）、ADR-0012 §2（复制与导出同一份文本）、ADR-0020（无损序列化）、ADR-0003（原文视图三模式 / 保真口径）、ADR-0021（导出文件名）
- 术语：`CONTEXT.md`（设置 / 导入·导出 / 临时修改）

## 背景

- 现状（2026-11-12 实测）：文件导出与「复制 JSON 到剪贴板」都**硬编码缩进 2**（`core.exportDoc(rootId, 2)`）；`serializeLossless(value, indent?)` 只有缩进参数，**没有** compact / 尾随逗号 / 非 ASCII 转义选项。
- 设置面板已有 11 项，其中「复制缩进 0/2/4」只管**子树复制**（`copyNode.indent`），与导出缩进各管各的。
- 编辑弹层回填固定 pretty(2)（`getNodeJson`），树视图无格式概念，原文视图三模式（source/pretty/plain）是保真证据（ADR-0003）。
- 文件导出刚改为系统「另存为」（ADR-0021）——原生对话框**放不下**每次导出的额外格式选项。
- #34 待拍板：`pretty⇄compact`、尾随逗号、unicode 转义；作用域（导出 / 复制 / 编辑回填）与预算。

## 决策

### 1. 作用面：文件导出 + 「复制 JSON 到剪贴板」

- 格式化配置同时作用于**文件导出**与**复制整份 JSON**——两者按 ADR-0012 §2 承诺「逐字同一份文本」，拆开会造成导出与复制不一致。
- **不作用于**：树视图（无格式概念）、原文视图（source/pretty/plain 是保真证据，ADR-0003）、**编辑弹层回填**（固定 pretty 2，可读性优先）、**子树/行尾复制**（沿用 JSON 缩进设置，见 §3）。
- 剪贴板 20MB 守卫、`exportMode` 持久化、复制文本来源（`core.exportDoc` 同一份）均不变。

### 2. v1 配置项：JSON 缩进（紧凑 0 / 2 / 4）+ 非 ASCII 转义（默认关）

| 设置项 | 取值 | 默认 | 语义 |
|---|---|---|---|
| JSON 缩进 | 紧凑（0）/ 2 / 4 | 2 | `0` = 无缩进/无换行，输出与 `JSON.stringify(v)` **逐字节等价**（`gapOf` 对 `indent<=0` 返回空串）；`2/4` = pretty，与 `JSON.stringify(v, null, 2/4)` 逐字节等价 |
| 导出转义非 ASCII | 开 / 关 | 关 | 开启时字符串里非 ASCII 字符输出为 `\uXXXX`（emoji 等非 BMP 按 **UTF-16 代理对**两个转义）；输出仍是**合法 JSON**、值不变、BigInt 仍为裸十进制 |

- **「紧凑」与「紧凑 0」是同一件事**：`serializeLossless` 的 `indent 0` 即 compact；UI 文案统一写「紧凑 / 2 空格 / 4 空格」，不再出现第二个词。
- 转义只影响**文本表示**（字符串值与对象键同一规则），不改变值图、不影响无损数字（ADR-0020，BigInt 仍裸十进制）、不影响解析后的显示。树行预览走另一份 `JSON.stringify`（`row-model.scalarPreview`），**不随转义开关变化**——查看侧保持「看到的即真实字符」。

### 3. 合并「复制缩进」为「JSON 缩进」

- 把现有设置项 `copyIndent`（0/2/4）升级为 `jsonIndent`（紧凑/2/4），**导出 + 整份复制 + 子树复制共用同一值**；编辑回填仍固定 2。
- 设置面板从 **11 行 → 12 行**：原「复制缩进」行改为「JSON 缩进」，末尾新增「导出转义非 ASCII」勾选行。实现时顺手把 `view/panels/settings-panel.ts` 里过时的「10 行/10 项」注释同步（现状注释与实际 11 行已不一致）。
- **兼容**：旧存储值读 `jsonIndent ?? copyIndent`（迁移不丢用户设置）；只写新键；缺键回落默认（ADR-0011 既有做法）。
- 不新增存储键（仍 `tjv.settings.v1`），不新增权限。

### 4. 尾随逗号：不做

- 尾随逗号会产出**非标准 JSON**，破坏「导出永远能被标准 JSON 解析器读取」的对外承诺（ADR-0004/0012 的导出语义、用户把导出喂给别的工具的主场景）。
- 导入容错（尾逗号 / JSON5 子集）属 **#20 宽松解析**，与本票不混。
- 如果未来出现具体下游工具要求，再单独拍板（可做成独立「JSONC 导出」动作，不影响标准导出）。

### 5. 输出契约（不可回退）

- 默认档（缩进 2、不转义）继续与 `JSON.stringify(value, null, 2)` **逐字节一致**（无 BigInt 时；ADR-0020 既有测试 `lossless-json.test.ts:234` 钉住 0/2/4/undefined）。
- 紧凑档与 `JSON.stringify(value)` 逐字节一致；pretty 档同 `JSON.stringify(value, null, indent)`。
- 转义档：输出仍是合法 JSON；转义规则 = 控制字符照旧（`\n`/`\t`/`\u00XX`）+ 非 ASCII → `\uXXXX`；`parseLossless` 读回值不变（可加往返测试）。
- BigInt 仍是裸十进制数字，**不受转义影响**；孤立代理项行为沿用 `JSON.stringify` 口径。

### 6. 入口与持久化

- **全局设置项**（设置面板，持久化 `tjv.settings.v1`）；导出时不询问——系统「另存为」框放不下额外选项。
- 导出菜单的「紧凑导出」等**每次临时选择**入口留作后续可选（不影响本轮设计；若以后常用再加一项菜单，不改变默认）。
- 不把格式配置塞进导出确认框 / 文件名逻辑（ADR-0021 的口径不变：文件名后缀与格式配置互相独立）。

### 7. 分层与协议

- 序列化选项在 **Worker 内**（`core/lossless-json.ts` + `DocService.exportDoc`/`copyNode`），主线程不持有值图。
- 序列化器签名扩展为 `serializeLossless(value, indent?, opts?: { escapeUnicode?: boolean })`（默认 `false`，保持既有逐字节等价）；**只有 `DocService.exportDoc` 透传 `escapeUnicode`**；`copyNode`（子树复制）、`getNodeJson`（编辑回填）、表达式内 `JSON.stringify()`（紧凑、结果值）一律不传，保持现状。
- `protocol` 的 `exportDoc` 命令/`CoreApi.exportDoc` 增加**可选** `escapeUnicode?: boolean` 与既有 `indent?: number`；`copyNode` 沿用 `indent`（子树复制，`core/copy.ts` 现有 [0,8] 守卫与 `COPY_INDENT` 回落不变）。
- 导出缩进与复制缩进的取值守卫口径不同（copy 夹 [0,8]、export 只在 serializer 内夹 [0,10]）；本票统一走「设置白名单 0/2/4」，不再新增歧义，实现时在 ADR 验收里记录是否顺手统一。
- 纯格式化逻辑（缩进/转义选项归一、迁移回落）放 `core`（可单测）；设置字段与校验在 `viewmodel/settings-state`；设置行在 `view/settings-panel`；`app/main` 只接线（读设置 → 传参）。

### 8. 预算

- `page.js` 当前 **48.8KB gz（预算 50，余 1.2）**；新增 1 行 segmented + 1 行 checkbox + 接线估计 **+0.4~0.8KB**（约 49.2–49.6）。
- `worker.js` **63.3KB**（无硬预算，ADR-0020 §9 起记录）；序列化器改动预计 +0.1~0.3KB。
- 懒加载 145.6/146 不变。
- **纪律**：先实现并实测；若 `page.js` > 50，带实测数字向用户请示后再记账（不静默超）。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| 做尾随逗号（默认关或独立 JSONC 导出） | 破坏「导出即标准 JSON」承诺；无具体下游诉求前不引入非标准输出（#20 只管导入容错） |
| 每次导出时弹格式选择 | 系统「另存为」框无法加选项；再加一层自制弹层违背 ADR-0021 的「一个系统框搞定」取向 |
| 导出缩进与复制缩进分成两项设置 | 同一份文本两个口径 → 导出与复制不一致；概念只增不减 |
| 只改查看侧（原文视图重新格式化） | 与 source/pretty 现有模式重复；原文视图的价值是「源文本没坏」 |
| 非 ASCII 永远转义 | 破坏可读性；默认必须保持原样输出（逐字节等价 JSON.stringify） |
| 格式选项不持久化（每次默认） | 用户偏好稳定，频繁重选成本高；与设置体系一致更好 |
| 只作用于导出、不影响整份复制 | 违反 ADR-0012 §2「复制与导出逐字同一份文本」的承诺 |

## 验收（2026-11-12 实现实测，#38）

- **单测**：1003 → **1023**（38 文件全绿）。`lossless-json` 17 → 23（escape 档精确文本 / 代理对 / 控制字符短转义 / 合法 JSON + `parseLossless` 往返 / BigInt 不受影响 / 默认档仍逐字节等价）；`doc-service` 111 → 113（escape 透传 + compact/pretty 组合）；契约 +1（`exportDoc(rootId, indent, escapeUnicode)` 在 InProcess 与 Worker 双适配器透传）；`settings-state` 15 → 23（默认 / 三档白名单 / 旧键 `copyIndent` 迁移（新键优先）/ 写盘只含新键 / `escapeUnicode` 回落 / set 持久化）；`dev-hook` 13 → 15（`exportDocText` / `copyResolve` 读设置）。
- **冒烟**：15 套串行全绿（`smoke-search` / `smoke-extension-search` 首跑各有 1–2 条 50ms 长任务 / 耗时阈值抖动，重跑 101/101、56/56 全绿——与改动无关的既有性能阈值抖动）。`smoke-settings` **25 → 26/26**（第 12 行顺序 + `set:escape-unicode`（默认关 → 勾选开、label/checked 同步）+ 重启恢复 12 项）；`smoke-export` **27 → 34/34**（默认档 ≡ `JSON.stringify(v,null,2)` / 紧凑档 ≡ `JSON.stringify(v)` / 转义 4 空格精确文本 + 全 ASCII / 转义输出仍是合法 JSON 且值不变 / 整份复制跟随设置 / 文件导出跟随设置 / 收尾还原默认）；其余 13 套计数不变（`smoke-edit` 回填仍 pretty(2)、`smoke-copy` 默认档期望不变）。
- **体积**：`page.js` **48.8 → 48.9KB gz**（+0.1：设置面板一行 + 三处接线；预算 50 未动）、`worker.js` **63.3 → 63.5KB gz**（+0.2：序列化器 escape 选项与 `quoteString`；无硬预算，ADR-0020 §9 口径）、`page.css` **8.2 不变**、懒加载 **145.6（146）不变**。
- **截图**：`.spike/smoke/settings-panel.png`（深）/ `settings-applied.png`（亮），面板 12 行。
- **文档**：`CONTEXT.md` 设置 12 项 + 复制/导出语义、`docs/design/direction.md` 组件表、ADR-0011 / ADR-0012 §2 / ADR-0020 §11 指针改「已实现」、架构 README §11 新增 6.25 行与产物体积归因。

## 已知差距 / 本轮不做

- 尾随逗号、JSONC/JSON5 输出不做（见 §4）。
- 每次导出临时选格式（导出菜单快捷项）不做，留作后续可选。
- 非 ASCII 转义只有开/关，不做「仅转义控制字符 / 只转义 BMP 外」等细分。
- 编辑弹层回填恒 pretty(2)，不跟随 JSON 缩进设置（可读性优先）。
- 原文视图/树视图不提供格式配置（ADR-0003 口径）。
- 缩进档位仍限制在 0/2/4（不开放任意 0–10，避免设置面板复杂度与无意义取值）。
- 树行预览/查看侧的字符串转义不跟随「导出转义」开关（两份实现：`lossless-json` 序列化 vs `row-model.scalarPreview`）——查看侧保持真实字符是刻意口径。
- `docs/architecture/build-and-test.md` 的旧预算数字（page ≤45 / worker ≤50 等）与当前实测脱节的既有问题不在本票内，只记录。

## 决策来源（2026-11-12 会话，grill 两轮）

- Q1 作用面 = 文件导出 + 整份复制（编辑回填固定 pretty、视图不动）；Q2 开关 = 缩进档 + 非 ASCII 转义；Q3 尾随逗号 = 不做；Q4 转义 = 导出开关、默认关；Q5 合并「复制缩进」为「JSON 缩进」、编辑回填固定 2；Q6 入口 = 全局设置项；Q7 查看侧 = 不动；Q8 默认/兼容 = 缩进 2、标准 JSON、不转义、旧键回落；Q9 预算 = 先实测、超 50 再请示。
- 追加确认：**「compact」与「紧凑 0」是同一件事**（`gapOf(indent<=0)` → 空缩进，输出与 `JSON.stringify(v)` 逐字节等价），术语统一为「紧凑（缩进 0）」。
- 决策评论已记录在 #34（2026-11-12）。
