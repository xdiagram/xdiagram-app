import type { LookupResult, RelatedLookup } from "../core/tauri-api.service";
import { splitTableId } from "../diagram/canvas-edit";
import { HEADER_H, ROW_H, routeAll, type EdgeRoute, type TableBox } from "../diagram/geometry";
import { displayTable, type VField, type VRef, type VTable } from "../diagram/view-model";

/**
 * Pure model of the related-data map: rows as cards, foreign keys as edges. A row is one card
 * however many paths reach it. Layout is incremental: parents go one column to the left of the
 * card that loaded them, children one column to the right, and cards already placed never move.
 */

export const CARD_W = 280;
export const COL_GAP = 120;
export const V_GAP = 24;
/** Height of the "N shown · more" pill under a capped relationship. */
export const MORE_H = 30;
/** Non-key columns shown on a card before "show all". */
export const EXTRA_COLUMNS = 3;
/** Rows fetched per relationship on the first expansion. */
export const PARENT_CAP = 5;
export const CHILD_CAP = 10;
/** Rows added by each "more". */
export const MORE_STEP = 25;
export const MAX_PER_REF = 100;
export const MAX_NODES = 200;
export const MAX_LOOKUPS = 64;
/** Mirrors `MAX_CELL_CHARS` in `src-tauri/crates/xdiagram-core/src/db/browse.rs`. */
const MAX_CELL_CHARS = 4000;

export type Direction = "parents" | "children";
export type ExpandState = "idle" | "loading" | "done";

export interface RowNode {
  id: string;
  tableId: string;
  columns: string[];
  values: (string | null)[];
  /** Identified by its primary key (else by all its values). */
  keyed: boolean;
  /** Column of the layout: 0 for the root, −1 for its parents, +1 for its children, … */
  col: number;
  x: number;
  y: number;
  /** The card whose expansion loaded this one (null for the root). */
  anchor: string | null;
  /** Creation order (for Tidy). */
  seq: number;
  showAll: boolean;
  parents: ExpandState;
  children: ExpandState;
  /** Why some relationships could not be followed. */
  notes: string[];
}

export interface RowEdge {
  id: string;
  ref: VRef;
  /** Card on the referencing (foreign-key) side. */
  from: string;
  /** Card on the referenced side. */
  to: string;
}

/** A relationship with more rows than were loaded. */
export interface MoreMarker {
  id: string;
  anchor: string;
  ref: VRef;
  dir: Direction;
  tableId: string;
  filters: { column: string; value: string }[];
  /** Rows asked for so far. */
  shown: number;
  x: number;
  y: number;
}

export interface RowGraph {
  rootId: string;
  nodes: ReadonlyMap<string, RowNode>;
  edges: ReadonlyMap<string, RowEdge>;
  more: ReadonlyMap<string, MoreMarker>;
  seq: number;
}

/** One lookup to run, and where its rows go. */
export interface PlannedLookup {
  anchor: string;
  ref: VRef;
  dir: Direction;
  tableId: string;
  filters: { column: string; value: string }[];
  limit: number;
}

export interface Interval {
  top: number;
  bottom: number;
}

export function columnX(col: number): number {
  return col * (CARD_W + COL_GAP);
}

/** A cell the backend shortened (see `truncate_cell`): its full value is unknown. */
export function isTruncated(v: string): boolean {
  return v.length > MAX_CELL_CHARS && v.endsWith("…") && [...v].length === MAX_CELL_CHARS + 1;
}

/** Card identity: table + primary-key values; all values when the key is unknown or incomplete. */
export function nodeKey(tableId: string, columns: string[], values: (string | null)[], pk: string[]): { id: string; keyed: boolean } {
  const idx = pk.map((c) => columns.indexOf(c));
  if (pk.length && idx.every((i) => i >= 0 && values[i] !== null)) {
    return { id: `${tableId}#${JSON.stringify(idx.map((i) => values[i]))}`, keyed: true };
  }
  return { id: `${tableId}#*${JSON.stringify(values)}`, keyed: false };
}

