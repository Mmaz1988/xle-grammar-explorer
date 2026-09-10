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

/**
 * Where continuations go when there is nothing on the head line to align with —
 * `lfg-format-rule`'s `(min 10 (current-column))`.
 */
const DEFAULT_CONTINUATION_COLUMN = 10;

/**
 * Furthest right an alignment will be taken.
 *
 * Aligning under a very long head pushes the body off to the right for no gain:
 * `AP[_type $ {attributive predicative}] -->` would put every daughter at column 41,
 * and the grammar's own authors do not write it that way — they break after the arrow
 * and indent normally. Past this, so does the formatter.
 */
const MAX_ALIGN_COLUMN = 32;

/** What kind of definition a head line introduces, which decides where its body starts. */
type HeadKind = 'rule' | 'template' | 'lexical';

/** A lexical entry's head: headword, category, morphcode. */
const LEXICAL_HEAD = /^[ \t]*(?:[^\s`]|`.)+[ \t]+\S+[ \t]+(?:\*|XLE)\b/;

/** Whether a line opens a definition, and so is where formatting starts. */
function isHeadLine(line: string): boolean {
  return line.includes('-->') || LEXICAL_HEAD.test(line) || /=(?!=|c)/.test(line);
}

/**
 * Visual column of `index` in `line`, expanding tabs to eight-column stops.
 *
 * Lexical entries in this corpus separate the headword from its category with tabs, so
 * counting characters would align the continuations to the wrong column.
 */
function visualColumn(line: string, index: number, start: number): number {
  let column = start;
  for (let i = 0; i < index && i < line.length; i++) {
    column = line[i] === '\t' ? column + 8 - (column % 8) : column + 1;
  }
  return column;
}

/**
 * The column the body starts at on the head line, or undefined if the line ends at
 * the operator with nothing after it.
 *
 * This is the kind-sensitive part. A rule's daughters begin after `-->`, a template's
 * constraints after `=`, and a lexical entry's schemata after its headword, category
 * and morphcode. Aligning continuations there is what makes daughters line up under
 * each other instead of under an arbitrary fixed column.
 *
 * lfg-mode only does this for lexical entries — `(max 10 (current-column))` — and caps
 * rules and templates at 10 with `(min 10 ...)`. Treating all three the same way is a
 * deliberate departure, and the reason rules now line up.
 */
function bodyColumn(headLine: string, indent: number): { kind: HeadKind; column?: number } {
  const after = (index: number): number | undefined => {
    const rest = headLine.slice(index);
    const spaces = /^[ \t]*/.exec(rest)![0].length;
    // Nothing but whitespace after the operator: the author broke the line there.
    return rest.trim() === '' ? undefined : visualColumn(headLine, index + spaces, indent);
  };

  const arrow = headLine.indexOf('-->');
  if (arrow >= 0) return { kind: 'rule', column: after(arrow + 3) };

  const lexical = LEXICAL_HEAD.exec(headLine);
  if (lexical) return { kind: 'lexical', column: after(lexical[0].length) };

  const equals = /=(?!=|c)/.exec(headLine);
  if (equals) return { kind: 'template', column: after(equals.index + 1) };

  return { kind: 'template', column: undefined };
}

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
  // A lexical entry's head line carries neither `-->` nor `=` — it is a headword, a
  // category and a morphcode — so looking only for an operator finds the wrong line
  // and formats from halfway down the entry.
  const head = masked.findIndex(isHeadLine);
  if (head < 0) return text;

  const out = lines.slice(0, head);
  const first = contentOf(lines[head]);
  out.push(' '.repeat(FIRST_LINE_COLUMN) + first);

  // Continuations line up under whatever the head line starts, so a rule's daughters
  // sit beneath the first daughter rather than at a fixed column.
  const { column: aligned } = bodyColumn(first, FIRST_LINE_COLUMN);
  let column = aligned !== undefined && aligned <= MAX_ALIGN_COLUMN
    ? aligned
    : DEFAULT_CONTINUATION_COLUMN;

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
