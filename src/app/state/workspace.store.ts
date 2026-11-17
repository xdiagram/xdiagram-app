import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";
import type { Database } from "@dbml/core";
import { ask } from "@tauri-apps/plugin-dialog";

import { loadDbmlCore } from "../core/dbml";
import type { EditorDiagnostic } from "../core/diagnostics";
import { DocumentParser } from "../core/document-parser";
import { ConnectionInput, TauriApi, errorMessage } from "../core/tauri-api.service";
import type { DetailLevel } from "../diagram/geometry";
import { type SqlDialect, dialectLabel } from "../export/sql-ddl";
import { layoutTables, prewarmLayout } from "../diagram/layout";
import { EMPTY_VIEW, type ViewModel } from "../diagram/view-model";
import { timed, timedAsync } from "../core/perf";
import { LayoutService, type Point, type Viewport } from "../persistence/layout.service";
import { DraftService } from "../persistence/draft.service";
import { FilterMemoryService } from "../persistence/filter-memory.service";
import { type MergeConflict, mergeDbml } from "../editor/merge";
import { CanvasHistory, type HistoryEntry, type LayoutState } from "./canvas-history";
import { type Arrangement, type Placement, fromSaved, renameInDoc, toSaved } from "./arrangements";
import type { ModulesDoc } from "../modules/types";
import { type SchemaChanges, diffSchemas, isEmptyChange } from "./schema-diff";
import type { Engine } from "../core/tauri-api.service";
import {
  ConnectionProfile,
  ProfilesService,
  databaseKeyOf,
  engineInfo,
  profileLabel,
  profileMeta,
  sshSecretId,
  toConnectionInput,
} from "../persistence/profiles.service";

export type Source =
  | { kind: "db"; profileId: string; engine: Engine; label: string; detail: string }
  | { kind: "file"; path: string; label: string; detail: string; /** Set when the file was imported from SQL. */ dialect?: SqlDialect };

/** Everything a tab needs to bring its document back (see `TabsStore`). */
export interface DocSnapshot {
  source: Source | null;
  dbml: string;
  baseline: string;
  positions: Record<string, Point>;
  hidden: string[];
  detail: DetailLevel;
  viewport: Viewport | null;
  layoutKey: string | null;
  activeView: string | null;
  history: CanvasHistory;
  /** Which arrangement `positions`/`viewport` belong to; the other one is `parked`. */
  arrangement: Arrangement;
  parked: Placement | null;
  modules: ModulesDoc | null;
}

/** Identity of a source, to find a tab that already shows it (null: always a new tab). */
export function sourceKey(source: Source | null | undefined): string | null {
  if (!source) return null;
  if (source.kind === "db") return `db:${source.profileId}`;
  return source.path ? `file:${source.path.toLowerCase()}` : null;
}

/** The path of an open .dbml file (saved in place and watched), or null. */
export function watchablePath(source: Source | null | undefined): string | null {
  return source?.kind === "file" && source.path && !source.dialect && /\.(dbml|txt)$/i.test(source.path) ? source.path : null;
}

/** What changed in a database since its tab last read it, and edits of the user's that clashed. */
export interface SchemaReport {
  /** The database, as its tab names it. */
  label: string;
  /** Null when one of the two schemas could not be read back for comparison. */
  changes: SchemaChanges | null;
  /** Lines both the user and the database changed: the database's version was kept. */
  conflicts: MergeConflict[];
}

/** A SQL/schema.rb script waiting in the import dialog (`path` is null for pasted text). */
export interface ImportRequest {
  text: string;
  path: string | null;
  name: string;
}

export type { EditorDiagnostic } from "../core/diagnostics";

/** Implemented by the diagram component; lets the toolbar drive the canvas. */
export interface DiagramHandle {
  fit(): void;
  focusTable(id: string): void;
  /** Focuses the table and briefly highlights one of its columns. */
  flashField(tableId: string, field: string): void;
  /** PNG data URL of the whole diagram, or null when empty. */
  exportPng(): string | null;
  exportSvg(): string | null;
  /** Ctrl+A: selects every table on the canvas. */
  selectAll(): void;
  /** Escape: clears the selection; false when there was nothing to clear. */
  clearSelection(): boolean;
  /** The viewport now (the one saved through `setViewport` lags behind by a moment). */
  currentViewport(): Viewport | null;
  /** Zooms to fit these tables. */
  fitTo(ids: readonly string[]): void;
  /** Escape on the canvas (see DiagramComponent.escape); false when it had nothing to do. */
  escape(): boolean;
  /** The selected tables, in the order they were selected. */
  selectedTables(): string[];
}

/** Implemented by the DBML editor; lets the canvas and shortcuts use its undo history. */
export interface EditorHandle {
  /** Applies a whole-document change as one undoable step; returns the model version after it. */
  applyEdit(text: string): number | null;
  /** The model's alternative version id (equal again after undoing back to a state). */
  versionId(): number | null;
  undo(): number | null;
  redo(): number | null;
  /** Ends the current undo step (after a save, so undo goes back exactly to the saved text). */
  checkpoint(): void;
}

