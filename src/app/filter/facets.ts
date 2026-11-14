import { type CondNode, type FilterNode, type GroupNode, newId } from "./model";
import { setColumnFilter, singleColumn } from "./tree";

/** What a facet has ticked: the values (and NULL) of its column's condition directly under the root. */
export interface FacetSelection {
  values: string[];
  nul: boolean;
  /** The column's condition (also when it is not a list of values, e.g. `> 5`). */
  node: FilterNode | null;
}

const isCond = (n: FilterNode): n is CondNode => n.t === "cond";

export function facetSelection(root: GroupNode, column: string): FacetSelection {
  const node = root.items.find((n) => !n.off && singleColumn(n) === column) ?? null;
  const out: FacetSelection = { values: [], nul: false, node };
  const take = (n: FilterNode): boolean => {
    if (!isCond(n)) return false;
    const strings = n.args.filter((a): a is string => typeof a === "string");
    if (n.op === "eq" && strings.length === 1) out.values.push(strings[0]);
    else if (n.op === "in") out.values.push(...strings);
    else if (n.op === "isNull") out.nul = true;
    else return false;
    return true;
  };
  if (!node) return out;
  const ok = node.t === "group" ? !node.not && node.op === "or" && node.items.every(take) : take(node);
  return ok ? out : { values: [], nul: false, node };
}

/** The root with `column`'s condition set to these values (and NULL); none: removed. */
export function setFacet(root: GroupNode, column: string, values: string[], nul: boolean): GroupNode {
  const list: CondNode | null = !values.length
    ? null
    : values.length === 1
      ? { t: "cond", id: newId(), column, op: "eq", args: [values[0]] }
      : { t: "cond", id: newId(), column, op: "in", args: values };
  const isNull: CondNode | null = nul ? { t: "cond", id: newId(), column, op: "isNull", args: [] } : null;
  const node: FilterNode | null = list && isNull ? { t: "group", id: newId(), op: "or", items: [list, isNull] } : (list ?? isNull);
  return setColumnFilter(root, column, node);
}
