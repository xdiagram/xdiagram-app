import { type CountOp, type GroupNode, newId, type Quant, type RelNode } from "./model";

/** A relationship as the diagram knows it (declared, or found by X-ray). */
export interface RefLike {
  from: { table: string; fields: string[] };
  to: { table: string; fields: string[] };
}

/** A related table a filter can ask about, from one table's point of view. */
export interface RelOption {
  /** Unique among the table's options; what chips and expressions call it. */
  label: string;
  /** `schema.table` of the related table. */
  tableId: string;
  schema: string;
  table: string;
  /** `[column of this table, column of the related table]` pairs. */
  on: [string, string][];
  /** Rows of the related table point at this one ("orders" of a user), or the other way round (its "org"). */
  direction: "children" | "parent";
}

const short = (id: string) => id.replace(/^public\./, "");
const split = (id: string) => {
  const dot = id.indexOf(".");
  return dot < 0 ? { schema: "public", table: id } : { schema: id.slice(0, dot), table: id.slice(dot + 1) };
};
/** `org_id` → `org`, `ManagerId` → `Manager`; empty when nothing is left. */
const stripId = (col: string) => col.replace(/(_id|Id|_ID)$/, "");

/**
 * The relationships of `tableId`: the tables whose rows point at it (named after that table,
 * `orders`) and the tables it points at (named after its key column, `org` for `org_id`).
 * Clashing names get the key columns added (`orders.approved_by`), then a number.
 */
export function relOptions(tableId: string, refs: RefLike[]): RelOption[] {
  const out: RelOption[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (r.from.fields.length !== r.to.fields.length || !r.from.fields.length) continue;
    if (r.to.table === tableId) {
      const key = `c:${r.from.table}:${r.from.fields.join(",")}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ label: short(r.from.table), tableId: r.from.table, ...split(r.from.table), on: r.to.fields.map((f, i) => [f, r.from.fields[i]] as [string, string]), direction: "children" });
      }
    }
    if (r.from.table === tableId) {
      const key = `p:${r.to.table}:${r.from.fields.join(",")}`;
      if (!seen.has(key)) {
        seen.add(key);
        const name = r.from.fields.length === 1 ? stripId(r.from.fields[0]) : "";
        out.push({ label: name || short(r.to.table), tableId: r.to.table, ...split(r.to.table), on: r.from.fields.map((f, i) => [f, r.to.fields[i]] as [string, string]), direction: "parent" });
      }
    }
  }
  // Clashes: add the related table's key columns (children) or this table's (parents), then a number.
  const labels = out.map((o) => o.label);
  const clashing = new Set(labels.filter((l, i) => labels.indexOf(l) !== i));
  for (const o of out) {
    if (clashing.has(o.label)) o.label = `${o.label}.${(o.direction === "children" ? o.on.map((p) => p[1]) : o.on.map((p) => p[0])).join("+")}`;
  }
  const used = new Map<string, number>();
  for (const o of out) {
    const n = (used.get(o.label) ?? 0) + 1;
    used.set(o.label, n);
    if (n > 1) o.label = `${o.label}${n}`;
  }
  return out;
}

/**
 * The related-row condition that selects, in `option`'s table, the rows related to the rows of
 * `tableId` matching `where` (no `where`: to any row): "the orders of these users". Its name is
 * the way back as the related table calls it.
 */
export function relatedTo(tableId: string, option: RelOption, where: GroupNode | null, refs: RefLike[]): RelNode {
  const on = option.on.map(([local, remote]) => [remote, local] as [string, string]);
  const back = relOptions(option.tableId, refs).find((o) => o.tableId === tableId && JSON.stringify(o.on) === JSON.stringify(on));
  const { schema, table } = split(tableId);
  return {
    t: "rel",
    id: newId(),
    label: back?.label ?? short(tableId),
    schema,
    table,
    on,
    quant: "some",
    ...(where && where.items.length ? { filter: where } : {}),
    origin: "nav",
  };
}

const SYMBOL: Record<CountOp, string> = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥" };

/** "has orders", "has no orders", "has ≥ 3 orders". */
export function quantText(quant: Quant, label: string): string {
  if (quant === "some") return `has ${label}`;
  if (quant === "none") return `has no ${label}`;
  return `has ${SYMBOL[quant.count.op]} ${quant.count.n} ${label}`;
}
