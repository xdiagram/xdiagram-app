import type { Database, Field } from "@dbml/core";

import { type ExportDialect, type SqlDialect, classifyType, conversionNote, renderType } from "./type-map";

/**
 * Adapts a parsed schema to another SQL dialect before `@dbml/core` writes its DDL. The exporters
 * only change the syntax around a column, so without this pass a PostgreSQL schema exported for
 * SQL Server would keep `gen_random_uuid()`, `::numeric` casts, `DEFAULT (true)`, expression
 * indexes and unindexable `nvarchar(max)` keys. What cannot be translated is dropped and listed.
 */

export interface AdaptReport {
  converted: number;
  notes: string[];
  /** Types left as written (enums excluded). */
  kept: string[];
  dropped: string[];
}

const CAST = /::\s*(?:"[^"]+"|[a-z_][a-z0-9_]*)(?:\s+(?:varying|precision|with(?:out)? time zone))?(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])*/gi;

const FUNCTIONS: { re: RegExp; to: Record<ExportDialect, string> }[] = [
  {
    re: /\b(?:now\s*\(\s*\)|current_timestamp(?:\s*\(\s*\d*\s*\))?|localtimestamp|getdate\s*\(\s*\)|getutcdate\s*\(\s*\)|sysutcdatetime\s*\(\s*\)|sysdatetime\s*\(\s*\)|sysdatetimeoffset\s*\(\s*\)|systimestamp|statement_timestamp\s*\(\s*\)|clock_timestamp\s*\(\s*\)|transaction_timestamp\s*\(\s*\)|utc_timestamp\s*\(\s*\))/gi,
    to: { postgres: "now()", mysql: "CURRENT_TIMESTAMP", mssql: "SYSDATETIME()", oracle: "SYSTIMESTAMP" },
  },
  {
    re: /\b(?:gen_random_uuid\s*\(\s*\)|uuid_generate_v4\s*\(\s*\)|newid\s*\(\s*\)|newsequentialid\s*\(\s*\)|uuid\s*\(\s*\)|sys_guid\s*\(\s*\))/gi,
    to: { postgres: "gen_random_uuid()", mysql: "UUID()", mssql: "NEWID()", oracle: "SYS_GUID()" },
  },
  {
    re: /\b(?:current_date|curdate\s*\(\s*\))/gi,
    to: { postgres: "CURRENT_DATE", mysql: "CURRENT_DATE", mssql: "CAST(GETDATE() AS date)", oracle: "TRUNC(SYSDATE)" },
  },
];

