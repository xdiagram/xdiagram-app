import { ChangeDetectionStrategy, Component, inject } from "@angular/core";

import { displayTable } from "../diagram/view-model";
import { sqlComment } from "../export/sql-comment";
import { WorkloadStore } from "../state/workload.store";
import { WorkspaceStore } from "../state/workspace.store";

@Component({
  selector: "app-workload-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="title">X-ray</span>
      @if (workload.enabled()) {
        <button type="button" class="link" (click)="workload.analyzing() ? workload.cancelAnalyze() : workload.analyze()"
          [title]="workload.analyzing() ? 'Stop the analysis' : 'Read the statistics again'">
          {{ workload.analyzing() ? "Analysing… Cancel" : "Re-analyse" }}
        </button>
      }
    </div>
    <div class="body">
      @if (!workload.enabled()) {
        <div class="card">
          <p class="lead">See what this database <strong>actually does</strong>, not just what it declares:</p>
          <ul class="bullets">
            <li>relationships found in real queries that have no foreign key, with one click to add them to the DBML</li>
            <li>live reads and writes glowing on the diagram, idle tables dimmed</li>
            <li>per-table and per-FK facts: row counts, scan patterns, de facto cardinality</li>
          </ul>
          <button type="button" class="primary" (click)="workload.enable()" [disabled]="!postgres()">
            Turn on X-ray
          </button>
          @if (!postgres()) {
            <p class="hint">{{ store.source()?.kind === "db" ? "X-ray reads PostgreSQL's statistics views, so it is only available for PostgreSQL connections." : "Connect to a PostgreSQL database first." }}</p>
          } @else {
            <p class="hint">Read-only. Relationship discovery needs the <code>pg_stat_statements</code> extension.</p>
          }
        </div>
      } @else {
        <div class="card">
          @if (workload.analyzing() && !workload.report()) {
            <p class="hint">Reading statistics…</p>
          } @else if (workload.report(); as r) {
            @if (r.available) {
              <p class="ok">
                pg_stat_statements {{ r.extensionVersion }} · {{ r.statements.parsed }} of {{ r.statements.total }} statements analysed
              </p>
              @if (r.statements.unparsed) {
                <p class="hint">{{ r.statements.unparsed }} statement{{ r.statements.unparsed === 1 ? "" : "s" }} could not be parsed and were skipped.</p>
              }
              @if (r.statements.redacted) {
                <p class="warn">{{ r.statements.redacted }} statements are hidden from this role. Grant <code>pg_read_all_stats</code> to include them.</p>
              }
            } @else {
              <p class="warn">Query workload unavailable: {{ r.reason }}</p>
              <p class="hint">Live activity and table facts still work.</p>
            }
          }
          <label class="live">
            <input type="checkbox" [checked]="workload.liveOn()" (change)="workload.toggleLive()" />
            <span>Live activity</span>
            <select (change)="workload.setInterval(+$any($event.target).value)" aria-label="Sampling interval">
              @for (ms of intervals; track ms) {
                <option [value]="ms" [selected]="ms === workload.intervalMs()">every {{ ms / 1000 }} s</option>
              }
            </select>
          </label>
        </div>

        <section>
          <h3>Found in queries, no FK <span class="count">{{ workload.discovered().length }}</span></h3>
          @for (ref of workload.discovered(); track ref.id) {
            <div class="rel">
              <button type="button" class="name" (click)="focus(ref.from.table)">{{ short(ref.from.table) }}.{{ ref.from.fields.join(", ") }}</button>
              <span class="arrow">{{ ref.discovered?.directed ? "→" : "—" }}</span>
              <button type="button" class="name" (click)="focus(ref.to.table)">{{ short(ref.to.table) }}.{{ ref.to.fields.join(", ") }}</button>
              <span class="calls" title="calls recorded by pg_stat_statements">{{ ref.discovered?.calls }}×</span>
              <button type="button" class="add" (click)="workload.promote(ref)" title="Add this relationship to the DBML">Add</button>
            </div>
          } @empty {
            <p class="hint">
              {{ workload.report()?.available ? "Every join in the recorded workload is backed by a foreign key." : "Needs pg_stat_statements." }}
            </p>
          }
          @if (workload.discovered().length > 1) {
            <button type="button" class="link" (click)="workload.promoteAll()">Add all to DBML</button>
          }
        </section>

        @if (workload.report()?.available) {
          <section>
            <h3>Declared FKs never joined <span class="count">{{ workload.neverJoined().length }}</span></h3>
            @for (u of workload.neverJoined(); track u.name) {
              <div class="rel">
                <button type="button" class="name" (click)="focus(id(u.from))">{{ short(id(u.from)) }}.{{ u.from.columns.join(", ") }}</button>
                <span class="arrow">→</span>
                <span class="name muted">{{ short(id(u.to)) }}</span>
              </div>
            } @empty {
              <p class="hint">Every declared relationship is used by the recorded queries.</p>
            }
          </section>
        }

        @if (workload.report()) {
          <section>
            <h3>Index suggestions <span class="count">{{ workload.indexAdvice().length }}</span></h3>
            @for (a of workload.indexAdvice(); track $index) {
              <div class="advice">
                <div class="adv-head">
                  <span class="adv-kind" [class]="'adv-kind ' + a.kind">{{ kindLabel(a.kind) }}</span>
                  <button type="button" class="name" (click)="focus(a.schema + '.' + a.table)">
                    {{ a.indexName ?? short(a.schema + '.' + a.table) + "(" + a.columns.join(", ") + ")" }}
                  </button>
                </div>
                <p class="adv-reason">{{ a.reason }}</p>
                <div class="adv-sql">
                  <code>{{ a.sql }}</code>
                  <button type="button" class="add" (click)="workload.copy(a.sql)">Copy</button>
                </div>
              </div>
            } @empty {
              <p class="hint">No index changes suggested for the recorded workload.</p>
            }
            @if (workload.indexAdvice().length > 1) {
              <button type="button" class="link" (click)="saveAllAdvice()">Save all as .sql</button>
            }
          </section>
        }

        <section>
          <h3>Idle tables <span class="count">{{ workload.idleTables().length }}</span></h3>
          @for (t of workload.idleTables(); track id(t)) {
            <div class="rel">
              <button type="button" class="name" (click)="focus(id(t))">{{ short(id(t)) }}</button>
              <span class="calls">{{ rows(t.rows) }} rows</span>
            </div>
          } @empty {
            <p class="hint">Every table was read or written since the statistics were reset.</p>
          }
        </section>

        <section>
          <h3>Sequential-scan heavy <span class="count">{{ workload.seqScanHeavy().length }}</span></h3>
          @for (t of workload.seqScanHeavy(); track id(t)) {
            <div class="rel">
              <button type="button" class="name" (click)="focus(id(t))">⚑ {{ short(id(t)) }}</button>
              <span class="calls">{{ t.seqScan }} seq / {{ t.idxScan }} idx</span>
            </div>
          } @empty {
            <p class="hint">No large table is scanned sequentially more often than by index.</p>
          }
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
    .head { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 12px;
      border-bottom: 1px solid var(--border); font-size: 12px; flex: none; }
    .title { font-weight: 600; letter-spacing: 0.04em; color: var(--text-muted); text-transform: uppercase; }
    .body { overflow: auto; flex: 1; padding: 10px; font-size: 12.5px; }
    .card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    .lead { margin: 0 0 6px; line-height: 1.45; }
    .bullets { margin: 0 0 10px; padding-left: 18px; color: var(--text-muted); line-height: 1.45; }
    .bullets li + li { margin-top: 3px; }
    .primary { font: inherit; font-size: 12.5px; font-weight: 600; width: 100%; padding: 8px; border: 0; border-radius: 7px;
      background: var(--accent); color: #fff; cursor: pointer; }
    .primary:hover:not(:disabled) { background: var(--accent-strong); }
    .primary:disabled { opacity: 0.55; cursor: default; }
    .hint { margin: 6px 0 0; color: var(--text-muted); line-height: 1.4; }
    .ok { margin: 0; color: var(--ok); line-height: 1.4; }
    .warn { margin: 0; color: var(--danger); line-height: 1.4; }
    .warn + .hint, .ok + .hint { margin-top: 4px; }
    code { font-size: 11.5px; }
    .live { display: flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer; }
    .live span { flex: 1; }
    .live select { font: inherit; font-size: 12px; color: var(--text); background: var(--input-bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 3px 6px; }
    .live input { margin: 0; accent-color: var(--accent); }
    section { margin-bottom: 14px; }
    h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 11.5px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
    .count { font-weight: 500; background: var(--hover); border-radius: 9px; padding: 0 7px; font-size: 11px; }
    .rel { display: flex; align-items: center; gap: 5px; padding: 3px 4px; border-radius: 6px; min-width: 0; }
    .rel:hover { background: var(--hover); }
    .name { flex: 1 1 auto; min-width: 0; border: 0; background: none; color: var(--text); font: inherit; font-size: 12px;
      font-family: var(--mono); text-align: left; padding: 2px 0; cursor: pointer; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .name.muted { color: var(--text-muted); cursor: default; }
    .arrow { color: #d97706; flex: none; }
    .calls { flex: none; color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .add { flex: none; font: inherit; font-size: 11.5px; font-weight: 600; border: 1px solid var(--border);
      background: var(--panel); color: var(--accent); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    .add:hover { background: var(--accent-soft); }
    .link { border: 0; background: none; color: var(--accent); font: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; padding: 4px; }
    .link:disabled { opacity: 0.6; cursor: default; }
    .advice { border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; margin-bottom: 6px; }
    .adv-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .adv-kind { flex: none; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px;
      border-radius: 9px; background: var(--accent-soft); color: var(--accent); }
    .adv-kind.unused, .adv-kind.duplicate { background: var(--hover); color: var(--text-muted); }
    .adv-reason { margin: 4px 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.4; }
    .adv-sql { display: flex; align-items: flex-start; gap: 6px; }
    .adv-sql code { flex: 1; min-width: 0; font-size: 10.5px; word-break: break-all; background: var(--panel-2); padding: 3px 5px; border-radius: 4px; }
  `,
})
export class WorkloadPanelComponent {
  protected readonly workload = inject(WorkloadStore);
  protected readonly store = inject(WorkspaceStore);
  protected readonly intervals = [1000, 3000, 5000, 15000];
  protected readonly short = displayTable;
  protected postgres(): boolean {
    const src = this.store.source();
    return src?.kind === "db" && src.engine === "postgres";
  }

  protected kindLabel(kind: string): string {
    return (
      { fk_unindexed: "FK, no index", filter_seq_scan: "Filter, no index", unused: "Unused", duplicate: "Duplicate" } as Record<string, string>
    )[kind] ?? kind;
  }

  protected saveAllAdvice(): void {
    const items = this.workload.indexAdvice();
    const lines = [
      "-- Index suggestions from xdiagram X-ray. Review each statement before running it.",
      "-- CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block.",
      "",
    ];
    // Reasons name tables and indexes, which may contain line breaks.
    for (const a of items) lines.push(sqlComment(`[${this.kindLabel(a.kind)}] ${a.reason}`), a.sql, "");
    void this.workload.saveSql("index-suggestions.sql", lines.join("\n"));
  }

  protected id(e: { schema: string; table: string }): string {
    return `${e.schema}.${e.table}`;
  }

  protected rows(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
  }

  protected focus(id: string): void {
    if (this.store.hidden().has(id)) this.store.toggleHidden(id);
    setTimeout(() => this.store.diagram?.focusTable(id), 0);
  }
}
