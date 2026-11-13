import { Injectable, signal } from "@angular/core";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  theme: ThemeChoice;
  editorFontSize: number;
  /** Reopen the tabs of the last session on start. */
  restoreSession: boolean;
  /** Statement time limit for browsing, profiling and the query builder. */
  queryTimeoutSecs: number;
  profileSampleRows: number;
  /** Reload an open .dbml file when it changes on disk (if it has no unsaved edits). */
  autoReloadFiles: boolean;
  checkUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  editorFontSize: 13,
  restoreSession: true,
  queryTimeoutSecs: 15,
  profileSampleRows: 20000,
  autoReloadFiles: true,
  checkUpdates: true,
};

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Fills missing fields and clamps numbers (older or hand-edited settings files). */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    theme: r.theme === "light" || r.theme === "dark" || r.theme === "system" ? r.theme : d.theme,
    editorFontSize: clamp(r.editorFontSize, 10, 24, d.editorFontSize),
    restoreSession: bool(r.restoreSession, d.restoreSession),
    queryTimeoutSecs: clamp(r.queryTimeoutSecs, 1, 600, d.queryTimeoutSecs),
    profileSampleRows: clamp(r.profileSampleRows, 100, 100000, d.profileSampleRows),
    autoReloadFiles: bool(r.autoReloadFiles, d.autoReloadFiles),
    checkUpdates: bool(r.checkUpdates, d.checkUpdates),
  };
}

/** The theme is also mirrored in localStorage so index.html can apply it before Angular starts. */
export const THEME_MIRROR_KEY = "xdiagram.theme";

/** App preferences, stored in `settings.json` (app data dir). */
@Injectable({ providedIn: "root" })
export class SettingsService {
  private readonly store = new LazyStore("settings.json", { autoSave: false, defaults: {} });
  readonly settings = signal<Settings>(normalizeSettings(readMirror()));
  readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.store
      .get<Settings>("settings")
      .then((s) => this.settings.set(normalizeSettings(s ?? readMirror())))
      .catch(() => undefined);
  }

  async update(patch: Partial<Settings>): Promise<void> {
    const next = normalizeSettings({ ...this.settings(), ...patch });
    this.settings.set(next);
    try {
      localStorage.setItem(THEME_MIRROR_KEY, next.theme);
    } catch {
      /* best-effort */
    }
    await this.store.set("settings", next);
    await this.store.save();
  }
}

function readMirror(): Partial<Settings> {
  try {
    const theme = localStorage.getItem(THEME_MIRROR_KEY);
    return theme ? { theme: theme as ThemeChoice } : {};
  } catch {
    return {};
  }
}
