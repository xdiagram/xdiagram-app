import { DEFAULT_SETTINGS, normalizeSettings } from "./settings.service";

describe("settings", () => {
  it("fills defaults and clamps values", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    const s = normalizeSettings({ theme: "dark", editorFontSize: 99, queryTimeoutSecs: "30", profileSampleRows: 5, restoreSession: false, bogus: 1 });
    expect(s.theme).toBe("dark");
    expect(s.editorFontSize).toBe(24);
    expect(s.queryTimeoutSecs).toBe(30);
    expect(s.profileSampleRows).toBe(100);
    expect(s.restoreSession).toBe(false);
    expect(s.autoReloadFiles).toBe(true);
    expect(normalizeSettings({ theme: "neon" }).theme).toBe("system");
  });
});
