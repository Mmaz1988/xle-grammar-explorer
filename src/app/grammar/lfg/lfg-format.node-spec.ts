/**
 * Tests for `M-q` reindenting.
 *
 * The safety property matters more than the cosmetics: reindenting must never alter
 * anything but leading whitespace. A formatter that quietly rewrites the inside of a
 * comment — and in these grammars comments hold commented-out entries — loses work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expressionRangeAt, reindentExpression } from './lfg-format';
import { parseLfgFile } from './lfg-parser';

// Resolved from the working directory: these specs run compiled, from `.harness/`.
const GRAMMARS = join(process.cwd(), 'grammars');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.fileindexdir')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.lfg') || name.endsWith('.lfg.glue')) out.push(full);
  }
  return out;
}

describe('reindentExpression', () => {
  it('indents a rule body under the arrow and hangs the disjunction delimiters', () => {
    // The head line is flush left; continuations line up under the first daughter
    // (column 9 here), the open brace pushes what follows two further, and a leading
    // `|` or `}` hangs two back.
    const out = reindentExpression('ROOT --> { S (PERIOD)\n| Simp\n}.');
    assert.equal(out, [
      'ROOT --> { S (PERIOD)',
      '         | Simp',
      '         }.',
    ].join('\n'));
  });

  it('lines a rule\'s daughters up under the first one', () => {
    // The point of aligning by kind: daughters sit beneath each other rather than at a
    // fixed column that has nothing to do with the arrow.
    const out = reindentExpression('S --> (ADVP)\nNP\nVP.');
    const [head, ...rest] = out.split('\n');
    const firstDaughter = head.indexOf('(ADVP)');
    for (const line of rest) {
      assert.equal(line.length - line.trimStart().length, firstDaughter, line);
    }
  });

  it('keeps the indentation the author chose when they broke after the arrow', () => {
    // The first daughter is on its own line, so it is what everything aligns with —
    // rather than a fixed column that ignores where the line was broken.
    // Plain daughters, no annotations — those align under their own colon instead.
    const out = reindentExpression('AP[_type $ {x y}] -->\n           e\n           ADV.');
    assert.deepEqual(out.split('\n').map((l) => l.length - l.trimStart().length), [0, 11, 11]);
  });

  it('indents by eight when the broken line would sit level with the head', () => {
    // Nothing to align with: a flush-left continuation under a flush-left head reads
    // as a second definition rather than as this one's body.
    const out = reindentExpression('AP[_type $ {x y}] -->\ne\nADV.');
    assert.deepEqual(out.split('\n').map((l) => l.length - l.trimStart().length), [0, 8, 8]);
  });

  it("indents a daughter's annotations under its own colon", () => {
    // lfg-format-rule-category skips the category and the colon, then formats the
    // constraints from there — so schemata sit under their own daughter rather than
    // under the column its siblings share.
    const out = reindentExpression('CPrel --> PRON: (! PRON-TYPE) =c rel\n(^ TOPIC) = !\n(^ CASE) = nom;\nVP[fin].');
    const lines = out.split('\n');
    const annotation = lines[0].indexOf('(! PRON-TYPE)');
    assert.equal(lines[1].length - lines[1].trimStart().length, annotation, lines[1]);
    assert.equal(lines[2].length - lines[2].trimStart().length, annotation, lines[2]);
    // The `;` closes the block, so the next daughter returns to the daughter column.
    assert.equal(lines[3].length - lines[3].trimStart().length, lines[0].indexOf('PRON'), lines[3]);
  });

  it("closes an annotation when the daughter's own parenthesis closes", () => {
    // `(NP: ... )` ends with the paren, not a semicolon.
    const out = reindentExpression('S --> A\n(NP: (^ SUBJ) = !\n(^ OBJ) = !)\nVP.');
    const lines = out.split('\n');
    const daughter = lines[1].length - lines[1].trimStart().length;
    assert.ok(lines[2].length - lines[2].trimStart().length > daughter, 'annotation is indented');
    assert.equal(lines[3].length - lines[3].trimStart().length, daughter, 'and then it returns');
  });

  it('lines every disjunction delimiter up with the others', () => {
    // lfg-mode outdents `| ` by two and a bare `|` by one, so the separators of one
    // disjunction land in different columns depending on whether a space follows.
    const out = reindentExpression('VP --> V\n{ A\n|\nB\n| C\n}.');
    const pipes = out.split('\n')
      .filter((line) => line.trimStart().startsWith('|') || line.trimStart().startsWith('}'))
      .map((line) => line.length - line.trimStart().length);
    assert.equal(new Set(pipes).size, 1, `delimiters at mixed columns: ${pipes}`);
  });

  it('aligns a lexical entry\'s schemata under the head line', () => {
    // A lexical head carries no `-->` and no `=`; finding the head by operator alone
    // once formatted from halfway down the entry instead.
    const out = reindentExpression('hug V-S XLE @(TRANS-EV %stem)\n@(OTHER).');
    const lines = out.split('\n');
    assert.equal(lines[1].length - lines[1].trimStart().length, lines[0].indexOf('@(TRANS-EV'));
  });

  it('recognises a `*` morphcode head, not only XLE', () => {
    // `\b` after `*` needs a word character next, but a morphcode is always followed by
    // space — so every `*` entry failed head detection and formatting restarted at the
    // first line holding an `=`, part-way down the entry. That is 1044 of the corpus's
    // 1448 lexical entries.
    const out = reindentExpression('dog    N * (^ NUM)=sg\n(^ PRED)=\'dog\'.');
    const lines = out.split('\n');
    assert.equal(lines[0].length - lines[0].trimStart().length, 0, 'the head line is the head line');
    assert.equal(lines[1].length - lines[1].trimStart().length, lines[0].indexOf('(^ NUM)'),
      'and its schemata align under the first one');
  });

  it('formats a nested disjunction in a real lexical entry', () => {
    // `more` important` in adj_adv_lex: a `*` entry, a multiword headword, and two
    // levels of disjunction — the case that surfaced the bug.
    const path = join(GRAMMARS, 'dev/lfgxdrt_inference_grammar/lexica/adj_adv_lex_fracas.lfg.glue');
    const text = readFileSync(path, 'utf8');
    const range = expressionRangeAt(text, text.indexOf('more` important') + 3)!;
    const out = reindentExpression(text.slice(range.from, range.to)).replace(/^\n+/, '');
    const lines = out.split('\n');

    assert.ok(lines[0].startsWith('more` important'), 'the head line stays put');
    // Each `|` and `}` lines up with the others at its own nesting level.
    const at = (needle: string) => lines
      .filter((l) => l.trimStart().startsWith(needle))
      .map((l) => l.length - l.trimStart().length);
    const pipes = at('|');
    assert.equal(new Set(pipes).size, 2, `two nesting levels, got columns ${pipes}`);
    assert.deepEqual(at('}'), pipes, 'closers match their openers');
  });

  it('measures tabs to the next eight-column stop', () => {
    // `hug` ends at column 3, the tab jumps to the stop at 8, `V-S XLE ` runs to 16 —
    // so the continuation is 16 even though the tab is a single character.
    const out = reindentExpression('hug\tV-S XLE @(TRANS-EV %stem)\n@(OTHER).');
    const second = out.split('\n')[1];
    assert.equal(second.length - second.trimStart().length, 16);
  });

  it('indents nested braces two columns deeper each level', () => {
    const out = reindentExpression('VP --> { V\n{ NP\n| PP\n}\n| S\n}.');
    assert.deepEqual(out.split('\n').map((l) => l.length - l.trimStart().length),
      [0, 9, 9, 9, 7, 7]);
  });

  it('leaves everything above the head line alone', () => {
    // Standalone banner comments belong to the span of the entry that follows them.
    const source = '"""\nLexical rules\n"""\n\nPASS(FRAME) = { FRAME\n| FRAME\n}.';
    const out = reindentExpression(source);
    assert.ok(out.startsWith('"""\nLexical rules\n"""\n\n'), out.slice(0, 40));
    assert.ok(out.includes('\nPASS(FRAME) = { FRAME'), out);
  });

  it('does not reindent lines inside a multi-line comment', () => {
    const source = 'X = "a comment\n    whose own indentation is content"\nY.';
    const out = reindentExpression(source);
    assert.ok(out.includes('    whose own indentation is content'), out);
  });

  it('gives the same result whatever the input indentation', () => {
    // The alignment columns are measured from the indent a line is being *given*. Using
    // the line with its original leading whitespace counted that twice, so a nested
    // annotation drifted further right the more indented its source was.
    const flat = 'S --> A\n(NP: (^ SUBJ) = !\n(^ OBJ) = !)\nVP.';
    const indented = 'S --> A\n        (NP: (^ SUBJ) = !\n                (^ OBJ) = !)\n        VP.';
    assert.equal(reindentExpression(indented), reindentExpression(flat));
  });

  it('is idempotent across the whole corpus', () => {
    // Reindenting an already-reindented entry must be a no-op. Anything that measures a
    // column from the text it just produced drifts instead, which is how the
    // double-counted indent showed up.
    let checked = 0;
    for (const full of walk(GRAMMARS)) {
      const text = readFileSync(full, 'utf8');
      const file = parseLfgFile(text, { path: relative(GRAMMARS, full) });
      for (const section of file.sections) {
        for (const entry of section.entries) {
          if (entry.kind === 'config-field' || entry.kind === 'morph-field') continue;
          const once = reindentExpression(text.slice(entry.start, entry.end));
          assert.equal(reindentExpression(once), once,
            `not stable in ${relative(GRAMMARS, full)}:${entry.line} (${entry.name})`);
          checked++;
        }
      }
    }
    assert.ok(checked > 3000, `expected the whole corpus, checked ${checked}`);
  });

  it('changes nothing but leading whitespace, across the whole corpus', () => {
    // The property that keeps this safe to bind to a keystroke.
    let checked = 0;
    for (const full of walk(GRAMMARS)) {
      const text = readFileSync(full, 'utf8');
      const file = parseLfgFile(text, { path: relative(GRAMMARS, full) });
      for (const section of file.sections) {
        for (const entry of section.entries) {
          if (entry.kind === 'config-field' || entry.kind === 'morph-field') continue;
          const before = text.slice(entry.start, entry.end);
          const after = reindentExpression(before);
          const strip = (s: string) => s.split('\n').map((l) => l.trimStart()).join('\n');
          assert.equal(strip(after), strip(before),
            `content changed in ${relative(GRAMMARS, full)}:${entry.line} (${entry.name})`);
          checked++;
        }
      }
    }
    assert.ok(checked > 3000, `expected the whole corpus, checked ${checked}`);
  });
});

describe('expressionRangeAt', () => {
  it('finds the entry containing a position', () => {
    const doc = 'TEST ENGLISH RULES (1.0)\nS --> NP VP.\nVP --> V NP.\n----\n';
    const range = expressionRangeAt(doc, doc.indexOf('VP --> V') + 2)!;
    assert.equal(doc.slice(range.from, range.to).trim(), 'VP --> V NP.');
  });

  it('returns nothing outside any entry', () => {
    assert.equal(expressionRangeAt('no sections here at all', 5), undefined);
  });
});
