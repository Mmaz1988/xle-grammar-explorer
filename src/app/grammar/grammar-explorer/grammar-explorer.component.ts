import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { FsAccessService } from '../workspace/fs-access.service';
import { GrammarStateService } from '../workspace/grammar-state.service';
import { indexGrammar, type GrammarIndex, type GrammarSource } from '../workspace/grammar-index';
import { parseLfgFile } from '../lfg/lfg-parser';
import { buildTree, type GrammarNode } from '../grammar-tree/grammar-node';

/**
 * The whole grammar view: a working tree on the left, the file it points at on the right.
 *
 * Self-contained by design — it owns no routing and reaches for no app-level service —
 * so it can be dropped into another Angular app as a component. Everything it needs
 * comes in through `@Input`, and everything a host might care about goes out through
 * `@Output`.
 */
@Component({
  selector: 'app-grammar-explorer',
  templateUrl: './grammar-explorer.component.html',
  styleUrls: ['./grammar-explorer.component.css'],
})
export class GrammarExplorerComponent implements OnInit, OnDestroy {
  /** Open a directory the host already has a handle for, instead of prompting. */
  @Input() directory?: FileSystemDirectoryHandle;
  @Input() readOnly = false;

  @Output() grammarOpened = new EventEmitter<GrammarIndex>();
  @Output() fileSaved = new EventEmitter<string>();

  supported = FsAccessService.isSupported();
  index?: GrammarIndex;
  tree: GrammarNode[] = [];
  filter = '';

  openPath = '';
  openContent = '';
  reveal?: { start: number; end: number };
  selected?: { path: string; line: number };

  dirty = false;
  busy = false;
  status = '';
  error = '';

  /** Left pane width as a fraction of the container. */
  splitFraction = 0.34;
  private dragging = false;

  constructor(
    private fs: FsAccessService,
    private state: GrammarStateService,
  ) {}

  async ngOnInit(): Promise<void> {
    const saved = this.state.get();
    this.filter = saved.filter;
    this.splitFraction = saved.splitFraction;
    if (this.directory) {
      await this.load(await this.fs.useDirectory(this.directory));
    }
  }

  ngOnDestroy(): void {
    this.state.save({
      filter: this.filter,
      openPath: this.openPath,
      openLine: this.selected?.line,
      splitFraction: this.splitFraction,
    });
  }

  async pick(): Promise<void> {
    this.error = '';
    try {
      const picked = await this.fs.pickDirectory();
      if (picked) await this.load(picked);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async load(picked: { name: string; source: GrammarSource }): Promise<void> {
    this.busy = true;
    this.status = 'Reading grammar…';
    try {
      const index = await indexGrammar(picked.source, picked.name);
      this.index = index;
      this.tree = buildTree(index);
      this.openPath = '';
      this.openContent = '';
      this.selected = undefined;
      this.dirty = false;

      const hidden = [...index.all.values()].filter((f) => f.shadowed).length;
      this.status =
        `${index.files.length} file(s)` +
        (hidden ? `, ${hidden} generated .lfg hidden` : '') +
        (index.warnings.length ? `, ${index.warnings.length} warning(s)` : '');
      this.grammarOpened.emit(index);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Open the file an entry lives in and reveal that entry.
   *
   * Refuses to swap files while there are unsaved edits — losing a change to a
   * click in a tree would be a nasty surprise.
   */
  async openNode(node: GrammarNode): Promise<void> {
    if (node.path === undefined) return;
    if (this.dirty && node.path !== this.openPath) {
      this.error = 'Save or discard the current changes first.';
      return;
    }
    this.error = '';
    if (node.path !== this.openPath) {
      this.openContent = await this.fs.readFile(node.path);
      this.openPath = node.path;
      this.dirty = false;
    }
    this.reveal = node.span;
    this.selected = { path: node.path, line: node.line ?? 1 };
  }

  onContentChange(text: string): void {
    this.openContent = text;
    this.dirty = true;
  }

  /**
   * Write the open file back, then re-parse and re-index.
   *
   * Re-indexing after a save is what keeps the tree honest: adding a lexical entry
   * should make it appear, and the entry offsets of everything below it have moved.
   */
  async save(): Promise<void> {
    if (!this.openPath || !this.dirty || this.readOnly) return;
    this.busy = true;
    this.error = '';
    try {
      await this.fs.writeFile(this.openPath, this.openContent);
      this.dirty = false;
      this.fileSaved.emit(this.openPath);

      const file = this.index?.all.get(this.openPath);
      if (file && this.index) {
        const reparsed = parseLfgFile(this.openContent, { path: this.openPath });
        reparsed.shadowed = file.shadowed;
        reparsed.unreferenced = file.unreferenced;
        this.index.all.set(this.openPath, reparsed);
        const i = this.index.files.findIndex((f) => f.path === this.openPath);
        if (i >= 0) this.index.files[i] = reparsed;
        // Rebuild from the visible files so section counts and offsets follow the edit.
        const { buildGroups } = await import('../workspace/grammar-index');
        this.index.groups = buildGroups(this.index.files);
        this.tree = buildTree(this.index);
      }
      this.status = `Saved ${this.openPath}`;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  async revert(): Promise<void> {
    if (!this.openPath) return;
    this.openContent = await this.fs.readFile(this.openPath);
    this.dirty = false;
  }

  // --- split pane -----------------------------------------------------------
  // A few lines of mousemove rather than a dependency; the client has no splitter
  // component to reuse.

  startDrag(event: MouseEvent): void {
    event.preventDefault();
    this.dragging = true;
  }

  onDrag(event: MouseEvent): void {
    if (!this.dragging) return;
    const host = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const fraction = (event.clientX - host.left) / host.width;
    this.splitFraction = Math.min(0.75, Math.max(0.15, fraction));
  }

  endDrag(): void {
    this.dragging = false;
  }
}
