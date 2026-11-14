import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { LazyStore } from "@tauri-apps/plugin-store";

import { TauriApi, errorMessage } from "../core/tauri-api.service";
import { importDdl } from "../export/sql-ddl";
import type { SqlDialect } from "../export/type-map";
import type { Engine } from "../core/tauri-api.service";
import { ProfilesService, engineInfo } from "../persistence/profiles.service";
import { SettingsService } from "../persistence/settings.service";
import { WorkloadStore } from "./workload.store";
import { type DocSnapshot, type Source, WorkspaceStore, sourceKey, watchablePath } from "./workspace.store";

/** What a tab reopens from in a later session. */
export type SessionEntry =
  | { kind: "db"; profileId: string; label: string; engine?: Engine }
  | { kind: "file"; path: string; label: string; dialect?: SqlDialect };

export interface SavedSession {
  tabs: SessionEntry[];
  /** Index (in `tabs`) of the tab that was active. */
  active: number;
}

export interface Tab {
  id: string;
  /** The document while the tab is in the background (the active tab lives in the workspace). */
  snapshot: DocSnapshot | null;
  /** Restored from the last session and not loaded yet. */
  pending: SessionEntry | null;
  /** The file changed on disk while the tab had unsaved edits (shown when it is activated). */
  externalChange?: { path: string; contents: string };
}

export interface TabView {
  id: string;
  label: string;
  kind: string;
  detail: string;
  dirty: boolean;
  active: boolean;
  pending: boolean;
}

const newId = () => crypto.randomUUID().slice(0, 8);

/** The badge on a tab: the engine, or the file type. */
function kindOf(source: Source): string {
  return source.kind === "db" ? engineInfo(source.engine).short : source.dialect ? "SQL" : "DBML";
}

/**
 * What reopens next time: each tab's source (the active one's from the workspace), in order.
 * Empty tabs and pasted imports are left out; a tab still waiting to load keeps its place.
 */
export function sessionOf(tabs: Tab[], activeId: string, liveSource: Source | null): SavedSession {
  const entries: SessionEntry[] = [];
  let active = 0;
  for (const t of tabs) {
    const entry = (t.id === activeId ? entryOf(liveSource) : entryOf(t.snapshot?.source)) ?? t.pending;
    if (!entry) continue;
    if (t.id === activeId) active = entries.length;
    entries.push(entry);
  }
  return { tabs: entries, active };
}

/** Same identity as `sourceKey`, for a tab that has not loaded yet. */
function entryKey(entry: SessionEntry): string {
  return entry.kind === "db" ? `db:${entry.profileId}` : `file:${entry.path.toLowerCase()}`;
}

function pendingKind(entry: SessionEntry): string {
  if (entry.kind === "db") return entry.engine ? engineInfo(entry.engine).short : "DB";
  return entry.dialect ? "SQL" : "DBML";
}

function entryOf(source: Source | null | undefined): SessionEntry | null {
  if (!source) return null;
  if (source.kind === "db") return { kind: "db", profileId: source.profileId, label: source.label, engine: source.engine };
  if (source.path) return { kind: "file", path: source.path, label: source.label, dialect: source.dialect };
  return null; // pasted SQL: nothing to reopen
}

/**
 * Several documents open at once. The active tab's document lives in `WorkspaceStore`; the others
 * are kept as snapshots, each with its own editor model (undo history) and canvas history.
 */
@Injectable({ providedIn: "root" })
export class TabsStore {
  private readonly workspace = inject(WorkspaceStore);
  private readonly workload = inject(WorkloadStore);
  private readonly profiles = inject(ProfilesService);
  private readonly settings = inject(SettingsService);
  private readonly api = inject(TauriApi);
  private readonly session = new LazyStore("session.json", { autoSave: false, defaults: {} });

  readonly tabs = signal<Tab[]>([{ id: newId(), snapshot: null, pending: null }]);
  readonly activeId = signal(this.tabs()[0].id);
  private watched = new Set<string>();
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private restoring = false;

  readonly views = computed<TabView[]>(() => {
    const active = this.activeId();
    const liveSource = this.workspace.source();
    // Only edits that would be lost count: a database tab's edits are kept for that database.
    const liveDirty = this.workspace.needsSave();
    return this.tabs().map((t) => {
      const isActive = t.id === active;
      const source = isActive ? liveSource : (t.snapshot?.source ?? null);
      // Not loaded yet: a background tab never shown, or the active tab whose loading was cancelled.
      const pending = !!t.pending && (isActive ? !liveSource : !t.snapshot);
      const label = source?.label ?? t.pending?.label ?? "Untitled";
      const kind = source ? kindOf(source) : t.pending ? pendingKind(t.pending) : "";
      return {
        id: t.id,
        label,
        kind,
        detail: source?.detail ?? (t.pending ? (isActive ? "Click to open it" : "Opens when you switch to it") : "Empty"),
        dirty: isActive ? liveDirty : !!t.snapshot && t.snapshot.source?.kind !== "db" && t.snapshot.dbml !== t.snapshot.baseline,
        active: isActive,
        pending,
      };
    });
  });

