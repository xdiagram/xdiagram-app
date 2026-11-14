import type { GroupNode, SortKey } from "./model";

/** A named filter of a table (phase 2: saved filters). */
export interface SavedFilter {
  name: string;
  where: GroupNode;
  sort: SortKey[];
}

/** What is kept for one table of a database. */
export interface TableMemory {
  /** The last filter used (without conditions that came from following a foreign key). */
  where?: GroupNode;
  sort?: SortKey[];
  saved?: SavedFilter[];
  /** The column shown for a row when it is picked by a foreign key (phase 2). */
  labelColumn?: string;
  /** The columns of the facet panel (phase 3). */
  facets?: string[];
  updatedAt: string;
}

/** One database's file in `<app data>/filters/`. */
export interface DbMemory {
  v: 1;
  tables: Record<string, TableMemory>;
  /** Expressions typed in the expression box, newest first (phase 2). */
  history: string[];
}

export const MAX_TABLES = 500;
export const MAX_HISTORY = 50;

export function emptyMemory(): DbMemory {
  return { v: 1, tables: {}, history: [] };
}

const isGroup = (v: unknown): v is GroupNode => !!v && typeof v === "object" && (v as GroupNode).t === "group" && Array.isArray((v as GroupNode).items);

/** Reads a stored file, keeping what is well-formed (an unreadable file is an empty memory). */
export function parseMemory(raw: string | null): DbMemory {
  if (!raw) return emptyMemory();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyMemory();
  }
  const out = emptyMemory();
  const d = data as Partial<DbMemory>;
  if (d && typeof d.tables === "object" && d.tables) {
    for (const [table, m] of Object.entries(d.tables)) {
      if (!m || typeof m !== "object") continue;
      const entry: TableMemory = { updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : new Date(0).toISOString() };
      if (isGroup(m.where)) entry.where = m.where;
      if (Array.isArray(m.sort)) entry.sort = m.sort.filter((k) => k && typeof k.column === "string").map((k) => ({ column: k.column, desc: !!k.desc }));
      if (Array.isArray(m.saved)) entry.saved = m.saved.filter((s) => s && typeof s.name === "string" && isGroup(s.where)).map((s) => ({ name: s.name, where: s.where, sort: Array.isArray(s.sort) ? s.sort : [] }));
      if (typeof m.labelColumn === "string") entry.labelColumn = m.labelColumn;
      if (Array.isArray(m.facets)) entry.facets = m.facets.filter((f): f is string => typeof f === "string").slice(0, 12);
      out.tables[table] = entry;
    }
  }
  if (Array.isArray(d?.history)) out.history = d.history.filter((h): h is string => typeof h === "string").slice(0, MAX_HISTORY);
  return out;
}

function isEmptyEntry(e: TableMemory): boolean {
  return !(e.where && e.where.items.length) && !(e.sort && e.sort.length) && !(e.saved && e.saved.length) && !e.labelColumn && !e.facets;
}

/** Updates one table's entry (dropping it when nothing is left), keeping the newest `MAX_TABLES`. */
export function rememberTable(mem: DbMemory, tableId: string, patch: Partial<Omit<TableMemory, "updatedAt">>, now = new Date()): DbMemory {
  const entry: TableMemory = { ...(mem.tables[tableId] ?? { updatedAt: "" }), ...patch, updatedAt: now.toISOString() };
  const tables = { ...mem.tables };
  if (isEmptyEntry(entry)) delete tables[tableId];
  else tables[tableId] = entry;
  const ids = Object.keys(tables);
  if (ids.length > MAX_TABLES) {
    ids.sort((a, b) => tables[b].updatedAt.localeCompare(tables[a].updatedAt));
    for (const id of ids.slice(MAX_TABLES)) delete tables[id];
  }
  return { ...mem, tables };
}

export const MAX_SAVED = 50;

/** Saves a named filter of a table; the same name (any case) is replaced. Sorted by name. */
export function saveNamed(mem: DbMemory, tableId: string, filter: SavedFilter, now = new Date()): DbMemory {
  const name = filter.name.trim();
  if (!name) return mem;
  const others = (mem.tables[tableId]?.saved ?? []).filter((s) => s.name.toLowerCase() !== name.toLowerCase());
  const saved = [...others, { ...filter, name }].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SAVED);
  return rememberTable(mem, tableId, { saved }, now);
}

/** Deletes a named filter of a table. */
export function deleteNamed(mem: DbMemory, tableId: string, name: string, now = new Date()): DbMemory {
  const saved = (mem.tables[tableId]?.saved ?? []).filter((s) => s.name !== name);
  return rememberTable(mem, tableId, { saved }, now);
}

/** Adds an expression to the history (newest first, no repeats). */
export function rememberExpression(mem: DbMemory, text: string): DbMemory {
  const t = text.trim();
  if (!t) return mem;
  return { ...mem, history: [t, ...mem.history.filter((h) => h !== t)].slice(0, MAX_HISTORY) };
}
