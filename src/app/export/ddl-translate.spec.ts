import { translateExpr } from "./ddl-translate";
import { exportDdl, fixIdentityTypes } from "./sql-ddl";

const PG_DBML = `
Table organizations {
  id int4 [pk]
  slug text [unique]
}
Table billing.invoices {
  id uuid [pk, default: \`gen_random_uuid()\`]
  org_id int4 [not null]
  amount numeric(10,2) [check: \`amount >= (0)::numeric\`]
  paid bool [default: true]
  tags "text[]" [default: \`ARRAY['new',  'trial']\`]
  meta jsonb [default: \`{}\`]
  created timestamptz [default: \`now()\`]
  Indexes {
    \`lower(slug::text)\` [name: 'expr_idx']
  }
}
Ref: billing.invoices.org_id > organizations.id [update: restrict]
`;

const opts = (source: "postgres" | "mssql" | null = "postgres") => ({ source, title: "t", origin: null });

describe("cross-dialect DDL translation", () => {
  it("translates expressions", () => {
    expect(translateExpr("now()", "postgres", "mssql")).toBe("SYSDATETIME()");
    expect(translateExpr("SYSUTCDATETIME()", "mssql", "postgres")).toBe("now()");
    expect(translateExpr("gen_random_uuid()", "postgres", "mysql")).toBe("UUID()");
    expect(translateExpr("amount >= (0)::numeric", "postgres", "mysql")).toBe("amount >= (0)");
    expect(translateExpr("([amount]>=(0))", "mssql", "postgres")).toBe("(amount>=(0))");
    expect(translateExpr("ARRAY['a', 'b''c']", "postgres", "mssql", true)).toBe(`'["a","b''c"]'`);
    expect(translateExpr("{}", "postgres", "mysql")).toBe("'{}'");
    expect(translateExpr("nextval('s'::regclass)", "postgres", "mysql")).toBeNull();
    expect(translateExpr("now()", "postgres", "postgres")).toBe("now()");
  });

  it("adapts a PostgreSQL schema for SQL Server", async () => {
    const { sql } = await exportDdl(PG_DBML, "mssql", opts());
    expect(sql).toContain("DEFAULT (NEWID())");
    expect(sql).toContain("CHECK (amount >= (0))");
    expect(sql).toMatch(/\[paid\] bit DEFAULT \(?1\)?[,\n]/);
    expect(sql).toMatch(/\[tags\] nvarchar\(max\) DEFAULT \('\["new","trial"\]'\)/);
    expect(sql).toMatch(/\[slug\] nvarchar\(450\)/);
    expect(sql).toContain("SYSDATETIME()");
    expect(sql).not.toMatch(/RESTRICT/i);
    expect(sql).not.toContain("expr_idx\n");
    expect(sql).toMatch(/Left out[\s\S]*expr_idx/);
  });

  it("names the default schema for MySQL and fixes bare {} defaults everywhere", async () => {
    const my = await exportDdl(PG_DBML, "mysql", opts());
    expect(my.sql).toContain("CREATE SCHEMA `main`");
    expect(my.sql).toMatch(/REFERENCES `main`\.`organizations`/);
    expect(my.sql).toMatch(/`slug` varchar\(255\)/);
    const pg = await exportDdl(PG_DBML, "postgres", opts());
    expect(pg.sql).toContain(`DEFAULT ('{}')`);
    expect(pg.sql).toContain("gen_random_uuid()");
  });

  it("repairs SQL Server IDENTITY types from the importer", () => {
    expect(fixIdentityTypes('Table a {\n  "id" "BIGINT IDENTITY(1,1)" [pk]\n  "n" "INT IDENTITY(1, 1)"\n}')).toBe(
      'Table a {\n  "id" BIGINT [increment, pk]\n  "n" INT [increment]\n}',
    );
  });
});
