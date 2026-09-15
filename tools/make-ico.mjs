/**
 * Write a Windows .ico from the PNG sizes the icon pipeline already renders.
 *
 * `iconutil` is macOS-only and there is no equivalent to shell out to, but an .ico
 * needs none: since Vista it is a directory of images and the images may be PNG files
 * stored whole. So the format is a six-byte header, a sixteen-byte entry per size, and
 * then the PNGs themselves — no encoder, no dependency, and byte-identical output
 * whichever machine builds it.
 *
 *   node tools/make-ico.mjs            (after tools/make-icon.mjs)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../server/is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What Windows actually shows: 16 and 32 in lists, 48 on the desktop, 256 in previews. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Pack PNGs into an .ico.
 *
 * @param images `{ size, data }` per entry, each `data` a complete PNG file.
 */
export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon, 2 = cursor
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    // 256 does not fit in a byte and is written as 0, which the format defines as 256.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);              // palette size: none, this is truecolour
    entry.writeUInt8(0, 3);              // reserved
    entry.writeUInt16LE(1, 4);           // colour planes
    entry.writeUInt16LE(32, 6);          // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

if (isMain(import.meta.url)) {
  const master = join(root, 'assets', 'logo.png');
  const scratch = mkdtempSync(join(tmpdir(), 'xle-ico-'));
  try {
    const images = ICO_SIZES.map((size) => {
      const file = join(scratch, `${size}.png`);
      execFileSync('sips', ['-z', String(size), String(size), master, '--out', file],
        { stdio: 'ignore' });
      return { size, data: readFileSync(file) };
    });
    const out = join(root, 'assets', 'AppIcon.ico');
    writeFileSync(out, buildIco(images));
    console.log(`Built ${out} (${ICO_SIZES.join(', ')})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
