import type { ColumnProfile } from "../core/tauri-api.service";

/** Hides most of a value that looks personal: `a•••@example.com`, `+4•••••••67`. */
export function maskValue(v: string): string {
  const at = v.indexOf("@");
  if (at > 0) return `${v[0]}•••${v.slice(at)}`;
  if (v.length <= 4) return "•".repeat(v.length);
  return `${v.slice(0, 2)}${"•".repeat(Math.min(v.length - 4, 8))}${v.slice(-2)}`;
}

export function percent(part: number, whole: number): string {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  return p > 0 && p < 0.1 ? "<0.1%" : `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
}

/** One-line summary for tooltips: `12% null · 3,204 distinct`. */
export function profileSummary(c: ColumnProfile): string {
  const total = c.nulls + c.nonNull;
  const distinct = c.unique ? "all distinct" : `${c.distinctCapped ? "≥ " : ""}${c.distinct.toLocaleString("en-US")} distinct`;
  return `${percent(c.nulls, total)} null · ${distinct}${c.pii ? ` · personal data? (${c.pii})` : ""}`;
}
