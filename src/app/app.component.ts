import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";

import { ConnectionDialogComponent } from "./connect/connection-dialog.component";
import { loadDbmlCore } from "./core/dbml";
import { DiagramComponent } from "./diagram/diagram.component";
import { displayTable } from "./diagram/view-model";
import { type Engine, TauriApi } from "./core/tauri-api.service";
import { engineInfo } from "./persistence/profiles.service";
import { DbmlEditorComponent } from "./editor/dbml-editor.component";
import { DataDrawerComponent } from "./data/data-drawer.component";
import { RowGraphComponent } from "./data/row-graph.component";
import { RowGraphStore } from "./state/row-graph.store";
import { DdlService } from "./export/ddl.service";
import { DocsService } from "./export/docs.service";
import type { ExportDialect } from "./export/sql-ddl";
import { ImportDialogComponent } from "./import/import-dialog.component";
import { SampleDataDialogComponent } from "./sample/sample-data-dialog.component";
import { SettingsDialogComponent } from "./settings/settings-dialog.component";
import { AboutDialogComponent } from "./about/about-dialog.component";
import { UpdateService } from "./core/update.service";
import { TabStripComponent } from "./tabs/tab-strip.component";
import { TabsStore } from "./state/tabs.store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { ThemeService } from "./core/theme.service";
import { CommandPaletteComponent, PaletteItem } from "./palette/command-palette.component";
import { LintPanelComponent } from "./sidebar/lint-panel.component";
import { TableListComponent } from "./sidebar/table-list.component";
import { LintStore } from "./state/lint.store";
import { QueryStore } from "./state/query.store";
import { WorkloadPanelComponent } from "./sidebar/workload-panel.component";
import { BrowserStore } from "./state/browser.store";
import { WorkloadStore } from "./state/workload.store";
import { WorkspaceStore } from "./state/workspace.store";

const EDITOR_WIDTH_KEY = "xdiagram.editorWidth";
const SIDEBAR_KEY = "xdiagram.sidebar";

type SidebarTab = "tables" | "xray" | "lint";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Inputs, text areas, contenteditable and the Monaco editor handle their own undo. */
function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .monaco-editor");
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferences are best-effort */
  }
}

