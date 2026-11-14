import type { ColKind } from "../core/tauri-api.service";
import { kindOf } from "./kinds";
import type { CondNode, FilterNode, GroupNode } from "./model";
import { opsFor } from "./operators";
import { condLabel, nodeText } from "./printer";
import { parseQuick, printQuick } from "./quick-syntax";
import { formatMoment, parsePoint, resolvePoint, resolveSpan } from "./relative-dates";
import { addNode, emptyRoot, fromEquality, hasActive, removeNode, setColumnFilter, toggleOff, topConds, withoutNav } from "./tree";
import { checkValue, isTimestamp } from "./validate";
import { toWire, wireKey } from "./wire";

const cond = (n: FilterNode | null) => n as CondNode;
const strip = (n: FilterNode | null): unknown => JSON.parse(JSON.stringify(n, (k, v) => (k === "id" ? undefined : v)));

describe("column kinds and operators", () => {
  it("uses Rust's kind, else guesses from the type", () => {
    expect(kindOf({ typeName: "whatever", kind: "uuid" })).toBe("uuid");
    expect(kindOf({ typeName: "character varying(20)" }, "postgres")).toBe("text");
    expect(kindOf({ typeName: "int(11) unsigned" }, "mysql")).toBe("int");
    expect(kindOf({ typeName: "enum('a','b')" }, "mysql")).toBe("enum");
    expect(kindOf({ typeName: "integer[]" }, "postgres")).toBe("other");
  });

  it("offers operators that fit the column", () => {
    const ops = (k: ColKind, e: Parameters<typeof opsFor>[1] = "postgres", nullable = true) => opsFor(k, e, nullable).map((o) => o.op);
    expect(ops("int")).toContain("between");
    expect(ops("int")).not.toContain("contains");
    expect(ops("text")).toContain("regex");
    expect(ops("text", "mssql")).not.toContain("regex");
    expect(ops("bool")).toEqual(["eq", "ne", "isNull", "notNull"]);
    expect(ops("int", "postgres", false)).not.toContain("isNull");
    expect(ops("other", "mysql")).not.toContain("lt");
  });
});

describe("value checks (same rules as Rust)", () => {
  it("accepts and rejects", () => {
    expect(checkValue("int", " 42 ")).toBeNull();
    expect(checkValue("int", "4.2")).toContain("whole number");
    expect(checkValue("decimal", "1e5")).toContain("number");
    expect(checkValue("float", "1e5")).toBeNull();
    expect(checkValue("bool", "Yes")).toBeNull();
    expect(checkValue("date", "2023-02-29")).toContain("date");
    expect(checkValue("date", "2024-02-29")).toBeNull();
    expect(checkValue("timestamp", "2026-11-14 10:00")).toBeNull();
    expect(checkValue("timestamp", "2026-11-14T10:00:00+01:00")).toContain("date and time");
    expect(checkValue("timestamptz", "2026-11-14T10:00:00+01:00")).toBeNull();
    expect(checkValue("uuid", "nope")).toContain("UUID");
    expect(checkValue("binary", "0x0a1")).toContain("hex");
    expect(checkValue("text", "anything at all")).toBeNull();
    expect(isTimestamp("2026-11-14 25:00")).toBe(false);
  });
});

describe("relative dates", () => {
  // Saturday 14 November 2026, 15:30 local time.
  const now = new Date(2026, 10, 14, 15, 30, 0);

  it("resolves periods to [from, to) local bounds", () => {
    expect(resolveSpan("today", now, "date")).toEqual(["2026-11-14", "2026-11-15"]);
    expect(resolveSpan("yesterday", now, "timestamp")).toEqual(["2026-11-13 00:00:00", "2026-11-14 00:00:00"]);
    expect(resolveSpan("thisWeek", now, "date")).toEqual(["2026-11-09", "2026-11-16"]);
    expect(resolveSpan("thisMonth", now, "date")).toEqual(["2026-11-01", "2026-12-01"]);
    expect(resolveSpan("thisYear", now, "date")).toEqual(["2026-01-01", "2027-01-01"]);
    expect(resolveSpan({ lastDays: 7 }, now, "date")).toEqual(["2026-11-08", "2026-11-15"]);
    expect(resolveSpan({ day: "2026-12-31" }, now, "date")).toEqual(["2026-12-31", "2027-01-01"]);
    // A Sunday belongs to the week that started on the Monday before.
    expect(resolveSpan("thisWeek", new Date(2026, 10, 15, 9), "date")).toEqual(["2026-11-09", "2026-11-16"]);
    // Year boundary.
    expect(resolveSpan("thisWeek", new Date(2027, 0, 1, 9), "date")).toEqual(["2026-12-28", "2027-01-04"]);
  });

  it("formats with an offset for zoned timestamps", () => {
    const off = -now.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
    const mm = String(Math.abs(off) % 60).padStart(2, "0");
    expect(formatMoment(now, "timestamptz")).toBe(`2026-11-14T15:30:00${sign}${hh}:${mm}`);
  });

  it("parses and resolves relative points", () => {
    expect(parsePoint("-7d")).toEqual({ ago: 7, unit: "d" });
    expect(parsePoint("-1mo")).toEqual({ ago: 1, unit: "mo" });
    expect(parsePoint("7d")).toBeNull();
    expect(resolvePoint({ ago: 7, unit: "d" }, now, "timestamp")).toBe("2026-11-07 15:30:00");
    expect(resolvePoint({ ago: 2, unit: "h" }, now, "timestamp")).toBe("2026-11-14 13:30:00");
  });
});

