/**
 * Parser for XLE/LFG grammar files.
 *
 * Produces the section/entry model the working tree renders. It is a *structural*
 * parser, not a full XLE front end: it finds section boundaries, splits entries and
 * names them, and reads the CONFIG fields. It deliberately does not interpret
 * f-structure annotations, glue premises or functional uncertainty — the editor pane
 * shows those as text.
 */

import { maskComments, splitEntries, lineIndex, lineAtIndexed } from './lfg-lexer';
import type { ConfigField, EntryKind, LfgEntry, LfgFile, LfgSection, SectionKind } from './lfg-model';

/**
 * Section header, e.g. `SENTENCE ENGLISH RULES (1.0)`.
 *
 * Neither the header nor the `----` terminator is anchored to column 0: real grammars
 * indent both (` SENTENCE ENGLISH RULES (1.0)` in sentence_fracas_grammar.lfg, and a
 * closing `   ----` at the end of templates_fracas.lfg). Whitespace between the three
 * header tokens is arbitrary.
 */
const SECTION_HEADER =
  /^[ \t]*(\S+)[ \t]+(\S+)[ \t]+(CONFIG|RULES|LEXICON|TEMPLATES|MORPHOLOGY|FEATURES)[ \t]*\(([\d.]+)\)[ \t]*$/gm;

const SECTION_END = /^[ \t]*----/m;

/** CONFIG field keywords, used to find where one field's value stops. */
const CONFIG_KEYWORDS = [
  'ROOTCAT', 'FILES', 'LEXENTRIES', 'RULES', 'TEMPLATES', 'MORPHOLOGY',
  'GOVERNABLERELATIONS', 'SEMANTICFUNCTIONS', 'NONDISTRIBUTIVES', 'EPSILON',
  'CHARACTERENCODING', 'OPTIMALITYORDER', 'GENOPTIMALITYORDER', 'PARAMETERS',
  'EXTERNALATTRIBUTES', 'FEATURES',
];

/** A c-structure rule: `VP[_form] --> ...`. `-->` must be at chunk start to count. */
const RULE_HEAD = /^([^\s=]+(?:\[[^\]]*\])?)\s*-->/;

/**
 * A macro or template definition: `NPCOORD(_CAT) = ...`.
 * The `(?!=|c)` guard keeps `=c` (constraining equation) and `==` from matching.
 */
