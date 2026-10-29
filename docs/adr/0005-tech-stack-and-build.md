# ADR-0005：原生 TS 无框架、esbuild 多入口、CM6 仅表达式框、UI 部件手写

- 状态：Accepted
- 日期：2026-10-27
- 依据：`docs/design/reassess-stack.md`；真机 CfT 156 + esbuild/vitest 实测。
- 相关票：#13（模块架构/构建）、#12（表达式输入）、#11（原始文本不引 CM6）

## 背景

#13 已定：原生 TS 无框架、自研固定行高行虚拟化、DOM 行渲染、esbuild + vitest、仅 storage 权限、_locales 中英；
#12 已定表达式编辑器用 CodeMirror 6（仅表达式输入框）；#11 已定原始文本视图不引 CM6。
本次用真实 Chrome 重新验证这套栈的性能、CSP 兼容性、体积与「无框架 UI 部件」的成本。

## 决策

1. **视图层 = 原生 TypeScript，无框架**（保持 #13）。理由：行虚拟化只需要「几十个行节点 + textContent 更新」，
   框架的 diff/组件树不带来收益；实测 40 行/帧渲染 0.03–0.09ms、0 掉帧。
2. **DOM 行渲染 = 行节点池 + `textContent` 复用**（1000 帧 31.2ms；innerHTML 86.2、createElement 74.1、cloneNode 67.2、fragment 76.0）。
   - 不用 `innerHTML` 拼串（即使转义也最慢，且引入唯一 XSS 面）；
   - 首次可用 DocumentFragment 批量挂载，滚动稳态切池复用；
   - 行高 `height` + `line-height` 双写 22–24px；缩进用 `padding-left`，不嵌套容器；`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`。
3. **UI 部件全部手写**：菜单 / toast / 模态 / 分栏 / 工具条 / 虚拟行键盘导航 / i18n = **354 行 / 3.11KB gz**；
   - 模态用原生 `<dialog>.showModal()`（top-layer + inert + Esc），**不引 focus-trap**；
   - 菜单用 20 行视口 clamp，**不引 @floating-ui/dom**；
   - 树用 `role=tree/treeitem` + `aria-activedescendant`（实测 0.1ms/键，虚拟行回收不丢焦点）；
   - 不引组件库。
4. **表达式输入 = CodeMirror 6**，最小包集合 `state + view + autocomplete (+commands)`：
   - MV3 扩展页 CSP 下可用：mount 7.1ms、输入 0.33ms/字符、补全 listbox/aria-activedescendant 正常、bundle 0 处 eval/new Function；
   - 体积 **99.4KB gz**（state 16.2 + view 49.1 + autocomplete 25.5 + commands 10.2）；
     `lang-javascript` 再 +45.0KB（142.8KB gz）——**高亮是否进 v1 作为产品取舍**；
   - 若体积预算 <80KB gz，降级为 textarea + 80 行自研补全（1.0KB gz）；当前首屏预算（≈138–182KB）允许保留 CM6。
5. **构建/测试 = esbuild 多入口 + vitest**：
   - 一份配置打 page + module worker + SW（67ms；watch 稳态 ~104ms）；开发期 `onEnd` 触发扩展 reload，不做 HMR；
   - vitest 只测纯函数（行窗口算术、tokenizer、路径/展开集合、acorn 白名单）；DOM/CSP/CM6/焦点用真机 harness 测；
   - **Vite + CRXJS 不引**（无框架/无 CSS 管线，HMR 绕不开 SW 重载；等样式迭代真的变慢再评估）。
6. **体积预算**：首屏不含 CM6 ≈37KB gz（acorn 33.7 + 自有 3.3）；含 CM6 最小集 ≈138KB gz；含 JS 高亮 ≈182KB gz。
   商店审核可读性：无混淆、保留可读模块结构，符合 MV3 代码可读性要求。

## 后果

- 没有框架状态/生命周期管理，需要自建一个很小的 store/render 约定（模块 seam 由 #13 落）。
- 手写部件意味着自己维护焦点/键盘/ARIA 细节；本次实测提供了可复制的实现与测试方法。
- CM6 体积是首屏最大单项（≈99KB gz），保留它是为输入体验（高亮/补全/undo/IME）；需在 #12 定「高亮是否值得 +45KB」。
- 未测：IME/中文组合、真实屏幕阅读器、移动端/触摸、DPR/缩放行高、CRXJS 现状（见重评估 §5）。

## 被否决的替代

| 方案 | 否决理由 |
|---|---|
| React/Svelte + react-virtual 类 | 行虚拟化只需几十个节点 + textContent；框架带来的 diff 与运行时体积无收益 |
| innerHTML 行渲染 | 最慢 + XSS 面 |
| focus-trap / floating-ui / 组件库 | 原生 dialog 与 20 行 clamp 已覆盖实测场景；省 6.3–6.7KB gz 与维护面 |
| Monaco 作为表达式输入 | 体积/初始化远大于 CM6；表达式框是单行短文本 |
| Vite + CRXJS | 无框架、多入口 esbuild 已 67ms；HMR 与 SW reload 复杂度抵消收益 |
