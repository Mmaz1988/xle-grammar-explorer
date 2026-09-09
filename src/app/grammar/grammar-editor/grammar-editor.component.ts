import {
  AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges,
  OnDestroy, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, indentUnit } from '@codemirror/language';
import { lfg } from '../lfg/lfg-language';
import { commentRegion } from '../lfg/lfg-commands';
import { lfgCompletions, type CompletionEntry } from '../lfg/lfg-completion';
import { identifierAt, templateCallAt } from '../lfg/lfg-references';

/** A request to jump to wherever `name` is defined. */
export interface GotoRequest {
  name: string;
  /** True when the name came from an `@call` rather than a bare identifier. */
  fromCall: boolean;
  /** Open the definition beside the current file instead of replacing it. */
  newPane?: boolean;
}

/**
 * The editor pane: one file, with LFG highlighting, completion and go-to-definition.
 *
 * CodeMirror is created once and reconfigured rather than torn down per file, so undo
 * history and scrolling stay sane while moving around a grammar.
 */
@Component({
  selector: 'app-grammar-editor',
  templateUrl: './grammar-editor.component.html',
  styleUrls: ['./grammar-editor.component.css'],
})
export class GrammarEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  @Input() content = '';
  @Input() path = '';
  /** Character range to reveal and select when the file opens. */
  @Input() reveal?: { start: number; end: number };
  @Input() readOnly = false;
  @Input() dirty = false;
  /** Names this grammar defines, for completion. */
  @Input() completions: CompletionEntry[] = [];
  /** Marks which pane keyboard focus and tree clicks act on. */
  @Input() active = false;
  /** Hides the close button when only one pane is open. */
  @Input() closable = false;

  @Output() contentChange = new EventEmitter<string>();
  @Output() save = new EventEmitter<void>();
  @Output() goto = new EventEmitter<GotoRequest>();
  @Output() focused = new EventEmitter<void>();
  @Output() closeRequested = new EventEmitter<void>();

  private view?: EditorView;
  private editable = new Compartment();
  /** Set while pushing text in, so the resulting update is not echoed back out. */
  private applying = false;

  get view_(): EditorView | undefined {
    return this.view;
  }

  ngAfterViewInit(): void {
    this.view = new EditorView({
      parent: this.host.nativeElement,
      state: EditorState.create({
        doc: this.content,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          bracketMatching(),
          history(),
          indentUnit.of('  '),
          ...lfg(),
          autocompletion({
            override: [lfgCompletions(() => this.completions)],
            // XLE names are written in a mix of cases and the list is long; matching
            // loosely finds `DEFAULT-NOUN-SEM` from `dns`.
            activateOnTyping: true,
          }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { this.save.emit(); return true; } },
            // Mirrors C-c C-c (lfg-comment-region) in the emacs mode.
            { key: 'Mod-;', preventDefault: true, run: commentRegion },
            // Mirrors M-" (imenu-go-find-at-position), plus the usual F12 and Mod-click.
            { key: 'Alt-\'', preventDefault: true, run: () => this.requestGoto() },
            { key: 'F12', preventDefault: true, run: () => this.requestGoto() },
            // Shift opens the definition beside the current file rather than in place,
            // for reading a template and its call site together.
            { key: 'Shift-F12', preventDefault: true, run: () => this.requestGoto(undefined, true) },
            ...completionKeymap,
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          this.editable.of(EditorView.editable.of(!this.readOnly)),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.applying) {
              this.contentChange.emit(update.state.doc.toString());
            }
            // Only announce a real change of focus, and only into a pane that is not
            // already the active one; an unconditional emit here feeds change detection
            // on every click inside the editor.
            if (update.focusChanged && update.view.hasFocus && !this.active) {
              this.focused.emit();
            }
          }),
          EditorView.domEventHandlers({
            mousedown: (event, view) => {
              // Cmd/Ctrl-click jumps, the convention everywhere else; adding Shift
              // opens the definition in a new pane instead of replacing this file.
              if (!event.metaKey && !event.ctrlKey) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null) return false;
              event.preventDefault();
              return this.requestGoto(pos, event.shiftKey);
            },
          }),
        ],
      }),
    });
    this.applyReveal();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.view) return;
    if (changes['content'] && this.content !== this.view.state.doc.toString()) {
      this.applying = true;
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: this.content } });
      this.applying = false;
    }
    if (changes['readOnly']) {
      this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(!this.readOnly)) });
    }
    if (changes['reveal'] || changes['path']) {
      this.applyReveal();
    }
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }

  focus(): void {
    this.view?.focus();
  }

  /**
   * Ask the host to resolve the name under the caret.
   *
   * Prefers an `@call`, since that is unambiguously a template reference; falls back to
   * the bare identifier so a category in a rule can jump to the rule defining it.
   */
  private requestGoto(at?: number, newPane = false): boolean {
    const view = this.view;
    if (!view) return false;
    const pos = at ?? view.state.selection.main.head;
    const doc = view.state.doc.toString();
    const call = templateCallAt(doc, pos);
    if (call) {
      this.goto.emit({ name: call.name, fromCall: true, newPane });
      return true;
    }
    const word = identifierAt(doc, pos);
    if (word) {
      this.goto.emit({ name: word.name, fromCall: false, newPane });
      return true;
    }
    return false;
  }

  /** Scroll a range into view and select it, so a jump target is unmistakable. */
  private applyReveal(): void {
    const view = this.view;
    if (!view || !this.reveal) return;
    const max = view.state.doc.length;
    const from = Math.min(this.reveal.start, max);
    const to = Math.min(this.reveal.end, max);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 40 }),
    });
    // Taking focus is only right for the pane the user is working in. Doing it
    // unconditionally means several panes fight over focus as they render.
    if (this.active) view.focus();
  }
}
