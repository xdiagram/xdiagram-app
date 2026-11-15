import type { Graph } from "./graph";

/**
 * Deterministic Louvain community detection (modularity, resolution γ) with locked nodes.
 *
 * Nodes are visited in index order and candidate communities in ascending order, and a node moves
 * only for a strictly better gain, so the same graph always gives the same communities. Nodes with
 * `locked[i] >= 0` belong to that existing group: they never move, and two groups never merge,
 * but other nodes may join a group.
 */
export interface LouvainOptions {
  /** Per node: the index of the existing group it belongs to, or -1. */
  locked?: ArrayLike<number>;
  /** Higher gives more, smaller communities. */
  resolution?: number;
}

const EPS = 1e-12;
const MAX_PASSES = 50;
const MAX_LEVELS = 20;

interface Level {
  n: number;
  nbr: number[][];
  wt: number[][];
  /** Weight of the edges inside each node (aggregated levels). */
  self: number[];
  lock: number[];
}

/** Community of every node, numbered 0… in the order of each community's first node. */
export function louvain(g: Graph, opts: LouvainOptions = {}): number[] {
  const n = g.ids.length;
  const gamma = opts.resolution ?? 1;
  const lock = Array.from({ length: n }, (_, i) => (opts.locked ? opts.locked[i] : -1));
  let level: Level = { n, nbr: g.nbr, wt: g.wt, self: new Array(n).fill(0), lock };
  // Community of each original node, as a node of the current level.
  let assignment = Array.from({ length: n }, (_, i) => i);
  // Groups start as one community each, so a group's tables are aggregated before anything else.
  const start = groupStart(lock);
  if (start.some((c, i) => c !== i)) {
    level = aggregate(level, start);
    assignment = assignment.map((v) => start[v]);
  }

  for (let depth = 0; depth < MAX_LEVELS; depth++) {
    const { comm, moved } = moveNodes(level, gamma);
    if (!moved) break;
    const renumbered = renumber(comm);
    const next = aggregate(level, renumbered);
    assignment = assignment.map((v) => renumbered[v]);
    if (next.n === level.n) break;
    level = next;
  }
  return renumber(assignment);
}

/** Locked nodes of the same group in one community, everything else alone (labels 0…k-1). */
function groupStart(lock: readonly number[]): number[] {
  const firstOfGroup = new Map<number, number>();
  const comm = lock.map((g, i) => {
    if (g < 0) return i;
    const first = firstOfGroup.get(g);
    if (first !== undefined) return first;
    firstOfGroup.set(g, i);
    return i;
  });
  return renumber(comm);
}

function degrees(level: Level): number[] {
  return level.nbr.map((_, i) => level.wt[i].reduce((s, w) => s + w, 0) + 2 * level.self[i]);
}

/** Local moving phase: each free node goes to the neighbouring community with the best modularity gain. */
function moveNodes(level: Level, gamma: number): { comm: number[]; moved: boolean } {
  const { n, nbr, wt, lock } = level;
  const comm = Array.from({ length: n }, (_, i) => i);
  const k = degrees(level);
  const m2 = k.reduce((s, x) => s + x, 0);
  if (m2 === 0) return { comm, moved: false };
  const tot = [...k];
  const weightTo = new Map<number, number>();
  let moved = false;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let movedThisPass = false;
    for (let i = 0; i < n; i++) {
      if (lock[i] >= 0) continue;
      weightTo.clear();
      for (let e = 0; e < nbr[i].length; e++) {
        const c = comm[nbr[i][e]];
        weightTo.set(c, (weightTo.get(c) ?? 0) + wt[i][e]);
      }
      const own = comm[i];
      tot[own] -= k[i];
      let best = own;
      let bestGain = (weightTo.get(own) ?? 0) - (gamma * tot[own] * k[i]) / m2;
      for (const c of [...weightTo.keys()].sort((a, b) => a - b)) {
        if (c === own) continue;
        // A community holding a locked node is that group's; a free node may join it.
        const gain = weightTo.get(c)! - (gamma * tot[c] * k[i]) / m2;
        if (gain > bestGain + EPS) {
          best = c;
          bestGain = gain;
        }
      }
      tot[best] += k[i];
      if (best !== own) {
        comm[i] = best;
        moved = true;
        movedThisPass = true;
      }
    }
    if (!movedThisPass) break;
  }
  return { comm, moved };
}

/** Renumbers labels 0… by first appearance. */
function renumber(labels: readonly number[]): number[] {
  const ids = new Map<number, number>();
  return labels.map((c) => {
    let id = ids.get(c);
    if (id === undefined) {
      id = ids.size;
      ids.set(c, id);
    }
    return id;
  });
}

/** One node per community (labels must be 0…k-1), with its inner weight as a self-loop. */
function aggregate(level: Level, comm: readonly number[]): Level {
  const size = comm.reduce((m, c) => Math.max(m, c + 1), 0);
  const self = new Array<number>(size).fill(0);
  const lock = new Array<number>(size).fill(-1);
  const edges: Map<number, number>[] = Array.from({ length: size }, () => new Map());
  for (let i = 0; i < level.n; i++) {
    const ci = comm[i];
    self[ci] += level.self[i];
    if (level.lock[i] >= 0) lock[ci] = level.lock[i];
    for (let e = 0; e < level.nbr[i].length; e++) {
      const j = level.nbr[i][e];
      if (j < i) continue; // each undirected edge once
      const cj = comm[j];
      const w = level.wt[i][e];
      if (ci === cj) self[ci] += w;
      else {
        edges[ci].set(cj, (edges[ci].get(cj) ?? 0) + w);
        edges[cj].set(ci, (edges[cj].get(ci) ?? 0) + w);
      }
    }
  }
  const nbr: number[][] = [];
  const wt: number[][] = [];
  for (const m of edges) {
    const list = [...m].sort((a, b) => a[0] - b[0]);
    nbr.push(list.map((p) => p[0]));
    wt.push(list.map((p) => p[1]));
  }
  return { n: size, nbr, wt, self, lock };
}

/**
 * Splits each community into its connected parts, so a module never holds tables with no path
 * between them inside it (Leiden's guarantee, approximated). Communities that hold an existing
 * group are kept whole: the user may have grouped unrelated tables on purpose.
 */
export function splitDisconnected(g: Graph, comm: readonly number[], isLocked: (i: number) => boolean): number[] {
  const n = g.ids.length;
  const keepWhole = new Set<number>();
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (isLocked(i)) keepWhole.add(comm[i]);
    const list = members.get(comm[i]) ?? [];
    list.push(i);
    members.set(comm[i], list);
  }
  const label = new Array<number>(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0) continue;
    const id = next++;
    if (keepWhole.has(comm[i])) {
      for (const j of members.get(comm[i])!) label[j] = id;
      continue;
    }
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const v = stack.pop()!;
      for (const u of g.nbr[v]) {
        if (label[u] < 0 && comm[u] === comm[i]) {
          label[u] = id;
          stack.push(u);
        }
      }
    }
  }
  return label;
}
