/**
 * Tests for overlaying XLE's verdicts on a locally-tokenised sentence.
 *
 * The two tokenisers are independent — XLE's belongs to the grammar — so the overlay
 * has to survive them disagreeing rather than assuming they line up one-for-one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, type SentenceToken } from './lexicon-lookup';
import { applyXleVerdicts, isCovered, type XleToken, type XleVerdict } from './xle-coverage';

function reported(text: string, verdict: XleVerdict, stems: string[] = []): XleToken {
  return { text, variants: [text], from: 0, to: 0, verdict, stems };
}

const wordsOf = (tokens: SentenceToken[]) => tokens.filter((t) => t.word && t.spans > 0);

describe('applyXleVerdicts', () => {
  it('attaches each verdict to its word', () => {
    const tokens = tokenize('Kim saw a tractor');
    applyXleVerdicts(tokens, [
      reported('Kim', 'lexicon'),
      reported('saw', 'lexicon', ['see']),
      reported('a', 'lexicon'),
      reported('tractor', 'unknown-entry', ['tractor']),
    ]);
    assert.deepEqual(
      wordsOf(tokens).map((t) => t.xle?.verdict),
      ['lexicon', 'lexicon', 'lexicon', 'unknown-entry'],
    );
    assert.deepEqual(wordsOf(tokens)[1].xle?.stems, ['see']);
  });

  it('gives a repeated word the verdict reported for that occurrence', () => {
    // Matching by text alone would put both verdicts on the first `a`.
    const tokens = tokenize('a dog met a blurgy');
    applyXleVerdicts(tokens, [
      reported('a', 'lexicon'),
      reported('dog', 'unknown-entry'),
      reported('met', 'lexicon'),
      reported('a', 'lexicon'),
      reported('blurgy', 'unanalyzable'),
    ]);
    assert.deepEqual(
      wordsOf(tokens).map((t) => t.xle?.verdict),
      ['lexicon', 'unknown-entry', 'lexicon', 'lexicon', 'unanalyzable'],
    );
  });

  it('leaves a word alone when XLE did not report it', () => {
    // XLE's tokeniser drops punctuation and may emit artefacts we filter; a word it
    // never mentions must keep its local verdict rather than inherit a neighbour's.
    const tokens = tokenize('Kim slept');
    applyXleVerdicts(tokens, [reported('Kim', 'lexicon')]);
    const words = wordsOf(tokens);
    assert.equal(words[0].xle?.verdict, 'lexicon');
    assert.equal(words[1].xle, undefined);
  });

  it('matches a multiword reported as one token', () => {
    const tokens = tokenize('Kim left New York');
    const multiword: XleToken = {
      text: 'New York', variants: ['New York'], from: 0, to: 0,
      verdict: 'lexicon', stems: ['New York'],
    };
    applyXleVerdicts(tokens, [reported('Kim', 'lexicon'), reported('left', 'lexicon'), multiword]);
    const words = wordsOf(tokens);
    assert.equal(words[2].xle?.verdict, 'lexicon', 'New');
    assert.equal(words[3].xle?.verdict, 'lexicon', 'York');
  });
});

describe('isCovered', () => {
  it('counts a default or guessed analysis as covered, and nothing else', () => {
    assert.equal(isCovered('lexicon'), true);
    assert.equal(isCovered('unknown-entry'), true);
    // A guess still parses, which is what "covered" claims here.
    assert.equal(isCovered('guessed'), true);
    assert.equal(isCovered('no-entry'), false);
    assert.equal(isCovered('unanalyzable'), false);
  });
});
