# XLE Grammar Explorer

A visual two-pane view of an LFG grammar: a **working tree organised by grammar
section** on the left, and the file an entry lives in — with XLE syntax highlighting —
on the right.

An XLE grammar's logical structure is not file-shaped. `lfgxdrt_inference_grammar` is
15 files across four directories, but what a grammar writer thinks in is sections:
`SENTENCE ENGLISH RULES (1.0)`, `VERB ENGLISH LEXICON (1.0)`. This app inverts the
usual view — sections are the tree, and the file becomes a tag on the entry.

Rules are shown reduced to their phrase-structure skeleton (`S --> (ADVP) NP VP[fin]`),
templates as their signature (`PASS(FRAME)`), lexical entries as their headword.
Clicking an entry opens its file at that entry.

## Running it

```sh
npm install
npm start          # http://localhost:4200
```

Then click **Open folder…** and pick a directory, e.g. `grammars/dev`. A folder may
hold several grammars — `grammars/dev` holds two — so a selector above the tree chooses
which one to view. **Open file…** opens a single `.lfg`/`.lfg.glue` directly; that works
fully for a self-contained grammar, and for a multi-file one the app says so and offers
to open the containing folder instead.

**Chrome or Edge only.** The app reads and writes files directly through the File
System Access API, which Firefox and Safari do not implement. There is no server and
no backend: nothing in the xleplusglue stack can write a file, so the browser does it.

`grammars/` is a symlink to `../xleplusglue/grammars`, so the app has real grammars to
work on. Editing through the app edits those files for real — they will show up in
that repo's `git status`.

## Verification

```sh
npm test           # unit tests + the full-corpus harness
npm run harness    # parse every file under grammars/ and assert every entry is named
npm run index -- grammars/dev/lfgxdrt_inference_grammar [--entries]
npm run build      # production build
```

The harness is the check that matters. It parses all 71 grammar files (127 sections)
and fails if any entry chunk yields no identifier. Current baseline: **3266/3266**.

`npm run index` prints the working tree for a grammar without opening a browser, which
is the quickest way to see what the UI will show.

### Two test conventions

- `*.node-spec.ts` — plain `node:test` specs for the Angular-free parser. Run by
  `npm test`, no browser needed.
- `*.spec.ts` — Karma/Jasmine specs for Angular components. Run by `npm run test:ng`.

## Layout

```
src/app/grammar/          the feature; self-contained, no routing, no app-level services
  lfg/                    parser and language support — plain TypeScript, no Angular
    lfg-lexer.ts            comment masking + depth-aware entry splitting
    lfg-parser.ts           sections, entries, CONFIG, MORPHOLOGY
    lfg-model.ts            types
    lfg-stream-mode.ts      tokenizer, written CodeMirror-5-style so it runs in both 5 and 6
    lfg-language.ts         CodeMirror 6 wiring + the lfg-mode palette
    lfg-indent.ts           port of lfg-next-fill-col
    lfg-commands.ts         port of lfg-comment-region
  workspace/
    fs-access.service.ts    File System Access API
    grammar-index.service.ts  FILES resolution, .lfg shadowing
    grammar-state.service.ts  session state
  grammar-tree/           the section tree
  grammar-editor/         the CodeMirror pane
  grammar-explorer/       the two-pane shell
src/app/app.*             throwaway host shell
```

## Notes on the format

Two constructs defeat a naive parser, and both cost real accuracy:

- **A single quote is not a string delimiter.** PRED values use it (`'walk<(^SUBJ)>'`),
  but so do X-bar categories: `C'`, `I'`, `V'`. Treating it as a delimiter swallows
  everything between them. The emacs mode agrees — `(modify-syntax-entry ?\' "w")`.
- **A period only ends an entry at bracket depth 0.** Glue premises are full of lambda
  dots (`:$ (\P.P) : ...`). Splitting on every period names 22% of lexical entries.

Also: a backquote escapes the next character *including a space*, which is how
multiword headwords are written (``New` York``); `"..."` comments nest by doubling the
quote, not by escaping; `#` comments only inside MORPHOLOGY; and section headers and
their `----` terminators may both be indented.

### `.lfg` vs `.lfg.glue`

In a grammar containing `.lfg.glue` sources, the `.lfg` files are compiler output
(`java -jar jars/liger.jar -glue2lfg`) and are **hidden** — they are regenerated on the
next grammar load, so editing them would be lost.

One wrinkle: a `.glue` grammar's own CONFIG `FILES` block still lists `.lfg` paths,
because the compiler does not rewrite the names it emits. The explorer works around
this by preferring an `X.lfg.glue` sibling whenever one exists. Fixing it upstream in
LiGER would make that preference a no-op rather than break it.

## Performance notes

Parsing is not the bottleneck and never was: indexing the entire corpus (71 files,
500 KB, 3444 entries) takes **21 ms**, and one grammar about 13 ms. The cost is all in
rendering, and two things keep it bounded:

- **Tree children are rendered lazily** (`*ngIf` on the outlet, not a CSS class).
  Angular Material's nested tree renders children into the outlet as soon as the parent
  renders — the usual examples merely hide them with CSS — so a grammar with ~1300
  entries instantiated every node at once and froze the tab. Only expanded subtrees are
  built now: opening a grammar renders 2-6 nodes, and expanding a 200-entry section
  costs ~100 ms.
- **Filter expansion is capped** at 300 entries. A filter matching most of a grammar
  would otherwise re-create the same freeze; past the cap the tree expands to section
  level and says so.

## Status

v1 covers navigate, edit and save. Drag-and-drop of entries between sections is
designed for — every entry carries its exact character range — but not implemented.
