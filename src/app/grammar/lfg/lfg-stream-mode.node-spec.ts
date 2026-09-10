/**
 * Tests for what the highlighter actually classifies things as.
 *
 * The tokenizer harness only checks that the stream keeps advancing, which a rule can
 * do perfectly while matching nothing it was meant to. These assert the token a piece
 * of text is given.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lfgStreamMode } from './lfg-stream-mode';

/** The minimum of CodeMirror's StringStream the mode uses. */
class Stream {
  pos = 0;
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
  eatSpace() { const s = this.pos; while (/\s/.test(this.string[this.pos] ?? '')) this.pos++; return this.pos > s; }
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

/** Tokenize one line, returning `[text, token]` pairs. */
function tokens(line: string): Array<[string, string | null]> {
  const state = lfgStreamMode.startState();
  const stream = new Stream(line);
  const out: Array<[string, string | null]> = [];
  while (!stream.eol()) {
    const start = stream.pos;
    const token = lfgStreamMode.token(stream as never, state);
    if (stream.pos === start) throw new Error(`stalled at ${start} in ${JSON.stringify(line)}`);
    out.push([line.slice(start, stream.pos), token]);
  }
  return out;
}

/** What, if anything, the headword of a line was classified as. */
const headwordToken = (line: string): string | null | undefined =>
  tokens(line).find(([text]) => text.trim() !== '')?.[1];

describe('lexical headwords', () => {
  it('highlights a headword whose morphcode is `*`', () => {
    // A boundary after `*` needs a word character next, and a morphcode is always
    // followed by space — so `\b` matched XLE entries and no `*` ones at all. lfg-mode
    // ends its own rule `\\(\\*\\|XLE\\)`, with nothing after it.
    assert.equal(headwordToken('Leading A * @(DEFAULT-ADJ-SEM %stem).'), 'keyword');
    assert.equal(headwordToken('leading A *  @(DEFAULT-ADJ-SEM %stem).'), 'keyword');
  });

  it('highlights a headword whose morphcode is XLE', () => {
    assert.equal(headwordToken('hug V-S XLE @(TRANS-EV %stem);ETC.'), 'keyword');
  });

  it('highlights a multiword headword written with a backquote', () => {
    assert.equal(headwordToken('more` important  A *        { @(PRED %stem)'), 'keyword');
    assert.equal(headwordToken('New` York N *   (^ PRED)=\'New` York\''), 'keyword');
  });

  it('highlights a punctuation headword', () => {
    assert.equal(headwordToken('. \t  PERIOD * (^ STMT-TYPE) = declarative.'), 'keyword');
  });

  it('leaves an ordinary schema line alone', () => {
    // Only a headword line gets the keyword face; its constraints do not.
    assert.notEqual(headwordToken('        (^ NUM) = sg'), 'keyword');
  });
});

describe('token names', () => {
  it('uses names CodeMirror does not already claim', () => {
    // `builtin` and `variable` are in CodeMirror's own stream-language table, which
    // wins over ours — so a brace resolved near variableName and came out the same
    // colour as a `%local`.
    const brace = tokens('X = { A | B }.').find(([t]) => t === '{');
    assert.equal(brace?.[1], 'lfgOperator');
    const local = tokens('X = %stem.').find(([t]) => t === '%stem');
    assert.equal(local?.[1], 'lfgLocal');
    assert.notEqual(brace?.[1], local?.[1], 'and the two must not collide');
  });
});

describe('the two meanings of @', () => {
  it('marks a template call but not glue application', () => {
    const call = tokens('@(PRED %stem)').find(([t]) => t === '@');
    assert.equal(call?.[1], 'lfgOperator');
    const application = tokens(':$ (\\V.V@e)').find(([t]) => t === '@');
    assert.equal(application?.[1], null, 'application is not an operator here');
  });
});
