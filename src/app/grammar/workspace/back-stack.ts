/**
 * Remembering where a jump started, so Back returns there.
 *
 * A character offset alone is not enough. Following `@TEMPLATE` to its definition is
 * usually the prelude to editing something, and any edit above the remembered offset
 * moves it — so Back would land a few lines off, which is worse than not offering it,
 * because it looks like it worked.
 *
 * The fix is to remember *what* was there rather than only where. On the way back the
 * file is checked, and if it has changed the anchor text is found again, nearest to
 * where it used to be. That is the "as long as nothing has changed" guarantee, made
 * good even when something has.
 */

export interface BackMark {
  path: string;
  line: number;
  span: { start: number; end: number };
  /** The text that was at `span`, used to find the spot again after an edit. */
  anchor: string;
  /** Cheap identity of the file as it was; a mismatch means offsets may have moved. */
  stamp: number;
}

/** How much text to remember. Enough to be distinctive, not enough to be brittle. */
const ANCHOR_LENGTH = 60;

/**
 * A cheap content fingerprint (FNV-1a).
 *
 * Only ever compared for equality against another stamp of the same file, so collision
 * resistance is not the point — noticing that an edit happened is.
 */
export function stampOf(content: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The line a character offset falls on, counting from 1. */
export function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Remember the current spot, with enough text to find it again. */
export function markFor(
  path: string,
  content: string,
  span: { start: number; end: number } | undefined,
  line: number,
): BackMark {
  const start = span?.start ?? offsetOfLine(content, line);
  const end = Math.min(span?.end ?? content.length, start + ANCHOR_LENGTH);
  return {
    path,
    line,
    span: span ? { ...span } : { start, end: start },
    anchor: content.slice(start, end).trim(),
    stamp: stampOf(content),
  };
}

function offsetOfLine(content: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = content.indexOf('\n', at);
    if (next === -1) return at;
    at = next + 1;
  }
  return at;
}

export interface Relocation {
  span: { start: number; end: number };
  line: number;
  /** `exact` when the file is untouched, `moved` when the anchor was found elsewhere. */
  how: 'exact' | 'moved' | 'lost';
}

/**
 * Where `mark` points now.
 *
 * When the anchor occurs several times — one template call among many identical ones —
 * the occurrence nearest the original offset wins, since an edit is far more likely to
 * have shifted the spot a little than to have moved it past a twin.
 */
export function relocate(content: string, mark: BackMark): Relocation {
  if (stampOf(content) === mark.stamp) {
    return { span: { ...mark.span }, line: mark.line, how: 'exact' };
  }
  if (mark.anchor) {
    const at = nearestOccurrence(content, mark.anchor, mark.span.start);
    if (at !== -1) {
      const span = { start: at, end: at + mark.anchor.length };
      return { span, line: lineAt(content, at), how: 'moved' };
    }
  }
  // The text is gone — deleted, or edited past recognition. Offer the file and say so
  // rather than scrolling to an offset that now means nothing.
  const line = Math.min(mark.line, lineAt(content, content.length));
  return { span: { start: 0, end: 0 }, line, how: 'lost' };
}

function nearestOccurrence(content: string, needle: string, near: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + 1)) {
    const distance = Math.abs(at - near);
    if (distance < bestDistance) {
      best = at;
      bestDistance = distance;
    }
  }
  return best;
}