const PARSE_DEBOUNCE_MS = 300;

/**
 * Single source of truth for the workspace. The DBML text drives everything: it is parsed
 * (debounced) into a `Database`, which becomes the diagram view model. Positions, visibility
 * and viewport are kept per database / file and persisted through `LayoutService`.
 */
@Injectable({ providedIn: "root" })
export class WorkspaceStore {
  private readonly api = inject(TauriApi);
  private readonly layouts = inject(LayoutService);
  private readonly profiles = inject(ProfilesService);
  private readonly parser = inject(DocumentParser);
  private readonly drafts = inject(DraftService);
  private readonly filterMemory = inject(FilterMemoryService);

  readonly source = signal<Source | null>(null);
  readonly dbml = signal("");
  /** Diagram model of the last DBML that parsed (kept while the text has errors). Parsed in a worker. */
  readonly view = signal<ViewModel>(EMPTY_VIEW);
  /** Some DBML has parsed: there is a model to edit from the canvas. */
  readonly hasModel = computed(() => this.view() !== EMPTY_VIEW);
  /** The text behind `view`, and its full `@dbml/core` model once asked for (see `parsedDatabase`). */
  private parsedText = "";
  private databaseCache: { text: string; db: Database } | null = null;
  readonly diagnostics = signal<EditorDiagnostic[]>([]);
  readonly positions = signal<Record<string, Point>>({});
  readonly hidden = signal<ReadonlySet<string>>(new Set());
  /** How much of each table is drawn; saved with the layout. */
  readonly detail = signal<DetailLevel>("all");
  /** When on, selecting a table fades everything more than one relationship away. */
  readonly focusMode = signal(false);
  /** The DBML `DiagramView` currently applied to the visibility, if any. */
  readonly activeView = signal<string | null>(null);
  /**
   * Which arrangement `positions` holds: the user's own, or the one Find modules made. The other
   * one waits in `parked`. Visibility and detail level are shared by both.
   */
  readonly arrangement = signal<Arrangement>("mine");
  /** What Find modules found for this document (null: no Modules arrangement). */
  readonly modulesDoc = signal<ModulesDoc | null>(null);
  /** Saved viewport to restore when a document is opened (null → fit to screen). */
  readonly initialViewport = signal<Viewport | null>(null);
  /** Bumped when a document is opened or re-arranged, so the diagram re-applies its viewport. */
  readonly documentVersion = signal(0);
  /** Tables without a position are being laid out (the diagram waits for them). */
  readonly layingOut = signal(false);
  /**
   * The text as loaded or last saved; the document has edits when it differs. On a database tab
   * it is the DBML the database gave when last read.
   */
  readonly baseline = signal("");
  readonly dirty = computed(() => this.dbml() !== this.baseline());
  /**
   * Edits that would be lost on close. A database tab's edits never are: they are kept for that
   * database (see `DraftService`) and come back on the next connection.
   */
  readonly needsSave = computed(() => this.dirty() && this.source()?.kind !== "db");
  /** Shown as a banner after a database tab was opened or refreshed and its schema had changed. */
  readonly schemaChanges = signal<SchemaReport | null>(null);
  readonly busy = signal<string | null>(null);
  /** Operation id of the running cancellable task (see `cancelBusy`). */
  readonly busyOp = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly revealRequest = signal<{ line: number; focus: boolean; nonce: number } | null>(null);
  /** Set while the SQL import dialog is open. */
  readonly importRequest = signal<ImportRequest | null>(null);
  /** Set while the sample data dialog is open (`table`: opened from that table's menu). */
  readonly sampleDataFor = signal<{ table: string | null } | null>(null);
  /** Whether the DBML editor pane is shown. Hidden, it stays mounted: canvas edits and undo go through it. */
  readonly editorOpen = signal(readEditorPref());

  diagram: DiagramHandle | null = null;
  editor: EditorHandle | null = null;
  /** Undo/redo for canvas actions (layout and DBML edits made from the canvas or panels). */
  history = new CanvasHistory();
  /** Set by `TabsStore`: decides which tab a document being opened goes to. */
  tabHost: { beforeOpen(key: string | null): void } | null = null;
  /** The open file changed on disk while it had unsaved edits: Reload or Keep mine. */
  readonly externalChange = signal<{ path: string; contents: string } | null>(null);

  private layoutKey: string | null = null;
  private viewport: Viewport | null = null;
  /** The arrangement not shown: My layout while Modules is shown, else the Modules one (or null). */
  private parked: Placement | null = null;
  /** Set by the modules store: lays the modules out again (Auto-arrange while Modules is shown). */
  moduleArranger: (() => Promise<Record<string, Point> | null>) | null = null;
  private parseTimer: ReturnType<typeof setTimeout> | null = null;
  private layoutSeq = 0;
  private parseSeq = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Passwords typed this session but not saved to the keychain. Never persisted. */
  private readonly sessionPasswords = new Map<string, string>();
  /** The same for SSH passwords / key passphrases. */
  private readonly sessionSshSecrets = new Map<string, string>();
  /** A connection to sign in to (a restored tab without a saved password): opens the connect dialog. */
  readonly signInRequest = signal<{ profileId: string; reason: string } | null>(null);

