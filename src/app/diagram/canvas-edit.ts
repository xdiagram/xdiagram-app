/**
 * Pure DBML text builders used by edits made on the canvas. They never parse: callers pass
 * offsets taken from the last successful parse (only allowed while the DBML has no errors).
 */

const DEFAULT_SCHEMA = "public";
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface Range {
  start: number;
  end: number;
}

/** A name the canvas accepts for tables and columns: non-empty, single line, no double quote. */
export function isValidName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 63 && !/["\r\n]/.test(n);
}

export function quoteIdent(name: string): string {
  return `"${name}"`;
}

/** `"schema"."table"`, or just `"table"` for the default schema (the style `generateDbml` uses). */
export function tableRef(id: string): string {
  const dot = id.indexOf(".");
  const schema = id.slice(0, dot);
  const table = id.slice(dot + 1);
  return schema === DEFAULT_SCHEMA ? quoteIdent(table) : `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export function splitTableId(id: string): { schema: string; table: string } {
  const dot = id.indexOf(".");
  return { schema: id.slice(0, dot), table: id.slice(dot + 1) };
}

export interface RefEnd {
  table: string;
  fields: string[];
}

/** `Ref: "child"."col" > "parent"."id"`; `-` instead of `>` for one-to-one / unknown direction. */
export function refLine(from: RefEnd, to: RefEnd, op: ">" | "-" = ">"): string {
  const cols = (f: string[]) => (f.length === 1 ? quoteIdent(f[0]) : `(${f.map(quoteIdent).join(", ")})`);
  return `Ref: ${tableRef(from.table)}.${cols(from.fields)} ${op} ${tableRef(to.table)}.${cols(to.fields)}`;
}

export function newTableBlock(id: string): string {
  return `Table ${tableRef(id)} {\n  "id" integer [pk]\n}`;
}

/** `base`, `base_2`, `base_3`, … — the first one not in `taken`. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Inserts a column line before the closing brace of a table block.
 * `tableEnd` is the offset just after the block's `}` (the parser's `token.end.offset`).
 */
export function insertColumn(src: string, tableEnd: number, name: string, type: string): string {
  const brace = src.lastIndexOf("}", tableEnd - 1);
  if (brace < 0) return src;
  const lineStart = src.lastIndexOf("\n", brace - 1) + 1;
  const braceAlone = src.slice(lineStart, brace).trim() === "";
  const line = `${quoteIdent(name.trim())} ${type.trim() || "varchar"}`;
  if (!braceAlone) return `${src.slice(0, brace)}\n  ${line}\n${src.slice(brace)}`;

  // Reuse the indentation of the previous non-empty line inside the block.
  const before = src.slice(0, lineStart).replace(/\n+$/, "");
  const prevLine = before.slice(before.lastIndexOf("\n") + 1);
  const indent = /\{\s*$/.test(prevLine) ? "  " : (prevLine.match(/^\s*/)?.[0] ?? "  ") || "  ";
  return `${src.slice(0, lineStart)}${indent}${line}\n${src.slice(lineStart)}`;
}

/** The identifier starting at `offset`: a `"quoted name"` or a bare word. */
export function identifierExtent(src: string, offset: number): Range {
  if (src[offset] === '"') {
    const close = src.indexOf('"', offset + 1);
    return { start: offset, end: close < 0 ? src.length : close + 1 };
  }
  let end = offset;
  while (end < src.length && /[A-Za-z0-9_$]/.test(src[end])) end++;
  return { start: offset, end };
}

/** Replaces every range with `text` (ranges may come in any order; overlaps are dropped). */
export function replaceRanges(src: string, ranges: Range[], text: string): string {
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let out = src;
  let lastStart = Infinity;
  for (const r of sorted) {
    if (r.end > lastStart) continue;
    out = out.slice(0, r.start) + text + out.slice(r.end);
    lastStart = r.start;
  }
  return out;
}

/** Renames a column: its declaration plus every usage. Quotes the name when it needs quoting. */
export function renameColumnText(src: string, declOffset: number, usages: Range[], newName: string): string {
  const name = newName.trim();
  const text = BARE_IDENTIFIER.test(name) ? name : quoteIdent(name);
  const decl = identifierExtent(src, declOffset);
  // Keep quoted occurrences quoted, so `"email"` becomes `"mail"` and `email` becomes `mail`.
  const quoted: Range[] = [];
  const bare: Range[] = [];
  for (const r of [decl, ...usages]) (src[r.start] === '"' ? quoted : bare).push(r);
  const all = [...quoted.map((r) => ({ r, t: quoteIdent(name) })), ...bare.map((r) => ({ r, t: text }))].sort(
    (a, b) => b.r.start - a.r.start,
  );
  let out = src;
  for (const { r, t } of all) out = out.slice(0, r.start) + t + out.slice(r.end);
  return out;
}

/** 0-based offset of a 1-based line/column. */
export function offsetOf(src: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = src.indexOf("\n", offset);
    if (nl < 0) return src.length;
    offset = nl + 1;
  }
  return Math.min(src.length, offset + column - 1);
}

/** Palette offered in the canvas context menu (dbdiagram-compatible header colours). */
export const HEADER_COLORS = ["#316896", "#3498DB", "#1ABC9C", "#27AE60", "#F1C40F", "#E67E22", "#E74C3C", "#8E44AD", "#34495E", "#7F8C8D"];
