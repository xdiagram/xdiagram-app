import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import type { ColumnProfile, TableProfile } from "../core/tauri-api.service";
import { maskValue, percent } from "./profile-format";

/** Column statistics of a table sample, one card per column. */
@Component({
  selector: "app-profile-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cards">
      @for (c of profile().columns; track c.name) {
        <article class="card" [class.pii]="!!c.pii">
          <header>
            <span class="name" [title]="c.name">{{ c.name }}</span>
            <span class="type">{{ c.typeName }}</span>
            @if (c.pii) {
              <span class="badge" [title]="c.piiBasis === 'values' ? 'Most sampled values look like ' + c.pii : 'The column name suggests ' + c.pii">
                {{ c.pii }}{{ c.piiBasis === "name" ? "?" : "" }}
              </span>
            }
          </header>
          <div class="stat">
            <span class="k">null</span>
            <span class="bar"><i [style.width]="share(c.nulls, c.nulls + c.nonNull)"></i></span>
            <span class="v">{{ pct(c.nulls, c.nulls + c.nonNull) }}</span>
          </div>
          <div class="stat">
            <span class="k">distinct</span>
            <span class="v wide">
              @if (c.unique) {
                all {{ c.nonNull.toLocaleString("en-US") }} different
              } @else {
                {{ c.distinctCapped ? "≥ " : "" }}{{ c.distinct.toLocaleString("en-US") }}
              }
            </span>
          </div>
          @if (c.min !== null) {
            <div class="stat">
              <span class="k">range</span>
              <span class="v wide mono" [title]="show(c, c.min) + ' … ' + show(c, c.max!)">{{ show(c, c.min) }} … {{ show(c, c.max!) }}</span>
            </div>
          }
          @if (c.avgLength !== null) {
            <div class="stat">
              <span class="k">length</span>
              <span class="v wide">avg {{ c.avgLength.toFixed(1) }} · max {{ c.maxLength }}</span>
            </div>
          }
          @if (c.top.length) {
            <ul class="top">
              @for (t of c.top; track t.value) {
                <li [title]="show(c, t.value) + ' — ' + t.count + ' rows'">
                  <span class="bar"><i [style.width]="share(t.count, c.nonNull)"></i></span>
                  <span class="tv mono">{{ show(c, t.value) }}</span>
                  <span class="tc">{{ pct(t.count, c.nonNull) }}</span>
                </li>
              }
            </ul>
          }
        </article>
      }
    </div>
  `,
  styles: `
    :host { display: block; overflow: auto; flex: 1; min-height: 0; padding: 8px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
    .card { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--panel); font-size: 12px; min-width: 0; }
    .card.pii { border-color: rgba(217, 119, 6, 0.55); }
    header { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; min-width: 0; }
    .name { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .type { color: var(--text-muted); font-family: var(--mono); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .badge { flex: none; font-size: 10.5px; font-weight: 600; color: #b45309; background: rgba(217, 119, 6, 0.12); border-radius: 8px; padding: 0 6px; }
    .stat { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
    .k { width: 52px; flex: none; color: var(--text-muted); }
    .v { flex: none; font-variant-numeric: tabular-nums; }
    .v.wide { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: var(--mono); font-size: 11px; }
    .bar { flex: 1; height: 6px; background: var(--hover); border-radius: 3px; overflow: hidden; min-width: 30px; }
    .bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
    .top { list-style: none; margin: 6px 0 0; padding: 6px 0 0; border-top: 1px dashed var(--border); }
    .top li { display: grid; grid-template-columns: 40px 1fr auto; align-items: center; gap: 6px; margin: 2px 0; }
    .tv { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tc { color: var(--text-muted); font-variant-numeric: tabular-nums; font-size: 11px; }
  `,
})
export class ProfileViewComponent {
  readonly profile = input.required<TableProfile>();
  /** Show values of personal-data columns unmasked. */
  readonly reveal = input(false);

  protected readonly pct = percent;

  protected share(part: number, whole: number): string {
    return whole && part ? `${Math.max(2, Math.round((part / whole) * 100))}%` : "0%";
  }

  protected show(c: ColumnProfile, value: string): string {
    return c.pii && !this.reveal() ? maskValue(value) : value;
  }
}
