/**
 * Tests for overlaying XLE's verdicts on a locally-tokenised sentence.
 *
 * The two tokenisers are independent — XLE's belongs to the grammar — so the overlay
 * has to survive them disagreeing rather than assuming they line up one-for-one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, type SentenceToken } from './lexicon-lookup';
import type { LexiconHit, LexiconIndex } from './lexicon-lookup';
import {
  applyXleVerdicts, isCovered, matchesFor, resolveXleHits, surfaceMatches,
  unknownEntry, unknownEntryFor, usesUnknownEntry,
  type XleReading, type XleToken, type XleVerdict,
} from './xle-coverage';

function reported(
  text: string, verdict: XleVerdict, stems: string[] = [], readings?: XleReading[],
): XleToken {
  return { text, variants: [text], from: 0, to: 0, verdict, stems, readings };
}

/** `train +Verb +Pres +Non3sg` as the service reports it. */
const reading = (stem: string, ...tags: string[]): XleReading => ({ stem, tags });

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

function hit(headword: string, path: string, line: number): LexiconHit {
  return { headword, path, line, span: { start: 0, end: 1 } };
}

/** A lexicon holding `see` and the grammar's `-unknown` entry, and nothing else. */
function lexicon(): LexiconIndex {
  return new Map([
    ['see', [hit('see', 'lexica/verblex.lfg.glue', 196)]],
    ['-unknown', [hit('-unknown', 'morph.lfg.glue', 74)]],
  ]);
}

describe('resolveXleHits', () => {
  it('follows an irregular form to the stem XLE used', () => {
    // Our own stemmer cannot get from `saw` to `see`; XLE reports the stem outright.
    const tokens = tokenize('Kim saw it');
    applyXleVerdicts(tokens, [
      reported('Kim', 'lexicon'),
      reported('saw', 'lexicon', ['see', 'saw']),
      reported('it', 'lexicon'),
    ]);
    resolveXleHits(tokens, lexicon());

    const saw = wordsOf(tokens)[1];
    assert.equal(saw.matched, 'see');
    assert.equal(saw.hits[0]?.line, 196);
    assert.equal(saw.viaUnknown, false);
  });

  it('points a word covered only by default at the -unknown entry', () => {
    const tokens = tokenize('a tractor');
    applyXleVerdicts(tokens, [
      reported('a', 'lexicon'),
      reported('tractor', 'unknown-entry', ['tractor']),
    ]);
    resolveXleHits(tokens, lexicon());

    const tractor = wordsOf(tokens)[1];
    assert.equal(tractor.matched, '-unknown');
    assert.equal(tractor.hits[0]?.line, 74, 'opens the entry actually responsible');
    assert.equal(tractor.viaUnknown, true);
  });

  it('does the same for a guessed word, which is covered the same way', () => {
    const tokens = tokenize('blurgy');
    applyXleVerdicts(tokens, [reported('blurgy', 'guessed', ['blurgy'])]);
    resolveXleHits(tokens, lexicon());
    assert.equal(wordsOf(tokens)[0].viaUnknown, true);
  });

  it('leaves a word XLE rejected with nothing to open', () => {
    const tokens = tokenize('blurgy');
    applyXleVerdicts(tokens, [reported('blurgy', 'unanalyzable')]);
    resolveXleHits(tokens, lexicon());
    assert.deepEqual(wordsOf(tokens)[0].hits, []);
  });

  it('offers nothing when the grammar has no -unknown entry', () => {
    // Not every grammar guesses; inventing a target would send the click nowhere.
    const tokens = tokenize('tractor');
    applyXleVerdicts(tokens, [reported('tractor', 'unknown-entry', ['tractor'])]);
    resolveXleHits(tokens, new Map([['see', [hit('see', 'v.lfg', 1)]]]));
    assert.deepEqual(wordsOf(tokens)[0].hits, []);
  });
});

