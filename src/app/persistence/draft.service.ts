import { Injectable, inject } from "@angular/core";

import { TauriApi } from "../core/tauri-api.service";

/**
 * A database tab's DBML as the user left it, kept per database (Rust `drafts.rs`), so edits on
 * a database tab (header colours, saved views, groups, notes, added refs) survive Refresh and
 * restarts. `baseline` is the DBML the database gave when it was last read: comparing it with
 * a fresh read shows what changed in the database, and it is the base of the three-way merge.
 */
export interface DbDraft {
  baseline: string;
  dbml: string;
}

/** On disk; `dbml` is null when it equals the baseline (no edits), halving the file. */
interface StoredDraft {
  v: 1;
  baseline: string;
  dbml: string | null;
  savedAt: string;
}

@Injectable({ providedIn: "root" })
export class DraftService {
  private readonly api = inject(TauriApi);
  private readonly pending = new Map<string, DbDraft>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  async load(key: string): Promise<DbDraft | null> {
    const queued = this.pending.get(key);
    if (queued) return { ...queued };
    try {
      const raw = await this.api.loadDraft(key);
      if (!raw) return null;
      const d = JSON.parse(raw) as Partial<StoredDraft>;
      if (typeof d.baseline !== "string") return null;
      return { baseline: d.baseline, dbml: typeof d.dbml === "string" ? d.dbml : d.baseline };
    } catch (err) {
      console.warn("Could not read the saved DBML of this database", err);
      return null;
    }
  }

  /** Debounced: typing fires this on every change. */
  save(key: string, draft: DbDraft): void {
    this.pending.set(key, { ...draft });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1000);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const entries = [...this.pending];
    this.pending.clear();
    await Promise.all(
      entries.map(([key, d]) => {
        const stored: StoredDraft = { v: 1, baseline: d.baseline, dbml: d.dbml === d.baseline ? null : d.dbml, savedAt: new Date().toISOString() };
        return this.api.saveDraft(key, JSON.stringify(stored)).catch((err) => console.error("Could not save the DBML of this database", err));
      }),
    );
  }
}
