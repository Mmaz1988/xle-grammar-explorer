/**
 * Moving an entry from one section to another, as text.
 *
 * This is the one operation that rewrites a grammar file structurally, so it is kept
 * pure and separately testable: given the source and target text and the offsets
 * involved, it returns the new text. No editor, no file system.
 *
 * The offsets come from the parser, so an entry's span already carries whatever
 * comments sit above it — a comment documenting a rule travels with the rule, which is
 * what you want, and is why the span is used verbatim rather than re-derived.
 */

/** A text edit, as a replacement over a half-open range. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Apply edits to `text`. Applied back to front, so earlier offsets stay valid. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  }
  return out;
}

/**
 * Normalise an entry's text for insertion elsewhere.
 *
 * An entry's span starts where the previous one ended, so it usually opens with the
 * newline that followed the previous period and often with blank lines. Those are
 * dropped; the entry is re-emitted on its own line with one blank line before it.
 */
export function detachEntry(text: string): string {
  return text.replace(/^[\s]*\n/, '').replace(/\s+$/, '');
}

export interface MoveRequest {
  /** Text of the file the entry comes from. */
  sourceText: string;
  /** The entry's span in `sourceText`. */
  from: number;
  to: number;
  /** Text of the file the section lives in; same string as `sourceText` if identical. */
  targetText: string;
  /** Offset in `targetText` to insert at — the end of the section's body. */
  at: number;
  /** Leave the original in place. */
  copy?: boolean;
  /** True when source and target are the same file. */
  sameFile: boolean;
}

export interface MoveResult {
  sourceText: string;
  targetText: string;
  /** Where the entry ended up in the target, for revealing it. */
  insertedAt: { start: number; end: number };
}

/**
 * Compute the new text for both files.
 *
 * When both are the same file the removal and the insertion are applied together, in
 * descending offset order, so the insertion point is not invalidated by the removal —
 * the classic way to corrupt a same-file move.
 */
export function moveEntry(request: MoveRequest): MoveResult {
  const { sourceText, from, to, targetText, at, copy = false, sameFile } = request;
  const entry = detachEntry(sourceText.slice(from, to));
  const insert = `\n\n${entry}\n`;

  if (sameFile) {
    const edits: TextEdit[] = [{ from: at, to: at, insert }];
    if (!copy) edits.push({ from, to, insert: '' });
    const text = applyEdits(sourceText, edits);
    // A removal before the insertion point shifts it left by the removed length.
    const shift = !copy && to <= at ? to - from : 0;
    const start = at - shift + 2;
    return { sourceText: text, targetText: text, insertedAt: { start, end: start + entry.length } };
  }

  const newSource = copy ? sourceText : applyEdits(sourceText, [{ from, to, insert: '' }]);
  const newTarget = applyEdits(targetText, [{ from: at, to: at, insert }]);
  return {
    sourceText: newSource,
    targetText: newTarget,
    insertedAt: { start: at + 2, end: at + 2 + entry.length },
  };
}

/**
 * Reorder the entries of one section.
 *
 * Each entry carries its own leading whitespace with it — its indentation and the blank
 * lines above it — so an entry looks the same wherever it lands.
 *
 * The obvious alternative, keeping each slot's whitespace where it is and moving only
 * the bodies through it, is worse in a way that is easy to miss: the slot's whitespace
 * includes the *indentation of the head line*, so an entry inherits whatever the
 * previous occupant had. Flush-left headwords came out indented by a stray tab, and a
 * slot whose entry had followed a period on the same line pulled the next entry up onto
 * that line too.
 *
 * The one thing that cannot travel is the very first entry's lack of a leading newline:
 * whichever entry lands first must not start on the section header's line, and every
 * other entry must start on a line of its own. Those two are normalised.
 *
 * Entry spans are contiguous across a section, so nothing is lost — comments included.
 *
 * @param order Indices of the entries in their new order; a permutation of 0..n-1.
 */
export function reorderEntries(
  text: string,
  spans: Array<{ start: number; end: number }>,
  order: number[],
): string {
  if (spans.length < 2 || order.length !== spans.length) return text;

  const chunks = spans.map((span) => text.slice(span.start, span.end));
  const leads = chunks.map((chunk) => /^\s*/.exec(chunk)![0]);
  const bodies = chunks.map((chunk) => chunk.replace(/^\s*/, ''));

  const rebuilt = order.map((from, position) => {
    let lead = leads[from];
    if (position === 0) {
      // First in the section: no leading blank lines, whatever it had before.
      lead = lead.replace(/^[\s]*\n/, '');
    } else if (!lead.includes('\n')) {
      // It used to sit on the same line as the previous entry's period. Give it a line.
      lead = `\n${lead}`;
    }
    return lead + bodies[from];
  }).join('');

  return text.slice(0, spans[0].start) + rebuilt + text.slice(spans[spans.length - 1].end);
}

/** The permutation that moves the entry at `from` to sit at index `to`. */
export function movePermutation(length: number, from: number, to: number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to > from ? to - 1 : to, 0, moved);
  return order;
}

/**
 * The permutation that sorts entries by the given keys.
 *
 * Each entry supplies its key parts in priority order — `[name]` to sort
 * alphabetically, `[category, name]` to group a lexicon by category and order each
 * group by name. Compared with a numeric collator, so `arg2` precedes `arg10` the way
 * a person would expect, and case differences do not scatter related entries: this
 * corpus has `He` beside `he` and `At` beside `at`.
 *
 * Ties keep their original order, so sorting is stable and re-sorting an already
 * sorted section changes nothing.
 */
export function sortPermutation(keys: Array<string | string[]>): number[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const parts = keys.map((key) => (Array.isArray(key) ? key : [key]));
  return parts
    .map((key, index) => ({ key, index }))
    .sort((a, b) => {
      const depth = Math.max(a.key.length, b.key.length);
      for (let i = 0; i < depth; i++) {
        const order = collator.compare(a.key[i] ?? '', b.key[i] ?? '');
        if (order !== 0) return order;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.index);
}