  constructor() {
    this.workspace.tabHost = { beforeOpen: (key) => this.beforeOpen(key) };
    void this.api.onFileChanged((change) => this.onExternalChange(change.path, change.contents));
    // Keep file watches and the saved session in step with what is open.
    effect(() => {
      this.tabs();
      this.activeId();
      this.workspace.source();
      untracked(() => {
        // A restored tab that got its document (e.g. through the connect dialog) is no longer pending.
        const active = this.activeId();
        if (this.workspace.source() && this.tabs().some((t) => t.id === active && t.pending)) {
          this.tabs.update((ts) => ts.map((t) => (t.id === active ? { ...t, pending: null } : t)));
        }
        this.syncWatches();
        this.saveSessionSoon();
      });
    });
  }

  // ------------------------------------------------------------------ opening & switching

  /**
   * Called by the workspace before it opens a document: reuses an empty tab, switches to a clean
   * tab that already shows this source, or makes a new tab for it.
   */
  private beforeOpen(key: string | null): void {
    if (this.restoring) return;
    const active = this.tabs().find((t) => t.id === this.activeId());
    const empty = !this.workspace.source() && !this.workspace.dbml().trim();
    // An empty tab takes the document, unless it is a restored tab still waiting for another one.
    if (empty && (!active?.pending || entryKey(active.pending) === key)) return;
    // A restored tab that has not loaded yet and is meant for this document: open it there.
    const waiting = key ? this.tabs().find((t) => t.id !== this.activeId() && !t.snapshot && t.pending && entryKey(t.pending) === key) : undefined;
    if (waiting) {
      this.stash();
      this.activeId.set(waiting.id);
      this.workspace.restore(null);
      return;
    }
    // A database tab is reused even when edited: its edits are kept for the database and merged back in.
    const reusable = (s: DocSnapshot) => s.dbml === s.baseline || s.source?.kind === "db";
    const existing = key ? this.tabs().find((t) => t.id !== this.activeId() && t.snapshot && sourceKey(t.snapshot.source) === key && reusable(t.snapshot)) : undefined;
    if (existing) {
      this.stash();
      this.activeId.set(existing.id);
      this.tabs.update((ts) => ts.map((t) => (t.id === existing.id ? { ...t, snapshot: null } : t)));
      return;
    }
    if (key && sourceKey(this.workspace.source()) === key && !this.workspace.needsSave()) return; // reopening what is shown
    this.stash();
    const tab: Tab = { id: newId(), snapshot: null, pending: null };
    this.tabs.update((ts) => [...ts, tab]);
    this.activeId.set(tab.id);
    this.workspace.restore(null);
  }

  /** Saves the active tab's document into its tab. */
  private stash(): void {
    const id = this.activeId();
    if (this.workload.enabled()) void this.workload.disable();
    const snap = this.workspace.snapshot();
    // A restored tab that never loaded stays pending, so it loads when shown again.
    const unloaded = !snap.source && !snap.dbml.trim();
    this.tabs.update((ts) => ts.map((t) => (t.id === id ? { ...t, snapshot: unloaded && t.pending ? null : snap } : t)));
  }

  newTab(): void {
    this.stash();
    const tab: Tab = { id: newId(), snapshot: null, pending: null };
    this.tabs.update((ts) => [...ts, tab]);
    this.activeId.set(tab.id);
    this.workspace.restore(null);
  }

  activate(id: string): void {
    if (id === this.activeId()) {
      // Clicking a restored tab that did not load (e.g. the password prompt was cancelled) tries again.
      const tab = this.tabs().find((t) => t.id === id);
      if (tab?.pending && !this.workspace.source()) void this.load(tab.pending);
      return;
    }
    const target = this.tabs().find((t) => t.id === id);
    if (!target) return;
    this.stash();
    this.activeId.set(id);
    this.tabs.update((ts) => ts.map((t) => (t.id === id ? { ...t, snapshot: null, externalChange: undefined } : t)));
    this.workspace.restore(target.snapshot);
    if (target.externalChange) this.workspace.externalChange.set(target.externalChange);
    if (!target.snapshot && target.pending) void this.load(target.pending);
  }

  cycle(step: 1 | -1): void {
    const ts = this.tabs();
    const i = ts.findIndex((t) => t.id === this.activeId());
    this.activate(ts[(i + step + ts.length) % ts.length].id);
  }

  async close(id: string): Promise<void> {
    const view = this.views().find((v) => v.id === id);
    if (view?.dirty) {
      const ok = await ask(`"${view.label}" has unsaved changes. Close it anyway?`, { title: "Close tab", kind: "warning" });
      if (!ok) return;
    }
    const ts = this.tabs();
    const i = ts.findIndex((t) => t.id === id);
    if (i < 0) return;
    if (id === this.activeId()) {
      if (ts.length === 1) {
        if (this.workload.enabled()) void this.workload.disable();
        const fresh: Tab = { id: newId(), snapshot: null, pending: null };
        this.tabs.set([fresh]);
        this.activeId.set(fresh.id);
        this.workspace.restore(null);
        return;
      }
      const next = ts[i + 1] ?? ts[i - 1];
      this.activate(next.id);
    }
    this.tabs.update((list) => list.filter((t) => t.id !== id));
  }

