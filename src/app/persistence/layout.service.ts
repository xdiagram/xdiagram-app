import { Injectable } from "@angular/core";
import { LazyStore } from "@tauri-apps/plugin-store";

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/** Everything about how a diagram looks that is not in the DBML itself. */
export interface SavedLayout {
  /** Table id (`schema.table`) → top-left position in diagram coordinates. */
  positions: Record<string, Point>;
  hidden: string[];
  viewport?: Viewport;
  /** "all" | "keys" | "names" — how much of each table is drawn. */
  detail?: "all" | "keys" | "names";
}

/** Diagram layouts in `layouts.json`, keyed by database identity or file path. */
@Injectable({ providedIn: "root" })
export class LayoutService {
  private readonly store = new LazyStore("layouts.json", { autoSave: false, defaults: {} });
  private pending = new Map<string, SavedLayout>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  async load(key: string): Promise<SavedLayout | null> {
    const queued = this.pending.get(key);
    if (queued) return structuredClone(queued);
    try {
      return (await this.store.get<SavedLayout>(key)) ?? null;
    } catch {
      return null;
    }
  }

  /** Debounced: dragging a table fires this many times. */
  save(key: string, layout: SavedLayout): void {
    this.pending.set(key, structuredClone(layout));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 600);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const entries = [...this.pending];
    this.pending.clear();
    try {
      for (const [key, layout] of entries) await this.store.set(key, layout);
      await this.store.save();
    } catch (err) {
      console.error("Failed to save layout", err);
    }
  }
}
