import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { DocumentParser } from "../core/document-parser";
import { timedAsync } from "../core/perf";
import { EMPTY_VIEW } from "../diagram/view-model";
import { DEFAULT_RULES, type LintFinding, type RuleId, RULES } from "../lint/lint";
import { WorkspaceStore } from "./workspace.store";

const RULES_KEY = "xdiagram.lint.rules";
const DIAGRAM_KEY = "xdiagram.lint.diagram";

function readRules(): ReadonlySet<RuleId> {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (raw) {
      const known = new Set(RULES.map((r) => r.id));
      return new Set((JSON.parse(raw) as RuleId[]).filter((r) => known.has(r)));
    }
  } catch {
    /* fall back to the defaults */
  }
  return DEFAULT_RULES;
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferences are best-effort */
  }
}

/** Lint findings for the current DBML, recomputed whenever it parses. */
@Injectable({ providedIn: "root" })
export class LintStore {
  private readonly workspace = inject(WorkspaceStore);
  private readonly parser = inject(DocumentParser);
  private lintSeq = 0;

  readonly enabled = signal<ReadonlySet<RuleId>>(readRules());
  readonly showOnDiagram = signal(readPref(DIAGRAM_KEY) !== "0");
  /** Lint runs in the parse worker, on the document that last parsed. */
  readonly findings = signal<LintFinding[]>([]);

  constructor() {
    effect(() => {
      const view = this.workspace.view();
      const rules = [...this.enabled()];
      untracked(() => void this.relint(view === EMPTY_VIEW ? null : rules));
    });
  }

  private async relint(rules: RuleId[] | null): Promise<void> {
    const seq = ++this.lintSeq;
    const findings = rules ? await timedAsync("lint", () => this.parser.lint(rules)) : [];
    if (seq === this.lintSeq) this.findings.set(findings);
  }

  readonly counts = computed(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const f of this.findings()) c[f.severity]++;
    return c;
  });

  /** Findings per table, for the diagram markers. */
  readonly byTable = computed(() => {
    const map = new Map<string, LintFinding[]>();
    for (const f of this.findings()) map.set(f.table, [...(map.get(f.table) ?? []), f]);
    return map;
  });

  toggleRule(id: RuleId, on: boolean): void {
    const next = new Set(this.enabled());
    if (on) next.add(id);
    else next.delete(id);
    this.enabled.set(next);
    write(RULES_KEY, JSON.stringify([...next]));
  }

  setShowOnDiagram(on: boolean): void {
    this.showOnDiagram.set(on);
    write(DIAGRAM_KEY, on ? "1" : "0");
  }

  applyFix(f: LintFinding): void {
    if (f.fix) this.workspace.appendDbml(f.fix.append);
  }
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