export function rootNode(tableId: string, columns: string[], values: (string | null)[], pk: string[]): RowGraph {
  const { id, keyed } = nodeKey(tableId, columns, values, pk);
  const node: RowNode = { id, tableId, columns, values, keyed, col: 0, x: 0, y: 0, anchor: null, seq: 0, showAll: false, parents: "idle", children: "idle", notes: [] };
  return { rootId: id, nodes: new Map([[id, node]]), edges: new Map(), more: new Map(), seq: 0 };
}

export function cell(node: RowNode, column: string): string | null | undefined {
  const i = node.columns.indexOf(column);
  return i < 0 ? undefined : node.values[i];
}

/**
 * Equality filters pairing `source` columns of a row with `target` columns (by position, so
 * composite keys work), or why the key cannot be followed. A NULL in any part references nothing.
 */
export function keyFilters(
  source: string[],
  target: string[],
  get: (column: string) => string | null | undefined,
): { filters: { column: string; value: string }[] } | { skip: "null" | string } {
  if (!source.length || source.length !== target.length) return { skip: "the key columns do not pair up" };
  const filters: { column: string; value: string }[] = [];
  for (let i = 0; i < source.length; i++) {
    const v = get(source[i]);
    if (v === undefined) return { skip: `${source[i]} is not in the row` };
    if (v === null) return { skip: "null" };
    if (isTruncated(v)) return { skip: `${source[i]} is too long to follow` };
    filters.push({ column: target[i], value: v });
  }
  return { filters };
}

/** Relationships a card can follow in a direction. */
export function refsToward(tableId: string, dir: Direction, refs: readonly VRef[]): VRef[] {
  return refs.filter((r) => (dir === "parents" ? r.from.table : r.to.table) === tableId);
}

/** The lookups that load a card's parents (rows it references) or children (rows referencing it). */
export function planLookups(node: RowNode, dir: Direction, refs: readonly VRef[]): { lookups: PlannedLookup[]; notes: string[] } {
  const lookups: PlannedLookup[] = [];
  const notes: string[] = [];
  for (const ref of refsToward(node.tableId, dir, refs)) {
    const [mine, theirs] = dir === "parents" ? [ref.from, ref.to] : [ref.to, ref.from];
    const k = keyFilters(mine.fields, theirs.fields, (c) => cell(node, c));
    if ("skip" in k) {
      // A NULL foreign key is visible on the card itself; other reasons deserve a note.
      if (k.skip !== "null") notes.push(`${displayTable(theirs.table)}: ${k.skip}`);
      continue;
    }
    lookups.push({ anchor: node.id, ref, dir, tableId: theirs.table, filters: k.filters, limit: dir === "parents" ? PARENT_CAP : CHILD_CAP });
  }
  return { lookups, notes };
}

export function toRequest(p: PlannedLookup): RelatedLookup {
  const { schema, table } = splitTableId(p.tableId);
  return { schema, table, filters: p.filters, limit: p.limit };
}

/** The rows a card shows: key columns plus the first few others (or all), in table order. */
export interface CardLayout {
  fields: VField[];
  /** Whether the card has a "show all / fewer columns" row. */
  toggle: boolean;
  hidden: number;
  height: number;
}

function plainField(name: string): VField {
  return { name, type: "", pk: false, fk: false, unique: false, notNull: false, increment: false, isEnum: false, defaultValue: null, note: null, offset: null };
}

export function cardLayout(node: RowNode, table: VTable | undefined, refCols: ReadonlySet<string>): CardLayout {
  const pk = new Set(table?.primaryKey ?? []);
  const model = new Map((table?.fields ?? []).map((f) => [f.name, f]));
  const all = node.columns.map((name) => {
    const f = model.get(name) ?? plainField(name);
    return pk.has(name) && !f.pk ? { ...f, pk: true } : f;
  });
  const isKey = (f: VField) => f.pk || f.fk || refCols.has(`${node.tableId}.${f.name}`);
  let extras = 0;
  const compact = all.filter((f) => {
    if (isKey(f)) return true;
    if (extras >= EXTRA_COLUMNS) return false;
    extras++;
    return true;
  });
  const toggle = compact.length < all.length;
  const fields = node.showAll ? all : compact;
  const rows = Math.max(1, fields.length) + (toggle ? 1 : 0);
  return { fields, toggle, hidden: all.length - fields.length, height: HEADER_H + rows * ROW_H };
}

