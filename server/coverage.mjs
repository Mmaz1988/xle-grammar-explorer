/**
 * Which words of a sentence does a grammar actually cover?
 *
 * The lexicon alone cannot answer this. A word reaches a parse through the
 * morphological analyser, and the analyser is a transducer we cannot read — so a word
 * absent from every lexicon may still parse (the `-unknown` entry supplies a default
 * analysis for stems the morphology knows), and a word that looks like a plausible
 * inflection may not parse at all. Which of the two happens differs *per grammar*:
 * the fracas grammar's transducer is closed-vocabulary, ParGram's guesses.
 *
 * So we ask XLE. After a parse, `get_lexical_edges` exposes exactly the three
 * predicates needed (xle/doc/xle.html:4700):
 *
 *   lexentry_found=T, unknown=       a real lexical entry matched
 *   lexentry_found=T, unknown=T      the entry that matched was `-unknown`
 *   a token no morpheme points at    the morphology could not analyse it
 *
 * Letting XLE tokenise and match also disposes of two problems our own lookup had:
 * its matching is case-sensitive where ours lower-cased, and multiword headwords are
 * handled by the tokeniser rather than by guessing at token runs.
 */

/** How a word is covered, worst to best. */
export const VERDICTS = ['unanalyzable', 'no-entry', 'guessed', 'unknown-entry', 'lexicon'];

const EDGE = '@@@E';

/** The Tcl that parses one sentence and dumps its lexical edges. */
export function coverageScript(sentence) {
  const quoted = `"${sentence.replace(/[\\$"[\]]/g, (c) => `\\${c}`)}"`;
  return [
    `parse-sentence ${quoted} $chart`,
    'foreach e [get_lexical_edges $chart] {',
    `  puts "${EDGE}\\t$e\\t[get-label $e]\\t[get_field $e is_surface]\\t` +
      '[get_field $e surface]\\t[get_field $e lexentry_found]\\t[get_field $e unknown]"',
    '}',
  ].join('\n');
}

/**
 * `tractor:58[28,35]`, `VPv[fin]:159:1[8,38]`, `a:50[24,25]??`.
 *
 * An edge id may be followed by a subtree id, so the text is matched lazily: matching
 * it greedily swallows the edge id and reads the subtree id as the edge. The cost is
 * that a token containing a colon followed by digits (`12:30`) would split early,
 * which no grammar's tokeniser has produced here.
 */
export function parseLabel(label) {
  const match = /^(.+?):(\d+)(?::(\d+))?\[(\d+),(\d+)\](\S*)$/.exec(label.trim());
  if (!match) return undefined;
  return { text: match[1], from: Number(match[4]), to: Number(match[5]) };
}

function parseEdges(output) {
  const edges = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith(EDGE)) continue;
    const [, handle, label, isSurface, surface, found, unknown] = line.split('\t');
    const parsed = parseLabel(label ?? '');
    if (!parsed) continue;
    edges.push({
      handle,
      text: parsed.text,
      from: parsed.from,
      to: parsed.to,
      isSurface: isSurface === 'T',
      surface: surface?.trim() || undefined,
      found: found === 'T',
      unknown: unknown === 'T',
    });
  }
  return edges;
}

/** Tags (`+Noun`) and tokeniser artefacts are not words. */
const isTag = (text) => text.startsWith('+');
/** `_,` is a token boundary; `^ kim` is the tokeniser's sentence-initial variant. */
const isArtefact = (text) => /^[_^]/.test(text) || text === 'TB';
/** `a_` is another such variant, but only alongside a plainer one on the same span. */
const isVariant = (text) => text.endsWith('_');

/**
 * How many analyses of one word to report. A tooltip nobody can read is no better
 * than no tooltip, and past the first handful the rest say the same thing.
 */
const MAX_READINGS = 12;

