/** The file the DBML compiler knows the document as (`DEFAULT_ENTRY`); the model uses the same URI. */
export const DBML_MODEL_URI = "file:///main.dbml";

/**
 * The slice of Monaco's ITextModel the `@dbml/parse` language providers use, over a plain string
 * (for the parse worker, and for queries outside the editor).
 */
export function textModel(text: string) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  return {
    uri: DBML_MODEL_URI,
    getValue: () => text,
    getLineCount: () => lineStarts.length,
    getLineContent: (n: number) => text.slice(lineStarts[n - 1], (lineStarts[n] ?? text.length + 1) - 1).replace(/\r$/, ""),
    getOffsetAt: (p: { lineNumber: number; column: number }) =>
      Math.min(text.length, (lineStarts[p.lineNumber - 1] ?? text.length) + p.column - 1),
    getPositionAt: (offset: number) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { lineNumber: lo + 1, column: offset - lineStarts[lo] + 1 };
    },
  };
}
