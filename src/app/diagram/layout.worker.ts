/// <reference lib="webworker" />
/**
 * ELK's own worker script: loaded in a worker it answers `elk-api`'s messages (see layout.ts),
 * so laying out hundreds of tables never freezes the window.
 */
import "elkjs/lib/elk-worker.min.js";
