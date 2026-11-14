import type { Database } from "@dbml/core";

import { loadDbmlCore } from "../core/dbml";
import type { DatabaseSchemaJson } from "../core/tauri-api.service";
import { adaptModel } from "./ddl-translate";
import { sqlComment } from "./sql-comment";
import type { ExportDialect, SqlDialect } from "./type-map";

export type { ExportDialect, SqlDialect } from "./type-map";

export const IMPORT_DIALECTS: { value: SqlDialect; label: string }[] = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL / MariaDB" },
  { value: "mssql", label: "SQL Server" },
  { value: "sqlite", label: "SQLite" },
  { value: "oracle", label: "Oracle" },
  { value: "snowflake", label: "Snowflake" },
  { value: "schemarb", label: "Rails schema.rb" },
];

export const EXPORT_DIALECTS: { value: ExportDialect; label: string }[] = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mssql", label: "SQL Server" },
  { value: "oracle", label: "Oracle" },
];

export function dialectLabel(d: SqlDialect): string {
  return IMPORT_DIALECTS.find((x) => x.value === d)?.label ?? d;
}

const HINTS: Record<Exclude<SqlDialect, "schemarb">, RegExp[]> = {
  postgres: [/\bserial\b/i, /::\w/, /\bcreate\s+extension\b/i, /\bpg_catalog\b/i, /\btimestamptz\b/i, /\bjsonb\b/i, /\bas\s+enum\b/i, /\bowner\s+to\b/i, /\busing\s+btree\b/i, /\bbytea\b/i],
  mysql: [/`/, /\bengine\s*=/i, /\bauto_increment\b/i, /\bunsigned\b/i, /\btinyint\s*\(/i, /\bcharset\b/i, /\blongtext\b/i],
  mssql: [/\[dbo\]/i, /^\s*go\s*$/im, /\bidentity\s*\(/i, /\bnvarchar\b/i, /\bsp_addextendedproperty\b/i, /\bdatetime2\b/i, /\buniqueidentifier\b/i],
  sqlite: [/\bautoincrement\b/i, /^\s*pragma\b/im, /\bwithout\s+rowid\b/i],
  oracle: [/\bvarchar2\b/i, /\bnumber\s*\(/i, /\bnvarchar2\b/i, /\bclob\b/i, /\bsysdate\b/i],
  snowflake: [/\bvariant\b/i, /\bcreate\s+or\s+replace\s+table\b/i, /\btimestamp_ntz\b/i, /\bcluster\s+by\b/i],
};

/** Best guess of a DDL script's dialect from its file name and telltale syntax. */
export function guessDialect(text: string, fileName = ""): SqlDialect {
  if (/\.rb$/i.test(fileName) || /ActiveRecord::Schema|^\s*create_table\s+"/m.test(text)) return "schemarb";
  let best: SqlDialect = "postgres";
  let bestScore = 0;
  for (const [dialect, hints] of Object.entries(HINTS) as [SqlDialect, RegExp[]][]) {
    const score = hints.filter((h) => h.test(text)).length;
    if (score > bestScore) [best, bestScore] = [dialect, score];
  }
  return best;
}

/**
 * Removes what the dialect's importer chokes on but a diagram does not need: `COPY … FROM
 * stdin` data and psql meta-commands (pg_dump), `EXEC` calls (SQL Server scripts). Removed lines
 * become blank lines so error positions still match the original text.
 */
export function prepareSql(text: string, dialect: SqlDialect): { text: string; skipped: string[] } {
  const lines = text.split(/\r?\n/);
  let copies = 0;
  let execs = 0;
  let meta = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (dialect === "postgres" && /^\s*COPY\s.+\bFROM\s+stdin\s*;\s*$/i.test(line)) {
      copies++;
      let j = i;
      while (j < lines.length && lines[j] !== "\\.") lines[j++] = "";
      if (j < lines.length) lines[j] = "";
      i = j;
    } else if (dialect === "postgres" && line.startsWith("\\")) {
      meta++;
      lines[i] = "";
    } else if (dialect === "mssql" && /^\s*EXEC(UTE)?\b/i.test(line)) {
      execs++;
      lines[i] = "";
    }
  }
  const skipped = [
    copies ? `COPY data ×${copies}` : "",
    meta ? `psql commands ×${meta}` : "",
    execs ? `EXEC ×${execs}` : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), skipped };
}

/**
 * The SQL Server importer leaves `IDENTITY(1,1)` inside the type (`"BIGINT IDENTITY(1,1)"`);
 * turn it into a plain type with the `increment` setting.
 */
export function fixIdentityTypes(dbml: string): string {
  return dbml.replace(
    /^(\s+"(?:[^"]|"")+"\s+)"([^"]+?)\s+IDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)"(?:\s*\[([^\]]*)\])?/gim,
    (_, pre: string, type: string, settings?: string) => `${pre}${type} [${settings ? `increment, ${settings}` : "increment"}]`,
  );
}

/** Drops DBML `Records` blocks (sample rows the importer builds from INSERT statements). */
export function stripRecords(dbml: string): string {
  return dbml.replace(/^Records\b[^\n]*\{\n[\s\S]*?^\}\n?/gm, "").replace(/\n{3,}/g, "\n\n");
}

export interface ImportResult {
  dbml: string;
  tables: number;
  refs: number;
  enums: number;
  skipped: string[];
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly line: number | null,
  ) {
    super(message);
  }
}

/** Message and line of an importer/parser failure (`CompilerError` carries `diags`). */
export function toImportError(err: unknown): ImportError {
  const e = err as { diags?: { message?: string; location?: { start?: { line?: number } } }[]; message?: string };
  const d = e?.diags?.[0];
  const message = (d?.message ?? e?.message ?? String(err)).replace(/\s+/g, " ").slice(0, 300);
  return new ImportError(message, d?.location?.start?.line ?? null);
}

/**
 * DDL → DBML. SQLite goes through the Rust side (`importSqlite`), which runs the script's CREATE
 * statements in a private in-memory database; every other dialect uses `@dbml/core`'s importer.
 */
export async function importDdl(
  text: string,
  dialect: SqlDialect,
  importSqlite: (sql: string) => Promise<{ schema: DatabaseSchemaJson; skipped: string[] }>,
): Promise<ImportResult> {
  const { importer, Parser } = await loadDbmlCore();
  let dbml: string;
  let skipped: string[];
  try {
    if (dialect === "sqlite") {
      const r = await importSqlite(text);
      dbml = importer.generateDbml(r.schema);
      skipped = r.skipped;
    } else {
      const prepared = prepareSql(text, dialect);
      dbml = stripRecords(importer.import(prepared.text, dialect));
      if (dialect === "mssql") dbml = fixIdentityTypes(dbml);
      skipped = prepared.skipped;
      if (/^\s*INSERT\b/im.test(text)) skipped.push("INSERT data");
    }
  } catch (err) {
    if (typeof err === "string") throw new ImportError(err, Number(/^Line (\d+)/.exec(err)?.[1]) || null);
    throw toImportError(err);
  }
  let db: Database;
  try {
    db = new Parser().parse(dbml, "dbmlv2");
  } catch (err) {
    throw toImportError(err);
  }
  const count = (key: "tables" | "refs" | "enums") => db.schemas.reduce((n, s) => n + (s[key] as unknown[]).length, 0);
  if (count("tables") === 0) throw new ImportError("No tables found", null);
  return { dbml, tables: count("tables"), refs: count("refs"), enums: count("enums"), skipped };
}

/**
 * Exporter output quirks: SQL Server index columns come out double-quoted, which only parses with
 * QUOTED_IDENTIFIER ON (sqlcmd and many tools default to OFF); brackets always work.
 */
function fixOutput(sql: string, target: ExportDialect): string {
  if (target !== "mssql") return sql;
  return sql.replace(/^(CREATE (?:UNIQUE )?(?:NONCLUSTERED |CLUSTERED )?INDEX .*)$/gm, (line) =>
    line.replace(/"((?:[^"]|"")+)"/g, (_, id: string) => `[${id.replace(/""/g, '"').replace(/]/g, "]]")}]`),
  );
}

export interface DdlExport {
  sql: string;
  /** Types that were converted or kept, for the header. */
  notes: string[];
}

/**
 * DBML → DDL for `target`. When the schema came from another dialect, types, defaults, checks and
 * indexes are adapted first (see `ddl-translate.ts`); the header lists what changed or was left out.
 */
export async function exportDdl(
  dbml: string,
  target: ExportDialect,
  options: { source: SqlDialect | null; title: string; origin: string | null; now?: Date },
): Promise<DdlExport> {
  const { ModelExporter, Parser } = await loadDbmlCore();
  let db: Database;
  try {
    db = new Parser().parse(stripRecords(dbml), "dbmlv2");
  } catch {
    throw new Error("The DBML has errors; fix them before exporting SQL.");
  }
  const report = adaptModel(db, options.source, target);
  let body: string;
  try {
    body = fixOutput(ModelExporter.export(db, target, false), target);
  } catch (err) {
    throw new Error(`${EXPORT_DIALECTS.find((d) => d.value === target)?.label} export failed: ${(err as Error)?.message ?? err}`);
  }
  const label = EXPORT_DIALECTS.find((d) => d.value === target)?.label ?? target;
  // Titles, notes and names come from the schema: `sqlComment` keeps a line break in them inside the comment.
  const header = [
    sqlComment(`${label} DDL for ${options.title}, generated by xdiagram on ${(options.now ?? new Date()).toISOString().slice(0, 10)}`),
    ...(options.origin ? [sqlComment(`Source: ${options.origin}`)] : []),
    ...(report.converted ? [`-- ${report.converted} column type(s) converted${options.source ? ` from ${dialectLabel(options.source)}` : ""}.`] : []),
    ...report.notes.map((n) => sqlComment(`Note: ${n}.`)),
    ...(report.kept.length ? [sqlComment(`Kept as written (check them): ${report.kept.join(", ")}.`)] : []),
    ...(report.dropped.length ? ["-- Left out (not expressible here):", ...report.dropped.map((d) => sqlComment(`  ${d.replace(/\s+/g, " ")}`))] : []),
    ...(target === "oracle" && db.schemas.length > 1 ? ["-- Note: Oracle schemas are users; create them before running this script."] : []),
    "-- Review before running; xdiagram never runs it.",
    "",
  ];
  return { sql: header.join("\n") + "\n" + body.trim() + "\n", notes: report.notes };
}
