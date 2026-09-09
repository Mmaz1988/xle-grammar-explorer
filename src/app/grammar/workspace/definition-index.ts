/**
 * Where every name in a grammar is defined, and which calls resolve to nothing.
 *
 * Built once per grammar and used for go-to-definition, completion, and the unresolved
 * call warning. Everything it needs is already in the parsed sections; this only
 * arranges it by name and applies XLE's own precedence rules.
 */

import { findTemplateCalls } from '../lfg/lfg-references';
import type { LfgFile, Span } from '../lfg/lfg-model';
import type { GrammarUnit } from './grammar-index';

export interface Definition {
  name: string;
  /** Parameter names, empty for a zero-argument template. */
  params: string[];
  kind: 'template' | 'macro' | 'rule';
  path: string;
  line: number;
  span: Span;
  /** The section it lives in, e.g. `STANDARD COMMON`. */
  sectionKey: string;
  /** First line of the definition's body, used as completion detail. */
  summary: string;
}

export interface UnresolvedCall {
  name: string;
  path: string;
  line: number;
}

export interface DefinitionIndex {
  /** Definitions by bare name, most preferred first. */
  byName: Map<string, Definition[]>;
  /** Calls naming something this grammar never defines. */
  unresolved: UnresolvedCall[];
  /** Every distinct callable name, for completion. */
  names: string[];
}

/**
 * Order sections the way the grammar's CONFIG does.
 *
 * XLE resolves a duplicated template name by the order of the `TEMPLATES` list, so a
 * name defined in two sections is not ambiguous to XLE and should not be ambiguous
 * here either. In this repo's dev grammar three names are defined twice — `CASE`,
 * `PRED` and `OT-MARK`, in both `common.templates` and `templates_fracas` — so this is
 * a live case, not a hypothetical one. Sections the CONFIG does not list sort last.
 */
function sectionRank(unit: GrammarUnit, all: Map<string, LfgFile>): Map<string, number> {
  const rank = new Map<string, number>();
  const main = unit.mainPath ? all.get(unit.mainPath) : undefined;
  const config = main?.sections.find((s) => s.kind === 'CONFIG' && s.key === unit.configKey);
  let next = 0;
  for (const keyword of ['TEMPLATES', 'RULES']) {
    for (const key of config?.config?.find((f) => f.keyword === keyword)?.items ?? []) {
      if (!rank.has(key)) rank.set(key, next++);
    }
  }
  return rank;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

export function buildDefinitionIndex(unit: GrammarUnit, all: Map<string, LfgFile>): DefinitionIndex {
  const rank = sectionRank(unit, all);
  const byName = new Map<string, Definition[]>();

  for (const file of unit.files) {
    for (const section of file.sections) {
      for (const entry of section.entries) {
        if (entry.kind !== 'template' && entry.kind !== 'macro' && entry.kind !== 'rule') continue;
        // `PASS(FRAME)` is called as `@PASS`; the parameters are not part of the name.
        const open = entry.name.indexOf('(');
        const bare = open < 0 ? entry.name : entry.name.slice(0, open);
        const params = open < 0
          ? []
          : entry.name.slice(open + 1, entry.name.lastIndexOf(')')).split(/[\s,]+/).filter(Boolean);

        const body = file.text.slice(entry.start, entry.end);
        const summary = body
          .replace(/^\s*/, '')
          .split('\n')[0]
          .replace(/\s+/g, ' ')
          .slice(0, 90);

        const list = byName.get(bare) ?? [];
        list.push({
          name: bare,
          params,
          kind: entry.kind,
          path: file.path,
          line: entry.line,
          span: { start: entry.start, end: entry.end },
          sectionKey: section.key,
          summary,
        });
        byName.set(bare, list);
      }
    }
  }

  for (const list of byName.values()) {
    list.sort((a, b) => (rank.get(a.sectionKey) ?? 99) - (rank.get(b.sectionKey) ?? 99));
  }

  // A call naming nothing is usually a real defect. `INTRANS-OBL-EV` is called three
  // times in this repo's verblex_fracas.lfg.glue and defined nowhere.
  const unresolved: UnresolvedCall[] = [];
  const seen = new Set<string>();
  for (const file of unit.files) {
    for (const call of findTemplateCalls(file.text)) {
      if (byName.has(call.name)) continue;
      const line = lineOf(file.text, call.start);
      const key = `${file.path}:${line}:${call.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unresolved.push({ name: call.name, path: file.path, line });
    }
  }

  return { byName, unresolved, names: [...byName.keys()].sort() };
}

/** Definitions for `name`, most preferred first. */
export function lookup(index: DefinitionIndex, name: string): Definition[] {
  return index.byName.get(name) ?? [];
}
