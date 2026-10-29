import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';

export const kb = (n) => Math.round((n / 1024) * 100) / 100;

/** raw + gzip-9 size of one file. */
export async function fileSize(path) {
  const buf = await readFile(path);
  return { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length };
}

export async function reportSizes(files) {
  const out = {};
  for (const [name, path] of Object.entries(files)) {
    const s = await fileSize(path);
    out[name] = { raw: s.raw, gz: s.gz, rawKB: kb(s.raw), gzKB: kb(s.gz) };
  }
  return out;
}

export async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
