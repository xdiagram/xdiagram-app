// Big-schema benchmark: a synthetic 300-table PostgreSQL schema, loaded and used in the running app.
//
//   node scripts/bench-big-schema.mjs setup [--dbml out.dbml]   create xdiagram_bench in the test container
//   node scripts/bench-big-schema.mjs run [--label name] [--out results.json]
//   node scripts/bench-big-schema.mjs drop                      drop xdiagram_bench
//
// `run` drives the dev app over the Chrome DevTools Protocol, so start it with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// It opens the schema in a new tab (your tabs are left alone), measures, then closes that tab.
//
// Environment: BENCH_CONTAINER (xdiagram-pg), BENCH_HOST (localhost), BENCH_PORT (55432),
// BENCH_USER (postgres), BENCH_PASSWORD (xdiagram), CDP_PORT (9222).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const env = (k, d) => process.env[k] ?? d;
const CONTAINER = env('BENCH_CONTAINER', 'xdiagram-pg');
const HOST = env('BENCH_HOST', 'localhost');
const PORT = Number(env('BENCH_PORT', '55432'));
const USER = env('BENCH_USER', 'postgres');
const PASSWORD = env('BENCH_PASSWORD', 'xdiagram');
const CDP_PORT = Number(env('CDP_PORT', '9222'));
const DB = 'xdiagram_bench';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

// ------------------------------------------------------------------ the schema

/** Deterministic PRNG, so every run benchmarks the same schema. */
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMAS = ['sales', 'inventory', 'hr', 'billing', 'support', 'analytics'];
const NOUNS = ['account', 'address', 'asset', 'batch', 'budget', 'campaign', 'category', 'channel', 'contract', 'country',
  'coupon', 'device', 'document', 'event', 'feature', 'invoice', 'item', 'job', 'ledger', 'license', 'location', 'message',
  'note', 'order', 'partner', 'payment', 'plan', 'policy', 'price', 'product', 'project', 'quote', 'region', 'report',
  'request', 'review', 'role', 'route', 'schedule', 'segment', 'session', 'shipment', 'skill', 'source', 'subscription',
  'supplier', 'task', 'team', 'ticket', 'warehouse'];
const COLUMNS = [
  ['name', 'varchar(120) NOT NULL'], ['code', 'varchar(32)'], ['status', "text NOT NULL DEFAULT 'new'"],
  ['amount', 'numeric(12,2)'], ['quantity', 'integer DEFAULT 0'], ['is_active', 'boolean NOT NULL DEFAULT true'],
  ['created_at', 'timestamptz NOT NULL DEFAULT now()'], ['updated_at', 'timestamptz'], ['notes', 'text'],
  ['external_id', 'uuid'], ['payload', 'jsonb'], ['valid_from', 'date'], ['valid_to', 'date'], ['priority', 'smallint'],
  ['score', 'double precision'], ['email', 'varchar(255)'], ['phone', 'varchar(40)'], ['currency', 'char(3)'],
  ['weight_kg', 'numeric(8,3)'], ['tags', 'text[]'],
];

