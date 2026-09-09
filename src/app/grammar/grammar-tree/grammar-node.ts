/**
 * The node shape the working tree renders.
 *
 * A single flat node type for every level (group, section, entry) keeps the template
 * simple and lets one filter walk the whole tree. What differs per level is the icon
 * and the secondary text, both decided here rather than in the template.
 */

import type { EntryKind, LabelPart, LfgEntry, LfgFile, LfgSection, SectionKind } from '../lfg/lfg-model';
import { renderRuleParts } from '../lfg/lfg-parser';
import type { GrammarUnit } from '../workspace/grammar-index';

export type NodeLevel = 'group' | 'section' | 'entry';

export interface GrammarNode {
  /**
   * Identity that survives a rebuild.
   *
   * The tree is rebuilt from scratch after every save, which hands `*ngFor` and the
   * expansion model brand-new objects. Keyed by object identity, that collapses the
   * whole tree and throws away the user's place in it. Keyed by this, the tree looks
   * untouched unless the file's contents actually changed.
   */
  id: string;
  level: NodeLevel;
  /**
   * The entry's own identifier — a rule's left-hand side, a template's name, a
   * headword — as opposed to {@link label}, which for a rule is the whole reduced
   * form. Searching this first is what makes typing `VP` find the rule *named* VP
   * rather than every rule that mentions it.
   */
  name: string;
  /** The one-line identifier shown in the tree. Kept minimal on purpose. */
  label: string;
  /**
   * The label split into coloured runs. Rules get several so they read like the editor
   * does; everything else is a single part.
   */
  parts: LabelPart[];
  /** Small glyph indicating what kind of thing this is. */
  icon: string;
  /** Extra detail, shown on hover rather than inline. */
  tooltip: string;
  /** Right-aligned count, for groups and sections. */
  badge?: string;
  /** Where clicking this node should open. */
  path?: string;
  line?: number;
  span?: { start: number; end: number };
  /** True for a file no CONFIG reaches. */
  unreferenced?: boolean;
  /** For an entry, what kind it is; for a section, which kind of section. */
  entryKind?: EntryKind;
  sectionKind?: SectionKind;
  /** Match rank while filtering; lower is better. */
  score?: number;
  /**
   * Whether this node is a result or merely a container that matched by name.
   * Only a container of real results is worth auto-expanding.
   */
  matched?: boolean;
  children: GrammarNode[];
}

const KIND_ICON: Record<EntryKind, string> = {
  rule: 'arrow_right_alt',
  macro: 'functions',
  template: 'functions',
  lex: 'label',
  'config-field': 'tune',
  'morph-field': 'spellcheck',
};

const GROUP_ICON: Record<SectionKind, string> = {
  CONFIG: 'settings',
  RULES: 'account_tree',
  TEMPLATES: 'functions',
  LEXICON: 'menu_book',
  MORPHOLOGY: 'spellcheck',
  FEATURES: 'tune',
};

const KIND_WORD: Record<EntryKind, string> = {
  rule: 'phrase-structure rule',
  macro: 'rule macro',
  template: 'template',
  lex: 'lexical entry',
  'config-field': 'config field',
  'morph-field': 'morphology field',
};

function entryNode(entry: LfgEntry, file: LfgFile, sectionId: string, occurrence: number): GrammarNode {
  const detail = [
    // The full name, since the label drops category subscripts and elides disjunctions.
    entry.name,
    KIND_WORD[entry.kind],
    entry.category ? `category ${entry.category}` : '',
    entry.morphcode ? `morphcode ${entry.morphcode}` : '',
    entry.hasGlue ? 'has glue premises' : '',
    `${file.path}:${entry.line}`,
  ].filter(Boolean);

  const parts = entryParts(entry);
  return {
    name: entry.name,
    entryKind: entry.kind,
    // Names repeat within a section — a lexicon can define the same headword under
    // two categories — so the occurrence disambiguates.
    id: `${sectionId}/${entry.kind}:${entry.name}#${occurrence}`,
    level: 'entry',
    label: parts.map((p) => p.text).join(''),
    parts,
    icon: KIND_ICON[entry.kind],
    tooltip: detail.join(' · '),
    path: file.path,
    line: entry.line,
    span: { start: entry.start, end: entry.end },
    children: [],
  };
}

/** Split an entry's label into coloured runs, matching the editor's palette. */
function entryParts(entry: LfgEntry): LabelPart[] {
  if (entry.kind === 'rule' && entry.skeleton) {
    // The stored name keeps its category subscript; the label does not.
    return renderRuleParts(entry.name.replace(/\[[^\]]*\]/g, ''), entry.skeleton);
  }
  if (entry.kind === 'template' || entry.kind === 'macro') {
    // Colour the name but leave the parameter list plain, so the name stands out.
    const open = entry.name.indexOf('(');
    return open < 0
      ? [{ text: entry.name, cls: 'name' }]
      : [{ text: entry.name.slice(0, open), cls: 'name' }, { text: entry.name.slice(open) }];
  }
  if (entry.kind === 'config-field' || entry.kind === 'morph-field') {
    const label = entry.display ?? entry.name;
    const rest = label.slice(entry.name.length);
    return [{ text: entry.name, cls: 'name' }, { text: rest, cls: 'muted' }];
  }
  return [{ text: entry.display ?? entry.name }];
}

