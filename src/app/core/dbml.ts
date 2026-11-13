import type * as DbmlCore from "@dbml/core";
import type * as DbmlParse from "@dbml/parse";

let pending: Promise<typeof DbmlCore> | null = null;
let pendingParse: Promise<typeof DbmlParse> | null = null;

/**
 * `@dbml/core` is loaded lazily, as its own chunk. Its `Parser` statically references ANTLR
 * parsers for every SQL dialect (~17 MB minified) that tree-shaking cannot drop; keeping it out
 * of the initial bundle lets the UI paint immediately. Only import *types* from `@dbml/core`
 * elsewhere — a value import would pull it back into the main bundle.
 */
export function loadDbmlCore(): Promise<typeof DbmlCore> {
  pending ??= import("@dbml/core");
  return pending;
}

/** `@dbml/parse` (language services for the editor); already part of the core chunk's dependencies. */
export function loadDbmlParse(): Promise<typeof DbmlParse> {
  pendingParse ??= import("@dbml/parse");
  return pendingParse;
}
