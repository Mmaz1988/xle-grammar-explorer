/**
 * Finding XLE.
 *
 * XLE is a native binary, so "where is it" is really "how do I invoke it here":
 * directly on Linux and macOS, and through `wsl` on Windows, where the binary lives
 * inside the Linux filesystem and every path we hand it has to be translated.
 * That is the same split LiGER makes in `XLEStarter`, for the same reason.
 */

import { execFileSync } from 'node:child_process';

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
export function locateXle(env = process.env) {
  const explicit = env.XLE_COMMAND;
  if (explicit) {
    return { command: explicit, args: [], mode: 'explicit', mapPath: (p) => p };
  }

  // XLEPATH is what XLE itself uses; honour it before falling back to PATH.
  const fromEnv = env.XLEPATH ? `${env.XLEPATH}/xle` : undefined;
  for (const candidate of [fromEnv, 'xle'].filter(Boolean)) {
    if (canRun(candidate, ['-noTk', '-e', 'exit'])) {
      return { command: candidate, args: [], mode: 'native', mapPath: (p) => p };
    }
  }

  if (process.platform === 'win32' && canRun('wsl', ['xle', '-noTk', '-e', 'exit'])) {
    return { command: 'wsl', args: ['xle'], mode: 'wsl', mapPath: toWslPath };
  }

  return undefined;
}
