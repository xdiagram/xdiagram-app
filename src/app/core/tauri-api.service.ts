import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";

import type { WireNode } from "../filter/model";

/**
 * Shape of `@dbml/connector`'s `DatabaseSchema`, as returned by the Rust `introspect` command.
 * Only passed through to `importer.generateDbml`, so it is kept opaque here on purpose.
 * (Never import from `@dbml/connector` in app code — it is a Node-only dev dependency.)
 */
export type DatabaseSchemaJson = Record<string, unknown> & { tables: unknown[] };

export type SslMode = "disable" | "prefer" | "require" | "verify-full";
export type Engine = "postgres" | "mysql" | "mssql" | "sqlite";

export interface ConnectionInput {
  /** Defaults to postgres. */
  engine?: Engine;
  /** SQLite database file. */
  path?: string;
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** When set and `password` is empty, Rust reads the password from the OS keychain. */
  profileId?: string;
  sslMode?: SslMode;
  /** Connect through this SSH server. */
  ssh?: SshInput;
}

export interface SshInput {
  host: string;
  port?: number;
  user: string;
  auth: "password" | "key";
  keyPath?: string;
  /** Password or key passphrase; when empty, Rust reads `ssh:<profileId>` from the keychain. */
  secret?: string;
  /** A host key fingerprint the user accepted (set by `TauriApi` after asking). */
  trust?: string;
}

/** Rust's `AppError::UnknownHostKey` message. */
const UNKNOWN_HOST_KEY = /^Unknown SSH host key for (.+): (SHA256:\S+)$/;

export interface OpenedFile {
  path: string;
  contents: string;
}

export interface SaveFileRequest {
  defaultName: string;
  filterName: string;
  extensions: string[];
  contents: string;
  /** `contents` is base64 (binary files such as PNG). */
  base64: boolean;
}

// ---- X-ray mode (src-tauri/src/db/workload_db.rs, src-tauri/src/live.rs) ----

export interface WorkloadEndpoint {
  schema: string;
  table: string;
  columns: string[];
}

export interface QueryEvidence {
  queryId: number | null;
  calls: number;
  meanMs: number | null;
  text: string;
}

/** A join seen in the query workload between columns that no foreign key connects. */
export interface DiscoveredRelation {
  from: WorkloadEndpoint;
  to: WorkloadEndpoint;
  directed: boolean;
  calls: number;
  statements: number;
  queries: QueryEvidence[];
}

export interface FkUsage {
  name: string;
  from: WorkloadEndpoint;
  to: WorkloadEndpoint;
  calls: number;
}

export interface TableFacts {
  schema: string;
  table: string;
  rows: number;
  deadRatio: number;
  seqScan: number;
  idxScan: number;
  inserts: number;
  updates: number;
  deletes: number;
  lastAutovacuum: string | null;
  lastAutoanalyze: string | null;
  neverUsed: boolean;
  seqScanHeavy: boolean;
}

export interface FkCardinality {
  schema: string;
  table: string;
  column: string;
  parentSchema: string;
  parentTable: string;
  parentColumn: string;
  childrenPerParent: number;
  parentCoverage: number;
  childNullFrac: number;
  verdict: "1:1" | "1:N";
}

export interface IndexAdvice {
  kind: "fk_unindexed" | "filter_seq_scan" | "unused" | "duplicate";
  schema: string;
  table: string;
  columns: string[];
  indexName: string | null;
  reason: string;
  impact: number;
  sql: string;
}

export interface RelationCheck {
  childRowsEstimate: number;
  checkedRows: number;
  sampled: boolean;
  timedOut: boolean;
  nullRows: number;
  orphanRows: number;
  orphanSamples: string[];
  parentUnique: boolean;
  childIndexed: boolean;
  constraintName: string;
  sql: string;
}

export interface WorkloadReport {
  available: boolean;
  reason: string | null;
  extensionVersion: string | null;
  statements: { total: number; parsed: number; unparsed: number; redacted: number };
  relations: DiscoveredRelation[];
  declaredUsage: FkUsage[];
  tables: TableFacts[];
  cardinality: FkCardinality[];
  indexAdvice: IndexAdvice[];
  statsReset: string | null;
}

export interface TableRate {
  id: string;
  rows: number;
  deadRatio: number;
  readsPerSec: number;
  writesPerSec: number;
  seqScansPerSec: number;
  idxScansPerSec: number;
  wroteSinceLast: boolean;
  totalReads: number;
  totalWrites: number;
}

export interface LiveSample {
  intervalMs: number;
  at: number;
  tables: TableRate[];
}

// ---- Data browser (src-tauri/src/db/browse.rs) ----

