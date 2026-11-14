import { EMPTY_VIEW, type VField, type VRef, type VTable, type ViewModel } from "../diagram/view-model";
import { diffSchemas, isEmptyChange, summarizeChanges } from "./schema-diff";

const field = (name: string, extra: Partial<VField> = {}): VField => ({
  name,
  type: "integer",
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

const ref = (id: string, from: string, fromField: string, to: string): VRef => ({
  id,
  name: null,
  from: { table: from, fields: [fromField], many: true },
  to: { table: to, fields: ["id"], many: false },
  onDelete: null,
  onUpdate: null,
});

const view = (tables: VTable[], refs: VRef[] = []): ViewModel => ({ ...EMPTY_VIEW, tables, refs });

describe("diffSchemas", () => {
  const users = table("public.users", [field("id", { pk: true }), field("email", { type: "varchar" })]);
  const orders = table("public.orders", [field("id", { pk: true }), field("user_id")]);
  const before = view([users, orders], [ref("r#1", "public.orders", "user_id", "public.users")]);

  it("finds nothing when the schema is the same, even if ref ids moved", () => {
    const same = view([users, orders], [ref("r#9", "public.orders", "user_id", "public.users")]);
    const c = diffSchemas(before, same);
    expect(isEmptyChange(c)).toBe(true);
    expect(summarizeChanges(c)).toBe("");
  });

  it("lists added and removed tables, column changes and relationships", () => {
    const users2 = table("public.users", [field("id", { pk: true }), field("email", { type: "text", notNull: true }), field("name", { type: "varchar" })]);
    const items = table("public.order_items", [field("id", { pk: true }), field("order_id")]);
    const after = view([users2, items], [ref("r#1", "public.order_items", "order_id", "public.orders")]);
    const c = diffSchemas(before, after);
    expect(c.tablesAdded).toEqual(["public.order_items"]);
    expect(c.tablesRemoved).toEqual(["public.orders"]);
    expect(c.tables).toEqual([
      { table: "public.users", added: ["name"], removed: [], changed: [{ name: "email", before: "varchar", after: "text, not null" }] },
    ]);
    expect(c.refsAdded).toEqual(["order_items(order_id) → orders(id)"]);
    expect(c.refsRemoved).toEqual(["orders(user_id) → users(id)"]);
    expect(summarizeChanges(c)).toBe(
      "1 table added, 1 table removed, 1 column added, 1 column changed, 1 relationship added, 1 relationship removed",
    );
  });
});
