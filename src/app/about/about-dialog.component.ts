import { Component, inject, output } from "@angular/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ReportService } from "../core/report.service";
import { UpdateService } from "../core/update.service";
import { DraggableDialogDirective } from "../core/draggable-dialog.directive";

/** Version, links, update check and the open-source projects xdiagram is built on. */
@Component({
  selector: "app-about-dialog",
  imports: [DraggableDialogDirective],
  host: { "(document:keydown.escape)": "closed.emit()" },
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <section class="dialog" appDraggableDialog role="dialog" aria-modal="true" aria-labelledby="about-title">
      <header data-drag-handle>
        <svg class="mark" viewBox="0 0 64 64" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="var(--accent)" />
          <g transform="translate(32 32) scale(2) translate(-12 -12)" fill="#fff">
            <rect x="2" y="3" width="9" height="7" rx="1.5" />
            <rect x="13" y="14" width="9" height="7" rx="1.5" />
            <path d="M11 6.5h3.5v11H13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" />
          </g>
        </svg>
        <div>
          <h2 id="about-title">xdiagram</h2>
          <p class="version">Version {{ updates.version() ?? "…" }}</p>
        </div>
      </header>

      <p>Database diagrams from PostgreSQL, MySQL, SQL Server and SQLite, as editable DBML.</p>

      @if (updates.releasesUrl(); as releases) {
        <p class="links">
          <a href="#" (click)="open($event, releases)">Releases</a>
          @if (updates.projectUrl(); as project) {
            · <a href="#" (click)="open($event, project)">Project page</a>
            · <a href="#" (click)="$event.preventDefault(); report.open()" title="Opens a GitHub issue form in your browser, with the app's version filled in. Nothing is sent until you submit it.">Report a problem</a>
          }
        </p>
      }

      <p class="legal">
        Copyright © 2026 the xdiagram authors. xdiagram is free software: you can redistribute it and modify it under the
        terms of the GNU Affero General Public License, version 3 or (at your option) any later version. It comes with
        no warranty.
        @if (updates.projectUrl(); as project) {
          <a href="#" (click)="open($event, project + '/blob/main/LICENSE')">License</a> ·
          <a href="#" (click)="open($event, project)">Source code</a>
        }
      </p>

      <div class="update">
        <button type="button" (click)="updates.check(true)" [disabled]="updates.checking() || !updates.configured()">
          {{ updates.checking() ? "Checking…" : "Check for updates" }}
        </button>
        <span class="status">{{ updates.status() ?? (updates.configured() ? "" : "Update checks are not set up in this build.") }}</span>
      </div>

      <details>
        <summary>Built with</summary>
        <ul>
          @for (c of credits; track c.name) {
            <li><span>{{ c.name }}</span> <em>{{ c.license }}</em></li>
          }
        </ul>
      </details>

      <div class="actions">
        <button type="button" class="primary" (click)="closed.emit()">Close</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 60; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; padding: 16px; }
    .backdrop { position: absolute; inset: 0; background: var(--backdrop); }
    .dialog { position: relative; width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--panel);
      color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 20px 22px;
      display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
    header { display: flex; align-items: center; gap: 14px; }
    .mark { width: 48px; height: 48px; flex: none; }
    h2 { margin: 0; font-size: 18px; }
    p { margin: 0; line-height: 1.5; }
    .version { color: var(--text-muted); font-size: 12.5px; }
    .links a, .legal a { color: var(--accent); }
    .legal { color: var(--text-muted); font-size: 12px; }
    .update { display: flex; align-items: center; gap: 10px; }
    .update button { font: inherit; font-size: 12.5px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 7px; padding: 5px 12px; cursor: pointer; flex: none; }
    .update button:disabled { opacity: 0.55; cursor: default; }
    .status { color: var(--text-muted); font-size: 12px; }
    details { border-top: 1px solid var(--border); padding-top: 10px; }
    summary { cursor: pointer; color: var(--text-muted); font-size: 12.5px; }
    ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
    li { display: flex; justify-content: space-between; gap: 12px; }
    li em { font-style: normal; color: var(--text-muted); font-size: 12px; }
    .actions { display: flex; justify-content: flex-end; }
    .primary { font: inherit; font-size: 13px; border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 7px 16px;
      border-radius: 7px; cursor: pointer; }
  `,
})
export class AboutDialogComponent {
  readonly closed = output<void>();
  protected readonly updates = inject(UpdateService);
  protected readonly report = inject(ReportService);

  protected readonly credits = [
    { name: "Tauri", license: "Apache-2.0 / MIT" },
    { name: "Angular", license: "MIT" },
    { name: "DBML (@dbml/core, @dbml/parse)", license: "Apache-2.0" },
    { name: "Monaco Editor", license: "MIT" },
    { name: "Konva", license: "MIT" },
    { name: "ELK (elkjs)", license: "EPL-2.0" },
    { name: "node-diff3", license: "MIT" },
    { name: "tokio-postgres, mysql_async, tiberius, rusqlite", license: "MIT / Apache-2.0" },
    { name: "russh", license: "Apache-2.0" },
    { name: "rustls", license: "Apache-2.0 / ISC / MIT" },
  ];

  protected open(event: Event, url: string): void {
    event.preventDefault();
    void openUrl(url);
  }
}
