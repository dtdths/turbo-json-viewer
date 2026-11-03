/**
 * viewmodel/export-state — 导出方式与剪贴板守卫（ADR-0012）。
 *
 * 纯策略模块（无 DOM）：模式枚举 / 校验回落 / 剪贴板大小守卫。
 * 「怎么执行」（下载 Blob、写剪贴板、toast）在 app 层；协议复用既有 `exportDoc`。
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

/** 设置面板「导出方式」行的文案（分体按钮菜单用更长的动作文案） */
export const EXPORT_MODE_LABELS: Record<ExportMode, string> = {
  file: '导出文件',
  clipboard: '复制到剪贴板',
};

export function isExportMode(value: unknown): value is ExportMode {
  return value === 'file' || value === 'clipboard';
}

/** 任意持久化值 → 合法方式（非法回落默认） */
export function normalizeExportMode(value: unknown): ExportMode {
  return isExportMode(value) ? value : DEFAULT_EXPORT_MODE;
}

/**
 * 剪贴板守卫：超限返回给用户看的中文提示，null = 可以复制。
 * 不做自动降级下载（避免用户不知道为什么多了一个文件）。
 */
export function clipboardRefusal(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= CLIPBOARD_MAX_BYTES) return null;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `文档较大（${mb} MB），请用「导出 JSON 文件」`;
}
