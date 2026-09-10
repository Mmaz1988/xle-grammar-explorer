/**
 * Editing the lists in a CONFIG section.
 *
 * These are the highest-stakes writes in the app: the CONFIG decides which files load
 * and which sections apply, so a malformed edit stops the whole grammar rather than
 * spoiling one entry. Everything here is a pure function over text, tested by
 * re-parsing the result.
 *
 * Two shapes make naive editing wrong, both real in this corpus:
 *
 *  - **The terminating period is fused to the last item** —
 *    `lexica/nounlex_fracas.lfg.` — so an item is added *before* that period, and
 *    removing the last item must leave the period attached to something.
 *  - **An empty list is written `FILES  .`** — the period alone — so the first
 *    insertion replaces it rather than appending beside it.
 */

import { maskComments } from './lfg-lexer';
import type { ConfigField } from './lfg-model';

/** Keywords whose items are parenthesised section keys rather than bare words. */
const KEYED_FIELDS = ['LEXENTRIES', 'RULES', 'TEMPLATES', 'MORPHOLOGY', 'FEATURES'];

/** The CONFIG keyword that declares a section of the given kind. */
export function configKeywordFor(kind: string): string | undefined {
  // A lexicon is declared under LEXENTRIES, not LEXICON — the one place where the
  // keyword is not simply the section kind.
  if (kind === 'LEXICON') return 'LEXENTRIES';
  return KEYED_FIELDS.includes(kind) ? kind : undefined;
}

/** Where each item sits inside a field's text, and what it says. */
interface ItemSpan {
  start: number;
  end: number;
  value: string;
}

/**
 * Locate the field's items within `fieldText`.
 *
 * Comments are masked first: a `FILES` list has `"templates"` and `"rules"` banners
 * interleaved with the paths, and those are not items.
 */
function itemSpans(fieldText: string, keyword: string): ItemSpan[] {
  const masked = maskComments(fieldText);
  const body = masked.slice(0, terminatorIndex(masked));
  const spans: ItemSpan[] = [];

  if (KEYED_FIELDS.includes(keyword)) {
    for (const match of body.matchAll(/\(([^)]*)\)/g)) {
      const at = match.index ?? 0;
      spans.push({
        start: at,
        end: at + match[0].length,
        value: match[1].trim().replace(/\s+/g, ' '),
      });
    }
    return spans;
  }

  // A bare list: whitespace-separated tokens, skipping the keyword itself.
  const afterKeyword = new RegExp(`^\\s*${keyword}\\b`).exec(body)?.[0].length ?? 0;
  for (const match of body.slice(afterKeyword).matchAll(/\S+/g)) {
    const at = afterKeyword + (match.index ?? 0);
    spans.push({ start: at, end: at + match[0].length, value: match[0] });
  }
  return spans;
}

/** Index of the period that ends the field, in masked text. */
function terminatorIndex(masked: string): number {
  const dot = masked.lastIndexOf('.');
  return dot < 0 ? masked.length : dot;
}

/** The indentation of the line `index` sits on. */
function indentOfLine(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** How an item is written for this field: `(A B)` for keyed lists, bare otherwise. */
function render(keyword: string, item: string): string {
  return KEYED_FIELDS.includes(keyword) ? `(${item})` : item;
}

/**
 * Add `item` to a CONFIG list, before its terminating period.
 *
 * New items go last, which for `TEMPLATES` and `RULES` also means lowest precedence —
 * the order of those lists decides which definition wins for a duplicated name.
 */
export function addToConfigList(text: string, field: ConfigField, item: string): string {
  const fieldText = text.slice(field.start, field.end);
  const masked = maskComments(fieldText);
  const dot = terminatorIndex(masked);
  const spans = itemSpans(fieldText, field.keyword);
  const rendered = render(field.keyword, item);

  if (spans.length === 0) {
    // `FILES  .` — put the item where the period is and push the period after it.
    return text.slice(0, field.start) +
      fieldText.slice(0, dot) + rendered + fieldText.slice(dot) +
      text.slice(field.end);
  }

  const last = spans[spans.length - 1];
  const indent = indentOfLine(fieldText, last.start);
  const inserted = `\n${indent}${rendered}`;
  return text.slice(0, field.start) +
    fieldText.slice(0, last.end) + inserted + fieldText.slice(last.end) +
    text.slice(field.end);
}

/** Remove `item` from a CONFIG list. Unknown items leave the text untouched. */
export function removeFromConfigList(text: string, field: ConfigField, item: string): string {
  const fieldText = text.slice(field.start, field.end);
  const span = itemSpans(fieldText, field.keyword).find((s) => s.value === item);
  if (!span) return text;

  let cut = fieldText.slice(0, span.start) + fieldText.slice(span.end);
  cut = tidy(cut);
  return text.slice(0, field.start) + cut + text.slice(field.end);
}

/**
 * Replace `from` with `to`, keeping its position in the list.
 *
 * In place, not remove-then-add: `TEMPLATES` and `RULES` are ordered by precedence, so
 * moving a renamed section to the end of its list would quietly change which definition
 * wins where a name is declared twice.
 */
export function replaceInConfigList(text: string, field: ConfigField, from: string, to: string): string {
  const fieldText = text.slice(field.start, field.end);
  const span = itemSpans(fieldText, field.keyword).find((s) => s.value === from);
  if (!span) return text;

  const replaced = fieldText.slice(0, span.start) + render(field.keyword, to) + fieldText.slice(span.end);
  return text.slice(0, field.start) + replaced + text.slice(field.end);
}

/**
 * Clean up after a removal.
 *
 * Drops lines left holding nothing, and pulls a stranded terminating period back onto
 * the last item — removing the final entry of a fused list would otherwise leave the
 * period alone on a line of its own.
 */
function tidy(fieldText: string): string {
  const lines = fieldText.split('\n');
  const kept = lines.filter((line, i) => i === 0 || line.trim() !== '');

  const lastIndex = kept.length - 1;
  if (kept[lastIndex]?.trim() === '.' && lastIndex > 0) {
    kept.splice(lastIndex, 1);
    kept[kept.length - 1] = `${kept[kept.length - 1].replace(/\s+$/, '')}.`;
  }
  return kept.join('\n');
}
