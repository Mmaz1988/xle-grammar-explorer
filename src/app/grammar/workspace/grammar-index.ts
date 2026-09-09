/**
 * Builds the working tree for a grammar directory.
 *
 * Two jobs beyond parsing individual files:
 *
 *  - decide which files belong to the grammar, by following each CONFIG's `FILES`
 *    list and falling back to a folder scan for anything no config reaches;
 *  - decide which files a human should *see*, which is not the same set.
 *
 * File access is abstracted behind {@link GrammarSource} so the same logic runs
 * against the File System Access API in the browser and against `node:fs` in tests.
 */

import { parseLfgFile } from '../lfg/lfg-parser';
import type { LfgFile, LfgSection, SectionKind } from '../lfg/lfg-model';

/** Minimal file access the index needs. Paths are relative to the grammar root. */
export interface GrammarSource {
  /** Every `*.lfg` / `*.lfg.glue` under the root, excluding `*.fileindexdir`. */
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export interface GrammarIndex {
  /** Display name of the grammar, normally the directory name. */
  name: string;
  /**
   * `glue` when the directory contains any `.lfg.glue`. In glue mode the `.lfg` files
   * are compiler output and are hidden.
   */
  mode: 'glue' | 'lfg';
  /** Files a human should see, in path order. */
  files: LfgFile[];
  /** Every parsed file including hidden ones, keyed by path. */
  all: Map<string, LfgFile>;
  /** The section tree, grouped by section kind then by named section. */
  groups: SectionGroup[];
  warnings: string[];
}

export interface SectionGroup {
  kind: SectionKind;
  sections: Array<{ section: LfgSection; file: LfgFile }>;
}

/** Order the tree shows section kinds in — configuration first, then the big three. */
const GROUP_ORDER: SectionKind[] = ['CONFIG', 'RULES', 'TEMPLATES', 'LEXICON', 'MORPHOLOGY', 'FEATURES'];

/** Directory part of a relative path, '' for a top-level file. */
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
 * two variants are byte-identical for any file that carries no glue premises and the
 * compiler does not rewrite the list. So prefer an `X.lfg.glue` sibling whenever one
 * exists, and fall back to the literal path otherwise.
 *
 * (Fixing this upstream — having `-glue2lfg` rewrite the names it emits — would make
 * this a no-op rather than break it, since the preference simply stops finding
 * anything to rewrite. That work lives in LiGER and is deliberately out of scope.)
 */
export function resolveConfigFile(base: string, rel: string, exists: (p: string) => boolean): string | undefined {
  const direct = resolvePath(base, rel);
  const glue = `${direct}.glue`;
  if (exists(glue)) return glue;
  if (exists(direct)) return direct;
  return undefined;
}

export async function indexGrammar(source: GrammarSource, name = 'grammar'): Promise<GrammarIndex> {
  const paths = (await source.listFiles()).slice().sort();
  const present = new Set(paths);
  const warnings: string[] = [];

  const mode: 'glue' | 'lfg' = paths.some((p) => p.endsWith('.lfg.glue')) ? 'glue' : 'lfg';

  // A `.lfg` with a `.lfg.glue` sibling is generated output. Hide it: it is regenerated
  // by `-glue2lfg` on the next grammar load, and editing it would be lost.
  const shadowed = new Set(paths.filter((p) => p.endsWith('.lfg') && present.has(`${p}.glue`)));

  const all = new Map<string, LfgFile>();
  for (const path of paths) {
    const file = parseLfgFile(await source.readFile(path), { path });
    if (shadowed.has(path)) file.shadowed = true;
    all.set(path, file);
    for (const d of file.diagnostics ?? []) warnings.push(`${path}: ${d}`);
  }

  // Walk the FILES graph from every config-bearing file. Transitive, because an
  // included file may itself carry a CONFIG.
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const [path, file] of all) {
    if (shadowed.has(path)) continue;
    if (file.sections.some((s) => s.kind === 'CONFIG')) {
      reachable.add(path);
      queue.push(path);
    }
  }
  while (queue.length) {
    const path = queue.shift()!;
    const file = all.get(path)!;
    for (const section of file.sections) {
      if (section.kind !== 'CONFIG') continue;
      const files = section.config?.find((f) => f.keyword === 'FILES');
      for (const rel of files?.items ?? []) {
        const target = resolveConfigFile(dirOf(path), rel, (p) => present.has(p));
        if (!target) {
          warnings.push(`${path}: FILES lists "${rel}", which does not exist`);
          continue;
        }
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
  }

  const visible: LfgFile[] = [];
  for (const path of paths) {
    if (shadowed.has(path)) continue;
    const file = all.get(path)!;
    if (!reachable.has(path)) file.unreferenced = true;
    visible.push(file);
  }

  return { name, mode, files: visible, all, groups: buildGroups(visible), warnings };
}

/**
 * Group sections by kind, then by the order they were found.
 *
 * This is the inversion the app exists for: a grammar's logical structure is its
 * sections, not its files. `VERB ENGLISH LEXICON` and `NOUN ENGLISH LEXICON` sit
 * together under LEXICON even though they live in different files, and the file
 * becomes a tag on the section rather than the thing you navigate.
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
