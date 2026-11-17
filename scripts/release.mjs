// Builds signed installers and the update manifest (latest.json) for a GitHub Release.
//
//   node scripts/release.mjs [--notes "What changed"] [--skip-build] [--asset-base URL] [-- <tauri build args>]
//
// The update signing key is read from %USERPROFILE%\.tauri\xdiagram-updater.key and its password
// from xdiagram-updater.password next to it (override with XDIAGRAM_UPDATER_KEY /
// XDIAGRAM_UPDATER_PASSWORD_FILE). They are passed to `tauri build` through the environment and
// never printed. Keep a copy of both in a password manager: without them, installed copies can
// no longer be updated.
//
// The MCP server (xdiagram-mcp) is built first (scripts/build-mcp.mjs) and bundled next to the
// app by src-tauri/tauri.release.conf.json, which only release builds use.
//
// Upload the installers, their .sig files and latest.json to the release tagged v<version>.
// latest.json points at https://github.com/<owner>/<repo>/releases/download/v<version>/<file>,
// derived from plugins.updater.endpoints in tauri.conf.json (or --asset-base).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMcp } from './build-mcp.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Updater platform keys for a bundle file name (see tauri-plugin-updater). */
export function platformsOf(file, arch = process.arch) {
  const cpu = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[arch] ?? arch;
  if (file.endsWith('-setup.exe')) return [`windows-${cpu}-nsis`, `windows-${cpu}`];
  if (file.endsWith('.msi')) return [`windows-${cpu}-msi`];
  if (file.endsWith('.app.tar.gz')) return [`darwin-${cpu}-app`, `darwin-${cpu}`];
  if (file.endsWith('.AppImage')) return [`linux-${cpu}-appimage`, `linux-${cpu}`];
  if (file.endsWith('.deb')) return [`linux-${cpu}-deb`];
  if (file.endsWith('.rpm')) return [`linux-${cpu}-rpm`];
  return [];
}

/**
 * The manifest the updater reads. `artifacts` are { file, signature } pairs; the first artifact
 * claiming a generic key (e.g. `windows-x86_64`) keeps it, so list the preferred installer first.
 */
export function buildManifest({ version, notes, date, artifacts, assetBase, arch }) {
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  const platforms = {};
  for (const { file, signature } of artifacts) {
    for (const key of platformsOf(file, arch)) {
      platforms[key] ??= { signature: signature.trim(), url: base + encodeURIComponent(file) };
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error('No signed installers found');
  return { version, notes, pub_date: date.toISOString().replace(/\.\d{3}Z$/, 'Z'), platforms };
}

/** `tauri build` arguments: the release config (it bundles xdiagram-mcp) first, so callers' own
 * `--config` overrides still win. */
export function tauriBuildArgs(passThrough) {
  return ['build', '--config', 'src-tauri/tauri.release.conf.json', ...passThrough];
}

/** GitHub release asset folder from the manifest endpoint: …/releases/latest/download/latest.json. */
export function assetBaseFor(endpoint, version) {
  const m = /^(https?:\/\/.+\/releases)\/latest\/download\/[^/]+$/.exec(endpoint ?? '');
  if (!m) throw new Error(`Cannot derive the asset URL from ${endpoint}; pass --asset-base`);
  return `${m[1]}/download/v${version}/`;
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const passThrough = sep >= 0 ? argv.slice(sep + 1) : [];
  const opt = (name) => {
    const i = own.indexOf(`--${name}`);
    return i >= 0 ? own[i + 1] : undefined;
  };

  const conf = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  // `--config` overrides passed through to tauri (e.g. a version for a test build) count here too.
  const cfgIdx = passThrough.indexOf('--config');
  const override = cfgIdx >= 0 ? JSON.parse(passThrough[cfgIdx + 1]) : {};
  const version = override.version ?? conf.version;
  const endpoint = override.plugins?.updater?.endpoints?.[0] ?? conf.plugins?.updater?.endpoints?.[0];

  if (!own.includes('--skip-build')) {
    const keyFile = process.env.XDIAGRAM_UPDATER_KEY ?? path.join(homedir(), '.tauri', 'xdiagram-updater.key');
    const pwFile = process.env.XDIAGRAM_UPDATER_PASSWORD_FILE ?? path.join(homedir(), '.tauri', 'xdiagram-updater.password');
    if (!existsSync(keyFile)) throw new Error(`Update signing key not found at ${keyFile}`);
    const env = {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, 'utf8').trim(),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: existsSync(pwFile) ? readFileSync(pwFile, 'utf8').trim() : '',
    };
    buildMcp();
    console.log(`Building xdiagram ${version} (signed)…`);
    execFileSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...tauriBuildArgs(passThrough)], {
      cwd: root, env, stdio: 'inherit',
    });
  }

  const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
  const artifacts = [];
  // NSIS first: it is the Windows default (installMode "passive" applies to it).
  for (const kind of ['nsis', 'msi', 'macos', 'appimage', 'deb', 'rpm']) {
    const dir = path.join(bundleDir, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.sig') || !f.includes(`_${version}_`)) continue;
      const file = f.slice(0, -4);
      artifacts.push({ file, path: path.join(dir, file), signature: readFileSync(path.join(dir, f), 'utf8') });
    }
  }
  const manifest = buildManifest({
    version,
    notes: opt('notes') ?? `xdiagram ${version}`,
    date: new Date(),
    artifacts,
    assetBase: opt('asset-base') ?? assetBaseFor(endpoint, version),
  });
  const out = path.join(bundleDir, 'latest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(root, out)} for ${Object.keys(manifest.platforms).join(', ')}.`);
  console.log('Upload to the release:');
  for (const a of artifacts) console.log(`  ${path.relative(root, a.path)}  (+ .sig)`);
  console.log(`  ${path.relative(root, out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