export interface BrowseFilter {
  column: string;
  /** null means IS NULL. */
  value: string | null;
}

export interface BrowseRequest {
  schema: string;
  table: string;
  /** Equality filters (FK navigation); AND-ed with `filter`. */
  filters: BrowseFilter[];
  /** The filter tree (see `src/app/filter/model.ts` and Rust `filter.rs`). */
  filter?: WireNode | null;
  orderBy?: { column: string; desc: boolean } | null;
  /** Sort keys, first to last; the primary key is added as tie-breaker. */
  sort?: { column: string; desc: boolean }[];
  limit: number;
  offset: number;
  /** Statement time limit in seconds. */
  timeoutSecs?: number;
  /** The columns to return, in this order (default: all). */
  columns?: string[];
}

/** Rows for an export (see Rust `browse::ExportResult`). */
export interface ExportResult {
  columns: BrowseColumn[];
  /** Whole values (not shortened); null is NULL. */
  rows: (string | null)[][];
  /** More rows match than were read. */
  truncated: boolean;
  elapsedMs: number;
}

/** A table's columns and key, without rows (see Rust `catalog::TableInfo`). */
export interface TableInfo {
  columns: BrowseColumn[];
  primaryKey: string[];
  rowEstimate: number;
  isView: boolean;
}

export interface CountResult {
  count: number;
  /** More rows match than the cap; `count` is the cap. */
  capped: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

export interface ValuesRequest {
  schema: string;
  table: string;
  column: string;
  filter: WireNode | null;
  /** Only values holding this text. */
  search?: string;
  limit?: number;
  timeoutSecs?: number;
}

export interface ValueCount {
  /** As the grid shows it; null is NULL. */
  value: string | null;
  count: number;
  /** Shortened: too long to filter by. */
  cut?: boolean;
}

/** See `values.rs`. */
export interface ValuesResult {
  values: ValueCount[];
  /** More distinct values exist than listed. */
  more: boolean;
  /** Rows looked at. */
  rows: number;
  /** Only the first matching rows were looked at. */
  sampled: boolean;
  min: string | null;
  max: string | null;
  timedOut: boolean;
  elapsedMs: number;
}

/** Statistics of one column over a table sample (see `profile.rs`). */
export interface ColumnProfile {
  name: string;
  typeName: string;
  nulls: number;
  nonNull: number;
  distinct: number;
  distinctCapped: boolean;
  unique: boolean;
  numeric: boolean;
  min: string | null;
  max: string | null;
  avgLength: number | null;
  maxLength: number | null;
  top: { value: string; count: number }[];
  /** Kind of personal data the column seems to hold. */
  pii: string | null;
  piiBasis: "values" | "name" | null;
}

export interface TableProfile {
  schema: string;
  table: string;
  rowEstimate: number;
  sampleSize: number;
  sampled: boolean;
  method: string;
  columns: ColumnProfile[];
  elapsedMs: number;
}

export interface BrowseResult {
  columns: BrowseColumn[];
  /** Values as text; null is SQL NULL. */
  rows: (string | null)[][];
  hasMore: boolean;
  rowEstimate: number;
  orderedBy: string[];
  /** The sort as applied: `tie` marks primary-key columns added for stable paging. */
  sort?: { column: string; desc: boolean; tie: boolean }[];
  /** False when the table has no primary key or row id: pages may repeat rows. */
  stableOrder?: boolean;
  truncatedCells: number;
  /** `[row, column]` of every value shortened to 4000 characters. */
  truncatedAt?: [number, number][];
  elapsedMs: number;
}

// ---- Related data (src-tauri/src/db/related.rs) ----

/** What a column holds (Rust `ColKind`): decides the filter operators offered for it. */
export type ColKind =
  | "int"
  | "decimal"
  | "float"
  | "bool"
  | "text"
  | "enum"
  | "uuid"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  | "json"
  | "binary"
  | "other";

export interface BrowseColumn {
  name: string;
  typeName: string;
  kind?: ColKind;
  nullable?: boolean;
  enumValues?: string[];
}

/** Rows of one table whose key columns equal the given values (none may be NULL). */
export interface RelatedLookup {
  schema: string;
  table: string;
  filters: { column: string; value: string }[];
  limit: number;
}

export interface LookupResult {
  columns: BrowseColumn[];
  rows: (string | null)[][];
  hasMore: boolean;
  truncatedCells: number;
  /** Why this lookup failed; the other lookups of the request are unaffected. */
  error: string | null;
}

export interface RelatedResult {
  /** One per lookup, in request order. */
  results: LookupResult[];
  elapsedMs: number;
}

/** Typed wrappers around the Rust commands in `src-tauri/src/commands.rs`. */
@Injectable({ providedIn: "root" })
export class TauriApi {
  /** Open "trust this SSH server?" questions, so parallel commands ask only once. */
  private readonly trustQuestions = new Map<string, Promise<boolean>>();

