import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { BrowseColumn, BrowseFilter, BrowseResult, ColKind, Engine, FilterIssue, TableProfile, TauriApi, errorMessage, filterIssues } from "../core/tauri-api.service";
import { splitTableId } from "../diagram/canvas-edit";
import type { VRef } from "../diagram/view-model";
import { kindOf } from "../filter/kinds";
import { type FilterNode, type GroupNode, LIMITS, type SortKey, type WireNode } from "../filter/model";
import { parseQuick } from "../filter/quick-syntax";
import { emptyRoot, fromEquality, hasActive, setColumnFilter } from "../filter/tree";
import { treeIssues } from "../filter/validate";
import { toWire, wireKey } from "../filter/wire";
import { SettingsService } from "../persistence/settings.service";
import { WorkloadStore } from "./workload.store";
import { WorkspaceStore, isCancelled } from "./workspace.store";

/** One step of the browsing trail: a table, its filter, sort and page. */
export interface BrowseLocation {
  tableId: string;
  where: GroupNode;
  sort: SortKey[];
  offset: number;
}

export const PAGE_SIZE = 100;
/** Matching rows are counted up to this many. */
export const COUNT_CAP = 100_000;

export type DrawerMode = "rows" | "profile" | "query";

export type CountState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; count: number; capped: boolean }
  | { state: "timedOut" }
  | { state: "error"; message: string };

/**
 * Read-only data browser. Rows are fetched a page at a time; foreign keys (declared, and the
 * ones X-ray found in queries) become links, so you can walk from a row to the row it
 * references and back to the rows that reference it. Each step of the trail has its own filter
 * tree (see `src/app/filter`) and sort.
 */
@Injectable({ providedIn: "root" })
export class BrowserStore {
  private readonly api = inject(TauriApi);
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly settings = inject(SettingsService);
  /** Operations running now (rows, count, profile), so Cancel can stop them. */
  private readonly running = new Set<string>();
  private rowsOp: string | null = null;
  private countOp: string | null = null;

  readonly open = signal(false);
  readonly history = signal<BrowseLocation[]>([]);
  readonly current = computed(() => this.history().at(-1) ?? null);
  readonly result = signal<BrowseResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Problems of single conditions (from Rust, or found before sending), by node id. */
  readonly issues = signal<FilterIssue[]>([]);
  /** How many rows match the current filter. */
  readonly count = signal<CountState>({ state: "idle" });
  /** What the drawer shows for the current table: its rows, or column statistics. */
  readonly mode = signal<DrawerMode>("rows");
  /** Column profiles fetched this session, by table id. */
  readonly profiles = signal<ReadonlyMap<string, TableProfile>>(new Map());
  readonly profileLoading = signal(false);
  readonly profileError = signal<string | null>(null);
  /** Columns seen per table this session (their kinds resolve relative dates before a load). */
  private readonly columnsByTable = new Map<string, BrowseColumn[]>();
  private readonly counts = new Map<string, CountState>();
  private seq = 0;
  private countSeq = 0;
  private profileSeq = 0;

  /** Declared relationships plus the ones X-ray found in queries. */
  readonly refs = computed<VRef[]>(() => [...this.workspace.view().refs, ...this.workload.discovered()]);
  /** Relationships where the current table is the referencing side. */
  readonly outgoing = computed(() => {
    const id = this.current()?.tableId;
    return id ? this.refs().filter((r) => r.from.table === id) : [];
  });
  /** Relationships where the current table is the referenced side. */
  readonly incoming = computed(() => {
    const id = this.current()?.tableId;
    return id ? this.refs().filter((r) => r.to.table === id) : [];
  });

  readonly engine = computed<Engine | null>(() => {
    const src = this.workspace.source();
    return src?.kind === "db" ? src.engine : null;
  });

  /** Kind of each column of the current result. */
  readonly kinds = computed(() => {
    const engine = this.engine();
    return new Map((this.result()?.columns ?? []).map((c) => [c.name, kindOf(c, engine)] as const));
  });

  constructor() {
    // A different database (or a file) means the trail no longer applies.
    effect(() => {
      this.workspace.source();
      untracked(() => {
        this.close();
        this.profiles.set(new Map());
        this.columnsByTable.clear();
        this.counts.clear();
      });
    });
  }

  canBrowse(): boolean {
    return this.workspace.source()?.kind === "db";
  }

  /** Opens a table, starting a new trail. */
  show(tableId: string, filters: BrowseFilter[] = []): void {
    if (!this.canBrowse()) return;
    this.mode.set("rows");
    this.history.set([{ tableId, where: fromEquality(filters, filters.length ? "nav" : undefined), sort: [], offset: 0 }]);
    this.open.set(true);
    void this.load();
  }

