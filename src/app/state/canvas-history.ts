import type { Point } from "../persistence/layout.service";

/** Table positions and visibility: what layout actions change. */
export interface LayoutState {
  positions: Record<string, Point>;
  hidden: string[];
}

export type HistoryEntry =
  | { kind: "layout"; label: string; before: LayoutState; after: LayoutState }
  /**
   * A DBML edit made from the canvas or a panel. `version` is the editor model's alternative
   * version id right after the edit; `undoneVersion` the id after it was undone.
   */
  | { kind: "text"; label: string; version: number; undoneVersion?: number };

/** How the history reaches the workspace and the editor. */
export interface HistoryTarget {
  applyLayout(state: LayoutState): void;
  /** Current alternative version id of the editor model (null without an editor). */
  textVersion(): number | null;
  /** Undoes / redoes one text step in the editor; returns the version id afterwards. */
  undoText(): number | null;
  redoText(): number | null;
}

export interface HistoryResult {
  done: boolean;
  label?: string;
  message?: string;
}

const LIMIT = 200;

/**
 * Undo/redo for actions taken on the canvas: moving, arranging, hiding tables (layout, which the
 * DBML does not hold) and DBML edits made from the canvas or panels (rename, colour, add Ref…).
 * Text edits go through the editor's own undo, but only while the text is exactly as the edit
 * left it; if it was typed over since, that step belongs to the editor's history instead.
 */
export class CanvasHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  record(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  undo(target: HistoryTarget): HistoryResult {
    const entry = this.undoStack.pop();
    if (!entry) return { done: false };
    if (entry.kind === "layout") {
      target.applyLayout(entry.before);
      this.redoStack.push(entry);
      return { done: true, label: entry.label };
    }
    if (target.textVersion() !== entry.version) {
      return { done: false, label: entry.label, message: "The DBML was edited since; undo that in the editor" };
    }
    const undoneVersion = target.undoText();
    this.redoStack.push({ ...entry, undoneVersion: undoneVersion ?? undefined });
    return { done: true, label: entry.label };
  }

  redo(target: HistoryTarget): HistoryResult {
    const entry = this.redoStack.pop();
    if (!entry) return { done: false };
    if (entry.kind === "layout") {
      target.applyLayout(entry.after);
      this.undoStack.push(entry);
      return { done: true, label: entry.label };
    }
    if (entry.undoneVersion === undefined || target.textVersion() !== entry.undoneVersion) {
      return { done: false, label: entry.label, message: "The DBML was edited since; redo that in the editor" };
    }
    const version = target.redoText();
    this.undoStack.push({ kind: "text", label: entry.label, version: version ?? entry.version });
    return { done: true, label: entry.label };
  }
}