  /**
   * A database command. The first time a connection goes through an SSH server whose host key
   * is not known, the user is shown its fingerprint; if they trust it, the command is retried
   * with the key accepted (Rust then remembers it).
   */
  private async db<T>(cmd: string, args: { input: ConnectionInput } & Record<string, unknown>): Promise<T> {
    try {
      return await invoke<T>(cmd, args);
    } catch (err) {
      const unknown = UNKNOWN_HOST_KEY.exec(errorMessage(err));
      if (!unknown || !args.input.ssh) throw err;
      const [, host, fingerprint] = unknown;
      const key = `${host} ${fingerprint}`;
      let question = this.trustQuestions.get(key);
      if (!question) {
        question = ask(
          `xdiagram has not connected to the SSH server ${host} before. Its host key fingerprint is\n\n${fingerprint}\n\n` +
            "Check that it matches the server's (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the server, " +
            "or ask its administrator). Trust this server and connect?",
          { title: "Unknown SSH server", kind: "warning", okLabel: "Trust and connect", cancelLabel: "Cancel" },
        ).finally(() => setTimeout(() => this.trustQuestions.delete(key), 1000));
        this.trustQuestions.set(key, question);
      }
      if (!(await question)) throw new Error(`The SSH server ${host} was not trusted`);
      return invoke<T>(cmd, { ...args, input: { ...args.input, ssh: { ...args.input.ssh, trust: fingerprint } } });
    }
  }

  analyzeWorkload(input: ConnectionInput, schemas: string[], opId?: string): Promise<WorkloadReport> {
    return this.db("analyze_workload", { input, schemas, opId });
  }

  /** Reads a schema file by path (reopening a session); limited to schema file types. */
  readTextFile(path: string): Promise<string> {
    return invoke("read_text_file", { path });
  }

  /** Saves a .dbml file opened or saved through a dialog. */
  writeTextFile(path: string, contents: string): Promise<void> {
    return invoke("write_text_file", { path, contents });
  }

  /** Whether `writeTextFile` accepts the path (it must have been picked in a dialog). */
  canWrite(path: string): Promise<boolean> {
    return invoke("can_write", { path });
  }

  /** App files found damaged and restored at start-up (reported once). */
  startupNotices(): Promise<string[]> {
    return invoke("startup_notices");
  }

  /** The edited DBML kept for a database (JSON written by `DraftService`), or null. */
  loadDraft(key: string): Promise<string | null> {
    return invoke("load_draft", { key });
  }

  saveDraft(key: string, contents: string): Promise<void> {
    return invoke("save_draft", { key, contents });
  }

  deleteDraft(key: string): Promise<void> {
    return invoke("delete_draft", { key });
  }

  /** The Browse-data filters remembered for a database (JSON written by `FilterMemoryService`). */
  loadFilters(key: string): Promise<string | null> {
    return invoke("load_filters", { key });
  }

  saveFilters(key: string, contents: string): Promise<void> {
    return invoke("save_filters", { key, contents });
  }

  watchFile(path: string): Promise<void> {
    return invoke("watch_file", { path });
  }

  unwatchFile(path: string): Promise<void> {
    return invoke("unwatch_file", { path });
  }

  /** Another program changed a watched file. */
  onFileChanged(callback: (change: { path: string; contents: string }) => void): Promise<UnlistenFn> {
    return listen<{ path: string; contents: string }>("xdiagram://file-changed", (e) => callback(e.payload));
  }

  /** Stops a running operation started with `opId`; false when it already finished. */
  cancelOp(opId: string): Promise<boolean> {
    return invoke("cancel_op", { opId });
  }

  /** The join query as readable SQL with the values written in (reads the tables' columns; nothing else runs). */
  joinSql(input: ConnectionInput, request: unknown, opId?: string): Promise<string> {
    return this.db("join_sql", { input, request, opId });
  }

  /** Runs the join query read-only; columns are named `alias.column`. */
  browseJoin(input: ConnectionInput, request: unknown, opId?: string): Promise<BrowseResult> {
    return this.db("browse_join", { input, request, opId });
  }

  profileTable(
    input: ConnectionInput,
    request: { schema: string; table: string; sampleRows?: number; timeoutSecs?: number },
    opId?: string,
  ): Promise<TableProfile> {
    return this.db("profile_table", { input, request, opId });
  }

  browseTable(input: ConnectionInput, request: BrowseRequest, opId?: string): Promise<BrowseResult> {
    return this.db("browse_table", { input, request, opId });
  }

