/**
 * Looking a sentence up in a grammar's lexicon.
 *
 * Answers "which of these words does the grammar already know?", which is the question
 * you ask before adding anything to it.
 *
 * Two things make this less than a dictionary lookup:
 *
 *  - **Morphology is not in the lexicon.** An entry whose morphcode is `XLE` gets its
 *    inflected forms from the morphological analyser, so `eat V-S XLE` covers *eating*
 *    without *eating* appearing anywhere. An entry with `*` supplies only the form
 *    written. Both are matches, but they are not the same claim, so they are reported
 *    apart.
 *  - **A headword may be several words.** `New` York` and `at` least` use a backquote
 *    to escape the space, so matching has to consider runs of tokens, longest first.
 */

import type { LfgEntry, LfgFile } from './lfg-model';
import type { GrammarUnit } from '../workspace/grammar-index';

/** Where a headword is defined. */
export interface LexiconHit {
  /** The headword as written, backquotes and all. */
  headword: string;
  category?: string;
  /** Every category the entry defines; `-unknown` supplies four in one entry. */
  categories?: string[];
  morphcode?: string;
  path: string;
  line: number;
  span: { start: number; end: number };
}

export type LexiconIndex = Map<string, LexiconHit[]>;

/**
 * How a token was matched.
 *
 * `inflected` is the interesting one: the grammar has the base form and the morphology
 * is expected to derive this one. `base-only` is the same match against an entry that
 * supplies just the form written, so the inflection may well not parse — worth saying,
 * rather than colouring it the same green as a word that is certainly covered.
 */
export type MatchKind = 'exact' | 'inflected' | 'base-only' | 'missing';

export interface SentenceToken {
  text: string;
  /** Offsets into the searched sentence, for highlighting it. */
  start: number;
  end: number;
  /** Punctuation and whitespace are shown but never looked up. */
  word: boolean;
  match: MatchKind;
  /** The headword that matched, when one did. */
  matched?: string;
  hits: LexiconHit[];
  /** How many tokens this match covers, for multiword headwords. */
  spans: number;
  /**
   * XLE's verdict, when the oracle answered. Absent means nothing asked it, which is
   * a different thing from a word it rejected — see `xle-coverage.ts`.
   */
  xle?: import('./xle-coverage').XleToken;
  /** True when `hits` point at `-unknown` rather than at an entry for this word. */
  viaUnknown?: boolean;
}