/** Vertical intervals taken by cards and pills overlapping the column that starts at `x`. */
export function occupiedAt(
  nodes: Iterable<RowNode>,
  more: Iterable<MoreMarker>,
  x: number,
  heightOf: (n: RowNode) => number,
  exclude?: ReadonlySet<string>,
): Interval[] {
  const out: Interval[] = [];
  const overlaps = (ix: number) => !isNaN(ix) && ix < x + CARD_W && ix + CARD_W > x;
  for (const n of nodes) if (overlaps(n.x) && !isNaN(n.y) && !exclude?.has(n.id)) out.push({ top: n.y, bottom: n.y + heightOf(n) });
  for (const m of more) if (overlaps(m.x) && !isNaN(m.y) && !exclude?.has(m.id)) out.push({ top: m.y, bottom: m.y + MORE_H });
  return out;
}

/** Top of a block of height `total`: as close to `desiredTop` as the free gaps allow. */
export function placeBlock(occupied: Interval[], desiredTop: number, total: number): number {
  const sorted = [...occupied].sort((a, b) => a.top - b.top);
  let best = desiredTop;
  let bestDist = Infinity;
  let prevBottom = -Infinity;
  for (let i = 0; i <= sorted.length; i++) {
    const nextTop = i < sorted.length ? sorted[i].top : Infinity;
    const lo = prevBottom + V_GAP;
    const hi = nextTop - V_GAP - total;
    if (hi >= lo) {
      const top = Math.min(hi, Math.max(lo, desiredTop));
      const dist = Math.abs(top - desiredTop);
      if (dist < bestDist) {
        bestDist = dist;
        best = top;
      }
    }
    if (i < sorted.length) prevBottom = Math.max(prevBottom, sorted[i].bottom);
  }
  return best;
}

type BlockItem = { kind: "node" | "more"; id: string };

/** Places the items of one block (loaded by `anchor` in direction `dir`) next to it. */
function placeItems(
  nodes: Map<string, RowNode>,
  more: Map<string, MoreMarker>,
  anchor: RowNode,
  dir: Direction,
  items: BlockItem[],
  heightOf: (n: RowNode) => number,
  desiredTop?: number,
): void {
  if (!items.length) return;
  const x = anchor.x + (dir === "parents" ? -1 : 1) * (CARD_W + COL_GAP);
  const heights = items.map((it) => (it.kind === "node" ? heightOf(nodes.get(it.id)!) : MORE_H));
  const total = heights.reduce((a, b) => a + b, 0) + V_GAP * (items.length - 1);
  const top = placeBlock(occupiedAt(nodes.values(), more.values(), x, heightOf), desiredTop ?? anchor.y + heightOf(anchor) / 2 - total / 2, total);
  let y = top;
  items.forEach((it, i) => {
    if (it.kind === "node") nodes.set(it.id, { ...nodes.get(it.id)!, x, y });
    else more.set(it.id, { ...more.get(it.id)!, x, y });
    y += heights[i] + V_GAP;
  });
}

export interface MergeOptions {
  heightOf: (n: RowNode) => number;
  pkOf: (tableId: string) => string[];
  /** Top of the block for this anchor and direction instead of centring it ("more"). */
  topFor?: (anchor: string, dir: Direction) => number | undefined;
}

/**
 * Adds the rows of finished lookups: new cards (placed next to the card that loaded them), edges,
 * and "more" pills for relationships with rows left. Rows already on the map gain only an edge.
 */
