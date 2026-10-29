/**
 * Local preview server for the visual direction prototypes.
 *
 *   node prototype/visual/serve.mjs            # http://127.0.0.1:5199/
 *
 * Serves prototype/visual over HTTP with correct MIME types (the prototypes
 * also work from file://, but B embeds its own CSS/JS and review.html needs
 * PNGs, so a single URL is simpler for human review).
 */
import path from 'node:path';
import { startStaticServer } from '../p1/lib/http.mjs';

const PORT = Number(process.env.PORT || 5199);
const root = path.resolve(import.meta.dirname);
const server = await startStaticServer(root, { port: PORT });

const base = (p) => `http://127.0.0.1:${server.port}/${p}`;

console.log(`serving ${root}`);
console.log('');
console.log(`  compare  ${base('compare.html')}`);
console.log(`  A        ${base('a/index.html?screen=main&theme=dark')}`);
console.log(`  A+类型列  ${base('a/index.html?screen=main&theme=dark&typecol=1')}`);
console.log(`  B        ${base('b/index.html?screen=main&theme=dark')}`);
console.log(`  review   ${base('review.html')}`);
console.log('');
console.log('Ctrl+C to stop.');