/** Constructs only one engine understands; an expression containing one is dropped. */
const NON_PORTABLE: Record<ExportDialect, RegExp> = {
  postgres: /\bifnull\s*\(|\bisnull\s*\(|\bgetdate\b|\b(?:len|datalength|nvl|sysdate)\s*\(|\bb'[01]+'|\bunix_timestamp\b/i,
  mysql: /\bnextval\s*\(|\barray\s*\[|::|\bjsonb?_[a-z_]+\s*\(|\bto_tsvector\b|\bregclass\b|\bpg_[a-z_]+|\binterval\s+'|\bilike\b|~|\$\d/i,
  mssql: /\bnextval\s*\(|\barray\s*\[|::|\bjsonb?_[a-z_]+\s*\(|\bto_tsvector\b|\bregclass\b|\bpg_[a-z_]+|\binterval\s+'|\bilike\b|~|\$\d|\bifnull\s*\(|\blimit\b/i,
  oracle: /\bnextval\s*\(|\barray\s*\[|::|\bjsonb?_[a-z_]+\s*\(|\bto_tsvector\b|\bregclass\b|\bpg_[a-z_]+|\bilike\b|~|\$\d|\bifnull\s*\(/i,
};

/** Splits `'a', 'b''c', 3` into items (top level, quotes respected). */
function splitItems(list: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "'") {
      if (quoted && list[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (c === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** `ARRAY['a', 'b']` → `'["a","b"]'` (JSON text), or null when the items are not literals. */
function arrayToJson(expr: string): string | null {
  const m = /^array\s*\[(.*)\]$/is.exec(expr.trim());
  if (!m) return null;
  const items: (string | number)[] = [];
  for (const item of splitItems(m[1])) {
    const s = /^'((?:[^']|'')*)'$/.exec(item);
    if (s) items.push(s[1].replace(/''/g, "'"));
    else if (/^-?\d+(\.\d+)?$/.test(item)) items.push(Number(item));
    else return null;
  }
  return `'${JSON.stringify(items).replace(/'/g, "''")}'`;
}

/**
 * An expression (default or CHECK) rewritten for `target`, or null when it cannot be expressed
 * there. `array` marks a value of a PostgreSQL array column (it becomes JSON text elsewhere).
 */
export function translateExpr(expr: string, source: SqlDialect | null, target: ExportDialect, array = false): string | null {
  if (source === target) return expr;
  let e = expr.trim();
  if (target !== "postgres") {
    if (/^'?\{\s*\}'?$/.test(e)) return array ? "'[]'" : "'{}'";
    const json = array ? arrayToJson(e.replace(CAST, "")) : null;
    if (json) return json;
    e = e.replace(CAST, "");
  }
  if (source === "mssql") e = e.replace(/\[([A-Za-z_][\w$]*)\]/g, "$1");
  for (const f of FUNCTIONS) e = e.replace(f.re, f.to[target]);
  if (target === "mssql" || target === "oracle") e = e.replace(/\btrue\b/gi, "1").replace(/\bfalse\b/gi, "0");
  if (NON_PORTABLE[target].test(e)) return null;
  return e;
}

/** Type for a text column that is part of a key or index (unbounded text cannot be indexed there). */
const KEYED_TEXT: Record<ExportDialect, string | null> = { postgres: null, mysql: "varchar(255)", mssql: "nvarchar(450)", oracle: "varchar2(4000)" };

const label = (table: { name: string; schema?: { name: string } | null }, field?: string) =>
  `${table.schema && table.schema.name !== "public" ? `${table.schema.name}.` : ""}${table.name}${field ? `.${field}` : ""}`;

/** Rewrites `db` in place for `target`; see the module comment. */
export function adaptModel(db: Database, source: SqlDialect | null, target: ExportDialect): AdaptReport {
  const report: AdaptReport = { converted: 0, notes: [], kept: [], dropped: [] };
  const notes = new Set<string>();

  // Fixes every target needs, the source's own dialect included.
  for (const schema of db.schemas) {
    for (const table of schema.tables) {
      for (const field of table.fields) {
        const def = field.dbdefault as { type: string; value: unknown } | null;
        // Introspection writes `'{}'::jsonb` / `'{}'::text[]` defaults as a bare `{}` expression.
        if (def?.type === "expression" && /^\{\s*\}$/.test(String(def.value))) def.value = "'{}'";
      }
    }
  }
  // MySQL has no schemas: each one becomes a database, and FKs into the default schema only
  // resolve when it is named too.
  if (target === "mysql" && db.schemas.filter((s) => s.tables.length).length > 1) {
    const main = db.schemas.find((s) => s.name === "public");
    if (main?.tables.length) {
      main.name = "main";
      notes.add("MySQL has no schemas: each schema becomes a database, and the default schema becomes `main`");
    }
  }
  if (source === target) {
    report.notes = [...notes];
    return report;
  }
  const kept = new Set<string>();
  const enumNames = new Set(db.schemas.flatMap((s) => s.enums.map((e) => e.name)));

  // Columns that take part in a key, an index or a relationship.
  const keyed = new Set<Field>();
  for (const schema of db.schemas) {
    for (const table of schema.tables) {
      for (const f of table.fields) if (f.pk || f.unique) keyed.add(f);
      for (const ix of table.indexes) {
        for (const c of ix.columns) {
          const f = c.type === "column" ? table.fields.find((x) => x.name === c.value) : undefined;
          if (f) keyed.add(f);
        }
      }
    }
    for (const ref of schema.refs) for (const ep of ref.endpoints) for (const f of ep.fields ?? []) keyed.add(f);
  }

  for (const schema of db.schemas) {
    for (const table of schema.tables) {
      for (const field of table.fields) {
        const type = field.type as unknown as { type_name: string; args: string | null };
        const isArray = type.type_name.trim().endsWith("]");
        if (!enumNames.has(type.type_name)) {
          const portable = isArray ? { kind: "json" as const } : classifyType(type.type_name, source);
          if (portable) {
            let rendered = renderType(portable, target);
            if (portable.kind === "text" && keyed.has(field) && KEYED_TEXT[target]) {
              rendered = KEYED_TEXT[target]!;
              notes.add(`text columns used in keys or indexes become ${rendered}`);
            }
            if (isArray) notes.add("array columns become JSON");
            const note = conversionNote(portable, target);
            if (note) notes.add(note);
            if (rendered !== type.type_name) report.converted++;
            type.type_name = rendered;
            type.args = /\(([^)]*)\)/.exec(rendered)?.[1] ?? null;
          } else {
            kept.add(type.type_name);
          }
        }

        const def = field.dbdefault as { type: string; value: string | number | boolean } | null;
        const isBool = classifyType(type.type_name, null)?.kind === "bool";
        if (def?.type === "number" && isBool && target === "postgres") {
          field.dbdefault = { type: "boolean", value: Number(def.value) !== 0 ? "true" : "false" } as never;
        } else if (def?.type === "boolean" && (target === "mssql" || target === "oracle")) {
          field.dbdefault = { type: "number", value: String(def.value).toLowerCase() === "true" ? 1 : 0 } as never;
        } else if (def?.type === "expression") {
          const t = translateExpr(String(def.value), source, target, isArray);
          if (t === null) {
            field.dbdefault = null as never;
            report.dropped.push(`default of ${label(table, field.name)}: ${def.value}`);
          } else def.value = t;
        }
        field.checks = field.checks.filter((c) => {
          const t = translateExpr(c.expression, source, target);
          if (t === null) report.dropped.push(`check on ${label(table, field.name)}: ${c.expression}`);
          else c.expression = t;
          return t !== null;
        });
      }
      table.checks = table.checks.filter((c) => {
        const t = translateExpr(c.expression, source, target);
        if (t === null) report.dropped.push(`check on ${label(table)}: ${c.expression}`);
        else c.expression = t;
        return t !== null;
      });
      // Expression indexes are written in the source dialect (SQL Server has none at all).
      table.indexes = table.indexes.filter((ix) => {
        const expr = ix.columns.some((c) => c.type === "expression");
        if (expr) report.dropped.push(`index ${ix.name ?? "(unnamed)"} on ${label(table)} (expression index; rewrite it for the target)`);
        return !expr;
      });
    }
  }
  // Referential actions each engine accepts.
  for (const schema of db.schemas) {
    for (const ref of schema.refs) {
      const r = ref as unknown as { onDelete: string | null; onUpdate: string | null; name: string | null };
      const name = r.name ?? ref.endpoints.map((e) => `${e.tableName}.${e.fieldNames.join(",")}`).join(" → ");
      for (const key of ["onDelete", "onUpdate"] as const) {
        const action = r[key]?.toLowerCase().replace(/_/g, " ");
        if (!action) continue;
        let next: string | null = r[key];
        if (target === "mssql" && action === "restrict") next = "no action";
        if (target === "mysql" && action === "set default") next = "no action";
        if (target === "oracle") {
          if (key === "onUpdate") next = null;
          else if (action !== "cascade" && action !== "set null") next = null;
        }
        if (next !== r[key]) {
          if (next === null || next === "no action") notes.add(`referential actions ${target === "oracle" ? "Oracle" : target === "mssql" ? "SQL Server" : "MySQL"} lacks were dropped or became NO ACTION`);
          if (next === null) report.dropped.push(`${key === "onDelete" ? "ON DELETE" : "ON UPDATE"} ${action} of ${name}`);
          r[key] = next;
        }
      }
    }
  }

  report.notes = [...notes];
  report.kept = [...kept].sort();
  return report;
}
