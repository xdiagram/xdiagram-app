import type { ColKind } from "../core/tauri-api.service";
import { type FilterNode, SEARCH_COLUMN, type WireNode } from "./model";
import { formatMoment, resolvePoint, resolveSpan } from "./relative-dates";
import { isDate } from "./validate";

/**
 * The tree as Rust takes it: switched-off nodes and empty groups dropped, periods and relative
 * dates resolved against `now`, and date-only bounds on timestamp columns turned into whole days
 * (`between 2026-11-01 and 2026-11-14` includes all of the 14th). `null`: nothing to filter.
 */
export function toWire(node: FilterNode | null, now: Date, kindOf: (column: string) => ColKind, relKindOf?: (tableId: string) => (column: string) => ColKind): WireNode | null {
  if (!node || node.off) return null;
  if (node.t === "group") {
    const items = node.items.map((i) => toWire(i, now, kindOf, relKindOf)).filter((i): i is WireNode => !!i);
    if (!items.length) return null;
    return { t: "group", id: node.id, op: node.op, ...(node.not ? { not: true } : {}), items };
  }
  if (node.t === "cols") return { t: "cols", id: node.id, left: node.left, op: node.op, right: node.right };
  if (node.t === "dup") return node.columns.length ? { t: "dup", id: node.id, columns: node.columns } : null;
  if (node.t === "rel") {
    // The related table's kinds when known; else timestamps (Rust takes them for dates too).
    const inner = relKindOf?.(`${node.schema}.${node.table}`) ?? (() => "timestamp" as ColKind);
    const filter = node.filter ? toWire(node.filter, now, inner, relKindOf) : null;
    return { t: "rel", id: node.id, schema: node.schema, table: node.table, on: node.on, quant: node.quant, ...(filter ? { filter } : {}) };
  }
  if (node.column === SEARCH_COLUMN) {
    const text = typeof node.args[0] === "string" ? node.args[0] : "";
    return text.trim() ? { t: "search", id: node.id, text, ...(node.cs ? { cs: true } : {}) } : null;
  }
  const kind = kindOf(node.column);
  const timestamp = kind === "timestamp" || kind === "timestamptz";
  if (node.op === "range" && node.span) {
    return { t: "cond", id: node.id, column: node.column, op: "range", args: resolveSpan(node.span, now, kind) };
  }
  const args = node.args.map((a) => (typeof a === "string" ? a : resolvePoint(a, now, kind)));
  if (node.op === "between" && timestamp && args.length === 2 && args.every(isDate)) {
    const [y, m, d] = args[1].split("-").map(Number);
    const from = formatMoment(new Date(Number(args[0].slice(0, 4)), Number(args[0].slice(5, 7)) - 1, Number(args[0].slice(8, 10))), kind);
    return { t: "cond", id: node.id, column: node.column, op: "range", args: [from, formatMoment(new Date(y, m - 1, d + 1), kind)] };
  }
  return { t: "cond", id: node.id, column: node.column, op: node.op, args, ...(node.cs ? { cs: true } : {}) };
}

/** A stable key for a wire tree (ids left out), to cache counts by filter. */
export function wireKey(node: WireNode | null): string {
  return JSON.stringify(node, (k, v) => (k === "id" ? undefined : v));
}
