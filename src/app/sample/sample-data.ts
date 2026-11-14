import { displayTable } from "../diagram/view-model";
import type { DocColumn, DocModel, DocRelation, DocTable } from "../export/doc-model";
import { sqlComment } from "../export/sql-comment";
import { type PortableType, type SqlDialect, classifyType } from "../export/type-map";

/**
 * Fake but consistent rows for a schema, as INSERT statements. Parents are filled before
 * children so every foreign key points at a generated row; keys and unique columns stay unique;
 * values follow the column type and name (emails, names, prices, dates…). Output is text only.
 */

export type SampleDialect = "postgres" | "mysql" | "mssql" | "sqlite";

export const SAMPLE_DIALECTS: { value: SampleDialect; label: string }[] = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mssql", label: "SQL Server" },
  { value: "sqlite", label: "SQLite" },
];

export interface SampleOptions {
  /** Table ids to fill (their required parents are added); null = every table. */
  tables: string[] | null;
  rowsPerTable: number;
  dialect: SampleDialect;
  seed: number;
  /** Dialect the column types are written in, when known. */
  source?: SqlDialect | null;
}

/** A generated value: JS number = integer literal, `{num}` = decimal literal, `{bin}` = hex bytes. */
export type Cell = null | boolean | number | string | { num: string } | { bin: string };

export interface TablePlan {
  table: DocTable;
  columns: string[];
  rows: Cell[][];
  identity: string | null;
}

export interface SamplePlan {
  /** Insert order: parents first. */
  order: string[];
  tables: Map<string, TablePlan>;
  /** Nullable FKs that point at rows inserted later (cycles), filled in afterwards. */
  updates: { table: string; set: [string, Cell][]; where: [string, Cell][] }[];
  warnings: string[];
  rowCount: number;
}

// ------------------------------------------------------------------ randomness

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => Math.floor(this.next() * 16).toString(16));
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

// ------------------------------------------------------------------ word lists

const FIRST = ["Ana", "Ben", "Chloe", "David", "Elena", "Farid", "Grace", "Hugo", "Ines", "Jonas", "Keiko", "Liam", "Maya", "Noah", "Olga", "Pablo", "Quinn", "Rosa", "Samir", "Tara", "Uma", "Victor", "Wen", "Yusuf", "Zoe"];
const LAST = ["Andersen", "Brown", "Costa", "Dubois", "Ellis", "Fischer", "Garcia", "Hansen", "Ionescu", "Jensen", "Kim", "Lopez", "Martin", "Novak", "Okafor", "Popescu", "Rossi", "Silva", "Tanaka", "Ueda", "Varga", "Weber", "Young", "Zhang"];
const ADJ = ["Bright", "Quiet", "Swift", "Silver", "Northern", "Golden", "Little", "Clever", "Brave", "Green", "Blue", "Lucky"];
const NOUN = ["Harbor", "Falcon", "Garden", "Summit", "River", "Lantern", "Orchard", "Beacon", "Meadow", "Atlas", "Canyon", "Forge"];
const COMPANY = ["Corp", "Labs", "Systems", "Group", "Studio", "Partners", "Works", "Ltd"];
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud".split(" ");
const CITIES = ["Lisbon", "Oslo", "Bucharest", "Lyon", "Osaka", "Austin", "Porto", "Krakow", "Toronto", "Valencia", "Cluj", "Dublin"];
const COUNTRIES = ["Portugal", "Norway", "Romania", "France", "Japan", "United States", "Poland", "Canada", "Spain", "Ireland"];
const COUNTRY_CODES = ["PT", "NO", "RO", "FR", "JP", "US", "PL", "CA", "ES", "IE"];
const CURRENCIES = ["EUR", "USD", "GBP", "RON", "JPY", "CAD"];
const STREETS = ["Main", "Oak", "Maple", "Cedar", "Elm", "Pine", "Lake", "Hill", "Park", "River"];
const COLORS = ["red", "green", "blue", "orange", "purple", "teal", "gray"];
const STATUSES = ["active", "pending", "archived"];
const ROLES = ["admin", "member", "guest"];
const KINDS = ["alpha", "beta", "gamma", "delta"];

