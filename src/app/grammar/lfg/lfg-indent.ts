/**
 * Indentation for LFG text, ported from `lfg-format-expression` in lfg-mode.el.
 *
 * The emacs mode has no `indent-line-function` — TAB does nothing. All indentation
 * happens through the reformatter bound to `M-q`, whose per-line rule is
 * `lfg-next-fill-col` / `lfg-indent-line-to`:
 *
 *   - one indent unit is **2 columns** per open `{` or `[`;
 *   - the delta a line contributes is `2 x (opens - closes)`, counting only
 *     delimiters that are not inside a `"..."` comment;
 *   - a line *starting* with a disjunction delimiter hangs to the left — by 1 column
 *     for a bare `|`, by 2 for `| ` and for `}`.
 *
 * That hanging rule is what gives XLE disjunctions their characteristic shape, where
 * the `|` and `}` sit outboard of the alternatives they separate.
 */

const UNIT = 2;

/** Count `{`/`[` opens minus `}`/`]` closes on a line, ignoring comment contents. */
export function netDelimiters(line: string): number {
  let net = 0;
  let inComment = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '`') { i++; continue; }
    if (inComment) {
      if (c === '"') inComment = false;
      continue;
    }
    if (c === '"') { inComment = true; continue; }
    if (c === '{' || c === '[') net++;
    else if (c === '}' || c === ']') net--;
  }
  return net;
}

/** How far a line hangs left of its nominal column, per `lfg-indent-line-to`. */
export function hangingOutdent(line: string): number {
  const trimmed = line.replace(/^[ \t]*/, '');
  if (trimmed.startsWith('| ')) return 2;
  if (trimmed.startsWith('|')) return 1;
  if (trimmed.startsWith('}')) return 2;
  return 0;
}

/**
 * Indentation for the line starting at `lineStart`, given the text before it.
 *
 * Returns the column the line should start at, or `null` to leave it alone.
 */
export function indentForLine(before: string, line: string, baseColumn = 3): number {
  let column = baseColumn;
  for (const previous of before.split('\n')) {
    column += UNIT * netDelimiters(previous);
  }
  return Math.max(0, column - hangingOutdent(line));
}