@Component({
  selector: "app-root",
  imports: [
    ConnectionDialogComponent,
    DiagramComponent,
    DbmlEditorComponent,
    TableListComponent,
    WorkloadPanelComponent,
    CommandPaletteComponent,
    DataDrawerComponent,
    ImportDialogComponent,
    LintPanelComponent,
    SampleDataDialogComponent,
    SettingsDialogComponent,
    AboutDialogComponent,
    TabStripComponent,
    RowGraphComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(document:keydown)": "onKey($event)" },
})
export class AppComponent {
  protected readonly store = inject(WorkspaceStore);
  protected readonly workload = inject(WorkloadStore);
  private readonly docs = inject(DocsService);
  protected readonly ddl = inject(DdlService);
  protected readonly lint = inject(LintStore);
  private readonly query = inject(QueryStore);
  protected readonly browser = inject(BrowserStore);
  protected readonly rowGraph = inject(RowGraphStore);
  protected readonly connectOpen = signal(false);
  protected readonly exportOpen = signal(false);
  protected readonly viewsOpen = signal(false);
  protected readonly paletteOpen = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly aboutOpen = signal(false);
  protected readonly updates = inject(UpdateService);
  /** Created at start so the chosen theme applies everywhere. */
  private readonly theme = inject(ThemeService);
  protected readonly tabs = inject(TabsStore);
  private readonly api = inject(TauriApi);
  /** X-ray reads PostgreSQL statistics views, so it is only offered for PostgreSQL connections. */
  protected readonly xrayAvailable = computed(() => {
    const src = this.store.source();
    return src?.kind === "db" && src.engine === "postgres";
  });

  protected engineName(engine: Engine): string {
    return engineInfo(engine).short;
  }

  /** Everything Ctrl+K can reach: tables, columns, saved views and commands. */
  protected readonly paletteItems = computed<PaletteItem[]>(() => {
    const view = this.store.view();
    const items: PaletteItem[] = [];
    const db = this.store.source()?.kind === "db";
    const has = view.tables.length > 0;
    const cmd = (id: string, label: string, run: () => void, detail?: string, when = true) => {
      if (when) items.push({ id: "cmd:" + id, kind: "command", label, detail, run });
    };
    cmd("connect", "Connect to a database…", () => this.connectOpen.set(true));
    cmd("settings", "Settings…", () => this.settingsOpen.set(true), "Ctrl+,");
    cmd("about", "About xdiagram", () => this.aboutOpen.set(true), "Help");
    cmd("updates", "Check for updates", () => this.checkForUpdates(), "Help");
    cmd("open", "Open a .dbml, .sql or schema.rb file", () => void this.store.openFile(), "Ctrl+O");
    cmd("save", "Save", () => void this.store.save(), "Ctrl+S", this.store.dbml().trim().length > 0);
    cmd("save-as", "Save as .dbml…", () => void this.store.saveAs(), "Ctrl+Shift+S", this.store.dbml().trim().length > 0);
    cmd("new-tab", "New tab", () => this.tabs.newTab(), "Ctrl+T");
    cmd("close-tab", "Close tab", () => void this.tabs.close(this.tabs.activeId()), "Ctrl+W");
    cmd("import-paste", "Import SQL DDL (paste)…", () => this.store.importRequest.set({ text: "", path: null, name: "Pasted SQL" }), "Import");
    cmd("refresh", "Refresh from database", () => void this.store.refresh(), "Ctrl+R", db);
    cmd("xray", this.workload.enabled() ? "Turn off X-ray" : "Turn on X-ray", () => void this.workload.toggle(), "Ctrl+Shift+X", this.xrayAvailable());
    cmd("editor", this.store.editorOpen() ? "Hide DBML editor" : "Show DBML editor", () => this.toggleEditor(), "Panels");
    cmd("sidebar", this.sidebarOpen() ? "Hide side panel" : "Show side panel", () => this.toggleSidebar(), "Panels");
    cmd("fit", "Fit diagram to screen", () => this.store.diagram?.fit(), undefined, has);
    cmd("arrange", "Auto-arrange tables", () => void this.store.autoArrange(), undefined, has);
    cmd("detail-all", "Show all columns", () => this.store.setDetail("all"), "Detail", has);
    cmd("detail-keys", "Show only key columns", () => this.store.setDetail("keys"), "Detail", has);
    cmd("detail-names", "Show only table names", () => this.store.setDetail("names"), "Detail", has);
    cmd("focus", this.store.focusMode() ? "Turn off focus mode" : "Turn on focus mode", () => this.store.focusMode.update((v) => !v), "F", has);
    cmd("show-all", "Show all tables", () => this.store.applyView(null), undefined, has);
    cmd("png", "Export PNG image", () => this.export("png"), "Export", has);
    cmd("svg", "Export SVG image", () => this.export("svg"), "Export", has);
    cmd("dbml", "Export DBML file", () => this.export("dbml"), "Ctrl+S", has);
    cmd("doc-html", "Export documentation (HTML)", () => this.export("html"), "Export", has);
    cmd("doc-md", "Export documentation (Markdown)", () => this.export("md"), "Export", has);
    cmd("sample", "Generate sample data (SQL)…", () => this.openSampleData(), "Export", has);
    for (const d of this.ddl.targets()) cmd("ddl-" + d.value, `Export SQL DDL (${d.label})`, () => this.exportDdl(d.value), "Export", has);
    for (const v of view.views) {
      items.push({ id: "view:" + v.name, kind: "view", label: v.name, detail: (v.tables?.length ?? view.tables.length) + " tables", run: () => this.store.applyView(v.name) });
    }
    for (const t of view.tables) {
      items.push({ id: "t:" + t.id, kind: "table", label: displayTable(t.id), detail: t.fields.length + " columns", run: () => this.goTo(t.id) });
    }
    if (db) {
      for (const t of view.tables) {
        items.push({ id: "browse:" + t.id, kind: "command", label: "Browse " + displayTable(t.id), detail: "Data", run: () => this.browser.show(t.id) });
        items.push({ id: "query:" + t.id, kind: "command", label: "Add " + displayTable(t.id) + " to query", detail: "Query", run: () => this.query.add(t.id) });
        items.push({ id: "profile:" + t.id, kind: "command", label: "Profile " + displayTable(t.id), detail: "Data", run: () => this.browser.showProfile(t.id) });
      }
    }
    for (const t of view.tables) {
      for (const f of t.fields) {
        items.push({ id: "c:" + t.id + "." + f.name, kind: "column", label: displayTable(t.id) + "." + f.name, detail: f.type, run: () => this.goTo(t.id, f.name) });
      }
    }
    return items;
  });
  protected readonly sidebarOpen = signal(readPref(SIDEBAR_KEY) !== "0");
  protected readonly sidebarTab = signal<SidebarTab>("tables");
  protected readonly editorWidth = signal(Number(readPref(EDITOR_WIDTH_KEY)) || 420);
  protected readonly resizing = signal(false);

  constructor() {
    // Start fetching the (large, lazy) DBML parser chunk right away.
    void loadDbmlCore();
    // Reopen the last session's tabs (when enabled in Settings), then report app files that
    // were damaged and restored at start-up (after the restore, which clears the error banner).
    void this.tabs
      .restoreSession()
      .catch(() => undefined)
      .then(() => this.api.startupNotices())
      .then((notices) => {
        if (notices.length) this.store.error.set(notices.join("\n"));
      })
      .catch(() => undefined);
    // New versions (checked shortly after start, when enabled and configured).
    void this.updates.init();
    // Unsaved edits are not lost by closing the window.
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (!this.tabs.anyDirty()) return;
      const ok = await ask("Some tabs have unsaved changes. Close xdiagram anyway?", { title: "Unsaved changes", kind: "warning" });
      if (!ok) event.preventDefault();
    });
    // A restored tab needs a password: open the connect dialog on its profile.
    effect(() => {
      if (this.store.signInRequest()) this.connectOpen.set(true);
    });
    // The window title names the open document (• when it has unsaved changes).
    effect(() => {
      const tab = this.tabs.views().find((t) => t.active);
      const title = tab && (tab.label !== "Untitled" || tab.kind) ? `xdiagram — ${tab.label}${tab.dirty ? " •" : ""}` : "xdiagram";
      if (document.title === title) return;
      document.title = title;
      void getCurrentWindow().setTitle(title).catch(() => undefined);
    });
    // Turning X-ray on brings its panel into view.
    effect(() => {
      if (this.workload.enabled()) {
        this.sidebarTab.set("xray");
        this.sidebarOpen.set(true);
      }
    });
  }

  protected checkForUpdates(): void {
    this.aboutOpen.set(true);
    void this.updates.check(true);
  }

  /** Installing restarts the app: edits not saved yet would be lost. */
  protected async installUpdate(): Promise<void> {
    if (this.tabs.anyDirty()) {
      const ok = await ask("Some tabs have unsaved changes, which will be lost when xdiagram restarts. Install the update anyway?", {
        title: "Install update",
        kind: "warning",
      });
      if (!ok) return;
    }
    await this.updates.install();
  }

  protected updateProgress(p: number | null): string {
    if (p === null) return "";
    return p < 0 ? " — downloading…" : ` — downloading ${Math.round(p * 100)}%`;
  }

  protected toggleEditor(): void {
    this.store.setEditorOpen(!this.store.editorOpen());
  }

  protected editorToggleTitle(): string {
    if (this.store.editorOpen()) return "Hide DBML editor";
    const n = this.store.diagnostics().length;
    return n ? `Show DBML editor (${n} problem${n === 1 ? "" : "s"})` : "Show DBML editor";
  }

  protected toggleSidebar(): void {
    this.sidebarOpen.update((v) => !v);
    writePref(SIDEBAR_KEY, this.sidebarOpen() ? "1" : "0");
  }

  protected dismissErrors(): void {
    this.store.error.set(null);
    this.workload.error.set(null);
  }

  protected startResize(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.resizing.set(true);
    const startX = event.clientX;
    const startW = this.editorWidth();
    const move = (e: PointerEvent) => {
      const max = Math.max(320, window.innerWidth * 0.7);
      this.editorWidth.set(Math.round(Math.min(max, Math.max(240, startW + e.clientX - startX))));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      this.resizing.set(false);
      writePref(EDITOR_WIDTH_KEY, String(this.editorWidth()));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  protected export(kind: "png" | "svg" | "dbml" | "html" | "md"): void {
    this.exportOpen.set(false);
    if (kind === "png") void this.store.exportPng();
    else if (kind === "svg") void this.store.exportSvg();
    else if (kind === "dbml") void this.store.exportDbml();
    else void this.docs.export(kind);
  }

  protected openSampleData(): void {
    this.exportOpen.set(false);
    this.store.sampleDataFor.set({ table: null });
  }

  protected exportDdl(target: ExportDialect): void {
    this.exportOpen.set(false);
    void this.ddl.export(target);
  }

  /** Reveals a table (un-hiding it if needed), optionally flashing one of its columns. */
  private goTo(tableId: string, field?: string): void {
    if (this.store.hidden().has(tableId)) this.store.toggleHidden(tableId);
    setTimeout(() => {
      if (field) this.store.diagram?.flashField(tableId, field);
      else this.store.diagram?.focusTable(tableId);
    }, 0);
  }

  protected saveView(input: HTMLInputElement): void {
    const name = input.value;
    input.value = "";
    this.viewsOpen.set(false);
    void this.store.saveView(name);
  }

  protected onKey(e: KeyboardEvent): void {
    // The related-data map covers the app: its shortcuts (undo, focus mode, …) would act unseen.
    if (this.rowGraph.open()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) {
      if (e.key === "Escape") {
        this.exportOpen.set(false);
        this.viewsOpen.set(false);
      } else if (e.key.toLowerCase() === "f" && !e.altKey && !isTextTarget(e.target) && !this.paletteOpen()) {
        this.store.focusMode.update((v) => !v);
      }
      return;
    }
    const key = e.key.toLowerCase();
    if (key === ",") {
      e.preventDefault();
      this.settingsOpen.set(true);
      return;
    }
    if (key === "k" || key === "p") {
      e.preventDefault();
      this.paletteOpen.set(true);
      return;
    }
    // Undo/redo canvas edits through the editor's history when focus is not in a text field.
    if ((key === "z" || key === "y") && !isTextTarget(e.target)) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) this.store.redoCanvas();
      else this.store.undoCanvas();
      return;
    }
    if (key === "o") {
      e.preventDefault();
      void this.store.openFile();
    } else if (key === "s") {
      e.preventDefault();
      void (e.shiftKey ? this.store.saveAs() : this.store.save());
    } else if (key === "t") {
      e.preventDefault();
      this.tabs.newTab();
    } else if (key === "w") {
      e.preventDefault();
      void this.tabs.close(this.tabs.activeId());
    } else if (key === "tab") {
      e.preventDefault();
      this.tabs.cycle(e.shiftKey ? -1 : 1);
    } else if (key === "r" && this.store.source()?.kind === "db") {
      e.preventDefault();
      void this.store.refresh();
    } else if (key === "x" && e.shiftKey && this.xrayAvailable()) {
      e.preventDefault();
      void this.workload.toggle();
    }
  }
}
