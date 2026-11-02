/**
 * core/copy — 复制四格式的文本生成（ADR-0010）。
 *
 * 为什么四个格式都在 core 侧生成：
 *   - 主线程看不到值图（行窗口只给单行 preview，ADR-0001/0002），子树 JSON / 原始值只能由 Worker 生成；
 *   - 路径 / 键名必须与 `shared/path` 的规范路径同源，否则复制出来的路径不能回填 UI。
 * 因此这是纯函数模块，`DocService.copyNode` 只做「取根 → valueAt → 调这里」。
 *
 * 只读语义：复制不推进 docRevision / rowVersion，不触发搜索 stale。
 */
import { CoreError } from '../protocol/errors';
import type { CopyFormat, Path } from '../protocol/types';
import { COPY_INDENT, COPY_MAX_BYTES } from '../protocol/versions';
import { byteLengthOf } from './import';
import { lastSegment } from '../shared/path';

/** 四种格式的固定枚举顺序（UI 菜单顺序同此，见 ADR-0010 §1）。 */
export const COPY_FORMATS: readonly CopyFormat[] = ['subtree', 'path', 'value', 'key'];

export function isCopyFormat(value: string): value is CopyFormat {
  return value === 'subtree' || value === 'path' || value === 'value' || value === 'key';
}

/**
 * 标量的「文本值」：字符串 = 内容本身（无引号、转义还原）；数字/布尔/null = JSON 字面量。
 * 容器不适用（容器没有原始值）→ BAD_COMMAND，由 UI 禁用保证不会触发。
 */
export function rawValueText(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    throw new CoreError({
      code: 'BAD_COMMAND',
      message: 'container has no raw value; copy subtree JSON instead',
    });
  }
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      // JSON.parse 不会产生 NaN/Infinity；String(-0) = "0" 与 JSON 口径一致
      return JSON.stringify(value) ?? 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      // null（以及 JSON.parse 不可能产出的 undefined/function/symbol 兜底）
      return 'null';
  }
}

/** 键名：对象键原样；数组元素为下标数字（不含方括号）；根没有键名 → BAD_COMMAND。 */
export function keyNameText(path: Path): string {
  const seg = lastSegment(path);
  if (!seg) {
    throw new CoreError({ code: 'BAD_COMMAND', message: 'root has no key name' });
  }
  return seg.kind === 'key' ? seg.key : String(seg.index);
}

export interface CopyTextArgs {
  format: CopyFormat;
  path: Path;
  value: unknown;
  /** 子树 JSON 的字节上限；默认 COPY_MAX_BYTES（测试用较小值） */
  maxBytes?: number;
}

export interface CopyTextResult {
  text: string;
  /** UTF-8 字节数（回包给主线程做提示/守卫，不在 UI 层重复计算） */
  bytes: number;
}

/** 复制文本的唯一入口（四种格式共用；不适用格式与超限都在这里抛 CoreError）。 */
export function copyNodeText(args: CopyTextArgs): CopyTextResult {
  const { format, path, value } = args;
  let text: string;
  switch (format) {
    case 'subtree': {
      // 先 stringify 再判上限（与 getNodeJson 同口径；超大子树会先付出 stringify 成本，已知差距）
      text = JSON.stringify(value, null, COPY_INDENT) ?? 'null';
      const bytes = byteLengthOf(text);
      const max = args.maxBytes ?? COPY_MAX_BYTES;
      if (bytes > max) {
        throw new CoreError({
          code: 'TOO_LARGE',
          message: `node JSON is ${bytes} bytes (> ${max}); use Export instead`,
          bytes,
        });
      }
      return { text, bytes };
    }
    case 'path':
      return { text: path, bytes: byteLengthOf(path) };
    case 'value':
      text = rawValueText(value);
      return { text, bytes: byteLengthOf(text) };
    case 'key':
      text = keyNameText(path);
      return { text, bytes: byteLengthOf(text) };
    default:
      throw new CoreError({ code: 'BAD_COMMAND', message: `unknown copy format: ${String(format)}` });
  }
}
