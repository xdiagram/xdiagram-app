import { Injectable, computed, inject, signal } from "@angular/core";

import { TauriApi, errorMessage } from "../core/tauri-api.service";
import { type ModuleLayoutPlan, layoutModules } from "../diagram/layout";
import type { VGroup, ViewModel } from "../diagram/view-model";
import { RESOLUTIONS, findModules, isValidModuleName } from "../modules/find-modules";
import { type TrafficReport, collectLinks } from "../modules/graph";
import type { FindMode, GraphSource, Link, ModuleProposal, ModulesDoc } from "../modules/types";
import type { Point } from "../persistence/layout.service";
import { WorkloadStore } from "./workload.store";
import { WorkspaceStore } from "./workspace.store";

/** What the module finder worked from, for the panel. */
export interface ModulesSource {
  kind: GraphSource;
  /** Why the traffic could not be used (PostgreSQL only), or null. */
  note: string | null;
  /** Joins seen in the traffic. */
  joins: number;
}

/**
 * Find modules: groups the tables by how they work together and shows them in a second
 * arrangement ("Modules") next to the user's own. A proposal stays out of the DBML until it is
 * accepted; the common tables and the proposal are kept with the layout.
 */
@Injectable({ providedIn: "root" })
export class ModulesStore {
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly api = inject(TauriApi);

  readonly computing = signal(false);
  /** The module the panel shows as selected (a proposal module key or a group id). */
  readonly selected = signal<string | null>(null);
  /** A change asks the app to show the Modules panel. */
  readonly revealRequests = signal(0);
  readonly source = signal<ModulesSource | null>(null);
  /** X-ray's report fetched for Find modules while X-ray was off, for one document. */
  private traffic: { key: string | null; report: TrafficReport | null; note: string | null } | null = null;
  private seq = 0;

  readonly doc = computed(() => this.workspace.modulesDoc());
  readonly proposal = computed(() => this.doc()?.proposal ?? null);
  readonly resolution = computed(() => this.doc()?.resolution ?? RESOLUTIONS.normal);

  /** Tables added to the document since the proposal was made. */
  readonly stale = computed(() => {
    const p = this.proposal();
    if (!p) return 0;
    const known = new Set([...p.modules.flatMap((m) => m.tables), ...p.common, ...p.other]);
    return this.workspace.view().tables.filter((t) => !known.has(t.id)).length;
  });

  /** Zones the canvas draws instead of the DBML groups (null: the DBML groups, as usual). */
  readonly zones = computed<VGroup[] | null>(() => {
    if (this.workspace.arrangement() !== "modules") return null;
    const doc = this.doc();
    if (!doc) return null;
    const view = this.workspace.view();
    const p = doc.proposal;
    if (p) {
      const zones: VGroup[] = p.modules.map((m) => ({ id: `module:${m.key}`, name: m.name, color: m.color, tables: m.tables, role: "proposed" }));
      return [...zones, ...this.extraZones(p.common, p.other)];
    }
    const grouped = new Set(view.groups.flatMap((g) => g.tables));
    const common = doc.common.filter((t) => !grouped.has(t));
    const commonSet = new Set(common);
    const other = view.tables.map((t) => t.id).filter((id) => !grouped.has(id) && !commonSet.has(id));
    return [...view.groups, ...this.extraZones(common, other)];
  });

  constructor() {
    this.workspace.moduleArranger = () => this.arrange();
  }

  private extraZones(common: string[], other: string[]): VGroup[] {
    const zones: VGroup[] = [];
    if (common.length) zones.push({ id: "module:common", name: "Common tables", color: null, tables: common, role: "common" });
    if (other.length) zones.push({ id: "module:other", name: "Other tables", color: null, tables: other, role: "other" });
    return zones;
  }

  /**
   * Finds modules and shows them in the Modules arrangement. "extend" keeps the existing
   * TableGroups and only adds tables to them; "all" recomputes everything.
   */
  async find(mode?: FindMode, resolution = this.resolution()): Promise<void> {
    const view = this.workspace.view();
    if (!view.tables.length) return this.workspace.flash("No tables to group yet");
    const chosen: FindMode = mode ?? this.proposal()?.mode ?? "extend";
    const seq = ++this.seq;
    const key = this.workspace.documentKey();
    this.computing.set(true);
    try {
      await this.workspace.run("Finding modules…", async (op) => {
        const report = await this.trafficReport(op);
        if (seq !== this.seq || key !== this.workspace.documentKey()) return;
        const { links, source } = collectLinks(
          view.tables.map((t) => t.id),
          view.refs,
          report,
        );
        const prev = this.doc();
        const proposal = findModules({
          tables: view.tables.map((t) => t.id),
          links,
          source,
          groups: view.groups,
          mode: chosen,
          resolution,
          commonAdded: prev?.commonAdded,
          commonRemoved: prev?.commonRemoved,
          previous: prev?.proposal?.modules,
        });
        const positions = await layoutModules(view, planOf(proposal, links));
        if (seq !== this.seq || key !== this.workspace.documentKey()) return;
        const doc: ModulesDoc = {
          commonAdded: prev?.commonAdded ?? [],
          commonRemoved: prev?.commonRemoved ?? [],
          common: prev?.common ?? [],
          proposal,
          // Accepted modules come back on Reject; a recomputation keeps what the first one kept.
          previous: prev && !prev.proposal ? { positions: this.workspace.modulesPositions() ?? {}, common: prev.common } : (prev?.previous ?? null),
          resolution,
        };
        this.source.set({ kind: source, note: this.traffic?.note ?? null, joins: links.reduce((s, l) => s + l.calls, 0) });
        this.workspace.setModules(doc, positions);
        this.revealRequests.update((n) => n + 1);
      });
    } finally {
      if (seq === this.seq) this.computing.set(false);
    }
  }

