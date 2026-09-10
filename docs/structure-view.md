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

### `workspace/fs-access.service.ts` — creation (extend)

`createFile(path, contents)`, creating intermediate directories. `getDirectoryHandle`
and `getFileHandle` both accept `{ create: true }`, and both are available on the
handles this app already holds — verified in the browser. Existing paths must be
refused rather than overwritten.

### `structure-view/` — the tab (new)

`structure-graph.component` renders the Cytoscape graph and emits the three creation
requests; `structure-model.ts` turns a `GrammarUnit` plus its CONFIG into nodes and
edges, including the live/undeclared distinction. Model building is plain TypeScript
and gets node-level tests; the component gets Karma specs.

### `grammar-explorer` — the tab switch (extend)

The right pane gains **Editor | Structure**. Structure replaces the pane area rather
than becoming another pane: it is a view of the whole grammar, not of a file. Switching
to Editor after a creation lands on the staged CONFIG file.

## Validation

Refuse, with a reason, before writing anything:

- a section key already used by another section of the same kind in this grammar;
- a file path that already exists, or escapes the grammar directory;
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

Deleting or renaming sections and files, moving a section between files, and editing
CONFIG fields other than the lists above. Deletion in particular needs a story for what
happens to the entries inside a section, and that is a separate design.
