import { type Block, flow, orderBlocks, packRows, rowWidth } from "./pack";

const overlaps = (a: Block & { x: number; y: number }, b: Block & { x: number; y: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("module packing", () => {
  it("puts the largest first, then the module most linked to those placed", () => {
    const size: Record<string, number> = { a: 10, b: 8, c: 6, d: 4 };
    const links: Record<string, number> = { "a|d": 5, "b|c": 3, "c|d": 1 };
    const strength = (x: string, y: string) => links[[x, y].sort().join("|")] ?? 0;
    expect(orderBlocks(["b", "d", "a", "c"], (k) => size[k], strength)).toEqual(["a", "d", "c", "b"]);
  });

  it("packs blocks in rows without overlap, in order", () => {
    const blocks: Block[] = [
      { key: "a", w: 400, h: 300 },
      { key: "b", w: 300, h: 200 },
      { key: "c", w: 500, h: 100 },
      { key: "d", w: 200, h: 200 },
    ];
    const width = rowWidth(blocks, 1.6);
    expect(width).toBeCloseTo(Math.sqrt((120000 + 60000 + 50000 + 40000) * 1.6));
    const spots = packRows(blocks, 800, 60);
    const placed = blocks.map((b) => ({ ...b, ...spots.get(b.key)! }));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false);
    // a and b share the first row; c does not fit after them.
    expect(spots.get("a")).toEqual({ x: 0, y: 0 });
    expect(spots.get("b")).toEqual({ x: 460, y: 0 });
    expect(spots.get("c")).toEqual({ x: 0, y: 360 });
  });

  it("never makes a row narrower than the widest block", () => {
    expect(rowWidth([{ key: "a", w: 2000, h: 10 }], 1.6)).toBe(2000);
  });

  it("flows items and reports the size they take", () => {
    const { spots, w, h } = flow(
      [
        { key: "x", w: 100, h: 50 },
        { key: "y", w: 100, h: 80 },
        { key: "z", w: 100, h: 50 },
      ],
      250,
      20,
    );
    expect(spots.get("z")).toEqual({ x: 0, y: 100 });
    expect({ w, h }).toEqual({ w: 220, h: 150 });
  });
});
