/**
 * view/doc-title — 文档标题的「原名追溯」文案（#29 / ADR-0021；i18n 在 #45 / ADR-0026 收口）。
 *
 * 从 `shared/doc-name` 拆出：`shared` 是零依赖层，**不 import i18n**（seams.md §1）；
 * 需要本地化文案的展示函数放 view 层，由 app / 其它 view 组件消费。
 */
import { t } from '../i18n/index';

/** 悬停提示：显示名与导入原名不同时，追加「原名」追溯；相同则原样返回。 */
export function displayTitle(name: string, originalName: string): string {
  return name === originalName ? name : t('view.doc-name.originalTitle', { name, originalName });
}
