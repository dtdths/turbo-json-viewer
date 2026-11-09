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

/** 生成 150 个大整数（全真失真）的数组文档：验证默认 maxHits 截断 + counts 全量。 */
const MANY_HITS_TEXT = '[' + Array.from({ length: 150 }, () => '1234567890123456789').join(',') + ']';

describe('scanFidelity — 大整数精度流失（precision）', () => {
  it('19 位不可精确表示的整数 → 1 条 precision，offset/literal/parsed 正确', async () => {
    const text = '{"a":1234567890123456789}';
    const report = await scan(text);
    expect(report.status).toBe('found');
    expect(report.counts).toEqual({ number: 1, keyOrder: 0, total: 1 });
    expect(report.truncated).toBe(false);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({
      kind: 'number',
      reason: 'precision',
      offset: text.indexOf('1234567890123456789'),
      literal: '1234567890123456789',
      parsed: '1234567890123456800',
    });
  });

  it('19 位但可精确表示（2^18 的十进制幂）→ 0 条', async () => {
    const report = await scan('1000000000000000000');
    expect(report.status).toBe('none');
    expect(report.counts).toEqual({ number: 0, keyOrder: 0, total: 0 });
    expect(report.hits).toEqual([]);
    expect(report.truncated).toBe(false);
  });

  it('2^53+1（9007199254740993）→ 1 条 precision（parsed 回 2^53）', async () => {
    const report = await scan('9007199254740993');
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({
      kind: 'number',
      reason: 'precision',
      literal: '9007199254740993',
      parsed: '9007199254740992',
    });
  });

  it('负的大整数同样判定；15 位以内的整数不报（不做无意义精确判定）', async () => {
    const negative = await scan('-1234567890123456789');
    expect(negative.hits[0]).toMatchObject({ reason: 'precision', literal: '-1234567890123456789' });
    expect((await scan('123456789012345')).status).toBe('none'); // 15 位：候选之外
  });

  it('数字出现在数组 / 嵌套结构里也命中，offset 是源文本偏移', async () => {
    const text = '{"a":[1,{"b":9007199254740993}]}';
    const report = await scan(text);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]?.offset).toBe(text.indexOf('9007199254740993'));
  });
});

describe('scanFidelity — 上溢 / 下溢（带指数）', () => {
  it('1e400 → overflow；1e-400 → underflow（各 1 条，按源顺序）', async () => {
    const text = '[1e400,1e-400]';
    const report = await scan(text);
    expect(report.counts).toEqual({ number: 2, keyOrder: 0, total: 2 });
    expect(digest(report)).toEqual([
      ['number', 'overflow'],
      ['number', 'underflow'],
    ]);
    expect(report.hits[0]).toMatchObject({ offset: text.indexOf('1e400'), parsed: 'Infinity' });
    expect(report.hits[1]).toMatchObject({ offset: text.indexOf('1e-400'), parsed: '0' });
  });

  it('指数写法的其它形态不误报：1e-5 / 1E+3 / -0 / 0 / 0e400', async () => {
    for (const text of ['1e-5', '1E+3', '-0', '0', '0e400', '1.5e10']) {
      const report = await scan(text);
      expect(report.status, `literal: ${text}`).toBe('none');
      expect(report.counts.total, `literal: ${text}`).toBe(0);
    }
  });

  it('上溢判定按「带指数且非有限」，大数但有限（1e308）不报', async () => {
    expect((await scan('1e308')).status).toBe('none');
    expect((await scan('-1e400')).hits[0]).toMatchObject({ reason: 'overflow' });
  });

  it('超长纯整数（double 撑爆为 Infinity）也按 overflow 报（ADR 表只列「带指数」，见实现报告）', async () => {
    const report = await scan('1'.repeat(400));
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({ kind: 'number', reason: 'overflow', parsed: 'Infinity' });
  });
});

describe('scanFidelity — 高精度小数 v1 不报（ADR 已记差距）', () => {
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
      '["1e-400","9007199254740993"]',
      '{"1234567890123456789":"x"}', // 键名是长数字串，值正常 → 数字判定不介入
    ]) {
      const report = await scan(text);
      expect(report.status, `text: ${text}`).toBe('none');
    }
  });

  it('字符串转义（\\" / \\\\ / \\uXXXX）不会打乱结构，字符串后的数字仍命中', async () => {
    const text = '{"s":"a\\"b\\\\c\\u0031","n":1234567890123456789}';
    const report = await scan(text);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({
      kind: 'number',
      offset: text.indexOf('1234567890123456789'),
    });
  });
});

