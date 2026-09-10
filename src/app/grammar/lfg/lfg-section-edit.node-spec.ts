/**
 * Tests for whole-section edits, checked by re-parsing rather than by string equality.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSection, fileTemplate, removeSection, renameSectionHeader, sectionTemplate } from './lfg-section-edit';
import { parseLfgFile } from './lfg-parser';

const VERBS = join(process.cwd(), 'grammars/dev/lfgxdrt_inference_grammar/rules/verb_fracas_grammar.lfg.glue');
const MORPH = join(process.cwd(), 'grammars/dev/lfgxdrt_inference_grammar/morph_fracas.lfg.glue');

const keys = (text: string): string[] => parseLfgFile(text).sections.map((s) => `${s.key} ${s.kind}`);

describe('sectionTemplate', () => {
  it('produces a section the parser recognises, and it is empty', () => {
    const file = parseLfgFile(sectionTemplate('ADVERB', 'ENGLISH', 'RULES'));
    assert.equal(file.sections.length, 1);
    assert.equal(file.sections[0].key, 'ADVERB ENGLISH');
    assert.equal(file.sections[0].kind, 'RULES');
    assert.deepEqual(file.sections[0].entries, []);
  });
});

describe('fileTemplate', () => {
  it('covers several sections in one file', () => {
    const text = fileTemplate([
      { name1: 'ADVERB', name2: 'ENGLISH', kind: 'RULES' },
      { name1: 'ADVERB', name2: 'ENGLISH', kind: 'LEXICON' },
    ]);
    assert.deepEqual(keys(text), ['ADVERB ENGLISH RULES', 'ADVERB ENGLISH LEXICON']);
  });
});

describe('appendSection', () => {
  it('adds a section to a real file without disturbing the existing one', () => {
    const text = readFileSync(VERBS, 'utf8');
    const before = parseLfgFile(text).sections[0];
    const out = appendSection(text, 'ADVERB', 'ENGLISH', 'RULES');
    const after = parseLfgFile(out).sections;

    assert.equal(after.length, 2);
    assert.equal(after[0].entries.length, before.entries.length, 'the first section is intact');
    assert.equal(after[1].key, 'ADVERB ENGLISH');
  });

  it('handles an empty file', () => {
    assert.deepEqual(keys(appendSection('', 'A', 'B', 'LEXICON')), ['A B LEXICON']);
  });
});

describe('renameSectionHeader', () => {
  it('renames without touching the body', () => {
    const text = readFileSync(VERBS, 'utf8');
    const section = parseLfgFile(text).sections[0];
    const out = renameSectionHeader(text, section, 'VERBAL', 'ENGLISH');
    const after = parseLfgFile(out).sections[0];

    assert.equal(after.key, 'VERBAL ENGLISH');
    assert.equal(after.kind, section.kind);
    assert.deepEqual(after.entries.map((e) => e.name), section.entries.map((e) => e.name));
  });

  it('renames the right one where a file holds several sections', () => {
    // morph_fracas has MORPHOLOGY, RULES and LEXICON in one file.
    const text = readFileSync(MORPH, 'utf8');
    const sections = parseLfgFile(text).sections;
    const rules = sections.find((s) => s.kind === 'RULES')!;
    const out = renameSectionHeader(text, rules, 'INFL', 'ENGLISH');

    assert.deepEqual(keys(out), keys(text).map((k) => (k.endsWith('RULES') ? 'INFL ENGLISH RULES' : k)));
  });
});

describe('removeSection', () => {
  it('takes the terminator with it, so the next section keeps its own', () => {
    const text = readFileSync(MORPH, 'utf8');
    const sections = parseLfgFile(text).sections;
    const out = removeSection(text, sections.find((s) => s.kind === 'RULES')!);
    const after = parseLfgFile(out);

    assert.deepEqual(after.sections.map((s) => s.kind), ['MORPHOLOGY', 'LEXICON']);
    // The survivors keep their entries, which is what a stolen terminator would break.
    assert.equal(after.sections[1].entries.length,
      sections.find((s) => s.kind === 'LEXICON')!.entries.length);
  });

  it('removing the only section leaves nothing to parse', () => {
    const text = readFileSync(VERBS, 'utf8');
    const out = removeSection(text, parseLfgFile(text).sections[0]);
    assert.deepEqual(parseLfgFile(out).sections, []);
  });
});
