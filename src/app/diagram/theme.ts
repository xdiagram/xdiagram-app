import type { VGroup } from "./view-model";

/** Diagram colours. The canvas follows the OS theme; exports always use the light palette. */
export interface DiagramPalette {
  background: string;
  grid: string;
  tableBody: string;
  tableBorder: string;
  tableBorderSelected: string;
  tableShadow: string;
  headerDefault: string;
  headerText: string;
  rowDivider: string;
  rowHover: string;
  fieldName: string;
  fieldType: string;
  pkBadge: string;
  fkBadge: string;
  badgeText: string;
  edge: string;
  edgeHighlight: string;
  edgeDimmed: string;
  groupFill: string;
  groupBorder: string;
  groupLabel: string;
  /** X-ray: relationships discovered from the query workload. */
  edgeDiscovered: string;
  /** X-ray: live activity glow. */
  glowRead: string;
  glowWrite: string;
  /** X-ray: seq-scan-heavy flag. */
  flag: string;
  /** X-ray: opacity of tables with no recorded activity. */
  idleOpacity: number;
}

export const LIGHT: DiagramPalette = {
  background: "#f6f7f9",
  grid: "#e3e6eb",
  tableBody: "#ffffff",
  tableBorder: "#d5dae1",
  tableBorderSelected: "#2f6fde",
  tableShadow: "rgba(16, 24, 40, 0.12)",
  headerDefault: "#316896",
  headerText: "#ffffff",
  rowDivider: "#eef0f3",
  rowHover: "#eef4ff",
  fieldName: "#1f2937",
  fieldType: "#6b7280",
  pkBadge: "#d99a00",
  fkBadge: "#2f6fde",
  badgeText: "#ffffff",
  edge: "#8a94a6",
  edgeHighlight: "#2f6fde",
  edgeDimmed: "#d5dae1",
  groupFill: "rgba(47, 111, 222, 0.05)",
  groupBorder: "rgba(47, 111, 222, 0.35)",
  groupLabel: "#2f6fde",
  edgeDiscovered: "#d97706",
  glowRead: "#2f6fde",
  glowWrite: "#f97316",
  flag: "#dc2626",
  idleOpacity: 0.5,
};

export const DARK: DiagramPalette = {
  background: "#16181d",
  grid: "#22262e",
  tableBody: "#1f232b",
  tableBorder: "#353b46",
  tableBorderSelected: "#6ea0ff",
  tableShadow: "rgba(0, 0, 0, 0.45)",
  headerDefault: "#2c5a82",
  headerText: "#ffffff",
  rowDivider: "#2a2f39",
  rowHover: "#26324a",
  fieldName: "#e5e7eb",
  fieldType: "#9aa3b2",
  pkBadge: "#c98f00",
  fkBadge: "#4c86f0",
  badgeText: "#ffffff",
  edge: "#6b7486",
  edgeHighlight: "#6ea0ff",
  edgeDimmed: "#2f343e",
  groupFill: "rgba(110, 160, 255, 0.06)",
  groupBorder: "rgba(110, 160, 255, 0.35)",
  groupLabel: "#8fb5ff",
  edgeDiscovered: "#f5a524",
  glowRead: "#6ea0ff",
  glowWrite: "#fb923c",
  flag: "#f87171",
  idleOpacity: 0.45,
};

/** Set by `ThemeService` (Settings can override the system theme); null until it starts. */
let darkOverride: boolean | null = null;

export function setDarkPalette(dark: boolean): void {
  darkOverride = dark;
}

export function currentPalette(): DiagramPalette {
  if (darkOverride !== null) return darkOverride ? DARK : LIGHT;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? DARK : LIGHT;
}

export const FONT_FAMILY = "Inter, 'Segoe UI', system-ui, -apple-system, sans-serif";
export const MONO_FAMILY = "'JetBrains Mono', 'Cascadia Code', Consolas, monospace";

export interface ZoneStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash: number[] | null;
  label: string;
}

/**
 * How a zone is drawn: a TableGroup dashed in its colour; a module not accepted yet tinted with
 * a solid border; the common and other tables of the Modules arrangement in neutral grey.
 */
export function zoneStyle(g: VGroup, p: DiagramPalette): ZoneStyle {
  if (g.role === "common" || g.role === "other") {
    return { fill: "rgba(127, 127, 127, 0.04)", stroke: p.tableBorder, strokeWidth: 1, dash: [2, 4], label: p.fieldType };
  }
  if (g.role === "proposed" && g.color) {
    return { fill: tint(g.color, 0.07), stroke: g.color, strokeWidth: 1.5, dash: null, label: g.color };
  }
  return { fill: p.groupFill, stroke: g.color ?? p.groupBorder, strokeWidth: 1, dash: [6, 4], label: g.color ?? p.groupLabel };
}

/** `#rrggbb` at the given opacity (anything else is returned as it is). */
function tint(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
