import { loadDbmlCore } from "../core/dbml";
import { buildViewModel } from "../diagram/view-model";
import { type DocModel, buildDocModel } from "../export/doc-model";
import { type Cell, generateSampleData, planSampleData } from "./sample-data";

const DBML = `
Enum role {
  admin
  member
  guest
}
Table users {
  id bigint [pk, increment]
  email varchar(255) [unique, not null]
  full_name varchar(120)
  role role [not null]
  is_active bool [not null]
  created_at timestamptz [not null]
  updated_at timestamptz
  manager_id bigint [ref: > users.id]
}
Table organizations {
  id int [pk, increment]
  name varchar(120) [not null]
  slug varchar(60) [not null, unique]
}
Table memberships {
  org_id int [not null, ref: > organizations.id]
  user_id bigint [not null, ref: > users.id]
  joined_at date [not null]
  Indexes { (org_id, user_id) [pk] }
}
Table projects {
  id uuid [pk]
  org_id int [not null, ref: > organizations.id]
  name varchar(200) [not null]
  budget numeric(12,2)
  starts_on date
  ends_on date
  lead_id bigint [ref: > users.id]
}
Table notes {
  id int [pk]
  body text
}
`;

let model: DocModel;
beforeAll(async () => {
  const { Parser } = await loadDbmlCore();
  const db = new Parser().parse(DBML, "dbmlv2");
  model = buildDocModel(db, buildViewModel(db), { title: "t", source: null });
});

const opts = { tables: null, rowsPerTable: 20, dialect: "postgres" as const, seed: 7 };
const col = (plan: ReturnType<typeof planSampleData>, table: string, column: string): Cell[] => {
  const tp = plan.tables.get(`public.${table}`)!;
  const i = tp.columns.indexOf(column);
  return tp.rows.map((r) => r[i]);
};

describe("sample data", () => {
  it("fills parents before children and keeps every foreign key valid", () => {
    const plan = planSampleData(model, opts);
    expect(plan.order.indexOf("public.organizations")).toBeLessThan(plan.order.indexOf("public.memberships"));
    expect(plan.order.indexOf("public.users")).toBeLessThan(plan.order.indexOf("public.memberships"));
    const userIds = new Set(col(plan, "users", "id"));
    const orgIds = new Set(col(plan, "organizations", "id"));
    expect(col(plan, "memberships", "user_id").every((v) => userIds.has(v))).toBe(true);
    expect(col(plan, "memberships", "org_id").every((v) => orgIds.has(v))).toBe(true);
    expect(col(plan, "projects", "lead_id").every((v) => v === null || userIds.has(v))).toBe(true);
    expect(col(plan, "users", "manager_id").every((v, i) => v === null || (typeof v === "number" && v <= i))).toBe(true);
  });

  it("keeps keys and unique columns unique and respects types", () => {
    const plan = planSampleData(model, opts);
    const emails = col(plan, "users", "email");
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails.every((e) => typeof e === "string" && e.length <= 255 && e.includes("@"))).toBe(true);
    const pairs = plan.tables.get("public.memberships")!.rows.map((r) => `${r[0]}|${r[1]}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(col(plan, "users", "role").every((v) => ["admin", "member", "guest"].includes(v as string))).toBe(true);
    expect(col(plan, "projects", "budget").every((v) => v === null || /^\d{1,10}\.\d{2}$/.test((v as { num: string }).num))).toBe(true);
    const starts = col(plan, "projects", "starts_on");
    col(plan, "projects", "ends_on").forEach((end, i) => {
      if (end && starts[i]) expect(end >= starts[i]!).toBe(true);
    });
  });

  it("includes required parents and is deterministic", () => {
    const plan = planSampleData(model, { ...opts, tables: ["public.memberships"] });
    expect(new Set(plan.order)).toEqual(new Set(["public.users", "public.organizations", "public.memberships"]));
    const a = generateSampleData(model, { ...opts, title: "t", now: new Date("2026-11-13") }).sql;
    const b = generateSampleData(model, { ...opts, title: "t", now: new Date("2026-11-13") }).sql;
    const c = generateSampleData(model, { ...opts, seed: 8, title: "t", now: new Date("2026-11-13") }).sql;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("writes each dialect's syntax", () => {
    const pg = generateSampleData(model, { ...opts, title: "t" }).sql;
    expect(pg).toContain('INSERT INTO "users" (');
    expect(pg).toContain("OVERRIDING SYSTEM VALUE");
    expect(pg).toContain(`SELECT setval(pg_get_serial_sequence('"users"', 'id')`);
    expect(pg).toMatch(/^BEGIN;$/m);
    const ms = generateSampleData(model, { ...opts, dialect: "mssql", title: "t" }).sql;
    expect(ms).toContain("SET IDENTITY_INSERT [users] ON;");
    expect(ms).toContain("SET IDENTITY_INSERT [users] OFF;");
    expect(ms).toMatch(/N'[^']+@example\.com'/);
    expect(ms).not.toMatch(/\bTRUE\b/);
    const my = generateSampleData(model, { ...opts, dialect: "mysql", title: "t" }).sql;
    expect(my).toContain("INSERT INTO `users` (");
    expect(my).toMatch(/^START TRANSACTION;$/m);
  });
});
