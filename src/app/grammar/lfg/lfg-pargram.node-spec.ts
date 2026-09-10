/**
 * Constructs found in the ParGram English grammar.
 *
 * That grammar is not in this repository — it lives outside it and cannot be a fixture
 * — so the shapes it exposed are pinned here as small cases. Between them they took
 * that grammar from 40 parse warnings to none, and its entry points from seven files
 * apiece to twenty-four.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLfgFile, splitConfigItems, splitConfigRemovals } from './lfg-parser';

const section = (kind: string, body: string): string => `TEST ENGLISH ${kind} (1.0)\n${body}\n----\n`;

const names = (kind: string, body: string): string[] =>
  parseLfgFile(section(kind, body)).sections[0].entries.map((e) => e.name);

describe('rule macros with bracketed parameters', () => {
  it('names a macro whose parameters are in square brackets', () => {
    // ParGram writes `VP[perf,modal] = VP[perf,base]`; only parenthesised parameters
    // were recognised, so these were reported as unnamed.
    assert.deepEqual(names('RULES', 'VP[perf,modal] = VP[perf,base].'), ['VP[perf,modal]']);
    assert.deepEqual(names('RULES', 'CPembed[decl] = CP.'), ['CPembed[decl]']);
  });

  it('names a template whose parameters are separated by a space', () => {
    assert.deepEqual(names('TEMPLATES', 'SUBJ-OBJ_core (_P) = (^ PRED)=\'_P\'.'),
      ['SUBJ-OBJ_core (_P)']);
  });

  it('still refuses to read a constraining equation as a definition', () => {
    // `=c` and `==` are not definitions, whatever precedes them.
    const entries = parseLfgFile(section('RULES', 'S --> NP: (^ CASE) =c nom.')).sections[0].entries;
    assert.deepEqual(entries.map((e) => e.name), ['S']);
  });
});

describe('a period inside a headword', () => {
  it('recovers an entry split by an abbreviation', () => {
    // `b.` and `d.` — born and died — end in a period, which looks exactly like the
    // terminator that ends an entry. The front half names nothing, so it is joined to
    // what follows rather than reported.
    assert.deepEqual(names('LEXICON', 'b.   !V[pass]   *   @(V-SUBJ-OBJ bear).'), ['b.']);
    assert.deepEqual(names('LEXICON', 'b. !V * @A.\nd. !V * @B.'), ['b.', 'd.']);
  });

  it('leaves ordinary entries alone', () => {
    assert.deepEqual(names('LEXICON', 'dog N * @A.\ncat N * @B.'), ['dog', 'cat']);
  });
});

describe('config lists that adjust a base config', () => {
  it('reads a `+` entry as an addition, without its sign', () => {
    assert.deepEqual(splitConfigItems('FILES', '+eng-lex-ne-tags.lfg +english-index-features.lfg.'),
      ['eng-lex-ne-tags.lfg', 'english-index-features.lfg']);
  });

  it('keeps a `-` entry out of the items, and reports it as a removal', () => {
    const value = '+english-index-postags-morphconfig.lfg -english-index-morphconfig.lfg.';
    assert.deepEqual(splitConfigItems('FILES', value), ['english-index-postags-morphconfig.lfg']);
    assert.deepEqual(splitConfigRemovals('FILES', value), ['english-index-morphconfig.lfg']);
  });

  it('reads a signed section key', () => {
    assert.deepEqual(splitConfigItems('TEMPLATES', '+(INDEX ENGLISH) (STANDARD ENGLISH).'),
      ['INDEX ENGLISH', 'STANDARD ENGLISH']);
  });
});

describe('ParGram config keywords', () => {
  it('parses the fields a smaller grammar never uses', () => {
    // A field runs until the next known keyword, so an unrecognised one is not ignored
    // — the field before it swallows it. `CHARACTERENCODING` ran on through three.
    const config = parseLfgFile(
      'STANDARD ENGLISH CONFIG (1.0)\n' +
      '  ROOTCAT ROOT.\n' +
      '  REPARSECAT FRAGMENTS.\n' +
      '  CHARACTERENCODING utf-8.\n' +
      '  PERFORMANCEVARSFILE performance-vars.txt.\n' +
      '  ENCRYPTFILES eng-verb-lex.lfg.NOENCRYPT.\n' +
      '  BASECONFIGFILE english.lfg.\n' +
      '  FILES a.lfg.\n----\n',
    ).sections[0].config!;

    assert.deepEqual(config.map((f) => f.keyword), [
      'ROOTCAT', 'REPARSECAT', 'CHARACTERENCODING', 'PERFORMANCEVARSFILE',
      'ENCRYPTFILES', 'BASECONFIGFILE', 'FILES',
    ]);
    assert.deepEqual(config.find((f) => f.keyword === 'CHARACTERENCODING')!.items, ['utf-8']);
    assert.deepEqual(config.find((f) => f.keyword === 'BASECONFIGFILE')!.items, ['english.lfg']);
  });
});
