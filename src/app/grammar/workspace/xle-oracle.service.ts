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
  /** Where `npm run xle` listens; overridden in tests. */
  baseUrl = 'http://127.0.0.1:8085';

  status: OracleStatus = 'unchecked';
  health?: OracleHealth;
  /** Why the last call failed, shown next to the fallback notice. */
  error = '';

  private probe?: Promise<OracleStatus>;

  /** Ask once whether the oracle is there; later calls reuse the answer. */
  async check(): Promise<OracleStatus> {
    if (this.probe) return this.probe;
    this.status = 'checking';
    this.probe = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/health`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.health = await response.json();
        // The service runs without XLE too, and then it cannot answer anything.
        this.status = this.health?.xle ? 'ready' : 'absent';
        if (this.status === 'absent') this.error = 'The service is running but XLE was not found.';
      } catch {
        this.status = 'absent';
        this.error = '';
      }
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
      return body.tokens as XleToken[];
    } catch (error) {
      this.error = String((error as Error)?.message ?? error);
      return undefined;
    }
  }
}
