import { Component, computed, input, output } from "@angular/core";

import { DraggableDialogDirective } from "../core/draggable-dialog.directive";
import { displayTable } from "../diagram/view-model";
import { summarizeChanges } from "../state/schema-diff";
import type { SchemaReport } from "../state/workspace.store";

/** What changed in a database since its tab last read it, and the user's edits that clashed. */
@Component({
  selector: "app-schema-changes-dialog",
  imports: [DraggableDialogDirective],
  host: { "(document:keydown.escape)": "closed.emit()" },
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <section class="dialog" appDraggableDialog role="dialog" aria-modal="true" aria-labelledby="changes-title">
      <header data-drag-handle>
        <h2 id="changes-title">Changes in {{ report().label }}</h2>
      </header>

      @if (report().changes; as c) {
        <p>{{ summary() ? summary() + ", since the database was last read." : "No changes to tables, columns or relationships." }}</p>
        @if (c.tablesAdded.length) {
          <h3>Tables added</h3>
          <ul>
            @for (t of c.tablesAdded; track t) {
              <li><button type="button" class="link" (click)="table.emit(t)">{{ short(t) }}</button></li>
            }
          </ul>
        }
        @if (c.tablesRemoved.length) {
          <h3>Tables removed</h3>
          <ul>
            @for (t of c.tablesRemoved; track t) {
              <li>{{ short(t) }}</li>
            }
          </ul>
        }
        @if (c.tables.length) {
          <h3>Columns</h3>
          <ul>
            @for (t of c.tables; track t.table) {
              <li>
                <button type="button" class="link" (click)="table.emit(t.table)">{{ short(t.table) }}</button>
                <ul class="cols">
                  @for (n of t.added; track n) {
                    <li><span class="tag add">added</span> {{ n }}</li>
                  }
                  @for (n of t.removed; track n) {
                    <li><span class="tag del">removed</span> {{ n }}</li>
                  }
                  @for (ch of t.changed; track ch.name) {
                    <li><span class="tag">changed</span> {{ ch.name }}: <code>{{ ch.before }}</code> → <code>{{ ch.after }}</code></li>
                  }
                </ul>
              </li>
            }
          </ul>
        }
        @if (c.refsAdded.length || c.refsRemoved.length) {
          <h3>Relationships</h3>
          <ul>
            @for (r of c.refsAdded; track r) {
              <li><span class="tag add">added</span> {{ r }}</li>
            }
            @for (r of c.refsRemoved; track r) {
              <li><span class="tag del">removed</span> {{ r }}</li>
            }
          </ul>
        }
        <p class="note">Indexes are not compared.</p>
      } @else {
        <p>The database's schema changed, but the two versions could not be compared table by table.</p>
      }

      @if (report().conflicts.length) {
        <h3>Your edits that clashed</h3>
        <p class="note">You and the database changed the same lines, so the database's version was kept. Your lines are below.</p>
        @for (k of report().conflicts; track $index) {
          <div class="conflict">
            <div class="conflict-head">
              <span>Line {{ k.line }}</span>
              <button type="button" class="small" (click)="copy(k.ours)">Copy your version</button>
            </div>
            <div class="side"><span class="label">Yours</span><pre>{{ k.ours || "(no lines)" }}</pre></div>
            <div class="side"><span class="label">Database (kept)</span><pre>{{ k.theirs || "(no lines)" }}</pre></div>
          </div>
        }
      }

      <div class="actions">
        <button type="button" class="primary" (click)="closed.emit()">Close</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 60; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; padding: 16px; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop); }
    .dialog { position: relative; width: min(600px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--panel);
      color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 20px 22px;
      display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
    h2 { margin: 0; font-size: 17px; }
    h3 { margin: 6px 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
    p { margin: 0; line-height: 1.5; }
    .note { color: var(--text-muted); font-size: 12px; }
    ul { margin: 0; padding-left: 18px; display: grid; gap: 3px; }
    ul.cols { margin-top: 3px; }
    code { font-family: var(--mono, monospace); font-size: 12px; }
    .link { font: inherit; font-weight: 600; border: 0; background: none; color: var(--accent); padding: 0; cursor: pointer; }
    .tag { display: inline-block; min-width: 54px; font-size: 11px; color: var(--text-muted); }
    .tag.add { color: #2e8540; }
    .tag.del { color: var(--danger); }
    .conflict { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: grid; gap: 6px; }
    .conflict-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-muted); }
    .side { display: grid; gap: 2px; }
    .label { font-size: 11px; color: var(--text-muted); }
    pre { margin: 0; padding: 6px 8px; background: var(--panel-2); border-radius: 6px; font-size: 12px; overflow: auto; max-height: 160px; white-space: pre; }
    .small { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 6px;
      padding: 2px 8px; cursor: pointer; }
    .actions { display: flex; justify-content: flex-end; }
    .primary { font: inherit; font-size: 13px; border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 7px 16px;
      border-radius: 7px; cursor: pointer; }
  `,
})
export class SchemaChangesDialogComponent {
  readonly report = input.required<SchemaReport>();
  readonly closed = output<void>();
  /** A table name was clicked: show it on the diagram. */
  readonly table = output<string>();
  protected readonly short = displayTable;
  protected readonly summary = computed(() => {
    const c = this.report().changes;
    return c ? summarizeChanges(c) : "";
  });

  protected copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}
