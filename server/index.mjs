/**
 * A local XLE oracle for the grammar explorer.
 *
 * The explorer is a browser app that talks to no backend, and that stays true: this
 * service is optional. Without it the sentence bar falls back to matching headwords
 * itself and says so. With it, the answer comes from the grammar's own morphology
 * instead of from our guesses about English.
 *
 * It is deliberately local-only - it runs XLE over paths the caller names, so it
 * binds to the loopback interface and nothing else.
 */

import { createServer } from 'node:http';
import { locateXle } from './xle-locate.mjs';
import { XleSessionPool } from './xle-session.mjs';
import { coverageScript, classify } from './coverage.mjs';
import { grammarRoots, listGrammars, resolveGrammar } from './grammars.mjs';

const CONTROL = /[\u0000-\u001f]/;

const PORT = Number(process.env.XLE_SERVICE_PORT ?? 8085);
const ORIGIN = process.env.XLE_SERVICE_ORIGIN ?? 'http://localhost:4200';

const xle = locateXle();
const pool = xle ? new XleSessionPool(xle) : undefined;
const ROOTS = grammarRoots();

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': 'content-type',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {});

  if (request.url === '/health') {
    return send(response, 200, {
      xle: xle ? xle.mode : null,
      command: xle?.command ?? null,
      roots: ROOTS,
    });
  }

  if (request.url === '/grammars') {
    return send(response, 200, { roots: ROOTS, grammars: listGrammars(ROOTS) });
  }

  if (request.url === '/coverage' && request.method === 'POST') {
    if (!pool) return send(response, 503, { error: 'XLE is not installed on this machine.' });
    try {
      const { grammar, mainPath, sentence } = await readJson(request);
      if (typeof sentence !== 'string') {
        return send(response, 400, { error: 'Expected {sentence}.' });
      }
      // A newline would end the Tcl command early and run whatever followed it.
      if (CONTROL.test(sentence)) {
        return send(response, 400, { error: 'Control characters are not allowed.' });
      }

      // The browser knows a grammar by name, never by path; resolve it against the
      // roots. An explicit `grammar` path is honoured as-is, for scripts and tests.
      let path = typeof grammar === 'string' ? grammar : undefined;
      if (!path) {
        if (typeof mainPath !== 'string') {
          return send(response, 400, { error: 'Expected {grammar} or {mainPath}.' });
        }
        const { wanted, matches } = resolveGrammar(mainPath, listGrammars(ROOTS));
        if (matches.length === 0) {
          return send(response, 404, {
            error: `No ${wanted} under ${ROOTS.join(', ') || 'any configured root'}. ` +
              'Set XLE_GRAMMAR_ROOTS to the folder holding this grammar.',
          });
        }
        if (matches.length > 1) {
          return send(response, 409, { error: `Several files named ${wanted}.`, matches });
        }
        path = matches[0];
      }
      if (CONTROL.test(path)) {
        return send(response, 400, { error: 'Control characters are not allowed.' });
      }
      const session = pool.get(path);
      const output = await session.run(coverageScript(sentence));
      return send(response, 200, { tokens: classify(output) });
    } catch (error) {
      return send(response, 500, { error: String(error?.message ?? error) });
    }
  }

  send(response, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const where = xle ? xle.mode + ' (' + xle.command + ')' : 'not found - /coverage will refuse';
  console.log('XLE oracle on http://127.0.0.1:' + PORT + ' - XLE: ' + where);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    pool?.closeAll();
    server.close(() => process.exit(0));
  });
}
