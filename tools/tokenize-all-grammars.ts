/**
 * Tokenizer harness.
 *
 * Runs the LFG stream mode over every grammar file with a minimal StringStream shim,
 * asserting the two invariants CodeMirror relies on:
 *
 *   1. every `token()` call advances the stream;
 *   2. tokenizing a line terminates.
 *
 * A stream parser that returns without consuming makes CodeMirror throw — or, with
 * enough repetition, take the renderer down with it. That is far easier to catch here,
 * against the real corpus, than by crashing browser tabs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lfgStreamMode } from '../src/app/grammar/lfg/lfg-stream-mode';

const ROOT = join(__dirname, '..', '..');
const GRAMMARS = join(ROOT, 'grammars');

/**
 * The subset of CodeMirror's StringStream the mode uses.
 *
 * This must match the real API's *return values*, not just its shape. An earlier
 * version returned `null` past end-of-line where CodeMirror returns `undefined`, and
 * that one difference hid an infinite loop that froze the browser: the harness passed
 * on all 71 files while the app hung on the first one it opened.
 */
class Stream {
  pos = 0;
  start = 0;
  constructor(public string: string) {}
  sol() { return this.pos === 0; }
  eol() { return this.pos >= this.string.length; }
  peek(): string | undefined { return this.pos < this.string.length ? this.string[this.pos] : undefined; }
  next(): string | undefined { return this.pos < this.string.length ? this.string[this.pos++] : undefined; }
  eat(m: string | RegExp) {
    const ch = this.peek();
    if (ch === undefined) return undefined;
    const ok = typeof m === 'string' ? ch === m : m.test(ch);
    if (ok) { this.pos++; return ch; }
    return undefined;
  }
  eatSpace() { const s = this.pos; while (/[\s ]/.test(this.string[this.pos] ?? '')) this.pos++; return this.pos > s; }
  skipToEnd() { this.pos = this.string.length; }
  match(pattern: string | RegExp, consume = true) {
    if (typeof pattern === 'string') {
      if (this.string.slice(this.pos, this.pos + pattern.length) === pattern) {
        if (consume) this.pos += pattern.length;
        return true;
      }
      return false;
    }
    const m = this.string.slice(this.pos).match(pattern);
    if (m && m.index === 0 && consume) this.pos += m[0].length;
    return m;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.fileindexdir')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.lfg') || name.endsWith('.lfg.glue')) out.push(full);
  }
  return out;
}

const files = walk(GRAMMARS).sort();
let lines = 0;
let tokens = 0;
let comments = 0;
const stalls: string[] = [];
/** Lines that open a comment but were classified as something else. */
const misread: string[] = [];

for (const full of files) {
  const path = relative(GRAMMARS, full);
  const text = readFileSync(full, 'utf8');
  const state = lfgStreamMode.startState();
  const docLines = text.split('\n');
  for (let i = 0; i < docLines.length; i++) {
    // A line starting with a quote opens a comment. Anything else means a line-start
    // rule beat the comment check, which is how commented-out entries came to be
    // highlighted as live ones.
    const opensComment = /^[ \t]*"/.test(docLines[i]) && !state.inComment;
    let firstToken: string | null | undefined;
    let firstAt = -1;

    const stream = new Stream(docLines[i]);
    lines++;
    let guard = 0;
    while (!stream.eol()) {
      stream.start = stream.pos;
      const before = stream.pos;
      const token = lfgStreamMode.token(stream as never, state);
      tokens++;
      if (firstAt < 0 && !/[ \t]/.test(docLines[i][before] ?? '')) {
        firstAt = before;
        firstToken = token;
      }
      if (stream.pos === before) {
        stalls.push(`${path}:${i + 1} col ${before}: token did not advance (${JSON.stringify(docLines[i].slice(before, before + 30))})`);
        break;
      }
      // A line cannot legitimately need more tokens than it has characters.
      if (++guard > docLines[i].length + 10) {
        stalls.push(`${path}:${i + 1}: runaway line (${guard} tokens for ${docLines[i].length} chars)`);
        break;
      }
    }

    if (opensComment) {
      comments++;
      if (firstToken !== 'comment') {
        misread.push(`${path}:${i + 1}: read as ${firstToken} — ${docLines[i].trim().slice(0, 50)}`);
      }
    }
  }
}

console.log(`files    ${files.length}`);
console.log(`lines    ${lines}`);
console.log(`tokens   ${tokens}`);
console.log(`comments ${comments - misread.length}/${comments} opening lines read as comments`);
if (misread.length) {
  console.error(`\n${misread.length} comment line(s) mis-tokenized:`);
  for (const m of misread.slice(0, 15)) console.error(`  ${m}`);
  process.exit(1);
}
if (stalls.length) {
  console.error(`\n${stalls.length} stall(s):`);
  for (const s of stalls.slice(0, 15)) console.error(`  ${s}`);
  process.exit(1);
}
console.log('\nOK — the stream always advanced.');
