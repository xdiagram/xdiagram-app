import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";

import { WorkspaceStore } from "../state/workspace.store";
import type { VTable } from "../diagram/view-model";

interface SchemaGroup {
  schema: string;
  tables: VTable[];
  hiddenCount: number;
}

@Component({
  selector: "app-table-list",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="title">Tables</span>
      <span class="count">{{ visibleCount() }}/{{ store.view().tables.length }}</span>
    </div>
    <div class="search">
      <input type="search" placeholder="Filter tables…" [value]="query()" (input)="query.set($any($event.target).value)"
        spellcheck="false" aria-label="Filter tables" />
    </div>
    <div class="bulk">
      <button type="button" (click)="setAll(false)">Show all</button>
      <button type="button" (click)="setAll(true)">Hide all</button>
    </div>
    <div class="list">
      @for (g of groups(); track g.schema) {
        <div class="schema">
          <label class="schema-row" [title]="'Show or hide every table in ' + g.schema">
            <input type="checkbox" [checked]="g.hiddenCount === 0" [indeterminate]="g.hiddenCount > 0 && g.hiddenCount < g.tables.length"
              (change)="setGroup(g, !$any($event.target).checked)" />
            <span class="schema-name">{{ g.schema }}</span>
            <span class="count">{{ g.tables.length }}</span>
          </label>
          @for (t of g.tables; track t.id) {
            <div class="table-row" [class.off]="store.hidden().has(t.id)">
              <input type="checkbox" [checked]="!store.hidden().has(t.id)" (change)="store.toggleHidden(t.id)"
                [attr.aria-label]="'Show ' + t.name" />
              <button type="button" class="name" (click)="focus(t)" [title]="'Show ' + t.name + ' in the diagram'">
                {{ t.name }}
              </button>
              <span class="fields">{{ t.fields.length }}</span>
            </div>
          }
        </div>
      } @empty {
        <p class="none">{{ store.view().tables.length ? "No tables match." : "No tables." }}</p>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
    .head { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 12px;
      border-bottom: 1px solid var(--border); font-size: 12px; flex: none; }
    .title { font-weight: 600; letter-spacing: 0.04em; color: var(--text-muted); }
    .count { font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .search { padding: 8px 10px 4px; }
    .search input { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; color: var(--text);
      background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
    .bulk { display: flex; gap: 6px; padding: 4px 10px 8px; }
    .bulk button { flex: 1; font: inherit; font-size: 11.5px; border: 1px solid var(--border); background: transparent;
      color: var(--text); border-radius: 6px; padding: 4px; cursor: pointer; }
    .bulk button:hover { background: var(--hover); }
    .list { overflow: auto; flex: 1; padding: 0 6px 12px; }
    .schema { margin-bottom: 6px; }
    .schema-row { display: flex; align-items: center; gap: 6px; padding: 5px 6px; font-size: 12px; font-weight: 600;
      color: var(--text-muted); cursor: pointer; }
    .schema-name { flex: 1; }
    .table-row { display: flex; align-items: center; gap: 6px; padding: 1px 6px 1px 18px; border-radius: 6px; }
    .table-row:hover { background: var(--hover); }
    .table-row.off .name { color: var(--text-muted); text-decoration: line-through; }
    .name { flex: 1; min-width: 0; text-align: left; border: 0; background: none; color: var(--text); font: inherit;
      font-size: 12.5px; padding: 4px 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fields { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .none { font-size: 12.5px; color: var(--text-muted); padding: 8px; }
    input[type="checkbox"] { margin: 0; accent-color: var(--accent); }
  `,
})
export class TableListComponent {
  protected readonly store = inject(WorkspaceStore);
  protected readonly query = signal("");

  protected readonly visibleCount = computed(() => {
    const hidden = this.store.hidden();
    return this.store.view().tables.filter((t) => !hidden.has(t.id)).length;
  });

  protected readonly groups = computed<SchemaGroup[]>(() => {
    const q = this.query().trim().toLowerCase();
    const hidden = this.store.hidden();
    const bySchema = new Map<string, VTable[]>();
    for (const t of this.store.view().tables) {
      if (q && !t.id.toLowerCase().includes(q)) continue;
      const list = bySchema.get(t.schema) ?? [];
      list.push(t);
      bySchema.set(t.schema, list);
    }
    return [...bySchema.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([schema, tables]) => ({
        schema,
        tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
        hiddenCount: tables.filter((t) => hidden.has(t.id)).length,
      }));
  });

  protected setAll(hidden: boolean): void {
    const ids = this.groups().flatMap((g) => g.tables.map((t) => t.id));
    this.store.setHidden(ids, hidden);
  }

  protected setGroup(g: SchemaGroup, hidden: boolean): void {
    this.store.setHidden(
      g.tables.map((t) => t.id),
      hidden,
    );
  }

  protected focus(t: VTable): void {
    if (this.store.hidden().has(t.id)) this.store.toggleHidden(t.id);
    setTimeout(() => this.store.diagram?.focusTable(t.id), 0);
  }
}
