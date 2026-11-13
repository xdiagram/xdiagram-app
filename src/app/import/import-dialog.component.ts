import { Component, OnDestroy, OnInit, computed, inject, input, output, signal } from "@angular/core";

import { TauriApi } from "../core/tauri-api.service";
import { DraggableDialogDirective } from "../core/draggable-dialog.directive";
import {
  IMPORT_DIALECTS,
  ImportError,
  type ImportResult,
  type SqlDialect,
  guessDialect,
  importDdl,
} from "../export/sql-ddl";
import { type ImportRequest, WorkspaceStore } from "../state/workspace.store";

/**
 * Converts a SQL DDL script (or a Rails schema.rb) to DBML. The dialect is guessed and can be
 * changed; the conversion re-runs live so the result (or the first error, with its line) is
 * visible before importing. Nothing here touches a database.
 */
@Component({
  selector: "app-import-dialog",
  imports: [DraggableDialogDirective],
  host: { "(document:keydown.escape)": "close()" },
  template: `
    <div class="backdrop" (click)="close()"></div>
    <section class="dialog" appDraggableDialog role="dialog" aria-modal="true" aria-labelledby="imp-title">
      <h2 id="imp-title">{{ pasteMode() ? "Import SQL" : "Import " + request().name }}</h2>

      @if (pasteMode()) {
        <label class="full">
          <span>SQL script <em>(CREATE TABLE statements, a pg_dump --schema-only, a schema.rb…)</em></span>
          <textarea rows="12" spellcheck="false" [value]="text()" (input)="onText($any($event.target).value)"
            placeholder="CREATE TABLE users (&#10;  id bigint PRIMARY KEY,&#10;  email varchar(255) NOT NULL&#10;);"></textarea>
        </label>
      }

      <label class="dialect">
        <span>Dialect</span>
        <select [value]="dialect()" (change)="onDialect($any($event.target).value)">
          @for (d of dialects; track d.value) {
            <option [value]="d.value" [selected]="d.value === dialect()">{{ d.label }}{{ d.value === guessed() ? " (detected)" : "" }}</option>
          }
        </select>
      </label>

      <div class="result" aria-live="polite">
        @if (busy()) {
          <p class="status">Converting…</p>
        } @else if (error(); as e) {
          <p class="status bad">{{ e.line ? "Line " + e.line + ": " : "" }}{{ e.message }}</p>
          @if (errorLine(); as l) {
            <pre class="snippet">{{ l }}</pre>
          }
          <p class="hint">Try another dialect if the detected one is wrong.</p>
        } @else if (result(); as r) {
          <p class="status ok">
            {{ r.tables }} table{{ r.tables === 1 ? "" : "s" }} · {{ r.refs }} relationship{{ r.refs === 1 ? "" : "s" }}
            @if (r.enums) { · {{ r.enums }} enum{{ r.enums === 1 ? "" : "s" }} }
          </p>
          @if (r.skipped.length) {
            <p class="hint">Ignored: {{ r.skipped.join(", ") }}.</p>
          }
        } @else if (pasteMode() && !text().trim()) {
          <p class="hint">Paste a script to see what it contains.</p>
        }
      </div>

      <p class="hint">Only the schema is imported. Nothing is run against a database.</p>
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" (click)="close()">Cancel</button>
        <button type="button" class="primary" (click)="confirm()" [disabled]="!result() || busy() || importing()">
          {{ importing() ? "Importing…" : "Import" }}
        </button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 50; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; padding: 16px; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop); }
    .dialog { position: relative; width: min(640px, 100%); max-height: calc(100vh - 32px); overflow: auto;
      background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 12px;
      box-shadow: var(--shadow-lg); padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; }
    h2 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
    label em { font-style: normal; opacity: 0.75; }
    .dialect { max-width: 260px; }
    select, textarea { font: inherit; font-size: 13px; color: var(--text); background: var(--input-bg);
      border: 1px solid var(--border); border-radius: 7px; padding: 7px 9px; }
    textarea { font-family: var(--mono); font-size: 12px; resize: vertical; min-height: 140px; }
    select:focus, textarea:focus { outline: 2px solid var(--accent-ring); outline-offset: -1px; border-color: var(--accent); }
    .result { min-height: 38px; display: flex; flex-direction: column; gap: 6px; }
    .status { margin: 0; font-size: 12.5px; padding: 8px 10px; border-radius: 7px; background: var(--hover); overflow-wrap: anywhere; }
    .status.ok { background: var(--ok-soft); color: var(--ok); }
    .status.bad { background: var(--danger-soft); color: var(--danger); }
    .snippet { margin: 0; font-family: var(--mono); font-size: 12px; background: var(--panel-2); border: 1px solid var(--border);
      border-radius: 6px; padding: 6px 8px; overflow-x: auto; white-space: pre; }
    .hint { margin: 0; font-size: 12px; color: var(--text-muted); }
    .actions { display: flex; gap: 8px; align-items: center; }
    .spacer { flex: 1; }
    .actions button { font: inherit; font-size: 13px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      padding: 7px 14px; border-radius: 7px; cursor: pointer; }
    .actions button:hover:not(:disabled) { background: var(--hover); }
    .actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; min-width: 96px; }
    .actions button.primary:hover:not(:disabled) { background: var(--accent-strong); }
    button:disabled { opacity: 0.6; cursor: default; }
  `,
})
export class ImportDialogComponent implements OnInit, OnDestroy {
  readonly request = input.required<ImportRequest>();
  readonly closed = output<void>();

