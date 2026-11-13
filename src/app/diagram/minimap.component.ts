import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  untracked,
  viewChild,
} from "@angular/core";

import { boundsOf, type Rect, type Scene } from "./geometry";
import type { DiagramPalette } from "./theme";

const W = 200;
const H = 130;
const PAD = 8;

/** Overview of the whole diagram with the visible area outlined; click or drag to move there. */
@Component({
  selector: "app-minimap",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #c [width]="W * dpr" [height]="H * dpr" [style.width.px]="W" [style.height.px]="H"
    (pointerdown)="onDown($event)" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
    (pointercancel)="onUp($event)" aria-label="Diagram overview; click to move the view"></canvas>`,
  styles: `
    :host { display: block; background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: var(--shadow-sm); overflow: hidden; }
    canvas { display: block; cursor: pointer; touch-action: none; }
  `,
})
export class MinimapComponent {
  readonly scene = input.required<Scene | null>();
  readonly version = input.required<number>();
  readonly view = input.required<Rect>();
  readonly palette = input.required<DiagramPalette>();
  /** Diagram point to centre the view on. */
  readonly navigate = output<{ x: number; y: number }>();

  protected readonly W = W;
  protected readonly H = H;
  protected readonly dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>("c");
  private frame = { x: 0, y: 0, scale: 1 };
  private dragging = false;

  constructor() {
    effect(() => {
      this.version();
      const scene = this.scene();
      const view = this.view();
      const palette = this.palette();
      untracked(() => this.draw(scene, view, palette));
    });
  }

  private draw(scene: Scene | null, view: Rect, p: DiagramPalette): void {
    const ctx = this.canvas().nativeElement.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, W, H);
    if (!scene || scene.tables.size === 0) return;

    // Frame the whole diagram plus the current view, so the outline never leaves the map.
    const b = boundsOf([...scene.tables.values(), view]);
    const scale = Math.min((W - PAD * 2) / Math.max(b.w, 1), (H - PAD * 2) / Math.max(b.h, 1));
    const ox = PAD + (W - PAD * 2 - b.w * scale) / 2 - b.x * scale;
    const oy = PAD + (H - PAD * 2 - b.h * scale) / 2 - b.y * scale;
    this.frame = { x: ox, y: oy, scale };

    ctx.strokeStyle = p.edge;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.6;
    for (const e of scene.edges) {
      ctx.beginPath();
      for (let i = 0; i < e.points.length; i += 2) {
        const x = ox + e.points[i] * scale;
        const y = oy + e.points[i + 1] * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const box of scene.tables.values()) {
      const x = ox + box.x * scale;
      const y = oy + box.y * scale;
      const w = Math.max(2, box.w * scale);
      const h = Math.max(2, box.h * scale);
      ctx.fillStyle = p.tableBody;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = box.table.headerColor ?? p.headerDefault;
      ctx.fillRect(x, y, w, Math.max(1.5, Math.min(h, 34 * scale)));
      ctx.strokeStyle = p.tableBorder;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, w, h);
    }
    ctx.strokeStyle = p.edgeHighlight;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = "rgba(47, 111, 222, 0.08)";
    const vx = ox + view.x * scale;
    const vy = oy + view.y * scale;
    ctx.fillRect(vx, vy, view.w * scale, view.h * scale);
    ctx.strokeRect(vx, vy, view.w * scale, view.h * scale);
  }

  private toDiagram(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas().nativeElement.getBoundingClientRect();
    const { x, y, scale } = this.frame;
    return { x: (e.clientX - r.left - x) / scale, y: (e.clientY - r.top - y) / scale };
  }

  protected onDown(e: PointerEvent): void {
    this.dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.navigate.emit(this.toDiagram(e));
  }

  protected onMove(e: PointerEvent): void {
    if (this.dragging) this.navigate.emit(this.toDiagram(e));
  }

  protected onUp(e: PointerEvent): void {
    this.dragging = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }
}
