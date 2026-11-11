import { describe, expect, it } from 'vitest';
import {
  FIDELITY_MAX_HITS,
  FIDELITY_SNIPPET_MAX,
  scanFidelity,
  type FidelityScanOptions,
} from '../../../src/core/fidelity';
import type { FidelityHit, FidelityReport } from '../../../src/protocol/types';

/** 扫一遍并断言没被取消（取消用例单独写）。 */
async function scan(text: string, opts?: FidelityScanOptions): Promise<FidelityReport> {
  const report = await scanFidelity(text, opts);
  if (report === null) throw new Error('scan returned null (unexpected cancellation)');
  return report;
}

/** 按源顺序取命中摘要（断言「第 n 条是什么」比逐个字段好读）。 */
function digest(report: FidelityReport): Array<[kind: string, reason?: string]> {
  return report.hits.map((hit) => [hit.kind, hit.reason]);
}

/** 超展开位数上限的字面量（ADR-0020：> BIGINT_DIGIT_CAP → Infinity，报 overflow）。 */
const OVERFLOW_LITERAL = '1e10001';
/** 生成 150 条溢出命中的数组文档：验证默认 maxHits 截断 + counts 全量。 */
const MANY_HITS_TEXT = '[' + Array.from({ length: 150 }, () => OVERFLOW_LITERAL).join(',') + ']';

describe('scanFidelity — 无损数字后整数不再报失真（ADR-0020 §7）', () => {
  it('用户报告的 297532588187238660 / 1234567890123456789 → 0 条（整数由 parser 精确表示）', async () => {
    for (const literal of ['297532588187238660', '1234567890123456789', '-1234567890123456789', '9007199254740993', '1000000000000000000']) {
      const report = await scan(`{"a":${literal}}`);
      expect(report.status, `literal: ${literal}`).toBe('none');
      expect(report.counts).toMatchObject({ number: 0, overflow: 0, underflow: 0, keyOrder: 0, total: 0 });
      expect(report.hits).toEqual([]);
    }
  });

  it('15 位以内 / 带指数但精确的整数 → 0 条；1e400 现在也是精确 BigInt（不报上溢）', async () => {
    for (const literal of ['123456789012345', '1e3', '1000e0', '1000000000000000000e0', '1.5e2', '1e400', '1.5e400', '1234567890123456789e0']) {
      const report = await scan(`[${literal}]`);
      expect(report.status, `literal: ${literal}`).toBe('none');
    }
  });
});

describe('scanFidelity — 数字上溢 / 下溢（ADR-0020 §7）', () => {
  it('整数超展开位数上限 → overflow（parsed Infinity）；小数下溢 → underflow（parsed 0）', async () => {
    const text = `[${OVERFLOW_LITERAL},1e-400]`;
    const report = await scan(text);
    expect(report.counts).toMatchObject({ number: 2, overflow: 1, underflow: 1, keyOrder: 0, total: 2 });
    expect(digest(report)).toEqual([
      ['number', 'overflow'],
      ['number', 'underflow'],
    ]);
    expect(report.hits[0]).toMatchObject({
      kind: 'number',
      reason: 'overflow',
      offset: text.indexOf(OVERFLOW_LITERAL),
      literal: OVERFLOW_LITERAL,
      parsed: 'Infinity',
    });
    expect(report.hits[1]).toMatchObject({ reason: 'underflow', offset: text.indexOf('1e-400'), parsed: '0' });
  });

  it('超长纯整数（展开位数超 cap）→ overflow；恰好 10000 位仍无损（不报）', async () => {
    const huge = '1'.repeat(10_001);
    const report = await scan(`[${huge}]`);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({ kind: 'number', reason: 'overflow', parsed: 'Infinity' });
    // 1e9999 → 10000 位，等于上限：BigInt 精确，不报
    expect((await scan('[1e9999]')).status).toBe('none');
  });

  it('非整数小数上溢（401 位整数部分 + 小数）→ overflow', async () => {
    const literal = '1' + '0'.repeat(400) + '.5';
    const report = await scan(`[${literal}]`);
    expect(report.hits[0]).toMatchObject({ reason: 'overflow', parsed: 'Infinity' });
  });

  it('指数写法的正常形态不误报：1e-5 / 1E+3 / -0 / 0 / 0e400 / 1.5e10 / 1e308', async () => {
    for (const text of ['1e-5', '1E+3', '-0', '0', '0e400', '1.5e10', '1e308']) {
      const report = await scan(text);
      expect(report.status, `literal: ${text}`).toBe('none');
      expect(report.counts.total, `literal: ${text}`).toBe(0);
    }
  });
});

