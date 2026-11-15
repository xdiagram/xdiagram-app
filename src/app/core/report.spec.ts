import { MAX_ERROR_CHARS, documentKind, environmentText, issueUrl, systemText, webviewText } from "./report";

const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.80";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const REPO = "https://github.com/xdiagram/xdiagram-app";

const fields = (url: string): Record<string, string> => {
  const u = new URL(url);
  return { path: u.origin + u.pathname, ...Object.fromEntries(u.searchParams) };
};

describe("report a problem", () => {
  it("names the system and the web view", () => {
    expect(systemText(WIN, "15.0.0")).toBe("Windows 11");
    expect(systemText(WIN, "10.0.0")).toBe("Windows 10");
    expect(systemText(WIN)).toBe("Windows 10 or 11");
    expect(systemText(MAC)).toBe("macOS 14.5");
    expect(systemText("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(webviewText(WIN)).toBe("WebView2 142.0.3595.80");
    expect(webviewText(MAC)).toBe("WebKit 605.1.15");
  });

  it("says what is open without naming it", () => {
    expect(documentKind({ kind: "db", engine: "mssql" })).toBe("SQL Server database");
    expect(documentKind({ kind: "file", path: "C:\\secret\\payroll.dbml" })).toBe(".dbml file");
    expect(documentKind({ kind: "file", path: "", dialect: "mysql" })).toBe("imported SQL script");
    expect(documentKind(null)).toBe("nothing open");
  });

  it("opens the bug form with the versions filled in", () => {
    const url = issueUrl(`${REPO}/`, { version: "0.4.0", userAgent: WIN, platformVersion: "15.0.0", opened: "PostgreSQL database" });
    expect(fields(url)).toEqual({
      path: `${REPO}/issues/new`,
      template: "bug_report.yml",
      labels: "bug",
      version: "0.4.0",
      environment: "xdiagram: 0.4.0\nSystem: Windows 11\nWeb view: WebView2 142.0.3595.80\nOpen: PostgreSQL database",
    });
  });

  it("fills in the error from the banner, cut to a size GitHub accepts", () => {
    const error = `relation "orders" does not exist\nat line 3 & more: 50% done?\n${"x".repeat(3000)}`;
    const f = fields(issueUrl(REPO, { version: "0.4.0", userAgent: WIN, opened: null, error }));
    expect(f["title"]).toBe('Error: relation "orders" does not exist');
    expect(f["what-happened"]).toContain('```\nrelation "orders" does not exist\nat line 3 & more: 50% done?\n');
    expect(f["what-happened"]).toContain("… (cut)");
    expect(f["what-happened"]).toContain("check the error above for anything private");
    expect(f["what-happened"].length).toBeLessThan(MAX_ERROR_CHARS + 400);
    const long = fields(issueUrl(REPO, { version: null, userAgent: WIN, opened: null, error: "y".repeat(200) }));
    expect(long["title"].length).toBeLessThanOrEqual(81);
    expect(long["version"]).toBeUndefined();
  });

  it("never carries the names of what is open", () => {
    const source = { kind: "db" as const, engine: "postgres" as const, profileId: "p", label: "Payroll prod", detail: "db.internal.example:5432/payroll" };
    const url = issueUrl(REPO, { version: "0.4.0", userAgent: WIN, opened: documentKind(source) });
    for (const secret of ["Payroll", "payroll", "db.internal", "5432"]) expect(decodeURIComponent(url)).not.toContain(secret);
    expect(environmentText({ version: "0.4.0", userAgent: WIN, opened: documentKind(source) })).toContain("Open: PostgreSQL database");
  });
});
