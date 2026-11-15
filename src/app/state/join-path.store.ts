import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { type JoinPath, type PathOutcome, type StepVariant, TauriApi, errorMessage } from "../core/tauri-api.service";
import { displayTable } from "../diagram/view-model";
import { PATH_DIALECT_LABEL, buildJoinGraph, pathDialectOf } from "../paths/join-graph";
import { ModulesStore } from "./modules.store";
import { WorkloadStore } from "./workload.store";
import { WorkspaceStore, sourceKey } from "./workspace.store";

export const MAX_PATHS = 3;
export const MAX_HOPS = 6;
const RESEARCH_DELAY_MS = 150;

/** What the canvas highlights in path mode: the path's tables and the edges of its chosen variants. */
export interface PathHighlight {
  tables: ReadonlySet<string>;
  refs: ReadonlySet<string>;
}

/** The variant of each step the user picked (the first by default). */
export function chosenVariants(path: JoinPath, picked: readonly number[]): StepVariant[] {
  return path.steps.map((s, i) => s.variants[picked[i] ?? 0] ?? s.variants[0]);
}

export function pathHighlight(path: JoinPath, picked: readonly number[]): PathHighlight {
  return { tables: new Set(path.tables), refs: new Set(chosenVariants(path, picked).map((v) => v.edge)) };
}

/** Index of the route with the same tables in a new result, so a new search keeps the one shown. */
export function sameRoute(paths: readonly JoinPath[], shown: JoinPath | null): number {
  if (!shown) return -1;
  const key = shown.tables.join("\u0000");
  return paths.findIndex((p) => p.tables.join("\u0000") === key);
}

/**
 * Join path mode: the best routes between two tables (src-tauri/crates/join-paths), one shown at
 * a time, the rest of the diagram dimmed. Searches again when the model, the traffic or the
 * options change; leaves when another document is shown.
 */
@Injectable({ providedIn: "root" })
export class JoinPathStore {
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly modules = inject(ModulesStore);
  private readonly api = inject(TauriApi);

  /** The two ends while path mode is on. */
  readonly ends = signal<{ from: string; to: string } | null>(null);
  readonly avoid = signal<readonly string[]>([]);
  /** Use the joins seen in the queries (when a traffic report is loaded). */
  readonly includeDiscovered = signal(true);
  readonly outcome = signal<PathOutcome | null>(null);
  readonly index = signal(0);
  /** Chosen variant per step of the shown path. */
  readonly picked = signal<readonly number[]>([]);
  readonly searching = signal(false);
  /** A change asks the canvas to fit the shown path. */
  readonly fitRequests = signal(0);

  readonly active = computed(() => !!this.ends());
  /** X-ray's report, or the one Find modules read: never read again for this. */
  readonly traffic = computed(() => this.workload.report() ?? this.modules.loadedTraffic());
  readonly hasTraffic = computed(() => !!this.traffic()?.available && (this.traffic()?.relations.length ?? 0) > 0);
  readonly graph = computed(() => buildJoinGraph(this.workspace.view(), this.traffic(), { discovered: this.includeDiscovered() }));
  readonly paths = computed(() => {
    const o = this.outcome();
    return o?.kind === "found" ? o.paths : [];
  });
  readonly current = computed(() => this.paths()[this.index()] ?? null);
  readonly highlight = computed<PathHighlight | null>(() => {
    const ends = this.ends();
    if (!ends) return null;
    const p = this.current();
    return p ? pathHighlight(p, this.picked()) : { tables: new Set([ends.from, ends.to]), refs: new Set() };
  });
  /** Tables of the shown path that are hidden on the canvas. */
  readonly hiddenOnPath = computed(() => (this.current()?.tables ?? []).filter((t) => this.workspace.hidden().has(t)));

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private documentKey: string | null = null;

