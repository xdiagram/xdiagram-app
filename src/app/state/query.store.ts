import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { type BrowseResult, TauriApi, errorMessage } from "../core/tauri-api.service";
import { splitTableId } from "../diagram/canvas-edit";
import type { VTable } from "../diagram/view-model";
import { makeAliases, planJoins } from "../query/join-path";
import { SettingsService } from "../persistence/settings.service";
import { BrowserStore, PAGE_SIZE } from "./browser.store";
import { WorkloadStore } from "./workload.store";
import { WorkspaceStore, isCancelled } from "./workspace.store";

export interface QueryFilter {
  table: string;
  column: string;
  value: string | null;
}

/** Structured join query, as the Rust `JoinRequest`. */
interface JoinRequest {
  tables: { schema: string; table: string; alias: string }[];
  joins: { alias: string; parent: string; on: [string, string][]; left: boolean }[];
  columns: { alias: string; column: string }[];
  filters: { alias: string; column: string; value: string | null }[];
  orderBy: null;
  limit: number;
  offset: number;
}

const KEYISH = /^(name|title|label|email|code|slug|status)$/i;

/**
 * Query builder: the chosen tables are joined along the shortest relationship paths (declared
 * first, then X-ray's discovered ones); the query runs read-only, a page at a time.
 */
@Injectable({ providedIn: "root" })
export class QueryStore {
  private readonly api = inject(TauriApi);
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly browser = inject(BrowserStore);
  private readonly settings = inject(SettingsService);
  private runningOp: string | null = null;

  /** Tables the user picked, in order (the first is the FROM table). */
  readonly chosen = signal<string[]>([]);
  /** Columns picked per table; tables not in the map use their defaults. */
  readonly picked = signal<ReadonlyMap<string, readonly string[]>>(new Map());
  readonly leftJoin = signal(false);
  readonly filters = signal<QueryFilter[]>([]);
  readonly offset = signal(0);
  readonly result = signal<BrowseResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sql = signal("");
  private seq = 0;

  private readonly refs = computed(() => [...this.workspace.view().refs, ...this.workload.discovered()]);
  private readonly tablesById = computed(() => new Map(this.workspace.view().tables.map((t) => [t.id, t])));
  readonly plan = computed(() => planJoins(this.chosen().filter((id) => this.tablesById().has(id)), this.refs()));
  readonly aliases = computed(() => makeAliases(this.plan().tables));

  /** What the diagram outlines while the query builder is open. */
  readonly highlight = computed(() => {
    const plan = this.plan();
    if (!this.browser.open() || this.browser.mode() !== "query" || !plan.tables.length) return null;
    return { tables: new Set(plan.tables), refs: plan.refIds };
  });

  readonly request = computed<JoinRequest | null>(() => {
    const plan = this.plan();
    const alias = this.aliases();
    if (!plan.tables.length) return null;
    const columns = plan.tables.flatMap((id) => this.columnsOf(id).map((column) => ({ alias: alias.get(id)!, column })));
    if (!columns.length) return null;
    return {
      tables: plan.tables.map((id) => ({ ...splitTableId(id), alias: alias.get(id)! })),
      joins: plan.steps.map((s) => ({ alias: alias.get(s.table)!, parent: alias.get(s.parent)!, on: s.on, left: this.leftJoin() })),
      columns,
      filters: this.filters()
        .filter((f) => alias.has(f.table))
        .map((f) => ({ alias: alias.get(f.table)!, column: f.column, value: f.value })),
      orderBy: null,
      limit: PAGE_SIZE,
      offset: this.offset(),
    };
  });

  constructor() {
    // Readable SQL preview, rebuilt (by the Rust side, for the connection's dialect) on every change.
    effect(() => {
      const req = this.request();
      const src = this.workspace.source();
      untracked(() => {
        if (!req || src?.kind !== "db") return this.sql.set("");
        this.api
          .joinSql(src.engine, req)
          .then((sql) => this.sql.set(sql))
          .catch((err) => this.sql.set(`-- ${errorMessage(err)}`));
      });
    });
    // Another database or file: start over.
    effect(() => {
      this.workspace.source();
      untracked(() => this.clear());
    });
  }

  /** Selected columns of a table: the user's choice, else all of the first table and the key-ish ones of the others. */
  columnsOf(id: string): readonly string[] {
    const picked = this.picked().get(id);
    if (picked) return picked;
    const t = this.tablesById().get(id);
    if (!t) return [];
    if (id === this.chosen()[0]) return t.fields.map((f) => f.name);
    if (!this.chosen().includes(id)) return []; // bridge tables only join
    return t.fields.filter((f) => f.pk || KEYISH.test(f.name)).map((f) => f.name);
  }

  table(id: string): VTable | undefined {
    return this.tablesById().get(id);
  }

  /** Adds a table and shows the query builder. */
  add(id: string): void {
    if (!this.browser.canBrowse()) return;
    if (!this.chosen().includes(id)) this.chosen.update((c) => [...c, id]);
    this.browser.open.set(true);
    this.browser.setMode("query");
    this.invalidate();
  }

  remove(id: string): void {
    this.chosen.update((c) => c.filter((x) => x !== id));
    this.picked.update((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
    this.filters.update((f) => f.filter((x) => x.table !== id));
    this.invalidate();
  }

  toggleColumn(id: string, column: string, on: boolean): void {
    const t = this.tablesById().get(id);
    if (!t) return;
    const current = new Set(this.columnsOf(id));
    if (on) current.add(column);
    else current.delete(column);
    this.picked.update((m) => new Map(m).set(id, t.fields.map((f) => f.name).filter((n) => current.has(n))));
    this.invalidate();
  }

  setLeftJoin(on: boolean): void {
    this.leftJoin.set(on);
    this.invalidate();
  }

  /** Sets (or with `undefined`, removes) an equality filter. */
  setFilter(table: string, column: string, value: string | null | undefined): void {
    this.filters.update((fs) => {
      const rest = fs.filter((f) => !(f.table === table && f.column === column));
      return value === undefined ? rest : [...rest, { table, column, value }];
    });
    this.offset.set(0);
    void this.run();
  }

  page(delta: number): void {
    this.offset.update((o) => Math.max(0, o + delta * PAGE_SIZE));
    void this.run();
  }

  clear(): void {
    this.chosen.set([]);
    this.picked.set(new Map());
    this.filters.set([]);
    this.invalidate();
  }

  copySql(): void {
    const sql = this.sql();
    if (sql) void navigator.clipboard?.writeText(sql).then(() => this.workspace.flash("SQL copied"));
  }

  /** Runs the query (read-only) and shows the current page. */
  async run(): Promise<void> {
    const req = this.request();
    const conn = await this.workspace.currentConnection();
    if (!req || !conn) return;
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const op = (this.runningOp = crypto.randomUUID());
      const result = await this.api.browseJoin(conn.input, { ...req, timeoutSecs: this.settings.settings().queryTimeoutSecs }, op);
      if (seq === this.seq) this.result.set(result);
    } catch (err) {
      if (seq === this.seq) {
        this.result.set(null);
        this.error.set(isCancelled(err) ? "Cancelled" : errorMessage(err));
      }
    } finally {
      if (seq === this.seq) this.loading.set(false);
      this.runningOp = null;
    }
  }

  cancel(): void {
    if (this.runningOp) void this.api.cancelOp(this.runningOp);
  }

  /** The query changed: earlier results no longer apply. */
  private invalidate(): void {
    this.offset.set(0);
    this.result.set(null);
    this.error.set(null);
  }
}