describe("quick syntax", () => {
  const q = (text: string, kind: ColKind = "int") => strip(parseQuick(text, "c", kind));

  it("reads the box syntax", () => {
    expect(parseQuick("  ", "c", "int")).toBeNull();
    expect(q("5")).toEqual({ t: "cond", column: "c", op: "eq", args: ["5"] });
    expect(q(">=5")).toEqual({ t: "cond", column: "c", op: "ge", args: ["5"] });
    expect(q("!=x", "text")).toEqual({ t: "cond", column: "c", op: "ne", args: ["x"] });
    expect(q("10..20")).toEqual({ t: "cond", column: "c", op: "between", args: ["10", "20"] });
    expect(q("1.5..")).toEqual({ t: "cond", column: "c", op: "ge", args: ["1.5"] });
    expect(q("..20")).toEqual({ t: "cond", column: "c", op: "le", args: ["20"] });
    expect(q("~gmail", "text")).toEqual({ t: "cond", column: "c", op: "contains", args: ["gmail"] });
    expect(q("!~x", "text")).toEqual({ t: "cond", column: "c", op: "notContains", args: ["x"] });
    expect(q("^ab", "text")).toEqual({ t: "cond", column: "c", op: "startsWith", args: ["ab"] });
    expect(q("ab*", "text")).toEqual({ t: "cond", column: "c", op: "startsWith", args: ["ab"] });
    expect(q("*ab", "text")).toEqual({ t: "cond", column: "c", op: "endsWith", args: ["ab"] });
    expect(q("/^a.+z$/", "text")).toEqual({ t: "cond", column: "c", op: "regex", args: ["^a.+z$"] });
    expect(q("NULL")).toEqual({ t: "cond", column: "c", op: "isNull", args: [] });
    expect(q("!null")).toEqual({ t: "cond", column: "c", op: "notNull", args: [] });
    expect(q('"NULL"', "text")).toEqual({ t: "cond", column: "c", op: "eq", args: ["NULL"] });
    expect(q('">5"', "text")).toEqual({ t: "cond", column: "c", op: "eq", args: [">5"] });
    expect(q("''", "text")).toEqual({ t: "cond", column: "c", op: "isEmpty", args: [] });
  });

  it("reads lists, but not in text columns", () => {
    expect(q("1,2,3")).toEqual({ t: "cond", column: "c", op: "in", args: ["1", "2", "3"] });
    expect(q("!1,2")).toEqual({ t: "cond", column: "c", op: "notIn", args: ["1", "2"] });
    expect(q("1,null")).toEqual({
      t: "group",
      op: "or",
      items: [
        { t: "cond", column: "c", op: "in", args: ["1"] },
        { t: "cond", column: "c", op: "isNull", args: [] },
      ],
    });
    expect(q("a,b", "text")).toEqual({ t: "cond", column: "c", op: "eq", args: ["a,b"] });
  });

  it("reads periods and relative moments on date columns", () => {
    expect(q("today", "timestamp")).toEqual({ t: "cond", column: "c", op: "range", args: [], span: "today" });
    expect(q("This Week", "date")).toEqual({ t: "cond", column: "c", op: "range", args: [], span: "thisWeek" });
    expect(q("last 30 days", "date")).toEqual({ t: "cond", column: "c", op: "range", args: [], span: { lastDays: 30 } });
    expect(q(">-7d", "timestamptz")).toEqual({ t: "cond", column: "c", op: "gt", args: [{ ago: 7, unit: "d" }] });
    expect(q("2026-11-14", "timestamp")).toEqual({ t: "cond", column: "c", op: "range", args: [], span: { day: "2026-11-14" } });
    expect(q("2026-11-14", "date")).toEqual({ t: "cond", column: "c", op: "eq", args: ["2026-11-14"] });
    expect(q("-7d", "text")).toEqual({ t: "cond", column: "c", op: "eq", args: ["-7d"] });
  });

  it("prints back what it reads", () => {
    const texts: [string, ColKind][] = [
      ["5", "int"],
      [">=5", "int"],
      ["!=x", "text"],
      ["10..20", "int"],
      ["~gmail", "text"],
      ["!~x", "text"],
      ["^ab", "text"],
      ["*ab", "text"],
      ["/re/", "text"],
      ["null", "int"],
      ["!null", "int"],
      ['"NULL"', "text"],
      ["''", "text"],
      ["1,2,3", "int"],
      ["!1,2", "int"],
      ["1,null", "int"],
      ["today", "timestamp"],
      ["last7d", "date"],
      [">-7d", "timestamp"],
      ["2026-11-14", "timestamp"],
    ];
    for (const [text, kind] of texts) {
      const node = parseQuick(text, "c", kind);
      expect(printQuick(node!), `${text} (${kind})`).toBe(text);
      expect(strip(parseQuick(printQuick(node!)!, "c", kind)), text).toEqual(strip(node));
    }
    expect(printQuick({ t: "cond", id: "x", column: "c", op: "contains", args: ["a"], cs: true })).toBeNull();
  });
});

