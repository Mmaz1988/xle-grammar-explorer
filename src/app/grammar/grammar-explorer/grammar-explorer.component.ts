import {
  Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output,
  QueryList, ViewChild, ViewChildren,
} from '@angular/core';
import { FsAccessService, type PickedGrammar } from '../workspace/fs-access.service';
import { WorkspaceStore, type StoredSession } from '../workspace/workspace-store';
import { GrammarStateService } from '../workspace/grammar-state.service';
import { buildGroups, indexGrammar, type GrammarIndex, type GrammarUnit } from '../workspace/grammar-index';
import { buildDefinitionIndex, lookup, type Definition, type DefinitionIndex } from '../workspace/definition-index';
import { markFor, relocate, type BackMark } from '../workspace/back-stack';
import { parseLfgFile } from '../lfg/lfg-parser';
import { buildTree, canDrop, type GrammarNode, type SortMode } from '../grammar-tree/grammar-node';
import { moveEntry, movePermutation, reorderEntries, sortPermutation } from '../lfg/lfg-move';
import { addToConfigList, configKeywordFor, removeFromConfigList, replaceInConfigList } from '../lfg/lfg-config-edit';
import { appendSection, fileTemplate, removeSection, renameSectionHeader, CREATABLE_KINDS } from '../lfg/lfg-section-edit';
import { buildStructure, type StructureGraph, type StructureNode } from '../structure-view/structure-model';
import type { StructureAction } from '../structure-view/structure-graph.component';
import type { ConfigField, LfgSection, SectionKind } from '../lfg/lfg-model';
import type { CompletionEntry } from '../lfg/lfg-completion';
import { buildLexiconIndex, type LexiconHit, type LexiconIndex } from '../lfg/lexicon-lookup';
import { GrammarEditorComponent, type GotoRequest } from '../grammar-editor/grammar-editor.component';
import { GrammarTreeComponent } from '../grammar-tree/grammar-tree.component';
import {
  columnCount, evenSizes, fitSizes, resizeTrack, toColumns,
  type EditorPane, type PaneLayout,
} from './editor-panes';

/** Beyond this, panes are too small to be worth opening; the user closes one first. */
const MAX_PANES = 8;

/**
 * The whole grammar view: a working tree on the left, the files it points at on the right.
 *
 * Self-contained by design — it owns no routing and reaches for no app-level service —
 * so it can be dropped into another Angular app as a component.
 */
@Component({
  selector: 'app-grammar-explorer',
  templateUrl: './grammar-explorer.component.html',
  styleUrls: ['./grammar-explorer.component.css'],
})
export class GrammarExplorerComponent implements OnInit, OnDestroy {
  @Input() directory?: FileSystemDirectoryHandle;
  @Input() readOnly = false;

  @Output() grammarOpened = new EventEmitter<GrammarIndex>();
  @Output() fileSaved = new EventEmitter<string>();

  @ViewChildren(GrammarEditorComponent) editors!: QueryList<GrammarEditorComponent>;
  @ViewChild(GrammarTreeComponent) treeView?: GrammarTreeComponent;

  supported = FsAccessService.isSupported();
  index?: GrammarIndex;
  active?: GrammarUnit;
  definitions?: DefinitionIndex;
  completions: CompletionEntry[] = [];
  tree: GrammarNode[] = [];
  filter = '';
  /** Display order only; writing it to the file is a separate command. */
  sortMode: SortMode = 'file';

  /** Headword lookup for the sentence bar, rebuilt when the grammar changes. */
  lexicon?: LexiconIndex;
  showSentenceBar = false;

  panes: EditorPane[] = [];
  /**
   * Panes arranged into columns.
   *
   * A stored field, never a getter. A getter returning freshly built arrays makes
   * `*ngFor` see every column as new on each change-detection pass, so it destroys and
   * recreates every pane — and a recreated editor focuses itself, which triggers the
   * next pass. That is an infinite loop that renders the app unusable, and it only
   * appears inside Angular's zone, so it hides from programmatic testing.
   */
  columns: EditorPane[][] = [];
  activePaneId = 0;
  layout: PaneLayout = 'rows';
  /** Column widths, then pane heights within each column. Fractions summing to 1. */
  colSizes: number[] = [];
  rowSizes: number[][] = [];

  /** Which of the two right-hand views is showing. */
  tab: 'editor' | 'structure' = 'editor';
  structure?: StructureGraph;
  structurePositions: Record<string, { x: number; y: number }> = {};

  selected?: { path: string; line: number };
  /** The open row menu, positioned where the click happened. */
  menu?: { node: GrammarNode; x: number; y: number };
  busy = false;
  status = '';
  error = '';
  notice = '';

  splitFraction = 0.34;
  private nextPaneId = 1;
  private dragging?: { axis: 'main' } | { axis: 'col'; i: number } | { axis: 'row'; col: number; i: number };
  /** Where a jump came from, so it can be undone. */
  private backStack: BackMark[] = [];

  /** A remembered directory that needs a permission grant before it can be reopened. */
  resumable?: { handle: FileSystemDirectoryHandle; name: string };

  constructor(
    private fs: FsAccessService,
    private state: GrammarStateService,
    private store: WorkspaceStore,
  ) {}

  private session?: StoredSession;