describe('scanFidelity — 高精度小数 v1 不报（ADR-0020 §8 已知差距）', () => {
  it('0.1234567890123456789 → 0 条（不做字符串往返比较）', async () => {
    expect((await scan('{"a":0.1234567890123456789}')).status).toBe('none');
    expect((await scan('-3.141592653589793238462643383279')).status).toBe('none');
  });
});

describe('scanFidelity — 字符串里的数字绝不误报', () => {
  it('字符串值 / 键名里的大数、指数文本都不算命中', async () => {
    for (const text of [
      '{"a":"1234567890123456789"}',
      '{"s":"1e400"}',
      '["1e-400","9007199254740993","1e10001"]',
      '{"1234567890123456789":"x"}', // 键名是长数字串，值正常 → 数字判定不介入
    ]) {
      const report = await scan(text);
      expect(report.status, `text: ${text}`).toBe('none');
    }
  });

  it('字符串转义（\\" / \\\\ / \\uXXXX）不会打乱结构，字符串后的溢出数字仍命中', async () => {
    const text = `{"s":"a\\"b\\\\c\\u0031","n":${OVERFLOW_LITERAL}}`;
    const report = await scan(text);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({
      kind: 'number',
      offset: text.indexOf(OVERFLOW_LITERAL),
    });
  });
});

describe('scanFidelity — 整数样式键重排（key-order）', () => {
  it('非下标键之后又出现下标键 → 1 条 key-order（offset = 对象 `{`）', async () => {
    const text = '{"2":1,"b":2,"1":3}';
    const report = await scan(text);
    expect(report.status).toBe('found');
    expect(report.counts).toMatchObject({ number: 0, keyOrder: 1, total: 1 });
    expect(report.hits[0]?.kind).toBe('key-order');
    expect(report.hits[0]?.offset).toBe(0);
    expect(report.hits[0]?.reason).toBeUndefined();
    expect(report.hits[0]?.snippet.length).toBeLessThanOrEqual(FIDELITY_SNIPPET_MAX);
  });

  it('下标键全部在前且升序 → 无损，不报', async () => {
    expect((await scan('{"1":1,"2":2,"b":3}')).status).toBe('none');
    expect((await scan('{"0":1,"1":2,"3":4,"b":5}')).status).toBe('none');
  });

  it('不同下标键降序（"1","0"）→ 1 条', async () => {
    expect((await scan('{"1":1,"0":2}')).counts.keyOrder).toBe(1);
  });

  it('重复的下标键不算键序损失（重复键吞并属另一类）', async () => {
    expect((await scan('{"1":1,"1":2}')).counts.keyOrder).toBe(0);
    expect((await scan('{"0":1,"0":2,"1":3}')).counts.keyOrder).toBe(0);
    // `1,2,1` 的枚举顺序仍是 `1,2`（后者覆盖前者），键序未变 → 不能报
    expect((await scan('{"1":1,"2":2,"1":3}')).counts.keyOrder).toBe(0);
    // 但「重复键 + 真降序」仍要报：1,3,2
    expect((await scan('{"1":1,"3":2,"2":3}')).counts.keyOrder).toBe(1);
  });

  it('非下标键在前、下标键倒序（"10","9"）→ 1 条', async () => {
    const report = await scan('{"b":1,"10":2,"9":3}');
    expect(report.counts).toMatchObject({ number: 0, keyOrder: 1, total: 1 });
  });

  it('键按 JSON 转义解码后判定：{"\\u0031":1,"0":2} → "1","0" 不升序 → 1 条', async () => {
    const report = await scan('{"\\u0031":1,"0":2}');
    expect(report.counts.keyOrder).toBe(1);
    // 无损反例：转义后的 "0","1" 升序
    expect((await scan('{"\\u0030":1,"1":2}')).status).toBe('none');
  });

  it('纯字符串键不做键序判定（键序保持不依赖数字形状）', async () => {
    expect((await scan('{"b":1,"a":2}')).status).toBe('none');
    expect((await scan('{"z":1,"y":2,"x":3}')).status).toBe('none');
  });

  it('同一对象最多 1 条（多个违规方向也只报一条）；嵌套对象各自独立', async () => {
    const one = await scan('{"b":1,"2":2,"1":3,"c":4,"0":5}');
    expect(one.counts.keyOrder).toBe(1);

    const nested = await scan('{"a":{"2":1,"1":2},"b":{"1":1,"2":2}}');
    expect(nested.counts.keyOrder).toBe(1);
    expect(nested.hits[0]?.offset).toBe('{"a":'.length); // 内层 `{` 的位置
  });

  it('数组下标上界：4294967295 不是下标键（与 JS 语义一致）', async () => {
    // 4294967295 作非下标键出现在前，"0" 作下标键跟在后面 → 被 JS 重排 → 报
    expect((await scan('{"4294967295":1,"0":2}')).counts.keyOrder).toBe(1);
    // 4294967294 仍是下标键，且升序 → 无损
    expect((await scan('{"4294967294":1,"b":2}')).status).toBe('none');
  });

  it('前导零 / 超长整数串不是规范整数键（按字符串键处理）', async () => {
    // "01" 不是下标键（非规范整数串），但后面的 "0" 是 → JS 会把 "0" 提到前面
    expect((await scan('{"01":1,"0":2}')).counts.keyOrder).toBe(1);
    expect((await scan('{"99999999999":1,"0":2}')).counts.keyOrder).toBe(1);
  });
});

