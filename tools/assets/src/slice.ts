import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import {
  alphaBBox,
  connectedComponents,
  gridCells,
  sortReadingOrder,
  splitAtMinDensity,
  type Rect,
  type RawImage,
} from './geometry.js';
import { buildManifest, type ManifestEntry } from './manifest.js';
import { sheets, type FracRegion, type ItemSpec } from './sheets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const RAW_DIR = join(REPO_ROOT, 'art', 'raw');
const OUT_DIR = join(REPO_ROOT, 'apps', 'web', 'public', 'assets');

function fracToRect(region: FracRegion | undefined, width: number, height: number): Rect {
  if (!region) return { x: 0, y: 0, width, height };
  const x0 = Math.round(region.xFrac[0] * width);
  const y0 = Math.round(region.yFrac[0] * height);
  const x1 = Math.round(region.xFrac[1] * width);
  const y1 = Math.round(region.yFrac[1] * height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function offsetCells(cells: Rect[], region: Rect): Rect[] {
  return cells.map((c) => ({ ...c, x: c.x + region.x, y: c.y + region.y }));
}

async function emitSprite(
  sourceBuffer: Buffer,
  sheetFile: string,
  box: Rect,
  item: ItemSpec,
): Promise<ManifestEntry> {
  const outPath = join(OUT_DIR, item.file);
  await mkdir(dirname(outPath), { recursive: true });
  const info = await sharp(sourceBuffer)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .resize(item.target[0], item.target[1], { fit: 'inside', kernel: sharp.kernel.nearest })
    .png()
    .toFile(outPath);
  return {
    id: item.id,
    path: `/assets/${item.file}`,
    source: sheetFile,
    width: info.width,
    height: info.height,
  };
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const manifest: ManifestEntry[] = [];

  for (const sheet of sheets) {
    const inputPath = join(RAW_DIR, sheet.file);
    const buffer = await readFile(inputPath);
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img: RawImage = { data, width: info.width, height: info.height, channels: info.channels };

    for (const group of sheet.groups) {
      if (group.kind === 'grid') {
        const region = fracToRect(group.region, img.width, img.height);
        const cells = offsetCells(
          gridCells(region.width, region.height, group.rows, group.cols),
          region,
        );
        if (cells.length !== group.items.length) {
          throw new Error(
            `${sheet.file}: grid produced ${cells.length} cells but ${group.items.length} items configured`,
          );
        }
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i] as Rect;
          const trimmed = alphaBBox(img, cell) ?? cell;
          manifest.push(await emitSprite(buffer, sheet.file, trimmed, group.items[i] as ItemSpec));
        }
      } else if (group.kind === 'bbox') {
        const region = group.region ? fracToRect(group.region, img.width, img.height) : undefined;
        let boxes = sortReadingOrder(connectedComponents(img, group.mergeGap, region));

        // Recover from two side-by-side sprites bridged by a touching prop (e.g. a weapon)
        // getting merged into one blob: repeatedly split the widest box at its thinnest
        // (least-opaque) vertical seam until the count matches, or give up.
        let splitAttempts = 0;
        while (boxes.length < group.items.length && splitAttempts < group.items.length) {
          const largest = boxes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
          const [first, second] = splitAtMinDensity(img, largest);
          boxes = sortReadingOrder(boxes.filter((b) => b !== largest).concat([first, second]));
          splitAttempts++;
        }

        if (boxes.length !== group.items.length) {
          throw new Error(
            `${sheet.file}: detected ${boxes.length} connected components but ${group.items.length} items configured. ` +
              `Boxes: ${JSON.stringify(boxes)}`,
          );
        }
        for (let i = 0; i < boxes.length; i++) {
          manifest.push(
            await emitSprite(buffer, sheet.file, boxes[i] as Rect, group.items[i] as ItemSpec),
          );
        }
      } else {
        const region = fracToRect(group.region, img.width, img.height);
        const box = group.trim ? (alphaBBox(img, region) ?? region) : region;
        manifest.push(await emitSprite(buffer, sheet.file, box, group.item));
      }
    }

    console.log(`sliced ${sheet.file}`);
  }

  const manifestPath = join(OUT_DIR, 'manifest.json');
  await writeFile(manifestPath, buildManifest(manifest));

  console.log(`\n${manifest.length} sprites written to ${OUT_DIR}`);
  console.log(`manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
