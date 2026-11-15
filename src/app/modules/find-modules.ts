import { HEADER_COLORS, isValidName, splitTableId, uniqueName } from "../diagram/canvas-edit";
import { type Graph, buildGraph, compareIds, linkWeight, maxCalls } from "./graph";
import { confirmHubs, hubCandidates, neighbourCounts } from "./hubs";
import { louvain, splitDisconnected } from "./louvain";
import type { ExistingGroup, FindMode, GraphSource, Link, ModuleMove, ModuleProposal, ProposedModule } from "./types";

/** Zone colours for modules: the header palette without its two greys (kept for common and other tables). */
export const MODULE_COLORS = HEADER_COLORS.slice(0, 8);

/** Minimum Jaccard overlap for a module to continue an existing group or an earlier module. */
const MIN_MATCH = 0.2;

export const RESOLUTIONS = { coarser: 0.6, normal: 1, finer: 1.6 } as const;

export interface FindInput {
  tables: readonly string[];
  links: readonly Link[];
  source: GraphSource;
  groups: readonly ExistingGroup[];
  mode: FindMode;
  resolution?: number;
  /** Tables the user made common. */
  commonAdded?: readonly string[];
  /** Detected common tables the user put back into the modules. */
  commonRemoved?: readonly string[];
  /** Modules of the proposal being replaced: matching ones keep their key, name and colour. */
  previous?: readonly ProposedModule[];
}

/** A name usable for a TableGroup and a DiagramView. */
export function isValidModuleName(name: string): boolean {
  return isValidName(name) && !/[{}]/.test(name);
}

/** Smallest module worth a zone: smaller ones join their closest neighbour. */
export function minModuleSize(tableCount: number): number {
  return tableCount >= 40 ? 3 : 2;
}

/**
 * Groups the tables into modules: Louvain communities on the link graph without the hub tables,
 * split into connected parts, with tiny ones merged into their closest neighbour. Deterministic.
 */
