/**
 * Build the macOS app icon from the XLE+Glue logo.
 *
 * Checked-in binaries are otherwise a mystery: this says where `assets/AppIcon.icns`
 * came from, and makes it redoable when the logo changes.
 *
 * The source logo sits in a 960x540 canvas that is mostly empty — the mark occupies
 * x 357..549, y 194..345, measured by finding every non-white pixel of the PNG. Those
 * bounds are coordinates in the SVG's own viewBox, so cropping is a matter of changing
 * the viewBox and the background rectangle drawn behind it.
 *
 * Rendering goes through headless Chrome, which is already required to run the app.
 * It renders once at 1024 and everything else is scaled down from that: Chrome will
 * not open a window small enough to render a 32px icon directly, and a screenshot of
 * a larger window would be a crop rather than a scaling.
 *
 * macOS only — `iconutil` and `.icns` are.
 *
 *   node tools/make-icon.mjs [path/to/xleplusglue-logo.svg]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? join(root, '..', 'xleplusglue', 'assets', 'xleplusglue-logo.svg'));

/** Non-white bounds of the mark within the 960x540 canvas, and the padding around it. */
const CONTENT = { x0: 357, y0: 194, x1: 550, y1: 346 };
const PADDING = 1.16;

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Every size an .icns wants, as [pixels, name]. */
const SIZES = [
  [16, 'icon_16x16'], [32, 'icon_16x16@2x'],
  [32, 'icon_32x32'], [64, 'icon_32x32@2x'],
  [128, 'icon_128x128'], [256, 'icon_128x128@2x'],
  [256, 'icon_256x256'], [512, 'icon_256x256@2x'],
  [512, 'icon_512x512'], [1024, 'icon_512x512@2x'],
];

/** Crop the logo to a square around the mark. */
export function cropSvg(svg, content = CONTENT, padding = PADDING) {
  const cx = (content.x0 + content.x1) / 2;
  const cy = (content.y0 + content.y1) / 2;
  const side = Math.max(content.x1 - content.x0, content.y1 - content.y0) * padding;
  const x = (cx - side / 2).toFixed(1);
  const y = (cy - side / 2).toFixed(1);
  const s = side.toFixed(1);

  let out = svg.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${s} ${s}"`);
  // The white backdrop covers the old canvas, so only part of it survives the crop.
  // Redraw it over the crop instead, or the icon gets white on three sides and not
  // the fourth.
  out = out.replace(
    /<path fill="#ffffff" d="m0 0l960\.0 0l0 540\.0l-960\.0 0z" fill-rule="evenodd"\/>/,
    `<path fill="#ffffff" d="m${x} ${y}l${s} 0l0 ${s}l-${s} 0z" fill-rule="evenodd"/>`,
  );
  return out;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });

  const cropped = join(assets, 'logo.svg');
  writeFileSync(cropped, cropSvg(readFileSync(source, 'utf8')));

  const master = join(assets, 'logo.png');
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--screenshot=${master}`, '--window-size=1024,1024', `file://${cropped}`,
  ], { stdio: 'ignore' });

  const iconset = join(assets, 'AppIcon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const [size, name] of SIZES) {
    execFileSync('sips', ['-z', String(size), String(size), master,
      '--out', join(iconset, `${name}.png`)], { stdio: 'ignore' });
  }

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(assets, 'AppIcon.icns')]);
  rmSync(iconset, { recursive: true, force: true });
  execFileSync('cp', [join(assets, 'AppIcon.icns'),
    join(root, 'XLE Grammar Explorer.app', 'Contents', 'Resources', 'AppIcon.icns')]);

  console.log(`Built assets/AppIcon.icns from ${source}`);
}
