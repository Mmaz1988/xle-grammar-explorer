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
import type {
  ConfigField, EntryKind, LabelPart, LfgEntry, LfgFile, LfgSection, RuleSkeleton, SectionKind,
} from './lfg-model';

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

/**
 * CONFIG field keywords, used to find where one field's value stops.
 *
 * A field runs until the next keyword, so an unknown one is not merely ignored — the
 * preceding field swallows it. The ParGram English grammar uses several that a smaller
 * grammar never does, and without them its `CHARACTERENCODING` ran on through three
 * more fields.
 */
const CONFIG_KEYWORDS = [
  'ROOTCAT', 'FILES', 'LEXENTRIES', 'RULES', 'TEMPLATES', 'MORPHOLOGY',
  'GOVERNABLERELATIONS', 'SEMANTICFUNCTIONS', 'NONDISTRIBUTIVES', 'EPSILON',
  'CHARACTERENCODING', 'OPTIMALITYORDER', 'GENOPTIMALITYORDER', 'PARAMETERS',
  'EXTERNALATTRIBUTES', 'FEATURES',
  // ParGram configurations
  'GRAMMARVERSION', 'BASECONFIGFILE', 'PERFORMANCEVARSFILE', 'ENCRYPTFILES',
  'REPARSECAT', 'FRAGMENTCAT', 'INSIDEOUTOPTIMALITYORDER', 'GENERATIONOPTIMIZATION',
  'MORPHOLOGYFILES', 'ABBREVIATIONS', 'MULTIWORDCONFIG',
];

/** A c-structure rule: `VP[_form] --> ...`. `-->` must be at chunk start to count. */
const RULE_HEAD = /^([^\s=]+(?:\[[^\]]*\])?)\s*-->/;

/**
 * A macro or template definition: `NPCOORD(_CAT) = ...`.
 *
 * Parameters may be parenthesised or bracketed — ParGram writes rule macros as
 * `VP[perf,modal] = VP[perf,base]` and `CPembed[decl] = ...` — and may be separated
 * from the name by a space, as in `SUBJ-OBJ-OBJTH-COMP_core (_P) = ...`.
 *
 * The `(?!=|c)` guard keeps `=c` (constraining equation) and `==` from matching.
 */