describe("tree edits", () => {
  it("adds, replaces per column, switches off and removes", () => {
    let root = fromEquality([
      { column: "org_id", value: "7" },
      { column: "deleted_at", value: null },
    ], "nav");
    expect(root.items.map((i) => cond(i).op)).toEqual(["eq", "isNull"]);
    expect(withoutNav(root).items).toEqual([]);
    root = setColumnFilter(root, "org_id", parseQuick(">5", "org_id", "int"));
    expect(topConds(root, "org_id").map((c) => c.op)).toEqual(["gt"]);
    root = setColumnFilter(root, "role", parseQuick("1,null", "role", "int"));
    expect(root.items).toHaveLength(3);
    root = setColumnFilter(root, "role", null);
    expect(root.items).toHaveLength(2);
    const id = root.items[0].id;
    root = toggleOff(root, id);
    expect(root.items[0].off).toBe(true);
    root = removeNode(root, id);
    expect(root.items).toHaveLength(1);
    const group: GroupNode = { t: "group", id: "g", op: "or", items: [{ t: "cond", id: "a", column: "x", op: "isNull", args: [] }] };
    root = addNode(root, group);
    root = removeNode(root, "a");
    expect(root.items.some((i) => i.id === "g")).toBe(false);
    expect(hasActive(emptyRoot())).toBe(false);
    expect(hasActive(root)).toBe(true);
  });
});

describe("wire form", () => {
  const now = new Date(2026, 10, 14, 15, 30);
  const kinds: Record<string, ColKind> = { at: "timestamp", day: "date", n: "int" };
  const kindOfColumn = (c: string) => kinds[c] ?? "text";

  it("drops switched-off nodes and resolves dates", () => {
    const root: GroupNode = {
      t: "group",
      id: "r",
      op: "and",
      items: [
        { t: "cond", id: "a", column: "at", op: "range", args: [], span: "today" },
        { t: "cond", id: "b", column: "n", op: "eq", args: ["1"], off: true },
        { t: "cond", id: "c", column: "at", op: "gt", args: [{ ago: 1, unit: "d" }] },
        { t: "cond", id: "d", column: "at", op: "between", args: ["2026-11-01", "2026-11-14"] },
        { t: "group", id: "e", op: "or", items: [{ t: "cond", id: "f", column: "n", op: "eq", args: ["2"], off: true }] },
      ],
    };
    expect(toWire(root, now, kindOfColumn)).toEqual({
      t: "group",
      id: "r",
      op: "and",
      items: [
        { t: "cond", id: "a", column: "at", op: "range", args: ["2026-11-14 00:00:00", "2026-11-15 00:00:00"] },
        { t: "cond", id: "c", column: "at", op: "gt", args: ["2026-11-13 15:30:00"] },
        { t: "cond", id: "d", column: "at", op: "range", args: ["2026-11-01 00:00:00", "2026-11-15 00:00:00"] },
      ],
    });
    expect(toWire(emptyRoot(), now, kindOfColumn)).toBeNull();
    expect(wireKey(toWire(root, now, kindOfColumn))).not.toContain('"id"');
  });
});

describe("labels", () => {
  it("reads like a sentence", () => {
    expect(condLabel({ t: "cond", id: "a", column: "n", op: "between", args: ["1", "5"] })).toEqual({ column: "n", op: "between", value: "1 and 5" });
    expect(condLabel({ t: "cond", id: "a", column: "at", op: "range", args: [], span: { lastDays: 7 } })).toEqual({ column: "at", op: "", value: "last 7 days" });
    expect(nodeText(parseQuick("1,null", "n", "int")!)).toBe("n in 1 or n is null");
    expect(nodeText({ t: "cond", id: "a", column: "at", op: "gt", args: [{ ago: 7, unit: "d" }] })).toBe("at > 7 days ago");
  });
});
