import type { Point } from "../persistence/layout.service";
import { FONT_FAMILY, MONO_FAMILY } from "./theme";
import type { VField, VGroup, VRef, VTable, ViewModel } from "./view-model";

/** How much of each table is drawn: every column, only key/relationship columns, or just the name. */
export type DetailLevel = "all" | "keys" | "names";

/** Gap between parallel vertical edge segments that would otherwise overlap. */
export const LANE_GAP = 8;

/**
 * Pure geometry shared by the Konva canvas and the SVG exporter:
 * table sizes, row positions and orthogonal edge routes in diagram coordinates.
 */

export const HEADER_H = 34;
export const ROW_H = 26;
export const PAD_X = 12;
export const BADGE_W = 22;
export const MIN_TABLE_W = 190;
export const STUB = 22;
export const GROUP_PAD = 24;
export const GROUP_LABEL_H = 26;

export const HEADER_FONT = `600 13px ${FONT_FAMILY}`;
export const FIELD_FONT = `400 12.5px ${FONT_FAMILY}`;
export const PK_FONT = `600 12.5px ${FONT_FAMILY}`;
export const TYPE_FONT = `400 11.5px ${MONO_FAMILY}`;

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();

export function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  let w = text.length * 7;
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
  }
  if (widthCache.size > 20000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

export interface Size {
  w: number;
  h: number;
}

/** `headerOnly` draws just the table name; otherwise at least one (possibly empty) row. */
export function tableSize(table: VTable, fields: VField[] = table.fields, headerOnly = false): Size {
  let w = textWidth(table.label, HEADER_FONT) + PAD_X * 2;
  for (const f of fields) {
    const name = textWidth(f.name, f.pk ? PK_FONT : FIELD_FONT);
    const type = textWidth(f.type, TYPE_FONT);
    w = Math.max(w, PAD_X + BADGE_W + name + 24 + type + PAD_X);
  }
  const h = HEADER_H + (headerOnly ? 0 : Math.max(1, fields.length) * ROW_H);
  return { w: Math.ceil(Math.max(headerOnly ? 120 : MIN_TABLE_W, w)), h };
}

/** Columns that appear in at least one relationship (declared or discovered), as `table.column`. */
export function refColumns(refs: VRef[]): Set<string> {
  const out = new Set<string>();
  for (const r of refs) {
    for (const f of r.from.fields) out.add(`${r.from.table}.${f}`);
    for (const f of r.to.fields) out.add(`${r.to.table}.${f}`);
  }
  return out;
}

export function visibleFields(table: VTable, detail: DetailLevel, refCols: ReadonlySet<string>): VField[] {
  if (detail === "all") return table.fields;
  if (detail === "names") return [];
  return table.fields.filter((f) => f.pk || f.fk || refCols.has(`${table.id}.${f.name}`));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TableBox extends Rect {
  table: VTable;
  /** The rows actually drawn (depends on the detail level). */
  fields: VField[];
}

export type Side = "left" | "right";

export interface EdgeEnd {
  x: number;
  y: number;
  side: Side;
  many: boolean;
}

export interface EdgeRoute {
  ref: VRef;
  points: number[];
  from: EdgeEnd;
  to: EdgeEnd;
  kind: "declared" | "discovered";
  /** Call count for discovered edges; 0 for declared ones. */
  weight: number;
  /** Undirected edges (no identifiable referenced side) get no end markers. */
  directed: boolean;
}

export function edgeStrokeWidth(e: EdgeRoute): number {
  return e.kind === "discovered" ? Math.min(1.2 + Math.log2(1 + e.weight) / 2, 4) : 1.4;
}

export interface GroupBox extends Rect {
  group: VGroup;
}

export interface Scene {
  tables: Map<string, TableBox>;
  edges: EdgeRoute[];
  groups: GroupBox[];
}

/** Centre of a column's row; the header centre when the column is not drawn. */
export function rowCenterY(box: TableBox, fieldName: string): number {
  const i = box.fields.findIndex((f) => f.name === fieldName);
  if (i < 0) return box.y + HEADER_H / 2;
  return box.y + HEADER_H + i * ROW_H + ROW_H / 2;
}

/**
 * Orthogonal route between two field rows, anchored on the facing sides of the tables
 * (or both on the right when the tables overlap horizontally, e.g. self-references).
 */
export function routeEdge(ref: VRef, a: TableBox, b: TableBox, laneOffset = 0): EdgeRoute {
  const ay = rowCenterY(a, ref.from.fields[0]);
  const by = rowCenterY(b, ref.to.fields[0]);
  let aSide: Side;
  let bSide: Side;
  if (a !== b && a.x + a.w + STUB * 2 <= b.x) {
    aSide = "right";
    bSide = "left";
  } else if (a !== b && b.x + b.w + STUB * 2 <= a.x) {
    aSide = "left";
    bSide = "right";
  } else {
    // Overlapping columns: loop around the right-hand side.
    aSide = "right";
    bSide = "right";
  }
  const ax = aSide === "right" ? a.x + a.w : a.x;
  const bx = bSide === "right" ? b.x + b.w : b.x;
  const aOut = aSide === "right" ? ax + STUB : ax - STUB;
  const bOut = bSide === "right" ? bx + STUB : bx - STUB;

  let points: number[];
  if (aSide === bSide) {
    const outer = Math.max(aOut, bOut) + (a === b ? STUB : 0) + Math.abs(laneOffset);
    points = [ax, ay, outer, ay, outer, by, bx, by];
  } else {
    // Keep the vertical segment between the two stubs, even when spread into lanes.
    const lo = Math.min(aOut, bOut) + 3;
    const hi = Math.max(aOut, bOut) - 3;
    const midX = Math.min(hi, Math.max(lo, (aOut + bOut) / 2 + laneOffset));
    points = [ax, ay, aOut, ay, midX, ay, midX, by, bOut, by, bx, by];
  }
  return {
    ref,
    points,
    from: { x: ax, y: ay, side: aSide, many: ref.from.many },
    to: { x: bx, y: by, side: bSide, many: ref.to.many },
    kind: ref.discovered ? "discovered" : "declared",
    weight: ref.discovered?.calls ?? 0,
    directed: ref.discovered?.directed ?? true,
  };
}

/** x of an edge's vertical segment (the "trunk" that parallel edges would share). */
function trunkX(e: EdgeRoute): number {
  return e.points.length === 12 ? e.points[4] : e.points[2];
}

/**
 * Routes every edge, spreading edges whose vertical segments coincide into lanes
 * `LANE_GAP` apart (ordered by their target rows) so parallel relationships stay readable.
 */
export function routeAll(refs: VRef[], tables: ReadonlyMap<string, TableBox>): EdgeRoute[] {
  const ends: { ref: VRef; a: TableBox; b: TableBox }[] = [];
  for (const ref of refs) {
    const a = tables.get(ref.from.table);
    const b = tables.get(ref.to.table);
    if (a && b) ends.push({ ref, a, b });
  }
  const base = ends.map((e) => routeEdge(e.ref, e.a, e.b));
  const groups = new Map<number, number[]>();
  base.forEach((e, i) => {
    const key = Math.round(trunkX(e));
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  const offsets = new Array<number>(base.length).fill(0);
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((i, j) => base[i].to.y - base[j].to.y || base[i].from.y - base[j].from.y);
    const sameSide = base[members[0]].points.length === 8;
    members.forEach((edge, k) => {
      offsets[edge] = (sameSide ? k : k - (members.length - 1) / 2) * LANE_GAP;
    });
  }
  return base.map((e, i) => (offsets[i] ? routeEdge(e.ref, ends[i].a, ends[i].b, offsets[i]) : e));
}

export interface SceneOptions {
  /** X-ray's discovered relationships, routed exactly like declared ones. */
  extra?: VRef[];
  detail?: DetailLevel;
  /** Zones to draw instead of the DBML TableGroups (the Modules arrangement). */
  groups?: readonly VGroup[] | null;
}

export function buildScene(
  view: ViewModel,
  positions: Record<string, Point>,
  hidden: ReadonlySet<string>,
  options: SceneOptions = {},
): Scene {
  const extra = options.extra ?? [];
  const detail = options.detail ?? "all";
  const refs = [...view.refs, ...extra];
  const refCols = refColumns(refs);
  const tables = new Map<string, TableBox>();
  for (const t of view.tables) {
    if (hidden.has(t.id)) continue;
    const p = positions[t.id] ?? { x: 0, y: 0 };
    const fields = visibleFields(t, detail, refCols);
    const s = tableSize(t, fields, detail === "names");
    tables.set(t.id, { table: t, fields, x: p.x, y: p.y, w: s.w, h: s.h });
  }

  const edges = routeAll(refs, tables);

  const groups: GroupBox[] = [];
  for (const g of options.groups ?? view.groups) {
    const boxes = g.tables.map((id) => tables.get(id)).filter((b): b is TableBox => !!b);
    if (boxes.length === 0) continue;
    const r = boundsOf(boxes);
    groups.push({
      group: g,
      x: r.x - GROUP_PAD,
      y: r.y - GROUP_PAD - GROUP_LABEL_H,
      w: r.w + GROUP_PAD * 2,
      h: r.h + GROUP_PAD * 2 + GROUP_LABEL_H,
    });
  }
  return { tables, edges, groups };
}

export function boundsOf(rects: Iterable<Rect>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The rectangle spanned by two corners, whatever direction it was dragged in. */
export function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Ids of the tables a selection box touches (any overlap counts, like most diagram tools). */
export function tablesInRect(tables: ReadonlyMap<string, Rect>, r: Rect): string[] {
  const hits: string[] = [];
  for (const [id, t] of tables) {
    if (t.x < r.x + r.w && t.x + t.w > r.x && t.y < r.y + r.h && t.y + t.h > r.y) hits.push(id);
  }
  return hits;
}

export function sceneBounds(scene: Scene): Rect {
  const rects: Rect[] = [...scene.tables.values(), ...scene.groups];
  const b = boundsOf(rects);
  // Self-reference loops stick out to the right of their table.
  let maxX = b.x + b.w;
  for (const e of scene.edges) for (let i = 0; i < e.points.length; i += 2) maxX = Math.max(maxX, e.points[i]);
  return { ...b, w: maxX - b.x };
}

/** Crow's foot (many) or a bar (one), drawn on the stub just outside the table edge. */
export function markerSegments(end: EdgeEnd): number[][] {
  const dir = end.side === "right" ? 1 : -1;
  if (end.many) {
    const tip = end.x + dir * 12;
    return [
      [tip, end.y, end.x, end.y - 6],
      [tip, end.y, end.x, end.y],
      [tip, end.y, end.x, end.y + 6],
    ];
  }
  const x = end.x + dir * 9;
  return [[x, end.y - 6, x, end.y + 6]];
}
