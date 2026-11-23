/**
 * scripts/package.mjs — 把 `dist/` 打成可直接上传 Chrome Web Store 的 zip。
 *
 *   node build.mjs && node scripts/package.mjs        # npm run package
 *
 * 为什么自己写 zip：仓库纪律不引新依赖；`zip` CLI 不是处处都有。这里只用
 * Node 内置 `zlib.deflateRawSync`，产出**确定性**包（文件按名字排序、mtime 固定、
 * 无 extra field、UTF-8 名字标志），同样输入永远得到逐字节相同的 zip —— 便于
 * 用 sha256 记账、也避免「只改了时间戳」的假 diff。
 *
 * 产物：`.spike/release/turbo-json-viewer-<version>.zip`（`.spike/` 已 gitignore，
 * 发布物不进版本库）。manifest.json 位于 zip 根目录（商店硬要求）。
 *
 * 校验（`--check` 之外的默认行为也会跑）：
 *   - `dist/manifest.json` 存在且 `manifest_version === 3`；
 *   - zip 内没有 `.map` / `.ts` / 源文件，没有 `__MACOSX`；
 *   - 打印条目数 / 原始体积 / zip 体积 / sha256。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';

const DIST = path.join(REPO_ROOT, 'dist');
const OUT_DIR = path.join(REPO_ROOT, '.spike', 'release');
const FORBIDDEN_EXT = ['.map', '.ts', '.tsx', '.mjs', '.md'];
const FORBIDDEN_PREFIX = ['__MACOSX/', '.DS_Store'];

/* ------------------------------- zip 写入 ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 固定 DOS 时间戳（2020-01-01 00:00），保证包内容确定。 */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function localHeader({ nameBuf, method, crc, compSize, rawSize }) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  head.writeUInt16LE(method, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(compSize, 18);
  head.writeUInt32LE(rawSize, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([head, nameBuf]);
}

function centralHeader({ nameBuf, method, crc, compSize, rawSize, offset }) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(method, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(compSize, 20);
  head.writeUInt32LE(rawSize, 24);
  head.writeUInt16LE(nameBuf.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk start
  head.writeUInt16LE(0, 36); // internal attrs
  head.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--（>>>0 避免符号溢出）
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, nameBuf]);
}

function eocd(count, cdSize, cdOffset) {
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(0x06054b50, 0);
  tail.writeUInt16LE(0, 4);
  tail.writeUInt16LE(0, 6);
  tail.writeUInt16LE(count, 8);
  tail.writeUInt16LE(count, 10);
  tail.writeUInt32LE(cdSize, 12);
  tail.writeUInt32LE(cdOffset, 16);
  tail.writeUInt16LE(0, 20);
  return tail;
}

/** 按名字排序后打包；所有条目用 deflate（PNG 也走，省得两套分支）。 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const local = localHeader({ nameBuf, method, crc, compSize: body.length, rawSize: data.length });
    chunks.push(local, body);
    central.push(
      centralHeader({
        nameBuf,
        method,
        crc,
        compSize: body.length,
        rawSize: data.length,
        offset,
      }),
    );
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const head = Buffer.concat(chunks);
  return Buffer.concat([head, cd, eocd(entries.length, cd.length, head.length)]);
}

/* ------------------------------- 主流程 ------------------------------- */

/** 递归列出 dist 下的文件（相对路径用 /，保证 zip 里是正斜杠）。 */
async function walk(dir, base = dir, out = []) {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) await walk(abs, base, out);
    else if (item.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

export async function packageExtension({ quiet = false } = {}) {
  const manifestPath = path.join(DIST, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    fail(`找不到可用的 ${path.relative(REPO_ROOT, manifestPath)}——先跑 node build.mjs`);
    return null;
  }
  if (manifest.manifest_version !== 3) {
    fail(`manifest_version 应为 3，实际 ${manifest.manifest_version}`);
    return null;
  }
  const version = manifest.version;
  if (!/^\d+(\.\d+){0,3}$/.test(version)) {
    fail(`version 不合规（1–4 段点分整数）：${version}`);
    return null;
  }

  const names = (await walk(DIST)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bad = names.filter((name) =>
    FORBIDDEN_PREFIX.some((p) => name.startsWith(p) || name.endsWith(p.replace('/', ''))),
  );
  const badExt = names.filter((name) => FORBIDDEN_EXT.some((ext) => name.endsWith(ext)));
  if (bad.length > 0) fail(`包里混进系统垃圾文件：${bad.join(', ')}`);
  if (badExt.length > 0) fail(`包里混进源码 / map：${badExt.join(', ')}`);
  if (!names.includes('manifest.json')) fail('manifest.json 不在 zip 根目录');
  if (!names.includes('page.html')) fail('缺 page.html（入口页）');
  if (process.exitCode === 1) return null;

  const entries = [];
  for (const name of names) entries.push({ name, data: await readFile(path.join(DIST, name)) });

  const zip = buildZip(entries);
  await mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `turbo-json-viewer-${version}.zip`);
  await writeFile(outFile, zip);

  const rawTotal = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const sha = createHash('sha256').update(zip).digest('hex');
  const summary = {
    version,
    file: path.relative(REPO_ROOT, outFile),
    entries: entries.length,
    rawBytes: rawTotal,
    zipBytes: zip.length,
    sha256: sha,
  };
  if (!quiet) {
    console.log(`manifest.json 在根目录 ✓  manifest_version=${manifest.manifest_version}  version=${version}`);
    console.log(`条目 ${summary.entries} 个 · 原始 ${(rawTotal / 1024).toFixed(1)} KB · zip ${(zip.length / 1024).toFixed(1)} KB`);
    console.log(`sha256 ${sha}`);
    console.log(`产物 ${summary.file}`);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await packageExtension();
}
