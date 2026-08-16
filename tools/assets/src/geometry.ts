export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Raw pixel buffer + how to read it, as returned by `sharp(...).raw().toBuffer({ resolveWithObject: true })`. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

const ALPHA_THRESHOLD = 10;

function alphaAt(img: RawImage, x: number, y: number): number {
  if (img.channels < 4) return 255;
  return img.data[(y * img.width + x) * img.channels + 3] as number;
}

/** Divide a sheet into `rows` x `cols` equal cells, in row-major (reading) order. */
export function gridCells(width: number, height: number, rows: number, cols: number): Rect[] {
  const cellW = width / cols;
  const cellH = height / rows;
  const cells: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: Math.round(c * cellW),
        y: Math.round(r * cellH),
        width: Math.round((c + 1) * cellW) - Math.round(c * cellW),
        height: Math.round((r + 1) * cellH) - Math.round(r * cellH),
      });
    }
  }
  return cells;
}

/**
 * Tight alpha bounding box within `region` (defaults to the whole image).
 * Returns null if every pixel in the region is at/below the alpha threshold.
 */
export function alphaBBox(img: RawImage, region?: Rect): Rect | null {
  const rx0 = region?.x ?? 0;
  const ry0 = region?.y ?? 0;
  const rx1 = region ? region.x + region.width : img.width;
  const ry1 = region ? region.y + region.height : img.height;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      if (alphaAt(img, x, y) > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function rectsClose(a: Rect, b: Rect, gap: number): boolean {
  const aX0 = a.x - gap;
  const aY0 = a.y - gap;
  const aX1 = a.x + a.width + gap;
  const aY1 = a.y + a.height + gap;
  return !(b.x > aX1 || b.x + b.width < aX0 || b.y > aY1 || b.y + b.height < aY0);
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Find connected components in the alpha mask (4-connectivity flood fill), restricted to
 * `region` if given, then merge components whose bounding boxes lie within `mergeGap`
 * pixels of each other (repeatedly, since a single sprite is often drawn as several
 * disjoint alpha blobs — e.g. a thrown weapon a few px from a hand).
 */
export function connectedComponents(img: RawImage, mergeGap: number, region?: Rect): Rect[] {
  const rx0 = region?.x ?? 0;
  const ry0 = region?.y ?? 0;
  const rx1 = region ? region.x + region.width : img.width;
  const ry1 = region ? region.y + region.height : img.height;

  const w = img.width;
  const visited = new Uint8Array(img.width * img.height);
  const boxes: Rect[] = [];
  const stackX = new Int32Array(img.width * img.height);
  const stackY = new Int32Array(img.width * img.height);

  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      const idx = y * w + x;
      if (visited[idx]) continue;
      visited[idx] = 1;
      if (alphaAt(img, x, y) <= ALPHA_THRESHOLD) continue;

      let sp = 0;
      stackX[sp] = x;
      stackY[sp] = y;
      sp++;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (sp > 0) {
        sp--;
        const cx = stackX[sp] as number;
        const cy = stackY[sp] as number;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors: Array<[number, number]> = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < rx0 || nx >= rx1 || ny < ry0 || ny >= ry1) continue;
          const nIdx = ny * w + nx;
          if (visited[nIdx]) continue;
          visited[nIdx] = 1;
          if (alphaAt(img, nx, ny) <= ALPHA_THRESHOLD) continue;
          stackX[sp] = nx;
          stackY[sp] = ny;
          sp++;
        }
      }

      boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }

  return mergeClose(boxes, mergeGap);
}

function mergeClose(boxes: Rect[], gap: number): Rect[] {
  let current = boxes;
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    const next: Rect[] = [];
    const used = new Array(current.length).fill(false);
    for (let i = 0; i < current.length; i++) {
      if (used[i]) continue;
      let acc = current[i] as Rect;
      used[i] = true;
      for (let j = i + 1; j < current.length; j++) {
        if (used[j]) continue;
        if (rectsClose(acc, current[j] as Rect, gap)) {
          acc = unionRect(acc, current[j] as Rect);
          used[j] = true;
          mergedAny = true;
        }
      }
      next.push(acc);
    }
    current = next;
  }
  return current;
}