export function mergeLookups(
  graph: RowGraph,
  planned: PlannedLookup[],
  results: LookupResult[],
  opts: MergeOptions,
): { graph: RowGraph; added: string[]; capped: boolean } {
  const nodes = new Map(graph.nodes);
  const edges = new Map(graph.edges);
  const more = new Map(graph.more);
  let seq = graph.seq;
  let capped = false;
  const added: string[] = [];
  const notes = new Map<string, string[]>();
  const blocks = new Map<string, { anchor: string; dir: Direction; items: BlockItem[] }>();

  planned.forEach((p, i) => {
    const r = results[i];
    const anchor = nodes.get(p.anchor);
    if (!anchor) return;
    if (!r || r.error) {
      notes.set(p.anchor, [...(notes.get(p.anchor) ?? []), `${displayTable(p.tableId)}: ${r?.error ?? "no result"}`]);
      return;
    }
    const blockKey = `${p.anchor}|${p.dir}`;
    let block = blocks.get(blockKey);
    if (!block) blocks.set(blockKey, (block = { anchor: p.anchor, dir: p.dir, items: [] }));
    const pk = opts.pkOf(p.tableId);
    const columns = r.columns.map((c) => c.name);
    for (const row of r.rows) {
      const { id, keyed } = nodeKey(p.tableId, columns, row, pk);
      if (!nodes.has(id)) {
        if (nodes.size >= MAX_NODES) {
          capped = true;
          continue;
        }
        const col = anchor.col + (p.dir === "parents" ? -1 : 1);
        nodes.set(id, { id, tableId: p.tableId, columns, values: row, keyed, col, x: NaN, y: NaN, anchor: anchor.id, seq: ++seq, showAll: false, parents: "idle", children: "idle", notes: [] });
        block.items.push({ kind: "node", id });
        added.push(id);
      }
      const [from, to] = p.dir === "parents" ? [anchor.id, id] : [id, anchor.id];
      const eid = `${p.ref.id}|${from}|${to}`;
      if (!edges.has(eid)) edges.set(eid, { id: eid, ref: p.ref, from, to });
    }
    const mid = markerId(p.anchor, p.ref, p.dir);
    if (r.hasMore) {
      const existing = more.get(mid);
      more.set(mid, { id: mid, anchor: p.anchor, ref: p.ref, dir: p.dir, tableId: p.tableId, filters: p.filters, shown: p.limit, x: existing?.x ?? NaN, y: existing?.y ?? NaN });
      if (!existing) block.items.push({ kind: "more", id: mid });
    } else {
      more.delete(mid);
    }
  });

  for (const b of blocks.values()) {
    const anchor = nodes.get(b.anchor);
    if (anchor) placeItems(nodes, more, anchor, b.dir, b.items, opts.heightOf, opts.topFor?.(b.anchor, b.dir));
  }
  for (const [id, list] of notes) {
    const n = nodes.get(id);
    if (n) nodes.set(id, { ...n, notes: [...new Set([...n.notes, ...list])] });
  }
  return { graph: { ...graph, nodes, edges, more, seq }, added, capped };
}

export function markerId(anchor: string, ref: VRef, dir: Direction): string {
  return `${anchor}|${ref.id}|${dir}`;
}

/**
 * Edges between cards already on the map that no lookup connected (e.g. a row loaded as a child
 * of one card that also references another). Compares key texts, so it is best-effort.
 */
export function linkKnown(graph: RowGraph, refs: readonly VRef[]): RowGraph {
  const byTable = new Map<string, RowNode[]>();
  for (const n of graph.nodes.values()) byTable.set(n.tableId, [...(byTable.get(n.tableId) ?? []), n]);
  let edges: Map<string, RowEdge> | null = null;
  for (const ref of refs) {
    const froms = byTable.get(ref.from.table);
    const tos = byTable.get(ref.to.table);
    if (!froms || !tos) continue;
    const index = new Map<string, RowNode[]>();
    for (const t of tos) {
      const vals = ref.to.fields.map((f) => cell(t, f));
      if (vals.some((v) => v == null)) continue;
      const k = JSON.stringify(vals);
      index.set(k, [...(index.get(k) ?? []), t]);
    }
    for (const f of froms) {
      const vals = ref.from.fields.map((c) => cell(f, c));
      if (vals.some((v) => v == null)) continue;
      for (const t of index.get(JSON.stringify(vals)) ?? []) {
        const eid = `${ref.id}|${f.id}|${t.id}`;
        if ((edges ?? graph.edges).has(eid)) continue;
        edges ??= new Map(graph.edges);
        edges.set(eid, { id: eid, ref, from: f.id, to: t.id });
      }
    }
  }
  return edges ? { ...graph, edges } : graph;
}

