import type { ValuesResult } from "../core/tauri-api.service";

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