/** Resolve backquote escapes, so `New` York` reads as the two words it is. */
export function unescapeHeadword(headword: string): string {
  return headword.replace(/`(.)/g, '$1');
}

/** Build the lookup for one grammar. Keys are lower-cased. */
export function buildLexiconIndex(unit: GrammarUnit): LexiconIndex {
  const index: LexiconIndex = new Map();
  for (const file of unit.files) {
    for (const section of file.sections) {
      if (section.kind !== 'LEXICON') continue;
      for (const entry of section.entries) {
        if (entry.kind !== 'lex') continue;
        add(index, file, entry);
      }
    }
  }
  return index;
}

function add(index: LexiconIndex, file: LfgFile, entry: LfgEntry): void {
  const key = unescapeHeadword(entry.name).toLowerCase().trim();
  if (key === '') return;
  const hit: LexiconHit = {
    headword: entry.name,
    category: entry.category,
    categories: entry.categories,
    morphcode: entry.morphcode,
    path: file.path,
    line: entry.line,
    span: { start: entry.start, end: entry.end },
  };
  const existing = index.get(key);
  if (existing) existing.push(hit);
  else index.set(key, [hit]);
}

/**
 * Base forms a token might be an inflection of.
 *
 * A deliberately small English stemmer rather than a real analyser: the grammar's own
 * morphology is the authority, and this only has to be good enough to suggest where to
 * look. Candidates are tried in order, so the least speculative wins.
 */
export function lemmaCandidates(token: string): string[] {
  const word = token.toLowerCase();
  const out = new Set<string>();
  const add = (candidate: string) => {
    if (candidate.length >= 2 && candidate !== word) out.add(candidate);
  };

  if (word.endsWith("'s") || word.endsWith('’s')) add(word.slice(0, -2));
  if (word.endsWith('ies')) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) { add(word.slice(0, -2)); add(word.slice(0, -1)); }
  if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
  if (word.endsWith('ing')) { add(word.slice(0, -3)); add(`${word.slice(0, -3)}e`); }
  if (word.endsWith('ed')) { add(word.slice(0, -2)); add(word.slice(0, -1)); }
  if (word.endsWith('er')) { add(word.slice(0, -2)); add(word.slice(0, -1)); }
  if (word.endsWith('est')) { add(word.slice(0, -3)); add(word.slice(0, -2)); }
  if (word.endsWith('ly')) add(word.slice(0, -2));

  // running → run, stopped → stop: a consonant doubled before the suffix.
  const doubled = /^(.*?)([bcdfghjklmnpqrstvwxz])\2(ing|ed|er|est)$/.exec(word);
  if (doubled) add(doubled[1] + doubled[2]);

  return [...out];
}

/** Split a sentence into words and the punctuation between them, keeping offsets. */
export function tokenize(sentence: string): SentenceToken[] {
  const out: SentenceToken[] = [];
  // A word may contain an apostrophe or hyphen: `don't`, `four-legged`.
  const pattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;
  for (const match of sentence.matchAll(pattern)) {
    const text = match[0];
    out.push({
      text,
      start: match.index ?? 0,
      end: (match.index ?? 0) + text.length,
      word: /[\p{L}\p{N}]/u.test(text),
      match: 'missing',
      hits: [],
      spans: 1,
    });
  }
  return out;
}

/** Longest run of tokens a multiword headword may cover. */
const MAX_SPAN = 4;

/**
 * Look a sentence up, marking each token.
 *
 * Multiword headwords are tried first and longest-first, so `at least three` matches
 * the entry `at` least` rather than leaving *at* and *least* to be looked up alone.
 */
export function analyseSentence(sentence: string, index: LexiconIndex): SentenceToken[] {
  const tokens = tokenize(sentence);
  const words = tokens.filter((t) => t.word);

  for (let i = 0; i < words.length; i++) {
    if (words[i].match !== 'missing') continue;

    for (let span = Math.min(MAX_SPAN, words.length - i); span >= 1; span--) {
      const run = words.slice(i, i + span);
      if (run.some((t) => t.match !== 'missing')) continue;
      const phrase = run.map((t) => t.text).join(' ');
      const found = lookup(phrase, index);
      if (!found) continue;

      run[0].match = found.kind;
      run[0].matched = found.hits[0].headword;
      run[0].hits = found.hits;
      run[0].spans = span;
      // The rest of the run is part of the same match, not separate misses.
      for (const rest of run.slice(1)) {
        rest.match = found.kind;
        rest.matched = found.hits[0].headword;
        rest.spans = 0;
      }
      break;
    }
  }
  return tokens;
}

/**
 * Entries that can cover a form, folding case the way XLE's tokenizer does.
 *
 * The index is keyed lower-case so a lookup stays one map hit, but the grammar is not
 * case-insensitive and the fold runs one way only. A capitalized form reaches a
 * lower-case entry — `The` is covered by `the D *`, mid-sentence as well as first —
 * while nothing reaches an entry with capitals the form does not have: `kim` does not
 * find `Kim N *`, and a sentence written that way returns no parse at all.
 *
 * Measured against the grammar rather than assumed. `parse-sentence` gives one parse
 * for *Kim sees The tractor* and none for *kim sees a tractor*, and `print-lex-entry
 * kim` falls through to `-unknown` while `print-lex-entry The` answers `The D *`.
 *
 * So an entry matches when it is the form exactly, or the form lower-cased.
 */
export function hitsFor(index: LexiconIndex, form: string): LexiconHit[] {
  const wanted = form.trim();
  const lower = wanted.toLowerCase();
  const candidates = index.get(lower);
  if (!candidates) return [];
  const usable = candidates.filter((hit) => {
    const headword = unescapeHeadword(hit.headword).trim();
    return headword === wanted || headword === lower;
  });
  return usable;
}

/** Match one word or phrase, preferring the least speculative reading. */
function lookup(phrase: string, index: LexiconIndex): { kind: MatchKind; hits: LexiconHit[] } | undefined {
  const exact = hitsFor(index, phrase);
  if (exact.length > 0) return { kind: 'exact', hits: exact };

  for (const candidate of lemmaCandidates(phrase)) {
    const hits = hitsFor(index, candidate);
    if (hits.length === 0) continue;
    // The morphology supplies inflections only for entries that defer to it.
    const kind = hits.some((h) => h.morphcode === 'XLE') ? 'inflected' : 'base-only';
    return { kind, hits };
  }
  return undefined;
}

/** One box per distinct headword found, in the order they appear. */
export function foundHeadwords(tokens: SentenceToken[]): SentenceToken[] {
  return tokens.filter((t) => t.word && t.spans > 0 && t.match !== 'missing');
}

/** Words the grammar has nothing for. */
export function missingWords(tokens: SentenceToken[]): SentenceToken[] {
  return tokens.filter((t) => t.word && t.match === 'missing');
}
