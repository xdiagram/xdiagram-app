import { Injectable } from "@angular/core";
import type { Database } from "@dbml/core";

import { buildViewModel, type ViewModel } from "../diagram/view-model";
import { buildDocModel } from "../export/doc-model";
import { type LintFinding, type RuleId, lintSchema } from "../lint/lint";
import { loadDbmlCore } from "./dbml";
import { type EditorDiagnostic, toDiagnostics } from "./diagnostics";
import type { CompletionListData, ParseRequest, ParseResponse } from "./parse-protocol";

export type ParseOutcome = { ok: true; view: ViewModel } | { ok: false; diagnostics: EditorDiagnostic[] };

/**
 * Parses DBML into the diagram model and lints it, in a Web Worker (`parse.worker.ts`) so big
 * schemas never block typing. Without workers (unit tests) or if the worker fails to start, the
 * same work runs on the main thread with `@dbml/core`.
 */
@Injectable({ providedIn: "root" })
export class DocumentParser {
  private worker: Worker | null = null;
  private workerFailed = false;
  private seq = 0;
  private readonly waiting = new Map<number, { req: ParseRequest; resolve: (r: ParseResponse) => void }>();
  /** Main-thread fallback: the last document that parsed, for lint. */
  private inlineLast: { db: Database; view: ViewModel } | null = null;

  constructor() {
    // Start the worker now: its first parse should not pay for loading it.
    this.ensureWorker();
  }

  /** Null when a newer parse superseded this one before it ran. */
  async parse(text: string): Promise<ParseOutcome | null> {
    const r = await this.send({ kind: "parse", id: ++this.seq, text });
    if (r.kind !== "parsed") return null;
    return r.ok ? { ok: true, view: r.view } : { ok: false, diagnostics: r.diagnostics };
  }

  /**
   * Editor completions from the worker; null when there is no worker (the caller then completes
   * on the main thread itself).
   */
  async complete(text: string, position: { lineNumber: number; column: number }): Promise<CompletionListData | null> {
    if (!this.ensureWorker()) return null;
    const r = await this.send({ kind: "complete", id: ++this.seq, text, position });
    return r.kind === "completed" ? (r.list ?? { suggestions: [] }) : { suggestions: [] };
  }

  /** Diagram models of other documents (null where one does not parse); the open document is untouched. */
  async views(texts: string[]): Promise<(ViewModel | null)[]> {
    const r = await this.send({ kind: "views", id: ++this.seq, texts });
    return r.kind === "viewed" ? r.views : texts.map(() => null);
  }

  /** Lints the last document that parsed. */
  async lint(rules: RuleId[]): Promise<LintFinding[]> {
    const r = await this.send({ kind: "lint", id: ++this.seq, rules });
    return r.kind === "linted" ? r.findings : [];
  }

  private send(req: ParseRequest): Promise<ParseResponse> {
    const worker = this.ensureWorker();
    if (!worker) return this.runInline(req);
    return new Promise((resolve) => {
      this.waiting.set(req.id, { req, resolve });
      worker.postMessage(req);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.workerFailed) return this.worker;
    if (typeof Worker === "undefined") {
      this.workerFailed = true;
      return null;
    }
    try {
      const worker = new Worker(new URL("./parse.worker", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<ParseResponse>) => {
        const entry = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        entry?.resolve(e.data);
      };
      worker.onerror = (e) => {
        console.error("DBML parse worker failed; parsing on the main thread from now on", e);
        this.workerFailed = true;
        this.worker = null;
        worker.terminate();
        // Whatever was in flight runs here instead (a lint after a lost parse just finds nothing).
        const pending = [...this.waiting.values()];
        this.waiting.clear();
        for (const { req, resolve } of pending) void this.runInline(req).then(resolve);
      };
      this.worker = worker;
    } catch (err) {
      console.error("Could not start the DBML parse worker", err);
      this.workerFailed = true;
    }
    return this.worker;
  }

  private async runInline(req: ParseRequest): Promise<ParseResponse> {
    if (req.kind === "complete") return { kind: "completed", id: req.id, list: null, ms: 0 };
    if (req.kind === "lint") {
      const last = this.inlineLast;
      const findings = last ? lintSchema(buildDocModel(last.db, last.view, { title: "", source: null }), new Set(req.rules)) : [];
      return { kind: "linted", id: req.id, findings, ms: 0 };
    }
    const { Parser } = await loadDbmlCore();
    if (req.kind === "views") {
      const views = req.texts.map((text) => {
        try {
          return buildViewModel(Parser.parse(text, "dbmlv2"));
        } catch {
          return null;
        }
      });
      return { kind: "viewed", id: req.id, views, ms: 0 };
    }
    try {
      const db = Parser.parse(req.text, "dbmlv2");
      const view = buildViewModel(db);
      this.inlineLast = { db, view };
      return { kind: "parsed", id: req.id, ok: true, view, ms: 0 };
    } catch (err) {
      return { kind: "parsed", id: req.id, ok: false, diagnostics: toDiagnostics(err), ms: 0 };
    }
  }
}