export function findModules(input: FindInput): ModuleProposal {
  const ids = [...new Set(input.tables)].sort(compareIds);
  const known = new Set(ids);
  const links = input.links.filter((l) => known.has(l.a) && known.has(l.b)).sort((p, q) => compareIds(p.a, q.a) || compareIds(p.b, q.b));
  const resolution = input.resolution ?? RESOLUTIONS.normal;
  const max = maxCalls(links);
  const weight = (l: Link) => linkWeight(l, max, input.source);

  const groups = input.groups.filter((g) => g.tables.some((t) => known.has(t)));
  const groupIndex = new Map<string, number>();
  groups.forEach((g, gi) => {
    for (const t of g.tables) if (known.has(t) && !groupIndex.has(t)) groupIndex.set(t, gi);
  });

  const added = new Set((input.commonAdded ?? []).filter((t) => known.has(t)));
  const removed = new Set(input.commonRemoved ?? []);
  // In extend mode the tables of existing groups stay where they are, unless made common by hand.
  const lockOf = (id: string) => (input.mode === "extend" && !added.has(id) ? (groupIndex.get(id) ?? -1) : -1);
  const minSize = minModuleSize(ids.length);
  const communities = (exclude: ReadonlySet<string>) => {
    const g = buildGraph(ids, links, input.source, exclude);
    const locked = g.ids.map(lockOf);
    return { g, comm: splitDisconnected(g, louvain(g, { locked, resolution }), (i) => locked[i] >= 0) };
  };

  // ---- common (hub) tables
  const degree = neighbourCounts(links);
  const candidates = hubCandidates(degree);
  let detected: string[] = [];
  if (candidates.length) {
    const first = communities(new Set(candidates));
    const communityOf = new Map(first.g.ids.map((id, i) => [id, first.comm[i]]));
    detected = confirmHubs(candidates, links, { communityOf, minSize, weight, degree });
  }
  const hubs = new Set([...detected.filter((t) => !removed.has(t)), ...added]);

  // ---- communities without the hubs
  const { g, comm } = communities(hubs);
  const slots = mergeSmall(g, comm, (i) => lockOf(g.ids[i]), minSize);

  // Slot of every table: a group index ("g"), a community ("c"), a hub's satellites ("s"), common, other.
  const slotOf = new Map<string, string>();
  for (const [i, s] of slots.entries()) {
    const id = g.ids[i];
    if (s.kind === "group") slotOf.set(id, `g:${s.index}`);
    else if (s.kind === "community") slotOf.set(id, `c:${s.index}`);
  }
  for (const hub of hubs) {
    const gi = lockOf(hub);
    slotOf.set(hub, gi >= 0 ? `g:${gi}` : "common");
  }
  // Tables left alone: with the hub they link to most, or other.
  const satellites = new Map<string, string[]>();
  for (const [i, s] of slots.entries()) {
    if (s.kind !== "alone") continue;
    const id = g.ids[i];
    const hub = strongestHub(id, links, hubs, weight);
    if (!hub) slotOf.set(id, "other");
    else {
      const gi = lockOf(hub);
      if (gi >= 0) slotOf.set(id, `g:${gi}`);
      else satellites.set(hub, [...(satellites.get(hub) ?? []), id]);
    }
  }
  for (const [hub, list] of satellites) for (const id of list) slotOf.set(id, list.length >= minSize ? `s:${hub}` : "other");

  // ---- modules
  const members = new Map<string, string[]>();
  for (const id of ids) {
    const s = slotOf.get(id)!;
    if (s === "common" || s === "other") continue;
    const list = members.get(s);
    if (list) list.push(id);
    else members.set(s, [id]);
  }
  const inner = innerStrength(links, slotOf, weight);
  const drafts: ProposedModule[] = [];
  for (const [slot, tables] of members) {
    const isGroup = slot.startsWith("g:");
    const group = isGroup ? groups[Number(slot.slice(2))] : null;
    const satelliteOf = slot.startsWith("s:") ? slot.slice(2) : null;
    const central = satelliteOf ?? centralTable(tables, inner);
    drafts.push({
      key: group ? group.id : `${satelliteOf ? "s" : "m"}:${central}`,
      name: group?.name ?? "",
      color: group?.color ?? "",
      tables,
      central,
      existing: group?.id ?? null,
      locked: !!group,
      added: group ? tables.filter((t) => !group.tables.includes(t)).length : 0,
      satelliteOf,
    });
  }

  matchModules(drafts, input.previous ?? [], groups, input.mode);
  nameModules(drafts, groups);
  colourModules(drafts, links, slotOf);

  const modules = drafts.sort((x, y) => y.tables.length - x.tables.length || compareIds(x.name, y.name));
  const moduleOf = new Map<string, ProposedModule>();
  for (const m of modules) for (const t of m.tables) moduleOf.set(t, m);
  const moves: ModuleMove[] = [];
  for (const id of ids) {
    const gi = groupIndex.get(id);
    if (gi === undefined) continue;
    const m = moduleOf.get(id);
    if (m?.existing === groups[gi].id) continue;
    moves.push({ table: id, from: groups[gi].name, to: m?.name ?? null });
  }
  const continued = new Set(modules.map((m) => m.existing).filter((x): x is string => !!x));
  const byDegree = (list: Iterable<string>) => [...list].sort((x, y) => (degree.get(y) ?? 0) - (degree.get(x) ?? 0) || compareIds(x, y));

  return {
    mode: input.mode,
    source: input.source,
    resolution,
    modules,
    common: byDegree([...hubs].filter((h) => slotOf.get(h) === "common")),
    detected: byDegree(detected),
    other: ids.filter((id) => slotOf.get(id) === "other"),
    moves,
    removedGroups: input.mode === "all" ? groups.map((gr) => gr.id).filter((id) => !continued.has(id)) : [],
    tableCount: ids.length,
  };
}

type Slot = { kind: "group"; index: number } | { kind: "community"; index: number } | { kind: "alone" };

/**
 * Communities smaller than `minSize` join the community they are most strongly linked to, smallest
 * first. Ones with no neighbour are left alone. Communities holding a group are never dissolved.
 */
