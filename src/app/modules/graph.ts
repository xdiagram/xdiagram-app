import type { WorkloadReport } from "../core/tauri-api.service";
import { type VEndpoint, type VRef, refKey } from "../diagram/view-model";
import type { GraphSource, Link } from "./types";

/** The part of X-ray's report the module finder reads. */
export type TrafficReport = Pick<WorkloadReport, "available" | "relations" | "declaredUsage">;

export const compareIds = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function endpoint(e: { schema: string; table: string; columns: string[] }): VEndpoint {
  return { table: `${e.schema}.${e.table}`, fields: e.columns, many: false };
}

/**
 * Merges declared relationships and the joins seen in the query traffic into one link per table
 * pair. Self-references and tables that are not in the document are left out. The traffic counts
 * only when the report is available and saw some joins.
 */
export function collectLinks(
  tableIds: Iterable<string>,
  refs: readonly VRef[],
  report: TrafficReport | null,
): { links: Link[]; source: GraphSource } {
  const known = new Set(tableIds);
  const traffic = report?.available ? report : null;
  const fkCalls = new Map<string, number>();
  for (const u of traffic?.declaredUsage ?? []) {
    const key = refKey(endpoint(u.from), endpoint(u.to));
    fkCalls.set(key, (fkCalls.get(key) ?? 0) + u.calls);
  }

  const pairs = new Map<string, Link>();
  const add = (x: string, y: string, declared: boolean, calls: number) => {
    if (x === y || !known.has(x) || !known.has(y)) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}\u0000${b}`;
    const link = pairs.get(key);
    if (link) {
      link.declared ||= declared;
      link.calls += calls;
    } else pairs.set(key, { a, b, declared, calls });
  };

  const counted = new Set<string>();
  for (const r of refs) {
    const key = refKey(r.from, r.to);
    // The same FK declared twice is joined once.
    add(r.from.table, r.to.table, true, counted.has(key) ? 0 : (fkCalls.get(key) ?? 0));
    counted.add(key);
  }
  // Joins no database FK backs. One written into the DBML since (Add Ref) is still reported here,
  // and its calls then go to the declared link.
  for (const rel of traffic?.relations ?? []) add(endpoint(rel.from).table, endpoint(rel.to).table, false, rel.calls);

  const links = [...pairs.values()].sort((p, q) => compareIds(p.a, q.a) || compareIds(p.b, q.b));
  const total = links.reduce((s, l) => s + l.calls, 0);
  return { links, source: traffic && total > 0 ? "traffic" : "declared" };
}

/**
 * Weight of a link: 1 for a declared relationship, plus up to 3 for its traffic on a log scale
 * relative to the busiest link. A never-joined FK weighs 1, the busiest FK 4, the busiest
 * undeclared join 3: traffic shifts the weights without drowning the structure.
 */
export function linkWeight(link: Link, maxCalls: number, source: GraphSource): number {
  const structure = link.declared ? 1 : 0;
  if (source !== "traffic" || link.calls <= 0 || maxCalls <= 0) return structure;
  return structure + (3 * Math.log1p(link.calls)) / Math.log1p(maxCalls);
}

export function maxCalls(links: readonly Link[]): number {
  let max = 0;
  for (const l of links) if (l.calls > max) max = l.calls;
  return max;
}

/** Undirected weighted graph over sorted table ids. Neighbour lists are ascending. */
export interface Graph {
  ids: string[];
  index: Map<string, number>;
  nbr: number[][];
  wt: number[][];
}

/** Builds the graph the communities are found on, leaving out the `exclude` tables and their links. */
export function buildGraph(
  tableIds: Iterable<string>,
  links: readonly Link[],
  source: GraphSource,
  exclude: ReadonlySet<string> = new Set(),
): Graph {
  const ids = [...new Set(tableIds)].filter((id) => !exclude.has(id)).sort(compareIds);
  const index = new Map(ids.map((id, i) => [id, i]));
  const pairs: [number, number][][] = ids.map(() => []);
  const max = maxCalls(links);
  for (const l of links) {
    const a = index.get(l.a);
    const b = index.get(l.b);
    if (a === undefined || b === undefined) continue;
    const w = linkWeight(l, max, source);
    if (w <= 0) continue;
    pairs[a].push([b, w]);
    pairs[b].push([a, w]);
  }
  const nbr: number[][] = [];
  const wt: number[][] = [];
  for (const list of pairs) {
    list.sort((p, q) => p[0] - q[0]);
    nbr.push(list.map((p) => p[0]));
    wt.push(list.map((p) => p[1]));
  }
  return { ids, index, nbr, wt };
}
