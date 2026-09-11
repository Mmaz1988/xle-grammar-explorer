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

### Grammars with several entry points

A ParGram-style grammar ships more than one parser over one grammar: a base config
holding the real file list, and small entry points that name it with `BASECONFIGFILE`
and then adjust the list — `+file` adds, `-file` drops. The English ParGram grammar has
three (`main.lfg`, `semtest.lfg`, `postags.lfg`), and each appears in the grammar
selector with its full extent, not just its own handful of files.

`.lfg.NOENCRYPT` files are read too. That is the plain-text counterpart of a file a
grammar ships encrypted, and ParGram's three largest lexica are distributed under that
name — skipping them left most of the vocabulary invisible.

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

**Reindent** — `⌥Q` (lfg-mode's `M-q`) reindents the rule, template or lexical entry
around the caret: two columns per open `{` or `[`, with `|` and `}` hanging back to the
left, ported from `lfg-next-fill-col`. Newlines auto-indent by the same rule.

The head line sits flush left — lfg-mode indents it to column 3 — so the thing being
defined is the leftmost text on the line and a section stays scannable.

Continuation lines align under the first daughter, wherever it is: on the head line,
under whatever follows `-->` (or `=` for a template, the morphcode for a lexical
entry); on a later line, under the indentation the author chose when they broke there.
Only when that would leave the body flush left, level with the head, is a fixed indent
of 8 used instead.

Within a rule, a daughter's annotations indent to the column after its own `:`, so each
daughter's schemata sit under that daughter rather than under the column its siblings
share. The block ends where XLE ends it — at the `;`, or at the parenthesis that wrapped
the daughter, as in `(NP: (^ SUBJ) = ! ... )` — and the next daughter returns to the
shared column. This follows `lfg-format-rule-category`.

Two departures from lfg-mode here. It aligns this way only for lexical entries
(`(max 10 (current-column))`) and caps rules and templates at column 10
(`(min 10 ...)`); all three are treated alike. And it outdents `| ` by two columns but
a bare `|` by one, so the separators of one disjunction land in different columns
depending on whether a space follows the pipe — invisible in emacs, which normalises
the spacing first, but a ragged disjunction here, where line content is left alone.
Every `|` and `}` hangs by two.

Option shortcuts (`⌥Q`, and `⌥'` for go-to-definition) are matched on the physical key
rather than the character produced. On macOS Option is the compose key — `⌥Q` *is* `œ`
— so a binding written against the character can never fire and simply types the
accented letter instead.

Unlike the emacs command it changes *only* leading whitespace — lfg-mode's `M-q` also
collapses runs of spaces and rewrites the inside of comments, and in grammars whose
comments hold commented-out entries that is a way to lose work. A test asserts the
no-content-change property across all 3266 entries in the corpus.

**Completion** — typing `@` offers the grammar's template names with their parameter
lists, `@(` inserts the parameters too. Matching is loose, so `dns` finds
`DEFAULT-NOUN-SEM`.

**Unresolved calls** — a call naming nothing the grammar defines is listed under the
tree. This is usually a real defect: the bundled dev grammar calls `@INTRANS-OBL-EV`
three times and defines it nowhere.

**Moving entries** — drag an entry onto another section to move it there; hold ⌥ to
copy instead. Only sections that can take it will accept the drop — a lexical entry has
no business in a RULES section — and the rest dim while you drag.

The entry travels with whatever comments sit above it, since that is what its parsed
span covers, and it lands at the end of the target section. The edit is left **unsaved**
in panes rather than written to disk: a drag is easy to do by accident, it rewrites two
files at once, and there is no undo across files, so you get to read it and either save
or revert. Moving in or out of a file with unsaved changes is refused, because the
offsets driving the splice describe what is on disk.

**Ordering** — the tree's **File order / A–Z / Category** control is a *view* setting:
sorting to find something never touches a grammar. **Category** groups a lexicon by
part of speech and orders each group by name — a pure category sort would leave dozens
of entries per category in arbitrary order, so name is always the tie-breaker, and
entries with no category (templates, rules) simply sort by name. It sorts both the
entries inside a section and the sections themselves; the top-level groups keep their fixed order, since CONFIG →
RULES → TEMPLATES → LEXICON → MORPHOLOGY is the shape of a grammar rather than an
alphabetical accident. Dragging an entry within its section moves it
in the file, and is offered only in file order with no filter — in a sorted or filtered
tree the rows either side of the pointer are not the entry's neighbours on disk, so
"drop between these two" would name no real position. To write an order into a file, use
**Sort A–Z in file** or **Sort by category in file** on a section's right-click menu.
Both are offered whatever the view is set to — tying the command to the view control
meant the category order could only be written while the tree happened to be showing
it, with nothing on the menu saying so.

Reordering is lossless by construction. A section's entry spans are contiguous — 3165
adjacent pairs across the corpus with no gaps — so its entries are a partition of its
body, and the separators between them stay put while only the entries move through
them. That keeps blank-line grouping where the author left it and confines the diff to
the lines that actually moved.

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

## Checking a sentence

**Sentence** on the toolbar opens a bar across the top: type a sentence and see which of
its words the grammar already knows — the question you ask before adding anything to it.
Each word found becomes a box; clicking it opens that entry, and shift-clicking opens it
in a pane beside what is already there — the same gesture as ⇧ on a go-to-definition,
and the way to line several words of a sentence up at once.

### Asking XLE

The lexicon cannot actually answer "will this word parse". A word in no lexicon may
still parse, because the `-unknown` entry supplies a default analysis for any stem the
morphology knows; and an inflection the lexicon seems to imply may not be analysable at
all. Which of the two happens differs per grammar — the fracas grammar's transducer is
closed-vocabulary, ParGram's guesses at anything.

So if XLE is installed, ask it:

```
npm run xle        # a local oracle on 127.0.0.1:8085
```

It finds XLE on `PATH` or at `XLEPATH`, and on Windows through `wsl`, translating paths
the way LiGER's `XLEStarter` does. It keeps one warm XLE process per grammar, because
`create-parser` costs 0.4s for the fracas grammar and 2.3s for ParGram while a lookup
after that is milliseconds. Grammars are found under `XLE_GRAMMAR_ROOTS` (colon
separated; the bundled `grammars` symlink by default), matched by the main file's name —
the File System Access API never reveals a path, so a name is all the browser has.

The service is optional and the explorer still needs no backend: without it the bar
falls back to matching headwords itself and says so, because a red word must never be
ambiguous between *XLE rejected it* and *nothing asked XLE*.

Words are coloured by what kind of claim the match is:

- **green** — a real lexical entry matches;
- **amber** — it parses, but only because `-unknown` supplies a default analysis for a
  stem the morphology knows. `tractor` is not in the fracas lexicon, yet
  `@(DEFAULT-NOUN-SEM %stem)` gives it a PRED;
- **amber, italic** — it parses only because the morphology *guessed* it. ParGram
  analyses `xqzzy` as happily as `tractor`, so this is a weaker claim again;
- **red** — the morphology cannot analyse it, so the grammar cannot parse it.

Hovering a word says which of these applies and which stems XLE found: *saw* reports
*see*.

Without the oracle the same four colours are driven by headword matching alone, where
green means the lexicon lists the form or defers it to `XLE`, amber means a `*` entry
supplies only the form written, and red means nothing matched. Base forms then come from
a small English stemmer, good enough to say where to look and no more. Multiword
headwords are matched across tokens, longest first, so `At least three` finds the entry
`At` least` rather than leaving *At* and *least* to fail separately.

Note that a grammar shipping encrypted headwords — ParGram's lexica cipher the wordlist
while leaving the structure readable — will report almost everything missing *in the
fallback*. Asking XLE gets the right answer anyway, since the cipher is XLE's own.

Because XLE loads `.lfg` and never `.lfg.glue`, a glue grammar is checked as of its last
compile, not as of the editor buffer.

## Filtering

Matching is a plain case-insensitive substring test — nothing is hidden — over each
entry's **identifier** first (a rule's left-hand side, a template's name, a headword)
and then its rendered label. Searching the identifier is what makes `VP` find the rule
*named* VP rather than every rule that mentions one.

Two rules decide what is presented:

- **The finest match wins.** When a query matches entries inside a section, those
  entries are the hits and the section is just their container. A section is offered as
  a hit only when nothing inside it matched — so `VERB` lets you browse `VERB ENGLISH`
  instead of reporting all 94 of its entries as results, and the tree leaves it closed.
- **Order is by score, not by file position**: exact, then prefix, then word boundary
  (a segment start in a name like `DEFAULT-NOUN-SEM`), then plain substring, with
  containers ranked by their best descendant. `he` still finds everything containing
  those letters, but leads with `He`, `he`, `Her`, `her`, `herself`.

Still missing, and worth adding: restricting a search to one entry kind (lexical
entries only, say), and searching entry *bodies* rather than identifiers.

## Structure view

A second tab beside the editor, drawing the grammar as a graph: the CONFIG, the files it
includes, and the sections those files hold. It exists for a condition neither the tree
nor the editor shows —

> a section is live only if its file is listed in the CONFIG's `FILES` **and** its own
> key is declared under the matching keyword, which is `LEXENTRIES` for a lexicon.

Miss the second and XLE loads the file, parses the section, and applies none of it.
Anything in that state is drawn dashed and counted in the toolbar.

Right-click a node to **add a section** to a file, **rename** it, **remove it from the
grammar** (undeclare, leaving it on disk) or **delete** it. **Add file…** creates a file
pre-filled with its section headers, declares it, and lists it in `FILES`. Nodes drag
freely and keep their positions; declaration edges are off by default, since the CONFIG
declares nearly everything and those edges bury the containment structure.

The working tree stays live while the structure view is showing, and clicking an entry
there brings the editor back with it — a click that quietly updated an invisible pane
would be worse than useless. Staging an edit from the structure view does *not* switch,
so a sequence of structural changes is not interrupted.

Every CONFIG change is staged unsaved like any other edit. A new file is written to disk
at once while its config entries are staged — safe in that direction only, because an
undeclared file is inert whereas a config naming a missing file will not load.

## Planned work

[`TODO.md`](TODO.md) lists what is left: authoring **skills** for XLE and the related
notations. The structure view above is built; its design notes are in
[`docs/structure-view.md`](docs/structure-view.md).

## Status

v1 covers navigate, edit and save, with go-to-definition, completion, multiple panes,
`M-q` reindenting and drag-and-drop moves. What is still open is listed under
*Filtering* above: scoping a search to one entry kind, and searching entry bodies.
