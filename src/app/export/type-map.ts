/**
 * Column type conversion between SQL dialects, used when exporting DDL for a database other than
 * the one the schema came from. `@dbml/core`'s exporters write types through unchanged, so a
 * PostgreSQL `timestamptz` would land in SQL Server DDL as-is (and `timestamp` there means
 * rowversion). Types are classified into a small portable set, then rendered for the target.
 * Anything not recognised (enums, arrays, domains, spatial types…) is left as written.
 */

export type SqlDialect = "postgres" | "mysql" | "mssql" | "oracle" | "sqlite" | "snowflake" | "schemarb";
export type ExportDialect = "postgres" | "mysql" | "mssql" | "oracle";

export type TypeKind =
  | "smallint"
  | "int"
  | "bigint"
  | "bool"
  | "decimal"
  | "real"
  | "double"
  | "varchar"
  | "char"
  | "text"
  | "uuid"
  | "json"
  | "binary"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz";

export interface PortableType {
  kind: TypeKind;
  /** Character length (`varchar(n)`, `char(n)`). */
  length?: number;
  precision?: number;
  scale?: number;
}

const KINDS: Record<string, TypeKind> = {
  smallint: "smallint", int2: "smallint", tinyint: "smallint", year: "smallint",
  int: "int", int4: "int", integer: "int", mediumint: "int", serial: "int", serial4: "int",
  bigint: "bigint", int8: "bigint", bigserial: "bigint", serial8: "bigint",
  bool: "bool", boolean: "bool", bit: "bool",
  numeric: "decimal", decimal: "decimal", dec: "decimal", number: "decimal", money: "decimal", smallmoney: "decimal",
  real: "real", float4: "real", binary_float: "real",
  float: "double", float8: "double", double: "double", "double precision": "double", binary_double: "double",
  varchar: "varchar", "character varying": "varchar", nvarchar: "varchar", varchar2: "varchar", nvarchar2: "varchar", string: "varchar",
  char: "char", character: "char", bpchar: "char", nchar: "char",
  text: "text", tinytext: "text", mediumtext: "text", longtext: "text", clob: "text", nclob: "text", ntext: "text", citext: "text",
  uuid: "uuid", uniqueidentifier: "uuid",
  json: "json", jsonb: "json",
  bytea: "binary", blob: "binary", tinyblob: "binary", mediumblob: "binary", longblob: "binary", binary: "binary", varbinary: "binary", image: "binary", raw: "binary",
  date: "date",
  time: "time", timetz: "time",
  timestamp: "timestamp", datetime: "timestamp", datetime2: "timestamp", smalldatetime: "timestamp",
  timestamptz: "timestamptz", datetimeoffset: "timestamptz",
};

const nums = (args: string | undefined): (number | "max")[] =>
  (args ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .map((a) => (a === "max" ? "max" : Number(a)));

/**
 * Classifies a written type (`varchar(255)`, `timestamp with time zone`, `tinyint(1)`,
 * `nvarchar(MAX)`…). `source` resolves the few names that mean different things per dialect.
 * Returns null for anything outside the portable set.
 */
export function classifyType(raw: string, source: SqlDialect | null = null): PortableType | null {
  const t = raw
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ identity\s*\(\s*\d+\s*,\s*\d+\s*\)$/, "");
  if (!t || t.endsWith("]")) return null; // arrays
  const m = /^([a-z_][a-z0-9_]*(?: (?:varying|precision))?)\s*(?:\(([^)]*)\))?(?: (with|without) time zone)?(?: unsigned)?(?: zerofill)?$/.exec(t);
  if (!m) return null;
  const [, base, args, tz] = m;
  let kind = KINDS[base];
  if (!kind) return null;
  const a = nums(args);

  if (base === "timestamp" && source === "mssql") kind = "binary"; // SQL Server's rowversion
  if (base === "tinyint" && a[0] === 1) kind = "bool";
  if (base === "bit" && a.length && a[0] !== 1) return null; // bit strings
  if (base === "float" && source === "mysql") kind = "real";
  if (base === "date" && source === "oracle") kind = "timestamp"; // Oracle DATE carries a time
  if (tz === "with") kind = kind === "time" ? "time" : "timestamptz";

  if (kind === "varchar" || kind === "char") {
    if (a[0] === "max") return { kind: "text" };
    return typeof a[0] === "number" && a[0] > 0 ? { kind, length: a[0] } : { kind };
  }
  if (kind === "decimal") {
    if (base === "money") return { kind, precision: 19, scale: 4 };
    if (base === "smallmoney") return { kind, precision: 10, scale: 4 };
    const [p, s] = a;
    return typeof p === "number" ? { kind, precision: p, scale: typeof s === "number" ? s : 0 } : { kind };
  }
  return { kind };
}

