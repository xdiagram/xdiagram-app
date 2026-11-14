import { parseExpression, printExpression, type RelContext } from "./expression";
import type { RelNode } from "./model";
import { quantText, relOptions, type RefLike } from "./relations";
import { renameColumns, reId, hasActive } from "./tree";
import { toWire } from "./wire";

const ref = (from: string, fromFields: string[], to: string, toFields: string[]): RefLike => ({ from: { table: from, fields: fromFields }, to: { table: to, fields: toFields } });

const REFS: RefLike[] = [
  ref("public.orders", ["user_id"], "public.users", ["id"]),
  ref("public.orders", ["approved_by"], "public.users", ["id"]),
  ref("public.users", ["org_id"], "public.organizations", ["id"]),
  ref("public.users", ["manager_id"], "public.users", ["id"]),
  ref("billing.invoices", ["org_id", "user_id"], "public.memberships", ["org_id", "user_id"]),
];

describe("relationships of a table", () => {
  it("names children after their table and parents after the key column, clashes get the key", () => {
    const opts = relOptions("public.users", REFS);
    expect(opts.map((o) => [o.label, o.direction, o.tableId, JSON.stringify(o.on)])).toEqual([
      ["orders.user_id", "children", "public.orders", '[["id","user_id"]]'],
      ["orders.approved_by", "children", "public.orders", '[["id","approved_by"]]'],
      ["org", "parent", "public.organizations", '[["org_id","id"]]'],
      ["users", "children", "public.users", '[["id","manager_id"]]'],
      ["manager", "parent", "public.users", '[["manager_id","id"]]'],
    ]);
    const m = relOptions("public.memberships", REFS);
    expect(m.map((o) => [o.label, o.schema, o.table, JSON.stringify(o.on)])).toEqual([["billing.invoices", "billing", "invoices", '[["org_id","org_id"],["user_id","user_id"]]']]);
  });

  it("describes how many", () => {
    expect(quantText("some", "orders")).toBe("has orders");
    expect(quantText("none", "orders")).toBe("has no orders");
    expect(quantText({ count: { op: "ge", n: 3 } }, "orders")).toBe("has ≥ 3 orders");
  });
});

describe("related rows in expressions", () => {
  const ctx: RelContext = { table: "public.users", options: (t) => relOptions(t, REFS) };
  const first = (text: string) => parseExpression(text, ctx).items[0] as RelNode;

  it("parses has, no and count, with conditions on the related rows", () => {
    const has = first("has org");
    expect([has.label, has.table, has.quant, JSON.stringify(has.on)]).toEqual(["org", "organizations", "some", '[["org_id","id"]]']);
    expect(first("has no users").quant).toBe("none");
    expect(first("no manager").quant).toBe("none");
    expect(first("count(orders.user_id) >= 3").quant).toEqual({ count: { op: "ge", n: 3 } });
    const narrowed = first("count(orders.user_id(total > 100 and status = paid)) != 0");
    expect(narrowed.filter?.items.map((i) => (i.t === "cond" ? `${i.column} ${i.op}` : i.t))).toEqual(["total gt", "status eq"]);
    // Inside, relationships are the related table's: an order's approver is a user, who has a manager.
    const nested = first("has orders.approved_by(has user(has manager))");
    expect(nested.filter?.items[0]).toMatchObject({ t: "rel", label: "user", table: "users", on: [["user_id", "id"]] });
  });

  it("prints back what it parses", () => {
    for (const text of [
      "has org",
      "no manager",
      "count(orders.user_id) >= 3",
      "has orders.user_id(total > 100) and email ~ gmail",
      "count(users(email ~ x)) = 2 or not (has org)",
    ]) {
      expect(printExpression(parseExpression(text, ctx))).toBe(text);
    }
  });

  it("reports unknown names and missing context where they are", () => {
    expect(() => parseExpression("has nope", ctx)).toThrow(/No related table “nope”: try orders.user_id, orders.approved_by, org, users, manager/);
    expect(() => parseExpression("has org")).toThrow(/no known relationships/);
    expect(() => parseExpression("count(org) ~ 3", ctx)).toThrow(/Expected =, !=/);
    expect(() => parseExpression("count(org) > x", ctx)).toThrow(/whole number/);
    expect(() => parseExpression("has = 1", ctx)).toThrow();
    expect(parseExpression("`has` = 1", ctx).items[0]).toMatchObject({ t: "cond", column: "has" });
  });

  it("goes over the wire and through tree edits", () => {
    const tree = parseExpression("has orders.user_id(total > 100)", ctx);
    const wire = toWire(tree, new Date(2026, 10, 14), () => "int");
    expect(wire).toMatchObject({ t: "group", items: [{ t: "rel", schema: "public", table: "orders", on: [["id", "user_id"]], quant: "some", filter: { t: "group", items: [{ t: "cond", column: "total", op: "gt", args: ["100"] }] } }] });
    expect(hasActive(tree)).toBe(true);
    const renamed = renameColumns(tree, (c) => `u.${c}`);
    expect((renamed.items[0] as RelNode).on).toEqual([["u.id", "user_id"]]);
    expect(((renamed.items[0] as RelNode).filter?.items[0] as { column: string }).column).toBe("total");
    const fresh = reId(tree);
    expect((fresh.items[0] as RelNode).filter?.id).not.toBe((tree.items[0] as RelNode).filter?.id);
  });
});
