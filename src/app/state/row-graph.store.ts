import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { TauriApi, errorMessage, type BrowseFilter } from "../core/tauri-api.service";
import * as rg from "../data/row-graph";
import { refColumns, type Scene, type TableBox } from "../diagram/geometry";
import { displayTable, type VRef, type VTable } from "../diagram/view-model";
import { SettingsService } from "../persistence/settings.service";
import { BrowserStore } from "./browser.store";
import { WorkspaceStore, isCancelled } from "./workspace.store";

/** What a card shows; reused while its row and the schema are unchanged (cheap re-renders). */
export interface CardView {
  node: rg.RowNode;
  table: VTable | undefined;
  layout: rg.CardLayout;
  title: string;
  keyText: string;
  canParents: boolean;
  canChildren: boolean;
  isRoot: boolean;
}

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/**
 * The related-data map: starts from one row of the data browser and grows as cards are expanded.
 * Closing only hides it (the drawer can bring it back); a new row or another database replaces it.
 */
@Injectable({ providedIn: "root" })
export class RowGraphStore {
  private readonly api = inject(TauriApi);
  private readonly workspace = inject(WorkspaceStore);
  private readonly browser = inject(BrowserStore);
  private readonly settings = inject(SettingsService);

  readonly open = signal(false);
  readonly graph = signal<rg.RowGraph | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  /** "More" pills waiting for rows. */
  readonly loadingMore = signal<ReadonlySet<string>>(new Set());
  /** Pan and zoom, kept while the map is hidden. */
  viewport: Viewport | null = null;
  readonly hasGraph = computed(() => !!this.graph());

  private readonly running = new Set<string>();
  private readonly pending = signal(0);
  readonly busy = computed(() => this.pending() > 0);
  /** Bumped when the map is replaced or discarded, so late results are dropped. */
  private session = 0;

  private readonly tables = computed(() => new Map(this.workspace.view().tables.map((t) => [t.id, t])));
  private readonly refs = this.browser.refs;
  private readonly refCols = computed(() => refColumns(this.refs()));
  private readonly withParents = computed(() => new Set(this.refs().map((r) => r.from.table)));
  private readonly withChildren = computed(() => new Set(this.refs().map((r) => r.to.table)));
  private cardCache = new WeakMap<rg.RowNode, { deps: unknown[]; view: CardView }>();

  readonly cards = computed<CardView[]>(() => {
    const g = this.graph();
    if (!g) return [];
    const tables = this.tables();
    const refCols = this.refCols();
    const withParents = this.withParents();
    const withChildren = this.withChildren();
    const deps = [tables, refCols, withParents, withChildren, g.rootId];
    return [...g.nodes.values()].map((node) => {
      const cached = this.cardCache.get(node);
      if (cached && cached.deps.every((d, i) => d === deps[i])) return cached.view;
      const table = tables.get(node.tableId);
      const view: CardView = {
        node,
        table,
        layout: rg.cardLayout(node, table, refCols),
        title: table?.label ?? displayTable(node.tableId),
        keyText: rg.keyLabel(node, table?.primaryKey ?? []),
        canParents: withParents.has(node.tableId),
        canChildren: withChildren.has(node.tableId),
        isRoot: node.id === g.rootId,
      };
      this.cardCache.set(node, { deps, view });
      return view;
    });
  });

  readonly scene = computed<Scene>(() => {
    const g = this.graph();
    const boxes = new Map<string, TableBox>();
    if (!g) return { tables: boxes, edges: [], groups: [] };
    for (const c of this.cards()) {
      boxes.set(c.node.id, { table: c.table ?? placeholderTable(c.node.tableId), fields: c.layout.fields, x: c.node.x, y: c.node.y, w: rg.CARD_W, h: c.layout.height });
    }
    return { tables: boxes, edges: rg.routedEdges(g, boxes), groups: [] };
  });

  constructor() {
    // Another database (or a file) makes the map meaningless.
    effect(() => {
      this.workspace.source();
      untracked(() => this.discard());
    });
  }

