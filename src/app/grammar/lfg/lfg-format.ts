/**
 * Reindenting a rule, template or lexical entry — the `M-q` of the emacs lfg-mode.
 *
 * The indentation rule is ported from `lfg-next-fill-col` / `lfg-indent-line-to`:
 * one unit is two columns per open `{` or `[`, a line contributes
 * `2 × (opens − closes)` to what follows it, and a line *starting* with a disjunction
 * delimiter hangs to the left — one column for a bare `|`, two for `| ` and for `}`.
 * That hanging is what gives XLE disjunctions their shape, with the separators
 * outboard of the alternatives.
 *
 * **Deliberate deviation:** lfg-mode's `M-q` also rewrites line content — it collapses
 * every run of whitespace to one space and inserts a space before `=`, across comments
 * too. This only ever changes a line's leading indentation and leaves the rest byte for
 * byte as it was. Reindenting is the part you actually want from a keystroke; silently
 * rewriting the inside of a `"..."` comment is not, and in a grammar where comments
 * carry commented-out code it is a good way to lose something.
 */

import { parseLfgFile } from './lfg-parser';
import { maskComments } from './lfg-lexer';
import { hangingOutdent, netDelimiters } from './lfg-indent';

/** Column the first line of an expression sits at, per `lfg-format-rule`. */
const FIRST_LINE_COLUMN = 3;
/** Ceiling on where continuation lines start, per `(min 10 (current-column))`. */
const MAX_CONTINUATION_COLUMN = 10;

/**
 * The span of the rule, template or lexical entry containing `pos`.
 *
 * Delegates to the parser rather than re-deriving entry boundaries: the rules for where
 * an entry ends — periods only at bracket depth zero, comments masked first, the `.`
 * headword — are subtle enough that a second implementation would drift from the first.
 */
export function expressionRangeAt(text: string, pos: number): { from: number; to: number } | undefined {
  const file = parseLfgFile(text);
  for (const section of file.sections) {
    if (pos < section.start || pos > section.end) continue;
    for (const entry of section.entries) {
      if (pos >= entry.start && pos <= entry.end) {
        return { from: entry.start, to: entry.end };
      }
    }
  }
  return undefined;
}

/** Where a line's content starts, ignoring its current indentation. */
function contentOf(line: string): string {
  return line.replace(/^[ \t]*/, '');
}

/**
 * Reindent one expression, returning the replacement text.
 *
 * Continuation lines start under the operator — after `-->` for a rule, after `=` for a
 * template or macro — capped at column 10 so a long left-hand side does not push the
 * body off to the right.
 */
export function reindentExpression(text: string): string {
  const lines = text.split('\n');
  if (lines.length === 0) return text;

  // An entry's span begins where the previous one ended, so it can open with blank
  // lines and with standalone comments — the `"""Lexical rules"""` banners in this
  // corpus sit inside the following entry. Formatting starts at the head line, the one
  // carrying `-->` or `=`, and everything above it is left exactly as it was.
  const masked = maskComments(text).split('\n');
  const head = masked.findIndex((line) => /-->|=(?!=|c)/.test(line));
  if (head < 0) return text;

  const out = lines.slice(0, head);
  const first = contentOf(lines[head]);
  out.push(' '.repeat(FIRST_LINE_COLUMN) + first);

  // Column just past the operator on the first line, which is where the body hangs.
  const operator = /(-->|=)(?!=|c)/.exec(first);
  const afterOperator = operator ? FIRST_LINE_COLUMN + operator.index + operator[0].length + 1 : MAX_CONTINUATION_COLUMN;
  let column = Math.min(MAX_CONTINUATION_COLUMN, afterOperator);

  // Whether the line we are about to emit begins inside a `"..."` comment. Those lines
  // are left exactly as they are: their leading whitespace is comment text.
  let inComment = openComment(lines[head]);
  column += 2 * netDelimiters(lines[head]);

  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i];
    if (inComment) {
      out.push(line);
    } else {
      const content = contentOf(line);
      out.push(content === '' ? '' : ' '.repeat(Math.max(0, column - hangingOutdent(content))) + content);
      column += 2 * netDelimiters(line);
    }
    inComment = inComment ? !closesComment(line) : openComment(line);
  }
  return out.join('\n');
}

/** True when `line` leaves an unterminated `"` open. */
function openComment(line: string): boolean {
  let open = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`') { i++; continue; }
    if (line[i] === '"') open = !open;
  }
  return open;
}

/** True when `line` closes a comment that was already open. */
function closesComment(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`') { i++; continue; }
    if (line[i] === '"') return true;
  }
  return false;
}
