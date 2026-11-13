/** A parse problem, positioned for Monaco markers. */
export interface EditorDiagnostic {
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning";
}

/** One problem as `@dbml/core` reports it (`CompilerDiagnostics.diags`). */
export interface RawDiagnostic {
  message: string;
  type?: string;
  location?: { start?: { line: number; column: number }; end?: { line: number; column: number } };
}

/** Converts what the DBML parser throws (`{ diags: [...] }`, or any error) into editor markers. */
export function toDiagnostics(err: unknown): EditorDiagnostic[] {
  const diags = (err as { diags?: RawDiagnostic[] } | null)?.diags;
  if (!Array.isArray(diags) || diags.length === 0) {
    return [{ message: messageOf(err), startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, severity: "error" }];
  }
  return diags.map((d) => {
    const start = d.location?.start ?? { line: 1, column: 1 };
    const end = d.location?.end ?? start;
    return {
      message: d.message,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.line === start.line && end.column <= start.column ? start.column + 1 : end.column,
      severity: d.type === "warning" ? "warning" : "error",
    };
  });
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}
