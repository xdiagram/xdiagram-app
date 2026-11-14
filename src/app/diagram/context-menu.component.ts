import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, inject, input, output } from "@angular/core";

import { HEADER_COLORS } from "./canvas-edit";

export interface CanvasMenuState {
  x: number;
  y: number;
  /** Table under the pointer, or null for the empty background. */
  tableId: string | null;
  tableLabel: string | null;
  field: string | null;
  headerColor: string | null;
  /** Pointer position in diagram coordinates (for "New table here"). */
  world: { x: number; y: number };
  canBrowse: boolean;
}

export type CanvasMenuAction =
  | { kind: "renameTable" }
  | { kind: "renameColumn" }
  | { kind: "addColumn" }
  | { kind: "color"; color: string | null }
  | { kind: "reveal" }
  | { kind: "browse" }
  | { kind: "profile" }
  | { kind: "query" }
  | { kind: "hide" }
  | { kind: "isolate" }
  | { kind: "copy" }
  | { kind: "sample" }
  | { kind: "newTable" }
  | { kind: "fit" };

@Component({
  selector: "app-canvas-menu",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: "menu",
    "[style.left.px]": "state().x",
    "[style.top.px]": "state().y",
    "(document:keydown.escape)": "closed.emit()",
    "(document:pointerdown)": "onOutside($event)",
    "(contextmenu)": "$event.preventDefault()",
  },
  template: `
    @if (state().tableId) {
      <div class="title">{{ state().tableLabel }}</div>
      <button type="button" role="menuitem" (click)="pick({ kind: 'renameTable' })">Rename table…<kbd>dbl-click header</kbd></button>
      @if (state().field) {
        <button type="button" role="menuitem" (click)="pick({ kind: 'renameColumn' })">Rename “{{ state().field }}”…<kbd>dbl-click row</kbd></button>
      }
      <button type="button" role="menuitem" (click)="pick({ kind: 'addColumn' })">Add column…</button>
      <div class="swatches" role="group" aria-label="Header colour">
        @for (c of colors; track c) {
          <button type="button" class="swatch" [class.on]="sameColor(c)" [style.background]="c" [title]="c"
            (click)="pick({ kind: 'color', color: c })"></button>
        }
        <button type="button" class="swatch none" [class.on]="!state().headerColor" title="Default colour"
          (click)="pick({ kind: 'color', color: null })">×</button>
      </div>
      <div class="sep"></div>
      @if (state().canBrowse) {
        <button type="button" role="menuitem" (click)="pick({ kind: 'browse' })">Browse data</button>
        <button type="button" role="menuitem" (click)="pick({ kind: 'profile' })">Profile data</button>
        <button type="button" role="menuitem" (click)="pick({ kind: 'query' })">Add to query</button>
      }
      <button type="button" role="menuitem" (click)="pick({ kind: 'reveal' })">Reveal in editor</button>
      <button type="button" role="menuitem" (click)="pick({ kind: 'hide' })">Hide from diagram</button>
      <button type="button" role="menuitem" (click)="pick({ kind: 'isolate' })">Show only this &amp; related</button>
      <button type="button" role="menuitem" (click)="pick({ kind: 'copy' })">Copy name</button>
      <button type="button" role="menuitem" (click)="pick({ kind: 'sample' })">Generate sample data…</button>
    } @else {
      <button type="button" role="menuitem" (click)="pick({ kind: 'newTable' })">New table here</button>
      <button type="button" role="menuitem" (click)="pick({ kind: 'fit' })">Fit diagram</button>
    }
  `,
  styles: `
    :host { position: absolute; z-index: 8; min-width: 210px; padding: 4px; background: var(--panel); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-md); font-size: 12.5px; }
    .title { padding: 6px 10px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
    button[role="menuitem"] { display: flex; justify-content: space-between; align-items: center; gap: 14px; width: 100%;
      font: inherit; text-align: left; border: 0; background: transparent; color: var(--text); padding: 6px 10px;
      border-radius: 5px; cursor: pointer; }
    button[role="menuitem"]:hover, button[role="menuitem"]:focus-visible { background: var(--hover); outline: none; }
    kbd { font-family: var(--font); font-size: 10.5px; color: var(--text-muted); }
    .swatches { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 10px 8px; max-width: 220px; }
    .swatch { width: 18px; height: 18px; border-radius: 4px; border: 1px solid rgba(0,0,0,0.15); cursor: pointer; padding: 0; }
    .swatch.on { outline: 2px solid var(--accent); outline-offset: 1px; }
    .swatch.none { background: var(--panel-2); color: var(--text-muted); font-size: 12px; line-height: 1; }
    .sep { height: 1px; background: var(--border); margin: 4px 2px; }
  `,
})
export class CanvasMenuComponent {
  readonly state = input.required<CanvasMenuState>();
  readonly action = output<CanvasMenuAction>();
  readonly closed = output<void>();
  protected readonly colors = HEADER_COLORS;
  private readonly el = inject(ElementRef<HTMLElement>);

  constructor() {
    // Keep the menu inside the canvas.
    afterNextRender(() => {
      const host = this.el.nativeElement as HTMLElement;
      const parent = host.parentElement;
      if (!parent) return;
      const maxX = parent.clientWidth - host.offsetWidth - 6;
      const maxY = parent.clientHeight - host.offsetHeight - 6;
      if (host.offsetLeft > maxX) host.style.left = `${Math.max(6, maxX)}px`;
      if (host.offsetTop > maxY) host.style.top = `${Math.max(6, maxY)}px`;
      host.querySelector<HTMLButtonElement>("button")?.focus();
    });
  }

  protected sameColor(c: string): boolean {
    return (this.state().headerColor ?? "").toLowerCase() === c.toLowerCase();
  }

  protected pick(action: CanvasMenuAction): void {
    this.action.emit(action);
    this.closed.emit();
  }

  protected onOutside(event: PointerEvent): void {
    if (!(this.el.nativeElement as HTMLElement).contains(event.target as Node)) this.closed.emit();
  }
}
