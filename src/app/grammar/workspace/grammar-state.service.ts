/**
 * Session state for the grammar view.
 *
 * Follows the convention used by the xleplusglue client's
 * `AnalysisWorkspaceStateService`: a plain root-provided service holding a typed
 * object, deep-cloned on the way in and out so callers can never alias the store.
 * Components restore in `ngOnInit` and save in `ngOnDestroy`.
 *
 * Deliberately not persisted anywhere. A directory handle cannot be meaningfully
 * restored without a fresh user gesture, so remembering which entry was open across a
 * reload would promise more than the browser can deliver.
 */

import { Injectable } from '@angular/core';

export interface GrammarWorkspaceState {
  filter: string;
  openPath?: string;
  openLine?: number;
  splitFraction: number;
}

const DEFAULTS: GrammarWorkspaceState = {
  filter: '',
  splitFraction: 0.34,
};

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

@Injectable({ providedIn: 'root' })
export class GrammarStateService {
  private state: GrammarWorkspaceState = clone(DEFAULTS);

  get(): GrammarWorkspaceState {
    return clone(this.state);
  }

  save(state: Partial<GrammarWorkspaceState>): void {
    this.state = clone({ ...this.state, ...state });
  }

  clear(): void {
    this.state = clone(DEFAULTS);
  }
}
