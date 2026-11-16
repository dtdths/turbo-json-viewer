/**
 * view/export-labels — 导出方式的中文/英文标签（ADR-0012 修订；i18n 在 #45 / ADR-0026 收口）。
 *
 * 从 `viewmodel/export-state` 拆出：`viewmodel` 是零 DOM / 纯逻辑层，**不 import i18n**
 * （seams.md §1 依赖方向）；需要本地化文案的展示映射放 view 层，app 与设置面板共用。
 */
import { t } from '../i18n/index';
import type { ExportMode } from '../viewmodel/export-state';

/** 导出方式 → 文案（getter：每次读取按当前 locale 取词条，切语言后新渲染即新语言）。 */
export const EXPORT_MODE_LABELS: Record<ExportMode, string> = {
  get file(): string {
    return t('view.settings.exportMode.file');
  },
  get clipboard(): string {
    return t('view.settings.exportMode.clipboard');
  },
};
