// node --test scripts/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostTriple, sidecarFile } from './build-mcp.mjs';
import { tauriBuildArgs } from './release.mjs';

test('reads the host target triple', () => {
  const out = 'rustc 1.94.1 (e408947bf 2026-03-25)\nbinary: rustc\nhost: x86_64-pc-windows-msvc\nrelease: 1.94.1\n';
  assert.equal(hostTriple(out), 'x86_64-pc-windows-msvc');
  assert.throws(() => hostTriple('nothing here'));
});

test('names the sidecar as Tauri expects', () => {
  assert.equal(sidecarFile('xdiagram-mcp', 'x86_64-pc-windows-msvc'), 'xdiagram-mcp-x86_64-pc-windows-msvc.exe');
  assert.equal(sidecarFile('xdiagram-mcp', 'aarch64-apple-darwin'), 'xdiagram-mcp-aarch64-apple-darwin');
});

test('release builds bundle the MCP server, before any caller overrides', () => {
  assert.deepEqual(tauriBuildArgs(['--config', '{"version":"9.9.9"}']), [
    'build', '--config', 'src-tauri/tauri.release.conf.json', '--config', '{"version":"9.9.9"}',
  ]);
});
