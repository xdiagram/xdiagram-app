import { applyChange, diffRange } from "./text-diff";

describe("diffRange", () => {
  const roundTrip = (a: string, b: string) => {
    const change = diffRange(a, b);
    expect(change).not.toBeNull();
    expect(applyChange(a, change!)).toBe(b);
    return change!;
  };

  it("returns null for identical texts", () => {
    expect(diffRange("same", "same")).toBeNull();
  });

  it("finds an insertion at the end", () => {
    expect(roundTrip("Table a {}\n", "Table a {}\n\nRef: x > y\n")).toEqual({ start: 11, end: 11, text: "\nRef: x > y\n" });
  });

  it("finds a replacement in the middle", () => {
    expect(roundTrip('Table "users" {', 'Table "people" {')).toEqual({ start: 7, end: 12, text: "people" });
  });

  it("finds a deletion", () => {
    expect(roundTrip("abcdef", "abef")).toEqual({ start: 2, end: 4, text: "" });
  });

  it("handles repeated characters around the edit", () => {
    roundTrip("aaaa", "aaaaa");
    roundTrip("aaaaa", "aaa");
  });

  it("never splits a surrogate pair", () => {
    const change = roundTrip("x😀y", "x😃y");
    expect(change.text).toBe("😃");
  });
});
