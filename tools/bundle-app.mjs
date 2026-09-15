/**
 * Package the explorer as an app that can be copied to another Mac.
 *
 * What travels is small, which is the whole reason this is worth doing: the server
 * imports nothing but Node builtins, so the runtime is the built page and eight files
 * of server code. The 400-odd megabytes in `node_modules` are there to *build* it and
 * are not needed to run it.
 *
 * What does not travel, and cannot:
 *
 *  - **Node**, which the launcher looks for and asks for by dialog if it is missing.
 *    Bundling it would mean a hundred megabytes per architecture.
 *  - **A Chromium browser**, for the File System Access API the explorer edits through.
 *  - **XLE**, which is licensed separately. This is an editor for XLE grammars, not a
 *    way to install XLE; without it the sentence bar matches headwords and says so.
 *
 * The app opens a Terminal window and runs there. A browser-based tool whose server is
 * invisible is one nobody can stop by hand when the browser does something unexpected,
 * which is why Jupyter keeps its terminal too.
 *
 * The result is unsigned, so macOS quarantines it when it arrives from elsewhere and
 * the first open has to be right-click - Open. Signing it needs a paid Developer ID.
 *
 *   npm run app:bundle
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../server/is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'XLE Grammar Explorer';

export function infoPlist(name = NAME, version = '0.0.1') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>de.uni-konstanz.xle-grammar-explorer</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict>
</plist>
`;
}

/** Assemble the bundle at `into`, from a repository at `from`. */
export function bundleApp(from, into, name = NAME) {
  const app = join(into, `${name}.app`);
  const contents = join(app, 'Contents');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources', 'app'), { recursive: true });

  writeFileSync(join(contents, 'Info.plist'), infoPlist(name));
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????');
  cpSync(join(from, 'assets', 'AppIcon.icns'), join(contents, 'Resources', 'AppIcon.icns'));

  // Both scripts are the same ones the repository copy uses; each works out which it
  // is at run time. The launcher opens Terminal, the runner is what Terminal runs.
  const launcher = join(contents, 'MacOS', 'launch');
  cpSync(join(from, 'assets', 'app-launch.sh'), launcher);
  chmodSync(launcher, 0o755);

  const runner = join(contents, 'Resources', 'app', 'run.command');
  cpSync(join(from, 'assets', 'app-run.sh'), runner);
  chmodSync(runner, 0o755);

  // `index.mjs` looks for the page at `../dist` from the server directory, so this
  // layout is the one it already expects.
  cpSync(join(from, 'server'), join(contents, 'Resources', 'app', 'server'), {
    recursive: true,
    filter: (path) => !path.endsWith('.test.mjs') && !path.includes('fixtures'),
  });
  cpSync(join(from, 'dist'), join(contents, 'Resources', 'app', 'dist'), { recursive: true });
  return app;
}

if (isMain(import.meta.url)) {
  if (!existsSync(join(root, 'dist'))) {
    console.error('Build the app first:  npm run build');
    process.exit(1);
  }
  const into = join(root, 'dist-app');
  mkdirSync(into, { recursive: true });
  const app = bundleApp(root, into);
  console.log(`Packaged ${app}`);
  console.log('Copy it anywhere. It needs Node.js and a Chromium browser on the machine');
  console.log('it runs on, and XLE for the sentence bar. Unsigned, so the first open on');
  console.log('another Mac has to be right-click - Open.');
}
