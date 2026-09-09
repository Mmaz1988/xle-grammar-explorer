/**
 * Arranging open files into resizable panes.
 *
 * Both layouts are the same structure — a row of columns, each column a stack of panes
 * — which means one divider implementation serves both and the sizes survive a layout
 * switch. `rows` is a single column; `grid` spreads panes over roughly square columns.
 */

import type { Span } from '../lfg/lfg-model';

export type PaneLayout = 'rows' | 'grid';

export interface EditorPane {
  id: number;
  path: string;
  /** Current text, which may differ from what is on disk. */
  content: string;
  /** Text as last read or written, for the dirty check. */
  saved: string;
  dirty: boolean;
  reveal?: Span;
}

/** Column counts per layout, given `n` open panes. */
export function columnCount(layout: PaneLayout, n: number): number {
  if (layout === 'rows' || n <= 1) return 1;
  return Math.ceil(Math.sqrt(n));
}

/**
 * Distribute panes over columns, filling column by column.
 *
 * Column-major keeps a pane in place when another is added after it, which matters
 * because panes move under the pointer otherwise.
 */
export function toColumns<T>(items: T[], columns: number): T[][] {
  if (items.length === 0) return [];
  const cols = Math.max(1, Math.min(columns, items.length));
  const perColumn = Math.ceil(items.length / cols);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perColumn) {
    out.push(items.slice(i, i + perColumn));
  }
  return out;
}

/** Even fractions summing to 1. */
export function evenSizes(n: number): number[] {
  return n <= 0 ? [] : Array.from({ length: n }, () => 1 / n);
}

/**
 * Grow or shrink a size array to `n` entries, keeping existing proportions.
 *
 * Resizing to even fractions on every open or close would throw away deliberate
 * adjustments, so existing tracks keep their relative sizes and any new one takes an
 * even share.
 */
export function fitSizes(sizes: number[], n: number): number[] {
  if (n <= 0) return [];
  if (sizes.length === n) return sizes;
  if (sizes.length === 0) return evenSizes(n);
  const kept = sizes.slice(0, n);
  while (kept.length < n) kept.push(1 / n);
  const total = kept.reduce((a, b) => a + b, 0);
  return total > 0 ? kept.map((s) => s / total) : evenSizes(n);
}

/** Minimum fraction a track may be dragged to, so a pane never vanishes. */
const MIN_FRACTION = 0.08;

/**
 * Move the boundary between tracks `i` and `i+1` to `position` (0..1 across the whole
 * axis), returning new sizes. Only the two adjacent tracks change.
 */
export function resizeTrack(sizes: number[], i: number, position: number): number[] {
  if (i < 0 || i + 1 >= sizes.length) return sizes;
  const before = sizes.slice(0, i).reduce((a, b) => a + b, 0);
  const pair = sizes[i] + sizes[i + 1];
  const first = Math.min(Math.max(position - before, MIN_FRACTION), pair - MIN_FRACTION);
  const out = sizes.slice();
  out[i] = first;
  out[i + 1] = pair - first;
  return out;
}
