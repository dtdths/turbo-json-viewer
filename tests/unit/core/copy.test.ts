import { describe, expect, it } from 'vitest';
import { copyNodeText, isCopyFormat, keyNameText, rawValueText } from '../../../src/core/copy';
import { CoreError } from '../../../src/protocol/errors';

/** 断言纯函数抛指定错误码。 */
function errorOf(fn: () => unknown): CoreError {
  try {
    fn();
  } catch (err) {
    return err as CoreError;
  }
  throw new Error('expected the call to throw');
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength;

describe('core/copy — 子树 JSON', () => {
  it('对象按 2 空格缩进（与 exportDoc 默认一致）', () => {
    const { text, bytes } = copyNodeText({
      format: 'subtree',
      path: '$.a',
      value: { 'b.c': 'x', n: 1 },
    });
    expect(text).toBe('{\n  "b.c": "x",\n  "n": 1\n}');
    expect(bytes).toBe(bytesOf(text));
  });

  it('数组 / 标量 / null 根同样可序列化', () => {
    expect(copyNodeText({ format: 'subtree', path: '$.a', value: [1, 2] }).text).toBe('[\n  1,\n  2\n]');
    expect(copyNodeText({ format: 'subtree', path: '$.a', value: 'x' }).text).toBe('"x"');
    expect(copyNodeText({ format: 'subtree', path: '$.a', value: null }).text).toBe('null');
  });

  it('超过 maxBytes → TOO_LARGE（不截断，带 bytes）', () => {
    const err = errorOf(() =>
      copyNodeText({ format: 'subtree', path: '$.a', value: { big: 'x'.repeat(600) }, maxBytes: 100 }),
    );
    expect(err.code).toBe('TOO_LARGE');
    expect(err.bytes).toBeGreaterThan(100);
  });

  it('bytes 按 UTF-8 计（中文/emoji 不是字符数）', () => {
    const { text, bytes } = copyNodeText({ format: 'subtree', path: '$.a', value: { k: '中文🙂' } });
    expect(bytes).toBe(bytesOf(text));
    expect(bytes).toBeGreaterThan(text.length); // 8 个 BMP+ 字符 → 字节 > 字符
  });
});

describe('core/copy — 路径', () => {
  it('返回规范路径原文（含非标识符键 / 数组下标 / 根）', () => {
    for (const path of ['$', '$.a', "$['b.c']", "$['it\\'s']", '$.arr[3]']) {
      expect(copyNodeText({ format: 'path', path, value: null }).text).toBe(path);
    }
  });
});

describe('core/copy — 原始值（仅标量）', () => {
  it('字符串 → 内容本身：无引号、转义还原', () => {
    expect(rawValueText('x')).toBe('x');
    expect(rawValueText('a\nb\t"c"')).toBe('a\nb\t"c"'); // 真正的换行/引号，不是 \n / \"
    expect(rawValueText("it's")).toBe("it's");
    expect(rawValueText('中文🙂')).toBe('中文🙂');
  });

  it('数字 / 布尔 / null → JSON 字面量', () => {
    expect(rawValueText(10)).toBe('10');
    expect(rawValueText(1.5)).toBe('1.5');
    expect(rawValueText(-0)).toBe('0');
    expect(rawValueText(true)).toBe('true');
    expect(rawValueText(false)).toBe('false');
    expect(rawValueText(null)).toBe('null');
  });

  it('容器不适用 → BAD_COMMAND（不静默序列化）', () => {
    const objErr = errorOf(() => rawValueText({ a: 1 }));
    const arrErr = errorOf(() => rawValueText([1]));
    expect(objErr.code).toBe('BAD_COMMAND');
    expect(arrErr.code).toBe('BAD_COMMAND');
  });
});

describe('core/copy — 键名（仅非根）', () => {
  it('对象键 → 键名原样（不转义、不加引号）', () => {
    expect(keyNameText("$['b.c']")).toBe('b.c');
    expect(keyNameText("$['it\\'s']")).toBe("it's");
    expect(keyNameText('$.arr')).toBe('arr');
  });

  it('数组元素 → 下标数字（不含方括号）', () => {
    expect(keyNameText('$.arr[0]')).toBe('0');
    expect(keyNameText('$.arr[1234]')).toBe('1234');
  });

  it('根没有键名 → BAD_COMMAND', () => {
    expect(errorOf(() => keyNameText('$')).code).toBe('BAD_COMMAND');
  });
});

describe('core/copy — 命令级装配 copyNodeText', () => {
  it('四种 format 走同一入口；不适用格式 → BAD_COMMAND', () => {
    expect(copyNodeText({ format: 'value', path: '$.n', value: 1 }).text).toBe('1');
    expect(copyNodeText({ format: 'key', path: '$.n', value: 1 }).text).toBe('n');
    expect(copyNodeText({ format: 'path', path: '$.n', value: 1 }).text).toBe('$.n');
    expect(copyNodeText({ format: 'subtree', path: '$.n', value: 1 }).text).toBe('1');
    expect(errorOf(() => copyNodeText({ format: 'value', path: '$.o', value: {} })).code).toBe('BAD_COMMAND');
    expect(errorOf(() => copyNodeText({ format: 'key', path: '$', value: {} })).code).toBe('BAD_COMMAND');
  });

  it('回包带 format 与 bytes（主线程据此给 toast/守卫）', () => {
    const reply = copyNodeText({ format: 'path', path: "$['a b']", value: 1 });
    expect(reply).toMatchObject({ text: "$['a b']", bytes: bytesOf("$['a b']") });
  });

  it('isCopyFormat 只接受四值', () => {
    expect(['subtree', 'path', 'value', 'key'].every(isCopyFormat)).toBe(true);
    expect(isCopyFormat('compact')).toBe(false);
    expect(isCopyFormat('')).toBe(false);
  });
});