describe('matchesFor', () => {
  it('keeps one row per reading, even when they share a stem', () => {
    // The whole point of the popup: `train` is one stem with two analyses, and the
    // tags are what tells them apart. Collapsing by stem would hide the ambiguity
    // that makes the word green in a sentence that does not parse.
    const tokens = tokenize('Kim sees a train');
    applyXleVerdicts(tokens, [
      reported('Kim', 'lexicon'),
      reported('sees', 'lexicon', ['see']),
      reported('a', 'lexicon'),
      reported('train', 'lexicon', ['train'], [
        reading('train', '+Verb', '+Pres', '+Non3sg'),
        reading('train', '+Noun', '+Sg'),
      ]),
    ]);
    const index: LexiconIndex = new Map([
      ['train', [hit('train', 'lexica/verblex.lfg.glue', 212)]],
    ]);

    const rows = matchesFor(wordsOf(tokens)[3], index);
    assert.deepEqual(rows.map((r) => r.reading.tags.join(' ')), [
      '+Verb +Pres +Non3sg',
      '+Noun +Sg',
    ]);
    // Both rows reach the same entry, because the entry is for the stem. Which of the
    // two analyses it actually backs is not something the lexicon can say.
    assert.deepEqual(rows.map((r) => r.hits.map((h) => h.line)), [[212], [212]]);
  });

  it('reports a stem the lexicon does not have rather than dropping the row', () => {
    const tokens = tokenize('Kim walks');
    applyXleVerdicts(tokens, [
      reported('Kim', 'lexicon'),
      reported('walks', 'unknown-entry', ['walk'], [
        reading('walk', '+Verb', '+Pres', '+3sg'),
        reading('walk', '+Noun', '+Pl'),
      ]),
    ]);
    const rows = matchesFor(wordsOf(tokens)[1], lexicon());
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.hits.length === 0), 'walk is in no lexicon here');
  });

  it('finds the entry for a multiword stem', () => {
    // A multiword headword analyses as one stem, so the lookup key has spaces in it.
    const tokens = tokenize('Kim took a swim');
    applyXleVerdicts(tokens, [
      reported('Kim', 'lexicon'),
      reported('took a swim', 'lexicon', ['take a swim'], [
        reading('take a swim', '+Verb', '+PastTense'),
      ]),
    ]);
    const index: LexiconIndex = new Map([
      ['take a swim', [hit('take` a` swim', 'lexica/verblex.lfg.glue', 44)]],
    ]);
    assert.deepEqual(matchesFor(wordsOf(tokens)[1], index)[0].hits.map((h) => h.line), [44]);
  });

  it('has no rows when nothing asked XLE', () => {
    const tokens = tokenize('Kim walks');
    assert.deepEqual(matchesFor(wordsOf(tokens)[0], lexicon()), []);
  });
});

describe('unknownEntry', () => {
  it('finds the default entry, so it can be offered beside a word\'s own', () => {
    assert.deepEqual(unknownEntry(lexicon()).map((h) => h.line), [74]);
  });

  it('is empty in a grammar without one', () => {
    assert.deepEqual(unknownEntry(new Map()), []);
  });
});

describe('words matched by a `*` entry, which have no stem at all', () => {
  /** `the D *` and `PC-6082 N *` — matched as the token, keyed by the form. */
  function starLexicon(): LexiconIndex {
    return new Map([
      ['the', [hit('the', 'lexica/detpronlex_fracas.lfg.glue', 242)]],
      ['pc-6082', [hit('PC-6082', 'lexica/nounlex_fracas.lfg.glue', 133)]],
      ['-unknown', [hit('-unknown', 'morph_fracas.lfg.glue', 74)]],
    ]);
  }

  /**
   * An entry with morphcode `*` matches the token, so the morphology's stem edges are
   * dead and XLE returns the word covered with nothing under it. Looking only at the
   * stems finds nothing and falls through to `-unknown`, which reports a word with a
   * perfectly good entry as analysed by default.
   */
  it('finds the entry under the surface form', () => {
    const tokens = tokenize('The PC-6082 is fast');
    applyXleVerdicts(tokens, [
      reported('The', 'lexicon'),
      reported('PC-6082', 'lexicon'),
      reported('is', 'lexicon', ['be']),
      reported('fast', 'lexicon', ['fast']),
    ]);
    resolveXleHits(tokens, starLexicon());

    const words = wordsOf(tokens);
    assert.deepEqual(words[0].hits.map((h) => h.line), [242], 'The → the D *');
    assert.deepEqual(words[1].hits.map((h) => h.line), [133], 'PC-6082 → N *');
    assert.ok(!words[0].viaUnknown, 'the has an entry and must not read as defaulted');
    assert.ok(!words[1].viaUnknown);
  });

  it('still gives the popup a row to show', () => {
    const tokens = tokenize('The PC-6082 is fast');
    applyXleVerdicts(tokens, [reported('The', 'lexicon')]);
    resolveXleHits(tokens, starLexicon());

    const word = wordsOf(tokens)[0];
    // No reading, so no row from the analyses — the entry still has to be reachable.
    assert.deepEqual(matchesFor(word, starLexicon()), []);
    const rows = surfaceMatches(word, starLexicon());
    assert.deepEqual(rows.map((r) => r.reading.tags), [[]]);
    assert.deepEqual(rows[0].hits.map((h) => h.line), [242]);
  });
});

