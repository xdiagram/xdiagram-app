import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from "@angular/core";

import { type BrowseColumn, type ValuesResult, errorMessage } from "../../core/tauri-api.service";
import { facetSelection, setFacet } from "../../filter/facets";
import type { GroupNode } from "../../filter/model";
import { isCancelled } from "../../state/workspace.store";

/** (column, condition to leave out, how many values) → that column's values with counts among the matching rows. */
export type FacetSource = (column: string, exclude: string | null, limit: number) => Promise<ValuesResult>;

type FacetState = { s: "loading" } | { s: "done"; r: ValuesResult } | { s: "error"; message: string };

const nf = new Intl.NumberFormat();

/**
 * Facets beside the grid: for a few columns, their most frequent values among the rows the rest
 * of the filter matches, with counts. Ticking values filters the column to them (the counts of a
 * column leave out its own condition, so its other values stay visible).
 */
@Component({
  selector: "app-facet-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (col of facets(); track col) {
      @let sel = selection(col);
      @let st = states().get(col);
      <section>
        <header>
          <b [title]="col">{{ col }}</b>
          @if (sel.values.length || sel.nul) {
            <button type="button" class="clear" (click)="clear(col)" [attr.aria-label]="'Clear ' + col">clear</button>
          } @else if (sel.node) {
            <span class="other" title="This column has another condition: ticking a value replaces it">filtered</span>
          }
          <button type="button" class="x" (click)="removeFacet(col)" [attr.aria-label]="'Remove the facet ' + col" title="Remove this facet">×</button>
        </header>
        @switch (st?.s) {
          @case ("done") {
            @if (st?.s === "done") {
              @for (v of st.r.values; track v.value) {
                <label class="fv" [class.cut]="v.cut" [title]="v.cut ? 'Too long to filter by' : (v.value ?? 'NULL')">
                  <input type="checkbox" [checked]="isTicked(sel, v.value)" [disabled]="v.cut" (change)="toggle(col, v.value, $any($event.target).checked)" />
                  <span class="val" [class.null]="v.value === null">{{ v.value ?? "NULL" }}</span>
                  <span class="n">{{ fmt(v.count) }}</span>
                </label>
              } @empty {
                <div class="note">No matching rows</div>
              }
              @if (st.r.more) {
                <button type="button" class="more" (click)="showMore(col)">{{ (limits().get(col) ?? 8) < 30 ? "More values" : "Use the editor to find others" }}</button>
              }
              @if (st.r.sampled) {
                <div class="note">in the first {{ fmt(st.r.rows) }} rows</div>
              }
              @if (st.r.timedOut) {
                <div class="note">counting took too long</div>
              }
            }
          }
          @case ("error") {
            @if (st?.s === "error") {
              <div class="note bad">{{ st.message }}</div>
            }
          }
          @default {
            <div class="note">counting…</div>
          }
        }
      </section>
    } @empty {
      <div class="note">No facets yet: add a column below.</div>
    }
    @if (addable().length) {
      <select class="add" (change)="addFacet($any($event.target))" aria-label="Add a facet">
        <option value="">+ Facet…</option>
        @for (c of addable(); track c.name) {
          <option [value]="c.name">{{ c.name }}</option>
        }
      </select>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 10px; width: 210px; flex: none; overflow: auto; padding: 8px; border-right: 1px solid var(--border);
      font-size: 12px; background: var(--panel-2); }
    section { display: flex; flex-direction: column; gap: 1px; }
    header { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
    header b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11.5px; }
    .clear, .more { font: inherit; font-size: 11px; border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0 2px; }
    .more { align-self: flex-start; }
    .other { color: var(--text-muted); font-size: 11px; }
    .x { border: 0; background: none; color: var(--text-muted); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 3px; border-radius: 6px; }
    .x:hover { color: var(--text); background: var(--hover); }
    .fv { display: flex; align-items: center; gap: 5px; padding: 1px 2px; border-radius: 4px; cursor: pointer; }
    .fv:hover { background: var(--hover); }
    .fv.cut { opacity: 0.55; cursor: default; }
    .fv input { margin: 0; }
    .val { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11.5px; }
    .val.null { font-style: italic; color: var(--text-muted); }
    .n { color: var(--text-muted); font-variant-numeric: tabular-nums; font-size: 11px; }
    .note { color: var(--text-muted); font-size: 11px; }
    .note.bad { color: var(--danger); }
    .add { font: inherit; font-size: 12px; border: 1px dashed var(--border); border-radius: 6px; padding: 2px 4px; background: none; color: var(--accent); }
  `,
})
export class FacetPanelComponent {
  readonly columns = input.required<BrowseColumn[]>();
  readonly tree = input.required<GroupNode>();
  /** The columns shown as facets. */
  readonly facets = input.required<string[]>();
  readonly source = input.required<FacetSource>();
  readonly treeChange = output<GroupNode>();
  readonly facetsChange = output<string[]>();

  protected readonly states = signal<ReadonlyMap<string, FacetState>>(new Map());
  protected readonly limits = signal<ReadonlyMap<string, number>>(new Map());
  protected readonly addable = computed(() => this.columns().filter((c) => !this.facets().includes(c.name)));

  constructor() {
    // Counts follow the filter: each facet asks again (cached per filter by the store).
    effect(() => {
      const tree = this.tree();
      const facets = this.facets();
      const limits = this.limits();
      untracked(() => facets.forEach((col) => void this.load(col, tree, limits.get(col) ?? 8)));
    });
  }

  private async load(col: string, tree: GroupNode, limit: number): Promise<void> {
    const exclude = facetSelection(tree, col).node?.id ?? null;
    const set = (s: FacetState) => this.states.update((m) => new Map(m).set(col, s));
    if (!this.states().get(col)) set({ s: "loading" });
    try {
      const r = await this.source()(col, exclude, limit);
      if (this.tree() === tree) set({ s: "done", r });
    } catch (err) {
      if (this.tree() === tree && !isCancelled(err)) set({ s: "error", message: errorMessage(err) });
    }
  }

  protected selection(col: string) {
    return facetSelection(this.tree(), col);
  }

  protected isTicked(sel: ReturnType<typeof facetSelection>, value: string | null): boolean {
    return value === null ? sel.nul : sel.values.includes(value);
  }

  protected toggle(col: string, value: string | null, on: boolean): void {
    const sel = facetSelection(this.tree(), col);
    const values = value === null ? sel.values : on ? [...sel.values, value] : sel.values.filter((v) => v !== value);
    const nul = value === null ? on : sel.nul;
    this.treeChange.emit(setFacet(this.tree(), col, values, nul));
  }

  protected clear(col: string): void {
    this.treeChange.emit(setFacet(this.tree(), col, [], false));
  }

  protected showMore(col: string): void {
    this.limits.update((m) => new Map(m).set(col, 30));
  }

  protected removeFacet(col: string): void {
    this.facetsChange.emit(this.facets().filter((f) => f !== col));
  }

  protected addFacet(select: HTMLSelectElement): void {
    const col = select.value;
    select.value = "";
    if (col) this.facetsChange.emit([...this.facets(), col]);
  }

  protected fmt(n: number): string {
    return nf.format(n);
  }
}
