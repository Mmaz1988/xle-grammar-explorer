import { Injectable } from '@angular/core';

import type { XleToken } from '../lfg/xle-coverage';

/**
 * The local XLE oracle, if one is running.
 *
 * The explorer needs no backend and keeps working without this: the sentence bar
 * falls back to matching headwords itself. So an absent service is a mode, reported
 * to the user, and never an error.
 *
 * `fetch` rather than HttpClient because this is the app's only network call and it
 * should not oblige the rest of the feature to depend on HttpClientModule.
 */

export type OracleStatus = 'unchecked' | 'checking' | 'ready' | 'absent';

export interface OracleHealth {
  xle: string | null;
  command: string | null;
  roots: string[];
}

@Injectable({ providedIn: 'root' })
export class XleOracleService {
  /**
   * Where the oracle listens; overridden in tests.
   *
   * Empty means *this origin*, which is the case when the oracle served the page —
   * `npm run app` is one process for both, and then there is no cross-origin question
   * to answer. Under `ng serve` the page comes from another port, so the fixed address
   * is tried next. Both are attempted, in that order, rather than configured: a build
   * that guessed wrong would fail silently and look like a missing service.
   */
  baseUrl = '';

  private static readonly FALLBACK = 'http://127.0.0.1:8085';

  status: OracleStatus = 'unchecked';
  health?: OracleHealth;
  /** Why the last call failed, shown next to the fallback notice. */
  error = '';
  /**
   * True when a `.lfg.glue` is newer than the `.lfg` compiled from it.
   *
   * XLE only ever loads the `.lfg`, so until LiGER recompiles, the answer describes
   * the grammar as it was — the one staleness reloading the parser cannot fix.
   */
  needsCompile = false;

  private probe?: Promise<OracleStatus>;

  /** Ask once whether the oracle is there; later calls reuse the answer. */
  async check(): Promise<OracleStatus> {
    if (this.probe) return this.probe;
    this.status = 'checking';
    this.probe = (async () => {
      for (const base of [this.baseUrl, XleOracleService.FALLBACK]) {
        try {
          // The service answers this by looking for XLE, which is fast when XLE is
          // healthy and slow when it is wedged. A bounded wait degrades to the
          // headword fallback instead of leaving the bar saying "checking" forever.
          const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(20_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          this.health = await response.json();
          this.baseUrl = base;
          // The service runs without XLE too, and then it cannot answer anything.
          this.status = this.health?.xle ? 'ready' : 'absent';
          if (this.status === 'absent') this.error = 'The service is running but XLE was not found.';
          return this.status;
        } catch {
          /* try the next address */
        }
      }
      this.status = 'absent';
      this.error = '';
      return this.status;
    })();
    return this.probe;
  }

  /** Forget the probe, so a service started after the page loaded is picked up. */
  recheck(): Promise<OracleStatus> {
    this.probe = undefined;
    this.error = '';
    return this.check();
  }

  /**
   * Ask XLE which words of `sentence` the grammar covers.
   *
   * `mainPath` is the grammar's main file as the browser knows it — a name, since the
   * File System Access API never reveals a path. The service resolves it against the
   * roots it was started with, and says so when it cannot.
   */
  async coverage(mainPath: string, sentence: string): Promise<XleToken[] | undefined> {
    if ((await this.check()) !== 'ready') return undefined;
    try {
      const response = await fetch(`${this.baseUrl}/coverage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mainPath, sentence }),
      });
      const body = await response.json();
      if (!response.ok) {
        this.error = body?.error ?? `HTTP ${response.status}`;
        return undefined;
      }
      this.error = '';
      this.needsCompile = body.needsCompile === true;
      return body.tokens as XleToken[];
    } catch (error) {
      this.error = String((error as Error)?.message ?? error);
      return undefined;
    }
  }
}
