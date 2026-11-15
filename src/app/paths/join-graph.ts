import type { Engine, Multiplicity, PathDialect, SchemaEdge, SchemaGraph } from "../core/tauri-api.service";
import { type VEndpoint, type ViewModel, refKey } from "../diagram/view-model";
import type { TrafficReport } from "../modules/graph";
import type { SqlDialect } from "../export/type-map";

/**
 * The graph the join-path engine searches (src-tauri/crates/join-paths): every table of the
 * document, hidden ones included, the declared relationships, and, when a traffic report is
 * already loaded (X-ray, or Find modules), the joins seen in the queries. Nothing is read from
 * the database here.
 */
export function buildJoinGraph(view: ViewModel, report: TrafficReport | null, opts: { discovered?: boolean } = {}): SchemaGraph {
  const tables = view.tables.map((t) => ({ id: t.id, schema: t.schema, name: t.name }));
  const columns = new Map(view.tables.map((t) => [t.id, new Set(t.fields.map((f) => f.name))]));
  const traffic = report?.available ? report : null;
  const fkCalls = new Map<string, number>();
  for (const u of traffic?.declaredUsage ?? []) {
    const key = refKey(endpoint(u.from), endpoint(u.to));
    fkCalls.set(key, (fkCalls.get(key) ?? 0) + u.calls);
  }

  const edges: SchemaEdge[] = [];
  const declared = new Set<string>();
  for (const r of view.refs) {
    const pairs = zip(r.from.fields, r.to.fields);
    if (!pairs) continue;
    const key = refKey(r.from, r.to);
    declared.add(key);
    edges.push({
      id: r.id,
      from: r.from.table,
      to: r.to.table,
      pairs,
      kind: "declared",
      fromMult: mult(r.from.many),
      toMult: mult(r.to.many),
      calls: fkCalls.get(key) ?? 0,
    });
  }

  if (opts.discovered !== false) {
    for (const rel of traffic?.relations ?? []) {
      const from = endpoint(rel.from);
      const to = endpoint(rel.to);
      const pairs = zip(from.fields, to.fields);
      const has = (e: VEndpoint) => e.fields.every((f) => columns.get(e.table)?.has(f));
      if (!pairs || !has(from) || !has(to) || declared.has(refKey(from, to))) continue;
      edges.push({
        // The id X-ray's overlay gives the same join, so the canvas can highlight it.
        id: `discovered:${from.table}(${from.fields.join(",")})->${to.table}(${to.fields.join(",")})`,
        from: from.table,
        to: to.table,
        pairs,
        kind: "discovered",
        fromMult: rel.directed ? "many" : "unknown",
        toMult: rel.directed ? "one" : "unknown",
        calls: rel.calls,
      });
    }
  }
  return { tables, edges };
}

function endpoint(e: { schema: string; table: string; columns: string[] }): VEndpoint {
  return { table: `${e.schema}.${e.table}`, fields: e.columns, many: false };
}

function mult(many: boolean): Multiplicity {
  return many ? "many" : "one";
}

/** Column pairs by position; null when the two sides do not match. */
function zip(from: string[], to: string[]): { from: string; to: string }[] | null {
  if (!from.length || from.length !== to.length) return null;
  return from.map((f, i) => ({ from: f, to: to[i] }));
}

const PATH_DIALECTS: readonly PathDialect[] = ["postgres", "mysql", "mssql", "sqlite"];

/**
 * Quoting for the copied SQL: a database's own engine; a file imported from MySQL, SQL Server or
 * SQLite keeps that dialect; anything else (a .dbml file, PostgreSQL, Oracle…) gets PostgreSQL's
 * standard double quotes.
 */
export function pathDialectOf(source: { kind: "db"; engine: Engine } | { kind: "file"; dialect?: SqlDialect } | null): PathDialect {
  if (source?.kind === "db") return source.engine;
  const d = source?.dialect;
  return d && (PATH_DIALECTS as readonly string[]).includes(d) ? (d as PathDialect) : "postgres";
}

export const PATH_DIALECT_LABEL: Record<PathDialect, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mssql: "SQL Server",
  sqlite: "SQLite",
};
