import { Injectable, computed, inject } from "@angular/core";

import { TauriApi, errorMessage } from "../core/tauri-api.service";
import { WorkspaceStore } from "../state/workspace.store";
import { EXPORT_DIALECTS, type ExportDialect, type SqlDialect, exportDdl } from "./sql-ddl";

/** "Export → SQL DDL": CREATE scripts for another (or the same) database, saved as a file. */
@Injectable({ providedIn: "root" })
export class DdlService {
  private readonly store = inject(WorkspaceStore);
  private readonly api = inject(TauriApi);

  /** The dialect the current document's types are written in, when known. */
  readonly sourceDialect = computed<SqlDialect | null>(() => {
    const src = this.store.source();
    if (src?.kind === "db") return src.engine;
    return src?.dialect ?? null;
  });

  /** Export targets, the current document's own dialect first. */
  readonly targets = computed(() => {
    const own = this.sourceDialect();
    return [...EXPORT_DIALECTS].sort((a, b) => Number(b.value === own) - Number(a.value === own));
  });

  async export(target: ExportDialect): Promise<void> {
    const dbml = this.store.dbml();
    if (!dbml.trim()) return this.store.flash("Nothing to export yet");
    const title = this.store.exportBaseName();
    try {
      const { sql } = await exportDdl(dbml, target, {
        source: this.sourceDialect(),
        title,
        origin: this.store.source()?.detail ?? null,
      });
      const path = await this.api.saveFile({
        defaultName: `${title}.${target}.sql`,
        filterName: "SQL script",
        extensions: ["sql"],
        contents: sql,
        base64: false,
      });
      if (path) this.store.flash(`Saved ${path}`);
    } catch (err) {
      this.store.error.set(errorMessage(err));
    }
  }
}
