import type { DiscoveredRelation, FkUsage } from "../core/tauri-api.service";
import { buildGraph, collectLinks, linkWeight } from "./graph";
import { confirmHubs, hubCandidates, neighbourCounts, quantile } from "./hubs";
import { fk, ids, link, shop } from "./modules-fixtures.spec-helper";

const end = (table: string, columns: string[]) => ({ schema: "public", table, columns });
const usage = (child: string, parent: string, calls: number): FkUsage => ({
  name: `${child}_fk`,
  from: end(child, [`${parent}_id`]),
  to: end(parent, ["id"]),
  calls,
});
const join = (a: string, aCol: string, b: string, bCol: string, calls: number): DiscoveredRelation => ({
  from: end(a, [aCol]),
  to: end(b, [bCol]),
  directed: true,
  calls,
  statements: 1,
  queries: [],
});

describe("module graph", () => {
  const tables = ids("orders", "users", "items", "audit");

  it("links declared refs once per table pair and skips self-references and unknown tables", () => {
    const refs = [fk("orders", "users"), fk("items", "orders"), { ...fk("items", "orders"), id: "dup" }, fk("users", "users"), fk("ghost", "users")];
    const { links, source } = collectLinks(tables, refs, null);
    expect(source).toBe("declared");
    expect(links).toEqual([
      { a: "public.items", b: "public.orders", declared: true, calls: 0 },
      { a: "public.orders", b: "public.users", declared: true, calls: 0 },
    ]);
  });

  it("adds the traffic: FK usage on declared links, undeclared joins as links of their own", () => {
    const report = {
      available: true,
      declaredUsage: [usage("orders", "users", 500)],
      relations: [join("audit", "order_ref", "orders", "id", 40), join("items", "orders_id", "orders", "id", 7)],
    };
    const { links, source } = collectLinks(tables, [fk("orders", "users"), fk("items", "orders")], report);
    expect(source).toBe("traffic");
    expect(links).toEqual([
      { a: "public.audit", b: "public.orders", declared: false, calls: 40 },
      // A join written into the DBML with Add Ref is still reported as discovered: its calls count.
      { a: "public.items", b: "public.orders", declared: true, calls: 7 },
      { a: "public.orders", b: "public.users", declared: true, calls: 500 },
    ]);
  });

  it("uses the declared relationships only when the report is unavailable or saw no joins", () => {
    const refs = [fk("orders", "users")];
    expect(collectLinks(tables, refs, { available: false, declaredUsage: [usage("orders", "users", 9)], relations: [] }).source).toBe("declared");
    expect(collectLinks(tables, refs, { available: true, declaredUsage: [usage("orders", "users", 0)], relations: [] }).source).toBe("declared");
  });

  it("weighs traffic on a bounded log scale on top of the structure", () => {
    const busiest = { a: "a", b: "b", declared: true, calls: 1_000_000 };
    expect(linkWeight({ ...busiest, calls: 0 }, 1_000_000, "traffic")).toBe(1);
    expect(linkWeight(busiest, 1_000_000, "traffic")).toBeCloseTo(4);
    expect(linkWeight({ ...busiest, declared: false }, 1_000_000, "traffic")).toBeCloseTo(3);
    expect(linkWeight({ ...busiest, calls: 10 }, 1_000_000, "traffic")).toBeLessThan(1.6);
    expect(linkWeight(busiest, 1_000_000, "declared")).toBe(1);
  });

  it("builds a graph over sorted ids without the excluded tables", () => {
    const g = buildGraph(ids("c", "a", "b"), [link("a", "b"), link("b", "c"), link("a", "c")], "declared", new Set(["public.c"]));
    expect(g.ids).toEqual(ids("a", "b"));
    expect(g.nbr).toEqual([[1], [0]]);
    expect(g.wt).toEqual([[1], [1]]);
  });
});

describe("common tables", () => {
  it("interpolates quantiles", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.75)).toBe(5);
  });

  it("finds the table everything references", () => {
    const { links } = shop();
    expect(hubCandidates(neighbourCounts(links))).toEqual(["public.users"]);
  });

  it("finds none in a small schema", () => {
    const links = ["a", "b", "c", "d", "e", "f", "g"].map((t) => link(t, "users"));
    expect(hubCandidates(neighbourCounts(links))).toEqual([]);
  });

  it("keeps a candidate whose links stay inside one module as that module's centre", () => {
    const near = ["x", "y", "z", "w", "v", "u"];
    const links = near.map((n) => link(n, "hub"));
    const check = (communities: number[]) => ({
      communityOf: new Map(ids(...near).map((id, i) => [id, communities[i]])),
      minSize: 2,
      weight: () => 1,
      degree: new Map([["public.hub", 4]]),
    });
    // Four of its six neighbours are one module: the candidate belongs to it.
    expect(confirmHubs(["public.hub"], links, check([0, 0, 0, 0, 1, 1]))).toEqual([]);
    // Its own children, fallen apart without it: still a centre.
    expect(confirmHubs(["public.hub"], links, check([0, 1, 2, 3, 4, 5]))).toEqual([]);
    // Three modules of two: a hub between them.
    expect(confirmHubs(["public.hub"], links, check([0, 0, 1, 1, 2, 2]))).toEqual(["public.hub"]);
  });
});