describe('usesUnknownEntry', () => {
  it('is false for a word that matched an entry of its own', () => {
    // `than CComp *` needs no default analysis, and offering `-unknown` beside it
    // reads as a second entry for the word — which is what it looked like in the bar.
    assert.equal(usesUnknownEntry('lexicon'), false);
    assert.equal(usesUnknownEntry('unknown-entry'), true);
    assert.equal(usesUnknownEntry('guessed'), true);
    assert.equal(usesUnknownEntry('no-entry'), false);
    assert.equal(usesUnknownEntry('unanalyzable'), false);
  });

  it('leaves a word with no entry to open rather than blaming -unknown', () => {
    // XLE says an entry matched; we cannot find it — ParGram ciphers its headwords, so
    // this is the normal case there. Nothing was defaulted, so pointing at `-unknown`
    // would invent a reason the grammar never used.
    const tokens = tokenize('Kim');
    applyXleVerdicts(tokens, [reported('Kim', 'lexicon')]);
    resolveXleHits(tokens, new Map([
      ['-unknown', [hit('-unknown', 'morph_fracas.lfg.glue', 74)]],
    ]));
    assert.deepEqual(wordsOf(tokens)[0].hits, []);
    assert.ok(!wordsOf(tokens)[0].viaUnknown);
  });
});

describe('unknownEntryFor', () => {
  /** The fracas `-unknown`: four sublexical categories in one entry, no verb. */
  function defaults(): LexiconIndex {
    return new Map([
      ['-unknown', [{
        headword: '-unknown',
        category: 'ADJ-S',
        categories: ['ADJ-S', 'NUMBER-S', 'ADV-S', 'N-S'],
        path: 'morph_fracas.lfg.glue',
        line: 74,
        span: { start: 0, end: 1 },
      }]],
    ]);
  }

  function word(verdict: XleVerdict, readings: XleReading[]) {
    const tokens = tokenize('x');
    applyXleVerdicts(tokens, [reported('x', verdict, [], readings)]);
    return wordsOf(tokens)[0];
  }

  it('offers it for a noun reading, and names the category that matched', () => {
    const out = unknownEntryFor(
      word('unknown-entry', [reading('walk', '+Noun', '+Pl')]), defaults(),
    );
    assert.deepEqual(out.hits.map((h) => h.line), [74]);
    // Not `ADJ-S`, which is merely the first category the entry happens to write.
    assert.deepEqual(out.categories, ['N-S']);
  });

  it('withholds it from a word analysed only as a verb', () => {
    // `-unknown` supplies no `V-S`, so it cannot be where a verb-only reading came
    // from — linking to it would send someone to a rule that never applied.
    const out = unknownEntryFor(
      word('unknown-entry', [reading('walk', '+Verb', '+Pres', '+3sg')]), defaults(),
    );
    assert.deepEqual(out.hits, []);
  });

  it('offers it when any one reading is covered', () => {
    const out = unknownEntryFor(word('unknown-entry', [
      reading('walk', '+Verb', '+Pres', '+3sg'),
      reading('walk', '+Noun', '+Pl'),
    ]), defaults());
    assert.deepEqual(out.categories, ['N-S']);
  });

  it('offers it when the tags say nothing we can check', () => {
    // Conservative on purpose: hiding a real link leaves someone hunting for where a
    // word got its analysis, which is worse than one link too many.
    const out = unknownEntryFor(
      word('guessed', [reading('blurgy', '+Frobnicate')]), defaults(),
    );
    assert.deepEqual(out.hits.map((h) => h.line), [74]);
    assert.deepEqual(out.categories, []);
  });

  it('offers it when the entry declares no categories', () => {
    const bare: LexiconIndex = new Map([
      ['-unknown', [hit('-unknown', 'morph.lfg.glue', 74)]],
    ]);
    const out = unknownEntryFor(word('unknown-entry', [reading('x', '+Verb')]), bare);
    assert.deepEqual(out.hits.map((h) => h.line), [74]);
  });

  it('withholds it from a word that matched an entry of its own', () => {
    assert.deepEqual(unknownEntryFor(word('lexicon', [reading('x', '+Noun')]), defaults()).hits, []);
  });
});
