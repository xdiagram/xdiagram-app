import type { Database, Endpoint, Field, Table } from "@dbml/core";

/** Same rule as `@dbml/parse`'s `isEndpointManySide`: the upper bound is unbounded (`*`, `0..*`, `1..*`). */
function isEndpointManySide(relation: unknown): boolean {
  const r = String(relation ?? "");
  return r === "*" || r.endsWith("..*");
}

/** Flattened, render-ready view of a parsed DBML `Database`. */
export interface VField {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  isEnum: boolean;
  defaultValue: string | null;
  note: string | null;
  /** Offset of the column declaration in the DBML text (last successful parse). */
  offset: number | null;
}

export interface VTable {
  /** `schema.table` — stable key for positions and visibility. */
  id: string;
  schema: string;
  name: string;
  /** Name shown in the header: schema-qualified unless it is the default schema. */
  label: string;
  headerColor: string | null;
  note: string | null;
  groupId: string | null;
  fields: VField[];
  /** Primary-key columns in key order: a `[pk]` index (composite keys), else the `pk` fields. */
  primaryKey: string[];
  /** 1-based source line of the table definition, for "reveal in editor". */
  line: number | null;
  /** Offset just after the table block's closing brace (last successful parse). */
  endOffset: number | null;
}

/** A `DiagramView` block from the DBML: a named subset of tables (`null` = all tables). */
export interface VView {
  name: string;
  tables: string[] | null;
}

export interface VEndpoint {
  table: string;
  fields: string[];
  many: boolean;
}

/** Present on relationships found in the query workload (X-ray mode) rather than in the DBML. */
export interface DiscoveredInfo {
  calls: number;
  statements: number;
  /** False when neither side could be identified as the referenced one. */
  directed: boolean;
  queries: { calls: number; meanMs: number | null; text: string }[];
}

export interface VRef {
  id: string;
  name: string | null;
  /** The referencing (foreign-key) side. */
  from: VEndpoint;
  /** The referenced side. */
  to: VEndpoint;
  onDelete: string | null;
  onUpdate: string | null;
  discovered?: DiscoveredInfo;
}

/** Table id without the default-schema prefix, for compact display. */
export function displayTable(id: string): string {
  return id.startsWith(`${DEFAULT_SCHEMA}.`) ? id.slice(DEFAULT_SCHEMA.length + 1) : id;
}

/** Order-independent key of a relationship's endpoints, for matching declared and discovered refs. */
export function refKey(from: VEndpoint, to: VEndpoint): string {
  const side = (e: VEndpoint) => `${e.table}(${[...e.fields].sort().join(",")})`;
  const [a, b] = [side(from), side(to)].sort();
  return `${a}|${b}`;
}

/** The given table(s) plus every table one relationship away from any of them, in either direction. */
export function relatedTables(refs: readonly VRef[], ids: string | readonly string[] | ReadonlySet<string>): Set<string> {
  const seeds: ReadonlySet<string> = typeof ids === "string" ? new Set([ids]) : new Set(ids);
  const near = new Set(seeds);
  for (const r of refs) {
    if (seeds.has(r.from.table)) near.add(r.to.table);
    if (seeds.has(r.to.table)) near.add(r.from.table);
  }
  return near;
}

export interface VGroup {
  id: string;
  name: string;
  color: string | null;
  tables: string[];
}

export interface ViewModel {
  tables: VTable[];
  refs: VRef[];
  groups: VGroup[];
  views: VView[];
}

export const EMPTY_VIEW: ViewModel = { tables: [], refs: [], groups: [], views: [] };

const DEFAULT_SCHEMA = "public";

export function tableId(table: Table): string {
  return `${table.schema?.name ?? DEFAULT_SCHEMA}.${table.name}`;
}

function typeLabel(field: Field): string {
  const t = field.type as { type_name?: string; schemaName?: string | null } | undefined;
  const name = t?.type_name ?? String(field.type ?? "");
  return t?.schemaName && t.schemaName !== DEFAULT_SCHEMA ? `${t.schemaName}.${name}` : name;
}

function defaultLabel(field: Field): string | null {
  const d = field.dbdefault as { type?: string; value?: unknown } | null | undefined;
  if (!d || d.value === undefined || d.value === null) return null;
  return d.type === "string" ? `'${d.value}'` : String(d.value);
}

type Tokened = { token?: { start?: { line?: number; offset?: number }; end?: { offset?: number } } };

function tokenLine(el: unknown): number | null {
  return (el as Tokened).token?.start?.line ?? null;
}

