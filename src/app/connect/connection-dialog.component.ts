import { ChangeDetectorRef, Component, ElementRef, OnInit, inject, output, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ask } from "@tauri-apps/plugin-dialog";

import { Engine, SslMode, TauriApi, errorMessage } from "../core/tauri-api.service";
import { DraggableDialogDirective } from "../core/draggable-dialog.directive";
import {
  ConnectionProfile,
  ENGINES,
  ProfilesService,
  engineInfo,
  newProfile,
  newSsh,
  parseConnectionUrl,
  profileLabel,
  profileMeta,
  sshSecretId,
  toConnectionInput,
} from "../persistence/profiles.service";
import { WorkspaceStore } from "../state/workspace.store";

const URL_PLACEHOLDER: Record<Engine, string> = {
  postgres: "postgres://user:password@host:5432/database",
  mysql: "mysql://user:password@host:3306/database",
  mssql: "sqlserver://user:password@host:1433/database",
  sqlite: "sqlite:C:/path/to/database.db",
};

@Component({
  selector: "app-connection-dialog",
  imports: [FormsModule, DraggableDialogDirective],
  templateUrl: "./connection-dialog.component.html",
  styleUrl: "./connection-dialog.component.css",
  host: { "(document:keydown.escape)": "close()" },
})
export class ConnectionDialogComponent implements OnInit {
  readonly closed = output<void>();

  protected readonly profiles = inject(ProfilesService);
  private readonly api = inject(TauriApi);
  private readonly store = inject(WorkspaceStore);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected draft: ConnectionProfile = newProfile();
  protected password = "";
  /** SSH password or key passphrase. */
  protected sshSecret = "";
  protected rememberPassword = true;
  protected urlText = "";

  protected readonly selectedId = signal<string | null>(null);
  protected readonly hasStoredPassword = signal(false);
  protected readonly hasStoredSshSecret = signal(false);
  protected readonly availableSchemas = signal<string[]>([]);
  protected readonly busy = signal<string | null>(null);
  protected readonly status = signal<{ ok: boolean; text: string } | null>(null);

  protected readonly engines = ENGINES;
  protected readonly label = profileLabel;
  protected readonly meta = profileMeta;
  protected readonly engineShort = (e: Engine) => engineInfo(e).short;
  protected readonly urlPlaceholder = URL_PLACEHOLDER;

  protected sslModes(): { value: SslMode; label: string }[] {
    if (this.draft.engine === "mssql") {
      return [
        { value: "prefer", label: "Encrypt if the server supports it (not verified)" },
        { value: "require", label: "Always encrypt (not verified)" },
        { value: "verify-full", label: "Encrypt + verify the certificate" },
        { value: "disable", label: "No encryption" },
      ];
    }
    return [
      { value: "prefer", label: "Prefer (TLS if available)" },
      { value: "require", label: "Require (encrypted, not verified)" },
      { value: "verify-full", label: "Verify full (encrypted + verified)" },
      { value: "disable", label: "Disable" },
    ];
  }

