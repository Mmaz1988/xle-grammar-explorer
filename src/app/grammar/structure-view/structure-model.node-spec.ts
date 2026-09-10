/**
 * Tests for the structure graph, and especially for the two-condition liveness rule
 * that the view exists to make visible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildStructure } from './structure-model';
import { indexGrammar, type GrammarSource } from '../workspace/grammar-index';
import { removeFromConfigList } from '../lfg/lfg-config-edit';
import { parseLfgFile } from '../lfg/lfg-parser';

const GRAMMAR = join(process.cwd(), 'grammars/dev/lfgxdrt_inference_grammar');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.fileindexdir')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.lfg') || name.endsWith('.lfg.glue')) out.push(full);
  }
  return out;
}

async function load(overrides: Record<string, string> = {}) {
  const files = walk(GRAMMAR).map((f) => relative(GRAMMAR, f));
  const cache: Record<string, string> = {};
  for (const f of files) cache[f] = overrides[f] ?? readFileSync(join(GRAMMAR, f), 'utf8');
  const source: GrammarSource = { listFiles: async () => files, readFile: async (p) => cache[p] };
  const index = await indexGrammar(source, 'test');
  const unit = index.grammars.find((g) => g.kind === 'grammar')!;
  const orphans = index.grammars.find((g) => g.kind === 'unreferenced')?.files ?? [];
  return { graph: buildStructure(unit, index.all, orphans), unit, index };
}

describe('buildStructure', () => {
  it('reports every section of the bundled grammar as live', async () => {
    const { graph } = await load();
    assert.deepEqual(graph.undeclared, [], 'nothing should be silently ignored');
    const dead = graph.nodes.filter((n) => !n.live);
    assert.deepEqual(dead, [], `expected all live, got ${dead.map((n) => n.label).join(', ')}`);
  });

  it('links the config to files and to the sections it declares', async () => {
    const { graph } = await load();
    const kinds = new Set(graph.edges.map((e) => e.kind));
    assert.deepEqual([...kinds].sort(), ['contains', 'declares', 'files']);
    // Every section sits in exactly one file.
    const sections = graph.nodes.filter((n) => n.kind === 'section');
    for (const section of sections) {
      const contains = graph.edges.filter((e) => e.kind === 'contains' && e.target === section.id);
      assert.equal(contains.length, 1, section.label);
    }
  });

  it('catches a section whose declaration was removed', async () => {
    // The case the view exists for: the file still loads and the section still parses,
    // but XLE applies none of it.
    const mainPath = 'main_lfgxdrt_inference_grammar.lfg.glue';
    const text = readFileSync(join(GRAMMAR, mainPath), 'utf8');
    const config = parseLfgFile(text).sections.find((s) => s.kind === 'CONFIG')!;
    const field = config.config!.find((f) => f.keyword === 'RULES')!;
    const edited = removeFromConfigList(text, field, 'VERB ENGLISH');

    const { graph } = await load({ [mainPath]: edited });
    const names = graph.undeclared.map((n) => n.label);
    assert.deepEqual(names, ['VERB ENGLISH RULES']);
    assert.match(graph.undeclared[0].reason!, /not declared under RULES/);
  });

  it('catches a file dropped from FILES, and the sections that go dark with it', async () => {
    const mainPath = 'main_lfgxdrt_inference_grammar.lfg.glue';
    const text = readFileSync(join(GRAMMAR, mainPath), 'utf8');
    const config = parseLfgFile(text).sections.find((s) => s.kind === 'CONFIG')!;
    const field = config.config!.find((f) => f.keyword === 'FILES')!;
    const edited = removeFromConfigList(text, field, 'rules/noun_fracas_grammar.lfg');

    const { graph } = await load({ [mainPath]: edited });
    const file = graph.nodes.find((n) => n.kind === 'file' && n.path === 'rules/noun_fracas_grammar.lfg.glue')!;
    assert.equal(file.live, false);
    assert.match(file.reason!, /not listed in FILES/);

    const section = graph.nodes.find((n) => n.kind === 'section' && n.path === file.path)!;
    assert.equal(section.live, false, 'a section in an excluded file is not live either');
  });

  it('treats a lexicon as declared under LEXENTRIES', async () => {
    const { graph } = await load();
    const lexicon = graph.nodes.find((n) => n.sectionKind === 'LEXICON')!;
    assert.equal(lexicon.live, true, 'looking under LEXICON instead would call this dead');
  });
});