  /** How many rows match a browse request's filter, counted up to `cap` (time-limited). */
  countRows(input: ConnectionInput, request: { request: BrowseRequest; cap?: number }, opId?: string): Promise<CountResult> {
    return this.db("count_rows", { input, request, opId });
  }

  /** The rows a browse request's filter matches, whole values, up to 50,000 (read-only). */
  exportRows(input: ConnectionInput, request: { request: BrowseRequest; maxRows?: number }, opId?: string): Promise<ExportResult> {
    return this.db("export_rows", { input, request, opId });
  }

  /** The rows a browse request shows, as SQL with the values written in (nothing is run). */
  filterSql(input: ConnectionInput, request: BrowseRequest, opId?: string): Promise<string> {
    return this.db("filter_sql", { input, request, opId });
  }

  /** A table's columns, kinds and primary key (no rows are read). */
  describeTable(input: ConnectionInput, schema: string, table: string, opId?: string): Promise<TableInfo> {
    return this.db("describe_table", { input, schema, table, opId });
  }

  /** A column's values with their counts among the matching rows (sampled, read-only). */
  valueCounts(input: ConnectionInput, request: ValuesRequest, opId?: string): Promise<ValuesResult> {
    return this.db("value_counts", { input, request, opId });
  }

  /** A batch of key lookups on one connection (read-only), for the related-data map. */
  relatedRows(input: ConnectionInput, request: { lookups: RelatedLookup[]; timeoutSecs?: number }, opId?: string): Promise<RelatedResult> {
    return this.db("related_rows", { input, request, opId });
  }

  checkRelation(input: ConnectionInput, request: { child: WorkloadEndpoint; parent: WorkloadEndpoint }): Promise<RelationCheck> {
    return this.db("check_relation", { input, request });
  }

  startLive(input: ConnectionInput, schemas: string[], intervalMs: number): Promise<void> {
    return this.db("start_live", { input, schemas, intervalMs });
  }

  stopLive(): Promise<void> {
    return invoke("stop_live");
  }

  onLive(callback: (sample: LiveSample) => void): Promise<UnlistenFn> {
    return listen<LiveSample>("xdiagram://live", (event) => callback(event.payload));
  }

  onLiveError(callback: (message: string) => void): Promise<UnlistenFn> {
    return listen<string>("xdiagram://live-error", (event) => callback(event.payload));
  }

  testConnection(input: ConnectionInput): Promise<string> {
    return this.db("test_connection", { input });
  }

  listSchemas(input: ConnectionInput): Promise<string[]> {
    return this.db("list_schemas", { input });
  }

  /** Schema JSON of a SQLite DDL script (its CREATE statements run in a private in-memory database). */
  importSqliteDdl(sql: string): Promise<{ schema: DatabaseSchemaJson; skipped: string[] }> {
    return invoke("import_sqlite_ddl", { sql });
  }

  introspect(input: ConnectionInput, schemas: string[], opId?: string): Promise<DatabaseSchemaJson> {
    return this.db("introspect", { input, schemas, opId });
  }

  /** Saves a password bound to the server in `input` (Rust refuses it for any other server). */
  savePassword(profileId: string, password: string, input: ConnectionInput): Promise<void> {
    return invoke("save_password", { profileId, password, input });
  }

  deletePassword(profileId: string): Promise<void> {
    return invoke("delete_password", { profileId });
  }

  hasPassword(profileId: string): Promise<boolean> {
    return invoke("has_password", { profileId });
  }

  /** Resolves to the saved path, or `null` if the user cancelled the dialog. */
  saveFile(req: SaveFileRequest): Promise<string | null> {
    return invoke("save_file", { ...req });
  }

  /** Native open dialog; resolves to the chosen path or null. */
  pickFile(filterName: string, extensions: string[]): Promise<string | null> {
    return invoke("pick_file", { filterName, extensions });
  }

  openTextFile(filterName: string, extensions: string[]): Promise<OpenedFile | null> {
    return invoke("open_text_file", { filterName, extensions });
  }
}

/** Errors from Rust commands arrive as plain strings. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  // Structured errors from Rust (filter problems) carry a readable message.
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") return (err as { message: string }).message;
  return JSON.stringify(err);
}

/** A filter condition that cannot run, tied to its node id (see Rust `filter.rs`). */
export interface FilterIssue {
  node: string;
  message: string;
}

/** The per-condition problems of a filter error, or [] for any other error. */
export function filterIssues(err: unknown): FilterIssue[] {
  if (err && typeof err === "object" && (err as { kind?: unknown }).kind === "filter") {
    const issues = (err as { issues?: unknown }).issues;
    if (Array.isArray(issues)) return issues as FilterIssue[];
  }
  return [];
}
