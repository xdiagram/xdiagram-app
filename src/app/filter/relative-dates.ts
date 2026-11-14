import type { ColKind } from "../core/tauri-api.service";
import type { RelativePoint, Span } from "./model";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A local moment in the form the column's kind compares with. */
export function formatMoment(d: Date, kind: ColKind): string {
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (kind === "date") return date;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (kind !== "timestamptz") return `${date} ${time}`;
  // getTimezoneOffset is minutes *behind* UTC: +60 means UTC−01:00.
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${date}T${time}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Midnight (local) of `d`, shifted by `days` (DST-safe: built from the calendar fields). */
function day(d: Date, days = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** `[from, to)` of a period, as values for the column's kind. Weeks start on Monday. */
export function resolveSpan(span: Span, now: Date, kind: ColKind): [string, string] {
  let from: Date;
  let to: Date;
  if (typeof span === "object" && "day" in span) {
    const [y, m, d] = span.day.split("-").map(Number);
    from = new Date(y, m - 1, d);
    to = new Date(y, m - 1, d + 1);
  } else if (typeof span === "object") {
    from = day(now, 1 - Math.max(1, span.lastDays));
    to = day(now, 1);
  } else {
    switch (span) {
      case "today":
        [from, to] = [day(now), day(now, 1)];
        break;
      case "yesterday":
        [from, to] = [day(now, -1), day(now)];
        break;
      case "thisWeek": {
        const sinceMonday = (now.getDay() + 6) % 7;
        [from, to] = [day(now, -sinceMonday), day(now, 7 - sinceMonday)];
        break;
      }
      case "thisMonth":
        [from, to] = [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)];
        break;
      case "thisYear":
        [from, to] = [new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1)];
        break;
    }
  }
  return [formatMoment(from, kind), formatMoment(to, kind)];
}

/** A moment relative to now (`-7d`: seven days ago, to the second). */
export function resolvePoint(p: RelativePoint, now: Date, kind: ColKind): string {
  const d = new Date(now);
  switch (p.unit) {
    case "h":
      d.setHours(d.getHours() - p.ago);
      break;
    case "d":
      d.setDate(d.getDate() - p.ago);
      break;
    case "w":
      d.setDate(d.getDate() - 7 * p.ago);
      break;
    case "mo":
      d.setMonth(d.getMonth() - p.ago);
      break;
    case "y":
      d.setFullYear(d.getFullYear() - p.ago);
      break;
  }
  return formatMoment(d, kind);
}

export function spanLabel(span: Span): string {
  if (typeof span === "object") return "day" in span ? `on ${span.day}` : `last ${span.lastDays} days`;
  return { today: "today", yesterday: "yesterday", thisWeek: "this week", thisMonth: "this month", thisYear: "this year" }[span];
}

export function pointLabel(p: RelativePoint): string {
  const unit = { h: "hour", d: "day", w: "week", mo: "month", y: "year" }[p.unit];
  return `${p.ago} ${unit}${p.ago === 1 ? "" : "s"} ago`;
}

/** `-7d`, `-3h`, `-2w`, `-1mo`, `-1y` → a relative point. */
export function parsePoint(text: string): RelativePoint | null {
  const m = /^-(\d{1,4})(h|d|w|mo|y)$/i.exec(text.trim());
  return m ? { ago: Number(m[1]), unit: m[2].toLowerCase() as RelativePoint["unit"] } : null;
}

export function printPoint(p: RelativePoint): string {
  return `-${p.ago}${p.unit}`;
}
