/**
 * Tests for the XLE oracle.
 *
 * The classifier runs against edge dumps captured from real XLE runs (see
 * `fixtures/`) rather than invented ones, because every bug this code had came from
 * XLE returning a shape I had not anticipated: several tokenisations of one span,
 * tags that are themselves lexicon hits, and a `-token` entry that matches everything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLabel, classify } from './coverage.mjs';
import { tclQuote } from './xle-session.mjs';
import { toWslPath } from './xle-locate.mjs';
import { originFor } from './cors.mjs';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', `${name}-edges.txt`), 'utf8');
const verdicts = (name) =>
  Object.fromEntries(classify(fixture(name)).map((t) => [t.text, t.verdict]));

test('parses the span out of an edge label', () => {
  assert.deepEqual(parseLabel('tractor:58[28,35]'), { text: 'tractor', from: 28, to: 35 });
  // A category may carry its own brackets, and a subtree id may follow the edge id.
  assert.deepEqual(parseLabel('VPv[fin]:159:1[8,38]'), { text: 'VPv[fin]', from: 8, to: 38 });
  // Trailing markers are not part of the span.
  assert.equal(parseLabel('a:50[24,25]??').text, 'a');
  assert.equal(parseLabel('not an edge'), undefined);
});

test('a closed-vocabulary grammar separates lexicon, -unknown and unanalysable', () => {
  const seen = verdicts('fracas');
  assert.equal(seen['Kim'], 'lexicon', 'Kim N * matches at token level');
  assert.equal(seen['saw'], 'lexicon', 'the stem see is in the verb lexicon');
  // In the FST but in no lexicon, so the -unknown entry supplies a default analysis.
  assert.equal(seen['tractor'], 'unknown-entry');
  // Not in the FST at all: this grammar cannot parse it however it is coloured.
  assert.equal(seen['blurgy'], 'unanalyzable');
});

test('a guessing grammar reports guesses as guesses', () => {
  const seen = verdicts('pargram');
  assert.equal(seen['tractor'], 'lexicon', 'ParGram has a large noun lexicon');
  // ParGram's morphology guesses any string, so this must never read as a real entry.
  assert.equal(seen['blurgy'], 'guessed');
});

test('several tokenisations of one span are one word', () => {
  // ParGram returns Kim, kim and `^ kim` for the same span; without grouping the
  // sentence would show a dozen words instead of seven.
  const words = classify(fixture('pargram'));
  assert.equal(words.length, 7, `expected 7 words, got ${words.map((w) => w.text).join(' ')}`);
  assert.deepEqual(
    words.map((w) => w.text),
    ['Kim', 'saw', 'a', 'tractor', 'and', 'a', 'blurgy'],
  );
});

test('tag morphemes are not evidence that a word is covered', () => {
  // Every tag is defined in the morphology lexicon, so a token whose only found
  // morphemes are tags is not covered. Counting them reported every word as green.
  const dump = [
    '@@@E\t(Edge)0xT\twidget:1[0,8]\tT\t\t\t',
    // The stem was analysed but matched no entry...
    '@@@E\t(Edge)0xS\twidget:4[0,6]\t\t(Edge)0xT\t\tT',
    // ...while its tags did, as tags always do.
    '@@@E\t(Edge)0xA\t+Noun:2[6,7]\t\t(Edge)0xT\tT\t',
    '@@@E\t(Edge)0xB\t+Sg:3[7,8]\t\t(Edge)0xT\tT\t',
  ].join('\n');
  assert.equal(classify(dump)[0].verdict, 'no-entry');
});

test('quotes text for Tcl so a sentence cannot become a command', () => {
  assert.equal(tclQuote('a dog'), '"a dog"');
  assert.equal(tclQuote('[exit]'), '"\\[exit\\]"');
  assert.equal(tclQuote('$x "y"'), '"\\$x \\"y\\""');
});

test('translates Windows paths for WSL, as LiGER does', () => {
  assert.equal(toWslPath('C:\\grammars\\main.lfg'), '/mnt/c/grammars/main.lfg');
  assert.equal(toWslPath('/already/posix'), '/already/posix');
});

test('allows any loopback origin, not one pinned port', () => {
  // ng serve takes whatever port is free; pinning 4200 silently broke the bar on 4300.
  assert.equal(originFor('http://localhost:4300', ''), 'http://localhost:4300');
  assert.equal(originFor('http://127.0.0.1:4200', ''), 'http://127.0.0.1:4200');
  // Anything not loopback gets no grant at all.
  assert.equal(originFor('https://example.com', ''), 'null');
  assert.equal(originFor('http://localhost.evil.com:80', ''), 'null');
  assert.equal(originFor(undefined, ''), 'null');
  // An explicit setting still wins.
  assert.equal(originFor('http://localhost:4300', 'http://x'), 'http://x');
});

test('the service starts and answers', async () => {
  // `node --check` validates syntax but not references, so an edit that deleted a
  // top-level declaration once shipped a server that died on its first request.
  // Only actually booting it catches that.
  const port = 8099;
  const child = spawn(process.execPath, [join(here, 'index.mjs')], {
    env: { ...process.env, XLE_SERVICE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(String(chunk)));

  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('exit', (code) => reject(new Error(`exited ${code}: ${errors.join('')}`)));
      setTimeout(() => reject(new Error('timed out starting')), 10000).unref();
    });

    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { origin: 'http://localhost:4321' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:4321');
    const health = await response.json();
    assert.ok(Array.isArray(health.roots), 'reports the roots it will search');
    assert.equal(errors.join(''), '', 'starts without writing to stderr');
  } finally {
    child.kill();
  }
});
