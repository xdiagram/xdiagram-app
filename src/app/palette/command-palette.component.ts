import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";

import { fuzzyFilter } from "./fuzzy";

export interface PaletteItem {
  id: string;
  kind: "table" | "column" | "command" | "view";
  /** Text matched against the query. */
  label: string;
  /** Secondary text (schema, type, shortcut). */
  detail?: string;
  run: () => void;
}

const KIND_LABEL: Record<PaletteItem["kind"], string> = {
  table: "Table",
  column: "Column",
  command: "Command",
  view: "View",
};

@Component({
  selector: "app-command-palette",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(document:keydown.escape)": "closed.emit()" },
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <section class="palette" role="dialog" aria-label="Command palette">
      <input #q class="query" type="text" [value]="query()" (input)="onInput($any($event.target).value)"
        (keydown)="onKey($event)" placeholder="Search tables, columns and commands…" spellcheck="false"
        autocomplete="off" role="combobox" aria-controls="xd-palette-list" [attr.aria-activedescendant]="'xd-pi-' + active()" />
      <ul id="xd-palette-list" role="listbox">
        @for (r of results(); track r.item.id; let i = $index) {
          <li [id]="'xd-pi-' + i" role="option" [attr.aria-selected]="i === active()" [class.active]="i === active()"
            (mousemove)="active.set(i)" (click)="pick(i)">
            <span class="kind" [class]="'kind ' + r.item.kind">{{ kindLabel[r.item.kind] }}</span>
            <!-- No whitespace between the parts: it would show up inside the name. -->
            <span class="label">@for (part of parts(r.item.label, r.match.positions); track $index) {<span [class.hit]="part.hit">{{ part.text }}</span>}</span>
            @if (r.item.detail) {
              <span class="detail">{{ r.item.detail }}</span>
            }
          </li>
        } @empty {
          <li class="none">No matches</li>
        }
      </ul>
      <div class="hint"><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 60; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop); }
    .palette { position: relative; width: min(640px, calc(100vw - 32px)); background: var(--panel); color: var(--text);
      border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden; }
    .query { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--border); background: transparent;
      color: var(--text); font: inherit; font-size: 15px; padding: 14px 16px; outline: none; }
    ul { list-style: none; margin: 0; padding: 6px; max-height: 52vh; overflow: auto; }
    li { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; }
    li.active { background: var(--accent-soft); }
    li.none { color: var(--text-muted); cursor: default; }
    .kind { flex: none; width: 64px; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-muted); }
    .kind.table { color: var(--accent); }
    .kind.column { color: #0f9b8e; }
    .kind.view { color: #8e44ad; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12.5px; }
    .label .hit { color: var(--accent); font-weight: 700; }
    .detail { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 12px; }
    .hint { border-top: 1px solid var(--border); padding: 7px 14px; font-size: 11.5px; color: var(--text-muted); }
    kbd { font-family: var(--font); font-size: 10.5px; border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; margin: 0 2px; }
  `,
})
export class CommandPaletteComponent {
  readonly items = input.required<PaletteItem[]>();
  readonly closed = output<void>();

  protected readonly query = signal("");
  protected readonly active = signal(0);
  protected readonly kindLabel = KIND_LABEL;
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>("q");

  /** Empty query: commands and views first; otherwise everything ranked by match quality. */
  protected readonly results = computed(() => {
    const q = this.query();
    const items = this.items();
    if (!q.trim()) {
      const first = items.filter((i) => i.kind === "command" || i.kind === "view");
      const rest = items.filter((i) => i.kind === "table");
      return [...first, ...rest].slice(0, 50).map((item) => ({ item, match: { score: 0, positions: [] as number[] } }));
    }
    return fuzzyFilter(q, items, (i) => i.label, 60);
  });

  constructor() {
    afterNextRender(() => this.input().nativeElement.focus());
  }

  protected onInput(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active.set(n ? (this.active() + 1) % n : 0);
      this.scrollActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active.set(n ? (this.active() - 1 + n) % n : 0);
      this.scrollActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.pick(this.active());
    }
  }

  protected pick(i: number): void {
    const r = this.results()[i];
    if (!r) return;
    this.closed.emit();
    // Let the palette close before running (focus moves back to the app).
    setTimeout(() => r.item.run(), 0);
  }

  protected parts(text: string, positions: number[]): { text: string; hit: boolean }[] {
    if (positions.length === 0) return [{ text, hit: false }];
    const hits = new Set(positions);
    const out: { text: string; hit: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
      const hit = hits.has(i);
      const last = out[out.length - 1];
      if (last && last.hit === hit) last.text += text[i];
      else out.push({ text: text[i], hit });
    }
    return out;
  }

  private scrollActive(): void {
    setTimeout(() => document.getElementById(`xd-pi-${this.active()}`)?.scrollIntoView({ block: "nearest" }), 0);
  }
}
