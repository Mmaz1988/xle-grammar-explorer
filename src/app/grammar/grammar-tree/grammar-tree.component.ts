import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { NestedTreeControl } from '@angular/cdk/tree';
import { MatTreeNestedDataSource } from '@angular/material/tree';
import { GrammarNode, filterTree } from './grammar-node';

/**
 * The working tree: grammar sections rather than files.
 *
 * Uses the CDK `NestedTreeControl` + `MatTreeNestedDataSource` pair, the same
 * combination as the xleplusglue client's `utilities/file-tree` component, so the
 * idiom is familiar — but without that component's hardcoded 760px width, which would
 * fight the resizable split pane here.
 */
@Component({
  selector: 'app-grammar-tree',
  templateUrl: './grammar-tree.component.html',
  styleUrls: ['./grammar-tree.component.css'],
})
export class GrammarTreeComponent implements OnChanges {
  @Input() nodes: GrammarNode[] = [];
  @Input() filter = '';
  /** Path+line of the entry currently open, so the tree can mark it. */
  @Input() selected?: { path: string; line: number };

  @Output() entrySelected = new EventEmitter<GrammarNode>();

  treeControl = new NestedTreeControl<GrammarNode>((node) => node.children);
  dataSource = new MatTreeNestedDataSource<GrammarNode>();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['nodes'] || changes['filter']) {
      const visible = filterTree(this.nodes, this.filter);
      this.dataSource.data = visible;
      // A filtered tree is useless collapsed: the whole point is to see what matched.
      if (this.filter.trim() !== '') {
        this.treeControl.dataNodes = visible;
        this.treeControl.expandAll();
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
