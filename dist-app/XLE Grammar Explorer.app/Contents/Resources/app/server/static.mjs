/**
 * Serving the built app, so one process is the whole thing.
 *
 * The explorer is a static bundle and the oracle is an HTTP service, and during
 * development they live on different ports — `ng serve` on 4200, the oracle on 8085 —
 * which is why the oracle answers CORS at all. Serving the bundle from the oracle puts
 * them on one origin, where the cross-origin question does not arise.
 *
 * There is no framework under this on purpose: the whole surface is "read a file under
 * one directory, or fall back to index.html".
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Where `ng build` put the app, or undefined if it has not been built.
 *
 * The output sits one directory deeper than `dist`, under the project name, and that
 * name is not worth hard-coding — any single directory holding an `index.html` is it.
 */
export function findBundle(dist) {
  if (!existsSync(dist)) return undefined;
  if (existsSync(join(dist, 'index.html'))) return dist;
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dist, entry.name);
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

/**
 * The file a request maps to, or undefined if it escapes the bundle.
 *
 * A URL path is not a file path: it can carry `..`, an encoding of it, or a query
 * string. It is normalised and then checked to still start with the root, rather than
 * trusted after normalising — which is the check that survives being wrong about the
 * ways `..` can be spelt.
 */
export function fileFor(root, url) {
  let path;
  try {
    path = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return undefined;
  }
  if (path.endsWith('/')) path += 'index.html';
  const full = resolve(join(root, normalize(path)));
  if (full !== root && !full.startsWith(root + sep)) return undefined;
  return full;
}

/** The content type for a path, defaulting to bytes rather than guessing. */
export const typeFor = (path) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/**
 * Serve `url` out of `root`, falling back to `index.html`.
 *
 * The fallback is what makes a client-side route survive a reload: the browser asks
 * for a path only the app knows about, and the app is in index.html. Hashed bundle
 * filenames are immutable, so they are cached hard; index.html never is, or a rebuild
 * would be invisible until someone cleared their cache.
 */
export function serveStatic(root, url, response) {
  const direct = fileFor(root, url);
  const file = direct && existsSync(direct) && statSync(direct).isFile()
    ? direct
    : join(root, 'index.html');

  if (!existsSync(file)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Not found');
  }

  const hashed = /\.[0-9a-f]{8,}\.(js|css)$/.test(file);
  response.writeHead(200, {
    'content-type': typeFor(file),
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(response);
}
