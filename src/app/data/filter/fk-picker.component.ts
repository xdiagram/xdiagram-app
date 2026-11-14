import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, input, output, signal, untracked, viewChild } from "@angular/core";

import { errorMessage } from "../../core/tauri-api.service";
import type { FkRows, FkSource, FkTarget } from "../../filter/pickers";
import { isCancelled } from "../../state/workspace.store";

type State = { s: "loading" } | { s: "done"; r: FkRows } | { s: "error"; message: string };

/**
 * Picks a referenced row by what it is called: the referenced table's rows (key and a name-like
 * column, which can be changed and is remembered), found by key or name.
 */
@Component({
  selector: "app-fk-picker",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(focusout)": "onFocusOut($event)", "(keydown.escape)": "$event.stopPropagation(); closed.emit()" },
  template: `
    <div class="head">
      <span>Rows of <b>{{ table() }}</b></span>
      @if (done(); as r) {
        @if (r.labels.length) {
          <label>showing
            <select [value]="r.label ?? ''" (change)="setLabel($any($event.target).value)" aria-label="Column shown next to the key">
              @for (l of r.labels; track l) {
                <option [value]="l" [selected]="l === r.label">{{ l }}</option>
              }
            </select>
          </label>
        }
      }
    </div>
    <input #find class="find" type="search" [placeholder]="'Find by ' + target().key + (done()?.label ? ' or ' + done()!.label : '')" spellcheck="false"
      [value]="search()" (input)="onSearch($any($event.target).value)" (keydown)="onKey($event)" aria-label="Find a row" />
    @switch (state().s) {
      @case ("loading") {
        <div class="note">Reading rows…</div>
      }
      @case ("error") {
        <div class="note bad">{{ errorText() }}</div>
      }
    }
    @if (done(); as r) {
      @if (r.rows.length) {
        <ul role="listbox" [attr.aria-multiselectable]="multi()">
          @for (row of r.rows; track row.key; let i = $index) {
            <li role="option" [class.on]="i === active()" [attr.aria-selected]="selected().includes(row.key)" (mousedown)="$event.preventDefault()"
              (click)="pick.emit(row.key)">
              @if (multi()) {
                <input type="checkbox" tabindex="-1" [checked]="selected().includes(row.key)" />
              }
              <span class="key">{{ row.key }}</span>
              <span class="label" [class.null]="row.label === null">{{ row.label ?? (r.label ? "NULL" : "") }}</span>
            </li>
          }
        </ul>
      } @else {
        <div class="note">{{ search() ? "No row matches “" + search() + "”" : "The table is empty" }}</div>
      }
      @if (r.more) {
        <div class="note">More rows exist: type to find one.</div>
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2);
      font-size: 12px; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-muted); }
    .head b { color: var(--text); }
    .head select { font: inherit; font-size: 11.5px; border: 1px solid var(--border); border-radius: 5px; padding: 1px 4px; background: var(--input-bg);
      color: var(--text); }
    .find { font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 5px; padding: 3px 6px; background: var(--input-bg); color: var(--text); }
    ul { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow: auto; }
    li { display: flex; align-items: center; gap: 8px; padding: 2px 4px; border-radius: 4px; cursor: pointer; }
    li.on, li:hover { background: var(--hover); }
    li input { margin: 0; }
    .key { font-family: var(--mono); color: var(--text-muted); min-width: 40px; }
    .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .label.null { font-style: italic; color: var(--text-muted); }
    .note { color: var(--text-muted); font-size: 11.5px; }
    .note.bad { color: var(--danger); }
  `,
})
export class FkPickerComponent {
  readonly source = input.required<FkSource>();
  readonly column = input.required<string>();
  readonly target = input.required<FkTarget>();
  readonly multi = input(false);
  readonly selected = input<string[]>([]);
  readonly pick = output<string>();
  readonly closed = output<void>();

  private readonly findRef = viewChild.required<ElementRef<HTMLInputElement>>("find");
  protected readonly search = signal("");
  private readonly query = signal("");
  /** A column chosen here (else the remembered or guessed one). */
  private readonly label = signal<string | null>(null);
  protected readonly state = signal<State>({ s: "loading" });
  protected readonly active = signal(-1);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  protected readonly table = computed(() => this.target().tableId.replace(/^public\./, ""));
  protected readonly done = computed(() => {
    const s = this.state();
    return s.s === "done" ? s.r : null;
  });
  protected readonly errorText = computed(() => {
    const s = this.state();
    return s.s === "error" ? s.message : "";
  });

  constructor() {
    effect(() => {
      const column = this.column();
      const search = this.query();
      const label = this.label();
      untracked(() => void this.fetch(column, search, label));
    });
    afterNextRender(() => this.findRef().nativeElement.focus());
  }

  private async fetch(column: string, search: string, label: string | null): Promise<void> {
    const seq = ++this.seq;
    this.state.set({ s: "loading" });
    try {
      const r = await this.source().rows(column, search, label);
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

  protected setLabel(label: string): void {
    this.label.set(label);
    this.source().setLabel(this.column(), label);
  }

  protected onKey(e: KeyboardEvent): void {
    const rows = this.done()?.rows ?? [];
    const n = rows.length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      this.active.set((this.active() + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const row = rows[this.active()];
      if (row) this.pick.emit(row.key);
    }
  }

  protected onFocusOut(e: FocusEvent): void {
    const to = e.relatedTarget as Node | null;
    if (to && !(e.currentTarget as HTMLElement).contains(to)) this.closed.emit();
  }
}
