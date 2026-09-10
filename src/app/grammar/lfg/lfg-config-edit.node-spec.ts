/**
 * Tests for CONFIG list edits.
 *
 * Checked by re-parsing the result and inspecting the field's items, never by comparing
 * strings: an edit that lands in the wrong place can still look plausible as text while
 * producing a config XLE will not load.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addToConfigList, configKeywordFor, removeFromConfigList, replaceInConfigList } from './lfg-config-edit';
import { parseLfgFile } from './lfg-parser';
import type { ConfigField } from './lfg-model';

const MAIN = join(
  process.cwd(),
  'grammars/dev/lfgxdrt_inference_grammar/main_lfgxdrt_inference_grammar.lfg.glue',
);

function field(text: string, keyword: string): ConfigField {
  const config = parseLfgFile(text).sections.find((s) => s.kind === 'CONFIG')!;
  return config.config!.find((f) => f.keyword === keyword)!;
}

function items(text: string, keyword: string): string[] {
  return field(text, keyword).items;
}

describe('configKeywordFor', () => {
  it('sends a lexicon to LEXENTRIES and everything else to its own name', () => {
    assert.equal(configKeywordFor('LEXICON'), 'LEXENTRIES');
    assert.equal(configKeywordFor('RULES'), 'RULES');
    assert.equal(configKeywordFor('TEMPLATES'), 'TEMPLATES');
    assert.equal(configKeywordFor('MORPHOLOGY'), 'MORPHOLOGY');
    assert.equal(configKeywordFor('CONFIG'), undefined, 'a CONFIG declares nothing');
  });
});

describe('addToConfigList', () => {
  const text = readFileSync(MAIN, 'utf8');

  it('adds a path to FILES, whose period is fused to the last entry', () => {
    // The list ends `lexica/nounlex_fracas.lfg.` — appending after that period would
    // put the new path outside the field entirely.
    const before = items(text, 'FILES');
    const out = addToConfigList(text, field(text, 'FILES'), 'rules/adverb_rules.lfg');
    assert.deepEqual(items(out, 'FILES'), [...before, 'rules/adverb_rules.lfg']);
  });

  it('adds a section key to a parenthesised list', () => {
    const before = items(text, 'RULES');
    const out = addToConfigList(text, field(text, 'RULES'), 'ADVERB ENGLISH');
    assert.deepEqual(items(out, 'RULES'), [...before, 'ADVERB ENGLISH']);
  });

  it('adds to LEXENTRIES, where a lexicon is declared', () => {
    const out = addToConfigList(text, field(text, 'LEXENTRIES'), 'ADVERB ENGLISH');
    assert.ok(items(out, 'LEXENTRIES').includes('ADVERB ENGLISH'));
  });

  it('fills an empty list, written as a lone period', () => {
    // A single-file grammar writes `FILES  .`
    const single = 'G B CONFIG (1.0)\n  ROOTCAT ROOT.\n  FILES  .\n----\n';
    const out = addToConfigList(single, field(single, 'FILES'), 'extra.lfg');
    assert.deepEqual(items(out, 'FILES'), ['extra.lfg']);
  });

  it('leaves every other field untouched', () => {
    const out = addToConfigList(text, field(text, 'FILES'), 'rules/adverb_rules.lfg');
    for (const keyword of ['ROOTCAT', 'LEXENTRIES', 'TEMPLATES', 'RULES', 'MORPHOLOGY']) {
      assert.deepEqual(items(out, keyword), items(text, keyword), keyword);
    }
  });

  it('ignores the string comments interleaved in a FILES list', () => {
    // The real list has `"templates"` and `"rules"` banners between the paths.
    const out = addToConfigList(text, field(text, 'FILES'), 'x.lfg');
    assert.ok(out.includes('"templates"'), 'banners survive');
    assert.ok(!items(out, 'FILES').includes('templates'), 'and are not items');
  });
});

describe('removeFromConfigList', () => {
  const text = readFileSync(MAIN, 'utf8');

  it('removes a path from the middle of FILES', () => {
    const out = removeFromConfigList(text, field(text, 'FILES'), 'templates/common.templates.lfg');
    assert.deepEqual(items(out, 'FILES'), items(text, 'FILES').filter((f) => f !== 'templates/common.templates.lfg'));
  });

  it('keeps the terminator attached when the last item goes', () => {
    // The period is fused to the last path, so removing it must not strand the period
    // on a line of its own.
    const last = items(text, 'FILES').at(-1)!;
    const out = removeFromConfigList(text, field(text, 'FILES'), last);
    const remaining = items(out, 'FILES');
    assert.equal(remaining.length, items(text, 'FILES').length - 1);
    assert.ok(!remaining.includes(last));
    assert.ok(!/\n\s*\.\s*\n/.test(out.slice(field(out, 'FILES').start, field(out, 'FILES').end)),
      'no stranded period');
  });

  it('removes a section key', () => {
    const out = removeFromConfigList(text, field(text, 'RULES'), 'COORD ENGLISH');
    assert.ok(!items(out, 'RULES').includes('COORD ENGLISH'));
    assert.equal(items(out, 'RULES').length, items(text, 'RULES').length - 1);
  });

  it('does nothing for an item that is not there', () => {
    assert.equal(removeFromConfigList(text, field(text, 'RULES'), 'NOT THERE'), text);
  });
});

describe('replaceInConfigList', () => {
  const text = readFileSync(MAIN, 'utf8');

  it('renames a key without moving it', () => {
    // Position matters: TEMPLATES and RULES order decides which definition wins for a
    // name declared twice, so a rename must not push the entry to the end.
    const before = items(text, 'RULES');
    const at = before.indexOf('MODIFIER ENGLISH');
    const out = replaceInConfigList(text, field(text, 'RULES'), 'MODIFIER ENGLISH', 'ADJUNCT ENGLISH');
    const after = items(out, 'RULES');
    assert.equal(after[at], 'ADJUNCT ENGLISH');
    assert.equal(after.length, before.length);
  });

  it('renames a path in FILES', () => {
    const out = replaceInConfigList(text, field(text, 'FILES'), 'rules/noun_fracas_grammar.lfg', 'rules/nominal.lfg');
    assert.ok(items(out, 'FILES').includes('rules/nominal.lfg'));
    assert.ok(!items(out, 'FILES').includes('rules/noun_fracas_grammar.lfg'));
  });
});
