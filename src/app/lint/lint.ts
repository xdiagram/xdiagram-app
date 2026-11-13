import { refLine } from "../diagram/canvas-edit";
import { displayTable } from "../diagram/view-model";
import type { DocColumn, DocModel, DocTable } from "../export/doc-model";
import { type PortableType, classifyType } from "../export/type-map";

/**
 * Schema lint: design problems found in the DBML alone, so it works for every engine and for
 * files. Each rule is a pure check over the documentation model.
 */

export type Severity = "error" | "warning" | "info";

export type RuleId =
  | "fk-type-mismatch"
  | "fk-target-not-unique"
  | "no-primary-key"
  | "fk-not-indexed"
  | "duplicate-index"
  | "redundant-index"
  | "reserved-word"
  | "possible-missing-fk"
  | "nullable-fk"
  | "naming-style"
  | "wide-table";

export interface LintRule {
  id: RuleId;
  title: string;
  description: string;
  /** Off until the user turns it on (noisy for many schemas). */
  optIn?: boolean;
}

export const RULES: LintRule[] = [
  { id: "fk-type-mismatch", title: "FK type mismatch", description: "A foreign key column's type differs from the column it references." },
  { id: "fk-target-not-unique", title: "FK target not unique", description: "A relationship points at columns that are not a primary key or unique." },
  { id: "no-primary-key", title: "No primary key", description: "Tables without a primary key." },
  { id: "fk-not-indexed", title: "FK not indexed", description: "Foreign key columns that no index (or primary key) starts with: joins and parent deletes scan the table." },
  { id: "duplicate-index", title: "Duplicate index", description: "Two indexes on exactly the same columns." },
  { id: "redundant-index", title: "Redundant index", description: "An index whose columns are the leading columns of another index." },
  { id: "reserved-word", title: "Reserved word", description: "Table or column names that are SQL keywords and need quoting." },
  { id: "possible-missing-fk", title: "Possible missing FK", description: "Columns named like `user_id` with a matching table but no relationship." },
  { id: "nullable-fk", title: "Nullable FK", description: "Foreign key columns that allow NULL.", optIn: true },
  { id: "naming-style", title: "Naming style", description: "Names that break the schema's dominant style (snake_case, camelCase, PascalCase)." },
  { id: "wide-table", title: "Wide table", description: "Tables with more than 40 columns." },
];

export const DEFAULT_RULES: ReadonlySet<RuleId> = new Set(RULES.filter((r) => !r.optIn).map((r) => r.id));

export interface LintFix {
  label: string;
  /** DBML appended to the document (one undo step). */
  append: string;
}

