/**
 * Overlaying XLE's verdict on a locally-matched sentence.
 *
 * The lexicon lookup in `lexicon-lookup.ts` answers "is this headword written down
 * somewhere", which is not the same question as "will this word parse". A word can be
 * absent from every lexicon and still parse, because the `-unknown` entry supplies a
 * default analysis for any stem the morphology knows; and a word that looks like a
 * plausible inflection may not parse at all. Only the grammar's own transducer knows,
 * and whether it guesses at all differs per grammar.
 *
 * So when XLE is available its answer wins, and the local match stays as the fallback
 * for when it is not. The two are kept apart rather than merged: a red word should
 * never be ambiguous between "XLE says no" and "nothing asked XLE".
 */

import type { SentenceToken } from './lexicon-lookup';

/** XLE's verdict for one word, worst to best. */
export type XleVerdict = 'unanalyzable' | 'no-entry' | 'guessed' | 'unknown-entry' | 'lexicon';

export interface XleToken {
  text: string;
  variants: string[];
  from: number;
  to: number;
  verdict: XleVerdict;
  /** Stems the morphology produced: `saw` reports `see`. */
  stems: string[];
}

/** Whether a word is covered at all, for the counts and the colouring. */
export function isCovered(verdict: XleVerdict): boolean {
  return verdict === 'lexicon' || verdict === 'unknown-entry' || verdict === 'guessed';
}

/**
 * Attach XLE's verdicts to the tokens we tokenised ourselves.
 *
 * The two tokenisers do not have to agree — XLE's is the grammar's own, and it may
 * join a multiword or split a contraction differently — so words are matched by text
 * in order rather than by position, and anything unmatched simply keeps its local
 * verdict instead of taking a neighbour's by accident.
 */
export function applyXleVerdicts(tokens: SentenceToken[], xle: XleToken[]): SentenceToken[] {
  const words = tokens.filter((t) => t.word && t.spans > 0);
  let at = 0;

  for (const reported of xle) {
    const run = findRun(words, at, reported);
    if (!run) continue;
    for (let i = run.start; i < run.start + run.length; i++) words[i].xle = reported;
    at = run.start + run.length;
  }
  return tokens;
}

/**
 * Where a reported token sits among our words, and how many of them it covers.
 *
 * XLE may report a multiword headword as a single token (`New York`), in which case it
 * is the verdict for both of our words — tagging only the first would leave the second
 * looking unchecked. Failing that, any of the tokeniser's variants matching one word
 * is enough.
 */
function findRun(
  words: SentenceToken[],
  from: number,
  reported: XleToken,
): { start: number; length: number } | undefined {
  const parts = reported.text.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (parts.length > 1) {
    for (let start = from; start + parts.length <= words.length; start++) {
      const fits = parts.every((part, i) => words[start + i].text.toLowerCase() === part);
      if (fits) return { start, length: parts.length };
    }
  }

  const names = [reported.text, ...reported.variants].map((n) => n.toLowerCase());
  for (let index = from; index < words.length; index++) {
    const word = words[index].text.toLowerCase();
    if (names.some((n) => n === word || n.split(/\s+/).includes(word))) {
      return { start: index, length: 1 };
    }
  }
  return undefined;
}
