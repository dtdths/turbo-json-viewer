/**
 * scripts/lib/search-expectations.mjs — 搜索冒烟的**文档基线**（唯一常量源，两份冒烟共用）。
 *
 * 为什么不再从样本现算：`core/search.ts` 的命中语义（含 ADR-0014 的 `Aa` / 正则 / `keysOnly` /
 * 截断）由 vitest 的 parity oracle（`tests/unit/core/search-parity.test.ts` × 独立参考实现
 * `tests/unit/core/search-reference.ts`）对照保证；冒烟只负责断言「真实浏览器 / 真实扩展的
 * 产出 = 文档基线」。历史上两份冒烟各自手抄一份 reference walk，既是第二份语义实现、又只能
 * 与被测实现互相背书（ADR-0014 修订 2026-11-10 / 架构走查候选 5）。
 *
 * 基线怎么可信：每个样本的**字节数 + sha256** 钉住具体文件；`reference:documented` 检查同时校验
 * 指纹与常量自洽（raw = key + value、capped = min(raw, limit)）。样本换了就红，提示刷新本文件。
 *
 * 刷新流程（样本重生成 / 换 `.mock/1.json` 时，一次性手动）：
 *   1) 临时在 `tests/unit/core/search-parity.test.ts` 里加一个 `it`，用 `referenceSearch` 对新样本
 *      算 `{total,key,value,truncated}`（uncapped 用 `limit: 1e9`）并 `console.log`；
 *   2) `npx vitest run tests/unit/core/search-parity.test.ts` 抄下数字；
 *   3) 用 `node -e` 算新样本的 bytes + sha256，更新本文件，删掉临时 `it`。
 */
import { createHash } from 'node:crypto';

/** 搜索命中上限（与 `src/protocol/versions.ts` 的 `SEARCH_LIMIT` 单源；漂移会被冒烟
 *  `big:search:hits==reference` / `trunc:hits==limit` 直接抓到）。 */
export const SEARCH_LIMIT = 50_000;

/** 文档常量（flat，供报告/详情展示；与 `REFERENCE_HITS` 的一致性由 `reference:documented` 断言）。 */
export const DOCUMENTED_HITS = {
  mockHotel: 186,
  bigHotelCapped: 50_000,
  bigHotelRaw: 74_378,
};

/** 期望命中数（形状对齐旧的 `analyzeHits` 返回值：`{total,key,value,truncated}`）。 */
export const REFERENCE_HITS = {
  /** `.mock/1.json` 搜 `hotel`：未截断（186 = 140 key + 46 value）。 */
  mockHotel: { total: 186, key: 140, value: 46, truncated: false },
  /** 10MB 样本搜 `hotel`：raw 74,378（37,189 key + 37,189 value）→ capped 50,000 truncated。 */
  bigHotel: {
    capped: { total: 50_000, truncated: true },
    raw: { total: 74_378, key: 37_189, value: 37_189, truncated: false },
  },
  /** 10MB 样本搜 `e`（远超上限）：capped 50,000 truncated。 */
  bigHotelE: { total: 50_000, truncated: true },
  /** `.mock/1.json` 搜 `zz-no-such-term-9x`：无命中。 */
  noHit: { total: 0, key: 0, value: 0, truncated: false },
};

/** 样本身份指纹（bytes = UTF-8 字节数；与 `readJsonSample` 的 `Buffer.byteLength(text)` 同口径）。 */
export const SAMPLES = {
  mock: {
    path: '.mock/1.json',
    bytes: 974_237,
    sha256: 'e6fa44fe3da43e09c868b808c906249439453aa45e3035e8519eb968cb26b2ca',
  },
  big: {
    path: '.spike/samples/10mb.json',
    bytes: 10_485_779,
    sha256: '677d10b250a858f32567c205dcf01f8ffc2755e80fb13bbb4d52e72d7123262c',
  },
};

/** 文本 → 样本指纹（与 `SAMPLES` 同口径）。 */
export function fingerprintText(text) {
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}
