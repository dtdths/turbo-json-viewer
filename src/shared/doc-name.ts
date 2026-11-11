/**
 * shared/doc-name — 文档显示名与导出文件名的唯一口径（#29 / ADR-0021）。
 *
 * 一个名字覆盖三处：标签条标题 / 文件 chip / 导出文件基名（`meta.name` 仍是导入时的
 * **原名**，只读保留，用于「原名」提示）。纯函数、零依赖，可脱 DOM 单测。
 *
 * 规则（用户 2026-11-12 拍板）：
 *   - 统一清洗：trim → 去控制字符 → 文件系统非法字符 `/ \ : * ? " < > |` 换成 `-` →
 *     去掉末尾 `.json` → 去末尾的点/空格 → 截到 `DOC_NAME_MAX` 个码点。
 *   - 导出名 = 清洗后的基名 + `-truncated-repaired` + `-edited` + `.json`（后缀顺序与旧
 *     `exportName` 逐字节一致，ADR-0004 §7 / ADR-0006 §2）。
 *   - 反向：从系统「另存为」返回的最终文件名里剥掉 `.json` 与「本次导出确实加过」的后缀，
 *     得到新的显示名；最终名与预填名相同 = 用户没改名，返回 null。
 */
export const DOC_NAME_MAX = 120;

const JSON_SUFFIX = /\.json$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|]/g;
const TRAILING_DOTS = /\.+$/;

const EDITED_SUFFIX = '-edited';
const REPAIRED_SUFFIX = '-truncated-repaired';

export interface ExportNameFlags {
  /** 有未导出的临时修改（`-edited`） */
  edited?: boolean;
  /** 源文本被截断修复过（`-truncated-repaired`） */
  repaired?: boolean;
}

/** 码点安全的截断（避免砍掉代理对）。 */
function capCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/**
 * 清洗用户输入的文档名：清洗后可能为空字符串（调用方决定「空 = 保持原名」还是禁用确认）。
 * 幂等，且对已是合法基名的输入原样返回（`sample` → `sample`）。
 */
export function sanitizeDocName(input: string): string {
  let name = input.trim();
  name = name.replace(CONTROL_CHARS, '');
  name = name.replace(ILLEGAL_FILE_CHARS, '-');
  name = name.replace(JSON_SUFFIX, '');
  name = name.replace(TRAILING_DOTS, '');
  return capCodePoints(name, DOC_NAME_MAX);
}

/** 导出文件名：基名 + 修复后缀 + 编辑后缀 + `.json`（旧 `exportName` 的逐字节等价迁移）。 */
export function exportFileName(base: string, flags: ExportNameFlags = {}): string {
  const suffix = `${flags.repaired ? REPAIRED_SUFFIX : ''}${flags.edited ? EDITED_SUFFIX : ''}`;
  // 基名清洗后为空时用导入兜底名（import.ts 的 untitled.json）的基名，保证导出名合法
  const clean = sanitizeDocName(base) || 'untitled';
  // 总长（含后缀与扩展名）不超过 DOC_NAME_MAX：给后缀与 `.json` 留出空间后再截基名
  const room = Math.max(1, DOC_NAME_MAX - suffix.length - '.json'.length);
  const capped = capCodePoints(clean, room).replace(TRAILING_DOTS, '') || 'untitled';
  return `${capped}${suffix}.json`;
}

/**
 * 从导出文件名反推显示名：剥 `.json`（大小写不敏感）→ 按 flags 剥「本次确实加过」的后缀。
 * flags 为 false 的后缀**不剥**（用户自己的名字里带 `-edited` 时不被误吃）。
 */
export function baseNameFromExport(fileName: string, flags: ExportNameFlags = {}): string {
  let stem = fileName.trim().replace(JSON_SUFFIX, '');
  if (flags.edited && stem.endsWith(EDITED_SUFFIX)) {
    stem = stem.slice(0, -EDITED_SUFFIX.length);
  }
  if (flags.repaired && stem.endsWith(REPAIRED_SUFFIX)) {
    stem = stem.slice(0, -REPAIRED_SUFFIX.length);
  }
  return sanitizeDocName(stem);
}

/** 悬停提示：改过名的文档追加「原名：…」便于追溯（原名 = 导入时的文件名，只读）。 */
export function displayTitle(name: string, originalName: string): string {
  return name === originalName ? name : `${name}（原名：${originalName}）`;
}

/**
 * 系统「另存为」保存成功后，从最终文件名反推要写回标签的新显示名。
 * 最终名与预填名相同（用户没改名）→ null（不动标签）；清洗后为空 → null。
 */
export function renameFromExport(
  finalName: string,
  prefillName: string,
  flags: ExportNameFlags = {},
): string | null {
  if (finalName === prefillName) return null;
  const base = baseNameFromExport(finalName, flags);
  return base === '' ? null : base;
}
