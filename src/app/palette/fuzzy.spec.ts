import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches subsequences and rejects missing characters", () => {
    expect(fuzzyMatch("usr", "users")).not.toBeNull();
    expect(fuzzyMatch("xyz", "users")).toBeNull();
    expect(fuzzyMatch("sru", "users")).toBeNull();
  });

  it("returns the matched positions", () => {
    expect(fuzzyMatch("ui", "users.id")?.positions).toEqual([0, 6]);
    expect(fuzzyMatch("email", "users.email")?.positions).toEqual([6, 7, 8, 9, 10]);
  });

  it("matches everything for an empty query", () => {
    expect(fuzzyMatch("  ", "anything")?.score).toBe(0);
  });

  it("ranks exact substrings, early and word-start matches higher", () => {
    const names = ["memberships.user_id", "users", "user_roles", "invoice_lines.unit_price"];
    const ranked = fuzzyFilter("user", names, (n) => n).map((r) => r.item);
    expect(ranked[0]).toBe("users");
    expect(ranked).toContain("memberships.user_id");
    expect(ranked.indexOf("users")).toBeLessThan(ranked.indexOf("memberships.user_id"));
  });

  it("prefers word starts for abbreviations", () => {
    const ranked = fuzzyFilter("pm", ["prompt", "project_members", "spam"], (n) => n).map((r) => r.item);
    expect(ranked[0]).toBe("project_members");
  });

  it("limits the number of results", () => {
    expect(fuzzyFilter("a", Array.from({ length: 100 }, (_, i) => `a${i}`), (n) => n, 10)).toHaveLength(10);
  });
});