  /** True when connecting needs no password prompt (saved in the keychain, typed this session, or SQLite). */
  async canConnectSilently(profile: ConnectionProfile): Promise<boolean> {
    if (profile.engine === "sqlite") return true;
    const known = (id: string, session: Map<string, string>) => (session.has(profile.id) ? Promise.resolve(true) : this.api.hasPassword(id).catch(() => false));
    if (!(await known(profile.id, this.sessionPasswords))) return false;
    // An SSH password is needed too (a key may have no passphrase).
    return profile.ssh?.auth !== "password" || known(sshSecretId(profile.id), this.sessionSshSecrets);
  }

  constructor() {
    // ELK loads in its worker while the app is idle, so the first diagram does not wait for it.
    setTimeout(prewarmLayout, 1500);
    // A database tab's DBML is kept for that database as it changes (debounced in the service).
    effect(() => {
      const source = this.source();
      const dbml = this.dbml();
      const baseline = this.baseline();
      untracked(() => {
        if (source?.kind === "db" && this.layoutKey && baseline) this.drafts.save(this.layoutKey, { baseline, dbml });
      });
    });
  }

  /** Writes the debounced saves (database tabs' DBML, layouts) now: before closing or restarting. */
  async flushPending(): Promise<void> {
    await Promise.all([this.drafts.flush(), this.layouts.flush(), this.filterMemory.flush()]);
  }

  /** Identity of the open document (database or file) its layout is kept under. */
  documentKey(): string | null {
    return this.layoutKey;
  }

  /** The open database's identity (layouts, drafts and remembered filters are kept by it). */
  databaseKey(): string | null {
    return this.source()?.kind === "db" ? this.layoutKey : null;
  }

  // ------------------------------------------------------------------ opening documents

  /** Resolves to true when the schema was loaded. */
  connect(profile: ConnectionProfile, password: string, rememberPassword: boolean, sshSecret = ""): Promise<boolean> {
    return this.run("Reading schema…", async (op) => {
      if (password) {
        this.sessionPasswords.set(profile.id, password);
        if (rememberPassword) await this.api.savePassword(profile.id, password, toConnectionInput(profile));
      }
      if (sshSecret && profile.ssh) {
        this.sessionSshSecrets.set(profile.id, sshSecret);
        if (rememberPassword) await this.api.savePassword(sshSecretId(profile.id), sshSecret, toConnectionInput(profile));
      }
      const fresh = await this.fetchDbml(profile, op);
      // The user's DBML for this database comes back, with what changed in the database since merged in.
      const key = databaseKeyOf(profile);
      const draft = await this.drafts.load(key);
      const merged = draft ? mergeDbml(draft.baseline, draft.dbml, fresh) : { text: fresh, conflicts: [] };
      await this.openDocument(merged.text, this.dbSource(profile), key, fresh);
      const kept = merged.text !== fresh ? " (with your DBML edits)" : "";
      this.flash(`Loaded ${this.view().tables.length} tables from ${profileLabel(profile)}${kept}`);
      if (draft && draft.baseline !== fresh) void this.reportSchemaChanges(draft.baseline, fresh, merged.conflicts, profileLabel(profile));
    });
  }

  /**
   * Re-reads the schema of the current database, keeping table positions and the user's DBML
   * edits: what changed in the database is merged into the edited text (three-way, with the
   * last read as the base). Where both changed the same lines, the database wins and the banner
   * lists the user's lines.
   */
  async refresh(): Promise<void> {
    const src = this.source();
    if (src?.kind !== "db") return;
    await this.profiles.load();
    const profile = this.profiles.profiles().find((p) => p.id === src.profileId);
    if (!profile) {
      this.error.set("The connection profile for this diagram no longer exists.");
      return;
    }
    await this.run("Refreshing schema…", async (op) => {
      const fresh = await this.fetchDbml(profile, op);
      this.source.set(this.dbSource(profile));
      const base = this.baseline();
      if (fresh === base) {
        this.flash("No changes in the database");
        return;
      }
      const merged = mergeDbml(base, this.dbml(), fresh);
      this.dbml.set(merged.text);
      this.baseline.set(fresh);
      // The editor takes the new text whole (its undo stack starts over), so canvas undo does too.
      this.history.clear();
      await this.parseNow();
      await this.ensureLayout();
      this.flash("Schema refreshed");
      void this.reportSchemaChanges(base, fresh, merged.conflicts, profileLabel(profile));
    });
  }

  /** Compares two reads of the database for the banner (in the parse worker, off the main thread). */
  private async reportSchemaChanges(before: string, after: string, conflicts: MergeConflict[], label: string): Promise<void> {
    const key = this.layoutKey;
    const [a, b] = await this.parser.views([before, after]);
    const changes = a && b ? diffSchemas(a, b) : null;
    if (key !== this.layoutKey) return; // another document was opened meanwhile
    if (changes && isEmptyChange(changes) && !conflicts.length) return;
    this.schemaChanges.set({ label, changes, conflicts });
  }

