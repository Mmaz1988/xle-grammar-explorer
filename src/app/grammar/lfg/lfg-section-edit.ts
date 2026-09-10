/**
 * Creating, renaming and removing whole sections, as text.
 *
 * A section is a header line, a body, and a `----` terminator. The parser already knows
 * where each one starts and ends, so nothing here re-derives those boundaries.
 */

import type { LfgSection, SectionKind } from './lfg-model';

/** Section kinds a user may create. CONFIG is excluded: a grammar has one, already. */
export const CREATABLE_KINDS: SectionKind[] = ['RULES', 'TEMPLATES', 'LEXICON', 'MORPHOLOGY'];

/** The version every section header in this corpus carries. */
const VERSION = '(1.0)';

/**
 * An empty section, ready to be appended to a file.
 *
 * The blank lines are not decoration: an XLE section is delimited by its header and a
 * `----`, and leaving room between them is what makes the result editable rather than a
 * pair of adjacent lines to prise apart.
 */
export function sectionTemplate(name1: string, name2: string, kind: SectionKind): string {
  return `${name1} ${name2} ${kind} ${VERSION}\n\n\n----\n`;
}

/** A new file's contents, covering one or more sections. */
export function fileTemplate(sections: Array<{ name1: string; name2: string; kind: SectionKind }>): string {
  return sections.map((s) => sectionTemplate(s.name1, s.name2, s.kind)).join('\n');
}

/**
 * Append a section to a file's text.
 *
 * Separated from what is already there by a blank line, and the file is left ending in
 * a newline whatever state it arrived in.
 */
export function appendSection(text: string, name1: string, name2: string, kind: SectionKind): string {
  const body = text.replace(/\s*$/, '');
  const separator = body === '' ? '' : '\n\n';
  return `${body}${separator}${sectionTemplate(name1, name2, kind)}`;
}

/**
 * Rewrite a section's header, leaving its body alone.
 *
 * Only the two name tokens change; the kind cannot, because moving a section between
 * kinds would move its declaration to a different CONFIG list and invalidate every
 * entry it holds.
 */
export function renameSectionHeader(
  text: string,
  section: LfgSection,
  name1: string,
  name2: string,
): string {
  const lineEnd = text.indexOf('\n', section.start);
  const end = lineEnd < 0 ? text.length : lineEnd;
  const header = text.slice(section.start, end);
  // Keep the original leading whitespace: headers in this corpus are sometimes indented.
  const indent = /^[ \t]*/.exec(header)![0];
  return text.slice(0, section.start) +
    `${indent}${name1} ${name2} ${section.kind} ${VERSION}` +
    text.slice(end);
}

/**
 * Cut a section out of a file, terminator included.
 *
 * `section.end` stops at the `----`, since that is where the parser stops looking for
 * entries, so the terminator line has to be taken too or the next section inherits it.
 */
export function removeSection(text: string, section: LfgSection): string {
  let end = section.end;
  const terminator = /^[ \t]*----[^\n]*\n?/m.exec(text.slice(end));
  if (terminator && terminator.index === 0) {
    end += terminator[0].length;
  }
  const before = text.slice(0, section.start).replace(/\n{3,}$/, '\n\n');
  const after = text.slice(end).replace(/^\n+/, '');
  return before === '' ? after : `${before}${after === '' ? '' : after}`;
}