  private readonly api = inject(TauriApi);
  private readonly store = inject(WorkspaceStore);

  protected readonly dialects = IMPORT_DIALECTS;
  protected readonly text = signal("");
  protected readonly dialect = signal<SqlDialect>("postgres");
  protected readonly guessed = signal<SqlDialect | null>(null);
  protected readonly result = signal<ImportResult | null>(null);
  protected readonly error = signal<ImportError | null>(null);
  protected readonly busy = signal(false);
  protected readonly importing = signal(false);
  protected readonly pasteMode = computed(() => this.request().path === null);
  /** The script line an import error points at. */
  protected readonly errorLine = computed(() => {
    const line = this.error()?.line;
    return line ? (this.text().split(/\r?\n/)[line - 1] ?? "").slice(0, 240) : null;
  });

  private dialectChosen = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  ngOnInit(): void {
    const req = this.request();
    this.text.set(req.text);
    this.setGuess();
    if (req.text.trim()) void this.convert();
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  protected onText(value: string): void {
    this.text.set(value);
    if (!this.dialectChosen) this.setGuess();
    this.schedule();
  }

  protected onDialect(value: SqlDialect): void {
    this.dialectChosen = true;
    this.dialect.set(value);
    void this.convert();
  }

  protected async confirm(): Promise<void> {
    const r = this.result();
    if (!r || this.importing()) return;
    this.importing.set(true);
    const ok = await this.store.openImported({ ...this.request(), text: this.text() }, r.dbml, this.dialect());
    this.importing.set(false);
    if (ok) this.closed.emit();
  }

  protected close(): void {
    if (!this.importing()) {
      this.store.importRequest.set(null);
      this.closed.emit();
    }
  }

  private setGuess(): void {
    const guess = guessDialect(this.text(), this.request().name);
    this.guessed.set(guess);
    this.dialect.set(guess);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.convert(), 350);
  }

  private async convert(): Promise<void> {
    const seq = ++this.seq;
    const text = this.text();
    if (!text.trim()) {
      this.result.set(null);
      this.error.set(null);
      return;
    }
    this.busy.set(true);
    try {
      const r = await importDdl(text, this.dialect(), (sql) => this.api.importSqliteDdl(sql));
      if (seq !== this.seq) return;
      this.result.set(r);
      this.error.set(null);
    } catch (err) {
      if (seq !== this.seq) return;
      this.result.set(null);
      this.error.set(err instanceof ImportError ? err : new ImportError(String((err as Error)?.message ?? err), null));
    } finally {
      if (seq === this.seq) this.busy.set(false);
    }
  }
}