  /** Starts a new map from a row of the data browser and loads its direct links. */
  show(tableId: string, columns: string[], values: (string | null)[]): void {
    this.cancel();
    this.session++;
    this.error.set(null);
    this.notice.set(null);
    this.loadingMore.set(new Set());
    this.viewport = null;
    this.cardCache = new WeakMap();
    const g = rg.rootNode(tableId, columns, values, this.pkOf(tableId));
    this.graph.set(g);
    this.open.set(true);
    void this.expand(g.rootId, "both");
  }

  reopen(): void {
    if (this.graph()) this.open.set(true);
  }

  /** Closes the overlay, keeping the map for `reopen`. */
  hide(): void {
    this.cancel();
    this.open.set(false);
  }

  discard(): void {
    this.cancel();
    this.session++;
    this.open.set(false);
    this.graph.set(null);
    this.error.set(null);
    this.notice.set(null);
    this.loadingMore.set(new Set());
    this.viewport = null;
  }

  cancel(): void {
    for (const op of this.running) void this.api.cancelOp(op);
  }

  /** Loads a card's parents, children, or both (directions already loaded are skipped). */
  async expand(nodeId: string, which: rg.Direction | "both"): Promise<void> {
    const node = this.graph()?.nodes.get(nodeId);
    if (!node) return;
    const dirs = (which === "both" ? (["parents", "children"] as const) : [which]).filter((d) => node[d] === "idle");
    if (!dirs.length) return;
    if (this.graph()!.nodes.size >= rg.MAX_NODES) {
      this.notice.set(`The map is limited to ${rg.MAX_NODES} rows`);
      return;
    }
    const refs = this.refs();
    let planned: rg.PlannedLookup[] = [];
    const notes: string[] = [];
    for (const d of dirs) {
      const p = rg.planLookups(node, d, refs);
      planned.push(...p.lookups);
      notes.push(...p.notes);
    }
    if (planned.length > rg.MAX_LOOKUPS) {
      notes.push(`Only the first ${rg.MAX_LOOKUPS} relationships were followed`);
      planned = planned.slice(0, rg.MAX_LOOKUPS);
    }
    this.patchNode(nodeId, (n) => {
      const next = { ...n, notes: [...new Set([...n.notes, ...notes])] };
      for (const d of dirs) next[d] = planned.some((p) => p.dir === d) ? "loading" : "done";
      return next;
    });
    const loading = dirs.filter((d) => planned.some((p) => p.dir === d));
    if (!planned.length) return;
    await this.run(planned, {
      done: (g) => setStates(g, nodeId, loading, "done"),
      failed: (g) => setStates(g, nodeId, loading, "idle"),
    });
  }

  /** Loads more rows of a capped relationship, placed where its pill was. */
  async showMore(markerId: string): Promise<void> {
    const m = this.graph()?.more.get(markerId);
    if (!m || m.shown >= rg.MAX_PER_REF || this.loadingMore().has(markerId)) return;
    const limit = Math.min(rg.MAX_PER_REF, m.shown + rg.MORE_STEP);
    this.loadingMore.update((s) => new Set(s).add(markerId));
    const unmark = () => this.loadingMore.update((s) => new Set([...s].filter((id) => id !== markerId)));
    await this.run([{ anchor: m.anchor, ref: m.ref, dir: m.dir, tableId: m.tableId, filters: m.filters, limit }], {
      // The pill goes after the new rows; they take its place.
      before: (g) => {
        const more = new Map(g.more);
        more.delete(markerId);
        return { ...g, more };
      },
      topFor: (anchor, dir) => (anchor === m.anchor && dir === m.dir ? m.y : undefined),
      done: (g) => (unmark(), g),
      failed: (g) => (unmark(), g),
    });
  }

  toggleAll(nodeId: string): void {
    const n = this.graph()?.nodes.get(nodeId);
    if (!n) return;
    this.patchNode(nodeId, (x) => ({ ...x, showAll: !x.showAll }));
    const g = this.graph();
    if (g && !n.showAll) this.graph.set(rg.relaxBelow(g, nodeId, this.heightOf));
  }

  moveNode(nodeId: string, x: number, y: number): void {
    this.patchNode(nodeId, (n) => ({ ...n, x, y }));
  }

  tidyUp(): void {
    const g = this.graph();
    if (g) this.graph.set(rg.tidy(g, this.heightOf));
  }

