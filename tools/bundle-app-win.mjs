/**
 * Package the explorer as a folder a Windows machine can run after downloading it.
 *
 * Deliberately a folder rather than an installer. What travels is the built page and
 * the server, which import nothing but Node builtins — so there is nothing to install,
 * and an installer would add a signing problem and a trust prompt to a thing that
 * works by being unzipped.
 *
 * `XLE Grammar Explorer.cmd` is the entry point: double-clicking a .cmd opens a console
 * window and runs in it, which is the visible, interruptible process the Mac build has
 * to open Terminal by hand to get.
 *
 * What does not travel: Node, a Chromium browser, and XLE — each checked for and
 * reported rather than assumed. On Windows XLE is expected under WSL, which is how
 * LiGER runs it; `xle-locate.mjs` translates paths across that boundary.
 *
 *   npm run app:bundle:win
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../server/is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'XLE Grammar Explorer';

/**
 * A script that puts a shortcut on the desktop, so the icon is reachable.
 *
 * A .cmd file cannot carry an icon — only a shortcut to it can — and a shortcut holds
 * an absolute path, so one made here would point at wherever it was built. It has to
 * be made on the machine that will use it, which is what this is for. Optional: the
 * .cmd runs perfectly well double-clicked.
 */
function shortcutScript(name = NAME) {
  return `@echo off
rem Puts "${name}" on your desktop, with its icon. Optional - the .cmd beside this
rem one runs the explorer whether or not you ever use this.
setlocal
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\${name}.lnk');" ^
  "$s.TargetPath = '%~dp0${name}.cmd';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = '%~dp0app\\AppIcon.ico';" ^
  "$s.Description = 'Explore and edit XLE grammars';" ^
  "$s.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo Put "${name}" on your desktop.
)
pause
`;
}

/** Assemble the folder at `into`, from a repository at `from`. */
export function bundleWindowsApp(from, into, name = NAME) {
  const app = join(into, name);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, 'app'), { recursive: true });

  // The same runner the repository uses; it works out which it is by looking for the
  // code beside it, exactly as the Mac one does.
  cpSync(join(from, `${name}.cmd`), join(app, `${name}.cmd`));
  writeFileSync(join(app, 'Create Desktop Shortcut.cmd'), shortcutScript(name));
  cpSync(join(from, 'assets', 'AppIcon.ico'), join(app, 'app', 'AppIcon.ico'));

  // `index.mjs` looks for the page at ../dist from the server directory, so server and
  // dist sit side by side under app/ — the layout it already expects.
  cpSync(join(from, 'server'), join(app, 'app', 'server'), {
    recursive: true,
    filter: (path) => !path.endsWith('.test.mjs') && !path.includes('fixtures'),
  });
  cpSync(join(from, 'dist'), join(app, 'app', 'dist'), { recursive: true });
  return app;
}

if (isMain(import.meta.url)) {
  if (!existsSync(join(root, 'dist'))) {
    console.error('Build the app first:  npm run build');
    process.exit(1);
  }
  if (!existsSync(join(root, 'assets', 'AppIcon.ico'))) {
    console.error('Build the icon first:  node tools/make-ico.mjs');
    process.exit(1);
  }
  const into = join(root, 'dist-app-win');
  mkdirSync(into, { recursive: true });
  const app = bundleWindowsApp(root, into);
  console.log(`Packaged ${app}`);
  console.log('Copy the folder anywhere and double-click the .cmd inside it. It needs');
  console.log('Node.js and a Chromium browser on the PC, and XLE under WSL for the');
  console.log('sentence bar.');
}
