import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, input, output, signal, untracked, viewChild } from "@angular/core";

import type { BrowseColumn, Engine } from "../../core/tauri-api.service";
import { type CompletionContext, ParseError, type Suggestion, complete, parseExpression, printExpression } from "../../filter/expression";
import { kindOf } from "../../filter/kinds";
import type { GroupNode } from "../../filter/model";

/**
 * The whole filter as one line of text (see `filter/expression.ts`), with suggestions as you type,
 * errors marked where they are, and the expressions used before. Enter applies; the chips and
 * this text are two views of the same filter.
 */
@Component({
  selector: "app-expression-box",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field" [class.bad]="!!error()">
      <div class="mirror" aria-hidden="true" #mirror>
        @if (error(); as e) {
          <span>{{ text().slice(0, e.from) }}</span><span class="mark">{{ text().slice(e.from, e.to) || " " }}</span>
        }
      </div>
      <input #input type="text" spellcheck="false" autocomplete="off" [value]="text()" placeholder="role = admin and (created_at > -7d or email ~ gmail)"
        aria-label="Filter expression (Enter applies, Ctrl+Space suggests, Esc undoes the edit)" (input)="onInput($event)" (keydown)="onKey($event)"
        (focus)="onFocus()" (blur)="onBlur()" (scroll)="syncScroll()" />
      <button type="button" class="apply" (mousedown)="$event.preventDefault()" (click)="apply()" title="Apply (Enter)">Apply</button>
    </div>
    @if (error(); as e) {
      <div class="msg">{{ e.message }} (at {{ e.from + 1 }})</div>
    }
    @if (focused() && list().length) {
      <ul class="list" role="listbox">
        @for (s of list(); track $index; let i = $index) {
          <li role="option" [class.on]="i === active()" [attr.aria-selected]="i === active()" (mousedown)="$event.preventDefault(); accept(i)">
            <span class="label">{{ s.label }}</span>
            @if (s.detail) {
              <span class="detail">{{ s.detail }}</span>
            }
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host { display: block; position: relative; padding: 4px 8px 6px; border-bottom: 1px solid var(--border); }
    .field { position: relative; display: flex; align-items: center; gap: 6px; }
    input, .mirror { font: 12px var(--mono); padding: 4px 7px; border: 1px solid var(--border); border-radius: 6px; box-sizing: border-box;
      white-space: pre; letter-spacing: normal; }
    input { flex: 1; min-width: 0; background: transparent; color: var(--text); position: relative; z-index: 1; }
    .field.bad input { border-color: var(--danger); }
    .mirror { position: absolute; left: 0; top: 0; bottom: 0; right: 64px; overflow: hidden; color: transparent; background: var(--input-bg);
      border-color: transparent; pointer-events: none; }
    .mark { text-decoration: underline wavy var(--danger); text-underline-offset: 3px; }
    .apply { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 6px;
      padding: 3px 10px; cursor: pointer; flex: none; }
    .msg { color: var(--danger); font-size: 11.5px; margin-top: 3px; }
    .list { position: absolute; z-index: 21; left: 8px; top: 100%; margin: 0; padding: 4px; list-style: none; min-width: 240px; max-width: 520px;
      max-height: 260px; overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 7px; box-shadow: var(--shadow-md); }
    li { display: flex; justify-content: space-between; gap: 12px; padding: 3px 8px; border-radius: 5px; cursor: pointer; font: 12px var(--mono);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    li.on, li:hover { background: var(--hover); }
    .detail { color: var(--text-muted); font-family: var(--font); font-size: 11px; }
  `,
})
export class ExpressionBoxComponent {
  readonly columns = input.required<BrowseColumn[]>();
  readonly engine = input<Engine | null>(null);
  readonly tree = input.required<GroupNode>();
  /** Expressions used before (newest first). */
  readonly history = input<string[]>([]);
  /** Known values of a column, for suggestions. */
  readonly values = input<(column: string) => string[]>(() => []);
  readonly treeChange = output<GroupNode>();
  readonly used = output<string>();

  private readonly inputRef = viewChild.required<ElementRef<HTMLInputElement>>("input");
  private readonly mirrorRef = viewChild.required<ElementRef<HTMLDivElement>>("mirror");
  protected readonly text = signal("");
  protected readonly focused = signal(false);
  protected readonly error = signal<ParseError | null>(null);
  protected readonly list = signal<Suggestion[]>([]);
  protected readonly active = signal(-1);
  private range = { from: 0, to: 0 };
  /** The text was typed (not yet applied): a new tree from outside does not overwrite it. */
  private dirty = false;

  private readonly ctx = computed<CompletionContext>(() => ({
    columns: this.columns().map((c) => ({ name: c.name, kind: kindOf(c, this.engine()), enumValues: c.enumValues })),
    values: this.values(),
  }));

  constructor() {
    effect(() => {
      const printed = printExpression(this.tree());
      untracked(() => {
        if (!this.dirty) {
          this.text.set(printed);
          this.error.set(null);
        }
      });
    });
  }

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
    this.dirty = true;
    this.check();
    this.suggest();
  }

  private check(): void {
    try {
      parseExpression(this.text());
      this.error.set(null);
    } catch (e) {
      this.error.set(e instanceof ParseError ? e : null);
    }
  }

  protected suggest(): void {
    const el = this.inputRef().nativeElement;
    if (!this.text().trim() && this.history().length) {
      this.range = { from: 0, to: this.text().length };
      this.list.set(this.history().slice(0, 12).map((h) => ({ label: h, insert: h, detail: "used before" })));
    } else {
      const c = complete(this.text(), el.selectionStart ?? this.text().length, this.ctx());
      this.range = { from: c.from, to: c.to };
      this.list.set(c.items);
    }
    this.active.set(-1);
  }

  protected accept(i: number): void {
    const s = this.list()[i];
    if (!s) return;
    const t = this.text();
    const next = t.slice(0, this.range.from) + s.insert + t.slice(this.range.to);
    this.text.set(next);
    this.dirty = true;
    const caret = this.range.from + s.insert.length;
    const el = this.inputRef().nativeElement;
    el.value = next;
    el.setSelectionRange(caret, caret);
    el.focus();
    this.check();
    this.suggest();
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.list().length;
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      this.suggest();
    } else if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      this.active.set((this.active() + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if ((e.key === "Tab" || e.key === "Enter") && this.active() >= 0) {
      e.preventDefault();
      this.accept(this.active());
    } else if (e.key === "Tab" && n === 1) {
      e.preventDefault();
      this.accept(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.apply();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (this.list().length) this.list.set([]);
      else this.revert();
    }
  }

  protected apply(): void {
    this.list.set([]);
    if (!this.dirty) return;
    let parsed: GroupNode;
    try {
      parsed = parseExpression(this.text());
    } catch (e) {
      if (e instanceof ParseError) {
        this.error.set(e);
        const el = this.inputRef().nativeElement;
        el.setSelectionRange(e.from, e.to);
      }
      return;
    }
    this.dirty = false;
    // Switched-off chips are not in the text: they stay, off.
    const off = this.tree().items.filter((i) => i.off);
    this.treeChange.emit({ ...parsed, items: [...parsed.items, ...off] });
    if (this.text().trim()) this.used.emit(this.text().trim());
  }

  private revert(): void {
    this.dirty = false;
    this.text.set(printExpression(this.tree()));
    this.error.set(null);
  }

  focus(): void {
    this.inputRef().nativeElement.focus();
  }

  protected onFocus(): void {
    this.focused.set(true);
    // Empty: the expressions used before.
    if (!this.text().trim()) this.suggest();
  }

  protected onBlur(): void {
    this.focused.set(false);
    this.list.set([]);
  }

  protected syncScroll(): void {
    this.mirrorRef().nativeElement.scrollLeft = this.inputRef().nativeElement.scrollLeft;
  }
}
