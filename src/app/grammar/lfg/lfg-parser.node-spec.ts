/**
 * Unit tests for the LFG parser.
 *
 * Every fixture here is drawn from a real grammar file in `grammars/`. They are the
 * constructs that broke a naive implementation, kept as tests so they stay broken-proof:
 * the full-corpus harness (`npm run harness`) proves nothing regressed in aggregate,
 * while these say *which* construct failed when something does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskComments, splitEntries } from './lfg-lexer';
import { parseLfgFile, reduceRule, splitConfigItems } from './lfg-parser';

/** Wrap a body in a section header + terminator, as a real file would. */
function section(kind: string, body: string): string {
  return `TEST ENGLISH ${kind} (1.0)\n${body}\n----\n`;
}

function entriesOf(kind: string, body: string) {
  const file = parseLfgFile(section(kind, body));
  assert.equal(file.sections.length, 1, 'expected exactly one section');
  assert.deepEqual(file.diagnostics ?? [], [], 'expected no unnamed entries');
  return file.sections[0].entries;
}

describe('maskComments', () => {
  it('blanks comment bodies while preserving offsets and newlines', () => {
    const src = 'A --> B. "a comment"\nC --> D.';
    const masked = maskComments(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked.indexOf('C --> D.'), src.indexOf('C --> D.'));
    assert.ok(!masked.includes('a comment'));
  });

  it('treats a single quote as a word character, not a delimiter', () => {
    // PRED values look like strings, but `'` is also the X-bar bar-level marker.
    // Masking it swallowed C', I' and V' rules in glue-basic-drt.lfg.
    const src = "C' --> (C) IP.\nN --> X.";
    const masked = maskComments(src);
    assert.equal(masked, src, 'single quotes must not be masked at all');
  });

  it('keeps PRED values intact', () => {
    const src = "hug V * (^ PRED) = '%stem<(^SUBJ)(^OBJ)>'.";
    assert.equal(maskComments(src), src);
  });

  it('skips backquote-escaped characters, including an escaped quote', () => {
    const src = 'New` York N * (^ NUM)=sg.';
    assert.equal(maskComments(src), src);
  });

  it('handles a triple-quoted block', () => {
    // `"""x"""` is just "" + "x" + "" to XLE.
    const masked = maskComments('"""\nBasic Glue templates\n"""\nA = B.');
    assert.ok(!masked.includes('Basic Glue templates'));
    assert.ok(masked.includes('A = B.'));
  });

  it('masks a comment containing unbalanced braces and pipes', () => {
    // Modelled on CPnom in noun_fracas_grammar.lfg, whose comment holds `|` and `}`.
    const src = 'CPnom --> { CPrel | "| VPinf }eg. takes an argument" CPto }.';
    const masked = maskComments(src);
    assert.ok(!masked.includes('VPinf'));
    // Brace counting is only correct after masking.
    const opens = (masked.match(/\{/g) ?? []).length;
    const closes = (masked.match(/\}/g) ?? []).length;
    assert.equal(opens, closes);
  });
});

describe('splitEntries', () => {
  it('does not split on a period inside brackets', () => {
    // Glue premises are full of lambda dots: `:$ (\P.P) : ...`
    const body = 'know V-S XLE :$ (\\P.(\\Q.([],[P -> Q]))) : (%ant_t -o %cons_t).';
    const chunks = splitEntries(maskComments(body), 0, body.length);
    assert.equal(chunks.length, 1);
  });

  it('treats a lone period as a headword, not a terminator', () => {
    // functionlex_fracas.lfg really does define the word `.`
    const body = '. \t  PERIOD * (^ STMT-TYPE) = declarative.\n! EXCL * (^ STMT-TYPE) = exclamation.';
    const chunks = splitEntries(maskComments(body), 0, body.length);
    assert.equal(chunks.length, 2);
    assert.ok(body.slice(chunks[0].start, chunks[0].end).includes('PERIOD'));
  });
});

