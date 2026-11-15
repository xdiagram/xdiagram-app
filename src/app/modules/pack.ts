/** Pure geometry for the Modules arrangement: where each module's block goes. */

export interface Block {
  key: string;
  w: number;
  h: number;
}

export interface Spot {
  x: number;
  y: number;
}

/**
 * Packing order: the largest module first, then again and again the one most strongly linked to
 * those already placed (ties: the larger, then the key), so linked modules end up side by side.
 */
export function orderBlocks(keys: readonly string[], size: (key: string) => number, strength: (a: string, b: string) => number): string[] {
  const left = [...keys];
  const placed: string[] = [];
  const better = (a: string, b: string) => size(a) > size(b) || (size(a) === size(b) && a < b);
  while (left.length) {
    let best = -1;
    let bestStrength = -1;
    for (let i = 0; i < left.length; i++) {
      let s = 0;
      for (const p of placed) s += strength(left[i], p);
      if (s > bestStrength || (s === bestStrength && better(left[i], left[best]))) {
        best = i;
        bestStrength = s;
      }
    }
    placed.push(left.splice(best, 1)[0]);
  }
  return placed;
}

/** A row width that gives the packed blocks roughly this aspect ratio (never narrower than the widest). */
export function rowWidth(blocks: readonly Block[], aspect: number): number {
  let area = 0;
  let widest = 0;
  for (const b of blocks) {
    area += b.w * b.h;
    widest = Math.max(widest, b.w);
  }
  return Math.max(widest, Math.sqrt(area * aspect));
}

/** Blocks left to right in the given order, starting a new row when the next one would not fit. */
export function packRows(blocks: readonly Block[], width: number, gap: number): Map<string, Spot> {
  const out = new Map<string, Spot>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > width) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out.set(b.key, { x, y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

/** Items in rows within `width` (the common tables' strip, the other tables' grid). */
export function flow(items: readonly Block[], width: number, gap: number): { spots: Map<string, Spot>; w: number; h: number } {
  const spots = packRows(items, width, gap);
  let w = 0;
  let h = 0;
  for (const it of items) {
    const s = spots.get(it.key)!;
    w = Math.max(w, s.x + it.w);
    h = Math.max(h, s.y + it.h);
  }
  return { spots, w, h };
}
