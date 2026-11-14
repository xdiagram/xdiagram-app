import type { ColKind, Engine } from "../core/tauri-api.service";
import { isDateKind, isNumericKind } from "./kinds";
import type { Op } from "./model";

export interface OpInfo {
  op: Op;
  /** Words, for menus. */
  label: string;
  /** Short form, for chips. */
  symbol: string;
  /** Values the operator takes: none, one, two, or a list. */
  arity: 0 | 1 | 2 | "list";
}

const INFO: Record<Op, OpInfo> = {
  eq: { op: "eq", label: "equals", symbol: "=", arity: 1 },
  ne: { op: "ne", label: "does not equal", symbol: "≠", arity: 1 },
  lt: { op: "lt", label: "less than", symbol: "<", arity: 1 },
  le: { op: "le", label: "at most", symbol: "≤", arity: 1 },
  gt: { op: "gt", label: "greater than", symbol: ">", arity: 1 },
  ge: { op: "ge", label: "at least", symbol: "≥", arity: 1 },
  between: { op: "between", label: "between", symbol: "between", arity: 2 },
  range: { op: "range", label: "in period", symbol: "in", arity: 2 },
  in: { op: "in", label: "is one of", symbol: "in", arity: "list" },
  notIn: { op: "notIn", label: "is none of", symbol: "not in", arity: "list" },
  isNull: { op: "isNull", label: "is null", symbol: "is null", arity: 0 },
  notNull: { op: "notNull", label: "is not null", symbol: "is not null", arity: 0 },
  contains: { op: "contains", label: "contains", symbol: "contains", arity: 1 },
  notContains: { op: "notContains", label: "does not contain", symbol: "does not contain", arity: 1 },
  startsWith: { op: "startsWith", label: "starts with", symbol: "starts with", arity: 1 },
  endsWith: { op: "endsWith", label: "ends with", symbol: "ends with", arity: 1 },
  isEmpty: { op: "isEmpty", label: "is empty", symbol: "is empty", arity: 0 },
  isBlank: { op: "isBlank", label: "is blank (empty or spaces)", symbol: "is blank", arity: 0 },
  isPadded: { op: "isPadded", label: "has leading or trailing spaces", symbol: "has extra spaces", arity: 0 },
  regex: { op: "regex", label: "matches regex", symbol: "matches", arity: 1 },
};

export function opInfo(op: Op): OpInfo {
  return INFO[op];
}

/** Engines with a regular-expression operator. */
export function hasRegex(engine: Engine | null): boolean {
  return engine === "postgres" || engine === "mysql";
}

/**
 * The operators offered for a column, most useful first. Mirrors what Rust accepts: ordering
 * needs a typed comparison (JSON and unknown types only compare for equality, except on
 * PostgreSQL), and the null checks are hidden for NOT NULL columns.
 */
export function opsFor(kind: ColKind, engine: Engine | null, nullable = true): OpInfo[] {
  const compare: Op[] = ["eq", "ne", "lt", "le", "gt", "ge", "between", "in", "notIn"];
  const textMatch: Op[] = ["contains", "notContains", "startsWith", "endsWith"];
  let ops: Op[];
  if (isNumericKind(kind) || isDateKind(kind) || kind === "time") ops = compare;
  else if (kind === "text") ops = ["eq", "ne", ...textMatch, "in", "notIn", "lt", "le", "gt", "ge", "between", "isEmpty", "isBlank", "isPadded", ...(hasRegex(engine) ? (["regex"] as Op[]) : [])];
  else if (kind === "enum") ops = ["eq", "ne", "in", "notIn", ...textMatch];
  else if (kind === "bool") ops = ["eq", "ne"];
  else if (kind === "uuid") ops = ["eq", "ne", "in", "notIn", ...textMatch];
  else if (kind === "binary") ops = ["eq", "ne"];
  else if (kind === "json") ops = ["eq", "ne", ...textMatch, "isEmpty"];
  else ops = [...(engine === "postgres" ? compare : (["eq", "ne", "in", "notIn"] as Op[])), ...textMatch, "isEmpty"];
  if (nullable) ops = [...ops, "isNull", "notNull"];
  return ops.map((op) => INFO[op]);
}
