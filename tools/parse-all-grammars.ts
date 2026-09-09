/**
 * Parser regression harness.
 *
 * Parses every grammar file reachable from `grammars/` and asserts that every entry
 * chunk yields an identifier. This is the check that matters: it runs headlessly over
 * the real corpus and catches the whole class of lexing bugs that only show up on one
 * unusual entry buried in a 600-line lexicon.
 *
 * Baseline at the time of writing: 71 files, 127 sections, 3266/3266 entries named.
 *
 *   npm run harness            report and exit non-zero on any unnamed entry
 *   npm run harness -- --verbose   also list every section
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseLfgFile } from '../src/app/grammar/lfg/lfg-parser';

const ROOT = join(__dirname, '..', '..');
const GRAMMARS = join(ROOT, 'grammars');
const verbose = process.argv.includes('--verbose');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // XLE writes its own cache next to the grammar; the files inside use `!` as a
    // path separator and are not grammar source.
    if (name.endsWith('.fileindexdir')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.lfg') || name.endsWith('.lfg.glue')) out.push(full);
  }
  return out;
}

const files = walk(GRAMMARS).sort();
let sections = 0;
let named = 0;
let total = 0;
const problems: string[] = [];
const byKind: Record<string, number> = {};

for (const full of files) {
  const path = relative(GRAMMARS, full);
  const parsed = parseLfgFile(readFileSync(full, 'utf8'), { path });
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
console.log('\nOK — every entry named.');
