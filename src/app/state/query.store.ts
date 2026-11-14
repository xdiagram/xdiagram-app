import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { type BrowseColumn, type BrowseResult, type ColKind, type FilterIssue, TauriApi, errorMessage, filterIssues } from "../core/tauri-api.service";
import { splitTableId } from "../diagram/canvas-edit";
import type { VTable } from "../diagram/view-model";
import { kindOf } from "../filter/kinds";
import type { GroupNode, WireNode } from "../filter/model";
import { parseQuick } from "../filter/quick-syntax";
import { emptyRoot, renameColumns, setColumnFilter } from "../filter/tree";
import { treeIssues } from "../filter/validate";
import { toWire } from "../filter/wire";
import { makeAliases, planJoins } from "../query/join-path";
import { SettingsService } from "../persistence/settings.service";
import { BrowserStore, PAGE_SIZE } from "./browser.store";
import { WorkloadStore } from "./workload.store";
import { WorkspaceStore, isCancelled } from "./workspace.store";

/** Structured join query, as the Rust `JoinRequest`. */
interface JoinRequest {
  tables: { schema: string; table: string; alias: string }[];
  joins: { alias: string; parent: string; on: [string, string][]; left: boolean }[];
  columns: { alias: string; column: string }[];
  filters: never[];
  /** The filter tree; columns are named `alias.column`. */
  filter: WireNode | null;
  orderBy: null;
  limit: number;
  offset: number;
}

const KEYISH = /^(name|title|label|email|code|slug|status)$/i;

/**
 * Query builder: the chosen tables are joined along the shortest relationship paths (declared
 * first, then X-ray's discovered ones); the query runs read-only, a page at a time. Its filter is
 * the same tree as the Rows view's, over columns named `alias.column`.
 */
@Injectable({ providedIn: "root" })
export class QueryStore {
  private readonly api = inject(TauriApi);
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly browser = inject(BrowserStore);
  private readonly settings = inject(SettingsService);
  private runningOp: string | null = null;
  private sqlOp: string | null = null;
  private sqlTimer: ReturnType<typeof setTimeout> | null = null;

  /** Tables the user picked, in order (the first is the FROM table). */
  readonly chosen = signal<string[]>([]);
  /** Columns picked per table; tables not in the map use their defaults. */
  readonly picked = signal<ReadonlyMap<string, readonly string[]>>(new Map());
  readonly leftJoin = signal(false);
  /** The filter: conditions on `alias.column`, searches across every table. */
  readonly where = signal<GroupNode>(emptyRoot());
  /** Problems of single conditions (found before sending, or reported by Rust). */
  readonly issues = signal<FilterIssue[]>([]);
  readonly offset = signal(0);
  readonly result = signal<BrowseResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sql = signal("");
  private seq = 0;
  /** The aliases the filter's columns were written with. */
  private aliasesSeen = new Map<string, string>();

  private readonly refs = computed(() => [...this.workspace.view().refs, ...this.workload.discovered()]);
  private readonly tablesById = computed(() => new Map(this.workspace.view().tables.map((t) => [t.id, t])));
  readonly plan = computed(() => planJoins(this.chosen().filter((id) => this.tablesById().has(id)), this.refs()));
  readonly aliases = computed(() => makeAliases(this.plan().tables));

