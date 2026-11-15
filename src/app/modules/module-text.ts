import { identifierExtent, tableRef } from "../diagram/canvas-edit";

/**
 * Writes modules into the DBML as `TableGroup` blocks: pure text edits on the offsets of the last
 * successful parse (like the canvas edits). `@dbml/parse` has no transform for TableGroup members,
 * so this edits the text itself and leaves everything it does not understand alone.
 */

const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PART = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))`;
const MEMBER = new RegExp(String.raw`^${PART}(?:\s*\.\s*${PART})?$`);

/** A TableGroup of the document, with its block's offsets (`end` is just after its `}`). */
export interface GroupBlock {
  id: string;
  name: string;
  tables: string[];
  start?: number | null;
  end?: number | null;
}

/** What a group should become. `existing`: the id of the group it updates, null for a new one. */
export interface GroupTarget {
  existing: string | null;
  name: string;
  color: string;
  tables: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A group name as DBML wants it: bare when it can be, else quoted. */
export function groupNameText(name: string): string {
  return BARE.test(name) ? name : `"${name}"`;
}

/** A new `TableGroup` block. */
export function groupBlockText(target: GroupTarget): string {
  const members = target.tables.map((t) => `  ${tableRef(t)}`).join("\n");
  return `TableGroup ${groupNameText(target.name)} [color: ${target.color}] {\n${members}\n}`;
}

/** Offsets of a block's `{` and `}` (quotes in its settings skipped), or null. */
function braces(src: string, start: number, end: number): { open: number; close: number } | null {
  let quote: string | null = null;
  let open = -1;
  for (let i = start; i < end; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "{") {
      open = i;
      break;
    }
  }
  const close = src.lastIndexOf("}", end - 1);
  return open >= 0 && close > open ? { open, close } : null;
}

interface MemberLine {
  /** Table id, or null for a member written in a way not understood here (an alias). */
  id: string | null;
  /** The member's text. */
  start: number;
  end: number;
  /** The whole line, newline included, when the member is alone on it. */
  line: { start: number; end: number } | null;
}

/** The member lines of a TableGroup body; notes and comments are skipped. */
export function memberLines(src: string, open: number, close: number): MemberLine[] {
  const out: MemberLine[] = [];
  let pos = open + 1;
  let inTriple = false;
  let noteDepth = 0;
  while (pos < close) {
    const nl = src.indexOf("\n", pos);
    const lineEnd = nl < 0 || nl >= close ? close : nl;
    const raw = src.slice(pos, lineEnd);
    const lineStart = pos;
    pos = lineEnd + 1;
    const triples = raw.split("'''").length - 1;
    if (inTriple) {
      if (triples % 2 === 1) inTriple = false;
      continue;
    }
    if (noteDepth > 0) {
      noteDepth += (raw.match(/\{/g)?.length ?? 0) - (raw.match(/\}/g)?.length ?? 0);
      continue;
    }
    const code = raw.replace(/\/\/.*$/, "");
    const text = code.trim();
    if (!text) continue;
    if (/^note\b/i.test(text)) {
      if (triples % 2 === 1) inTriple = true;
      else if (text.includes("{") && !text.includes("}")) noteDepth = 1;
      continue;
    }
    const m = MEMBER.exec(text);
    const start = lineStart + code.indexOf(text);
    const end = start + text.length;
    let id: string | null = null;
    if (m) {
      const first = m[1] ?? m[2];
      const second = m[3] ?? m[4];
      id = second ? `${first}.${second}` : `public.${first}`;
    }
    const alone = lineStart > open && lineEnd < close && src[lineEnd] === "\n";
    out.push({ id, start, end, line: alone ? { start: lineStart, end: lineEnd + 1 } : null });
  }
  return out;
}

/**
 * The DBML with the groups written: existing groups updated (members added and removed, renamed),
 * groups in `remove` deleted, new groups appended. Throws when a group to update has no offsets.
 * Colours of existing groups are left to `updateElementSetting` (see `ModulesStore.accept`).
 */
export function writeModuleGroups(src: string, groups: readonly GroupBlock[], targets: readonly GroupTarget[], remove: readonly string[]): string {
  const edits: Edit[] = [];
  const byId = new Map(groups.map((g) => [g.id, g]));

  for (const target of targets) {
    if (!target.existing) continue;
    const g = byId.get(target.existing);
    if (!g || g.start == null || g.end == null) throw new Error(`Cannot find the TableGroup ${target.existing} in the text`);
    const b = braces(src, g.start, g.end);
    if (!b) throw new Error(`Cannot read the TableGroup ${g.name}`);

    if (target.name !== g.name) {
      const header = /^TableGroup\s+/i.exec(src.slice(g.start, b.open));
      if (!header) throw new Error(`Cannot read the name of the TableGroup ${g.name}`);
      const name = identifierExtent(src, g.start + header[0].length);
      edits.push({ ...name, text: groupNameText(target.name) });
    }

    const keep = new Set(target.tables);
    const members = memberLines(src, b.open, b.close);
    for (const m of members) {
      // Only lines naming one of the group's tables: an alias resolves to no table and stays.
      if (!m.id || keep.has(m.id) || !g.tables.includes(m.id)) continue;
      edits.push(m.line ? { ...m.line, text: "" } : { start: m.start, end: m.end, text: "" });
    }
    const present = new Set([...g.tables, ...members.map((m) => m.id).filter((x): x is string => !!x)]);
    const added = target.tables.filter((t) => !present.has(t));
    if (added.length) {
      const sample = members.find((m) => m.line)?.line;
      const indent = (sample && /^[ \t]*/.exec(src.slice(sample.start))?.[0]) || "  ";
      const lineStart = src.lastIndexOf("\n", b.close - 1) + 1;
      const braceAlone = lineStart > b.open && src.slice(lineStart, b.close).trim() === "";
      const lines = added.map((t) => `${indent}${tableRef(t)}`).join("\n");
      if (braceAlone) edits.push({ start: lineStart, end: lineStart, text: `${lines}\n` });
      else edits.push({ start: b.close, end: b.close, text: `\n${lines}\n` });
    }
  }

  for (const id of remove) {
    const g = byId.get(id);
    if (!g || g.start == null || g.end == null) continue;
    let end = g.end;
    if (src[end] === "\r") end++;
    if (src[end] === "\n") end++;
    edits.push({ start: g.start, end, text: "" });
  }

  let out = applyEdits(src, edits);
  const fresh = targets.filter((t) => !t.existing && t.tables.length).map(groupBlockText);
  if (fresh.length) out = `${out.trimEnd()}\n\n${fresh.join("\n\n")}\n`;
  return out;
}

/** Applies non-overlapping edits given against the same text (any order; insertions keep their order). */
function applyEdits(src: string, edits: readonly Edit[]): string {
  const sorted = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.end - a.end || b.i - a.i);
  let out = src;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.end > limit) continue; // overlaps an edit already applied
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}
