import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import {
  analyseSentence, foundHeadwords, missingWords,
  type LexiconHit, type LexiconIndex, type SentenceToken,
} from '../lfg/lexicon-lookup';

/**
 * A sentence, checked against the grammar's lexicon.
 *
 * Type a sentence and see which of its words the grammar already knows — the question
 * you ask before adding anything to it. Each word found is a box you can click to open
 * its entry.
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

  @Output() openEntry = new EventEmitter<LexiconHit>();
  @Output() hide = new EventEmitter<void>();

  sentence = '';
  tokens: SentenceToken[] = [];
  found: SentenceToken[] = [];
  missing: SentenceToken[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    // A different grammar knows different words, so the answer has to be recomputed.
    if (changes['lexicon']) this.analyse();
  }

  analyse(): void {
    if (!this.lexicon || this.sentence.trim() === '') {
      this.tokens = [];
      this.found = [];
      this.missing = [];
      return;
    }
    this.tokens = analyseSentence(this.sentence, this.lexicon);
    this.found = foundHeadwords(this.tokens);
    this.missing = missingWords(this.tokens);
  }

  clear(): void {
    this.sentence = '';
    this.analyse();
  }

  /** Open the first entry for a matched token. */
  open(token: SentenceToken): void {
    const hit = token.hits[0];
    if (hit) this.openEntry.emit(hit);
  }

  /** Distinct headwords, so a word repeated in the sentence yields one box. */
  get boxes(): SentenceToken[] {
    const seen = new Set<string>();
    return this.found.filter((t) => {
      const key = `${t.matched}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  get knownCount(): number {
    return this.tokens.filter((t) => t.word && t.spans > 0 && t.match !== 'missing').length;
  }

  get wordCount(): number {
    return this.tokens.filter((t) => t.word && t.spans > 0).length;
  }
}
