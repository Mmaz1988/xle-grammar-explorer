/**
 * Lexing primitives for XLE grammar text.
 *
 * XLE's surface syntax defeats line-based parsing in two specific ways, and both are
 * handled here rather than being rediscovered by every caller. Measured against all
 * 71 grammar files in `grammars/`, getting either one wrong is not a rare edge case:
 * naive period-splitting names only 22% of lexical entries correctly.
 */

/**
 * Blank out the contents of `"..."` comments, preserving length and newlines so that
 * every offset into the result still indexes the original text.
 *
 * Three things make this less obvious than it looks:
 *
 * 1. XLE comments are double-quoted *strings*, not line comments. They span lines,
 *    they contain unbalanced braces and pipes (see `CPnom` in noun_fracas_grammar.lfg,
 *    whose comment holds a stray `|` and `}`), and they routinely contain commented-out
 *    grammar code — adj_adv_lex_fracas.lfg:81-91 is a single comment wrapping six
 *    complete-looking lexical entries. Brace matching and entry splitting must
 *    therefore run *after* this pass, never before.
 *
 * 2. A backquote escapes the next character (`` `( ``, `` `. ``, `` `\ ``), including a
 *    quote, so it must be skipped as a unit. This is also how a multiword headword
 *    encodes its space: ``New` York``.
 *
 * 3. A single quote is NOT a string delimiter, however much it looks like one. PRED
 *    values are written `'%stem<(^SUBJ)>'`, but the same character is the X-bar
 *    bar-level marker in category names — `C'`, `I'`, `V'`, `N'`. Treating `'` as a
 *    delimiter makes everything between `C'` and the next apostrophe vanish, which
 *    silently swallowed four rules in glue-basic-drt.lfg when this was first written.
 *    The emacs lfg-mode agrees: `(modify-syntax-entry ?\' "w")` — word constituent.
 *
 * `"""` needs no special handling: it lexes naturally as `""` + `"..."` + `""`.
 */
export function maskComments(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '`') {
      i += 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        j += text[j] === '`' ? 2 : 1;
      }
      const end = Math.min(j, n - 1);
      for (let k = i; k <= end; k++) {
        if (out[k] !== '\n') {
          out[k] = ' ';
        }
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Split a section body into entry chunks at every terminating period.
 *
 * A period only terminates an entry at bracket depth 0. Inside brackets it is
 * ordinary punctuation, and XLE grammars are full of such periods: lambda terms in
 * glue premises (`:$ (\P.P) : ...`), DRS commas and dots, and the `%mc` encodings the
 * glue compiler emits. Tracking `()`, `{}` and `[]` depth is what takes entry naming
 * from 22% to 100% on the lexicons.
 *
 * The one deliberate exception is the `.` headword. `functionlex_fracas.lfg` really
 * does define an entry whose word *is* a period:
 *
 *     . 	  PERIOD * (^ STMT-TYPE) = declarative.
 *
 * so a period that would close an empty chunk is treated as the start of the next
 * entry rather than as a terminator.
 *
 * @param masked  Text already run through {@link maskComments}.
 * @param start   Offset to begin at (normally just past the section header line).
 * @param end     Offset to stop at (the `----` terminator, or end of file).
 */
export function splitEntries(masked: string, start: number, end: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let chunkStart = start;
  let i = start;
  while (i < end) {
    const c = masked[i];
    if (c === '`') {
      i += 2;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') {
      depth++;
    } else if (c === ')' || c === '}' || c === ']') {
      depth = Math.max(0, depth - 1);
    } else if (c === '.' && depth === 0) {
      const chunk = masked.slice(chunkStart, i + 1);
      // Only a real boundary if the chunk has content other than dots/whitespace;
      // otherwise this is the leading '.' of a `. PERIOD * ...` headword.
      if (chunk.replace(/[.\s]/g, '') !== '') {
        out.push({ start: chunkStart, end: i + 1 });
        chunkStart = i + 1;
      }
    }
    i++;
  }
  if (masked.slice(chunkStart, end).trim() !== '') {
    out.push({ start: chunkStart, end });
  }
  return out;
}

/** 1-based line number of `offset`. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
    }
  }
  return line;
}

/** Build a prefix table so repeated {@link lineAt} lookups over one file stay cheap. */
export function lineIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 1-based line number of `offset`, using a table from {@link lineIndex}. */
export function lineAtIndexed(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}
