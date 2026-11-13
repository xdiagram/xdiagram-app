import { Injectable, inject } from "@angular/core";

import { TauriApi, errorMessage } from "../core/tauri-api.service";
import { buildScene } from "../diagram/geometry";
import { sceneToSvg } from "../diagram/svg-export";
import { LIGHT } from "../diagram/theme";
import { WorkloadStore } from "../state/workload.store";
import { WorkspaceStore } from "../state/workspace.store";
import { renderHtml } from "./doc-html";
import { renderMarkdown } from "./doc-markdown";
import { anchorOf, buildDocModel } from "./doc-model";

/** Data-dictionary export (HTML or Markdown) of the current DBML, with X-ray facts when on. */
@Injectable({ providedIn: "root" })
export class DocsService {
  private readonly store = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly api = inject(TauriApi);

  async export(format: "html" | "md"): Promise<void> {
    const db = await this.store.parsedDatabase();
    if (!db) return this.store.flash("Nothing to document yet");
    const view = this.store.view();
    const title = this.store.exportBaseName();
    const report = this.workload.enabled() ? this.workload.report() : null;
    const model = buildDocModel(db, view, { title, source: this.store.source()?.detail ?? null, report });

    let contents: string;
    if (format === "html") {
      // Every table, at full detail, at its saved position (hidden ones included).
      const scene = buildScene(view, this.store.positions(), new Set(), { detail: "all" });
      const svg = scene.tables.size ? sceneToSvg(scene, LIGHT, title, { link: (id) => `#${anchorOf(id)}` }) : null;
      contents = renderHtml(model, svg);
    } else {
      contents = renderMarkdown(model);
    }
    try {
      const path = await this.api.saveFile({
        defaultName: `${title}${format === "html" ? ".html" : ".md"}`,
        filterName: format === "html" ? "HTML document" : "Markdown",
        extensions: [format === "html" ? "html" : "md"],
        contents,
        base64: false,
      });
      if (path) this.store.flash(`Saved ${path}`);
    } catch (err) {
      this.store.error.set(errorMessage(err));
    }
  }
}
