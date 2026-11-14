import { MAX_TABLES, deleteNamed, emptyMemory, parseMemory, rememberExpression, rememberTable, saveNamed } from "./memory";
import type { GroupNode } from "./model";
import { reId } from "./tree";

const where = (column: string): GroupNode => ({ t: "group", id: "r", op: "and", items: [{ t: "cond", id: "c", column, op: "eq", args: ["1"] }] });

describe("remembered filters", () => {
  it("round-trips and tolerates damaged files", () => {
    let m = rememberTable(emptyMemory(), "public.users", { where: where("id"), sort: [{ column: "id", desc: true }] }, new Date("2026-11-14T10:00:00Z"));
    const back = parseMemory(JSON.stringify(m));
    expect(back.tables["public.users"].where).toEqual(where("id"));
    expect(back.tables["public.users"].sort).toEqual([{ column: "id", desc: true }]);
    expect(parseMemory("{ not json")).toEqual(emptyMemory());
    expect(parseMemory(JSON.stringify({ tables: { t: { where: "nope", sort: [{ column: 3 }] } } })).tables["t"]).toEqual({ updatedAt: new Date(0).toISOString(), sort: [] });
    m = rememberTable(m, "public.users", { where: { t: "group", id: "r", op: "and", items: [] }, sort: [] });
    expect(m.tables["public.users"]).toBeUndefined();
  });

  it("keeps the most recent tables", () => {
    let m = emptyMemory();
    for (let i = 0; i <= MAX_TABLES; i++) m = rememberTable(m, `t${i}`, { where: where("id") }, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    expect(Object.keys(m.tables)).toHaveLength(MAX_TABLES);
    expect(m.tables["t0"]).toBeUndefined();
    expect(m.tables[`t${MAX_TABLES}`]).toBeDefined();
  });

  it("keeps an expression history without repeats", () => {
    let m = rememberExpression(emptyMemory(), "a = 1");
    m = rememberExpression(m, "b = 2");
    m = rememberExpression(m, " a = 1 ");
    expect(m.history).toEqual(["a = 1", "b = 2"]);
  });

  it("saves named filters per table, replacing a name and sorted by name", () => {
    let m = rememberTable(emptyMemory(), "t", { where: where("kept") });
    m = saveNamed(m, "t", { name: "Zeta", where: where("a"), sort: [] });
    m = saveNamed(m, "t", { name: " admins ", where: where("b"), sort: [{ column: "id", desc: true }] });
    m = saveNamed(m, "t", { name: "ADMINS", where: where("c"), sort: [] });
    m = saveNamed(m, "t", { name: "  ", where: where("d"), sort: [] });
    expect(m.tables["t"].saved?.map((s) => s.name)).toEqual(["ADMINS", "Zeta"]);
    expect(m.tables["t"].saved?.[0].where).toEqual(where("c"));
    expect(m.tables["t"].where).toEqual(where("kept"));
    const back = parseMemory(JSON.stringify(m));
    expect(back.tables["t"].saved?.map((s) => s.name)).toEqual(["ADMINS", "Zeta"]);
    m = deleteNamed(m, "t", "Zeta");
    expect(m.tables["t"].saved?.map((s) => s.name)).toEqual(["ADMINS"]);
    m = deleteNamed(rememberTable(m, "t", { where: undefined }), "t", "ADMINS");
    expect(m.tables["t"]).toBeUndefined();
  });

  it("gives an applied filter new ids", () => {
    const tree: GroupNode = { t: "group", id: "r", op: "or", items: [{ t: "cond", id: "c", column: "a", op: "eq", args: ["1"] }, { t: "group", id: "g", op: "and", items: [] }] };
    const fresh = reId(tree);
    expect(fresh.id).not.toBe("r");
    expect(fresh.items.map((i) => i.id)).not.toContain("c");
    expect(JSON.stringify(fresh, (k, v) => (k === "id" ? undefined : v))).toBe(JSON.stringify(tree, (k, v) => (k === "id" ? undefined : v)));
  });
});
