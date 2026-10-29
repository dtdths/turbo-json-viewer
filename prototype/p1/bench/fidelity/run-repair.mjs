/**
 * Truncation-repair bench: runs the conservative repair prototype over every fixture in
 * fixtures/fidelity/data/truncated/ and reports detect / repair / summary + the
 * provenance data shape.
 *
 *   node prototype/p1/bench/fidelity/run-repair.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { repairTruncated } from './lib/repair.mjs';

const DATA = path.join(import.meta.dirname, '../../fixtures/fidelity/data/truncated');
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

const files = (await readdir(DATA)).filter((f) => f.endsWith('.json')).sort();
const rows = [];
let detected = 0;
let repairedOk = 0;
let unrepairable = 0;
const t0 = now();

for (const f of files) {
  const text = await readFile(path.join(DATA, f), 'utf8');
  const t = now();
  const r = repairTruncated(text);
  const ms = Math.round((now() - t) * 1000) / 1000;
  if (r.status !== 'ok') detected++;
  if (r.status === 'repaired') repairedOk++;
  if (r.status === 'unrepairable') unrepairable++;
  rows.push({
    file: f,
    chars: text.length,
    truncated: r.status !== 'ok',
    status: r.status,
    ms,
    ops: r.ops.map((o) => `${o.op === 'insert' ? '+' : '-'}${JSON.stringify(o.text)}@${o.at} [${o.scope}] ${o.note}`),
    summaryText: r.summaryText,
    counts: r.counts,
    check: r.check,
    healed: r.repairedText ? r.repairedText.slice(-60) : null,
  });
}
const totalMs = now() - t0;

console.log(
  JSON.stringify(
    {
      fixtures: files.length,
      detectRate: `${detected}/${files.length}`,
      repairedOk,
      unrepairable,
      statusNone: files.length - detected,
      totalMs: Math.round(totalMs * 1000) / 1000,
      rows,
      provenanceShape: {
        docLevel: {
          'doc.repair.status': "'none' | 'repaired' | 'unrepairable'",
          'doc.repair.truncatedAt': 'number  // 源文本偏移（= 原文本长度）',
          'doc.repair.summaryText': 'string  // 顶部提示条副标题',
          'doc.repair.counts': '{ brackets, quotes, commas, deletedChars }',
        },
        perOp: {
          at: 'number  // 原文本偏移，op=insert 时为插入点',
          op: "'insert' | 'delete'",
          text: 'string  // 插入的字符 / 被删掉的原文片段',
          scope: "'container' | 'string' | 'key' | 'number' | 'literal' | 'comma'",
          note: 'string  // 修复摘要里给用户看的一行说明',
        },
        exportSuffix: '.truncated-repaired.json（导出时加后缀 + 文档头部注释不可用于 JSON；改为文件名后缀 + UI 角标）',
      },
    },
    null,
    2,
  ),
);
