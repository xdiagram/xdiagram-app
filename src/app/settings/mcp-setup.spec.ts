import { claudeCodeCommand, mcpJsonConfig } from "./mcp-setup";

describe("MCP client setup", () => {
  const path = "C:\\Program Files\\xdiagram\\xdiagram-mcp.exe";

  it("quotes the path in the Claude Code command", () => {
    expect(claudeCodeCommand(path)).toBe('claude mcp add --scope user xdiagram -- "C:\\Program Files\\xdiagram\\xdiagram-mcp.exe"');
  });

  it("writes JSON that parses back to the same path", () => {
    const text = mcpJsonConfig(path);
    expect(text).toContain("\\\\Program Files\\\\");
    expect(JSON.parse(text)).toEqual({ mcpServers: { xdiagram: { command: path } } });
  });
});
