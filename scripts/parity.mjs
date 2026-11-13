// Parity check: Rust introspection vs @dbml/connector (the reference implementation).
//
//   node scripts/parity.mjs "postgres://postgres:pw@localhost:5432/postgres" [schema1,schema2]
//   node scripts/parity.mjs --engine mysql "mysql://root:pw@localhost:3306/shop"
//   node scripts/parity.mjs --engine mssql "Server=localhost,1433;Database=shop;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=true" [schemas]
//
// Runs both against the same database, deep-diffs the schema JSON and the generated DBML.
// Exits non-zero on any difference.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import connectorPkg from '@dbml/connector';
import { importer, Parser } from '@dbml/core';

const { connector } = connectorPkg;

const argv = process.argv.slice(2);
const engine = argv[0] === '--engine' ? argv.splice(0, 2)[1] : 'postgres';
const [url, schemas = ''] = argv;
if (!url || !['postgres', 'mysql', 'mssql'].includes(engine)) {
  console.error('usage: node scripts/parity.mjs [--engine postgres|mysql|mssql] <connection> [schema1,schema2]');
  process.exit(2);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let refConnection = url;
if (schemas && engine === 'postgres') refConnection = `${url}${url.includes('?') ? '&' : '?'}schemas=${schemas}`;
if (schemas && engine === 'mssql') refConnection = `${url};schemas=${schemas}`;

const reference = await connector.fetchSchemaJson(refConnection, engine);
const rustArgs = ['run', '-q', '--example', 'dump_schema', '--', '--engine', engine, url, ...(schemas ? [schemas] : [])];
const rust = JSON.parse(
  execFileSync('cargo', rustArgs, { cwd: path.join(root, 'src-tauri'), maxBuffer: 1 << 28 }).toString(),
);

// Intentional differences in the Rust port, applied to both sides before comparing:
// - check constraints are ordered (the connector leaves the order to the planner): compare as sets;
// - refs pointing at tables outside the selected schemas are dropped (the connector keeps them,
//   which makes generateDbml throw "Can't find table");
// - indexes involving expressions are read per key position (the connector splits expressions on
//   commas and drops expression-only indexes), so they are excluded from the comparison;
// - SQL Server referential actions use DBML's spelling (`SET NULL`, not `SET_NULL`, which DBML rejects);
// - backtick-quoted identifiers inside expressions (MySQL CHECK clauses) are unquoted, because DBML
//   delimits expressions with backticks and the connector's output does not parse.
// Mirrors dispatch::dbml_safe_expr in the Rust port.
const dbmlSafeExpr = (expr) =>
  expr.replace(/`((?:``|[^`])*)`/g, (_, name) => {
    const n = name.replace(/``/g, '`');
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(n) ? n : `"${n.replace(/`/g, '').replace(/"/g, '""')}"`;
  });
const byName = (a, b) => `${a.name}|${a.expression}`.localeCompare(`${b.name}|${b.expression}`);
function normalize(schema) {
  const s = structuredClone(schema);
  const known = new Set(s.tables.map((t) => `${t.schemaName}.${t.name}`));
  s.refs = s.refs.filter((r) => r.endpoints.every((e) => known.has(`${e.schemaName}.${e.tableName}`)));
  for (const [key, list] of Object.entries(s.indexes ?? {})) {
    const kept = list.filter((idx) => idx.columns.every((c) => c.type === 'column'));
    if (kept.length) s.indexes[key] = kept;
    else delete s.indexes[key];
  }
  if (engine === 'mssql') {
    for (const r of s.refs) {
      if (r.onDelete) r.onDelete = r.onDelete.replace('_', ' ');
      if (r.onUpdate) r.onUpdate = r.onUpdate.replace('_', ' ');
    }
  }
  const fixChecks = (list = []) => list.forEach((c) => (c.expression = dbmlSafeExpr(c.expression)));
  Object.values(s.checks ?? {}).forEach(fixChecks);
  for (const table of Object.values(s.tableConstraints ?? {})) for (const col of Object.values(table)) fixChecks(col.checks);
  for (const f of Object.values(s.fields ?? {}).flat()) if (f.dbdefault?.type === 'expression') f.dbdefault.value = dbmlSafeExpr(f.dbdefault.value);
  for (const list of Object.values(s.checks ?? {})) list.sort(byName);
  for (const table of Object.values(s.tableConstraints ?? {})) {
    for (const col of Object.values(table)) col.checks?.sort(byName);
  }
  return s;
}

const diffs = [];
function diff(a, b, at = '$') {
  if (Object.is(a, b)) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(`${at}\n    connector: ${JSON.stringify(a)}\n    rust:      ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : `${at}.${k}`);
}

// The app feeds the raw Rust output to generateDbml, so that must always succeed.
let rawDbml;
try {
  rawDbml = importer.generateDbml(rust);
} catch (err) {
  console.log(`FAIL: generateDbml rejects the Rust output: ${err.message}`);
  process.exit(1);
}
// ...and the DBML it produces must parse back (that is what the editor and diagram do next).
try {
  new Parser().parse(rawDbml, 'dbmlv2');
} catch (err) {
  const first = (err.diags ?? [err])[0];
  console.log(`FAIL: the generated DBML does not parse: line ${first.location?.start?.line}: ${first.message}`);
  process.exit(1);
}
let referenceNote = '';
try {
  importer.generateDbml(reference);
} catch (err) {
  referenceNote = ` [@dbml/connector's own output fails: ${err.message.replace(/^Error: /, '')}]`;
}

diff(normalize(reference), normalize(rust));
const dbmlRef = importer.generateDbml(normalize(reference));
const dbmlRust = importer.generateDbml(normalize(rust));

const tables = rust.tables.length;
const refs = rust.refs.length;
const indexCount = Object.values(rust.indexes).flat().length;
if (diffs.length === 0 && dbmlRef === dbmlRust) {
  console.log(
    `OK: identical schema JSON and DBML (${tables} tables, ${refs} refs, ${rust.enums.length} enums, ` +
      `${indexCount} indexes; raw DBML ${rawDbml.split('\n').length} lines)${referenceNote}`,
  );
} else {
  console.log(`MISMATCH: ${diffs.length} JSON difference(s); DBML ${dbmlRef === dbmlRust ? 'identical' : 'differs'}`);
  for (const d of diffs.slice(0, 50)) console.log(' -', d);
  process.exit(1);
}
