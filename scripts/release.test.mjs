// node --test scripts/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assetBaseFor, buildManifest, platformsOf } from './release.mjs';

test('maps installers to updater platforms', () => {
  assert.deepEqual(platformsOf('xdiagram_0.2.0_x64-setup.exe', 'x64'), ['windows-x86_64-nsis', 'windows-x86_64']);
  assert.deepEqual(platformsOf('xdiagram_0.2.0_x64_en-US.msi', 'x64'), ['windows-x86_64-msi']);
  assert.deepEqual(platformsOf('xdiagram.app.tar.gz', 'arm64'), ['darwin-aarch64-app', 'darwin-aarch64']);
  assert.deepEqual(platformsOf('notes.txt'), []);
});

test('builds the manifest with NSIS as the Windows default', () => {
  const m = buildManifest({
    version: '0.2.0',
    notes: 'Faster diagrams',
    date: new Date('2026-11-13T10:00:00.123Z'),
    arch: 'x64',
    assetBase: 'https://github.com/acme/xdiagram/releases/download/v0.2.0',
    artifacts: [
      { file: 'xdiagram_0.2.0_x64-setup.exe', signature: 'sig-nsis\n' },
      { file: 'xdiagram_0.2.0_x64_en-US.msi', signature: 'sig-msi' },
    ],
  });
  assert.equal(m.pub_date, '2026-11-13T10:00:00Z');
  assert.deepEqual(m.platforms['windows-x86_64'], {
    signature: 'sig-nsis',
    url: 'https://github.com/acme/xdiagram/releases/download/v0.2.0/xdiagram_0.2.0_x64-setup.exe',
  });
  assert.equal(m.platforms['windows-x86_64-msi'].signature, 'sig-msi');
  assert.throws(() => buildManifest({ version: '1', notes: '', date: new Date(), artifacts: [], assetBase: 'x' }));
});

test('derives the release asset folder from the endpoint', () => {
  assert.equal(
    assetBaseFor('https://github.com/acme/xdiagram/releases/latest/download/latest.json', '0.2.0'),
    'https://github.com/acme/xdiagram/releases/download/v0.2.0/',
  );
  assert.throws(() => assetBaseFor('https://example.com/feed.json', '1.0.0'));
});