function mergeSmall(g: Graph, comm: readonly number[], lockOf: (i: number) => number, minSize: number): Slot[] {
  const count = comm.reduce((m, c) => Math.max(m, c + 1), 0);
  const parent = Array.from({ length: count }, (_, c) => c);
  const find = (c: number): number => (parent[c] === c ? c : (parent[c] = find(parent[c])));
  const size = new Array<number>(count).fill(0);
  const lock = new Array<number>(count).fill(-1);
  comm.forEach((c, i) => {
    size[c]++;
    if (lockOf(i) >= 0) lock[c] = lockOf(i);
  });
  const membersOf = Array.from({ length: count }, () => [] as number[]);
  comm.forEach((c, i) => membersOf[c].push(i));
  const alone = new Set<number>();

  for (;;) {
    let pick = -1;
    for (let c = 0; c < count; c++) {
      if (find(c) !== c || lock[c] >= 0 || alone.has(c) || size[c] >= minSize) continue;
      if (pick < 0 || size[c] < size[pick]) pick = c;
    }
    if (pick < 0) break;
    const weightTo = new Map<number, number>();
    for (const i of membersOf[pick]) {
      for (let e = 0; e < g.nbr[i].length; e++) {
        const c = find(comm[g.nbr[i][e]]);
        if (c !== pick) weightTo.set(c, (weightTo.get(c) ?? 0) + g.wt[i][e]);
      }
    }
    let best = -1;
    for (const [c, w] of [...weightTo].sort((a, b) => a[0] - b[0])) if (best < 0 || w > weightTo.get(best)!) best = c;
    if (best < 0) {
      alone.add(pick);
      continue;
    }
    parent[pick] = best;
    size[best] += size[pick];
    membersOf[best].push(...membersOf[pick]);
  }

  return comm.map((c) => {
    const root = find(c);
    if (lock[root] >= 0) return { kind: "group", index: lock[root] };
    if (alone.has(root)) return { kind: "alone" };
    return { kind: "community", index: root };
  });
}

function strongestHub(id: string, links: readonly Link[], hubs: ReadonlySet<string>, weight: (l: Link) => number): string | null {
  let best: string | null = null;
  let bestW = 0;
  for (const l of links) {
    const other = l.a === id ? l.b : l.b === id ? l.a : null;
    if (!other || !hubs.has(other)) continue;
    const w = weight(l);
    if (w > bestW || (w === bestW && best !== null && other < best)) {
      best = other;
      bestW = w;
    }
  }
  return best;
}

/** Per table: weight and count of its links to tables in the same slot. */
function innerStrength(links: readonly Link[], slotOf: ReadonlyMap<string, string>, weight: (l: Link) => number) {
  const m = new Map<string, { w: number; n: number }>();
  const bump = (id: string, w: number) => {
    const s = m.get(id) ?? { w: 0, n: 0 };
    s.w += w;
    s.n++;
    m.set(id, s);
  };
  for (const l of links) {
    if (slotOf.get(l.a) !== slotOf.get(l.b)) continue;
    const w = weight(l);
    bump(l.a, w);
    bump(l.b, w);
  }
  return m;
}

/** The member with the highest weighted degree inside the module (then most neighbours, then id). */
function centralTable(tables: readonly string[], inner: ReadonlyMap<string, { w: number; n: number }>): string {
  let best = tables[0];
  for (const t of tables) {
    const a = inner.get(t) ?? { w: 0, n: 0 };
    const b = inner.get(best) ?? { w: 0, n: 0 };
    if (a.w > b.w + 1e-9 || (Math.abs(a.w - b.w) <= 1e-9 && (a.n > b.n || (a.n === b.n && t < best)))) best = t;
  }
  return best;
}

interface MatchTarget {
  key: string;
  name: string;
  color: string | null;
  existing: string | null;
  tables: ReadonlySet<string>;
}

/**
 * Continues earlier modules (keeping the user's renames and colours), then, in all mode, existing
 * groups: greedily by Jaccard overlap, best pairs first.
 */