describe('sections', () => {
  it('finds an indented header and an indented ---- terminator', () => {
    const src = ' SENTENCE ENGLISH RULES (1.0)\nS --> NP VP.\n   ----\n';
    const file = parseLfgFile(src);
    assert.equal(file.sections.length, 1);
    assert.equal(file.sections[0].key, 'SENTENCE ENGLISH');
    assert.equal(file.sections[0].entries.length, 1);
  });

  it('finds several sections in one file', () => {
    const src = section('MORPHOLOGY', 'TOKENIZE:\na.fst') + section('RULES', 'S --> NP VP.') +
      section('LEXICON', 'dog N * (^ NUM)=sg.');
    const file = parseLfgFile(src);
    assert.deepEqual(file.sections.map((s) => s.kind), ['MORPHOLOGY', 'RULES', 'LEXICON']);
  });
});

describe('entry naming', () => {
  it('distinguishes a rule from a rule macro inside one RULES section', () => {
    const entries = entriesOf('RULES', 'S --> NP VP.\nNPCOORD(_CAT) = _CAT CONJnp _CAT.');
    assert.deepEqual(entries.map((e) => [e.kind, e.name]), [
      ['rule', 'S'],
      ['macro', 'NPCOORD(_CAT)'],
    ]);
  });

  it('keeps category parameters in a rule name', () => {
    const entries = entriesOf('RULES', 'VP[_form $ {cop fin base }] --> V.');
    assert.equal(entries[0].name, 'VP[_form $ {cop fin base }]');
  });

  it('does not mistake a lexical rewrite for a c-structure rule', () => {
    // `-->` also appears inside template bodies, as in PASS.
    const entries = entriesOf('TEMPLATES', 'PASS(FRAME) = { FRAME (^ OBJ)-->(^ SUBJ) }.');
    assert.deepEqual([entries[0].kind, entries[0].name], ['template', 'PASS(FRAME)']);
  });

  it('reads a multiword headword with its backquote intact', () => {
    const entries = entriesOf('LEXICON', 'New` York N * (^ NUM)=sg.');
    assert.equal(entries[0].name, 'New` York');
    assert.equal(entries[0].category, 'N');
    assert.equal(entries[0].morphcode, '*');
  });

  it('handles `;ETC.` with no preceding space', () => {
    const entries = entriesOf('LEXICON', 'hug V-S XLE @(TRANS-EV %stem);ETC.');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'hug');
  });

  it('ignores lexical entries that are commented out', () => {
    // adj_adv_lex_fracas.lfg:81-91 is one comment wrapping six fake entries.
    const entries = entriesOf('LEXICON', 'real A * @(PRED real).\n"British A * @(PRED british); ETC.\nGerman A * @(PRED german); ETC."');
    assert.deepEqual(entries.map((e) => e.name), ['real']);
  });

  it('flags entries carrying glue premises', () => {
    const entries = entriesOf('LEXICON', 'a N * (^ NUM)=sg.\nb N * :$ (\\P.P) : (s::^_t -o %s_t).');
    assert.deepEqual(entries.map((e) => !!e.hasGlue), [false, true]);
  });

  it('records a 1-based line for each entry', () => {
    const entries = entriesOf('RULES', 'S --> NP VP.\n\nVP --> V NP.');
    assert.deepEqual(entries.map((e) => e.line), [2, 4]);
  });

  it('spans point back into the original text', () => {
    const src = section('RULES', 'S --> NP VP.');
    const e = parseLfgFile(src).sections[0].entries[0];
    assert.equal(src.slice(e.start, e.end).trim(), 'S --> NP VP.');
  });
});

