/**
 * Tests for the back stack's anchoring.
 *
 * The point of the anchor is the case where the file moved under it, so most of these
 * edit the file between marking a spot and going back to it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markFor, relocate, stampOf, lineAt } from './back-stack';

const FILE = [
  'DEMO ENGLISH TEMPLATES (1.0)',
  '',
  'PASS(FRAME) = @FRAME',
  '              (^ PASSIVE) = +.',
  '',
  'TRANS(P) = @(PRED P).',
].join('\n');

/** The span of `text` in `content`, as the editor would hand it over. */
function spanOf(content: string, text: string) {
  const start = content.indexOf(text);
  return { start, end: start + text.length };
}

describe('relocate', () => {
  it('returns the exact spot when the file is untouched', () => {
    const span = spanOf(FILE, 'TRANS(P) = @(PRED P).');
    const mark = markFor('t.lfg', FILE, span, 6);
    const where = relocate(FILE, mark);
    assert.equal(where.how, 'exact');
    assert.deepEqual(where.span, span);
    assert.equal(where.line, 6);
  });

  it('finds the spot again after an edit above it', () => {
    // The whole point: following a call is usually the prelude to editing, and an edit
    // above the remembered offset would otherwise send Back a few lines off.
    const mark = markFor('t.lfg', FILE, spanOf(FILE, 'TRANS(P) = @(PRED P).'), 6);
    const edited = FILE.replace('DEMO ENGLISH TEMPLATES (1.0)', 'DEMO ENGLISH TEMPLATES (1.0)\n\n"a new comment"');

    const where = relocate(edited, mark);
    assert.equal(where.how, 'moved');
    assert.equal(edited.slice(where.span.start, where.span.end), 'TRANS(P) = @(PRED P).');
    assert.equal(where.line, 8, 'two lines further down');
  });

  it('prefers the occurrence nearest where it used to be', () => {
    // A template called identically twice: an edit is far likelier to have nudged the
    // spot than to have moved it past its twin.
    const doubled = `${FILE}\n\nTRANS(P) = @(PRED P).`;
    const second = doubled.lastIndexOf('TRANS(P) = @(PRED P).');
    const mark = markFor('t.lfg', doubled, { start: second, end: second + 21 }, 8);

    const edited = doubled.replace('DEMO ENGLISH TEMPLATES (1.0)', '"x"\nDEMO ENGLISH TEMPLATES (1.0)');
    const where = relocate(edited, mark);
    assert.equal(where.how, 'moved');
    assert.equal(where.span.start, edited.lastIndexOf('TRANS(P) = @(PRED P).'), 'the second one');
  });

  it('says so when the spot is gone rather than scrolling somewhere arbitrary', () => {
    const mark = markFor('t.lfg', FILE, spanOf(FILE, 'TRANS(P) = @(PRED P).'), 6);
    const gutted = FILE.replace('TRANS(P) = @(PRED P).', '');
    const where = relocate(gutted, mark);
    assert.equal(where.how, 'lost');
  });
});

describe('stampOf', () => {
  it('changes with the content and not otherwise', () => {
    assert.equal(stampOf(FILE), stampOf(`${FILE}`));
    assert.notEqual(stampOf(FILE), stampOf(`${FILE} `));
  });
});

describe('lineAt', () => {
  it('counts lines from one', () => {
    assert.equal(lineAt(FILE, 0), 1);
    assert.equal(lineAt(FILE, FILE.indexOf('PASS(FRAME)')), 3);
  });
});