function sectionNode(section: LfgSection, file: LfgFile): GrammarNode {
  const id = `s:${file.path}:${section.kind}:${section.key}`;
  const seen = new Map<string, number>();
  return {
    id,
    name: section.key,
    sectionKind: section.kind,
    level: 'section',
    label: section.key,
    parts: [{ text: section.key }],
    icon: GROUP_ICON[section.kind] ?? 'folder',
    tooltip: `${section.key} ${section.kind} (${section.version}) — ${file.path}:${section.line}`,
    badge: String(section.entries.length),
    path: file.path,
    line: section.line,
    span: { start: section.start, end: section.end },
    unreferenced: file.unreferenced,
    children: section.entries.map((e) => {
      const key = `${e.kind}:${e.name}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      return entryNode(e, file, id, occurrence);
    }),
  };
}

/** Turn one grammar into the tree the UI binds to. */
export function buildTree(unit: GrammarUnit): GrammarNode[] {
  return unit.groups.map((group) => {
    const children = group.sections.map(({ section, file }) => sectionNode(section, file));
    const total = children.reduce((n, c) => n + c.children.length, 0);
    return {
      id: `g:${group.kind}`,
      name: group.kind,
      level: 'group' as const,
      label: group.kind,
      parts: [{ text: group.kind }],
      icon: GROUP_ICON[group.kind] ?? 'folder',
      tooltip: `${group.sections.length} ${group.kind} section(s), ${total} entries`,
      badge: String(total),
      children,
    };
  });
}

/**
 * How well a string matches a query, lower being better.
 *
 * Ranking matters here because a plain substring test floods the tree: in this
 * corpus `he` matches 27 labels, most of them template names like `CHECK` and
 * `SCHEMATA` that merely contain those letters. An exact hit should not be buried
 * under them.
 */
export function scoreText(text: string, needle: string): number | undefined {
  const haystack = text.toLowerCase();
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  // A word boundary: the start of a segment inside a hyphenated or underscored name,
  // which is how XLE names are built (`DEFAULT-NOUN-SEM`, `ADJUNCT-TYPE_desig`).
  if (new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}`).test(haystack)) return 2;
  return haystack.includes(needle) ? 3 : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A node's score: its own name first, then its rendered label as a weaker match.
 *
 * Every substring hit is a match — nothing is hidden — and the score only decides the
 * order, so an exact hit leads and the rest stay reachable below it.
 */
export function scoreNode(node: GrammarNode, needle: string): number | undefined {
  const byName = scoreText(node.name, needle);
  if (byName !== undefined) return byName;
  const byLabel = scoreText(node.label, needle);
  return byLabel === undefined ? undefined : byLabel + 4;
}

export interface FilterResult {
  nodes: GrammarNode[];
  /** Entries that matched, as opposed to being shown because their parent did. */
  matches: number;
}

/**
 * Filter the tree to what matches `query`, best matches first.
 *
 * Matching is a plain case-insensitive substring test, so nothing is hidden. Two rules
 * decide what is presented as a *hit*:
 *
 * - **The most fine-grained match wins.** If a query matches entries inside a section,
 *   those entries are the hits and the section is only their container. The section
 *   itself is offered as a hit solely when nothing inside it matched — so `VERB` lets
 *   you browse `VERB ENGLISH` rather than reporting all 94 of its entries as results.
 * - **Order is by score**, not by position in the file: exact, then prefix, then word
 *   boundary, then plain substring, with containers ranked by their best descendant.
 */
export function filterTree(nodes: GrammarNode[], query: string): GrammarNode[] {
  return filterTreeDetailed(nodes, query).nodes;
}

export function filterTreeDetailed(nodes: GrammarNode[], query: string): FilterResult {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { nodes, matches: 0 };

  let matches = 0;

  const walk = (node: GrammarNode): GrammarNode | undefined => {
    if (node.level === 'entry') {
      const score = scoreNode(node, needle);
      if (score === undefined) return undefined;
      matches++;
      return { ...node, score, matched: true };
    }

    const children = node.children
      .map(walk)
      .filter((c): c is GrammarNode => c !== undefined)
      .sort((a, b) => (a.score ?? 9) - (b.score ?? 9));

    if (children.length > 0) {
      return {
        ...node,
        children,
        matched: true,
        // A container ranks by its best descendant, so the section holding the exact
        // hit sorts above one that merely contains a weak match.
        score: Math.min(...children.map((c) => c.score ?? 9)),
        badge: String(countEntries(children)),
      };
    }

    // Nothing inside matched, but the container itself might. Keep it browsable
    // without pretending its contents are results.
    const own = scoreNode(node, needle);
    if (own === undefined) return undefined;
    return { ...node, score: own, matched: false };
  };

  return {
    nodes: nodes
      .map(walk)
      .filter((n): n is GrammarNode => n !== undefined)
      .sort((a, b) => (a.score ?? 9) - (b.score ?? 9)),
    matches,
  };
}

export function countEntries(nodes: GrammarNode[]): number {
  return nodes.reduce((n, c) => n + (c.level === 'entry' ? 1 : countEntries(c.children)), 0);
}

/**
 * Which section kind an entry belongs in.
 *
 * Dropping a lexical entry into a RULES section would produce a grammar XLE cannot
 * load, so a move is only offered where it makes sense.
 */
export function sectionKindFor(entry: EntryKind): SectionKind | undefined {
  switch (entry) {
    case 'lex': return 'LEXICON';
    case 'template': return 'TEMPLATES';
    case 'rule':
    case 'macro': return 'RULES';
    default: return undefined;
  }
}

/** Whether `source` may be dropped onto `target`. */
export function canDrop(source: GrammarNode, target: GrammarNode): boolean {
  if (source.level !== 'entry' || target.level !== 'section') return false;
  if (source.entryKind === undefined || target.sectionKind === undefined) return false;
  if (sectionKindFor(source.entryKind) !== target.sectionKind) return false;
  // Dropping an entry back into the section it already lives in is a no-op.
  return !target.children.some((child) => child.id === source.id);
}
