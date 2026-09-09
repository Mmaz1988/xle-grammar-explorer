/**
 * Tests for template-call detection and the pane layout maths.
 *
 * The `@` cases are drawn from real glue grammars: telling a template call apart from
 * function application is what makes go-to-definition and the unresolved-call warning
 * trustworthy on a `.lfg.glue` file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findTemplateCalls, identifierAt, isTemplateCallAt, templateCallAt } from './lfg-references';
import { columnCount, fitSizes, resizeTrack, toColumns } from '../grammar-explorer/editor-panes';

describe('template calls', () => {
  it('finds a bare call and a parenthesised one', () => {
    const calls = findTemplateCalls('a N * @DEF-NAME @(PRED %stem).');
    assert.deepEqual(calls.map((c) => c.name), ['DEF-NAME', 'PRED']);
  });

  it('does not mistake glue application for a call', () => {
    // `V@e` applies V to e; there is no template named `e`.
    const calls = findTemplateCalls(':$ (\\V.([e],[]) + V@e) : (x_v -o y_t).');
    assert.deepEqual(calls, []);
  });

  it('still finds a call written next to a delimiter', () => {
    const calls = findTemplateCalls('X = { @(A b) | @C }.');
    assert.deepEqual(calls.map((c) => c.name), ['A', 'C']);
  });

  it('ignores calls inside comments', () => {
    const calls = findTemplateCalls('X = @REAL "commented @FAKE out".');
    assert.deepEqual(calls.map((c) => c.name), ['REAL']);
  });

  it('ignores a backquote-escaped at sign', () => {
    assert.equal(isTemplateCallAt('@(CONCAT `@ x)', 12), false);
  });

  it('resolves a call from anywhere on it, including the caret at the end', () => {
    const text = 'X = @(PRED %stem).';
    for (const pos of [4, 6, 8, 10]) {
      assert.equal(templateCallAt(text, pos)?.name, 'PRED', `at ${pos}`);
    }
  });

  it('reads the identifier under the caret for a bare category', () => {
    assert.equal(identifierAt('S --> NP VP.', 7)?.name, 'NP');
    assert.equal(identifierAt("CP --> C' IP.", 8)?.name, "C'");
  });
});

describe('pane layout', () => {
  it('stacks in one column for rows, and squares up for grid', () => {
    assert.equal(columnCount('rows', 4), 1);
    assert.equal(columnCount('grid', 1), 1);
    assert.equal(columnCount('grid', 4), 2);
    assert.equal(columnCount('grid', 5), 3);
  });

  it('fills columns without reordering panes', () => {
    assert.deepEqual(toColumns([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
    assert.deepEqual(toColumns([1, 2, 3], 2), [[1, 2], [3]]);
  });

  it('keeps proportions when a track is added or removed', () => {
    const grown = fitSizes([0.8, 0.2], 3);
    assert.equal(grown.length, 3);
    assert.ok(Math.abs(grown.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'sizes sum to 1');
    assert.ok(grown[0] > grown[1], 'the wider track stays wider');

    const shrunk = fitSizes([0.5, 0.3, 0.2], 2);
    assert.ok(Math.abs(shrunk.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });

  it('resizes only the two tracks either side of a divider', () => {
    const out = resizeTrack([0.25, 0.25, 0.5], 0, 0.4);
    assert.ok(Math.abs(out[0] - 0.4) < 1e-9);
    assert.ok(Math.abs(out[1] - 0.1) < 1e-9);
    assert.equal(out[2], 0.5, 'the far track is untouched');
  });

  it('never lets a pane be dragged to nothing', () => {
    const out = resizeTrack([0.5, 0.5], 0, 0.001);
    assert.ok(out[0] >= 0.05, `expected a floor, got ${out[0]}`);
    assert.ok(Math.abs(out[0] + out[1] - 1) < 1e-9);
  });
});

describe('highlighting the two meanings of @', () => {
  it('colours a template call but not glue application', () => {
    // Mirrors the stream mode's own decision, so highlighting and completion agree.
    const call = '@(PRED %stem)';
    const application = 'V@e';
    assert.equal(isTemplateCallAt(call, 0), true);
    assert.equal(isTemplateCallAt(application, 1), false);
  });
});