export interface LintFinding {
  /** Stable key (rule + location). */
  key: string;
  rule: RuleId;
  severity: Severity;
  table: string;
  column: string | null;
  message: string;
  fix?: LintFix;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Keywords people use as names, with the dialects that reserve them. */
const PG = "PostgreSQL";
const MY = "MySQL";
const MS = "SQL Server";
const OR = "Oracle";
const RESERVED: Record<string, string[]> = {
  user: [PG, MS, OR], order: [PG, MY, MS, OR], group: [PG, MY, MS, OR], key: [MY, MS], index: [MY, MS, OR],
  table: [PG, MY, MS, OR], column: [PG, MY, MS, OR], check: [PG, MY, MS, OR], default: [PG, MY, MS, OR],
  desc: [PG, MY, MS, OR], limit: [PG, MY], offset: [PG], references: [PG, MY, MS], primary: [PG, MY, MS],
  select: [PG, MY, MS, OR], from: [PG, MY, MS, OR], where: [PG, MY, MS, OR], values: [MY, MS, OR], end: [PG, MS],
  to: [PG, MY, MS, OR], rank: [MY], row: [MY, OR], rows: [MY, OR], range: [MY], level: [OR], comment: [OR],
  date: [OR], number: [OR], size: [OR], mode: [OR], session: [OR], file: [MS, OR], option: [MY, MS, OR],
  read: [MY, MS], match: [MY], schema: [MY, MS], database: [MY, MS], plan: [MS], interval: [MY], condition: [MY],
  signal: [MY], usage: [MY], release: [MY], grant: [PG, MY, MS, OR], constraint: [PG, MY, MS], distinct: [PG, MY, MS, OR],
  union: [PG, MY, MS, OR], unique: [PG, MY, MS, OR], window: [PG, MY], when: [PG, MY, MS], case: [PG, MY, MS],
  left: [PG, MY, MS], right: [PG, MY, MS], current_user: [PG, MY, MS], only: [PG], returning: [PG], using: [PG, MY],
  natural: [PG, MY, MS], fetch: [PG, MY, MS], cross: [PG, MY, MS], full: [PG, MS], inner: [PG, MY, MS], outer: [PG, MY, MS],
  join: [PG, MY, MS], function: [MY, MS], procedure: [MY, MS], trigger: [MY, MS, OR], view: [MS, OR], public: [MS, OR],
};

const MAX_COLUMNS = 40;

function columnsOf(t: DocTable): Map<string, DocColumn> {
  return new Map(t.columns.map((c) => [c.name, c]));
}

/** Column lists that are guaranteed unique in `t` (PK, unique columns, unique indexes). */
function uniqueKeys(t: DocTable): string[][] {
  const keys: string[][] = [];
  const pkCols = t.columns.filter((c) => c.pk).map((c) => c.name);
  if (pkCols.length) keys.push(pkCols);
  for (const c of t.columns) if (c.unique) keys.push([c.name]);
  for (const ix of t.indexes) if (ix.pk || ix.unique) keys.push(ix.columns);
  return keys;
}

/** Ordered column lists that can serve lookups (indexes, PK, unique columns). */
function indexKeys(t: DocTable): { columns: string[]; name: string; unique: boolean }[] {
  const keys: { columns: string[]; name: string; unique: boolean }[] = [];
  const pkCols = t.columns.filter((c) => c.pk).map((c) => c.name);
  if (pkCols.length) keys.push({ columns: pkCols, name: "primary key", unique: true });
  for (const c of t.columns) if (c.unique && !c.pk) keys.push({ columns: [c.name], name: `unique ${c.name}`, unique: true });
  t.indexes.forEach((ix, i) =>
    keys.push({ columns: ix.columns, name: ix.pk ? "primary key" : (ix.name ?? `index #${i + 1}`), unique: ix.pk || ix.unique }),
  );
  return keys;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => b[i] === x);
const isPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((x, i) => b[i] === x);

const STRINGS = new Set(["varchar", "char", "text"]);

/** null when compatible; otherwise how serious the difference is. */
function typeDifference(from: string, to: string): Severity | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^"(.*)"$/, "$1");
  if (norm(from) === norm(to)) return null;
  const a = classifyType(from);
  const b = classifyType(to);
  if (!a || !b) return "error";
  if (a.kind !== b.kind) return STRINGS.has(a.kind) && STRINGS.has(b.kind) ? "warning" : "error";
  const sameArgs = (x: PortableType, y: PortableType) => x.length === y.length && x.precision === y.precision && x.scale === y.scale;
  return sameArgs(a, b) ? null : "warning";
}

type Style = "snake" | "camel" | "pascal" | "upper";

function styleOf(name: string): Style | null {
  if (/^[a-z][a-z0-9]*$/.test(name)) return null; // one lowercase word fits snake and camel
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return "snake";
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(name)) return "camel";
  if (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)*$/.test(name)) return "pascal";
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(name)) return "upper";
  return null;
}

const STYLE_LABEL: Record<Style, string> = { snake: "snake_case", camel: "camelCase", pascal: "PascalCase", upper: "UPPER_CASE" };

/** Dominant style among `names` (≥ 60% of the classifiable ones, at least 5 of them). */
function dominantStyle(names: string[]): Style | null {
  const counts = new Map<Style, number>();
  let total = 0;
  for (const n of names) {
    const s = styleOf(n);
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
    total++;
  }
  if (total < 5) return null;
  const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return n / total >= 0.6 ? best : null;
}

