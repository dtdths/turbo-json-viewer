/**
 * Tiny static file server with permissive CORS, so an extension page under test
 * can `fetch()` big JSON samples without copying them through the CDP channel.
 * (Unpacked extensions have no host permissions; a CORS-enabled localhost
 * server is the simplest way to hand 10/50 MB strings to the page/worker.)
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8';

export async function startStaticServer(root, { port = 0 } = {}) {
  const absRoot = path.resolve(root);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    let file = path.resolve(absRoot, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(absRoot + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let st;
    try {
      st = statSync(file);
      if (st.isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': mimeOf(file),
      'content-length': st.size,
      'access-control-allow-origin': '*',
      'access-control-allow-private-network': 'true',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: address.port,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
