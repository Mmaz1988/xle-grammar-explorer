/**
 * Data model for a parsed XLE/LFG grammar.
 *
 * Everything here is plain TypeScript with no Angular dependency, deliberately:
 * the parser is the part of this app most likely to be reused elsewhere (and it is
 * the part the headless regression harness exercises without a browser).
 *
 * The model is *derived state*. Files on disk stay the single source of truth, and
 * every node carries the exact character offsets it came from, so an edit is always
 * a splice into the text we read rather than a re-serialisation of the model.
 */

/** Section types XLE understands. The first three carry entries; the others don't. */
export type SectionKind =
  | 'CONFIG'
  | 'RULES'
  | 'LEXICON'
  | 'TEMPLATES'
  | 'MORPHOLOGY'
  | 'FEATURES';

/**
 * What an individual entry is. Note `rule` vs `macro`: inside one RULES section XLE
 * accepts both `S --> NP VP.` (a c-structure rule) and `NPCOORD(_CAT) = ....` (a rule
 * macro), and they are different things to a grammar writer, so the tree shows them
 * differently. The emacs lfg-mode draws the same distinction via lfg-is-rule /
 * lfg-is-macro.
 */
export type EntryKind = 'rule' | 'macro' | 'template' | 'lex' | 'config-field' | 'morph-field';

/** A half-open character range `[start, end)` into the *original* file text. */
export interface Span {
  start: number;
  end: number;
}

/**
 * A rule reduced to its phrase-structure skeleton.
 *
 * Kept as a small tree rather than a string so the display can be shortened
 * intelligently — eliding the inside of a disjunction rather than chopping characters
 * off the end — and coloured without re-parsing.
 */
export type RuleSkeleton =
  | { kind: 'seq'; items: RuleSkeleton[] }
  | { kind: 'disj'; alts: RuleSkeleton[] }
  | { kind: 'opt'; body: RuleSkeleton }
  | { kind: 'cat'; name: string; kleene?: string }
  | { kind: 'call'; text: string };

/** A run of label text with a role, so the tree can colour it like the editor does. */
export interface LabelPart {
  text: string;
  cls?: 'name' | 'arrow' | 'disj' | 'opt' | 'call' | 'elide' | 'muted';
}

export interface LfgEntry extends Span {
  kind: EntryKind;
  /** The identifier shown in the tree, e.g. `PASS(FRAME)`, `hug`, `VP[_form]`. */
  name: string;
  /**
   * A short reduced rendering for rules — `S --> (ADVP) NP VP[fin]`. Undefined when
   * extraction was not confident; callers fall back to `name` or the first line.
   */
  display?: string;
  /** 1-based line of `start`, for "open the file here". */
  line: number;
  /** Lexical entries only: the category and morphcode of the first category block. */
  category?: string;
  morphcode?: string;
  /** True when the entry contains a glue premise (`:$ ...`) or a lollipop. */
  hasGlue?: boolean;
  /** Rules only: the phrase-structure skeleton behind {@link display}. */
  skeleton?: RuleSkeleton;
}

export interface LfgSection extends Span {
  kind: SectionKind;
  /** The two header tokens that identify the section, e.g. `SENTENCE` + `ENGLISH`. */
  id: [string, string];
  version: string;
  /** `SENTENCE ENGLISH` — how CONFIG refers to this section. */
  key: string;
  line: number;
  entries: LfgEntry[];
  /** CONFIG sections only. */
  config?: ConfigField[];
}

export interface ConfigField extends Span {
  keyword: string;
  /** Raw value text with comments already stripped. */
  value: string;
  /** For FILES: the listed paths. For LEXENTRIES/RULES/...: the `(A B)` section keys. */
  items: string[];
  line: number;
}

/** One physical file, with the sections it contains. */
export interface LfgFile {
  /** Path relative to the grammar root, e.g. `lexica/verblex_fracas.lfg.glue`. */
  path: string;
  text: string;
  sections: LfgSection[];
  /** True for an `X.lfg` that has an `X.lfg.glue` sibling: generated, hidden. */
  shadowed?: boolean;
  /** True when no CONFIG in the grammar reaches this file. */
  unreferenced?: boolean;
  /** Parse problems that did not stop the parse. */
  diagnostics?: string[];
}