describe('scanFidelity — counts 按类别拆分（精确数量不能被类别污染）', () => {
  it('overflow / underflow 分别计数，number 为两者之和（precision 已退场）', async () => {
    const report = await scan(`[1e10001,1e-400,1e10002,1e-401]`);
    expect(report.counts).toMatchObject({
      number: 4,
      overflow: 2,
      underflow: 2,
      keyOrder: 0,
      total: 4,
    });
  });
});

describe('scanFidelity — 截断保留的是「源顺序最靠前」', () => {
  it('键序命中（对象 `{` 靠前、关闭靠后）不会被后发现的数字挤掉', async () => {
    // 对象 `{` 在 offset 6；其中溢出数字 offset 更晚但先被扫到 → maxHits=1 时必须保留键序命中
    const text = `{"ob":{"2":0,"b":1,"1":2,"big":${OVERFLOW_LITERAL}}}`;
    const report = await scan(text, { maxHits: 1 });
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]?.kind).toBe('key-order');
    expect(report.hits[0]?.offset).toBe(6);
    expect(report.counts.total).toBe(2);
    expect(report.truncated).toBe(true);
  });
});

describe('scanFidelity — 混合文档 / 截断 / 顺序', () => {
  const text = `{"2":1,"b":2,"1":3,"n":${OVERFLOW_LITERAL},"e":1e-400}`;

  it('命中按源文本顺序、counts 分类正确', async () => {
    const report = await scan(text);
    expect(report.counts).toMatchObject({ number: 2, overflow: 1, underflow: 1, keyOrder: 1, total: 3 });
    expect(digest(report)).toEqual([
      ['key-order', undefined],
      ['number', 'overflow'],
      ['number', 'underflow'],
    ]);
    const offsets = report.hits.map((hit) => hit.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets[0]).toBe(0); // 键序命中 = 对象 `{`
  });

  it('maxHits 截断 hits 但 counts 保持全量；truncated 标明', async () => {
    const report = await scan(text, { maxHits: 2 });
    expect(report.hits).toHaveLength(2);
    expect(report.truncated).toBe(true);
    expect(report.counts.total).toBe(3); // 不受 maxHits 限制
    expect(report.counts.number).toBe(2);
    expect(report.counts.keyOrder).toBe(1);
  });

  it('默认 maxHits = FIDELITY_MAX_HITS(100)：150 条命中只留前 100 条', async () => {
    const report = await scan(MANY_HITS_TEXT);
    expect(FIDELITY_MAX_HITS).toBe(100);
    expect(report.counts.total).toBe(150);
    expect(report.hits).toHaveLength(FIDELITY_MAX_HITS);
    expect(report.truncated).toBe(true);
    // 保留的是前 100 条（源顺序）
    expect(report.hits[0]?.offset).toBe(MANY_HITS_TEXT.indexOf(OVERFLOW_LITERAL));
  });

  it('maxHits: 0 → 不保留片段、counts 仍全量', async () => {
    const report = await scan(MANY_HITS_TEXT, { maxHits: 0 });
    expect(report.hits).toEqual([]);
    expect(report.truncated).toBe(true);
    expect(report.counts.total).toBe(150);
  });

  it('snippet 一律 ≤ 48 字符（超长字面量截断为 47 字符 + …）', async () => {
    const longLiteral = '1'.repeat(10_001); // 超 cap → 命中
    const report = await scan(`[${longLiteral}]`);
    expect(report.hits).toHaveLength(1);
    const hit = report.hits[0] as FidelityHit;
    expect(hit.snippet.length).toBeLessThanOrEqual(FIDELITY_SNIPPET_MAX);
    expect(hit.snippet.length).toBe(FIDELITY_SNIPPET_MAX);
    expect(hit.snippet.endsWith('…')).toBe(true);
    expect(hit.literal?.length).toBeLessThanOrEqual(FIDELITY_SNIPPET_MAX);
  });
});

