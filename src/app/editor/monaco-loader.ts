import loader from "@monaco-editor/loader";
import type * as MonacoNs from "monaco-editor";

let pending: Promise<typeof MonacoNs> | null = null;

/**
 * Loads Monaco's AMD build from the app's own assets (copied from `monaco-editor/min/vs`
 * by angular.json), so the editor works offline and nothing is fetched from a CDN.
 */
export function loadMonaco(): Promise<typeof MonacoNs> {
  if (!pending) {
    const vs = new URL("assets/monaco/vs", document.baseURI).href;
    loader.config({ paths: { vs } });
    pending = loader.init() as unknown as Promise<typeof MonacoNs>;
  }
  return pending;
}
