import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import {
  analyseSentence, type LexiconHit, type LexiconIndex, type SentenceToken,
} from '../lfg/lexicon-lookup';
import {
  applyXleVerdicts, isCovered, matchesFor, resolveXleHits, surfaceMatches,
  UNKNOWN_HEADWORD, type XleMatch, type XleVerdict,
} from '../lfg/xle-coverage';
import { XleOracleService } from '../workspace/xle-oracle.service';

/** The four states a word is shown in, whichever source answered. */
export type WordState = 'covered' | 'defaulted' | 'guessed' | 'missing';

/** How long to wait after a keystroke before asking XLE. */
const ASK_AFTER_MS = 250;

/**
 * How long the details popup survives the pointer leaving a word.
 *
 * It has to outlive the gap between the word and the popup, or the popup would close
 * on the way to clicking anything in it.
 */
const CLOSE_AFTER_MS = 160;

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
      this.closePeek();
      return;
    }
    this.tokens = analyseSentence(this.sentence, this.lexicon);
    this.closePeek();

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
   * What the word's colour means, shown as the popup's first line.
   *
   * It explains the colour and nothing else. The readings below it are deliberately
   * unannotated: the colour answers "is this word in the grammar", which for a word
   * the morphology reads two ways is genuinely ambiguous — `train` is in the verb
   * lexicon and has a noun reading nothing backs — and saying which reading failed
   * would need the category the syntax would assign.
   */
  verdict(token: SentenceToken): string {
    const xle = token.xle;
    if (xle) {
      const reasons: Record<XleVerdict, string> = {
        lexicon: 'a lexical entry matches',
        'unknown-entry': 'no entry of its own — -unknown supplies a default analysis',
        guessed: 'the morphology guessed this word',
        'no-entry': 'analysed, but no lexical entry matches',
        unanalyzable: 'the morphology cannot analyse this word',
      };
      return reasons[xle.verdict];
    }
    return token.matched ? `${token.match} match on ${token.matched}` : 'not in the lexicon';
  }

  // ---- the word details popup -------------------------------------------------
  //
  // A native tooltip could show the readings but not let anyone act on them, and a
  // word can have several entries worth opening: one per stem the morphology found,
  // several under one headword, and `-unknown` besides. So the hover target is a real
  // popup whose rows are the entries.

  /** The word whose popup is open, if any. */
  peeked?: SentenceToken;
  /** Where to draw it, relative to the sentence line. */
  peekLeft = 0;
  peekTop = 0;
  private closeTimer?: ReturnType<typeof setTimeout>;

  /** Open the popup under a word. */
  peek(token: SentenceToken, event: MouseEvent): void {
    this.hold();
    const word = event.currentTarget as HTMLElement;
    this.peekLeft = word.offsetLeft;
    this.peekTop = word.offsetTop + word.offsetHeight + 2;
    this.peeked = token;
  }

  /** Keep it open — the pointer is on the word or in the popup. */
  hold(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  /** Let it close, unless the pointer arrives somewhere that holds it first. */
  release(): void {
    this.hold();
    this.closeTimer = setTimeout(() => (this.peeked = undefined), CLOSE_AFTER_MS);
  }

  closePeek(): void {
    this.hold();
    this.peeked = undefined;
  }

  /**
   * One row per analysis, with the entries the lexicon has under its stem.
   *
   * Without the oracle there are no analyses, so the row falls back to the headword we
   * matched ourselves. The popup is the only way to open an entry, so it has to keep
   * working when nothing asked XLE — that is also the case where the match is a guess
   * from a small stemmer and seeing which headword it landed on matters most.
   */
  get peekedMatches(): XleMatch[] {
    if (!this.peeked || !this.lexicon) return [];
    const rows = matchesFor(this.peeked, this.lexicon);
    if (rows.length > 0) return rows;
    return surfaceMatches(this.peeked, this.lexicon);
  }

  /** Drawn apart: it stands for the rule about unlisted stems, not an entry. */
  isDefault(hit: LexiconHit): boolean {
    return hit.headword === UNKNOWN_HEADWORD;
  }

  /** Open one entry from the popup. Shift puts it in a new pane, as elsewhere. */
  openHit(hit: LexiconHit, event: MouseEvent): void {
    this.openEntry.emit({ hit, newPane: event.shiftKey === true });
    this.closePeek();
  }

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
