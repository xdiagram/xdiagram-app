import type { Database } from "@dbml/core";
import { Compiler, DBMLCompletionItemProvider, DEFAULT_ENTRY, MemoryProjectLayout } from "@dbml/parse";
import DatabaseModel from "#dbml-model";

import { buildViewModel, type ViewModel } from "../diagram/view-model";
import { textModel } from "../editor/text-model";
import { buildDocModel } from "../export/doc-model";
import { type LintFinding, type RuleId, lintSchema } from "../lint/lint";
import { type EditorDiagnostic, type RawDiagnostic, toDiagnostics } from "./diagnostics";
import type { CompletionListData } from "./parse-protocol";

export type SessionParse = { ok: true; db: Database; view: ViewModel } | { ok: false; diagnostics: EditorDiagnostic[] };

/**
 * One DBML document as the parse worker sees it. Mirrors `Parser.parse(text, "dbmlv2")` from
 * `@dbml/core` with only the parts that needs, the compiler (`@dbml/parse`) and the model
 * classes, not the SQL parsers. Parsing and completion share the compiler, so completing at
 * the text that was just parsed reuses its work.
 */
export class DbmlSession {
  private readonly layout = new MemoryProjectLayout();
  private readonly compiler = new Compiler(this.layout);
  private readonly completion = new DBMLCompletionItemProvider(this.compiler);
  private source: string | null = null;
  /** The last document that parsed, for lint. */
  private last: { db: Database; view: ViewModel } | null = null;

  parse(text: string): SessionParse {
    try {
      this.setSource(text);
      const errors = this.compiler.parse.errors(DEFAULT_ENTRY);
      if (errors.length > 0) return { ok: false, diagnostics: toDiagnostics({ diags: errors.map(rawOf) }) };
      const db = new DatabaseModel(this.compiler.parse.rawDb(DEFAULT_ENTRY));
      const view = buildViewModel(db);
      this.last = { db, view };
      return { ok: true, db, view };
    } catch (err) {
      return { ok: false, diagnostics: toDiagnostics(err) };
    }
  }

  lint(rules: RuleId[]): LintFinding[] {
    const last = this.last;
    return last ? lintSchema(buildDocModel(last.db, last.view, { title: "", source: null }), new Set(rules)) : [];
  }

  complete(text: string, position: { lineNumber: number; column: number }): CompletionListData | null {
    try {
      this.setSource(text);
      return this.completion.provideCompletionItems(textModel(text) as never, position) as unknown as CompletionListData;
    } catch (err) {
      console.warn("DBML completion failed", err);
      return null;
    }
  }

  private setSource(text: string): void {
    if (text === this.source) return;
    this.layout.setSource(DEFAULT_ENTRY, text);
    this.source = text;
  }
}

interface Pos {
  line: number;
  column: number;
}

/** Same positions as `@dbml/core` reports (1-based). */
function rawOf(e: { diagnostic: string; nodeOrToken: { startPos: Pos; endPos: Pos } }): RawDiagnostic {
  const { startPos, endPos } = e.nodeOrToken;
  return {
    message: e.diagnostic,
    location: { start: { line: startPos.line + 1, column: startPos.column + 1 }, end: { line: endPos.line + 1, column: endPos.column + 1 } },
  };
}