  /** Puts this database tab back to the schema as last read (one undoable step). */
  async discardDbEdits(): Promise<void> {
    if (this.source()?.kind !== "db" || !this.dirty()) return;
    const ok = await ask("Replace your edits to this database's DBML with the schema as last read from the database? Ctrl+Z brings them back.", {
      title: "Discard DBML edits",
      kind: "warning",
    });
    if (!ok) return;
    this.applyDbmlEdit(this.baseline(), "Discard DBML edits");
    this.flash("DBML reset to the database schema");
  }

  async openFile(): Promise<void> {
    await this.run("Opening file…", async () => {
      const file = await this.api.openTextFile("Schema files", ["dbml", "sql", "ddl", "rb", "txt"]);
      if (!file) return;
      const name = file.path.split(/[\\/]/).pop() ?? file.path;
      if (/\.(sql|ddl|rb)$/i.test(name)) {
        this.importRequest.set({ text: file.contents, path: file.path, name });
        return;
      }
      await this.openFileContents(file.path, file.contents);
    });
  }

  /** Opens .dbml text read from `path` (Open… or a restored session). */
  async openFileContents(path: string, contents: string): Promise<void> {
    const name = path.split(/[\\/]/).pop() ?? path;
    await this.openDocument(contents, { kind: "file", path, label: name, detail: path }, `file:${path}`);
  }

  /** Opens DBML converted by the import dialog, as a file document. */
  async openImported(req: ImportRequest, dbml: string, dialect: SqlDialect): Promise<boolean> {
    return this.run("Importing…", async () => {
      const detail = `${req.path ?? "Pasted SQL"} · imported from ${dialectLabel(dialect)}`;
      const key = req.path ? `file:${req.path}` : `import:${hashText(req.text)}`;
      await this.openDocument(dbml, { kind: "file", path: req.path ?? "", label: req.name, detail, dialect }, key);
      this.importRequest.set(null);
      this.flash(`Imported ${this.view().tables.length} tables from ${req.name}`);
    });
  }

  private async fetchDbml(profile: ConnectionProfile, op?: string): Promise<string> {
    const input = toConnectionInput(profile, this.sessionPasswords.get(profile.id), this.sessionSshSecrets.get(profile.id));
    const schema = await timedAsync("introspect", () => this.api.introspect(input, profile.schemas, op));
    const { importer } = await loadDbmlCore();
    return timed("generateDbml", () => importer.generateDbml(schema));
  }

  private dbSource(profile: ConnectionProfile): Source {
    const schemas = profile.schemas.length ? ` · ${profile.schemas.join(", ")}` : "";
    return {
      kind: "db",
      profileId: profile.id,
      engine: profile.engine,
      label: profileLabel(profile),
      detail: `${engineInfo(profile.engine).label} · ${profileMeta(profile)}${schemas}`,
    };
  }

  /** `baseline`: the unedited text (on a database tab, the DBML the database gave). */
  private async openDocument(dbml: string, source: Source, layoutKey: string, baseline = dbml): Promise<void> {
    this.tabHost?.beforeOpen(sourceKey(source));
    this.externalChange.set(null);
    this.schemaChanges.set(null);
    await Promise.all([this.layouts.flush(), this.drafts.flush()]);
    const saved = await this.layouts.load(layoutKey);
    // A layout still running for the previous document must not land in this one.
    this.layoutSeq++;
    this.layingOut.set(false);
    this.layoutKey = layoutKey;
    this.source.set(source);
    const arranged = fromSaved(saved);
    this.arrangement.set(arranged.arrangement);
    this.parked = arranged.parked;
    this.modulesDoc.set(arranged.modules);
    this.positions.set(arranged.shown.positions);
    this.hidden.set(new Set(saved?.hidden ?? []));
    this.detail.set(saved?.detail ?? "all");
    this.activeView.set(null);
    this.viewport = arranged.shown.viewport;
    this.initialViewport.set(this.viewport);
    this.dbml.set(dbml);
    this.baseline.set(baseline);
    this.history.clear();
    await this.parseNow();
    await this.ensureLayout();
    this.documentVersion.update((v) => v + 1);
  }

  // ------------------------------------------------------------------ tabs

  snapshot(): DocSnapshot {
    return {
      source: this.source(),
      dbml: this.dbml(),
      baseline: this.baseline(),
      positions: this.positions(),
      hidden: [...this.hidden()],
      detail: this.detail(),
      viewport: this.viewport,
      layoutKey: this.layoutKey,
      activeView: this.activeView(),
      history: this.history,
      arrangement: this.arrangement(),
      parked: this.parked,
      modules: this.modulesDoc(),
    };
  }

