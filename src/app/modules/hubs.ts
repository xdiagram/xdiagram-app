import { compareIds } from "./graph";
import type { Link } from "./types";

/** Below this many linked tables nothing is treated as a hub: small schemas have none worth removing. */
export const MIN_TABLES_FOR_HUBS = 12;
/** A table needs at least this many distinct neighbours to be a hub. */
const MIN_HUB_DEGREE = 6;
/** At most this share of the linked tables can be hubs (but always two). */
const MAX_HUB_SHARE = 0.1;
/** A candidate with this share of its link weight in one module is that module's centre, not a hub. */
const CENTRE_SHARE = 0.5;

/** Distinct neighbours of every linked table. */
export function neighbourCounts(links: readonly Link[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of links) {
    m.set(l.a, (m.get(l.a) ?? 0) + 1);
    m.set(l.b, (m.get(l.b) ?? 0) + 1);
  }
  return m;
}

/** Quantile of ascending values, interpolated linearly between ranks. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Tables linked to far more tables than the rest: at least `max(6, Q3 + 3·IQR, 3·median)` distinct
 * neighbours. Most linked first, capped at a tenth of the linked tables (at least two).
 */
export function hubCandidates(degrees: ReadonlyMap<string, number>): string[] {
  const linked = [...degrees].filter(([, d]) => d > 0);
  if (linked.length < MIN_TABLES_FOR_HUBS) return [];
  const values = linked.map(([, d]) => d).sort((a, b) => a - b);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const median = quantile(values, 0.5);
  const threshold = Math.max(MIN_HUB_DEGREE, q3 + 3 * (q3 - q1), 3 * median);
  const cap = Math.max(2, Math.floor(linked.length * MAX_HUB_SHARE));
  return linked
    .filter(([, d]) => d >= threshold)
    .sort((x, y) => y[1] - x[1] || compareIds(x[0], y[0]))
    .slice(0, cap)
    .map(([id]) => id);
}

export interface HubCheck {
  /** Community of every table that is not a candidate, from a run without the candidates. */
  communityOf: ReadonlyMap<string, number>;
  /** Communities smaller than this are fragments. */
  minSize: number;
  weight: (l: Link) => number;
  degree: ReadonlyMap<string, number>;
}

/**
 * Keeps the candidates that link modules together and drops the module centres (a `products`
 * table with its children). Without the candidates, a centre's children fall apart into
 * fragments: each fragment is given to the candidate it links to most (ties to the less linked,
 * more specific one). A candidate with at least half of its link weight in one module (its own
 * fragments, or a community) is that module's centre.
 */
export function confirmHubs(candidates: readonly string[], links: readonly Link[], check: HubCheck): string[] {
  const isCandidate = new Set(candidates);
  const size = new Map<number, number>();
  for (const c of check.communityOf.values()) size.set(c, (size.get(c) ?? 0) + 1);
  const isFragment = (c: number) => (size.get(c) ?? 0) < check.minSize;

  // Weight from each fragment to each candidate.
  const toCandidate = new Map<number, Map<string, number>>();
  for (const l of links) {
    for (const [cand, other] of [
      [l.a, l.b],
      [l.b, l.a],
    ]) {
      if (!isCandidate.has(cand)) continue;
      const c = check.communityOf.get(other);
      if (c === undefined || !isFragment(c)) continue;
      const m = toCandidate.get(c) ?? new Map<string, number>();
      m.set(cand, (m.get(cand) ?? 0) + check.weight(l));
      toCandidate.set(c, m);
    }
  }
  const owner = new Map<number, string>();
  for (const [c, m] of toCandidate) {
    let best: string | null = null;
    for (const [cand, w] of m) {
      if (best === null) best = cand;
      const bw = m.get(best)!;
      const fewer = (check.degree.get(cand) ?? 0) < (check.degree.get(best) ?? 0);
      const same = (check.degree.get(cand) ?? 0) === (check.degree.get(best) ?? 0);
      if (w > bw || (w === bw && (fewer || (same && cand < best)))) best = cand;
    }
    if (best) owner.set(c, best);
  }

  const buckets = new Map<string, Map<string, number>>();
  for (const l of links) {
    for (const [cand, other] of [
      [l.a, l.b],
      [l.b, l.a],
    ]) {
      if (!isCandidate.has(cand)) continue;
      const c = check.communityOf.get(other);
      if (c === undefined) continue; // another candidate
      const key = isFragment(c) ? `own:${owner.get(c)}` : `module:${c}`;
      const m = buckets.get(cand) ?? new Map<string, number>();
      m.set(key, (m.get(key) ?? 0) + check.weight(l));
      buckets.set(cand, m);
    }
  }
  return candidates.filter((cand) => {
    const m = buckets.get(cand);
    if (!m) return true;
    let total = 0;
    let top = 0;
    for (const w of m.values()) {
      total += w;
      top = Math.max(top, w);
    }
    return total === 0 || top / total < CENTRE_SHARE;
  });
}
