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

import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A section header line, which is what makes a file a grammar rather than a fragment. */
const CONFIG_HEADER = /^[ \t]*\S+[ \t]+\S+[ \t]+CONFIG[ \t]*\([\d.]+\)[ \t]*$/m;

/** Caches and generated indexes XLE leaves beside a grammar; never worth walking. */
const SKIP = new Set(['node_modules', '.git', 'tmp']);

/**
 * Where a copy with no grammars beside it remembers to look.
 *
 * A distributable app has no `grammars` symlink and is started by double-click, so it
 * inherits no environment worth reading. The folder its owner picked is kept here
 * instead — the one piece of state this program has.
 */
export function rootsFile(env = process.env, platform = process.platform) {
  if (env.XLE_GRAMMAR_ROOTS_FILE) return env.XLE_GRAMMAR_ROOTS_FILE;
  return join(configDir(env, platform), 'roots');
}

/** Remember where the grammars are, for the next launch. */
export function saveRoots(roots, env = process.env) {
  const file = rootsFile(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, roots.join('\n') + '\n');
  return file;
}

export function grammarRoots(env = process.env, bundled = resolve(here, '..', 'grammars')) {
  const configured = env.XLE_GRAMMAR_ROOTS;
  if (configured) return configured.split(':').filter(Boolean).map((r) => resolve(r));
  if (existsSync(bundled)) return [bundled];
  // No environment and nothing beside us: a shared copy, reading what it was told.
  try {
    return readFileSync(rootsFile(env), 'utf8')
      .split('\n').map((line) => line.trim()).filter(Boolean)
      .filter((dir) => existsSync(dir)).map((dir) => resolve(dir));
  } catch {
    return [];
  }
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

/**
 * A stamp that changes whenever the grammar on disk does.
 *
 * A warm process holds the grammar `create-parser` read, so without this an edit is
 * invisible until the service restarts — which is exactly what you do not want while
 * adding the entry you are checking for. Watching only the main file is not enough,
 * since entries live in the lexica beside it, so the whole directory is stamped.
 *
 * `needsCompile` reports the other staleness, the one no reload here can fix: XLE
 * loads `.lfg`, so an edited `.lfg.glue` does not reach it until LiGER recompiles.
 */
export function grammarStamp(mainPath) {
  const root = dirname(mainPath);
  let newest = 0;
  let needsCompile = false;
  const seen = [];
  stampWalk(root, seen, 0);
  for (const [path, mtime] of seen) {
    if (mtime > newest) newest = mtime;
    if (path.endsWith('.lfg.glue')) {
      const compiled = seen.find(([p]) => p === path.slice(0, -'.glue'.length));
      if (!compiled || compiled[1] < mtime) needsCompile = true;
    }
  }
  return { stamp: newest, needsCompile };
}

function stampWalk(dir, out, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.name.startsWith('.') || entry.name.endsWith('.fileindexdir')) continue;
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) stampWalk(path, out, depth + 1);
    else if (entry.name.endsWith('.lfg') || entry.name.endsWith('.lfg.glue')) {
      out.push([path, stats.mtimeMs]);
    }
  }
}
