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

import { hitsFor } from './lexicon-lookup';
import type { LexiconHit, LexiconIndex, SentenceToken } from './lexicon-lookup';

/**
 * One analysis the morphology offers for a word, stem and tags apart.
 *
 * They are looked up in different places: the stem is a headword the lexicon may have
 * an entry for, the tags belong to the morphology. A stem can be several words, since
 * a multiword headword such as `take` a` swim` analyses as one.
 */
export interface XleReading {
  stem: string;
  tags: string[];
}

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
  /**
   * Every analysis the morphology offers: `see` + `+Verb +PastTense +123SP`.
   *
   * The verdict above is one colour for the whole word, but a word is only in the
   * grammar *as something*: `train` is in the verb lexicon and has a noun reading
   * nothing backs, which is why a sentence needing the noun fails while the word
   * shows green. Nothing in the lexicon can settle which reading was meant — that is
   * the category the syntax would assign — so the readings are reported rather than
   * judged, and the person reading them can see at a glance which one is missing.
   *
   * Optional because an older service will not send them.
   */
  readings?: XleReading[];
}

/** Whether a word is covered at all, for the counts and the colouring. */
export function isCovered(verdict: XleVerdict): boolean {
  return verdict === 'lexicon' || verdict === 'unknown-entry' || verdict === 'guessed';
}

/**
 * Whether `-unknown` is what covered this word.
 *
 * Narrower than `isCovered` on purpose. A word XLE reports as `lexicon` matched an
 * entry of its own, and offering `-unknown` beside it says the grammar analysed the
 * word by default when it did not — which is the claim the whole bar exists to get
 * right. A stem *can* hold an entry and still take `-unknown` for a category that
 * entry does not supply, but nothing here can tell when: that needs the sublexical
 * category, and guessing wrongly is worse than not offering it.
 */
