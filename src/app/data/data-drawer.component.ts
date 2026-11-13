import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";

import { displayTable, type VRef } from "../diagram/view-model";
import { BrowseLocation, BrowserStore } from "../state/browser.store";
import { ProfileViewComponent } from "./profile-view.component";
import { QueryViewComponent } from "./query-view.component";
import { QueryStore } from "../state/query.store";
import { RowGraphStore } from "../state/row-graph.store";
import { WorkspaceStore } from "../state/workspace.store";

const HEIGHT_KEY = "xdiagram.dataDrawerHeight";

function readHeight(): number {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || 280;
  } catch {
    return 280;
  }
}

/** Bottom drawer listing a page of rows; foreign keys are links (read-only). */
@Component({
  selector: "app-data-drawer",
  imports: [ProfileViewComponent, QueryViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[style.height.px]": "height()", "(document:keydown.escape)": "rowMenu.set(null)" },
  template: `
    <div class="resize" (pointerdown)="startResize($event)" role="separator" aria-orientation="horizontal" aria-label="Resize data panel"></div>
    <header>
      @if (store.mode() === "query") {
        <span class="crumbs q-title">Query builder</span>
      } @else {
      <nav class="crumbs" aria-label="Browsing trail">
        @for (loc of store.history(); track $index; let i = $index; let last = $last) {
          <button type="button" [disabled]="last" (click)="store.back(i)" [class.current]="last">{{ label(loc) }}</button>
          @if (!last) {
            <span class="sep">›</span>
          }
        }
      </nav>
      }
      <div class="modes" role="tablist" aria-label="Data view">
        <button type="button" role="tab" [class.on]="store.mode() === 'rows'" [attr.aria-selected]="store.mode() === 'rows'"
          (click)="store.setMode('rows')" [disabled]="!store.current()">Rows</button>
        <button type="button" role="tab" [class.on]="store.mode() === 'profile'" [attr.aria-selected]="store.mode() === 'profile'"
          (click)="store.setMode('profile')" title="Column statistics from a sample of the table" [disabled]="!store.current()">Profile</button>
        <button type="button" role="tab" [class.on]="store.mode() === 'query'" [attr.aria-selected]="store.mode() === 'query'"
          (click)="openQuery()" title="Join tables along their relationships">Query</button>
      </div>
      @if (store.mode() === "profile" && hasPii()) {
        <label class="reveal" title="Values of columns that look like personal data are masked">
          <input type="checkbox" [checked]="reveal()" (change)="reveal.set($any($event.target).checked)" /> Show personal values
        </label>
      }
      @if (store.mode() !== "query") {
        <span class="meta">{{ meta() }}</span>
      }
      @if (rowGraph.hasGraph() && !rowGraph.open()) {
        <button type="button" class="reopen" (click)="rowGraph.reopen()" title="Back to the related-data map">⇄ Related data</button>
      }
      <button type="button" class="icon" (click)="store.refresh()" [disabled]="store.loading() || store.profileLoading()" title="Reload">↻</button>
      <button type="button" class="icon" (click)="store.close()" title="Close data panel" aria-label="Close">×</button>
    </header>
    @if (store.mode() === "query") {
      <app-query-view />
    } @else if (store.mode() === "profile") {
      @if (store.profileError(); as err) {
        <div class="error">{{ err }}</div>
      }
      @if (profile(); as p) {
        <app-profile-view [profile]="p" [reveal]="reveal()" [class.dim]="store.profileLoading()" />
      } @else if (store.profileLoading()) {
        <div class="loading">Sampling the table… <button type="button" class="cancel" (click)="store.cancel()">Cancel</button></div>
      }
    } @else {
    @if (store.error(); as err) {
      <div class="error">{{ err }}</div>
    }
    @if (store.result(); as r) {
      <div class="grid-wrap" [class.dim]="store.loading()">
        <table class="grid">
          <thead>
            <tr>
              <th class="act"></th>
              @for (c of r.columns; track c.name) {
                <th (click)="store.sortBy(c.name)" [title]="c.typeName + ' — click to sort'">
                  <span class="cname">{{ c.name }}</span>
                  @if (sortMark(c.name); as mark) {
                    <span class="sort">{{ mark }}</span>
                  }
                  <span class="ctype">{{ c.typeName }}</span>
                </th>
              }
            </tr>
            <tr class="filters">
              <th class="act"></th>
              @for (c of r.columns; track c.name) {
                <th>
                  <input type="text" [value]="filterText(c.name)" placeholder="=" spellcheck="false"
                    (keydown.enter)="applyFilter(c.name, $any($event.target).value)"
                    [attr.aria-label]="'Filter ' + c.name + ' (Enter; empty clears, NULL for null)'" />
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of r.rows; track $index; let ri = $index) {
              <tr [class.menu-row]="rowMenu()?.row === ri">
                <td class="act" (contextmenu)="openRowMenu($event, ri, null)">
                  @if (canRelate()) {
                    <button type="button" class="ref-in" (click)="showRelated(ri)" title="Show related data: this row and the rows linked to it">⇄</button>
                  }
                  @if (store.incoming().length) {
                    <button type="button" class="ref-in" (click)="openRowMenuAt($event, ri)" title="Rows that reference this row">↳</button>
                  }
                </td>
                @for (cell of row; track $index; let ci = $index) {
                  @let fk = fkAt(ci);
                  <td [class.null]="cell === null" [class.fk]="!!fk && cell !== null" [title]="cell ?? 'NULL'"
                    (click)="onCell(ri, ci, fk)" (contextmenu)="openRowMenu($event, ri, ci)">{{ cell ?? "NULL" }}</td>
                }
              </tr>
            } @empty {
              <tr><td class="none" [attr.colspan]="r.columns.length + 1">No rows{{ store.current()?.filters?.length ? " match the filters" : "" }}.</td></tr>
            }
          </tbody>
        </table>
      </div>
      <footer>
        <span>{{ range() }}</span>
        @if (r.truncatedCells) {
          <span class="muted">· {{ r.truncatedCells }} long values shortened</span>
        }
        <span class="spacer"></span>
        <span class="muted">click a value to copy it · underlined values follow the foreign key · right-click a row for more</span>
        <button type="button" (click)="store.page(-1)" [disabled]="!store.current()?.offset || store.loading()">‹ Prev</button>
        <button type="button" (click)="store.page(1)" [disabled]="!r.hasMore || store.loading()">Next ›</button>
      </footer>
    } @else if (store.loading()) {
      <div class="loading">Loading… <button type="button" class="cancel" (click)="store.cancel()">Cancel</button></div>
    }
    }
    @if (rowMenu(); as m) {
      @let rec = rowRecord(m.row);
      <div class="menu-scrim" (click)="rowMenu.set(null)" (contextmenu)="$event.preventDefault(); rowMenu.set(null)"></div>
      <div class="ref-menu" role="menu" [style.left.px]="m.x" [style.top.px]="m.y" [style.max-height.px]="m.maxH">
        @if (canRelate()) {
          <button type="button" role="menuitem" class="primary" (click)="showRelated(m.row)">⇄ Show related data</button>
        }
        @let outs = followable(rec);
        @if (outs.length) {
          <div class="ref-title">References</div>
          @for (ref of outs; track ref.id) {
            <button type="button" role="menuitem" (click)="followOutgoing(ref, rec)">
              <span>{{ short(ref.to.table) }} <span class="via">via {{ ref.from.fields.join(", ") }}</span></span>
              @if (ref.discovered) {
                <span class="disc">from queries</span>
              }
            </button>
          }
        }
        @if (store.incoming().length) {
          <div class="ref-title">Referenced by</div>
          @for (ref of store.incoming(); track ref.id) {
            <button type="button" role="menuitem" (click)="followIncoming(ref, rec)">
              {{ short(ref.from.table) }}.{{ ref.from.fields.join(", ") }}
              @if (ref.discovered) {
                <span class="disc">from queries</span>
              }
            </button>
          }
        }
        <div class="sep-line"></div>
        @if (m.col !== null && cellValue(m.row, m.col) !== null) {
          <button type="button" role="menuitem" (click)="copyCell(m.row, m.col)">Copy value</button>
        }
        <button type="button" role="menuitem" (click)="copyRow(m.row)">Copy row as JSON</button>
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: flex; flex-direction: column; flex: none; min-height: 120px; background: var(--panel);
      border-top: 1px solid var(--border); font-size: 12px; }
    .resize { position: absolute; left: 0; right: 0; top: -4px; height: 8px; cursor: row-resize; z-index: 2; }
    header { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--border); flex: none; }
    .crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; overflow-x: auto; white-space: nowrap; }
    .crumbs button { font: inherit; font-size: 12px; border: 0; background: none; color: var(--accent); cursor: pointer;
      padding: 2px 5px; border-radius: 5px; font-family: var(--mono); }
    .crumbs button:hover:not(:disabled) { background: var(--hover); }
    .crumbs button.current { color: var(--text); font-weight: 600; cursor: default; }
    .sep { color: var(--text-muted); }
    .meta { flex: none; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .modes { display: flex; gap: 2px; padding: 2px; background: var(--hover); border-radius: 7px; flex: none; }
    .modes button { font: inherit; font-size: 11.5px; border: 0; background: transparent; color: var(--text-muted); padding: 2px 9px;
      border-radius: 5px; cursor: pointer; }
    .modes button.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: var(--shadow-sm); }
    .q-title { font-weight: 600; font-size: 12px; padding-left: 5px; }
    .modes button:disabled { opacity: 0.45; cursor: default; }
    .reveal { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; flex: none; }
    app-profile-view.dim { opacity: 0.6; }
    .icon { border: 0; background: none; color: var(--text-muted); font-size: 15px; width: 26px; height: 24px; border-radius: 5px; cursor: pointer; }
    .icon:hover:not(:disabled) { background: var(--hover); color: var(--text); }
    .error { padding: 8px 12px; color: var(--danger); background: var(--danger-soft); }
    .loading { padding: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 10px; }
    .cancel { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 6px; padding: 2px 9px; cursor: pointer; }
    .grid-wrap { flex: 1; min-height: 0; overflow: auto; }
    .grid-wrap.dim { opacity: 0.6; }
    table { border-collapse: separate; border-spacing: 0; font-family: var(--mono); font-size: 11.5px; }
    th, td { padding: 3px 8px; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); text-align: left;
      white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
    thead th { position: sticky; top: 0; z-index: 1; background: var(--panel-2); font-family: var(--font); cursor: pointer; }
    thead tr.filters th { top: 37px; padding: 2px 4px; cursor: default; }
    .cname { font-weight: 600; font-size: 12px; }
    .ctype { display: block; font-size: 10.5px; color: var(--text-muted); font-family: var(--mono); font-weight: 400; }
    .sort { margin-left: 4px; color: var(--accent); }
    .filters input { width: 100%; min-width: 60px; box-sizing: border-box; font: inherit; font-size: 11px; font-family: var(--mono);
      border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; background: var(--input-bg); color: var(--text); }
    td { cursor: copy; }
    td.null { color: var(--text-muted); font-style: italic; }
    td.fk { color: var(--accent); text-decoration: underline; text-decoration-style: dotted; cursor: pointer; }
    td.act, th.act { width: 44px; min-width: 44px; padding: 0 2px; text-align: center; cursor: default; }
    .ref-in { border: 0; background: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 0 3px; }
    tbody tr:hover td, tbody tr.menu-row td { background: var(--hover); }
    .reopen { flex: none; font: inherit; font-size: 11.5px; border: 1px solid var(--accent); background: transparent; color: var(--accent);
      border-radius: 6px; padding: 1px 8px; cursor: pointer; }
    .reopen:hover { background: var(--hover); }
    td.none { color: var(--text-muted); font-family: var(--font); cursor: default; padding: 10px; }
    footer { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-top: 1px solid var(--border); flex: none; }
    footer button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 6px; padding: 2px 9px; cursor: pointer; }
    footer button:disabled { opacity: 0.5; cursor: default; }
    .spacer { flex: 1; }
    .muted { color: var(--text-muted); }
    .menu-scrim { position: fixed; inset: 0; z-index: 9; }
    .ref-menu { position: fixed; z-index: 10; min-width: 220px; max-width: 360px; padding: 4px; background: var(--panel); border: 1px solid var(--border);
      border-radius: 8px; box-shadow: var(--shadow-md); overflow-y: auto; }
    .ref-menu button.primary { font-family: var(--font); font-weight: 600; color: var(--accent); }
    .via { color: var(--text-muted); font-size: 11px; }
    .sep-line { height: 1px; margin: 4px 2px; background: var(--border); }
    .ref-title { padding: 4px 8px; font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; }
    .ref-menu button { display: flex; justify-content: space-between; gap: 10px; width: 100%; font: inherit; font-family: var(--mono);
      font-size: 12px; text-align: left; border: 0; background: none; color: var(--text); padding: 5px 8px; border-radius: 5px; cursor: pointer; }
    .ref-menu button:hover { background: var(--hover); }
    .disc { font-family: var(--font); font-size: 10.5px; color: #d97706; }
  `,
})
export class DataDrawerComponent {
  protected readonly store = inject(BrowserStore);
  protected readonly rowGraph = inject(RowGraphStore);
  private readonly workspace = inject(WorkspaceStore);
  protected readonly height = signal(readHeight());
  /** Row menu (right-click, or the ↳ button): `col` is the clicked column, if any. */
  protected readonly rowMenu = signal<{ x: number; y: number; maxH: number; row: number; col: number | null } | null>(null);
  protected readonly short = displayTable;
  /** The current table has relationships, so its rows can be shown on the related-data map. */
  protected readonly canRelate = computed(() => this.store.outgoing().length + this.store.incoming().length > 0);

  /** Column index → outgoing relationship it starts (first column of single/composite keys). */
  private readonly fkByColumn = computed(() => {
    const r = this.store.result();
    const map = new Map<number, VRef>();
    if (!r) return map;
    for (const ref of this.store.outgoing()) {
      const i = r.columns.findIndex((c) => c.name === ref.from.fields[0]);
      if (i >= 0 && !map.has(i)) map.set(i, ref);
    }
    return map;
  });

  protected readonly reveal = signal(false);
  private readonly query = inject(QueryStore);

  /** Query tab: starts from the table being browsed, if the query is empty. */
  protected openQuery(): void {
    const id = this.store.current()?.tableId;
    if (id && !this.query.chosen().length) this.query.add(id);
    else this.store.setMode("query");
  }
  protected readonly profile = computed(() => {
    const id = this.store.current()?.tableId;
    return id ? (this.store.profiles().get(id) ?? null) : null;
  });
  protected readonly hasPii = computed(() => !!this.profile()?.columns.some((c) => c.pii));

  protected readonly meta = computed(() => {
    if (this.store.mode() === "profile") {
      const p = this.profile();
      if (!p) return "";
      const of = p.sampled ? ` of ~${Math.round(p.rowEstimate).toLocaleString("en-US")}` : "";
      return `${p.sampleSize.toLocaleString("en-US")}${of} rows · ${p.sampled ? p.method : "whole table"} · ${p.elapsedMs} ms`;
    }
    const r = this.store.result();
    if (!r) return "";
    return `~${Math.round(r.rowEstimate).toLocaleString("en-US")} rows · ${r.elapsedMs} ms`;
  });

  protected readonly range = computed(() => {
    const r = this.store.result();
    const offset = this.store.current()?.offset ?? 0;
    if (!r || r.rows.length === 0) return "0 rows";
    return `rows ${offset + 1}–${offset + r.rows.length}${r.hasMore ? "" : " (end)"}`;
  });

  protected label(loc: BrowseLocation): string {
    const filters = loc.filters.map((f) => `${f.column}=${f.value ?? "NULL"}`).join(", ");
    return `${displayTable(loc.tableId)}${filters ? ` [${filters}]` : ""}`;
  }

  protected sortMark(column: string): string | null {
    const o = this.store.current()?.orderBy;
    if (o?.column === column) return o.desc ? "▼" : "▲";
    return !o && this.store.result()?.orderedBy.includes(column) ? "·" : null;
  }

  protected filterText(column: string): string {
    const f = this.store.current()?.filters.find((x) => x.column === column);
    return f ? (f.value ?? "NULL") : "";
  }

  protected applyFilter(column: string, text: string): void {
    const t = text.trim();
    this.store.setFilter(column, t === "" ? undefined : t.toUpperCase() === "NULL" ? null : t);
  }

  protected fkAt(index: number): VRef | null {
    return this.fkByColumn().get(index) ?? null;
  }

  protected rowRecord(index: number): Record<string, string | null> {
    const r = this.store.result();
    const row = r?.rows[index] ?? [];
    return Object.fromEntries((r?.columns ?? []).map((c, i) => [c.name, row[i] ?? null]));
  }

  protected cellValue(row: number, col: number): string | null {
    return this.store.result()?.rows[row]?.[col] ?? null;
  }

  /** Outgoing relationships this row can follow (no NULL in its key). */
  protected followable(row: Record<string, string | null>): VRef[] {
    return this.store.outgoing().filter((ref) => ref.from.fields.every((f) => row[f] != null));
  }

  protected showRelated(rowIndex: number): void {
    this.rowMenu.set(null);
    const r = this.store.result();
    const tableId = this.store.current()?.tableId;
    const row = r?.rows[rowIndex];
    if (!r || !tableId || !row) return;
    this.rowGraph.show(tableId, r.columns.map((c) => c.name), row);
  }

  protected openRowMenu(event: MouseEvent, row: number, col: number | null): void {
    event.preventDefault();
    this.placeMenu(event.clientX, event.clientY, row, col);
  }

  /** The ↳ button opens the same menu next to it. */
  protected openRowMenuAt(event: MouseEvent, row: number): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.placeMenu(rect.right + 4, rect.top, row, null);
  }

  private placeMenu(x: number, y: number, row: number, col: number | null): void {
    const width = 300;
    const items = 3 + this.store.outgoing().length + this.store.incoming().length;
    const wanted = Math.min(window.innerHeight - 16, 24 + items * 28);
    this.rowMenu.set({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - wanted - 8)),
      maxH: window.innerHeight - 16,
      row,
      col,
    });
  }

  protected followOutgoing(ref: VRef, row: Record<string, string | null>): void {
    this.rowMenu.set(null);
    this.store.followOutgoing(ref, row);
  }

  protected copyCell(row: number, col: number): void {
    this.rowMenu.set(null);
    const value = this.cellValue(row, col);
    if (value !== null) void navigator.clipboard?.writeText(value).then(() => this.workspace.flash("Value copied"));
  }

  protected copyRow(row: number): void {
    this.rowMenu.set(null);
    const json = JSON.stringify(this.rowRecord(row), null, 2);
    void navigator.clipboard?.writeText(json).then(() => this.workspace.flash("Row copied as JSON"));
  }

  protected onCell(rowIndex: number, colIndex: number, fk: VRef | null): void {
    const value = this.store.result()?.rows[rowIndex]?.[colIndex] ?? null;
    if (fk && value !== null) {
      this.store.followOutgoing(fk, this.rowRecord(rowIndex));
    } else if (value !== null) {
      void navigator.clipboard?.writeText(value).then(() => this.workspace.flash("Value copied"));
    }
  }

  protected followIncoming(ref: VRef, row: Record<string, string | null>): void {
    this.rowMenu.set(null);
    this.store.followIncoming(ref, row);
  }

  protected startResize(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startH = this.height();
    const move = (e: PointerEvent) => this.height.set(Math.round(Math.min(window.innerHeight * 0.75, Math.max(140, startH - (e.clientY - startY)))));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(this.height()));
      } catch {
        /* best-effort */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }
}