/**
 * The morphological analyses of one token.
 *
 * XLE lays a token's morphemes out as a chart over character positions *inside* the
 * token's own span, and each analysis is a path across it:
 *
 *   train:[21,31]   train[21,25] +Verb[25,27] +Pres[27,29] +Non3sg[29,31]
 *                   train[21,25] +Noun[25,28] +Sg[28,31]
 *
 * Which matters because the stem edge is shared between those two paths, so its
 * `lexentry_found` is a property of the word and not of a reading: `train` is in the
 * verb lexicon, and the flag it earns there is the same flag the noun reading shows.
 * Reporting the paths separately is what lets a reader see which analysis the entry
 * is actually for. Recovering them costs nothing — they are already in the dump.
 *
 * Reported as stem and tags apart, because they are looked up in different places: the
 * stem is a headword the lexicon may have an entry for, the tags are the morphology's.
 * A stem can be several words — a multiword headword such as `take` a` swim` analyses
 * as one — so it is joined rather than assumed to be a single morpheme.
 *
 * Offsets increase strictly along an edge, so the walk terminates.
 */
function readingsOf(under, from, to) {
  const out = [];
  const seen = new Set();

  const walk = (at, path) => {
    if (out.length >= MAX_READINGS) return;
    if (at === to) {
      const text = path.join(' ');
      if (!seen.has(text)) {
        seen.add(text);
        out.push({
          stem: path.filter((m) => !isTag(m)).join(' '),
          tags: path.filter((m) => isTag(m)),
        });
      }
      return;
    }
    for (const edge of under) {
      if (edge.from !== at || edge.to <= at) continue;
      walk(edge.to, [...path, edge.text]);
    }
  };

  walk(from, []);
  return out;
}

/**
 * Classify each token of the sentence.
 *
 * Three things learnt the hard way from running this against both grammars:
 *
 *  - **A tokeniser emits several readings of one span.** ParGram returns `Kim`, `kim`
 *    and `^ kim` all spanning [0,13]. They are one word, so edges are grouped by span
 *    and the group takes its best verdict.
 *  - **Tag morphemes must not count as evidence.** Every tag (`+Noun`) is defined in
 *    the morphology lexicon, so counting them would report every word as covered.
 *    Only stem morphemes decide.
 *  - **A token's own `lexentry_found` is only trustworthy last.** It is how an entry
 *    with morphcode `*` such as `Kim N *` matches — but a grammar with a `-token`
 *    entry, as ParGram has, matches *every* token that way, so it is consulted only
 *    after the stems have had their say.
 *
 * `+Guessed` outranks everything: a grammar whose morphology guesses will happily
 * analyse `xqzzy`, and calling that a lexicon hit would make the whole bar a lie.
 */
export function classify(output) {
  const edges = parseEdges(output);
  const tokens = edges.filter((e) => e.isSurface && !isArtefact(e.text));
  const beneath = edges.filter((e) => e.surface && !isArtefact(e.text));

  const spans = new Map();
  for (const token of tokens) {
    const key = `${token.from}:${token.to}`;
    if (!spans.has(key)) spans.set(key, []);
    spans.get(key).push(token);
  }

  return [...spans.values()]
    .map((group) => {
      const handles = new Set(group.map((t) => t.handle));
      const under = beneath.filter((e) => handles.has(e.surface));
      const stems = under.filter((e) => !isTag(e.text));
      const found = stems.filter((e) => e.found);

      let verdict;
      if (under.some((e) => e.text === '+Guessed')) verdict = 'guessed';
      else if (found.some((e) => !e.unknown)) verdict = 'lexicon';
      else if (found.length > 0) verdict = 'unknown-entry';
      else if (group.some((t) => t.found && !t.unknown)) verdict = 'lexicon';
      else if (stems.length > 0) verdict = 'no-entry';
      else verdict = 'unanalyzable';

      const names = group.map((t) => t.text);
      const plain = names.filter((t) => !isVariant(t));
      return {
        text: (plain.length > 0 ? plain : names)[0],
        variants: [...new Set(names)],
        from: group[0].from,
        to: group[0].to,
        verdict,
        // The stems XLE found, for the tooltip: `saw` reports `see`.
        stems: [...new Set(stems.map((e) => e.text))],
        // Each analysis the morphology offers, for the tooltip.
        readings: readingsOf(under, group[0].from, group[0].to),
      };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
}
