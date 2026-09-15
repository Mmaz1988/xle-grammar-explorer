/**
 * The few things this program has to ask the operating system directly.
 *
 * Everything else here is Node builtins and runs anywhere. These four are not: where a
 * program keeps a setting, how it puts a folder chooser on screen, how it says
 * something when there is no terminal, and where a browser is installed. Each is a
 * different command on each system and none has a portable form.
 *
 * Kept together so that adding a system means adding cases here rather than forking
 * the program. The rest of the server does not know which system it is on.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Join with the separator the *named* system uses, not the one running this.
 *
 * `path.join` builds paths for the host, so asking a Mac where Windows keeps its
 * settings gives a path with the wrong slashes in it — right in production, wrong
 * everywhere it can be checked.
 */
const joinFor = (platform) => (platform === 'win32' ? win32.join : posix.join);

/**
 * Where this program's own state belongs, by each system's convention.
 *
 * The only state it has is which folder the grammars are in, and that has to outlive
 * a run — a packaged copy is told once and should not ask again.
 */
export function configDir(env = process.env, platform = process.platform) {
  const join = joinFor(platform);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'XLE Grammar Explorer');
  }
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'XLE Grammar Explorer');
  }
  // Linux and the rest: the XDG basedir spec, whose default is ~/.config.
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'xle-grammar-explorer');
}

/** A directory the person picked, or undefined if they did not pick one. */
export function chooseFolder(prompt, platform = process.platform, run = execFileSync) {
  try {
    if (platform === 'darwin') {
      const picked = run('/usr/bin/osascript', [
        '-e', `POSIX path of (choose folder with prompt "${prompt}")`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return clean(picked);
    }

    if (platform === 'win32') {
      // Windows has no folder chooser to shell out to, so PowerShell borrows the one
      // in .NET. `-STA` because the dialog is a COM control and will not open without.
      const script =
        'Add-Type -AssemblyName System.Windows.Forms;' +
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;' +
        `$d.Description = '${prompt.replace(/'/g, "''")}';` +
        'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }';
      const picked = run('powershell', ['-NoProfile', '-STA', '-Command', script],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return clean(picked);
    }

    // Linux: whichever of the two desktop toolkits is installed. Neither is certain,
    // which is why the page treats an unanswered question as an ordinary outcome.
    for (const [command, args] of [
      ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]],
      ['kdialog', ['--getexistingdirectory', env_home()]],
    ]) {
      try {
        return clean(run(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch {
        /* not installed, or cancelled; try the other */
      }
    }
    return undefined;
  } catch {
    return undefined;  // Cancelled, or nothing here can ask.
  }
}

const env_home = () => process.env.HOME || homedir();

/** Trim what a chooser printed, and treat an empty answer as no answer. */
function clean(output) {
  const picked = String(output ?? '').trim().replace(/[/\\]$/, '');
  return picked === '' ? undefined : picked;
}

/**
 * Say something when there may be no terminal to say it in.
 *
 * Best-effort by design: a machine with no way to show a dialog is not a machine to
 * fail on, so this never throws and the caller carries on.
 */
export function notify(message, platform = process.platform, run = execFileSync) {
  const quiet = { stdio: 'ignore' };
  try {
    if (platform === 'darwin') {
      run('/usr/bin/osascript', ['-e',
        `display alert "XLE Grammar Explorer" message "${message.replace(/"/g, "'")}"`], quiet);
    } else if (platform === 'win32') {
      run('powershell', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms;' +
        `[System.Windows.Forms.MessageBox]::Show('${message.replace(/'/g, "''")}',` +
        " 'XLE Grammar Explorer')"], quiet);
    } else {
      run('zenity', ['--error', `--text=${message}`], quiet);
    }
  } catch {
    /* No way to say it here; the caller has already written it wherever it can. */
  }
}
