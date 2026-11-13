import type { Database } from "@dbml/core";
import { Component, computed, effect, inject, input, output, signal, untracked } from "@angular/core";

import { TauriApi, errorMessage } from "../core/tauri-api.service";
import { DraggableDialogDirective } from "../core/draggable-dialog.directive";
import { displayTable } from "../diagram/view-model";
import { buildDocModel } from "../export/doc-model";
import { DdlService } from "../export/ddl.service";
import { WorkspaceStore } from "../state/workspace.store";
import { SAMPLE_DIALECTS, type SampleDialect, generateSampleData } from "./sample-data";

type Scope = "visible" | "all" | "table";

const PREVIEW_LINES = 200;

/** Settings, preview and Copy / Save for the sample data generator. Nothing is run. */
@Component({
  selector: "app-sample-data-dialog",
  imports: [DraggableDialogDirective],
  host: { "(document:keydown.escape)": "closed.emit()" },
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <section class="dialog" appDraggableDialog role="dialog" aria-modal="true" aria-labelledby="sd-title">
      <h2 id="sd-title">Sample data</h2>
      <div class="row">
        <label>
          <span>Tables</span>
          <select [value]="scope()" (change)="scope.set($any($event.target).value)">
            @if (table(); as t) {
              <option value="table" [selected]="scope() === 'table'">{{ short(t) }} and the tables it needs</option>
            }
            <option value="visible" [selected]="scope() === 'visible'">Visible tables ({{ visibleIds().length }})</option>
            <option value="all" [selected]="scope() === 'all'">All tables ({{ store.view().tables.length }})</option>
          </select>
        </label>
        <label class="narrow">
          <span>Rows per table</span>
          <input type="number" min="1" max="1000" [value]="rows()" (change)="setRows($any($event.target).value)" />
        </label>
        <label>
          <span>Dialect</span>
          <select [value]="dialect()" (change)="dialect.set($any($event.target).value)">
            @for (d of dialects; track d.value) {
              <option [value]="d.value" [selected]="d.value === dialect()">{{ d.label }}</option>
            }
          </select>
        </label>
        <label class="narrow">
          <span>Seed</span>
          <span class="seed">
            <input type="number" [value]="seed()" (change)="seed.set(+$any($event.target).value || 1)" />
            <button type="button" (click)="shuffle()" title="New random values">Shuffle</button>
          </span>
        </label>
      </div>

      @if (result(); as r) {
        <p class="summary">
          {{ r.rowCount }} rows in {{ r.tableCount }} table{{ r.tableCount === 1 ? "" : "s" }}
          · {{ lineCount() }} lines{{ lineCount() > previewLines ? " (preview shows the first " + previewLines + ")" : "" }}
        </p>
        @for (w of r.warnings; track $index) {
          <p class="warning">{{ w }}</p>
        }
        <pre class="preview">{{ preview() }}</pre>
      } @else if (error(); as e) {
        <p class="warning">{{ e }}</p>
      }

      <p class="hint">Fake values in dependency order. Nothing is run against a database.</p>
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" (click)="closed.emit()">Close</button>
        <button type="button" (click)="copy()" [disabled]="!result()">Copy</button>
        <button type="button" class="primary" (click)="save()" [disabled]="!result()">Save .sql…</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 50; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; padding: 16px; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop); }
    .dialog { position: relative; width: min(860px, 100%); max-height: calc(100vh - 32px); background: var(--panel); color: var(--text);
      border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 18px 22px;
      display: flex; flex-direction: column; gap: 10px; min-height: 0; }
    h2 { margin: 0; font-size: 16px; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); flex: 1 1 180px; min-width: 0; }
    label.narrow { flex: 0 1 150px; }
    select, input { font: inherit; font-size: 13px; color: var(--text); background: var(--input-bg); border: 1px solid var(--border);
      border-radius: 7px; padding: 6px 8px; min-width: 0; }
    .seed { display: flex; gap: 4px; }
    .seed input { width: 70px; flex: 1; }
    .seed button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 7px; padding: 4px 8px; cursor: pointer; }
    .summary { margin: 0; font-size: 12.5px; }
    .warning { margin: 0; font-size: 12px; color: #b45309; background: rgba(217, 119, 6, 0.1); padding: 5px 8px; border-radius: 6px; }
    .preview { margin: 0; flex: 1; min-height: 160px; max-height: 50vh; overflow: auto; font-family: var(--mono); font-size: 11.5px;
      line-height: 1.45; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; white-space: pre; }
    .hint { margin: 0; font-size: 12px; color: var(--text-muted); }
    .actions { display: flex; gap: 8px; align-items: center; }
    .spacer { flex: 1; }
    .actions button { font: inherit; font-size: 13px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      padding: 7px 14px; border-radius: 7px; cursor: pointer; }
    .actions button:hover:not(:disabled) { background: var(--hover); }
    .actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .actions button.primary:hover:not(:disabled) { background: var(--accent-strong); }
    button:disabled { opacity: 0.6; cursor: default; }
  `,
})
export class SampleDataDialogComponent {
  /** Table the dialog was opened for (context menu), if any. */
  readonly table = input<string | null>(null);
  readonly closed = output<void>();

  protected readonly store = inject(WorkspaceStore);
  private readonly api = inject(TauriApi);
  private readonly ddl = inject(DdlService);

  protected readonly dialects = SAMPLE_DIALECTS;
  protected readonly previewLines = PREVIEW_LINES;
  protected readonly short = displayTable;
  protected readonly scope = signal<Scope>("visible");
  protected readonly rows = signal(25);
  protected readonly dialect = signal<SampleDialect>("postgres");
  protected readonly seed = signal(1);

  protected readonly visibleIds = computed(() => {
    const hidden = this.store.hidden();
    return this.store.view().tables.filter((t) => !hidden.has(t.id)).map((t) => t.id);
  });

  /** The full model of the current DBML (parsed on demand; null until ready or when empty). */
  private readonly database = signal<Database | null>(null);

  private readonly outcome = computed(() => {
    const db = this.database();
    if (!db) return { error: this.store.hasModel() ? "Reading the schema…" : "Nothing to generate yet" };
    const scope = this.scope();
    const tables = scope === "all" ? null : scope === "table" && this.table() ? [this.table()!] : this.visibleIds();
    try {
      const model = buildDocModel(db, this.store.view(), { title: "", source: null });
      const data = generateSampleData(model, {
        tables,
        rowsPerTable: this.rows(),
        dialect: this.dialect(),
        seed: this.seed(),
        source: this.ddl.sourceDialect(),
        title: this.store.exportBaseName(),
      });
      return { data };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  });
  protected readonly result = computed(() => this.outcome().data ?? null);
  protected readonly error = computed(() => this.outcome().error ?? null);

  protected readonly lineCount = computed(() => this.result()?.sql.split("\n").length ?? 0);
  protected readonly preview = computed(() => this.result()?.sql.split("\n").slice(0, PREVIEW_LINES).join("\n") ?? "");

  constructor() {
    effect(() => {
      this.store.view();
      untracked(() => void this.store.parsedDatabase().then((db) => this.database.set(db)));
    });
    queueMicrotask(() => {
      if (this.table()) this.scope.set("table");
      const own = this.ddl.sourceDialect();
      if (own === "postgres" || own === "mysql" || own === "mssql" || own === "sqlite") this.dialect.set(own);
    });
  }

  protected setRows(value: string): void {
    this.rows.set(Math.min(1000, Math.max(1, Math.round(Number(value)) || 1)));
  }

  protected shuffle(): void {
    this.seed.set(1 + Math.floor(Math.random() * 99999));
  }

  protected copy(): void {
    const sql = this.result()?.sql;
    if (sql) void navigator.clipboard?.writeText(sql).then(() => this.store.flash("Sample data copied"));
  }

  protected async save(): Promise<void> {
    const sql = this.result()?.sql;
    if (!sql) return;
    try {
      const path = await this.api.saveFile({
        defaultName: `${this.store.exportBaseName()}.sample.${this.dialect()}.sql`,
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
