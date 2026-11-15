import type { ModulesDoc, ModuleProposal } from "../modules/types";
import type { Point, SavedLayout, Viewport } from "../persistence/layout.service";

/** "mine": the user's own positions. "modules": the arrangement Find modules made. */
export type Arrangement = "mine" | "modules";

/** One arrangement's table positions and where it was last looked at. */
export interface Placement {
  positions: Record<string, Point>;
  viewport: Viewport | null;
}

/** A document's two arrangements while it is open: the shown one and the other one. */
export interface ArrangementState {
  arrangement: Arrangement;
  shown: Placement;
  /** My layout while Modules is shown; the Modules positions (if any) while My layout is. */
  parked: Placement | null;
  modules: ModulesDoc | null;
}

/** Reads a saved layout: My layout is always `positions`, so older files and app versions agree. */
export function fromSaved(saved: SavedLayout | null): ArrangementState {
  const mine: Placement = { positions: saved?.positions ?? {}, viewport: saved?.viewport ?? null };
  const m = saved?.modules;
  if (!m) return { arrangement: "mine", shown: mine, parked: null, modules: null };
  const { positions, viewport, ...doc } = m;
  const modules: Placement = { positions, viewport: viewport ?? null };
  return saved?.arrangement === "modules"
    ? { arrangement: "modules", shown: modules, parked: mine, modules: doc }
    : { arrangement: "mine", shown: mine, parked: modules, modules: doc };
}

export function toSaved(state: ArrangementState, hidden: string[], detail: SavedLayout["detail"]): SavedLayout {
  const onModules = state.arrangement === "modules";
  const mine = onModules ? state.parked : state.shown;
  const modules = onModules ? state.shown : state.parked;
  const layout: SavedLayout = { positions: mine?.positions ?? {}, hidden, viewport: mine?.viewport ?? undefined, detail };
  if (state.modules && modules) {
    layout.modules = { ...state.modules, positions: modules.positions, viewport: modules.viewport ?? undefined };
    if (onModules) layout.arrangement = "modules";
  }
  return layout;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function isProposal(v: unknown): v is ModuleProposal {
  return (
    isObject(v) &&
    Array.isArray(v["modules"]) &&
    v["modules"].every((m) => isObject(m) && typeof m["name"] === "string" && isStrings(m["tables"])) &&
    isStrings(v["common"]) &&
    isStrings(v["other"])
  );
}

/** Drops a malformed Modules part (hand-edited or from a newer version) instead of failing to open. */
export function normalizeLayout(raw: unknown): SavedLayout | null {
  if (!isObject(raw)) return null;
  const layout = { ...raw } as unknown as SavedLayout;
  if (!isObject(layout.positions)) layout.positions = {};
  if (!isStrings(layout.hidden)) layout.hidden = [];
  const m = raw["modules"];
  const valid =
    isObject(m) &&
    isObject(m["positions"]) &&
    isStrings(m["commonAdded"]) &&
    isStrings(m["commonRemoved"]) &&
    isStrings(m["common"]) &&
    (m["proposal"] === null || isProposal(m["proposal"])) &&
    typeof m["resolution"] === "number";
  if (!valid) {
    delete layout.modules;
    delete layout.arrangement;
  } else if (layout.arrangement !== "modules") delete layout.arrangement;
  return layout;
}

/** Follows a table rename in the module lists (the positions keep both ids, see `renameTableId`). */
export function renameInDoc(doc: ModulesDoc, oldId: string, newId: string): ModulesDoc {
  const r = (list: string[]) => list.map((t) => (t === oldId ? newId : t));
  const p = doc.proposal;
  return {
    ...doc,
    commonAdded: r(doc.commonAdded),
    commonRemoved: r(doc.commonRemoved),
    common: r(doc.common),
    proposal: p && {
      ...p,
      modules: p.modules.map((m) => ({ ...m, tables: r(m.tables), central: m.central === oldId ? newId : m.central })),
      common: r(p.common),
      detected: r(p.detected),
      other: r(p.other),
      moves: p.moves.map((mv) => (mv.table === oldId ? { ...mv, table: newId } : mv)),
    },
  };
}
