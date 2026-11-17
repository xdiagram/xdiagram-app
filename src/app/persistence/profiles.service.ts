import { Injectable, signal } from "@angular/core";
import { LazyStore } from "@tauri-apps/plugin-store";

import { ConnectionInput, Engine, SslMode, TauriApi } from "../core/tauri-api.service";

/** A saved connection. The password is never stored here — it lives in the OS keychain. */
export interface ConnectionProfile {
  id: string;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: SslMode;
  /** Schemas to include; empty means all user schemas. */
  schemas: string[];
  /** SQLite database file. */
  path: string;
  /** Reach the database through this SSH server (null: connect directly). */
  ssh: SshSettings | null;
  /** Whether AI agents may use this connection through xdiagram-mcp, and how much they may read. */
  mcp: McpSettings;
}

/**
 * What xdiagram-mcp may do with a connection. Off unless turned on. `schema`: the schema only;
 * `masked`: rows too, with values that look like personal data masked; `full`: rows as they are.
 */
export interface McpSettings {
  enabled: boolean;
  data: McpDataAccess;
}

export type McpDataAccess = "schema" | "masked" | "full";

export const MCP_DATA_ACCESS: McpDataAccess[] = ["schema", "masked", "full"];

export function newMcp(): McpSettings {
  return { enabled: false, data: "masked" };
}

/** Anything unexpected keeps agents out (xdiagram-mcp reads the file the same way). */
function normalizeMcp(m: unknown): McpSettings {
  const v = (m ?? {}) as Partial<Record<keyof McpSettings, unknown>>;
  return {
    enabled: v.enabled === true,
    data: MCP_DATA_ACCESS.includes(v.data as McpDataAccess) ? (v.data as McpDataAccess) : "masked",
  };
}

export interface SshSettings {
  host: string;
  port: number;
  user: string;
  auth: "password" | "key";
  /** Private key file (OpenSSH, PEM or PuTTY .ppk) for key sign-in. */
  keyPath: string;
}

export function newSsh(): SshSettings {
  return { host: "", port: 22, user: "", auth: "password", keyPath: "" };
}

/** Keychain entry of a profile's SSH password or key passphrase. */
export function sshSecretId(profileId: string): string {
  return `ssh:${profileId}`;
}

export interface EngineInfo {
  value: Engine;
  label: string;
  /** Badge text, e.g. in the toolbar. */
  short: string;
  port: number;
  user: string;
  database: string;
}

export const ENGINES: EngineInfo[] = [
  { value: "postgres", label: "PostgreSQL", short: "PostgreSQL", port: 5432, user: "postgres", database: "postgres" },
  { value: "mysql", label: "MySQL / MariaDB", short: "MySQL", port: 3306, user: "root", database: "" },
  { value: "mssql", label: "SQL Server", short: "SQL Server", port: 1433, user: "sa", database: "master" },
  { value: "sqlite", label: "SQLite", short: "SQLite", port: 0, user: "", database: "" },
];

export function engineInfo(engine: Engine): EngineInfo {
  return ENGINES.find((e) => e.value === engine) ?? ENGINES[0];
}

export function newProfile(engine: Engine = "postgres"): ConnectionProfile {
  const e = engineInfo(engine);
  return {
    id: crypto.randomUUID(),
    name: "",
    engine,
    host: "localhost",
    port: e.port,
    database: e.database,
    user: e.user,
    sslMode: "prefer",
    schemas: [],
    path: "",
    ssh: null,
    mcp: newMcp(),
  };
}

/** Fills fields added after a profile was saved (older profiles are PostgreSQL). */
export function normalizeProfile(p: Partial<ConnectionProfile> & { id: string }): ConnectionProfile {
  return {
    ...newProfile(p.engine ?? "postgres"),
    ...p,
    engine: p.engine ?? "postgres",
    path: p.path ?? "",
    ssh: p.ssh ? { ...newSsh(), ...p.ssh } : null,
    mcp: normalizeMcp(p.mcp),
  };
}

const basename = (path: string) => path.split(/[\\/]/).pop() || path;

export function profileLabel(p: ConnectionProfile): string {
  if (p.name.trim()) return p.name.trim();
  if (p.engine === "sqlite") return basename(p.path) || "SQLite file";
  return `${p.database || "(default)"}@${p.host}`;
}

/** One-line description: `user@host:port/db`, or the file path for SQLite. */
export function profileMeta(p: ConnectionProfile): string {
  if (p.engine === "sqlite") return p.path;
  const via = p.ssh?.host.trim() ? ` via ${p.ssh.host.trim()}` : "";
  return `${p.user}@${p.host}:${p.port}/${p.database}${via}`;
}

/** `sshSecret`: the SSH password or key passphrase typed this session (else the keychain's). */
export function toConnectionInput(p: ConnectionProfile, password?: string, sshSecret?: string): ConnectionInput {
  if (p.engine === "sqlite") return { engine: "sqlite", path: p.path, profileId: p.id };
  return {
    engine: p.engine,
    host: p.host,
    port: p.port,
    database: p.database,
    user: p.user,
    sslMode: p.sslMode,
    profileId: p.id,
    password: password || undefined,
    ssh: p.ssh
      ? {
          host: p.ssh.host.trim(),
          port: p.ssh.port || 22,
          user: p.ssh.user.trim(),
          auth: p.ssh.auth,
          keyPath: p.ssh.auth === "key" ? p.ssh.keyPath.trim() : undefined,
          secret: sshSecret || undefined,
        }
      : undefined,
  };
}

