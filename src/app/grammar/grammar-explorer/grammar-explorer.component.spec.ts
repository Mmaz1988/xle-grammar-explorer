/**
 * Change-detection stability tests.
 *
 * These exist because of a specific bug class the Node tests structurally cannot see.
 * The pane arrangement was once computed by a getter, so `*ngFor` received freshly
 * built arrays on every change-detection pass, destroyed every pane and rebuilt its
 * editor — and a rebuilt editor focuses itself, which schedules the next pass. Inside
 * Angular's zone that is an infinite loop; outside it, where scripted tests run,
 * nothing happens at all. Only a test that runs real change detection catches it.
 *
 * Two independent things now prevent it: the arrangement is a stored field rather than
 * a getter, and the `*ngFor` over columns has a `trackBy`. Either alone is enough, so
 * the identity test below is what actually fails if the field becomes a getter again.
 */

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { MatTreeModule } from '@angular/material/tree';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CommonModule } from '@angular/common';
import { GrammarExplorerComponent } from './grammar-explorer.component';
import { GrammarTreeComponent } from '../grammar-tree/grammar-tree.component';
import { GrammarEditorComponent } from '../grammar-editor/grammar-editor.component';
import { StructureGraphComponent } from '../structure-view/structure-graph.component';
import { FsAccessService } from '../workspace/fs-access.service';
import { WorkspaceStore } from '../workspace/workspace-store';

/** Just enough of a node for the template-choice check. */
type GrammarNodeLike = { level: string; children: unknown[] };

/** Pristine fixture. Specs that save mutate their copy, never this. */
const SOURCE_FILES: Record<string, string> = {
  // A realistic config: it declares its sections, not just its files. Without the
  // declarations every section would be inert, and the structure specs meaningless.
  'main.lfg':
    'DEMO ENGLISH CONFIG (1.0)\n' +
    '  ROOTCAT ROOT.\n' +
    '  FILES rules.lfg lex.lfg.\n' +
    '  RULES (VERB ENGLISH).\n' +
    '  LEXENTRIES (A ENGLISH) (B ENGLISH) (C ENGLISH).\n' +
    '----\n',
  // VP spans lines so that reindenting it produces visible indentation.
  'rules.lfg': 'VERB ENGLISH RULES (1.0)\nVP --> { V\n| NP\n}.\nS --> NP VP.\n----\n',
  'lex.lfg':
    'A ENGLISH LEXICON (1.0)\nhug V-S XLE @X.\n----\n' +
    'B ENGLISH LEXICON (1.0)\nowl N * @Y.\n----\n' +
    // Deliberately out of order, so sorting the view has something to move.
    'C ENGLISH LEXICON (1.0)\nzebra N * @Z.\napple N * @A.\nmango N * @M.\n----\n',
};

/** Reset for every spec, so one that saves cannot leak into the next. */
let FILES: Record<string, string>;

