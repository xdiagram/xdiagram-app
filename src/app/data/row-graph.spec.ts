import type { LookupResult } from "../core/tauri-api.service";
import { HEADER_H, ROW_H, refColumns, rowCenterY, type TableBox } from "../diagram/geometry";
import type { VField, VRef, VTable } from "../diagram/view-model";
import {
  CARD_W,
  CHILD_CAP,
  COL_GAP,
  EXTRA_COLUMNS,
  MAX_NODES,
  MORE_H,
  V_GAP,
  cardLayout,
  isTruncated,
  keyFilters,
  linkKnown,
  mergeLookups,
  nodeKey,
  placeBlock,
  planLookups,
  relaxBelow,
  rootNode,
  routedEdges,
  tidy,
  type RowGraph,
  type RowNode,
} from "./row-graph";

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

const table = (id: string, fields: VField[], primaryKey = fields.filter((f) => f.pk).map((f) => f.name)): VTable => ({
  id,
  schema: "public",
  name: id.split(".")[1],
  label: id.split(".")[1],
  headerColor: null,
  note: null,
  groupId: null,
  fields,
  primaryKey,
  line: null,
  endOffset: null,
});

const ref = (from: string, fromFields: string[], to: string, toFields: string[], discovered = false): VRef => ({
  id: `${from}(${fromFields})->${to}(${toFields})`,
  name: null,
  from: { table: from, fields: fromFields, many: true },
  to: { table: to, fields: toFields, many: false },
  onDelete: null,
  onUpdate: null,
  ...(discovered ? { discovered: { calls: 3, statements: 1, directed: true, queries: [] } } : {}),
});

const orgs = table("public.organizations", [field("id", { pk: true }), field("name")]);
const users = table("public.users", [field("id", { pk: true }), field("email"), field("manager_id", { fk: true }), field("a"), field("b"), field("c"), field("d")]);
const memberships = table("public.memberships", [field("org_id", { fk: true }), field("user_id", { fk: true }), field("role")], ["org_id", "user_id"]);
const projectMembers = table("public.project_members", [field("id", { pk: true }), field("org_id", { fk: true }), field("user_id", { fk: true })]);
const tables = new Map([orgs, users, memberships, projectMembers].map((t) => [t.id, t]));

const refs = [
  ref("public.memberships", ["org_id"], "public.organizations", ["id"]),
  ref("public.memberships", ["user_id"], "public.users", ["id"]),
  ref("public.project_members", ["org_id", "user_id"], "public.memberships", ["org_id", "user_id"]),
  ref("public.users", ["manager_id"], "public.users", ["id"]),
];
const refCols = refColumns(refs);
const heightOf = (n: RowNode) => cardLayout(n, tables.get(n.tableId), refCols).height;
const pkOf = (id: string) => tables.get(id)?.primaryKey ?? [];

const result = (columns: string[], rows: (string | null)[][], hasMore = false, error: string | null = null): LookupResult => ({
  columns: columns.map((name) => ({ name, typeName: "text" })),
  rows,
  hasMore,
  truncatedCells: 0,
  error,
});

const MEMBERSHIP_COLS = ["org_id", "user_id", "role"];
const USER_COLS = ["id", "email", "manager_id", "a", "b", "c", "d"];

function membershipRoot(): RowGraph {
  return rootNode("public.memberships", MEMBERSHIP_COLS, ["7", "42", "admin"], memberships.primaryKey);
}

const overlap = (a: RowNode, b: RowNode) =>
  a.x < b.x + CARD_W && a.x + CARD_W > b.x && a.y < b.y + heightOf(b) && a.y + heightOf(a) > b.y;

