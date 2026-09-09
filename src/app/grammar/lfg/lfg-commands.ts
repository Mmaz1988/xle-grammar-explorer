/**
 * Editor commands ported from lfg-mode.el.
 */

import type { EditorView } from '@codemirror/view';
import { expressionRangeAt, reindentExpression } from './lfg-format';

/**
 * Comment or uncomment the selection, mirroring `lfg-comment-region` (C-c C-c).
 *
 * XLE comments are `"..."`, and the way to put a quote *inside* a comment is to double
 * it, not to backslash-escape it. So commenting a region wraps it in quotes and turns
 * every interior `"` into `""`; uncommenting reverses both steps. Getting this wrong
 * silently truncates the comment at the first interior quote, which in a grammar full
 * of commented-out code is easy to miss.
 */
export function commentRegion(view: EditorView): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    // With no selection, act on the whole line — the usual editor courtesy.
    const from = range.empty ? state.doc.lineAt(range.from).from : range.from;
    const to = range.empty ? state.doc.lineAt(range.to).to : range.to;
    const text = state.sliceDoc(from, to);

    const isCommented = text.startsWith('"') && text.endsWith('"') && text.length >= 2;
    const insert = isCommented
      ? text.slice(1, -1).replace(/""/g, '"')
      : `"${text.replace(/"/g, '""')}"`;

    return {
      changes: { from, to, insert },
      range: state.selection.ranges[0].extend(from, from + insert.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

/**
 * Reindent the rule, template or lexical entry around the caret — lfg-mode's `M-q`.
 *
 * Reindents only; line content is untouched. See `lfg-format.ts` for why this stops
 * short of what the emacs command does.
 */
export function formatExpression(view: EditorView): boolean {
  const { state } = view;
  const doc = state.doc.toString();
  const range = expressionRangeAt(doc, state.selection.main.head);
  if (!range) return false;

  const before = doc.slice(range.from, range.to);
  const after = reindentExpression(before);
  if (after === before) return true;

  // Keep the caret on the same line, since its column has moved.
  const line = state.doc.lineAt(state.selection.main.head).number;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: after },
    userEvent: 'format',
  });
  const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
  view.dispatch({ selection: { anchor: target.to }, scrollIntoView: true });
  return true;
}
