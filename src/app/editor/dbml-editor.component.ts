import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type * as MonacoNs from "monaco-editor";

import { loadDbmlCore } from "../core/dbml";
import { ThemeService } from "../core/theme.service";
import { SettingsService } from "../persistence/settings.service";
import { DocumentParser } from "../core/document-parser";
import { TabsStore } from "../state/tabs.store";
import { WorkspaceStore } from "../state/workspace.store";
import { DBML_MODEL_URI, addNavigationActions, registerDbmlServices } from "./dbml-language";
import { loadMonaco } from "./monaco-loader";
import { diffRange } from "./text-diff";

type Monaco = typeof MonacoNs;

@Component({
  selector: "app-dbml-editor",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="title">DBML</span>
      @if (store.dirty()) {
        <span class="badge"
          [title]="store.source()?.kind === 'db'
            ? 'Edited: your DBML is kept for this database and merged with its changes on Refresh'
            : 'The DBML was edited after it was loaded'">edited</span>
      }
    </div>
    <div #host class="host"></div>
    @if (loadError(); as err) {
      <div class="load-error">Editor failed to load: {{ err }}</div>
    }
    @if (firstError(); as d) {
      <button type="button" class="problems" (click)="store.reveal(d.startLine, { focus: true })" title="Go to error">
        <span class="dot"></span>
        <span class="msg">Line {{ d.startLine }}: {{ d.message }}</span>
        @if (store.diagnostics().length > 1) {
          <span class="more">+{{ store.diagnostics().length - 1 }}</span>
        }
      </button>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--panel); }
    .head { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; flex: none;
      border-bottom: 1px solid var(--border); font-size: 12px; }
    .title { font-weight: 600; letter-spacing: 0.04em; color: var(--text-muted); }
    .badge { font-size: 11px; padding: 1px 6px; border-radius: 9px; background: var(--accent-soft); color: var(--accent); }
    .host { flex: 1; min-height: 0; }
    .load-error { padding: 12px; color: var(--danger); font-size: 12px; }
    .problems { display: flex; align-items: center; gap: 8px; flex: none; border: 0; border-top: 1px solid var(--border);
      background: var(--danger-soft); color: var(--danger); font: inherit; font-size: 12px; padding: 7px 12px;
      text-align: left; cursor: pointer; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); flex: none; }
    .msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .more { flex: none; opacity: 0.8; }
  `,
})
export class DbmlEditorComponent {
  protected readonly store = inject(WorkspaceStore);
  private readonly hostRef = viewChild.required<ElementRef<HTMLDivElement>>("host");

  protected readonly loadError = signal<string | null>(null);
  protected readonly firstError = computed(() => this.store.diagnostics()[0] ?? null);

  private readonly theme = inject(ThemeService);
  private readonly tabs = inject(TabsStore);
  private readonly parser = inject(DocumentParser);
  /** One model per tab: switching tabs keeps each document's undo history. */
  private readonly models = new Map<string, MonacoNs.editor.ITextModel>();
  private lang: Awaited<typeof services> | null = null;
  private readonly settings = inject(SettingsService);
  private monaco: Monaco | null = null;
  private editor: MonacoNs.editor.IStandaloneCodeEditor | null = null;
  /** Set once Monaco is up, so the effects below re-run then. */
  private readonly ready = signal(false);
  private applyingExternal = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => void this.init(destroyRef));

    // The active tab's model, and external changes (DB load, file open) flowing into it.
    effect(() => {
      const tabId = this.tabs.activeId();
      const text = this.store.dbml();
      if (this.ready()) untracked(() => this.show(tabId, text));
    });
    // Models of closed tabs go away.
    effect(() => {
      const open = new Set(this.tabs.tabs().map((t) => t.id));
      untracked(() => {
        for (const [id, model] of this.models) {
          if (!open.has(id)) {
            model.dispose();
            this.models.delete(id);
          }
        }
      });
    });

    effect(() => {
      const dark = this.theme.dark();
      if (this.ready()) untracked(() => this.monaco?.editor.setTheme(dark ? "vs-dark" : "vs"));
    });
    effect(() => {
      const fontSize = this.settings.settings().editorFontSize;
      if (this.ready()) untracked(() => this.editor?.updateOptions({ fontSize }));
    });

    effect(() => {
      const diags = this.store.diagnostics();
      untracked(() => this.applyMarkers(diags));
    });

    effect(() => {
      const req = this.store.revealRequest();
      if (!req) return;
      untracked(() => {
        const editor = this.editor;
        if (!editor) return;
        editor.setPosition({ lineNumber: req.line, column: 1 });
        editor.revealLineInCenter(req.line);
        if (!this.store.editorOpen()) return;
        // The pane may have just been shown: measure again before scrolling (and focusing).
        requestAnimationFrame(() => {
          editor.layout();
          editor.revealLineInCenter(req.line);
          if (req.focus) editor.focus();
        });
      });
    });
  }

  private async init(destroyRef: DestroyRef): Promise<void> {
    let monaco: Monaco;
    let tokens: MonacoNs.languages.IMonarchLanguage;
    try {
      const [m, core] = await Promise.all([loadMonaco(), loadDbmlCore()]);
      monaco = m;
      tokens = core.dbmlMonarchTokensProvider as MonacoNs.languages.IMonarchLanguage;
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : String(err));
      return;
    }
    this.monaco = monaco;
    registerDbml(monaco, tokens);

    // The model URI matches the file the DBML compiler knows (`DEFAULT_ENTRY`), so the language
    // services resolve positions against the same document.
    const model = this.modelFor(this.tabs.activeId(), this.store.dbml());
    services ??= registerDbmlServices(monaco, (text, position) => this.parser.complete(text, position)).catch((err) => {
      console.warn("DBML language services unavailable", err);
      return null;
    });
    const editor = monaco.editor.create(this.hostRef().nativeElement, {
      model,
      theme: this.theme.dark() ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: this.settings.settings().editorFontSize,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      tabSize: 2,
      insertSpaces: true,
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      fixedOverflowWidgets: true,
      // Completions come from the DBML language service; generic word guesses are just noise.
      wordBasedSuggestions: "off",
      padding: { top: 8 },
      placeholder: "// Connect to a database or type DBML here, e.g.\n// Table users {\n//   id int [pk]\n// }",
    } as MonacoNs.editor.IStandaloneEditorConstructionOptions);
    this.editor = editor;

    const lang = await services;
    this.lang = lang;
    lang?.sync(model.getValue());
    const navigation = lang ? addNavigationActions(monaco, editor, lang) : [];
    const sub = editor.onDidChangeModelContent(() => {
      const text = editor.getValue();
      lang?.sync(text);
      if (!this.applyingExternal) this.store.setDbml(text);
    });

    this.applyMarkers(this.store.diagnostics());
    const version = () => editor.getModel()?.getAlternativeVersionId() ?? null;
    this.store.editor = {
      applyEdit: (text) => this.applyEdit(text),
      versionId: version,
      undo: () => (editor.trigger("canvas", "undo", null), version()),
      redo: () => (editor.trigger("canvas", "redo", null), version()),
      checkpoint: () => editor.pushUndoStop(),
    };
    this.ready.set(true);

    destroyRef.onDestroy(() => {
      sub.dispose();
      navigation.forEach((d) => d.dispose());
      editor.dispose();
      for (const m of this.models.values()) m.dispose();
      this.models.clear();
      this.editor = null;
      this.store.editor = null;
    });
  }

  private modelFor(tabId: string, text: string): MonacoNs.editor.ITextModel {
    let model = this.models.get(tabId);
    if (!model) {
      const monaco = this.monaco!;
      // The first tab uses the compiler's own URI; the others their own (see dbml-language.ts).
      const uri = monaco.Uri.parse(this.models.size === 0 && !monaco.editor.getModel(monaco.Uri.parse(DBML_MODEL_URI)) ? DBML_MODEL_URI : `file:///tab-${tabId}.dbml`);
      monaco.editor.getModel(uri)?.dispose();
      model = monaco.editor.createModel(text, "dbml", uri);
      this.models.set(tabId, model);
    }
    return model;
  }

  /** Puts the tab's model in the editor and brings its text up to date. */
  private show(tabId: string, text: string): void {
    const editor = this.editor;
    if (!editor) return;
    const model = this.modelFor(tabId, text);
    if (editor.getModel() !== model) {
      editor.setModel(model);
      this.lang?.sync(model.getValue());
      this.applyMarkers(this.store.diagnostics());
    }
    if (model.getValue() !== text) {
      this.applyingExternal = true;
      model.setValue(text);
      this.applyingExternal = false;
      this.lang?.sync(text);
    }
  }

  /**
   * A programmatic edit (canvas, panels) as one undoable step touching only what changed.
   * Returns the model's version after it, for the canvas history.
   */
  private applyEdit(text: string): number | null {
    const model = this.editor?.getModel();
    if (!model) return null;
    const change = diffRange(model.getValue(), text);
    if (change) {
      const start = model.getPositionAt(change.start);
      const end = model.getPositionAt(change.end);
      model.pushStackElement();
      model.pushEditOperations(
        [],
        [{ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: change.text }],
        () => null,
      );
      model.pushStackElement();
    }
    return model.getAlternativeVersionId();
  }

  private applyMarkers(diags: ReturnType<WorkspaceStore["diagnostics"]>): void {
    const monaco = this.monaco;
    const model = this.editor?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      "dbml",
      diags.map((d) => ({
        startLineNumber: d.startLine,
        startColumn: d.startColumn,
        endLineNumber: d.endLine,
        endColumn: d.endColumn,
        message: d.message,
        severity: d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      })),
    );
  }
}

let registered = false;
let services: Promise<Awaited<ReturnType<typeof registerDbmlServices>> | null> | null = null;

function registerDbml(monaco: Monaco, tokens: MonacoNs.languages.IMonarchLanguage): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: "dbml", extensions: [".dbml"], aliases: ["DBML"] });
  monaco.languages.setMonarchTokensProvider("dbml", tokens);
  monaco.languages.setLanguageConfiguration("dbml", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: ["string", "comment"] },
      { open: '"', close: '"', notIn: ["string", "comment"] },
      { open: "`", close: "`", notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
    ],
  });
}
