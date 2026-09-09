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

  it('ignores mid-word hits for a short query', () => {
    // `he` must not drag in `the`, nor template names that merely contain those
    // letters — the single biggest source of filter noise.
    const result = filterTreeDetailed(tree, 'he');
    assert.deepEqual(names(result.nodes), ['he', 'her']);
    assert.equal(result.matches, 2);
  });

  it('still allows mid-word hits once a query is specific enough', () => {
    assert.deepEqual(names(filterTreeDetailed(tree, 'hugg').nodes), ['hugged']);
  });

  it('keeps a section browsable when its own name matches, without counting its entries', () => {
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
