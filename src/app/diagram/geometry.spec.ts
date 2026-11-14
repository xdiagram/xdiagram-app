import { HEADER_H, LANE_GAP, ROW_H, buildScene, normalizeRect, refColumns, rowCenterY, tablesInRect, visibleFields } from "./geometry";
import { EMPTY_VIEW, type VField, type VRef, type VTable, type ViewModel } from "./view-model";

const field = (name: string, extra: Partial<VField> = {}): VField => ({
  name,
  type: "int",
  pk: false,
  fk: false,
  unique: false,
  notNull: false,
  increment: false,
  isEnum: false,
  defaultValue: null,
  note: null,
  offset: null,
  ...extra,
});

const table = (id: string, fields: VField[]): VTable => ({
  id,
  schema: id.split(".")[0],
  name: id.split(".")[1],
  label: id.split(".")[1],
  headerColor: null,
  note: null,
  groupId: null,
  fields,
  primaryKey: fields.filter((f) => f.pk).map((f) => f.name),
  line: null,
  endOffset: null,
});

const ref = (from: string, fromField: string, to: string, toField = "id"): VRef => ({
  id: `${from}.${fromField}->${to}.${toField}`,
  name: null,
  from: { table: from, fields: [fromField], many: true },
  to: { table: to, fields: [toField], many: false },
  onDelete: null,
  onUpdate: null,
});

describe("geometry", () => {
  const users = table("public.users", [field("id", { pk: true }), field("email"), field("org_id", { fk: true })]);
  const a = table("public.a", [field("id", { pk: true }), field("user_id"), field("note")]);
  const b = table("public.b", [field("id", { pk: true }), field("user_id"), field("note")]);
  const c = table("public.c", [field("id", { pk: true }), field("user_id"), field("note")]);
  const refs = [ref("public.a", "user_id", "public.users"), ref("public.b", "user_id", "public.users"), ref("public.c", "user_id", "public.users")];
  const view: ViewModel = { ...EMPTY_VIEW, tables: [users, a, b, c], refs };
  // Three child tables stacked in one column, all referencing the same parent to their right.
  const positions = { "public.a": { x: 0, y: 0 }, "public.b": { x: 0, y: 300 }, "public.c": { x: 0, y: 600 }, "public.users": { x: 600, y: 300 } };

  it("finds the tables a selection box touches, dragged in any direction", () => {
    const boxes = new Map([
      ["a", { x: 0, y: 0, w: 100, h: 50 }],
      ["b", { x: 200, y: 0, w: 100, h: 50 }],
      ["c", { x: 0, y: 300, w: 100, h: 50 }],
    ]);
    expect(normalizeRect({ x: 250, y: 60 }, { x: 50, y: 10 })).toEqual({ x: 50, y: 10, w: 200, h: 50 });
    // Partly covering a and b is enough; c is below the box.
    expect(tablesInRect(boxes, normalizeRect({ x: 250, y: 60 }, { x: 50, y: 10 }))).toEqual(["a", "b"]);
    expect(tablesInRect(boxes, { x: 110, y: 0, w: 80, h: 400 })).toEqual([]);
    expect(tablesInRect(boxes, { x: -1000, y: -1000, w: 5000, h: 5000 })).toEqual(["a", "b", "c"]);
  });

  it("keeps key and relationship columns at the 'keys' detail level", () => {
    const cols = refColumns(refs);
    expect(visibleFields(a, "keys", cols).map((f) => f.name)).toEqual(["id", "user_id"]);
    expect(visibleFields(users, "keys", cols).map((f) => f.name)).toEqual(["id", "org_id"]);
    expect(visibleFields(a, "names", cols)).toEqual([]);
    expect(visibleFields(a, "all", cols)).toHaveLength(3);
  });

  it("anchors hidden columns on the header", () => {
    const scene = buildScene(view, positions, new Set(), { detail: "names" });
    const box = scene.tables.get("public.a")!;
    expect(box.h).toBe(HEADER_H);
    expect(rowCenterY(box, "user_id")).toBe(HEADER_H / 2);
    const full = buildScene(view, positions, new Set()).tables.get("public.a")!;
    expect(rowCenterY(full, "user_id")).toBe(HEADER_H + ROW_H + ROW_H / 2);
  });

  it("spreads edges that would share a vertical segment into separate lanes", () => {
    const scene = buildScene(view, positions, new Set());
    const trunks = scene.edges.map((e) => e.points[4]);
    expect(new Set(trunks).size).toBe(3);
    const sorted = [...trunks].sort((x, y) => x - y);
    expect(sorted[1] - sorted[0]).toBeCloseTo(LANE_GAP);
    expect(sorted[2] - sorted[1]).toBeCloseTo(LANE_GAP);
  });

  it("leaves a lone edge on the midpoint between the tables", () => {
    const single: ViewModel = { ...view, refs: [refs[0]] };
    const e = buildScene(single, positions, new Set()).edges[0];
    expect(e.points[4]).toBeCloseTo((e.points[2] + e.points[8]) / 2);
  });
});