describe('scanFidelity — 整数样式键重排（key-order）', () => {
  it('非下标键之后又出现下标键 → 1 条 key-order（offset = 对象 `{`）', async () => {
    const text = '{"2":1,"b":2,"1":3}';
    const report = await scan(text);
    expect(report.status).toBe('found');
    expect(report.counts).toEqual({ number: 0, keyOrder: 1, total: 1 });
    expect(report.hits[0]?.kind).toBe('key-order');
    expect(report.hits[0]?.offset).toBe(0);
    expect(report.hits[0]?.reason).toBeUndefined();
    expect(report.hits[0]?.snippet.length).toBeLessThanOrEqual(FIDELITY_SNIPPET_MAX);
  });

  it('下标键全部在前且升序 → 无损，不报', async () => {
    expect((await scan('{"1":1,"2":2,"b":3}')).status).toBe('none');
    expect((await scan('{"0":1,"1":2,"3":4,"b":5}')).status).toBe('none');
  });

  it('下标键降序（"1","2","1"）→ 1 条（1 出现在 2 之后）', async () => {
    const report = await scan('{"1":1,"2":2,"1":3}');
    expect(report.counts.keyOrder).toBe(1);
  });

  it('重复的下标键（"1","1"）不算键序损失（重复键吞并属 ADR §4 另一类）', async () => {
    expect((await scan('{"1":1,"1":2}')).counts.keyOrder).toBe(0);
    expect((await scan('{"0":1,"0":2,"1":3}')).counts.keyOrder).toBe(0);
  });

  it('非下标键在前、下标键倒序（"10","9"）→ 1 条', async () => {
    const report = await scan('{"b":1,"10":2,"9":3}');
    expect(report.counts).toEqual({ number: 0, keyOrder: 1, total: 1 });
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
    // 4294967295 作非下标键出现在前，"0" 作下标键跟在后面 → 被 JSON.parse 重排 → 报
    expect((await scan('{"4294967295":1,"0":2}')).counts.keyOrder).toBe(1);
    // 4294967294 仍是下标键，且升序 → 无损
    expect((await scan('{"4294967294":1,"b":2}')).status).toBe('none');
  });

  it('前导零 / 超长整数串不是规范整数键（按字符串键处理）', async () => {
    // "01" 不是下标键（非规范整数串），但后面的 "0" 是 → JSON.parse 会把 "0" 提到前面
    expect((await scan('{"01":1,"0":2}')).counts.keyOrder).toBe(1);
    expect((await scan('{"99999999999":1,"0":2}')).counts.keyOrder).toBe(1);
  });
});

describe('scanFidelity — 混合文档 / 截断 / 顺序', () => {
  const text = '{"2":1,"b":2,"1":3,"n":1234567890123456789,"e":1e400}';

  it('命中按源文本顺序、counts 分类正确', async () => {
    const report = await scan(text);
    expect(report.counts).toEqual({ number: 2, keyOrder: 1, total: 3 });
    expect(digest(report)).toEqual([
      ['key-order', undefined],
      ['number', 'precision'],
      ['number', 'overflow'],
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
    expect(report.hits[0]?.offset).toBe(MANY_HITS_TEXT.indexOf('1234567890123456789'));
  });

  it('maxHits: 0 → 不保留片段、counts 仍全量', async () => {
    const report = await scan(MANY_HITS_TEXT, { maxHits: 0 });
    expect(report.hits).toEqual([]);
    expect(report.truncated).toBe(true);
    expect(report.counts.total).toBe(150);
  });

  it('snippet 一律 ≤ 48 字符（超长字面量截断为 47 字符 + …）', async () => {
    const longLiteral = '1'.repeat(60);
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
    // 100 个数字、yieldEvery=10 → 至少 10 次让出机会
    const text = '[' + Array.from({ length: 100 }, () => '1234567890123456789').join(',') + ']';
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
      expect(report.counts).toEqual({ number: 0, keyOrder: 0, total: 0 });
      expect(report.hits).toEqual([]);
      expect(report.truncated).toBe(false);
      expect(typeof report.scanMs).toBe('number');
      expect(report.scanMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('非法 / 截断文本不抛错，仍尽力给命中（源文本可能是修复前的原文）', async () => {
    const report = await scan('{"a":1234567890123456789,"b":"hello wor');
    expect(report.status).toBe('found');
    expect(report.counts.number).toBe(1);
    expect(report.truncated).toBe(false);
  });
});