export function usesUnknownEntry(verdict: XleVerdict): boolean {
  return verdict === 'unknown-entry' || verdict === 'guessed';
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

/** The headword a grammar uses for stems its lexicon does not list. */
export const UNKNOWN_HEADWORD = '-unknown';

/**
 * Point each word at an entry worth opening, using what XLE found.
 *
 * The local lookup can only follow a word to an entry when its own stemmer gets
 * there, which rules out every irregular form: nothing takes `saw` to `see`. XLE
 * reports the stem it actually used, so the entry is one lookup away.
 *
 * A word covered without a lexicon entry is pointed at `-unknown` instead — that
 * genuinely is the entry responsible for it, and it is the one you would want to read
 * (or edit) on finding a word analysed by default rather than by design.
 */
export function resolveXleHits(tokens: SentenceToken[], index: LexiconIndex): SentenceToken[] {
  for (const token of tokens) {
    if (!token.xle) continue;

    const rows = matchesFor(token, index).filter((row) => row.hits.length > 0);
    if (rows.length > 0) {
      token.hits = rows.flatMap((row) => row.hits);
      token.matched = rows[0].reading.stem;
      token.viaUnknown = false;
      continue;
    }

    // Covered, but by the default analysis rather than by an entry of its own — and
    // only when `-unknown` supplies a category this word's readings actually ask for.
    const unknown = unknownEntryFor(token, index);
    if (unknown.hits.length > 0) {
      token.hits = unknown.hits;
      token.matched = UNKNOWN_HEADWORD;
      token.viaUnknown = true;
    }
  }
  return tokens;
}

/**
 * One row of a word's popup: an analysis, and the entries its stem has.
 *
 * The entries are *for the stem*, not for the reading. Saying which entry backs which
 * analysis would mean knowing the sublexical category each tag demands, which is a
 * question only XLE can answer and only by being asked again; and the category shown
 * on each entry lets a reader pair them up at a glance anyway. So the rows report and
 * do not judge — the same reason the colour cannot be fixed.
 */
export interface XleMatch {
  reading: XleReading;
  hits: LexiconHit[];
}

/**
 * A full-form entry for the word: morphcode `*`, matching the token itself.
 *
 * `*` supplies only the form written, so it sits outside the morphology altogether —
 * no sublexical rule reaches it and no stem the analyser produces is looked up in it.
 * `PC-6082 N *` is the clear case, but so are `than CComp *` and `is AUX[fin] *`,
 * whose forms the analyser does happen to have readings for.
 */
function fullFormMatches(token: SentenceToken, index: LexiconIndex): XleMatch[] {
  for (const form of [token.xle?.text, token.text]) {
    if (form === undefined) continue;
    const hits = hitsFor(index, form).filter((hit) => hit.morphcode === '*');
    if (hits.length > 0) return [{ reading: { stem: form.trim(), tags: [] }, hits }];
  }
  return [];
}

/**
 * The rows for one word: what covered it, and every reading with what backs it.
 *
 * The two kinds of entry do not mix. A morphological reading can only be backed by an
 * entry that defers to the morphology (`XLE`); a full-form entry (`*`) covers the
 * token and nothing else. `than CComp *` is the case that shows why: the analyser
 * offers `than +Conj +Subord` and `than +Prep`, but no sublexical rule licenses either
 * against a `*` entry, so listing the entry twice under those tags claims two readings
 * the grammar cannot have. Like `PC-6082`, `than` has one entry and one row.
 *
 * Several readings usually share a stem (`train +Verb …` and `train +Noun …`), and
 * each stays a row of its own: the tags are what distinguishes them, and collapsing by
 * stem would hide exactly the ambiguity worth seeing. A reading nothing backs still
 * gets a row when the word has no full-form entry either — that is `walks`, where
 * seeing the unbacked verb analysis is the whole point.
 */
export function matchesFor(token: SentenceToken, index: LexiconIndex): XleMatch[] {
  const fullForm = fullFormMatches(token, index);
  // A word can have stems that chain into no complete analysis. The stems are still
  // the entries to offer — this is the path that gets `saw` to `see`.
  const analyses = token.xle?.readings?.length
    ? token.xle.readings
    : (token.xle?.stems ?? []).map((stem) => ({ stem, tags: [] }));
  const readings = analyses.map((reading) => ({
    reading,
    hits: backing(hitsFor(index, reading.stem), reading),
  }));
  return [
    ...fullForm,
    ...readings.filter((row) => row.hits.length > 0 || fullForm.length === 0),
  ];
}

/**
 * The `-unknown` entry, offered alongside a word's own entries rather than instead.
 *
 * A word can be reached both ways at once — a stem with an entry of its own may still
 * take `-unknown` for a category that entry does not supply — so the two are not
 * alternatives to choose between. It is listed as what it is, the rule for unlisted
 * stems, without claiming to apply to this word: deciding that needs the sublexical
 * category, which is the same thing the colour cannot know.
 */
export function unknownEntry(index: LexiconIndex): LexiconHit[] {
  return index.get(UNKNOWN_HEADWORD) ?? [];
}

/**
 * The stem category a morphological tag asks for.
 *
 * The sublexical convention a ParGram-derived morphology is written in: a rule pairs a
 * `X-POS` tag with an `X-S` stem — `V --> V-S_BASE V-POS_BASE …` — and an entry
 * supplies stems, not tags. Written out rather than derived because deriving it means
 * asking XLE for each tag's own category and pairing that against the morphology
 * rules, a lookup per tag for a table that has not varied across these grammars.
 *
 * Only the part-of-speech tags are here. Inflectional tags (`+Sg`, `+PastTense`) sit
 * on other sublexical categories entirely and say nothing about which stem is needed.
 */
const STEM_CATEGORY: Record<string, string> = {
  '+Noun': 'N-S',
  '+Prop': 'N-S',
  '+Verb': 'V-S',
  '+Adj': 'ADJ-S',
  '+Adv': 'ADV-S',
  '+Num': 'NUMBER-S',
};

/** `N-S_BASE` and `N-S` are the same category; the suffix is XLE's, not the grammar's. */
const bareCategory = (category: string) => category.replace(/_BASE$/, '');

/**
 * Which of a stem's entries could back one reading.
 *
 * Two filters, both about what the morphology can reach. A full-form entry (`*`)
 * supplies only the token, so no reading reaches it at all. And an entry supplies
 * particular sublexical categories, so a reading reaches it only if one of them is the
 * category its part-of-speech tag asks for: `fast ADJ-S XLE` backs `fast +Adj +Comp`
 * and not `fast +Adv +Comp`, and `train V-S XLE` backs the verb reading of `train`
 * while the noun reading it also has goes unbacked — which is the whole reason a
 * sentence needing that noun fails while the word shows green.
 *
 * Conservative where it cannot tell, as everywhere else here: a reading whose tags
 * name no category we know, or an entry that declares none, keeps the entry. Hiding a
 * real entry is worse than showing one too many.
 */
function backing(hits: LexiconHit[], reading: XleReading): LexiconHit[] {
  const usable = hits.filter((hit) => hit.morphcode !== '*');
  const wanted = reading.tags.map((tag) => STEM_CATEGORY[tag]).find((c) => c !== undefined);
  if (wanted === undefined) return usable;
  return usable.filter((hit) => {
    const declared = hit.categories ?? [];
    return declared.length === 0 || declared.map(bareCategory).includes(wanted);
  });
}

/**
 * `-unknown`, but only for a word whose analyses it could actually supply.
 *
 * `-unknown` is not a general fallback: it lists the sublexical categories it covers,
 * four in the fracas grammar (`ADJ-S`, `NUMBER-S`, `ADV-S`, `N-S`) and no verb among
 * them. Offering it for a word analysed only as a verb points at a rule that cannot
 * have applied. So the entry's own categories are checked against the categories this
 * word's readings ask for.
 *
 * Conservative where it cannot tell: if the entry declares no categories, or the word
 * has no readings, or none of its tags is one we know a stem category for, the entry
 * is offered rather than suppressed. Hiding a real link is the worse failure — it is
 * the one that leaves someone hunting for where a word got its analysis.
 */
export function unknownEntryFor(
  token: SentenceToken,
  index: LexiconIndex,
): { hits: LexiconHit[]; categories: string[] } {
  const none = { hits: [], categories: [] };
  const xle = token.xle;
  if (!xle || !usesUnknownEntry(xle.verdict)) return none;

  const hits = unknownEntry(index);
  if (hits.length === 0) return none;

  const supplies = new Set(
    hits.flatMap((hit) => (hit.categories ?? []).map(bareCategory)),
  );
  const wanted = [
    ...new Set(
      (xle.readings ?? [])
        .flatMap((reading) => reading.tags)
        .map((tag) => STEM_CATEGORY[tag])
        .filter((category): category is string => category !== undefined),
    ),
  ];
  if (supplies.size === 0 || wanted.length === 0) return { hits, categories: [] };

  const matched = wanted.filter((category) => supplies.has(category));
  return matched.length > 0 ? { hits, categories: matched } : none;
}

/**
 * The rows for a word the morphology gave no analysis of.
 *
 * A `*` entry matches the token itself, so `the` and `PC-6082` arrive covered with no
 * stem and no reading. There is still an entry to open, and it is keyed by the form.
 */
export function surfaceMatches(token: SentenceToken, index: LexiconIndex): XleMatch[] {
  if (token.hits.length === 0) return [];
  return [{ reading: { stem: token.matched ?? token.text, tags: [] }, hits: token.hits }];
}
