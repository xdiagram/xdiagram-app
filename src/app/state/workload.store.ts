import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  FkCardinality,
  FkUsage,
  IndexAdvice,
  LiveSample,
  RelationCheck,
  TableFacts,
  TableRate,
  TauriApi,
  WorkloadEndpoint,
  WorkloadReport,
  errorMessage,
} from "../core/tauri-api.service";
import { refLine, splitTableId } from "../diagram/canvas-edit";
import { VEndpoint, VRef, refKey } from "../diagram/view-model";
import { WorkspaceStore } from "./workspace.store";

const PULSE_MS = 700;

function endpointOf(e: WorkloadEndpoint): VEndpoint {
  return { table: `${e.schema}.${e.table}`, fields: e.columns, many: false };
}

/** `Ref:` line for a discovered relationship, in the quoting style `generateDbml` uses. */
export function dbmlRefLine(ref: VRef): string {
  return refLine(ref.from, ref.to, ref.discovered?.directed === false ? "-" : ">");
}

/**
 * X-ray mode: what the database actually does, layered over the declared diagram.
 * Holds the workload report (discovered relationships, FK usage, table facts, cardinality)
 * and the live activity rates streamed from the Rust session.
 */
@Injectable({ providedIn: "root" })
export class WorkloadStore {
  private readonly api = inject(TauriApi);
  private readonly workspace = inject(WorkspaceStore);

  readonly enabled = signal(false);
  readonly report = signal<WorkloadReport | null>(null);
  readonly analyzing = signal(false);
  readonly liveOn = signal(false);
  readonly intervalMs = signal(3000);
  readonly rates = signal<ReadonlyMap<string, TableRate>>(new Map());
  /** Tables that wrote since the previous sample; cleared shortly after each sample. */
  readonly pulse = signal<ReadonlySet<string>>(new Set());
  readonly lastSampleAt = signal<number | null>(null);
  readonly error = signal<string | null>(null);

  /** Discovered relationships as diagram refs: only between visible tables, minus declared ones. */
  readonly discovered = computed<VRef[]>(() => {
    const report = this.report();
    if (!this.enabled() || !report) return [];
    const view = this.workspace.view();
    const hidden = this.workspace.hidden();
    const tables = new Map(view.tables.map((t) => [t.id, t]));
    const declared = new Set(view.refs.map((r) => refKey(r.from, r.to)));
    const out: VRef[] = [];
    for (const rel of report.relations) {
      const from: VEndpoint = { ...endpointOf(rel.from), many: rel.directed };
      const to = endpointOf(rel.to);
      const fromTable = tables.get(from.table);
      const toTable = tables.get(to.table);
      if (!fromTable || !toTable || hidden.has(from.table) || hidden.has(to.table)) continue;
      if (declared.has(refKey(from, to))) continue;
      const hasFields = (t: typeof fromTable, fields: string[]) => fields.every((f) => t.fields.some((x) => x.name === f));
      if (!hasFields(fromTable, from.fields) || !hasFields(toTable, to.fields)) continue;
      out.push({
        id: `discovered:${from.table}(${from.fields.join(",")})->${to.table}(${to.fields.join(",")})`,
        name: null,
        from,
        to,
        onDelete: null,
        onUpdate: null,
        discovered: { calls: rel.calls, statements: rel.statements, directed: rel.directed, queries: rel.queries },
      });
    }
    return out;
  });

  readonly facts = computed(() => {
    const m = new Map<string, TableFacts>();
    for (const t of this.report()?.tables ?? []) m.set(`${t.schema}.${t.table}`, t);
    return m;
  });

  /** Keyed by `schema.table.column` of the foreign-key column. */
  readonly cardinality = computed(() => {
    const m = new Map<string, FkCardinality>();
    for (const c of this.report()?.cardinality ?? []) m.set(`${c.schema}.${c.table}.${c.column}`, c);
    return m;
  });

  /** Keyed like `refKey`, so a diagram ref can look up how often its FK is joined. */
  readonly fkUsage = computed(() => {
    const m = new Map<string, FkUsage>();
    for (const u of this.report()?.declaredUsage ?? []) m.set(refKey(endpointOf(u.from), endpointOf(u.to)), u);
    return m;
  });

  readonly neverJoined = computed(() => {
    const r = this.report();
    return r?.available ? r.declaredUsage.filter((u) => u.calls === 0) : [];
  });
  /** Index suggestions grouped by kind, most impactful first (already sorted by the backend). */
  readonly indexAdvice = computed<IndexAdvice[]>(() => this.report()?.indexAdvice ?? []);

  readonly idleTables = computed(() => (this.report()?.tables ?? []).filter((t) => t.neverUsed));
  readonly seqScanHeavy = computed(() => (this.report()?.tables ?? []).filter((t) => t.seqScanHeavy));

  private unlisten: UnlistenFn[] = [];
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProfile: string | null | undefined = undefined;

  constructor() {
    // Switch off when the document moves to another database or to a file.
    effect(() => {
      const src = this.workspace.source();
      const key = src?.kind === "db" ? src.profileId : null;
      untracked(() => {
        if (this.lastProfile !== undefined && key !== this.lastProfile && this.enabled()) void this.disable();
        this.lastProfile = key;
      });
    });
  }

