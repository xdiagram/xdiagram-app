import { Injectable, computed, inject, signal } from "@angular/core";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { type Update, check } from "@tauri-apps/plugin-updater";

import { SettingsService } from "../persistence/settings.service";
import { errorMessage } from "./tauri-api.service";

/** The update URL in tauri.conf.json still names no real repository. */
const PLACEHOLDER = "YOUR-ACCOUNT";

export interface AvailableUpdate {
  version: string;
  notes: string | null;
}

/**
 * New versions from the release feed (`plugins.updater.endpoints` in tauri.conf.json, a GitHub
 * Releases `latest.json`). Downloads are checked against the app's update signing key before
 * anything is installed. Nothing is checked while the URL is still the placeholder.
 */
@Injectable({ providedIn: "root" })
export class UpdateService {
  private readonly settings = inject(SettingsService);
  private update: Update | null = null;

  readonly version = signal<string | null>(null);
  readonly endpoint = signal<string | null>(null);
  readonly configured = computed(() => {
    const url = this.endpoint();
    return !!url && !url.includes(PLACEHOLDER);
  });
  /** The releases page (the manifest lives at `…/releases/latest/download/latest.json`). */
  readonly releasesUrl = computed(() => (this.configured() ? (/^(https?:\/\/.+\/releases)\//.exec(this.endpoint() ?? "")?.[1] ?? null) : null));
  readonly projectUrl = computed(() => this.releasesUrl()?.replace(/\/releases$/, "") ?? null);

  readonly available = signal<AvailableUpdate | null>(null);
  /** "Later" hides the banner until the next check. */
  readonly dismissed = signal(false);
  readonly checking = signal(false);
  /** Result of the last check made from the About dialog, or of a failed install. */
  readonly status = signal<string | null>(null);
  /** While installing: the downloaded fraction (0–1), or -1 when the size is unknown. */
  readonly progress = signal<number | null>(null);
  /** Why the last install failed (shown in the banner). */
  readonly installError = signal<string | null>(null);

  constructor() {
    void getVersion()
      .then((v) => this.version.set(v))
      .catch(() => undefined);
  }

  /** Reads the feed URL and, when enabled in Settings, checks once shortly after start. */
  async init(): Promise<void> {
    this.endpoint.set(await invoke<string | null>("update_endpoint").catch(() => null));
    await this.settings.loaded;
    if (this.configured() && this.settings.settings().checkUpdates) setTimeout(() => void this.check(false), 4000);
  }

  async check(manual: boolean): Promise<void> {
    if (!this.configured()) {
      if (manual) this.status.set("Update checks are not set up in this build.");
      return;
    }
    this.checking.set(true);
    this.status.set(null);
    try {
      const update = await check({ timeout: 20000 });
      this.update = update;
      this.available.set(update ? { version: update.version, notes: update.body ?? null } : null);
      this.dismissed.set(false);
      if (manual) this.status.set(update ? `xdiagram ${update.version} is available.` : "You have the latest version.");
    } catch (err) {
      if (manual) this.status.set(`Could not check for updates: ${errorMessage(err)}`);
      else console.warn("Update check failed", err);
    } finally {
      this.checking.set(false);
    }
  }

  /** Downloads the new version (its signature is verified), installs it and restarts. */
  async install(): Promise<void> {
    const update = this.update;
    if (!update || this.progress() !== null) return;
    let total = 0;
    let received = 0;
    this.installError.set(null);
    this.progress.set(-1);
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          received += e.data.chunkLength;
          this.progress.set(total ? Math.min(1, received / total) : -1);
        } else if (e.event === "Finished") this.progress.set(1);
      });
      await relaunch();
    } catch (err) {
      this.progress.set(null);
      this.installError.set(errorMessage(err));
      this.status.set(`The update could not be installed: ${errorMessage(err)}`);
    }
  }
}
