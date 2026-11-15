import type { Engine } from "./tauri-api.service";

/**
 * "Report a problem": a GitHub issue form (`.github/ISSUE_TEMPLATE/bug_report.yml`) prefilled
 * through its URL. Nothing is sent by the app: the browser shows the form, and the person reads
 * and submits it (or not). Only the versions and the kind of document open are filled in, never
 * the names of hosts, databases, schemas, tables or files.
 */

/** GitHub cuts long URLs; the error text is kept well under that. */
export const MAX_ERROR_CHARS = 1500;
const MAX_TITLE_CHARS = 80;

export interface ReportInfo {
  /** The app's version. */
  version: string | null;
  userAgent: string;
  /** `navigator.userAgentData` platformVersion when the WebView has it (tells Windows 11 apart). */
  platformVersion?: string | null;
  /** What is open, as a kind only (see `documentKind`). */
  opened: string | null;
  /** The error the app showed, when reporting from the error banner. */
  error?: string | null;
}

const ENGINE_LABEL: Record<Engine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  mssql: "SQL Server",
  sqlite: "SQLite",
};

/** The kind of document open, without its name: "PostgreSQL database", ".dbml file", "imported SQL". */
export function documentKind(source: { kind: "db"; engine: Engine } | { kind: "file"; path: string; dialect?: string } | null): string {
  if (!source) return "nothing open";
  if (source.kind === "db") return `${ENGINE_LABEL[source.engine]} database`;
  if (source.dialect) return "imported SQL script";
  return source.path ? ".dbml file" : "unsaved DBML";
}

/** The operating system from the user agent (Windows 10 and 11 both say NT 10.0). */
export function systemText(userAgent: string, platformVersion?: string | null): string {
  const win = /Windows NT (\d+\.\d+)/.exec(userAgent);
  if (win) {
    if (win[1] !== "10.0") return `Windows NT ${win[1]}`;
    const major = platformVersion ? parseInt(platformVersion, 10) : NaN;
    if (Number.isNaN(major)) return "Windows 10 or 11";
    return major >= 13 ? "Windows 11" : "Windows 10";
  }
  const mac = /Mac OS X ([\d_.]+)/.exec(userAgent);
  if (mac) return `macOS ${mac[1].replace(/_/g, ".")}`;
  if (/Linux/.test(userAgent)) return "Linux";
  return "unknown";
}

/** The web view the app runs in: WebView2 (Edge) on Windows, WebKit elsewhere. */
export function webviewText(userAgent: string): string {
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  if (edge) return `WebView2 ${edge[1]}`;
  const webkit = /AppleWebKit\/([\d.]+)/.exec(userAgent);
  return webkit ? `WebKit ${webkit[1]}` : "unknown";
}

/** The facts the form's Environment field gets. */
export function environmentText(info: ReportInfo): string {
  return [
    `xdiagram: ${info.version ?? "unknown"}`,
    `System: ${systemText(info.userAgent, info.platformVersion)}`,
    `Web view: ${webviewText(info.userAgent)}`,
    `Open: ${info.opened ?? "nothing open"}`,
  ].join("\n");
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}\n… (cut)` : text;
}

/** The URL of a new issue on `projectUrl` (`https://github.com/owner/repo`), with the form filled in. */
export function issueUrl(projectUrl: string, info: ReportInfo): string {
  const params = new URLSearchParams({ template: "bug_report.yml", labels: "bug" });
  const error = info.error?.trim();
  if (error) {
    const first = error.split("\n")[0].trim();
    params.set("title", cut(`Error: ${first}`, MAX_TITLE_CHARS).replace(/\n… \(cut\)$/, "…"));
    params.set(
      "what-happened",
      [
        "The app showed this error:",
        "",
        "```",
        cut(error, MAX_ERROR_CHARS),
        "```",
        "",
        "What I was doing:",
        "",
        "<!-- Before submitting, check the error above for anything private (names, addresses) and remove it. -->",
      ].join("\n"),
    );
  }
  if (info.version) params.set("version", info.version);
  params.set("environment", environmentText(info));
  return `${projectUrl.replace(/\/+$/, "")}/issues/new?${params}`;
}
