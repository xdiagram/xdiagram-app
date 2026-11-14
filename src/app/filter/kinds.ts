import type { BrowseColumn, ColKind, Engine } from "../core/tauri-api.service";
import { classifyType } from "../export/type-map";

const FROM_PORTABLE: Record<string, ColKind> = {
  smallint: "int",
  int: "int",
  bigint: "int",
  bool: "bool",
  decimal: "decimal",
  real: "float",
  double: "float",
  varchar: "text",
  char: "text",
  text: "text",
  uuid: "uuid",
  json: "json",
  binary: "binary",
  date: "date",
  time: "time",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
};

/** A column's kind: as Rust reported it, else guessed from the type name. */
export function kindOf(col: Pick<BrowseColumn, "typeName" | "kind">, engine: Engine | null = null): ColKind {
  if (col.kind) return col.kind;
  const t = classifyType(col.typeName, engine);
  if (t) return FROM_PORTABLE[t.kind] ?? "other";
  return /^enum\s*\(/i.test(col.typeName) ? "enum" : "other";
}

export const isNumericKind = (k: ColKind): boolean => k === "int" || k === "decimal" || k === "float";
export const isDateKind = (k: ColKind): boolean => k === "date" || k === "timestamp" || k === "timestamptz";
/** Kinds whose values have an order (`<`, between, sort). */
export const isOrderedKind = (k: ColKind): boolean => isNumericKind(k) || isDateKind(k) || k === "time" || k === "text";
/** Whether two columns of these kinds compare (as Rust's `filter::comparable`, plus text with enums). */
export function comparableKinds(a: ColKind, b: ColKind): boolean {
  if (a === b) return a !== "json" && a !== "binary" && a !== "other";
  const text = (k: ColKind) => k === "text" || k === "enum";
  return (isNumericKind(a) && isNumericKind(b)) || (isDateKind(a) && isDateKind(b)) || (text(a) && text(b));
}

/** Kinds where text matching (contains, starts with, …) makes sense. */
export const isTextLike = (k: ColKind): boolean => k === "text" || k === "enum" || k === "json" || k === "other" || k === "uuid";
