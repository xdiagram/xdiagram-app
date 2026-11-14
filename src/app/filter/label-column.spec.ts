import type { ColKind } from "../core/tauri-api.service";
import { labelColumn } from "./label-column";

const cols = (...spec: [string, ColKind][]) => spec.map(([name, kind]) => ({ name, kind }));

describe("label column of a referenced table", () => {
  it("prefers a name-like text column", () => {
    expect(labelColumn(cols(["id", "int"], ["email", "text"], ["full_name", "text"]), ["id"])).toBe("full_name");
    expect(labelColumn(cols(["id", "int"], ["sku", "text"], ["title", "text"]), ["id"])).toBe("title");
    expect(labelColumn(cols(["id", "int"], ["notes", "text"], ["email", "text"]), ["id"])).toBe("email");
    expect(labelColumn(cols(["id", "int"], ["org_name_short", "text"], ["notes", "text"]), ["id"])).toBe("org_name_short");
  });

  it("falls back to the first text column that is not the key, else none", () => {
    expect(labelColumn(cols(["code", "text"], ["notes", "text"]), ["code"])).toBe("notes");
    expect(labelColumn(cols(["id", "int"], ["amount", "decimal"]), ["id"])).toBeNull();
    expect(labelColumn(cols(["id", "int"], ["status", "enum"]), ["id"])).toBe("status");
  });

  it("keeps a saved choice while the table has that column", () => {
    const c = cols(["id", "int"], ["name", "text"], ["city", "text"]);
    expect(labelColumn(c, ["id"], "city")).toBe("city");
    expect(labelColumn(c, ["id"], "gone")).toBe("name");
  });
});
