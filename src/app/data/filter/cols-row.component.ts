import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";

import type { BrowseColumn, ColKind, Engine } from "../../core/tauri-api.service";
import { comparableKinds, kindOf } from "../../filter/kinds";
import type { ColsNode, CondNode, CountOp } from "../../filter/model";
import { COLS_SYMBOL } from "../../filter/printer";

const OPS: CountOp[] = ["eq", "ne", "lt", "le", "gt", "ge"];

/** Edits one column compared with another of the same row (`ends_on < starts_on`). */
@Component({
  selector: "app-cols-row",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <select class="col" (change)="setLeft($any($event.target).value)" aria-label="Column">
      @for (c of columns(); track c.name) {
        <option [value]="c.name" [selected]="c.name === node().left">{{ c.name }}</option>
      }
    </select>
    <select class="op" (change)="setOp($any($event.target).value)" aria-label="Operator">
      @for (o of ops; track o) {
        <option [value]="o" [selected]="o === node().op">{{ symbol[o] }}</option>
      }
    </select>
    <select class="col right" (change)="setRight($any($event.target).value)" aria-label="Other column">
      @for (c of rightOptions(); track c.name) {
        <option [value]="c.name" [selected]="c.name === node().right">{{ c.name }}</option>
      }
    </select>
    <button type="button" class="pick" (click)="toValue.emit(asValue())" title="Compare with a value instead">vs value</button>
    @if (!rightOptions().length) {
      <div class="msg">No other column of a comparable type</div>
    } @else {
      <div class="hint">Rows where either is NULL do not match.</div>
    }
  `,
  styles: `
    :host { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; font-size: 12px; }
    select { font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 5px; padding: 3px 5px; background: var(--input-bg); color: var(--text);
      max-width: 170px; }
    .right { font-weight: 600; }
    .pick { font: inherit; font-size: 11.5px; border: 1px solid var(--border); background: none; color: var(--text-muted); border-radius: 5px; padding: 3px 7px; cursor: pointer; }
    .pick:hover { color: var(--accent); border-color: var(--accent); }
    .msg { flex-basis: 100%; color: var(--danger); font-size: 11.5px; }
    .hint { flex-basis: 100%; color: var(--text-muted); font-size: 11px; }
  `,
})
export class ColsRowComponent {
  readonly columns = input.required<BrowseColumn[]>();
  readonly engine = input<Engine | null>(null);
  readonly node = input.required<ColsNode>();
  readonly changed = output<ColsNode>();
  /** Back to a comparison with a value. */
  readonly toValue = output<CondNode>();

  protected readonly ops = OPS;
  protected readonly symbol = COLS_SYMBOL;

  private kind(name: string): ColKind {
    const c = this.columns().find((x) => x.name === name);
    return c ? kindOf(c, this.engine()) : "other";
  }

  /** The columns `left` compares with (not itself). */
  private comparableTo(left: string): BrowseColumn[] {
    const k = this.kind(left);
    return this.columns().filter((c) => c.name !== left && comparableKinds(k, kindOf(c, this.engine())));
  }

  protected readonly rightOptions = computed(() => this.comparableTo(this.node().left));

  protected setLeft(left: string): void {
    const options = this.comparableTo(left);
    const right = options.some((c) => c.name === this.node().right) ? this.node().right : (options[0]?.name ?? this.node().right);
    this.changed.emit({ ...this.node(), left, right });
  }

  protected setOp(op: CountOp): void {
    this.changed.emit({ ...this.node(), op });
  }

  protected setRight(right: string): void {
    this.changed.emit({ ...this.node(), right });
  }

  protected asValue(): CondNode {
    return { t: "cond", id: this.node().id, column: this.node().left, op: this.node().op, args: [""] };
  }
}
