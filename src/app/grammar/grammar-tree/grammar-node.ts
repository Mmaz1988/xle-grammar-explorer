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
 * Filter the tree to nodes matching `query`, keeping ancestors of any match.
 *
 * Matching is case-insensitive substring over the label. A section or group is kept
 * whole when its own name matches, so typing `VERB` shows both `VERB ENGLISH` sections
 * with all their entries rather than nothing.
 */
export function filterTree(nodes: GrammarNode[], query: string): GrammarNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return nodes;

  const walk = (node: GrammarNode): GrammarNode | undefined => {
    const selfMatch = node.label.toLowerCase().includes(needle);
    if (selfMatch && node.level !== 'group') {
      return node;
    }
    const children = node.children.map(walk).filter((c): c is GrammarNode => c !== undefined);
    if (children.length > 0) {
      return { ...node, children, badge: node.level === 'entry' ? node.badge : String(countEntries(children)) };
    }
    return selfMatch ? { ...node, children: [] } : undefined;
  };

  return nodes.map(walk).filter((n): n is GrammarNode => n !== undefined);
}

export function countEntries(nodes: GrammarNode[]): number {
  return nodes.reduce((n, c) => n + (c.level === 'entry' ? 1 : countEntries(c.children)), 0);
}
