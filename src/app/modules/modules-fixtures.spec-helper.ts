import type { VRef } from "../diagram/view-model";
import type { Link } from "./types";

/** Declared ref `child.<parent>_id → parent.id` between two `public` tables. */
export function fk(child: string, parent: string): VRef {
  const from = `public.${child}`;
  const to = `public.${parent}`;
  return {
    id: `${from}->${to}`,
    name: null,
    from: { table: from, fields: [`${parent}_id`], many: true },
    to: { table: to, fields: ["id"], many: false },
    onDelete: null,
    onUpdate: null,
  };
}

/** Declared link between two `public` tables. */
export function link(x: string, y: string, calls = 0): Link {
  const [a, b] = [`public.${x}`, `public.${y}`].sort();
  return { a, b, declared: true, calls };
}

export const ids = (...names: string[]) => names.map((n) => `public.${n}`);

/**
 * Three modules of five tables (a centre with four children, two of them linked), one bridge
 * (order_items → products), and `users` referenced by all fifteen.
 */
export function shop(): { tables: string[]; links: Link[] } {
  const modules: [string, string[]][] = [
    ["orders", ["order_items", "payments", "shipments", "returns"]],
    ["products", ["categories", "product_images", "prices", "inventory"]],
    ["invoices", ["invoice_lines", "credit_notes", "tax_rates", "receipts"]],
  ];
  const links: Link[] = [];
  const tables = ["users"];
  for (const [centre, children] of modules) {
    tables.push(centre, ...children);
    for (const c of children) links.push(link(c, centre));
    links.push(link(children[0], children[1]));
    for (const t of [centre, ...children]) links.push(link(t, "users"));
  }
  links.push(link("order_items", "products"));
  return { tables: ids(...tables), links };
}
