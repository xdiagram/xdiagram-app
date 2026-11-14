import { relatedTables, type VRef } from "./view-model";

const ref = (from: string, to: string): VRef => ({
  id: `${from}->${to}`,
  name: null,
  from: { table: from, fields: ["fk"], many: true },
  to: { table: to, fields: ["id"], many: false },
  onDelete: null,
  onUpdate: null,
});

describe("relatedTables", () => {
  const refs = [
    ref("public.orders", "public.users"),
    ref("public.profiles", "public.users"),
    ref("public.users", "public.countries"),
    ref("public.order_items", "public.orders"),
    ref("public.users", "public.users"),
  ];

  it("follows references in both directions", () => {
    expect(relatedTables(refs, "public.users")).toEqual(
      new Set(["public.users", "public.orders", "public.profiles", "public.countries"]),
    );
  });

  it("includes the referenced table of an outgoing link", () => {
    expect(relatedTables(refs, "public.orders")).toEqual(
      new Set(["public.orders", "public.users", "public.order_items"]),
    );
  });

  it("stops at the first degree", () => {
    expect(relatedTables(refs, "public.users").has("public.order_items")).toBe(false);
  });

  it("returns only the table itself when it has no links", () => {
    expect(relatedTables(refs, "public.audit")).toEqual(new Set(["public.audit"]));
    expect(relatedTables([], "public.users")).toEqual(new Set(["public.users"]));
  });
});
