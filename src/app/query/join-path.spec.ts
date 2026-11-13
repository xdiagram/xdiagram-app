import type { VRef } from "../diagram/view-model";
import { makeAliases, planJoins } from "./join-path";

const ref = (id: string, from: string, fromCols: string[], to: string, toCols: string[], discovered = false): VRef => ({
  id,
  name: null,
  from: { table: `public.${from}`, fields: fromCols, many: true },
  to: { table: `public.${to}`, fields: toCols, many: false },
  onDelete: null,
  onUpdate: null,
  ...(discovered ? { discovered: { calls: 1, statements: 1, directed: true, queries: [] } } : {}),
});

const REFS = [
  ref("m_u", "memberships", ["user_id"], "users", ["id"]),
  ref("m_o", "memberships", ["org_id"], "organizations", ["id"]),
  ref("pm_m", "project_members", ["org_id", "user_id"], "memberships", ["org_id", "user_id"]),
  ref("pm_p", "project_members", ["project_id"], "projects", ["id"]),
  ref("p_o", "projects", ["org_id"], "organizations", ["id"]),
  ref("e_u", "events", ["user_id"], "users", ["id"], true),
  ref("e_o", "events", ["org_id"], "organizations", ["id"], true),
];
const t = (n: string) => `public.${n}`;

describe("join paths", () => {
  it("connects chosen tables through the fewest relationships", () => {
    const plan = planJoins([t("project_members"), t("users"), t("organizations")], REFS);
    expect(plan.tables).toEqual([t("project_members"), t("memberships"), t("users"), t("organizations")]);
    expect(plan.steps.map((s) => [s.parent, s.table])).toEqual([
      [t("project_members"), t("memberships")],
      [t("memberships"), t("users")],
      [t("memberships"), t("organizations")],
    ]);
    expect(plan.steps[0].on).toEqual([["org_id", "org_id"], ["user_id", "user_id"]]);
    expect(plan.steps[1].on).toEqual([["user_id", "id"]]);
    expect(plan.unreachable).toEqual([]);
  });

  it("prefers declared relationships to discovered ones", () => {
    // users → organizations: via memberships (2 declared hops) rather than events (2 discovered hops).
    const plan = planJoins([t("users"), t("organizations")], REFS);
    expect(plan.tables).toEqual([t("users"), t("memberships"), t("organizations")]);
    expect([...plan.refIds]).toEqual(["m_u", "m_o"]);
  });

  it("reports tables no path reaches", () => {
    const plan = planJoins([t("users"), t("legacy_notes"), t("memberships")], REFS);
    expect(plan.tables).toEqual([t("users"), t("memberships")]);
    expect(plan.unreachable).toEqual([t("legacy_notes")]);
    expect(planJoins([], REFS).tables).toEqual([]);
  });

  it("makes short unique aliases", () => {
    const a = makeAliases([t("project_members"), t("projects"), t("organizations"), t("orders"), "billing.invoice_lines", t("isActive")]);
    expect([...a.values()]).toEqual(["pm", "p", "o", "o2", "il", "ia"]);
    expect(makeAliases([t("audit_sessions")]).get(t("audit_sessions"))).toBe("as_");
  });
});
