import { loadDbmlCore } from "../core/dbml";
import { buildViewModel } from "../diagram/view-model";
import { buildDocModel } from "../export/doc-model";
import { DEFAULT_RULES, type LintFinding, RULES, lintSchema } from "./lint";

const DBML = `
Table users {
  id bigint [pk]
  email varchar(255) [unique]
  full_name text
  created_at timestamp
  org_id int
}
Table organizations {
  id int [pk]
  name text
}
Table orders {
  id int [pk]
  user_id int [not null]
  "order" text
  Indexes {
    user_id
    (user_id, id)
    user_id [name: 'orders_user_dup']
  }
}
Table logs {
  message text
  createdAt timestamp
}
Table items {
  id int [pk]
  code varchar(10)
  unit_price numeric(10,2)
}
Table item_refs {
  item_code varchar(20) [ref: > items.code]
}
Ref: orders.user_id > users.id
`;

async function lint(dbml: string, rules = new Set(RULES.map((r) => r.id))): Promise<LintFinding[]> {
  const { Parser } = await loadDbmlCore();
  const db = new Parser().parse(dbml, "dbmlv2");
  return lintSchema(buildDocModel(db, buildViewModel(db), { title: "t", source: null }), rules);
}

const find = (all: LintFinding[], rule: string, table: string, column: string | null = null) =>
  all.filter((f) => f.rule === rule && f.table === `public.${table}` && (column === null || f.column === column));

describe("schema lint", () => {
  it("checks relationships", async () => {
    const all = await lint(DBML);
    expect(find(all, "fk-type-mismatch", "orders", "user_id")[0]?.severity).toBe("error");
    expect(find(all, "fk-type-mismatch", "item_refs", "item_code")[0]?.severity).toBe("warning");
    expect(find(all, "fk-target-not-unique", "item_refs")).toHaveLength(1);
    expect(find(all, "fk-not-indexed", "item_refs")).toHaveLength(1);
    expect(find(all, "fk-not-indexed", "orders")).toHaveLength(0);
    expect(find(all, "nullable-fk", "item_refs", "item_code")).toHaveLength(1);
  });

  it("checks tables, indexes and names", async () => {
    const all = await lint(DBML);
    expect(find(all, "no-primary-key", "logs")).toHaveLength(1);
    expect(find(all, "no-primary-key", "users")).toHaveLength(0);
    expect(find(all, "duplicate-index", "orders")).toHaveLength(1);
    expect(find(all, "redundant-index", "orders").length).toBeGreaterThan(0);
    expect(find(all, "reserved-word", "orders", "order")[0]?.message).toContain("PostgreSQL");
    expect(find(all, "naming-style", "logs", "createdAt")).toHaveLength(1);
    expect(all[0].severity).toBe("error");
  });

  it("suggests missing relationships with a working fix", async () => {
    const all = await lint(DBML);
    const [missing] = find(all, "possible-missing-fk", "users", "org_id");
    expect(missing.message).toContain("organizations.id");
    expect(missing.fix?.append).toContain("org_id");
    const fixed = await lint(DBML + "\n" + missing.fix!.append + "\n");
    expect(find(fixed, "possible-missing-fk", "users", "org_id")).toHaveLength(0);
    expect(find(fixed, "fk-type-mismatch", "users", "org_id")).toHaveLength(0);
  });

  it("respects the enabled rules", async () => {
    const all = await lint(DBML, new Set(DEFAULT_RULES));
    expect(all.some((f) => f.rule === "nullable-fk")).toBe(false);
    expect(await lint(DBML, new Set())).toEqual([]);
  });
});
