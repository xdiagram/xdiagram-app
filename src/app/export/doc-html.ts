import { DocModel, DocTable, anchorOf, constraintsOf, displayId } from "./doc-model";

export function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const nl2br = (text: string) => escapeHtml(text).replace(/\r?\n/g, "<br>");
const num = (n: number) => Math.round(n).toLocaleString("en-US");

function columnRows(t: DocTable): string {
  return t.columns
    .map((c) => {
      const badges = constraintsOf(c)
        .map((k) => `<span class="b b-${k.replace(/[^a-z]/gi, "").toLowerCase()}">${escapeHtml(k)}</span>`)
        .join("");
      const refs = c.references
        .map((r) => `<a href="#${anchorOf(r.table)}">${escapeHtml(displayId(r.table))}.${escapeHtml(r.columns.join(", "))}</a>`)
        .join("<br>");
      const notes: string[] = [];
      if (c.note) notes.push(nl2br(c.note));
      for (const ch of c.checks) notes.push(`check <code>${escapeHtml(ch)}</code>`);
      if (c.enumValues) notes.push(`values: ${c.enumValues.map((v) => `<code>${escapeHtml(v)}</code>`).join(" ")}`);
      if (c.cardinality) {
        const k = c.cardinality;
        notes.push(
          `<span class="xr">in the data: ${escapeHtml(k.verdict)} · ${k.childrenPerParent.toFixed(1)} per parent · ${Math.round(k.parentCoverage * 100)}% of parents referenced</span>`,
        );
      }
      return `<tr><td class="mono"><b>${escapeHtml(c.name)}</b></td><td class="mono type">${escapeHtml(c.type)}</td><td>${badges}</td><td class="mono">${escapeHtml(c.defaultValue ?? "")}</td><td>${refs}</td><td>${notes.join("<br>")}</td></tr>`;
    })
    .join("\n");
}

