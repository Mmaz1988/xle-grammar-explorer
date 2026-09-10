/**
 * Tests for how a grammar's extent is worked out, including the several-entry-points
 * arrangement ParGram grammars use.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexGrammar, type GrammarSource } from './grammar-index';

function source(files: Record<string, string>): GrammarSource {
  return { listFiles: async () => Object.keys(files), readFile: async (p) => files[p] };
}

const lexicon = (key: string, word: string): string =>
  `${key} LEXICON (1.0)\n${word} N * @A.\n----\n`;

describe('BASECONFIGFILE', () => {
  /**
   * Three parsers over one grammar, which is how the ParGram English grammar is built:
   * a base config holding the real file list, and small entry points that name it and
   * then add or drop a file apiece.
   */
  const files = {
    'english.lfg':
      'STANDARD ENGLISH CONFIG (1.0)\n  ROOTCAT ROOT.\n  FILES core.lfg extra.lfg.\n----\n',
    'core.lfg': lexicon('CORE ENGLISH', 'dog'),
    'extra.lfg': lexicon('EXTRA ENGLISH', 'cat'),
    'index.lfg': lexicon('INDEX ENGLISH', 'owl'),
    'main.lfg':
      'INDEX ENGLISH CONFIG (1.0)\n  BASECONFIGFILE english.lfg.\n  FILES +index.lfg.\n----\n',
    'lean.lfg':
      'LEAN ENGLISH CONFIG (1.0)\n  BASECONFIGFILE english.lfg.\n  FILES -extra.lfg.\n----\n',
  };

  it('gives an entry point everything its base includes', async () => {
    const index = await indexGrammar(source(files), 'test');
    const main = index.grammars.find((g) => g.name === 'main')!;
    assert.deepEqual(main.files.map((f) => f.path).sort(),
      ['core.lfg', 'english.lfg', 'extra.lfg', 'index.lfg', 'main.lfg']);
  });

  it('honours a file the entry point drops from the inherited list', async () => {
    const index = await indexGrammar(source(files), 'test');
    const lean = index.grammars.find((g) => g.name === 'lean')!;
    const paths = lean.files.map((f) => f.path);
    assert.ok(paths.includes('core.lfg'), 'inherited files are still there');
    assert.ok(!paths.includes('extra.lfg'), 'and the one it removes is not');
  });

  it('leaves the base config usable as a grammar in its own right', async () => {
    const index = await indexGrammar(source(files), 'test');
    const base = index.grammars.find((g) => g.name === 'english')!;
    assert.deepEqual(base.files.map((f) => f.path).sort(),
      ['core.lfg', 'english.lfg', 'extra.lfg']);
  });

  it('reports no missing files for any of them', async () => {
    const index = await indexGrammar(source(files), 'test');
    assert.deepEqual(index.warnings, []);
    for (const unit of index.grammars) assert.deepEqual(unit.missing, [], unit.name);
  });
});
