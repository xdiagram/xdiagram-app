import type { ELK as ElkInstance, ElkNode } from "elkjs/lib/elk-api";

import { type Block, flow, orderBlocks, packRows, rowWidth } from "../modules/pack";
import type { Point } from "../persistence/layout.service";
import { GROUP_LABEL_H, GROUP_PAD, boundsOf, tableSize } from "./geometry";
import type { ViewModel } from "./view-model";

let workerElk: Promise<ElkInstance> | null = null;
let mainThreadElk: Promise<ElkInstance> | null = null;
/** Set when the layout worker could not run: from then on ELK runs on the main thread. */
let workerBroken = typeof Worker === "undefined";
/** Rejects the layouts waiting on the worker when it dies (elk-api would wait forever). */
const onWorkerError = new Set<(err: unknown) => void>();

/** ELK (~1.5 MB) in a Web Worker (layout.worker.ts), loaded on first use. */
function getWorkerElk(): Promise<ElkInstance> {
  workerElk ??= import("elkjs/lib/elk-api.js").then(
    (m) =>
      new m.default({
        workerFactory: () => {
          const worker = new Worker(new URL("./layout.worker", import.meta.url), { type: "module" });
          worker.addEventListener("error", (e) => {
            workerBroken = true;
            for (const reject of onWorkerError) reject(e.message || "layout worker failed");
          });
          return worker;
        },
      }),
  );
  return workerElk;
}

/** Starts the layout worker ahead of time, so the first diagram does not wait for ELK to load. */
export function prewarmLayout(): void {
  if (!workerBroken) void getWorkerElk().catch(() => undefined);
}

function getMainThreadElk(): Promise<ElkInstance> {
  mainThreadElk ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default());
  return mainThreadElk;
}

async function runElk(graph: ElkNode): Promise<ElkNode> {
  if (!workerBroken) {
    try {
      const elk = await getWorkerElk();
      return await new Promise<ElkNode>((resolve, reject) => {
        onWorkerError.add(reject);
        elk.layout(graph).then(resolve, reject).finally(() => onWorkerError.delete(reject));
      });
    } catch (err) {
      if (!workerBroken) throw err; // a layout error, not a worker problem
      console.warn("Layout worker failed; laying out on the main thread", err);
    }
  }
  return (await getMainThreadElk()).layout(graph);
}

const ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "110",
  "elk.spacing.nodeNode": "48",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "90",
  "elk.aspectRatio": "1.6",
};

/**
 * Returns positions for every table. Saved positions win; tables without one are laid out
 * with ELK (layered, referenced tables to the left of the tables that reference them) and,
 * when other tables are already placed, dropped below the existing diagram.
 */
export async function layoutTables(view: ViewModel, saved: Record<string, Point>): Promise<Record<string, Point>> {
  const result: Record<string, Point> = {};
  const missing = view.tables.filter((t) => !saved[t.id]);
  for (const t of view.tables) if (saved[t.id]) result[t.id] = saved[t.id];
  if (missing.length === 0) return result;

  const missingIds = new Set(missing.map((t) => t.id));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: ELK_OPTIONS,
    children: missing.map((t) => {
      const s = tableSize(t);
      return { id: t.id, width: s.w, height: s.h };
    }),
    edges: view.refs
      .filter((r) => r.from.table !== r.to.table && missingIds.has(r.from.table) && missingIds.has(r.to.table))
      .map((r, i) => ({ id: `e${i}`, sources: [r.to.table], targets: [r.from.table] })),
  };

  let laidOut: ElkNode;
  try {
    laidOut = await runElk(graph);
  } catch (err) {
    console.error("ELK layout failed, falling back to a grid", err);
    laidOut = gridLayout(graph);
  }

  let offsetX = 0;
  let offsetY = 0;
  const placed = view.tables.filter((t) => saved[t.id]);
  if (placed.length > 0) {
    const b = boundsOf(placed.map((t) => ({ ...saved[t.id], ...size(t) })));
    offsetX = b.x;
    offsetY = b.y + b.h + 120;
  }
  for (const n of laidOut.children ?? []) {
    result[n.id] = { x: Math.round((n.x ?? 0) + offsetX), y: Math.round((n.y ?? 0) + offsetY) };
  }
  return result;
}

/** What the Modules arrangement lays out: each module's tables, the common and the other tables. */
export interface ModuleLayoutPlan {
  modules: { key: string; tables: string[] }[];
  /** Most linked first: a strip above the modules. */
  common: string[];
  other: string[];
  /** Links no relationship in the DBML declares (X-ray's joins): they pull tables together too. */
  extraLinks?: { a: string; b: string }[];
}

/** Space between two zones, and between tables in the common and other strips. */
const ZONE_GAP = 60;
const ITEM_GAP = 48;
const ASPECT = 1.6;
const OTHER_KEY = "\u0000other";

/**
 * Positions for the Modules arrangement. Each module is laid out on its own with ELK (in
 * parallel), then the modules are packed in rows, linked ones side by side, each with room for
 * its zone so zones never overlap. The common tables form a strip on top, the other tables a
 * block at the end. Tables the plan does not mention go with the other tables.
 */