const MACRO_HEAD = /^([A-Za-z_][A-Za-z0-9_'\-]*(?:\([^)]*\))?)\s*=(?!=|c)/;

/**
 * Scan the three leading tokens of a lexical entry: headword, category, morphcode.
 *
 * This cannot be a `\S+` regex. A backquote escapes the character after it *including
 * a space*, which is exactly how XLE writes a multiword headword: ``New` York``,
 * ``North` American``, ``more` important``. A whitespace-splitting regex reads those as
 * headword ``New` ``, category `York`, morphcode `N` — plausible-looking and wrong.
 */
function scanLexHead(chunk: string): { word: string; category: string; morphcode: string; lead: number } | undefined {
  let i = 0;
  const readToken = (): string | undefined => {
    while (i < chunk.length && /\s/.test(chunk[i])) { i++; }
    const start = i;
    while (i < chunk.length) {
      const c = chunk[i];
      if (c === '`') { i += 2; continue; }
      if (/\s/.test(c)) { break; }
      i++;
    }
    return i > start ? chunk.slice(start, i) : undefined;
  };
  while (i < chunk.length && /\s/.test(chunk[i])) { i++; }
  const lead = i;
  const word = readToken();
  const category = readToken();
  const morphcode = readToken();
  if (word === undefined || category === undefined || morphcode === undefined) {
    return undefined;
  }
  return { word, category, morphcode, lead };
}

export interface ParseOptions {
  /** Path recorded on the result; also used for `.lfg.glue` detection. */
  path?: string;
}

/** Parse one grammar file into sections and entries. */
export function parseLfgFile(text: string, options: ParseOptions = {}): LfgFile {
  const masked = maskComments(text);
  const starts = lineIndex(text);
  const sections: LfgSection[] = [];
  const diagnostics: string[] = [];

  SECTION_HEADER.lastIndex = 0;
  let header: RegExpExecArray | null;
  while ((header = SECTION_HEADER.exec(masked)) !== null) {
    const kind = header[3] as SectionKind;
    const headerStart = header.index;
    const bodyStart = masked.indexOf('\n', headerStart) + 1 || masked.length;

    // The section runs to the next `----`, or to end of file if it is unterminated.
    SECTION_END.lastIndex = 0;
    const tail = masked.slice(bodyStart);
    const endMatch = SECTION_END.exec(tail);
    const bodyEnd = endMatch ? bodyStart + endMatch.index : masked.length;

    const section: LfgSection = {
      kind,
      id: [header[1], header[2]],
      key: `${header[1]} ${header[2]}`,
      version: header[4],
      start: headerStart,
      end: bodyEnd,
      line: lineAtIndexed(starts, headerStart),
      entries: [],
    };

    if (kind === 'CONFIG') {
      section.config = parseConfig(text, masked, bodyStart, bodyEnd, starts);
      section.entries = section.config.map((f) => ({
        kind: 'config-field' as EntryKind,
        name: f.keyword,
        display: `${f.keyword}  ${summariseConfigValue(f)}`,
        start: f.start,
        end: f.end,
        line: f.line,
      }));
    } else if (kind === 'MORPHOLOGY') {
      section.entries = parseMorphology(text, bodyStart, bodyEnd, starts);
    } else if (kind === 'RULES' || kind === 'TEMPLATES' || kind === 'LEXICON') {
      for (const chunk of splitEntries(masked, bodyStart, bodyEnd)) {
        const entry = nameEntry(text, masked, chunk.start, chunk.end, kind, starts);
        if (entry) {
          section.entries.push(entry);
        } else {
          const snippet = masked.slice(chunk.start, chunk.end).trim().slice(0, 60);
          diagnostics.push(`unnamed ${kind} entry at line ${lineAtIndexed(starts, chunk.start)}: ${snippet}`);
        }
      }
    }

    sections.push(section);
    // Continue scanning after this section so nested-looking text can't re-match.
    SECTION_HEADER.lastIndex = Math.max(header.index + header[0].length, bodyEnd);
  }

  const file: LfgFile = { path: options.path ?? '', text, sections };
  if (diagnostics.length) {
    file.diagnostics = diagnostics;
  }
  return file;
}

/**
 * Identify and name one entry chunk.
 *
 * Returns `undefined` when the chunk yields no identifier, which the caller records as
 * a diagnostic. On the current corpus this never happens; it is kept as a real signal
 * rather than being papered over with a placeholder name.
 */
function nameEntry(
  text: string,
  masked: string,
  start: number,
  end: number,
  kind: SectionKind,
  starts: number[],
): LfgEntry | undefined {
  const maskedChunk = masked.slice(start, end);
  const trimmed = maskedChunk.trimStart();
  if (trimmed === '') {
    return undefined;
  }
  const lead = maskedChunk.length - trimmed.length;
  const base = {
    start,
    end,
    line: lineAtIndexed(starts, start + lead),
    hasGlue: /:\$|-o/.test(maskedChunk) || undefined,
  };

  if (kind === 'RULES' || kind === 'TEMPLATES') {
    const rule = RULE_HEAD.exec(trimmed);
    if (rule) {
      return { ...base, kind: 'rule', name: rule[1], display: reduceRule(trimmed) };
    }
    const macro = MACRO_HEAD.exec(trimmed);
    if (macro) {
      return { ...base, kind: kind === 'RULES' ? 'macro' : 'template', name: macro[1] };
    }
    return undefined;
  }

  if (kind === 'LEXICON') {
    const lex = scanLexHead(maskedChunk);
    if (lex) {
      // Read the headword from the ORIGINAL text rather than the masked copy, so the
      // backquote form survives for display and for locating the entry again.
      const name = text.slice(start + lex.lead, start + lex.lead + lex.word.length);
      return { ...base, kind: 'lex', name, category: lex.category, morphcode: lex.morphcode };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Reduce a rule to its phrase-structure skeleton: `S --> (ADVP) NP VP[fin]`.
 *
 * Walks the masked RHS and keeps daughter categories while skipping their `:`
 * annotation blocks, preserving `{ | }` disjunction and `( )` optionality as
 * structure. Annotations are what make a rule unreadable at a glance, and they are
 * exactly what the editor pane is for.
 *
 * This is display-only and never round-trips. When the result looks degenerate the
 * caller falls back to the rule's first physical line.
 */
export function reduceRule(chunk: string): string | undefined {
  const arrow = chunk.indexOf('-->');
  if (arrow < 0) {
    return undefined;
  }
  const lhs = chunk.slice(0, arrow).trim();
  const rhs = chunk.slice(arrow + 3);
  const parts: string[] = [];
  let i = 0;

  while (i < rhs.length) {
    const c = rhs[i];
    if (c === '`') { i += 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '.' ) { break; }

    if (c === '{' || c === '}' || c === '|') {
      parts.push(c);
      i++;
      continue;
    }
    // A template call is a single daughter, not a paren group: `@(CP-COORD CP)`.
    if (c === '@') {
      const call = /^@\(?[^\s()]*\)?/.exec(rhs.slice(i));
      if (call && rhs[i + 1] === '(') {
        const close = matchParen(rhs, i + 1);
        if (close > 0) {
          parts.push(rhs.slice(i, close + 1).replace(/\s+/g, ' '));
          i = close + 1;
          continue;
        }
      }
      if (call) { parts.push(call[0]); i += call[0].length; continue; }
    }

    if (c === '(') { parts.push('('); i++; continue; }
    if (c === ')') { parts.push(')'); i++; continue; }

    if (c === ':') {
      // Skip this daughter's annotation block: everything up to the `;` that ends it,
      // or to a delimiter that closes the enclosing group.
      i++;
      let depth = 0;
      while (i < rhs.length) {
        const a = rhs[i];
        if (a === '`') { i += 2; continue; }
        if (a === '(' || a === '{' || a === '[') { depth++; }
        else if (a === ')' || a === '}' || a === ']') {
          if (depth === 0) { break; }
          depth--;
        } else if (depth === 0 && (a === ';' || a === '|')) { break; }
        else if (depth === 0 && a === '.') { break; }
        i++;
      }
      if (rhs[i] === ';') { i++; }
      continue;
    }
    if (c === ';') { i++; continue; }

    // A category: identifier, optional [params], optional Kleene marker.
    const cat = /^[^\s:;(){}|[\].]+(?:\[[^\]]*\])?[*+]?/.exec(rhs.slice(i));
    if (cat) {
      parts.push(cat[0]);
      i += cat[0].length;
      continue;
    }
    i++;
  }

  const rendered = parts
    .join(' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\{\s+/g, '{ ')
    .replace(/\s+\}/g, ' }')
    .replace(/\s+/g, ' ')
    .trim();

  if (rendered === '' || /^[(){}|\s]*$/.test(rendered)) {
    return undefined;
  }
  return `${lhs} --> ${rendered}`;
}

/** Index of the `)` matching the `(` at `open`, or -1. Skips backquote escapes. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '`') { i++; continue; }
    if (c === '(') { depth++; }
    else if (c === ')') { depth--; if (depth === 0) { return i; } }
  }
  return -1;
}

/**
 * Parse the fields of a CONFIG section.
 *
 * Each field is `KEYWORD values .`, but the terminating period cannot be found by
 * scanning for the first `.` — filenames in a FILES list are full of them and the
 * final one is fused to the last path (`lexica/nounlex_fracas.lfg.`). So a field's
 * value runs until the next known keyword at line start, and the last `.` inside that
 * span is the terminator.
 */
export function parseConfig(
  text: string,
  masked: string,
  start: number,
  end: number,
  starts: number[],
): ConfigField[] {
  const body = masked.slice(start, end);
  const keywordRe = new RegExp(`^[ \\t]*(${CONFIG_KEYWORDS.join('|')})\\b`, 'gm');
  const heads: Array<{ keyword: string; at: number; valueAt: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = keywordRe.exec(body)) !== null) {
    heads.push({ keyword: m[1], at: m.index, valueAt: m.index + m[0].length });
  }

  return heads.map((head, idx) => {
    const spanEnd = idx + 1 < heads.length ? heads[idx + 1].at : body.length;
    const raw = body.slice(head.valueAt, spanEnd);
    const dot = raw.lastIndexOf('.');
    const value = (dot >= 0 ? raw.slice(0, dot + 1) : raw).trim();
    return {
      keyword: head.keyword,
      value,
      items: splitConfigItems(head.keyword, value),
      start: start + head.at,
      end: start + head.valueAt + (dot >= 0 ? dot + 1 : raw.length),
      line: lineAtIndexed(starts, start + head.at),
    };
  });
}

/**
 * Split a CONFIG field value into its items.
 *
 * `FILES` is whitespace-separated paths with the terminating period fused to the last
 * one; a single-file grammar writes just `FILES .`. The `(A B)` section references in
 * LEXENTRIES/RULES/TEMPLATES/MORPHOLOGY are parenthesised pairs. Everything else is
 * bare atoms.
 */
export function splitConfigItems(keyword: string, value: string): string[] {
  const body = value.replace(/\.\s*$/, '').trim();
  if (body === '') {
    return [];
  }
  if (['LEXENTRIES', 'RULES', 'TEMPLATES', 'MORPHOLOGY', 'FEATURES'].includes(keyword)) {
    return Array.from(body.matchAll(/\(([^)]*)\)/g)).map((mm) => mm[1].trim().replace(/\s+/g, ' '));
  }
  return body.split(/\s+/).filter((s) => s !== '' && s !== '.');
}

function summariseConfigValue(field: ConfigField): string {
  if (field.keyword === 'FILES') {
    return `(${field.items.length} file${field.items.length === 1 ? '' : 's'})`;
  }
  const flat = field.value.replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/**
 * Parse a MORPHOLOGY section.
 *
 * This section is a different mini-language from the rest of an XLE grammar: mixed-case
 * `KEY:` block headers, `#` line comments (the only place `#` comments anything),
 * whitespace-separated FST paths optionally prefixed `P!` (parse-only) or `G!`
 * (generate-only), and no terminating periods at all.
 */
export function parseMorphology(text: string, start: number, end: number, starts: number[]): LfgEntry[] {
  const entries: LfgEntry[] = [];
  const body = text.slice(start, end);
  const lineRe = /^[ \t]*([A-Za-z][A-Za-z0-9 _]*):[ \t]*$/gm;
  const heads: Array<{ key: string; at: number; valueAt: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(body)) !== null) {
    heads.push({ key: m[1].trim(), at: m.index, valueAt: m.index + m[0].length });
  }
  heads.forEach((head, idx) => {
    const spanEnd = idx + 1 < heads.length ? heads[idx + 1].at : body.length;
    const value = body
      .slice(head.valueAt, spanEnd)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
      .join(' ')
      .trim();
    entries.push({
      kind: 'morph-field',
      name: head.key,
      display: value === '' ? `${head.key}:` : `${head.key}: ${value}`,
      start: start + head.at,
      end: start + spanEnd,
      line: lineAtIndexed(starts, start + head.at),
    });
  });
  return entries;
}