  /** Opens a table's column profile. */
  showProfile(tableId: string): void {
    if (!this.canBrowse()) return;
    if (this.current()?.tableId !== tableId || !this.open()) {
      this.history.set([{ tableId, where: emptyRoot(), sort: [], offset: 0 }]);
      this.result.set(null);
    }
    this.open.set(true);
    this.setMode("profile");
  }

  setMode(mode: DrawerMode): void {
    this.mode.set(mode);
    if (mode === "profile") {
      const id = this.current()?.tableId;
      if (id && !this.profiles().has(id)) void this.loadProfile(id);
    } else if (mode === "rows" && !this.result()) {
      void this.load();
    }
  }

  /** Samples the table and summarises its columns (cached for the session; `force` re-reads). */
  async loadProfile(tableId: string, force = false): Promise<void> {
    if (!force && this.profiles().has(tableId)) return;
    const conn = await this.workspace.currentConnection();
    if (!conn) return;
    const seq = ++this.profileSeq;
    this.profileLoading.set(true);
    this.profileError.set(null);
    try {
      const { schema, table } = splitTableId(tableId);
      const s = this.settings.settings();
      const op = crypto.randomUUID();
      this.running.add(op);
      const profile = await this.api
        .profileTable(conn.input, { schema, table, sampleRows: s.profileSampleRows, timeoutSecs: s.queryTimeoutSecs }, op)
        .finally(() => this.running.delete(op));
      if (seq === this.profileSeq) this.profiles.update((m) => new Map(m).set(tableId, profile));
    } catch (err) {
      if (seq === this.profileSeq) this.profileError.set(isCancelled(err) ? "Cancelled" : errorMessage(err));
    } finally {
      if (seq === this.profileSeq) this.profileLoading.set(false);
    }
  }

  /** Stops whatever the drawer is waiting for (rows, count or a profile). */
  cancel(): void {
    for (const op of this.running) void this.api.cancelOp(op);
  }

  /** Reload button: the current view again. */
  refresh(): void {
    const id = this.current()?.tableId;
    if (this.mode() === "profile" && id) void this.loadProfile(id, true);
    else {
      this.counts.clear();
      void this.load();
    }
  }

  close(): void {
    this.open.set(false);
    this.history.set([]);
    this.result.set(null);
    this.error.set(null);
    this.issues.set([]);
    this.count.set({ state: "idle" });
  }

  back(index: number): void {
    this.history.update((h) => h.slice(0, index + 1));
    void this.load();
    if (this.mode() === "profile") this.setMode("profile");
  }

  private replace(patch: Partial<BrowseLocation>): void {
    const cur = this.current();
    if (!cur) return;
    this.history.update((h) => [...h.slice(0, -1), { ...cur, ...patch }]);
    void this.load();
  }

  /** Replaces the current filter tree (back to the first page). */
  setWhere(where: GroupNode): void {
    this.replace({ where, offset: 0 });
  }

  /** A column box's text (quick syntax) becomes that column's filter; empty text removes it. */
  setQuick(column: string, text: string): void {
    const cur = this.current();
    if (!cur) return;
    const kind = this.kinds().get(column) ?? "text";
    this.setWhere(setColumnFilter(cur.where, column, parseQuick(text, column, kind)));
  }

  /**
   * Header click: ascending, descending, then off. With `additive` (Shift) the column is added
   * to the sort keys (or cycled within them) instead of replacing them.
   */
  toggleSort(column: string, additive = false): void {
    const sort = this.current()?.sort ?? [];
    const at = sort.findIndex((k) => k.column === column);
    let next: SortKey[];
    if (!additive) {
      const only = sort.length === 1 && at === 0;
      next = !only ? [{ column, desc: false }] : sort[0].desc ? [] : [{ column, desc: true }];
    } else if (at < 0) {
      next = [...sort, { column, desc: false }].slice(0, LIMITS.sortKeys);
    } else if (!sort[at].desc) {
      next = sort.map((k, i) => (i === at ? { ...k, desc: true } : k));
    } else {
      next = sort.filter((_, i) => i !== at);
    }
    this.replace({ sort: next, offset: 0 });
  }

  page(delta: number): void {
    const cur = this.current();
    if (!cur) return;
    this.replace({ offset: Math.max(0, cur.offset + delta * PAGE_SIZE) });
  }

  /** From a referencing row to the row it references. */
  followOutgoing(ref: VRef, row: Record<string, string | null>): void {
    const values = ref.from.fields.map((f) => row[f] ?? null);
    if (values.some((v) => v === null)) return this.workspace.flash("This row's key is NULL: it references nothing");
    this.navigate(ref.to.table, ref.to.fields.map((column, i) => ({ column, value: values[i] })));
  }

  /** From a referenced row to the rows that reference it. */
  followIncoming(ref: VRef, row: Record<string, string | null>): void {
    const values = ref.to.fields.map((f) => row[f] ?? null);
    if (values.some((v) => v === null)) return this.workspace.flash("This row's key is NULL");
    this.navigate(ref.from.table, ref.from.fields.map((column, i) => ({ column, value: values[i] })));
  }

