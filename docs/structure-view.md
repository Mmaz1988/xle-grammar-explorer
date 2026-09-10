# Structure view

A second tab beside the editor, showing how a grammar's **sections**, the **files** that
hold them, and the **CONFIG** that declares them fit together — and letting you create
sections and files from that view without hand-editing the config.

## Why

The working tree deliberately hides files: it organises a grammar by section, because
that is how a grammar writer thinks. The editor shows one file at a time. Neither shows
the binding between them, and that binding has a condition which is invisible today:

> A section is live only if **both** its file is listed in the CONFIG's `FILES` **and**
> its own `(NAME1 NAME2)` key is listed under the matching keyword.

The keyword is the section kind, except for lexicons:

| Section kind | Declared under |
|---|---|
| `RULES` | `RULES` |
| `TEMPLATES` | `TEMPLATES` |
| `LEXICON` | **`LEXENTRIES`** |
| `MORPHOLOGY` | `MORPHOLOGY` |

Miss the second condition and XLE silently ignores the section — the file loads, the
section parses, nothing in it applies. Checked across the bundled grammars, every
section is currently declared, so this is about *keeping* it that way as sections and
files get added, which is exactly what the creation flows below are for.

## What it shows

Three layers, left to right: the CONFIG, the files it includes, the sections those files
contain. Two kinds of edge:

- **file edges** — `CONFIG --FILES--> file`
- **declaration edges** — `CONFIG --RULES/TEMPLATES/LEXENTRIES/MORPHOLOGY--> section`

with `file --contains--> section` between the last two layers. A section reached by both
a contains-edge and a declaration-edge is live; one reached only by containment is
drawn dashed and flagged, because XLE will ignore it. A file with no incoming `FILES`
edge is likewise inert — the index already computes that as `unreferenced`.

**Rendering:** Cytoscape with the `dagre` layered layout. Nodes drag to rearrange and
positions persist per grammar in the existing IndexedDB workspace record, so the graph
looks the same each time it is opened. Cytoscape is already the xleplusglue client's
graph library, so this carries over if the view is ever ported there. Cost is roughly
400 KB on an 810 KB bundle, comfortably inside the client's 2 MB budget.

## Operations

All three write through the same staging rule as everything else: **the CONFIG edit is
staged unsaved and its file is opened in the Editor tab**, so switching back from the
structure view shows the pending change ready to review, save or revert.

### Add a section to an existing file

Right-click a file → **Add section**. Ask for the two name tokens and the kind, then:

1. Append to the file:
   ```
   <NAME1> <NAME2> <KIND> (1.0)


   ----
   ```
2. Add `(NAME1 NAME2)` to the CONFIG's list for that kind.

### Add a section not attached to any file yet

Same dialog reached from the CONFIG node; it asks which file should hold it, then runs
the flow above. This is the "create a section and link it to a file" case.

### Add a file

