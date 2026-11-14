import { toCsv, toJson } from "./rows-export";

describe("row export", () => {
  it("writes RFC 4180 CSV", () => {
    const csv = toCsv(["id", "note"], [
      ["1", "plain"],
      ["2", 'say "hi", twice'],
      ["3", "two\nlines"],
      ["4", null],
      ["5", ""],
      ["6", " padded "],
      ["7", "ünïcode ✓"],
    ]);
    expect(csv).toBe(
      'id,note\r\n1,plain\r\n2,"say ""hi"", twice"\r\n3,"two\nlines"\r\n4,\r\n5,""\r\n6," padded "\r\n7,ünïcode ✓\r\n',
    );
  });

  it("quotes header names that need it", () => {
    expect(toCsv(["a,b", 'c"d'], [])).toBe('"a,b","c""d"\r\n');
  });

  it("writes JSON objects, NULL as null", () => {
    expect(JSON.parse(toJson(["id", "name"], [["1", "Ann"], ["2", null]]))).toEqual([
      { id: "1", name: "Ann" },
      { id: "2", name: null },
    ]);
    expect(toJson(["id"], [])).toBe("[]\n");
  });
});
