import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";

import type { BrowseColumn, Engine, FilterIssue } from "../../core/tauri-api.service";
import { kindOf } from "../../filter/kinds";
import { type CondNode, type FilterNode, type GroupNode, newId, type Op, SEARCH_COLUMN, type SortKey } from "../../filter/model";
import { opsFor } from "../../filter/operators";
import { condLabel, nodeText } from "../../filter/printer";
import { addNode, hasActive, removeNode, replaceNode, toggleOff } from "../../filter/tree";
import { ConditionRowComponent } from "./condition-row.component";
import { printExpression } from "../../filter/expression";
import type { SavedFilter } from "../../filter/memory";
import type { FkSource, SavedSource, ValueSource } from "../../filter/pickers";

/** The Copy / Export menu's items. */
export type CopyKind = "sql" | "expression" | "csv" | "json";

interface Editing {
  /** The node being edited (a copy: applied on Apply). */
  draft: FilterNode;
  /** True for a node not yet in the tree. */
  isNew: boolean;
  x: number;
  y: number;
}

/**
 * The filter above the grid: one chip per condition or group (click to edit, tick to switch it
 * off without losing it, × to remove), "+ Filter", "+ Group" (conditions of which any must
 * match) and All/Any for how the chips combine. Emits the new tree; the parent applies it.
 */
