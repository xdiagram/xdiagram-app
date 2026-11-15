import { findModules, isValidModuleName } from "./find-modules";
import { ids, link, shop } from "./modules-fixtures.spec-helper";
import type { ExistingGroup, ModuleProposal } from "./types";

const names = (p: ModuleProposal) => Object.fromEntries(p.modules.map((m) => [m.name, m.tables.map((t) => t.slice("public.".length))]));
const group = (name: string, tables: string[], color: string | null = null): ExistingGroup => ({
  id: `public.${name}`,
  name,
  color,
  tables: ids(...tables),
});

describe("findModules", () => {
  const { tables, links } = shop();
  const base = { tables, links, source: "declared" as const, groups: [], mode: "extend" as const };

  it("takes the table everything references out and finds the modules behind it", () => {
    const p = findModules(base);
    expect(p.common).toEqual(["public.users"]);
    expect(p.detected).toEqual(["public.users"]);
    expect(names(p)).toEqual({
      invoices: ["credit_notes", "invoice_lines", "invoices", "receipts", "tax_rates"],
      orders: ["order_items", "orders", "payments", "returns", "shipments"],
      products: ["categories", "inventory", "prices", "product_images", "products"],
    });
    expect(p.modules.every((m) => m.existing === null && !m.locked)).toBe(true);
    expect(p.other).toEqual([]);
  });

  it("gives the same proposal whatever order the input comes in", () => {
    const again = findModules({ ...base, tables: [...tables].reverse(), links: [...links].reverse() });
    expect(again).toEqual(findModules(base));
  });

  it("gives linked modules different colours", () => {
    const p = findModules(base);
    const colour = (n: string) => p.modules.find((m) => m.name === n)!.color;
    expect(colour("orders")).not.toBe(colour("products"));
    expect(new Set(p.modules.map((m) => m.color)).size).toBe(3);
  });

  it("follows the user's choice of common tables", () => {
    const back = findModules({ ...base, commonRemoved: ["public.users"] });
    expect(back.common).toEqual([]);
    expect(back.detected).toEqual(["public.users"]);
    const more = findModules({ ...base, commonAdded: ["public.products"] });
    expect(more.common).toEqual(["public.users", "public.products"]);
    expect(more.modules.some((m) => m.tables.includes("public.products"))).toBe(false);
  });

  it("puts tables that only link to a common table in that table's own module, and lone tables in other", () => {
    const extra = [link("user_settings", "users"), link("user_sessions", "users"), link("user_roles", "users")];
    const p = findModules({ ...base, tables: [...tables, ...ids("user_settings", "user_sessions", "user_roles", "lonely")], links: [...links, ...extra] });
    const own = p.modules.find((m) => m.satelliteOf === "public.users")!;
    expect(own.name).toBe("users");
    expect(own.tables).toEqual(ids("user_roles", "user_sessions", "user_settings"));
    expect(p.other).toEqual(["public.lonely"]);
  });

  it("merges a module that is too small into its closest neighbour", () => {
    // 40+ tables: modules need three. A pair hanging off orders joins it.
    const filler = Array.from({ length: 24 }, (_, i) => `f${i}`);
    const fillerLinks = filler.slice(1).map((t, i) => link(filler[i], t));
    const pair = [link("audit_a", "audit_b"), link("audit_a", "orders")];
    const p = findModules({
      ...base,
      tables: [...tables, ...ids(...filler, "audit_a", "audit_b")],
      links: [...links, ...fillerLinks, ...pair],
    });
    expect(p.common).toEqual(["public.users"]);
    expect(p.modules.find((m) => m.name === "orders")!.tables).toEqual(expect.arrayContaining(ids("orders", "audit_a", "audit_b")));
    expect(p.modules.every((m) => m.tables.length >= 3)).toBe(true);
  });

  it("finds two common tables when everything also references a tenant", () => {
    const withTenant = [...links, ...tables.map((t) => link(t.slice("public.".length), "tenants"))];
    const p = findModules({ ...base, tables: [...tables, "public.tenants"], links: withTenant });
    expect(p.common).toEqual(["public.tenants", "public.users"]);
    expect(Object.keys(names(p)).sort()).toEqual(["invoices", "orders", "products"]);
  });

  it("keeps a candidate centre with its own children instead of treating it as common", () => {
    const children = Array.from({ length: 12 }, (_, i) => `photo_${i}`);
    const p = findModules({
      ...base,
      tables: [...tables, ...ids(...children)],
      links: [...links, ...children.map((c) => link(c, "products"))],
    });
    expect(p.common).toEqual(["public.users"]);
    expect(p.modules.find((m) => m.name === "products")!.tables).toEqual(expect.arrayContaining(ids(...children)));
  });

  it("makes names unique and valid", () => {
    const p = findModules({ ...base, groups: [group("orders", ["users"])] , mode: "all" });
    const all = p.modules.map((m) => m.name);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every(isValidModuleName)).toBe(true);
    expect(isValidModuleName("a{b")).toBe(false);
  });

  describe("with existing groups", () => {
    it("extend mode keeps each group and only adds tables to it", () => {
      const groups = [group("sales", ["orders", "invoices"], "#E67E22"), group("pics", ["product_images"])];
      const p = findModules({ ...base, groups });
      const sales = p.modules.find((m) => m.existing === "public.sales")!;
      expect(sales).toMatchObject({ name: "sales", color: "#E67E22", locked: true });
      expect(sales.tables).toEqual(expect.arrayContaining(ids("orders", "invoices")));
      expect(sales.added).toBe(sales.tables.length - 2);
      expect(p.modules.find((m) => m.existing === "public.pics")!.tables).toContain("public.product_images");
      expect(p.moves).toEqual([]);
      expect(p.removedGroups).toEqual([]);
    });

    it("all mode continues the groups that overlap a module, keeping their name and colour", () => {
      const groups = [group("shop", ["orders", "order_items", "payments"], "#8E44AD"), group("misc", ["products", "invoices", "users"])];
      const p = findModules({ ...base, groups, mode: "all" });
      const shopModule = p.modules.find((m) => m.existing === "public.shop")!;
      expect(shopModule).toMatchObject({ name: "shop", color: "#8E44AD", locked: false });
      expect(shopModule.tables).toEqual(expect.arrayContaining(ids("orders", "shipments", "returns")));
      expect(p.removedGroups).toEqual(["public.misc"]);
      expect(p.moves).toEqual(
        expect.arrayContaining([
          { table: "public.products", from: "misc", to: "products" },
          { table: "public.users", from: "misc", to: null },
        ]),
      );
    });

    it("a recomputation keeps the names and colours of the proposal it replaces", () => {
      const first = findModules(base);
      const renamed = first.modules.map((m) => (m.name === "orders" ? { ...m, name: "sales", color: "#E74C3C" } : m));
      const again = findModules({ ...base, previous: renamed, commonAdded: [] });
      expect(again.modules.find((m) => m.tables.includes("public.orders"))).toMatchObject({ name: "sales", color: "#E74C3C" });
    });
  });
});
