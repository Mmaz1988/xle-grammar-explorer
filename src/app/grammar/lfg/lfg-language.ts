/**
 * CodeMirror 6 wiring for the LFG stream mode, plus the colour scheme.
 *
 * The palette is lifted from the Aquamacs lfg-mode, which does not use `defface` but
 * mutates the standard faces in its mode hook:
 *
 *     (set-face-foreground font-lock-comment-face "Chocolate")
 *     (set-face-foreground font-lock-string-face  "Chocolate")
 *     (set-face-foreground font-lock-keyword-face "Purple")
 *     (set-face-foreground font-lock-builtin-face "Red")
 *
 * Note `Purple` there is the X11 colour `#A020F0`, not CSS `purple` (`#800080`) — they
 * are visibly different, and the X11 one is what a grammar looks like in Aquamacs.
 *
 * The dark variant is not from the emacs mode (there is nothing to port), so it lifts
 * each hue to stay legible on a dark ground while keeping the same role mapping.
 */

import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentService } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import { lfgStreamMode } from './lfg-stream-mode';
import { hangingOutdent, netDelimiters } from './lfg-indent';

/**
 * Map our token names onto lezer highlight tags.
 *
 * This has to be handed to `StreamLanguage.define` as its `tokenTable`. Without it
 * CodeMirror resolves the names itself, and it knows nothing of `builtin` or
 * `variable` — so those tokens took whatever the fallback gave them, which is how
 * `{` and `@` ended up green instead of red.
 */
const TOKEN_TAGS: Record<string, ReturnType<typeof t.special> | typeof t.comment> = {
  comment: t.comment,
  keyword: t.keyword,
  string: t.string,
  lfgOperator: t.operatorKeyword,
  lfgLocal: t.variableName,
  lfgProjection: t.typeName,
};

export const lfgLanguage = StreamLanguage.define({
  name: 'lfg',
  startState: () => lfgStreamMode.startState(),
  copyState: (s) => lfgStreamMode.copyState(s),
  token: (stream, state) => {
    const token = lfgStreamMode.token(stream as never, state);
    return token === null ? null : token;
  },
  languageData: {
    // XLE has no line-comment syntax; commenting means wrapping in `"..."`, which the
    // grammar-editor handles as its own command (see lfg-comment-region in lfg-mode).
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
  },
  tokenTable: TOKEN_TAGS,
});

const LIGHT = HighlightStyle.define([
  { tag: t.comment, color: '#D2691E' },            // Chocolate
  { tag: t.string, color: '#D2691E' },
  { tag: t.keyword, color: '#A020F0', fontWeight: '600' }, // X11 Purple
  { tag: t.operatorKeyword, color: '#FF0000' },    // Red
  { tag: t.variableName, color: '#1a7f5a' },
  { tag: t.typeName, color: '#0b6ea8' },
]);

const DARK = HighlightStyle.define([
  { tag: t.comment, color: '#e39a5c' },
  { tag: t.string, color: '#e39a5c' },
  { tag: t.keyword, color: '#c98bff', fontWeight: '600' },
  { tag: t.operatorKeyword, color: '#ff6b6b' },
  { tag: t.variableName, color: '#4fd1a5' },
  { tag: t.typeName, color: '#5cb8f0' },
]);

/**
 * Auto-indent for a newly opened line, following the same rule as `M-q`.
 *
 * Computed from the previous non-empty line rather than by re-parsing the enclosing
 * expression: the rule is incremental — each line contributes `2 × (opens − closes)`
 * to the next — so a local answer is the same answer, and it stays cheap while typing.
 */
export const lfgIndent = indentService.of((context, pos) => {
  const doc = context.state.doc;
  const line = doc.lineAt(pos);
  for (let previous = line.number - 1; previous >= 1; previous--) {
    const candidate = doc.line(previous);
    if (candidate.text.trim() === '') continue;
    const indent = /^[ \t]*/.exec(candidate.text)![0].length;
    const base = indent + 2 * netDelimiters(candidate.text);
    return Math.max(0, base - hangingOutdent(line.text.replace(/^[ \t]*/, '')));
  }
  return null;
});

export function lfgHighlighting(dark = false): Extension {
  return syntaxHighlighting(dark ? DARK : LIGHT, { fallback: true });
}

/** Everything needed to show LFG text: the language plus its colours. */
export function lfg(dark = false): Extension[] {
  return [lfgLanguage, lfgIndent, lfgHighlighting(dark)];
}
