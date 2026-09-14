/**
 * Tests for checking a sentence against a lexicon.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseSentence, buildLexiconIndex, lemmaCandidates, tokenize, unescapeHeadword,
  type LexiconIndex,
} from './lexicon-lookup';
import { parseLfgFile } from './lfg-parser';
import type { GrammarUnit } from '../workspace/grammar-index';

/** A one-file grammar unit built from lexicon text. */
function grammarOf(body: string): GrammarUnit {
  const text = `A ENGLISH LEXICON (1.0)\n${body}\n----\n`;
  const file = parseLfgFile(text, { path: 'lex.lfg' });
  return {
    id: 'g', name: 'g', kind: 'grammar', mode: 'lfg',
    files: [file], groups: [], entryCount: 0, missing: [],
  };
}

const index = (body: string): LexiconIndex => buildLexiconIndex(grammarOf(body));

const marks = (sentence: string, lexicon: LexiconIndex) =>
  analyseSentence(sentence, lexicon).filter((t) => t.word).map((t) => `${t.text}:${t.match}`);

describe('unescapeHeadword', () => {
  it('reads a backquote as an escape, not a character', () => {
    assert.equal(unescapeHeadword('New` York'), 'New York');
    assert.equal(unescapeHeadword('four`-legged'), 'four-legged');
  });
});

describe('lemmaCandidates', () => {
  it('undoes the common English suffixes', () => {
    assert.ok(lemmaCandidates('eating').includes('eat'));
    assert.ok(lemmaCandidates('making').includes('make'));
    assert.ok(lemmaCandidates('walked').includes('walk'));
    assert.ok(lemmaCandidates('flies').includes('fly'));
    assert.ok(lemmaCandidates('dogs').includes('dog'));
    assert.ok(lemmaCandidates('quickly').includes('quick'));
  });

  it('undoes a doubled consonant', () => {
    assert.ok(lemmaCandidates('running').includes('run'));
    assert.ok(lemmaCandidates('stopped').includes('stop'));
  });

  it('leaves a word that is already a base form alone', () => {
    assert.ok(!lemmaCandidates('eat').includes('eat'));
  });

  it('keeps the capital a word came with', () => {
    // Suffixes are matched lower-case, but the grammar is not case-insensitive:
    // `Kim Laughs` does not parse against `laugh V-S XLE`, so suggesting `laugh` for
    // `Laughs` would send the fallback to an entry the grammar will not use here.
    assert.ok(lemmaCandidates('Laughs').includes('Laugh'));
    assert.ok(!lemmaCandidates('Laughs').includes('laugh'));
    assert.ok(lemmaCandidates('laughs').includes('laugh'));
  });
});

describe('analyseSentence', () => {
  it('finds a word the lexicon lists outright', () => {
    assert.deepEqual(marks('the dog', index('the D * @A.\ndog N * @B.')), ['the:exact', 'dog:exact']);
  });

  it('finds an inflection through the base form, when morphology supplies it', () => {
    // `eat V-S XLE` defers inflection to the morphological analyser, so *eating* is
    // covered even though it appears nowhere.
    assert.deepEqual(marks('eating', index('eat V-S XLE @A.')), ['eating:inflected']);
  });

  it('distinguishes a base form that supplies only itself', () => {
    // `*` means the entry gives exactly the form written, so the inflection may well
    // not parse — a different claim from the one above, and not worth the same green.
    assert.deepEqual(marks('eating', index('eat V * @A.')), ['eating:base-only']);
  });

  it('marks a word the lexicon has nothing for', () => {
    assert.deepEqual(marks('aardvark', index('dog N * @A.')), ['aardvark:missing']);
  });

  it('matches a multiword headword across tokens, longest first', () => {
    const lexicon = index('New` York N * @A.\nNew A * @B.');
    const tokens = analyseSentence('New York', lexicon).filter((t) => t.word);
    assert.equal(tokens[0].matched, 'New` York', 'the phrase wins over the single word');
    assert.equal(tokens[0].spans, 2);
    assert.equal(tokens[1].spans, 0, 'the second token is part of the same match');
  });

  it('falls back to the single word when the phrase is not there', () => {
    const tokens = analyseSentence('New house', index('New A * @B.')).filter((t) => t.word);
    assert.equal(tokens[0].match, 'exact');
    assert.equal(tokens[0].spans, 1);
    assert.equal(tokens[1].match, 'missing');
  });

  it('matches case, because the grammar does', () => {
    // `Kim laughs` parses and `Kim Laughs` does not: XLE folds no case, and a grammar
    // that wants a sentence-initial capital writes the entry twice. This one has
    // `the D *` and `The D *` on consecutive lines — separate entries a parse picks
    // between, which need not carry the same schemata.
    assert.deepEqual(marks('the', index('the D * @A.')), ['the:exact']);
    assert.deepEqual(marks('THE', index('the D * @A.')), ['THE:missing']);
    assert.deepEqual(marks('The', index('the D * @A.\nThe D * @B.')), ['The:exact']);
  });

  it('does not reach a lower-case entry through the stemmer either', () => {
    assert.deepEqual(marks('laughs', index('laugh V-S XLE @A.')), ['laughs:inflected']);
    assert.deepEqual(marks('Laughs', index('laugh V-S XLE @A.')), ['Laughs:missing']);
  });

  it('keeps punctuation out of the lookup but in the sentence', () => {
    const tokens = analyseSentence('a dog.', index('a D * @A.'));
    assert.deepEqual(tokens.map((t) => t.text), ['a', ' ', 'dog', '.']);
    assert.deepEqual(tokens.filter((t) => !t.word).map((t) => t.text), [' ', '.']);
  });
});

describe('tokenize', () => {
  it('keeps a hyphen or apostrophe inside a word', () => {
    assert.deepEqual(tokenize("don't four-legged").filter((t) => t.word).map((t) => t.text),
      ["don't", 'four-legged']);
  });

  it('records offsets that index the original sentence', () => {
    const sentence = 'a dog';
    for (const token of tokenize(sentence)) {
      assert.equal(sentence.slice(token.start, token.end), token.text);
    }
  });
});
