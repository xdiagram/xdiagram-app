import { displayTable } from "../diagram/view-model";
import { fuzzyFilter } from "../palette/fuzzy";

/** A join path typed in the palette: the start and, once the arrow is typed, the end. */
export interface PathQuery {
  from: string;
  /** Null until an arrow is typed; "" right after it. */
  to: string | null;
}

const ARROW = /\s*(?:→|->|=>|>)\s*/;

/**
 * `path orders → users`, `path: orders -> users`, `orders > users`, or just `path orders` (the
 * start only). Null when the text is not a path query (the palette searches as usual).
 */
export function parsePathQuery(text: string): PathQuery | null {
  const prefixed = /^\s*path\b:?\s*(.*)$/i.exec(text);
  const body = prefixed ? prefixed[1] : text;
  const parts = body.split(ARROW);
  if (parts.length === 2) return { from: parts[0].trim(), to: parts[1].trim() };
  if (prefixed && parts.length === 1 && parts[0].trim()) return { from: parts[0].trim(), to: null };
  return null;
}

export interface PathCandidate {
  from: string;
  to: string;
}

/** Tables matching a typed name, best first. */
export function matchTables(text: string, tableIds: readonly string[], limit: number): { id: string; score: number }[] {
  return fuzzyFilter(text, [...tableIds], displayTable, limit).map((r) => ({ id: r.item, score: r.match.score }));
}

/**
 * The (start, end) pairs a path query stands for, best first: the best few matches of each side
 * combined by their scores. With the end not typed yet, every other table (by name) is offered.
 */
export function pathCandidates(q: PathQuery, tableIds: readonly string[], limit = 8): PathCandidate[] {
  if (!q.from || q.to === null) return [];
  const froms = matchTables(q.from, tableIds, 3);
  const tos = q.to
    ? matchTables(q.to, tableIds, 3)
    : [...tableIds].sort((a, b) => displayTable(a).localeCompare(displayTable(b))).map((id) => ({ id, score: 0 }));
  const pairs: (PathCandidate & { score: number })[] = [];
  for (const f of froms) {
    for (const t of tos) {
      // From a table to itself only when both sides were typed (its self-references).
      if (f.id === t.id && !q.to) continue;
      pairs.push({ from: f.id, to: t.id, score: f.score + t.score });
    }
  }
  return pairs
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ from, to }) => ({ from, to }));
}
