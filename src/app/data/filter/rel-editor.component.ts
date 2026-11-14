import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from "@angular/core";

import { type BrowseColumn, type Engine, errorMessage } from "../../core/tauri-api.service";
import { kindOf } from "../../filter/kinds";
import { type CondNode, type CountOp, type GroupNode, newId, type Op, type Quant, type RelNode } from "../../filter/model";
import { opsFor } from "../../filter/operators";
import { nodeText } from "../../filter/printer";
import type { RelOption } from "../../filter/relations";
import { ConditionRowComponent } from "./condition-row.component";

const QUANTS: { value: string; label: string }[] = [
  { value: "some", label: "have" },
  { value: "none", label: "have no" },
  { value: "ge", label: "have at least" },
  { value: "le", label: "have at most" },
  { value: "eq", label: "have exactly" },
  { value: "gt", label: "have more than" },
  { value: "lt", label: "have fewer than" },
];

/**
 * Edits a related-row condition: how many related rows (some, none, a number), which
 * relationship, and conditions on the related rows (only those count).
 */
@Component({
  selector: "app-rel-editor",
  imports: [ConditionRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      Rows that
      <select [value]="quantValue()" (change)="setQuant($any($event.target).value)" aria-label="How many related rows">
        @for (q of quants; track q.value) {
          <option [value]="q.value" [selected]="q.value === quantValue()">{{ q.label }}</option>
        }
      </select>
      @if (isCount()) {
        <input class="n" type="number" min="0" max="999999999" [value]="countN()" (input)="setN($any($event.target).value)" aria-label="Number of related rows" />
      }
      <select class="rel" [value]="optionIndex()" (change)="setOption(+$any($event.target).value)" aria-label="Related table">
        @for (o of options(); track o.label; let i = $index) {
          <option [value]="i" [selected]="i === optionIndex()">{{ o.label }}{{ o.label !== short(o.tableId) ? " (" + short(o.tableId) + ")" : "" }}</option>
        }
      </select>
    </div>
    <div class="hint">{{ how() }}</div>
    @if (columnsError(); as err) {
      <div class="msg">{{ err }}</div>
    } @else if (columns().length) {
      @if (conds().length) {
        <div class="sub">counting only related rows where all of:</div>
      }
      @for (c of conds(); track c.id) {
        <div class="item">
          <app-condition-row [columns]="columns()" [engine]="engine()" [node]="c" (changed)="setCond($event)" (submit)="submit.emit()" />
          <button type="button" class="x" (click)="removeCond(c.id)" aria-label="Remove condition">×</button>
        </div>
      }
      @for (other of otherItems(); track other.id) {
        <div class="item"><span class="nested">{{ text(other) }}</span></div>
      }
      <button type="button" class="add" (click)="addCond()">+ Condition on {{ short(node().schema + "." + node().table) }}</button>
    } @else {
      <div class="sub">Reading the columns of {{ node().table }}…</div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .head { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    select, input { font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 5px; padding: 3px 5px; background: var(--input-bg); color: var(--text); }
    .n { width: 70px; }
    .rel { max-width: 220px; font-family: var(--mono); }
    .hint, .sub { color: var(--text-muted); font-size: 11.5px; }
    .msg { color: var(--danger); font-size: 11.5px; }
    .item { display: flex; align-items: flex-start; gap: 4px; padding-left: 10px; border-left: 2px solid var(--border); }
    .item app-condition-row { flex: 1; }
    .nested { font-family: var(--mono); color: var(--text-muted); }
    .x { border: 0; background: none; color: var(--text-muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 8px; }
    .x:hover { color: var(--text); background: var(--hover); }
    .add { align-self: flex-start; font: inherit; font-size: 12px; border: 1px dashed var(--border); background: none; color: var(--accent); border-radius: 14px;
      padding: 2px 9px; cursor: pointer; }
  `,
})
export class RelEditorComponent {
  readonly options = input.required<RelOption[]>();
  readonly node = input.required<RelNode>();
  readonly engine = input<Engine | null>(null);
  /** Columns of a related table (`schema.table`). */
  readonly columnsOf = input.required<(tableId: string) => Promise<BrowseColumn[]>>();
  readonly changed = output<RelNode>();
  /** Enter in a value box. */
  readonly submit = output<void>();

  protected readonly quants = QUANTS;
  protected readonly text = nodeText;
  protected readonly columns = signal<BrowseColumn[]>([]);
  protected readonly columnsError = signal<string | null>(null);

  protected readonly optionIndex = computed(() => {
    const n = this.node();
    const i = this.options().findIndex((o) => o.schema === n.schema && o.table === n.table && JSON.stringify(o.on) === JSON.stringify(n.on));
    return Math.max(0, i);
  });
  protected readonly quantValue = computed(() => {
    const q = this.node().quant;
    return typeof q === "string" ? q : q.count.op;
  });
  protected readonly isCount = computed(() => typeof this.node().quant === "object");
  protected readonly countN = computed(() => {
    const q = this.node().quant;
    return typeof q === "object" ? q.count.n : 1;
  });
  /** The conditions editable here (top-level ones of the related-row filter). */
  protected readonly conds = computed(() => (this.node().filter?.items ?? []).filter((i): i is CondNode => i.t === "cond"));
  /** Groups and deeper related-row conditions (from the text box): shown, edited as text. */
  protected readonly otherItems = computed(() => (this.node().filter?.items ?? []).filter((i) => i.t !== "cond"));
  protected readonly how = computed(() => {
    const o = this.options()[this.optionIndex()];
    if (!o) return "";
    const pairs = o.on.map(([l, r]) => `${o.table}.${r} = ${l}`).join(" and ");
    return o.direction === "children" ? `Rows of ${o.table} pointing here (${pairs})` : `The ${o.table} row this one points at (${pairs})`;
  });

  /** The related table: its columns load when it changes (not on every edit of a condition). */
  private readonly tableId = computed(() => `${this.node().schema}.${this.node().table}`);

  constructor() {
    effect(() => {
      const tableId = this.tableId();
      const load = this.columnsOf();
      untracked(() => {
        this.columns.set([]);
        this.columnsError.set(null);
        load(tableId).then(
          (cols) => {
            if (this.tableId() === tableId) this.columns.set(cols);
          },
          (err) => this.columnsError.set(`Could not read the columns of ${this.short(tableId)}: ${errorMessage(err)}`),
        );
      });
    });
  }

  protected short(id: string): string {
    return id.replace(/^public\./, "");
  }

  private emit(patch: Partial<RelNode>): void {
    this.changed.emit({ ...this.node(), ...patch });
  }

  protected setQuant(value: string): void {
    const quant: Quant = value === "some" || value === "none" ? value : { count: { op: value as CountOp, n: this.countN() } };
    this.emit({ quant });
  }

  protected setN(text: string): void {
    const q = this.node().quant;
    if (typeof q !== "object") return;
    const n = Math.max(0, Math.min(999_999_999, Math.round(Number(text) || 0)));
    this.emit({ quant: { count: { op: q.count.op, n } } });
  }

  protected setOption(i: number): void {
    const o = this.options()[i];
    if (!o) return;
    // Another table: its conditions no longer apply.
    const same = o.schema === this.node().schema && o.table === this.node().table;
    this.emit({ label: o.label, schema: o.schema, table: o.table, on: o.on, ...(same ? {} : { filter: undefined }) });
  }

  private setItems(items: GroupNode["items"]): void {
    const base: GroupNode = this.node().filter ?? { t: "group", id: newId(), op: "and", items: [] };
    this.emit({ filter: items.length ? { ...base, items } : undefined });
  }

  protected addCond(): void {
    const col = this.columns()[0];
    if (!col) return;
    const op = opsFor(kindOf(col, this.engine()), this.engine(), col.nullable ?? true)[0].op as Op;
    this.setItems([...(this.node().filter?.items ?? []), { t: "cond", id: newId(), column: col.name, op, args: [""] }]);
  }

  protected setCond(c: CondNode): void {
    this.setItems((this.node().filter?.items ?? []).map((i) => (i.id === c.id ? c : i)));
  }

  protected removeCond(id: string): void {
    this.setItems((this.node().filter?.items ?? []).filter((i) => i.id !== id));
  }
}
