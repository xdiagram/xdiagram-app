import {
  BADGE_W,
  GROUP_LABEL_H,
  HEADER_H,
  PAD_X,
  ROW_H,
  Scene,
  edgeStrokeWidth,
  markerSegments,
  sceneBounds,
} from "./geometry";
import { DiagramPalette, FONT_FAMILY, MONO_FAMILY, zoneStyle } from "./theme";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const n = (v: number) => +v.toFixed(2);

export interface SvgOptions {
  /** Wraps each table in a link (used by the HTML documentation to jump to its section). */
  link?: (tableId: string) => string;
}

/** Renders the same scene the canvas shows as a standalone SVG document. */
export function sceneToSvg(scene: Scene, p: DiagramPalette, title: string, options: SvgOptions = {}): string {
  const b = sceneBounds(scene);
  const pad = 40;
  const x0 = b.x - pad;
  const y0 = b.y - pad;
  const w = b.w + pad * 2;
  const h = b.h + pad * 2;
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}">`,
    `<title>${esc(title)}</title>`,
    `<style>text{font-family:${esc(FONT_FAMILY)};dominant-baseline:central}.t{font-family:${esc(MONO_FAMILY)};font-size:11.5px;fill:${p.fieldType}}</style>`,
    `<rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}" fill="${p.background}"/>`,
  );

  for (const g of scene.groups) {
    const z = zoneStyle(g.group, p);
    const dash = z.dash ? ` stroke-dasharray="${z.dash.join(" ")}"` : "";
    out.push(
      `<g transform="translate(${n(g.x)},${n(g.y)})">`,
      `<rect width="${n(g.w)}" height="${n(g.h)}" rx="10" fill="${esc(z.fill)}" stroke="${esc(z.stroke)}" stroke-width="${z.strokeWidth}"${dash}/>`,
      `<text x="12" y="${GROUP_LABEL_H / 2}" font-size="12" font-weight="600" fill="${esc(z.label)}">${esc(g.group.name)}</text>`,
      `</g>`,
    );
  }

  for (const e of scene.edges) {
    const pts: string[] = [];
    for (let i = 0; i < e.points.length; i += 2) pts.push(`${n(e.points[i])},${n(e.points[i + 1])}`);
    const discovered = e.kind === "discovered";
    const stroke = discovered ? p.edgeDiscovered : p.edge;
    out.push(`<g stroke="${stroke}" stroke-width="${n(edgeStrokeWidth(e))}" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
    out.push(`<polyline points="${pts.join(" ")}"${discovered ? ' stroke-dasharray="6 4"' : ""}/>`);
    if (e.directed) {
      for (const end of [e.from, e.to]) {
        for (const s of markerSegments(end)) {
          out.push(`<line x1="${n(s[0])}" y1="${n(s[1])}" x2="${n(s[2])}" y2="${n(s[3])}"/>`);
        }
      }
    }
    out.push(`</g>`);
  }

  for (const box of scene.tables.values()) {
    const t = box.table;
    const header = t.headerColor ?? p.headerDefault;
    const r = 6;
    if (options.link) out.push(`<a href="${esc(options.link(t.id))}">`);
    out.push(
      `<g transform="translate(${n(box.x)},${n(box.y)})">`,
      `<rect width="${box.w}" height="${box.h}" rx="${r}" fill="${p.tableBody}" stroke="${p.tableBorder}"/>`,
      `<path d="M0 ${HEADER_H}V${r}Q0 0 ${r} 0H${box.w - r}Q${box.w} 0 ${box.w} ${r}V${HEADER_H}Z" fill="${esc(header)}"/>`,
      `<text x="${PAD_X}" y="${HEADER_H / 2}" font-size="13" font-weight="600" fill="${p.headerText}">${esc(t.label)}</text>`,
    );
    box.fields.forEach((f, i) => {
      const y = HEADER_H + i * ROW_H;
      const cy = y + ROW_H / 2;
      if (i > 0) out.push(`<line x1="1" y1="${y}" x2="${box.w - 1}" y2="${y}" stroke="${p.rowDivider}"/>`);
      const badge = f.pk ? "PK" : f.fk ? "FK" : null;
      if (badge) {
        out.push(
          `<rect x="${PAD_X}" y="${cy - 7}" width="18" height="14" rx="3" fill="${f.pk ? p.pkBadge : p.fkBadge}"/>`,
          `<text x="${PAD_X + 9}" y="${cy}" font-size="8" font-weight="700" text-anchor="middle" fill="${p.badgeText}">${badge}</text>`,
        );
      }
      out.push(
        `<text x="${PAD_X + BADGE_W}" y="${cy}" font-size="12.5" font-weight="${f.pk ? 600 : 400}" fill="${p.fieldName}">${esc(f.name)}</text>`,
        `<text class="t" x="${box.w - PAD_X}" y="${cy}" text-anchor="end">${esc(f.type)}</text>`,
      );
    });
    out.push(`</g>`);
    if (options.link) out.push(`</a>`);
  }

  out.push(`</svg>`);
  return out.join("\n");
}