  /** Any tab with edits that closing would lose (asked about before the window closes). */
  anyUnsaved(): boolean {
    return this.views().some((v) => v.dirty);
  }

  // ------------------------------------------------------------------ session

  /** Reopens the last session's tabs; the active one loads now, the others when first shown. */
  async restoreSession(): Promise<void> {
    await this.settings.loaded;
    if (!this.settings.settings().restoreSession) return;
    const saved = await this.session.get<SavedSession>("session").catch(() => undefined);
    if (!saved?.tabs?.length) return;
    if (this.workspace.source() || this.workspace.dbml().trim()) return; // something was opened already
    const tabs: Tab[] = saved.tabs.map((entry) => ({ id: newId(), snapshot: null, pending: entry }));
    const active = Math.min(Math.max(saved.active ?? 0, 0), tabs.length - 1);
    this.tabs.set(tabs);
    this.activeId.set(tabs[active].id);
    await this.load(tabs[active].pending!);
  }

  /** Loads a tab restored from the last session into the (empty) active tab. */
  private async load(entry: SessionEntry): Promise<void> {
    const id = this.activeId();
    this.restoring = true;
    try {
      if (entry.kind === "db") {
        await this.profiles.load();
        const profile = this.profiles.profiles().find((p) => p.id === entry.profileId);
        if (!profile) throw new Error(`The connection "${entry.label}" no longer exists`);
        if (!(await this.workspace.canConnectSilently(profile))) {
          // No saved password: ask for it in the connect dialog (the tab stays pending until then).
          this.workspace.signInRequest.set({ profileId: profile.id, reason: `Enter the password to reopen ${entry.label}.` });
          return;
        }
        const ok = await this.workspace.connect(profile, "", false);
        if (!ok) this.workspace.error.set(`Could not reopen ${entry.label}: ${this.workspace.error() ?? "connection failed"}. Use Connect… to sign in.`);
      } else {
        const contents = await this.api.readTextFile(entry.path);
        if (entry.dialect) {
          const r = await importDdl(contents, entry.dialect, (sql) => this.api.importSqliteDdl(sql));
          const name = entry.path.split(/[\\/]/).pop() ?? entry.path;
          await this.workspace.openImported({ text: contents, path: entry.path, name }, r.dbml, entry.dialect);
        } else {
          await this.workspace.openFileContents(entry.path, contents);
        }
      }
      this.tabs.update((ts) => ts.map((t) => (t.id === id ? { ...t, pending: null } : t)));
    } catch (err) {
      this.workspace.error.set(`Could not reopen ${entry.label}: ${errorMessage(err)}`);
    } finally {
      this.restoring = false;
    }
  }

  private saveSessionSoon(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => void this.saveSession(), 500);
  }

  private async saveSession(): Promise<void> {
    try {
      await this.session.set("session", sessionOf(this.tabs(), this.activeId(), this.workspace.source()));
      await this.session.save();
    } catch {
      /* the session is a convenience */
    }
  }

  // ------------------------------------------------------------------ files on disk

  /** Watches exactly the .dbml files open in some tab. */
  private syncWatches(): void {
    const active = this.activeId();
    const wanted = new Set<string>();
    for (const t of this.tabs()) {
      const path = watchablePath(t.id === active ? this.workspace.source() : t.snapshot?.source);
      if (path) wanted.add(path);
    }
    for (const path of wanted) if (!this.watched.has(path)) void this.api.watchFile(path).catch(() => undefined);
    for (const path of this.watched) if (!wanted.has(path)) void this.api.unwatchFile(path);
    this.watched = wanted;
  }

  /** Another program changed an open file: reload clean tabs, ask about edited ones. */
  private onExternalChange(path: string, contents: string): void {
    const same = (p: string | null) => !!p && p.toLowerCase() === path.toLowerCase();
    const auto = this.settings.settings().autoReloadFiles;
    const active = this.activeId();
    if (same(watchablePath(this.workspace.source()))) {
      if (contents === this.workspace.dbml()) return;
      if (auto && !this.workspace.dirty()) this.workspace.reloadFromDisk(contents);
      else this.workspace.externalChange.set({ path, contents });
    }
    this.tabs.update((ts) =>
      ts.map((t) => {
        if (t.id === active || !t.snapshot || !same(watchablePath(t.snapshot.source))) return t;
        const clean = t.snapshot.dbml === t.snapshot.baseline;
        if (auto && clean) return { ...t, snapshot: { ...t.snapshot, dbml: contents, baseline: contents } };
        return { ...t, externalChange: { path, contents } };
      }),
    );
  }
}