/** 6 schemas × 50 tables, 9–15 columns each, ~420 foreign keys (mostly within a schema). */
export function benchSchemaSql() {
  const rand = rng(20261113);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const tables = [];
  const out = [];
  for (const schema of SCHEMAS) {
    out.push(`CREATE SCHEMA ${schema};`);
    for (let i = 0; i < 50; i++) tables.push({ schema, name: `${NOUNS[i]}s`, index: tables.length });
  }
  let refs = 0;
  for (const t of tables) {
    const cols = ['  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY'];
    const used = new Set(['id']);
    const extra = 8 + Math.floor(rand() * 7);
    for (let k = 0; k < extra; k++) {
      const [name, type] = pick(COLUMNS);
      if (used.has(name)) continue;
      used.add(name);
      cols.push(`  ${name} ${type}`);
    }
    const fkCount = t.index === 0 ? 0 : pick([0, 1, 1, 1, 2, 2, 3]);
    const fks = [];
    for (let k = 0; k < fkCount; k++) {
      const sameSchema = tables.filter((o) => o.schema === t.schema && o.index < t.index);
      const pool = rand() < 0.8 && sameSchema.length ? sameSchema : tables.filter((o) => o.index < t.index);
      const target = pick(pool);
      const col = `${target.name.replace(/s$/, '')}_id`;
      if (used.has(col)) continue;
      used.add(col);
      cols.push(`  ${col} bigint${rand() < 0.6 ? ' NOT NULL' : ''} REFERENCES ${target.schema}.${target.name}(id)`);
      fks.push(col);
      refs++;
    }
    out.push(`CREATE TABLE ${t.schema}.${t.name} (\n${cols.join(',\n')}\n);`);
    for (const col of fks) if (rand() < 0.5) out.push(`CREATE INDEX ON ${t.schema}.${t.name} (${col});`);
    if (rand() < 0.3) out.push(`COMMENT ON TABLE ${t.schema}.${t.name} IS 'Synthetic ${t.name} table for the benchmark';`);
  }
  return { sql: out.join('\n') + '\n', tables: tables.length, refs };
}

function psql(args, input) {
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', USER, ...args], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
  });
}

async function setup() {
  const { sql, tables, refs } = benchSchemaSql();
  psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]);
  psql(['-c', `CREATE DATABASE ${DB}`]);
  psql(['-d', DB], sql);
  console.log(`created ${DB}: ${tables} tables, ${refs} foreign keys (container ${CONTAINER})`);
  const dbmlOut = opt('dbml');
  if (dbmlOut) {
    const { importer } = await import('@dbml/core');
    writeFileSync(dbmlOut, importer.import(sql.replace(/^CREATE (SCHEMA|INDEX ON) .*$/gm, ''), 'postgres'));
    console.log(`wrote ${dbmlOut}`);
  }
}

function drop() {
  psql(['-c', `DROP DATABASE IF EXISTS ${DB}`]);
  console.log(`dropped ${DB}`);
}

// ------------------------------------------------------------------ CDP

