/**
 * A warm XLE process, one per grammar.
 *
 * `create-parser` reads the whole grammar and its transducers — 0.4s for the fracas
 * grammar, 2.3s for ParGram — so paying it per lookup would make the sentence bar
 * unusable. The process is kept and fed commands on stdin instead; a lookup after
 * that is milliseconds.
 *
 * Two things are less obvious than they look:
 *
 *  - **XLE sources `xlerc` from its working directory.** This repository's sibling
 *    has one that turns on subtree tracing and shells out to LiGER to compile glue
 *    grammars, which would make every probe slow, noisy and stateful. So the process
 *    runs in an empty scratch directory of our own.
 *  - **Commands and their output are not framed.** XLE writes its banner, lexicon
 *    indexing chatter and any tracing to the same stream, so every reply is bracketed
 *    by a sentinel and everything outside it is discarded.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const READY = '@@@XLE-READY@@@';
const DONE = '@@@XLE-DONE@@@';

/** Quote a string for Tcl. Only used on text that reaches XLE as a sentence. */
export function tclQuote(text) {
  return `"${text.replace(/[\\$"[\]]/g, (c) => `\\${c}`)}"`;
}

export class XleSession {
  #child;
  #buffer = '';
  #pending = [];
  #failed;

  constructor(xle, grammarPath, { onExit } = {}) {
    this.grammarPath = grammarPath;
    this.lastUsed = Date.now();

    // An empty directory, so no stray xlerc is picked up.
    const cwd = mkdtempSync(join(tmpdir(), 'xle-explorer-'));
    this.#child = spawn(xle.command, [...xle.args, '-noTk'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#absorb(chunk));
    this.#child.on('exit', (code) => {
      this.#failed = new Error(`XLE exited (${code})`);
      for (const { reject } of this.#pending.splice(0)) reject(this.#failed);
      onExit?.();
    });

    this.ready = this.#send(
      `set chart [create-parser ${tclQuote(xle.mapPath(grammarPath))}]`,
    );
  }

  #absorb(chunk) {
    this.#buffer += chunk;
    let at;
    while ((at = this.#buffer.indexOf(DONE)) !== -1) {
      const reply = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + DONE.length);
      const waiter = this.#pending.shift();
      if (!waiter) continue;
      const start = reply.indexOf(READY);
      waiter.resolve(start === -1 ? reply : reply.slice(start + READY.length));
    }
  }

  #send(script) {
    if (this.#failed) return Promise.reject(this.#failed);
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#child.stdin.write(`puts ${tclQuote(READY)}\n${script}\nputs ${tclQuote(DONE)}\n`);
    });
  }

  /** Run a script against the loaded grammar, returning only its own output. */
  async run(script) {
    await this.ready;
    return this.#send(script);
  }

  close() {
    try {
      this.#child.stdin.end('exit\n');
    } catch {
      /* already gone */
    }
    this.#child.kill();
  }
}

/** Keeps one session per grammar, retiring those nobody has used in a while. */
export class XleSessionPool {
  #sessions = new Map();

  constructor(xle, { idleMs = 10 * 60 * 1000, max = 4 } = {}) {
    this.xle = xle;
    this.idleMs = idleMs;
    this.max = max;
  }

  /**
   * The session for a grammar, rebuilt when `stamp` shows the files changed.
   *
   * Reloading is just dropping the process: `create-parser` costs a couple of seconds
   * at worst, and it happens only on the first lookup after an edit.
   */
  get(grammarPath, stamp = 0) {
    this.#retireIdle();
    let session = this.#sessions.get(grammarPath);
    if (session && stamp && session.stamp !== stamp) {
      session.close();
      this.#sessions.delete(grammarPath);
      session = undefined;
    }
    if (!session) {
      if (this.#sessions.size >= this.max) this.#retireOldest();
      session = new XleSession(this.xle, grammarPath, {
        onExit: () => this.#sessions.delete(grammarPath),
      });
      session.stamp = stamp;
      this.#sessions.set(grammarPath, session);
    }
    return session;
  }

  #retireIdle() {
    const cutoff = Date.now() - this.idleMs;
    for (const [path, session] of this.#sessions) {
      if (session.lastUsed < cutoff) {
        session.close();
        this.#sessions.delete(path);
      }
    }
  }

  #retireOldest() {
    let oldest;
    for (const [path, session] of this.#sessions) {
      if (!oldest || session.lastUsed < oldest[1].lastUsed) oldest = [path, session];
    }
    if (oldest) {
      oldest[1].close();
      this.#sessions.delete(oldest[0]);
    }
  }

  closeAll() {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }
}
