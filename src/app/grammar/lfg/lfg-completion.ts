/**
 * Template-name completion for the editor.
 *
 * Uses `@codemirror/autocomplete`, which ships with the `codemirror` package, so this
 * costs no new dependency.
 */

import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { isTemplateCallAt } from './lfg-references';

/** What the editor needs to know about a grammar to complete names in it. */
export interface CompletionEntry {
  name: string;
  params: string[];
  kind: 'template' | 'macro' | 'rule';
  detail: string;
}

/**
 * Build a completion source over `entries`.
 *
 * Only fires after an `@` that actually introduces a template call. Inside a glue
 * premise `V@e` is function application, and popping a template list there would be
 * noise on every lambda term in the file.
 */
export function lfgCompletions(entries: () => CompletionEntry[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match `@NAME`, `@(NAME`, and the bare `@`/`@(` that has just been typed.
    const token = context.matchBefore(/@\(?\s*[A-Za-z_][A-Za-z0-9_'-]*|@\(?/);
    if (!token) return null;
    if (!context.explicit && token.text.replace(/[@(\s]/g, '') === '') {
      // Typing just `@` opens the list; an explicit request always does.
      if (token.text !== '@' && token.text !== '@(') return null;
    }

    const doc = context.state.doc.toString();
    if (!isTemplateCallAt(doc, token.from)) return null;

    // Complete the name only, leaving any `@(` the user already typed in place.
    const nameOffset = /^@\(?\s*/.exec(token.text)?.[0].length ?? 1;

    const options: Completion[] = entries().map((e) => ({
      label: e.name,
      type: e.kind === 'rule' ? 'class' : 'function',
      detail: e.params.length ? `(${e.params.join(' ')})` : '',
      info: e.detail || undefined,
      // Insert the parameter list's shape too, so the call is ready to fill in.
      apply: e.params.length && token.text.startsWith('@(')
        ? `${e.name} ${e.params.map((p) => p.replace(/^_/, '')).join(' ')}`
        : e.name,
    }));

    return {
      from: token.from + nameOffset,
      options,
      validFor: /^[A-Za-z_][A-Za-z0-9_'-]*$/,
    };
  };
}
