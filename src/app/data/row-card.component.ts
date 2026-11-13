import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

import { HEADER_H, ROW_H } from "../diagram/geometry";
import type { Direction } from "./row-graph";
import { CARD_W, cell } from "./row-graph";
import type { CardView } from "../state/row-graph.store";

/**
 * One row of the related-data map, drawn like a diagram table: a coloured header (table and key)
 * and one line per column (name, value). Sizes match `geometry.ts` so edges land on the rows.
 */
@Component({
  selector: "app-row-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.root]": "card().isRoot",
    "[style.width.px]": "width",
    "[style.height.px]": "card().layout.height",
  },
  template: `
    @let c = card();
    @let n = c.node;
    <header [style.height.px]="headerH" [style.background]="c.table?.headerColor || null" (pointerdown)="onHeaderDown($event)"
      [title]="c.title + ' ' + c.keyText + ' — drag to move'">
      <span class="t">{{ c.title }}</span>
      <span class="k">{{ c.keyText }}</span>
      @if (n.notes.length) {
        <span class="warn" [title]="n.notes.join('\\n')">⚠</span>
      }
      <span class="sp"></span>
      @if (!c.isRoot) {
        <button type="button" (click)="startHere.emit()" title="Start the map from this row" aria-label="Start here">⌖</button>
      }
      <button type="button" (click)="openInGrid.emit()" title="Open this row in the data browser" aria-label="Open in data browser">↗</button>
    </header>
    @for (f of c.layout.fields; track f.name) {
      @let v = value(f.name);
      <div class="row" [style.height.px]="rowH">
        @if (f.pk) {
          <span class="badge pk">PK</span>
        } @else if (f.fk) {
          <span class="badge fk">FK</span>
        } @else {
          <span class="badge none"></span>
        }
        <span class="name" [class.key]="f.pk" [title]="f.name + (f.type ? ' (' + f.type + ')' : '')">{{ f.name }}</span>
        <span class="val" [class.null]="v === null" [title]="tip(v)" (click)="copy.emit(v)">{{ v === null ? "NULL" : v }}</span>
      </div>
    } @empty {
      <div class="row empty" [style.height.px]="rowH">no columns</div>
    }
    @if (c.layout.toggle) {
      <button type="button" class="toggle" [style.height.px]="rowH" (click)="toggleAll.emit()">
        {{ n.showAll ? "Fewer columns" : "+" + c.layout.hidden + " more column" + (c.layout.hidden === 1 ? "" : "s") }}
      </button>
    }
    @if (c.canParents && n.parents !== "done") {
      <button type="button" class="expand left" [style.top.px]="headerH / 2 - 11" [disabled]="n.parents === 'loading' || full()"
        (click)="expand.emit('parents')" [title]="full() ? 'The map is full' : 'Show the rows this row references'"
        aria-label="Show referenced rows">{{ n.parents === "loading" ? "…" : "+" }}</button>
    }
    @if (c.canChildren && n.children !== "done") {
      <button type="button" class="expand right" [style.top.px]="headerH / 2 - 11" [disabled]="n.children === 'loading' || full()"
        (click)="expand.emit('children')" [title]="full() ? 'The map is full' : 'Show the rows that reference this row'"
        aria-label="Show referencing rows">{{ n.children === "loading" ? "…" : "+" }}</button>
    }
  `,
  styles: `
    :host { position: absolute; display: block; box-sizing: border-box; background: var(--rc-body); border-radius: 8px;
      box-shadow: 0 0 0 1px var(--rc-border), 0 2px 8px var(--rc-shadow); font-size: 12px; user-select: text; }
    :host(.root) { box-shadow: 0 0 0 2px var(--rc-selected), 0 4px 14px var(--rc-shadow); }
    header { display: flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; box-sizing: border-box; background: var(--rc-header);
      color: var(--rc-header-text); border-radius: 8px 8px 0 0; cursor: grab; user-select: none; overflow: hidden; }
    header:active { cursor: grabbing; }
    /* The table name keeps its width; a long key (uuid, composite) takes what is left. */
    .t { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 40px; flex: 0 1 auto; }
    .k { font-family: var(--mono); font-size: 11.5px; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 0; }
    .warn { flex: none; cursor: help; }
    .sp { flex: none; }
    header button { flex: none; border: 0; background: transparent; color: inherit; width: 22px; height: 22px; border-radius: 5px;
      cursor: pointer; font-size: 13px; opacity: 0.85; padding: 0; }
    header button:hover { background: rgba(255, 255, 255, 0.18); opacity: 1; }
    .row { display: flex; align-items: center; gap: 6px; padding: 0 8px; box-sizing: border-box; border-top: 1px solid var(--rc-divider); }
    .row.empty { color: var(--rc-type); font-style: italic; }
    .badge { flex: none; width: 20px; height: 14px; border-radius: 3px; font-size: 8.5px; font-weight: 700; line-height: 14px; text-align: center;
      color: var(--rc-badge-text); }
    .badge.pk { background: var(--rc-pk); }
    .badge.fk { background: var(--rc-fk); }
    .badge.none { visibility: hidden; }
    .name { flex: 0 1 auto; max-width: 45%; color: var(--rc-name); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name.key { font-weight: 600; }
    .val { flex: 1; min-width: 0; text-align: right; font-family: var(--mono); font-size: 11.5px; color: var(--rc-name); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; cursor: copy; }
    .val.null { color: var(--rc-type); font-style: italic; }
    .val:hover { color: var(--rc-selected); }
    .toggle { display: block; width: 100%; border: 0; border-top: 1px solid var(--rc-divider); background: transparent; color: var(--rc-type);
      font: inherit; font-size: 11.5px; cursor: pointer; border-radius: 0 0 8px 8px; }
    .toggle:hover { color: var(--rc-selected); background: var(--rc-hover); }
    .expand { position: absolute; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--rc-border); background: var(--rc-body);
      color: var(--rc-selected); font-size: 15px; line-height: 18px; font-weight: 600; padding: 0; cursor: pointer; box-shadow: 0 1px 3px var(--rc-shadow); }
    .expand:hover:not(:disabled) { background: var(--rc-selected); color: #fff; }
    .expand:disabled { cursor: default; opacity: 0.6; }
    .expand.left { left: -11px; }
    .expand.right { right: -11px; }
  `,
})
export class RowCardComponent {
  readonly card = input.required<CardView>();
  /** The map has reached its card limit. */
  readonly full = input(false);
  readonly expand = output<Direction>();
  readonly toggleAll = output<void>();
  readonly openInGrid = output<void>();
  readonly startHere = output<void>();
  readonly copy = output<string | null>();
  /** Pointer down on the header (not on a button): the map moves the card. */
  readonly dragStart = output<PointerEvent>();

  protected readonly width = CARD_W;
  protected readonly headerH = HEADER_H;
  protected readonly rowH = ROW_H;

  protected value(column: string): string | null {
    return cell(this.card().node, column) ?? null;
  }

  protected tip(v: string | null): string {
    if (v === null) return "NULL — click to copy";
    return `${v.length > 500 ? `${v.slice(0, 500)}…` : v}\n(click to copy)`;
  }

  protected onHeaderDown(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    this.dragStart.emit(event);
  }
}