describe('scanFidelity — 取消 / 让出', () => {
  it('shouldCancel 在第 2 次让出后为 true → 返回 null（不抛错）', async () => {
    // 100 个溢出数字、yieldEvery=10 → 至少 10 次让出机会
    const text = '[' + Array.from({ length: 100 }, () => OVERFLOW_LITERAL).join(',') + ']';
    let yields = 0;
    const report = await scanFidelity(text, {
      yieldEvery: 10,
      onYield: async () => {
        yields += 1;
      },
      shouldCancel: () => yields >= 2,
    });
    expect(report).toBeNull();
    expect(yields).toBeGreaterThan(0);
    expect(yields).toBe(2);
  });

  it('onYield 被周期性调用（小块让出）；默认不让出时报出完整报告', async () => {
    let yields = 0;
    const report = await scan(MANY_HITS_TEXT, {
      yieldEvery: 64,
      onYield: async () => {
        yields += 1;
      },
    });
    expect(yields).toBeGreaterThan(0);
    expect(report.counts.total).toBe(150);
  });

  it('shouldCancel 一开始就 true → 直接 null', async () => {
    expect(await scanFidelity('{"a":1}', { shouldCancel: () => true })).toBeNull();
  });
});

describe('scanFidelity — 边界', () => {
  it('空文本 / 合法小文档 → status none、counts 全 0、scanMs 是数字', async () => {
    for (const text of ['', '   ', 'null', '{"a":1}', '[]', '{}']) {
      const report = await scan(text);
      expect(report.status, `text: ${JSON.stringify(text)}`).toBe('none');
      expect(report.counts).toMatchObject({ number: 0, overflow: 0, underflow: 0, keyOrder: 0, total: 0 });
      expect(report.hits).toEqual([]);
      expect(report.truncated).toBe(false);
      expect(typeof report.scanMs).toBe('number');
      expect(report.scanMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('非法 / 截断文本不抛错，仍尽力给命中（源文本可能是修复前的原文）', async () => {
    const report = await scan(`{"a":${OVERFLOW_LITERAL},"b":"hello wor`);
    expect(report.status).toBe('found');
    expect(report.counts.number).toBe(1);
    expect(report.truncated).toBe(false);
  });
});