  /** Shows a tab's document (`null`: an empty tab). */
  restore(s: DocSnapshot | null): void {
    void this.layouts.flush();
    void this.drafts.flush();
    if (this.parseTimer) clearTimeout(this.parseTimer);
    this.externalChange.set(null);
    this.schemaChanges.set(null);
    this.layoutSeq++;
    this.layingOut.set(false);
    this.source.set(s?.source ?? null);
    this.layoutKey = s?.layoutKey ?? null;
    this.arrangement.set(s?.arrangement ?? "mine");
    this.parked = s?.parked ?? null;
    this.modulesDoc.set(s?.modules ?? null);
    this.positions.set(s?.positions ?? {});
    this.hidden.set(new Set(s?.hidden ?? []));
    this.detail.set(s?.detail ?? "all");
    this.activeView.set(s?.activeView ?? null);
    this.viewport = s?.viewport ?? null;
    this.initialViewport.set(this.viewport);
    this.history = s?.history ?? new CanvasHistory();
    this.dbml.set(s?.dbml ?? "");
    this.baseline.set(s?.baseline ?? "");
    this.diagnostics.set([]);
    if (!s) {
      this.view.set(EMPTY_VIEW);
      this.parsedText = "";
    }
    void this.parseNow().then(() => this.documentVersion.update((v) => v + 1));
  }

  // ------------------------------------------------------------------ files

