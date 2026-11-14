import { ChangeDetectionStrategy, Component, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from "@angular/core";

import { errorMessage } from "../core/tauri-api.service";
import { displayTable, type VRef } from "../diagram/view-model";
import { printExpression } from "../filter/expression";
import { QUICK_HELP } from "../filter/help";
import { highlightTerms, segments } from "../filter/highlight";
import { isOrderedKind } from "../filter/kinds";
import { newId, type Op } from "../filter/model";
import { printQuick } from "../filter/quick-syntax";
import { nodeText } from "../filter/printer";
import { hasActive, singleColumn } from "../filter/tree";
import { BrowseLocation, BrowserStore } from "../state/browser.store";
import { ExpressionBoxComponent } from "./filter/expression-box.component";
import { FilterBarComponent } from "./filter/filter-bar.component";
import type { FkSource, SavedSource, ValueSource } from "../filter/pickers";
import { ProfileViewComponent } from "./profile-view.component";
import { QueryViewComponent } from "./query-view.component";
import { QueryStore } from "../state/query.store";
import { RowGraphStore } from "../state/row-graph.store";
import { WorkspaceStore } from "../state/workspace.store";

const HEIGHT_KEY = "xdiagram.dataDrawerHeight";
const TEXT_KEY = "xdiagram.filterTextOpen";

function readTextOpen(): boolean {
  try {
    return localStorage.getItem(TEXT_KEY) === "1";
  } catch {
    return false;
  }
}

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
  imports: [ProfileViewComponent, QueryViewComponent, FilterBarComponent, ExpressionBoxComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[style.height.px]": "height()", "(document:keydown.escape)": "rowMenu.set(null); colMenu.set(null); picked.set(null)" },
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
    @if (store.current(); as cur) {
      @if (store.columns().length) {
        <app-filter-bar [columns]="store.columns()" [engine]="store.engine()" [tree]="cur.where" [issues]="store.issues()"
          (treeChange)="store.setWhere($event)" [textOpen]="textOpen()" (textToggle)="toggleText()" [values]="valueSource" [fk]="fkSource"
          [saved]="savedSource" [sort]="cur.sort" [canCopy]="true" (copy)="copyFilter($event)" />
        @if (textOpen()) {
          <app-expression-box [columns]="store.columns()" [engine]="store.engine()" [tree]="cur.where" [history]="store.expressionHistory()"
            [values]="knownValues" (treeChange)="store.setWhere($event)" (used)="store.rememberExpression($event)" />
        }
      }
    }
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
                <th (click)="store.toggleSort(c.name, $event.shiftKey)" (contextmenu)="openColMenu($event, c.name)"
                  [title]="c.typeName + ' — click to sort, Shift+click to sort by several columns, right-click for more'">
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
                  @let ft = filterText(c.name);
                  <input type="text" [value]="ft ?? ''" [placeholder]="ft === null ? '(filtered)' : 'filter'" spellcheck="false"
                    [class.issue]="hasIssue(c.name)" [title]="quickHelp"
                    (keydown.enter)="applyFilter(c.name, $any($event.target).value)"
                    [attr.aria-label]="'Filter ' + c.name + ' (Enter applies; empty clears)'" />
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
                  <td [class.null]="cell === null" [class.fk]="!!fk && cell !== null && !isCut(ri, ci)" [class.cut]="isCut(ri, ci)"
                    [class.picked]="isPicked(ri, ci)"
                    [title]="isCut(ri, ci) ? 'Shortened: the full value has more than 4000 characters' : (cell ?? 'NULL')"
                    (click)="onCell($event, ri, ci, fk)" (contextmenu)="openRowMenu($event, ri, ci)">@if (marks()?.[ri]?.[ci]; as segs) {@for (s of segs; track $index) {<span [class.hit]="s.hit">{{ s.text }}</span>}} @else {<ng-container>{{ cell ?? "NULL" }}</ng-container>}</td>
                }
              </tr>
            } @empty {
              <tr><td class="none" [attr.colspan]="r.columns.length + 1">No rows{{ filtered() ? " match the filter" : "" }}.</td></tr>
            }
          </tbody>
        </table>
      </div>
      <footer>
        <span>{{ range() }}</span>
        @if (countText(); as ct) {
          <span class="count" [class.muted]="store.count().state !== 'done'">· {{ ct }}</span>
        }
        @if (r.truncatedCells) {
          <span class="muted">· {{ r.truncatedCells }} long values shortened</span>
        }
        @if (r.stableOrder === false) {
          <span class="muted" title="The table has no primary key: rows with equal sort values may move between pages">· order not unique</span>
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
        @let outs = followable(rec, m.row);
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
        @if (m.col !== null && !isCut(m.row, m.col)) {
          @let v = cellValue(m.row, m.col);
          @let col = columnName(m.col);
          <div class="ref-title">Filter by {{ col }}</div>
          @let picks = pickedValues(m.col);
          @if (picks.length > 1) {
            <button type="button" role="menuitem" (click)="filterBy(col, 'in', picks)">is one of the {{ picks.length }} picked values</button>
            <button type="button" role="menuitem" (click)="filterBy(col, 'notIn', picks)">is none of them</button>
          }
          @if (v === null) {
            <button type="button" role="menuitem" (click)="filterBy(col, 'isNull', [])">is null</button>
            <button type="button" role="menuitem" (click)="filterBy(col, 'notNull', [])">is not null</button>
          } @else {
            <button type="button" role="menuitem" (click)="filterBy(col, 'eq', [v])"><span>= <span class="v">{{ v }}</span></span></button>
            <button type="button" role="menuitem" (click)="filterBy(col, 'ne', [v])"><span>≠ <span class="v">{{ v }}</span></span></button>
            @if (ordered(m.col)) {
              <button type="button" role="menuitem" (click)="filterBy(col, 'lt', [v])"><span>&lt; <span class="v">{{ v }}</span></span></button>
              <button type="button" role="menuitem" (click)="filterBy(col, 'gt', [v])"><span>&gt; <span class="v">{{ v }}</span></span></button>
            }
          }
        }
        <div class="sep-line"></div>
        @if (m.col !== null && cellValue(m.row, m.col) !== null) {
          <button type="button" role="menuitem" (click)="copyCell(m.row, m.col)">Copy value</button>
        }
        <button type="button" role="menuitem" (click)="copyRow(m.row)">Copy row as JSON</button>
      </div>
    }
    @if (colMenu(); as cm) {
      <div class="menu-scrim" (click)="colMenu.set(null)" (contextmenu)="$event.preventDefault(); colMenu.set(null)"></div>
      <div class="ref-menu" role="menu" [style.left.px]="cm.x" [style.top.px]="cm.y">
        <div class="ref-title">{{ cm.column }}</div>
        <button type="button" role="menuitem" (click)="sortOnly(cm.column, false)">Sort ascending</button>
        <button type="button" role="menuitem" (click)="sortOnly(cm.column, true)">Sort descending</button>
        @if (sortKeys().length && !inSort(cm.column)) {
          <button type="button" role="menuitem" (click)="addSort(cm.column, false)">Then by this, ascending</button>
          <button type="button" role="menuitem" (click)="addSort(cm.column, true)">Then by this, descending</button>
        }
        @if (inSort(cm.column)) {
          <button type="button" role="menuitem" (click)="removeSort(cm.column)">Remove from the sort</button>
        }
        <div class="sep-line"></div>
        <button type="button" role="menuitem" (click)="filterColumn(cm)">Filter…</button>
        @if (filterText(cm.column) !== "") {
          <button type="button" role="menuitem" (click)="clearColumn(cm.column)">Clear this column's filter</button>
        }
        <button type="button" role="menuitem" (click)="copyName(cm.column)">Copy column name</button>
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
    .filters input.issue { border-color: var(--danger); }
    td.cut { color: var(--text-muted); }
    td.picked { outline: 2px solid var(--accent); outline-offset: -2px; }
    td .hit { background: var(--highlight); color: inherit; border-radius: 2px; }
    .ref-menu .v { color: var(--accent); }
    .count { font-variant-numeric: tabular-nums; }
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
  private readonly injector = inject(Injector);

  constructor() {
    // The box offers the expressions used before in this database.
    effect(() => {
      if (this.textOpen() && this.store.open()) untracked(() => void this.store.loadExpressionHistory());
    });
  }
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

  protected readonly quickHelp = QUICK_HELP;

  protected readonly filtered = computed(() => hasActive(this.store.current()?.where ?? null));

  /** The expression box under the filter bar (remembered on this computer). */
  protected readonly textOpen = signal(readTextOpen());
  private readonly exprBox = viewChild(ExpressionBoxComponent);
  protected readonly knownValues = (column: string) => this.store.knownValues(column);
  protected readonly valueSource: ValueSource = (column, search, exclude) => this.store.valueCounts(column, search, exclude);
  protected readonly savedSource: SavedSource = {
    list: () => this.store.savedFilters(),
    save: (name) => this.store.saveFilter(name),
    remove: (name) => this.store.deleteSavedFilter(name),
    apply: (filter) => this.store.applySavedFilter(filter),
  };
  protected readonly fkSource: FkSource = {
    target: (column) => this.store.fkTarget(column),
    rows: (column, search, label) => this.store.fkRows(column, search, label ?? null),
    setLabel: (column, label) => this.store.setFkLabel(column, label),
  };

  /** Copy menu of the filter bar: the filter as an expression, or the rows shown as SQL. */
  protected async copyFilter(what: "sql" | "expression"): Promise<void> {
    const where = this.store.current()?.where;
    if (!where) return;
    try {
      const text = what === "sql" ? await this.store.sqlText() : printExpression(where);
      await navigator.clipboard?.writeText(text);
      this.workspace.flash(what === "sql" ? "SQL copied" : "Filter copied as text");
    } catch (err) {
      this.workspace.flash(`Could not copy: ${errorMessage(err)}`);
    }
  }

  protected toggleText(): void {
    const open = !this.textOpen();
    this.textOpen.set(open);
    try {
      localStorage.setItem(TEXT_KEY, open ? "1" : "0");
    } catch {
      // Not kept: it opens closed next time.
    }
    if (open) afterNextRender(() => this.exprBox()?.focus(), { injector: this.injector });
  }

  /** Matched text per cell (searches everywhere, contains / starts / ends / equals in their column); null: plain. */
  protected readonly marks = computed(() => {
    const r = this.store.result();
    const { all, byColumn } = highlightTerms(this.store.current()?.where ?? null);
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

  protected label(loc: BrowseLocation): string {
    const filter = hasActive(loc.where) ? nodeText(loc.where) : "";
    const short = filter.length > 60 ? `${filter.slice(0, 59)}…` : filter;
    return `${displayTable(loc.tableId)}${short ? ` [${short}]` : ""}`;
  }

  /** ▲/▼ for sort keys (numbered when several), · for the key columns added as tie-breaker. */
  protected sortMark(column: string): string | null {
    const keys = this.store.current()?.sort ?? [];
    const i = keys.findIndex((k) => k.column === column);
    if (i >= 0) return `${keys[i].desc ? "▼" : "▲"}${keys.length > 1 ? i + 1 : ""}`;
    return this.store.result()?.sort?.some((s) => s.column === column && s.tie) ? "·" : null;
  }

  /** The column box text: its filter in quick syntax; null when it has one the box cannot show. */
  protected filterText(column: string): string | null {
    const where = this.store.current()?.where;
    if (!where) return "";
    const nodes = where.items.filter((n) => singleColumn(n) === column && !n.off);
    if (!nodes.length) return "";
    return nodes.length === 1 ? printQuick(nodes[0]) : null;
  }

  protected applyFilter(column: string, text: string): void {
    this.store.setQuick(column, text);
  }

  protected hasIssue(column: string): boolean {
    const where = this.store.current()?.where;
    const ids = new Set(this.store.issues().map((i) => i.node));
    return !!where && where.items.some((n) => singleColumn(n) === column && (ids.has(n.id) || (n.t === "group" && n.items.some((i) => ids.has(i.id)))));
  }

  protected readonly countText = computed(() => {
    const c = this.store.count();
    switch (c.state) {
      case "loading":
        return "counting…";
      case "done":
        return `${c.count.toLocaleString("en-US")}${c.capped ? "+" : ""} matching`;
      case "timedOut":
        return "count took too long";
      case "error":
        return "count failed";
      default:
        return "";
    }
  });

  private readonly cut = computed(() => new Set((this.store.result()?.truncatedAt ?? []).map(([r, c]) => `${r}:${c}`)));

  /** The value was shortened: it is not the real value, so it is never followed or filtered by. */
  protected isCut(row: number, col: number): boolean {
    return this.cut().has(`${row}:${col}`);
  }

  private rowHasCut(row: number, columns: string[]): boolean {
    const r = this.store.result();
    return !!r && columns.some((c) => this.isCut(row, r.columns.findIndex((x) => x.name === c)));
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

  /** Outgoing relationships this row can follow (no NULL, and no shortened value, in its key). */
  protected followable(row: Record<string, string | null>, index = -1): VRef[] {
    return this.store.outgoing().filter((ref) => ref.from.fields.every((f) => row[f] != null) && !this.rowHasCut(index, ref.from.fields));
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

  protected onCell(event: MouseEvent, rowIndex: number, colIndex: number, fk: VRef | null): void {
    // Ctrl/Cmd+click picks cells of one column, for "Filter by: is one of".
    if (event.ctrlKey || event.metaKey) {
      this.togglePick(rowIndex, colIndex);
      return;
    }
    this.picked.set(null);
    const value = this.store.result()?.rows[rowIndex]?.[colIndex] ?? null;
    if (fk && value !== null && !this.isCut(rowIndex, colIndex)) {
      this.store.followOutgoing(fk, this.rowRecord(rowIndex));
    } else if (value !== null) {
      void navigator.clipboard?.writeText(value).then(() => this.workspace.flash("Value copied"));
    }
  }

  /** Cells picked with Ctrl+click (one column at a time). */
  protected readonly picked = signal<{ col: number; rows: number[] } | null>(null);
  protected readonly colMenu = signal<{ x: number; y: number; column: string } | null>(null);
  private readonly bar = viewChild(FilterBarComponent);
  protected readonly sortKeys = computed(() => this.store.current()?.sort ?? []);

  private togglePick(row: number, col: number): void {
    if (this.isCut(row, col) || this.cellValue(row, col) === null) return;
    const p = this.picked();
    if (!p || p.col !== col) return this.picked.set({ col, rows: [row] });
    const rows = p.rows.includes(row) ? p.rows.filter((r) => r !== row) : [...p.rows, row];
    this.picked.set(rows.length ? { col, rows } : null);
  }

  protected isPicked(row: number, col: number): boolean {
    const p = this.picked();
    return !!p && p.col === col && p.rows.includes(row);
  }

  /** The distinct values of the picked cells of a column. */
  protected pickedValues(col: number): string[] {
    const p = this.picked();
    if (!p || p.col !== col) return [];
    return [...new Set(p.rows.map((r) => this.cellValue(r, col)).filter((v): v is string => v !== null))];
  }

  protected columnName(col: number): string {
    return this.store.result()?.columns[col]?.name ?? "";
  }

  protected ordered(col: number): boolean {
    return isOrderedKind(this.store.kinds().get(this.columnName(col)) ?? "other");
  }

  protected filterBy(column: string, op: Op, args: string[]): void {
    this.rowMenu.set(null);
    this.picked.set(null);
    this.store.addCondition({ t: "cond", id: newId(), column, op, args });
  }

  protected openColMenu(event: MouseEvent, column: string): void {
    event.preventDefault();
    this.colMenu.set({ x: Math.min(event.clientX, window.innerWidth - 240), y: Math.min(event.clientY, window.innerHeight - 260), column });
  }

  protected inSort(column: string): boolean {
    return this.sortKeys().some((k) => k.column === column);
  }

  protected sortOnly(column: string, desc: boolean): void {
    this.colMenu.set(null);
    this.store.setSort([{ column, desc }]);
  }

  protected addSort(column: string, desc: boolean): void {
    this.colMenu.set(null);
    this.store.setSort([...this.sortKeys(), { column, desc }]);
  }

  protected removeSort(column: string): void {
    this.colMenu.set(null);
    this.store.setSort(this.sortKeys().filter((k) => k.column !== column));
  }

  protected filterColumn(cm: { x: number; y: number; column: string }): void {
    this.colMenu.set(null);
    this.bar()?.openFor(cm.column, cm.x, cm.y);
  }

  protected clearColumn(column: string): void {
    this.colMenu.set(null);
    this.store.setQuick(column, "");
  }

  protected copyName(column: string): void {
    this.colMenu.set(null);
    void navigator.clipboard?.writeText(column).then(() => this.workspace.flash("Column name copied"));
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

