/**
 * Tests for moving an entry between sections.
 *
 * This is the only operation that rewrites a grammar structurally, so the tests check
 * the result by *re-parsing* it: the entry must appear in the target section, be gone
 * from the source, and the file's other entries must survive untouched. Asserting on
 * the text alone would miss a splice that lands inside another entry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moveEntry, detachEntry, applyEdits, reorderEntries, movePermutation, sortPermutation } from './lfg-move';
import { parseLfgFile } from './lfg-parser';

const GRAMMARS = join(process.cwd(), 'grammars');

function sectionOf(text: string, key: string) {
  const file = parseLfgFile(text);
  return file.sections.find((s) => s.key === key)!;
}

function entryNames(text: string, key: string): string[] {
  return sectionOf(text, key).entries.map((e) => e.name);
}

describe('applyEdits', () => {
  it('applies back to front so offsets stay valid', () => {
    const out = applyEdits('abcdef', [
      { from: 1, to: 2, insert: 'X' },
      { from: 4, to: 5, insert: 'YY' },
    ]);
    assert.equal(out, 'aXcdYYf');
  });
});

describe('detachEntry', () => {
  it('drops the leading blank lines an entry span carries', () => {
    assert.equal(detachEntry('\n\n   hug V-S XLE @X.'), '   hug V-S XLE @X.');
  });
});

describe('moveEntry between two files', () => {
  const source = 'A ENGLISH LEXICON (1.0)\nfirst N * (^ NUM)=sg.\nhug V-S XLE @(TRANS-EV %stem).\nlast N * (^ NUM)=pl.\n----\n';
  const target = 'B ENGLISH LEXICON (1.0)\nother N * (^ NUM)=sg.\n----\n';

  it('removes from the source and adds to the target', () => {
    const entry = sectionOf(source, 'A ENGLISH').entries.find((e) => e.name === 'hug')!;
    const result = moveEntry({
      sourceText: source, from: entry.start, to: entry.end,
      targetText: target, at: sectionOf(target, 'B ENGLISH').end, sameFile: false,
    });

    assert.deepEqual(entryNames(result.sourceText, 'A ENGLISH'), ['first', 'last']);
    assert.deepEqual(entryNames(result.targetText, 'B ENGLISH'), ['other', 'hug']);
    assert.ok(result.targetText.includes('@(TRANS-EV %stem)'), 'the body came with it');
    assert.ok(result.targetText.trimEnd().endsWith('----'), 'still inside the section');
  });

  it('leaves the source alone when copying', () => {
    const entry = sectionOf(source, 'A ENGLISH').entries.find((e) => e.name === 'hug')!;
    const result = moveEntry({
      sourceText: source, from: entry.start, to: entry.end,
      targetText: target, at: sectionOf(target, 'B ENGLISH').end, sameFile: false, copy: true,
    });
    assert.deepEqual(entryNames(result.sourceText, 'A ENGLISH'), ['first', 'hug', 'last']);
    assert.deepEqual(entryNames(result.targetText, 'B ENGLISH'), ['other', 'hug']);
  });

  it('reveals the entry where it landed', () => {
    const entry = sectionOf(source, 'A ENGLISH').entries.find((e) => e.name === 'hug')!;
    const result = moveEntry({
      sourceText: source, from: entry.start, to: entry.end,
      targetText: target, at: sectionOf(target, 'B ENGLISH').end, sameFile: false,
    });
    const shown = result.targetText.slice(result.insertedAt.start, result.insertedAt.end);
    assert.ok(shown.includes('hug'), `expected the entry, got ${JSON.stringify(shown)}`);
  });
});

describe('moveEntry within one file', () => {
  const doc = [
    'A ENGLISH LEXICON (1.0)',
    'alpha N * (^ NUM)=sg.',
    'beta N * (^ NUM)=sg.',
    '----',
    'B ENGLISH LEXICON (1.0)',
    'gamma N * (^ NUM)=sg.',
    '----',
  ].join('\n');

  it('moves forward without corrupting the insertion point', () => {
    // The removal sits before the insertion point, so a naive splice inserts at a
    // stale offset and lands inside another entry.
    const entry = sectionOf(doc, 'A ENGLISH').entries.find((e) => e.name === 'alpha')!;
    const result = moveEntry({
      sourceText: doc, from: entry.start, to: entry.end,
      targetText: doc, at: sectionOf(doc, 'B ENGLISH').end, sameFile: true,
    });
    assert.deepEqual(entryNames(result.targetText, 'A ENGLISH'), ['beta']);
    assert.deepEqual(entryNames(result.targetText, 'B ENGLISH'), ['gamma', 'alpha']);
  });

  it('moves backward too', () => {
    const entry = sectionOf(doc, 'B ENGLISH').entries.find((e) => e.name === 'gamma')!;
    const result = moveEntry({
      sourceText: doc, from: entry.start, to: entry.end,
      targetText: doc, at: sectionOf(doc, 'A ENGLISH').end, sameFile: true,
    });
    assert.deepEqual(entryNames(result.targetText, 'A ENGLISH'), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(entryNames(result.targetText, 'B ENGLISH'), []);
  });
});

describe('moveEntry on a real grammar file', () => {
  it('moves a lexical entry between two real lexica without losing anything', () => {
    const dir = join(GRAMMARS, 'dev/lfgxdrt_inference_grammar/lexica');
    const verbs = readFileSync(join(dir, 'verblex_fracas.lfg.glue'), 'utf8');
    const nouns = readFileSync(join(dir, 'nounlex_fracas.lfg.glue'), 'utf8');

    const verbSection = verbs.match(/^(\S+)\s+(\S+)\s+LEXICON/m)!;
    const verbKey = `${verbSection[1]} ${verbSection[2]}`;
    const nounSection = nouns.match(/^(\S+)\s+(\S+)\s+LEXICON/m)!;
    const nounKey = `${nounSection[1]} ${nounSection[2]}`;

    const before = entryNames(verbs, verbKey);
    const hug = sectionOf(verbs, verbKey).entries.find((e) => e.name === 'hug')!;

    const result = moveEntry({
      sourceText: verbs, from: hug.start, to: hug.end,
      targetText: nouns, at: sectionOf(nouns, nounKey).end, sameFile: false,
    });

    const after = entryNames(result.sourceText, verbKey);
    assert.equal(after.length, before.length - 1, 'exactly one entry left the source');
    assert.ok(!after.includes('hug'));
    assert.deepEqual(after, before.filter((n) => n !== 'hug'), 'nothing else moved');

    const landed = entryNames(result.targetText, nounKey);
    assert.equal(landed[landed.length - 1], 'hug', 'it arrived at the end of the target');
    assert.equal(landed.length, entryNames(nouns, nounKey).length + 1);
  });
});

describe('reorderEntries', () => {
  const doc = 'A ENGLISH LEXICON (1.0)\ncharlie N * @C.\n\nalpha N * @A.\nbravo N * @B.\n----\n';
  const spans = () => sectionOf(doc, 'A ENGLISH').entries.map((e) => ({ start: e.start, end: e.end }));

  it('sorts entries without losing or duplicating any', () => {
    const names = sectionOf(doc, 'A ENGLISH').entries.map((e) => e.name);
    const out = reorderEntries(doc, spans(), sortPermutation(names));
    assert.deepEqual(entryNames(out, 'A ENGLISH'), ['alpha', 'bravo', 'charlie']);
    assert.ok(out.includes('@A') && out.includes('@B') && out.includes('@C'), 'bodies survived');
  });

  it('leaves the separators between entries where they were', () => {
    // The blank line after the first entry stays after the *first* entry, rather than
    // travelling with the entry that used to follow it.
    const names = sectionOf(doc, 'A ENGLISH').entries.map((e) => e.name);
    const out = reorderEntries(doc, spans(), sortPermutation(names));
    assert.ok(/alpha N \* @A\.\n\nbravo/.test(out), out);
  });

  it('never glues two entries onto one line, whatever the permutation', () => {
    // The first span carries no leading newline, so permuting the spans themselves
    // would run whichever entry lands first straight into the one after it.
    const s = spans();
    for (const order of [[2, 1, 0], [1, 2, 0], [2, 0, 1], [0, 2, 1]]) {
      const out = reorderEntries(doc, s, order);
      assert.deepEqual(entryNames(out, 'A ENGLISH').length, 3, `order ${order}`);
      // Every entry must start a line of its own.
      const perLine = out.split('\n').map((line) => (line.match(/N \* @/g) ?? []).length);
      assert.ok(perLine.every((n) => n <= 1), `order ${order} put two entries on one line: ${out}`);
    }
  });

  it('moves one entry to a new position', () => {
    const out = reorderEntries(doc, spans(), movePermutation(3, 0, 3));
    assert.deepEqual(entryNames(out, 'A ENGLISH'), ['alpha', 'bravo', 'charlie']);
  });

  it('sorts on compound keys, most significant first', () => {
    const order = sortPermutation([['V', 'run'], ['N', 'zebra'], ['V', 'go'], ['N', 'apple']]);
    assert.deepEqual(order, [3, 1, 2, 0]);
  });

  it('keeps ties in their original order', () => {
    // Stability is what makes re-sorting an already sorted section a no-op.
    assert.deepEqual(sortPermutation([['N', 'a'], ['N', 'a'], ['N', 'a']]), [0, 1, 2]);
  });

  it('sorts a real lexicon losslessly', () => {
    const path = join(GRAMMARS, 'dev/lfgxdrt_inference_grammar/lexica/nounlex_fracas.lfg.glue');
    const text = readFileSync(path, 'utf8');
    const key = text.match(/^(\S+)\s+(\S+)\s+LEXICON/m)!;
    const sectionKey = `${key[1]} ${key[2]}`;
    const entries = sectionOf(text, sectionKey).entries;

    const out = reorderEntries(
      text,
      entries.map((e) => ({ start: e.start, end: e.end })),
      sortPermutation(entries.map((e) => e.name)),
    );

    const before = entries.map((e) => e.name).slice().sort();
    const after = entryNames(out, sectionKey).slice().sort();
    assert.deepEqual(after, before, 'the same entries, no more and no fewer');
    assert.equal(out.length, text.length, 'not one character gained or lost');
  });
});