function tableSection(t: DocTable): string {
  const parts: string[] = [];
  parts.push(`<section class="table" id="${anchorOf(t.id)}" data-name="${escapeHtml(t.id.toLowerCase())}">`);
  parts.push(`<h2><span class="schema">${escapeHtml(t.schema)}.</span>${escapeHtml(t.name)}</h2>`);
  const meta: string[] = [];
  if (t.group) meta.push(`group <b>${escapeHtml(t.group)}</b>`);
  meta.push(`${t.columns.length} columns`);
  if (t.facts) meta.push(`~${num(t.facts.rows)} rows`, `${num(t.facts.seqScan)} seq / ${num(t.facts.idxScan)} index scans`);
  if (t.facts?.neverUsed) meta.push(`<span class="warn">idle</span>`);
  parts.push(`<p class="meta">${meta.join(" · ")}</p>`);
  if (t.note) parts.push(`<p class="note">${nl2br(t.note)}</p>`);
  parts.push(
    `<table class="cols"><thead><tr><th>Column</th><th>Type</th><th>Constraints</th><th>Default</th><th>References</th><th>Notes</th></tr></thead><tbody>${columnRows(t)}</tbody></table>`,
  );
  if (t.indexes.length) {
    parts.push(
      `<h3>Indexes</h3><table class="small"><thead><tr><th>Name</th><th>Columns</th><th>Kind</th><th>Type</th></tr></thead><tbody>${t.indexes
        .map(
          (i) =>
            `<tr><td class="mono">${escapeHtml(i.name ?? "")}</td><td class="mono">${escapeHtml(i.columns.join(", "))}</td><td>${i.pk ? "primary key" : i.unique ? "unique" : ""}</td><td class="mono">${escapeHtml(i.type ?? "")}</td></tr>`,
        )
        .join("")}</tbody></table>`,
    );
  }
  if (t.checks.length) {
    parts.push(`<h3>Checks</h3><ul>${t.checks.map((c) => `<li>${c.name ? `${escapeHtml(c.name)}: ` : ""}<code>${escapeHtml(c.expression)}</code></li>`).join("")}</ul>`);
  }
  if (t.referencedBy.length) {
    parts.push(
      `<h3>Referenced by</h3><p>${t.referencedBy
        .map((r) => `<a href="#${anchorOf(r.table)}">${escapeHtml(displayId(r.table))}</a>.${escapeHtml(r.columns.join(", "))}`)
        .join(" · ")}</p>`,
    );
  }
  const unused = t.fkUsage.filter((u) => u.calls === 0);
  if (unused.length) {
    parts.push(
      `<p class="xr">X-ray: never joined in the recorded workload — ${unused.map((u) => `${escapeHtml(u.columns.join(", "))} → ${escapeHtml(displayId(u.target))}`).join(", ")}</p>`,
    );
  }
  parts.push(`</section>`);
  return parts.join("\n");
}

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--border:#e2e5ea;--text:#1f2937;--muted:#6b7280;--accent:#2f6fde;--accent-soft:#e8f0fd;--warn:#b45309;--code:#f1f3f6}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--panel:#1a1d23;--border:#2c313a;--text:#e5e7eb;--muted:#9aa3b2;--accent:#6ea0ff;--accent-soft:rgba(110,160,255,.14);--warn:#f5a524;--code:#22262e}}
*{box-sizing:border-box}html,body{margin:0}body{font:14px/1.5 Inter,"Segoe UI",system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}code,.mono{font-family:"JetBrains Mono","Cascadia Code",Consolas,monospace;font-size:12.5px}
code{background:var(--code);padding:1px 4px;border-radius:4px}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
nav{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--border);background:var(--panel);padding:16px 12px}
nav h1{font-size:15px;margin:0 0 2px}nav .sub{color:var(--muted);font-size:12px;margin:0 0 10px}
nav input{width:100%;font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);margin-bottom:8px}
nav ul{list-style:none;margin:0;padding:0}nav li a{display:block;padding:3px 6px;border-radius:5px;color:var(--text);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav li a:hover{background:var(--accent-soft);text-decoration:none}nav .schema{color:var(--muted)}
main{padding:24px 32px 64px;max-width:1200px}
header h1{margin:0 0 4px;font-size:24px}header p{margin:0;color:var(--muted)}
.diagram{margin:20px 0 28px;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:auto;max-height:70vh}
.diagram svg{display:block;max-width:none}
section.table{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 20px;margin:0 0 18px;scroll-margin-top:12px}
section.table:target{outline:2px solid var(--accent)}
h2{margin:0 0 2px;font-size:18px}h2 .schema{color:var(--muted);font-weight:500}h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:16px 0 6px}
.meta{margin:0 0 8px;color:var(--muted);font-size:12.5px}.note{margin:4px 0 10px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--border)}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}td.type{color:var(--muted)}
table.small td,table.small th{padding:4px 8px}
.b{display:inline-block;font-size:10.5px;font-weight:700;padding:0 5px;border-radius:4px;margin:0 3px 2px 0;background:var(--code);color:var(--muted)}
.b-pk{background:#d99a00;color:#fff}.b-fk{background:#2f6fde;color:#fff}
.xr{color:var(--warn)}.warn{color:var(--warn);font-weight:600}
section.enums ul{margin:4px 0 12px}
footer{color:var(--muted);font-size:12px;margin-top:32px}
.hidden{display:none!important}
@media (max-width:800px){.layout{grid-template-columns:1fr}nav{position:static;height:auto;max-height:40vh}main{padding:16px}}
@media print{nav{display:none}.layout{display:block}.diagram{max-height:none;overflow:visible}section.table{break-inside:avoid}}
`;

const SCRIPT = `
const q=document.getElementById('filter');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
document.querySelectorAll('nav li[data-name]').forEach(li=>li.classList.toggle('hidden',!!v&&!li.dataset.name.includes(v)));
document.querySelectorAll('section.table').forEach(s=>s.classList.toggle('hidden',!!v&&!s.dataset.name.includes(v)));});
`;

/** A self-contained HTML data dictionary: inline CSS and script, embedded SVG diagram. */
export function renderHtml(model: DocModel, diagramSvg: string | null): string {
  const date = model.generatedAt.slice(0, 10);
  const nav = model.tables
    .map(
      (t) =>
        `<li data-name="${escapeHtml(t.id.toLowerCase())}"><a href="#${anchorOf(t.id)}">${t.schema !== "public" ? `<span class="schema">${escapeHtml(t.schema)}.</span>` : ""}${escapeHtml(t.name)}</a></li>`,
    )
    .join("");
  const enums = model.enums.length
    ? `<section class="table enums" id="enums" data-name="enums"><h2>Enums</h2>${model.enums
        .map(
          (e) =>
            `<h3>${escapeHtml(displayId(e.id))}</h3>${e.note ? `<p class="note">${nl2br(e.note)}</p>` : ""}<ul>${e.values
              .map((v) => `<li><code>${escapeHtml(v.name)}</code>${v.note ? ` — ${escapeHtml(v.note)}` : ""}</li>`)
              .join("")}</ul>`,
        )
        .join("")}</section>`
    : "";
  const xray = model.xray
    ? `<p>X-ray: ${model.xray.available ? `${model.xray.statements} recorded statements analysed` : "query workload unavailable"} — row counts, scans and FK usage are from the database's statistics.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)} — data dictionary</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
<nav aria-label="Tables">
<h1>${escapeHtml(model.title)}</h1>
<p class="sub">${model.tables.length} tables</p>
<input id="filter" type="search" placeholder="Filter tables…" aria-label="Filter tables">
<ul>${nav}${model.enums.length ? `<li data-name="enums"><a href="#enums">Enums</a></li>` : ""}</ul>
</nav>
<main>
<header>
<h1>${escapeHtml(model.title)}</h1>
<p>${model.tables.length} tables · ${model.relations.length} relationships · ${model.enums.length} enums${model.source ? ` · ${escapeHtml(model.source)}` : ""}</p>
${xray}
</header>
${diagramSvg ? `<div class="diagram" role="img" aria-label="Entity-relationship diagram">${diagramSvg.replace(/^<\?xml[^>]*>/, "")}</div>` : ""}
${model.tables.map(tableSection).join("\n")}
${enums}
<footer>Generated ${escapeHtml(date)} by xdiagram.</footer>
</main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
