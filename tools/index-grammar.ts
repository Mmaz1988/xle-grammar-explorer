/**
 * Index one grammar directory and print its working tree.
 *
 *   npm run index -- grammars/dev/lfgxdrt_inference_grammar
 *   npm run index -- grammars/grammars-fstr-notation --entries
 *
 * Useful as a check on the whole pipeline without a browser, and as the quickest way
 * to see what the tree will look like for a grammar.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { indexGrammar, type GrammarSource } from '../src/app/grammar/workspace/grammar-index';

const ROOT = join(__dirname, '..', '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showEntries = process.argv.includes('--entries');
const dir = join(ROOT, args[0] ?? 'grammars/dev/lfgxdrt_inference_grammar');

function walk(d: string, out: string[] = []): string[] {
  for (const name of readdirSync(d)) {
    if (name.endsWith('.fileindexdir')) continue;
    const full = join(d, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.lfg') || name.endsWith('.lfg.glue')) out.push(full);
  }
  return out;
}

const source: GrammarSource = {
  listFiles: async () => walk(dir).map((f) => relative(dir, f)),
  readFile: async (p) => readFileSync(join(dir, p), 'utf8'),
};

indexGrammar(source, relative(ROOT, dir)).then((index) => {
  const hidden = [...index.all.values()].filter((f) => f.shadowed).length;
  console.log(`\n${index.name}`);
  console.log(`  ${index.grammars.length} grammar(s), ${hidden} hidden as generated .lfg\n`);

  for (const unit of index.grammars) {
    const tag = unit.kind === 'unreferenced' ? '' : `  [${unit.mode}]`;
    console.log(`  ${unit.name}${tag}   ${unit.files.length} file(s), ${unit.entryCount} entries` +
      (unit.partial ? '   [partial: FILES unresolved]' : ''));
    if (unit.mainPath) console.log(`    main: ${unit.mainPath}   config: ${unit.configKey}`);
    for (const group of unit.groups) {
      console.log(`    ${group.kind}`);
      for (const { section, file } of group.sections) {
        console.log(`      ${section.key}  (${section.entries.length})   ${file.path}:${section.line}`);
        if (showEntries) {
          for (const e of section.entries) console.log(`          ${e.display ?? e.name}`);
        }
      }
    }
  }
  if (index.warnings.length) {
    console.log(`\n  warnings:`);
    for (const w of index.warnings) console.log(`    ${w}`);
  }
});
