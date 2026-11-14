import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";

import { displayTable } from "../diagram/view-model";
import { QUICK_HELP } from "../filter/help";
import { highlightTerms, segments } from "../filter/highlight";
import { printQuick } from "../filter/quick-syntax";
import { singleColumn } from "../filter/tree";
import { BrowserStore, PAGE_SIZE } from "../state/browser.store";
import { QueryStore } from "../state/query.store";
import { WorkspaceStore } from "../state/workspace.store";
import { ExpressionBoxComponent } from "./filter/expression-box.component";
import { FilterBarComponent } from "./filter/filter-bar.component";

/**
 * Query builder body of the data drawer: tables, columns, the filter (the same tree, bar and
 * expression box as the Rows view, over `alias.column`), the generated SQL and the results.
 */
@Component({
  selector: "app-query-view",
  imports: [FilterBarComponent, ExpressionBoxComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      @for (id of q.plan().tables; track id) {
        @let chosen = q.chosen().includes(id);
        <span class="chip" [class.bridge]="!chosen" [class.open]="picking() === id">
          <button type="button" class="chip-main" (click)="picking.set(picking() === id ? null : id)"
            [title]="(chosen ? '' : 'Joined to connect the others — ') + 'pick columns of ' + short(id)">
            <b>{{ alias(id) }}</b> {{ short(id) }} <span class="count">{{ q.columnsOf(id).length }}</span>
          </button>
          @if (chosen) {
            <button type="button" class="x" (click)="q.remove(id)" [attr.aria-label]="'Remove ' + short(id)">×</button>
          }
        </span>
      }
      @for (id of q.plan().unreachable; track id) {
        <span class="chip bad" [title]="'No relationship path connects ' + short(id) + ' to the other tables'">
          {{ short(id) }} — no path
          <button type="button" class="x" (click)="q.remove(id)" [attr.aria-label]="'Remove ' + short(id)">×</button>
        </span>
      }
      <select class="add" (change)="addTable($any($event.target))" aria-label="Add a table to the query">
        <option value="">+ Add table…</option>
        @for (t of addable(); track t.id) {
          <option [value]="t.id">{{ short(t.id) }}</option>
        }
      </select>
      <label class="opt" title="LEFT JOIN: keep rows of earlier tables that have no match">
        <input type="checkbox" [checked]="q.leftJoin()" (change)="q.setLeftJoin($any($event.target).checked)" /> Keep unmatched rows
      </label>
      <span class="spacer"></span>
      <button type="button" (click)="q.copySql()" [disabled]="!q.sql()">Copy SQL</button>
      @if (q.loading()) {
        <button type="button" (click)="q.cancel()" title="Stop the query">Cancel</button>
      } @else {
        <button type="button" class="primary" (click)="run()" [disabled]="!q.request()">Run</button>
      }
    </div>

    @if (picking(); as id) {
      <div class="picker">
        <span class="p-title">{{ short(id) }} columns:</span>
        @for (f of q.table(id)?.fields ?? []; track f.name) {
          <label><input type="checkbox" [checked]="q.columnsOf(id).includes(f.name)" (change)="q.toggleColumn(id, f.name, $any($event.target).checked)" /> {{ f.name }}</label>
        }
      </div>
    }

    @if (!q.chosen().length) {
      <p class="hint">Add tables (here, from a table's right-click menu, or with Ctrl+K). They are joined along their relationships; the path is outlined on the diagram.</p>
    } @else {
      <app-filter-bar [columns]="q.columns()" [engine]="engine()" [tree]="q.where()" [issues]="q.issues()" (treeChange)="q.setWhere($event)"
        [textOpen]="textOpen()" (textToggle)="textOpen.set(!textOpen())" />
      @if (textOpen()) {
        <app-expression-box [columns]="q.columns()" [engine]="engine()" [tree]="q.where()" (treeChange)="q.setWhere($event)" />
      }
      <pre class="sql" [title]="'Read-only. Values are sent as parameters when it runs.'">{{ q.sql() || "-- pick at least one column" }}</pre>
    }

    @if (q.error(); as err) {
      <div class="error">{{ err }}</div>
    }
    @if (q.result(); as r) {
      <div class="grid-wrap" [class.dim]="q.loading()">
        <table class="grid">
          <thead>
            <tr>
              @for (c of r.columns; track c.name) {
                <th [title]="c.typeName"><span class="cname">{{ c.name }}</span><span class="ctype">{{ c.typeName }}</span></th>
              }
            </tr>
            <tr class="filters">
              @for (c of r.columns; track c.name) {
                <th>
                  @let ft = filterText(c.name);
                  <input type="text" [value]="ft ?? ''" [placeholder]="ft === null ? '(filtered)' : 'filter'" spellcheck="false" [title]="quickHelp"
                    (keydown.enter)="q.setQuick(c.name, $any($event.target).value)"
                    [attr.aria-label]="'Filter ' + c.name + ' (Enter applies; empty clears)'" />
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of r.rows; track $index; let ri = $index) {
              <tr>
                @for (cell of row; track $index; let ci = $index) {
                  <td [class.null]="cell === null" [title]="cell ?? 'NULL'" (click)="copy(cell)">@if (marks()?.[ri]?.[ci]; as segs) {@for (s of segs; track $index) {<span [class.hit]="s.hit">{{ s.text }}</span>}} @else {<ng-container>{{ cell ?? "NULL" }}</ng-container>}</td>
                }
              </tr>
            } @empty {
              <tr><td class="none" [attr.colspan]="r.columns.length">No rows.</td></tr>
            }
          </tbody>
        </table>
      </div>
      <footer>
        <span>{{ range() }}</span>
        <span class="muted">· {{ r.elapsedMs }} ms</span>
        <span class="spacer"></span>
        <button type="button" (click)="q.page(-1)" [disabled]="!q.offset() || q.loading()">‹ Prev</button>
        <button type="button" (click)="q.page(1)" [disabled]="!r.hasMore || q.loading()">Next ›</button>
      </footer>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; font-size: 12px; }
    .bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex-wrap: wrap; border-bottom: 1px solid var(--border); flex: none; }
    .chip { display: inline-flex; align-items: center; border: 1px solid var(--accent); border-radius: 14px; background: var(--accent-soft); }
    .chip.bridge { border-style: dashed; background: transparent; }
    .chip.open { box-shadow: 0 0 0 2px var(--accent-ring); }
    .chip.bad { border-color: var(--danger); color: var(--danger); background: var(--danger-soft); padding-left: 9px; }
    .chip button { font: inherit; font-size: 12px; border: 0; background: none; color: var(--text); cursor: pointer; }
    .chip-main { padding: 2px 4px 2px 9px; font-family: var(--mono) !important; }
    .chip-main b { color: var(--accent); }
    .count { color: var(--text-muted); font-size: 10.5px; }
    .x { padding: 0 8px 0 4px; color: var(--text-muted) !important; }
    .add, .bar > button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 6px; padding: 3px 8px; cursor: pointer; }
    .bar > button.primary { background: var(--accent); border-color: var(--accent); color: #fff; min-width: 64px; }
    .bar > button:disabled { opacity: 0.5; cursor: default; }
    .opt { display: flex; align-items: center; gap: 4px; color: var(--text-muted); cursor: pointer; }
    .spacer { flex: 1; }
    .picker { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--panel-2); flex: none;
      max-height: 90px; overflow: auto; }
    .picker label { display: flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 11.5px; cursor: pointer; }
    .p-title { font-weight: 600; color: var(--text-muted); }
    .hint { margin: 10px 12px; color: var(--text-muted); }
    app-filter-bar, app-expression-box { flex: none; }
    .sql { margin: 0; padding: 6px 10px; font-family: var(--mono); font-size: 11.5px; background: var(--panel-2); border-bottom: 1px solid var(--border);
      max-height: 86px; overflow: auto; white-space: pre; flex: none; }
    .error { padding: 8px 12px; color: var(--danger); background: var(--danger-soft); }
    .grid-wrap { flex: 1; min-height: 0; overflow: auto; }
    .grid-wrap.dim { opacity: 0.6; }
    table { border-collapse: separate; border-spacing: 0; font-family: var(--mono); font-size: 11.5px; }
    th, td { padding: 3px 8px; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); text-align: left;
      white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
    thead th { position: sticky; top: 0; z-index: 1; background: var(--panel-2); font-family: var(--font); }
    thead tr.filters th { top: 37px; padding: 2px 4px; }
    .cname { font-weight: 600; font-size: 12px; }
    .ctype { display: block; font-size: 10.5px; color: var(--text-muted); font-family: var(--mono); font-weight: 400; }
    .filters input { width: 100%; min-width: 60px; box-sizing: border-box; font: inherit; font-size: 11px; font-family: var(--mono);
      border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; background: var(--input-bg); color: var(--text); }
    td { cursor: copy; }
    td .hit { background: var(--highlight); border-radius: 2px; }
    td.null { color: var(--text-muted); font-style: italic; }
    td.none { color: var(--text-muted); font-family: var(--font); cursor: default; padding: 10px; }
    tbody tr:hover td { background: var(--hover); }
    footer { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-top: 1px solid var(--border); flex: none; }
    footer button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 6px; padding: 2px 9px; cursor: pointer; }
    footer button:disabled { opacity: 0.5; cursor: default; }
    .muted { color: var(--text-muted); }
  `,
})
export class QueryViewComponent {
  protected readonly q = inject(QueryStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly browser = inject(BrowserStore);
  protected readonly picking = signal<string | null>(null);
  protected readonly short = displayTable;

  protected readonly addable = computed(() => {
    const inQuery = new Set([...this.q.plan().tables, ...this.q.chosen()]);
    return this.workspace.view().tables.filter((t) => !inQuery.has(t.id));
  });


  protected readonly range = computed(() => {
    const r = this.q.result();
    if (!r || !r.rows.length) return "0 rows";
    const from = this.q.offset() + 1;
    return `rows ${from}–${this.q.offset() + r.rows.length}${r.hasMore ? "" : " (end)"}`;
  });

  protected alias(id: string): string {
    return this.q.aliases().get(id) ?? "";
  }

  protected addTable(select: HTMLSelectElement): void {
    if (select.value) this.q.add(select.value);
    select.value = "";
  }

  protected run(): void {
    this.q.offset.set(0);
    void this.q.run();
  }

  protected readonly engine = this.browser.engine;
  protected readonly textOpen = signal(false);
  protected readonly quickHelp = QUICK_HELP;

  /** A column box's text: its one condition in quick syntax; `null` when it has several. */
  protected filterText(column: string): string | null {
    const nodes = this.q.where().items.filter((n) => singleColumn(n) === column && !n.off);
    if (!nodes.length) return "";
    return nodes.length === 1 ? printQuick(nodes[0]) : null;
  }

  /** Matched text per cell, as in the Rows view. */
  protected readonly marks = computed(() => {
    const r = this.q.result();
    const { all, byColumn } = highlightTerms(this.q.where());
    if (!r || (!all.length && !byColumn.size)) return null;
    const terms = r.columns.map((c) => [...all, ...(byColumn.get(c.name) ?? [])]);
    return r.rows.map((row) =>
      row.map((cell, ci) => {
        if (cell === null || !terms[ci].length) return null;
        const segs = segments(cell, terms[ci]);
        return segs.some((s) => s.hit) ? segs : null;
      }),
    );
  });

  protected copy(value: string | null): void {
    if (value !== null) void navigator.clipboard?.writeText(value).then(() => this.workspace.flash("Value copied"));
  }

  protected readonly pageSize = PAGE_SIZE;
}
