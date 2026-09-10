# TODO

Larger pieces of work, roughly in the order they are worth doing.

## 1. Structure view — a graph of sections, files and the CONFIG that binds them

**Status:** built. Design notes: [`docs/structure-view.md`](docs/structure-view.md).
Still to do from that plan: moving a section between files, and editing CONFIG fields
other than the lists.

A second tab beside the editor showing how the working tree's sections map onto the
files that hold them, and which of them the CONFIG actually declares. From it, create a
section and attach it to a file, or create a whole file — declared in the CONFIG and
pre-filled with the section headers it covers — as well as unlink, rename and delete
sections and files, keeping the config in step.

The point is that a section is only live if *two* things hold: its file is listed in the
CONFIG's `FILES`, and its own name is listed under the matching keyword. Neither the
tree nor the editor shows that second condition, so a section can sit in a file being
quietly ignored by XLE. See the plan for the full design.

## 1b. Deferred: stray `"` characters appearing

**Update:** one reordering fault was found and fixed from the `Most` report — entries
inherited the previous occupant's indentation, which pushed headwords off column 0 and
could pull a comment onto the previous entry's closing line. That is not quote
insertion, so the original report stands open.


**Status:** waiting for a reproducible example.

Reported after reloading and after reordering a lexicon. Not reproduced, and the file
it was seen in had also been hand-edited, so it could not be attributed.

What has been ruled out, over the whole corpus: sorting a section, moving an entry, and
reindenting all preserve the character multiset exactly — 101 sections and 3266 entries,
now asserted by tests, so a regression there would fail the suite.

The remaining suspect is **⌘; (comment region)**. It is the only code path that inserts
quotes, and with no selection it comments the *whole current line* — so one stray
keypress wraps a line in quotes, and doubles any quotes already in it. That matches the
symptom exactly. If it recurs, worth checking whether ⌘; was pressed; the fix would be
to require a selection, or to make the binding harder to hit by accident.

## 2. Skills for writing XLE and related notations

**Status:** not started. Best done in its own session.

Authoring skills, so an agent writing grammar code follows the conventions rather than
reinventing them. In priority order:

1. **XLE** — rules, lexical entries, templates. Syntax rules of each, and, importantly,
   the instruction to *search the grammar for an existing template before writing a new
   one*. This repo's parser already indexes every definition and every call site, so a
   skill can lean on `npm run index` rather than grepping.
2. **Meaning constructors for the GSWB** — glue premise syntax, the `:$ term : type`
   shape, `||` options, and how they attach to lexical entries.
3. **LFGxDRT representations** — the literal DRT notation used in
   `grammars/dev/glue-basic-drt.lfg.glue`.
4. **LiGER rules** — the rewriting notation in `liger_resources/rules/`.

Worth knowing before starting: the corpus already contains defects a skill should help
avoid — `@INTRANS-OBL-EV` is called three times and defined nowhere, and `lose` is
defined twice identically in `verblex_fracas.lfg.glue`.
