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
    // The body hangs at column 10 — `min(10, column after the arrow)` — the open brace
    // pushes what follows to 12, and a leading `|` or `}` hangs two columns back to 10.
    const out = reindentExpression('ROOT --> { S (PERIOD)\n| Simp\n}.');
    assert.equal(out, [
      '   ROOT --> { S (PERIOD)',
      '          | Simp',
      '          }.',
    ].join('\n'));
  });

  it('indents nested braces two columns deeper each level', () => {
    const out = reindentExpression('VP --> { V\n{ NP\n| PP\n}\n| S\n}.');
    assert.deepEqual(out.split('\n').map((l) => l.length - l.trimStart().length),
      [3, 12, 12, 12, 10, 10]);
  });

  it('leaves everything above the head line alone', () => {
    // Standalone banner comments belong to the span of the entry that follows them.
    const source = '"""\nLexical rules\n"""\n\nPASS(FRAME) = { FRAME\n| FRAME\n}.';
    const out = reindentExpression(source);
    assert.ok(out.startsWith('"""\nLexical rules\n"""\n\n'), out.slice(0, 40));
    assert.ok(out.includes('   PASS(FRAME) = { FRAME'), out);
  });

  it('does not reindent lines inside a multi-line comment', () => {
    const source = 'X = "a comment\n    whose own indentation is content"\nY.';
    const out = reindentExpression(source);
    assert.ok(out.includes('    whose own indentation is content'), out);
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
