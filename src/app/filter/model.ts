/**
 * The row filter: a tree of AND/OR groups and conditions. The UI tree carries a few things Rust
 * never sees (switched-off chips, relative dates, where a condition came from); `toWire` turns
 * it into the `WireNode` that Rust's `filter.rs` renders into SQL.
 */

/** Operators, as Rust's `filter::Op` names them. */
export type Op =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "between"
  | "range"
  | "in"
  | "notIn"
  | "isNull"
  | "notNull"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "regex"
  | "isBlank"
  | "isPadded";

export type BoolOp = "and" | "or";

/** Compare operators for a number of related rows. */
export type CountOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

/** How many related rows a row must have (Rust `filter::Quant`). */
export type Quant = "some" | "none" | { count: { op: CountOp; n: number } };

/** What Rust receives. */
export type WireNode =
  | { t: "group"; id: string; op: BoolOp; not?: boolean; items: WireNode[] }
  | { t: "cond"; id: string; column: string; op: Op; args: string[]; cs?: boolean }
  | { t: "search"; id: string; text: string; columns?: string[]; cs?: boolean }
  | { t: "rel"; id: string; schema: string; table: string; on: [string, string][]; quant: Quant; filter?: WireNode };

/**
 * The pseudo-column of a search in every text column (`any ~ text`): in the UI tree it is a
 * `contains` condition on this column, sent as a `search` node.
 */
export const SEARCH_COLUMN = "*";

/** A moment relative to now: `{ ago: 7, unit: "d" }` is seven days ago. */
export interface RelativePoint {
  ago: number;
  unit: "h" | "d" | "w" | "mo" | "y";
}

/** A value: literal text, or (date columns) a moment relative to now. */
export type Arg = string | RelativePoint;

/** A calendar period, resolved to `[from, to)` when sent (`range`). */
export type Span = "today" | "yesterday" | "thisWeek" | "thisMonth" | "thisYear" | { lastDays: number } | { day: string };

export interface CondNode {
  t: "cond";
  id: string;
  column: string;
  op: Op;
  args: Arg[];
  /** Case-sensitive text matching. */
  cs?: boolean;
  /** For `op: "range"`: a period instead of two values. */
  span?: Span;
  /** Switched off: kept in the bar, not applied. */
  off?: boolean;
  /** Came from following a foreign key (not remembered for the table). */
  origin?: "nav";
}

export interface GroupNode {
  t: "group";
  id: string;
  op: BoolOp;
  not?: boolean;
  off?: boolean;
  items: FilterNode[];
}

/** Rows by their related rows (Rust `FilterNode::Rel`). */
export interface RelNode {
  t: "rel";
  id: string;
  /** The relationship's name in chips and expressions (see `relations.ts`), e.g. `orders`. */
  label: string;
  schema: string;
  table: string;
  /** `[column of this table, column of the related table]` pairs. */
  on: [string, string][];
  quant: Quant;
  /** Conditions on the related rows (their own columns). */
  filter?: GroupNode;
  off?: boolean;
  /** Came from opening the related rows of a filtered list (not remembered for the table). */
  origin?: "nav";
}

export type FilterNode = GroupNode | CondNode | RelNode;

export interface SortKey {
  column: string;
  desc: boolean;
}

/** Same limits as Rust `filter.rs` (checked there too). */
export const LIMITS = { params: 2000, list: 1000, nodes: 200, depth: 6, valueChars: 4000, sortKeys: 8 } as const;

let counter = 0;

/** A node id (unique in this session; only used to tie problems to chips). */
export function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `n${Date.now().toString(36)}${counter.toString(36)}`;
}