describe("row graph", () => {
  it("identifies rows by primary key, composite key, or all values", () => {
    expect(nodeKey("public.users", USER_COLS, ["42", "x", null, null, null, null, null], ["id"])).toEqual({ id: 'public.users#["42"]', keyed: true });
    expect(nodeKey("public.memberships", MEMBERSHIP_COLS, ["7", "42", "admin"], ["org_id", "user_id"]).id).toBe('public.memberships#["7","42"]');
    expect(nodeKey("public.logs", ["msg"], ["hi"], [])).toEqual({ id: 'public.logs#*["hi"]', keyed: false });
    // A key column missing from the result, or NULL, falls back to all values.
    expect(nodeKey("public.users", ["email"], ["x"], ["id"]).keyed).toBe(false);
    expect(nodeKey("public.users", ["id"], [null], ["id"]).keyed).toBe(false);
  });

  it("pairs composite key columns and refuses NULL or shortened values", () => {
    const row: Record<string, string | null> = { org_id: "7", user_id: "42", note: null, long: "x".repeat(4000) + "…" };
    expect(keyFilters(["org_id", "user_id"], ["o", "u"], (c) => row[c])).toEqual({ filters: [{ column: "o", value: "7" }, { column: "u", value: "42" }] });
    expect(keyFilters(["org_id", "note"], ["o", "n"], (c) => row[c])).toEqual({ skip: "null" });
    expect(keyFilters(["long"], ["l"], (c) => row[c])).toEqual({ skip: "long is too long to follow" });
    expect(keyFilters(["missing"], ["m"], (c) => row[c])).toEqual({ skip: "missing is not in the row" });
    expect(isTruncated("x".repeat(4000) + "…")).toBe(true);
    expect(isTruncated("short…")).toBe(false);
  });

  it("plans parent and child lookups, including composite keys and self-references", () => {
    const g = membershipRoot();
    const root = g.nodes.get(g.rootId)!;
    const parents = planLookups(root, "parents", refs).lookups;
    expect(parents.map((l) => [l.tableId, l.filters])).toEqual([
      ["public.organizations", [{ column: "id", value: "7" }]],
      ["public.users", [{ column: "id", value: "42" }]],
    ]);
    const children = planLookups(root, "children", refs).lookups;
    expect(children).toHaveLength(1);
    expect(children[0].filters).toEqual([{ column: "org_id", value: "7" }, { column: "user_id", value: "42" }]);
    expect(children[0].limit).toBe(CHILD_CAP);

    const user: RowNode = { ...root, id: "u", tableId: "public.users", columns: USER_COLS, values: ["42", "a@x", null, "", "", "", ""] };
    // NULL manager: no parent lookup and no note (the NULL is visible on the card).
    expect(planLookups(user, "parents", refs)).toEqual({ lookups: [], notes: [] });
    const reports = planLookups(user, "children", refs).lookups;
    expect(reports.map((l) => [l.tableId, l.filters[0].column])).toEqual([
      ["public.memberships", "user_id"],
      ["public.users", "manager_id"],
    ]);
  });

  it("shows key columns plus a few others, or all of them", () => {
    const u: RowNode = { ...membershipRoot().nodes.values().next().value!, tableId: "public.users", columns: USER_COLS, values: USER_COLS.map(() => "1") };
    const compact = cardLayout(u, users, refCols);
    expect(compact.fields.map((f) => f.name)).toEqual(["id", "email", "manager_id", "a", "b"]);
    expect(compact.fields.filter((f) => !f.pk && !f.fk && !refCols.has(`public.users.${f.name}`))).toHaveLength(EXTRA_COLUMNS);
    expect(compact.toggle).toBe(true);
    expect(compact.height).toBe(HEADER_H + 6 * ROW_H);
    const all = cardLayout({ ...u, showAll: true }, users, refCols);
    expect(all.fields).toHaveLength(USER_COLS.length);
    expect(all.toggle).toBe(true);
    // Composite primary-key columns get the PK badge although the model fields lack `pk`.
    const m = cardLayout(membershipRoot().nodes.values().next().value!, memberships, refCols);
    expect(m.fields.filter((f) => f.pk).map((f) => f.name)).toEqual(["org_id", "user_id"]);
    expect(m.toggle).toBe(false);
  });

  it("places a block as close as possible to where it wants to go, never overlapping", () => {
    expect(placeBlock([], 100, 50)).toBe(100);
    // Wanted 100..150 but 90..200 is taken: the nearest free spot is above.
    const top = placeBlock([{ top: 90, bottom: 200 }], 100, 50);
    expect(top).toBe(90 - V_GAP - 50);
    // Fits in the gap between two cards.
    expect(placeBlock([{ top: 0, bottom: 100 }, { top: 300, bottom: 400 }], 150, 100)).toBe(150);
    // Gap too small: the nearest free spot wins (here below the second card, not above the first).
    expect(placeBlock([{ top: 0, bottom: 100 }, { top: 150, bottom: 200 }], 160, 100)).toBe(200 + V_GAP);
  });

  it("merges lookups: parents left, children right, one card per row, existing cards stay put", () => {
    let g = membershipRoot();
    const root = g.nodes.get(g.rootId)!;
    const parents = planLookups(root, "parents", refs).lookups;
    const r1 = mergeLookups(g, parents, [result(["id", "name"], [["7", "Acme"]]), result(USER_COLS, [["42", "a@x", "41", "", "", "", ""]])], { heightOf, pkOf });
    g = r1.graph;
    expect(r1.added).toEqual(['public.organizations#["7"]', 'public.users#["42"]']);
    const org = g.nodes.get('public.organizations#["7"]')!;
    const user = g.nodes.get('public.users#["42"]')!;
    expect(org.x).toBe(-(CARD_W + COL_GAP));
    expect(user.x).toBe(org.x);
    expect(overlap(org, user)).toBe(false);
    expect([...g.edges.values()].map((e) => [e.from, e.to])).toEqual([
      [g.rootId, org.id],
      [g.rootId, user.id],
    ]);

    // The user's manager, then the manager's reports: the user comes back as a child of the
    // manager, but stays one card (with a second edge).
    const managerLookup = planLookups(user, "parents", refs).lookups.filter((l) => l.tableId === "public.users");
    g = mergeLookups(g, managerLookup, [result(USER_COLS, [["41", "boss@x", null, "", "", "", ""]])], { heightOf, pkOf }).graph;
    const manager = g.nodes.get('public.users#["41"]')!;
    expect(manager.col).toBe(-2);
    const reportsLookup = planLookups(manager, "children", refs).lookups.filter((l) => l.tableId === "public.users");
    const before = new Map([...g.nodes].map(([id, n]) => [id, { x: n.x, y: n.y }]));
    const r3 = mergeLookups(g, reportsLookup, [result(USER_COLS, [["42", "a@x", "41", "", "", "", ""], ["43", "b@x", "41", "", "", "", ""]])], { heightOf, pkOf });
    expect(r3.added).toEqual(['public.users#["43"]']);
    for (const [id, p] of before) expect(r3.graph.nodes.get(id)).toMatchObject(p);
    const edgesToManager = [...r3.graph.edges.values()].filter((e) => e.to === manager.id);
    expect(edgesToManager.map((e) => e.from).sort()).toEqual(['public.users#["42"]', 'public.users#["43"]']);
    const nodes = [...r3.graph.nodes.values()];
    for (const a of nodes) for (const b of nodes) if (a !== b) expect(overlap(a, b)).toBe(false);
  });

  it("adds a 'more' pill when a relationship has rows left, and notes failed lookups", () => {
    const g = membershipRoot();
    const root = g.nodes.get(g.rootId)!;
    const children = planLookups(root, "children", refs).lookups;
    const rows = Array.from({ length: CHILD_CAP }, (_, i) => [String(i), "7", "42"]);
    const r = mergeLookups(g, children, [result(["id", "org_id", "user_id"], rows, true)], { heightOf, pkOf });
    expect(r.graph.more.size).toBe(1);
    const pill = [...r.graph.more.values()][0];
    expect(pill.shown).toBe(CHILD_CAP);
    const lastCard = [...r.graph.nodes.values()].filter((n) => n.col === 1).sort((a, b) => b.y - a.y)[0];
    expect(pill.y).toBe(lastCard.y + heightOf(lastCard) + V_GAP);

    const failed = mergeLookups(g, children, [result([], [], false, "Unknown column org_id")], { heightOf, pkOf });
    expect(failed.graph.nodes.get(g.rootId)!.notes).toEqual(["project_members: Unknown column org_id"]);
    expect(failed.graph.nodes.size).toBe(1);
    expect(MORE_H).toBeGreaterThan(0);
  });

  it("stops adding cards at the cap", () => {
    const g = membershipRoot();
    const children = planLookups(g.nodes.get(g.rootId)!, "children", refs).lookups;
    const rows = Array.from({ length: MAX_NODES + 5 }, (_, i) => [String(i), "7", "42"]);
    const r = mergeLookups(g, children, [result(["id", "org_id", "user_id"], rows)], { heightOf, pkOf });
    expect(r.capped).toBe(true);
    expect(r.graph.nodes.size).toBe(MAX_NODES);
  });

  it("links cards that reference each other without a lookup between them", () => {
    let g = membershipRoot();
    const parents = planLookups(g.nodes.get(g.rootId)!, "parents", refs).lookups.filter((l) => l.tableId === "public.users");
    g = mergeLookups(g, parents, [result(USER_COLS, [["42", "a@x", "41", "", "", "", ""]])], { heightOf, pkOf }).graph;
    const children = planLookups(g.nodes.get(g.rootId)!, "children", refs).lookups;
    g = mergeLookups(g, children, [result(["id", "org_id", "user_id"], [["1", "7", "42"]])], { heightOf, pkOf }).graph;
    // Load user 41 as an unrelated root-level card: user 42's manager.
    const boss = mergeLookups(g, planLookups(g.nodes.get('public.users#["42"]')!, "parents", refs).lookups, [result(USER_COLS, [["41", "b", null, "", "", "", ""]])], { heightOf, pkOf }).graph;
    const edgeCount = boss.edges.size;
    expect(linkKnown(boss, refs).edges.size).toBe(edgeCount);
    // Remove the lookup edge and let linkKnown find it again.
    const stripped: RowGraph = { ...boss, edges: new Map([...boss.edges].filter(([, e]) => e.to !== 'public.users#["41"]')) };
    expect(linkKnown(stripped, refs).edges.size).toBe(edgeCount);
  });

  it("pushes cards down when one grows, and tidies back to columns", () => {
    let g = membershipRoot();
    const parents = planLookups(g.nodes.get(g.rootId)!, "parents", refs).lookups;
    g = mergeLookups(g, parents, [result(["id", "name"], [["7", "Acme"]]), result(USER_COLS, [["42", "a@x", null, "", "", "", ""]])], { heightOf, pkOf }).graph;
    const orgId = 'public.organizations#["7"]';
    const userId = 'public.users#["42"]';
    const org = g.nodes.get(orgId)!;
    // Make the org card tall (as if it had many columns) and relax.
    const tall = (n: RowNode) => (n.id === orgId ? 2000 : heightOf(n));
    const relaxed = relaxBelow(g, orgId, tall);
    expect(relaxed.nodes.get(userId)!.y).toBe(org.y + 2000 + V_GAP);
    expect(relaxed.nodes.get(g.rootId)).toEqual(g.nodes.get(g.rootId));

    const dragged: RowGraph = { ...g, nodes: new Map(g.nodes).set(userId, { ...g.nodes.get(userId)!, x: 900, y: -500 }) };
    const t = tidy(dragged, heightOf);
    expect(t.nodes.get(g.rootId)).toMatchObject({ x: 0, y: 0 });
    expect(t.nodes.get(userId)).toMatchObject({ x: g.nodes.get(userId)!.x, y: g.nodes.get(userId)!.y });
  });

  it("routes edges between card rows", () => {
    let g = membershipRoot();
    const parents = planLookups(g.nodes.get(g.rootId)!, "parents", refs).lookups.filter((l) => l.tableId === "public.users");
    g = mergeLookups(g, parents, [result(USER_COLS, [["42", "a@x", null, "", "", "", ""]])], { heightOf, pkOf }).graph;
    const boxes = new Map<string, TableBox>();
    for (const n of g.nodes.values()) {
      const t = tables.get(n.tableId)!;
      const l = cardLayout(n, t, refCols);
      boxes.set(n.id, { table: t, fields: l.fields, x: n.x, y: n.y, w: CARD_W, h: l.height });
    }
    const [edge] = routedEdges(g, boxes);
    const rootBox = boxes.get(g.rootId)!;
    // From the root's user_id row (left side) to the user card's id row (right side).
    expect(edge.from).toMatchObject({ side: "left", y: rowCenterY(rootBox, "user_id") });
    expect(edge.to).toMatchObject({ side: "right", y: rowCenterY(boxes.get('public.users#["42"]')!, "id") });
  });
});
