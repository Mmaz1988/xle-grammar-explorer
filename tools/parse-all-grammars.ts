/**
 * Parser regression harness.
 *
 * Parses every grammar file reachable from `grammars/` and asserts that every entry
 * chunk yields an identifier. This is the check that matters: it runs headlessly over
 * the real corpus and catches the whole class of lexing bugs that only show up on one
 * unusual entry buried in a 600-line lexicon.
 *
 * It also checks that no entry has swallowed another. Naming alone cannot catch that:
 * a lexicon whose entries silently merged still names every chunk it produces, and
 * reports a healthy 100%. That is how ParGram's verb lexicon read as 313 entries of
 * 10695 without raising anything — the survivors parsed perfectly.
 *
 * Baselines at the time of writing: the bundled corpus is 71 files, 127 sections,
 * 3278/3278 named; ParGram's English grammar is 34 files, 54 sections, 28776/28776.
 * The swallowing check earns its keep on the latter: reintroduce the headword fix in
 * `splitEntries` and it reports 26757 swallowed entries there and none here, because
 * only a ciphered lexicon has the unpaired brackets that trigger it.
 *
 *   npm run harness                  report and exit non-zero on any problem
 *   npm run harness -- --verbose     also list every section
 *   npm run harness -- <directory>   check a grammar outside this repository
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseLfgFile } from '../src/app/grammar/lfg/lfg-parser';
import { maskComments } from '../src/app/grammar/lfg/lfg-lexer';

const ROOT = join(__dirname, '..', '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const GRAMMARS = args[0] ?? join(ROOT, 'grammars');
const verbose = process.argv.includes('--verbose');

/**
 * The shape of a lexical entry's first line: headword, category, morphcode.
 *
 * Shared with the tokenizer, which uses it to colour headwords. Inside an entry's body
 * it means something has gone wrong — the entry has eaten the one after it.
 */
const LEXICAL_HEAD = /^((?:[^ \t\n`]|`.)+)([ \t]+[^ \n\t]+[ \t]+(?:\*|XLE)(?=\s|$))/;

/**
 * How many entries beyond the first this chunk contains.
 *
 * An entry's span starts where the previous one ended, so it carries the blank lines
 * and comments that sat between them — the headword is not necessarily on the first
 * line. So every line that begins an entry is counted and one is subtracted, rather
 * than skipping a "first line" that may be a comment.
 *
 * Run over masked text, so the six commented-out entries in `adj_adv_lex_fracas` do
 * not count: they are inside a comment and genuinely are not entries.
 */
function swallowed(masked: string, start: number, end: number): number {
  let heads = 0;
  for (const line of masked.slice(start, end).split('\n')) {
    // Only a line at column 0: a continuation is indented.
    if (line.length > 0 && !/^[ \t]/.test(line) && LEXICAL_HEAD.test(line)) heads++;
  }
  return Math.max(0, heads - 1);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // XLE writes its own cache next to the grammar; the files inside use `!` as a
    // path separator and are not grammar source.
    if (name.endsWith('.fileindexdir')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    // `.NOENCRYPT` is a licensed grammar's lexicon: not wrapped in XLE's encrypted
    // container, though its headwords are ciphered. It parses like any other file.
    else if (/\.lfg(\.glue|\.NOENCRYPT)?$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(GRAMMARS).sort();
let sections = 0;
let named = 0;
let total = 0;
const problems: string[] = [];
let merged = 0;
const mergeExamples: string[] = [];
const byKind: Record<string, number> = {};

for (const full of files) {
  const path = relative(GRAMMARS, full);
  const text = readFileSync(full, 'utf8');
  const parsed = parseLfgFile(text, { path });
  const masked = maskComments(text);
  sections += parsed.sections.length;
  for (const s of parsed.sections) {
    if (verbose) {
      console.log(`  ${path}  ${s.key} ${s.kind} (${s.entries.length})`);
    }
    for (const e of s.entries) {
      if (e.kind === 'config-field' || e.kind === 'morph-field') continue;
      total++;
      named++;
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      if (s.kind === 'LEXICON' && e.kind === 'lex') {
        const eaten = swallowed(masked, e.start, e.end);
        if (eaten > 0) {
          merged += eaten;
          if (mergeExamples.length < 5) {
            mergeExamples.push(`${path}:${e.line} "${e.name}" swallowed ${eaten}`);
          }
        }
      }
    }
  }
  for (const d of parsed.diagnostics ?? []) {
    total++;
    problems.push(`${path}: ${d}`);
  }
}

console.log(`\nfiles      ${files.length}`);
console.log(`sections   ${sections}`);
console.log(`entries    ${named}/${total} named  (${total ? ((100 * named) / total).toFixed(1) : '0'}%)`);
console.log(`by kind    ${JSON.stringify(byKind)}`);

if (problems.length) {
  console.error(`\n${problems.length} unnamed entr${problems.length === 1 ? 'y' : 'ies'}:`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  process.exit(1);
}
if (merged > 0) {
  console.error(`\n${merged} entr${merged === 1 ? 'y appears' : 'ies appear'} to have been swallowed:`);
  for (const example of mergeExamples) console.error(`  ${example}`);
  console.error('An entry contains a line that starts a new entry — see splitEntries.');
  process.exit(1);
}

console.log('\nOK — every entry named, none swallowed.');
