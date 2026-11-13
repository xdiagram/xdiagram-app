import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from "@angular/core";

import { ThemeService } from "../core/theme.service";
import { edgeStrokeWidth, markerSegments, sceneBounds, type EdgeRoute } from "../diagram/geometry";
import { DARK, LIGHT } from "../diagram/theme";
import { displayTable } from "../diagram/view-model";
import { RowGraphStore, type Viewport } from "../state/row-graph.store";
import { WorkspaceStore } from "../state/workspace.store";
import { RowCardComponent } from "./row-card.component";
import { CARD_W, MAX_NODES, MAX_PER_REF, MORE_H, keyLabel, type MoreMarker } from "./row-graph";

const MIN_SCALE = 0.2;
const MAX_SCALE = 2;
const FIT_PAD = 40;
/** The automatic fit after loading never zooms out further than this (Fit does). */
const READABLE_SCALE = 0.75;

/**
 * The related-data map: a large overlay with the rows as cards, foreign keys as edges, its own
 * pan (drag the background, or wheel) and zoom (Ctrl+wheel). Esc or × hides it; the map is kept.
 */
@Component({
  selector: "app-row-graph",
  imports: [RowCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(document:keydown.escape)": "store.hide()", "[style]": "vars()" },
  template: `
    <div class="backdrop"></div>
    <section class="panel" role="dialog" aria-modal="true" aria-label="Related data">
      <header>
        <span class="title">Related data</span>
        @if (rootTitle(); as t) {
          <span class="root">{{ t }}</span>
        }
        <span class="count">{{ store.cards().length }} row{{ store.cards().length === 1 ? "" : "s" }}</span>
        @if (store.busy()) {
          <span class="busy">Loading… <button type="button" class="btn" (click)="store.cancel()">Cancel</button></span>
        }
        @if (store.error(); as e) {
          <span class="error" [title]="e">{{ e }}</span>
        } @else if (store.notice(); as n) {
          <span class="notice">{{ n }}</span>
        }
        <span class="spacer"></span>
        <span class="hint">+ on a card loads its links · drag cards or the background · Ctrl+wheel zooms</span>
        <div class="zoom" role="group" aria-label="Zoom">
          <button type="button" class="btn icon" (click)="zoomBy(1 / 1.2)" title="Zoom out" aria-label="Zoom out">−</button>
          <span class="pct">{{ pct() }}%</span>
          <button type="button" class="btn icon" (click)="zoomBy(1.2)" title="Zoom in" aria-label="Zoom in">+</button>
        </div>
        <button type="button" class="btn" (click)="fit()" title="Show the whole map">Fit</button>
        <button type="button" class="btn" (click)="store.tidyUp()" title="Lay the cards out again (undoes dragging)">Tidy</button>
        <button type="button" class="btn icon close" (click)="store.hide()" title="Close (Esc) — the map is kept" aria-label="Close">×</button>
      </header>
      <div class="viewport" #viewport (wheel)="onWheel($event)" (pointerdown)="onPointerDown($event)" [class.panning]="panning()">
        <div class="world" [style.transform]="transform()">
          <svg class="edges" width="1" height="1" aria-hidden="true">
            @for (e of store.scene().edges; track e.ref.id) {
              @let hot = isHot(e);
              <g>
                <title>{{ edgeTitle(e) }}</title>
                <polyline class="hit" [attr.points]="e.points.join(' ')" />
                <polyline [attr.points]="e.points.join(' ')" fill="none" [attr.stroke]="edgeColor(e, hot)"
                  [attr.stroke-width]="edgeStrokeWidth(e) + (hot ? 0.8 : 0)" [attr.stroke-dasharray]="e.kind === 'discovered' ? '6 4' : null"
                  stroke-linejoin="round" />
                @if (e.directed) {
                  @for (s of ends(e); track $index) {
                    <line [attr.x1]="s[0]" [attr.y1]="s[1]" [attr.x2]="s[2]" [attr.y2]="s[3]" [attr.stroke]="edgeColor(e, hot)"
                      [attr.stroke-width]="edgeStrokeWidth(e) + (hot ? 0.8 : 0)" />
                  }
                }
              </g>
            }
          </svg>
          @for (c of store.cards(); track c.node.id) {
            <app-row-card [card]="c" [full]="full()" [style.left.px]="c.node.x" [style.top.px]="c.node.y"
              (mouseenter)="hovered.set(c.node.id)" (mouseleave)="hovered.set(null)"
              (expand)="store.expand(c.node.id, $event)" (toggleAll)="store.toggleAll(c.node.id)" (openInGrid)="store.openInGrid(c.node.id)"
              (startHere)="store.startHere(c.node.id)" (copy)="copy($event)" (dragStart)="startDrag(c.node.id, $event)" />
          }
          @for (m of pills(); track m.id) {
            <div class="pill" [style.left.px]="m.x" [style.top.px]="m.y" [style.width.px]="cardW" [style.height.px]="moreH">
              <span class="ptxt" [title]="displayTable(m.tableId) + ': more rows reference this one'">{{ displayTable(m.tableId) }}: {{ m.shown }} shown</span>
              @if (m.shown < maxPerRef) {
                <button type="button" (click)="store.showMore(m.id)" [disabled]="store.loadingMore().has(m.id) || full()">
                  {{ store.loadingMore().has(m.id) ? "Loading…" : "More" }}</button>
              }
              <button type="button" (click)="store.openMoreInGrid(m.id)" title="Open all of them in the data browser">All in grid ↗</button>
            </div>
          }
        </div>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 30; display: block; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop, rgba(15, 23, 42, 0.35)); }
    .panel { position: absolute; inset: 24px; display: flex; flex-direction: column; background: var(--rc-canvas); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: var(--shadow-md, 0 12px 40px rgba(0, 0, 0, 0.3)); overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: var(--panel); border-bottom: 1px solid var(--border);
      font-size: 12px; flex: none; min-width: 0; }
    .title { font-weight: 600; font-size: 13px; flex: none; }
    .root { font-family: var(--mono); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .count { color: var(--text-muted); flex: none; font-variant-numeric: tabular-nums; }
    .busy { display: flex; align-items: center; gap: 6px; color: var(--text-muted); flex: none; }
    .error { color: var(--danger); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .notice { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .spacer { flex: 1; }
    .hint { color: var(--text-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
    .zoom { display: flex; align-items: center; gap: 2px; flex: none; }
    .pct { width: 40px; text-align: center; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .btn { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 6px;
      padding: 2px 9px; cursor: pointer; flex: none; }
    .btn:hover { background: var(--hover); }
    .btn.icon { width: 26px; padding: 2px 0; }
    .close { border-color: transparent; font-size: 16px; line-height: 1; }
    .viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: default; touch-action: none;
      background-color: var(--rc-canvas); background-image: radial-gradient(var(--rc-grid) 1px, transparent 1px);
      background-size: 22px 22px; }
    .viewport.panning { cursor: grabbing; }
    .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    .edges { position: absolute; left: 0; top: 0; overflow: visible; }
    .edges .hit { fill: none; stroke: transparent; stroke-width: 10; }
    .pill { position: absolute; display: flex; align-items: center; gap: 6px; box-sizing: border-box; padding: 0 6px 0 10px; border-radius: 15px;
      border: 1px dashed var(--rc-border); background: var(--rc-body); color: var(--rc-type); font-size: 11.5px; }
    .ptxt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pill button { flex: none; font: inherit; font-size: 11.5px; border: 0; background: transparent; color: var(--rc-selected); cursor: pointer;
      padding: 2px 6px; border-radius: 10px; }
    .pill button:hover:not(:disabled) { background: var(--rc-hover); }
    .pill button:disabled { color: var(--rc-type); cursor: default; }
  `,
})
export class RowGraphComponent {
  protected readonly store = inject(RowGraphStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly theme = inject(ThemeService);
  private readonly viewportRef = viewChild.required<ElementRef<HTMLElement>>("viewport");

  protected readonly displayTable = displayTable;
  protected readonly edgeStrokeWidth = edgeStrokeWidth;
  protected readonly cardW = CARD_W;
  protected readonly moreH = MORE_H;
  protected readonly maxPerRef = MAX_PER_REF;

  /** The view the map had when it was hidden (null for a new map). */
  private readonly restored = this.store.viewport;
  protected readonly view = signal<Viewport>(this.restored ?? { x: 0, y: 0, scale: 1 });
  protected readonly panning = signal(false);
  protected readonly hovered = signal<string | null>(null);
  /** Whether the view was fitted to the map once it loaded (a reopened map keeps its view). */
  private fitted = !!this.restored;
  private readonly rendered = signal(false);

  protected readonly palette = computed(() => (this.theme.dark() ? DARK : LIGHT));
  protected readonly vars = computed(() => {
    const p = this.palette();
    return {
      "--rc-canvas": p.background,
      "--rc-grid": p.grid,
      "--rc-body": p.tableBody,
      "--rc-border": p.tableBorder,
      "--rc-selected": p.tableBorderSelected,
      "--rc-shadow": p.tableShadow,
      "--rc-header": p.headerDefault,
      "--rc-header-text": p.headerText,
      "--rc-divider": p.rowDivider,
      "--rc-hover": p.rowHover,
      "--rc-name": p.fieldName,
      "--rc-type": p.fieldType,
      "--rc-pk": p.pkBadge,
      "--rc-fk": p.fkBadge,
      "--rc-badge-text": p.badgeText,
    };
  });
  protected readonly transform = computed(() => {
    const v = this.view();
    return `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  });
  protected readonly pct = computed(() => Math.round(this.view().scale * 100));
  protected readonly pills = computed<MoreMarker[]>(() => [...(this.store.graph()?.more.values() ?? [])]);
  protected readonly full = computed(() => this.store.cards().length >= MAX_NODES);
  protected readonly rootTitle = computed(() => {
    const g = this.store.graph();
    const root = g?.nodes.get(g.rootId);
    if (!root) return null;
    const table = this.workspace.view().tables.find((t) => t.id === root.tableId);
    return `${table?.label ?? displayTable(root.tableId)} ${keyLabel(root, table?.primaryKey ?? [])}`;
  });

  constructor() {
    // Keep the view when the map is hidden, so reopening it shows the same place.
    effect(() => {
      const v = this.view();
      untracked(() => (this.store.viewport = v));
    });
    afterNextRender(() => {
      if (!this.restored) this.centerRoot();
      this.rendered.set(true);
    });
    // A new map ("Start here") starts centred on its row, then fits once its first links loaded.
    let rootId = this.store.graph()?.rootId ?? null;
    effect(() => {
      const g = this.store.graph();
      const root = g?.nodes.get(g.rootId);
      if (!g || !root || !this.rendered()) return;
      untracked(() => {
        if (g.rootId !== rootId) {
          rootId = g.rootId;
          this.fitted = false;
          this.centerRoot();
        }
        if (this.fitted || root.parents === "loading" || root.children === "loading") return;
        this.fitted = true;
        if (g.nodes.size > 1) this.fitReadable();
      });
    });
  }

  protected isHot(e: EdgeRoute): boolean {
    const h = this.hovered();
    return !!h && (e.ref.from.table === h || e.ref.to.table === h);
  }

  protected edgeColor(e: EdgeRoute, hot: boolean): string {
    const p = this.palette();
    if (hot) return p.edgeHighlight;
    return e.kind === "discovered" ? p.edgeDiscovered : p.edge;
  }

  protected ends(e: EdgeRoute): number[][] {
    return [...markerSegments(e.from), ...markerSegments(e.to)];
  }

  protected edgeTitle(e: EdgeRoute): string {
    const ref = this.store.refById(e.ref.id);
    if (!ref) return "";
    const how = ref.discovered ? " (found in queries)" : "";
    return `${displayTable(ref.from.table)}.${ref.from.fields.join(", ")} → ${displayTable(ref.to.table)}.${ref.to.fields.join(", ")}${how}`;
  }

  protected copy(value: string | null): void {
    if (value === null) return;
    void navigator.clipboard?.writeText(value).then(() => this.workspace.flash("Value copied"));
  }

  // ------------------------------------------------------------------ viewport

  private size(): { w: number; h: number } {
    const el = this.viewportRef().nativeElement;
    return { w: el.clientWidth, h: el.clientHeight };
  }

  private centerRoot(): void {
    const { w, h } = this.size();
    const g = this.store.graph();
    const root = g?.nodes.get(g.rootId);
    this.view.set({ x: w / 2 - CARD_W / 2 - (root?.x ?? 0), y: h / 2 - 120 - (root?.y ?? 0), scale: 1 });
  }

  /** Shows the whole map (never zooming in past `maxScale`). */
  protected fit(maxScale = MAX_SCALE): void {
    const scene = this.store.scene();
    if (!scene.tables.size) return;
    const b = sceneBounds(scene);
    let { x: minX, y: minY } = b;
    let maxX = b.x + b.w;
    let maxY = b.y + b.h;
    for (const m of this.pills()) {
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + CARD_W);
      maxY = Math.max(maxY, m.y + MORE_H);
    }
    // Room for the expand buttons and markers sticking out of the cards.
    minX -= 24;
    maxX += 24;
    const { w, h } = this.size();
    const scale = clamp(Math.min((w - FIT_PAD * 2) / (maxX - minX), (h - FIT_PAD * 2) / (maxY - minY), maxScale), MIN_SCALE, MAX_SCALE);
    this.view.set({ x: w / 2 - ((minX + maxX) / 2) * scale, y: h / 2 - ((minY + maxY) / 2) * scale, scale });
  }

  /** Fits the map, unless that makes it unreadable: then stays readable, centred on the root. */
  private fitReadable(): void {
    this.fit(1);
    if (this.view().scale >= READABLE_SCALE) return;
    const g = this.store.graph();
    const root = g?.nodes.get(g.rootId);
    if (!root) return;
    const { w, h } = this.size();
    const s = READABLE_SCALE;
    this.view.set({ x: w / 2 - (root.x + CARD_W / 2) * s, y: h / 2 - (root.y + 60) * s, scale: s });
  }

  protected zoomBy(factor: number): void {
    const { w, h } = this.size();
    this.zoomAt(w / 2, h / 2, factor);
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const v = this.view();
    const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
    const wx = (px - v.x) / v.scale;
    const wy = (py - v.y) / v.scale;
    this.view.set({ x: px - wx * scale, y: py - wy * scale, scale });
  }

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = this.viewportRef().nativeElement.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0025));
    } else {
      this.view.update((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  }

  /** Drag on the background (or an edge) pans. */
  protected onPointerDown(e: PointerEvent): void {
    if ((e.button !== 0 && e.button !== 1) || (e.target as Element).closest("app-row-card, .pill")) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, vx: this.view().x, vy: this.view().y };
    this.panning.set(true);
    this.track(e, (ev) => this.view.update((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y })), () => this.panning.set(false));
  }

  /** Moves a card with the pointer (after a few pixels, so clicks stay clicks). */
  protected startDrag(id: string, e: PointerEvent): void {
    const node = this.store.graph()?.nodes.get(id);
    if (!node) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y };
    let moving = false;
    this.track(e, (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moving && Math.hypot(dx, dy) < 3) return;
      moving = true;
      const s = this.view().scale;
      this.store.moveNode(id, Math.round(start.nx + dx / s), Math.round(start.ny + dy / s));
    });
  }

  private track(e: PointerEvent, move: (ev: PointerEvent) => void, end?: () => void): void {
    const el = this.viewportRef().nativeElement;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      end?.();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