  async toggle(): Promise<void> {
    if (this.enabled()) await this.disable();
    else await this.enable();
  }

  /** Asks for the X-ray panel to be shown (its index advice); a change of this number shows it. */
  readonly revealRequests = signal(0);

  /** Shows the X-ray panel, turning X-ray on first when it is off. */
  async reveal(): Promise<void> {
    if (!this.enabled()) await this.enable();
    this.revealRequests.update((n) => n + 1);
  }

  async enable(): Promise<void> {
    const src = this.workspace.source();
    if (src?.kind === "db" && src.engine !== "postgres") {
      this.error.set("X-ray reads PostgreSQL's statistics views, so it is not available for this database.");
      return;
    }
    if (!(await this.workspace.currentConnection())) {
      this.error.set("X-ray needs a PostgreSQL connection. Connect to a database first.");
      return;
    }
    this.enabled.set(true);
    this.error.set(null);
    await Promise.all([this.analyze(), this.startLive()]);
  }

  async disable(): Promise<void> {
    this.enabled.set(false);
    await this.stopLive();
    this.report.set(null);
    this.rates.set(new Map());
    this.pulse.set(new Set());
  }

  async analyze(): Promise<void> {
    const conn = await this.workspace.currentConnection();
    if (!conn) return;
    this.analyzing.set(true);
    const op = (this.analyzeOp = crypto.randomUUID());
    try {
      this.report.set(await this.api.analyzeWorkload(conn.input, conn.schemas, op));
    } catch (err) {
      if (errorMessage(err) === "Cancelled") this.workspace.flash("X-ray analysis cancelled");
      else this.error.set(errorMessage(err));
    } finally {
      this.analyzing.set(false);
      this.analyzeOp = null;
    }
  }

  /** Stops a running analysis. */
  cancelAnalyze(): void {
    if (this.analyzeOp) void this.api.cancelOp(this.analyzeOp);
  }
  private analyzeOp: string | null = null;

  async startLive(): Promise<void> {
    const conn = await this.workspace.currentConnection();
    if (!conn) return;
    try {
      if (this.unlisten.length === 0) {
        this.unlisten = await Promise.all([
          this.api.onLive((sample) => this.onSample(sample)),
          this.api.onLiveError((message) => {
            this.error.set(`Live activity stopped: ${message}`);
            this.liveOn.set(false);
          }),
        ]);
      }
      await this.api.startLive(conn.input, conn.schemas, this.intervalMs());
      this.liveOn.set(true);
    } catch (err) {
      this.error.set(errorMessage(err));
      this.liveOn.set(false);
    }
  }

  async stopLive(): Promise<void> {
    this.liveOn.set(false);
    for (const u of this.unlisten) u();
    this.unlisten = [];
    await this.api.stopLive().catch(() => undefined);
  }

  toggleLive(): void {
    void (this.liveOn() ? this.stopLive() : this.startLive());
  }

  async setInterval(ms: number): Promise<void> {
    this.intervalMs.set(ms);
    if (this.liveOn()) await this.startLive();
  }

  private onSample(sample: LiveSample): void {
    this.rates.set(new Map(sample.tables.map((t) => [t.id, t])));
    this.lastSampleAt.set(sample.at);
    this.pulse.set(new Set(sample.tables.filter((t) => t.wroteSinceLast).map((t) => t.id)));
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => this.pulse.set(new Set()), PULSE_MS);
  }

  /**
   * Counts rows that would violate a discovered relationship (read-only) and returns the
   * migration SQL. `from` is the referencing side.
   */
  async checkRelation(ref: VRef): Promise<RelationCheck | null> {
    const conn = await this.workspace.currentConnection();
    if (!conn) return null;
    const end = (e: VEndpoint) => ({ ...splitTableId(e.table), columns: e.fields });
    try {
      return await this.api.checkRelation(conn.input, { child: end(ref.from), parent: end(ref.to) });
    } catch (err) {
      this.error.set(errorMessage(err));
      return null;
    }
  }

  /** Saves SQL text through the native save dialog. */
  async saveSql(name: string, sql: string): Promise<void> {
    try {
      const path = await this.api.saveFile({ defaultName: name, filterName: "SQL", extensions: ["sql"], contents: sql, base64: false });
      if (path) this.workspace.flash(`Saved ${path}`);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  copy(text: string, what = "SQL"): void {
    void navigator.clipboard?.writeText(text).then(() => this.workspace.flash(`${what} copied`));
  }

  /** Writes the relationship into the DBML; on the next parse it becomes a declared edge. */
  promote(ref: VRef): void {
    const line = dbmlRefLine(ref);
    this.workspace.appendDbml(line);
    this.workspace.flash(`Added to DBML: ${line}`);
  }

  promoteAll(): void {
    const refs = this.discovered();
    if (refs.length === 0) return;
    this.workspace.appendDbml(refs.map(dbmlRefLine).join("\n"));
    this.workspace.flash(`Added ${refs.length} relationships to the DBML`);
  }
}