async function cdp() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('No app page on the CDP port; is `tauri dev` running with remote debugging?');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'page error');
    return res.result?.result?.value;
  };
  const mouse = (type, x, y, buttons = 0) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: buttons ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  return { send, evaluate, mouse, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page-side helpers (installed once per page load). */
const PAGE_HELPERS = `(() => {
  if (window.__bench) return true;
  const root = () => ng.getComponent(document.querySelector('app-root'));
  const diag = () => ng.getComponent(document.querySelector('app-diagram'));
  const frames = { list: [], on: false, last: 0 };
  const tick = (t) => { if (!frames.on) return; frames.list.push(t - frames.last); frames.last = t; requestAnimationFrame(tick); };
  window.__bench = {
    root, diag,
    startFrames() { frames.list = []; frames.on = true; frames.last = performance.now(); requestAnimationFrame(tick); },
    stopFrames() { frames.on = false; return frames.list.slice(1); },
    idle: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0)))),
    measures() {
      const out = {};
      for (const m of performance.getEntriesByType('measure')) {
        if (!m.name.startsWith('xd:')) continue;
        const k = m.name.slice(3);
        (out[k] ??= []).push(m.duration);
      }
      performance.clearMeasures();
      return out;
    },
    /** Times every Konva layer draw (the actual canvas painting). */
    patchDraw() {
      const layer = diag().layer;
      if (layer.__benchPatched) return;
      const orig = layer.drawScene.bind(layer);
      layer.drawScene = (...args) => {
        if (!globalThis.__xdPerf) return orig(...args);
        const t = performance.now();
        try { return orig(...args); } finally { performance.measure('xd:draw', { start: t, end: performance.now() }); }
      };
      layer.__benchPatched = true;
    },
    point(x, y) {
      const d = diag(), s = d.stage, r = document.querySelector('app-diagram').getBoundingClientRect();
      return { x: Math.round(r.left + s.x() + x * s.scaleX()), y: Math.round(r.top + s.y() + y * s.scaleY()) };
    },
  };
  return true;
})()`;

function stats(list) {
  if (!list?.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (v) => Math.round(v * 10) / 10;
  return { n: s.length, total: r(s.reduce((a, b) => a + b, 0)), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) };
}

async function run() {
  const c = await cdp();
  const { evaluate, mouse, send } = c;
  const results = { label: opt('label') ?? 'run', at: new Date().toISOString() };
  await evaluate(PAGE_HELPERS);

  // --- load: connect in a fresh tab, from scratch (no saved layout)
  results.load = await evaluate(`(async () => {
    const b = window.__bench, root = b.root(), s = root.store;
    root.connectOpen?.set(false); // e.g. a sign-in prompt from session restore
    await b.idle();
    if (document.querySelector('.backdrop')) throw new Error('Close the open dialog in the app first');
    root.tabs.newTab();
    await b.idle();
    const key = 'db:${HOST}:${PORT}/${DB}';
    await s.layouts.store.delete(key); await s.layouts.store.save();
    await s.profiles.load();
    const profile = { id: 'bench-' + Date.now(), name: 'bench (${DB})', engine: 'postgres', host: '${HOST}', port: ${PORT},
      database: '${DB}', user: '${USER}', sslMode: 'disable', schemas: [], path: '', trustCert: false };
    b.patchDraw();
    performance.clearMeasures();
    globalThis.__xdPerf = true;
    const heap0 = performance.memory?.usedJSHeapSize ?? 0;
    const t0 = performance.now();
    const ok = await s.connect(profile, ${JSON.stringify(PASSWORD)}, false);
    const d = b.diag();
    for (let i = 0; i < 400 && !(d.tableViews.size > 0 && Object.keys(s.positions()).length >= s.view().tables.length); i++) await new Promise((r) => setTimeout(r, 25));
    await b.idle();
    const firstDiagram = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    return { ok, error: s.error(), tables: s.view().tables.length, refs: s.view().refs.length, firstDiagramMs: Math.round(firstDiagram),
      konvaNodes: d.layer.find(() => true).length, heapMB: Math.round(((performance.memory?.usedJSHeapSize ?? 0) - heap0) / 1e6), marks: b.measures() };
  })()`);
  if (!results.load.ok) throw new Error(`Could not load ${DB}: ${results.load.error}`);

  // --- interactions at two zoom levels: fit-to-screen (all 300 tables) and 100% around a busy table
  const busiest = await evaluate(`(() => {
    const v = window.__bench.root().store.view(), count = new Map();
    for (const r of v.refs) for (const t of [r.from.table, r.to.table]) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0][0];
  })()`);

  for (const zoom of ['fit', '100%']) {
    await evaluate(`(async () => {
      const b = window.__bench, d = b.diag();
      ${zoom === 'fit' ? 'd.fit();' : `d.focusTable(${JSON.stringify(busiest)}); d.applyViewport({ x: d.stage.x(), y: d.stage.y(), scale: 1 }); d.focusTable(${JSON.stringify(busiest)});`}
      await new Promise((r) => setTimeout(r, 400)); await b.idle(); b.measures(); return true;
    })()`);
    const r = (results[zoom] = { scale: await evaluate(`Math.round(window.__bench.diag().stage.scaleX() * 100) / 100`) });

    // hover: sweep the pointer over table headers and rows
    const pts = await evaluate(`(() => {
      const b = window.__bench, d = b.diag(), host = document.querySelector('app-diagram').getBoundingClientRect(), out = [];
      for (const box of d.scene.tables.values()) {
        for (const dy of [17, 34 + 13, 34 + 26 + 13]) {
          const p = b.point(box.x + box.w / 2, box.y + dy);
          if (p.x > host.left + 10 && p.x < host.right - 10 && p.y > host.top + 10 && p.y < host.bottom - 60) out.push(p);
        }
        if (out.length >= 90) break;
      }
      return out;
    })()`);
    await evaluate('window.__bench.startFrames()');
    for (const p of pts) {
      await mouse('mouseMoved', p.x, p.y);
      await sleep(16);
    }
    await evaluate('window.__bench.idle()');
    r.hover = { frames: stats(await evaluate('window.__bench.stopFrames()')), marks: await evaluate('window.__bench.measures()') };

    // drag the busiest table's header 300 px right and 120 px down in 40 steps
    const from = await evaluate(`(() => { const d = window.__bench.diag(), box = d.scene.tables.get(${JSON.stringify(busiest)}); return window.__bench.point(box.x + Math.min(60, box.w / 3), box.y + 12); })()`);
    await mouse('mouseMoved', from.x, from.y);
    await sleep(50);
    await evaluate('window.__bench.measures(); window.__bench.startFrames()');
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= 40; i++) {
      await mouse('mouseMoved', from.x + (300 * i) / 40, from.y + (120 * i) / 40, 1);
      await sleep(16);
    }
    await mouse('mouseReleased', from.x + 300, from.y + 120);
    await sleep(100);
    await evaluate('window.__bench.idle()');
    r.drag = { frames: stats(await evaluate('window.__bench.stopFrames()')), marks: await evaluate('window.__bench.measures()') };
    // put it back (one undoable step) so both zoom levels start from the same layout
    await evaluate(`(async () => { window.__bench.root().store.undoCanvas(); await window.__bench.idle(); window.__bench.measures(); return true; })()`);

    // pan: wheel-scroll the canvas
    const mid = await evaluate(`(() => { const r = document.querySelector('app-diagram').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await evaluate('window.__bench.startFrames()');
    for (let i = 0; i < 30; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: 0, deltaY: i < 15 ? 40 : -40 });
      await sleep(16);
    }
    await evaluate('window.__bench.idle()');
    r.pan = { frames: stats(await evaluate('window.__bench.stopFrames()')), marks: await evaluate('window.__bench.measures()') };
  }

  // --- typing in the editor: a new column in the busiest table, one key at a time
  results.typing = await evaluate(`(async () => {
    const b = window.__bench, s = b.root().store;
    window.__benchEditorWasOpen = s.editorOpen();
    s.setEditorOpen(true);
    await new Promise((r) => setTimeout(r, 400));
    const ed = monaco.editor.getEditors()[0], model = ed.getModel();
    const table = s.view().tables.find((t) => t.id === ${JSON.stringify(busiest)});
    const line = model.getLineContent(table.line + 1) !== undefined ? table.line + 1 : table.line;
    ed.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
    ed.focus();
    b.measures();
    // Input latency: from each typed character to the next frame (Event Timing ignores CDP input).
    window.__benchLatency = [];
    window.__benchInput = (e) => { const t0 = e.timeStamp; requestAnimationFrame(() => window.__benchLatency.push(performance.now() - t0)); };
    for (const type of ['keydown', 'input']) document.addEventListener(type, window.__benchInput, true);
    // Frames over 50 ms, with the scripts that made them long.
    window.__benchLong = [];
    window.__benchObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__benchLong.push({ ms: Math.round(e.duration), scripts: (e.scripts ?? []).sort((a, b) => b.duration - a.duration).slice(0, 3)
        .map((x) => \`\${Math.round(x.duration)}ms \${x.invoker} \${x.sourceFunctionName || ''} \${(x.sourceURL || '').split('/').pop()}:\${x.sourceCharPosition}\`) });
    });
    window.__benchObserver.observe({ type: 'long-animation-frame' });
    return true;
  })()`);
  await evaluate('window.__bench.startFrames()');
  const typed = '\n  bench_col integer';
  const keyTimes = [];
  for (const ch of typed) {
    const t = performance.now();
    if (ch === '\n') await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    else await send('Input.insertText', { text: ch });
    if (ch === '\n') await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    keyTimes.push(performance.now() - t);
    await sleep(80);
  }
  const updated = await evaluate(`(async () => {
    const s = window.__bench.root().store, t0 = performance.now();
    for (let i = 0; i < 200 && !s.view().tables.some((t) => t.fields.some((f) => f.name === 'bench_col')); i++) await new Promise((r) => setTimeout(r, 10));
    await window.__bench.idle();
    return Math.round(performance.now() - t0);
  })()`);
  const typingInfo = await evaluate(`(() => {
    window.__benchObserver.disconnect();
    for (const type of ['keydown', 'input']) document.removeEventListener(type, window.__benchInput, true);
    return { latency: window.__benchLatency, long: window.__benchLong };
  })()`);
  results.typing = {
    keystroke: stats(keyTimes),
    /** From a typed character to the next frame. */
    inputLatency: stats(typingInfo.latency),
    /** Frames over 50 ms while typing and re-parsing, with their main scripts. */
    longFrames: typingInfo.long,
    diagramUpdatedMsAfterLastKey: updated,
    frames: stats(await evaluate('window.__bench.stopFrames()')),
    marks: await evaluate('window.__bench.measures()'),
  };

  // --- clean up: close the bench tab without keeping its edits or layout
  await evaluate(`(async () => {
    const root = window.__bench.root(), s = root.store;
    globalThis.__xdPerf = false;
    s.baseline.set(s.dbml());
    await root.tabs.close(root.tabs.activeId());
    s.setEditorOpen(window.__benchEditorWasOpen ?? s.editorOpen());
    await s.layouts.flush();
    await s.layouts.store.delete('db:${HOST}:${PORT}/${DB}'); await s.layouts.store.save();
    return true;
  })()`);
  c.close();

  for (const k of Object.keys(results)) {
    const v = results[k];
    if (v?.marks) v.marks = Object.fromEntries(Object.entries(v.marks).map(([m, list]) => [m, stats(list)]));
    for (const sub of ['hover', 'drag', 'pan']) {
      if (v?.[sub]?.marks) v[sub].marks = Object.fromEntries(Object.entries(v[sub].marks).map(([m, list]) => [m, stats(list)]));
    }
  }
  const out = opt('out');
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  printSummary(results);
}

function printSummary(r) {
  const L = r.load;
  const m = (marks, k) => (marks?.[k] ? `${marks[k].total} ms${marks[k].n > 1 ? ` (${marks[k].n}×)` : ''}` : '–');
  console.log(`\n${r.label}: ${L.tables} tables, ${L.refs} refs, ${L.konvaNodes} Konva nodes, +${L.heapMB} MB heap`);
  console.log(`  first diagram     ${L.firstDiagramMs} ms`);
  for (const k of ['introspect', 'generateDbml', 'parse', 'viewModel', 'lint', 'layout', 'render', 'draw']) console.log(`    ${k.padEnd(14)} ${m(L.marks, k)}`);
  for (const z of ['fit', '100%']) {
    const Z = r[z];
    console.log(`  at ${z} (scale ${Z.scale})`);
    for (const k of ['hover', 'drag', 'pan']) {
      const f = Z[k].frames;
      console.log(`    ${k.padEnd(6)} frames p50 ${f?.p50} ms, p95 ${f?.p95} ms, max ${f?.max} ms   draw ${m(Z[k].marks, 'draw')}`);
    }
  }
  const T = r.typing;
  console.log(`  typing   input→frame p50 ${T.inputLatency?.p50} ms / max ${T.inputLatency?.max} ms, long frames ${T.longFrames.length}, frames p95 ${T.frames?.p95} ms / max ${T.frames?.max} ms, diagram updated ${T.diagramUpdatedMsAfterLastKey} ms after the last key`);
  console.log(`    ${Object.keys(T.marks ?? {}).map((k) => `${k} ${m(T.marks, k)}`).join(', ')}`);
}

if (cmd === 'setup') await setup();
else if (cmd === 'drop') drop();
else if (cmd === 'run') await run();
else {
  console.error('usage: node scripts/bench-big-schema.mjs setup [--dbml out.dbml] | run [--label name] [--out file.json] | drop');
  process.exit(2);
}