  async ngOnInit(): Promise<void> {
    const saved = this.state.get();
    this.filter = saved.filter;
    this.splitFraction = saved.splitFraction;
    this.layout = saved.layout ?? 'rows';
    this.sortMode = saved.sortMode ?? 'file';

    if (this.directory) {
      await this.load(await this.fs.useDirectory(this.directory));
      return;
    }
    await this.restore();
  }

  ngOnDestroy(): void {
    this.state.save({
      filter: this.filter,
      splitFraction: this.splitFraction,
      layout: this.layout,
      sortMode: this.sortMode,
    });
    void this.persist();
  }

  /** Persist on tab close too, where ngOnDestroy never runs. */
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    void this.persist();
  }

  /**
   * Reopen the directory from last time.
   *
   * The handle survives a reload but its permission usually does not, and asking for
   * one needs a user gesture — so when it is not already granted this only offers a
   * button, rather than failing at a prompt the browser will refuse.
   */
  private async restore(): Promise<void> {
    if (!WorkspaceStore.isSupported()) return;
    const [handle, session] = await Promise.all([this.store.loadDirectory(), this.store.loadSession()]);
    if (!handle) return;
    this.session = session;
    if (await this.store.hasPermission(handle)) {
      await this.load(await this.fs.useDirectory(handle), session);
    } else {
      this.resumable = { handle, name: session?.directoryName ?? handle.name };
    }
  }

  /** Grant access to the remembered directory and reopen it. From a user gesture. */
  async resume(): Promise<void> {
    const resumable = this.resumable;
    if (!resumable) return;
    this.error = '';
    if (!(await this.store.requestPermission(resumable.handle))) {
      this.error = 'Access to the remembered folder was not granted.';
      return;
    }
    this.resumable = undefined;
    await this.load(await this.fs.useDirectory(resumable.handle), this.session);
  }

  async forgetWorkspace(): Promise<void> {
    this.resumable = undefined;
    this.session = undefined;
    await this.store.clear();
  }

  /** Snapshot where the user is, so a reload can come back to it. */
  private async persist(): Promise<void> {
    if (!this.index || !WorkspaceStore.isSupported()) return;
    const session: StoredSession = {
      directoryName: this.index.name,
      grammarId: this.active?.id,
      filter: this.filter,
      layout: this.layout,
      splitFraction: this.splitFraction,
      panes: this.panes.map((p) => ({
        path: p.path,
        start: p.reveal?.start ?? 0,
        end: p.reveal?.end ?? 0,
        line: 1,
      })),
      activePaneIndex: Math.max(0, this.panes.findIndex((p) => p.id === this.activePaneId)),
      expanded: this.treeView?.getExpanded() ?? [],
      savedAt: Date.now(),
    };
    await this.store.saveSession(session);
  }

  // --- opening a grammar ----------------------------------------------------

  async pickFolder(): Promise<void> {
    this.error = '';
    try {
      const picked = await this.fs.pickDirectory();
      if (picked) await this.load(picked);
    } catch (err) {
      this.error = this.messageOf(err);
    }
  }

  async pickFile(): Promise<void> {
    this.error = '';
    try {
      const picked = await this.fs.pickFile();
      if (picked) await this.load(picked);
    } catch (err) {
      this.error = this.messageOf(err);
    }
  }

  private async load(picked: PickedGrammar, session?: StoredSession): Promise<void> {
    this.busy = true;
    this.status = 'Reading grammar…';
    try {
      if (picked.handle) await this.store.saveDirectory(picked.handle);
      const index = await indexGrammar(picked.source, picked.name);
      this.index = index;
      this.panes = [];
      this.columns = [];
      this.rowSizes = [];
      this.colSizes = [];
      this.selected = undefined;
      this.backStack = [];
      const remembered = session?.grammarId
        ? index.grammars.find((g) => g.id === session.grammarId)
        : undefined;
      this.selectGrammar(remembered ?? index.grammars.find((g) => g.kind === 'grammar') ?? index.grammars[0]);
      if (session) await this.restoreSession(session);

      const hidden = [...index.all.values()].filter((f) => f.shadowed).length;
      const real = index.grammars.filter((g) => g.kind === 'grammar').length;
      this.status = `${real} grammar${real === 1 ? '' : 's'}` +
        (hidden ? `, ${hidden} generated .lfg hidden` : '');
      this.grammarOpened.emit(index);
    } catch (err) {
      this.error = this.messageOf(err);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Put back the filter, layout, expanded rows and open files from a stored session.
   *
   * Anything that has since disappeared — a deleted file, a renamed section — is
   * skipped rather than treated as an error; the grammar on disk is the authority.
   */
  private async restoreSession(session: StoredSession): Promise<void> {
    this.filter = session.filter ?? '';
    this.layout = session.layout ?? 'rows';
    this.splitFraction = session.splitFraction ?? this.splitFraction;

    for (const stored of session.panes) {
      if (!this.index?.all.has(stored.path)) continue;
      const span = stored.end > stored.start ? { start: stored.start, end: stored.end } : undefined;
      await this.show(stored.path, span, stored.line, { newPane: this.panes.length > 0 });
    }
    const active = this.panes[session.activePaneIndex];
    if (active) this.activePaneId = active.id;

    // The tree renders after this returns, so expansion is applied on the next tick.
    setTimeout(() => this.treeView?.setExpanded(session.expanded ?? []));
  }

  selectGrammar(unit: GrammarUnit | undefined): void {
    this.active = unit;
    this.tree = unit ? buildTree(unit) : [];
    this.refreshStructure();
    this.definitions = unit && this.index ? buildDefinitionIndex(unit, this.index.all) : undefined;
    this.lexicon = unit && unit.kind === 'grammar' ? buildLexiconIndex(unit) : undefined;
    this.completions = this.definitions
      ? [...this.definitions.byName.entries()].map(([name, defs]) => ({
          name,
          params: defs[0].params,
          kind: defs[0].kind,
          detail: defs[0].summary,
        }))
      : [];
  }

  onGrammarChange(id: string): void {
    this.selectGrammar(this.index?.grammars.find((g) => g.id === id));
  }

  // --- sentence bar ---------------------------------------------------------

  toggleSentenceBar(): void {
    this.showSentenceBar = !this.showSentenceBar;
  }

  /** Open the lexical entry behind a word found in a sentence. */
  async openLexiconHit(request: { hit: LexiconHit; newPane: boolean }): Promise<void> {
    const { hit, newPane } = request;
    this.error = '';
    if (newPane && this.panes.length >= MAX_PANES) {
      this.error = `Too many open panes (${MAX_PANES}). Close one first.`;
      return;
    }
    await this.show(hit.path, hit.span, hit.line, { newPane });
    this.tab = 'editor';
  }

  // --- structure view -------------------------------------------------------

  showTab(tab: 'editor' | 'structure'): void {
    this.tab = tab;
  }

  /** Rebuild the graph from the current index. Cheap, so it follows every edit. */
  private refreshStructure(): void {
    if (!this.active || !this.index || this.active.kind !== 'grammar') {
      this.structure = undefined;
      return;
    }
    const orphans = this.index.grammars.find((g) => g.kind === 'unreferenced')?.files ?? [];
    this.structure = buildStructure(this.active, this.index.all, orphans);
  }

  onStructurePositions(positions: Record<string, { x: number; y: number }>): void {
    this.structurePositions = positions;
  }

  /** Carry out what the graph asked for. */
  async onStructureAction(request: StructureAction): Promise<void> {
    const { action, node } = request;
    this.error = '';
    this.notice = '';
    try {
      if (action === 'add-file') return await this.addFile();
      if (!node) return;
      switch (action) {
        case 'open': return await this.openStructureNode(node);
        case 'add-section': return await this.addSection(node);
        case 'rename': return await this.renameNode(node);
        case 'unlink': return await this.setDeclared(node, false);
        case 'relink': return await this.setDeclared(node, true);
        case 'delete': return await this.deleteNode(node);
      }
    } catch (err) {
      this.error = this.messageOf(err);
    }
  }

  /** Open the file behind a node, at its section when there is one. */
  private async openStructureNode(node: StructureNode): Promise<void> {
    if (!node.path) return;
    const section = this.sectionOf(node);
    await this.show(node.path, section ? { start: section.start, end: section.end } : undefined, section?.line);
    this.tab = 'editor';
  }

  private async addSection(file: StructureNode): Promise<void> {
    if (!file.path) return;
    const key = prompt(`New section in ${file.path}\n\nTwo name tokens, e.g. "ADVERB ENGLISH":`);
    if (!key) return;
    const kind = prompt(`Section kind for ${key}\n\nOne of: ${CREATABLE_KINDS.join(', ')}`, 'RULES');
    if (!kind) return;
    const [name1, name2] = key.trim().split(/\s+/);
    const problem = this.checkSection(name1, name2, kind);
    if (problem) { this.error = problem; return; }

    const text = this.index!.all.get(file.path)!.text;
    await this.stageEdit(file.path, appendSection(text, name1, name2, kind as SectionKind));
    await this.declare(`${name1} ${name2}`, kind as SectionKind, true);
    this.notice = `Added ${name1} ${name2} ${kind} to ${file.path} and declared it. Unsaved — review and save.`;
  }

  private async addFile(): Promise<void> {
    const path = prompt('New file, relative to the grammar root:\n\ne.g. rules/adverb_rules.lfg.glue');
    if (!path) return;
    const key = prompt(`Sections in ${path}\n\nTwo name tokens, e.g. "ADVERB ENGLISH":`);
    if (!key) return;
    const kind = prompt(`Section kind\n\nOne of: ${CREATABLE_KINDS.join(', ')}`, 'RULES');
    if (!kind) return;
    const [name1, name2] = key.trim().split(/\s+/);
    const problem = this.checkSection(name1, name2, kind);
    if (problem) { this.error = problem; return; }
    if (await this.fs.exists(path)) { this.error = `${path} already exists.`; return; }

    // The file is written now; the config edit is staged. Safe in this direction only:
    // an undeclared file is inert, while a config naming a missing file will not load.
    await this.fs.createFile(path, fileTemplate([{ name1, name2, kind: kind as SectionKind }]));
    await this.declareFile(path, true);
    await this.declare(`${name1} ${name2}`, kind as SectionKind, true);
    await this.reload();
    this.notice = `Created ${path}. Its CONFIG entries are unsaved — review and save.`;
  }

  private async renameNode(node: StructureNode): Promise<void> {
    if (node.kind === 'file') return this.renameFile(node);
    return this.renameSection(node);
  }

  private async renameSection(node: StructureNode): Promise<void> {
    const section = this.sectionOf(node);
    if (!section || !node.path) return;
    const key = prompt(`Rename ${node.label}\n\nTwo name tokens:`, node.sectionKey);
    if (!key || key.trim() === node.sectionKey) return;
    const [name1, name2] = key.trim().split(/\s+/);
    const problem = this.checkSection(name1, name2, section.kind);
    if (problem) { this.error = problem; return; }

    const text = this.index!.all.get(node.path)!.text;
    await this.stageEdit(node.path, renameSectionHeader(text, section, name1, name2));
    // Both edits must land, or the section is declared under a name no file defines.
    await this.renameDeclaration(section.kind, node.sectionKey!, `${name1} ${name2}`);
    this.notice = `Renamed to ${name1} ${name2}. Two files changed — save both.`;
  }

  private async renameFile(node: StructureNode): Promise<void> {
    if (!node.path) return;
    const to = prompt(`Rename ${node.path}\n\nNew path, relative to the grammar root:`, node.path);
    if (!to || to === node.path) return;
    if (await this.fs.exists(to)) { this.error = `${to} already exists.`; return; }

    await this.fs.renameFile(node.path, to);
    // FILES carries paths without the .glue suffix.
    const strip = (p: string) => p.replace(/\.glue$/, '');
    await this.withConfig('FILES', (text, f) => replaceInConfigList(text, f, strip(node.path!), strip(to)));
    await this.reload();
    this.notice = `Renamed to ${to}. Its CONFIG entry is unsaved — review and save.`;
  }

  private async setDeclared(node: StructureNode, declared: boolean): Promise<void> {
    if (node.kind === 'file') {
      await this.declareFile(node.path!, declared);
      this.notice = declared
        ? `${node.path} added to FILES. Unsaved — review and save.`
        : `${node.path} removed from FILES; the file is untouched. Unsaved — review and save.`;
    } else {
      await this.declare(node.sectionKey!, node.sectionKind!, declared);
      this.notice = declared
        ? `${node.label} declared. Unsaved — review and save.`
        : `${node.label} undeclared; the section is untouched. Unsaved — review and save.`;
    }
    this.refreshStructure();
  }

  private async deleteNode(node: StructureNode): Promise<void> {
    if (node.kind === 'file') {
      const file = this.index!.all.get(node.path!)!;
      const entries = file.sections.reduce((n, s) => n + s.entries.length, 0);
      const ok = confirm(
        `Delete ${node.path} from disk?\n\n` +
        `${file.sections.length} section(s), ${entries} entries.\n\n` +
        'There is no undo here — recover it with git if this is a mistake.',
      );
      if (!ok) return;
      // Undeclare first: a config naming a missing file will not load, whereas a file
      // nothing references is merely inert.
      for (const section of file.sections) {
        if (section.kind !== 'CONFIG') await this.declare(section.key, section.kind, false);
      }
      await this.declareFile(node.path!, false);
      await this.fs.deleteFile(node.path!);
      this.panes = this.panes.filter((p) => p.path !== node.path);
      this.relayout();
      await this.reload();
      this.notice = `Deleted ${node.path}. Its CONFIG entries are unsaved — review and save.`;
      return;
    }

    const section = this.sectionOf(node);
    if (!section || !node.path) return;
    if (!confirm(`Delete ${node.label} and its ${section.entries.length} entries?\n\nRecover with git if this is a mistake.`)) return;
    const text = this.index!.all.get(node.path)!.text;
    await this.stageEdit(node.path, removeSection(text, section));
    await this.declare(node.sectionKey!, node.sectionKind!, false);
    this.notice = `Deleted ${node.label}. Unsaved — review and save.`;
  }

  // --- config plumbing ------------------------------------------------------

  /** The parsed section a graph node stands for. */
  private sectionOf(node: StructureNode): LfgSection | undefined {
    if (node.kind !== 'section' || !node.path) return undefined;
    return this.index?.all.get(node.path)?.sections
      .find((s) => s.key === node.sectionKey && s.kind === node.sectionKind);
  }

  /** Add or remove a section's declaration. */
  private async declare(key: string, kind: SectionKind, declared: boolean): Promise<void> {
    const keyword = configKeywordFor(kind);
    if (!keyword) return;
    await this.withConfig(keyword, (text, field) => declared
      ? addToConfigList(text, field, key)
      : removeFromConfigList(text, field, key));
  }

  private async renameDeclaration(kind: SectionKind, from: string, to: string): Promise<void> {
    const keyword = configKeywordFor(kind);
    if (!keyword) return;
    await this.withConfig(keyword, (text, field) => replaceInConfigList(text, field, from, to));
  }

  private async declareFile(path: string, declared: boolean): Promise<void> {
    const listed = path.replace(/\.glue$/, '');
    await this.withConfig('FILES', (text, field) => declared
      ? addToConfigList(text, field, listed)
      : removeFromConfigList(text, field, listed));
  }

  /**
   * Apply an edit to one CONFIG field and stage it.
   *
   * The config is re-read and re-parsed each time, because several of these run in
   * sequence — deleting a file undeclares every section it held — and each edit moves
   * the offsets the next one needs.
   */
  private async withConfig(
    keyword: string,
    edit: (text: string, field: ConfigField) => string,
  ): Promise<void> {
    const path = this.active?.mainPath;
    if (!path || !this.index) return;
    const pane = this.panes.find((p) => p.path === path);
    const text = pane?.content ?? this.index.all.get(path)?.text;
    if (text === undefined) return;

    const config = parseLfgFile(text, { path }).sections
      .find((s) => s.kind === 'CONFIG' && s.key === this.active!.configKey);
    const field = config?.config?.find((f) => f.keyword === keyword);
    if (!field) {
      this.error = `The CONFIG has no ${keyword} field to edit.`;
      return;
    }
    await this.stageEdit(path, edit(text, field));
  }

  /** Re-read the whole grammar after a change on disk. */
  private async reload(): Promise<void> {
    const name = this.index?.name;
    if (!name) return;
    const index = await indexGrammar(
      { listFiles: () => this.fs.listFiles(), readFile: (p) => this.fs.readFile(p) },
      name,
    );
    // Keep unsaved pane content: re-reading from disk would discard staged config edits.
    for (const pane of this.panes.filter((p) => p.dirty)) {
      const file = index.all.get(pane.path);
      if (file) index.all.set(pane.path, parseLfgFile(pane.content, { path: pane.path }));
    }
    this.index = index;
    const same = index.grammars.find((g) => g.id === this.active?.id)
      ?? index.grammars.find((g) => g.kind === 'grammar');
    this.selectGrammar(same);
  }

  /** Names must be bare tokens, or the header parses as something else entirely. */
  private checkSection(name1: string, name2: string, kind: string): string | undefined {
    if (!name1 || !name2) return 'A section needs two name tokens, e.g. "ADVERB ENGLISH".';
    if (!/^[A-Za-z0-9_.-]+$/.test(name1) || !/^[A-Za-z0-9_.-]+$/.test(name2)) {
      return 'Section names must be single words without spaces or brackets.';
    }
    if (!CREATABLE_KINDS.includes(kind as SectionKind)) {
      return `Section kind must be one of: ${CREATABLE_KINDS.join(', ')}.`;
    }
    const clash = this.active?.files.some((f) => f.sections
      .some((s) => s.kind === kind && s.key === `${name1} ${name2}`));
    return clash ? `${name1} ${name2} ${kind} already exists in this grammar.` : undefined;
  }

  // --- panes ----------------------------------------------------------------

  get activePane(): EditorPane | undefined {
    return this.panes.find((p) => p.id === this.activePaneId);
  }

  /**
   * Switch layout, starting from even tracks.
   *
   * Carrying sizes across a switch is worse than it sounds: the single column of `rows`
   * has weight 1, so growing it to two columns yields a lopsided 2:1 grid rather than
   * the equal tiles the switch is asking for.
   */
  setLayout(layout: PaneLayout): void {
    this.layout = layout;
    this.colSizes = [];
    this.rowSizes = [];
    this.relayout();
  }

  /**
   * Rebuild the column arrangement and fit the track sizes to it.
   *
   * Called whenever panes are added or removed, or the layout changes — never from a
   * template binding.
   */
  private relayout(): void {
    this.columns = toColumns(this.panes, columnCount(this.layout, this.panes.length));
    this.colSizes = fitSizes(this.colSizes, this.columns.length);
    this.rowSizes = this.columns.map((col, i) => fitSizes(this.rowSizes[i] ?? [], col.length));
  }

  columnWidth(i: number): number {
    return (this.colSizes[i] ?? 1 / Math.max(1, this.columns.length)) * 100;
  }

  paneHeight(col: number, i: number): number {
    const sizes = this.rowSizes[col];
    return (sizes?.[i] ?? 1 / Math.max(1, this.columns[col]?.length ?? 1)) * 100;
  }

  /**
   * Open `path` at `span`.
   *
   * A file already on screen is reused rather than opened twice. Otherwise the active
   * pane is reused — unless it has unsaved edits, in which case a new pane opens rather
   * than either losing the work or refusing the click.
   */
  private async show(
    path: string,
    span?: { start: number; end: number },
    line?: number,
    options: { newPane?: boolean } = {},
  ): Promise<void> {
    this.error = '';
    this.notice = '';

    // Opening deliberately into a split wants a second view even of a file already on
    // screen — comparing two places in one file is the main reason to ask for it.
    const existing = options.newPane ? undefined : this.panes.find((p) => p.path === path);
    if (existing) {
      existing.reveal = span ? { ...span } : existing.reveal;
      this.activePaneId = existing.id;
      this.selected = { path, line: line ?? 1 };
      setTimeout(() => this.focusActive());
      return;
    }

    const content = await this.fs.readFile(path);
    const target = options.newPane ? undefined : this.activePane;

    if (target && !target.dirty) {
      target.path = path;
      target.content = content;
      target.saved = content;
      target.reveal = span ? { ...span } : undefined;
    } else {
      if (this.panes.length >= MAX_PANES) {
        this.error = `Too many open panes (${MAX_PANES}). Close one first.`;
        return;
      }
      if (target?.dirty) {
        this.notice = `${target.path} has unsaved changes, so ${path} opened in a new pane.`;
      }
      const pane: EditorPane = {
        id: this.nextPaneId++,
        path,
        content,
        saved: content,
        dirty: false,
        reveal: span ? { ...span } : undefined,
      };
      this.panes.push(pane);
      this.activePaneId = pane.id;
      this.relayout();
    }
    this.selected = { path, line: line ?? 1 };
    setTimeout(() => this.focusActive());
  }

  async openNode(node: GrammarNode): Promise<void> {
    if (node.path === undefined) return;
    await this.show(node.path, node.span, node.line);
    // The tree stays usable while the structure view is showing, so a click there has
    // to bring the editor back — otherwise it silently updates a pane out of sight.
    this.tab = 'editor';
  }

  /**
   * Move (or copy) an entry into another section, dragged in the tree.
   *
   * The edit is left **unsaved** in panes rather than written straight to disk. A drag
   * is easy to do by accident, it rewrites two files at once, and there is no undo
   * across files — so the change is shown in the editor where it can be read, reverted
   * or saved deliberately.
   */
  async dropEntry(event: { source: GrammarNode; target: GrammarNode; copy: boolean }): Promise<void> {
    const { source, target, copy } = event;
    this.error = '';
    this.notice = '';
    if (!canDrop(source, target) || source.path === undefined || target.path === undefined) return;
    if (!source.span || !target.span) return;

    // Offsets come from the index, which reflects what is on disk. Splicing them into
    // a buffer that has moved on would cut in the wrong place.
    for (const path of new Set([source.path, target.path])) {
      const pane = this.panes.find((p) => p.path === path && p.dirty);
      if (pane) {
        this.error = `Save ${path} before moving entries in or out of it.`;
        return;
      }
    }

    const sameFile = source.path === target.path;
    const sourceText = this.index?.all.get(source.path)?.text;
    const targetText = this.index?.all.get(target.path)?.text;
    if (sourceText === undefined || targetText === undefined) return;

    const result = moveEntry({
      sourceText,
      from: source.span.start,
      to: source.span.end,
      targetText,
      at: target.span.end,
      copy,
      sameFile,
    });

    if (!sameFile && !copy) await this.stageEdit(source.path, result.sourceText);
    await this.stageEdit(target.path, sameFile ? result.targetText : result.targetText, result.insertedAt);

    const verb = copy ? 'Copied' : 'Moved';
    this.notice = `${verb} ${source.name} into ${target.name}. Unsaved — review and save.`;
  }

  /**
   * Put edited text into a pane, opening one if the file is not on screen, and refresh
   * the index from it so the tree shows the entry in its new home immediately.
   */
  private async stageEdit(path: string, text: string, reveal?: { start: number; end: number }): Promise<void> {
    let pane = this.panes.find((p) => p.path === path);
    if (!pane) {
      await this.show(path, reveal, undefined, { newPane: this.panes.length > 0 });
      pane = this.panes.find((p) => p.path === path);
      if (!pane) return;
    }
    pane.content = text;
    pane.dirty = text !== pane.saved;
    if (reveal) pane.reveal = { ...reveal };
    this.reindexFile(path, text);
  }

  /**
   * Reorder an entry within its own section, dragged in the tree.
   *
   * Only reachable in file order with no filter, so "above this entry" is a real
   * position in the file rather than a position in a view of it.
   */
  async reorderEntry(event: { source: GrammarNode; before?: GrammarNode }): Promise<void> {
    const { source, before } = event;
    this.error = '';
    this.notice = '';
    if (source.path === undefined) return;
    const section = this.sectionContaining(source);
    if (!section) return;
    if (!(await this.ensureSaved(source.path))) return;

    const entries = section.children;
    const from = entries.indexOf(source);
    const to = before ? entries.indexOf(before) : entries.length;
    if (from < 0 || to < 0 || from === to) return;

    const text = this.index?.all.get(source.path)?.text;
    if (text === undefined) return;
    const spans = entries.map((e) => e.span!).filter(Boolean);
    if (spans.length !== entries.length) return;

    const reordered = reorderEntries(text, spans, movePermutation(entries.length, from, to));
    await this.stageEdit(source.path, reordered);
    this.notice = `Moved ${source.name} within ${section.qualifiedLabel ?? section.name}. Unsaved — review and save.`;
  }

  /**
   * Write an order into the file for one section.
   *
   * Both orders are offered outright rather than following the view control. Tying the
   * command to the view meant the category order could only be written while the tree
   * happened to be showing it, and nothing on the menu said so — a hidden dependency on
   * a control at the other end of the pane.
   *
   * Still separate from the view itself: looking at a lexicon in some order is a way of
   * finding something and must never rewrite anything, while this rewrites and says so.
   */
  async sortSectionInFile(section: GrammarNode, order: 'alpha' | 'category' = 'alpha'): Promise<void> {
    this.menu = undefined;
    this.error = '';
    this.notice = '';
    if (section.level !== 'section' || section.path === undefined) return;
    if (!(await this.ensureSaved(section.path))) return;

    const text = this.index?.all.get(section.path)?.text;
    if (text === undefined) return;
    // Take the section straight from the index: the tree may be showing a sorted or
    // filtered view, which is not the order on disk.
    const parsed = this.index?.all.get(section.path)?.sections
      .find((s) => s.key === section.name && s.kind === section.sectionKind);
    const entries = parsed?.entries ?? [];
    if (entries.length < 2) return;

    const byCategory = order === 'category';
    const keys = entries.map((e) => (byCategory ? [e.category ?? '', e.name] : e.name));
    const sorted = reorderEntries(
      text,
      entries.map((e) => ({ start: e.start, end: e.end })),
      sortPermutation(keys),
    );
    const described = byCategory ? 'by category' : 'alphabetically';
    if (sorted === text) {
      this.notice = `${section.qualifiedLabel ?? section.name} is already sorted ${described}.`;
      return;
    }
    await this.stageEdit(section.path, sorted);
    this.notice = `Sorted ${section.qualifiedLabel ?? section.name} ${described}. Unsaved — review and save.`;
  }

  /** The section node holding `entry` in the current tree. */
  private sectionContaining(entry: GrammarNode): GrammarNode | undefined {
    for (const group of this.tree) {
      for (const section of group.children) {
        if (section.children.includes(entry)) return section;
      }
    }
    return undefined;
  }

  /** Refuse to splice a file whose buffer has moved on from what the index holds. */
  private async ensureSaved(path: string): Promise<boolean> {
    if (this.panes.some((p) => p.path === path && p.dirty)) {
      this.error = `Save ${path} before reordering its entries.`;
      return false;
    }
    return true;
  }

  // --- row menu -------------------------------------------------------------

  onContextMenu(event: { node: GrammarNode; x: number; y: number }): void {
    // Keep the menu on screen when the click lands near an edge. The size is the
    // menu's own max-width and its measured height for two items plus the title.
    const width = 320;
    const height = 96;
    this.menu = {
      node: event.node,
      x: Math.min(event.x, Math.max(0, window.innerWidth - width - 8)),
      y: Math.min(event.y, Math.max(0, window.innerHeight - height - 8)),
    };
  }

  /** Dismiss the menu on any click elsewhere, or on Escape. */
  @HostListener('document:click')
  @HostListener('document:contextmenu')
  @HostListener('document:keydown.escape')
  closeMenu(): void {
    if (this.menu) this.menu = undefined;
  }

  async openFromMenu(node: GrammarNode, where: 'here' | 'split'): Promise<void> {
    this.menu = undefined;
    if (node.path === undefined) return;
    if (where === 'here') {
      await this.show(node.path, node.span, node.line);
      this.tab = 'editor';
      return;
    }
    if (this.panes.length >= MAX_PANES) {
      this.error = `Too many open panes (${MAX_PANES}). Close one first.`;
      return;
    }
    await this.show(node.path, node.span, node.line, { newPane: true });
  }

  closePane(pane: EditorPane): void {
    if (pane.dirty && !confirm(`${pane.path} has unsaved changes. Close it anyway?`)) return;
    this.panes = this.panes.filter((p) => p !== pane);
    if (this.activePaneId === pane.id) this.activePaneId = this.panes[this.panes.length - 1]?.id ?? 0;
    this.relayout();
  }

  onPaneFocused(pane: EditorPane): void {
    // Guard the assignment: writing the same value still counts as work to change
    // detection, and this fires on every focus event.
    if (this.activePaneId !== pane.id) this.activePaneId = pane.id;
  }

  onContentChange(pane: EditorPane, text: string): void {
    pane.content = text;
    pane.dirty = text !== pane.saved;
  }

  private focusActive(): void {
    const i = this.panes.findIndex((p) => p.id === this.activePaneId);
    this.editors?.get(i)?.focus();
  }

  // --- go to definition -----------------------------------------------------

  /**
   * Jump to where `name` is defined.
   *
   * When a name has several definitions the CONFIG order decides, exactly as it does
   * for XLE, and the alternatives are reported rather than silently dropped.
   */
  async goto(request: GotoRequest): Promise<void> {
    this.error = '';
    this.notice = '';
    if (!this.definitions) return;
    const defs = lookup(this.definitions, request.name);
    if (defs.length === 0) {
      this.notice = request.fromCall
        ? `@${request.name} is not defined in this grammar.`
        : `No definition found for "${request.name}".`;
      return;
    }
    const here = this.activePane;
    // Only a jump that replaces the current view needs an undo; opening beside it
    // leaves the starting point on screen.
    if (here && !request.newPane) {
      // Remembered with its text, not just its offset, so editing what we jump into
      // does not send Back to the wrong line — see `back-stack.ts`.
      this.backStack.push(
        markFor(here.path, here.content, here.reveal, this.selected?.line ?? 1),
      );
    }
    if (request.newPane && this.panes.length >= MAX_PANES) {
      this.error = `Too many open panes (${MAX_PANES}). Close one first.`;
      return;
    }
    await this.jumpTo(defs[0], request.newPane);
    this.tab = 'editor';
    if (defs.length > 1) {
      const others = defs.slice(1).map((d) => `${d.sectionKey} (${d.path}:${d.line})`).join(', ');
      this.notice = `${request.name} is defined ${defs.length} times; showing the one CONFIG prefers. Also in: ${others}`;
    }
  }

  private async jumpTo(def: Definition, newPane = false): Promise<void> {
    await this.show(def.path, def.span, def.line, { newPane });
  }

  /**
   * Return to where the last jump started, mirroring the emacs mode's C-".
   *
   * The spot is found by its text when the file has been edited since, which is the
   * common case: following a template call is usually the prelude to changing it.
   */
  async back(): Promise<void> {
    const previous = this.backStack.pop();
    if (!previous) return;
    this.error = '';
    this.notice = '';

    // Prefer the open buffer: it holds unsaved edits that the file on disk does not.
    const open = this.panes.find((p) => p.path === previous.path);
    let content = open?.content;
    if (content === undefined) {
      try {
        content = await this.fs.readFile(previous.path);
      } catch {
        this.notice = `${previous.path} is no longer available.`;
        return;
      }
    }

    const where = relocate(content, previous);
    if (where.how === 'lost') {
      this.notice = `Back: the place this jump started from is gone from ${previous.path}.`;
    }
    await this.show(previous.path, where.span, where.line);
    this.tab = 'editor';
  }

  get canGoBack(): boolean {
    return this.backStack.length > 0;
  }

  // --- saving ---------------------------------------------------------------

  async save(pane: EditorPane | undefined = this.activePane): Promise<void> {
    if (!pane || !pane.dirty || this.readOnly) return;
    this.busy = true;
    this.error = '';
    // Every notice describes a change that is still pending — "Unsaved — review and
    // save" and the like. Saving answers it, so leaving it on screen contradicts the
    // clean pane sitting next to it.
    this.notice = '';
    try {
      await this.fs.writeFile(pane.path, pane.content);
      pane.saved = pane.content;
      pane.dirty = false;
      this.fileSaved.emit(pane.path);
      this.reindexFile(pane.path, pane.content);
      // Another pane showing the same file is now stale unless it was edited too.
      for (const other of this.panes) {
        if (other !== pane && other.path === pane.path && !other.dirty) {
          other.content = pane.content;
          other.saved = pane.content;
        }
      }
      this.status = `Saved ${pane.path}`;
    } catch (err) {
      this.error = this.messageOf(err);
    } finally {
      this.busy = false;
    }
  }

  get dirtyPanes(): EditorPane[] {
    return this.panes.filter((p) => p.dirty);
  }

  /**
   * Save every pane with unsaved changes.
   *
   * ⌘S and each pane's own button save that pane alone, which is what those gestures
   * mean everywhere else — but with several panes open it is easy to leave an edit
   * behind, so this exists and appears only when more than one pane is dirty.
   */
  async saveAll(): Promise<void> {
    for (const pane of this.dirtyPanes) {
      await this.save(pane);
      if (this.error) return;
    }
  }

  async revert(pane: EditorPane | undefined = this.activePane): Promise<void> {
    if (!pane) return;
    this.notice = '';
    pane.content = await this.fs.readFile(pane.path);
    pane.saved = pane.content;
    pane.dirty = false;
  }

  /** Re-parse one file and refresh every grammar that includes it. */
  private reindexFile(path: string, text: string): void {
    const file = this.index?.all.get(path);
    if (!file || !this.index) return;
    const reparsed = parseLfgFile(text, { path });
    reparsed.shadowed = file.shadowed;
    reparsed.unreferenced = file.unreferenced;
    this.index.all.set(path, reparsed);
    for (const unit of this.index.grammars) {
      const i = unit.files.findIndex((f) => f.path === path);
      if (i < 0) continue;
      unit.files[i] = reparsed;
      unit.groups = buildGroups(unit.files);
      unit.entryCount = unit.files.reduce((n, f) => n + f.sections.reduce((m, s) => m + s.entries.length, 0), 0);
    }
    // Definitions may have been added or renamed, so completion and jumps follow.
    if (this.active) this.selectGrammar(this.active);
    this.refreshStructure();
  }

  // --- dragging -------------------------------------------------------------

  startDrag(event: MouseEvent, target: NonNullable<typeof this.dragging>): void {
    event.preventDefault();
    this.dragging = target;
  }

  onDrag(event: MouseEvent): void {
    const drag = this.dragging;
    if (!drag) return;
    const host = (event.currentTarget as HTMLElement).getBoundingClientRect();

    if (drag.axis === 'main') {
      this.splitFraction = Math.min(0.75, Math.max(0.15, (event.clientX - host.left) / host.width));
      return;
    }
    const area = (event.currentTarget as HTMLElement).querySelector('.panes')?.getBoundingClientRect();
    if (!area) return;
    if (drag.axis === 'col') {
      this.colSizes = resizeTrack(this.colSizes, drag.i, (event.clientX - area.left) / area.width);
    } else {
      const column = (event.currentTarget as HTMLElement)
        .querySelectorAll('.pane-column')[drag.col]?.getBoundingClientRect();
      if (!column) return;
      const sizes = this.rowSizes[drag.col] ?? evenSizes(this.columns[drag.col].length);
      this.rowSizes[drag.col] = resizeTrack(sizes, drag.i, (event.clientY - column.top) / column.height);
    }
  }

  endDrag(): void {
    this.dragging = undefined;
  }

  trackPane = (_: number, pane: EditorPane): number => pane.id;

  /** Columns are identified by their first pane, so a stable column keeps its views. */
  trackColumn = (index: number, column: EditorPane[]): number => column[0]?.id ?? index;

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
