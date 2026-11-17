/**
 * How to add xdiagram-mcp (installed next to the app) to an MCP client: the Claude Code command
 * and the JSON other clients (Claude Desktop, …) take in their configuration file.
 */

/** Runs in a terminal; `--scope user` makes it available in every project. */
export function claudeCodeCommand(serverPath: string): string {
  return `claude mcp add --scope user xdiagram -- "${serverPath}"`;
}

/** The `mcpServers` entry, e.g. for claude_desktop_config.json. */
export function mcpJsonConfig(serverPath: string): string {
  return JSON.stringify({ mcpServers: { xdiagram: { command: serverPath } } }, null, 2);
}