const MACRO_HEAD = /^([A-Za-z_][A-Za-z0-9_'\-]*(?:[ \t]*(?:\([^)]*\)|\[[^\]]*\]))?)\s*=(?!=|c)/;

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
      // A chunk that yields no name is usually not a stray: it is the front of an
      // entry that was split too early, because a period inside the headword looked
      // like a terminator — ParGram has `b.` and `d.` as abbreviations of "born" and
      // "died". Joining it to what follows recovers the entry; only a chunk that still
      // will not name itself is reported.
      const chunks = splitEntries(masked, bodyStart, bodyEnd, { lexical: kind === 'LEXICON' });
      for (let i = 0; i < chunks.length; i++) {
        let start = chunks[i].start;
        let entry = nameEntry(text, masked, start, chunks[i].end, kind, starts);
        while (!entry && i + 1 < chunks.length) {
          i++;
          entry = nameEntry(text, masked, start, chunks[i].end, kind, starts);
        }
        if (entry) {
          section.entries.push(entry);
        } else {
          const snippet = masked.slice(start, chunks[i].end).trim().slice(0, 60);
          diagnostics.push(`unnamed ${kind} entry at line ${lineAtIndexed(starts, start)}: ${snippet}`);
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
      const skeleton = parseRuleSkeleton(trimmed);
      return {
        ...base,
        kind: 'rule',
        name: rule[1],
        skeleton: skeleton?.body,
        display: reduceRule(trimmed),
      };
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
 * Parse a rule's right-hand side into a phrase-structure skeleton.
 *
 * Keeps the daughters and the `{ | }` / `( )` structure; drops everything that makes a
 * rule unreadable at a glance and is better seen in the editor pane:
 *
 * - **annotations** — the `:` block after a daughter, up to the `;` that ends it;
 * - **category subscripts** — `VP[fin]` shows as `VP`, and the parameter machinery in
 *   `AP[_type $ {attributive predicative}]` as plain `AP`. The full form stays in the
 *   entry's name and tooltip.
 *
 * Display-only; it never round-trips back to the file.
 */
export function parseRuleSkeleton(chunk: string): { lhs: string; body: RuleSkeleton } | undefined {
  const arrow = chunk.indexOf('-->');
  if (arrow < 0) return undefined;
  // Category subscripts go from the left-hand side too: `VP[_form $ {...}]` -> `VP`.
  const lhs = chunk.slice(0, arrow).trim().replace(/\[[^\]]*\]/g, '');
  const { node } = parseSeq(chunk.slice(arrow + 3), 0, '');
  return { lhs, body: node };
}

function parseSeq(src: string, i: number, stop: string): { node: RuleSkeleton; i: number } {
  const items: RuleSkeleton[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '`') { i += 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '.' || stop.includes(c)) break;
    if (c === ';') { i++; continue; }
    // A daughter's annotation block: skip to the `;` that closes it.
    if (c === ':') { i = skipAnnotation(src, i + 1); continue; }
    if (c === '{') { const r = parseDisj(src, i + 1); items.push(r.node); i = r.i; continue; }
    if (c === '(') {
      const r = parseSeq(src, i + 1, ')');
      items.push({ kind: 'opt', body: r.node });
      i = src[r.i] === ')' ? r.i + 1 : r.i;
      continue;
    }
    if (c === '@') {
      // A template call is one daughter, not a paren group.
      if (src[i + 1] === '(') {
        const close = matchParen(src, i + 1);
        if (close > 0) {
          items.push({ kind: 'call', text: src.slice(i, close + 1).replace(/\s+/g, ' ') });
          i = close + 1;
          continue;
        }
      }
      const m = /^@[A-Za-z_][A-Za-z0-9_'-]*/.exec(src.slice(i));
      if (m) { items.push({ kind: 'call', text: m[0] }); i += m[0].length; continue; }
      i++;
      continue;
    }
    const cat = /^([^\s:;(){}|[\].@]+)(\[[^\]]*\])?([*+])?/.exec(src.slice(i));
    if (cat && cat[1]) {
      items.push({ kind: 'cat', name: cat[1], kleene: cat[3] });
      i += cat[0].length;
      continue;
    }
    i++;
  }
  return { node: { kind: 'seq', items }, i };
}

function parseDisj(src: string, i: number): { node: RuleSkeleton; i: number } {
  const alts: RuleSkeleton[] = [];
  while (i < src.length) {
    const r = parseSeq(src, i, '|}');
    alts.push(r.node);
    i = r.i;
    if (src[i] === '|') { i++; continue; }
    if (src[i] === '}') { i++; }
    break;
  }
  return { node: { kind: 'disj', alts }, i };
}

/** Skip a daughter's annotation, stopping at the `;` or delimiter that ends it. */
function skipAnnotation(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '`') { i += 2; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; }
    else if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ';' || c === '|' || c === '.')) break;
    i++;
  }
  return src[i] === ';' ? i + 1 : i;
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

const DEFAULT_MAX_LABEL = 58;

/**
 * Render a rule skeleton as coloured label parts, short enough to read in the tree.
 *
 * Long rules are shortened by collapsing disjunctions to their first alternative
 * (`{ D N | ... }`) rather than by truncating text, so the shape of the rule survives
 * even when its detail does not. Nested disjunctions collapse first, since those are
 * what usually make a rule unreadable; only if that is still too long does the
 * top-level one collapse too.
 *
 * `maxLen` is a target rather than a hard cap. Once every disjunction is collapsed
 * there is nothing left to drop except real daughters, and a label cut mid-category
 * reads worse than one that overflows into the pane's ellipsis.
 */
