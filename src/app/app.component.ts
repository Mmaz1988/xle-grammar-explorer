import { Component } from '@angular/core';

/**
 * Thin host around the grammar view.
 *
 * Everything real lives in `GrammarModule`; this shell exists only so the feature can
 * be run standalone, and is the part that would be discarded on integration.
 */
@Component({
  selector: 'app-root',
  template: `
    <header class="app-bar">
      <h1>XLE Grammar Explorer</h1>
      <span class="sub">a working tree of grammar sections</span>
    </header>
    <main><app-grammar-explorer></app-grammar-explorer></main>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100vh; }
    .app-bar {
      display: flex; align-items: baseline; gap: 10px;
      padding: 8px 14px; border-bottom: 1px solid #d8dee8; background: #243247; color: #fff;
      flex: none;
    }
    .app-bar h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .02em; }
    .sub { font-size: 11px; color: #9fb0c6; }
    main { flex: 1; min-height: 0; }
  `],
})
export class AppComponent {}
