/**
 * viewmodel/export-state — 导出方式与剪贴板守卫（ADR-0012）。
 *
 * 纯策略模块（无 DOM）：模式枚举 / 校验回落 / 剪贴板大小守卫。
 * 「怎么执行」（下载 Blob、写剪贴板、toast）在 app 层；协议复用既有 `exportDoc`。
 *
 * 文案（`EXPORT_MODE_LABELS`）在 `view/export-labels`：viewmodel 层不 import i18n（seams.md §1）。
 */

/** 导出方式：file = 下载 JSON 文件；clipboard = 复制 JSON 到剪贴板 */
export type ExportMode = 'file' | 'clipboard';

export const EXPORT_MODES: readonly ExportMode[] = ['file', 'clipboard'];

/** 默认方式：文件导出（保持旧行为） */
export const DEFAULT_EXPORT_MODE: ExportMode = 'file';

/**
 * 复制到剪贴板的文档上限（ADR-0012 §4）。
 * 整份文本要 postMessage 回主线程再写剪贴板，成本高于下载；超限不复制、引导用文件导出。
 */
export const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;

export function isExportMode(value: unknown): value is ExportMode {
  return value === 'file' || value === 'clipboard';
}

/** 任意持久化值 → 合法方式（非法回落默认） */
export function normalizeExportMode(value: unknown): ExportMode {
  return isExportMode(value) ? value : DEFAULT_EXPORT_MODE;
}

/**
 * 剪贴板守卫：超限返回**超限字节数**（供 app 用当前 locale 生成提示），null = 可以复制。
 * 只做判定不改文案（viewmodel 层不 import i18n，seams.md §1）；
 * 不做自动降级下载（避免用户不知道为什么多了一个文件）。
 */
export function clipboardRefusal(bytes: number): number | null {
  if (!Number.isFinite(bytes) || bytes <= CLIPBOARD_MAX_BYTES) return null;
  return bytes;
}