function tokenStart(el: unknown): number | null {
  return (el as Tokened).token?.start?.offset ?? null;
}

function tokenEnd(el: unknown): number | null {
  return (el as Tokened).token?.end?.offset ?? null;
}

function endpointTable(ep: Endpoint): Table | null {
  return ep.fields?.[0]?.table ?? null;
}

/**
 * Decides which endpoint is the foreign-key side: the "many" side when there is exactly one;
 * otherwise (1-1, many-many) the side that is not purely primary-key columns; else the first.
 */
function orientRef(a: Endpoint, b: Endpoint): [Endpoint, Endpoint] {
  const aMany = isEndpointManySide(a.relation);
  const bMany = isEndpointManySide(b.relation);
  if (aMany !== bMany) return aMany ? [a, b] : [b, a];
  const allPk = (ep: Endpoint) => ep.fields.length > 0 && ep.fields.every((f) => f.pk);
  if (allPk(a) && !allPk(b)) return [b, a];
  return [a, b];
}

export function buildViewModel(db: Database): ViewModel {
  const tables: VTable[] = [];
  const refs: VRef[] = [];
  const groups: VGroup[] = [];
  const fkFields = new Set<string>();

  for (const schema of db.schemas) {
    for (const ref of schema.refs) {
      if (ref.endpoints.length !== 2) continue;
      const [fromEp, toEp] = orientRef(ref.endpoints[0], ref.endpoints[1]);
      const fromTable = endpointTable(fromEp);
      const toTable = endpointTable(toEp);
      if (!fromTable || !toTable) continue;
      const from: VEndpoint = {
        table: tableId(fromTable),
        fields: fromEp.fields.map((f) => f.name),
        many: isEndpointManySide(fromEp.relation),
      };
      const to: VEndpoint = {
        table: tableId(toTable),
        fields: toEp.fields.map((f) => f.name),
        many: isEndpointManySide(toEp.relation),
      };
      for (const f of from.fields) fkFields.add(`${from.table}.${f}`);
      refs.push({
        id: `${from.table}(${from.fields.join(",")})->${to.table}(${to.fields.join(",")})#${refs.length}`,
        name: ref.name || null,
        from,
        to,
        onDelete: ref.onDelete ?? null,
        onUpdate: ref.onUpdate ?? null,
      });
    }

    for (const group of schema.tableGroups) {
      groups.push({
        id: `${schema.name}.${group.name}`,
        name: group.name,
        color: (group.color as unknown as string) || null,
        tables: group.tables.map(tableId),
      });
    }
  }

  for (const schema of db.schemas) {
    for (const table of schema.tables) {
      const id = tableId(table);
      const schemaName = table.schema?.name ?? DEFAULT_SCHEMA;
      const pkIndex = (table.indexes ?? []).find((ix) => ix.pk);
      const pkColumns = pkIndex?.columns.filter((c) => c.type === "column").map((c) => String(c.value)) ?? [];
      tables.push({
        id,
        schema: schemaName,
        name: table.name,
        label: schemaName === DEFAULT_SCHEMA ? table.name : `${schemaName}.${table.name}`,
        headerColor: (table.headerColor as unknown as string) || null,
        note: table.note || null,
        groupId: table.group ? `${table.group.schema?.name ?? DEFAULT_SCHEMA}.${table.group.name}` : null,
        line: tokenLine(table),
        endOffset: tokenEnd(table),
        fields: table.fields.map((f) => ({
          name: f.name,
          type: typeLabel(f),
          pk: !!f.pk,
          fk: fkFields.has(`${id}.${f.name}`),
          unique: !!f.unique,
          notNull: !!f.not_null,
          increment: !!f.increment,
          isEnum: !!(f as unknown as { _enum?: unknown })._enum,
          defaultValue: defaultLabel(f),
          note: f.note || null,
          offset: tokenStart(f),
        })),
        primaryKey: pkColumns.length ? pkColumns : table.fields.filter((f) => f.pk).map((f) => f.name),
      });
    }
  }

  type RawView = { name: string; visibleEntities?: { tables?: { name: string; schemaName?: string | null }[] | null } };
  const rawViews = ((db as unknown as { diagramViews?: RawView[] }).diagramViews ?? []) as RawView[];
  const views: VView[] = rawViews.map((v) => ({
    name: v.name,
    tables: v.visibleEntities?.tables ? v.visibleEntities.tables.map((t) => `${t.schemaName || DEFAULT_SCHEMA}.${t.name}`) : null,
  }));

  return { tables, refs, groups, views };
}