/** Renders a portable type for an export dialect. */
export function renderType(t: PortableType, target: ExportDialect): string {
  const len = t.length;
  const ps = t.precision !== undefined ? `(${t.precision},${t.scale ?? 0})` : "";
  switch (target) {
    case "postgres":
      return {
        smallint: "smallint", int: "integer", bigint: "bigint", bool: "boolean", decimal: `numeric${ps}`, real: "real",
        double: "double precision", varchar: len ? `varchar(${len})` : "varchar", char: `char(${len ?? 1})`, text: "text",
        uuid: "uuid", json: "jsonb", binary: "bytea", date: "date", time: "time", timestamp: "timestamp", timestamptz: "timestamptz",
      }[t.kind];
    case "mysql":
      return {
        smallint: "smallint", int: "int", bigint: "bigint", bool: "tinyint(1)", decimal: ps ? `decimal${ps}` : "decimal(38,10)",
        real: "float", double: "double", varchar: len && len <= 16383 ? `varchar(${len})` : len ? "longtext" : "varchar(255)",
        char: `char(${Math.min(len ?? 1, 255)})`, text: "longtext", uuid: "char(36)", json: "json", binary: "longblob",
        date: "date", time: "time", timestamp: "datetime", timestamptz: "datetime",
      }[t.kind];
    case "mssql":
      return {
        smallint: "smallint", int: "int", bigint: "bigint", bool: "bit", decimal: ps ? `decimal${ps}` : "decimal(38,10)",
        real: "real", double: "float", varchar: len && len <= 4000 ? `nvarchar(${len})` : len ? "nvarchar(max)" : "nvarchar(255)",
        char: `nchar(${Math.min(len ?? 1, 4000)})`, text: "nvarchar(max)", uuid: "uniqueidentifier", json: "nvarchar(max)",
        binary: "varbinary(max)", date: "date", time: "time", timestamp: "datetime2", timestamptz: "datetimeoffset",
      }[t.kind];
    case "oracle":
      return {
        smallint: "number(5)", int: "number(10)", bigint: "number(19)", bool: "number(1)", decimal: `number${ps}`,
        real: "binary_float", double: "binary_double", varchar: len && len <= 4000 ? `varchar2(${len})` : len ? "clob" : "varchar2(255)",
        char: `char(${Math.min(len ?? 1, 2000)})`, text: "clob", uuid: "raw(16)", json: "clob", binary: "blob",
        date: "date", time: "varchar2(16)", timestamp: "timestamp", timestamptz: "timestamp with time zone",
      }[t.kind];
  }
}

/** Notes worth putting in the DDL header for a conversion. */
export function conversionNote(t: PortableType, target: ExportDialect): string | null {
  if (t.kind === "timestamptz" && target === "mysql") return "time-zone-aware timestamps become datetime (no zone)";
  if (t.kind === "time" && target === "oracle") return "time values become varchar2(16) (Oracle has no time type)";
  if (t.kind === "uuid" && target === "oracle") return "uuids become raw(16)";
  return null;
}

/**
 * The type to write for `target`, or null to keep the original (same dialect, or a type outside
 * the portable set).
 */
export function convertType(raw: string, source: SqlDialect | null, target: ExportDialect): { type: string; note: string | null } | null {
  if (source === target) return null;
  const t = classifyType(raw, source);
  if (!t) return null;
  return { type: renderType(t, target), note: conversionNote(t, target) };
}
