import {
  ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges,
} from '@angular/core';
import { NestedTreeControl } from '@angular/cdk/tree';
import { MatTreeNestedDataSource } from '@angular/material/tree';
import { GrammarNode, canDrop, countEntries, filterTreeDetailed } from './grammar-node';

/**
 * How many entries may be auto-expanded when a filter is applied.
 *
 * A filter that matches most of a grammar would otherwise expand thousands of nodes at
 * once, which is the same freeze that eager child rendering caused. Past this budget we
 * expand down to section level only and let the user open the section they want.
 */
const AUTO_EXPAND_BUDGET = 300;

/**
 * The working tree: grammar sections rather than files.
 *
 * Uses the CDK `NestedTreeControl` + `MatTreeNestedDataSource` pair, the same
 * combination as the xleplusglue client's `utilities/file-tree` component — but with
 * children rendered lazily (see the template) and without that component's hardcoded
 * 760px width, which would fight the resizable split pane here.
 */
@Component({
  selector: 'app-grammar-tree',
  templateUrl: './grammar-tree.component.html',
  styleUrls: ['./grammar-tree.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GrammarTreeComponent implements OnChanges {
  @Input() nodes: GrammarNode[] = [];
  @Input() filter = '';
  /** Path+line of the entry currently open, so the tree can mark it. */
  @Input() selected?: { path: string; line: number };

  @Output() entrySelected = new EventEmitter<GrammarNode>();
  /** Right-click (or ctrl-click on a Mac) on a row, with where to put the menu. */
  @Output() entryContextMenu = new EventEmitter<{ node: GrammarNode; x: number; y: number }>();
  /** An entry dragged onto a section. `copy` when the pointer was holding Alt. */
  @Output() entryDropped = new EventEmitter<{ source: GrammarNode; target: GrammarNode; copy: boolean }>();

  /**
   * Expansion is tracked by node id, not object identity.
   *
   * Saving rebuilds the tree, so identity-keyed expansion would collapse everything
   * the user had open every time they pressed ⌘S.
   */
  treeControl = new NestedTreeControl<GrammarNode, string>((node) => node.children, {
    trackBy: (node) => node.id,
  });
  dataSource = new MatTreeNestedDataSource<GrammarNode>();

  /** Set when a filter matched more than we are willing to expand at once. */
  truncatedExpansion = false;
  /** How many entries the current filter matched, for the result line. */
  matchCount = 0;

  /** Reuse rendered rows across a rebuild, so the tree does not flash or lose scroll. */
  trackNode = (_: number, node: GrammarNode): string => node.id;

  /** Ids of the currently expanded nodes, for saving the session. */
  getExpanded(): string[] {
    return [...this.treeControl.expansionModel.selected];
  }

  /** Re-expand the nodes named by `ids`, ignoring any that no longer exist. */
  setExpanded(ids: string[]): void {
    if (!ids.length) return;
    this.treeControl.expansionModel.select(...ids);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['nodes'] && !changes['filter']) return;

    const { nodes: visible, matches } = filterTreeDetailed(this.nodes, this.filter);
    this.matchCount = matches;
    // Only reset expansion when the filter changed. A rebuild of the same grammar —
    // what a save produces — must leave the tree exactly as the user left it.
    if (changes['filter']) this.treeControl.collapseAll();
    this.dataSource.data = visible;
    this.treeControl.dataNodes = visible;

    // A filtered tree is useless collapsed — the point is to see what matched — but
    // expansion has to stay within a budget.
    this.truncatedExpansion = false;
    if (this.filter.trim() !== '') {
      this.expandWithinBudget(visible);
    }
  }

  /**
   * Expand groups, then sections in order, stopping before the rendered entry count
   * would exceed {@link AUTO_EXPAND_BUDGET}.
   */
  private expandWithinBudget(nodes: GrammarNode[]): void {
    let budget = AUTO_EXPAND_BUDGET;
    for (const group of nodes) {
      if (!group.matched) continue;
      this.treeControl.expand(group);
      for (const section of group.children) {
        // A section shown only because its own name matched is left closed: its
        // entries are not results, and expanding them buries the ones that are.
        if (!section.matched) continue;
        const cost = countEntries([section]);
        if (cost > budget) {
          this.truncatedExpansion = true;
          continue;
        }
        budget -= cost;
        this.treeControl.expand(section);
      }
    }
  }

  /** The entry being dragged, and the section currently under the pointer. */
  dragging?: GrammarNode;
  dropTarget?: GrammarNode;

  hasChild = (_: number, node: GrammarNode): boolean => node.children.length > 0;

  onDragStart(event: DragEvent, node: GrammarNode): void {
    if (node.level !== 'entry') return;
    this.dragging = node;
    // Some payload is required or Firefox refuses to start a drag at all.
    event.dataTransfer?.setData('text/plain', node.name);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
  }

  onDragEnd(): void {
    this.dragging = undefined;
    this.dropTarget = undefined;
  }

  onDragOver(event: DragEvent, node: GrammarNode): void {
    if (!this.dragging || !canDrop(this.dragging, node)) return;
    // Preventing the default is what marks this element as a drop target.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
    this.dropTarget = node;
  }

  onDragLeave(node: GrammarNode): void {
    if (this.dropTarget === node) this.dropTarget = undefined;
  }

  onDrop(event: DragEvent, node: GrammarNode): void {
    const source = this.dragging;
    this.dropTarget = undefined;
    this.dragging = undefined;
    if (!source || !canDrop(source, node)) return;
    event.preventDefault();
    this.entryDropped.emit({ source, target: node, copy: event.altKey });
  }

  isDropTarget(node: GrammarNode): boolean {
    return this.dropTarget === node;
  }

  /** A section that cannot accept the entry being dragged, so it can be dimmed. */
  isRejectingDrop(node: GrammarNode): boolean {
    return this.dragging !== undefined && node.level === 'section' && !canDrop(this.dragging, node);
  }

  isSelected(node: GrammarNode): boolean {
    return (
      this.selected !== undefined &&
      node.level === 'entry' &&
      node.path === this.selected.path &&
      node.line === this.selected.line
    );
  }

  select(node: GrammarNode): void {
    if (node.path !== undefined) {
      this.entrySelected.emit(node);
    }
  }

  /**
   * Offer the row's menu.
   *
   * `contextmenu` covers both gestures: on a Mac, ctrl-click raises it as well as a
   * right-click, so there is nothing extra to handle for either.
   */
  openMenu(event: MouseEvent, node: GrammarNode): void {
    if (node.path === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.entryContextMenu.emit({ node, x: event.clientX, y: event.clientY });
  }
}
