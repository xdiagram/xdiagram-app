import type { ELK as ElkInstance, ElkNode } from "elkjs/lib/elk-api";

import type { Point } from "../persistence/layout.service";
import { boundsOf, tableSize } from "./geometry";
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