  /** Opens rows of a table, appended to the current trail so Back returns to where you were. */
  push(tableId: string, filters: BrowseFilter[]): void {
    if (!this.canBrowse()) return;
    this.mode.set("rows");
    this.open.set(true);
    this.navigate(tableId, filters);
  }

  private navigate(tableId: string, filters: BrowseFilter[]): void {
    this.history.update((h) => [...h, { tableId, where: fromEquality(filters, "nav"), sort: [], offset: 0 }]);
    void this.load();
  }

  /** The kind of a column of a table, from the latest result seen for that table. */
  private kindIn(tableId: string, column: string): ColKind | null {
    const col = this.columnsByTable.get(tableId)?.find((c) => c.name === column);
    return col ? kindOf(col, this.engine()) : null;
  }

  /** The current filter as Rust takes it. */
  wire(loc: BrowseLocation | null = this.current()): WireNode | null {
    if (!loc) return null;
    // Before the first load of a table its kinds are unknown: periods resolve as timestamps,
    // which Rust also accepts for date columns (at midnight).
    return toWire(loc.where, new Date(), (c) => this.kindIn(loc.tableId, c) ?? "timestamp");
  }

  async load(): Promise<void> {
    const loc = this.current();
    if (!loc) return;
    const conn = await this.workspace.currentConnection();
    if (!conn) return;
    const seq = ++this.seq;
    const local = treeIssues(loc.where, (c) => this.kindIn(loc.tableId, c));
    this.issues.set(local);
    if (local.length) {
      // Nothing is sent: the chips say what to fix.
      this.error.set(local.length === 1 ? local[0].message : `${local[0].message} (and ${local.length - 1} more)`);
      this.loading.set(false);
      return;
    }
    // A newer load replaces the running one.
    if (this.rowsOp) void this.api.cancelOp(this.rowsOp);
    this.loading.set(true);
    this.error.set(null);
    const filter = this.wire(loc);
    const { schema, table } = splitTableId(loc.tableId);
    const request = { schema, table, filters: [], filter, sort: loc.sort, limit: PAGE_SIZE, offset: loc.offset, timeoutSecs: this.settings.settings().queryTimeoutSecs };
    try {
      const op = crypto.randomUUID();
      this.rowsOp = op;
      this.running.add(op);
      const result = await this.api.browseTable(conn.input, request, op).finally(() => {
        this.running.delete(op);
        if (this.rowsOp === op) this.rowsOp = null;
      });
      if (seq !== this.seq) return;
      this.columnsByTable.set(loc.tableId, result.columns);
      this.result.set(result);
      void this.loadCount(loc, filter, result);
    } catch (err) {
      if (seq === this.seq) {
        this.result.set(null);
        this.issues.set(filterIssues(err));
        this.error.set(isCancelled(err) ? "Cancelled" : errorMessage(err));
        this.count.set({ state: "idle" });
      }
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }

  /** Counts the matching rows after the page arrived (cached per table and filter). */
  private async loadCount(loc: BrowseLocation, filter: WireNode | null, page: BrowseResult): Promise<void> {
    const seq = ++this.countSeq;
    if (this.countOp) void this.api.cancelOp(this.countOp);
    if (!filter || !hasActive(loc.where)) {
      this.count.set({ state: "idle" });
      return;
    }
    // The first page already holds all of them.
    if (loc.offset === 0 && !page.hasMore) {
      this.count.set({ state: "done", count: page.rows.length, capped: false });
      return;
    }
    const key = `${loc.tableId}|${wireKey(filter)}`;
    const cached = this.counts.get(key);
    if (cached) {
      this.count.set(cached);
      return;
    }
    const conn = await this.workspace.currentConnection();
    if (!conn || seq !== this.countSeq) return;
    this.count.set({ state: "loading" });
    const { schema, table } = splitTableId(loc.tableId);
    const op = crypto.randomUUID();
    this.countOp = op;
    this.running.add(op);
    try {
      const r = await this.api.countRows(conn.input, { request: { schema, table, filters: [], filter, limit: 1, offset: 0, timeoutSecs: this.settings.settings().queryTimeoutSecs }, cap: COUNT_CAP }, op);
      if (seq !== this.countSeq) return;
      const state: CountState = r.timedOut ? { state: "timedOut" } : { state: "done", count: r.count, capped: r.capped };
      if (!r.timedOut) this.counts.set(key, state);
      this.count.set(state);
    } catch (err) {
      if (seq === this.countSeq) this.count.set(isCancelled(err) ? { state: "idle" } : { state: "error", message: errorMessage(err) });
    } finally {
      this.running.delete(op);
      if (this.countOp === op) this.countOp = null;
    }
  }
}
