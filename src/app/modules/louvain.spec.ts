import { buildGraph } from "./graph";
import { louvain, splitDisconnected } from "./louvain";
import { ids, link } from "./modules-fixtures.spec-helper";
import type { Link } from "./types";

const clique = (names: string[]): Link[] => names.flatMap((a, i) => names.slice(i + 1).map((b) => link(a, b)));

describe("louvain", () => {
  const left = ["a1", "a2", "a3", "a4"];
  const right = ["b1", "b2", "b3", "b4"];
  const links = [...clique(left), ...clique(right), link("a1", "b1")];
  const tables = ids(...left, ...right, "lonely");

  const groupsOf = (g: { ids: string[] }, comm: number[]) => {
    const m = new Map<number, string[]>();
    g.ids.forEach((id, i) => m.set(comm[i], [...(m.get(comm[i]) ?? []), id.slice("public.".length)]));
    return [...m.values()];
  };

  it("separates two cliques joined by one link and leaves an isolated table alone", () => {
    const g = buildGraph(tables, links, "declared");
    expect(groupsOf(g, louvain(g))).toEqual([left, right, ["lonely"]]);
  });

  it("gives the same communities whatever order the input comes in", () => {
    const a = buildGraph(tables, links, "declared");
    const b = buildGraph([...tables].reverse(), [...links].reverse(), "declared");
    expect(louvain(b)).toEqual(louvain(a));
  });

  it("never moves locked tables and never merges two groups", () => {
    const g = buildGraph(tables, links, "declared");
    // a1 and b1 are one group, a2 another: both stay, although the cliques pull them apart.
    const locked = g.ids.map((id) => (id === "public.a1" || id === "public.b1" ? 0 : id === "public.a2" ? 1 : -1));
    const comm = louvain(g, { locked });
    const at = (name: string) => comm[g.index.get(`public.${name}`)!];
    expect(at("a1")).toBe(at("b1"));
    expect(at("a2")).not.toBe(at("a1"));
  });

  it("lets ungrouped tables join a group", () => {
    const g = buildGraph(tables, links, "declared");
    const locked = g.ids.map((id) => (id === "public.b1" ? 0 : -1));
    const comm = louvain(g, { locked });
    const at = (name: string) => comm[g.index.get(`public.${name}`)!];
    for (const t of ["b2", "b3", "b4"]) expect(at(t)).toBe(at("b1"));
  });

  it("finds more, smaller communities at a higher resolution", () => {
    const chain = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
    const chainLinks = chain.slice(1).map((t, i) => link(chain[i], t));
    const g = buildGraph(ids(...chain), chainLinks, "declared");
    const count = (r: number) => new Set(louvain(g, { resolution: r })).size;
    expect(count(2)).toBeGreaterThan(count(0.5));
  });

  it("splits a community into its connected parts, but keeps a group whole", () => {
    const g = buildGraph(ids("a", "b", "c", "d"), [link("a", "b"), link("c", "d")], "declared");
    expect(splitDisconnected(g, [0, 0, 0, 0], () => false)).toEqual([0, 0, 1, 1]);
    expect(splitDisconnected(g, [0, 0, 0, 0], (i) => i === 2)).toEqual([0, 0, 0, 0]);
  });
});
