/**
 * Finding XLE.
 *
 * XLE is a native binary, so "where is it" is really "how do I invoke it here":
 * directly on Linux and macOS, and through `wsl` on Windows, where the binary lives
 * inside the Linux filesystem and every path we hand it has to be translated.
 * That is the same split LiGER makes in `XLEStarter`, for the same reason.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where XLE is usually installed, for when PATH does not say.
 *
 * An app started from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else, so a shell that finds `xle` perfectly well is no guide to what the launcher
 * will find. Without this, double-clicking on a machine that *has* XLE reports it
 * missing — a worse failure than not having it, because nothing looks wrong.
 */
const USUAL_PLACES = [
  '/Applications/xle',
  '/usr/local/xle',
  '/opt/xle',
  '/opt/homebrew/xle',
];

/** `C:\grammars\x.lfg` → `/mnt/c/grammars/x.lfg`, as LiGER's formatWslString does. */
export function toWslPath(path) {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!drive) return path.replace(/\\/g, '/');
  return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
}

function canRun(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * How to run XLE here, or `undefined` when it is not installed.
 *
 * Returned rather than thrown: the explorer works without XLE, just with a weaker
 * answer, so a missing binary is a mode and not an error.
 */
export function locateXle(env = process.env, probe = {}) {
  // `canRun` spawns with the real process environment whatever `env` says, so the
  // search cannot be exercised by handing it a doctored PATH. The seam is for tests;
  // nothing else passes it.
  const run = probe.canRun ?? canRun;
  const exists = probe.exists ?? existsSync;

  const explicit = env.XLE_COMMAND;
  if (explicit) {
    return { command: explicit, args: [], mode: 'explicit', mapPath: (p) => p };
  }

  // XLEPATH is what XLE itself uses; honour it, then PATH, then the usual places.
  const fromEnv = env.XLEPATH ? join(env.XLEPATH, 'xle') : undefined;
  const home = env.HOME || homedir();
  const installed = [...USUAL_PLACES, join(home, 'xle')]
    .map((dir) => join(dir, 'xle'))
    .filter((path) => exists(path));

  for (const candidate of [fromEnv, 'xle', ...installed].filter(Boolean)) {
    if (run(candidate, ['-noTk', '-e', 'exit'])) {
      return { command: candidate, args: [], mode: 'native', mapPath: (p) => p };
    }
  }

  if (process.platform === 'win32' && run('wsl', ['xle', '-noTk', '-e', 'exit'])) {
    return { command: 'wsl', args: ['xle'], mode: 'wsl', mapPath: toWslPath };
  }

  return undefined;
}