  startHere(nodeId: string): void {
    const n = this.graph()?.nodes.get(nodeId);
    if (n) this.show(n.tableId, n.columns, n.values);
  }

  /** Opens the card's row in the data browser (trail kept) and hides the map. */
  openInGrid(nodeId: string): void {
    const n = this.graph()?.nodes.get(nodeId);
    if (!n) return;
    const pk = this.pkOf(n.tableId);
    const filters: BrowseFilter[] = n.keyed
      ? pk.map((column) => ({ column, value: rg.cell(n, column) ?? null }))
      : n.columns.map((column, i) => ({ column, value: n.values[i] })).filter((f) => f.value === null || !rg.isTruncated(f.value));
    this.browser.push(n.tableId, filters);
    this.hide();
  }

  /** Opens every row of a capped relationship in the data browser. */
  openMoreInGrid(markerId: string): void {
    const m = this.graph()?.more.get(markerId);
    if (!m) return;
    this.browser.push(m.tableId, m.filters);
    this.hide();
  }

  /** Refs as the map draws them (for edge tooltips). */
  refById(id: string): VRef | undefined {
    return this.graph()?.edges.get(id)?.ref;
  }

  private readonly heightOf = (n: rg.RowNode): number => rg.cardLayout(n, untracked(this.tables).get(n.tableId), untracked(this.refCols)).height;

  private pkOf(tableId: string): string[] {
    return untracked(this.tables).get(tableId)?.primaryKey ?? [];
  }

  private patchNode(id: string, f: (n: rg.RowNode) => rg.RowNode): void {
    const g = this.graph();
    const n = g?.nodes.get(id);
    if (!g || !n) return;
    this.graph.set({ ...g, nodes: new Map(g.nodes).set(id, f(n)) });
  }

  private async run(
    planned: rg.PlannedLookup[],
    hooks: {
      before?: (g: rg.RowGraph) => rg.RowGraph;
      topFor?: rg.MergeOptions["topFor"];
      done: (g: rg.RowGraph) => rg.RowGraph;
      failed: (g: rg.RowGraph) => rg.RowGraph;
    },
  ): Promise<void> {
    const session = this.session;
    const fail = (message: string | null) => {
      if (session !== this.session) return;
      const g = this.graph();
      if (g) this.graph.set(hooks.failed(g));
      if (message) this.error.set(message);
    };
    const conn = await this.workspace.currentConnection();
    if (!conn) return fail("Not connected to a database");
    const op = crypto.randomUUID();
    this.running.add(op);
    this.pending.update((n) => n + 1);
    try {
      const res = await this.api.relatedRows(
        conn.input,
        { lookups: planned.map(rg.toRequest), timeoutSecs: this.settings.settings().queryTimeoutSecs },
        op,
      );
      if (session !== this.session) return;
      let g = this.graph();
      if (!g) return;
      if (hooks.before) g = hooks.before(g);
      const merged = rg.mergeLookups(g, planned, res.results, { heightOf: this.heightOf, pkOf: (id) => this.pkOf(id), topFor: hooks.topFor });
      this.graph.set(hooks.done(rg.linkKnown(merged.graph, this.refs())));
      this.error.set(null);
      if (merged.capped) this.notice.set(`The map is limited to ${rg.MAX_NODES} rows`);
    } catch (err) {
      fail(isCancelled(err) ? null : errorMessage(err));
    } finally {
      this.running.delete(op);
      this.pending.update((n) => n - 1);
    }
  }
}

function setStates(g: rg.RowGraph, id: string, dirs: rg.Direction[], state: rg.ExpandState): rg.RowGraph {
  const n = g.nodes.get(id);
  if (!n || !dirs.length) return g;
  const next = { ...n };
  for (const d of dirs) next[d] = state;
  return { ...g, nodes: new Map(g.nodes).set(id, next) };
}

/** A table the model no longer has (edited away): enough for routing. */
function placeholderTable(id: string): VTable {
  const dot = id.indexOf(".");
  return { id, schema: id.slice(0, dot), name: id.slice(dot + 1), label: displayTable(id), headerColor: null, note: null, groupId: null, fields: [], primaryKey: [], line: null, endOffset: null };
}
