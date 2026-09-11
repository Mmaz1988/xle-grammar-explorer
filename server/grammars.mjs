/**
 * Finding the .lfg files XLE could load.
 *
 * The explorer reaches its grammars through the File System Access API, which hands
 * out handles and deliberately never reveals an absolute path — but `create-parser`
 * takes a path and nothing else. So the two halves are matched by filename: the
 * service walks the roots it was given, and the browser asks for a main file by name.
 *
 * Roots come from XLE_GRAMMAR_ROOTS (colon-separated); the repository's own `grammars`
 * symlink is the default, which covers the grammars checked in beside it.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** A section header line, which is what makes a file a grammar rather than a fragment. */
const CONFIG_HEADER = /^[ \t]*\S+[ \t]+\S+[ \t]+CONFIG[ \t]*\([\d.]+\)[ \t]*$/m;

/** Caches and generated indexes XLE leaves beside a grammar; never worth walking. */
const SKIP = new Set(['node_modules', '.git', 'tmp']);

export function grammarRoots(env = process.env) {
  const configured = env.XLE_GRAMMAR_ROOTS;
  if (configured) return configured.split(':').filter(Boolean).map((r) => resolve(r));
  const bundled = resolve(here, '..', 'grammars');
  return existsSync(bundled) ? [bundled] : [];
}

function walk(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    // A symlinked grammars folder is the normal case here, so follow with statSync.
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (entry.name.endsWith('.fileindexdir')) continue;
      walk(path, out, depth + 1);
    } else if (entry.name.endsWith('.lfg') && stats.size < 8 * 1024 * 1024) {
      try {
        if (CONFIG_HEADER.test(readFileSync(path, 'utf8'))) out.push(path);
      } catch {
        /* unreadable or not text */
      }
    }
  }
}

/** Every loadable grammar under the roots, as absolute paths. */
export function listGrammars(roots = grammarRoots()) {
  const out = [];
  for (const root of roots) walk(root, out, 0);
  return [...new Set(out)].sort();
}

/**
 * Resolve the name the browser knows to a path XLE can load.
 *
 * A glue grammar is edited as `x.lfg.glue` but XLE loads the `x.lfg` that LiGER
 * compiles from it, so the extension is mapped before matching. An ambiguous name
 * returns every candidate and lets the caller choose rather than guessing.
 */
export function resolveGrammar(mainPath, grammars = listGrammars()) {
  const wanted = basename(mainPath).replace(/\.lfg\.glue$/, '.lfg');
  const matches = grammars.filter((p) => basename(p) === wanted);
  return { wanted, matches };
}
