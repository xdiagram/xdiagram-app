import type { DiscoveredRelation, FkUsage } from "../core/tauri-api.service";
import { EMPTY_VIEW, type VField, type VRef, type VTable, type ViewModel } from "../diagram/view-model";
import { buildJoinGraph, pathDialectOf } from "./join-graph";

const field = (name: string): VField => ({
  name,
  type: "int",
  pk: name === "id",
  fk: false,
  unique: false,
  notNull: false,
  increment: false,
  isEnum: false,
  defaultValue: null,
  note: null,
  offset: null,
});
const table = (id: string, fields: string[]): VTable => ({
  id,
  schema: id.split(".")[0],
  name: id.split(".")[1],
  label: id,
  headerColor: null,
  note: null,
  groupId: null,
  fields: fields.map(field),
  primaryKey: ["id"],
  line: null,
  endOffset: null,
});
const ref = (id: string, from: string, fromCols: string[], to: string, toCols: string[], many = true): VRef => ({
  id,
  name: null,
  from: { table: from, fields: fromCols, many },
  to: { table: to, fields: toCols, many: false },
  onDelete: null,
  onUpdate: null,
});
const end = (t: string, columns: string[]) => ({ schema: t.split(".")[0], table: t.split(".")[1], columns });
const join = (from: string, fromCols: string[], to: string, toCols: string[], calls: number, directed = true): DiscoveredRelation => ({
  from: end(from, fromCols),
  to: end(to, toCols),
  directed,
  calls,
  statements: 1,
  queries: [],
});
const usage = (from: string, fromCols: string[], to: string, toCols: string[], calls: number): FkUsage => ({ name: "fk", from: end(from, fromCols), to: end(to, toCols), calls });

describe("buildJoinGraph", () => {
  const view: ViewModel = {
    ...EMPTY_VIEW,
    tables: [
      table("public.orders", ["id", "user_id", "note_ref"]),
      table("public.users", ["id", "org_id"]),
      table("public.members", ["org_id", "role"]),
      table("public.roles", ["org_id", "name"]),
      table("billing.notes", ["id"]),
    ],
    refs: [
      ref("o_u#0", "public.orders", ["user_id"], "public.users", ["id"]),
      ref("m_r#1", "public.members", ["org_id", "role"], "public.roles", ["org_id", "name"]),
      ref("bad#2", "public.users", ["org_id"], "public.roles", ["org_id", "name"]),
      ref("one#3", "public.users", ["id"], "public.members", ["org_id"], false),
    ],
  };

  it("turns declared refs into edges: column pairs, multiplicity, ids", () => {
    const g = buildJoinGraph(view, null);
    expect(g.tables.map((t) => t.id)).toEqual(view.tables.map((t) => t.id));
    expect(g.tables[4]).toEqual({ id: "billing.notes", schema: "billing", name: "notes" });
    expect(g.edges).toEqual([
      { id: "o_u#0", from: "public.orders", to: "public.users", pairs: [{ from: "user_id", to: "id" }], kind: "declared", fromMult: "many", toMult: "one", calls: 0 },
      {
        id: "m_r#1",
        from: "public.members",
        to: "public.roles",
        pairs: [
          { from: "org_id", to: "org_id" },
          { from: "role", to: "name" },
        ],
        kind: "declared",
        fromMult: "many",
        toMult: "one",
        calls: 0,
      },
      // bad#2 has one column on one side and two on the other: skipped.
      { id: "one#3", from: "public.users", to: "public.members", pairs: [{ from: "id", to: "org_id" }], kind: "declared", fromMult: "one", toMult: "one", calls: 0 },
    ]);
  });

  it("adds the traffic: FK usage on declared edges, joins nobody declared as edges of their own", () => {
    const report = {
      available: true,
      declaredUsage: [usage("public.orders", ["user_id"], "public.users", ["id"], 900)],
      relations: [
        join("public.orders", ["note_ref"], "billing.notes", ["id"], 40),
        join("public.users", ["org_id"], "public.roles", ["org_id"], 7, false),
        // Already declared, unknown column, unknown table: left out.
        join("public.orders", ["user_id"], "public.users", ["id"], 5),
        join("public.orders", ["nope"], "public.users", ["id"], 5),
        join("public.ghost", ["x"], "public.users", ["id"], 5),
      ],
    };
    const g = buildJoinGraph(view, report);
    expect(g.edges.find((e) => e.id === "o_u#0")?.calls).toBe(900);
    expect(g.edges.filter((e) => e.kind === "discovered")).toEqual([
      {
        id: "discovered:public.orders(note_ref)->billing.notes(id)",
        from: "public.orders",
        to: "billing.notes",
        pairs: [{ from: "note_ref", to: "id" }],
        kind: "discovered",
        fromMult: "many",
        toMult: "one",
        calls: 40,
      },
      {
        id: "discovered:public.users(org_id)->public.roles(org_id)",
        from: "public.users",
        to: "public.roles",
        pairs: [{ from: "org_id", to: "org_id" }],
        kind: "discovered",
        fromMult: "unknown",
        toMult: "unknown",
        calls: 7,
      },
    ]);
    expect(buildJoinGraph(view, report, { discovered: false }).edges.every((e) => e.kind === "declared")).toBe(true);
    expect(buildJoinGraph(view, { ...report, available: false }).edges.every((e) => e.calls === 0 && e.kind === "declared")).toBe(true);
  });
});

describe("pathDialectOf", () => {
  it("quotes like the database, the imported dialect, or PostgreSQL", () => {
    expect(pathDialectOf({ kind: "db", engine: "mssql" })).toBe("mssql");
    expect(pathDialectOf({ kind: "file", dialect: "mysql" })).toBe("mysql");
    expect(pathDialectOf({ kind: "file", dialect: "oracle" })).toBe("postgres");
    expect(pathDialectOf({ kind: "file" })).toBe("postgres");
    expect(pathDialectOf(null)).toBe("postgres");
  });
});
