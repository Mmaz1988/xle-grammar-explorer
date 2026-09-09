/**
 * Runs CodeMirror's real parser over every grammar file.
 *
 * The sibling tokenizer harness drives a hand-written StringStream shim, which is fast
 * and dependency-free but only as faithful as the shim. It once passed on all 71 files
 * while the app hung on the first one opened, because the shim returned `null` past
 * end-of-line where CodeMirror returns `undefined`.
 *
 * This check has no shim: it builds a real EditorState with the real StreamLanguage and
 * forces a full parse, so any loop or stall in highlighting shows up here rather than
 * as a frozen tab. No DOM is needed — EditorState and the language package run in Node.
 */

import { spawnSync } from 'node:child_process';
import { EditorState } from '@codemirror/state';
import { StreamLanguage, ensureSyntaxTree } from '@codemirror/language';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const { lfgStreamMode } = await import('../.harness/src/app/grammar/lfg/lfg-stream-mode.js');

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const GRAMMARS = join(ROOT, 'grammars');
const BUDGET_MS = 5000;
const WALL_CLOCK_MS = 60000;

const lang = StreamLanguage.define({
  name: 'lfg',
  startState: () => lfgStreamMode.startState(),
  copyState: (s) => lfgStreamMode.copyState(s),
  token: (stream, state) => lfgStreamMode.token(stream, state),
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.fileindexdir')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.lfg') || name.endsWith('.lfg.glue')) out.push(full);
  }
  return out;
}

/**
 * The work runs in a child process under a wall-clock timeout.
 *
 * A tokenizer that loops inside a single token() call never returns to CodeMirror, so
 * ensureSyntaxTree's own budget never gets a chance to fire and the run simply hangs —
 * which is exactly how the `peek() !== null` bug behaved. Killing a child turns that
 * hang into a reported failure naming the file it died on, instead of a stuck CI job.
 */
if (!process.argv.includes('--child')) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
    timeout: WALL_CLOCK_MS,
    encoding: 'utf8',
  });
  const out = run.stdout ?? '';
  process.stdout.write(out);
  if (run.stderr) process.stderr.write(run.stderr);

  if (run.error?.code === 'ETIMEDOUT' || run.signal) {
    const attempted = [...out.matchAll(/^trying (.+)$/gm)].map((m) => m[1]);
    const last = attempted[attempted.length - 1] ?? '(none)';
    console.error(
      `\nHighlighting hung after ${Date.now() - started} ms — the tokenizer stopped ` +
      `returning to CodeMirror.\nLast file attempted: ${last}`,
    );
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}

const files = walk(GRAMMARS).sort();
const failures = [];
let slowest = { path: '', ms: 0 };

for (const full of files) {
  const path = relative(GRAMMARS, full);
  // Printed before parsing so a hang is attributable to a specific file.
  console.log(`trying ${path}`);
  const doc = readFileSync(full, 'utf8');
  const state = EditorState.create({ doc, extensions: [lang] });
  const t0 = Date.now();
  const tree = ensureSyntaxTree(state, state.doc.length, BUDGET_MS);
  const ms = Date.now() - t0;
  if (ms > slowest.ms) slowest = { path, ms };
  if (!tree) failures.push(`${path}: highlighting did not finish within ${BUDGET_MS} ms`);
}

console.log(`\nfiles    ${files.length}`);
console.log(`slowest  ${slowest.path} (${slowest.ms} ms)`);
if (failures.length) {
  console.error(`\n${failures.length} file(s) failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nOK — CodeMirror highlighted every file.');
