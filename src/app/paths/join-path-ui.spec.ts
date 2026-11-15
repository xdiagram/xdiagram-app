import type { JoinPath, StepVariant } from "../core/tauri-api.service";
import { chosenVariants, pathHighlight, sameRoute } from "../state/join-path.store";
import { callsText, cardinality, onText, reasonText } from "./path-bar.component";

const variant = (edge: string, extra: Partial<StepVariant> = {}): StepVariant => ({
  edge,
  forward: true,
  on: [{ from: "user_id", to: "id" }],
  leftMult: "many",
  rightMult: "one",
  kind: "declared",
  calls: 0,
  cost: 1,
  ...extra,
});

const path: JoinPath = {
  tables: ["public.orders", "public.users", "public.teams"],
  steps: [
    { left: "public.orders", right: "public.users", variants: [variant("created_by"), variant("updated_by")] },
    {
      left: "public.users",
      right: "public.teams",
      variants: [variant("t_u", { forward: false, on: [{ from: "id", to: "owner_id" }], leftMult: "one", rightMult: "many" })],
    },
  ],
  cost: 2,
  hops: 2,
};

describe("join path mode", () => {
  it("lights the path's tables and the edges of the chosen variants", () => {
    expect(chosenVariants(path, []).map((v) => v.edge)).toEqual(["created_by", "t_u"]);
    expect(chosenVariants(path, [1, 5]).map((v) => v.edge)).toEqual(["updated_by", "t_u"]);
    const h = pathHighlight(path, [1]);
    expect([...h.tables]).toEqual(path.tables);
    expect([...h.refs]).toEqual(["updated_by", "t_u"]);
  });

  it("keeps showing the same route after a new search", () => {
    const other = { ...path, tables: ["public.orders", "public.teams"] };
    expect(sameRoute([other, { ...path, cost: 9 }], path)).toBe(1);
    expect(sameRoute([other], path)).toBe(-1);
    expect(sameRoute([other], null)).toBe(-1);
  });

  it("writes each join from its referencing side, with its cardinality", () => {
    const [first, second] = chosenVariants(path, []);
    expect(cardinality(first)).toBe("N:1");
    expect(onText(first, "public.orders", "public.users")).toBe("orders.user_id = users.id");
    // Walked against the foreign key: still teams.owner_id = users.id.
    expect(cardinality(second)).toBe("1:N");
    expect(onText(second, "public.users", "public.teams")).toBe("teams.owner_id = users.id");
    const composite = variant("c", { on: [{ from: "a", to: "x" }, { from: "b", to: "y" }], leftMult: "unknown" });
    expect(onText(composite, "s.l", "s.r")).toBe("s.l.a = s.r.x and s.l.b = s.r.y");
    expect(cardinality(composite)).toBe("?:1");
  });

  it("says why there is no path", () => {
    expect(reasonText({ kind: "notConnected" }, "public.orders", "public.audit")).toBe("orders and audit are not connected by any relationship.");
    expect(reasonText({ kind: "tooLong", hops: 8 }, "a", "b")).toBe("The shortest path needs 8 joins (the limit is 6).");
    expect(callsText(950)).toBe("950");
    expect(callsText(1234)).toBe("1.2k");
    expect(callsText(2_500_000)).toBe("2.5M");
  });
});
