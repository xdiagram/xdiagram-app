import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, input, output, signal, untracked, viewChild } from "@angular/core";

import { type ValueCount, type ValuesResult, errorMessage } from "../../core/tauri-api.service";
import { isCancelled } from "../../state/workspace.store";

/** Where the picker gets a column's values: (column, text to find, condition to leave out). */
export type ValueSource = (column: string, search: string, exclude: string | null) => Promise<ValuesResult>;

type State = { s: "loading" } | { s: "done"; r: ValuesResult } | { s: "error"; message: string };

const nf = new Intl.NumberFormat();

/**
 * The values of a column among the rows the rest of the filter matches, most frequent first, with
 * their counts: click one to use it (or tick several for "is one of"). A find box narrows the
 * list on the server; numbers and dates also show their smallest and largest value.
 */
@Component({
  selector: "app-value-picker",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(focusout)": "onFocusOut($event)", "(keydown.escape)": "$event.stopPropagation(); closed.emit()" },
  template: `
    <input #find class="find" type="search" placeholder="Find a value" spellcheck="false" [value]="search()" (input)="onSearch($any($event.target).value)"
      (keydown)="onKey($event)" aria-label="Find a value" />
    @switch (state().s) {
      @case ("loading") {
        <div class="note">Counting values…</div>
      }
      @case ("error") {
        <div class="note bad">{{ errorText() }}</div>
      }
    }
    @if (items().length) {
      <ul role="listbox" [attr.aria-multiselectable]="multi()">
        @for (v of items(); track v.value; let i = $index) {
          <li role="option" [class.on]="i === active()" [class.zero]="!v.count" [class.off]="!usable(v)" [attr.aria-selected]="isSelected(v)"
            [title]="v.cut ? 'Too long to filter by' : v.value === null && multi() ? 'NULL cannot be one of a list' : ''"
            (mousedown)="$event.preventDefault()" (click)="choose(v)">
            @if (multi()) {
              <input type="checkbox" tabindex="-1" [checked]="isSelected(v)" [disabled]="!usable(v)" />
            }
            <span class="val" [class.null]="v.value === null">{{ v.value ?? "NULL" }}</span>
            <span class="bar"><span [style.width.%]="share(v)"></span></span>
            <span class="n">{{ fmt(v.count) }}</span>
          </li>
        }
      </ul>
    }
    @if (done(); as r) {
      @if (!items().length) {
        <div class="note">{{ search() ? "No value holds “" + search() + "”" : "No matching rows" }}</div>
      }
      @if (r.min !== null && r.max !== null) {
        <div class="note">Smallest <b>{{ r.min }}</b> · largest <b>{{ r.max }}</b></div>
      }
      @if (r.more) {
        <div class="note">More values exist: type to find one.</div>
      }
      @if (r.sampled) {
        <div class="note">Counted in the first {{ fmt(r.rows) }} matching rows.</div>
      }
      @if (r.timedOut) {
        <div class="note">Counting took too long: type to narrow it.</div>
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2);
      font-size: 12px; }
    .find { font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 5px; padding: 3px 6px; background: var(--input-bg); color: var(--text); }
    ul { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow: auto; }
    li { display: grid; grid-template-columns: auto minmax(60px, 1fr) 70px 56px; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px;
      cursor: pointer; }
    li:not(:has(input)) { grid-template-columns: minmax(60px, 1fr) 70px 56px; }
    li.on, li:hover { background: var(--hover); }
    li.zero .val, li.zero .n { color: var(--text-muted); }
    li.off { cursor: default; opacity: 0.55; }
    li input { margin: 0; }
    .val { font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .val.null { font-style: italic; color: var(--text-muted); }
    .bar { height: 6px; background: var(--hover); border-radius: 3px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--accent); opacity: 0.6; }
    .n { text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .note { color: var(--text-muted); font-size: 11.5px; }
    .note.bad { color: var(--danger); }
  `,
})
export class ValuePickerComponent {
  readonly source = input.required<ValueSource>();
  readonly column = input.required<string>();
  /** The condition being edited: left out of the filter the values are counted in. */
  readonly exclude = input<string | null>(null);
  /** An enum's values: listed too when absent (count 0). */
  readonly enumValues = input<string[]>([]);
  /** Several values ("is one of"): ticks instead of one pick. */
  readonly multi = input(false);
  readonly selected = input<string[]>([]);
  readonly pick = output<string>();
  readonly pickNull = output<void>();
  readonly closed = output<void>();

  private readonly findRef = viewChild.required<ElementRef<HTMLInputElement>>("find");
  protected readonly search = signal("");
  private readonly query = signal("");
  protected readonly state = signal<State>({ s: "loading" });
  protected readonly active = signal(-1);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  protected readonly done = computed(() => {
    const s = this.state();
    return s.s === "done" ? s.r : null;
  });
  protected readonly errorText = computed(() => {
    const s = this.state();
    return s.s === "error" ? s.message : "";
  });
  protected readonly items = computed<ValueCount[]>(() => {
    const r = this.done();
    if (!r) return [];
    const listed = r.values;
    const q = this.query().toLowerCase();
    const missing = this.enumValues()
      .filter((e) => !listed.some((v) => v.value === e) && (!q || e.toLowerCase().includes(q)))
      .map((value) => ({ value, count: 0 }));
    return [...listed, ...missing];
  });
  private readonly max = computed(() => Math.max(1, ...this.items().map((v) => v.count)));

  constructor() {
    effect(() => {
      const column = this.column();
      const search = this.query();
      const exclude = this.exclude();
      untracked(() => void this.fetch(column, search, exclude));
    });
    afterNextRender(() => this.findRef().nativeElement.focus());
  }

  private async fetch(column: string, search: string, exclude: string | null): Promise<void> {
    const seq = ++this.seq;
    this.state.set({ s: "loading" });
    try {
      const r = await this.source()(column, search, exclude);
      if (seq === this.seq) {
        this.state.set({ s: "done", r });
        this.active.set(-1);
      }
    } catch (err) {
      if (seq === this.seq) this.state.set({ s: "error", message: isCancelled(err) ? "Cancelled" : errorMessage(err) });
    }
  }

  protected onSearch(text: string): void {
    this.search.set(text);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.query.set(text.trim()), 250);
  }

  protected fmt(n: number): string {
    return nf.format(n);
  }

  protected share(v: ValueCount): number {
    return (v.count / this.max()) * 100;
  }

  protected usable(v: ValueCount): boolean {
    return !v.cut && !(v.value === null && this.multi());
  }

  protected isSelected(v: ValueCount): boolean {
    return v.value !== null && this.selected().includes(v.value);
  }

  protected choose(v: ValueCount): void {
    if (!this.usable(v)) return;
    if (v.value === null) this.pickNull.emit();
    else this.pick.emit(v.value);
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.items().length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      this.active.set((this.active() + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const v = this.items()[this.active()];
      if (v) this.choose(v);
    }
  }

  protected onFocusOut(e: FocusEvent): void {
    const to = e.relatedTarget as Node | null;
    if (to && !(e.currentTarget as HTMLElement).contains(to)) this.closed.emit();
  }
}
