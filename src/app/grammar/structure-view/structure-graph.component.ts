import {
  AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges,
  OnDestroy, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import type { StructureGraph, StructureNode } from './structure-model';

cytoscape.use(dagre);

/** What the user asked to do with a node, for the host to carry out. */
export interface StructureAction {
  action: 'open' | 'add-section' | 'add-file' | 'rename' | 'unlink' | 'relink' | 'delete';
  /** Absent for `add-file`, which is about the grammar rather than a node. */
  node?: StructureNode;
}

/**
 * The grammar drawn as a graph: the CONFIG, the files it includes, the sections they
 * hold, and which of those XLE will actually use.
 *
 * Laid out left to right with dagre, because the data is strictly layered and a
 * force-directed layout would obscure that. Nodes drag freely and their positions are
 * reported back so the host can remember them — a graph that rearranges itself every
 * time it opens is not somewhere you can learn your way around.
 */
@Component({
  selector: 'app-structure-graph',
  templateUrl: './structure-graph.component.html',
  styleUrls: ['./structure-graph.component.css'],
})
export class StructureGraphComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  @Input() graph?: StructureGraph;
  /** Remembered node positions, keyed by node id. */
  @Input() positions: Record<string, { x: number; y: number }> = {};

  @Output() action = new EventEmitter<StructureAction>();
  @Output() positionsChanged = new EventEmitter<Record<string, { x: number; y: number }>>();

  /** The node the context menu is open for, and where to draw it. */
  menu?: { node: StructureNode; x: number; y: number };

  /**
   * Whether to draw an edge from the CONFIG to every section it declares.
   *
   * Off by default. The CONFIG declares nearly every section, so those edges fan out
   * of one node across the whole diagram and bury the containment structure — and they
   * say nothing the node styling does not, since an undeclared section is already drawn
   * dashed. Worth turning on to see the declarations themselves.
   */
  showDeclarations = false;

  private cy?: cytoscape.Core;

  ngAfterViewInit(): void {
    this.cy = cytoscape({
      container: this.host.nativeElement,
      style: STYLE,
      wheelSensitivity: 0.2,
      // Dragging is the point; selecting boxes of nodes is not.
      boxSelectionEnabled: false,
    });

    this.cy.on('tap', 'node', (event: cytoscape.EventObject) => {
      this.menu = undefined;
      const node = this.nodeOf(event.target.id());
      if (node) this.action.emit({ action: 'open', node });
    });
    this.cy.on('cxttap', 'node', (event: cytoscape.EventObject) => {
      const node = this.nodeOf(event.target.id());
      if (!node) return;
      const { x, y } = event.renderedPosition ?? { x: 0, y: 0 };
      const box = this.host.nativeElement.getBoundingClientRect();
      this.menu = { node, x: box.left + x, y: box.top + y };
    });
    this.cy.on('tap', (event: cytoscape.EventObject) => {
      if (event.target === this.cy) this.menu = undefined;
    });
    this.cy.on('dragfree', 'node', () => this.reportPositions());

    this.render();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.cy && changes['graph']) this.render();
  }

  ngOnDestroy(): void {
    this.cy?.destroy();
  }

  closeMenu(): void {
    this.menu = undefined;
  }

  run(action: StructureAction['action'], node: StructureNode): void {
    this.menu = undefined;
    this.action.emit({ action, node });
  }

  addFile(): void {
    this.menu = undefined;
    this.action.emit({ action: 'add-file' });
  }

  toggleDeclarations(): void {
    this.showDeclarations = !this.showDeclarations;
    this.relayout();
  }

  /** Re-run the layout, discarding remembered positions. */
  relayout(): void {
    this.positions = {};
    this.render();
    this.reportPositions();
  }

  private nodeOf(id: string): StructureNode | undefined {
    return this.graph?.nodes.find((n) => n.id === id);
  }

  private render(): void {
    const cy = this.cy;
    if (!cy || !this.graph) return;

    cy.elements().remove();
    cy.add(this.graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.label,
        kind: node.kind,
        // Styling keys off this: a node XLE ignores is drawn dashed and muted.
        state: node.live ? 'live' : 'inert',
      },
      position: this.positions[node.id],
    })));
    const edges = this.graph.edges
      .filter((edge) => this.showDeclarations || edge.kind !== 'declares');
    cy.add(edges.map((edge) => ({
      data: { id: edge.id, source: edge.source, target: edge.target, kind: edge.kind },
    })));

    const known = this.graph.nodes.filter((n) => this.positions[n.id]).length;
    if (known < this.graph.nodes.length) {
      // Only lay out when something is new; otherwise the remembered arrangement stands.
      cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 14, rankSep: 90, animate: false } as never).run();
      this.reportPositions();
    }
    cy.fit(undefined, 30);
  }

  private reportPositions(): void {
    if (!this.cy) return;
    const out: Record<string, { x: number; y: number }> = {};
    this.cy.nodes().forEach((n: cytoscape.NodeSingular) => {
      const p = n.position();
      out[n.id()] = { x: p.x, y: p.y };
    });
    this.positions = out;
    this.positionsChanged.emit(out);
  }
}

/**
 * Cytoscape stylesheet, in the same palette as the rest of the app.
 *
 * Cast at the end: `@types/cytoscape` types style values far more narrowly than
 * Cytoscape accepts them — `width: 'label'` is valid and documented, but not in the
 * declared union — so the alternative is to fight the types rather than the library.
 */
const STYLE = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'font-family': 'SF Mono, Menlo, Consolas, monospace',
      'font-size': 10,
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': '150px',
      shape: 'round-rectangle',
      width: 'label',
      height: 'label',
      padding: '7px',
      'border-width': 1,
    },
  },
  { selector: 'node[kind="config"]', style: { 'background-color': '#243247', color: '#fff', 'border-color': '#243247', 'font-weight': 'bold' } },
  { selector: 'node[kind="file"]', style: { 'background-color': '#eef3fa', color: '#243247', 'border-color': '#bcd9f0' } },
  { selector: 'node[kind="section"]', style: { 'background-color': '#fff', color: '#243247', 'border-color': '#d8dee8' } },
  // Present but ignored by XLE: the thing this view exists to show.
  { selector: 'node[state="inert"]', style: { 'border-style': 'dashed', 'border-color': '#d97706', color: '#9aa7ba', 'background-color': '#fffaf3' } },
  {
    selector: 'edge',
    style: {
      width: 1,
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.7,
      'line-color': '#c6d0dc',
      'target-arrow-color': '#c6d0dc',
    },
  },
  { selector: 'edge[kind="declares"]', style: { 'line-color': '#00a9e0', 'target-arrow-color': '#00a9e0', 'line-style': 'dashed' } },
  { selector: 'edge[kind="files"]', style: { 'line-color': '#7c8ba1', 'target-arrow-color': '#7c8ba1' } },
] as unknown as cytoscape.Stylesheet[];