/**
 * Split `box` in two at whichever seam (a vertical column, or a horizontal row, searched
 * within the middle 70% of the box so trivial edge cuts are avoided) has the lowest opaque
 * pixel *density* — used to recover when two sprites are bridged by a touching prop (e.g. a
 * weapon, or debris spanning a row gap) and connected-component detection merged them into
 * one blob. Tries both orientations since the merge can happen along either axis. Each half
 * is re-trimmed to its own tight alpha bbox.
 */
export function splitAtMinDensity(img: RawImage, box: Rect): [Rect, Rect] {
  const vertical = bestSeam(img, box.x, box.x + box.width, box.y, box.y + box.height, true);
  const horizontal = bestSeam(img, box.y, box.y + box.height, box.x, box.x + box.width, false);

  if (vertical.density <= horizontal.density) {
    const left: Rect = { x: box.x, y: box.y, width: vertical.at - box.x, height: box.height };
    const right: Rect = {
      x: vertical.at,
      y: box.y,
      width: box.x + box.width - vertical.at,
      height: box.height,
    };
    return [alphaBBox(img, left) ?? left, alphaBBox(img, right) ?? right];
  }
  const top: Rect = { x: box.x, y: box.y, width: box.width, height: horizontal.at - box.y };
  const bottom: Rect = {
    x: box.x,
    y: horizontal.at,
    width: box.width,
    height: box.y + box.height - horizontal.at,
  };
  return [alphaBBox(img, top) ?? top, alphaBBox(img, bottom) ?? bottom];
}

function bestSeam(
  img: RawImage,
  primary0: number,
  primary1: number,
  cross0: number,
  cross1: number,
  vertical: boolean,
): { at: number; density: number } {
  const searchP0 = primary0 + Math.round((primary1 - primary0) * 0.15);
  const searchP1 = primary0 + Math.round((primary1 - primary0) * 0.85);
  const crossLen = cross1 - cross0;

  let bestAt = Math.round((primary0 + primary1) / 2);
  let bestCount = Infinity;
  for (let p = searchP0; p < searchP1; p++) {
    let count = 0;
    for (let c = cross0; c < cross1; c++) {
      const alpha = vertical ? alphaAt(img, p, c) : alphaAt(img, c, p);
      if (alpha > ALPHA_THRESHOLD) count++;
    }
    if (count < bestCount) {
      bestCount = count;
      bestAt = p;
    }
  }
  return { at: bestAt, density: crossLen === 0 ? Infinity : bestCount / crossLen };
}

/**
 * Sort boxes into reading order: cluster into row bands by vertical overlap of centers,
 * top band first, then left-to-right within each band.
 */
export function sortReadingOrder(boxes: Rect[]): Rect[] {
  const withCenter = boxes.map((b) => ({ b, cy: b.y + b.height / 2 }));
  withCenter.sort((a, b) => a.cy - b.cy);

  const bands: Array<{ items: typeof withCenter; top: number; bottom: number }> = [];
  for (const item of withCenter) {
    const band = bands.find((bd) => item.cy >= bd.top && item.cy <= bd.bottom);
    if (band) {
      band.items.push(item);
      band.top = Math.min(band.top, item.b.y);
      band.bottom = Math.max(band.bottom, item.b.y + item.b.height);
    } else {
      bands.push({ items: [item], top: item.b.y, bottom: item.b.y + item.b.height });
    }
  }

  bands.sort((a, b) => a.top - b.top);
  const result: Rect[] = [];
  for (const band of bands) {
    band.items.sort((a, b) => a.b.x - b.b.x);
    result.push(...band.items.map((i) => i.b));
  }
  return result;
}
