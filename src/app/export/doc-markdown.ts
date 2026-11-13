import { DocModel, DocRelation, DocTable, constraintsOf, displayId } from "./doc-model";

/** Escapes text for a GitHub-flavoured Markdown table cell. */
export function mdCell(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** GitHub's heading anchor algorithm (lower-case, drop punctuation, spaces → dashes). */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Mermaid entity names allow letters, digits, `_` and `-`. */
export function mermaidEntity(id: string): string {
  return displayId(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Mermaid attribute types may only contain letters, digits, `-`, `_`, parentheses and brackets:
 * `double precision` → `double_precision`, `numeric(10,2)` → `numeric(10_2)`, `s.enum` → `s_enum`.
 */
export function mermaidType(type: string): string {
  const t = type.trim().replace(/[\s,.]+/g, "_").replace(/[^A-Za-z0-9_()[\]-]/g, "");
  return /^[A-Za-z]/.test(t) ? t : `t_${t}`;
}

/** Crow's-foot notation, parent on the left: `||--o{` (one-to-many), `||--o|` (one-to-one), `}o--o{`. */
export function mermaidCardinality(rel: DocRelation): string {
  const parent = rel.to.many ? "}o" : "||";
  const child = rel.from.many ? "o{" : "o|";
  return `${parent}--${child}`;
}

function mermaid(model: DocModel): string {
  const lines = ["```mermaid", "erDiagram"];
  for (const t of model.tables) {
    // Large tables list only key columns so the rendered diagram stays readable.
    const cols = t.columns.length > 20 ? t.columns.filter((c) => c.pk || c.references.length) : t.columns;
    lines.push(`  ${mermaidEntity(t.id)} {`);
    for (const c of cols) {
      const keys = [c.pk && "PK", c.references.length && "FK", c.unique && !c.pk && "UK"].filter(Boolean).join(", ");
      lines.push(`    ${mermaidType(c.type)} ${c.name.replace(/[^A-Za-z0-9_]/g, "_")}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
  }
  for (const r of model.relations) {
    const label = r.from.columns.join(", ").replace(/"/g, "'");
    lines.push(`  ${mermaidEntity(r.to.table)} ${mermaidCardinality(r)} ${mermaidEntity(r.from.table)} : "${label}"`);
  }
  lines.push("```");
  return lines.join("\n");
}

function tableSection(t: DocTable): string {
  const out: string[] = [`## ${displayId(t.id)}`, ""];
  if (t.note) out.push(t.note, "");
  const meta: string[] = [];
  if (t.group) meta.push(`Group: **${t.group}**`);
  if (t.facts) meta.push(`~${Math.round(t.facts.rows).toLocaleString("en-US")} rows`);
  if (meta.length) out.push(meta.join(" · "), "");

  out.push("| Column | Type | Constraints | Default | References | Note |", "| --- | --- | --- | --- | --- | --- |");
  for (const c of t.columns) {
    const refs = c.references.map((r) => `${displayId(r.table)}.${r.columns.join(", ")}`).join("; ");
    const extra = [...c.checks.map((x) => `check: \`${x}\``), c.enumValues ? `values: ${c.enumValues.join(", ")}` : null]
      .filter(Boolean)
      .join("; ");
    const note = [c.note, extra].filter(Boolean).join(" — ");
    out.push(
      `| ${mdCell(c.name)} | \`${mdCell(c.type)}\` | ${mdCell(constraintsOf(c).join(", "))} | ${c.defaultValue ? `\`${mdCell(c.defaultValue)}\`` : ""} | ${mdCell(refs)} | ${mdCell(note)} |`,
    );
  }
  out.push("");

  if (t.indexes.length) {
    out.push("**Indexes**", "", "| Name | Columns | Unique | Type |", "| --- | --- | --- | --- |");
    for (const i of t.indexes) {
      out.push(`| ${mdCell(i.name ?? "")} | ${mdCell(i.columns.join(", "))} | ${i.pk ? "primary key" : i.unique ? "yes" : ""} | ${mdCell(i.type ?? "")} |`);
    }
    out.push("");
  }
  if (t.checks.length) {
    out.push("**Checks**", "");
    for (const c of t.checks) out.push(`- ${c.name ? `${c.name}: ` : ""}\`${c.expression}\``);
    out.push("");
  }
  if (t.referencedBy.length) {
    out.push(`**Referenced by:** ${t.referencedBy.map((r) => `${displayId(r.table)}.${r.columns.join(", ")}`).join(", ")}`, "");
  }
  const unused = t.fkUsage.filter((u) => u.calls === 0);
  if (unused.length) {
    out.push(`**X-ray:** never joined in the recorded workload: ${unused.map((u) => `${u.columns.join(", ")} → ${displayId(u.target)}`).join(", ")}`, "");
  }
  return out.join("\n");
}

/** GitHub-flavoured Markdown data dictionary with a Mermaid ER diagram. */
export function renderMarkdown(model: DocModel): string {
  const out: string[] = [`# ${model.title}`, ""];
  const date = model.generatedAt.slice(0, 10);
  out.push(`${model.tables.length} tables · ${model.relations.length} relationships · ${model.enums.length} enums${model.source ? ` · source: ${model.source}` : ""} · generated ${date} by xdiagram`, "");
  out.push("## Contents", "");
  for (const t of model.tables) out.push(`- [${displayId(t.id)}](#${githubSlug(displayId(t.id))})${t.note ? ` — ${mdCell(t.note.split("\n")[0])}` : ""}`);
  if (model.enums.length) out.push(`- [Enums](#enums)`);
  out.push("", "## Diagram", "", mermaid(model), "");
  for (const t of model.tables) out.push(tableSection(t));
  if (model.enums.length) {
    out.push("## Enums", "");
    for (const e of model.enums) {
      out.push(`### ${displayId(e.id)}`, "");
      if (e.note) out.push(e.note, "");
      for (const v of e.values) out.push(`- \`${v.name}\`${v.note ? ` — ${v.note}` : ""}`);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
