import type { ColKind, FilterIssue } from "../core/tauri-api.service";
import { type FilterNode, LIMITS } from "./model";

/** `YYYY-MM-DD` that is a real calendar date. */
export function isDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
}

/** `HH:MM`, `HH:MM:SS` or `HH:MM:SS.fff`. */
export function isTime(v: string): boolean {
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/.exec(v);
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59 && Number(m[3] ?? 0) <= 59;
}

/** A date, optionally followed by `T`/space and a time, optionally with `Z` or `±HH[:MM]`. */
export function isTimestamp(v: string, offsetAllowed = true): boolean {
  if (!isDate(v.slice(0, 10))) return false;
  const rest = v.slice(10);
  if (!rest) return true;
  const m = /^[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(rest);
  return !!m && isTime(m[1]) && (offsetAllowed || !m[2]);
}

/**
 * Why `value` cannot be compared with a column of this kind, or null when it can. The same
 * rules as Rust's `check_value`, so problems show while typing.
 */
export function checkValue(kind: ColKind, value: string): string | null {
  const v = value.trim();
  const bad = (what: string) => `“${v}” is not ${what}`;
  switch (kind) {
    case "int":
      return /^[+-]?\d+$/.test(v) ? null : bad("a whole number");
    case "decimal":
      return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v) ? null : bad("a number");
    case "float":
      return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v) ? null : bad("a number");
    case "bool":
      return /^(true|false|t|f|1|0|yes|no|y|n|on|off)$/i.test(v) ? null : bad("true or false");
    case "uuid":
      return /^[0-9a-f]{32}$/i.test(v.replace(/[-{}]/g, "")) ? null : bad("a UUID");
    case "date":
      return isDate(v) ? null : bad("a date (YYYY-MM-DD)");
    case "time":
      return isTime(v) ? null : bad("a time (HH:MM:SS)");
    case "timestamp":
      return isTimestamp(v, false) ? null : bad("a date and time (YYYY-MM-DD HH:MM:SS)");
    case "timestamptz":
      return isTimestamp(v) ? null : bad("a date and time (YYYY-MM-DD HH:MM:SS)");
    case "binary": {
      const hex = v.replace(/^(0x|\\x)/i, "");
      return hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex) ? null : bad("hex bytes (0x…)");
    }
    default:
      return null;
  }
}

/** Conditions whose values cannot match their column (checked before anything is sent). */
export function treeIssues(node: FilterNode, kindOfColumn: (column: string) => ColKind | null): FilterIssue[] {
  if (node.off) return [];
  if (node.t === "group") return node.items.flatMap((i) => treeIssues(i, kindOfColumn));
  // The related table's values are checked by Rust, which knows its columns.
  if (node.t === "rel") return [];
  // Two columns: Rust checks that their kinds compare.
  if (node.t === "cols" || node.t === "dup") return [];
  const kind = kindOfColumn(node.column);
  if (!kind) return [];
  if (node.op === "in" || node.op === "notIn") {
    if (node.args.length > LIMITS.list) return [{ node: node.id, message: `A list can hold ${LIMITS.list} values at most` }];
  }
  for (const a of node.args) {
    if (typeof a !== "string") continue;
    const message = ["contains", "notContains", "startsWith", "endsWith", "regex"].includes(node.op) ? null : checkValue(kind, a);
    if (message) return [{ node: node.id, message }];
  }
  return [];
}
