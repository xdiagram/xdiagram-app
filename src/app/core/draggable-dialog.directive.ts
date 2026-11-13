import { Directive, ElementRef, afterNextRender, inject, signal } from "@angular/core";

/** How much of a dialog stays on screen while it is dragged (px). */
const KEEP_VISIBLE = 80;

/**
 * Lets a modal dialog be moved by dragging its title: the element marked `data-drag-handle`, or
 * else its first `h2`. The title always stays reachable on screen; double-clicking it puts the
 * dialog back in the centre. Dialogs open centred (they are created anew each time).
 */
@Directive({
  selector: "[appDraggableDialog]",
  host: { "[style.translate]": "translate()" },
})
export class DraggableDialogDirective {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private offset = { x: 0, y: 0 };
  protected readonly translate = signal("none");

  constructor() {
    afterNextRender(() => {
      const dialog = this.el.nativeElement;
      const handle = dialog.querySelector<HTMLElement>("[data-drag-handle]") ?? dialog.querySelector<HTMLElement>("h2");
      if (!handle) return;
      handle.style.cursor = "move";
      handle.style.userSelect = "none";
      handle.style.touchAction = "none";
      handle.title ||= "Drag to move · double-click to centre";
      handle.addEventListener("pointerdown", (e) => this.start(e, handle));
      handle.addEventListener("dblclick", () => this.moveTo(0, 0));
    });
  }

  private start(e: PointerEvent, handle: HTMLElement): void {
    // Buttons, fields and links inside the title keep working.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const from = { ...this.offset };
    const rect = this.el.nativeElement.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      // Keep the title on screen: not above the top, not below the bottom, partly visible sideways.
      const dx = clamp(ev.clientX - startX, KEEP_VISIBLE - rect.right, innerWidth - KEEP_VISIBLE - rect.left);
      const dy = clamp(ev.clientY - startY, -rect.top, innerHeight - 40 - rect.top);
      this.moveTo(from.x + dx, from.y + dy);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  private moveTo(x: number, y: number): void {
    this.offset = { x, y };
    this.translate.set(x || y ? `${Math.round(x)}px ${Math.round(y)}px` : "none");
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
