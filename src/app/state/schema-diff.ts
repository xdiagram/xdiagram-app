import { displayTable, refKey, type VField, type VRef, type VTable, type ViewModel } from "../diagram/view-model";

export interface ColumnChange {
  name: string;
  before: string;
  after: string;
}

export interface TableChange {
  table: string;
  added: string[];
  removed: string[];
  changed: ColumnChange[];
}

/** What changed in a database between two reads of its schema. Indexes are not compared. */
export interface SchemaChanges {
  tablesAdded: string[];
  tablesRemoved: string[];
  /** Tables in both reads whose columns changed. */
  tables: TableChange[];
  refsAdded: string[];
  refsRemoved: string[];
}

/** A column as one comparable line: type and the settings that matter for the schema. */
export function describeField(f: VField): string {
  const parts = [f.type];
  if (f.pk) parts.push("pk");
  if (f.increment) parts.push("increment");
  if (f.unique) parts.push("unique");
  if (f.notNull) parts.push("not null");
  if (f.defaultValue !== null) parts.push(`default ${f.defaultValue}`);
  return parts.join(", ");
}

export function describeRef(r: VRef): string {
  return `${displayTable(r.from.table)}(${r.from.fields.join(", ")}) → ${displayTable(r.to.table)}(${r.to.fields.join(", ")})`;
}

function diffTable(before: VTable, after: VTable): TableChange | null {
  const old = new Map(before.fields.map((f) => [f.name, f]));
  const now = new Map(after.fields.map((f) => [f.name, f]));
  const added = after.fields.filter((f) => !old.has(f.name)).map((f) => f.name);
  const removed = before.fields.filter((f) => !now.has(f.name)).map((f) => f.name);
  const changed: ColumnChange[] = [];
  for (const f of after.fields) {
    const prev = old.get(f.name);
    if (!prev) continue;
    const [a, b] = [describeField(prev), describeField(f)];
    if (a !== b) changed.push({ name: f.name, before: a, after: b });
  }
  return added.length || removed.length || changed.length ? { table: after.id, added, removed, changed } : null;
}

export function diffSchemas(before: ViewModel, after: ViewModel): SchemaChanges {
  const old = new Map(before.tables.map((t) => [t.id, t]));
  const now = new Map(after.tables.map((t) => [t.id, t]));
  const tables: TableChange[] = [];
  for (const t of after.tables) {
    const prev = old.get(t.id);
    const change = prev ? diffTable(prev, t) : null;
    if (change) tables.push(change);
  }
  const keyed = (refs: VRef[]) => new Map(refs.map((r) => [refKey(r.from, r.to), r]));
  const [oldRefs, newRefs] = [keyed(before.refs), keyed(after.refs)];
  return {
    tablesAdded: after.tables.filter((t) => !old.has(t.id)).map((t) => t.id),
    tablesRemoved: before.tables.filter((t) => !now.has(t.id)).map((t) => t.id),
    tables,
    refsAdded: [...newRefs].filter(([k]) => !oldRefs.has(k)).map(([, r]) => describeRef(r)),
    refsRemoved: [...oldRefs].filter(([k]) => !newRefs.has(k)).map(([, r]) => describeRef(r)),
  };
}

export function isEmptyChange(c: SchemaChanges): boolean {
  return !c.tablesAdded.length && !c.tablesRemoved.length && !c.tables.length && !c.refsAdded.length && !c.refsRemoved.length;
}

/** "2 tables added, 3 columns changed, 1 relationship removed". */
export function summarizeChanges(c: SchemaChanges): string {
  const count = (n: number, one: string, many: string, what: string) => (n ? [`${n} ${n === 1 ? one : many} ${what}`] : []);
  const sum = (pick: (t: TableChange) => number) => c.tables.reduce((n, t) => n + pick(t), 0);
  return [
    ...count(c.tablesAdded.length, "table", "tables", "added"),
    ...count(c.tablesRemoved.length, "table", "tables", "removed"),
    ...count(sum((t) => t.added.length), "column", "columns", "added"),
    ...count(sum((t) => t.removed.length), "column", "columns", "removed"),
    ...count(sum((t) => t.changed.length), "column", "columns", "changed"),
    ...count(c.refsAdded.length, "relationship", "relationships", "added"),
    ...count(c.refsRemoved.length, "relationship", "relationships", "removed"),
  ].join(", ");
}
