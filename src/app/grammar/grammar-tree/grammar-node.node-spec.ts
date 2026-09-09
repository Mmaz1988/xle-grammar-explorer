/**
 * Filter behaviour.
 *
 * The numbers here were measured against `grammars/dev/lfgxdrt_inference_grammar`
 * before the ranking existed: `he` returned 27 hits led by `CHECK` and `SCHEMATA`,
 * and `VERB` returned all 94 entries of the two VERB sections. Those are the cases
 * these tests pin.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterTreeDetailed, scoreText, type GrammarNode } from './grammar-node';

function entry(name: string, label = name): GrammarNode {
  return { id: `e:${name}`, name, label, parts: [{ text: label }], level: 'entry', icon: '', tooltip: '', children: [] };
}

function section(key: string, entries: GrammarNode[]): GrammarNode {
  return { id: `s:${key}`, name: key, label: key, parts: [{ text: key }], level: 'section', icon: '', tooltip: '', children: entries };
}

function group(kind: string, sections: GrammarNode[]): GrammarNode {
  return { id: `g:${kind}`, name: kind, label: kind, parts: [{ text: kind }], level: 'group', icon: '', tooltip: '', children: sections };
}

const names = (nodes: GrammarNode[]): string[] => {
  const out: string[] = [];
  const walk = (ns: GrammarNode[]): void => {
    for (const n of ns) {
      if (n.level === 'entry') out.push(n.name);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
};

describe('scoreText', () => {
  it('ranks exact, prefix, word boundary, then substring', () => {
    assert.equal(scoreText('hug', 'hug'), 0);
    assert.equal(scoreText('hugged', 'hug'), 1);
    assert.equal(scoreText('DEFAULT-NOUN-SEM', 'noun'), 2);
    assert.equal(scoreText('SCHEMATA', 'hem'), 3);
    assert.equal(scoreText('unrelated', 'zzz'), undefined);
  });
});

describe('filterTreeDetailed', () => {
  const tree = [
    group('RULES', [
      section('MODIFIER ENGLISH', [entry('ADVP', 'ADVP --> (ADVComp) ADV')]),
      section('VERB ENGLISH', [entry('VP', 'VP --> { VPv | ... }'), entry('VPinf', 'VPinf --> PARTinf VP')]),
    ]),
    group('LEXICON', [
      section('DETPRON ENGLISH', [entry('he'), entry('her'), entry('the')]),
      section('VERB ENGLISH', [entry('hug'), entry('hugged')]),
    ]),
  ];

  it('puts an exact match first, ahead of entries that merely contain it', () => {
    // `VP` used to surface ADVP first, purely because its section came earlier.
    assert.deepEqual(names(filterTreeDetailed(tree, 'VP').nodes).slice(0, 2), ['VP', 'VPinf']);
  });

  it('keeps every substring hit but leads with the best', () => {
    // Nothing is hidden — `the` still matches `he` — but the exact and prefix hits
    // come first rather than being buried wherever the file happens to put them.
    const result = filterTreeDetailed(tree, 'he');
    assert.deepEqual(names(result.nodes).slice(0, 2), ['he', 'her']);
    assert.ok(names(result.nodes).includes('the'), 'a mid-word hit is still reachable');
  });

  it('matches on a substring anywhere', () => {
    assert.deepEqual(names(filterTreeDetailed(tree, 'ugg').nodes), ['hugged']);
  });

  it('prefers the finest match: an entry is the hit, its section only the container', () => {
    // `VP` matches both the VERB ENGLISH section's entries and nothing in its name,
    // so entries are the hits. The reverse case is covered below.
    const result = filterTreeDetailed(tree, 'VP');
    assert.ok(result.matches > 0, 'entries are reported as matches');
    const sections: GrammarNode[] = [];
    const walk = (ns: GrammarNode[]): void => {
      for (const n of ns) {
        if (n.level === 'section') sections.push(n);
        else walk(n.children);
      }
    };
    walk(result.nodes);
    assert.ok(sections.every((s) => s.matched === true), 'sections carry the hits, not are them');
  });

  it('offers a section as the hit only when nothing inside it matched', () => {
    // `VERB` should not report 94 results; it reports none, and leaves the sections
    // there to open. `matched: false` is what stops the tree auto-expanding them.
    const result = filterTreeDetailed(tree, 'VERB ENGLISH');
    assert.equal(result.matches, 0, 'a container match is not an entry match');
    const sections: GrammarNode[] = [];
    const walk = (ns: GrammarNode[]): void => {
      for (const n of ns) {
        if (n.level === 'section') sections.push(n);
        else walk(n.children);
      }
    };
    walk(result.nodes);
    assert.equal(sections.length, 2);
    assert.ok(sections.every((s) => s.matched === false), 'sections are containers, not results');
  });

  it('returns everything for an empty query', () => {
    assert.equal(filterTreeDetailed(tree, '   ').nodes, tree);
  });
});