  /**
   * X-ray's report: the one X-ray already holds, else read once for this document (PostgreSQL,
   * without turning the overlay on). Null when there is no traffic to use; the reason goes to
   * the panel.
   */
  private async trafficReport(op: string): Promise<TrafficReport | null> {
    const loaded = this.workload.report();
    if (loaded?.available) return loaded;
    const key = this.workspace.documentKey();
    const src = this.workspace.source();
    if (src?.kind !== "db" || src.engine !== "postgres") {
      this.traffic = { key, report: null, note: null };
      return null;
    }
    if (this.traffic?.key === key && this.traffic.report) return this.traffic.report;
    const conn = await this.workspace.currentConnection();
    if (!conn) return null;
    try {
      const report = await this.api.analyzeWorkload(conn.input, conn.schemas, op);
      this.traffic = { key, report: report.available ? report : null, note: report.available ? null : report.reason };
      return this.traffic.report;
    } catch (err) {
      if (errorMessage(err) === "Cancelled") throw err;
      this.traffic = { key, report: null, note: errorMessage(err) };
      return null;
    }
  }

  /** Lays the modules on the canvas out again (Auto-arrange while Modules is shown). */
  private async arrange(): Promise<Record<string, Point> | null> {
    const doc = this.doc();
    if (!doc) return null;
    const view = this.workspace.view();
    const { links } = collectLinks(
      view.tables.map((t) => t.id),
      view.refs,
      this.traffic?.report ?? this.workload.report(),
    );
    if (doc.proposal) return layoutModules(view, planOf(doc.proposal, links));
    return layoutModules(view, acceptedPlan(view, doc, links));
  }

  /** Makes a table common, or puts it back into the modules, and finds the modules again. */
  async toggleCommon(id: string): Promise<void> {
    const doc = this.doc();
    const p = doc?.proposal;
    if (!doc || !p) return;
    const added = doc.commonAdded.filter((x) => x !== id);
    const removed = doc.commonRemoved.filter((x) => x !== id);
    if (p.common.includes(id)) {
      if (p.detected.includes(id)) removed.push(id);
    } else if (!p.detected.includes(id)) added.push(id);
    this.workspace.setModules({ ...doc, commonAdded: added, commonRemoved: removed });
    await this.find(p.mode, p.resolution);
  }

  /** Renames a module of the proposal; false (with a message) when the name cannot be used. */
  rename(key: string, name: string): boolean {
    const p = this.proposal();
    const doc = this.doc();
    const m = p?.modules.find((x) => x.key === key);
    if (!doc || !p || !m) return false;
    const next = name.trim();
    if (next === m.name) return true;
    if (!isValidModuleName(next)) {
      this.workspace.flash("Enter a name without quotes, braces or line breaks");
      return false;
    }
    const groups = this.workspace.view().groups;
    const taken = [...p.modules.filter((x) => x.key !== key).map((x) => x.name), ...groups.filter((g) => g.id !== m.existing).map((g) => g.name)];
    if (taken.includes(next)) {
      this.workspace.flash(`“${next}” is already used by another module or group`);
      return false;
    }
    this.updateProposal({ ...p, modules: p.modules.map((x) => (x.key === key ? { ...x, name: next } : x)) });
    return true;
  }

  setColor(key: string, color: string): void {
    const p = this.proposal();
    if (!p) return;
    this.updateProposal({ ...p, modules: p.modules.map((x) => (x.key === key ? { ...x, color } : x)) });
  }

  /** Finer or coarser modules. */
  async setResolution(resolution: number): Promise<void> {
    await this.find(this.proposal()?.mode, resolution);
  }

  /** Discards the proposal: back to the accepted modules it replaced, or no Modules arrangement. */
  reject(): void {
    const doc = this.doc();
    if (!doc?.proposal) return;
    this.seq++;
    if (doc.previous) {
      const shown = this.workspace.arrangement() === "modules";
      this.workspace.setModules({ ...doc, proposal: null, common: doc.previous.common, previous: null }, doc.previous.positions, shown);
    } else this.workspace.setModules(null);
    this.workspace.flash("Proposal discarded");
  }

  /** Shows the tables of one module on the canvas (switching to the Modules arrangement). */
  showModule(key: string, tables: readonly string[]): void {
    this.selected.set(key);
    if (this.workspace.arrangement() !== "modules") this.workspace.setArrangement("modules");
    const hidden = tables.filter((t) => this.workspace.hidden().has(t));
    if (hidden.length) this.workspace.setHidden(hidden, false);
    setTimeout(() => this.workspace.diagram?.fitTo(tables), 0);
  }

  private updateProposal(proposal: ModuleProposal): void {
    const doc = this.doc();
    if (doc) this.workspace.setModules({ ...doc, proposal });
  }
}

/** The proposal as a layout plan. */
export function planOf(p: ModuleProposal, links: readonly Link[]): ModuleLayoutPlan {
  return {
    modules: p.modules.map((m) => ({ key: m.key, tables: m.tables })),
    common: p.common,
    other: p.other,
    extraLinks: links.filter((l) => !l.declared),
  };
}

/** Accepted modules (the DBML groups) as a layout plan. */
function acceptedPlan(view: ViewModel, doc: ModulesDoc, links: readonly Link[]): ModuleLayoutPlan {
  const grouped = new Set(view.groups.flatMap((g) => g.tables));
  const common = doc.common.filter((t) => !grouped.has(t));
  const commonSet = new Set(common);
  return {
    modules: view.groups.map((g) => ({ key: g.id, tables: g.tables })),
    common,
    other: view.tables.map((t) => t.id).filter((id) => !grouped.has(id) && !commonSet.has(id)),
    extraLinks: links.filter((l) => !l.declared),
  };
}