/** Table names a `<base>_id` column could point at. */
function candidateNames(base: string): string[] {
  const b = base.toLowerCase();
  const out = [b, `${b}s`, `${b}es`];
  if (b.endsWith("y")) out.push(`${b.slice(0, -1)}ies`);
  return out;
}

export function lintSchema(model: DocModel, enabled: ReadonlySet<RuleId> = DEFAULT_RULES): LintFinding[] {
  const findings: LintFinding[] = [];
  const on = (r: RuleId) => enabled.has(r);
  const add = (f: Omit<LintFinding, "key">) => findings.push({ ...f, key: `${f.rule}:${f.table}:${f.column ?? ""}:${f.message}` });
  const tables = new Map(model.tables.map((t) => [t.id, t]));
  const fq = (table: string, cols: string[]) => `${displayTable(table)}.${cols.length === 1 ? cols[0] : `(${cols.join(", ")})`}`;

  // --- relationships
  for (const rel of model.relations) {
    const from = tables.get(rel.from.table);
    const to = tables.get(rel.to.table);
    if (!from || !to) continue;
    const fromCols = columnsOf(from);
    const toCols = columnsOf(to);
    const column = rel.from.columns.length === 1 ? rel.from.columns[0] : null;

    if (on("fk-type-mismatch")) {
      rel.from.columns.forEach((name, i) => {
        const a = fromCols.get(name);
        const b = toCols.get(rel.to.columns[i] ?? "");
        if (!a || !b) return;
        const diff = typeDifference(a.type, b.type);
        if (diff) {
          add({
            rule: "fk-type-mismatch", severity: diff, table: from.id, column: name,
            message: `${fq(from.id, [name])} is ${a.type} but references ${fq(to.id, [b.name])}, which is ${b.type}`,
          });
        }
      });
    }
    if (on("fk-target-not-unique") && !(rel.from.many && rel.to.many) && !rel.to.many) {
      if (!uniqueKeys(to).some((k) => sameSet(k, rel.to.columns))) {
        add({
          rule: "fk-target-not-unique", severity: "error", table: from.id, column,
          message: `${fq(from.id, rel.from.columns)} references ${fq(to.id, rel.to.columns)}, which is not a primary key or unique`,
        });
      }
    }
    if (on("fk-not-indexed") && !(rel.from.many && rel.to.many)) {
      const covered = indexKeys(from).some((k) => sameSet(k.columns.slice(0, rel.from.columns.length), rel.from.columns));
      if (!covered) {
        add({
          rule: "fk-not-indexed", severity: "warning", table: from.id, column,
          message: `No index starts with ${fq(from.id, rel.from.columns)} (references ${displayTable(to.id)})`,
        });
      }
    }
    if (on("nullable-fk")) {
      for (const name of rel.from.columns) {
        const c = fromCols.get(name);
        if (c && !c.notNull && !c.pk) {
          add({ rule: "nullable-fk", severity: "info", table: from.id, column: name, message: `${fq(from.id, [name])} is a foreign key that allows NULL` });
        }
      }
    }
  }

  // --- per table
  const declaredFrom = new Set(model.relations.flatMap((r) => r.from.columns.map((c) => `${r.from.table}.${c}`)));
  const declaredTo = new Set(model.relations.flatMap((r) => r.to.columns.map((c) => `${r.to.table}.${c}`)));
  const byName = new Map<string, DocTable[]>();
  for (const t of model.tables) byName.set(t.name.toLowerCase(), [...(byName.get(t.name.toLowerCase()) ?? []), t]);
  const tableStyle = on("naming-style") ? dominantStyle(model.tables.map((t) => t.name)) : null;
  const columnStyle = on("naming-style") ? dominantStyle(model.tables.flatMap((t) => t.columns.map((c) => c.name))) : null;

  for (const t of model.tables) {
    const keys = indexKeys(t);
    if (on("no-primary-key") && !keys.some((k) => k.name === "primary key")) {
      add({ rule: "no-primary-key", severity: "warning", table: t.id, column: null, message: `${displayTable(t.id)} has no primary key` });
    }
    if (on("duplicate-index") || on("redundant-index")) {
      keys.forEach((a, i) =>
        keys.forEach((b, j) => {
          if (j <= i || a.columns.some((c) => c.startsWith("`")) || b.columns.some((c) => c.startsWith("`"))) return;
          if (on("duplicate-index") && sameList(a.columns, b.columns)) {
            add({
              rule: "duplicate-index", severity: "warning", table: t.id, column: a.columns.length === 1 ? a.columns[0] : null,
              message: `${displayTable(t.id)}: ${b.name} duplicates ${a.name} (${a.columns.join(", ")})`,
            });
          }
        }),
      );
      if (on("redundant-index")) {
        for (const a of keys) {
          if (a.unique || a.columns.some((c) => c.startsWith("`"))) continue;
          const wider = keys.find((b) => isPrefix(a.columns, b.columns));
          if (wider) {
            add({
              rule: "redundant-index", severity: "info", table: t.id, column: a.columns.length === 1 ? a.columns[0] : null,
              message: `${displayTable(t.id)}: ${a.name} (${a.columns.join(", ")}) is covered by ${wider.name} (${wider.columns.join(", ")})`,
            });
          }
        }
      }
    }
    if (on("reserved-word")) {
      const check = (name: string, column: string | null) => {
        const dialects = RESERVED[name.toLowerCase()];
        if (!dialects) return;
        add({
          rule: "reserved-word", severity: dialects.length === 1 && dialects[0] === OR ? "info" : "warning", table: t.id, column,
          message: `"${name}" is a reserved word in ${dialects.join(", ")}; it must be quoted there`,
        });
      };
      check(t.name, null);
      for (const c of t.columns) check(c.name, c.name);
    }
    if (on("possible-missing-fk")) {
      for (const c of t.columns) {
        const m = /^(.+?)(?:_id|Id|ID)$/.exec(c.name);
        if (!m || declaredFrom.has(`${t.id}.${c.name}`) || declaredTo.has(`${t.id}.${c.name}`)) continue;
        const base = m[1].replace(/_$/, "").toLowerCase();
        let targets = candidateNames(base)
          .flatMap((n) => byName.get(n) ?? [])
          .filter((x) => x.id !== t.id || !c.pk);
        if (!targets.length && base.length >= 3) {
          // Abbreviations: `org_id` → `organizations`, when exactly one table name starts that way.
          const prefixed = model.tables.filter((x) => x.name.toLowerCase().startsWith(base) && x.id !== t.id);
          if (prefixed.length === 1) targets = prefixed;
        }
        const target = targets.find((x) => x.schema === t.schema) ?? targets[0];
        const pk = target?.columns.filter((x) => x.pk);
        if (!target || pk?.length !== 1) continue;
        add({
          rule: "possible-missing-fk", severity: "info", table: t.id, column: c.name,
          message: `${fq(t.id, [c.name])} looks like a reference to ${fq(target.id, [pk[0].name])}, but no relationship is declared`,
          fix: { label: "Add Ref", append: refLine({ table: t.id, fields: [c.name] }, { table: target.id, fields: [pk[0].name] }) },
        });
      }
    }
    if (on("naming-style")) {
      const ts = styleOf(t.name);
      if (tableStyle && ts && ts !== tableStyle) {
        add({ rule: "naming-style", severity: "info", table: t.id, column: null, message: `Table ${t.name} is ${STYLE_LABEL[ts]}; most tables are ${STYLE_LABEL[tableStyle]}` });
      }
      for (const c of t.columns) {
        const cs = styleOf(c.name);
        if (columnStyle && cs && cs !== columnStyle) {
          add({ rule: "naming-style", severity: "info", table: t.id, column: c.name, message: `${fq(t.id, [c.name])} is ${STYLE_LABEL[cs]}; most columns are ${STYLE_LABEL[columnStyle]}` });
        }
      }
    }
    if (on("wide-table") && t.columns.length > MAX_COLUMNS) {
      add({ rule: "wide-table", severity: "info", table: t.id, column: null, message: `${displayTable(t.id)} has ${t.columns.length} columns` });
    }
  }

  const seen = new Set<string>();
  return findings
    .filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.table.localeCompare(b.table) || (a.column ?? "").localeCompare(b.column ?? ""));
}
