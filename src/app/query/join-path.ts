import type { VRef } from "../diagram/view-model";

/**
 * Join paths for the query builder: the chosen tables are connected along relationships with the
 * fewest hops. Declared relationships are preferred to the ones X-ray found in queries.
 */

export interface JoinStep {
  /** Table being joined. */
  table: string;
  /** Table already in the query that it joins to. */
  parent: string;
  ref: VRef;
  /** `[parent column, joined column]` pairs. */
  on: [string, string][];
}

export interface JoinPlan {
  /** Every table in the query, root first, in join order (bridges included). */
  tables: string[];
  steps: JoinStep[];
  refIds: Set<string>;
  /** Chosen tables no relationship path reaches. */
  unreachable: string[];
}

interface Edge {
  to: string;
  ref: VRef;
  weight: number;
  on: [string, string][];
}

function graph(refs: VRef[]): Map<string, Edge[]> {
  const g = new Map<string, Edge[]>();
  const add = (from: string, e: Edge) => g.set(from, [...(g.get(from) ?? []), e]);
  for (const r of refs) {
    if (r.from.table === r.to.table || r.from.fields.length !== r.to.fields.length) continue;
    const weight = r.discovered ? 1.5 : 1;
    const pairs = r.from.fields.map((f, i) => [f, r.to.fields[i]] as [string, string]);
    add(r.from.table, { to: r.to.table, ref: r, weight, on: pairs });
    add(r.to.table, { to: r.from.table, ref: r, weight, on: pairs.map(([a, b]) => [b, a] as [string, string]) });
  }
  return g;
}

export function planJoins(selected: string[], refs: VRef[]): JoinPlan {
  const chosen = [...new Set(selected)];
  const plan: JoinPlan = { tables: [], steps: [], refIds: new Set(), unreachable: [] };
  if (!chosen.length) return plan;
  const g = graph(refs);
  const tree = new Set([chosen[0]]);
  plan.tables.push(chosen[0]);
  let remaining = chosen.slice(1);

  while (remaining.length) {
    // Shortest paths from the whole tree at once (small graphs: a linear scan is fine).
    const dist = new Map<string, number>([...tree].map((t) => [t, 0]));
    const prev = new Map<string, { node: string; edge: Edge }>();
    const done = new Set<string>();
    for (;;) {
      let node: string | null = null;
      for (const [n, d] of dist) if (!done.has(n) && (node === null || d < dist.get(node)!)) node = n;
      if (node === null) break;
      done.add(node);
      for (const e of g.get(node) ?? []) {
        const d = dist.get(node)! + e.weight;
        if (d < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, d);
          prev.set(e.to, { node, edge: e });
        }
      }
    }
    const reachable = remaining.filter((t) => dist.has(t));
    if (!reachable.length) {
      plan.unreachable = remaining;
      break;
    }
    const target = reachable.reduce((best, t) => (dist.get(t)! < dist.get(best)! ? t : best));
    const path: JoinStep[] = [];
    for (let n = target; !tree.has(n); ) {
      const p = prev.get(n)!;
      path.unshift({ table: n, parent: p.node, ref: p.edge.ref, on: p.edge.on });
      n = p.node;
    }
    for (const step of path) {
      tree.add(step.table);
      plan.tables.push(step.table);
      plan.steps.push(step);
      plan.refIds.add(step.ref.id);
    }
    remaining = remaining.filter((t) => !tree.has(t));
  }
  return plan;
}

const SHORT_WORDS = new Set(["as", "at", "by", "do", "go", "if", "in", "is", "no", "of", "on", "or", "to", "all", "and", "any", "asc", "end", "for", "key", "not", "set", "top", "use"]);

/** Short SQL aliases from table names: `project_members` → `pm`, clashes get a number. */
export function makeAliases(tableIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const id of tableIds) {
    const name = id.slice(id.indexOf(".") + 1);
    const words = name.split(/[_\s]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
    let base = words.map((w) => w[0]).join("").toLowerCase().replace(/[^a-z0-9_]/g, "") || "t";
    if (!/^[a-z_]/.test(base)) base = `t${base}`;
    if (SHORT_WORDS.has(base)) base = `${base}_`;
    let alias = base;
    for (let n = 2; used.has(alias); n++) alias = `${base}${n}`;
    used.add(alias);
    out.set(id, alias);
  }
  return out;
}
