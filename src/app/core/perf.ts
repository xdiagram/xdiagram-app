/**
 * Timings for the big-schema benchmark (`scripts/bench-big-schema.mjs`). Recorded as
 * `performance.measure("xd:<name>")` entries only while the benchmark sets
 * `globalThis.__xdPerf = true`; otherwise each call costs one property read.
 */
function enabled(): boolean {
  return (globalThis as { __xdPerf?: boolean }).__xdPerf === true;
}

export function timed<T>(name: string, fn: () => T): T {
  if (!enabled()) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    performance.measure(`xd:${name}`, { start, end: performance.now() });
  }
}

export async function timedAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    performance.measure(`xd:${name}`, { start, end: performance.now() });
  }
}