/** Pushes cards below `id` (in its column) down after it grew, so they do not overlap. */
export function relaxBelow(graph: RowGraph, id: string, heightOf: (n: RowNode) => number): RowGraph {
  const start = graph.nodes.get(id);
  if (!start) return graph;
  const nodes = new Map(graph.nodes);
  const more = new Map(graph.more);
  type Item = { kind: "node" | "more"; id: string; x: number; y: number; h: number };
  const items: Item[] = [];
  const overlaps = (x: number) => x < start.x + CARD_W && x + CARD_W > start.x;
  for (const n of nodes.values()) if (n.id !== id && overlaps(n.x) && n.y >= start.y) items.push({ kind: "node", id: n.id, x: n.x, y: n.y, h: heightOf(n) });
  for (const m of more.values()) if (overlaps(m.x) && m.y >= start.y) items.push({ kind: "more", id: m.id, x: m.x, y: m.y, h: MORE_H });
  items.sort((a, b) => a.y - b.y);
  let cursor = start.y + heightOf(start);
  let moved = false;
  for (const it of items) {
    if (it.y < cursor + V_GAP) {
      it.y = cursor + V_GAP;
      moved = true;
      if (it.kind === "node") nodes.set(it.id, { ...nodes.get(it.id)!, y: it.y });
      else more.set(it.id, { ...more.get(it.id)!, y: it.y });
    }
    cursor = Math.max(cursor, it.y + it.h);
  }
  return moved ? { ...graph, nodes, more } : graph;
}

/** Lays every card out again from scratch, in the order they were loaded (undoes dragging). */
export function tidy(graph: RowGraph, heightOf: (n: RowNode) => number): RowGraph {
  const nodes = new Map<string, RowNode>();
  const more = new Map<string, MoreMarker>();
  for (const n of graph.nodes.values()) nodes.set(n.id, n.id === graph.rootId ? { ...n, x: 0, y: 0 } : { ...n, x: NaN, y: NaN });
  for (const m of graph.more.values()) more.set(m.id, { ...m, x: NaN, y: NaN });
  const groups = new Map<string, { anchor: string; dir: Direction; first: number; items: BlockItem[] }>();
  const group = (anchor: string, dir: Direction, seq: number) => {
    const key = `${anchor}|${dir}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { anchor, dir, first: seq, items: [] }));
    g.first = Math.min(g.first, seq);
    return g;
  };
  for (const n of [...nodes.values()].sort((a, b) => a.seq - b.seq)) {
    const a = n.anchor ? nodes.get(n.anchor) : undefined;
    if (a) group(a.id, n.col < a.col ? "parents" : "children", n.seq).items.push({ kind: "node", id: n.id });
  }
  for (const m of more.values()) group(m.anchor, m.dir, Infinity).items.push({ kind: "more", id: m.id });
  for (const g of [...groups.values()].sort((a, b) => a.first - b.first)) {
    const anchor = nodes.get(g.anchor);
    if (anchor && !isNaN(anchor.x)) placeItems(nodes, more, anchor, g.dir, g.items, heightOf);
  }
  return { ...graph, nodes, more };
}

/** Routes the edges between cards with the diagram's router, endpoints renamed to card ids. */
export function routedEdges(graph: RowGraph, boxes: ReadonlyMap<string, TableBox>): EdgeRoute[] {
  const refs: VRef[] = [...graph.edges.values()].map((e) => ({
    ...e.ref,
    id: e.id,
    from: { ...e.ref.from, table: e.from },
    to: { ...e.ref.to, table: e.to },
  }));
  return routeAll(refs, boxes);
}

/** Short label of a card's key, e.g. `#42` or `#(7, 42)`; the first values when it has no key. */
export function keyLabel(node: RowNode, pk: string[]): string {
  const vals = node.keyed ? pk.map((c) => cell(node, c) ?? "NULL") : node.values.slice(0, 1).map((v) => v ?? "NULL");
  const text = vals.length === 1 ? vals[0] : `(${vals.join(", ")})`;
  const short = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return node.keyed ? `#${short}` : short;
}
