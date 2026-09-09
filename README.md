# XLE Grammar Explorer

A visual two-pane view of an LFG grammar: a **working tree organised by grammar
section** on the left, and the file an entry lives in — with XLE syntax highlighting —
on the right.

An XLE grammar's logical structure is not file-shaped. `lfgxdrt_inference_grammar` is
15 files across four directories, but what a grammar writer thinks in is sections:
`SENTENCE ENGLISH RULES (1.0)`, `VERB ENGLISH LEXICON (1.0)`. This app inverts the
usual view — sections are the tree, and the file becomes a tag on the entry.

Rules are shown reduced to their phrase-structure skeleton (`S --> (ADVP) NP VP`),
templates as their signature (`PASS(FRAME)`), lexical entries as their headword, and
each is coloured with the same palette as the editor. Clicking an entry opens its file
at that entry.

Rule labels drop what makes a rule unreadable at a glance and is better seen in the
editor pane: annotations, category subscripts (`VP[fin]` shows as `VP`, and
`AP[_type $ {attributive predicative}]` as `AP`), and — once a label runs long — the
tail of each disjunction, which collapses to `{ D N | ... }`. Innermost disjunctions
collapse first, since those are usually the noise. The full form stays in the tooltip
and, of course, in the file.

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
npm test           # unit tests + tokenizer checks + the full-corpus harness
npm run harness    # parse every file under grammars/ and assert every entry is named
npm run test:tokens # tokenize every file, then re-check with CodeMirror's real parser
npm run index -- grammars/dev [--entries]
npm run build      # production build
```

The harness is the check that matters. It parses all 71 grammar files (127 sections)
and fails if any entry chunk yields no identifier. Current baseline: **3266/3266**.

`npm run index` prints the working tree for a grammar without opening a browser, which
is the quickest way to see what the UI will show.

### Why there are two tokenizer checks

`tools/tokenize-all-grammars.ts` drives the mode through a hand-written StringStream
shim — fast, dependency-free, and only ever as faithful as the shim.
`tools/parse-with-codemirror.mjs` runs CodeMirror's *real* parser over the same files
in a child process under a wall-clock timeout.

The second exists because the first once passed on all 71 files while the app hung on
the first file it opened. CodeMirror's `StringStream.peek()` returns `undefined` past
end of line; the shim returned `null`; the comment scanner looped on `!== null` and so
never terminated on any line ending inside a `"..."` comment — which is every
multi-line comment in every grammar here. A shim can always drift from the API it
imitates, so the real parser gets a vote too. The timeout matters as much as the check:
a tokenizer that loops inside one `token()` call never returns to CodeMirror, so its
own parse budget never fires and the run just hangs.

### Two test conventions

- `*.node-spec.ts` — plain `node:test` specs for the Angular-free parser and layout
  maths. Run by `npm test`; fast, no browser.
- `*.spec.ts` — Karma/Jasmine component specs, run by `npm run test:ng`
  (`npm run test:all` runs both).

The component specs are not decoration. One class of bug here is invisible to
everything else: the pane arrangement was once computed by a getter, so `*ngFor` saw
new arrays on every change-detection pass, destroyed every pane and rebuilt its editor
— and a rebuilt editor focuses itself, which schedules the next pass. Inside Angular's
zone that is an infinite loop that freezes the tab on the first click; outside it,
where scripted browser testing runs, nothing happens at all. Only real change detection
shows it, so `grammar-explorer.component.spec.ts` asserts that repeated passes leave
the editor DOM node and the column arrays identical.

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

## Navigation and editing

**Go to definition** — `F12` or ⌘-click on a template call jumps to its definition,
across files; `← Back` returns. Hold **Shift** (⌘⇧-click, or `Shift-F12`) to open the
definition in a pane beside the current file instead of replacing it, for reading a
template and its call site together. A jump that opens beside pushes nothing onto the
back stack, since where you came from is still on screen. A bare identifier also resolves, so a category in a
rule's right-hand side jumps to the rule defining it. When a name is defined more than
once the CONFIG `TEMPLATES`/`RULES` order decides which wins — exactly as it does for
XLE — and the alternatives are named rather than silently dropped. (In
`lfgxdrt_inference_grammar`, `CASE`, `PRED` and `OT-MARK` are each defined twice.)

**Completion** — typing `@` offers the grammar's template names with their parameter
lists, `@(` inserts the parameters too. Matching is loose, so `dns` finds
`DEFAULT-NOUN-SEM`.

**Unresolved calls** — a call naming nothing the grammar defines is listed under the
tree. This is usually a real defect: the bundled dev grammar calls `@INTRANS-OBL-EV`
three times and defines it nowhere.

**Multiple panes** — right-click a tree row (ctrl-click on a Mac) and choose **Open in
split view** to open it in a pane of its own. `Rows` stacks the panes, `Grid` tiles them into roughly equal squares,
and every divider drags. A split always gets its own pane even when the file is already
open, since reading two places in one file is the main reason to ask for one. A plain
click reuses the active pane, unless it has unsaved changes, in which case the file
opens in a new pane rather than the click being refused.

### The two meanings of `@`

In a `.lfg.glue` file `@` is both a template call and function application inside a
glue premise: `:$ (\V.([e],[]) + V@e)` applies `V` to `e`. Read naively, `V@e` looks
like a call to a template named `e` — in the dev grammar that mistake accounts for 74
of 77 apparently-unresolved calls. Since a call's `@` starts a schema it never directly
follows a term, while application's always does, and that positional rule is what
completion, go-to-definition, the unresolved-call list and the highlighter all use.

## Saving and the session

**Save is per pane.** ⌘S saves the pane with focus; each pane's Save button saves that
pane alone. When more than one pane has unsaved changes a **Save all (n)** button
appears, so an edit in a pane you are not looking at is not silently left behind.

Saving re-parses the file and refreshes every grammar that includes it, which rebuilds
the tree — but the tree keeps its expanded rows and your place in it, because nodes
carry ids that survive the rebuild rather than being tracked by object identity.

**The workspace is remembered.** The picked directory is stored in IndexedDB (a
`FileSystemDirectoryHandle` is structured-cloneable, which is why this cannot be
`localStorage`), along with the selected grammar, open files and their positions,
expanded rows, filter and layout. On the next visit the app offers to reopen it.

It has to be an offer, not a silent restore: the handle survives a reload but its
permission usually does not, and asking for permission requires a user gesture. When
permission does survive, the workspace comes back on its own.

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
