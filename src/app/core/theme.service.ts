import { Injectable, computed, effect, inject, signal } from "@angular/core";

import { setDarkPalette } from "../diagram/theme";
import { SettingsService } from "../persistence/settings.service";

/**
 * The theme in effect: the one chosen in Settings, or the system's. Sets `data-theme` on <html>
 * (CSS tokens) and tells the diagram palette; the editor and diagram follow `dark()`.
 */
@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly settings = inject(SettingsService);
  private readonly media = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : null;
  private readonly systemDark = signal(this.media?.matches ?? false);

  readonly dark = computed(() => {
    const choice = this.settings.settings().theme;
    return choice === "system" ? this.systemDark() : choice === "dark";
  });

  constructor() {
    this.media?.addEventListener("change", (e) => this.systemDark.set(e.matches));
    effect(() => {
      const choice = this.settings.settings().theme;
      const root = document.documentElement;
      if (choice === "system") delete root.dataset["theme"];
      else root.dataset["theme"] = choice;
      setDarkPalette(this.dark());
    });
  }
}
