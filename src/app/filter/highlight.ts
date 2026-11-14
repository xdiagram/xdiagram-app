import { type FilterNode, SEARCH_COLUMN } from "./model";

export interface Segment {
  text: string;
  hit: boolean;
}

/** `value` split around every occurrence of any of `terms` (longest match first, case as asked). */
export function segments(value: string, terms: string[], cs = false): Segment[] {
  const wanted = [...new Set(terms.filter((t) => t.length > 0))].sort((a, b) => b.length - a.length);
  if (!wanted.length) return [{ text: value, hit: false }];
  const hay = cs ? value : value.toLowerCase();
  const needles = cs ? wanted : wanted.map((t) => t.toLowerCase());
  const out: Segment[] = [];
  let i = 0;
  let plain = 0;
  while (i < value.length) {
    const n = needles.find((t) => hay.startsWith(t, i));
    if (!n) {
      i++;
      continue;
    }
    if (i > plain) out.push({ text: value.slice(plain, i), hit: false });
    out.push({ text: value.slice(i, i + n.length), hit: true });
    i += n.length;
    plain = i;
  }
  if (plain < value.length) out.push({ text: value.slice(plain), hit: false });
  return out;
}

/** What to highlight: per column (its contains / starts / ends values) and everywhere (searches). */
export function highlightTerms(node: FilterNode | null): { all: string[]; byColumn: Map<string, string[]> } {
  const all: string[] = [];
  const byColumn = new Map<string, string[]>();
  const walk = (n: FilterNode) => {
    if (n.off) return;
    if (n.t === "group") {
      if (!n.not) n.items.forEach(walk);
      return;
    }
    const v = n.args[0];
    if (typeof v !== "string" || !v) return;
    if (n.column === SEARCH_COLUMN) all.push(v);
    else if (n.op === "contains" || n.op === "startsWith" || n.op === "endsWith" || n.op === "eq") byColumn.set(n.column, [...(byColumn.get(n.column) ?? []), v]);
  };
  if (node) walk(node);
  return { all, byColumn };
}
