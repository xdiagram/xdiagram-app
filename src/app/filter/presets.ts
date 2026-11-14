import type { ColKind } from "../core/tauri-api.service";
import { labelColumn } from "./label-column";
import { type CondNode, type FilterNode, newId } from "./model";
import type { RelOption } from "./relations";

/** A ready-made data check: a filter that finds rows worth a look. */
export interface Preset {
  label: string;
  detail: string;
  node: FilterNode;
  /** Open it in the editor first (columns to choose), else apply it as it is. */
  edit: boolean;
}

const short = (id: string) => id.replace(/^public\./, "");
const cond = (column: string, op: CondNode["op"]): CondNode => ({ t: "cond", id: newId(), column, op, args: [] });

/**
 * The checks for a table: duplicate values, references pointing at no row (orphans), rows with
 * nothing pointing at them, empty or blank text, and text with extra spaces.
 */
export function presets(columns: { name: string; kind: ColKind }[], rels: RelOption[]): Preset[] {
  const out: Preset[] = [];
  const text = columns.filter((c) => c.kind === "text");
  const firstText = labelColumn(columns, []) ?? text[0]?.name ?? null;
  if (columns.length) {
    out.push({
      label: "Duplicate values…",
      detail: "rows whose values in the chosen columns occur in other rows too",
      node: { t: "dup", id: newId(), columns: [firstText ?? columns[0].name] },
      edit: true,
    });
  }
  for (const r of rels.filter((o) => o.direction === "parent")) {
    const locals = r.on.map(([local]) => local);
    out.push({
      label: `Orphans: ${locals.join(", ")} pointing at no ${short(r.tableId)} row`,
      detail: "a key that is set but whose row does not exist",
      node: {
        t: "group",
        id: newId(),
        op: "and",
        items: [...locals.map((c) => cond(c, "notNull")), { t: "rel", id: newId(), label: r.label, schema: r.schema, table: r.table, on: r.on, quant: "none" }],
      },
      edit: false,
    });
  }
  for (const r of rels.filter((o) => o.direction === "children")) {
    out.push({
      label: `Without any ${r.label}`,
      detail: `rows no ${short(r.tableId)} row points at`,
      node: { t: "rel", id: newId(), label: r.label, schema: r.schema, table: r.table, on: r.on, quant: "none" },
      edit: false,
    });
  }
  if (firstText) {
    out.push({
      label: "Empty or blank text…",
      detail: "NULL, empty, or only spaces",
      node: { t: "group", id: newId(), op: "or", items: [cond(firstText, "isNull"), cond(firstText, "isBlank")] },
      edit: true,
    });
    out.push({ label: "Text with extra spaces…", detail: "leading or trailing spaces", node: cond(firstText, "isPadded"), edit: true });
  }
  return out;
}
