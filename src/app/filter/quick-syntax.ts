import type { ColKind } from "../core/tauri-api.service";
import { isDateKind, isNumericKind } from "./kinds";
import { type Arg, type CondNode, type FilterNode, newId, type Op, type Span } from "./model";
import { parsePoint, printPoint } from "./relative-dates";
import { isDate } from "./validate";

const SPANS: Record<string, Span> = { today: "today", yesterday: "yesterday", thisweek: "thisWeek", thismonth: "thisMonth", thisyear: "thisYear" };
const COMPARE: Record<string, Op> = { ">=": "ge", "<=": "le", ">": "gt", "<": "lt", "=": "eq" };

/** Kinds where `a,b,c` is a list (text values may contain commas: use `in(…)` there). */
const listKind = (k: ColKind) => isNumericKind(k) || isDateKind(k) || k === "time" || k === "bool" || k === "uuid" || k === "enum" || k === "binary";
const rangeKind = (k: ColKind) => isNumericKind(k) || isDateKind(k) || k === "time";

const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/**
 * A column filter box's text as a condition (or a small group). `null`: the text is empty, so
 * the column's filter is removed.
 *
 *   abc =abc      equals            !=x <>x       not equal
 *   >5 >=5 <5 <=5 compare           10..20 10.. ..20   between / at least / at most
 *   ~x !~x        contains / not    ^x x* / *x    starts with / ends with
 *   /re/          regex             null !null    is null / is not null
 *   "NULL" ">5"   literal equality  ''            is empty
 *   a,b,c !a,b    in / not in list (not for text columns)
 *   today yesterday thisweek thismonth thisyear last7d   periods (date columns)
 *   >-7d          relative moment   2026-11-14    that whole day (timestamp columns)
 */
export function parseQuick(text: string, column: string, kind: ColKind): FilterNode | null {
  const t = text.trim();
  if (!t) return null;
  const cond = (op: Op, args: Arg[] = [], extra: Partial<CondNode> = {}): CondNode => ({ t: "cond", id: newId(), column, op, args, ...extra });
  const value = (v: string): Arg => (isDateKind(kind) ? parsePoint(v) : null) ?? unquote(v.trim());
  const lower = t.toLowerCase();

  if (lower === "null") return cond("isNull");
  if (lower === "!null") return cond("notNull");
  if (t === "''" || t === '""') return cond("isEmpty");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return cond("eq", [t.slice(1, -1)]);

  if (isDateKind(kind)) {
    const span = SPANS[lower.replace(/\s+/g, "")];
    if (span) return cond("range", [], { span });
    const last = /^last\s*(\d{1,4})\s*d(ays?)?$/.exec(lower);
    if (last) return cond("range", [], { span: { lastDays: Number(last[1]) } });
    if (kind !== "date" && isDate(t)) return cond("range", [], { span: { day: t } });
  }

  let m = /^(!=|<>)(.*)$/s.exec(t);
  if (m) return cond("ne", [value(m[2])]);
  m = /^(>=|<=|>|<|=)(.*)$/s.exec(t);
  if (m) return cond(COMPARE[m[1]], [value(m[2])]);
  if (t.startsWith("!~")) return cond("notContains", [t.slice(2).trim()]);
  if (t.startsWith("~")) return cond("contains", [t.slice(1).trim()]);
  if (t.startsWith("^") && t.length > 1) return cond("startsWith", [t.slice(1)]);
  if (t.length > 2 && t.startsWith("/") && t.endsWith("/")) return cond("regex", [t.slice(1, -1)]);
  if (t.length > 1 && t.startsWith("*")) return cond("endsWith", [t.slice(1)]);
  if (kind === "text" && t.length > 1 && t.endsWith("*")) return cond("startsWith", [t.slice(0, -1)]);

  if (rangeKind(kind)) {
    const i = t.indexOf("..");
    if (i >= 0) {
      const [a, b] = [t.slice(0, i).trim(), t.slice(i + 2).trim()];
      if (a && b) return cond("between", [value(a), value(b)]);
      if (a) return cond("ge", [value(a)]);
      if (b) return cond("le", [value(b)]);
    }
  }

  if (listKind(kind) && t.includes(",")) {
    const negate = t.startsWith("!");
    const parts = (negate ? t.slice(1) : t)
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const values = parts.filter((p) => p.toLowerCase() !== "null").map(unquote);
    const withNull = values.length < parts.length;
    const list = cond(negate ? "notIn" : "in", values);
    if (!withNull) return list;
    const nullCheck = cond(negate ? "notNull" : "isNull");
    return { t: "group", id: newId(), op: negate ? "and" : "or", items: values.length ? [list, nullCheck] : [nullCheck] };
  }

  return cond("eq", [value(t)]);
}

const printArg = (a: Arg) => (typeof a === "string" ? a : printPoint(a));

/** A value as typed in the box: quoted when it would otherwise read as syntax. */
function plain(a: Arg): string {
  const v = printArg(a);
  if (typeof a !== "string") return v;
  return /^(null|!null)$/i.test(v) || /^[=!<>~^*/"]/.test(v) || v.endsWith("*") || v.includes("..") || v.includes(",") || v === "" || v !== v.trim() ? `"${v}"` : v;
}

function spanText(span: Span): string {
  if (typeof span === "object") return "day" in span ? span.day : `last${span.lastDays}d`;
  return span.toLowerCase();
}

/**
 * The box text for a node (what `parseQuick` reads back), or null when the node cannot be
 * written that way (case-sensitive matching, blank checks, deeper groups): the box then shows
 * that the column has a filter set elsewhere.
 */
export function printQuick(node: FilterNode): string | null {
  if (node.t === "group") {
    const list = node.items.find((i): i is CondNode => i.t === "cond" && (i.op === "in" || i.op === "notIn"));
    const nullCheck = node.items.find((i) => i.t === "cond" && (i.op === "isNull" || i.op === "notNull"));
    if (node.not || node.items.length > 2 || !nullCheck) return null;
    const negate = (nullCheck as CondNode).op === "notNull";
    if (!list) return node.items.length === 1 ? (negate ? "!null" : "null") : null;
    return `${negate ? "!" : ""}${[...list.args.map(plain), "null"].join(",")}`;
  }
  if (node.t === "rel" || node.t === "cols" || node.cs) return null;
  const [a, b] = node.args;
  switch (node.op) {
    case "eq":
      return plain(a);
    case "ne":
      return `!=${plain(a)}`;
    case "lt":
      return `<${printArg(a)}`;
    case "le":
      return `<=${printArg(a)}`;
    case "gt":
      return `>${printArg(a)}`;
    case "ge":
      return `>=${printArg(a)}`;
    case "between":
      return `${printArg(a)}..${printArg(b)}`;
    case "range":
      return node.span ? spanText(node.span) : null;
    case "in":
      return node.args.map(plain).join(",");
    case "notIn":
      return `!${node.args.map(plain).join(",")}`;
    case "isNull":
      return "null";
    case "notNull":
      return "!null";
    case "isEmpty":
      return "''";
    case "contains":
      return `~${printArg(a)}`;
    case "notContains":
      return `!~${printArg(a)}`;
    case "startsWith":
      return `^${printArg(a)}`;
    case "endsWith":
      return `*${printArg(a)}`;
    case "regex":
      return `/${printArg(a)}/`;
    default:
      return null;
  }
}
