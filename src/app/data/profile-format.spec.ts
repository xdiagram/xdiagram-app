import { maskValue, percent, profileSummary } from "./profile-format";

describe("profile formatting", () => {
  it("masks personal values", () => {
    expect(maskValue("ann.lee@example.com")).toBe("a•••@example.com");
    expect(maskValue("+40 721 234 567")).toBe("+4••••••••67");
    expect(maskValue("abc")).toBe("•••");
  });

  it("formats shares and summaries", () => {
    expect(percent(0, 10)).toBe("0%");
    expect(percent(1, 3)).toBe("33%");
    expect(percent(1, 2000)).toBe("<0.1%");
    expect(percent(5, 1000)).toBe("0.5%");
    const c = { name: "e", typeName: "text", nulls: 1, nonNull: 9, distinct: 9, distinctCapped: false, unique: true, numeric: false,
      min: null, max: null, avgLength: null, maxLength: null, top: [], pii: "email", piiBasis: "values" as const };
    expect(profileSummary(c)).toBe("10% null · all distinct · personal data? (email)");
  });
});