// ------------------------------------------------------------------ helpers

const DEFAULT_SCHEMA = "public";
const lower = (s: string) => s.toLowerCase();
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const cap = (s: string, length?: number) => (length ? s.slice(0, length) : s);

function isGenerated(c: DocColumn): boolean {
  return /\bgenerated\b|^\s*as\s*\(|\browversion\b/i.test(c.type);
}

function isRequired(rel: DocRelation, from: DocTable): boolean {
  return rel.from.columns.every((name) => {
    const c = from.columns.find((x) => x.name === name);
    return !!c && (c.notNull || c.pk);
  });
}

/** Column lists that must stay unique (PK, unique columns, unique indexes without expressions). */
function uniqueKeys(t: DocTable): string[][] {
  const keys: string[][] = [];
  const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
  if (pk.length) keys.push(pk);
  for (const c of t.columns) if (c.unique && !c.pk) keys.push([c.name]);
  for (const ix of t.indexes) {
    if ((ix.pk || ix.unique) && ix.columns.every((c) => !c.startsWith("`"))) keys.push(ix.columns);
  }
  return keys;
}

function keyOf(row: Map<string, Cell>, cols: string[]): string | null {
  const parts: string[] = [];
  for (const c of cols) {
    const v = row.get(c);
    if (v === null || v === undefined) return null; // NULLs never collide
    parts.push(JSON.stringify(v));
  }
  return parts.join("|");
}

/** A date between `from` and `to` (ISO strings), as `YYYY-MM-DD`. */
function dateBetween(rng: Rng, from: number, to: number): Date {
  return new Date(from + rng.float() * (to - from));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const START = Date.UTC(2024, 0, 1);
const END = Date.UTC(2026, 9, 31);

// ------------------------------------------------------------------ values

interface RowContext {
  table: DocTable;
  index: number;
  row: Map<string, Cell>;
  rng: Rng;
  dialect: SampleDialect;
}

function textValue(name: string, ctx: RowContext, length: number | undefined, unique: boolean): string {
  const { rng, index, table } = ctx;
  const n = index + 1;
  const first = () => (ctx.row.get("__first") as string) ?? rng.pick(FIRST);
  const last = () => (ctx.row.get("__last") as string) ?? rng.pick(LAST);
  const person = /user|people|person|customer|employee|member|author|account|contact|student|patient|staff/i.test(table.name);
  let v: string;
  if (/e_?mail/.test(name)) v = `${lower(first())}.${lower(last())}${n}@example.com`;
  else if (/^(first_?name|given_?name|forename)$/.test(name)) v = first();
  else if (/^(last_?name|surname|family_?name)$/.test(name)) v = last();
  else if (/^(full_?name|display_?name|contact_?name)$/.test(name) || (name === "name" && person)) v = `${first()} ${last()}`;
  else if (/user_?name|login|handle|nick/.test(name)) v = `${lower(first())}${n}`;
  else if (/phone|mobile|tel|fax/.test(name)) v = `+1-555-${pad(rng.int(100, 999), 3)}-${pad(n % 10000, 4)}`;
  else if (/url|website|homepage|link|href/.test(name)) v = `https://example.com/${displayTable(table.id).replace(/\W+/g, "-")}/${n}`;
  else if (/slug/.test(name)) v = `${lower(rng.pick(ADJ))}-${lower(rng.pick(NOUN))}-${n}`;
  else if (/country_?code|^iso2?$/.test(name)) v = rng.pick(COUNTRY_CODES);
  else if (/country/.test(name)) v = rng.pick(COUNTRIES);
  else if (/city|town/.test(name)) v = rng.pick(CITIES);
  else if (/currency/.test(name)) v = rng.pick(CURRENCIES);
  else if (/zip|postal|postcode/.test(name)) v = pad(rng.int(10000, 99999), 5);
  else if (/address|street/.test(name)) v = `${rng.int(1, 250)} ${rng.pick(STREETS)} St`;
  else if (/colou?r/.test(name)) v = rng.pick(COLORS);
  else if (/^ip|_ip$|ip_?addr/.test(name)) v = `10.0.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  else if (/uuid|guid/.test(name)) v = rng.uuid();
  else if (/password|hash|token|secret|salt|digest/.test(name)) v = Array.from({ length: 32 }, () => rng.int(0, 15).toString(16)).join("");
  else if (/status|state$/.test(name)) v = rng.pick(STATUSES);
  else if (/role/.test(name)) v = rng.pick(ROLES);
  else if (/type|kind|category|tier|plan|level/.test(name)) v = rng.pick(KINDS);
  else if (/code|sku|ref|reference|number|serial/.test(name)) v = `${name.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X")}-${pad(n, 5)}`;
  else if (/description|notes?|comment|bio|summary|body|content|message|text|details|remarks/.test(name)) {
    v = Array.from({ length: rng.int(5, 14) }, () => rng.pick(WORDS)).join(" ");
    v = v[0].toUpperCase() + v.slice(1) + ".";
  } else if (/name|title|label|caption|subject|heading/.test(name)) {
    v = /org|company|vendor|supplier|tenant|client|team/i.test(table.name)
      ? `${rng.pick(ADJ)} ${rng.pick(NOUN)} ${rng.pick(COMPANY)}`
      : `${rng.pick(ADJ)} ${rng.pick(NOUN)}`;
  } else v = `${rng.pick(WORDS)} ${rng.pick(WORDS)}`;

  if (unique && !/e_?mail|user_?name|login|slug|code|sku|ref|uuid|guid|password|hash|token/.test(name)) v = `${v} ${n}`;
  if (length && v.length > length) {
    // Keep the unique suffix when cutting.
    const suffix = unique ? `${n}` : "";
    v = cap(v, Math.max(1, length - suffix.length)) + suffix;
    v = cap(v, length);
  }
  return v;
}

function numberValue(name: string, t: PortableType, ctx: RowContext): Cell {
  const { rng, index } = ctx;
  if (t.kind === "decimal" || t.kind === "real" || t.kind === "double") {
    const scale = t.kind === "decimal" ? (t.scale ?? 2) : 2;
    const intDigits = t.kind === "decimal" && t.precision ? t.precision - scale : 6;
    const max = Math.min(10 ** Math.max(intDigits, 0) - 1, /price|amount|total|cost|budget|balance|salary|fee|revenue/.test(name) ? 2000 : 1000);
    const v = /rate|ratio|percent|pct|share|discount/.test(name) ? rng.float() : rng.float() * Math.max(max, 1);
    return { num: v.toFixed(Math.min(scale, 4)) };
  }
  const limit = t.kind === "smallint" ? 32767 : t.kind === "int" ? 2147483647 : Number.MAX_SAFE_INTEGER;
  let v: number;
  if (/count|qty|quantity|stock|seats|attempts|retries|visits|views/.test(name)) v = rng.int(0, 50);
  else if (/age/.test(name)) v = rng.int(18, 80);
  else if (/year/.test(name)) v = rng.int(1990, 2026);
  else if (/position|order|rank|sort|seq|line_?no|index|priority/.test(name)) v = index + 1;
  else if (/duration|minutes|seconds|ms$/.test(name)) v = rng.int(1, 600);
  else v = rng.int(1, 1000);
  return Math.min(v, limit);
}

function temporalValue(name: string, t: PortableType, ctx: RowContext): Cell {
  const { rng, row } = ctx;
  let d: Date;
  const endLike = /^(ends?_|end_|finish|until|expires?|due|closed|completed)|(_end|_until)$/.test(name);
  if (/birth|dob/.test(name)) d = dateBetween(rng, Date.UTC(1950, 0, 1), Date.UTC(2005, 11, 31));
  else if (/updated|modified|changed|edited/.test(name) && row.get("__created")) {
    d = new Date((row.get("__created") as number) + rng.int(1, 24 * 90) * 3600_000);
  } else if (endLike && row.get("__start")) {
    d = new Date((row.get("__start") as number) + rng.int(1, 365) * 86400_000);
  } else d = dateBetween(rng, START, END);
  if (/created|inserted|registered|joined|start|begin|from|opened/.test(name)) {
    row.set("__created", d.getTime());
    row.set("__start", d.getTime());
  }
  if (t.kind === "date") return iso(d);
  if (t.kind === "time") return isoTime(d).slice(11);
  return isoTime(d);
}

function columnValue(c: DocColumn, ctx: RowContext, unique: boolean, source: SqlDialect | null): Cell | undefined {
  const { rng, index } = ctx;
  const name = lower(c.name);
  if (c.enumValues?.length) return rng.pick(c.enumValues);
  if (c.type.trim().endsWith("]")) {
    const items = Array.from({ length: rng.int(0, 3) }, () => rng.pick(KINDS));
    return ctx.dialect === "postgres" ? `{${items.join(",")}}` : JSON.stringify(items);
  }
  const t = classifyType(c.type.replace(/\s+on update [a-z_()]+$/i, ""), source ?? null);
  if (!t) return undefined;
  switch (t.kind) {
    case "bool":
      return /^(is_)?(active|enabled|visible|published|verified)$/.test(name) ? rng.chance(0.85) : rng.chance(0.5);
    case "smallint":
    case "int":
    case "bigint":
      return unique ? index + 1 : numberValue(name, t, ctx);
    case "decimal":
    case "real":
    case "double":
      return numberValue(name, t, ctx);
    case "uuid":
      return rng.uuid();
    case "json":
      return /settings|prefs|preferences|config/.test(name) ? JSON.stringify({ theme: rng.pick(["light", "dark"]), notifications: rng.chance(0.5) }) : JSON.stringify({ n: index + 1, tag: rng.pick(KINDS) });
    case "binary":
      return { bin: Array.from({ length: 4 }, () => rng.int(0, 255).toString(16).padStart(2, "0")).join("") };
    case "date":
    case "time":
    case "timestamp":
    case "timestamptz":
      return temporalValue(name, t, ctx);
    case "varchar":
    case "char":
    case "text": {
      // Dates kept as text (SQLite, legacy schemas): recognise them by name.
      if (!t.length || t.length >= 10) {
        if (/(^|_)(date|day)$|_on$|^dob$|birth_?date/.test(name)) return temporalValue(name, { kind: "date" }, ctx);
        if (/_at$|timestamp|datetime|(^|_)time$/.test(name)) return temporalValue(name, { kind: "timestamp" }, ctx);
      }
      if (t.kind === "char" && t.length && t.length <= 3 && !/currency|country|code|iso/.test(name)) {
        return Array.from({ length: t.length }, () => String.fromCharCode(65 + rng.int(0, 25))).join("");
      }
      return textValue(name, ctx, t.length, unique);
    }
  }
}

// ------------------------------------------------------------------ planning

export function planSampleData(model: DocModel, opts: SampleOptions): SamplePlan {
  const rng = new Rng(opts.seed);
  const warnings: string[] = [];
  const byId = new Map(model.tables.map((t) => [t.id, t]));
  const outgoing = (id: string) => model.relations.filter((r) => r.from.table === id && byId.has(r.to.table));

  // Tables to fill: the chosen ones plus every parent a NOT NULL foreign key needs.
  const included = new Set((opts.tables ?? model.tables.map((t) => t.id)).filter((id) => byId.has(id)));
  const queue = [...included];
  while (queue.length) {
    const id = queue.pop()!;
    for (const r of outgoing(id)) {
      if (r.to.table !== id && isRequired(r, byId.get(id)!) && !included.has(r.to.table)) {
        included.add(r.to.table);
        queue.push(r.to.table);
      }
    }
  }

  // Parents first (Kahn over required, non-self relationships).
  const order: string[] = [];
  const remaining = new Set(included);
  while (remaining.size) {
    const ready = [...remaining].filter((id) =>
      outgoing(id).every((r) => r.to.table === id || !remaining.has(r.to.table) || !isRequired(r, byId.get(id)!)),
    );
    if (!ready.length) {
      const cycle = [...remaining].map(displayTable).join(", ");
      warnings.push(`NOT NULL foreign keys form a cycle between ${cycle}; some rows may violate them`);
      order.push(...remaining);
      break;
    }
    for (const id of model.tables.map((t) => t.id).filter((x) => ready.includes(x))) {
      order.push(id);
      remaining.delete(id);
    }
  }
  const position = new Map(order.map((id, i) => [id, i]));

  const tables = new Map<string, TablePlan>();
  const updates: SamplePlan["updates"] = [];
  const rowsByTable = new Map<string, Map<string, Cell>[]>();
  let rowCount = 0;

  for (const id of order) {
    const t = byId.get(id)!;
    const columns = t.columns.filter((c) => !isGenerated(c));
    const rels = outgoing(id);
    const keys = uniqueKeys(t);
    const seen = keys.map(() => new Set<string>());
    const singleIntPk = (() => {
      const pk = t.columns.filter((c) => c.pk);
      const k = pk.length === 1 ? classifyType(pk[0].type, opts.source ?? null)?.kind : undefined;
      return pk.length === 1 && (k === "int" || k === "bigint" || k === "smallint") ? pk[0].name : null;
    })();
    const uniqueCols = new Set(keys.filter((k) => k.length === 1).map((k) => k[0]));
    const rows: Map<string, Cell>[] = [];
    let unsupported = new Set<string>();
    let short = false;

    for (let i = 0; i < Math.max(1, opts.rowsPerTable); i++) {
      let accepted: Map<string, Cell> | null = null;
      for (let attempt = 0; attempt < 30 && !accepted; attempt++) {
        const row = new Map<string, Cell>();
        const ctx: RowContext = { table: t, index: i, row, rng, dialect: opts.dialect };
        row.set("__first", rng.pick(FIRST));
        row.set("__last", rng.pick(LAST));

        // Foreign keys first: a composite key copies one whole parent row.
        for (const r of rels) {
          const required = isRequired(r, t);
          const self = r.to.table === id;
          const parentRows = self ? rows : rowsByTable.get(r.to.table);
          const later = !self && (position.get(r.to.table) ?? -1) > (position.get(id) ?? 0);
          if (later || !parentRows) {
            for (const c of r.from.columns) if (!row.has(c)) row.set(c, null);
            if (later) row.set(`__defer:${r.to.table}:${r.from.columns.join(",")}`, true);
            continue;
          }
          if (!parentRows.length || (!required && rng.chance(self ? 0.3 : 0.12))) {
            for (const c of r.from.columns) if (!row.has(c)) row.set(c, null);
            continue;
          }
          const parent = rng.pick(parentRows);
          r.from.columns.forEach((c, k) => row.set(c, parent.get(r.to.columns[k]) ?? null));
        }

        for (const c of columns) {
          if (row.has(c.name)) continue;
          const unique = uniqueCols.has(c.name);
          if (c.name === singleIntPk) {
            row.set(c.name, i + 1);
            continue;
          }
          if (!c.notNull && !c.pk && !unique && rng.chance(/deleted|archived|cancel|removed/.test(lower(c.name)) ? 0.85 : 0.1)) {
            row.set(c.name, null);
            continue;
          }
          let v = columnValue(c, ctx, unique || (c.pk && !singleIntPk), opts.source ?? null);
          if (v === undefined) {
            unsupported.add(`${displayTable(id)}.${c.name} (${c.type})`);
            v = c.notNull || c.pk ? `sample ${i + 1}` : null;
          }
          if (attempt > 2 && typeof v === "string" && keys.some((k) => k.includes(c.name))) v = `${v}-${attempt}`;
          row.set(c.name, v);
        }

        // A NOT NULL self-reference on the first row can only point at the row itself.
        for (const r of rels) {
          if (r.to.table === id && isRequired(r, t) && r.from.columns.some((c) => row.get(c) === null)) {
            r.from.columns.forEach((c, k) => row.set(c, row.get(r.to.columns[k]) ?? null));
          }
        }

        if (keys.every((k, n) => {
          const key = keyOf(row, k);
          return key === null || !seen[n].has(key);
        })) accepted = row;
      }
      if (!accepted) {
        short = true;
        break;
      }
      keys.forEach((k, n) => {
        const key = keyOf(accepted!, k);
        if (key !== null) seen[n].add(key);
      });
      rows.push(accepted);
    }
    if (short) warnings.push(`${displayTable(id)}: only ${rows.length} rows (not enough distinct key combinations)`);
    if (unsupported.size) warnings.push(`No generator for ${[...unsupported].join(", ")}; used NULL or placeholder text`);
    unsupported = new Set();

    rowsByTable.set(id, rows);
    tables.set(id, {
      table: t,
      columns: columns.map((c) => c.name),
      rows: rows.map((r) => columns.map((c) => r.get(c.name) ?? null)),
      identity: columns.find((c) => c.increment)?.name ?? null,
    });
    rowCount += rows.length;
  }

  // Foreign keys whose parent is inserted later: fill them with UPDATEs at the end.
  for (const id of order) {
    const t = byId.get(id)!;
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const pkIndex = t.indexes.find((ix) => ix.pk)?.columns ?? [];
    const keyCols = pk.length ? pk : pkIndex;
    for (const r of outgoing(id)) {
      const marker = `__defer:${r.to.table}:${r.from.columns.join(",")}`;
      const parents = rowsByTable.get(r.to.table) ?? [];
      for (const row of rowsByTable.get(id) ?? []) {
        if (!row.get(marker) || !parents.length) continue;
        if (!keyCols.length) {
          warnings.push(`${displayTable(id)}: cannot fill ${r.from.columns.join(", ")} afterwards (no primary key)`);
          break;
        }
        if (!isRequired(r, t) && rng.chance(0.12)) continue;
        const parent = rng.pick(parents);
        updates.push({
          table: id,
          set: r.from.columns.map((c, k) => [c, parent.get(r.to.columns[k]) ?? null] as [string, Cell]),
          where: keyCols.map((c) => [c, row.get(c) ?? null] as [string, Cell]),
        });
      }
      if ((rowsByTable.get(id) ?? []).some((row) => row.get(marker)) && isRequired(r, t)) {
        warnings.push(`${displayTable(id)}.${r.from.columns.join(", ")} is NOT NULL but its parent is inserted later; the INSERT will fail`);
      }
    }
  }

  return { order, tables, updates, warnings, rowCount };
}

// ------------------------------------------------------------------ SQL

function quoteIdent(name: string, d: SampleDialect): string {
  if (d === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (d === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(v: Cell, d: SampleDialect): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return d === "postgres" || d === "mysql" ? (v ? "TRUE" : "FALSE") : v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "num" in v) return v.num;
  if (typeof v === "object" && "bin" in v) {
    if (d === "postgres") return `'\\x${v.bin}'::bytea`;
    if (d === "sqlite") return `X'${v.bin}'`;
    return `0x${v.bin}`;
  }
  let s = v.replace(/'/g, "''");
  if (d === "mysql") s = s.replace(/\\/g, "\\\\");
  return d === "mssql" ? `N'${s}'` : `'${s}'`;
}

export function renderSampleSql(plan: SamplePlan, opts: SampleOptions & { title: string; now?: Date }): string {
  const d = opts.dialect;
  const schemas = new Set(plan.order.map((id) => plan.tables.get(id)!.table.schema));
  const mysqlMain = d === "mysql" && schemas.size > 1;
  const tableName = (t: DocTable) => {
    if (d === "sqlite" || (t.schema === DEFAULT_SCHEMA && !mysqlMain)) return quoteIdent(t.name, d);
    return `${quoteIdent(t.schema === DEFAULT_SCHEMA ? "main" : t.schema, d)}.${quoteIdent(t.name, d)}`;
  };
  const label = SAMPLE_DIALECTS.find((x) => x.value === d)?.label ?? d;
  const out: string[] = [
    sqlComment(`Sample data for ${opts.title} (${label}): ${plan.rowCount} rows in ${plan.order.length} tables, seed ${opts.seed}`),
    `-- Generated by xdiagram on ${(opts.now ?? new Date()).toISOString().slice(0, 10)}. The values are fake.`,
    "-- CHECK constraints and triggers are not evaluated. Review before running; xdiagram never runs it.",
    ...(mysqlMain ? ["-- Tables of the default schema are written as `main`.table, like the MySQL DDL export."] : []),
    ...(d === "sqlite" && schemas.size > 1 ? ["-- SQLite has no schemas: table names are written without them."] : []),
    ...plan.warnings.map((w) => sqlComment(`Warning: ${w}.`)),
    "",
    d === "mssql" ? "BEGIN TRANSACTION;" : d === "mysql" ? "START TRANSACTION;" : "BEGIN;",
    "",
  ];
  const batch = 100;
  for (const id of plan.order) {
    const tp = plan.tables.get(id)!;
    if (!tp.rows.length) continue;
    const name = tableName(tp.table);
    const cols = tp.columns.map((c) => quoteIdent(c, d)).join(", ");
    out.push(sqlComment(`${displayTable(id)}: ${tp.rows.length} rows`));
    if (d === "mssql" && tp.identity) out.push(`SET IDENTITY_INSERT ${name} ON;`);
    for (let i = 0; i < tp.rows.length; i += batch) {
      const values = tp.rows
        .slice(i, i + batch)
        .map((r) => `  (${r.map((v) => literal(v, d)).join(", ")})`)
        .join(",\n");
      const overriding = d === "postgres" && tp.identity ? " OVERRIDING SYSTEM VALUE" : "";
      out.push(`INSERT INTO ${name} (${cols})${overriding} VALUES\n${values};`);
    }
    if (d === "mssql" && tp.identity) out.push(`SET IDENTITY_INSERT ${name} OFF;`);
    out.push("");
  }
  if (plan.updates.length) {
    out.push("-- Foreign keys whose parent rows come later");
    for (const u of plan.updates) {
      const t = plan.tables.get(u.table)!.table;
      const set = u.set.map(([c, v]) => `${quoteIdent(c, d)} = ${literal(v, d)}`).join(", ");
      const where = u.where.map(([c, v]) => `${quoteIdent(c, d)} = ${literal(v, d)}`).join(" AND ");
      out.push(`UPDATE ${tableName(t)} SET ${set} WHERE ${where};`);
    }
    out.push("");
  }
  if (d === "postgres") {
    const resets = plan.order
      .map((id) => plan.tables.get(id)!)
      .filter((tp) => tp.identity && tp.rows.length)
      .map((tp) => {
        const qualified = tableName(tp.table);
        const col = quoteIdent(tp.identity!, d);
        return `SELECT setval(pg_get_serial_sequence('${qualified.replace(/'/g, "''")}', '${tp.identity!.replace(/'/g, "''")}'), (SELECT MAX(${col}) FROM ${qualified}));`;
      });
    if (resets.length) out.push("-- Move identity sequences past the inserted keys", ...resets, "");
  }
  out.push("COMMIT;", "");
  return out.join("\n");
}

export function generateSampleData(
  model: DocModel,
  opts: SampleOptions & { title: string; now?: Date },
): { sql: string; rowCount: number; tableCount: number; warnings: string[]; plan: SamplePlan } {
  const plan = planSampleData(model, opts);
  return { sql: renderSampleSql(plan, opts), rowCount: plan.rowCount, tableCount: plan.order.length, warnings: plan.warnings, plan };
}
