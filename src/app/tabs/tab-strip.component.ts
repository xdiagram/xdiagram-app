import { ChangeDetectionStrategy, Component, inject } from "@angular/core";

import { TabsStore } from "../state/tabs.store";

/** The open documents, one tab each (Ctrl+Tab / Ctrl+Shift+Tab to switch, Ctrl+W to close). */
@Component({
  selector: "app-tab-strip",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="strip" role="tablist" aria-label="Open documents">
      @for (t of tabs.views(); track t.id) {
        <div class="tab" [class.active]="t.active" [class.pending]="t.pending">
          <button type="button" role="tab" class="tab-main" [attr.aria-selected]="t.active" [title]="t.detail"
            (click)="tabs.activate(t.id)" (auxclick)="$event.button === 1 && tabs.close(t.id)">
            @if (t.kind) {
              <span class="kind">{{ t.kind }}</span>
            }
            <span class="label">{{ t.label }}</span>
            @if (t.dirty) {
              <i class="dot" aria-label="unsaved changes"></i>
            }
          </button>
          <button type="button" class="close" (click)="tabs.close(t.id)" [attr.aria-label]="'Close ' + t.label" title="Close (Ctrl+W)">×</button>
        </div>
      }
      <button type="button" class="new" (click)="tabs.newTab()" aria-label="New tab" title="New tab (Ctrl+T)">+</button>
    </div>
  `,
  styles: `
    :host { display: block; background: var(--panel-2); border-bottom: 1px solid var(--border); flex: none; }
    .strip { display: flex; align-items: stretch; gap: 1px; height: 32px; overflow-x: auto; scrollbar-width: none; padding: 0 6px; }
    .tab { display: flex; align-items: center; max-width: 240px; min-width: 0; border-radius: 7px 7px 0 0; margin-top: 4px;
      color: var(--text-muted); }
    .tab:hover { background: var(--hover); }
    .tab.active { background: var(--panel); color: var(--text); box-shadow: 0 0 0 1px var(--border); clip-path: inset(-1px -1px 0 -1px); }
    .tab.pending .label { font-style: italic; }
    .tab-main { display: flex; align-items: center; gap: 6px; min-width: 0; height: 100%; border: 0; background: none; color: inherit;
      font: inherit; font-size: 12.5px; padding: 0 4px 0 10px; cursor: pointer; }
    .kind { flex: none; font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent); }
    .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
    .close { flex: none; width: 22px; height: 22px; margin-right: 4px; border: 0; border-radius: 5px; background: none; color: var(--text-muted);
      font-size: 14px; line-height: 1; cursor: pointer; opacity: 0; }
    .tab:hover .close, .tab.active .close, .close:focus-visible { opacity: 1; }
    .close:hover { background: var(--hover); color: var(--text); }
    .new { flex: none; width: 28px; margin: 4px 0 0 2px; border: 0; border-radius: 7px 7px 0 0; background: none; color: var(--text-muted);
      font-size: 16px; cursor: pointer; }
    .new:hover { background: var(--hover); color: var(--text); }
  `,
})
export class TabStripComponent {
  protected readonly tabs = inject(TabsStore);
}
