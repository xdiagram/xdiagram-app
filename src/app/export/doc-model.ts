import type { Database } from "@dbml/core";

import type { FkCardinality, FkUsage, TableFacts, WorkloadReport } from "../core/tauri-api.service";
import { refKey, type ViewModel } from "../diagram/view-model";

/** Everything the documentation renderers need, independent of the DBML library's classes. */
export interface DocColumn {
  name: string;
  type: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  defaultValue: string | null;
  note: string | null;
  /** `schema.table(column)` this column references. */
  references: { table: string; columns: string[] }[];
  checks: string[];
  enumValues: string[] | null;
  cardinality: FkCardinality | null;
}

export interface DocIndex {
  name: string | null;
  columns: string[];
  unique: boolean;
  pk: boolean;
  type: string | null;
}

export interface DocTable {
  id: string;
  schema: string;
  name: string;
  label: string;
  note: string | null;
  group: string | null;
  columns: DocColumn[];
  indexes: DocIndex[];
  checks: { name: string | null; expression: string }[];
  /** Tables that reference this one. */
  referencedBy: { table: string; columns: string[]; toColumns: string[] }[];
  facts: TableFacts | null;
  /** How often each outgoing FK is joined in the recorded workload (X-ray). */
  fkUsage: { columns: string[]; target: string; calls: number }[];
}

export interface DocEnum {
  id: string;
  name: string;
  note: string | null;
  values: { name: string; note: string | null }[];
}

export interface DocRelation {
  from: { table: string; columns: string[]; many: boolean };
  to: { table: string; columns: string[]; many: boolean };
  name: string | null;
}

export interface DocModel {
  title: string;
  source: string | null;
  generatedAt: string;
  tables: DocTable[];
  enums: DocEnum[];
  relations: DocRelation[];
  groups: { name: string; tables: string[] }[];
  xray: { statements: number; available: boolean } | null;
}

type Loose = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function buildDocModel(
  db: Database,
  view: ViewModel,
  options: { title: string; source: string | null; report?: WorkloadReport | null; now?: Date },
): DocModel {
  const report = options.report ?? null;
  const facts = new Map((report?.tables ?? []).map((t) => [`${t.schema}.${t.table}`, t]));
  const cardinality = new Map((report?.cardinality ?? []).map((c) => [`${c.schema}.${c.table}.${c.column}`, c]));
  const usage = new Map<string, FkUsage>();
  for (const u of report?.declaredUsage ?? []) {
    usage.set(
      refKey({ table: `${u.from.schema}.${u.from.table}`, fields: u.from.columns, many: false }, { table: `${u.to.schema}.${u.to.table}`, fields: u.to.columns, many: false }),
      u,
    );
  }

  // Enums, keyed by `schema.name` and by bare name (columns may reference either).
  const enums: DocEnum[] = [];
  const enumValues = new Map<string, string[]>();
  for (const schema of db.schemas) {
    for (const e of schema.enums as unknown as Loose[]) {
      const values = ((e["values"] as Loose[]) ?? []).map((v) => ({ name: String(v["name"]), note: str(v["note"]) }));
      const id = `${schema.name}.${e["name"]}`;
      enums.push({ id, name: String(e["name"]), note: str(e["note"]), values });
      enumValues.set(id, values.map((v) => v.name));
    }
  }

  const rawTables = new Map<string, Loose>();
  for (const schema of db.schemas) for (const t of schema.tables) rawTables.set(`${schema.name}.${t.name}`, t as unknown as Loose);

  const tables: DocTable[] = view.tables.map((vt) => {
    const raw = rawTables.get(vt.id) ?? {};
    const rawFields = new Map(((raw["fields"] as Loose[]) ?? []).map((f) => [String(f["name"]), f]));
    const outgoing = view.refs.filter((r) => r.from.table === vt.id);
    const columns: DocColumn[] = vt.fields.map((f) => {
      const rf = rawFields.get(f.name) ?? {};
      const type = rf["type"] as Loose | undefined;
      const enumKey = type ? `${type["schemaName"] ?? vt.schema}.${type["type_name"]}` : "";
      return {
        name: f.name,
        type: f.type,
        pk: f.pk,
        unique: f.unique,
        notNull: f.notNull,
        increment: f.increment,
        defaultValue: f.defaultValue,
        note: f.note,
        references: outgoing.filter((r) => r.from.fields.includes(f.name)).map((r) => ({ table: r.to.table, columns: r.to.fields })),
        checks: ((rf["checks"] as Loose[]) ?? []).map((c) => String(c["expression"] ?? "")).filter(Boolean),
        enumValues: f.isEnum ? (enumValues.get(enumKey) ?? enumValues.get(`public.${type?.["type_name"]}`) ?? null) : null,
        cardinality: cardinality.get(`${vt.id}.${f.name}`) ?? null,
      };
    });
    const indexes: DocIndex[] = ((raw["indexes"] as Loose[]) ?? []).map((ix) => ({
      name: str(ix["name"]),
      columns: ((ix["columns"] as Loose[]) ?? []).map((c) => (c["type"] === "expression" ? `\`${c["value"]}\`` : String(c["value"]))),
      unique: !!ix["unique"],
      pk: !!ix["pk"],
      type: str(ix["type"]),
    }));
    return {
      id: vt.id,
      schema: vt.schema,
      name: vt.name,
      label: vt.label,
      note: vt.note,
      group: view.groups.find((g) => g.tables.includes(vt.id))?.name ?? null,
      columns,
      indexes,
      checks: ((raw["checks"] as Loose[]) ?? []).map((c) => ({ name: str(c["name"]), expression: String(c["expression"] ?? "") })),
      referencedBy: view.refs
        .filter((r) => r.to.table === vt.id)
        .map((r) => ({ table: r.from.table, columns: r.from.fields, toColumns: r.to.fields })),
      facts: facts.get(vt.id) ?? null,
      fkUsage: report?.available
        ? outgoing.map((r) => ({ columns: r.from.fields, target: r.to.table, calls: usage.get(refKey(r.from, r.to))?.calls ?? 0 }))
        : [],
    };
  });

  return {
    title: options.title,
    source: options.source,
    generatedAt: (options.now ?? new Date()).toISOString(),
    tables,
    enums,
    relations: view.refs.map((r) => ({
      from: { table: r.from.table, columns: r.from.fields, many: r.from.many },
      to: { table: r.to.table, columns: r.to.fields, many: r.to.many },
      name: r.name,
    })),
    groups: view.groups.map((g) => ({ name: g.name, tables: g.tables })),
    xray: report ? { statements: report.statements.parsed, available: report.available } : null,
  };
}

/** `table` for the default schema, `schema.table` otherwise. */
export function displayId(id: string): string {
  return id.startsWith("public.") ? id.slice("public.".length) : id;
}

/** Stable anchor id for a table section. */
export function anchorOf(id: string): string {
  return `t-${id.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

export function constraintsOf(c: DocColumn): string[] {
  const out: string[] = [];
  if (c.pk) out.push("PK");
  if (c.references.length) out.push("FK");
  if (c.unique) out.push("unique");
  if (c.notNull && !c.pk) out.push("not null");
  if (c.increment) out.push("auto-increment");
  return out;
}
