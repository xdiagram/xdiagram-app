import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";

import type { Multiplicity, NoPathReason, StepVariant } from "../core/tauri-api.service";
import { displayTable } from "../diagram/view-model";
import { JoinPathStore, MAX_HOPS } from "../state/join-path.store";
import { WorkloadStore } from "../state/workload.store";
import { WorkspaceStore } from "../state/workspace.store";

const MULT: Record<Multiplicity, string> = { one: "1", many: "N", unknown: "?" };

/** `1:N`: how many rows of each side match, in the walking direction. */
export function cardinality(v: StepVariant): string {
  return `${MULT[v.leftMult]}:${MULT[v.rightMult]}`;
}

/** `order_items.order_id = orders.id`, written from the referencing side. */
export function onText(v: StepVariant, left: string, right: string): string {
  const [fkTable, pkTable] = v.forward ? [left, right] : [right, left];
  return v.on
    .map((p) => {
      const [fkCol, pkCol] = v.forward ? [p.from, p.to] : [p.to, p.from];
      return `${displayTable(fkTable)}.${fkCol} = ${displayTable(pkTable)}.${pkCol}`;
    })
    .join(" and ");
}

export function callsText(calls: number): string {
  return calls >= 1_000_000 ? `${(calls / 1_000_000).toFixed(1)}M` : calls >= 1000 ? `${(calls / 1000).toFixed(1)}k` : String(calls);
}

export function reasonText(reason: NoPathReason, from: string, to: string): string {
  switch (reason.kind) {
    case "notConnected":
      return `${displayTable(from)} and ${displayTable(to)} are not connected by any relationship.`;
    case "onlyThroughAvoided":
      return "They are connected only through the tables you are avoiding.";
    case "tooLong":
      return `The shortest path needs ${reason.hops} joins (the limit is ${MAX_HOPS}).`;
    case "noSelfReference":
      return `${displayTable(from)} does not reference itself.`;
  }
}