Ask for a path (relative to the main file's directory) and the sections it covers — at
least one, since an empty file has nothing to declare. Then:

1. Create the file, with a header block per section, `----`-terminated as above.
2. Add its path to the CONFIG's `FILES`.
3. Declare each of its sections under the matching keyword.

The file is written to disk immediately; only the CONFIG edit is staged. That
asymmetry is safe in this one direction: an undeclared file is inert, so the
intermediate state cannot break the grammar, whereas a config listing a file that does
not exist would stop it loading.

**Paths in `FILES` are written without the `.glue` suffix**, matching what the compiler
emits and what the resolver already expects — see the `.lfg` → `.lfg.glue` rule in the
README.

## The pieces to build

### `lfg/lfg-config-edit.ts` — pure text edits to a CONFIG (new)

The delicate part, and the reason it is pure and separately tested:

- `addToConfigList(text, field, item)` — insert into `FILES`, `RULES`, `TEMPLATES`,
  `LEXENTRIES` or `MORPHOLOGY`, before the field's terminating period, matching the
  indentation of the existing entries.
- `removeFromConfigList(text, field, item)` — the inverse, for unlinking.
- `replaceInConfigList(text, field, from, to)` — for renames, substituting **in place**
  so list order, and therefore precedence, is preserved.

### `lfg/lfg-section-edit.ts` — section text edits (new)

- `removeSection(text, section)` — cut from the header through the `----`, leaving the
  surrounding blank lines tidy.
- `renameSectionHeader(text, section, name1, name2)` — rewrite the header only.

Section spans already come from the parser, so neither re-derives boundaries.

Two shapes to get right, both real in this corpus:

- The terminating period is **fused to the last item** — `lexica/nounlex_fracas.lfg.` —
  so an item is inserted before that period, not after the last line.
- An empty list is written `FILES  .`, so the first insertion replaces the lone period
  rather than appending beside it.

Tests assert by **re-parsing** the result and checking the field's `items`, not by
comparing strings — the same discipline as `lfg-move.ts`, for the same reason.

### `lfg/lfg-scaffold.ts` — section boilerplate (new)

`sectionTemplate(name1, name2, kind)` and `fileTemplate(sections)`. Small, but worth
isolating so the exact `----` convention lives in one place with a test.

### `workspace/fs-access.service.ts` — creation and removal (extend)

`createFile(path, contents)`, creating intermediate directories, plus `deleteFile(path)`
and `renameFile(from, to)` — the latter as copy-then-delete, since the API has no rename.
`getDirectoryHandle`, `getFileHandle` and `removeEntry` are all available on the handles
this app already holds, and the first two accept `{ create: true }` — verified in the
browser. Existing paths must be refused rather than overwritten.

### `structure-view/` — the tab (new)

`structure-graph.component` renders the Cytoscape graph and emits the three creation
requests; `structure-model.ts` turns a `GrammarUnit` plus its CONFIG into nodes and
edges, including the live/undeclared distinction. Model building is plain TypeScript
and gets node-level tests; the component gets Karma specs.

### `grammar-explorer` — the tab switch (extend)

The right pane gains **Editor | Structure**. Structure replaces the pane area rather
than becoming another pane: it is a view of the whole grammar, not of a file. Switching
to Editor after a creation lands on the staged CONFIG file.

## Removing, unlinking and renaming

Two different things, and the view should not blur them:

- **Unlink** — take a section or file out of the CONFIG, leaving it on disk. XLE stops
  seeing it; nothing is lost. A text edit to the config, staged like any other.
- **Delete** — remove the section's text, or the file itself. Destructive.

Unlink is the safer default and is what is usually wanted, so it leads on the menu and
delete is worded explicitly (**Delete file from disk**, not "Remove").

### Unlink a section / a file

Remove `(NAME1 NAME2)` from its keyword list, or the path from `FILES`. The node stays
in the graph, drawn dashed as "present but undeclared". Re-linking is the same edit in
reverse, so this is fully reversible from within the view.

### Rename a section

Two edits that must land together:

1. the header in the file — `OLD1 OLD2 KIND (1.0)` becomes `NEW1 NEW2 KIND (1.0)`;
2. its entry in the CONFIG list, **replaced in place**.

In place matters: for `TEMPLATES` and `RULES` the list order decides which definition
wins when a name is defined twice, so appending the new key instead of substituting it
would silently change precedence. This corpus has three such names — `CASE`, `PRED` and
`OT-MARK`.

The two edits are in different files, so both panes are staged dirty and saving only one
leaves the section dark — declared under a name no file defines, or defined under a name
the config never mentions. The notice must name both files, and **Save all** already
appears whenever more than one pane is dirty.

### Rename a file

The File System Access API has no rename, so it is create-with-contents, delete the old,
and replace the path in `FILES` in place. Two wrinkles specific to this corpus:

- **Paths in `FILES` carry no `.glue`.** Renaming `lexica/verblex.lfg.glue` rewrites the
  config entry `lexica/verblex.lfg`.
- **The generated `.lfg` shadow.** A renamed `.lfg.glue` leaves its old compiled sibling
  behind under the old name, where it is an orphan the resolver would still find. Offer
  to delete the shadow alongside, defaulting to yes — it is regenerated by `-glue2lfg`
  on the next grammar load.

### Delete a section

Cut from its header through its `----`, and undeclare it. Its entries go with it, so the
confirmation states the count: *"Delete VERB ENGLISH LEXICON and its 79 entries?"* If
the file is left with no sections at all, offer to delete the file too rather than
leaving an empty one declared in `FILES`.

### Delete a file

Delete from disk, drop it from `FILES`, and undeclare every section it held. The
confirmation counts all three: *"Delete lexica/verblex_fracas.lfg.glue — 1 section,
79 entries?"* Plus the shadow, as above.

### What makes deletion acceptable here

There is no undo across files, and a deleted file cannot be staged for review the way a
text edit can. What makes it tolerable is that these grammars are **tracked in the
xleplusglue repository** — 22 files under version control for `lfgxdrt_inference_grammar`
alone — so `git checkout` recovers anything deleted by mistake. The confirmation should
say so plainly rather than implying the app can undo it.

Ordering is chosen so that a failure part-way through leaves the grammar loadable: the
config edit is staged first and the disk deletion happens last, because a config naming
a missing file will not load, while a file nothing references is merely inert.

## Validation

Refuse, with a reason, before writing anything:

- a section key already used by another section of the same kind in this grammar —
  on rename as well as on create;
- a file path that already exists, or escapes the grammar directory;
- a rename that would leave a template or rule name defined nowhere while calls to it
  remain: the definition index already knows every call site, so the confirmation can
  say how many would break;
- name tokens that are not bare identifiers — XLE section headers are three whitespace
  separated tokens plus a version, so a space in a token would produce a header that
  parses as something else entirely;
- a section whose kind has no CONFIG keyword (`CONFIG` itself).

## Verification

- **Node tests** for the config edits and the scaffolding: insert into a fused-period
  list, into an empty `FILES .`, and into each keyword list, re-parsing each result.
- **A round-trip test on the real grammar**: add a section and a file to a copy of
  `lfgxdrt_inference_grammar`, re-index, and assert the new section is live by the
  two-condition rule above — and that every previously live section still is.
- **Karma specs** for the tab switch and for the graph emitting the right request.
- **By hand**, since the picker needs a real gesture: create a file, check it appears on
  disk with correct headers, check the CONFIG opens staged in the Editor tab, save, and
  confirm the new section shows as live in both the tree and the graph.

## Out of scope for v1

Moving a section between files, and editing CONFIG fields other than the lists above
(`ROOTCAT`, `GOVERNABLERELATIONS` and the rest stay hand-edited). Also out: any attempt
to update call sites when a template is renamed — the index can *report* how many would
break, but rewriting them is a refactoring feature, not a structure one.