function matchModules(drafts: ProposedModule[], previous: readonly ProposedModule[], groups: readonly ExistingGroup[], mode: FindMode): void {
  const free = () => drafts.filter((d) => !d.locked && !d.name);
  const claimed = new Set(drafts.map((d) => d.existing).filter((x): x is string => !!x));
  const fromPrevious: MatchTarget[] = previous
    .filter((p) => !p.locked)
    .map((p) => ({ key: p.key, name: p.name, color: p.color, existing: p.existing, tables: new Set(p.tables) }));
  assign(free(), fromPrevious, claimed);
  if (mode === "all") {
    const fromGroups: MatchTarget[] = groups
      .filter((g) => !claimed.has(g.id))
      .map((g) => ({ key: g.id, name: g.name, color: g.color, existing: g.id, tables: new Set(g.tables) }));
    assign(free(), fromGroups, claimed);
  }
  // Keys must stay unique even if an earlier key comes back on another module.
  const keys = new Set<string>();
  for (const d of drafts) {
    d.key = uniqueName(d.key, keys);
    keys.add(d.key);
  }
}

function assign(drafts: ProposedModule[], targets: MatchTarget[], claimed: Set<string>): void {
  const pairs: { d: ProposedModule; t: MatchTarget; jaccard: number; overlap: number }[] = [];
  for (const d of drafts) {
    for (const t of targets) {
      const overlap = d.tables.filter((x) => t.tables.has(x)).length;
      if (!overlap) continue;
      const jaccard = overlap / (d.tables.length + t.tables.size - overlap);
      if (jaccard >= MIN_MATCH) pairs.push({ d, t, jaccard, overlap });
    }
  }
  pairs.sort((p, q) => q.jaccard - p.jaccard || q.overlap - p.overlap || compareIds(p.t.name, q.t.name) || compareIds(p.d.key, q.d.key));
  const used = new Set<MatchTarget>();
  const done = new Set<ProposedModule>();
  for (const { d, t } of pairs) {
    if (used.has(t) || done.has(d) || (t.existing && claimed.has(t.existing))) continue;
    used.add(t);
    done.add(d);
    d.key = t.key;
    d.name = t.name;
    d.color = t.color ?? "";
    d.existing = t.existing;
    if (t.existing) claimed.add(t.existing);
  }
}

/** Unnamed modules take their central table's name, made unique against groups and other modules. */
function nameModules(drafts: ProposedModule[], groups: readonly ExistingGroup[]): void {
  const taken = new Set<string>([...groups.map((g) => g.name), ...drafts.filter((d) => d.name).map((d) => d.name)]);
  const order = drafts.filter((d) => !d.name).sort((x, y) => y.tables.length - x.tables.length || compareIds(x.key, y.key));
  for (const d of order) {
    const { schema, table } = splitTableId(d.central);
    let base = isValidModuleName(table) ? table.trim() : "module";
    if (taken.has(base) && schema !== "public" && isValidModuleName(`${schema}_${base}`)) base = `${schema}_${base}`;
    d.name = uniqueName(base, taken);
    taken.add(d.name);
  }
}

/** Modules without a colour get the least used one that no linked module has. */
function colourModules(drafts: ProposedModule[], links: readonly Link[], slotOf: ReadonlyMap<string, string>): void {
  const moduleOf = new Map<string, ProposedModule>();
  for (const d of drafts) for (const t of d.tables) moduleOf.set(t, d);
  const near = new Map<ProposedModule, Set<ProposedModule>>();
  for (const l of links) {
    if (slotOf.get(l.a) === slotOf.get(l.b)) continue;
    const a = moduleOf.get(l.a);
    const b = moduleOf.get(l.b);
    if (!a || !b) continue;
    (near.get(a) ?? near.set(a, new Set()).get(a)!).add(b);
    (near.get(b) ?? near.set(b, new Set()).get(b)!).add(a);
  }
  const used = new Map<string, number>();
  for (const d of drafts) if (d.color) used.set(d.color, (used.get(d.color) ?? 0) + 1);
  const order = drafts.filter((d) => !d.color).sort((x, y) => y.tables.length - x.tables.length || compareIds(x.key, y.key));
  for (const d of order) {
    const taken = new Set([...(near.get(d) ?? [])].map((n) => n.color).filter(Boolean));
    const options = MODULE_COLORS.filter((c) => !taken.has(c));
    const pool = options.length ? options : MODULE_COLORS;
    let best = pool[0];
    for (const c of pool) if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
    d.color = best;
    used.set(best, (used.get(best) ?? 0) + 1);
  }
}
