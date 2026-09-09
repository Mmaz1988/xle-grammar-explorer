import {
  Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output,
  QueryList, ViewChildren,
} from '@angular/core';
import { FsAccessService, type PickedGrammar } from '../workspace/fs-access.service';
import { GrammarStateService } from '../workspace/grammar-state.service';
import { buildGroups, indexGrammar, type GrammarIndex, type GrammarUnit } from '../workspace/grammar-index';
import { buildDefinitionIndex, lookup, type Definition, type DefinitionIndex } from '../workspace/definition-index';
import { parseLfgFile } from '../lfg/lfg-parser';
import { buildTree, type GrammarNode } from '../grammar-tree/grammar-node';
import type { CompletionEntry } from '../lfg/lfg-completion';
import { GrammarEditorComponent, type GotoRequest } from '../grammar-editor/grammar-editor.component';
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

  supported = FsAccessService.isSupported();
  index?: GrammarIndex;
  active?: GrammarUnit;
  definitions?: DefinitionIndex;
  completions: CompletionEntry[] = [];
  tree: GrammarNode[] = [];
  filter = '';

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
  private backStack: Array<{ path: string; line: number; span: { start: number; end: number } }> = [];

  constructor(private fs: FsAccessService, private state: GrammarStateService) {}

  async ngOnInit(): Promise<void> {
    const saved = this.state.get();
    this.filter = saved.filter;
    this.splitFraction = saved.splitFraction;
    this.layout = saved.layout ?? 'rows';
    if (this.directory) await this.load(await this.fs.useDirectory(this.directory));
  }

  ngOnDestroy(): void {
    this.state.save({
      filter: this.filter,
      splitFraction: this.splitFraction,
      layout: this.layout,
    });
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

  private async load(picked: PickedGrammar): Promise<void> {
    this.busy = true;
    this.status = 'Reading grammar…';
    try {
      const index = await indexGrammar(picked.source, picked.name);
      this.index = index;
      this.panes = [];
      this.columns = [];
      this.rowSizes = [];
      this.colSizes = [];
      this.selected = undefined;
      this.backStack = [];
      this.selectGrammar(index.grammars.find((g) => g.kind === 'grammar') ?? index.grammars[0]);

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

  selectGrammar(unit: GrammarUnit | undefined): void {
    this.active = unit;
    this.tree = unit ? buildTree(unit) : [];
    this.definitions = unit && this.index ? buildDefinitionIndex(unit, this.index.all) : undefined;
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
    if (here) {
      this.backStack.push({ path: here.path, line: this.selected?.line ?? 1, span: here.reveal ?? { start: 0, end: 0 } });
    }
    await this.jumpTo(defs[0]);
    if (defs.length > 1) {
      const others = defs.slice(1).map((d) => `${d.sectionKey} (${d.path}:${d.line})`).join(', ');
      this.notice = `${request.name} is defined ${defs.length} times; showing the one CONFIG prefers. Also in: ${others}`;
    }
  }

  private async jumpTo(def: Definition): Promise<void> {
    await this.show(def.path, def.span, def.line);
  }

  /** Return to where the last jump started, mirroring the emacs mode's C-". */
  async back(): Promise<void> {
    const previous = this.backStack.pop();
    if (!previous) return;
    await this.show(previous.path, previous.span, previous.line);
  }

  get canGoBack(): boolean {
    return this.backStack.length > 0;
  }

  // --- saving ---------------------------------------------------------------

  async save(pane: EditorPane | undefined = this.activePane): Promise<void> {
    if (!pane || !pane.dirty || this.readOnly) return;
    this.busy = true;
    this.error = '';
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

  async revert(pane: EditorPane | undefined = this.activePane): Promise<void> {
    if (!pane) return;
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
