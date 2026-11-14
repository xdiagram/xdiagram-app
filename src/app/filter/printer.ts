import { type Arg, type CondNode, type CountOp, type FilterNode, SEARCH_COLUMN } from "./model";
import { opInfo } from "./operators";
import { pointLabel, spanLabel } from "./relative-dates";
import { quantText } from "./relations";

const argText = (a: Arg) => (typeof a === "string" ? a : pointLabel(a));

export const COLS_SYMBOL: Record<CountOp, string> = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥" };

/** The three parts of a condition's chip: column, operator, value. */
export function condLabel(c: CondNode): { column: string; op: string; value: string } {
  if (c.column === SEARCH_COLUMN) return { column: "any column", op: "contains", value: `${argText(c.args[0] ?? "")}${c.cs ? " (case-sensitive)" : ""}` };
  const info = opInfo(c.op);
  let value = "";
  if (c.op === "range" && c.span) return { column: c.column, op: "", value: spanLabel(c.span) };
  if (info.arity === 1) value = argText(c.args[0] ?? "");
  else if (info.arity === 2) value = `${argText(c.args[0] ?? "")} and ${argText(c.args[1] ?? "")}`;
  else if (info.arity === "list") value = c.args.map(argText).join(", ");
  if (c.cs) value += " (case-sensitive)";
  return { column: c.column, op: info.symbol, value };
}

/** One line for a node: chip of a group, breadcrumb, tooltips. */
export function nodeText(n: FilterNode): string {
  if (n.t === "cond") {
    const { column, op, value } = condLabel(n);
    return [column, op, value].filter((s) => s).join(" ");
  }
  if (n.t === "cols") return `${n.left} ${COLS_SYMBOL[n.op]} ${n.right}`;
  if (n.t === "rel") {
    const inner = n.filter && n.filter.items.some((i) => !i.off) ? ` where ${nodeText(n.filter)}` : "";
    return `${quantText(n.quant, n.label)}${inner}`;
  }
  const inner = n.items.map((i) => (i.t === "group" && i.items.length > 1 ? `(${nodeText(i)})` : nodeText(i))).join(` ${n.op} `);
  return n.not ? `not (${inner})` : inner;
}
