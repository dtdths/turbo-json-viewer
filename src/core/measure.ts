/**
 * core/measure — 子树 JSON 体积的**字符数下界**预扫描（分配无关）。
 *
 * 为什么需要它：`getNodeJson` 的旧判据是「先 `JSON.stringify(value,null,2)` 整棵子树，
 * 再按 UTF-8 字节数判 5MB」——超大子树会先在 Worker 内付出完整 stringify + 巨型字符串分配，
 * 然后才被拒绝（README §11 已知差距 / 编辑 spec §7 的「大子树 5MB 预检」）。
 * 这里提供一条**只遍历值图、不拼字符串**的下界计算，让超预算子树在分配前就被拒。
 *
 * 下界论证（为什么可以据此拒绝，且**零误拒**）：
 *   1. `JSON.stringify(value, null, 2)` 的输出形态是确定的：标量就是字面量；空容器 `{}` / `[]`；
 *      非空容器 = 开括号 + 每成员一行（`,\n` 分隔、按深度缩进）+ 闭行 + 闭括号。
 *      本模块对每个标量/结构按**最少字符数**累加：字符串取原文 UTF-16 码元数 + 2 个引号
 *      （转义只会让序列化更长，例如 `"` → `\"`、控制字符 → `\u00XX`），数字/布尔/null 至少 1，
 *      键取原文长度 + 2 引号 + 1 冒号，容器取括号 + 逗号 + 换行 + 缩进。
 *   2. 对任意 JSON 值 v，`jsonSizeLowerBoundChars(v) <= JSON.stringify(v,null,2).length`（UTF-16 码元数）。
 *   3. 又因为任何 UTF-16 码元在 UTF-8 下编码为 **≥1 字节**（BMP 非 ASCII ≥2，代理对 2 码元 → 4 字节），
 *      所以 `字符串长度 <= UTF-8 字节数`。
 *   4. 于是 `下界 <= 真实 UTF-8 字节数`：**下界已超预算 ⇒ 真实字节必然超预算**，不存在误拒；
 *      反之「下界没超」只说明有可能达标，仍需精确判据兜底（见 `DocService.getNodeJson`）。
 *
 * 实现约束：
 *   - **显式栈迭代**（不递归）：2000 层深嵌套也不会爆调用栈；
 *   - 栈里只放**待展开的容器**（标量在父级直接累加），因此栈深 ≈ 嵌套深度，与节点数无关；
 *   - 累加一旦超过 `limit` **立即早停返回**（返回值此时 > limit，但不保证等于完整下界——只用于「已超预算」判定）。
 */

/** 栈帧：待展开的容器 + 它作为成员出现时的缩进深度（根 = 0）。 */
interface PendingContainer {
  value: unknown;
  /** 缩进深度：根值 0；根容器的成员 1，依此类推 */
  depth: number;
}

/** 值是否为需要展开的容器（null 是标量，JSON 字面量 "null"）。 */
function isContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * 标量的下界（字符数）：不拼串、不算转义，只取最少可能的字符数。
 * 入参只应来自值图（ADR-0020：JSON 值域，数字载体 `number | bigint`）。
 */
function scalarLowerBound(value: unknown): number {
  switch (typeof value) {
    case 'string':
      // 引号 2 + 原文 UTF-16 码元数；JSON.stringify 的转义只会更长（含 emoji / 代理对不缩短）
      return value.length + 2;
    case 'number':
      // "0" 1 个字符；“-0”/“1e+21”/“1.5” 等都 ≥1
      return 1;
    case 'bigint':
      // 无损数字（ADR-0020）：序列化输出就是十进制串本身（负号含在内）
      return value.toString().length;
    case 'boolean':
      return 1; // "true"(4) / "false"(5) 都 ≥1
    case 'object':
      return 4; // 仅 null 走这里：JSON 字面量 "null"
    default:
      // undefined / function / symbol 不在 JSON 值域内（兜底 1；调用方保证不会传入）
      return 1;
  }
}

/**
 * `value` 序列化为 `JSON.stringify(value, null, 2)` 后的**字符数下界**（UTF-16 码元）。
 *
 * 语义：
 *   - 返回值 ≤ 真实字符数 ≤ 真实 UTF-8 字节数（见文件头论证），可用于「必然超预算」判定；
 *   - 累加跨过 `limit` 立即早停，此时返回值 > `limit`，但**可能小于**完整下界
 *     （只是「已超预算」的证据，不要当成完整下界的精确值）；
 *   - `limit` 非有限值（如 `Infinity`）→ 不做早停，返回完整下界。
 *
 * @param value JSON 值（JSON.parse 产出的值图；不处理环引用 / toJSON / undefined 键）
 * @param limit 字符数预算（调用方传字节预算时，因下界 ≤ 字节数仍成立）
 */
export function jsonSizeLowerBoundChars(value: unknown, limit: number): number {
  const cap = Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY;
  let total = 0;
  const stack: PendingContainer[] = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const depth = frame.depth;
    const current = frame.value;

    if (!isContainer(current)) {
      total += scalarLowerBound(current);
      if (total > cap) return total;
      continue;
    }

    if (Array.isArray(current)) {
      const n = current.length;
      // 开/闭括号 2 个字符；空数组就恰好是 "[]"。
      total += 2;
      if (n > 0) {
        // n-1 个逗号 + 闭行（1 换行 + 2*depth 缩进）+ n 个成员行（各 1 换行 + 2*(depth+1) 缩进）
        total += n - 1 + 1 + 2 * depth + n * (1 + 2 * (depth + 1));
        if (total > cap) return total;
        for (let i = 0; i < n; i++) {
          const item = current[i];
          if (isContainer(item)) {
            stack.push({ value: item, depth: depth + 1 });
          } else {
            total += scalarLowerBound(item);
            if (total > cap) return total;
          }
        }
      } else if (total > cap) {
        return total;
      }
      continue;
    }

    const keys = Object.keys(current);
    const n = keys.length;
    // 开/闭括号 2 个字符；空对象就恰好是 "{}"。
    total += 2;
    if (n > 0) {
      // 同上：逗号 + 闭行 + 成员行；对象成员每行还多 `"key": ` 的键成本。
      total += n - 1 + 1 + 2 * depth + n * (1 + 2 * (depth + 1));
      if (total > cap) return total;
      for (let i = 0; i < n; i++) {
        const key = keys[i];
        // 键："key" 的 2 引号 + 原文长度 + 冒号 1（JSON.stringify 的 ": " 多 1 空格，不计入下界）
        total += key.length + 2 + 1;
        if (total > cap) return total;
        const child = (current as Record<string, unknown>)[key];
        if (isContainer(child)) {
          stack.push({ value: child, depth: depth + 1 });
        } else {
          total += scalarLowerBound(child);
          if (total > cap) return total;
        }
      }
    } else if (total > cap) {
      return total;
    }
  }

  return total;
}
