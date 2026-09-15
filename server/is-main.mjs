/**
 * Was this module run directly, or imported?
 *
 * The obvious comparison — `import.meta.url` against `process.argv[1]` — is wrong in a
 * way that only shows up away from the repository. `import.meta.url` is a real path,
 * with every symlink resolved; `process.argv[1]` is whatever was typed. On macOS the
 * temporary directories are `/var/folders/...`, a symlink to `/private/var/folders/...`,
 * so the two never match and a program started from one silently does nothing: the
 * module loads, the guard is false, the process exits 0 having served nobody.
 *
 * Comparing real paths is the fix, and it takes the spaces in "XLE Grammar Explorer"
 * with it — a URL escapes them and a path does not.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
