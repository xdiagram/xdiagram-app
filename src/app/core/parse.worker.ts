/// <reference lib="webworker" />
/**
 * Parses DBML and answers editor completions off the main thread (see `DbmlSession`), so typing
 * in a big schema never waits for the DBML compiler.
 */
import { DbmlSession } from "./dbml-session";
import type { ParseRequest, ParseResponse } from "./parse-protocol";

const session = new DbmlSession();
/** For `views`: other documents parse here, so the open document's state (lint, completion) stays. */
const scratch = new DbmlSession();

// Requests are queued and handled together: when several parses or completions pile up while
// one is running (fast typing), only the newest of each kind is worth doing.
const queue: ParseRequest[] = [];
let draining = false;

addEventListener("message", (event: MessageEvent<ParseRequest>) => {
  queue.push(event.data);
  if (!draining) {
    draining = true;
    setTimeout(drain, 0);
  }
});

function drain(): void {
  draining = false;
  const batch = queue.splice(0);
  // Lint and `views` requests are each wanted, so they are never skipped.
  const always = (req: ParseRequest) => req.kind === "lint" || req.kind === "views";
  const newest = new Map<string, number>();
  for (const req of batch) if (!always(req)) newest.set(req.kind, req.id);
  for (const req of batch) {
    if (!always(req) && newest.get(req.kind) !== req.id) postMessage({ kind: "skipped", id: req.id } satisfies ParseResponse);
    else postMessage(handle(req));
  }
}

function handle(req: ParseRequest): ParseResponse {
  const start = performance.now();
  const ms = () => Math.round((performance.now() - start) * 10) / 10;
  switch (req.kind) {
    case "lint":
      return { kind: "linted", id: req.id, findings: session.lint(req.rules), ms: ms() };
    case "complete":
      return { kind: "completed", id: req.id, list: session.complete(req.text, req.position), ms: ms() };
    case "views": {
      const views = req.texts.map((text) => {
        const r = scratch.parse(text);
        return r.ok ? r.view : null;
      });
      return { kind: "viewed", id: req.id, views, ms: ms() };
    }
    case "parse": {
      const r = session.parse(req.text);
      return r.ok
        ? { kind: "parsed", id: req.id, ok: true, view: r.view, ms: ms() }
        : { kind: "parsed", id: req.id, ok: false, diagnostics: r.diagnostics, ms: ms() };
    }
  }
}