  /** Every column of the joined tables as `alias.column`: kinds from the last result, else from the diagram's types. */
  readonly columns = computed<BrowseColumn[]>(() => {
    const alias = this.aliases();
    const known = new Map((this.result()?.columns ?? []).map((c) => [c.name, c]));
    return this.plan().tables.flatMap((id) => {
      const t = this.tablesById().get(id);
      const a = alias.get(id);
      if (!t || !a) return [];
      return t.fields.map((f) => known.get(`${a}.${f.name}`) ?? { name: `${a}.${f.name}`, typeName: f.type, nullable: !f.notNull && !f.pk });
    });
  });
  readonly kinds = computed(() => {
    const engine = this.browser.engine();
    return new Map(this.columns().map((c) => [c.name, kindOf(c, engine)] as const));
  });

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
    const kinds = this.kinds();
    return {
      tables: plan.tables.map((id) => ({ ...splitTableId(id), alias: alias.get(id)! })),
      joins: plan.steps.map((s) => ({ alias: alias.get(s.table)!, parent: alias.get(s.parent)!, on: s.on, left: this.leftJoin() })),
      columns,
      filters: [],
      filter: toWire(this.where(), new Date(), (c) => kinds.get(c) ?? "timestamp"),
      orderBy: null,
      limit: PAGE_SIZE,
      offset: this.offset(),
    };
  });

  constructor() {
    // Readable SQL preview with the values written in, built by the Rust side from the tables'
    // real columns (so it is what runs); debounced, the previous one cancelled.
    effect(() => {
      const req = this.request();
      untracked(() => this.previewSql(req));
    });
    // Aliases follow the tables' order: when they change, the filter's columns follow them,
    // and conditions on a removed table go.
    effect(() => {
      const now = this.aliases();
      untracked(() => {
        const before = this.aliasesSeen;
        this.aliasesSeen = now;
        const rename = new Map<string, string | null>([...before].map(([id, a]) => [a, now.get(id) ?? null]));
        if (![...rename].some(([a, b]) => a !== b)) return;
        this.where.update((w) =>
          renameColumns(w, (column) => {
            const dot = column.indexOf(".");
            const a = column.slice(0, dot);
            if (dot < 0 || !rename.has(a)) return column;
            const b = rename.get(a);
            return b ? `${b}${column.slice(dot)}` : null;
          }),
        );
      });
    });
    // Another database or file: start over.
    effect(() => {
      this.workspace.source();
      untracked(() => this.clear());
    });
  }

  private previewSql(req: JoinRequest | null): void {
    if (this.sqlTimer) clearTimeout(this.sqlTimer);
    if (!req || this.workspace.source()?.kind !== "db") return this.sql.set("");
    this.sqlTimer = setTimeout(async () => {
      const conn = await this.workspace.currentConnection();
      if (!conn || req !== this.request()) return;
      if (this.sqlOp) void this.api.cancelOp(this.sqlOp);
      const op = (this.sqlOp = crypto.randomUUID());
      try {
        const sql = await this.api.joinSql(conn.input, req, op);
        if (req === this.request()) this.sql.set(sql);
      } catch (err) {
        if (req === this.request() && !isCancelled(err)) this.sql.set(`-- ${errorMessage(err)}`);
      } finally {
        if (this.sqlOp === op) this.sqlOp = null;
      }
    }, 250);
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

  /** Replaces the filter and runs the query from its first page. */
  setWhere(where: GroupNode): void {
    this.where.set(where);
    this.offset.set(0);
    void this.run();
  }

  /** A column box's text (quick syntax) becomes that column's filter; empty text removes it. */
  setQuick(column: string, text: string): void {
    const kind: ColKind = this.kinds().get(column) ?? "text";
    this.setWhere(setColumnFilter(this.where(), column, parseQuick(text, column, kind)));
  }

  /**
   * Opens the query builder on one table with a filter of the Rows view (its columns become
   * `alias.column`), and runs it.
   */
  openWith(tableId: string, where: GroupNode): void {
    this.clear();
    this.add(tableId);
    const alias = this.aliases().get(tableId);
    if (!alias) return;
    this.aliasesSeen = this.aliases();
    this.setWhere(renameColumns(where, (c) => `${alias}.${c}`));
  }

  page(delta: number): void {
    this.offset.update((o) => Math.max(0, o + delta * PAGE_SIZE));
    void this.run();
  }

  clear(): void {
    this.chosen.set([]);
    this.picked.set(new Map());
    this.where.set(emptyRoot());
    this.issues.set([]);
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
    const kinds = this.kinds();
    const local = treeIssues(this.where(), (c) => kinds.get(c) ?? null);
    this.issues.set(local);
    if (local.length) {
      // Nothing is sent: the chips say what to fix.
      this.error.set(local.length === 1 ? local[0].message : `${local[0].message} (and ${local.length - 1} more)`);
      this.loading.set(false);
      return;
    }
    if (this.runningOp) void this.api.cancelOp(this.runningOp);
    this.loading.set(true);
    this.error.set(null);
    try {
      const op = (this.runningOp = crypto.randomUUID());
      const result = await this.api.browseJoin(conn.input, { ...req, timeoutSecs: this.settings.settings().queryTimeoutSecs }, op);
      if (seq === this.seq) this.result.set(result);
    } catch (err) {
      if (seq === this.seq) {
        this.result.set(null);
        this.issues.set(filterIssues(err));
        this.error.set(isCancelled(err) ? "Cancelled" : errorMessage(err));
      }
    } finally {
      if (seq === this.seq) {
        this.loading.set(false);
        this.runningOp = null;
      }
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
