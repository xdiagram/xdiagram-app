import { Injectable, inject } from "@angular/core";

import { TauriApi } from "../core/tauri-api.service";
import { type DbMemory, type TableMemory, parseMemory } from "../filter/memory";

/**
 * The Browse-data filters remembered per database (Rust `FilterMemory`, one JSON file per
 * database in `<app data>/filters/`): read once per database, written debounced.
 */
@Injectable({ providedIn: "root" })
export class FilterMemoryService {
  private readonly api = inject(TauriApi);
  private readonly cache = new Map<string, Promise<DbMemory>>();
  private readonly pending = new Map<string, DbMemory>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  get(dbKey: string): Promise<DbMemory> {
    let m = this.cache.get(dbKey);
    if (!m) {
      m = this.api
        .loadFilters(dbKey)
        .then(parseMemory)
        .catch((err) => {
          console.warn("Could not read the remembered filters", err);
          return parseMemory(null);
        });
      this.cache.set(dbKey, m);
    }
    return m;
  }

  async table(dbKey: string, tableId: string): Promise<TableMemory | null> {
    return (await this.get(dbKey)).tables[tableId] ?? null;
  }

  /**
   * Changes a database's memory, saved debounced. Changes chain: each one sees the ones made
   * before it, even while the file is still being read.
   */
  async update(dbKey: string, change: (m: DbMemory) => DbMemory): Promise<void> {
    const base = this.get(dbKey);
    const chained = base.then(change).catch((err) => {
      console.error("Could not change the remembered filters", err);
      return base;
    });
    this.cache.set(dbKey, chained);
    const next = await chained;
    this.pending.set(dbKey, next);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 800);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const entries = [...this.pending];
    this.pending.clear();
    await Promise.all(entries.map(([key, m]) => this.api.saveFilters(key, JSON.stringify(m)).catch((err) => console.error("Could not save the filters", err))));
  }
}
