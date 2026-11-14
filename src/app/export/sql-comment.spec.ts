import { sqlComment } from "./sql-comment";

describe("sqlComment", () => {
  it("prefixes a single line", () => {
    expect(sqlComment("Sample data for shop")).toBe("-- Sample data for shop");
  });

  it("comments every line, whatever the line break", () => {
    expect(sqlComment('a\nDROP TABLE "users";\r\nb\rc')).toBe('-- a\n-- DROP TABLE "users";\n-- b\n-- c');
  });

  it("never leaves a line without the comment marker", () => {
    const lines = sqlComment("x\n\n  y\r\n").split("\n");
    expect(lines.every((l) => l.startsWith("-- "))).toBe(true);
  });
});
