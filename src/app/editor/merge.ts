import { diff3Merge } from "node-diff3";

/** Lines both the user and the database changed; the database's version was kept. */
export interface MergeConflict {
  /** 1-based line in the merged text where the database's lines start. */
  line: number;
  /** The user's lines that were replaced. */
  ours: string;
  /** The database's lines that were kept. */
  theirs: string;
}

export interface MergeOutcome {
  text: string;
  conflicts: MergeConflict[];
}

/**
 * Three-way merge of a database tab's DBML, line by line:
 * - `base`: what the database gave last time;
 * - `ours`: the user's edited text;
 * - `theirs`: what the database gives now.
 *
 * Lines changed on one side only come from that side. Where both changed the same lines, the
 * database wins (it is the source of truth for the schema) and the clash is reported, so the
 * user can copy their version back.
 */
export function mergeDbml(base: string, ours: string, theirs: string): MergeOutcome {
  if (theirs === base || ours === theirs) return { text: ours, conflicts: [] };
  if (ours === base) return { text: theirs, conflicts: [] };
  const lines = (s: string) => s.split("\n");
  const out: string[] = [];
  const conflicts: MergeConflict[] = [];
  // Arrays, not strings: given strings, node-diff3 splits on whitespace (a word diff).
  for (const region of diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })) {
    if (region.ok) {
      out.push(...region.ok);
    } else if (region.conflict) {
      conflicts.push({ line: out.length + 1, ours: region.conflict.a.join("\n"), theirs: region.conflict.b.join("\n") });
      out.push(...region.conflict.b);
    }
  }
  return { text: out.join("\n"), conflicts };
}
