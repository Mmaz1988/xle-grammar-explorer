/**
 * Builds the working tree for a grammar directory.
 *
 * The unit of organisation is a **CONFIG section, not a directory**. A folder can hold
 * several unrelated grammars — `grammars/dev` holds two (a loose single-file grammar
 * and a 15-file one in a subdirectory), and `grammars-fstr-notation` holds four — so
 * indexing produces a list of grammars, each with its own file closure and section
 * tree, rather than one merged pile.
 *
 * File access is abstracted behind {@link GrammarSource} so the same logic runs against
 * the File System Access API in the browser and against `node:fs` in tests.
 */

import { parseLfgFile } from '../lfg/lfg-parser';
import type { LfgFile, LfgSection, SectionKind } from '../lfg/lfg-model';

/** Minimal file access the index needs. Paths are relative to the grammar root. */
export interface GrammarSource {
  /** Every `*.lfg` / `*.lfg.glue` under the root, excluding `*.fileindexdir`. */
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export interface SectionGroup {
  kind: SectionKind;
  sections: Array<{ section: LfgSection; file: LfgFile }>;
}

/**
 * One grammar: a CONFIG section plus the transitive closure of its `FILES` list.
 *
 * `kind: 'unreferenced'` is the catch-all for files no CONFIG reaches — a real case
 * (`kascha/xleplusglue-default-testfile.lfg`), kept visible without being folded into a
 * grammar it is not part of.
 */
export interface GrammarUnit {
  id: string;
  name: string;
  kind: 'grammar' | 'unreferenced';
  mode: 'glue' | 'lfg';
  mainPath?: string;
  configKey?: string;
  files: LfgFile[];
  groups: SectionGroup[];
  entryCount: number;
  /**
   * True when the grammar's `FILES` list could not be resolved — the case where a
   * single file was opened directly and there is no access to its containing folder.
   */
  partial?: boolean;
  /** Paths listed in FILES that could not be found. */
  missing: string[];
}

export interface GrammarIndex {
  /** Name of what was opened (the folder, or the file for a direct file open). */
  name: string;
  grammars: GrammarUnit[];
  /** Every parsed file including hidden ones, keyed by path. */
  all: Map<string, LfgFile>;
  warnings: string[];
}

/** Order the tree shows section kinds in — configuration first, then the big three. */
const GROUP_ORDER: SectionKind[] = ['CONFIG', 'RULES', 'TEMPLATES', 'LEXICON', 'MORPHOLOGY', 'FEATURES'];

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Join and normalise a relative path, resolving `.` and `..` segments. */
export function resolvePath(base: string, rel: string): string {
  const parts = (base === '' ? [] : base.split('/')).concat(rel.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Resolve a path as listed in a CONFIG `FILES` block.
 *
 * A `.lfg.glue` grammar still lists `.lfg` paths in its own FILES block, because the
 * two variants are byte-identical for any file carrying no glue premises and the
 * compiler does not rewrite the list. So prefer an `X.lfg.glue` sibling when one
 * exists, and fall back to the literal path.
 *
 * (Fixing this upstream — having `-glue2lfg` rewrite the names it emits — would make
 * this preference a no-op rather than break it. That work lives in LiGER, out of scope.)
 */
export function resolveConfigFile(base: string, rel: string, exists: (p: string) => boolean): string | undefined {
  const direct = resolvePath(base, rel);
  const glue = `${direct}.glue`;
  if (exists(glue)) return glue;
  if (exists(direct)) return direct;
  return undefined;
}

/**
 * Name a grammar the way a person would refer to it.
 *
 * The CONFIG key is unusable on its own: `grammars-fstr-notation` holds four distinct
 * grammars all keyed `GLUE BASIC`. So use the containing subdirectory when the grammar
 * has one to itself, and the main file's basename otherwise. Checked against all ten
 * grammars in the corpus, this produces the expected name for each.
 */
export function nameGrammar(mainPath: string, files: string[]): string {
  const dirs = new Set(files.map(dirOf));
  const mainDir = dirOf(mainPath);
  if (mainDir !== '' && [...dirs].every((d) => d === mainDir || d.startsWith(`${mainDir}/`))) {
    const segments = mainDir.split('/');
    return segments[segments.length - 1];
  }
  const base = mainPath.slice(mainPath.lastIndexOf('/') + 1);
  return base.replace(/\.lfg(\.glue)?$/, '');
}

export async function indexGrammar(source: GrammarSource, name = 'grammar'): Promise<GrammarIndex> {
  const paths = (await source.listFiles()).slice().sort();
  const present = new Set(paths);
  const warnings: string[] = [];

  // A `.lfg` with a `.lfg.glue` sibling is compiler output. Hide it: it is regenerated
  // by `-glue2lfg` on the next grammar load, so an edit to it would be lost.
  const shadowed = new Set(paths.filter((p) => p.endsWith('.lfg') && present.has(`${p}.glue`)));

  const all = new Map<string, LfgFile>();
  for (const path of paths) {
    const file = parseLfgFile(await source.readFile(path), { path });
    if (shadowed.has(path)) file.shadowed = true;
    all.set(path, file);
    for (const d of file.diagnostics ?? []) warnings.push(`${path}: ${d}`);
  }

  const visible = paths.filter((p) => !shadowed.has(p));
  const grammars: GrammarUnit[] = [];
  const covered = new Set<string>();

  // One grammar per CONFIG section, each taking the transitive closure of its FILES.
  for (const path of visible) {
    for (const section of all.get(path)!.sections) {
      if (section.kind !== 'CONFIG') continue;
      const { closure, missing } = closureOf(path, section.key, all, present, shadowed);
      for (const f of closure) covered.add(f);

      const files = [...closure].sort().map((p) => all.get(p)!);
      const listed = section.config?.find((f) => f.keyword === 'FILES')?.items ?? [];
      grammars.push(makeUnit({
        id: `${path}::${section.key}`,
        name: nameGrammar(path, [...closure]),
        kind: 'grammar',
        mainPath: path,
        configKey: section.key,
        files,
        // Every listed include failed to resolve: this is a file opened without access
        // to its folder, not a broken grammar.
        partial: listed.length > 0 && missing.length === listed.length,
        missing,
      }));
      for (const m of missing) warnings.push(`${path}: FILES lists "${m}", which was not found`);
    }
  }

  // Disambiguate grammars that ended up sharing a name (two CONFIGs in one file).
  const counts = new Map<string, number>();
  for (const g of grammars) counts.set(g.name, (counts.get(g.name) ?? 0) + 1);
  for (const g of grammars) {
    if ((counts.get(g.name) ?? 0) > 1 && g.configKey) g.name = `${g.name} (${g.configKey})`;
  }

  const orphans = visible.filter((p) => !covered.has(p));
  if (grammars.length === 0 && orphans.length > 0) {
    // No CONFIG anywhere — e.g. someone picked `lexica/`. Fall back to treating the
    // whole folder as one implicit grammar, which is the folder-scan path.
    grammars.push(makeUnit({
      id: 'implicit',
      name,
      kind: 'grammar',
      files: orphans.map((p) => all.get(p)!),
      missing: [],
    }));
  } else if (orphans.length > 0) {
    for (const p of orphans) all.get(p)!.unreferenced = true;
    grammars.push(makeUnit({
      id: 'unreferenced',
      name: `Unreferenced files (${orphans.length})`,
      kind: 'unreferenced',
      files: orphans.map((p) => all.get(p)!),
      missing: [],
    }));
  }

  return { name, grammars, all, warnings };
}

function makeUnit(init: Omit<GrammarUnit, 'groups' | 'entryCount' | 'mode'>): GrammarUnit {
  const groups = buildGroups(init.files);
  return {
    ...init,
    groups,
    mode: init.files.some((f) => f.path.endsWith('.lfg.glue')) ? 'glue' : 'lfg',
    entryCount: init.files.reduce((n, f) => n + f.sections.reduce((m, s) => m + s.entries.length, 0), 0),
  };
}

/** Transitive FILES closure starting from one CONFIG section. */
function closureOf(
  mainPath: string,
  key: string,
  all: Map<string, LfgFile>,
  present: Set<string>,
  shadowed: Set<string>,
): { closure: Set<string>; missing: string[] } {
  const closure = new Set<string>([mainPath]);
  const missing: string[] = [];
  const queue = [mainPath];
  let first = true;
  while (queue.length) {
    const path = queue.shift()!;
    for (const section of all.get(path)!.sections) {
      if (section.kind !== 'CONFIG') continue;
      // Only the originating CONFIG defines this grammar's extent; a different CONFIG
      // in the same file belongs to a different grammar.
      if (first && section.key !== key) continue;
      for (const rel of section.config?.find((f) => f.keyword === 'FILES')?.items ?? []) {
        const target = resolveConfigFile(dirOf(path), rel, (p) => present.has(p) && !shadowed.has(p));
        if (!target) { missing.push(rel); continue; }
        if (!closure.has(target)) { closure.add(target); queue.push(target); }
      }
    }
    first = false;
  }
  return { closure, missing };
}

/**
 * Group a grammar's sections by kind.
 *
 * This is the inversion the app exists for: a grammar's logical structure is its
 * sections, not its files. `VERB ENGLISH LEXICON` and `NOUN ENGLISH LEXICON` sit
 * together under LEXICON even though they live in different files.
 */
export function buildGroups(files: LfgFile[]): SectionGroup[] {
  const byKind = new Map<SectionKind, SectionGroup['sections']>();
  for (const file of files) {
    for (const section of file.sections) {
      const list = byKind.get(section.kind) ?? [];
      list.push({ section, file });
      byKind.set(section.kind, list);
    }
  }
  const groups: SectionGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const sections = byKind.get(kind);
    if (sections?.length) groups.push({ kind, sections });
  }
  for (const [kind, sections] of byKind) {
    if (!GROUP_ORDER.includes(kind)) groups.push({ kind, sections });
  }
  return groups;
}