@Component({
  selector: "app-filter-bar",
  imports: [ConditionRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(document:keydown.escape)": "cancel()" },
  template: `
    @if (tree().items.length > 1) {
      <button type="button" class="match" (click)="toggleMatch()" [title]="tree().op === 'and' ? 'Rows match every chip (click: any chip)' : 'Rows match any chip (click: every chip)'">
        {{ tree().op === "and" ? "All of" : "Any of" }}
      </button>
    }
    @for (n of tree().items; track n.id) {
      @if (n.id !== searchNode()?.id) {
      <span class="chip" [class.off]="n.off" [class.bad]="!!issueOf(n)" [class.nav]="isNav(n)" [title]="issueOf(n) ?? (isNav(n) ? 'From following a foreign key' : '')">
        <input type="checkbox" [checked]="!n.off" (change)="emit(toggle(n.id))" [attr.aria-label]="(n.off ? 'Apply ' : 'Switch off ') + text(n)" />
        <button type="button" class="body" (click)="edit(n, $event)">
          @if (n.t === "cond") {
            @let l = label(n);
            <b>{{ l.column }}</b>
            @if (l.op) {
              <span class="op">{{ l.op }}</span>
            }
            <span class="val">{{ l.value }}</span>
          } @else {
            <span class="val">{{ text(n) }}</span>
          }
        </button>
        <button type="button" class="x" (click)="emit(remove(n.id))" [attr.aria-label]="'Remove ' + text(n)">×</button>
      </span>
      }
    }
    <button type="button" class="add" (click)="addCondition($event)" [disabled]="!columns().length">+ Filter</button>
    <button type="button" class="add" (click)="addGroup($event)" [disabled]="!columns().length" title="Conditions of which any one must match">+ Group</button>
    @if (tree().items.length) {
      <button type="button" class="clear" (click)="emit({ t: 'group', id: tree().id, op: 'and', items: [] })">Clear</button>
    }
    <button type="button" class="text" [class.on]="textOpen()" [attr.aria-pressed]="textOpen()" (click)="textToggle.emit()"
      title="Edit the whole filter as text, e.g. role = admin and (created_at: last 7 days or email ~ gmail)">Text</button>
    @if (canCopy()) {
      <span class="saved-wrap">
        <button type="button" class="text" [class.on]="copyMenu()" [attr.aria-expanded]="copyMenu()" (click)="copyMenu.set(!copyMenu())"
          title="Copy the filter as text or the rows as SQL; export the rows as CSV or JSON">Copy / Export</button>
        @if (copyMenu()) {
          <div class="scrim" (click)="copyMenu.set(false)"></div>
          <div class="saved-menu" role="menu" aria-label="Copy or export">
            <button type="button" role="menuitem" class="use" [disabled]="!hasActiveFilter()" (click)="copyAs('expression')">Copy the filter as text (expression)</button>
            <button type="button" role="menuitem" class="use" (click)="copyAs('sql')">Copy the rows as SQL (values written in)</button>
            <div class="sep"></div>
            <button type="button" role="menuitem" class="use" (click)="copyAs('csv')" title="All matching rows, sorted, whole values (the first 50,000)">Export rows as CSV…</button>
            <button type="button" role="menuitem" class="use" (click)="copyAs('json')" title="All matching rows, sorted, whole values (the first 50,000)">Export rows as JSON…</button>
          </div>
        }
      </span>
    }
    @if (saved()) {
      <span class="saved-wrap">
        <button type="button" class="text" [class.on]="!!savedMenu()" [attr.aria-expanded]="!!savedMenu()" (click)="toggleSaved()"
          title="Named filters of this table: save the current filter and sort, or apply one">★ Saved</button>
        @if (savedMenu(); as list) {
          <div class="scrim" (click)="savedMenu.set(null)"></div>
          <div class="saved-menu" role="menu" aria-label="Saved filters">
            @for (s of list; track s.name) {
              <div class="saved-item" [class.on]="isCurrent(s)">
                <button type="button" role="menuitem" class="use" (click)="applySaved(s)" [title]="savedText(s)">{{ s.name }}</button>
                <button type="button" class="x" (click)="removeSaved(s.name)" [attr.aria-label]="'Delete ' + s.name" title="Delete">×</button>
              </div>
            } @empty {
              <div class="none">No saved filters for this table yet.</div>
            }
            <form class="save-as" (submit)="$event.preventDefault(); saveAs(name.value); name.value = ''">
              <input #name type="text" spellcheck="false" [placeholder]="canSave() ? 'Name for the current filter' : 'Filter or sort first'"
                [disabled]="!canSave()" aria-label="Name for the current filter" />
              <button type="submit" [disabled]="!canSave()">Save</button>
            </form>
          </div>
        }
      </span>
    }
    <input type="search" class="search" [class.on]="!!searchText()" placeholder="Search all columns" spellcheck="false" [value]="searchText()"
      [title]="searchTitle" aria-label="Search all columns (Enter applies)" (keydown.enter)="search($any($event.target).value)"
      (search)="$any($event.target).value || search('')" />
    @if (searchNode(); as s) {
      <label class="cs" title="Match upper and lower case exactly">
        <input type="checkbox" [checked]="!!s.cs" (change)="setSearchCs($any($event.target).checked)" /> Aa
      </label>
    }
    @if (editing(); as e) {
      <div class="scrim" (click)="cancel()"></div>
      <div class="editor" role="dialog" aria-label="Edit filter" [style.left.px]="e.x" [style.top.px]="e.y">
        @if (e.draft.t === "cond") {
          <app-condition-row [columns]="columns()" [engine]="engine()" [node]="e.draft" [issue]="issueOf(e.draft)" [values]="values()" [fk]="fk()"
            (changed)="setDraft($event)" (submit)="apply()" />
        } @else {
          <div class="group-head">
            Rows match
            <select [value]="e.draft.op" (change)="setGroupOp($any($event.target).value)" aria-label="Combine">
              <option value="or">any</option>
              <option value="and">all</option>
            </select>
            of these:
          </div>
          @for (c of e.draft.items; track c.id) {
            <div class="item">
              @if (c.t === "cond") {
                <app-condition-row [columns]="columns()" [engine]="engine()" [node]="c" [issue]="issueOf(c)" [values]="values()" [fk]="fk()"
                  (changed)="setDraftItem($event)" (submit)="apply()" />
              } @else {
                <span class="nested">{{ text(c) }}</span>
              }
              <button type="button" class="x" (click)="removeDraftItem(c.id)" aria-label="Remove condition">×</button>
            </div>
          }
          <button type="button" class="add" (click)="addDraftItem()">+ Condition</button>
        }
        <div class="actions">
          <button type="button" (click)="cancel()">Cancel</button>
          <button type="button" class="primary" (click)="apply()">Apply</button>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 5px 8px; border-bottom: 1px solid var(--border);
      font-size: 12px; position: relative; }
    .chip { display: inline-flex; align-items: center; gap: 2px; max-width: 420px; border: 1px solid var(--border); border-radius: 14px;
      padding: 0 2px 0 6px; background: var(--panel-2); }
    .chip.off { opacity: 0.55; }
    .chip.off .body { text-decoration: line-through; }
    .chip.bad { border-color: var(--danger); background: var(--danger-soft); }
    .chip.nav { border-style: dashed; }
    .chip input { margin: 0; cursor: pointer; }
    .body { font: inherit; font-size: 12px; border: 0; background: none; color: var(--text); cursor: pointer; padding: 2px 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
    .body b { font-weight: 600; }
    .op { color: var(--text-muted); margin: 0 3px; }
    .val { font-family: var(--mono); }
    .x { border: 0; background: none; color: var(--text-muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; border-radius: 8px; }
    .x:hover { color: var(--text); background: var(--hover); }
    .match, .add, .clear { font: inherit; font-size: 12px; border: 1px dashed var(--border); background: none; color: var(--accent);
      border-radius: 14px; padding: 2px 9px; cursor: pointer; }
    .match { border-style: solid; color: var(--text); font-weight: 600; }
    .clear { border: 0; color: var(--text-muted); }
    .add:disabled { opacity: 0.5; cursor: default; }
    .text { font: 600 11px var(--mono); border: 1px solid var(--border); background: none; color: var(--text-muted); border-radius: 14px;
      padding: 2px 8px; cursor: pointer; }
    .text.on { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
    .saved-wrap { position: relative; }
    .saved-menu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 240px; max-width: 360px; padding: 6px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-md); display: flex; flex-direction: column; gap: 2px; }
    .saved-item { display: flex; align-items: center; border-radius: 5px; }
    .saved-item:hover, .saved-item.on { background: var(--hover); }
    .saved-item.on .use { font-weight: 600; }
    .saved-menu > .use { border-radius: 5px; }
    .sep { height: 1px; background: var(--border); margin: 3px 0; }
    .saved-menu > .use:hover:not(:disabled) { background: var(--hover); }
    .use:disabled { color: var(--text-muted); cursor: default; }
    .use { flex: 1; text-align: left; font: inherit; font-size: 12px; border: 0; background: none; color: var(--text); padding: 4px 6px; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .none { color: var(--text-muted); padding: 4px 6px; }
    .save-as { display: flex; gap: 4px; margin-top: 4px; padding-top: 6px; border-top: 1px solid var(--border); }
    .save-as input { flex: 1; min-width: 0; font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 5px; padding: 3px 6px;
      background: var(--input-bg); color: var(--text); }
    .save-as button { font: inherit; font-size: 12px; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 5px;
      padding: 3px 10px; cursor: pointer; }
    .save-as button:disabled { opacity: 0.5; cursor: default; }
    .search { margin-left: auto; width: 190px; font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 14px;
      padding: 2px 9px; background: var(--input-bg); color: var(--text); }
    .search.on { border-color: var(--accent); }
    .cs { display: flex; align-items: center; gap: 3px; color: var(--text-muted); cursor: pointer; }
    .cs input { margin: 0; }
    .scrim { position: fixed; inset: 0; z-index: 19; }
    .editor { position: fixed; z-index: 20; min-width: 320px; max-width: min(640px, calc(100vw - 16px)); padding: 10px; background: var(--panel);
      border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-md); display: flex; flex-direction: column; gap: 8px; }
    .group-head { display: flex; align-items: center; gap: 5px; }
    .group-head select { font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 5px; padding: 2px 4px;
      background: var(--input-bg); color: var(--text); }
    .item { display: flex; align-items: flex-start; gap: 4px; padding-left: 10px; border-left: 2px solid var(--border); }
    .item app-condition-row { flex: 1; }
    .nested { font-family: var(--mono); color: var(--text-muted); }
    .actions { display: flex; justify-content: flex-end; gap: 6px; }
    .actions button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 6px; padding: 3px 12px; cursor: pointer; }
    .actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  `,
})
export class FilterBarComponent {
  readonly columns = input.required<BrowseColumn[]>();
  readonly engine = input<Engine | null>(null);
  readonly tree = input.required<GroupNode>();
  readonly issues = input<FilterIssue[]>([]);
  /** Where the value picker gets a column's values. */
  readonly values = input<ValueSource | null>(null);
  /** Rows of referenced tables, for foreign-key columns. */
  readonly fk = input<FkSource | null>(null);
  /** Named filters of the table (none: no "Saved" menu). */
  readonly saved = input<SavedSource | null>(null);
  /** The current sort (saved with a named filter). */
  readonly sort = input<SortKey[]>([]);
  /** Shows the Copy menu (the parent copies). */
  readonly canCopy = input(false);
  readonly copy = output<CopyKind>();
  readonly treeChange = output<GroupNode>();
  /** Whether the expression box is shown (the Text button). */
  readonly textOpen = input(false);
  readonly textToggle = output<void>();

  protected readonly editing = signal<Editing | null>(null);
  private readonly issueById = computed(() => new Map(this.issues().map((i) => [i.node, i.message])));

  protected readonly label = condLabel;
  protected readonly text = nodeText;
  protected readonly searchTitle =
    "Rows where any column contains this text (text columns by their content, other columns when the text is a valid value for them). Enter applies; empty clears.";

  /** The search box's condition: the first active "any column contains" directly under the root. */
  protected readonly searchNode = computed(
    () => this.tree().items.find((n): n is CondNode => n.t === "cond" && n.column === SEARCH_COLUMN && !n.off) ?? null,
  );
  protected readonly searchText = computed(() => {
    const v = this.searchNode()?.args[0];
    return typeof v === "string" ? v : "";
  });

  protected readonly copyMenu = signal(false);
  protected readonly hasActiveFilter = computed(() => hasActive(this.tree()));

  protected copyAs(what: CopyKind): void {
    this.copyMenu.set(false);
    this.copy.emit(what);
  }

  protected readonly savedMenu = signal<SavedFilter[] | null>(null);
  protected readonly canSave = computed(() => hasActive(this.tree()) || this.sort().length > 0);
  private readonly currentText = computed(() => printExpression(this.tree()) + JSON.stringify(this.sort()));

  protected async toggleSaved(): Promise<void> {
    if (this.savedMenu()) return this.savedMenu.set(null);
    const source = this.saved();
    if (source) this.savedMenu.set(await source.list());
  }

  protected async saveAs(name: string): Promise<void> {
    const source = this.saved();
    if (source && name.trim() && this.canSave()) this.savedMenu.set(await source.save(name));
  }

  protected async removeSaved(name: string): Promise<void> {
    const source = this.saved();
    if (source) this.savedMenu.set(await source.remove(name));
  }

  protected applySaved(s: SavedFilter): void {
    this.savedMenu.set(null);
    this.saved()?.apply(s);
  }

  protected isCurrent(s: SavedFilter): boolean {
    return printExpression(s.where) + JSON.stringify(s.sort) === this.currentText();
  }

  protected savedText(s: SavedFilter): string {
    const where = printExpression(s.where) || "no conditions";
    const sort = s.sort.map((k) => `${k.column}${k.desc ? " ↓" : " ↑"}`).join(", ");
    return sort ? `${where} · sorted by ${sort}` : where;
  }

  protected search(text: string): void {
    const t = text.trim() ? text : "";
    const cur = this.searchNode();
    if (t === this.searchText()) return;
    if (!t) {
      if (cur) this.emit(removeNode(this.tree(), cur.id));
      return;
    }
    const node: CondNode = { t: "cond", id: cur?.id ?? newId(), column: SEARCH_COLUMN, op: "contains", args: [t], ...(cur?.cs ? { cs: true } : {}) };
    this.emit(cur ? replaceNode(this.tree(), cur.id, node) : addNode(this.tree(), node));
  }

  protected setSearchCs(on: boolean): void {
    const cur = this.searchNode();
    if (cur) this.emit(replaceNode(this.tree(), cur.id, { ...cur, cs: on || undefined }));
  }

  protected emit(tree: GroupNode): void {
    this.treeChange.emit(tree);
  }

  /** A problem of the node, or of a condition inside it. */
  protected issueOf(n: FilterNode): string | null {
    const own = this.issueById().get(n.id);
    if (own) return own;
    return n.t === "group" ? n.items.map((i) => this.issueOf(i)).find((m) => !!m) ?? null : null;
  }

  protected isNav(n: FilterNode): boolean {
    return n.t === "cond" && n.origin === "nav";
  }

  protected toggle(id: string): GroupNode {
    return toggleOff(this.tree(), id);
  }

  protected remove(id: string): GroupNode {
    return removeNode(this.tree(), id);
  }

  protected toggleMatch(): void {
    this.emit({ ...this.tree(), op: this.tree().op === "and" ? "or" : "and" });
  }

  private newCondition(): CondNode {
    const col = this.columns()[0];
    const kind = kindOf(col, this.engine());
    const op = opsFor(kind, this.engine(), col.nullable ?? true)[0].op as Op;
    return { t: "cond", id: newId(), column: col.name, op, args: [""] };
  }

  /** Opens the editor under the clicked element. */
  private open(draft: FilterNode, isNew: boolean, event: Event): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 420;
    this.editing.set({
      draft: structuredClone(draft),
      isNew,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      y: Math.min(rect.bottom + 4, window.innerHeight - 220),
    });
  }

  protected edit(n: FilterNode, event: Event): void {
    this.open(n, false, event);
  }

  /** Opens the editor for a new condition on `column` at a screen position (column header menu). */
  openFor(column: string, x: number, y: number): void {
    const col = this.columns().find((c) => c.name === column);
    if (!col) return;
    const kind = kindOf(col, this.engine());
    const op = opsFor(kind, this.engine(), col.nullable ?? true)[0].op as Op;
    const width = 420;
    this.editing.set({
      draft: { t: "cond", id: newId(), column, op, args: [""] },
      isNew: true,
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.min(y, window.innerHeight - 220),
    });
  }

  protected addCondition(event: Event): void {
    this.open(this.newCondition(), true, event);
  }

  protected addGroup(event: Event): void {
    this.open({ t: "group", id: newId(), op: "or", items: [this.newCondition(), this.newCondition()] }, true, event);
  }

  protected setDraft(node: CondNode): void {
    this.editing.update((e) => (e ? { ...e, draft: node } : e));
  }

  protected setGroupOp(op: "and" | "or"): void {
    this.editing.update((e) => (e && e.draft.t === "group" ? { ...e, draft: { ...e.draft, op } } : e));
  }

  protected setDraftItem(node: CondNode): void {
    this.editing.update((e) => (e && e.draft.t === "group" ? { ...e, draft: { ...e.draft, items: e.draft.items.map((i) => (i.id === node.id ? node : i)) } } : e));
  }

  protected removeDraftItem(id: string): void {
    this.editing.update((e) => (e && e.draft.t === "group" ? { ...e, draft: { ...e.draft, items: e.draft.items.filter((i) => i.id !== id) } } : e));
  }

  protected addDraftItem(): void {
    this.editing.update((e) => (e && e.draft.t === "group" ? { ...e, draft: { ...e.draft, items: [...e.draft.items, this.newCondition()] } } : e));
  }

  protected cancel(): void {
    this.editing.set(null);
    this.savedMenu.set(null);
    this.copyMenu.set(false);
  }

  protected apply(): void {
    const e = this.editing();
    if (!e) return;
    this.editing.set(null);
    let draft = e.draft;
    // A group with one condition left is that condition; an empty one is nothing.
    if (draft.t === "group" && draft.items.length === 1) draft = draft.items[0];
    if (draft.t === "group" && !draft.items.length) {
      if (!e.isNew) this.emit(removeNode(this.tree(), e.draft.id));
      return;
    }
    // Edited conditions apply again (and stop being "from navigation").
    if (draft.t === "cond") draft = { ...draft, off: false, origin: undefined };
    const tree = e.isNew ? addNode(this.tree(), draft) : replaceNode(this.tree(), e.draft.id, draft);
    if (hasActive(draft) || !e.isNew) this.emit(tree);
  }
}
