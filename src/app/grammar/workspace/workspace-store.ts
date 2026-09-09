/**
 * Remembering the workspace across a reload.
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so IndexedDB can store the
 * handle itself — `localStorage` cannot, since it only holds strings. That is the whole
 * reason this uses IndexedDB rather than something simpler.
 *
 * The browser still decides whether the stored handle is usable. Permission is not
 * persisted with it: after a reload the handle usually comes back needing a fresh
 * grant, and asking for one requires a user gesture. So restoring is offered as a
 * button rather than done silently, unless permission happens to have survived.
 */

import { Injectable } from '@angular/core';

const DB_NAME = 'xle-grammar-explorer';
const DB_VERSION = 1;
const STORE = 'workspace';
const HANDLE_KEY = 'directory';
const SESSION_KEY = 'session';

/** Everything about where the user was, other than the directory itself. */
export interface StoredSession {
  /** Name of the directory, so it can be offered by name before it is reopened. */
  directoryName: string;
  /** `GrammarUnit.id` of the grammar that was selected. */
  grammarId?: string;
  filter: string;
  layout: 'rows' | 'grid';
  splitFraction: number;
  /** Files that were open, in pane order, with the range each was showing. */
  panes: Array<{ path: string; start: number; end: number; line: number }>;
  activePaneIndex: number;
  /** Ids of the expanded tree nodes. */
  expanded: string[];
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    // Private windows and blocked site data both land here. Losing the session is a
    // nuisance, never a failure worth interrupting the user for.
    return undefined;
  }
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  async saveDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
    await withStore('readwrite', (store) => store.put(handle, HANDLE_KEY));
  }

  async loadDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
    return withStore<FileSystemDirectoryHandle>('readonly', (store) => store.get(HANDLE_KEY));
  }

  async saveSession(session: StoredSession): Promise<void> {
    await withStore('readwrite', (store) => store.put(session, SESSION_KEY));
  }

  async loadSession(): Promise<StoredSession | undefined> {
    return withStore<StoredSession>('readonly', (store) => store.get(SESSION_KEY));
  }

  async clear(): Promise<void> {
    await withStore('readwrite', (store) => store.clear());
  }

  /**
   * Whether `handle` can be read without prompting.
   *
   * `queryPermission` reports the current state without asking; `requestPermission`
   * asks, and must be called from a user gesture.
   */
  async hasPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const query = (handle as unknown as {
      queryPermission?(d: { mode: string }): Promise<PermissionState>;
    }).queryPermission;
    if (!query) return false;
    try {
      return (await query.call(handle, { mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  /** Ask for access to `handle`. Must be called from a user gesture. */
  async requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const request = (handle as unknown as {
      requestPermission?(d: { mode: string }): Promise<PermissionState>;
    }).requestPermission;
    if (!request) return false;
    try {
      return (await request.call(handle, { mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }
}