  async ngOnInit(): Promise<void> {
    await this.profiles.load();
    const request = this.store.signInRequest();
    this.store.signInRequest.set(null);
    const src = this.store.source();
    const wanted = request?.profileId ?? (src?.kind === "db" ? src.profileId : null);
    const current = wanted ? this.profiles.profiles().find((p) => p.id === wanted) : undefined;
    const first = current ?? this.profiles.profiles()[0];
    if (first) await this.select(first);
    if (request && current) {
      this.status.set({ ok: true, text: request.reason });
      this.cdr.markForCheck();
      setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>("input[name=password]")?.focus());
    }
  }

  protected async select(p: ConnectionProfile): Promise<void> {
    this.draft = structuredClone(p);
    this.password = "";
    this.sshSecret = "";
    this.hasStoredSshSecret.set(p.ssh ? await this.api.hasPassword(sshSecretId(p.id)).catch(() => false) : false);
    this.urlText = "";
    this.selectedId.set(p.id);
    this.availableSchemas.set([]);
    this.status.set(null);
    const stored = p.engine === "sqlite" ? false : await this.api.hasPassword(p.id).catch(() => false);
    this.hasStoredPassword.set(stored);
    this.rememberPassword = stored || this.rememberPassword;
  }

  protected startNew(engine: Engine = this.draft.engine): void {
    this.draft = newProfile(engine);
    this.password = "";
    this.sshSecret = "";
    this.hasStoredSshSecret.set(false);
    this.urlText = "";
    this.selectedId.set(null);
    this.hasStoredPassword.set(false);
    this.availableSchemas.set([]);
    this.status.set(null);
  }

  /** Switching engine keeps what the user typed, but moves untouched defaults (port, user, db). */
  protected setEngine(engine: Engine): void {
    const before = engineInfo(this.draft.engine);
    const after = engineInfo(engine);
    const d = this.draft;
    this.draft = {
      ...d,
      engine,
      port: !d.port || d.port === before.port ? after.port : d.port,
      user: !d.user || d.user === before.user ? after.user : d.user,
      database: d.database === before.database ? after.database : d.database,
      schemas: [],
    };
    this.availableSchemas.set([]);
    this.status.set(null);
  }

  protected onUrlChange(text: string): void {
    this.urlText = text;
    const parsed = parseConnectionUrl(text);
    if (!parsed) return;
    const { password, ...fields } = parsed;
    if (fields.engine && fields.engine !== this.draft.engine) this.setEngine(fields.engine);
    this.draft = { ...this.draft, ...fields };
    if (password) this.password = password;
  }

  protected async pickFile(): Promise<void> {
    const path = await this.api.pickFile("SQLite database", ["db", "sqlite", "sqlite3", "db3"]).catch((err) => {
      this.status.set({ ok: false, text: errorMessage(err) });
      return null;
    });
    if (path) {
      this.draft = { ...this.draft, path };
      // Zoneless: nothing else re-renders the form after the native dialog resolves.
      this.cdr.markForCheck();
    }
  }

  protected toggleSsh(on: boolean): void {
    this.draft = { ...this.draft, ssh: on ? (this.draft.ssh ?? newSsh()) : null };
    this.status.set(null);
  }

  protected async pickKey(): Promise<void> {
    const path = await this.api.pickFile("SSH private key", ["*"]).catch((err) => {
      this.status.set({ ok: false, text: errorMessage(err) });
      return null;
    });
    if (path && this.draft.ssh) {
      this.draft = { ...this.draft, ssh: { ...this.draft.ssh, keyPath: path } };
      this.cdr.markForCheck();
    }
  }

  protected toggleSchema(name: string, checked: boolean): void {
    const set = new Set(this.draft.schemas);
    if (checked) set.add(name);
    else set.delete(name);
    this.draft.schemas = [...set].sort();
  }

  protected async test(): Promise<void> {
    await this.task("Testing…", async () => {
      const version = await this.api.testConnection(this.input());
      const name = this.engineShort(this.draft.engine);
      const via = this.draft.ssh && this.draft.engine !== "sqlite" ? ` · via SSH ${this.draft.ssh.host}` : "";
      if (this.draft.engine === "postgres" || this.draft.engine === "mssql") {
        const schemas = await this.api.listSchemas(this.input());
        this.availableSchemas.set(schemas);
        this.status.set({ ok: true, text: `Connected${via} · ${name} ${version.split(" ")[0]} · ${schemas.length} schemas` });
      } else {
        this.status.set({ ok: true, text: `Connected${via} · ${name} ${version.split(" ")[0]}` });
      }
    });
  }

  protected async connect(): Promise<void> {
    if (this.draft.engine === "sqlite" && !this.draft.path.trim()) {
      this.status.set({ ok: false, text: "Choose a SQLite database file" });
      return;
    }
    const profile: ConnectionProfile = { ...this.draft, name: this.draft.name.trim() || profileLabel(this.draft) };
    await this.task("Connecting…", async () => {
      await this.profiles.upsert(profile);
      this.selectedId.set(profile.id);
      if (!this.rememberPassword) {
        await this.api.deletePassword(profile.id).catch(() => undefined);
        await this.api.deletePassword(sshSecretId(profile.id)).catch(() => undefined);
      }
      const ok = await this.store.connect(profile, this.password, this.rememberPassword, this.sshSecret);
      if (ok) this.closed.emit();
      else this.status.set({ ok: false, text: this.store.error() ?? "Failed to load the schema" });
    });
  }

  protected async remove(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    const ok = await ask(`Delete the connection "${profileLabel(this.draft)}" and its saved password?`, {
      title: "Delete connection",
      kind: "warning",
    });
    if (!ok) return;
    await this.profiles.remove(id);
    this.startNew();
  }

  protected close(): void {
    if (!this.busy()) this.closed.emit();
  }

  private input() {
    return toConnectionInput(this.draft, this.password, this.sshSecret);
  }

  private async task(label: string, fn: () => Promise<void>): Promise<void> {
    this.busy.set(label);
    this.status.set(null);
    try {
      await fn();
    } catch (err) {
      this.status.set({ ok: false, text: errorMessage(err) });
    } finally {
      this.busy.set(null);
    }
  }
}
