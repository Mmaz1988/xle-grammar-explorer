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

  treeControl = new NestedTreeControl<GrammarNode>((node) => node.children);
  dataSource = new MatTreeNestedDataSource<GrammarNode>();

  /** Set when a filter matched more than we are willing to expand at once. */
  truncatedExpansion = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['nodes'] && !changes['filter']) return;

    const visible = filterTree(this.nodes, this.filter);
    this.treeControl.collapseAll();
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
}
