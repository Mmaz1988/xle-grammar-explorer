import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTreeModule } from '@angular/material/tree';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

import { GrammarExplorerComponent } from './grammar-explorer/grammar-explorer.component';
import { GrammarTreeComponent } from './grammar-tree/grammar-tree.component';
import { GrammarEditorComponent } from './grammar-editor/grammar-editor.component';
import { StructureGraphComponent } from './structure-view/structure-graph.component';
import { SentenceSearchComponent } from './sentence-search/sentence-search.component';

/**
 * The grammar view, packaged so a host application can import this one module and use
 * `<app-grammar-explorer>`.
 *
 * It pulls in only what it uses and declares nothing app-specific — no routes, no
 * global providers — so dropping it into another Angular app is an import rather than
 * a merge.
 */
@NgModule({
  declarations: [
    GrammarExplorerComponent,
    GrammarTreeComponent,
    GrammarEditorComponent,
    StructureGraphComponent,
    SentenceSearchComponent,
  ],
  imports: [CommonModule, FormsModule, MatTreeModule, MatIconModule, MatButtonModule],
  exports: [GrammarExplorerComponent],
})
export class GrammarModule {}
