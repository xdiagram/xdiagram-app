import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";

import { displayTable } from "../diagram/view-model";
import { type LintFinding, RULES, type Severity } from "../lint/lint";
import { LintStore } from "../state/lint.store";
import { WorkspaceStore } from "../state/workspace.store";

const SEVERITIES: { id: Severity; label: string }[] = [
  { id: "error", label: "Errors" },
  { id: "warning", label: "Warnings" },
  { id: "info", label: "Notes" },
];

/** Side-panel tab listing schema lint findings, with rule toggles and quick fixes. */
@Component({
  selector: "app-lint-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="title">Lint</span>
      <button type="button" class="link" (click)="rulesOpen.set(!rulesOpen())" [attr.aria-expanded]="rulesOpen()">
        Rules ({{ lint.enabled().size }}/{{ rules.length }})
      </button>
    </div>
    <div class="bar">
      <span class="summary">
        @if (lint.findings().length) {
          <span class="n error">{{ lint.counts().error }}</span> errors ·
          <span class="n warning">{{ lint.counts().warning }}</span> warnings ·
          <span class="n info">{{ lint.counts().info }}</span> notes
        } @else {
          {{ store.view().tables.length ? "No problems found" : "Nothing to check yet" }}
        }
      </span>
      <label class="toggle" title="Mark tables with findings on the diagram">
        <input type="checkbox" [checked]="lint.showOnDiagram()" (change)="lint.setShowOnDiagram($any($event.target).checked)" />
        On diagram
      </label>
    </div>

    @if (rulesOpen()) {
      <div class="rules">
        @for (r of rules; track r.id) {
          <label class="rule" [title]="r.description">
            <input type="checkbox" [checked]="lint.enabled().has(r.id)" (change)="lint.toggleRule(r.id, $any($event.target).checked)" />
            <span class="r-title">{{ r.title }}</span>
            <span class="r-desc">{{ r.description }}</span>
          </label>
        }
      </div>
    }

    <div class="list">
      @for (g of groups(); track g.id) {
        <div class="group">
          <div class="g-head"><i class="dot" [class]="g.id"></i>{{ g.label }} <span class="count">{{ g.items.length }}</span></div>
          @for (f of g.items; track f.key) {
            <div class="item">
              <button type="button" class="msg" (click)="goTo(f)" [title]="ruleTitle(f) + ' — click to show it'">
                <span class="loc">{{ short(f.table) }}{{ f.column ? "." + f.column : "" }}</span>
                {{ f.message }}
              </button>
              @if (f.fix) {
                <button type="button" class="fix" (click)="lint.applyFix(f)" [title]="f.fix.append">{{ f.fix.label }}</button>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
    .head { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 12px;
      border-bottom: 1px solid var(--border); font-size: 12px; flex: none; }
    .title { font-weight: 600; letter-spacing: 0.04em; color: var(--text-muted); }
    .link { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; padding: 0; }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; font-size: 12px;
      color: var(--text-muted); border-bottom: 1px solid var(--border); flex: none; }
    .n { font-weight: 700; font-variant-numeric: tabular-nums; }
    .n.error { color: var(--danger); }
    .n.warning { color: #b45309; }
    .toggle { display: flex; align-items: center; gap: 5px; cursor: pointer; white-space: nowrap; }
    .rules { border-bottom: 1px solid var(--border); padding: 6px 8px; max-height: 45%; overflow: auto; flex: none; }
    .rule { display: grid; grid-template-columns: auto 1fr; gap: 0 6px; padding: 4px; border-radius: 6px; cursor: pointer; }
    .rule:hover { background: var(--hover); }
    .rule input { grid-row: span 2; margin-top: 2px; }
    .r-title { font-size: 12.5px; font-weight: 600; }
    .r-desc { font-size: 11.5px; color: var(--text-muted); }
    .list { overflow: auto; flex: 1; padding: 6px 6px 14px; }
    .group { margin-bottom: 8px; }
    .g-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em; padding: 6px 6px 4px; }
    .count { font-weight: 500; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .dot.error { background: var(--danger); }
    .dot.warning { background: #d97706; }
    .dot.info { background: var(--text-muted); }
    .item { display: flex; align-items: flex-start; gap: 4px; border-radius: 6px; }
    .item:hover { background: var(--hover); }
    .msg { flex: 1; min-width: 0; text-align: left; border: 0; background: none; color: var(--text); font: inherit; font-size: 12px;
      line-height: 1.4; padding: 5px 6px; cursor: pointer; overflow-wrap: anywhere; }
    .loc { display: block; font-family: var(--mono); font-size: 11px; color: var(--accent); }
    .fix { flex: none; margin: 5px 4px 0 0; font: inherit; font-size: 11.5px; border: 1px solid var(--border); background: var(--panel);
      color: var(--text); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    .fix:hover { background: var(--accent-soft); border-color: var(--accent); }
    input[type="checkbox"] { margin: 0; accent-color: var(--accent); }
  `,
})
export class LintPanelComponent {
  protected readonly lint = inject(LintStore);
  protected readonly store = inject(WorkspaceStore);
  protected readonly rules = RULES;
  protected readonly rulesOpen = signal(false);
  protected readonly short = displayTable;

  protected readonly groups = computed(() =>
    SEVERITIES.map((s) => ({ ...s, items: this.lint.findings().filter((f) => f.severity === s.id) })).filter((g) => g.items.length),
  );

  protected ruleTitle(f: LintFinding): string {
    return RULES.find((r) => r.id === f.rule)?.title ?? f.rule;
  }

  /** Shows the table (and column) on the canvas and moves the editor cursor there. */
  protected goTo(f: LintFinding): void {
    if (this.store.hidden().has(f.table)) this.store.toggleHidden(f.table);
    const table = this.store.view().tables.find((t) => t.id === f.table);
    const field = f.column ? table?.fields.find((x) => x.name === f.column) : undefined;
    setTimeout(() => {
      if (field) this.store.diagram?.flashField(f.table, field.name);
      else this.store.diagram?.focusTable(f.table);
    }, 0);
    const line = field?.offset != null ? this.store.dbml().slice(0, field.offset).split("\n").length : table?.line;
    this.store.reveal(line ?? null);
  }
}
