import { Component, OnInit, computed, inject, output, signal } from "@angular/core";

import { TauriApi } from "../core/tauri-api.service";
import { UpdateService } from "../core/update.service";
import { DraggableDialogDirective } from "../core/draggable-dialog.directive";
import { ProfilesService } from "../persistence/profiles.service";
import { type Settings, SettingsService, type ThemeChoice } from "../persistence/settings.service";
import { claudeCodeCommand, mcpJsonConfig } from "./mcp-setup";

/** Preferences; every change applies (and is saved) at once. */
@Component({
  selector: "app-settings-dialog",
  imports: [DraggableDialogDirective],
  host: { "(document:keydown.escape)": "closed.emit()" },
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <section class="dialog" appDraggableDialog role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings</h2>

      <fieldset>
        <legend>Appearance</legend>
        <div class="row">
          <span class="label" id="theme-label">Theme</span>
          <div class="seg" role="radiogroup" aria-labelledby="theme-label">
            @for (t of themes; track t.value) {
              <button type="button" role="radio" [attr.aria-checked]="s().theme === t.value" [class.on]="s().theme === t.value"
                (click)="set({ theme: t.value })">{{ t.label }}</button>
            }
          </div>
        </div>
        <label class="row">
          <span class="label">Editor font size</span>
          <input type="number" min="10" max="24" [value]="s().editorFontSize" (change)="setNumber('editorFontSize', $event)" />
        </label>
      </fieldset>

      <fieldset>
        <legend>Data</legend>
        <label class="row">
          <span class="label">Query time limit <em>seconds, for browsing, profiles and the query builder</em></span>
          <input type="number" min="1" max="600" [value]="s().queryTimeoutSecs" (change)="setNumber('queryTimeoutSecs', $event)" />
        </label>
        <label class="row">
          <span class="label">Profile sample <em>rows read to profile a table</em></span>
          <input type="number" min="100" max="100000" step="1000" [value]="s().profileSampleRows" (change)="setNumber('profileSampleRows', $event)" />
        </label>
      </fieldset>

      <fieldset>
        <legend>Files &amp; session</legend>
        <label class="check">
          <input type="checkbox" [checked]="s().restoreSession" (change)="setBool('restoreSession', $event)" />
          <span>Reopen the last session's tabs on start</span>
        </label>
        <label class="check">
          <input type="checkbox" [checked]="s().autoReloadFiles" (change)="setBool('autoReloadFiles', $event)" />
          <span>Reload .dbml files changed by other programs (when they have no unsaved edits)</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Updates</legend>
        <label class="check">
          <input type="checkbox" [checked]="s().checkUpdates" (change)="setBool('checkUpdates', $event)" />
          <span>Check for new versions on start
            @if (!updates.configured()) {
              <em>(not set up in this build)</em>
            }
          </span>
        </label>
      </fieldset>

      <fieldset>
        <legend>AI agents</legend>
        <p class="note">
          xdiagram-mcp lets AI agents such as Claude Code read the connections you open to them (Connect → edit a
          connection → “Let AI agents use this connection”), read-only, without this window open.
          {{ agentCount() === 1 ? "1 connection is open to agents." : agentCount() + " connections are open to agents." }}
        </p>
        @if (mcpPath(); as path) {
          <code class="path" title="The MCP server">{{ path }}</code>
          <div class="buttons">
            <button type="button" (click)="copy(claudeCode(path), 'Command copied')">Copy Claude Code command</button>
            <button type="button" (click)="copy(jsonConfig(path), 'Configuration copied')">Copy JSON configuration</button>
            @if (copied(); as c) {
              <span class="copied">{{ c }}</span>
            }
          </div>
          <p class="note">Run the command in a terminal, or add the JSON to your client's MCP settings (for Claude Desktop, claude_desktop_config.json). Updating xdiagram replaces the server even while the client runs (the client switches to the new one when it restarts it); if you installed the .msi, close the client first.</p>
        } @else {
          <p class="note">xdiagram-mcp is not installed next to the app in this build.</p>
        }
      </fieldset>

      <div class="actions">
        <button type="button" class="link" (click)="about.emit()">About xdiagram…</button>
        <span class="hint">Changes are saved as you make them.</span>
        <button type="button" class="primary" (click)="closed.emit()">Done</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 50; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; padding: 16px; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop); }
    .dialog { position: relative; width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--panel);
      color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 18px 22px;
      display: flex; flex-direction: column; gap: 14px; }
    h2 { margin: 0; font-size: 16px; }
    fieldset { border: 1px solid var(--border); border-radius: 9px; padding: 8px 14px 12px; margin: 0; display: flex; flex-direction: column; gap: 10px; }
    legend { font-size: 12px; font-weight: 600; color: var(--text-muted); padding: 0 4px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .label { font-size: 13px; display: flex; flex-direction: column; }
    .label em { font-style: normal; font-size: 11.5px; color: var(--text-muted); }
    input[type="number"] { width: 96px; font: inherit; font-size: 13px; color: var(--text); background: var(--input-bg);
      border: 1px solid var(--border); border-radius: 7px; padding: 5px 8px; }
    .check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; cursor: pointer; }
    .check input { margin-top: 3px; accent-color: var(--accent); }
    .seg { display: flex; gap: 2px; padding: 2px; background: var(--hover); border-radius: 8px; }
    .seg button { font: inherit; font-size: 12.5px; border: 0; background: transparent; color: var(--text-muted); padding: 5px 12px;
      border-radius: 6px; cursor: pointer; }
    .seg button.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: var(--shadow-sm); }
    .actions { display: flex; align-items: center; gap: 8px; }
    .hint { flex: 1; font-size: 12px; color: var(--text-muted); text-align: right; }
    .check em { font-style: normal; color: var(--text-muted); font-size: 12px; }
    .link { font: inherit; font-size: 12.5px; border: 0; background: none; color: var(--accent); padding: 0; cursor: pointer; }
    .primary { font: inherit; font-size: 13px; border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 7px 16px;
      border-radius: 7px; cursor: pointer; }
    .note { margin: 0; font-size: 12.5px; color: var(--text-muted); }
    .path { font-family: var(--mono); font-size: 11.5px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 7px;
      padding: 6px 8px; overflow-wrap: anywhere; user-select: all; }
    .buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .buttons button { font: inherit; font-size: 12.5px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      padding: 5px 10px; border-radius: 7px; cursor: pointer; }
    .buttons button:hover { background: var(--hover); }
    .copied { font-size: 12px; color: var(--ok); }
  `,
})
export class SettingsDialogComponent implements OnInit {
  readonly closed = output<void>();
  readonly about = output<void>();
  protected readonly updates = inject(UpdateService);
  private readonly settings = inject(SettingsService);
  private readonly api = inject(TauriApi);
  private readonly profiles = inject(ProfilesService);
  protected readonly s = this.settings.settings;
  protected readonly mcpPath = signal<string | null>(null);
  protected readonly agentCount = computed(() => this.profiles.profiles().filter((p) => p.mcp.enabled).length);
  protected readonly copied = signal<string | null>(null);
  protected readonly claudeCode = claudeCodeCommand;
  protected readonly jsonConfig = mcpJsonConfig;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async ngOnInit(): Promise<void> {
    void this.profiles.load();
    this.mcpPath.set(await this.api.mcpServerPath().catch(() => null));
  }

  protected copy(text: string, done: string): void {
    void navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(done);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(null), 2500);
    });
  }
  protected readonly themes: { value: ThemeChoice; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  protected set(patch: Partial<Settings>): void {
    void this.settings.update(patch);
  }

  protected setNumber(key: "editorFontSize" | "queryTimeoutSecs" | "profileSampleRows", e: Event): void {
    this.set({ [key]: Number((e.target as HTMLInputElement).value) });
  }

  protected setBool(key: "restoreSession" | "autoReloadFiles" | "checkUpdates", e: Event): void {
    this.set({ [key]: (e.target as HTMLInputElement).checked });
  }
}
