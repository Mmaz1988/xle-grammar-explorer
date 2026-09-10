/**
 * The structure of a grammar as nodes and edges: the CONFIG, the files it includes, and
 * the sections those files hold.
 *
 * This exists to make one condition visible that neither the working tree nor the
 * editor shows:
 *
 *   A section is live only if its file is listed in the CONFIG's FILES *and* its own
 *   key is listed under the matching keyword.
 *
 * Miss the second and XLE loads the file, parses the section, and applies none of it.
 * Plain TypeScript with no Angular or Cytoscape in sight, so the rule can be tested
 * without a browser.
 */

import { configKeywordFor } from '../lfg/lfg-config-edit';
import type { LfgFile, SectionKind } from '../lfg/lfg-model';
import type { GrammarUnit } from '../workspace/grammar-index';

export type StructureNodeKind = 'config' | 'file' | 'section';

export interface StructureNode {
  id: string;
  kind: StructureNodeKind;
  label: string;
  /** True for the file the grammar is entered through — the one holding the CONFIG. */
  main?: boolean;
  /** Files and sections: where they live. */
  path?: string;
  /** Sections: their `(NAME1 NAME2)` key and section kind. */
  sectionKey?: string;
  sectionKind?: SectionKind;
  /** Sections: how many entries they hold, for the delete confirmation. */
  entryCount?: number;
  /**
   * Whether XLE will actually use this. A file must be in `FILES`; a section must be
   * both in an included file and declared under its keyword.
   */
  live: boolean;
  /** Why not, when `live` is false. */
  reason?: string;
}

export interface StructureEdge {
  id: string;
  source: string;
  target: string;
  /** `files` and `declares` come from the CONFIG; `contains` from the file itself. */
  kind: 'files' | 'declares' | 'contains';
}

export interface StructureGraph {
  nodes: StructureNode[];
  edges: StructureEdge[];
  /** Sections present in an included file but not declared — XLE ignores these. */
  undeclared: StructureNode[];
}

/**
 * Build the graph for one grammar.
 *
 * @param extraFiles Files present in the directory that no CONFIG reaches. The index
 *   drops them from the unit, but they are exactly what this view should show: a file
 *   sitting there being ignored is the failure mode worth seeing.
 */
export function buildStructure(
  unit: GrammarUnit,
  all: Map<string, LfgFile>,
  extraFiles: LfgFile[] = [],
): StructureGraph {
  const main = unit.mainPath ? all.get(unit.mainPath) : undefined;
  const config = main?.sections.find((s) => s.kind === 'CONFIG' && s.key === unit.configKey);

  const declaredFiles = new Set(config?.config?.find((f) => f.keyword === 'FILES')?.items ?? []);
  const declaredSections = new Map<string, Set<string>>();
  for (const f of config?.config ?? []) {
    declaredSections.set(f.keyword, new Set(f.items));
  }

  const nodes: StructureNode[] = [];
  const edges: StructureEdge[] = [];
  const undeclared: StructureNode[] = [];

  /**
   * The CONFIG is a section of the main file, not a thing beside it.
   *
   * Drawing it separately put it in the graph twice — once as its own node and once as
   * a section under the file that holds it — and left the main file looking like any
   * other include. Chaining main file → CONFIG → included files → their sections gives
   * one path from the entry point, with nothing duplicated.
   */
  const configId = `section:${unit.mainPath}:CONFIG:${unit.configKey}`;

  for (const file of [...unit.files, ...extraFiles]) {
    // The main file is included by definition; the others must be named in FILES. The
    // stored paths carry no `.glue`, matching what the compiler emits.
    const isMain = file.path === unit.mainPath;
    const included = isMain || declaredFiles.has(file.path.replace(/\.glue$/, ''));
    const fileId = `file:${file.path}`;

    nodes.push({
      id: fileId,
      kind: 'file',
      label: file.path,
      path: file.path,
      main: isMain,
      live: included,
      reason: included ? undefined : 'not listed in FILES',
    });
    if (included && !isMain) {
      edges.push({ id: `e:files:${file.path}`, source: configId, target: fileId, kind: 'files' });
    }

    for (const section of file.sections) {
      const sectionId = `section:${file.path}:${section.kind}:${section.key}`;
      // Labelled with its kind, like every other section: the key alone names several.
      const keyword = configKeywordFor(section.kind);
      const declared = section.kind === 'CONFIG'
        ? true
        : Boolean(keyword && declaredSections.get(keyword)?.has(section.key));

      const node: StructureNode = {
        id: sectionId,
        // The grammar's own CONFIG keeps its distinct styling, and stays out of the
        // rename and delete commands — it is not an ordinary section.
        kind: section.kind === 'CONFIG' ? 'config' : 'section',
        label: `${section.key} ${section.kind}`,
        path: file.path,
        sectionKey: section.key,
        sectionKind: section.kind,
        entryCount: section.entries.length,
        live: included && declared,
        reason: !included
          ? 'its file is not listed in FILES'
          : declared ? undefined : `not declared under ${keyword ?? 'any keyword'}`,
      };
      nodes.push(node);
      edges.push({ id: `e:contains:${sectionId}`, source: fileId, target: sectionId, kind: 'contains' });
      if (declared && section.kind !== 'CONFIG') {
        edges.push({ id: `e:declares:${sectionId}`, source: configId, target: sectionId, kind: 'declares' });
      }
      if (included && !declared && section.kind !== 'CONFIG') {
        undeclared.push(node);
      }
    }
  }

  return { nodes, edges, undeclared };
}
