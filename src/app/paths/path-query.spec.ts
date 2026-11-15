import { matchTables, parsePathQuery, pathCandidates } from "./path-query";

describe("path queries in the palette", () => {
  it("reads the start and the end, with or without the path prefix", () => {
    expect(parsePathQuery("path orders → users")).toEqual({ from: "orders", to: "users" });
    expect(parsePathQuery("Path: orders -> users")).toEqual({ from: "orders", to: "users" });
    expect(parsePathQuery("orders > users")).toEqual({ from: "orders", to: "users" });
    expect(parsePathQuery("orders=>users")).toEqual({ from: "orders", to: "users" });
    expect(parsePathQuery("path orders → ")).toEqual({ from: "orders", to: "" });
    expect(parsePathQuery("path orders")).toEqual({ from: "orders", to: null });
  });

  it("leaves other searches alone", () => {
    expect(parsePathQuery("orders")).toBeNull();
    expect(parsePathQuery("path")).toBeNull();
    expect(parsePathQuery("pathology")).toBeNull();
    expect(parsePathQuery("a > b > c")).toBeNull();
  });

  const tables = ["public.orders", "public.order_items", "public.users", "billing.invoices", "public.user_roles"];

  it("matches table names, schema-qualified outside the default schema", () => {
    expect(matchTables("inv", tables, 3).map((m) => m.id)).toEqual(["billing.invoices"]);
    expect(matchTables("billing.inv", tables, 3).map((m) => m.id)).toEqual(["billing.invoices"]);
  });

  it("combines the best matches of each side", () => {
    expect(pathCandidates({ from: "orders", to: "users" }, tables)[0]).toEqual({ from: "public.orders", to: "public.users" });
    expect(pathCandidates({ from: "orders", to: "users" }, tables).length).toBeLessThanOrEqual(8);
    // End not typed yet: every other table, by name.
    const open = pathCandidates({ from: "invoices", to: "" }, tables);
    expect(open.map((c) => c.to)).toEqual(["public.order_items", "public.orders", "public.user_roles", "public.users"]);
    expect(pathCandidates({ from: "orders", to: null }, tables)).toEqual([]);
    // Both sides typed as the same table: its self-references.
    expect(pathCandidates({ from: "users", to: "users" }, tables)[0]).toEqual({ from: "public.users", to: "public.users" });
  });
});
