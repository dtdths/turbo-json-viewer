/**
 * Generate the fidelity fixtures (small, committable).
 *
 *   data/pathological.json      all distortion classes in one minified document
 *   data/key-order.json         integer-style key ordering / mixed key objects
 *   data/truncated/*.json       truncation cases for the repair prototype
 *
 * Run: node prototype/p1/bench/fidelity/gen-fixtures.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const HERE = import.meta.dirname;
const DATA = path.join(HERE, '../../fixtures/fidelity/data');
const TRUNC = path.join(DATA, 'truncated');

// NOTE: every string is written verbatim — this file stores JSON *source text*, so
// escapes such as \ud800 stay as backslash-u sequences in the fixture.
const pathological = [
  '{',
  '"big_int_inexact":1234567890123456789,', // 19 digits → 1234567890123456800
  '"big_int_2p53_plus1":9007199254740993,', // → 9007199254740992
  '"big_int_pow2_exact":9007199254740992,', // exact (2^53)
  '"big_int_2p64":18446744073709551616,', // exact (2^64, power of two)
  '"big_int_inexact_22":1234567890123456789012,',
  '"neg_zero":-0,',
  '"neg_zero_frac":-0.0,',
  '"overflow_1e400":1e400,',
  '"underflow_1e_m400":1e-400,',
  '"lone_high":"\\ud800",',
  '"lone_low":"x\\udc00y",',
  '"escape_pairs":"caf\\u00e9 \\uD83D\\uDE00",',
  '"escaped_solidus":"a\\/b",',
  '"escaped_quote":"\\"q\\" and \\\\ backslash",',
  '"cjk":"日本語テキスト",',
  '"number_forms":[1E+2,1e2,1.0,1.50,0,-0,2.5e-3],',
  '"dup_keys":{"a":1,"a":2,"b":3,},',
  '"depth":{"a":{"b":{"c":[1,2,3]}}}',
  '}',
].join('');

// trailing comma above is *intentional* in dup_keys? no — keep the doc strictly valid.
const pathologicalValid = pathological.replace('"b":3,}', '"b":3}');

// Written as literal source text on purpose: JSON.stringify(obj) would emit keys in
// already-reordered form, which would make this fixture useless.
const keyOrder = [
  '{',
  '"mixed_msg_first":{"msg":"a","2":"b","1":"c","z":"d","0":"e"},',
  '"pure_ascending":{"1":"a","2":"b","10":"c"},',
  '"pure_descending":{"3":"a","2":"b","1":"c"},',
  '"big_index_like":{"4294967295":"a","1":"b"},',
  '"negative_like":{"-1":"a","0":"b"},',
  '"leading_zero":{"01":"a","1":"b"},',
  '"all_int_ascending_then_str":{"0":"a","1":"b","10":"c","tag":"x"},',
  '"nested":[{"msg":"x","2":1,"1":2}],',
  '"mixed_msg_last":{"1":"a","2":"b","msg":"c"}',
  '}',
].join('');

// Truncation fixtures: each is a valid JSON prefix cut somewhere, mimicking a stalled
// transfer / truncated log line.
const truncated = {
  'trunc-mid-string.json': '{"a":1,"b":"hello wor',
  'trunc-mid-string-escape.json': '{"s":"ab\\',
  'trunc-mid-string-unicode-escape.json': '{"s":"ab\\u00',
  'trunc-unclosed-object.json': '{"a":1,"b":{"c":2',
  'trunc-unclosed-array.json': '{"items":[1,2,3',
  'trunc-empty-unclosed-array.json': '{"items":[',
  'trunc-after-comma-object.json': '{"a":1,',
  'trunc-after-comma-array.json': '{"a":[1,2,',
  'trunc-after-colon.json': '{"a":',
  'trunc-truncated-number.json': '{"n":1234567',
  'trunc-truncated-number-exp.json': '{"n":1.2e',
  'trunc-truncated-literal.json': '{"t":tru',
  'trunc-truncated-literal-null.json': '{"t":nul',
  'trunc-key-only.json': '{"a":1,"bb',
  'trunc-nested-deep.json': '{"a":{"b":[{"c":[1,{"d":"x',
  'trunc-array-of-objects.json': '[{"id":1,"name":"a"},{"id":2,"name":"b"},{"id":3,"na',
  'trunc-whitespace-tail.json': '{"a":1}   \n  ',
  'trunc-none.json': '{"a":1,"b":2}',
};

await mkdir(TRUNC, { recursive: true });
await writeFile(path.join(DATA, 'pathological.json'), pathologicalValid);
await writeFile(path.join(DATA, 'pathological.raw-with-dup-and-comma.json'), pathological);
await writeFile(path.join(DATA, 'key-order.json'), keyOrder);
for (const [name, body] of Object.entries(truncated)) {
  await writeFile(path.join(TRUNC, name), body);
}
const n = Object.keys(truncated).length;
console.log(
  JSON.stringify(
    {
      wrote: [
        'data/pathological.json',
        'data/pathological.raw-with-dup-and-comma.json',
        'data/key-order.json',
        `data/truncated/*.json (${n})`,
      ],
      dataDir: DATA,
    },
    null,
    2,
  ),
);
