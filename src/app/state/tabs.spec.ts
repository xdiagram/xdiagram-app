import { CanvasHistory } from "./canvas-history";
import { type Tab, sessionOf } from "./tabs.store";
import { type DocSnapshot, type Source, sourceKey, watchablePath } from "./workspace.store";

const pg: Source = { kind: "db", profileId: "p1", engine: "postgres", label: "Shop DB", detail: "" };
const file: Source = { kind: "file", path: "C:\Data\Shop.dbml", label: "Shop.dbml", detail: "" };
const pasted: Source = { kind: "file", path: "", label: "Pasted SQL", detail: "", dialect: "mysql" };

function snap(source: Source | null, dbml = "Table t { id int }"): DocSnapshot {
  return { source, dbml, baseline: dbml, positions: {}, hidden: [], detail: "all", viewport: null, layoutKey: null, activeView: null, history: new CanvasHistory() };
}

describe("tab helpers", () => {
  it("identifies sources so a source opens in one tab", () => {
    expect(sourceKey(pg)).toBe("db:p1");
    expect(sourceKey(file)).toBe("file:c:\data\shop.dbml");
    expect(sourceKey({ kind: "file", path: "", label: "Pasted SQL", detail: "" })).toBeNull();
    expect(sourceKey(null)).toBeNull();
  });

  it("only .dbml files are saved in place and watched", () => {
    expect(watchablePath(file)).toBe("C:\Data\Shop.dbml");
    expect(watchablePath({ kind: "file", path: "C:\a.sql", label: "a.sql", detail: "", dialect: "mysql" })).toBeNull();
    expect(watchablePath(pg)).toBeNull();
  });
});

describe("sessionOf", () => {
  it("lists the tabs' sources in order, the active one from the workspace", () => {
    const tabs: Tab[] = [
      { id: "a", snapshot: snap(file), pending: null },
      { id: "b", snapshot: null, pending: null }, // active: its document lives in the workspace
    ];
    expect(sessionOf(tabs, "b", pg)).toEqual({
      tabs: [
        { kind: "file", path: file.path, label: "Shop.dbml", dialect: undefined },
        { kind: "db", profileId: "p1", label: "Shop DB", engine: "postgres" },
      ],
      active: 1,
    });
  });

  it("leaves out empty tabs and pasted imports, and points at the right active entry", () => {
    const tabs: Tab[] = [
      { id: "empty", snapshot: snap(null, ""), pending: null },
      { id: "paste", snapshot: snap(pasted), pending: null },
      { id: "db", snapshot: null, pending: null },
    ];
    const s = sessionOf(tabs, "db", pg);
    expect(s.tabs.map((t) => t.label)).toEqual(["Shop DB"]);
    expect(s.active).toBe(0);
  });

  it("keeps tabs that have not loaded yet, including the active one waiting for a password", () => {
    const waiting = { kind: "db" as const, profileId: "p1", label: "Shop DB", engine: "postgres" as const };
    const later = { kind: "file" as const, path: "C:\b.dbml", label: "b.dbml" };
    const tabs: Tab[] = [
      { id: "a", snapshot: null, pending: waiting },
      { id: "b", snapshot: null, pending: later },
    ];
    expect(sessionOf(tabs, "a", null)).toEqual({ tabs: [waiting, later], active: 0 });
  });
});