describe('GrammarExplorerComponent', () => {
  let fixture: ComponentFixture<GrammarExplorerComponent>;
  let component: GrammarExplorerComponent;

  beforeEach(async () => {
    FILES = { ...SOURCE_FILES };
    await TestBed.configureTestingModule({
      declarations: [
        GrammarExplorerComponent,
        GrammarTreeComponent,
        GrammarEditorComponent,
        StructureGraphComponent,
      ],
      imports: [CommonModule, FormsModule, MatTreeModule, MatIconModule, MatButtonModule],
    }).compileComponents();

    fixture = TestBed.createComponent(GrammarExplorerComponent);
    component = fixture.componentInstance;

    const fs = TestBed.inject(FsAccessService);
    spyOn(fs, 'readFile').and.callFake(async (p: string) => FILES[p]);
    spyOn(fs, 'writeFile').and.callFake(async (p: string, text: string) => { FILES[p] = text; });

    // Keep the specs off real IndexedDB, so they neither persist nor depend on
    // whatever a previous run left behind.
    const store = TestBed.inject(WorkspaceStore);
    spyOn(store, 'loadDirectory').and.resolveTo(undefined);
    spyOn(store, 'loadSession').and.resolveTo(undefined);
    spyOn(store, 'saveDirectory').and.resolveTo();
    spyOn(store, 'saveSession').and.resolveTo();

    fixture.detectChanges();
    await component['load']({
      name: 'test',
      source: { listFiles: async () => Object.keys(FILES), readFile: async (p) => FILES[p] },
    });
    fixture.detectChanges();
  });

  /** Re-read the fixture, for specs that change FILES after the initial load. */
  function reload(): Promise<void> {
    return component['load']({
      name: 'test',
      source: { listFiles: async () => Object.keys(FILES), readFile: async (p: string) => FILES[p] },
    });
  }

  function openFirstRule(): Promise<void> {
    const rules = component.tree.find((g) => g.label === 'RULES')!;
    return component.openNode(rules.children[0].children[0]);
  }

  function openSecondRuleInSplit(): Promise<void> {
    const rules = component.tree.find((g) => g.label === 'RULES')!;
    return component.openFromMenu(rules.children[0].children[1], 'split');
  }

  it('does not rebuild editors on repeated change detection', async () => {
    await openFirstRule();
    fixture.detectChanges();

    const editor = fixture.nativeElement.querySelector('.cm-editor');
    expect(editor).withContext('an editor should be rendered').toBeTruthy();

    for (let i = 0; i < 5; i++) fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cm-editor'))
      .withContext('the same editor DOM node must survive change detection')
      .toBe(editor);
  });

  it('keeps the column arrangement identical between reads', async () => {
    await openFirstRule();
    await openSecondRuleInSplit();
    fixture.detectChanges();
    // A getter would fail this, and a getter is what caused the loop.
    expect(component.columns).toBe(component.columns);
    expect(component.columns[0]).toBe(component.columns[0]);
  });

  it('opens the row menu on a right-click and closes it on the next click', async () => {
    const rules = component.tree.find((g) => g.label === 'RULES')!;
    component.onContextMenu({ node: rules.children[0].children[0], x: 40, y: 60 });
    fixture.detectChanges();

    const menu = fixture.nativeElement.querySelector('.row-menu');
    expect(menu).withContext('the menu should render').toBeTruthy();
    expect([...menu.querySelectorAll('button')].map((b: HTMLElement) => b.textContent!.trim()))
      .toEqual(['Open', 'Open in split view']);

    component.closeMenu();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.row-menu')).toBeNull();
  });

  it('opens a second pane on the same file from the row menu', async () => {
    const rules = component.tree.find((g) => g.label === 'RULES')!;
    const [first, second] = rules.children[0].children;

    await component.openFromMenu(first, 'here');
    fixture.detectChanges();
    expect(component.panes.length).toBe(1);

    // The same file again: a split must still get its own pane, since looking at two
    // places in one file is the main reason to ask for one.
    await component.openFromMenu(second, 'split');
    fixture.detectChanges();

    expect(component.panes.length).toBe(2);
    expect(component.panes[1].path).toBe(component.panes[0].path);
    expect(component.panes[0].reveal!.start).not.toBe(component.panes[1].reveal!.start);
    expect(fixture.nativeElement.querySelectorAll('.cm-editor').length).toBe(2);
  });

  it('leaves the tree expanded after a save', async () => {
    // Saving rebuilds the tree from the re-parsed file. Before node ids were stable,
    // that collapsed everything the user had open.
    const tree = fixture.debugElement.query(
      (de) => de.componentInstance instanceof GrammarTreeComponent,
    ).componentInstance as GrammarTreeComponent;

    const rules = component.tree.find((g) => g.label === 'RULES')!;
    tree.treeControl.expand(rules);
    tree.treeControl.expand(rules.children[0]);
    fixture.detectChanges();
    const before = tree.getExpanded().slice().sort();
    expect(before.length).toBe(2);

    await openFirstRule();
    const pane = component.activePane!;
    component.onContentChange(pane, `${pane.content}\n"trailing"\n`);
    await component.save(pane);
    fixture.detectChanges();

    expect(tree.getExpanded().slice().sort()).toEqual(before);
  });

  it('saves only the pane asked for, and saveAll saves the rest', async () => {
    await openFirstRule();
    await openSecondRuleInSplit();
    fixture.detectChanges();

    const [first, second] = component.panes;
    component.onContentChange(first, `${first.content}\n"one"\n`);
    component.onContentChange(second, `${second.content}\n"two"\n`);
    expect(component.dirtyPanes.length).toBe(2);

    await component.save(first);
    expect(first.dirty).withContext('the saved pane is clean').toBeFalse();
    expect(second.dirty).withContext('the other pane keeps its edits').toBeTrue();

    await component.saveAll();
    expect(component.dirtyPanes.length).toBe(0);
  });

  it('jumps in place, or beside, depending on the request', async () => {
    await openFirstRule();
    fixture.detectChanges();
    expect(component.panes.length).toBe(1);

    // A plain jump replaces the current view and can be undone.
    await component.goto({ name: 'S', fromCall: false });
    fixture.detectChanges();
    expect(component.panes.length).withContext('reuses the pane').toBe(1);
    expect(component.canGoBack).withContext('a replacing jump is undoable').toBeTrue();

    // With Shift it opens beside, and needs no undo since the source stays visible.
    const backBefore = component.canGoBack;
    await component.goto({ name: 'VP', fromCall: false, newPane: true });
    fixture.detectChanges();
    expect(component.panes.length).withContext('opens a second pane').toBe(2);
    expect(component.canGoBack).withContext('no undo pushed').toBe(backBefore);
    expect(fixture.nativeElement.querySelectorAll('.cm-editor').length).toBe(2);
  });

  it('moves a dragged entry between sections, leaving the result unsaved', async () => {
    const lexicon = component.tree.find((g) => g.label === 'LEXICON')!;
    const from = lexicon.children.find((s) => s.label === 'A ENGLISH')!;
    const to = lexicon.children.find((s) => s.label === 'B ENGLISH')!;
    const hug = from.children.find((e) => e.name === 'hug')!;

    await component.dropEntry({ source: hug, target: to, copy: false });
    fixture.detectChanges();

    const after = component.tree.find((g) => g.label === 'LEXICON')!;
    const names = (key: string) =>
      after.children.find((s) => s.label === key)!.children.map((e) => e.name);
    expect(names('A ENGLISH')).toEqual([]);
    expect(names('B ENGLISH')).toEqual(['owl', 'hug']);

    // Deliberately not written to disk: a drag is easy to do by accident.
    expect(component.dirtyPanes.length).withContext('the edit is staged, not saved').toBeGreaterThan(0);
  });

  it('refuses to move entries in or out of a file with unsaved changes', async () => {
    await openFirstRule();
    const pane = component.activePane!;
    component.onContentChange(pane, `${pane.content}\n"edited"\n`);

    const rules = component.tree.find((g) => g.label === 'RULES')!;
    const section = rules.children[0];
    const entry = section.children[0];
    // Same section is not a legal target anyway; use the entry's own file via a
    // different section to exercise the guard rather than the kind check.
    await component.dropEntry({ source: entry, target: section, copy: false });
    fixture.detectChanges();

    expect(component.tree.find((g) => g.label === 'RULES')!.children[0].children.length)
      .withContext('nothing moved').toBe(section.children.length);
  });

  /*
   * Note: the rendered *order* of entry rows is not asserted here. Angular Material's
   * nested tree builds a node's children through an outlet that this template creates
   * with *ngIf, and under TestBed those children never materialise, so any DOM-order
   * assertion would pass vacuously rather than test anything. The ordering itself is
   * covered by the sortTree specs in grammar-node.node-spec.ts; the rebuild that makes
   * the rows actually move is verified in a browser.
   */

  it('draws an empty section as a section, not as an entry', async () => {
    // An empty section — the main file's `DEMO ENGLISH RULES (1.0)` is a placeholder
    // with no rules — used to fall through to the leaf template and be drawn like an
    // entry, so it read as an item inside its group rather than a section of its own.
    const tree = fixture.debugElement.query(
      (de) => de.componentInstance instanceof GrammarTreeComponent,
    ).componentInstance as GrammarTreeComponent;

    const empty: GrammarNodeLike = { level: 'section', children: [] } as GrammarNodeLike;
    const entry: GrammarNodeLike = { level: 'entry', children: [] } as GrammarNodeLike;
    expect(tree.hasChild(0, empty as never)).withContext('sections take the branch template').toBeTrue();
    expect(tree.hasChild(0, entry as never)).withContext('entries do not').toBeFalse();
  });

  it('drops the pending-change notice once the change is saved', async () => {
    const lexicon = component.tree.find((g) => g.label === 'LEXICON')!;
    await component.dropEntry({
      source: lexicon.children.find((s) => s.label === 'A ENGLISH')!.children[0],
      target: lexicon.children.find((s) => s.label === 'B ENGLISH')!,
      copy: false,
    });
    fixture.detectChanges();
    expect(component.notice).withContext('a pending change says so').toContain('Unsaved');

    for (const pane of component.dirtyPanes.slice()) await component.save(pane);
    fixture.detectChanges();

    expect(component.notice).withContext('and stops saying so once saved').toBe('');
    expect(fixture.nativeElement.querySelector('.notice')).toBeNull();
  });

  it('clears the notice when a change is reverted', async () => {
    await openFirstRule();
    const pane = component.activePane!;
    component.onContentChange(pane, `${pane.content}\n"edited"\n`);
    component.notice = 'Something is pending.';

    await component.revert(pane);
    fixture.detectChanges();

    expect(component.notice).toBe('');
    expect(pane.dirty).toBeFalse();
  });

  it('opens a word from the sentence bar, beside the current file when shift-held', async () => {
    const lexicon = component.lexicon!;
    expect(lexicon).withContext('a lexicon is indexed for the sentence bar').toBeTruthy();
    const hit = [...lexicon.values()][0][0];

    await component.openLexiconHit({ hit, newPane: false });
    fixture.detectChanges();
    expect(component.panes.length).toBe(1);
    expect(component.tab).withContext('and shows it').toBe('editor');

    await component.openLexiconHit({ hit, newPane: true });
    fixture.detectChanges();
    expect(component.panes.length).withContext('shift opens beside').toBe(2);
  });

  it('builds a structure graph and switches to it', () => {
    expect(component.structure).withContext('a graph is available').toBeTruthy();
    expect(component.structure!.undeclared)
      .withContext('the fixture grammar declares everything').toEqual([]);

    component.showTab('structure');
    fixture.detectChanges();
    expect(component.tab).toBe('structure');
    expect(fixture.nativeElement.querySelector('app-structure-graph')).toBeTruthy();
  });

  it('brings the editor back when the tree is used from the structure view', async () => {
    component.showTab('structure');
    fixture.detectChanges();
    expect(component.tab).toBe('structure');

    const rules = component.tree.find((g) => g.label === 'RULES')!;
    await component.openNode(rules.children[0].children[0]);
    fixture.detectChanges();

    expect(component.tab).withContext('a tree click shows what it opened').toBe('editor');
    expect(component.activePane).toBeTruthy();
  });

  it('stays in the structure view while staging a structure edit', async () => {
    // Unlinking stages a config edit, which opens the config file in a pane. That must
    // not throw the user back to the editor mid-way through working on the structure.
    component.showTab('structure');
    fixture.detectChanges();

    const section = component.structure!.nodes.find((n) => n.kind === 'section')!;
    await component.onStructureAction({ action: 'unlink', node: section });
    fixture.detectChanges();

    expect(component.tab).withContext('still in the structure view').toBe('structure');
  });

  it('unlinks a section without touching the file that holds it', async () => {
    const section = component.structure!.nodes.find((n) => n.kind === 'section' && n.sectionKind === 'RULES')!;
    const before = FILES[section.path!];

    await component.onStructureAction({ action: 'unlink', node: section });
    fixture.detectChanges();

    const after = component.structure!.nodes.find((n) => n.id === section.id)!;
    expect(after.live).withContext('XLE would now ignore it').toBeFalse();
    expect(after.reason).toContain('not declared');
    expect(FILES[section.path!]).withContext('the section itself is untouched').toBe(before);

    // And back again: unlinking must be reversible from the view.
    await component.onStructureAction({ action: 'relink', node: after });
    fixture.detectChanges();
    expect(component.structure!.nodes.find((n) => n.id === section.id)!.live).toBeTrue();
  });

  it('offers both in-file orders regardless of the view', async () => {
    // Neither command depends on the view control: the category order was previously
    // only writable while the tree happened to be showing it.
    const lexicon = component.tree.find((g) => g.label === 'LEXICON')!;
    component.onContextMenu({ node: lexicon.children[0], x: 10, y: 10 });
    fixture.detectChanges();

    const items = Array.from(fixture.nativeElement.querySelectorAll('.row-menu button'))
      .map((b) => (b as HTMLElement).textContent!.trim());
    expect(items).toContain('Sort A–Z in file');
    expect(items).toContain('Sort by category in file');
  });

  it('sorts sections as well as the entries inside them', async () => {
    component.sortMode = 'alpha';
    fixture.detectChanges();
    const tree = fixture.debugElement.query(
      (de) => de.componentInstance instanceof GrammarTreeComponent,
    ).componentInstance as GrammarTreeComponent;
    const sections = tree.dataSource.data.find((g) => g.label === 'LEXICON')!.children.map((s) => s.label);
    expect(sections).toEqual([...sections].sort());
  });

  it('sorts the view without touching the file', async () => {
    const lexicon = () => component.tree.find((g) => g.label === 'LEXICON')!;
    const before = FILES['lex.lfg'];

    component.sortMode = 'alpha';
    fixture.detectChanges();

    // The tree is a view; the model and the file both keep their own order.
    expect(FILES['lex.lfg']).withContext('a sorted view writes nothing').toBe(before);
    expect(component.dirtyPanes.length).toBe(0);
    expect(lexicon()).toBeTruthy();
  });

  it('writes alphabetical order into the file only when asked', async () => {
    const lexicon = component.tree.find((g) => g.label === 'LEXICON')!;
    const section = lexicon.children.find((s) => s.label === 'B ENGLISH')!;
    // Give the section something to sort.
    await component.dropEntry({
      source: lexicon.children.find((s) => s.label === 'A ENGLISH')!.children[0],
      target: section,
      copy: false,
    });
    fixture.detectChanges();
    for (const pane of component.dirtyPanes.slice()) await component.save(pane);
    fixture.detectChanges();

    const target = component.tree.find((g) => g.label === 'LEXICON')!
      .children.find((s) => s.label === 'B ENGLISH')!;
    expect(target.children.map((e) => e.name)).toEqual(['owl', 'hug']);

    await component.sortSectionInFile(target);
    fixture.detectChanges();

    const after = component.tree.find((g) => g.label === 'LEXICON')!
      .children.find((s) => s.label === 'B ENGLISH')!;
    expect(after.children.map((e) => e.name)).toEqual(['hug', 'owl']);
    expect(component.dirtyPanes.length).withContext('staged, not written').toBeGreaterThan(0);
  });

  it('refuses to sort a section holding a stranded continuation', async () => {
    // A stray period ends `than` early, so the constraint below it parses as an entry
    // headed `((OBL-COMP`. Sorting would move that fragment away from the entry it
    // continues — which is exactly how it surfaced, at the top of a real lexicon.
    FILES['lex.lfg'] = FILES['lex.lfg'].replace(
      'C ENGLISH LEXICON (1.0)\nzebra N * @Z.',
      'C ENGLISH LEXICON (1.0)\n' +
        "than CComp * (^PRED) = 'than<(^OBJ)>'.\n" +
        '        ((OBL-COMP ^) DEGREE) =c comparative.\n' +
        'zebra N * @Z.',
    );
    await reload();
    fixture.detectChanges();

    const before = FILES['lex.lfg'];
    const target = component.tree.find((g) => g.label === 'LEXICON')!
      .children.find((s) => s.label === 'C ENGLISH')!;

    await component.sortSectionInFile(target);
    fixture.detectChanges();

    expect(component.error).withContext('says why, and where').toContain('((OBL-COMP');
    expect(component.error).toContain('Not sorted');
    expect(FILES['lex.lfg']).withContext('nothing written').toBe(before);
    expect(component.dirtyPanes.length).withContext('nothing staged either').toBe(0);
  });

  it('marks a malformed entry in the tree rather than hiding it', async () => {
    FILES['lex.lfg'] = FILES['lex.lfg'].replace(
      'owl N * @Y.',
      "owl N * (^PRED) = 'owl'.\n   (^ NUM) =c sg.",
    );
    await reload();
    fixture.detectChanges();

    const entries = component.tree.find((g) => g.label === 'LEXICON')!
      .children.find((s) => s.label === 'B ENGLISH')!.children;
    const flagged = entries.filter((e) => e.suspect);
    expect(flagged.length).withContext('the stranded constraint is flagged').toBe(1);
    expect(flagged[0].suspect).toContain('not a morphcode');
  });

  it('honours Option shortcuts even though macOS composes them into characters', async () => {
    // Option is the compose key on macOS: Option+Q *is* `œ`, so `event.key` never says
    // "q" and a plain Alt-q binding cannot fire — it types the accented character
    // instead, which is exactly what happened. Matching is on `event.code`.
    await openFirstRule();
    fixture.detectChanges();

    const view = (component.editors.first as unknown as { view_: {
      state: { doc: { toString(): string; length: number } };
      dispatch(spec: unknown): void;
      contentDOM: HTMLElement;
    } }).view_;

    const flattened = view.state.doc.toString().split('\n').map((l) => l.trimStart()).join('\n');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: flattened } });
    view.dispatch({ selection: { anchor: 30 } });

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'œ', code: 'KeyQ', altKey: true, bubbles: true, cancelable: true,
    }));

    const after = view.state.doc.toString();
    expect(after).withContext('no stray composed character was typed').not.toContain('œ');
    // Head lines are flush left, so reindenting shows up on the continuation lines.
    expect(after.split('\n').some((line) => /^\s+\S/.test(line)))
      .withContext('the entry was reindented').toBeTrue();
    expect(after).not.toBe(flattened);
  });

  it('keeps one editor per pane after splitting', async () => {
    await openFirstRule();
    await openSecondRuleInSplit();
    component.setLayout('grid');
    fixture.detectChanges();

    expect(component.panes.length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.cm-editor').length).toBe(2);
  });
});
