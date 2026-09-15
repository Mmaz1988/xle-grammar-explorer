/**
 * Tests for serving the app and launching it.
 *
 * The launcher's job is to fail in a way someone can act on, so the tests are mostly
 * about the refusals: no bundle, no browser that can run the app, a port taken by
 * something else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findBundle, fileFor, typeFor } from './static.mjs';
import { findBrowser, openCommand, portInUse, oracleAt } from './launch.mjs';
import { Presence } from './presence.mjs';
import { isMain } from './is-main.mjs';
import { locateXle } from './xle-locate.mjs';
import { grammarRoots, saveRoots } from './grammars.mjs';
import { bundleApp } from '../tools/bundle-app.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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

test('never stops before a window has ever opened', () => {
  // The browser takes a second or two to start. Exiting on that silence would stop
  // the server between the launcher printing its address and anyone reaching it.
  let clock = 0;
  const presence = new Presence({ emptyMs: 8000, now: () => clock });
  for (clock = 0; clock < 60_000; clock += 2000) {
    assert.equal(presence.check(), 'wait');
  }
});

test('stops once the last window says goodbye', () => {
  let clock = 0;
  const presence = new Presence({ emptyMs: 8000, now: () => clock });
  presence.seen('tab-1');
  assert.equal(presence.check(), 'wait');

  presence.gone('tab-1');
  clock += 2000;
  assert.equal(presence.check(), 'wait', 'not instantly — a reload gets this long');
  clock += 8000;
  assert.equal(presence.check(), 'exit');
});

test('survives a reload, which looks exactly like a close', () => {
  // `pagehide` fires and a new instance appears under a new id a moment later. The
  // gap is the whole reason the decision waits instead of counting to zero.
  let clock = 0;
  const presence = new Presence({ emptyMs: 8000, now: () => clock });
  presence.seen('tab-1');
  presence.gone('tab-1');

  clock += 900;
  assert.equal(presence.check(), 'wait');
  presence.seen('tab-2');
  clock += 30_000;
  assert.equal(presence.check(), 'wait', 'the reloaded page is holding it open');
});

test('keeps running while any other window is open', () => {
  let clock = 0;
  const presence = new Presence({ emptyMs: 8000, now: () => clock });
  presence.seen('tab-1');
  presence.seen('tab-2');
  presence.gone('tab-1');
  clock += 20_000;
  assert.equal(presence.check(), 'wait');
  assert.equal(presence.size, 1);

  presence.gone('tab-2');
  clock += 20_000;
  assert.equal(presence.check(), 'exit');
});

test('does not mistake a background tab for a closed one', () => {
  // Browsers throttle a hidden tab's timers to roughly once a minute, so a page that
  // is merely not in front checks in far less often than one in front.
  let clock = 0;
  const presence = new Presence({ staleMs: 90_000, emptyMs: 8000, now: () => clock });
  presence.seen('tab-1');
  clock += 61_000;
  assert.equal(presence.check(), 'wait', 'a throttled tab is still a tab');

  presence.seen('tab-1');
  clock += 91_000;
  assert.equal(presence.check(), 'wait', 'gone silent, but the grace has not elapsed');
  clock += 9000;
  assert.equal(presence.check(), 'exit', 'silent past both windows: the tab is gone');
});

test('knows it was run directly even through a symlinked path', () => {
  // The bug this exists for: `import.meta.url` is a real path and `process.argv[1]` is
  // whatever was typed. macOS temp directories are /var/folders, a symlink to
  // /private/var/folders, so comparing them made a packaged app load its launcher,
  // decide it had been imported, and exit 0 having served nobody.
  const real = realpathSync(join(here, 'launch.mjs'));
  // A directory whose name has a space in it, reached through a symlink: both halves
  // of what a packaged app hits, since it lives in "XLE Grammar Explorer.app" and gets
  // copied to /var/folders.
  const box = mkdtempSync(join(tmpdir(), 'xle-link-'));
  const spaced = join(box, 'XLE Grammar Explorer');
  mkdirSync(spaced);
  symlinkSync(real, join(spaced, 'launch.mjs'));
  const link = join(realpathSync(box).replace('/private/', '/'), 'XLE Grammar Explorer', 'launch.mjs');

  const argv = process.argv[1];
  try {
    process.argv[1] = real;
    assert.equal(isMain(pathToFileURL(real).href), true, 'the plain case');

    process.argv[1] = join(spaced, 'launch.mjs');
    assert.equal(isMain(pathToFileURL(real).href), true, 'through a symlink');

    if (link !== join(spaced, 'launch.mjs')) {
      process.argv[1] = link;
      assert.equal(isMain(pathToFileURL(real).href), true, 'through /var -> /private/var');
    }

    // A different file is still a different file.
    process.argv[1] = realpathSync(join(here, 'index.mjs'));
    assert.equal(isMain(pathToFileURL(real).href), false);
    process.argv[1] = join(here, 'nothing-here.mjs');
    assert.equal(isMain(pathToFileURL(real).href), false);
  } finally {
    process.argv[1] = argv;
  }
});

test('finds XLE where it is installed, not only where PATH says', () => {
  // An app started from Finder inherits /usr/bin:/bin:/usr/sbin:/sbin, so a bare `xle`
  // is not runnable even on a machine that has it — which reported XLE missing and
  // looked like nothing was wrong at all.
  const onlyInstalled = {
    exists: (path) => path === '/Applications/xle/xle',
    canRun: (command) => command === '/Applications/xle/xle',
  };
  const found = locateXle({ HOME: '/Users/someone' }, onlyInstalled);
  assert.equal(found?.mode, 'native');
  assert.equal(found?.command, '/Applications/xle/xle');

  // PATH still comes first when it works, so nobody's working setup changes.
  const onPath = { exists: () => true, canRun: (command) => command === 'xle' };
  assert.equal(locateXle({ HOME: '/Users/someone' }, onPath)?.command, 'xle');

  // And a machine without XLE gets a mode, not an error.
  assert.equal(locateXle({ HOME: '/Users/someone' }, { exists: () => false, canRun: () => false }), undefined);
});

test('an explicit XLE_COMMAND still wins over anything installed', () => {
  const found = locateXle({ XLE_COMMAND: '/somewhere/else/xle', PATH: '/usr/bin' });
  assert.equal(found?.mode, 'explicit');
  assert.equal(found?.command, '/somewhere/else/xle');
});

test('remembers where a shared copy was told its grammars are', () => {
  // A packaged app has no `grammars` beside it and inherits no environment, so the
  // folder its owner picked is the only way the oracle can resolve a name to a path.
  const file = join(mkdtempSync(join(tmpdir(), 'xle-roots-')), 'roots');
  const env = { XLE_GRAMMAR_ROOTS_FILE: file, HOME: '/nowhere' };
  // No `grammars` beside it: that is what makes a copy a copy rather than the repo.
  const none = '/no/grammars/here';
  assert.deepEqual(grammarRoots(env, none), [], 'nothing saved yet');

  const real = mkdtempSync(join(tmpdir(), 'xle-grammars-'));
  saveRoots([real, '/gone/missing'], env);
  // A folder that has since been deleted is dropped rather than handed to XLE.
  assert.deepEqual(grammarRoots(env, none), [resolve(real)]);

  // The environment still outranks the file, and the repo's own symlink outranks both.
  assert.deepEqual(grammarRoots({ ...env, XLE_GRAMMAR_ROOTS: '/a:/b' }, none),
    [resolve('/a'), resolve('/b')]);
});

test('packages an app that carries its own code', () => {
  const from = mkdtempSync(join(tmpdir(), 'xle-src-'));
  for (const dir of ['assets', 'server', 'dist']) mkdirSync(join(from, dir));
  writeFileSync(join(from, 'assets', 'AppIcon.icns'), 'icns');
  writeFileSync(join(from, 'assets', 'app-launch.sh'), '#!/bin/sh\n');
  writeFileSync(join(from, 'server', 'launch.mjs'), '// launcher');
  writeFileSync(join(from, 'server', 'coverage.test.mjs'), '// a test');
  writeFileSync(join(from, 'dist', 'index.html'), '<html>');

  const app = bundleApp(from, mkdtempSync(join(tmpdir(), 'xle-out-')));
  for (const part of ['Contents/Info.plist', 'Contents/PkgInfo', 'Contents/MacOS/launch',
    'Contents/Resources/AppIcon.icns', 'Contents/Resources/app/server/launch.mjs',
    'Contents/Resources/app/dist/index.html']) {
    assert.ok(existsSync(join(app, part)), `missing ${part}`);
  }
  // `index.mjs` looks for the page at ../dist from the server directory, so the two
  // have to sit side by side inside Resources/app or the app serves nothing.
  assert.ok(existsSync(join(app, 'Contents/Resources/app/dist')));
  // Tests and fixtures are not worth shipping.
  assert.ok(!existsSync(join(app, 'Contents/Resources/app/server/coverage.test.mjs')));
  // Finder will not run it otherwise.
  assert.ok(statSync(join(app, 'Contents/MacOS/launch')).mode & 0o111, 'launcher not executable');
});

test('ships the same launcher in the repository copy as in the package', () => {
  // Two copies of a script drift; this is the cheapest way to notice.
  const canonical = readFileSync(join(here, '..', 'assets', 'app-launch.sh'), 'utf8');
  const inRepoApp = join(here, '..', 'XLE Grammar Explorer.app', 'Contents', 'MacOS', 'launch');
  assert.equal(readFileSync(inRepoApp, 'utf8'), canonical);
});
