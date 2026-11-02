# Turbo JSON Viewer

本地只读 JSON 查看器（Chrome MV3）。文档常驻 Worker、主线程只取视口行窗口、固定行高虚拟化；搜索 / 表达式 / 临时子树编辑全部在本地完成，无网络请求。

## 开发

```bash
npm install
npm run build        # esbuild → dist/（page / worker / sw 三入口）
npm run watch        # 监听重建（改完在 chrome://extensions 点刷新）
npm run check        # typecheck + 单测 + build
npm run smoke        # 真机冒烟：导入 → 首帧 → 展开 → 滚动（headless CfT）
npm run smoke:ext    # 以真实 unpacked 扩展跑同一套冒烟
```

冒烟样本默认用 `.spike/samples/10mb.json`（`.spike/` 已 gitignore）；没有的话用 `.spike/gen-samples.js` 生成，或 `node scripts/smoke.mjs <任意样本路径>`。

## 在 Chrome 里加载

1. `npm run build`
2. `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/`
3. 点扩展图标打开查看页；初始页可拖入 / 选择文件 / 直接 `⌘V` 粘贴
4. 已打开文档后，页面上的 `⌘V` / 拖放**不会直接替换文档**：点「导入」或按 `⌘O` 打开**导入层**，在层内粘贴 / 拖放 / 选择文件替换（会提示将替换的文档；原文件不受影响）
5. **编辑**：双击节点 / 右键「编辑此节点 JSON」/ 选中后按 `F2` 打开子树 JSON 编辑器（CM6；`⌘↵` 应用、`Esc` 取消、上限 5MB）；Apply 只改当前会话内存，不写原文件
6. **撤销 / 重做 / 导出**：`⌘Z` / `⇧⌘Z`；点工具栏「已修改 N 处」徽标可重置全部；导出为 `原名-edited.json`（唯一落盘动作）

品牌版 Chrome（≥137）会忽略 `--load-extension`，自动化验证请用 Chrome for Testing（见 `prototype/p1/README.md`）。

## 目录

- `src/{app,view,viewmodel,core,protocol,shared}` — 分层与依赖方向见 `docs/architecture/README.md`
- `docs/adr/` — 架构决策（0001–0008）；`CONTEXT.md` — 领域词汇
- `prototype/` — 视觉方向（A/B/C）与性能 spike，不发布
- `scripts/smoke*.mjs` — 真机冒烟
- `tests/unit/` — vitest 纯逻辑测试

## 状态

slice 1–5 已可跑：导入 → Worker 解析 → 行窗口 → 树虚拟化 / 展开折叠 / 滚动；**搜索**（44px 两行虚拟结果列表 + 树命中/当前命中高亮 + 上下条 / Enter / ⌘G / F3 + `docRevision` 过期逻辑）；**全部展开 / 全部收起 + 小文档自适应**；**临时子树编辑 + 撤销/重做/重置 + 导出**（#16 / ADR-0006，CM6 懒加载 130.6KB gz）。10MB `hotel` 搜索 **91ms**、跳转 **2.7ms**；10MB 展开至 595,030 行 68ms；编辑 Apply <1ms。实现进度与实测数字见 `docs/architecture/README.md` §11。

红线：仅 `storage` 权限、无网络、禁 eval、文档不落盘、不改原文件。
