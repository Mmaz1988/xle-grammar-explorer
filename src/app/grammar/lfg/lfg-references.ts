/**
 * Finding template calls in grammar text.
 *
 * The whole difficulty here is that `@` means two different things in a `.lfg.glue`
 * file, and telling them apart is what makes go-to-definition and completion usable:
 *
 *   - a **template call**, `@NAME` or `@(NAME arg ...)` — what we want to resolve;
 *   - **function application** inside a glue premise, as in
 *     `:$ (\V.([e],[]) + V@e)` — where `V@e` applies `V` to `e`.
 *
 * Read naively, `V@e` looks like a call to a template named `e`. In this repo's dev
 * grammar that mistake accounts for 74 of 77 apparently-unresolved calls, so it is the
 * difference between a useful "undefined template" warning and a useless one.
 *
 * The rule is positional: a call's `@` starts a schema, so it never directly follows a
 * term. Application's `@` always does.
 */

import { maskComments } from './lfg-lexer';

/** Characters that can end a term, and therefore mark an `@` as application. */
const TERM_END = /[A-Za-z0-9_'%)\]]/;

export interface TemplateCall {
  name: string;
  /** Offset of the `@`. */
  start: number;
  /** Offset just past the called name. */
  end: number;
  /** Offset of the name itself, for precise highlighting. */
  nameStart: number;
}

/** True if the `@` at `pos` introduces a template call rather than glue application. */
export function isTemplateCallAt(text: string, pos: number): boolean {
  if (text[pos] !== '@') return false;
  // A backquote-escaped `@` is a literal character, not an operator.
  if (pos > 0 && text[pos - 1] === '`') return false;
  let i = pos - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  // Whitespace before `@` always means a call: application is written tight (`V@e`).
  if (i < pos - 1) return true;
  if (i < 0) return true;
  return !TERM_END.test(text[i]);
}

/**
 * Every template call in `text`, ignoring those inside `"..."` comments.
 *
 * Offsets index the original text, so callers can map a call straight back to the file.
 */
export function findTemplateCalls(text: string): TemplateCall[] {
  const masked = maskComments(text);
  const out: TemplateCall[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '@' || !isTemplateCallAt(masked, i)) continue;
    let j = i + 1;
    if (masked[j] === '(') j++;
    while (j < masked.length && (masked[j] === ' ' || masked[j] === '\t')) j++;
    const m = /^[A-Za-z_][A-Za-z0-9_'-]*/.exec(masked.slice(j));
    if (!m) continue;
    out.push({ name: m[0], start: i, nameStart: j, end: j + m[0].length });
  }
  return out;
}

/**
 * The template call covering `pos`, if any.
 *
 * Matches when the caret is anywhere on `@NAME` — including on the `@` itself and at
 * the very end of the name, which is where a caret usually sits after typing one.
 */
export function templateCallAt(text: string, pos: number): TemplateCall | undefined {
  return findTemplateCalls(text).find((c) => pos >= c.start && pos <= c.end);
}

/**
 * The bare identifier covering `pos`, used as a fallback jump target.
 *
 * Lets a category in a rule's right-hand side resolve to the rule that defines it, so
 * `VP` in `S --> NP VP` is navigable and not only `@`-prefixed names.
 */
export function identifierAt(text: string, pos: number): { name: string; start: number; end: number } | undefined {
  const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_'-]/.test(c);
  if (!isWord(text[pos]) && !isWord(text[pos - 1])) return undefined;
  let start = pos;
  while (start > 0 && isWord(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && isWord(text[end])) end++;
  const name = text.slice(start, end);
  return name === '' ? undefined : { name, start, end };
}
