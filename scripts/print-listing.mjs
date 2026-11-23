/**
 * scripts/print-listing.mjs — 打印 / 校验商店 listing 文案（单一来源 docs/release/listing.json）。
 *
 *   node scripts/print-listing.mjs --check        # 长度与必填校验（CI / wizard 预检）
 *   node scripts/print-listing.mjs en             # 打印英文各字段（复制粘贴用）
 *   node scripts/print-listing.mjs zh --field summary
 *
 * 长度口径（Chrome Web Store）：Name ≤ 75 字符、Summary ≤ 132 字符，均按 Unicode 码点计。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';

const FILE = path.join(REPO_ROOT, 'docs/release/listing.json');
const LIMITS = { name: 75, summary: 132 };
const REQUIRED = [
  'name',
  'summary',
  'description',
  'singlePurpose',
  'permissions',
  'remoteCode',
  'dataUsage',
  'testInstructions',
  'screenshotCaptions',
];

const args = process.argv.slice(2);
const check = args.includes('--check');
const lang = args.find((a) => !a.startsWith('--')) ?? 'en';
const fieldIdx = args.indexOf('--field');
const field = fieldIdx >= 0 ? args[fieldIdx + 1] : null;

const listing = JSON.parse(await readFile(FILE, 'utf8'));
const cp = (s) => [...s].length;

function validate() {
  const problems = [];
  if (!listing.category) problems.push('缺 category');
  for (const [tag, entry] of Object.entries(listing.locales)) {
    for (const key of REQUIRED) {
      if (entry[key] === undefined) problems.push(`${tag}: 缺 ${key}`);
    }
    for (const [key, max] of Object.entries(LIMITS)) {
      const value = entry[key];
      if (typeof value !== 'string') continue;
      if (cp(value) > max) problems.push(`${tag}.${key} 超长：${cp(value)} > ${max}`);
    }
    if (!Array.isArray(entry.description) || entry.description.length === 0) {
      problems.push(`${tag}.description 应为非空数组（按行拼接）`);
    }
    if (!Array.isArray(entry.screenshotCaptions) || entry.screenshotCaptions.length > 5) {
      problems.push(`${tag}.screenshotCaptions 最多 5 条（商店截图上限）`);
    }
  }
  return problems;
}

const problems = validate();
if (check) {
  const tags = Object.keys(listing.locales);
  for (const [tag, entry] of Object.entries(listing.locales)) {
    console.log(
      `${tag}: name ${cp(entry.name)}/${LIMITS.name} · summary ${cp(entry.summary)}/${LIMITS.summary} · description ${entry.description.length} 行`,
    );
  }
  if (problems.length === 0) {
    console.log(`listing.json ✓（${tags.join(' / ')}）`);
  } else {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exitCode = 1;
  }
} else {
  const entry = listing.locales[lang];
  if (!entry) {
    console.error(`没有 ${lang} 这一套；可选：${Object.keys(listing.locales).join(' / ')}`);
    process.exit(1);
  }
  const rule = (title) => console.log(`\n──── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
  if (!field || field === 'name') {
    rule(`Name (${cp(entry.name)}/75)`);
    console.log(entry.name);
  }
  if (!field || field === 'summary') {
    rule(`Summary (${cp(entry.summary)}/132)`);
    console.log(entry.summary);
  }
  if (!field || field === 'description') {
    rule('Description');
    console.log(entry.description.join('\n'));
  }
  if (!field || field === 'singlePurpose') {
    rule('Single purpose');
    console.log(entry.singlePurpose);
  }
  if (!field || field === 'permissions') {
    rule('Permission justifications');
    for (const [key, value] of Object.entries(entry.permissions)) console.log(`${key}: ${value}`);
    rule('Remote code');
    console.log(entry.remoteCode);
  }
  if (!field || field === 'dataUsage') {
    rule('Data usage');
    for (const [key, value] of Object.entries(entry.dataUsage)) console.log(`${key}: ${value}`);
  }
  if (!field || field === 'testInstructions') {
    rule('Test instructions');
    console.log(entry.testInstructions.join('\n'));
  }
  if (!field || field === 'captions') {
    rule('Screenshot captions');
    entry.screenshotCaptions.forEach((caption, i) => console.log(`${i + 1}. ${caption}`));
  }
  if (problems.length > 0) {
    console.error('\n⚠ listing.json 有问题：');
    for (const p of problems) console.error(`  ✗ ${p}`);
  }
}
