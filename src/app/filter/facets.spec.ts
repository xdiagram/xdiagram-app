import { facetSelection, setFacet } from "./facets";
import type { GroupNode } from "./model";
import { parseExpression, printExpression } from "./expression";

const root = (text: string): GroupNode => parseExpression(text);

describe("facets", () => {
  it("reads what a column's condition ticks", () => {
    expect(facetSelection(root("role = admin and id > 3"), "role")).toMatchObject({ values: ["admin"], nul: false });
    expect(facetSelection(root("role in (admin, guest)"), "role")).toMatchObject({ values: ["admin", "guest"], nul: false });
    expect(facetSelection(root("id > 0 and (role = admin or role is null)"), "role")).toMatchObject({ values: ["admin"], nul: true });
    // Another kind of condition on the column: nothing ticked, but it is there (ticking replaces it).
    const other = facetSelection(root("login_count > 5"), "login_count");
    expect(other.values).toEqual([]);
    expect(other.node).not.toBeNull();
    expect(facetSelection(root("id > 3"), "role")).toEqual({ values: [], nul: false, node: null });
  });

  it("sets the column's condition from the ticks, keeping the others", () => {
    const base = root("id > 3 and role = admin");
    expect(printExpression(setFacet(base, "role", ["admin", "guest"], false))).toBe("id > 3 and role in (admin, guest)");
    expect(printExpression(setFacet(base, "role", ["guest"], true))).toBe("id > 3 and (role = guest or role is null)");
    expect(printExpression(setFacet(base, "role", [], true))).toBe("id > 3 and role is null");
    expect(printExpression(setFacet(base, "role", [], false))).toBe("id > 3");
    const round = setFacet(base, "role", ["a", "b"], true);
    expect(facetSelection(round, "role")).toMatchObject({ values: ["a", "b"], nul: true });
  });
});
