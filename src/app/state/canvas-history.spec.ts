import { CanvasHistory, type HistoryTarget, type LayoutState } from "./canvas-history";

/** A fake editor: a version counter with its own undo stack, plus a layout. */
function fakeTarget() {
  let version = 1;
  let next = 2;
  const undone: number[] = [];
  const done: number[] = [];
  let layout: LayoutState = { positions: {}, hidden: [] };
  const target: HistoryTarget & { edit(): number; type(): void; layout(): LayoutState } = {
    applyLayout: (s) => (layout = s),
    textVersion: () => version,
    undoText: () => {
      undone.push(version);
      version = done.pop() ?? 1;
      return version;
    },
    redoText: () => {
      done.push(version);
      version = undone.pop()!;
      return version;
    },
    edit: () => {
      done.push(version);
      version = next++;
      return version;
    },
    type: () => {
      done.push(version);
      version = next++;
    },
    layout: () => layout,
  };
  return target;
}

const at = (x: number): LayoutState => ({ positions: { "public.t": { x, y: 0 } }, hidden: [] });

describe("canvas history", () => {
  it("undoes and redoes layout changes", () => {
    const h = new CanvasHistory();
    const t = fakeTarget();
    h.record({ kind: "layout", label: "Move", before: at(0), after: at(100) });
    h.record({ kind: "layout", label: "Move", before: at(100), after: at(200) });
    expect(h.undo(t).done).toBe(true);
    expect(t.layout()).toEqual(at(100));
    expect(h.undo(t).done).toBe(true);
    expect(t.layout()).toEqual(at(0));
    expect(h.undo(t).done).toBe(false);
    expect(h.redo(t).done).toBe(true);
    expect(t.layout()).toEqual(at(100));
  });

  it("undoes canvas text edits through the editor while the text is unchanged", () => {
    const h = new CanvasHistory();
    const t = fakeTarget();
    h.record({ kind: "text", label: "Rename", version: t.edit() });
    expect(h.undo(t)).toEqual({ done: true, label: "Rename" });
    expect(t.textVersion()).toBe(1);
    expect(h.redo(t).done).toBe(true);
    expect(t.textVersion()).toBe(2);
  });

  it("leaves a text edit alone once the DBML was typed over", () => {
    const h = new CanvasHistory();
    const t = fakeTarget();
    h.record({ kind: "layout", label: "Move", before: at(0), after: at(50) });
    h.record({ kind: "text", label: "Rename", version: t.edit() });
    t.type();
    const r = h.undo(t);
    expect(r.done).toBe(false);
    expect(r.message).toContain("edited since");
    expect(h.undo(t).done).toBe(true); // the move before it is still undoable
    expect(t.layout()).toEqual(at(0));
  });

  it("a new action clears redo", () => {
    const h = new CanvasHistory();
    const t = fakeTarget();
    h.record({ kind: "layout", label: "Move", before: at(0), after: at(1) });
    h.undo(t);
    h.record({ kind: "layout", label: "Move", before: at(0), after: at(2) });
    expect(h.canRedo).toBe(false);
  });
});
