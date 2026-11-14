/** Rows as text cells (`null` is SQL NULL), as the data browser reads them. */
export type Rows = (string | null)[][];

/**
 * CSV (RFC 4180): a header line, commas, CRLF line ends; a field is quoted when it holds a comma,
 * a quote, a line break or leading/trailing spaces, with quotes doubled. NULL is an empty field,
 * the empty string a quoted one (`""`), so the two stay apart.
 */
export function toCsv(columns: string[], rows: Rows): string {
  const field = (v: string | null): string => {
    if (v === null) return "";
    if (v === "" || /[",\r\n]/.test(v) || v !== v.trim()) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  return [columns, ...rows].map((r) => r.map(field).join(",")).join("\r\n") + "\r\n";
}

/** A JSON array with one object per row (column → value; NULL is `null`), indented. */
export function toJson(columns: string[], rows: Rows): string {
  const objects = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
  return JSON.stringify(objects, null, 2) + "\n";
}
