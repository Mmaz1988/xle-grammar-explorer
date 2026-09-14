/**
 * Start the explorer: serve it, find a browser that can run it, open it.
 *
 * Three things have to hold, and each fails in its own way, so each is checked and
 * reported separately rather than collapsed into "it did not work":
 *
 *  - **The app has to be built.** It is a static bundle; there is nothing to serve
 *    before `ng build` has run.
 *  - **The browser has to be Chrome or Edge.** Not a preference: the explorer reads
 *    and writes grammar files through the File System Access API, which Firefox and
 *    Safari do not implement. Opening the default browser would show a page that
 *    cannot open a folder, which is a worse failure than refusing.
 *  - **XLE is optional.** Without it the sentence bar falls back to matching headwords
 *    and says so in the page, so a missing XLE is reported and then carried on from.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

/**
 * Browsers that implement the File System Access API, per platform.
 *
 * macOS is asked through `mdfind`, which finds an app wherever it was installed, and
 * falls back to the standard locations when Spotlight is off. Windows takes the usual
 * install paths; Linux takes whatever is on PATH.
 */
const BROWSERS = {
  darwin: [
    { name: 'Google Chrome', bundle: 'com.google.Chrome', path: '/Applications/Google Chrome.app' },
    { name: 'Microsoft Edge', bundle: 'com.microsoft.edgemac', path: '/Applications/Microsoft Edge.app' },
    { name: 'Chromium', bundle: 'org.chromium.Chromium', path: '/Applications/Chromium.app' },
    { name: 'Brave Browser', bundle: 'com.brave.Browser', path: '/Applications/Brave Browser.app' },
  ],
  win32: [
    { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Chrome', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  ],
  linux: [
    { name: 'google-chrome', command: 'google-chrome' },
    { name: 'chromium', command: 'chromium' },
    { name: 'chromium-browser', command: 'chromium-browser' },
    { name: 'microsoft-edge', command: 'microsoft-edge' },
  ],
};

const onPath = (command) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const installedOnMac = (bundle) => {
  try {
    return execFileSync('mdfind', [`kMDItemCFBundleIdentifier == ${bundle}`], {
      encoding: 'utf8', timeout: 4000,
    }).trim().split('\n').filter(Boolean)[0];
  } catch {
    return undefined;
  }
};

/** The first browser found that can run the app, or undefined. */
export function findBrowser(platform = process.platform, probe = {}) {
  const exists = probe.exists ?? existsSync;
  const has = probe.onPath ?? onPath;
  const spotlight = probe.spotlight ?? installedOnMac;

  for (const candidate of BROWSERS[platform] ?? []) {
    if (candidate.command && has(candidate.command)) return { ...candidate, found: candidate.command };
    if (platform === 'darwin') {
      const viaSpotlight = spotlight(candidate.bundle);
      if (viaSpotlight) return { ...candidate, found: viaSpotlight };
    }
    if (candidate.path && exists(candidate.path)) return { ...candidate, found: candidate.path };
  }
  return undefined;
}

/** How to launch a browser at a URL, as command and arguments. */
export function openCommand(browser, url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: ['-a', browser.found, url] };
  if (platform === 'win32') return { command: browser.found, args: [url] };
  return { command: browser.found, args: [url] };
}

/** Whether something is already listening there. */
export function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error) => resolve(error.code === 'EADDRINUSE'));
    probe.listen(port, host, () => probe.close(() => resolve(false)));
  });
}

/**
 * Whether the thing already on that port is us.
 *
 * Worth asking before giving up or moving: a second launch should join the running
 * explorer rather than start a rival on another port, and something else entirely on
 * 8085 should not be mistaken for it.
 */
export async function oracleAt(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Object.hasOwn(body, 'xle') && Object.hasOwn(body, 'roots');
  } catch {
    return false;
  }
}

const say = (line) => process.stdout.write(line + '\n');
const fail = (line) => process.stderr.write(line + '\n');

export async function main() {
  // Read before the server module is loaded, which is where it is acted on. The
  // standalone `npm run xle` must not inherit this: its pages come from `ng serve` and
  // never check in, and exiting on that silence would kill a service in use.
  process.env.XLE_EXIT_WHEN_IDLE = '1';
  const { start, status, url } = await import('./index.mjs');
  const { xle, bundle, port } = status();

  if (!bundle) {
    fail('The app has not been built yet.');
    fail('');
    fail('  npm install && npm run build');
    fail('');
    fail('Then start this again.');
    return 1;
  }

  const browser = findBrowser();
  if (!browser) {
    fail('No browser here can run the explorer.');
    fail('');
    fail('It reads and writes your grammar files through the File System Access API,');
    fail('which only Chromium-based browsers implement. Install one of:');
    fail('');
    fail('  Google Chrome, Microsoft Edge, Chromium, or Brave');
    fail('');
    fail('Firefox and Safari will load the page but cannot open a folder.');
    return 1;
  }

  if (await portInUse(port)) {
    if (await oracleAt(port)) {
      say(`The explorer is already running on ${url()} — opening it.`);
      const { command, args } = openCommand(browser, url());
      spawn(command, args, { stdio: 'ignore', detached: true }).unref();
      return 0;
    }
    fail(`Port ${port} is taken by something that is not the explorer.`);
    fail('');
    fail('Free it, or put the explorer somewhere else:');
    fail('');
    fail('  XLE_SERVICE_PORT=8090 npm run app:quick');
    return 1;
  }

  try {
    await start();
  } catch (error) {
    fail(`Could not listen on port ${port}: ${error.message}`);
    return 1;
  }

  say(`Explorer:  ${url()}`);
  say(`Browser:   ${browser.name}`);
  if (xle) {
    say(`XLE:       ${xle.mode} (${xle.command})`);
  } else {
    say('XLE:       not found — the sentence bar will match headwords only.');
    say('           Put xle on your PATH, or set XLEPATH or XLE_COMMAND, and restart.');
  }
  say('');
  say('Closing the last explorer window stops this too. So does Ctrl-C here,');
  say('or `npm run app:stop` from anywhere.');

  const { command, args } = openCommand(browser, url());
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().then((code) => {
    // A non-zero code means nothing is running, so there is nothing to wait for.
    if (code !== 0) process.exit(code);
  }, (error) => {
    fail(String(error?.stack ?? error));
    process.exit(1);
  });
}
