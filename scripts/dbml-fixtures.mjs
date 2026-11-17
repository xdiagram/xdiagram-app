// Regenerates the expected DBML of the Rust DBML writer's tests (xdiagram-core/tests/dbml): each
// `<name>.json` schema is written to `<name>.dbml` by @dbml/core's importer.generateDbml, the
// function the app uses, so `cargo test` checks the Rust port against the real thing.
//
//   node scripts/dbml-fixtures.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importer } from '@dbml/core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'src-tauri', 'crates', 'xdiagram-core', 'tests', 'dbml');

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const schema = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  const out = path.join(dir, file.replace(/\.json$/, '.dbml'));
  writeFileSync(out, importer.generateDbml(schema));
  console.log(`${path.relative(root, out)}`);
}
