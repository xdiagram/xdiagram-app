import { Parser } from "@dbml/core";

import { buildViewModel } from "../diagram/view-model";
import { type GroupTarget, writeModuleGroups } from "./module-text";

const TABLES = `Table a {
  id int [pk]
}

Table b {
  id int [pk]
}

Table c {
  id int [pk]
}

Table billing.invoices {
  id int [pk]
}

Table billing.lines {
  id int [pk]
}
`;

const groupsOf = (text: string) => buildViewModel(Parser.parse(text, "dbmlv2")).groups;
const membersOf = (text: string) => Object.fromEntries(groupsOf(text).map((g) => [g.name, g.tables]));
const write = (src: string, targets: GroupTarget[], remove: string[] = []) => writeModuleGroups(src, groupsOf(src), targets, remove);

describe("writeModuleGroups", () => {
  it("appends new groups with their colour, members quoted like generateDbml", () => {
    const out = write(TABLES, [{ existing: null, name: "billing", color: "#E67E22", tables: ["billing.invoices", "billing.lines", "public.a"] }]);
    expect(out).toContain('TableGroup billing [color: #E67E22] {\n  "billing"."invoices"\n  "billing"."lines"\n  "a"\n}\n');
    expect(membersOf(out)).toEqual({ billing: ["billing.invoices", "billing.lines", "public.a"] });
    expect(groupsOf(out)[0].color?.toLowerCase()).toBe("#e67e22");
  });

  it("quotes names that are not bare identifiers", () => {
    const out = write(TABLES, [{ existing: null, name: "order flow", color: "#3498DB", tables: ["public.b"] }]);
    expect(membersOf(out)).toEqual({ "order flow": ["public.b"] });
  });

  it("updates an existing group in place, keeping its note and comments", () => {
    const src = `${TABLES}
TableGroup sales [color: #316896] {
  a // the main one
  Note: 'Things we sell'
  "b"
}
`;
    const out = write(src, [{ existing: "public.sales", name: "sales", color: "#316896", tables: ["public.a", "public.c"] }]);
    expect(out).toContain("  a // the main one\n  Note: 'Things we sell'\n  \"c\"\n}");
    expect(out).not.toContain('"b"\n');
    expect(membersOf(out)).toEqual({ sales: ["public.a", "public.c"] });
  });

  it("removes schema-qualified and quoted members, not lines inside a multi-line note", () => {
    const src = `${TABLES}
TableGroup money {
  billing.invoices
  "billing"."lines"
  Note: '''
  a
  '''
  b
}
`;
    const out = write(src, [{ existing: "public.money", name: "money", color: "#27AE60", tables: ["public.b"] }]);
    expect(out).toContain("  Note: '''\n  a\n  '''\n  b\n}");
    expect(membersOf(out)).toEqual({ money: ["public.b"] });
  });

  it("renames a group", () => {
    const src = `${TABLES}\nTableGroup sales {\n  a\n}\n`;
    const out = write(src, [{ existing: "public.sales", name: "shop", color: "#316896", tables: ["public.a", "public.b"] }]);
    expect(out).toContain("TableGroup shop {");
    expect(membersOf(out)).toEqual({ shop: ["public.a", "public.b"] });
  });

  it("moves tables between groups so that no table is in two", () => {
    const src = `${TABLES}\nTableGroup one {\n  a\n  b\n}\n\nTableGroup two {\n  c\n}\n`;
    const out = write(src, [
      { existing: "public.one", name: "one", color: "#316896", tables: ["public.a"] },
      { existing: "public.two", name: "two", color: "#1ABC9C", tables: ["public.b", "public.c"] },
    ]);
    expect(membersOf(out)).toEqual({ one: ["public.a"], two: ["public.c", "public.b"] });
  });

  it("deletes the groups no module continues", () => {
    const src = `${TABLES}\nTableGroup old {\n  a\n}\n\nTableGroup kept {\n  b\n}\n`;
    const out = write(src, [{ existing: "public.kept", name: "kept", color: "#316896", tables: ["public.b"] }], ["public.old"]);
    expect(out).not.toContain("TableGroup old");
    expect(membersOf(out)).toEqual({ kept: ["public.b"] });
  });

  it("leaves a member written as an alias alone", () => {
    const src = `Table orders as O {\n  id int [pk]\n}\n\nTable x {\n  id int [pk]\n}\n\nTableGroup g {\n  O\n}\n`;
    const out = write(src, [{ existing: "public.g", name: "g", color: "#316896", tables: ["public.orders", "public.x"] }]);
    expect(out).toContain("  O\n");
    expect(membersOf(out)).toEqual({ g: ["public.orders", "public.x"] });
  });
});