  constructor() {
    // Search (again) when the ends, the avoided tables, the model or the traffic change.
    effect(() => {
      const ends = this.ends();
      this.graph();
      this.avoid();
      if (!ends) return;
      untracked(() => this.schedule());
    });
    // Another document or tab: path mode ends.
    effect(() => {
      const key = sourceKey(this.workspace.source());
      untracked(() => {
        if (key !== this.documentKey && this.active()) this.exit();
        this.documentKey = key;
      });
    });
  }

  /** Shows the best routes from `from` to `to`. */
  show(from: string, to: string): void {
    this.ends.set({ from, to });
    this.avoid.set([]);
    this.outcome.set(null);
    this.index.set(0);
    this.picked.set([]);
  }

  swap(): void {
    const ends = this.ends();
    if (!ends) return;
    this.outcome.set(null);
    this.ends.set({ from: ends.to, to: ends.from });
  }

  /** Shows the next (or previous) route. */
  step(by: 1 | -1): void {
    const n = this.paths().length;
    if (n < 2) return;
    this.index.set((this.index() + by + n) % n);
    this.picked.set([]);
    this.fitRequests.update((v) => v + 1);
  }

  setVariant(step: number, variant: number): void {
    const next = [...this.picked()];
    while (next.length <= step) next.push(0);
    next[step] = variant;
    this.picked.set(next);
  }

  avoidTable(id: string): void {
    if (!this.avoid().includes(id)) this.avoid.set([...this.avoid(), id]);
  }

  allowTable(id: string): void {
    this.avoid.set(this.avoid().filter((t) => t !== id));
  }

  clearAvoid(): void {
    this.avoid.set([]);
  }

  exit(): void {
    this.seq++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ends.set(null);
    this.outcome.set(null);
    this.avoid.set([]);
    this.picked.set([]);
    this.searching.set(false);
  }

  /** Unhides the hidden tables on the shown path (one undo step). */
  showHidden(): void {
    const hidden = this.hiddenOnPath();
    if (hidden.length) this.workspace.setHidden(hidden, false);
  }

  /** Copies the shown path as a SELECT skeleton, quoted for the document's database. */
  async copySql(): Promise<void> {
    const p = this.current();
    if (!p) return;
    const ids = new Set(p.tables);
    const tables = this.graph().tables.filter((t) => ids.has(t.id));
    const dialect = pathDialectOf(this.workspace.source());
    try {
      const sql = await this.api.joinPathSql(p, tables, dialect, [...this.picked()]);
      await navigator.clipboard?.writeText(sql);
      this.workspace.flash(`SQL copied (${PATH_DIALECT_LABEL[dialect]} quoting)`);
    } catch (err) {
      this.workspace.error.set(errorMessage(err));
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    // The first search right away; later ones (typing in the editor) once things settle.
    this.timer = setTimeout(() => void this.search(), this.outcome() ? RESEARCH_DELAY_MS : 0);
  }

  private async search(): Promise<void> {
    const ends = this.ends();
    if (!ends) return;
    const seq = ++this.seq;
    const shown = this.current();
    this.searching.set(true);
    try {
      const out = await this.api.findJoinPaths(this.graph(), ends.from, ends.to, { maxPaths: MAX_PATHS, maxHops: MAX_HOPS, avoid: [...this.avoid()] });
      if (seq !== this.seq || !this.ends()) return;
      if (out.kind === "invalid" && out.error.kind === "unknownTable") {
        this.workspace.flash(`${displayTable(out.error.table)} is no longer in the diagram`);
        this.exit();
        return;
      }
      this.outcome.set(out);
      const again = out.kind === "found" ? sameRoute(out.paths, shown) : -1;
      if (again >= 0) {
        this.index.set(again);
      } else {
        this.index.set(0);
        this.picked.set([]);
        this.fitRequests.update((v) => v + 1);
      }
    } catch (err) {
      if (seq === this.seq) this.workspace.error.set(errorMessage(err));
    } finally {
      if (seq === this.seq) this.searching.set(false);
    }
  }
}
