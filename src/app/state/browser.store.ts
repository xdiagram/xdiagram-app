import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { BrowseFilter, BrowseResult, TableProfile, TauriApi, errorMessage } from "../core/tauri-api.service";
import { splitTableId } from "../diagram/canvas-edit";
import type { VRef } from "../diagram/view-model";
import { SettingsService } from "../persistence/settings.service";
import { WorkloadStore } from "./workload.store";
import { WorkspaceStore, isCancelled } from "./workspace.store";

/** One step of the browsing trail: a table, its filters, sort and page. */
export interface BrowseLocation {
  tableId: string;
  filters: BrowseFilter[];
  orderBy: { column: string; desc: boolean } | null;
  offset: number;
}

export const PAGE_SIZE = 100;

export type DrawerMode = "rows" | "profile" | "query";

/**
 * Read-only data browser. Rows are fetched a page at a time; foreign keys (declared, and the
 * ones X-ray found in queries) become links, so you can walk from a row to the row it
 * references and back to the rows that reference it.
 */
@Injectable({ providedIn: "root" })
export class BrowserStore {
  private readonly api = inject(TauriApi);
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly settings = inject(SettingsService);
  /** Operations running now (rows, profile), so Cancel can stop them. */
  private readonly running = new Set<string>();

  readonly open = signal(false);
  readonly history = signal<BrowseLocation[]>([]);
  readonly current = computed(() => this.history().at(-1) ?? null);
  readonly result = signal<BrowseResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** What the drawer shows for the current table: its rows, or column statistics. */
  readonly mode = signal<DrawerMode>("rows");
  /** Column profiles fetched this session, by table id. */
  readonly profiles = signal<ReadonlyMap<string, TableProfile>>(new Map());
  readonly profileLoading = signal(false);
  readonly profileError = signal<string | null>(null);
  private seq = 0;
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

  constructor() {
    // A different database (or a file) means the trail no longer applies.
    effect(() => {
      this.workspace.source();
      untracked(() => {
        this.close();
        this.profiles.set(new Map());
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
    this.history.set([{ tableId, filters, orderBy: null, offset: 0 }]);
    this.open.set(true);
    void this.load();
  }

  /** Opens a table's column profile. */
  showProfile(tableId: string): void {
    if (!this.canBrowse()) return;
    if (this.current()?.tableId !== tableId || !this.open()) {
      this.history.set([{ tableId, filters: [], orderBy: null, offset: 0 }]);
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

  /** Stops whatever the drawer is waiting for (rows or a profile). */
  cancel(): void {
    for (const op of this.running) void this.api.cancelOp(op);
  }

  /** Reload button: the current view again. */
  refresh(): void {
    const id = this.current()?.tableId;
    if (this.mode() === "profile" && id) void this.loadProfile(id, true);
    else void this.load();
  }

  close(): void {
    this.open.set(false);
    this.history.set([]);
    this.result.set(null);
    this.error.set(null);
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

  /** Click on a header: ascending, then descending, then back to the default order. */
  sortBy(column: string): void {
    const cur = this.current()?.orderBy;
    const next = cur?.column !== column ? { column, desc: false } : cur.desc ? null : { column, desc: true };
    this.replace({ orderBy: next, offset: 0 });
  }

  page(delta: number): void {
    const cur = this.current();
    if (!cur) return;
    this.replace({ offset: Math.max(0, cur.offset + delta * PAGE_SIZE) });
  }

  /** Sets (or with `undefined`, removes) the equality filter on a column. */
  setFilter(column: string, value: string | null | undefined): void {
    const cur = this.current();
    if (!cur) return;
    const filters = cur.filters.filter((f) => f.column !== column);
    if (value !== undefined) filters.push({ column, value });
    this.replace({ filters, offset: 0 });
  }

  /** From a referencing row to the row it references. */
  followOutgoing(ref: VRef, row: Record<string, string | null>): void {
    const values = ref.from.fields.map((f) => row[f] ?? null);
    if (values.some((v) => v === null)) return this.workspace.flash("This row's key is NULL: it references nothing");
    this.navigate({ tableId: ref.to.table, filters: ref.to.fields.map((column, i) => ({ column, value: values[i] })), orderBy: null, offset: 0 });
  }

  /** From a referenced row to the rows that reference it. */
  followIncoming(ref: VRef, row: Record<string, string | null>): void {
    const values = ref.to.fields.map((f) => row[f] ?? null);
    if (values.some((v) => v === null)) return this.workspace.flash("This row's key is NULL");
    this.navigate({ tableId: ref.from.table, filters: ref.from.fields.map((column, i) => ({ column, value: values[i] })), orderBy: null, offset: 0 });
  }

  /** Opens rows of a table, appended to the current trail so Back returns to where you were. */
  push(tableId: string, filters: BrowseFilter[]): void {
    if (!this.canBrowse()) return;
    this.mode.set("rows");
    this.open.set(true);
    this.navigate({ tableId, filters, orderBy: null, offset: 0 });
  }

  private navigate(loc: BrowseLocation): void {
    this.history.update((h) => [...h, loc]);
    void this.load();
  }

  async load(): Promise<void> {
    const loc = this.current();
    if (!loc) return;
    const conn = await this.workspace.currentConnection();
    if (!conn) return;
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const { schema, table } = splitTableId(loc.tableId);
      const op = crypto.randomUUID();
      this.running.add(op);
      const result = await this.api
        .browseTable(
          conn.input,
          { schema, table, filters: loc.filters, orderBy: loc.orderBy, limit: PAGE_SIZE, offset: loc.offset, timeoutSecs: this.settings.settings().queryTimeoutSecs },
          op,
        )
        .finally(() => this.running.delete(op));
      if (seq === this.seq) this.result.set(result);
    } catch (err) {
      if (seq === this.seq) {
        this.result.set(null);
        this.error.set(isCancelled(err) ? "Cancelled" : errorMessage(err));
      }
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }
}
