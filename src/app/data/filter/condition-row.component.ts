import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";

import type { BrowseColumn, ColKind, Engine } from "../../core/tauri-api.service";
import { comparableKinds, isDateKind, kindOf } from "../../filter/kinds";
import { type Arg, type CondNode, type Op, SEARCH_COLUMN, type Span } from "../../filter/model";
import { opInfo, opsFor } from "../../filter/operators";
import { parsePoint, printPoint } from "../../filter/relative-dates";
import { treeIssues } from "../../filter/validate";
import type { FkSource, ValueSource } from "../../filter/pickers";
import { FkPickerComponent } from "./fk-picker.component";
import { ValuePickerComponent } from "./value-picker.component";

const PERIODS: { value: string; label: string }[] = [
  { value: "today", label: "today" },
  { value: "yesterday", label: "yesterday" },
  { value: "thisWeek", label: "this week" },
  { value: "thisMonth", label: "this month" },
  { value: "thisYear", label: "this year" },
  { value: "lastDays", label: "the last … days" },
  { value: "day", label: "on the day…" },
];

/** Edits one condition: column, operator (fitted to the column's kind) and value inputs. */
@Component({
  selector: "app-condition-row",
  imports: [ValuePickerComponent, FkPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <select class="col" [value]="node().column" (change)="setColumn($any($event.target).value)" aria-label="Column">
      <option [value]="anyColumn" [selected]="node().column === anyColumn" title="Rows where any column contains the text">(any column)</option>
      @for (c of columns(); track c.name) {
        <option [value]="c.name" [selected]="c.name === node().column">{{ c.name }}</option>
      }
    </select>
    <select class="op" [value]="opValue()" (change)="setOp($any($event.target).value)" aria-label="Operator">
      @for (o of ops(); track o.value) {
        <option [value]="o.value" [selected]="o.value === opValue()">{{ o.label }}</option>
      }
    </select>
    @switch (shape()) {
      @case ("period") {
        <select class="val" [value]="periodValue()" (change)="setPeriod($any($event.target).value)" aria-label="Period">
          @for (p of periods; track p.value) {
            <option [value]="p.value" [selected]="p.value === periodValue()">{{ p.label }}</option>
          }
        </select>
        @if (periodValue() === "lastDays") {
          <input class="num" type="number" min="1" max="9999" [value]="lastDays()" (input)="setLastDays($any($event.target).value)" aria-label="Days" />
        } @else if (periodValue() === "day") {
          <input class="val" type="date" [value]="dayValue()" (input)="setDay($any($event.target).value)" aria-label="Day" />
        }
      }
      @case ("one") {
        @if (kind() === "bool") {
          <select class="val" [value]="argText(0)" (change)="setArg(0, $any($event.target).value)" aria-label="Value">
            <option value="">…</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        } @else if (enumValues().length && !textMatch()) {
          <select class="val" [value]="argText(0)" (change)="setArg(0, $any($event.target).value)" aria-label="Value">
            <option value="">…</option>
            @for (v of enumValues(); track v) {
              <option [value]="v" [selected]="v === argText(0)">{{ v }}</option>
            }
          </select>
        } @else {
          <input class="val" [value]="argText(0)" [placeholder]="placeholder()" spellcheck="false" (input)="setArg(0, $any($event.target).value)"
            (keydown.enter)="submit.emit()" aria-label="Value" />
          @if (dateKind()) {
            <span class="cal"><input #cal0 type="date" tabindex="-1" aria-hidden="true" (change)="pickDate(0, $any($event.target).value)" /><button
              type="button" (click)="openCal(cal0)" title="Pick a day" aria-label="Pick a day">{{ calIcon }}</button></span>
          }
        }
      }
      @case ("two") {
        <input class="val" [value]="argText(0)" [placeholder]="placeholder()" spellcheck="false" (input)="setArg(0, $any($event.target).value)"
          (keydown.enter)="submit.emit()" aria-label="From" />
        @if (dateKind()) {
          <span class="cal"><input #calFrom type="date" tabindex="-1" aria-hidden="true" (change)="pickDate(0, $any($event.target).value)" /><button
            type="button" (click)="openCal(calFrom)" title="Pick the first day" aria-label="Pick the first day">{{ calIcon }}</button></span>
        }
        <span class="and">and</span>
        <input class="val" [value]="argText(1)" [placeholder]="placeholder()" spellcheck="false" (input)="setArg(1, $any($event.target).value)"
          (keydown.enter)="submit.emit()" aria-label="To" />
        @if (dateKind()) {
          <span class="cal"><input #calTo type="date" tabindex="-1" aria-hidden="true" (change)="pickDate(1, $any($event.target).value)" /><button
            type="button" (click)="openCal(calTo)" title="Pick the last day" aria-label="Pick the last day">{{ calIcon }}</button></span>
        }
      }
      @case ("list") {
        <textarea class="list" rows="3" spellcheck="false" [value]="listText()" (input)="setList($any($event.target).value)"
          placeholder="one value per line" aria-label="Values"></textarea>
      }
    }
    @if (canPick()) {
      <button type="button" class="pick" [class.on]="picker() === 'values'" [attr.aria-expanded]="picker() === 'values'" (click)="toggle('values')"
        title="Pick from this column's values, with how often each occurs among the matching rows">▾ Values</button>
    }
    @if (canCompareColumns()) {
      <button type="button" class="pick" (click)="toColumns.emit()" title="Compare with another column of the same row (ends_on < starts_on)">vs column</button>
    }
    @if (fkTarget(); as t) {
      <button type="button" class="pick rows" [class.on]="picker() === 'rows'" [attr.aria-expanded]="picker() === 'rows'" (click)="toggle('rows')"
        [title]="'Pick a row of ' + t.tableId + ' by its name'">▾ {{ shortTable(t.tableId) }}</button>
    }
    @if (textMatch()) {
      <label class="cs" title="Match upper and lower case exactly">
        <input type="checkbox" [checked]="!!node().cs" (change)="setCs($any($event.target).checked)" /> Aa
      </label>
    }
    @if (message(); as m) {
      <div class="msg">{{ m }}</div>
    }
    @if (picker() === "values" && canPick()) {
      <app-value-picker class="picker" [source]="values()!" [column]="node().column" [exclude]="node().id" [enumValues]="enumValues()"
        [multi]="shape() === 'list'" [selected]="stringArgs()" (pick)="pickValue($event)" (pickNull)="pickNull()" (closed)="picker.set(null)" />
    } @else if (picker() === "rows" && fkTarget(); as t) {
      <app-fk-picker class="picker" [source]="fk()!" [column]="node().column" [target]="t" [multi]="shape() === 'list'" [selected]="stringArgs()"
        (pick)="pickValue($event)" (closed)="picker.set(null)" />
    }
  `,
  styles: `
    :host { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; font-size: 12px; }
    select, input, textarea { font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 5px; padding: 3px 5px;
      background: var(--input-bg); color: var(--text); }
    .col { max-width: 170px; }
    .op { max-width: 170px; }
    .val { width: 150px; font-family: var(--mono); }
    .num { width: 64px; }
    .list { width: 220px; font-family: var(--mono); resize: vertical; }
    .and { color: var(--text-muted); }
    .cs { display: flex; align-items: center; gap: 3px; color: var(--text-muted); cursor: pointer; }
    .msg { flex-basis: 100%; color: var(--danger); font-size: 11.5px; }
    .pick { font: inherit; font-size: 11.5px; border: 1px solid var(--border); background: none; color: var(--text-muted); border-radius: 5px;
      padding: 3px 7px; cursor: pointer; }
    .pick.on, .pick:hover { color: var(--accent); border-color: var(--accent); }
    .cal { position: relative; display: inline-flex; }
    .cal input { position: absolute; left: 0; bottom: 0; width: 0; height: 0; padding: 0; border: 0; opacity: 0; pointer-events: none; }
    .cal button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: none; color: var(--text-muted); border-radius: 5px;
      padding: 2px 6px; cursor: pointer; line-height: 1.2; }
    .cal button:hover { color: var(--accent); border-color: var(--accent); }
    .picker { flex-basis: 100%; }
  `,
})
export class ConditionRowComponent {
  readonly columns = input.required<BrowseColumn[]>();
  readonly engine = input<Engine | null>(null);
  readonly node = input.required<CondNode>();
  /** A problem Rust reported for this condition. */
  readonly issue = input<string | null>(null);
  /** Where the value picker gets a column's values (none: no picker). */
  readonly values = input<ValueSource | null>(null);
  /** Rows of referenced tables (foreign-key columns get a row picker). */
  readonly fk = input<FkSource | null>(null);
  readonly changed = output<CondNode>();
  /** "vs column": the parent turns this into a column-against-column condition. */
  readonly toColumns = output<void>();
  /** Enter in a value box. */
  readonly submit = output<void>();

  protected readonly periods = PERIODS;
  protected readonly anyColumn = SEARCH_COLUMN;
  protected readonly calIcon = "▦";
  /** The open picker: the column's values, or the rows of the table it references. */
  protected readonly picker = signal<"values" | "rows" | null>(null);

  private readonly column = computed(() => this.columns().find((c) => c.name === this.node().column) ?? null);
  protected readonly kind = computed<ColKind>(() => {
    const c = this.column();
    return c ? kindOf(c, this.engine()) : "text";
  });
  protected readonly enumValues = computed(() => this.column()?.enumValues ?? []);
  protected readonly ops = computed(() => {
    if (this.node().column === SEARCH_COLUMN) return [{ value: "contains", label: "contains" }];
    const list = opsFor(this.kind(), this.engine(), this.column()?.nullable ?? true).map((o) => ({ value: o.op as string, label: o.label }));
    return isDateKind(this.kind()) ? [{ value: "period", label: "is in" }, ...list] : list;
  });
  protected readonly opValue = computed(() => (this.node().op === "range" && this.node().span ? "period" : this.node().op));
  protected readonly shape = computed(() => {
    if (this.opValue() === "period") return "period";
    const arity = opInfo(this.node().op).arity;
    return arity === 0 ? "none" : arity === 1 ? "one" : arity === 2 ? "two" : "list";
  });
  protected readonly textMatch = computed(() => ["contains", "notContains", "startsWith", "endsWith", "regex"].includes(this.node().op));
  protected readonly placeholder = computed(() => {
    switch (this.kind()) {
      case "date":
        return "YYYY-MM-DD or -7d";
      case "timestamp":
      case "timestamptz":
        return "YYYY-MM-DD HH:MM or -7d";
      case "time":
        return "HH:MM:SS";
      case "binary":
        return "0x…";
      default:
        return "value";
    }
  });
  protected readonly message = computed(() => this.issue() ?? treeIssues(this.node(), () => this.kind())[0]?.message ?? null);

  protected readonly periodValue = computed(() => {
    const span = this.node().span;
    if (!span) return "today";
    if (typeof span === "object") return "day" in span ? "day" : "lastDays";
    return span;
  });
  protected readonly lastDays = computed(() => {
    const span = this.node().span;
    return typeof span === "object" && "lastDays" in span ? span.lastDays : 7;
  });
  protected readonly dayValue = computed(() => {
    const span = this.node().span;
    return typeof span === "object" && "day" in span ? span.day : "";
  });
  protected readonly listText = computed(() => this.node().args.map((a) => this.text(a)).join("\n"));
  protected readonly stringArgs = computed(() => this.node().args.filter((a): a is string => typeof a === "string"));
  protected readonly dateKind = computed(() => isDateKind(this.kind()));
  /** The value picker fits conditions that take values from the column. */
  protected readonly canPick = computed(
    () =>
      !!this.values() &&
      this.node().column !== SEARCH_COLUMN &&
      ["one", "two", "list"].includes(this.shape()) &&
      this.node().op !== "regex" &&
      this.kind() !== "bool" &&
      this.kind() !== "binary",
  );

  /** A comparison (=, ≠, <, ≤, >, ≥) whose column compares with another column. */
  protected readonly canCompareColumns = computed(() => {
    const n = this.node();
    if (n.column === SEARCH_COLUMN || !["eq", "ne", "lt", "le", "gt", "ge"].includes(n.op) || n.span) return false;
    const k = this.kind();
    return this.columns().some((c) => c.name !== n.column && comparableKinds(k, kindOf(c, this.engine())));
  });

  /** The referenced table, for "= / ≠ / is one of" on a single-column foreign key. */
  protected readonly fkTarget = computed(() => {
    const fk = this.fk();
    if (!fk || !["eq", "ne", "in", "notIn"].includes(this.node().op)) return null;
    return fk.target(this.node().column);
  });

  protected shortTable(id: string): string {
    return id.replace(/^public\./, "");
  }

  protected toggle(which: "values" | "rows"): void {
    this.picker.set(this.picker() === which ? null : which);
  }

  protected pickValue(v: string): void {
    const shape = this.shape();
    if (shape === "list") {
      const args = this.stringArgs();
      this.emit({ args: args.includes(v) ? args.filter((a) => a !== v) : [...args, v] });
    } else if (shape === "two" && !this.argText(0)) {
      this.setArg(0, v);
    } else {
      this.setArg(shape === "two" ? 1 : 0, v);
      this.picker.set(null);
    }
  }

  /** NULL picked: the condition becomes "is null". */
  protected pickNull(): void {
    this.emit({ op: "isNull", args: [] });
    this.picker.set(null);
  }

  protected openCal(el: HTMLInputElement): void {
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  }

  /** A day from the calendar. "=" a day on a timestamp column means that whole day. */
  protected pickDate(i: number, day: string): void {
    if (!day) return;
    const timestamp = this.kind() === "timestamp" || this.kind() === "timestamptz";
    if (timestamp && this.node().op === "eq") this.emit({ op: "range", args: [], span: { day } });
    else this.setArg(i, day);
  }

  private text(a: Arg | undefined): string {
    return a === undefined ? "" : typeof a === "string" ? a : printPoint(a);
  }

  protected argText(i: number): string {
    return this.text(this.node().args[i]);
  }

  private emit(patch: Partial<CondNode>): void {
    const next: CondNode = { ...this.node(), ...patch };
    if (next.op !== "range") delete next.span;
    if (!["contains", "notContains", "startsWith", "endsWith", "regex"].includes(next.op)) delete next.cs;
    this.changed.emit(next);
  }

  protected setColumn(name: string): void {
    if (name === SEARCH_COLUMN) {
      const first = this.node().args[0];
      return this.emit({ column: name, op: "contains", args: [typeof first === "string" ? first : ""], span: undefined });
    }
    const col = this.columns().find((c) => c.name === name);
    const kind = col ? kindOf(col, this.engine()) : "text";
    const allowed = opsFor(kind, this.engine(), col?.nullable ?? true).map((o) => o.op as string);
    const keepOp = allowed.includes(this.node().op) || (isDateKind(kind) && this.opValue() === "period");
    const sameKind = kind === this.kind();
    this.emit(keepOp ? { column: name, ...(sameKind ? {} : { args: this.node().args.map(() => "") }) } : { column: name, op: allowed[0] as Op, args: [""], span: undefined });
  }

  protected setOp(value: string): void {
    if (value === "period") return this.emit({ op: "range", args: [], span: "today" });
    const op = value as Op;
    const arity = opInfo(op).arity;
    const a = this.node().span ? [] : this.node().args;
    // A list keeps the values given so far, not empty boxes.
    const args = arity === 0 ? [] : arity === 1 ? [a[0] ?? ""] : arity === 2 ? [a[0] ?? "", a[1] ?? ""] : a.filter((x) => typeof x !== "string" || x.trim() !== "");
    this.emit({ op, args, span: undefined });
  }

  private arg(text: string): Arg {
    return (isDateKind(this.kind()) ? parsePoint(text) : null) ?? text;
  }

  protected setArg(i: number, text: string): void {
    const args = [...this.node().args];
    args[i] = this.arg(text);
    this.emit({ args });
  }

  protected setList(text: string): void {
    const args = text
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map((v) => this.arg(v));
    this.emit({ args });
  }

  protected setCs(on: boolean): void {
    this.emit({ cs: on || undefined });
  }

  protected setPeriod(value: string): void {
    const span: Span = value === "lastDays" ? { lastDays: this.lastDays() } : value === "day" ? { day: this.dayValue() || new Date().toISOString().slice(0, 10) } : (value as Span);
    this.emit({ op: "range", args: [], span });
  }

  protected setLastDays(value: string): void {
    const n = Math.max(1, Math.min(9999, Math.round(Number(value) || 1)));
    this.emit({ op: "range", args: [], span: { lastDays: n } });
  }

  protected setDay(value: string): void {
    if (value) this.emit({ op: "range", args: [], span: { day: value } });
  }
}