/** The join path bar over the canvas: the route, its alternatives, Copy as SQL, and why there is none. */
@Component({
  selector: "app-path-bar",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (paths.ends(); as ends) {
      <div class="bar" role="region" aria-label="Join path">
        <div class="row">
          <span class="ends"><b>{{ short(ends.from) }}</b> → <b>{{ short(ends.to) }}</b></span>
          <button type="button" class="icon" (click)="paths.swap()" title="Swap start and end">⇄</button>
          @if (paths.current(); as p) {
            <span class="sep"></span>
            <button type="button" class="icon" (click)="paths.step(-1)" [disabled]="paths.paths().length < 2" title="Previous path (←)">◀</button>
            <span class="count">Path {{ paths.index() + 1 }} of {{ paths.paths().length }}</span>
            <button type="button" class="icon" (click)="paths.step(1)" [disabled]="paths.paths().length < 2" title="Next path (→)">▶</button>
            <span class="muted">{{ p.hops }} {{ p.hops === 1 ? "join" : "joins" }}</span>
            <button type="button" class="primary" (click)="paths.copySql()" title="Copy SELECT … FROM … JOIN … ON … for this path (nothing is run)">Copy as SQL</button>
          } @else if (paths.searching()) {
            <span class="muted">Finding paths…</span>
          }
          @if (paths.hasTraffic()) {
            <label class="toggle" title="Use the joins seen in the queries (X-ray), not only the declared relationships">
              <input type="checkbox" [checked]="paths.includeDiscovered()" (change)="paths.includeDiscovered.set($any($event.target).checked)" />
              Joins from queries
            </label>
          }
          <button type="button" class="icon close" (click)="paths.exit()" title="Close (Esc)" aria-label="Close">✕</button>
        </div>

        @if (paths.current(); as p) {
          <div class="steps">
            <span class="t">{{ short(p.tables[0]) }}</span>
            @for (s of p.steps; track $index; let i = $index) {
              <span class="join" [class.found]="variant(i).kind === 'discovered'">
                <span class="card">{{ card(variant(i)) }}</span>
                @if (s.variants.length > 1) {
                  <select (change)="paths.setVariant(i, +$any($event.target).value)" [attr.aria-label]="'Relationship for join ' + (i + 1)">
                    @for (v of s.variants; track v.edge; let j = $index) {
                      <option [value]="j" [selected]="j === picked(i)">{{ on(v, s.left, s.right) }}</option>
                    }
                  </select>
                } @else {
                  <span class="on">{{ on(variant(i), s.left, s.right) }}</span>
                }
                @if (variant(i).kind === "discovered") {
                  <span class="q" title="Seen in the queries, no foreign key declares it">from queries{{ variant(i).calls ? " · " + calls(variant(i).calls) + " calls" : "" }}</span>
                }
              </span>
              <span class="t">
                {{ short(s.right) }}
                @if (i < p.steps.length - 1) {
                  <button type="button" class="avoid" (click)="paths.avoidTable(s.right)" [title]="'Find paths that do not go through ' + short(s.right)">⊘</button>
                }
              </span>
            }
          </div>
        }

        @if (paths.hiddenOnPath().length; as n) {
          <div class="note">
            Passes through {{ n }} hidden {{ n === 1 ? "table" : "tables" }} ({{ hiddenNames() }}).
            <button type="button" class="link" (click)="paths.showHidden()">Show</button>
          </div>
        }
        @if (paths.avoid().length) {
          <div class="note">
            Avoiding:
            @for (t of paths.avoid(); track t) {
              <span class="chip">{{ short(t) }} <button type="button" (click)="paths.allowTable(t)" [attr.aria-label]="'Allow ' + short(t)">×</button></span>
            }
            <button type="button" class="link" (click)="paths.clearAvoid()">Clear</button>
          </div>
        }
        @if (noPath(); as r) {
          <div class="note warn">
            {{ reason(r, ends.from, ends.to) }}
            @if (r.kind === "notConnected" && xrayHint()) {
              <span class="muted">Turn on X-ray to include the joins seen in the queries.</span>
            }
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 4; max-width: calc(100% - 24px); }
    .bar { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-md);
      font-size: 12.5px; color: var(--text); padding: 4px 6px; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .ends { padding: 0 4px; white-space: nowrap; }
    .sep { width: 1px; height: 18px; background: var(--border); }
    .count { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .muted { color: var(--text-muted); }
    button { font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.4; cursor: default; }
    .icon { border: 0; background: none; color: var(--text); padding: 3px 6px; border-radius: 5px; }
    .icon:hover:not(:disabled) { background: var(--hover); }
    .close { margin-left: auto; color: var(--text-muted); }
    .primary { border: 0; border-radius: 6px; background: var(--accent); color: #fff; padding: 3px 10px; font-weight: 600; }
    .toggle { display: flex; align-items: center; gap: 4px; color: var(--text-muted); white-space: nowrap; cursor: pointer; }
    .toggle input { margin: 0; accent-color: var(--accent); }
    .steps { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; padding: 5px 4px 3px; border-top: 1px solid var(--border);
      margin-top: 4px; font-size: 12px; }
    .t { font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; gap: 2px; }
    .join { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); }
    .join::before, .join::after { content: "—"; opacity: 0.6; }
    .join.found .card, .join.found .on { color: var(--warn, #b45309); }
    .card { font-family: var(--mono); font-size: 11px; border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
    .on { font-family: var(--mono); font-size: 11px; }
    select { font: inherit; font-family: var(--mono); font-size: 11px; color: var(--text); background: var(--input-bg);
      border: 1px solid var(--border); border-radius: 5px; padding: 1px 3px; max-width: 320px; }
    .q { font-size: 11px; }
    .avoid { border: 0; background: none; color: var(--text-muted); padding: 0 3px; font-size: 12px; }
    .avoid:hover { color: var(--danger); }
    .note { padding: 4px 4px 2px; font-size: 12px; color: var(--text-muted); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .note.warn { color: var(--text); }
    .link { border: 0; background: none; color: var(--accent); font-weight: 600; padding: 0; }
    .chip { display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--border); border-radius: 10px; padding: 0 2px 0 7px; }
    .chip button { border: 0; background: none; color: var(--text-muted); padding: 0 4px; }
  `,
})
export class PathBarComponent {
  protected readonly paths = inject(JoinPathStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  protected readonly short = displayTable;
  protected readonly card = cardinality;
  protected readonly on = onText;
  protected readonly calls = callsText;
  protected readonly reason = reasonText;

  protected readonly noPath = computed(() => {
    const o = this.paths.outcome();
    return o?.kind === "noPath" ? o.reason : null;
  });

  protected readonly hiddenNames = computed(() => this.paths.hiddenOnPath().map(displayTable).join(", "));

  /** PostgreSQL with X-ray off: the joins seen in the queries could connect them. */
  protected readonly xrayHint = computed(() => {
    const src = this.workspace.source();
    return src?.kind === "db" && src.engine === "postgres" && !this.workload.enabled();
  });

  protected picked(step: number): number {
    return this.paths.picked()[step] ?? 0;
  }

  protected variant(step: number): StepVariant {
    const s = this.paths.current()!.steps[step];
    return s.variants[this.picked(step)] ?? s.variants[0];
  }
}