  /** Ctrl+S: back to the open .dbml file, or Save As for databases and imported scripts. */
  async save(): Promise<void> {
    const path = watchablePath(this.source());
    if (!path) return this.saveAs();
    // Only files picked in a dialog are written in place (a tab reopened from an older session
    // may not be one yet): confirm the destination once with the save dialog.
    if (!(await this.api.canWrite(path).catch(() => false))) return this.saveAs();
    const text = this.dbml();
    try {
      await this.api.writeTextFile(path, text);
      this.baseline.set(text);
      this.editor?.checkpoint();
      this.flash(`Saved ${this.source()?.label}`);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  /** Saves the DBML to a new .dbml file, which this tab then follows (saved in place, watched). */
  async saveAs(): Promise<void> {
    const text = this.dbml();
    if (!text.trim()) return this.flash("Nothing to save yet");
    try {
      const path = await this.api.saveFile({ defaultName: `${this.exportBaseName()}.dbml`, filterName: "DBML", extensions: ["dbml"], contents: text, base64: false });
      if (!path) return;
      const name = path.split(/[\\/]/).pop() ?? path;
      const key = `file:${path}`;
      if (this.layoutKey !== key) {
        this.layoutKey = key;
        this.persist();
      }
      this.source.set({ kind: "file", path, label: name, detail: path });
      this.baseline.set(text);
      this.editor?.checkpoint();
      this.flash(`Saved ${path}`);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  /** Takes the version on disk (one undoable step, so Ctrl+Z brings the edits back). */
  reloadFromDisk(contents: string): void {
    this.externalChange.set(null);
    const version = this.editor?.applyEdit(contents) ?? null;
    if (version === null) this.setDbml(contents);
    this.baseline.set(contents);
    this.flash("Reloaded from disk");
  }

  // ------------------------------------------------------------------ editing

  /** Called by the editor on every keystroke. */
  setDbml(text: string): void {
    if (text === this.dbml()) return;
    this.dbml.set(text);
    if (this.parseTimer) clearTimeout(this.parseTimer);
    this.parseTimer = setTimeout(() => {
      void this.parseNow().then(() => this.ensureLayout());
    }, PARSE_DEBOUNCE_MS);
  }

  private async parseNow(): Promise<void> {
    if (this.parseTimer) clearTimeout(this.parseTimer);
    this.parseTimer = null;
    const seq = ++this.parseSeq;
    const text = this.dbml();
    if (!text.trim()) {
      this.view.set(EMPTY_VIEW);
      this.parsedText = "";
      this.diagnostics.set([]);
      return;
    }
    const result = await timedAsync("parse", () => this.parser.parse(text));
    if (!result || seq !== this.parseSeq) return; // a newer edit superseded this parse
    if (result.ok) {
      this.view.set(result.view);
      this.parsedText = text;
      this.diagnostics.set([]);
    } else {
      this.diagnostics.set(result.diagnostics);
    }
  }

  /** Parses now if the text changed since the last parse, so `view` matches `dbml` (unless it has errors). */
  async settle(): Promise<void> {
    if (this.parseTimer || this.parsedText !== this.dbml()) await this.parseNow();
  }

  /** The diagram model of a DBML text that is not the open document (null when it does not parse). */
  async parseView(text: string): Promise<ViewModel | null> {
    const [view] = await this.parser.views([text]);
    return view;
  }

  /**
   * The full `@dbml/core` model behind the diagram (documentation, sample data), parsed here on
   * first use; null when nothing has parsed yet.
   */
  async parsedDatabase(): Promise<Database | null> {
    const text = this.parsedText;
    if (!text) return null;
    if (this.databaseCache?.text !== text) {
      const { Parser } = await loadDbmlCore();
      this.databaseCache = { text, db: Parser.parse(text, "dbmlv2") };
    }
    return this.databaseCache.db;
  }

  /**
   * Replaces the DBML from code (canvas edits, X-ray "Add Ref"). Goes through the editor as a
   * single undoable edit when the editor is up, so Ctrl+Z reverts it; otherwise sets it directly.
   */
  applyDbmlEdit(newText: string, label = "Edit"): void {
    if (newText === this.dbml()) return;
    const version = this.editor?.applyEdit(newText) ?? null;
    if (version === null) {
      this.setDbml(newText);
      return;
    }
    this.history.record({ kind: "text", label, version });
  }

  /** Appends text (e.g. a `Ref:` line) to the DBML through the undoable edit path. */
  appendDbml(text: string, label = "Add"): void {
    const current = this.dbml().trimEnd();
    this.applyDbmlEdit((current ? `${current}\n\n` : "") + text + "\n", label);
  }

  // ------------------------------------------------------------------ canvas undo / redo

  private layoutState(): LayoutState {
    const state: LayoutState = { positions: { ...this.positions() }, hidden: [...this.hidden()] };
    if (this.arrangement() !== "mine") state.arrangement = this.arrangement();
    return state;
  }

  /** Runs a layout change and records it for canvas undo. */
  private recordLayout(label: string, change: () => void): void {
    const before = this.layoutState();
    change();
    this.history.record({ kind: "layout", label, before, after: this.layoutState() });
  }

  private readonly historyTarget = {
    applyLayout: (s: LayoutState) => {
      const where = s.arrangement ?? "mine";
      if (where !== this.arrangement()) {
        // A step taken in the other arrangement: show it, unless only the visibility changes.
        if (where === "modules" && !this.modulesDoc()) return;
        if (!samePositions(s.positions, this.parked?.positions ?? {})) this.setArrangement(where);
      }
      if (where === this.arrangement()) this.positions.set({ ...s.positions });
      this.hidden.set(new Set(s.hidden));
      this.activeView.set(null);
      this.persist();
    },
    textVersion: () => this.editor?.versionId() ?? null,
    undoText: () => this.editor?.undo() ?? null,
    redoText: () => this.editor?.redo() ?? null,
  };

  /** Ctrl+Z outside the editor: the last canvas action, else the editor's last change. */
  undoCanvas(): void {
    if (!this.history.canUndo) {
      this.editor?.undo();
      return;
    }
    const r = this.history.undo(this.historyTarget);
    if (r.message) this.flash(r.message);
  }

  redoCanvas(): void {
    if (!this.history.canRedo) {
      this.editor?.redo();
      return;
    }
    const r = this.history.redo(this.historyTarget);
    if (r.message) this.flash(r.message);
  }

  /**
   * Keeps saved position and visibility when a table is renamed. The old entries are kept too,
   * so undoing the rename puts the table back where it was.
   */
  renameTableId(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const pos = this.positions()[oldId];
    if (pos) this.positions.set({ ...this.positions(), [newId]: pos });
    const parked = this.parked?.positions[oldId];
    if (this.parked && parked) this.parked = { ...this.parked, positions: { ...this.parked.positions, [newId]: parked } };
    const doc = this.modulesDoc();
    if (doc) this.modulesDoc.set(renameInDoc(doc, oldId, newId));
    if (this.hidden().has(oldId)) this.hidden.set(new Set([...this.hidden(), newId]));
    this.persist();
  }

  /**
   * Moves the editor cursor to `line`. `show` opens the editor if it is hidden; `focus` moves the
   * keyboard focus into it (only for explicit "go to the text" actions, so canvas shortcuts keep
   * working after a click on a table).
   */
  reveal(line: number | null, opts: { show?: boolean; focus?: boolean } = {}): void {
    if (!line) return;
    if (opts.show) this.setEditorOpen(true);
    this.revealRequest.set({ line, focus: !!opts.focus, nonce: Date.now() });
  }

  setEditorOpen(open: boolean): void {
    this.editorOpen.set(open);
    try {
      localStorage.setItem(EDITOR_OPEN_KEY, open ? "1" : "0");
    } catch {
      /* preferences are best-effort */
    }
  }

  /** Connection details of the database behind the current document, for follow-up queries. */
  async currentConnection(): Promise<{ input: ConnectionInput; schemas: string[] } | null> {
    const src = this.source();
    if (src?.kind !== "db") return null;
    await this.profiles.load();
    const profile = this.profiles.profiles().find((p) => p.id === src.profileId);
    if (!profile) return null;
    return {
      input: toConnectionInput(profile, this.sessionPasswords.get(profile.id), this.sessionSshSecrets.get(profile.id)),
      schemas: profile.schemas,
    };
  }

  // ------------------------------------------------------------------ layout & visibility

  /** Places tables that have no position yet (new document, or tables added in the editor). */
  private async ensureLayout(): Promise<void> {
    const view = this.view();
    if (view.tables.every((t) => this.positions()[t.id])) return;
    const seq = ++this.layoutSeq;
    this.layingOut.set(true);
    try {
      const laidOut = await timedAsync("layout", () => layoutTables(view, this.positions()));
      if (seq !== this.layoutSeq) return;
      // Merge: keep anything the user moved while the layout was running.
      this.positions.set({ ...laidOut, ...this.positions() });
      this.persist();
    } finally {
      if (seq === this.layoutSeq) this.layingOut.set(false);
    }
  }

  /**
   * Discards manual positions and lays out every table again. While the Modules arrangement is
   * shown, lays out the modules again instead (the user's own layout is not touched).
   */
  async autoArrange(): Promise<void> {
    const view = this.view();
    if (view.tables.length === 0) return;
    const modules = this.arrangement() === "modules" ? this.moduleArranger : null;
    await this.run("Arranging…", async () => {
      const seq = ++this.layoutSeq;
      const laidOut = modules ? await modules() : await layoutTables(view, {});
      if (seq !== this.layoutSeq || !laidOut) return;
      this.replacePositions(laidOut, modules ? "Arrange modules" : "Auto-arrange");
    });
  }

  /** New positions for every table of the shown arrangement (one undo step), fitted to screen. */
  private replacePositions(positions: Record<string, Point>, label: string): void {
    this.recordLayout(label, () => this.positions.set(positions));
    this.viewport = null;
    this.initialViewport.set(null);
    this.persist();
    this.documentVersion.update((v) => v + 1);
  }

  // ------------------------------------------------------------------ arrangements

  /** Shows the user's own layout or the Modules arrangement. Each keeps its viewport. */
  setArrangement(to: Arrangement): void {
    if (to === this.arrangement() || !this.parked) return;
    if (to === "modules" && !this.modulesDoc()) return;
    const leaving: Placement = { positions: this.positions(), viewport: this.diagram?.currentViewport() ?? this.viewport };
    const coming = this.parked;
    this.parked = leaving;
    this.arrangement.set(to);
    // A layout still running belongs to the arrangement being left.
    this.layoutSeq++;
    this.layingOut.set(false);
    this.positions.set({ ...coming.positions });
    this.viewport = coming.viewport;
    this.initialViewport.set(coming.viewport);
    this.persist();
    this.documentVersion.update((v) => v + 1);
    // Tables added while the other arrangement was shown get a place here.
    void this.ensureLayout();
  }

  /**
   * Replaces what Find modules keeps for this document. With `positions`, they become the
   * Modules arrangement, shown unless `show` is false; earlier undo steps taken in it are
   * dropped. `null` discards the Modules arrangement and goes back to the user's layout.
   */
  setModules(doc: ModulesDoc | null, positions?: Record<string, Point>, show = true): void {
    if (!doc) {
      if (this.arrangement() === "modules") this.setArrangement("mine");
      this.parked = null;
      this.modulesDoc.set(null);
      this.history.forgetLayouts("modules");
      this.persist();
      return;
    }
    this.modulesDoc.set(doc);
    if (positions) {
      this.history.forgetLayouts("modules");
      if (this.arrangement() === "modules") {
        this.layoutSeq++;
        this.layingOut.set(false);
        this.positions.set(positions);
        this.viewport = null;
        this.initialViewport.set(null);
        this.documentVersion.update((v) => v + 1);
      } else {
        this.parked = { positions, viewport: null };
        if (show) this.setArrangement("modules");
      }
    }
    this.persist();
  }

  /** Positions of the Modules arrangement, shown or not (null when there is none). */
  modulesPositions(): Record<string, Point> | null {
    if (!this.modulesDoc()) return null;
    return this.arrangement() === "modules" ? this.positions() : (this.parked?.positions ?? null);
  }

  moveTables(moves: Record<string, Point>): void {
    this.recordLayout("Move", () => this.positions.update((p) => ({ ...p, ...moves })));
    this.persist();
  }

  // ------------------------------------------------------------------ saved views (DBML DiagramView)

  /** Shows only the tables of a `DiagramView` block (`null` = every table). */
  applyView(name: string | null): void {
    const view = this.view();
    const v = name === null ? null : view.views.find((x) => x.name === name);
    if (name !== null && !v) return;
    const visible = v?.tables ? new Set(v.tables) : null;
    this.recordLayout("Show view", () =>
      this.hidden.set(new Set(visible ? view.tables.filter((t) => !visible.has(t.id)).map((t) => t.id) : [])),
    );
    this.activeView.set(name);
    this.persist();
  }

  /** Writes the currently visible tables into a `DiagramView` block (one undoable edit). */
  async saveView(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || /["{}\r\n]/.test(trimmed)) return this.flash("Enter a view name without quotes or braces");
    if (this.diagnostics().length) return this.flash("Fix the errors in the DBML first");
    const exists = this.view().views.some((v) => v.name === trimmed);
    const tables = this.view()
      .tables.filter((t) => !this.hidden().has(t.id))
      .map((t) => ({ name: t.name, schemaName: t.schema }));
    const { syncDiagramView } = await loadDbmlCore();
    const { newDbml } = syncDiagramView(this.dbml(), [
      { operation: exists ? "update" : "create", name: trimmed, visibleEntities: { tables } },
    ] as never);
    this.applyDbmlEdit(newDbml, "Save view");
    this.activeView.set(trimmed);
    this.flash(`${exists ? "Updated" : "Saved"} view “${trimmed}” (${tables.length} tables)`);
  }

  async deleteView(name: string): Promise<void> {
    if (this.diagnostics().length) return this.flash("Fix the errors in the DBML first");
    const { syncDiagramView } = await loadDbmlCore();
    const { newDbml } = syncDiagramView(this.dbml(), [{ operation: "delete", name }] as never);
    this.applyDbmlEdit(newDbml, "Delete view");
    if (this.activeView() === name) this.applyView(null);
    this.flash(`Deleted view “${name}”`);
  }

  setDetail(detail: DetailLevel): void {
    this.detail.set(detail);
    this.persist();
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.persist();
  }

  toggleHidden(id: string): void {
    this.recordLayout(this.hidden().has(id) ? "Show table" : "Hide table", () =>
      this.hidden.update((h) => {
        const next = new Set(h);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    );
    this.persist();
  }

  setHidden(ids: string[], hidden: boolean): void {
    this.recordLayout(hidden ? "Hide tables" : "Show tables", () =>
      this.hidden.update((h) => {
        const next = new Set(h);
        for (const id of ids) {
          if (hidden) next.add(id);
          else next.delete(id);
        }
        return next;
      }),
    );
    this.persist();
  }

  /** Hides every table except those in `keep` (one undo step). */
  showOnly(keep: ReadonlySet<string>, label: string): void {
    const tables = this.view().tables;
    this.recordLayout(label, () => this.hidden.set(new Set(tables.filter((t) => !keep.has(t.id)).map((t) => t.id))));
    // The visible set no longer matches a saved DiagramView.
    this.activeView.set(null);
    this.persist();
  }

  private persist(): void {
    if (!this.layoutKey) return;
    const state = {
      arrangement: this.arrangement(),
      shown: { positions: this.positions(), viewport: this.viewport },
      parked: this.parked,
      modules: this.modulesDoc(),
    };
    this.layouts.save(this.layoutKey, toSaved(state, [...this.hidden()], this.detail()));
  }

  // ------------------------------------------------------------------ export

  exportBaseName(): string {
    const src = this.source();
    const base = src?.kind === "file" ? src.label.replace(/\.[^.]+$/, "") : (src?.label ?? "diagram");
    return base.replace(/[\\/:*?"<>|]+/g, "_") || "diagram";
  }

  async exportPng(): Promise<void> {
    const url = this.diagram?.exportPng();
    if (!url) return this.flash("Nothing to export yet");
    await this.saveExport(`${this.exportBaseName()}.png`, "PNG image", ["png"], url.slice(url.indexOf(",") + 1), true);
  }

  async exportSvg(): Promise<void> {
    const svg = this.diagram?.exportSvg();
    if (!svg) return this.flash("Nothing to export yet");
    await this.saveExport(`${this.exportBaseName()}.svg`, "SVG image", ["svg"], svg, false);
  }

  async exportDbml(): Promise<void> {
    if (!this.dbml().trim()) return this.flash("Nothing to export yet");
    await this.saveExport(`${this.exportBaseName()}.dbml`, "DBML", ["dbml"], this.dbml(), false);
  }

  private async saveExport(name: string, filter: string, ext: string[], contents: string, base64: boolean) {
    try {
      const path = await this.api.saveFile({ defaultName: name, filterName: filter, extensions: ext, contents, base64 });
      if (path) this.flash(`Saved ${path}`);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  // ------------------------------------------------------------------ status

  /**
   * Runs a task with a busy label; errors are shown in the error banner. The task gets an
   * operation id to pass to cancellable commands (`cancelBusy` stops them). Resolves to success.
   */
  /** Runs a task behind the busy spinner (cancellable with `op`); errors go to the banner. */
  async run(label: string, task: (op: string) => Promise<void>): Promise<boolean> {
    const op = crypto.randomUUID();
    this.busy.set(label);
    this.busyOp.set(op);
    this.error.set(null);
    try {
      await task(op);
      return true;
    } catch (err) {
      if (isCancelled(err)) this.flash("Cancelled");
      else this.error.set(errorMessage(err));
      return false;
    } finally {
      this.busy.set(null);
      this.busyOp.set(null);
    }
  }

  /** Stops the running task (introspection) as soon as possible. */
  cancelBusy(): void {
    const op = this.busyOp();
    if (op) void this.api.cancelOp(op);
  }

  flash(message: string): void {
    this.notice.set(message);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), 3500);
  }
}

function samePositions(a: Record<string, Point>, b: Record<string, Point>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => b[k] && a[k].x === b[k].x && a[k].y === b[k].y);
}

/** The error a cancelled command returns (`AppError::Cancelled`). */
export function isCancelled(err: unknown): boolean {
  return errorMessage(err) === "Cancelled";
}

/** FNV-1a, for layout keys of pasted scripts. */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const EDITOR_OPEN_KEY = "xdiagram.editor";

function readEditorPref(): boolean {
  try {
    return localStorage.getItem(EDITOR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}


