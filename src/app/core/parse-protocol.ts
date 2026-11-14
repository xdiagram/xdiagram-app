import type { ViewModel } from "../diagram/view-model";
import type { LintFinding, RuleId } from "../lint/lint";
import type { EditorDiagnostic } from "./diagnostics";

/** A Monaco completion list as plain data (ranges, kinds and rules are numbers/objects). */
export interface CompletionListData {
  suggestions: unknown[];
  incomplete?: boolean;
}

/** Messages to the parse worker (see `parse.worker.ts`). */
export type ParseRequest =
  /** Parse DBML; the worker keeps the result for `lint`. */
  | { kind: "parse"; id: number; text: string }
  /** Lint the last successfully parsed document. */
  | { kind: "lint"; id: number; rules: RuleId[] }
  /** Editor completion at a position (1-based line and column). */
  | { kind: "complete"; id: number; text: string; position: { lineNumber: number; column: number } }
  /** Parse other documents (e.g. two reads of a database, to compare them) without touching the current one. */
  | { kind: "views"; id: number; texts: string[] };

export type ParseResponse =
  | { kind: "parsed"; id: number; ok: true; view: ViewModel; ms: number }
  | { kind: "parsed"; id: number; ok: false; diagnostics: EditorDiagnostic[]; ms: number }
  /** A newer request of the same kind arrived before this one was handled: it was skipped. */
  | { kind: "skipped"; id: number }
  | { kind: "linted"; id: number; findings: LintFinding[]; ms: number }
  | { kind: "completed"; id: number; list: CompletionListData | null; ms: number }
  /** One entry per text: its diagram model, or null when it does not parse. */
  | { kind: "viewed"; id: number; views: (ViewModel | null)[]; ms: number };
