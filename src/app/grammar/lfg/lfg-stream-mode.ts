/**
 * Syntax highlighting for XLE/LFG grammar text.
 *
 * This is a direct port of the font-lock rules in the Aquamacs `lfg-mode`
 * (~/.emacs.d/lisp/lfg-mode.el), so that a grammar looks the same in the browser as
 * it does in the editor it is normally written in.
 *
 * It is deliberately written as a **CodeMirror 5 style stream mode object**: a `token`
 * function that consumes from a stream and returns a token name. CodeMirror 6 runs
 * this shape directly via `StreamLanguage.define()`, and CodeMirror 5 via
 * `CodeMirror.defineMode()` — which is exactly what the xleplusglue client's
 * `editor.component.ts` already does for its `liger`, `glue` and `nli` modes. Keeping
 * the tokenizer in this shape means the highlighting is portable between the two
 * without a rewrite, whichever editor a host app happens to use.
 *
 * Emacs applies these rules in order with no `override` flag, and font-lock does not
 * re-highlight text an earlier rule already claimed. So the ordering below is the
 * semantics, not a stylistic choice: the template-LHS rule must be tried before the
 * lexical-headword rule, or `PASS(FRAME) = ...` gets highlighted as a headword.
 */

/** Token names produced by the mode. These map to CSS classes / highlight tags. */
/**
 * Token names produced by the mode. These map to highlight tags and, in CodeMirror 5,
 * to `.cm-<name>` CSS classes.
 *
 * The LFG-specific ones are prefixed. CodeMirror 6's stream-language layer ships a
 * default table for the common CodeMirror 5 names — `builtin` and `variable` among
 * them — and that table wins over a `tokenTable` entry of the same name, so `builtin`
 * silently resolved near `variableName` and the disjunction braces came out the same
 * green as `%local` names. Names it does not own resolve to exactly what we say.
 */
export type LfgToken =
  | 'comment'
  | 'keyword'
  | 'string'
  | 'lfgOperator'
  | 'lfgLocal'
  | 'lfgProjection'
  | null;

interface StreamLike {
  sol(): boolean;
  eol(): boolean;
  /**
   * CodeMirror's StringStream returns `undefined` at end of line, not `null`.
   * Getting this wrong is not a type nicety: a `!== null` loop condition never
   * terminates, and the tokenizer spins the renderer.
   */
  peek(): string | undefined;
  next(): string | undefined;
  eat(match: string | RegExp): string | undefined | void;
  match(pattern: string | RegExp, consume?: boolean): boolean | RegExpMatchArray | null;
  skipToEnd(): void;
  eatSpace(): boolean;
  readonly string: string;
  pos: number;
}

export interface LfgState {
  /** Inside a `"..."` comment, which may span many lines. */
  inComment: boolean;
  /** The head of a line has not been consumed yet (used for the line-start rules). */
  atLineStart: boolean;
  /**
   * The previous token ended a term, with no whitespace since.
   *
   * This is what separates the two meanings of `@`: a template call starts a schema and
   * so never directly follows a term, while glue application always does.
   */
  afterTerm: boolean;
}

/**
 * `"..."` is XLE's comment syntax, and it is what the emacs syntax table calls a
 * string. Both are given the same colour there ("Chocolate"), so a single token name
 * is enough; we call it `comment` because that is what it means in a grammar.
 */
function tokenComment(stream: StreamLike, state: LfgState): LfgToken {
  // Loop on eol(), never on `peek() !== null`: StringStream.peek() yields `undefined`
  // past the end of a line, so a null comparison is always true and the loop never
  // ends. Any line finishing inside an unterminated comment hits this, which is every
  // multi-line comment in every grammar here.
  while (!stream.eol()) {
    const c = stream.next();
    // A backquote escapes the next character, including a closing quote.
    if (c === '`') {
      stream.next();
      continue;
    }
    if (c === '"') {
      state.inComment = false;
      return 'comment';
    }
  }
  return 'comment';
}

