/**
 * search-fixtures — 搜索 parity 测试用的小样本（checked-in、纯 JSON 值、可 `JSON.parse` 往返）。
 *
 * 刻意不读 `.mock/1.json` / `.spike/samples/*`：那两个目录 gitignore，干净 checkout 不可复现
 * （README §11 已记这条差距）。大文档用 `bigHitDoc()` 在内存里合成。
 */

/** 混合形态：标识符键 / 非标识符键 / 空键 / 引号与反斜杠键 / 数组 / 空容器 / 深层 / 长串。 */
export const MIXED_DOC: unknown = {
  name: 'Alice',
  tags: ['alice', 'bob'],
  nested: { note: 'ALICE in wonderland', count: 2 },
  'a b': true,
  '': 'empty key',
  "quote'key": "value'quote",
  'back\\slash': 'backslash value',
  num: 123,
  digits: '123',
  flag: false,
  nil: null,
  emptyArr: [],
  emptyObj: {},
  deep: { l1: { l2: { l3: { l4: { l5: 'hotel deep' } } } } },
  long: 'y'.repeat(200),
  hotel: 'hotel',
};

/** Unicode：中文 / emoji / 大小写折叠边界（İ / ẞ / ß）。 */
export const UNICODE_DOC: unknown = {
  'İstanbul': 'İstanbul city',
  'ẞ': 'ẞ sharp s',
  strasse: 'straße',
  '中文': '中文酒店 hotel',
  emoji: '🏨 hotel 🏨',
  mixed: 'HOTEL Hotel hotel',
};

/** 键名命中优先于值命中；数组下标不参与键名匹配。 */
export const FIELD_DOC: unknown = {
  abc: 'abc',
  x: 'abc',
  list: ['[0]', 'abc', 0],
  nested: { abc: 'x', y: 'abc' },
};

/** 截断矩阵：5 条同词值命中，键名不命中。 */
export const TRUNC_DOC: unknown = { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x' };

/** 根形态：标量 / 数组 / 空对象。 */
export const ROOT_SCALAR: unknown = 'hello hotel world';
export const ROOT_ARRAY: unknown = ['hotel', { hotel: 'hotel' }, [], 123];
export const ROOT_EMPTY_OBJECT: unknown = {};

/** 冒烟 `smoke-search` options phase 的 fixture：四格命中数应为 6 / 2 / 5 / 1（冒烟手算常量由本测试背书）。 */
export const OPTIONS_DOC: unknown = {
  Hotel: 1,
  hotel: 2,
  HOTEL: 3,
  list: ['HoTel', 'xhotelx'],
  deep: { Hotel: 'v' },
};

/** 20 层嵌套（深层路径 / 递归深度）。 */
export function deepDoc(depth = 20): unknown {
  let node: unknown = 'hotel at bottom';
  for (let i = depth; i > 0; i -= 1) node = { ['l' + i]: node };
  return node;
}

/** 默认 `SEARCH_LIMIT` 截断用的大文档（内存合成，不依赖磁盘样本）：60,000 条值命中。 */
export function bigHitDoc(count = 60_000): unknown {
  return { items: Array.from({ length: count }, () => 'x') };
}
