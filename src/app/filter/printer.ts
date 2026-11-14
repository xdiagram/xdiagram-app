import type { Arg, CondNode, FilterNode } from "./model";
import { opInfo } from "./operators";
import { pointLabel, spanLabel } from "./relative-dates";

const argText = (a: Arg) => (typeof a === "string" ? a : pointLabel(a));

/** The three parts of a condition's chip: column, operator, value. */
export function condLabel(c: CondNode): { column: string; op: string; value: string } {
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
  const inner = n.items.map((i) => (i.t === "group" && i.items.length > 1 ? `(${nodeText(i)})` : nodeText(i))).join(` ${n.op} `);
  return n.not ? `not (${inner})` : inner;
}
