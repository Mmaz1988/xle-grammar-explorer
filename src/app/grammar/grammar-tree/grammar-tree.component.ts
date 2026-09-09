import {
  ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges,
} from '@angular/core';
import { NestedTreeControl } from '@angular/cdk/tree';
import { MatTreeNestedDataSource } from '@angular/material/tree';
import { GrammarNode, countEntries, filterTree } from './grammar-node';

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

    const visible = filterTree(this.nodes, this.filter);
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
      this.treeControl.expand(group);
      for (const section of group.children) {
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

  hasChild = (_: number, node: GrammarNode): boolean => node.children.length > 0;

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
