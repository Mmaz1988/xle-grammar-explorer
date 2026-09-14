/**
 * Tests for serving the app and launching it.
 *
 * The launcher's job is to fail in a way someone can act on, so the tests are mostly
 * about the refusals: no bundle, no browser that can run the app, a port taken by
 * something else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { findBundle, fileFor, typeFor } from './static.mjs';
import { findBrowser, openCommand, portInUse, oracleAt } from './launch.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'xle-launch-'));

test('finds the bundle inside the directory ng build makes', () => {
  const dist = scratch();
  // `ng build` writes dist/<project name>/, and the project name is not worth knowing.
  mkdirSync(join(dist, 'xle-grammar-explorer'));
  writeFileSync(join(dist, 'xle-grammar-explorer', 'index.html'), '<html>');
  assert.equal(findBundle(dist), join(dist, 'xle-grammar-explorer'));

  // A flat build works too, and an empty dist is "not built" rather than an error.
  const flat = scratch();
  writeFileSync(join(flat, 'index.html'), '<html>');
  assert.equal(findBundle(flat), flat);
  assert.equal(findBundle(scratch()), undefined);
  assert.equal(findBundle(join(scratch(), 'absent')), undefined);
});

test('no spelling of `..` reaches outside the bundle', () => {
  const root = resolve('/srv/app');
  assert.equal(fileFor(root, '/main.js'), join(root, 'main.js'));
  // A query string is not part of the path; a directory means its index.
  assert.equal(fileFor(root, '/main.js?v=2'), join(root, 'main.js'));
  assert.equal(fileFor(root, '/'), join(root, 'index.html'));

  // Plain, percent-encoded, and with an encoded separator. None of these escape, and
  // they do not escape for two reasons worth keeping apart: the URL parser collapses
  // `..` against the origin root before we see it, and `normalize` runs before `join`
  // so an absolute path cannot climb above `/` either. Each resolves to a harmless
  // path inside the bundle, which then 404s. The startsWith check is the backstop for
  // anything that gets past both.
  for (const attempt of [
    '/../../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/a/../../../etc/passwd',
    '/..%2f..%2fetc/passwd',
  ]) {
    const got = fileFor(root, attempt);
    assert.ok(
      got === undefined || got.startsWith(root + '/'),
      `${attempt} resolved to ${got}, which is outside ${root}`,
    );
  }
});

test('serves script and style as script and style', () => {
  // Chrome refuses a module served as text/plain, so this is not cosmetic.
  assert.match(typeFor('/main.abc.js'), /^text\/javascript/);
  assert.match(typeFor('/styles.abc.css'), /^text\/css/);
  assert.match(typeFor('/index.html'), /^text\/html/);
  assert.equal(typeFor('/fonts/x.woff2'), 'font/woff2');
  assert.equal(typeFor('/unknown.bin'), 'application/octet-stream');
});

test('accepts only browsers that implement the File System Access API', () => {
  // Firefox and Safari load the page and cannot open a folder, so a launcher that
  // opened the default browser would look like it worked and then not work.
  const noSpotlight = () => undefined;
  const mac = findBrowser('darwin', {
    spotlight: noSpotlight,
    exists: (path) => path === '/Applications/Google Chrome.app',
  });
  assert.equal(mac?.name, 'Google Chrome');

  const linux = findBrowser('linux', { onPath: (c) => c === 'chromium' });
  assert.equal(linux?.name, 'chromium');

  const bare = findBrowser('linux', { onPath: () => false, exists: () => false });
  assert.equal(bare, undefined, 'a machine with only Firefox gets a refusal');
  assert.equal(findBrowser('sunos', { onPath: () => false, exists: () => false }), undefined);
});

test('opens a mac app by bundle rather than by executable path', () => {
  // `open -a` takes the app, which is what Spotlight and /Applications both name;
  // reaching inside the bundle for the binary is what breaks on a renamed install.
  const mac = openCommand({ found: '/Applications/Google Chrome.app' }, 'http://x', 'darwin');
  assert.deepEqual(mac, { command: 'open', args: ['-a', '/Applications/Google Chrome.app', 'http://x'] });

  const win = openCommand({ found: 'C:\\chrome.exe' }, 'http://x', 'win32');
  assert.deepEqual(win, { command: 'C:\\chrome.exe', args: ['http://x'] });
});

test('tells a free port from a taken one', async () => {
  const { createServer } = await import('node:http');
  const held = createServer();
  await new Promise((done) => held.listen(0, '127.0.0.1', done));
  const port = held.address().port;

  assert.equal(await portInUse(port), true);
  // Taken, but not by us — the launcher must not join something else's server.
  assert.equal(await oracleAt(port), false);

  await new Promise((done) => held.close(done));
  assert.equal(await portInUse(port), false);
});

test('recognises its own service on a taken port', async () => {
  const { createServer } = await import('node:http');
  const ours = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ xle: null, command: null, roots: [] }));
  });
  await new Promise((done) => ours.listen(0, '127.0.0.1', done));
  assert.equal(await oracleAt(ours.address().port), true, 'a second launch should join it');
  await new Promise((done) => ours.close(done));
});
