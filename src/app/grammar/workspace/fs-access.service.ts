/**
 * Reading and writing grammar files straight from the user's disk, via the
 * File System Access API.
 *
 * There is no server in this app on purpose. Nothing in the xleplusglue backend can
 * write a file — LiGER exposes `/list_grammars1`, `/change_grammar` and `/load_rules`,
 * all read-only — so a server-backed editor would have meant adding a Java endpoint
 * and rebuilding `jars/liger.jar`. The browser writes directly instead.
 *
 * The cost is that this is Chrome/Edge only: Firefox and Safari do not implement
 * `showDirectoryPicker`. {@link isSupported} exists so the UI can say so plainly
 * rather than failing at the moment the user clicks.
 */

import { Injectable } from '@angular/core';
import type { GrammarSource } from './grammar-index';

/** Extensions we treat as grammar source. */
const GRAMMAR_EXTENSIONS = ['.lfg', '.lfg.glue'];

/**
 * XLE writes a cache directory next to a grammar whose entries use `!` as a path
 * separator (`macosx!rules!verb_fracas_grammar.lfg`). It is build output, never source.
 */
const IGNORED_DIR_SUFFIX = '.fileindexdir';

export interface PickedGrammar {
  name: string;
  source: GrammarSource;
  /** Absent when a single file was opened directly rather than a folder. */
  handle?: FileSystemDirectoryHandle;
  /** True when only one file was opened, so `FILES` includes cannot be resolved. */
  singleFile?: boolean;
}

@Injectable({ providedIn: 'root' })
export class FsAccessService {
  private handles = new Map<string, FileSystemFileHandle>();
  private root?: FileSystemDirectoryHandle;

  /** Whether this browser can pick a directory at all. */
  static isSupported(): boolean {
    return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  }

