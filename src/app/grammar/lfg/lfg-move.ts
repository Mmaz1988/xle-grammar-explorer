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
