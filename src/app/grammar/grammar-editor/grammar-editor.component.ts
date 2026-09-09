import {
  AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges,
  OnDestroy, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, indentUnit } from '@codemirror/language';
import { lfg } from '../lfg/lfg-language';
import { commentRegion } from '../lfg/lfg-commands';

/**
 * The editor pane: one file at a time, with LFG highlighting.
 *
 * CodeMirror is created once and reconfigured, rather than torn down per file, so that
 * undo history and scroll behaviour stay sane while moving around a grammar.
 */
@Component({
  selector: 'app-grammar-editor',
  templateUrl: './grammar-editor.component.html',
  styleUrls: ['./grammar-editor.component.css'],
})
export class GrammarEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;

  /** Text of the open file. */
  @Input() content = '';
  /** Path of the open file, shown in the header and used to detect a file change. */
  @Input() path = '';
  /** Character range to reveal and flash when the file opens. */
  @Input() reveal?: { start: number; end: number };
  @Input() readOnly = false;

  @Output() contentChange = new EventEmitter<string>();
  @Output() save = new EventEmitter<void>();

  private view?: EditorView;
  private editable = new Compartment();
  /** Set while we push text in, so the resulting update is not echoed back out. */
  private applying = false;

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
          // XLE grammars are indented in units of two columns per open brace.
          indentUnit.of('  '),
          ...lfg(),
          keymap.of([
            // Ctrl/Cmd-S saves, the one binding people will reach for first.
            { key: 'Mod-s', preventDefault: true, run: () => { this.save.emit(); return true; } },
            // Mirrors C-c C-c (lfg-comment-region) from the emacs mode.
            { key: 'Mod-;', preventDefault: true, run: commentRegion },
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
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: this.content },
      });
      this.applying = false;
    }
    if (changes['readOnly']) {
      this.view.dispatch({
        effects: this.editable.reconfigure(EditorView.editable.of(!this.readOnly)),
      });
    }
    if (changes['reveal'] || changes['path']) {
      this.applyReveal();
    }
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }

  /**
   * Scroll the requested range into view and select it.
   *
   * Selecting rather than just scrolling is deliberate: after clicking an entry in the
   * tree, the entry you asked for should be unmistakable in a 600-line lexicon.
   */
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
    view.focus();
  }
}
