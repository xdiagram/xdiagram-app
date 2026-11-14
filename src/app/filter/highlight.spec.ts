import { highlightTerms, segments } from "./highlight";
import { type GroupNode, SEARCH_COLUMN } from "./model";
import { toWire } from "./wire";

const hits = (value: string, terms: string[], cs = false) =>
  segments(value, terms, cs)
    .filter((s) => s.hit)
    .map((s) => s.text);

describe("search highlighting", () => {
  it("splits a value around every match, case-insensitively by default", () => {
    expect(segments("Ana and ANNA", ["an"])).toEqual([
      { text: "An", hit: true },
      { text: "a ", hit: false },
      { text: "an", hit: true },
      { text: "d ", hit: false },
      { text: "AN", hit: true },
      { text: "NA", hit: false },
    ]);
    expect(hits("Ana and ANNA", ["an"], true)).toEqual(["an"]);
    expect(segments("plain", [])).toEqual([{ text: "plain", hit: false }]);
    expect(segments("plain", [""])).toEqual([{ text: "plain", hit: false }]);
  });

  it("prefers the longest term and never overlaps", () => {
    expect(hits("gmail.com", ["mail", "gmail"])).toEqual(["gmail"]);
    expect(hits("aaaa", ["aa"])).toEqual(["aa", "aa"]);
    expect(segments("x@y", ["@"]).map((s) => s.text).join("")).toBe("x@y");
  });

  it("collects terms from active text conditions, per column and everywhere", () => {
    const where: GroupNode = {
      t: "group",
      id: "r",
      op: "and",
      items: [
        { t: "cond", id: "s", column: SEARCH_COLUMN, op: "contains", args: ["ana"] },
        { t: "cond", id: "e", column: "email", op: "contains", args: ["gmail"] },
        { t: "cond", id: "n", column: "name", op: "startsWith", args: ["Jo"] },
        { t: "cond", id: "o", column: "role", op: "contains", args: ["admin"], off: true },
        { t: "cond", id: "g", column: "age", op: "gt", args: ["3"] },
        { t: "group", id: "x", op: "or", not: true, items: [{ t: "cond", id: "z", column: "city", op: "contains", args: ["Rome"] }] },
      ],
    };
    const t = highlightTerms(where);
    expect(t.all).toEqual(["ana"]);
    expect([...t.byColumn.entries()]).toEqual([
      ["email", ["gmail"]],
      ["name", ["Jo"]],
    ]);
    expect(highlightTerms(null)).toEqual({ all: [], byColumn: new Map() });
  });

  it("sends the search box as a search node, and nothing when it is empty", () => {
    const now = new Date(2026, 10, 14);
    const kind = () => "text" as const;
    const search = (text: string, cs?: boolean): GroupNode => ({
      t: "group",
      id: "r",
      op: "and",
      items: [{ t: "cond", id: "s", column: SEARCH_COLUMN, op: "contains", args: [text], ...(cs ? { cs } : {}) }],
    });
    expect(toWire(search("ana"), now, kind)).toEqual({ t: "group", id: "r", op: "and", items: [{ t: "search", id: "s", text: "ana" }] });
    expect(toWire(search("Ana", true), now, kind)).toEqual({ t: "group", id: "r", op: "and", items: [{ t: "search", id: "s", text: "Ana", cs: true }] });
    expect(toWire(search("  "), now, kind)).toBeNull();
  });
});
