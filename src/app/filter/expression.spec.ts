import { complete, parseExpression, ParseError, printExpression, SEARCH_COLUMN } from "./expression";
import type { FilterNode } from "./model";

const strip = (n: FilterNode): unknown => JSON.parse(JSON.stringify(n, (k, v) => (k === "id" ? undefined : v)));

describe("expression language", () => {
  it("parses conditions, groups and precedence", () => {
    const t = parseExpression("role = 'admin' and (created_at > -7d or email ~ \"@gmail\" cs)");
    expect(strip(t)).toEqual({
      t: "group",
      op: "and",
      items: [
        { t: "cond", column: "role", op: "eq", args: ["admin"] },
        {
          t: "group",
          op: "or",
          items: [
            { t: "cond", column: "created_at", op: "gt", args: [{ ago: 7, unit: "d" }] },
            { t: "cond", column: "email", op: "contains", args: ["@gmail"], cs: true },
          ],
        },
      ],
    });
    // "and" binds tighter than "or".
    const p = parseExpression("a = 1 or b = 2 and c = 3");
    expect(strip(p)).toMatchObject({ op: "or", items: [{ column: "a" }, { op: "and", items: [{ column: "b" }, { column: "c" }] }] });
  });

  it("reads every predicate form", () => {
    const one = (s: string) => strip(parseExpression(s).items[0]);
    expect(one("id between 1 and 5")).toEqual({ t: "cond", column: "id", op: "between", args: ["1", "5"] });
    expect(one("id in (1, 2, '3 4')")).toEqual({ t: "cond", column: "id", op: "in", args: ["1", "2", "3 4"] });
    expect(one("id not in ()")).toEqual({ t: "cond", column: "id", op: "notIn", args: [] });
    expect(one("x is not null")).toEqual({ t: "cond", column: "x", op: "notNull", args: [] });
    expect(one("x is blank")).toEqual({ t: "cond", column: "x", op: "isBlank", args: [] });
    expect(one("x ^= ab")).toEqual({ t: "cond", column: "x", op: "startsWith", args: ["ab"] });
    expect(one("x $= ab")).toEqual({ t: "cond", column: "x", op: "endsWith", args: ["ab"] });
    expect(one("x !~ ab")).toEqual({ t: "cond", column: "x", op: "notContains", args: ["ab"] });
    expect(one("x matches '^a.*z$'")).toEqual({ t: "cond", column: "x", op: "regex", args: ["^a.*z$"] });
    expect(one("at: this week")).toEqual({ t: "cond", column: "at", op: "range", args: [], span: "thisWeek" });
    expect(one("at: last 30 days")).toEqual({ t: "cond", column: "at", op: "range", args: [], span: { lastDays: 30 } });
    expect(one("at: 2026-11-14")).toEqual({ t: "cond", column: "at", op: "range", args: [], span: { day: "2026-11-14" } });
    expect(one("`weird col` = 'it\\'s'")).toEqual({ t: "cond", column: "weird col", op: "eq", args: ["it's"] });
    expect(one("`and` = 1")).toEqual({ t: "cond", column: "and", op: "eq", args: ["1"] });
    expect(one("any ~ ann")).toEqual({ t: "cond", column: SEARCH_COLUMN, op: "contains", args: ["ann"] });
    expect(strip(parseExpression("not (a = 1 or b = 2)"))).toMatchObject({ t: "group", op: "and", items: [{ op: "or", not: true }] });
    expect(parseExpression("   ").items).toEqual([]);
  });

  it("reports where it fails", () => {
    const err = (s: string) => {
      try {
        parseExpression(s);
      } catch (e) {
        return e as ParseError;
      }
      throw new Error("parsed");
    };
    expect(err("role =").message).toBe("Expected a value");
    expect(err("role admin")).toMatchObject({ from: 5 });
    expect(err("(a = 1").message).toBe("Expected “)”");
    expect(err("a = 1 b = 2").message).toContain("expected and, or");
    expect(err("and = 1").message).toContain("keyword");
    expect(err("x = 'open").message).toBe("Unclosed '");
    expect(err("at: someday").message).toContain("period");
  });

  it("prints what it parses", () => {
    const texts = [
      "role = admin and (created_at > -7d or email ~ @gmail cs)",
      "note ~ 'two words' and code = 'x)y'",
      "id between 1 and 5",
      "id in (1, 2, '3 4')",
      "x is not null or y is empty",
      "not (a = 1 or b = 2)",
      "at: this week and at: last 30 days",
      "`weird col` = 'it\\'s'",
      "x = '-7d' and y < -7d",
      "x = 'and' and `or` = 1",
      "any ~ ann",
      "x matches '^a.+$' and z $= q",
    ];
    for (const s of texts) {
      const tree = parseExpression(s);
      expect(printExpression(tree), s).toBe(s);
      expect(strip(parseExpression(printExpression(tree))), s).toEqual(strip(tree));
    }
  });

  it("leaves switched-off nodes out", () => {
    const tree = parseExpression("a = 1 and b = 2");
    tree.items[1].off = true;
    expect(printExpression(tree)).toBe("a = 1");
  });
});

describe("expression suggestions", () => {
  const ctx = {
    columns: [
      { name: "role", kind: "enum" as const, enumValues: ["admin", "member"] },
      { name: "created_at", kind: "timestamptz" as const },
      { name: "rows", kind: "int" as const },
    ],
  };
  const labels = (text: string, caret = text.length) => complete(text, caret, ctx).items.map((s) => s.label);

  it("offers columns, operators, values, periods and joins", () => {
    expect(labels("")).toEqual(["role", "created_at", "rows", "any", "not"]);
    expect(labels("r")).toEqual(["role", "rows"]);
    expect(labels("role ")).toContain("~");
    expect(labels("rows ")).not.toContain("~");
    expect(labels("created_at ")).toContain(":");
    expect(labels("role = ")).toEqual(["admin", "member"]);
    expect(labels("role = a")).toEqual(["admin"]);
    expect(labels("role in (admin, ")).toEqual(["admin", "member"]);
    expect(labels("created_at: ")).toContain("this week");
    expect(labels("role = admin ")).toEqual(["and", "or"]);
    expect(labels("role = admin and ")).toContain("created_at");
    expect(complete("role = a", 8, ctx)).toMatchObject({ from: 7, to: 8 });
  });
});
