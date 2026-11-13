import type * as MonacoNs from "monaco-editor";

import { loadDbmlCore, loadDbmlParse } from "../core/dbml";
import { offsetOf, type Range } from "../diagram/canvas-edit";
import { DBML_MODEL_URI, textModel } from "./text-model";

type Monaco = typeof MonacoNs;

export { DBML_MODEL_URI } from "./text-model";

/**
 * Text ranges of every usage of the symbol declared at `offset` (refs, indexes, inline refs),
 * via the same references service the editor uses. The declaration itself is not included.
 */
export async function findUsages(text: string, offset: number): Promise<Range[]> {
  const [core, parse] = await Promise.all([loadDbmlCore(), loadDbmlParse()]);
  const parser = new core.Parser();
  parser.setDbmlSource(core.DEFAULT_ENTRY, text);
  const model = textModel(text);
  const locations = new parse.DBMLReferencesProvider(parser.DBMLCompiler).provideReferences(
    model as never,
    model.getPositionAt(offset),
  ) as { range: MonacoNs.IRange }[] | undefined;
  return (locations ?? []).map((l) => ({
    start: offsetOf(text, l.range.startLineNumber, l.range.startColumn),
    end: offsetOf(text, l.range.endLineNumber, l.range.endColumn),
  }));
}

/**
 * DBML language services from `@dbml/parse`: completion, go-to-definition and find-references.
 * The providers query a compiler whose source must mirror the editor model, so `sync` is called
 * on every content change.
 */
export interface DbmlServices {
  sync(text: string): void;
  definitionAt(model: MonacoNs.editor.ITextModel, position: MonacoNs.IPosition): MonacoNs.languages.Location[];
  referencesAt(model: MonacoNs.editor.ITextModel, position: MonacoNs.IPosition): MonacoNs.languages.Location[];
  dispose(): void;
}

/** Completions computed elsewhere (the parse worker); null means "not available, do it here". */
export type RemoteCompletion = (
  text: string,
  position: MonacoNs.IPosition,
) => Promise<{ suggestions: unknown[]; incomplete?: boolean } | null>;

export async function registerDbmlServices(monaco: Monaco, remote?: RemoteCompletion): Promise<DbmlServices> {
  const [core, parse] = await Promise.all([loadDbmlCore(), loadDbmlParse()]);
  const parser = new core.Parser();
  const compiler = parser.DBMLCompiler;
  const sync = (text: string) => parser.setDbmlSource(core.DEFAULT_ENTRY, text);

  // Every tab has its own model; the compiler knows the document as DEFAULT_ENTRY, so the
  // providers see the active model under that URI.
  const mainUri = monaco.Uri.parse(DBML_MODEL_URI);
  const asMain = (model: MonacoNs.editor.ITextModel) =>
    model.uri.toString() === mainUri.toString() ? model : (Object.create(model, { uri: { value: mainUri } }) as MonacoNs.editor.ITextModel);

  const completion = new parse.DBMLCompletionItemProvider(compiler);
  const definition = new parse.DBMLDefinitionProvider(compiler);
  const references = new parse.DBMLReferencesProvider(compiler);

  // Results come back with the library's own URI objects; point them at the live model instead.
  type Loc = { range: MonacoNs.IRange };
  const relink = (model: MonacoNs.editor.ITextModel, locations: unknown): MonacoNs.languages.Location[] => {
    const list = (Array.isArray(locations) ? locations : locations ? [locations] : []) as Loc[];
    return list.filter((l) => l?.range).map((l) => ({ uri: model.uri, range: l.range }));
  };

  const guard = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      console.warn("DBML language service failed", err);
      return fallback;
    }
  };

  const disposables = [
    monaco.languages.registerCompletionItemProvider("dbml", {
      triggerCharacters: completion.triggerCharacters,
      // Completion compiles the whole document: on big schemas that takes ~100 ms per keystroke,
      // so it runs in the parse worker when there is one.
      provideCompletionItems: async (model, position) => {
        const fromWorker = remote ? await remote(model.getValue(), position).catch(() => null) : null;
        if (fromWorker) return fromWorker as MonacoNs.languages.CompletionList;
        return guard(
          () => completion.provideCompletionItems(asMain(model) as never, position) as unknown as MonacoNs.languages.CompletionList,
          { suggestions: [] },
        );
      },
    }),
    monaco.languages.registerDefinitionProvider("dbml", {
      provideDefinition: (model, position) => guard(() => relink(model, definition.provideDefinition(asMain(model) as never, position)), []),
    }),
    monaco.languages.registerReferenceProvider("dbml", {
      provideReferences: (model, position) => guard(() => relink(model, references.provideReferences(asMain(model) as never, position)), []),
    }),
  ];

  return {
    sync,
    definitionAt: (model, position) => guard(() => relink(model, definition.provideDefinition(asMain(model) as never, position)), []),
    referencesAt: (model, position) => guard(() => relink(model, references.provideReferences(asMain(model) as never, position)), []),
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

/**
 * The standalone Monaco build ships without the go-to-symbol UI, so the editor gets explicit
 * actions: F12 / Ctrl+click jump to the definition, Shift+F12 puts a cursor on every usage
 * (which doubles as "rename all": just type).
 */
export function addNavigationActions(
  monaco: Monaco,
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  services: DbmlServices,
): MonacoNs.IDisposable[] {
  const goToDefinition = (position: MonacoNs.IPosition | null) => {
    const model = editor.getModel();
    if (!model || !position) return;
    const target = services.definitionAt(model, position)[0];
    if (!target) return;
    const r = target.range;
    editor.setSelection({ startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.startLineNumber, endColumn: r.startColumn });
    editor.revealRangeInCenter(r);
    editor.focus();
  };
  return [
    editor.addAction({
      id: "dbml.goToDefinition",
      label: "Go to Definition",
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      run: (ed) => goToDefinition(ed.getPosition()),
    }),
    editor.addAction({
      id: "dbml.selectReferences",
      label: "Select All References",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 2,
      run: (ed) => {
        const model = ed.getModel();
        const position = ed.getPosition();
        if (!model || !position) return;
        const refs = services.referencesAt(model, position);
        if (refs.length === 0) return;
        ed.setSelections(
          refs.map((l) => ({
            selectionStartLineNumber: l.range.startLineNumber,
            selectionStartColumn: l.range.startColumn,
            positionLineNumber: l.range.endLineNumber,
            positionColumn: l.range.endColumn,
          })),
        );
        ed.revealRangeInCenter(refs[0].range);
      },
    }),
    editor.onMouseDown((e) => {
      const modifier = navigator.platform.toLowerCase().includes("mac") ? e.event.metaKey : e.event.ctrlKey;
      if (modifier && e.target.position && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
        e.event.preventDefault();
        goToDefinition(e.target.position);
      }
    }),
  ];
}
