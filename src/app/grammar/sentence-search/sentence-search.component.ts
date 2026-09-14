import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import {
  analyseSentence, foundHeadwords, missingWords,
  type LexiconHit, type LexiconIndex, type SentenceToken,
} from '../lfg/lexicon-lookup';
import {
  applyXleVerdicts, isCovered, resolveXleHits, UNKNOWN_HEADWORD, type XleVerdict,
} from '../lfg/xle-coverage';
import { XleOracleService } from '../workspace/xle-oracle.service';

/** The four states a word is shown in, whichever source answered. */
export type WordState = 'covered' | 'defaulted' | 'guessed' | 'missing';

/** How long to wait after a keystroke before asking XLE. */
const ASK_AFTER_MS = 250;

/**
 * A sentence, checked against the grammar.
 *
 * Two sources can answer. When the XLE oracle is running the grammar's own morphology
 * decides, which is the only way to know whether a word absent from the lexicon still
 * parses through `-unknown`, or whether an inflection the lexicon implies is actually
 * analysable. Otherwise the bar falls back to matching headwords itself and says so —
 * a red word must never be ambiguous between "XLE rejected it" and "nothing asked".
 */
@Component({
  selector: 'app-sentence-search',
  templateUrl: './sentence-search.component.html',
  styleUrls: ['./sentence-search.component.css'],
})
export class SentenceSearchComponent implements OnChanges {
  @Input() lexicon?: LexiconIndex;
  /** Named in the placeholder, so it is clear which grammar is being asked. */
  @Input() grammarName = '';
  /** The grammar's main file, which the oracle resolves to a path XLE can load. */
  @Input() mainPath?: string;

  /** `newPane` when the click was shift-held, matching ⇧ in the editor. */
  @Output() openEntry = new EventEmitter<{ hit: LexiconHit; newPane: boolean }>();
  @Output() hide = new EventEmitter<void>();

  sentence = '';
  tokens: SentenceToken[] = [];
  found: SentenceToken[] = [];
  missing: SentenceToken[] = [];

  /** Bumped per keystroke so a slow reply cannot overwrite a newer sentence. */
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(readonly oracle: XleOracleService) {
    void this.oracle.check();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // A different grammar knows different words, so the answer has to be recomputed.
    if (changes['lexicon'] || changes['mainPath']) this.analyse();
  }

  analyse(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);

    if (!this.lexicon || this.sentence.trim() === '') {
      this.tokens = [];
      this.found = [];
      this.missing = [];
      return;
    }
    this.tokens = analyseSentence(this.sentence, this.lexicon);
    this.found = foundHeadwords(this.tokens);
    this.missing = missingWords(this.tokens);

    // Asking XLE means parsing, so wait for a pause rather than firing per keystroke.
    const mine = this.generation;
    const sentence = this.sentence;
    this.timer = setTimeout(() => void this.askXle(mine, sentence), ASK_AFTER_MS);
  }

  private async askXle(mine: number, sentence: string): Promise<void> {
    if (!this.mainPath) return;
    const reported = await this.oracle.coverage(this.mainPath, sentence);
    // The sentence moved on while XLE was working; its answer is about the old one.
    if (mine !== this.generation || !reported || !this.lexicon) return;
    // XLE's stems reach entries our own stemmer cannot: nothing takes `saw` to `see`.
    this.tokens = resolveXleHits(applyXleVerdicts([...this.tokens], reported), this.lexicon);
    this.found = this.tokens.filter((t) => t.word && t.spans > 0 && t.hits.length > 0);
  }

  clear(): void {
    this.sentence = '';
    this.analyse();
  }

  /** Retry after starting the service, without reloading the page. */
  async retryOracle(): Promise<void> {
    await this.oracle.recheck();
    this.analyse();
  }

  /**
   * Open the first entry for a matched token.
   *
   * Shift opens it beside whatever is already there, the same gesture as ⇧ on a
   * go-to-definition — useful for lining several words of a sentence up at once.
   */
  open(token: SentenceToken, event?: MouseEvent): void {
    const hit = token.hits[0];
    if (hit) this.openEntry.emit({ hit, newPane: event?.shiftKey === true });
  }

  /**
   * How to colour a word.
   *
   * XLE's verdict wins when it answered: it is the grammar's own morphology rather
   * than our reading of the lexicon. `guessed` is kept apart from `defaulted` because
   * they fail differently — a guessing grammar will analyse any string at all, so
   * showing that as a hit would make the bar meaningless.
   */
  stateOf(token: SentenceToken): WordState {
    const verdict = token.xle?.verdict;
    if (verdict) {
      if (verdict === 'lexicon') return 'covered';
      if (verdict === 'unknown-entry') return 'defaulted';
      if (verdict === 'guessed') return 'guessed';
      return 'missing';
    }
    if (token.match === 'missing') return 'missing';
    if (token.match === 'base-only') return 'defaulted';
    return 'covered';
  }

  /**
   * What the word's colour means, spelled out on hover.
   *
   * The colour answers "is this word in the grammar", which for a word the morphology
   * reads two ways is genuinely ambiguous — `train` is in the verb lexicon, `walks`
   * only in the noun default. Deciding between them needs the category the syntax
   * would assign, so the readings are listed underneath instead and left to the
   * reader: seeing `walk +Verb +Pres +3sg` next to a word that will not parse is the
   * whole diagnosis.
   */
  explain(token: SentenceToken): string {
    const xle = token.xle;
    if (xle) {
      const stems = xle.stems.length ? ` (${xle.stems.join(', ')})` : '';
      const reasons: Record<XleVerdict, string> = {
        lexicon: `XLE: a lexical entry matches${stems}`,
        'unknown-entry':
          `XLE: no entry — -unknown supplies a default analysis${stems}` +
          (token.viaUnknown ? ' · click to open -unknown' : ''),
        guessed:
          `XLE: the morphology guessed this word${stems}` +
          (token.viaUnknown ? ' · click to open -unknown' : ''),
        'no-entry': `XLE: analysed${stems} but no lexical entry matches`,
        unanalyzable: 'XLE: the morphology cannot analyse this word',
      };
      const readings = xle.readings?.length ? `\n\n${xle.readings.join('\n')}` : '';
      return reasons[xle.verdict] + readings;
    }
    return token.matched ? `lexicon: ${token.match} — ${token.matched}` : 'not in the lexicon';
  }

  /**
   * Distinct entries, so a word repeated in the sentence yields one box.
   *
   * Keyed on the entry rather than the word: several words of one sentence can be
   * covered by the same `-unknown`, and one box for it says more than three.
   */
  get boxes(): SentenceToken[] {
    const seen = new Set<string>();
    return this.found.filter((t) => {
      const hit = t.hits[0];
      if (!hit) return false;
      const key = `${t.matched}|${hit.path}:${hit.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Shown on a box that stands for the default analysis rather than an entry. */
  readonly unknownHeadword = UNKNOWN_HEADWORD;

  /** True once any word carries an XLE verdict, which is what the notice reflects. */
  get usingXle(): boolean {
    return this.tokens.some((t) => t.xle);
  }

  private get words(): SentenceToken[] {
    return this.tokens.filter((t) => t.word && t.spans > 0);
  }

  get knownCount(): number {
    return this.words.filter((t) =>
      t.xle ? isCovered(t.xle.verdict) : t.match !== 'missing',
    ).length;
  }

  get missingCount(): number {
    return this.words.length - this.knownCount;
  }

  get wordCount(): number {
    return this.words.length;
  }
}
