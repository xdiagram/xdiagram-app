import { mergeDbml } from "./merge";

const base = [
  'Table "users" {',
  '  "id" integer [pk]',
  '  "email" varchar',
  "}",
  "",
  'Table "orders" {',
  '  "id" integer [pk]',
  '  "user_id" integer',
  "}",
  "",
  'Ref "orders_user_id_fkey":"users"."id" < "orders"."user_id"',
  "",
].join("\n");

describe("mergeDbml", () => {
  it("keeps the user's edits and takes the database's changes elsewhere", () => {
    const ours = base.replace('Table "users" {', 'Table "users" [headercolor: #2f6fde] {') + 'TableGroup "core" {\n  "users"\n}\n';
    const theirs = base.replace('  "user_id" integer\n', '  "user_id" integer\n  "total" numeric(10,2)\n');
    const r = mergeDbml(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.text).toContain('Table "users" [headercolor: #2f6fde] {');
    expect(r.text).toContain('"total" numeric(10,2)');
    expect(r.text).toContain('TableGroup "core"');
  });

  it("lets the database win where both changed the same lines, and reports it", () => {
    const ours = base.replace('  "email" varchar', '  "email" varchar [note: "login"]');
    const theirs = base.replace('  "email" varchar', '  "email" text [not null]');
    const r = mergeDbml(base, ours, theirs);
    expect(r.text).toContain('"email" text [not null]');
    expect(r.text).not.toContain("login");
    expect(r.conflicts).toEqual([{ line: 3, ours: '  "email" varchar [note: "login"]', theirs: '  "email" text [not null]' }]);
  });

  it("takes either side whole when the other did not change", () => {
    const edited = base.replace("varchar", "text");
    expect(mergeDbml(base, edited, base)).toEqual({ text: edited, conflicts: [] });
    expect(mergeDbml(base, base, edited)).toEqual({ text: edited, conflicts: [] });
    expect(mergeDbml(base, edited, edited)).toEqual({ text: edited, conflicts: [] });
  });

  it("keeps a table the database dropped only if the user did not touch it either", () => {
    const theirs = base.replace(/Table "orders" \{[^}]*\}\n\n/, "").replace(/Ref .*\n/, "");
    const r = mergeDbml(base, base.replace("varchar", "text"), theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.text).not.toContain('Table "orders"');
    expect(r.text).toContain('"email" text');
  });
});