/**
 * The key a database's layout, edited DBML (drafts) and remembered filters are saved under.
 * PostgreSQL keeps its original keys, so old layouts still load. xdiagram-mcp builds the same key
 * (`database_key` in xdiagram-core) to read the drafts.
 */
export function databaseKeyOf(p: ConnectionProfile): string {
  if (p.engine === "sqlite") return `db:sqlite:${p.path}`;
  // Through SSH the database host is often "localhost": the SSH server tells it apart.
  const via = p.ssh?.host ? `@ssh:${p.ssh.host}:${p.ssh.port || 22}` : "";
  if (p.engine === "postgres") return `db:${p.host}:${p.port}/${p.database}${via}`;
  return `db:${p.engine}:${p.host}:${p.port}/${p.database}${via}`;
}

const SCHEMES: { re: RegExp; engine: Engine }[] = [
  { re: /^postgres(ql)?:\/\//i, engine: "postgres" },
  { re: /^(mysql|mariadb):\/\//i, engine: "mysql" },
  { re: /^(sqlserver|mssql):\/\//i, engine: "mssql" },
];

/**
 * Parses `postgres://`, `mysql://` / `mariadb://`, `sqlserver://` / `mssql://` URLs and
 * `sqlite:path` into profile fields. Returns null when the text is not a supported URL.
 */
export function parseConnectionUrl(text: string): (Partial<ConnectionProfile> & { password?: string }) | null {
  const trimmed = text.trim();
  const sqlite = /^sqlite:(\/\/)?(.+)$/i.exec(trimmed);
  if (sqlite) return { engine: "sqlite", path: sqlite[2] };
  const scheme = SCHEMES.find((s) => s.re.test(trimmed));
  if (!scheme) return null;
  const defaults = engineInfo(scheme.engine);
  try {
    // Swap the scheme so the WHATWG parser treats it as a hierarchical URL with host/port.
    const url = new URL(trimmed.replace(/^[a-z]+:/i, "http:"));
    const ssl = (url.searchParams.get("sslmode") ?? url.searchParams.get("ssl-mode"))?.toLowerCase();
    const sslMode: SslMode | undefined =
      ssl === "disable" || ssl === "allow" || ssl === "disabled"
        ? "disable"
        : ssl === "require" || ssl === "required"
          ? "require"
          : ssl === "verify-ca" || ssl === "verify-full" || ssl === "verify_identity"
            ? "verify-full"
            : ssl === "prefer" || ssl === "preferred"
              ? "prefer"
              : undefined;
    return {
      engine: scheme.engine,
      host: decodeURIComponent(url.hostname) || "localhost",
      port: url.port ? Number(url.port) : defaults.port,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || defaults.database,
      user: decodeURIComponent(url.username) || defaults.user,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      ...(sslMode ? { sslMode } : {}),
    };
  } catch {
    return null;
  }
}

/** Connection profiles in `connections.json` (app data dir), passwords in the keychain. */
@Injectable({ providedIn: "root" })
export class ProfilesService {
  private readonly store = new LazyStore("connections.json", { autoSave: false, defaults: {} });
  readonly profiles = signal<ConnectionProfile[]>([]);
  private loaded: Promise<void> | null = null;
  /** The file could not be read: saving would replace every saved connection, so it is refused. */
  private loadFailed = false;

  constructor(private readonly api: TauriApi) {}

  load(): Promise<void> {
    this.loaded ??= this.store
      .get<ConnectionProfile[]>("profiles")
      .then((list) => this.profiles.set((list ?? []).map(normalizeProfile)))
      .catch((err) => {
        console.error("Could not read saved connections", err);
        this.loadFailed = true;
        this.profiles.set([]);
      });
    return this.loaded;
  }

  private assertWritable(): void {
    if (this.loadFailed) {
      throw new Error("Saved connections could not be read, so nothing was changed (the file is kept as it is). Restart xdiagram to try again.");
    }
  }

  async upsert(profile: ConnectionProfile): Promise<void> {
    await this.load();
    this.assertWritable();
    const list = this.profiles();
    const i = list.findIndex((p) => p.id === profile.id);
    const next = i >= 0 ? list.map((p, j) => (j === i ? profile : p)) : [...list, profile];
    this.profiles.set(next);
    await this.store.set("profiles", next);
    await this.store.save();
  }

  async remove(id: string): Promise<void> {
    await this.load();
    this.assertWritable();
    const next = this.profiles().filter((p) => p.id !== id);
    this.profiles.set(next);
    await this.store.set("profiles", next);
    await this.store.save();
    await this.api.deletePassword(id).catch(() => undefined);
    await this.api.deletePassword(sshSecretId(id)).catch(() => undefined);
  }
}
