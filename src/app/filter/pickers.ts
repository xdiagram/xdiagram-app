import type { ValuesResult } from "../core/tauri-api.service";
import type { SavedFilter } from "./memory";

/** The named filters of the table shown (the filter bar's "Saved" menu). */
export interface SavedSource {
  list(): Promise<SavedFilter[]>;
  /** Saves the current filter and sort under `name`; returns the new list. */
  save(name: string): Promise<SavedFilter[]>;
  remove(name: string): Promise<SavedFilter[]>;
  apply(filter: SavedFilter): void;
}

/** Where the value picker gets a column's values: (column, text to find, condition to leave out). */
export type ValueSource = (column: string, search: string, exclude: string | null) => Promise<ValuesResult>;

/** The table a foreign-key column points at (single-column keys). */
export interface FkTarget {
  tableId: string;
  key: string;
}

export interface FkRows {
  /** The column shown next to the key (null: none). */
  label: string | null;
  /** Columns that can be shown instead. */
  labels: string[];
  rows: { key: string; label: string | null }[];
  more: boolean;
}

/** Rows of the table a foreign-key column references, for picking one by its name. */
export interface FkSource {
  target(column: string): FkTarget | null;
  rows(column: string, search: string, label?: string | null): Promise<FkRows>;
  /** Remembers the column shown for the referenced table. */
  setLabel(column: string, label: string): void;
}
