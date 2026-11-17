// Builds the MCP server (src-tauri/crates/xdiagram-mcp) in release mode and puts it where
// Tauri's `externalBin` expects it, src-tauri/binaries/xdiagram-mcp-<target triple>[.exe], so
// the installers ship it next to xdiagram.exe (tauri.release.conf.json adds it to the bundle).
// scripts/release.mjs runs this before `tauri build`.
//
//   node scripts/build-mcp.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tauriDir = path.join(root, 'src-tauri');

/** The host target triple from `rustc -vV` output (`host: x86_64-pc-windows-msvc`). */
export function hostTriple(rustcVersion) {
  const m = /^host:\s*(\S+)$/m.exec(rustcVersion);
  if (!m) throw new Error('Cannot read the host target from `rustc -vV`');
  return m[1];
}

/** The file name Tauri looks for: `<name>-<triple>`, plus `.exe` on Windows targets. */
export function sidecarFile(name, triple) {
  return `${name}-${triple}${triple.includes('windows') ? '.exe' : ''}`;
}

export function buildMcp() {
  const triple = hostTriple(execFileSync('rustc', ['-vV']).toString());
  console.log('Building xdiagram-mcp (release)…');
  execFileSync('cargo', ['build', '--release', '-p', 'xdiagram-mcp'], { cwd: tauriDir, stdio: 'inherit' });
  const exe = triple.includes('windows') ? 'xdiagram-mcp.exe' : 'xdiagram-mcp';
  const dir = path.join(tauriDir, 'binaries');
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, sidecarFile('xdiagram-mcp', triple));
  const cargoTarget = process.env.CARGO_TARGET_DIR ? path.resolve(tauriDir, process.env.CARGO_TARGET_DIR) : path.join(tauriDir, 'target');
  copyFileSync(path.join(cargoTarget, 'release', exe), target);
  console.log(`Wrote ${path.relative(root, target)}`);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildMcp();
