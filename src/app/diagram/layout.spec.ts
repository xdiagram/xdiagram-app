import { GROUP_LABEL_H, GROUP_PAD, boundsOf, tableSize } from "./geometry";
import { layoutModules } from "./layout";
import { EMPTY_VIEW, type VRef, type VTable, type ViewModel } from "./view-model";

const table = (name: string): VTable => ({
  id: `public.${name}`,
  schema: "public",
  name,
  label: name,
  headerColor: null,
  note: null,
  groupId: null,
  fields: [{ name: "id", type: "int", pk: true, fk: false, unique: false, notNull: true, increment: false, isEnum: false, defaultValue: null, note: null, offset: null }],
  primaryKey: ["id"],
  line: null,
  endOffset: null,
});
const ref = (from: string, to: string): VRef => ({
  id: `${from}->${to}`,
  name: null,
  from: { table: `public.${from}`, fields: [`${to}_id`], many: true },
  to: { table: `public.${to}`, fields: ["id"], many: false },
  onDelete: null,
  onUpdate: null,
});

describe("layoutModules", () => {
  const names = ["orders", "order_items", "payments", "products", "prices", "images", "users", "tenants", "lonely", "added_later"];
  const view: ViewModel = {
    ...EMPTY_VIEW,
    tables: names.map(table),
    refs: [ref("order_items", "orders"), ref("payments", "orders"), ref("prices", "products"), ref("images", "products"), ref("order_items", "products"), ref("orders", "users")],
  };
  const plan = {
    modules: [
      { key: "m:orders", tables: ["public.orders", "public.order_items", "public.payments"] },
      { key: "m:products", tables: ["public.products", "public.prices", "public.images"] },
    ],
    common: ["public.users", "public.tenants"],
    other: ["public.lonely"],
  };
  const zoneOf = (positions: Record<string, { x: number; y: number }>, ids: string[]) => {
    const b = boundsOf(ids.map((id) => ({ ...positions[id], ...tableSize(view.tables.find((t) => t.id === id)!) })));
    return { x: b.x - GROUP_PAD, y: b.y - GROUP_PAD - GROUP_LABEL_H, w: b.w + GROUP_PAD * 2, h: b.h + GROUP_PAD * 2 + GROUP_LABEL_H };
  };
  const overlap = (a: ReturnType<typeof zoneOf>, b: ReturnType<typeof zoneOf>) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("places every table, with zones that never overlap and the common tables on top", async () => {
    const positions = await layoutModules(view, plan);
    expect(Object.keys(positions).sort()).toEqual(view.tables.map((t) => t.id).sort());
    const zones = [
      zoneOf(positions, plan.modules[0].tables),
      zoneOf(positions, plan.modules[1].tables),
      zoneOf(positions, plan.common),
      zoneOf(positions, ["public.lonely", "public.added_later"]),
    ];
    for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) expect(overlap(zones[i], zones[j])).toBe(false);
    const commonBottom = zones[2].y + zones[2].h;
    expect(zones[0].y).toBeGreaterThanOrEqual(commonBottom);
    expect(zones[1].y).toBeGreaterThanOrEqual(commonBottom);
  });

  it("gives the same positions every time", async () => {
    expect(await layoutModules(view, plan)).toEqual(await layoutModules(view, plan));
  });
});