export function renderRuleParts(
  lhs: string,
  body: RuleSkeleton,
  maxLen = DEFAULT_MAX_LABEL,
): LabelPart[] {
  const candidates: LabelPart[][] = [];
  for (const elideFrom of [Infinity, 1, 0]) {
    const parts: LabelPart[] = [
      { text: lhs, cls: 'name' },
      { text: ' --> ', cls: 'arrow' },
    ];
    emit(body, 0, elideFrom, parts);
    if (partsLength(parts) <= maxLen) return merge(parts);
    candidates.push(parts);
  }
  // Nothing fits. Collapsing is not monotonic — replacing a one-character alternative
  // with `...` makes a label longer — so take whichever attempt came out shortest
  // rather than assuming the most aggressive one did.
  candidates.sort((a, b) => partsLength(a) - partsLength(b));
  return merge(candidates[0]);
}

function partsLength(parts: LabelPart[]): number {
  return parts.reduce((n, p) => n + p.text.length, 0);
}

function emit(node: RuleSkeleton, depth: number, elideFrom: number, out: LabelPart[]): void {
  switch (node.kind) {
    case 'seq':
      node.items.forEach((item, idx) => {
        if (idx > 0) out.push({ text: ' ' });
        emit(item, depth, elideFrom, out);
      });
      return;
    case 'opt':
      out.push({ text: '(', cls: 'opt' });
      emit(node.body, depth, elideFrom, out);
      out.push({ text: ')', cls: 'opt' });
      return;
    case 'disj': {
      out.push({ text: '{ ', cls: 'disj' });
      if (depth >= elideFrom && node.alts.length > 1) {
        emit(node.alts[0], depth + 1, elideFrom, out);
        out.push({ text: ' | ', cls: 'disj' });
        out.push({ text: '...', cls: 'elide' });
      } else {
        node.alts.forEach((alt, idx) => {
          if (idx > 0) out.push({ text: ' | ', cls: 'disj' });
          emit(alt, depth + 1, elideFrom, out);
        });
      }
      out.push({ text: ' }', cls: 'disj' });
      return;
    }
    case 'call':
      out.push({ text: node.text, cls: 'call' });
      return;
    case 'cat':
      out.push({ text: node.name + (node.kleene ?? '') });
      return;
  }
}

/** Join neighbouring parts that share a class, to keep the rendered DOM small. */
function merge(parts: LabelPart[]): LabelPart[] {
  const out: LabelPart[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.cls === part.cls) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/** The reduced rule as plain text, for the CLI tools and tests. */
export function reduceRule(chunk: string, maxLen = DEFAULT_MAX_LABEL): string | undefined {
  const parsed = parseRuleSkeleton(chunk);
  if (!parsed) return undefined;
  const text = renderRuleParts(parsed.lhs, parsed.body, maxLen).map((p) => p.text).join('');
  return /-->\s*$/.test(text) ? undefined : text;
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
      removals: splitConfigRemovals(head.keyword, value),
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
  return body
    .split(/\s+/)
    .filter((item) => item !== '' && item !== '.')
    // A ParGram config that extends another marks each entry as an addition to, or a
    // removal from, the base config's list: `+eng-lex-ne-tags.lfg`, `-english-index-
    // morphconfig.lfg`. A removal names a file this grammar does *not* include, so it
    // is dropped rather than resolved; an addition is just a path with a sign on it.
    .filter((item) => !item.startsWith('-'))
    .map((item) => item.replace(/^\+/, ''));
}

/** Entries a config marks for removal from the list it inherits. */
export function splitConfigRemovals(keyword: string, value: string): string[] {
  if (['LEXENTRIES', 'RULES', 'TEMPLATES', 'MORPHOLOGY', 'FEATURES'].includes(keyword)) {
    return [];
  }
  return value
    .replace(/\.\s*$/, '')
    .trim()
    .split(/\s+/)
    .filter((item) => item.startsWith('-') && item.length > 1)
    .map((item) => item.slice(1));
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