export async function layoutModules(view: ViewModel, plan: ModuleLayoutPlan): Promise<Record<string, Point>> {
  const byId = new Map(view.tables.map((t) => [t.id, t]));
  const known = (ids: readonly string[]) => ids.filter((id) => byId.has(id));
  const extra = plan.extraLinks ?? [];
  const zone = (w: number, h: number) => ({ w: w + GROUP_PAD * 2, h: h + GROUP_PAD * 2 + GROUP_LABEL_H });
  const inset = { x: GROUP_PAD, y: GROUP_PAD + GROUP_LABEL_H };
  const item = (id: string): Block => ({ key: id, ...size(byId.get(id)!) });

  const modules = plan.modules.map((m) => ({ key: m.key, tables: known(m.tables) })).filter((m) => m.tables.length);
  const laid = new Map(await Promise.all(modules.map(async (m) => [m.key, await layoutBlock(view, m.tables, extra)] as const)));

  const placed = new Set([...modules.flatMap((m) => m.tables), ...known(plan.common)]);
  const other = [...known(plan.other), ...view.tables.map((t) => t.id).filter((id) => !placed.has(id) && !plan.other.includes(id))];

  // Pack order: linked modules next to each other.
  const moduleOf = new Map<string, string>();
  for (const m of modules) for (const t of m.tables) moduleOf.set(t, m.key);
  const strength = new Map<string, number>();
  const pairs = [...view.refs.map((r) => ({ a: r.from.table, b: r.to.table })), ...extra];
  for (const { a, b } of pairs) {
    const ma = moduleOf.get(a);
    const mb = moduleOf.get(b);
    if (!ma || !mb || ma === mb) continue;
    const key = ma < mb ? `${ma}\u0000${mb}` : `${mb}\u0000${ma}`;
    strength.set(key, (strength.get(key) ?? 0) + 1);
  }
  const tableCount = new Map(modules.map((m) => [m.key, m.tables.length]));
  const order = orderBlocks(
    modules.map((m) => m.key),
    (k) => tableCount.get(k) ?? 0,
    (x, y) => strength.get(x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`) ?? 0,
  );

  const blocks: Block[] = order.map((k) => ({ key: k, ...zone(laid.get(k)!.w, laid.get(k)!.h) }));
  const otherItems = other.map(item);
  const otherFlow = otherItems.length ? flow(otherItems, rowWidth(otherItems, ASPECT), ITEM_GAP) : null;
  if (otherFlow) blocks.push({ key: OTHER_KEY, ...zone(otherFlow.w, otherFlow.h) });
  const width = rowWidth(blocks, ASPECT);

  const result: Record<string, Point> = {};
  const put = (id: string, x: number, y: number) => (result[id] = { x: Math.round(x), y: Math.round(y) });

  let top = 0;
  const commonItems = known(plan.common).map(item);
  if (commonItems.length) {
    const strip = flow(commonItems, Math.max(width - GROUP_PAD * 2, 1), ITEM_GAP);
    for (const [id, s] of strip.spots) put(id, inset.x + s.x, inset.y + s.y);
    top = zone(strip.w, strip.h).h + ZONE_GAP;
  }

  const spots = packRows(blocks, width, ZONE_GAP);
  for (const b of blocks) {
    const at = spots.get(b.key)!;
    const ox = at.x + inset.x;
    const oy = top + at.y + inset.y;
    if (b.key === OTHER_KEY) {
      for (const [id, s] of otherFlow!.spots) put(id, ox + s.x, oy + s.y);
      continue;
    }
    for (const [id, p] of laid.get(b.key)!.positions) put(id, ox + p.x, oy + p.y);
  }
  return result;
}

/** One module laid out with ELK, moved to start at 0,0. */
async function layoutBlock(
  view: ViewModel,
  ids: readonly string[],
  extra: readonly { a: string; b: string }[],
): Promise<{ positions: Map<string, Point>; w: number; h: number }> {
  const set = new Set(ids);
  const byId = new Map(view.tables.map((t) => [t.id, t]));
  const ends = [
    ...view.refs.filter((r) => r.from.table !== r.to.table && set.has(r.from.table) && set.has(r.to.table)).map((r) => [r.to.table, r.from.table]),
    ...extra.filter((l) => l.a !== l.b && set.has(l.a) && set.has(l.b)).map((l) => [l.a, l.b]),
  ];
  const graph: ElkNode = {
    id: "root",
    layoutOptions: ELK_OPTIONS,
    children: ids.map((id) => {
      const s = tableSize(byId.get(id)!);
      return { id, width: s.w, height: s.h };
    }),
    edges: ends.map(([source, target], i) => ({ id: `e${i}`, sources: [source], targets: [target] })),
  };
  let laidOut: ElkNode;
  try {
    laidOut = ids.length > 1 ? await runElk(graph) : gridLayout(graph);
  } catch (err) {
    console.error("ELK layout of a module failed, falling back to a grid", err);
    laidOut = gridLayout(graph);
  }
  const nodes = laidOut.children ?? [];
  const b = boundsOf(nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? 0, h: n.height ?? 0 })));
  const positions = new Map(nodes.map((n) => [n.id, { x: (n.x ?? 0) - b.x, y: (n.y ?? 0) - b.y }]));
  return { positions, w: b.w, h: b.h };
}

function size(t: ViewModel["tables"][number]) {
  const s = tableSize(t);
  return { w: s.w, h: s.h };
}

function gridLayout(graph: ElkNode): ElkNode {
  const cols = Math.max(1, Math.ceil(Math.sqrt(graph.children?.length ?? 1)));
  let x = 0;
  let y = 0;
  let rowH = 0;
  const children = (graph.children ?? []).map((n, i) => {
    if (i > 0 && i % cols === 0) {
      x = 0;
      y += rowH + 60;
      rowH = 0;
    }
    const placed = { ...n, x, y };
    x += (n.width ?? 200) + 60;
    rowH = Math.max(rowH, n.height ?? 100);
    return placed;
  });
  return { ...graph, children };
}