  /**
   * Ask the user for a grammar directory.
   *
   * Must be called from a user gesture — the browser refuses otherwise, which is also
   * why this app cannot silently re-open a folder on load.
   */
  async pickDirectory(): Promise<PickedGrammar | undefined> {
    if (!FsAccessService.isSupported()) {
      throw new Error(
        'This browser cannot open a local folder. The File System Access API is available in Chrome and Edge.',
      );
    }
    const picker = (globalThis as unknown as {
      showDirectoryPicker(o?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;

    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker({ mode: 'readwrite' });
    } catch (err) {
      // The user dismissing the picker is a normal outcome, not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') return undefined;
      throw err;
    }
    return this.useDirectory(handle);
  }

  /**
   * Ask the user for a single grammar file.
   *
   * A file handle carries no access to its parent directory, so a multi-file grammar
   * opened this way cannot resolve its own `FILES` list. That is surfaced rather than
   * hidden: the resulting grammar is marked `partial`, and the UI offers to open the
   * containing folder instead. A self-contained grammar (`FILES .`) works fully,
   * including save.
   */
  async pickFile(): Promise<PickedGrammar | undefined> {
    if (!FsAccessService.isSupported()) {
      throw new Error(
        'This browser cannot open a local file this way. The File System Access API is available in Chrome and Edge.',
      );
    }
    const picker = (globalThis as unknown as {
      showOpenFilePicker(o?: unknown): Promise<FileSystemFileHandle[]>;
    }).showOpenFilePicker;

    let handles: FileSystemFileHandle[];
    try {
      handles = await picker({
        multiple: false,
        types: [{ description: 'XLE grammar', accept: { 'text/plain': ['.lfg', '.glue'] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return undefined;
      throw err;
    }
    const handle = handles[0];
    if (!handle) return undefined;

    this.root = undefined;
    this.handles.clear();
    this.handles.set(handle.name, handle);
    return {
      name: handle.name,
      singleFile: true,
      source: {
        listFiles: async () => [handle.name],
        readFile: (path) => this.readFile(path),
      },
    };
  }

  /** Adopt an already-granted directory handle (e.g. one restored from IndexedDB). */
  async useDirectory(handle: FileSystemDirectoryHandle): Promise<PickedGrammar> {
    this.root = handle;
    this.handles.clear();
    return {
      name: handle.name,
      handle,
      source: {
        listFiles: () => this.listFiles(),
        readFile: (path) => this.readFile(path),
      },
    };
  }

  /** Every grammar file under the picked directory, as paths relative to it. */
  async listFiles(): Promise<string[]> {
    if (!this.root) return [];
    const out: string[] = [];
    await this.walk(this.root, '', out);
    return out.sort();
  }

  private async walk(dir: FileSystemDirectoryHandle, prefix: string, out: string[]): Promise<void> {
    for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.kind === 'directory') {
        if (name.endsWith(IGNORED_DIR_SUFFIX)) continue;
        await this.walk(entry as FileSystemDirectoryHandle, path, out);
      } else if (GRAMMAR_EXTENSIONS.some((ext) => name.endsWith(ext))) {
        out.push(path);
        this.handles.set(path, entry as FileSystemFileHandle);
      }
    }
  }

  async readFile(path: string): Promise<string> {
    const handle = await this.handleFor(path);
    const file = await handle.getFile();
    return file.text();
  }

  /**
   * Overwrite a file with `text`.
   *
   * `createWritable` truncates on open, so a short write cannot leave a tail of the
   * previous contents behind. The write is only visible once `close()` resolves.
   */
  async writeFile(path: string, text: string): Promise<void> {
    const handle = await this.handleFor(path);
    const permission = await (handle as unknown as {
      queryPermission(d: { mode: string }): Promise<PermissionState>;
    }).queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      const granted = await (handle as unknown as {
        requestPermission(d: { mode: string }): Promise<PermissionState>;
      }).requestPermission({ mode: 'readwrite' });
      if (granted !== 'granted') {
        throw new Error(`Write permission was not granted for ${path}.`);
      }
    }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  /**
   * Create a file and write `contents`.
   *
   * Intermediate directories are created too, so `rules/adverb.lfg.glue` works in a
   * grammar that has no `rules/` yet. Refuses to overwrite: creation must never be a
   * silent destructive act, and the caller checks existence first anyway.
   */
  async createFile(path: string, contents: string): Promise<void> {
    if (!this.root) throw new Error('No grammar directory has been opened.');
    if (await this.exists(path)) {
      throw new Error(`${path} already exists.`);
    }
    const parts = path.split('/');
    let dir = this.root;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    this.handles.set(path, handle);
  }

  /** Whether `path` is already present. */
  async exists(path: string): Promise<boolean> {
    if (!this.root) return false;
    try {
      await this.resolveHandle(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a file. There is no undo; callers confirm first. */
  async deleteFile(path: string): Promise<void> {
    if (!this.root) throw new Error('No grammar directory has been opened.');
    const parts = path.split('/');
    let dir = this.root;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part);
    }
    await dir.removeEntry(parts[parts.length - 1]);
    this.handles.delete(path);
  }

  /**
   * Rename a file.
   *
   * The File System Access API has no rename, so this copies the contents to the new
   * path and deletes the old one. The copy is written first: a failure then leaves the
   * original in place, where a delete-first order would lose it.
   */
  async renameFile(from: string, to: string): Promise<void> {
    const contents = await this.readFile(from);
    await this.createFile(to, contents);
    await this.deleteFile(from);
  }

  private async handleFor(path: string): Promise<FileSystemFileHandle> {
    const cached = this.handles.get(path);
    if (cached) return cached;
    const handle = await this.resolveHandle(path);
    this.handles.set(path, handle);
    return handle;
  }

  /** Walk the directory tree to `path`, without consulting the cache. */
  private async resolveHandle(path: string): Promise<FileSystemFileHandle> {
    if (!this.root) throw new Error('No grammar directory has been opened.');
    const parts = path.split('/');
    let dir = this.root;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part);
    }
    return dir.getFileHandle(parts[parts.length - 1]);
  }
}
