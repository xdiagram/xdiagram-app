import {
  identifierExtent,
  insertColumn,
  isValidName,
  newTableBlock,
  offsetOf,
  refLine,
  renameColumnText,
  tableRef,
  uniqueName,
} from "./canvas-edit";

describe("canvas-edit", () => {
  it("quotes table references, omitting the default schema", () => {
    expect(tableRef("public.users")).toBe('"users"');
    expect(tableRef("billing.invoices")).toBe('"billing"."invoices"');
    expect(tableRef("public.my.table")).toBe('"my.table"');
  });

  it("builds Ref lines for single and composite keys", () => {
    expect(refLine({ table: "public.events", fields: ["user_id"] }, { table: "public.users", fields: ["id"] })).toBe(
      'Ref: "events"."user_id" > "users"."id"',
    );
    expect(
      refLine({ table: "billing.lines", fields: ["a", "b"] }, { table: "billing.heads", fields: ["x", "y"] }, "-"),
    ).toBe('Ref: "billing"."lines".("a", "b") - "billing"."heads".("x", "y")');
  });

  it("validates names", () => {
    expect(isValidName("orders")).toBe(true);
    expect(isValidName("  ")).toBe(false);
    expect(isValidName('a"b')).toBe(false);
    expect(isValidName("a\nb")).toBe(false);
  });

  it("picks unique names", () => {
    expect(uniqueName("new_table", new Set())).toBe("new_table");
    expect(uniqueName("new_table", new Set(["new_table", "new_table_2"]))).toBe("new_table_3");
  });

  it("creates a new table block", () => {
    expect(newTableBlock("public.orders")).toBe('Table "orders" {\n  "id" integer [pk]\n}');
  });

  it("inserts a column before the closing brace, keeping indentation", () => {
    const src = 'Table "users" {\n    "id" int8 [pk]\n}\n\nRef: x > y\n';
    const end = src.indexOf("}") + 1;
    expect(insertColumn(src, end, "email", "varchar(255)")).toBe(
      'Table "users" {\n    "id" int8 [pk]\n    "email" varchar(255)\n}\n\nRef: x > y\n',
    );
  });

  it("inserts into an empty or single-line block", () => {
    const empty = "Table t {\n}\n";
    expect(insertColumn(empty, empty.indexOf("}") + 1, "id", "int")).toBe('Table t {\n  "id" int\n}\n');
    const inline = "Table t { id int }";
    expect(insertColumn(inline, inline.length, "x", "")).toBe('Table t { id int \n  "x" varchar\n}');
  });

  it("finds quoted and bare identifiers", () => {
    expect(identifierExtent('  "email" varchar', 2)).toEqual({ start: 2, end: 9 });
    expect(identifierExtent("  email varchar", 2)).toEqual({ start: 2, end: 7 });
  });

  it("renames a column declaration and its usages", () => {
    const src = 'Table "users" {\n  "email" varchar\n  indexes {\n    (email, id)\n  }\n}\nRef: p.e > "users"."email"\n';
    const decl = src.indexOf('"email"');
    const idx = src.indexOf("email, id");
    const ref = src.lastIndexOf('"email"');
    const out = renameColumnText(src, decl, [{ start: idx, end: idx + 5 }, { start: ref, end: ref + 7 }], "mail");
    expect(out).toBe('Table "users" {\n  "mail" varchar\n  indexes {\n    (mail, id)\n  }\n}\nRef: p.e > "users"."mail"\n');
  });

  it("quotes renamed bare usages when the new name needs quoting", () => {
    const src = "Table t {\n  email varchar\n}\n";
    expect(renameColumnText(src, src.indexOf("email"), [], "e mail")).toBe('Table t {\n  "e mail" varchar\n}\n');
  });

  it("converts line/column to offsets", () => {
    expect(offsetOf("ab\ncd\nef", 2, 2)).toBe(4);
    expect(offsetOf("ab\ncd", 9, 1)).toBe(5);
  });
});
