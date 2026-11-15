import type { ModulesDoc } from "../modules/types";
import type { SavedLayout } from "../persistence/layout.service";
import { CanvasHistory, type HistoryTarget, type LayoutState } from "./canvas-history";
import { fromSaved, normalizeLayout, renameInDoc, toSaved } from "./arrangements";

const doc: ModulesDoc = { commonAdded: [], commonRemoved: ["public.users"], common: ["public.tenants"], proposal: null, previous: null, resolution: 1 };
const mine = { "public.a": { x: 1, y: 2 } };
const mod = { "public.a": { x: 500, y: 600 } };

describe("arrangements", () => {
  it("reads a layout saved before modules existed as the user's own", () => {
    const old: SavedLayout = { positions: mine, hidden: ["public.b"], viewport: { x: 1, y: 1, scale: 1 }, detail: "keys" };
    expect(fromSaved(old)).toEqual({ arrangement: "mine", shown: { positions: mine, viewport: { x: 1, y: 1, scale: 1 } }, parked: null, modules: null });
    expect(fromSaved(null).shown).toEqual({ positions: {}, viewport: null });
  });

  it("keeps My layout in `positions` whichever arrangement is shown", () => {
    const onModules = toSaved({ arrangement: "modules", shown: { positions: mod, viewport: null }, parked: { positions: mine, viewport: null }, modules: doc }, [], "all");
    expect(onModules.positions).toEqual(mine);
    expect(onModules.arrangement).toBe("modules");
    expect(onModules.modules?.positions).toEqual(mod);
    const onMine = toSaved({ arrangement: "mine", shown: { positions: mine, viewport: null }, parked: { positions: mod, viewport: null }, modules: doc }, [], "all");
    expect(onMine.positions).toEqual(mine);
    expect(onMine.arrangement).toBeUndefined();
    expect(onMine.modules?.positions).toEqual(mod);
  });

  it("round-trips both arrangements", () => {
    const state = { arrangement: "modules" as const, shown: { positions: mod, viewport: { x: 3, y: 4, scale: 0.5 } }, parked: { positions: mine, viewport: null }, modules: doc };
    expect(fromSaved(toSaved(state, [], "all"))).toEqual(state);
  });

  it("drops a malformed Modules part instead of failing", () => {
    const bad = normalizeLayout({ positions: mine, hidden: [], arrangement: "modules", modules: { positions: mod, proposal: 42 } });
    expect(bad).toEqual({ positions: mine, hidden: [] });
    expect(normalizeLayout("nope")).toBeNull();
    expect(normalizeLayout({ hidden: "x" })).toEqual({ positions: {}, hidden: [] });
    const good = { positions: mine, hidden: [], arrangement: "modules", modules: { ...doc, positions: mod } };
    expect(normalizeLayout(good)).toEqual(good);
  });

  it("follows a table rename in the module lists", () => {
    const renamed = renameInDoc({ ...doc, commonRemoved: ["public.users", "public.x"] }, "public.users", "public.people");
    expect(renamed.commonRemoved).toEqual(["public.people", "public.x"]);
  });
});

describe("canvas history across arrangements", () => {
  const state = (arrangement?: "modules"): LayoutState => ({ positions: {}, hidden: [], arrangement });
  const target: HistoryTarget = { applyLayout: () => undefined, textVersion: () => null, undoText: () => null, redoText: () => null };

  it("forgets only the layout steps of a discarded arrangement", () => {
    const h = new CanvasHistory();
    h.record({ kind: "layout", label: "Move", before: state(), after: state() });
    h.record({ kind: "layout", label: "Move module table", before: state("modules"), after: state("modules") });
    h.record({ kind: "text", label: "Accept modules", version: 3 });
    h.forgetLayouts("modules");
    // The text step stays (it needs the editor), then the user's move.
    expect(h.undo({ ...target, textVersion: () => 3, undoText: () => 2 }).label).toBe("Accept modules");
    expect(h.undo(target).label).toBe("Move");
    expect(h.canUndo).toBe(false);
  });
});