describe('CONFIG', () => {
  it('splits a FILES list whose terminating period is fused to the last path', () => {
    const items = splitConfigItems('FILES', 'morph.lfg\nlexica/nounlex_fracas.lfg.');
    assert.deepEqual(items, ['morph.lfg', 'lexica/nounlex_fracas.lfg']);
  });

  it('reads an empty FILES list for a single-file grammar', () => {
    assert.deepEqual(splitConfigItems('FILES', '.'), []);
  });

  it('reads (A B) section references', () => {
    const items = splitConfigItems('RULES', '(DEMO ENGLISH)\n(MORPH ENGLISH).');
    assert.deepEqual(items, ['DEMO ENGLISH', 'MORPH ENGLISH']);
  });

  it('drops interleaved string comments from a FILES list', () => {
    const src = section('CONFIG', '  ROOTCAT ROOT.\n  FILES morph.lfg\n "templates"\n templates/a.lfg.');
    const cfg = parseLfgFile(src).sections[0].config!;
    const files = cfg.find((f) => f.keyword === 'FILES')!;
    assert.deepEqual(files.items, ['morph.lfg', 'templates/a.lfg']);
  });
});

describe('reduceRule', () => {
  it('strips annotations and keeps the category skeleton', () => {
    const out = reduceRule('S --> (ADVP: ! $ (^ ADJUNCT))\n NP: (^ SUBJ)=!\n (! CASE)=nom;\n VP[fin]: (^ TNS-ASP TENSE).');
    assert.equal(out, 'S --> (ADVP) NP VP');
  });

  it('drops category subscripts on both sides of the arrow', () => {
    // `VP[fin]` and the parameter machinery in `AP[_type $ {...}]` are noise in a tree.
    assert.equal(reduceRule('VP[_form $ {cop fin}] --> V[fin] NP.'), 'VP --> V NP');
    assert.equal(
      reduceRule('AP[_type $ {attributive predicative}] --> e ADV* A.'),
      'AP --> e ADV* A',
    );
  });

  it('elides a long disjunction instead of truncating it', () => {
    const long = 'NP --> (ADV) (NEG) { ({ D | PRON | NUMBER | DComp }) AP* (NMod) N (CPnom) PP* | PRON | { NUMBER | D } PP }.';
    const out = reduceRule(long)!;
    // Each disjunction keeps its first alternative and drops the rest, so the shape of
    // the rule survives. The budget is a target, not a hard cap: a single alternative
    // can be longer than it, and cutting mid-category would read worse than overflowing.
    assert.equal(out, 'NP --> (ADV) (NEG) { ({ D | ... }) AP* (NMod) N (CPnom) PP* | ... }');
    assert.ok(out.length < long.length - 30, `expected a much shorter label: ${out}`);
  });

  it('elides the innermost disjunction first', () => {
    // At a budget the rule misses only slightly, the nested disjunction collapses and
    // the top-level alternatives survive.
    const rule = 'VP --> V { { NP | PP | AP | CP } ADV | S }.';
    assert.equal(reduceRule(rule, 35), 'VP --> V { { NP | ... } ADV | S }');
    // Given room, nothing is elided at all.
    assert.equal(reduceRule(rule, 99), 'VP --> V { { NP | PP | AP | CP } ADV | S }');
  });

  it('never returns a longer label than a less aggressive elision would', () => {
    // Collapsing `| S` to `| ...` costs characters, so the most aggressive attempt is
    // not always the shortest one.
    const rule = 'VP --> V { { NP | PP | AP | CP } ADV | S }.';
    const out = reduceRule(rule, 10)!;
    assert.ok(out.length <= 33, `expected the shortest candidate, got ${out.length}: ${out}`);
  });

  it('leaves a short rule alone', () => {
    assert.equal(reduceRule('CPnom --> { CPrel | CPComp | CPto }.'), 'CPnom --> { CPrel | CPComp | CPto }');
  });

  it('keeps disjunction structure', () => {
    const out = reduceRule('NP --> { D N | PRON }.');
    assert.equal(out, 'NP --> { D N | PRON }');
  });

  it('keeps a template call as one daughter', () => {
    const out = reduceRule("CP --> { C' | @(CP-COORD CP) }.");
    assert.equal(out, "CP --> { C' | @(CP-COORD CP) }");
  });

  it('keeps Kleene markers', () => {
    const out = reduceRule('VP --> V PP* (NP).');
    assert.equal(out, 'VP --> V PP* (NP)');
  });
});
