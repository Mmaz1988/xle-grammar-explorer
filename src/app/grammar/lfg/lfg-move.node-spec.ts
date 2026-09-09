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
import { moveEntry, detachEntry, applyEdits } from './lfg-move';
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