export const lfgStreamMode = {
  name: 'lfg',

  startState(): LfgState {
    return { inComment: false, atLineStart: true, afterTerm: false };
  },

  copyState(state: LfgState): LfgState {
    return { ...state };
  },

  token(stream: StreamLike, state: LfgState): LfgToken {
    if (state.inComment) {
      if (stream.sol()) {
        state.atLineStart = true;
      }
      return tokenComment(stream, state);
    }

    // Track "nothing but whitespace so far on this line" rather than using sol():
    // every template and lexical entry in these grammars is indented, and testing
    // sol() alone means the line-start rules never fire for them.
    if (stream.sol()) {
      state.atLineStart = true;
      state.afterTerm = false;
    }
    if (stream.eatSpace()) {
      state.afterTerm = false;
      return null;
    }
    const lineStart = state.atLineStart;
    state.atLineStart = false;

    // Rule 0: `#` comments a line, but only at the start of one. This is the
    // MORPHOLOGY section's comment syntax; elsewhere `#` is not special.
    if (lineStart && stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }

    if (lineStart) {
      // Rule 2 (glue): a `:$` at line start introduces a glue premise. From the two
      // glue rules your local lfg-mode adds over the stock one in xle/emacs/.
      if (stream.match(/^:\$/)) {
        return 'keyword';
      }

      // Rule 1: a template or macro definition LHS, up to the `=`.
      // `(?!=|c)` keeps `=c` (constraining) and `==` from ending a name early.
      const head = /^([A-Za-z][^:^\n)(]*(?:\([^)^]*\))?)([ \t]*=)(?!=|c)/.exec(
        stream.string.slice(stream.pos),
      );
      if (head) {
        stream.pos += head[1].length;
        return 'keyword';
      }

      // Rule 5: a rule LHS, up to `-->`.
      const ruleHead = /^([^^\n]+?)([ \t]*-->)/.exec(stream.string.slice(stream.pos));
      if (ruleHead) {
        stream.pos += ruleHead[1].length;
        return 'keyword';
      }

      // Rule 4: a lexical headword — `word CATEGORY morphcode`, where the morphcode
      // is `*` or `XLE`. Matching the whole shape is what distinguishes a headword
      // from any other identifier sitting at the start of a line.
      // Whitespace lookahead, not `\b`: a boundary after `*` needs a word character
      // next, and a morphcode is always followed by space. lfg-mode's own rule ends
      // `\(\*\|XLE\)` with nothing after it, for exactly this reason.
      const lex = /^((?:[^ \t\n`]|`.)+)([ \t]+[^ \n\t]+[ \t]+(?:\*|XLE)(?=\s|$))/.exec(
        stream.string.slice(stream.pos),
      );
      if (lex) {
        stream.pos += lex[1].length;
        return 'keyword';
      }
    }

    const c = stream.peek();

    if (c === '"') {
      stream.next();
      state.inComment = true;
      return tokenComment(stream, state);
    }

    // A backquote escapes the following character; keep them together so an escaped
    // brace or quote is never mistaken for structure.
    if (c === '`') {
      stream.next();
      stream.next();
      return 'string';
    }

    // Rule 3: the linear-logic lollipop.
    if (stream.match(/^-o\b/)) {
      return 'lfgOperator';
    }

    // Rule 6: only the `@` glyph is coloured, not the template name after it. That is
    // what lfg-mode does, and XLE grammars read as a red `@` before a plain name.
    //
    // But only when it introduces a template call. In a glue premise `@` is function
    // application — `V@e` applies V to e — and colouring those as operators makes every
    // lambda term look like it is full of template calls.
    if (c === '@') {
      const application = state.afterTerm;
      stream.next();
      state.afterTerm = false;
      return application ? null : 'lfgOperator';
    }

    // Rule 7: disjunction delimiters.
    if (c === '{' || c === '}' || c === '|') {
      stream.next();
      return 'lfgOperator';
    }

    // Beyond the ported rules: local names (`%stem`, `%mc296`) and projections
    // (`s::`, `o::`) are the two things a grammar writer scans for most after the
    // above, and the emacs mode leaves them plain only because its syntax table
    // folds them into words.
    if (c === '%') {
      stream.match(/^%[^\s.,;:(){}[\]]*/);
      state.afterTerm = true;
      return 'lfgLocal';
    }
    if (stream.match(/^[a-z]::/)) {
      return 'lfgProjection';
    }

    // PRED values: `'walk<(^SUBJ)>'`. Not a string to XLE — the apostrophe is a word
    // character, and it is also the X-bar bar-level marker in `C'`, `V'` — so only
    // treat it as a PRED when it closes on the same line.
    if (c === "'") {
      const rest = stream.string.slice(stream.pos + 1);
      const close = rest.indexOf("'");
      if (close >= 0) {
        stream.pos += close + 2;
        return 'string';
      }
    }

    const consumed = stream.next();
    // Identifiers, closing brackets and quotes can all end a term.
    state.afterTerm = consumed !== undefined && /[A-Za-z0-9_')\]]/.test(consumed);
    return null;
  },
};
