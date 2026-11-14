import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import Konva from "konva";

import { timed } from "../core/perf";
import type { RelationCheck } from "../core/tauri-api.service";
import type { Point, Viewport } from "../persistence/layout.service";
import { BrowserStore } from "../state/browser.store";
import { CanvasActions } from "../state/canvas-actions";
import { LintStore } from "../state/lint.store";
import { QueryStore } from "../state/query.store";
import { ThemeService } from "../core/theme.service";
import { profileSummary } from "../data/profile-format";
import { WorkloadStore } from "../state/workload.store";
import { DiagramHandle, WorkspaceStore } from "../state/workspace.store";
import { CanvasMenuAction, CanvasMenuComponent, CanvasMenuState } from "./context-menu.component";
import { MinimapComponent } from "./minimap.component";
import {
  BADGE_W,
  EdgeRoute,
  GROUP_LABEL_H,
  GroupBox,
  HEADER_H,
  PAD_X,
  ROW_H,
  type Rect,
  Scene,
  TableBox,
  buildScene,
  DetailLevel,
  edgeStrokeWidth,
  markerSegments,
  normalizeRect,
  routeAll,
  rowCenterY,
  sceneBounds,
  tablesInRect,
  textWidth,
  TYPE_FONT,
} from "./geometry";
import { sceneToSvg } from "./svg-export";
import { DiagramPalette, FONT_FAMILY, LIGHT, MONO_FAMILY, currentPalette } from "./theme";
import { displayTable, relatedTables, type VField, type VRef, type VTable, type ViewModel } from "./view-model";

interface Tooltip {
  x: number;
  y: number;
  title: string;
  lines: string[];
  note: string | null;
}

interface Evidence {
  x: number;
  y: number;
  ref: VRef;
}

/** In-place rename input, positioned over the table header or column row (host pixels). */
interface InlineEdit {
  kind: "table" | "column";
  tableId: string;
  field: VField | null;
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

interface ColumnForm {
  tableId: string;
  label: string;
  x: number;
  y: number;
}

interface FieldEnd {
  table: string;
  field: string;
}

const COLUMN_TYPES = [
  "integer", "bigint", "smallint", "serial", "bigserial", "numeric(10,2)", "real", "double precision", "boolean",
  "varchar(255)", "text", "char(1)", "uuid", "date", "time", "timestamp", "timestamptz", "interval", "json", "jsonb", "bytea",
];

const MIN_SCALE = 0.02;
const MAX_SCALE = 3;
const GRID = 24;
/** Width reserved in the header for the live rate / idle tag. */
const RATE_SLOT_W = 118;

@Component({
  selector: "app-diagram",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CanvasMenuComponent, MinimapComponent],
  template: `
    <div #host class="host"></div>
    @if (inlineEdit(); as ie) {
      <input #inlineInput class="inline-edit" [class.header]="ie.kind === 'table'" [value]="ie.value"
        [style.left.px]="ie.x" [style.top.px]="ie.y" [style.width.px]="ie.w" [style.height.px]="ie.h"
        [style.font-size.px]="ie.fontSize" (keydown)="onInlineKey($event)" (blur)="commitInline()"
        spellcheck="false" autocomplete="off" [attr.aria-label]="ie.kind === 'table' ? 'Table name' : 'Column name'" />
    }
    @if (columnForm(); as cf) {
      <form class="col-form" [style.left.px]="cf.x" [style.top.px]="cf.y" (submit)="submitColumn($event)"
        (keydown.escape)="columnForm.set(null)">
        <div class="cf-title">Add column to {{ cf.label }}</div>
        <input #colName name="name" placeholder="name" autocomplete="off" spellcheck="false" aria-label="Column name" />
        <input name="type" placeholder="type" list="xd-col-types" value="varchar(255)" autocomplete="off"
          spellcheck="false" aria-label="Column type" />
        <datalist id="xd-col-types">
          @for (t of columnTypes; track t) {
            <option [value]="t"></option>
          }
        </datalist>
        <div class="cf-actions">
          <button type="button" (click)="columnForm.set(null)">Cancel</button>
          <button type="submit" class="primary">Add</button>
        </div>
      </form>
    }
    @if (menu(); as m) {
      <app-canvas-menu [state]="m" (action)="onMenuAction($event)" (closed)="menu.set(null)" />
    }
    @if (store.view().tables.length === 0) {
      <div class="empty">
        <p class="empty-title">No diagram yet</p>
        <p>Connect to a database (PostgreSQL, MySQL, SQL Server or SQLite), open a <code>.dbml</code> file, or start typing DBML in the editor.</p>
      </div>
    }
    @if (workload.enabled()) {
      <div class="legend" aria-label="X-ray legend">
        <span><i class="l-solid"></i>declared FK</span>
        <span><i class="l-dash"></i>found in queries, no FK</span>
        <span><i class="l-glow"></i>live writes / reads</span>
        <span><i class="l-idle"></i>idle table</span>
        <span><i class="l-flag">⚑</i>seq-scan heavy</span>
      </div>
    }
    @if (showMinimap() && store.view().tables.length >= 8) {
      <app-minimap class="minimap" [scene]="sceneSig()" [version]="sceneVersion()" [view]="viewRect()"
        [palette]="paletteSig()" (navigate)="centerOn($event)" />
    }
    <div class="zoom" role="toolbar" aria-label="Diagram view">
      <div class="seg" role="radiogroup" aria-label="Detail level">
        @for (d of detailLevels; track d.value) {
          <button type="button" role="radio" [attr.aria-checked]="store.detail() === d.value" [class.on]="store.detail() === d.value"
            (click)="store.setDetail(d.value)" [title]="d.title">{{ d.label }}</button>
        }
      </div>
      <button type="button" class="txt" [class.on]="store.focusMode()" (click)="store.focusMode.set(!store.focusMode())"
        title="Focus: selecting a table fades everything more than one relationship away (F)">Focus</button>
      <button type="button" class="txt" [class.on]="showMinimap()" (click)="toggleMinimap()" title="Show or hide the overview map">Map</button>
      <span class="zsep"></span>
      <button type="button" (click)="zoomBy(1 / 1.2)" title="Zoom out">−</button>
      <span class="pct" title="Ctrl + scroll to zoom, scroll or drag the background to pan">{{ zoomPct() }}%</span>
      <button type="button" (click)="zoomBy(1.2)" title="Zoom in">+</button>
      <button type="button" class="fit" (click)="fit()" title="Fit diagram to screen">Fit</button>
    </div>
    @if (tooltip(); as t) {
      <div class="tooltip" [style.left.px]="t.x" [style.top.px]="t.y">
        <div class="tt-title">{{ t.title }}</div>
        @for (line of t.lines; track $index) {
          <div class="tt-line">{{ line }}</div>
        }
        @if (t.note) {
          <div class="tt-note">{{ t.note }}</div>
        }
      </div>
    }
    @if (evidence(); as ev) {
      <div class="evidence" [style.left.px]="ev.x" [style.top.px]="ev.y" role="dialog" aria-label="Discovered relationship">
        <div class="ev-head">
          <span class="ev-tag">Found in queries · no foreign key</span>
          <button type="button" class="ev-close" (click)="evidence.set(null)" aria-label="Close">×</button>
        </div>
        <div class="ev-title">
          {{ short(ev.ref.from.table) }}.{{ ev.ref.from.fields.join(", ") }}
          <span class="ev-arrow">{{ ev.ref.discovered?.directed ? "→" : "—" }}</span>
          {{ short(ev.ref.to.table) }}.{{ ev.ref.to.fields.join(", ") }}
        </div>
        <div class="ev-meta">
          {{ ev.ref.discovered?.calls }} calls across {{ ev.ref.discovered?.statements }} distinct statement{{ ev.ref.discovered?.statements === 1 ? "" : "s" }}
          @if (!ev.ref.discovered?.directed) { · direction unknown }
        </div>
        @for (q of ev.ref.discovered?.queries; track $index) {
          <pre class="ev-q"><b>{{ q.calls }}×</b> {{ q.text }}</pre>
        }
        @if (check(); as c) {
          @if (c.loading) {
            <p class="ev-meta">Checking the data (read-only)…</p>
          } @else if (c.result; as r) {
            <div class="ev-check" [class.bad]="r.orphanRows > 0 || r.timedOut">
              @if (r.timedOut) {
                <b>The check timed out after 15 s.</b>
              } @else if (r.orphanRows === 0) {
                <b>✓ No orphan rows</b> in {{ fmtInt(r.checkedRows) }} rows{{ r.sampled ? " (sample)" : "" }}
              } @else {
                <b>{{ fmtInt(r.orphanRows) }} orphan rows</b> in {{ fmtInt(r.checkedRows) }}{{ r.sampled ? " (sample)" : "" }} — e.g. {{ r.orphanSamples.join(", ") }}
              }
              @if (r.nullRows) {
                <span> · {{ fmtInt(r.nullRows) }} with NULL keys</span>
              }
              <div class="ev-chips">
                <span [class.ok]="r.parentUnique">{{ r.parentUnique ? "referenced key is unique" : "referenced key not unique" }}</span>
                <span [class.ok]="r.childIndexed">{{ r.childIndexed ? "referencing columns indexed" : "no index on referencing columns" }}</span>
              </div>
            </div>
            <pre class="ev-sql">{{ r.sql }}</pre>
            <div class="ev-actions">
              <button type="button" class="ev-secondary" (click)="workload.copy(r.sql)">Copy SQL</button>
              <button type="button" class="ev-secondary" (click)="workload.saveSql(r.constraintName + '.sql', r.sql)">Save .sql</button>
            </div>
          }
        }
        <div class="ev-actions">
          <button type="button" class="ev-secondary" (click)="checkData(ev.ref)" [disabled]="check()?.loading"
            title="Count rows that would violate a foreign key, and generate the migration SQL (read-only)">Check data</button>
          <button type="button" class="ev-add" (click)="promote(ev.ref)">Add Ref to DBML</button>
        </div>
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: block; overflow: hidden; background: var(--canvas-bg);
      background-image: radial-gradient(var(--canvas-dot) 1px, transparent 1px); }
    .host { position: absolute; inset: 0; }
    .empty { position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
      color: var(--text-muted); pointer-events: none; padding: 24px; gap: 4px; }
    .empty-title { font-size: 16px; font-weight: 600; color: var(--text); margin: 0; }
    .empty p { margin: 0; max-width: 380px; line-height: 1.5; }
    .zoom { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 2px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 3px;
      box-shadow: var(--shadow-sm); }
    .zoom button { border: 0; background: transparent; color: var(--text); width: 28px; height: 26px;
      border-radius: 5px; font-size: 15px; cursor: pointer; }
    .zoom button.fit, .zoom button.txt { width: auto; padding: 0 9px; font-size: 12px; font-weight: 500; }
    .zoom button.on { background: var(--accent-soft); color: var(--accent); }
    .seg { display: flex; gap: 1px; background: var(--hover); border-radius: 6px; padding: 1px; }
    .seg button { width: auto; padding: 0 8px; height: 24px; font-size: 11.5px; font-weight: 500; }
    .seg button.on { background: var(--panel); color: var(--text); box-shadow: var(--shadow-sm); }
    .zsep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }
    .minimap { position: absolute; right: 12px; bottom: 52px; z-index: 3; }
    .zoom button:hover { background: var(--hover); }
    .pct { min-width: 44px; text-align: center; font-size: 12px; color: var(--text-muted);
      font-variant-numeric: tabular-nums; }
    .tooltip { position: absolute; z-index: 5; pointer-events: none; max-width: 340px; padding: 8px 10px;
      background: var(--tooltip-bg); color: var(--tooltip-text); border-radius: 6px; font-size: 12px;
      line-height: 1.45; box-shadow: var(--shadow-md); }
    .tt-title { font-weight: 600; margin-bottom: 2px; }
    .tt-line { opacity: 0.85; font-family: var(--mono); font-size: 11.5px; }
    .tt-note { margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.15); white-space: pre-wrap; }
    .legend { position: absolute; left: 12px; top: 12px; display: flex; flex-wrap: wrap; gap: 4px 14px;
      max-width: calc(100% - 24px); padding: 6px 10px; background: var(--panel); border: 1px solid var(--border);
      border-radius: 8px; box-shadow: var(--shadow-sm); font-size: 11.5px; color: var(--text-muted); }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { display: inline-block; width: 18px; height: 0; border-top: 2px solid var(--text-muted); }
    .legend .l-dash { border-top: 2px dashed #d97706; }
    .legend .l-glow { width: 12px; height: 12px; border: 0; border-radius: 3px; background: var(--panel);
      box-shadow: 0 0 8px 2px #f97316; }
    .legend .l-idle { width: 12px; height: 12px; border: 1px solid var(--border); border-radius: 3px; opacity: 0.45;
      background: var(--text-muted); }
    .legend .l-flag { width: auto; height: auto; border: 0; color: #dc2626; font-style: normal; font-size: 12px; }
    .evidence { position: absolute; z-index: 6; width: 420px; max-width: calc(100% - 24px); max-height: 60%;
      overflow: auto; background: var(--panel); color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: var(--shadow-lg); padding: 10px 12px 12px; font-size: 12.5px; }
    .ev-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .ev-tag { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #d97706;
      background: rgba(217, 119, 6, 0.12); padding: 2px 7px; border-radius: 9px; }
    .ev-close { border: 0; background: none; color: var(--text-muted); font-size: 18px; line-height: 1; cursor: pointer; }
    .ev-title { font-weight: 600; font-family: var(--mono); font-size: 12px; word-break: break-all; }
    .ev-arrow { color: #d97706; padding: 0 4px; }
    .ev-meta { color: var(--text-muted); margin: 3px 0 8px; }
    .ev-q { margin: 0 0 6px; padding: 6px 8px; background: var(--panel-2); border: 1px solid var(--border);
      border-radius: 6px; font-family: var(--mono); font-size: 11px; line-height: 1.4; white-space: pre-wrap;
      word-break: break-word; max-height: 96px; overflow: auto; }
    .ev-q b { color: #d97706; }
    .ev-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
    .ev-add { font: inherit; font-size: 12.5px; font-weight: 600; background: var(--accent); color: #fff; border: 0;
      border-radius: 7px; padding: 7px 12px; cursor: pointer; }
    .ev-add:hover { background: var(--accent-strong); }
    .ev-actions { gap: 6px; }
    .ev-secondary { font: inherit; font-size: 12.5px; font-weight: 500; background: var(--panel); color: var(--text);
      border: 1px solid var(--border); border-radius: 7px; padding: 6px 11px; cursor: pointer; }
    .ev-secondary:hover:not(:disabled) { background: var(--hover); }
    .ev-secondary:disabled { opacity: 0.6; }
    .ev-check { margin: 8px 0 6px; padding: 8px 10px; border-radius: 7px; background: var(--ok-soft); color: var(--ok); font-size: 12px; }
    .ev-check.bad { background: var(--danger-soft); color: var(--danger); }
    .ev-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .ev-chips span { font-size: 11px; padding: 1px 7px; border-radius: 9px; background: var(--danger-soft); color: var(--danger); }
    .ev-chips span.ok { background: var(--panel); color: var(--ok); }
    .ev-sql { margin: 0 0 6px; padding: 6px 8px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px;
      font-family: var(--mono); font-size: 10.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
    .inline-edit { position: absolute; z-index: 7; box-sizing: border-box; margin: 0; padding: 0 6px; border: 2px solid var(--accent);
      border-radius: 4px; background: var(--panel); color: var(--text); font-family: var(--font); outline: none;
      box-shadow: var(--shadow-md); }
    .inline-edit.header { font-weight: 600; border-radius: 6px 6px 0 0; }
    .col-form { position: absolute; z-index: 7; display: grid; gap: 6px; width: 230px; padding: 10px; background: var(--panel);
      border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-md); font-size: 12.5px; }
    .cf-title { font-weight: 600; color: var(--text-muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .col-form input { font: inherit; font-size: 12.5px; color: var(--text); background: var(--input-bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 5px 8px; font-family: var(--mono); }
    .col-form input:focus { outline: 2px solid var(--accent-ring); border-color: var(--accent); }
    .cf-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .cf-actions button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 6px; padding: 4px 10px; cursor: pointer; }
    .cf-actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  `,
})
export class DiagramComponent implements DiagramHandle {
  protected readonly store = inject(WorkspaceStore);
  protected readonly workload = inject(WorkloadStore);
  private readonly lint = inject(LintStore);
  private readonly query = inject(QueryStore);
  private readonly theme = inject(ThemeService);
  private readonly hostRef = viewChild.required<ElementRef<HTMLDivElement>>("host");
  private readonly el = inject(ElementRef<HTMLElement>);

  protected readonly zoomPct = signal(100);
  protected readonly tooltip = signal<Tooltip | null>(null);
  protected readonly evidence = signal<Evidence | null>(null);
  protected readonly short = displayTable;
  /** Result of "Check data" for the relationship shown in the evidence popover. */
  protected readonly check = signal<{ refId: string; loading: boolean; result: RelationCheck | null } | null>(null);
  protected readonly fmtInt = fmtInt;
  protected readonly inlineEdit = signal<InlineEdit | null>(null);
  protected readonly columnForm = signal<ColumnForm | null>(null);
  protected readonly menu = signal<CanvasMenuState | null>(null);
  protected readonly columnTypes = COLUMN_TYPES;
  /** Bumped whenever table boxes move or the scene is rebuilt (the minimap redraws on it). */
  protected readonly sceneVersion = signal(0);
  /** Visible part of the diagram, in diagram coordinates. */
  protected readonly viewRect = signal({ x: 0, y: 0, w: 1, h: 1 });
  protected readonly sceneSig = signal<Scene | null>(null);
  protected readonly paletteSig = signal<DiagramPalette>(currentPalette());
  protected readonly showMinimap = signal(readFlag("xdiagram.minimap", true));
  protected readonly detailLevels: { value: DetailLevel; label: string; title: string }[] = [
    { value: "all", label: "All", title: "Show every column" },
    { value: "keys", label: "Keys", title: "Show only key and relationship columns" },
    { value: "names", label: "Names", title: "Show only table names" },
  ];

  private readonly actions = inject(CanvasActions);
  private readonly browser = inject(BrowserStore);
  private readonly inlineInput = viewChild<ElementRef<HTMLInputElement>>("inlineInput");
  private readonly colNameInput = viewChild<ElementRef<HTMLInputElement>>("colName");
  private inlineCancelled = false;
  /** A table created from the canvas, to rename as soon as it appears. */
  private renameWhenVisible: string | null = null;
  /** Set by "Show only this & related": fit the camera to what is left once it is drawn. */
  private fitWhenRendered = false;
  private linking: {
    from: FieldEnd;
    node: Konva.Group;
    line: Konva.Line;
    start: Point;
    target: FieldEnd | null;
    targetMark: Konva.Rect | null;
  } | null = null;

  private stage: Konva.Stage | null = null;
  private layer!: Konva.Layer;
  private groupsLayer!: Konva.Group;
  private edgesLayer!: Konva.Group;
  private tablesLayer!: Konva.Group;
  private palette: DiagramPalette = currentPalette();

  private scene: Scene | null = null;
  /** Konva nodes per table / relationship, reused across renders while their content is unchanged. */
  private tableViews = new Map<string, TableView>();
  private edgeViews = new Map<string, EdgeView>();
  /** The palette the cached nodes were drawn with (a theme switch redraws everything). */
  private drawnPalette: DiagramPalette | null = null;
  private hoverTable: string | null = null;
  private hoverEdge: string | null = null;
  private hoverField: { table: string; field: string } | null = null;
  /** Selected tables: click, Shift/Ctrl+click, Shift+drag a box on the background, Ctrl+A. */
  private selection = new Set<string>();
  /** While a selected table is dragged: where each selected table started (they move together). */
  private groupDrag: { leader: string; start: Map<string, Point> } | null = null;
  /** Shift+drag on the background: the selection box, in diagram coordinates. */
  private band: { start: Point; rect: Konva.Rect; end: () => void } | null = null;
  private viewportTimer: ReturnType<typeof setTimeout> | null = null;
  private exporting = false;

  constructor() {
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => this.init(destroyRef));

    // Re-render whenever the model, positions, visibility or discovered relationships change.
    effect(() => {
      const view = this.store.view();
      const positions = this.store.positions();
      const hidden = this.store.hidden();
      const extra = this.workload.discovered();
      const detail = this.store.detail();
      this.store.focusMode();
      // While new tables are being placed, wait for their positions instead of drawing them at 0,0.
      if (this.store.layingOut()) return;
      if (this.stage) untracked(() => this.render(view, positions, hidden, extra, detail));
    });

    // Live activity overlay: updates existing nodes in place, no re-render.
    effect(() => {
      this.workload.enabled();
      this.workload.rates();
      this.workload.pulse();
      this.workload.facts();
      if (this.stage) untracked(() => this.applyOverlay());
    });

    // Theme switches (system or Settings) redraw with the matching palette.
    effect(() => {
      this.theme.dark();
      untracked(() => {
        const next = currentPalette();
        if (this.stage && next !== this.palette) {
          this.palette = next;
          this.rerender();
        }
      });
    });

    // Query builder: outline the tables and relationships of the join path.
    effect(() => {
      this.query.highlight();
      if (this.stage) untracked(() => this.applyHighlight());
    });

    // Lint markers: a severity badge on each table with findings.
    effect(() => {
      this.lint.byTable();
      this.lint.showOnDiagram();
      if (this.stage) untracked(() => this.applyLintMarkers());
    });

    // A newly opened (or re-arranged) document restores its viewport, or fits to screen.
    effect(() => {
      this.store.documentVersion();
      const vp = this.store.initialViewport();
      untracked(() => setTimeout(() => (vp ? this.applyViewport(vp) : this.fit()), 0));
    });

    // Focus the rename input / column form as soon as they appear.
    effect(() => {
      const el = this.inlineInput()?.nativeElement;
      if (el) setTimeout(() => (el.focus(), el.select()), 0);
    });
    effect(() => {
      const el = this.colNameInput()?.nativeElement;
      if (el) setTimeout(() => el.focus(), 0);
    });

    this.store.diagram = this;
    destroyRef.onDestroy(() => {
      if (this.store.diagram === this) this.store.diagram = null;
    });
  }

  // ------------------------------------------------------------------ setup

  private init(destroyRef: DestroyRef): void {
    const host = this.hostRef().nativeElement;
    this.stage = new Konva.Stage({ container: host, width: host.clientWidth, height: host.clientHeight, draggable: true });
    this.layer = new Konva.Layer();
    this.groupsLayer = new Konva.Group({ listening: false });
    this.edgesLayer = new Konva.Group();
    this.tablesLayer = new Konva.Group();
    this.layer.add(this.groupsLayer, this.edgesLayer, this.tablesLayer);
    this.stage.add(this.layer);

    const stage = this.stage;
    stage.on("wheel", (e) => this.onWheel(e.evt));
    stage.on("dragmove", (e) => {
      if (e.target === stage) this.onViewportChanged();
    });
    stage.on("dragstart", (e) => {
      if (e.target === stage) stage.container().style.cursor = "grabbing";
    });
    stage.on("dragend", (e) => {
      if (e.target === stage) stage.container().style.cursor = "";
    });
    stage.on("click tap", (e) => {
      // A click on the background clears the selection, except while drawing a selection box
      // (Konva reports its release as a click) or with Shift held.
      if (e.target === stage && !this.band && !(e.evt as MouseEvent).shiftKey) {
        this.selection.clear();
        this.evidence.set(null);
        this.applyHighlight();
      }
    });
    // Capture phase: runs before Konva's own pointerdown, so the stage never starts panning.
    const onPointerDown = (e: PointerEvent) => this.maybeStartBand(e);
    host.addEventListener("pointerdown", onPointerDown, { capture: true });
    destroyRef.onDestroy(() => host.removeEventListener("pointerdown", onPointerDown, { capture: true }));
    stage.on("contextmenu", (e) => {
      e.evt.preventDefault();
      this.openMenu(e.target);
    });

    const resize = new ResizeObserver(() => {
      stage.size({ width: host.clientWidth, height: host.clientHeight });
      this.updateViewRect();
    });
    resize.observe(host);

    destroyRef.onDestroy(() => {
      resize.disconnect();
      stage.destroy();
      this.stage = null;
    });

    this.rerender();
    this.onViewportChanged(false);
  }

  private rerender(): void {
    this.render(this.store.view(), this.store.positions(), this.store.hidden(), this.workload.discovered(), this.store.detail());
  }

  // ------------------------------------------------------------------ rendering

  private render(
    view: ViewModel,
    positions: Record<string, Point>,
    hidden: ReadonlySet<string>,
    extra: VRef[],
    detail: DetailLevel,
  ): void {
    timed("render", () => this.renderNow(view, positions, hidden, extra, detail));
  }

  private renderNow(
    view: ViewModel,
    positions: Record<string, Point>,
    hidden: ReadonlySet<string>,
    extra: VRef[],
    detail: DetailLevel,
  ): void {
    if (!this.stage) return;
    this.scene = buildScene(view, positions, hidden, { extra, detail });
    this.sceneSig.set(this.scene);
    this.paletteSig.set(this.palette);
    this.sceneVersion.update((v) => v + 1);
    if (this.drawnPalette !== this.palette) {
      this.clearViews();
      this.drawnPalette = this.palette;
    }
    if (this.hoverTable && !this.scene.tables.has(this.hoverTable)) this.hoverTable = null;
    for (const id of this.selection) if (!this.scene.tables.has(id)) this.selection.delete(id);
    this.hoverField = null;
    this.hoverEdge = null;
    this.tooltip.set(null);
    const ev = this.evidence();
    if (ev && !this.scene.edges.some((e) => e.ref.id === ev.ref.id)) this.evidence.set(null);

    this.groupsLayer.destroyChildren();
    for (const g of this.scene.groups) this.groupsLayer.add(this.drawGroup(g));

    // Unchanged relationships and tables keep their nodes: typing in one table or moving one
    // rebuilds only what changed.
    const edgeIds = new Set<string>();
    for (const e of this.scene.edges) {
      edgeIds.add(e.ref.id);
      const sig = edgeSig(e);
      const old = this.edgeViews.get(e.ref.id);
      if (old?.sig === sig) continue;
      old?.node.destroy();
      const v = this.drawEdge(e, sig);
      this.edgesLayer.add(v.node);
      this.edgeViews.set(e.ref.id, v);
    }
    for (const [id, v] of this.edgeViews) {
      if (!edgeIds.has(id)) {
        v.node.destroy();
        this.edgeViews.delete(id);
      }
    }
    for (const box of this.scene.tables.values()) {
      const sig = tableSig(box);
      const old = this.tableViews.get(box.table.id);
      if (old?.sig === sig) {
        old.node.position({ x: box.x, y: box.y });
        continue;
      }
      old?.node.destroy();
      const v = this.drawTable(box, sig);
      this.tablesLayer.add(v.node);
      this.tableViews.set(box.table.id, v);
    }
    for (const [id, v] of this.tableViews) {
      if (!this.scene.tables.has(id)) {
        v.node.destroy();
        this.tableViews.delete(id);
      }
    }
    this.updateVisibility();
    this.applyHighlight();
    // Both clear themselves while exporting (reused nodes may carry badges or live rates).
    this.applyOverlay();
    this.applyLintMarkers();

    const pending = this.renameWhenVisible;
    const created = pending ? this.scene.tables.get(pending) : undefined;
    if (created) {
      this.renameWhenVisible = null;
      setTimeout(() => this.startRenameTable(created), 0);
    }
    if (this.fitWhenRendered) {
      this.fitWhenRendered = false;
      setTimeout(() => this.fit(), 0);
    }
  }

  private clearViews(): void {
    for (const v of this.tableViews.values()) v.node.destroy();
    for (const v of this.edgeViews.values()) v.node.destroy();
    this.tableViews.clear();
    this.edgeViews.clear();
  }

  /**
   * Viewport culling and level of detail: only tables and relationships near the viewport are
   * drawn; zoomed out, tables lose their rows and shadows (rows are created the first time a
   * table is shown up close), and further out their names.
   */
  private updateVisibility(): void {
    const stage = this.stage;
    const scene = this.scene;
    if (!stage || !scene) return;
    const s = stage.scaleX();
    const all = this.exporting;
    const m = CULL_MARGIN / s;
    const x0 = -stage.x() / s - m;
    const y0 = -stage.y() / s - m;
    const x1 = x0 + stage.width() / s + 2 * m;
    const y1 = y0 + stage.height() / s + 2 * m;
    const near = (r: Rect) => all || (r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0);
    const level: DetailMode = all || s >= DETAIL_SCALE ? "full" : s >= TITLE_SCALE ? "mid" : "far";
    // Mid zoom: the name, drawn inside the body at a size that reads on screen (and fits the box).
    const labelSize = Math.round(MID_LABEL_PX / s);
    for (const [id, v] of this.tableViews) {
      const box = scene.tables.get(id);
      const shown = !!box && (near(box) || v.node.isDragging());
      if (shown !== v.shown) {
        v.node.visible(shown);
        v.shown = shown;
      }
      if (!shown || !box) continue;
      if (level === "full" && !v.rows) {
        v.rows = this.drawRows(box);
        v.node.add(v.rows);
      }
      if (level === "mid" && !v.label) this.addMidLabel(v, box);
      if (level !== v.level) {
        const full = level === "full";
        v.rows?.visible(full);
        v.body.shadowEnabled(full);
        v.title.visible(full);
        v.rate.visible(full && !!v.rate.text());
        v.skeleton?.visible(level === "mid");
        v.label?.visible(level === "mid");
        v.level = level;
      }
      if (level === "mid" && v.label) {
        const size = Math.min(labelSize, v.label.getAttr("fitSize") as number);
        if (v.label.fontSize() !== size) v.label.fontSize(size);
      }
    }
    for (const v of this.edgeViews.values()) {
      const shown = near(v.bounds);
      if (shown !== v.shown) {
        v.node.visible(shown);
        v.shown = shown;
      }
    }
  }

  /** Row dividers and a large name, shown instead of the rows at mid zoom. */
  private addMidLabel(v: TableView, box: TableBox): void {
    const p = this.palette;
    const t = box.table;
    const rows = box.fields.length;
    const hasBody = box.h - HEADER_H >= 24;
    v.skeleton = new Konva.Shape({
      listening: false, stroke: p.rowDivider, strokeWidth: 1, perfectDrawEnabled: false, visible: false,
      sceneFunc: (ctx, shape) => {
        ctx.beginPath();
        for (let i = 1; i < rows; i++) {
          ctx.moveTo(1, HEADER_H + i * ROW_H);
          ctx.lineTo(box.w - 1, HEADER_H + i * ROW_H);
        }
        ctx.strokeShape(shape);
      },
    });
    const lines = t.schema && t.label !== t.name ? [t.name, t.schema] : [t.name];
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const width = box.w - 20;
    const area = hasBody ? box.h - HEADER_H : box.h;
    v.label = new Konva.Text({
      x: 10, y: hasBody ? HEADER_H : 0, width, height: area, text: lines.join("\n"), align: "center", verticalAlign: "middle",
      fontFamily: FONT_FAMILY, fontStyle: "600", fill: hasBody ? p.fieldName : p.headerText, wrap: "none", ellipsis: true,
      listening: false, visible: false, lineHeight: 1.1,
    });
    // Largest size at which the longest line still fits the width (and the lines the height).
    v.label.setAttr("fitSize", Math.max(8, Math.floor(Math.min(width / (longest * 0.6), area / (lines.length * 1.25)))));
    v.node.add(v.skeleton, v.label);
    v.lint?.moveToTop();
  }

  private drawGroup(g: GroupBox): Konva.Group {
    const p = this.palette;
    const color = g.group.color ?? p.groupBorder;
    const node = new Konva.Group({ x: g.x, y: g.y, name: "group" });
    node.add(
      new Konva.Rect({ width: g.w, height: g.h, fill: p.groupFill, stroke: color, strokeWidth: 1, cornerRadius: 10, dash: [6, 4] }),
      new Konva.Text({
        x: 12, y: 0, height: GROUP_LABEL_H, verticalAlign: "middle", text: g.group.name,
        fontFamily: FONT_FAMILY, fontSize: 12, fontStyle: "600", fill: g.group.color ?? p.groupLabel,
      }),
    );
    return node;
  }

  private drawEdge(e: EdgeRoute, sig: string): EdgeView {
    const discovered = e.kind === "discovered";
    const stroke = discovered ? this.palette.edgeDiscovered : this.palette.edge;
    const strokeWidth = edgeStrokeWidth(e);
    const id = e.ref.id;
    const node = new Konva.Group({ listening: discovered });
    const strokes: Konva.Line[] = [
      new Konva.Line({
        points: e.points, stroke, strokeWidth, lineJoin: "round", name: "stroke", perfectDrawEnabled: false,
        dash: discovered ? [6, 4] : undefined, hitStrokeWidth: discovered ? 14 : 0,
      }),
    ];
    if (e.directed) {
      for (const end of [e.from, e.to]) {
        for (const seg of markerSegments(end)) {
          strokes.push(new Konva.Line({ points: seg, stroke, strokeWidth, lineCap: "round", name: "stroke", listening: false, perfectDrawEnabled: false }));
        }
      }
    }
    node.add(...strokes);
    if (discovered) {
      node.on("mouseenter", () => {
        this.hoverEdge = id;
        this.applyHighlight();
        this.setCursor("pointer");
      });
      node.on("mouseleave", () => {
        this.hoverEdge = null;
        this.applyHighlight();
        this.setCursor("");
      });
      node.on("click tap", (evt) => {
        evt.cancelBubble = true;
        this.openEvidence(this.scene?.edges.find((x) => x.ref.id === id)?.ref ?? e.ref);
      });
    }
    return { sig, node, strokes, bounds: pointsBounds(e.points), shown: true };
  }

  private drawTable(box: TableBox, sig: string): TableView {
    const p = this.palette;
    const t = box.table;
    const id = t.id;
    // Handlers read the live box: the node outlives the scene it was created for.
    const current = () => this.scene?.tables.get(id) ?? box;
    const node = new Konva.Group({ x: box.x, y: box.y, draggable: true, name: "table" });
    node.setAttr("tableId", id);

    const header = new Konva.Rect({
      width: box.w, height: HEADER_H, fill: t.headerColor ?? p.headerDefault, name: "header",
      cornerRadius: box.h <= HEADER_H ? 6 : [6, 6, 0, 0], perfectDrawEnabled: false,
    });
    // X-ray glow sits behind the body; hidden until live activity arrives.
    const glow = new Konva.Rect({
      width: box.w, height: box.h, cornerRadius: 6, fill: p.tableBody, opacity: 0, shadowColor: p.glowWrite, visible: false,
      shadowBlur: 0, shadowOpacity: 0.9, shadowForStrokeEnabled: false, listening: false, name: "glow", perfectDrawEnabled: false,
    });
    // The shadow is switched on with the rows (see updateVisibility).
    const body = new Konva.Rect({
      width: box.w, height: box.h, fill: p.tableBody, cornerRadius: 6, stroke: p.tableBorder, strokeWidth: 1,
      shadowColor: p.tableShadow, shadowBlur: 12, shadowOffsetY: 3, shadowForStrokeEnabled: false, shadowEnabled: false,
      name: "body", perfectDrawEnabled: false,
    });
    const title = new Konva.Text({
      x: PAD_X, width: box.w - PAD_X * 2, height: HEADER_H, verticalAlign: "middle", text: t.label, wrap: "none", visible: false,
      ellipsis: true, fontFamily: FONT_FAMILY, fontSize: 13, fontStyle: "600", fill: p.headerText, listening: false, name: "title",
    });
    const rate = new Konva.Text({
      x: box.w - PAD_X - RATE_SLOT_W, width: RATE_SLOT_W, height: HEADER_H, align: "right", verticalAlign: "middle", visible: false,
      text: "", fontFamily: MONO_FAMILY, fontSize: 10, fill: p.headerText, opacity: 0.92, listening: false, name: "rate",
    });
    node.add(glow, body, header, title, rate);

    header.on("mouseenter", () => this.showTableTooltip(current()));
    header.on("mouseleave", () => this.tooltip.set(null));
    header.on("dblclick dbltap", () => this.startRenameTable(current()));
    node.on("mouseenter", () => {
      this.hoverTable = id;
      this.applyHighlight();
      this.setCursor("move");
    });
    node.on("mouseleave", () => {
      this.hoverTable = null;
      this.applyHighlight();
      this.setCursor("");
    });
    node.on("dragstart", (e) => {
      node.moveToTop();
      // Dragging an unselected table selects it (adds it with a modifier); dragging a selected
      // one moves the whole selection.
      if (!this.selection.has(id)) {
        if (!isAdditive(e.evt)) this.selection.clear();
        this.selection.add(id);
      }
      const boxes = this.scene?.tables;
      const start = new Map<string, Point>();
      for (const t of this.selection) {
        const b = boxes?.get(t);
        if (b) start.set(t, { x: b.x, y: b.y });
      }
      this.groupDrag = start.size > 1 ? { leader: id, start } : null;
      this.tooltip.set(null);
      this.evidence.set(null);
    });
    node.on("dragmove", () => this.onTableDrag(id, node));
    node.on("dragend", () => {
      const moved = this.groupDrag?.leader === id ? [...this.groupDrag.start.keys()] : [id];
      this.groupDrag = null;
      const moves: Record<string, Point> = {};
      for (const t of moved) {
        const b = this.scene?.tables.get(t);
        if (b) moves[t] = { x: Math.round(b.x), y: Math.round(b.y) };
      }
      moves[id] = { x: Math.round(node.x()), y: Math.round(node.y()) };
      // One call, so moving a whole selection is one undo step.
      this.store.moveTables(moves);
    });
    node.on("click tap", (e) => {
      if (isAdditive(e.evt)) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
        this.applyHighlight();
        return;
      }
      this.selection = new Set([id]);
      this.applyHighlight();
      this.store.reveal(current().table.line);
    });
    return { sig, node, body, glow, title, rate, rows: null, lint: null, skeleton: null, label: null, shown: true, level: "far" };
  }

  /** A table's rows, created the first time it is shown up close. */
  private drawRows(box: TableBox): Konva.Group {
    const rows = new Konva.Group({ name: "rows" });
    box.fields.forEach((f, i) => rows.add(this.drawRow(box, f, i)));
    return rows;
  }

  private drawRow(box: TableBox, f: VField, i: number): Konva.Group {
    const p = this.palette;
    const last = i === box.fields.length - 1;
    const row = new Konva.Group({ y: HEADER_H + i * ROW_H, name: "row" });
    const bg = new Konva.Rect({
      width: box.w, height: ROW_H, fill: "rgba(0,0,0,0)", cornerRadius: last ? [0, 0, 6, 6] : 0, name: "row-bg",
    });
    row.add(bg);
    if (i > 0) row.add(new Konva.Line({ points: [1, 0, box.w - 1, 0], stroke: p.rowDivider, strokeWidth: 1, listening: false }));

    const badge = f.pk ? "PK" : f.fk ? "FK" : null;
    if (badge) {
      row.add(
        new Konva.Rect({
          x: PAD_X, y: (ROW_H - 14) / 2, width: 18, height: 14, cornerRadius: 3,
          fill: f.pk ? p.pkBadge : p.fkBadge, listening: false,
        }),
        new Konva.Text({
          x: PAD_X, y: (ROW_H - 14) / 2, width: 18, height: 14, align: "center", verticalAlign: "middle",
          text: badge, fontFamily: FONT_FAMILY, fontSize: 8, fontStyle: "700", fill: p.badgeText, listening: false,
        }),
      );
    }
    const typeW = textWidth(f.type, TYPE_FONT);
    row.add(
      new Konva.Text({
        x: PAD_X + BADGE_W, height: ROW_H, verticalAlign: "middle", text: f.name, fontFamily: FONT_FAMILY,
        fontSize: 12.5, fontStyle: f.pk ? "600" : "400", fill: p.fieldName, listening: false,
      }),
      new Konva.Text({
        x: box.w - PAD_X - typeW, height: ROW_H, verticalAlign: "middle", text: f.type, fontFamily: MONO_FAMILY,
        fontSize: 11.5, fill: p.fieldType, listening: false,
      }),
    );

    // Connector dot: drag it onto another column to draw a relationship. Always in the hit graph
    // (it sticks out of the row, so it must be found from outside too) but only painted while its
    // row is hovered ("lit").
    const circle = (ctx: Konva.Context, shape: Konva.Shape) => {
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStrokeShape(shape);
    };
    const dot = new Konva.Shape({
      x: box.w, y: ROW_H / 2, fill: p.edgeHighlight, stroke: p.tableBody, strokeWidth: 1.5, hitStrokeWidth: 8,
      name: "connector", perfectDrawEnabled: false,
      sceneFunc: (ctx, shape) => {
        if (shape.getAttr("lit")) circle(ctx, shape);
      },
      hitFunc: circle,
    });
    row.add(dot);
    const tableId = box.table.id;
    row.setAttr("tableId", tableId);
    row.setAttr("field", f.name);
    // The live box and column (notes, defaults… may have changed since the row was drawn).
    const live = () => {
      const b = this.scene?.tables.get(tableId) ?? box;
      return { b, f: b.table.fields.find((x) => x.name === f.name) ?? f };
    };

    row.on("mouseenter", () => {
      bg.fill(p.rowHover);
      if (!this.linking) dot.setAttr("lit", true);
      this.hoverField = { table: tableId, field: f.name };
      this.applyHighlight();
      if (!this.linking) {
        const cur = live();
        this.showFieldTooltip(cur.b.table, cur.f);
      }
    });
    row.on("mouseleave", () => {
      bg.fill("rgba(0,0,0,0)");
      dot.setAttr("lit", false);
      this.hoverField = null;
      this.applyHighlight();
      this.tooltip.set(null);
    });
    row.on("dblclick dbltap", () => {
      const cur = live();
      this.startRenameColumn(cur.b, cur.f);
    });
    dot.on("mouseenter", () => this.setCursor("crosshair"));
    dot.on("mousedown touchstart", (e) => {
      e.cancelBubble = true;
      // row → rows group → table node
      const node = row.getParent()?.getParent() as Konva.Group | null;
      const cur = live();
      if (node) this.startLink(cur.b, cur.f, node);
    });
    return row;
  }

  // ------------------------------------------------------------------ canvas editing

  private toHost(x: number, y: number): Point {
    const stage = this.stage!;
    return { x: stage.x() + x * stage.scaleX(), y: stage.y() + y * stage.scaleY() };
  }

  private startRenameTable(box: TableBox): void {
    if (!this.stage || !this.actions.canEdit()) return;
    const s = this.stage.scaleX();
    const p = this.toHost(box.x, box.y);
    this.tooltip.set(null);
    this.inlineEdit.set({
      kind: "table", tableId: box.table.id, field: null, value: box.table.name,
      x: p.x, y: p.y, w: Math.max(box.w * s, 160), h: Math.max(HEADER_H * s, 26), fontSize: Math.max(12, 13 * s),
    });
  }

  private startRenameColumn(box: TableBox, f: VField): void {
    if (!this.stage || !this.actions.canEdit()) return;
    const s = this.stage.scaleX();
    const i = box.fields.findIndex((x) => x.name === f.name);
    const p = this.toHost(box.x + PAD_X + BADGE_W - 6, box.y + HEADER_H + i * ROW_H);
    this.tooltip.set(null);
    this.inlineEdit.set({
      kind: "column", tableId: box.table.id, field: f, value: f.name,
      x: p.x, y: p.y, w: Math.max(box.w * 0.6 * s, 140), h: Math.max(ROW_H * s, 24), fontSize: Math.max(12, 12.5 * s),
    });
  }

  protected onInlineKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      this.commitInline();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.inlineCancelled = true;
      this.inlineEdit.set(null);
    }
  }

  protected commitInline(): void {
    const edit = this.inlineEdit();
    const value = this.inlineInput()?.nativeElement.value ?? "";
    this.inlineEdit.set(null);
    if (this.inlineCancelled || !edit) {
      this.inlineCancelled = false;
      return;
    }
    if (edit.kind === "table") void this.actions.renameTable(edit.tableId, value);
    else if (edit.field) void this.actions.renameColumn(edit.tableId, edit.field, value);
  }

  protected submitColumn(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const cf = this.columnForm();
    this.columnForm.set(null);
    if (cf) this.actions.addColumn(cf.tableId, String(data.get("name") ?? ""), String(data.get("type") ?? ""));
  }

  /** Finds the table group and column row under a Konva node. */
  private hitInfo(node: Konva.Node | null): { tableId: string | null; field: string | null } {
    let field: string | null = null;
    let n: Konva.Node | null = node;
    while (n && n !== this.stage) {
      field ??= (n.getAttr("field") as string | undefined) ?? null;
      const tableId = n.name() === "table" ? (n.getAttr("tableId") as string) : null;
      if (tableId) return { tableId, field };
      n = n.getParent();
    }
    return { tableId: null, field: null };
  }

  private openMenu(target: Konva.Node): void {
    const stage = this.stage;
    const pointer = stage?.getPointerPosition();
    const world = stage?.getRelativePointerPosition();
    if (!stage || !pointer || !world) return;
    const { tableId, field } = target === stage ? { tableId: null, field: null } : this.hitInfo(target);
    const table = tableId ? this.scene?.tables.get(tableId)?.table : undefined;
    this.tooltip.set(null);
    this.evidence.set(null);
    // Right-clicking outside the selection makes that table the selection (like file managers);
    // inside it, the menu acts on every selected table.
    if (table && !this.selection.has(table.id)) {
      this.selection = new Set([table.id]);
      this.applyHighlight();
    }
    this.menu.set({
      x: pointer.x + 2,
      y: pointer.y + 2,
      tableId: table?.id ?? null,
      tableLabel: table?.label ?? null,
      field: table ? field : null,
      headerColor: table?.headerColor ?? null,
      world,
      canBrowse: !!table && this.browser.canBrowse(),
      count: table ? this.selection.size : 0,
    });
  }

  protected onMenuAction(action: CanvasMenuAction): void {
    const m = this.menu();
    if (!m) return;
    const box = m.tableId ? this.scene?.tables.get(m.tableId) : undefined;
    // The tables the menu acts on: the selection when several are selected, else the clicked one.
    const ids = m.count > 1 ? [...this.selection].filter((id) => this.scene?.tables.has(id)) : box ? [box.table.id] : [];
    const labels = ids.map((id) => this.scene?.tables.get(id)?.table.label ?? displayTable(id));
    switch (action.kind) {
      case "renameTable":
        if (box) this.startRenameTable(box);
        break;
      case "renameColumn": {
        const f = box?.table.fields.find((x) => x.name === m.field);
        if (box && f) this.startRenameColumn(box, f);
        break;
      }
      case "addColumn":
        if (box && this.actions.canEdit()) this.columnForm.set({ tableId: box.table.id, label: box.table.label, x: m.x, y: m.y });
        break;
      case "color":
        if (box) void this.actions.setHeaderColor(box.table.id, action.color);
        break;
      case "reveal":
        if (box) this.store.reveal(box.table.line, { show: true, focus: true });
        break;
      case "browse":
        if (box) this.browser.show(box.table.id);
        break;
      case "profile":
        if (box) this.browser.showProfile(box.table.id);
        break;
      case "query":
        for (const id of ids) this.query.add(id);
        break;
      case "hide":
        if (ids.length > 1) {
          this.store.setHidden(ids, true);
          this.store.flash(`Hid ${ids.length} tables`);
        } else if (box) {
          this.store.toggleHidden(box.table.id);
        }
        break;
      case "showOnly":
        if (ids.length) {
          this.fitWhenRendered = true;
          this.store.showOnly(new Set(ids), "Show selected tables");
          this.store.flash(`Showing ${ids.length} selected table${ids.length === 1 ? "" : "s"}`);
        }
        break;
      case "isolate":
        if (ids.length) {
          // Declared refs include links to hidden tables, so hidden neighbours come back;
          // discovered (X-ray) refs are the same extra lines the canvas draws.
          const keep = relatedTables([...this.store.view().refs, ...this.workload.discovered()], ids);
          this.fitWhenRendered = true;
          this.store.showOnly(keep, "Show related tables");
          const n = keep.size - ids.length;
          const what = ids.length === 1 ? labels[0] : `${ids.length} tables`;
          this.store.flash(`Showing ${what} and ${n} related table${n === 1 ? "" : "s"}`);
        }
        break;
      case "copy":
        if (labels.length) void navigator.clipboard?.writeText(labels.join("\n"));
        break;
      case "sample":
        if (box) this.store.sampleDataFor.set({ table: box.table.id });
        break;
      case "newTable": {
        const id = this.actions.newTable(m.world);
        if (id) this.renameWhenVisible = id;
        break;
      }
      case "fit":
        this.fit();
        break;
    }
  }

  private startLink(box: TableBox, f: VField, node: Konva.Group): void {
    const stage = this.stage;
    if (!stage || this.linking || !this.actions.canEdit()) return;
    const start = { x: box.x + box.w, y: rowCenterY(box, f.name) };
    const line = new Konva.Line({
      points: [start.x, start.y, start.x, start.y], stroke: this.palette.edgeHighlight, strokeWidth: 1.8,
      dash: [5, 4], lineCap: "round", listening: false,
    });
    this.layer.add(line);
    node.draggable(false);
    stage.draggable(false);
    this.tooltip.set(null);
    this.linking = { from: { table: box.table.id, field: f.name }, node, line, start, target: null, targetMark: null };
    stage.on("mousemove.link touchmove.link", () => this.updateLink());
    const finish = (e: Event) => {
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("touchend", finish);
      window.removeEventListener("keydown", onKey);
      this.endLink(e.type !== "keydown");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(e);
    };
    window.addEventListener("mouseup", finish);
    window.addEventListener("touchend", finish);
    window.addEventListener("keydown", onKey);
  }

  private updateLink(): void {
    const stage = this.stage;
    const link = this.linking;
    const pointer = stage?.getPointerPosition();
    const world = stage?.getRelativePointerPosition();
    if (!stage || !link || !pointer || !world) return;
    link.line.points([link.start.x, link.start.y, world.x, world.y]);

    const { tableId, field } = this.hitInfo(stage.getIntersection(pointer));
    const target = tableId && field && !(tableId === link.from.table && field === link.from.field) ? { table: tableId, field } : null;
    if (target?.table !== link.target?.table || target?.field !== link.target?.field) {
      link.targetMark?.destroy();
      link.targetMark = null;
      link.target = target;
      const box = target ? this.scene?.tables.get(target.table) : undefined;
      if (box && target) {
        const i = box.fields.findIndex((x) => x.name === target.field);
        link.targetMark = new Konva.Rect({
          x: box.x, y: box.y + HEADER_H + i * ROW_H, width: box.w, height: ROW_H, stroke: this.palette.edgeHighlight,
          strokeWidth: 2, cornerRadius: 3, listening: false,
        });
        this.layer.add(link.targetMark);
      }
    }
    this.layer.batchDraw();
  }

  private endLink(commit: boolean): void {
    const link = this.linking;
    if (!link) return;
    this.linking = null;
    this.stage?.off(".link");
    link.line.destroy();
    link.targetMark?.destroy();
    link.node.draggable(true);
    this.stage?.draggable(true);
    this.setCursor("");
    this.layer.batchDraw();
    if (commit && link.target) this.actions.addRef(link.from, link.target);
  }

  /** Focuses a table and briefly highlights one of its rows. */
  flashField(tableId: string, field: string): void {
    this.focusTable(tableId);
    const box = this.scene?.tables.get(tableId);
    const i = box?.fields.findIndex((f) => f.name === field) ?? -1;
    if (!box || i < 0) return;
    const mark = new Konva.Rect({
      x: box.x, y: box.y + HEADER_H + i * ROW_H, width: box.w, height: ROW_H, fill: this.palette.edgeHighlight,
      opacity: 0.35, listening: false,
    });
    this.layer.add(mark);
    new Konva.Tween({ node: mark, duration: 1.6, opacity: 0, easing: Konva.Easings.EaseIn, onFinish: () => mark.destroy() }).play();
  }

  /**
   * Re-routes edges while a table is dragged. All edges are re-laned (moving one table can
   * change which edges share a vertical segment); only the ones whose route changed are redrawn.
   */
  private onTableDrag(id: string, node: Konva.Group): void {
    timed("dragmove", () => this.dragNow(id, node));
  }

  private dragNow(id: string, node: Konva.Group): void {
    const scene = this.scene;
    const box = scene?.tables.get(id);
    if (!scene || !box) return;
    const moved = [id];
    const group = this.groupDrag;
    if (group?.leader === id) {
      // The other selected tables follow by the same offset.
      const from = group.start.get(id)!;
      const dx = node.x() - from.x;
      const dy = node.y() - from.y;
      for (const [other, start] of group.start) {
        const b = other === id ? undefined : scene.tables.get(other);
        if (!b) continue;
        b.x = start.x + dx;
        b.y = start.y + dy;
        this.tableViews.get(other)?.node.position({ x: b.x, y: b.y });
        moved.push(other);
      }
    }
    box.x = node.x();
    box.y = node.y();
    const routes = routeAll(
      scene.edges.map((e) => e.ref),
      scene.tables,
    );
    routes.forEach((routed, i) => {
      const old = scene.edges[i];
      if (old && old.points.length === routed.points.length && old.points.every((v, k) => v === routed.points[k])) return;
      scene.edges[i] = routed;
      this.edgeViews.get(routed.ref.id)?.node.destroy();
      const fresh = this.drawEdge(routed, edgeSig(routed));
      this.edgesLayer.add(fresh.node);
      this.edgeViews.set(routed.ref.id, fresh);
    });
    this.sceneVersion.update((v) => v + 1);
    if (scene.groups.some((g) => moved.some((t) => g.group.tables.includes(t)))) {
      const view = this.store.view();
      const live: Record<string, Point> = { ...this.store.positions() };
      for (const t of moved) {
        const b = scene.tables.get(t);
        if (b) live[t] = { x: b.x, y: b.y };
      }
      scene.groups = buildScene(view, live, this.store.hidden(), { detail: this.store.detail() }).groups;
      this.groupsLayer.destroyChildren();
      for (const g of scene.groups) this.groupsLayer.add(this.drawGroup(g));
    }
    this.updateVisibility();
    this.applyHighlight();
  }

  /** Highlights edges touching the hovered field, else the hovered edge, else the hovered or selected tables. */
  private applyHighlight(): void {
    timed("highlight", () => this.highlightNow());
  }

  private highlightNow(): void {
    const scene = this.scene;
    if (!scene) return;
    const p = this.palette;
    const selection = this.selection;
    const query = this.exporting ? null : this.query.highlight();
    for (const e of scene.edges) {
      const view = this.edgeViews.get(e.ref.id);
      if (!view) continue;
      let active = false;
      if (this.hoverField) {
        const { table, field } = this.hoverField;
        active =
          (e.ref.from.table === table && e.ref.from.fields.includes(field)) ||
          (e.ref.to.table === table && e.ref.to.fields.includes(field));
      } else if (this.hoverEdge) {
        active = e.ref.id === this.hoverEdge;
      } else if (this.hoverTable) {
        active = e.ref.from.table === this.hoverTable || e.ref.to.table === this.hoverTable;
      } else if (selection.size && !query) {
        active = selection.has(e.ref.from.table) || selection.has(e.ref.to.table);
      } else if (query) {
        active = query.refs.has(e.ref.id);
      }
      const discovered = e.kind === "discovered";
      const base = discovered ? p.edgeDiscovered : p.edge;
      const baseWidth = edgeStrokeWidth(e);
      for (const s of view.strokes) {
        s.stroke(active && !discovered ? p.edgeHighlight : base);
        s.strokeWidth(active ? baseWidth + 0.8 : baseWidth);
      }
      if (active) view.node.moveToTop();
    }
    for (const [id, view] of this.tableViews) {
      const isSel = selection.has(id) || !!query?.tables.has(id);
      view.body.stroke(isSel ? p.tableBorderSelected : p.tableBorder);
      view.body.strokeWidth(isSel ? 2 : 1);
    }
    this.applyTableOpacity();
    this.layer.batchDraw();
  }

  /**
   * Idle tables (X-ray) are dimmed; in focus mode, tables more than one relationship away from
   * the selected tables fade out, and so do the edges that touch no selected table.
   */
  private applyTableOpacity(): void {
    const scene = this.scene;
    if (!scene) return;
    const p = this.palette;
    const focus = this.store.focusMode() && !this.exporting && this.selection.size ? this.selection : null;
    const near = focus ? relatedTables(scene.edges.map((e) => e.ref), focus) : new Set<string>();
    const facts = this.workload.enabled() && !this.exporting ? this.workload.facts() : null;
    for (const [id, view] of this.tableViews) {
      const idle = facts?.get(id)?.neverUsed ? p.idleOpacity : 1;
      view.node.opacity(idle * (focus && !near.has(id) ? 0.25 : 1));
    }
    for (const e of scene.edges) {
      const dim = focus && !(focus.has(e.ref.from.table) || focus.has(e.ref.to.table));
      this.edgeViews.get(e.ref.id)?.node.opacity(dim ? 0.2 : 1);
    }
  }

  // ------------------------------------------------------------------ lint markers

  /** A small count badge on the top-right corner of each table with lint findings. */
  private applyLintMarkers(): void {
    if (!this.scene) return;
    const show = this.lint.showOnDiagram() && !this.exporting;
    const byTable = this.lint.byTable();
    for (const [id, view] of this.tableViews) {
      view.lint?.destroy();
      view.lint = null;
      const node = view.node;
      const findings = show ? byTable.get(id) : undefined;
      const box = this.scene.tables.get(id);
      if (!findings?.length || !box) continue;
      const worst = findings.some((f) => f.severity === "error") ? "error" : findings.some((f) => f.severity === "warning") ? "warning" : "info";
      const color = worst === "error" ? "#dc2626" : worst === "warning" ? "#d97706" : "#6b7280";
      const label = findings.length > 9 ? "9+" : String(findings.length);
      const badge = new Konva.Group({ x: box.w - 4, y: -4, name: "lint" });
      badge.add(
        new Konva.Circle({ radius: 9, fill: color, stroke: this.palette.tableBody, strokeWidth: 2 }),
        new Konva.Text({
          x: -9, y: -9, width: 18, height: 18, align: "center", verticalAlign: "middle", text: label,
          fontFamily: FONT_FAMILY, fontSize: 10, fontStyle: "700", fill: "#ffffff", listening: false,
        }),
      );
      badge.on("mouseenter", () => {
        const pointer = this.stage?.getPointerPosition();
        if (!pointer) return;
        const hostW = this.hostRef().nativeElement.clientWidth;
        const lines = findings.slice(0, 8).map((f) => `${f.severity === "error" ? "✖" : f.severity === "warning" ? "▲" : "•"} ${f.message}`);
        if (findings.length > 8) lines.push(`… and ${findings.length - 8} more (Lint tab)`);
        this.tooltip.set({ x: Math.min(pointer.x + 14, hostW - 350), y: pointer.y + 16, title: `Lint · ${box.table.label}`, lines, note: null });
      });
      badge.on("mouseleave", () => this.tooltip.set(null));
      node.add(badge);
      view.lint = badge;
    }
    this.layer.batchDraw();
  }

  // ------------------------------------------------------------------ X-ray overlay

  /** Live rates, idle dimming and seq-scan flags, applied to the existing table nodes. */
  private applyOverlay(): void {
    if (!this.scene) return;
    const p = this.palette;
    const on = this.workload.enabled() && !this.exporting;
    const rates = this.workload.rates();
    const pulse = this.workload.pulse();
    const facts = this.workload.facts();

    for (const [id, view] of this.tableViews) {
      const box = this.scene.tables.get(id);
      const { glow, rate: rateText, title } = view;
      if (!box) continue;

      const rate = on ? rates.get(id) : undefined;
      const fact = on ? facts.get(id) : undefined;
      const writes = rate?.writesPerSec ?? 0;
      const reads = rate?.readsPerSec ?? 0;
      const peak = Math.max(writes, reads);
      const intensity = peak > 0 ? Math.min(1, Math.log10(1 + peak) / 3) : 0;
      const baseOpacity = intensity > 0 ? 0.35 + 0.65 * intensity : 0;
      const baseBlur = 8 + 28 * intensity;

      glow.shadowColor(writes >= reads && writes > 0 ? p.glowWrite : p.glowRead);
      if (on && pulse.has(id)) {
        this.pulseGlow(glow, Math.max(baseOpacity, 0.3), baseBlur);
      } else if (!glow.getAttr("tween")) {
        glow.opacity(baseOpacity);
        glow.shadowBlur(baseBlur);
        glow.visible(baseOpacity > 0);
      }

      const parts: string[] = [];
      if (fact?.seqScanHeavy) parts.push("⚑");
      if (fact?.neverUsed) parts.push("idle");
      else if (rate && peak > 0) {
        if (writes > 0) parts.push(`${fmtRate(writes)} w/s`);
        if (reads > 0) parts.push(`${fmtRate(reads)} r/s`);
      }
      const text = parts.join("  ");
      rateText.text(text);
      rateText.visible(!!text && view.level === "full");
      rateText.fill(fact?.seqScanHeavy && parts.length === 1 ? p.flag : p.headerText);
      title.width(box.w - PAD_X * 2 - (text ? RATE_SLOT_W - 8 : 0));
    }
    this.applyTableOpacity();
    this.layer.batchDraw();
  }

  private pulseGlow(glow: Konva.Rect, baseOpacity: number, baseBlur: number): void {
    (glow.getAttr("tween") as Konva.Tween | undefined)?.destroy();
    glow.visible(true);
    glow.opacity(Math.max(baseOpacity, 0.95));
    glow.shadowBlur(Math.max(baseBlur, 40));
    const tween = new Konva.Tween({
      node: glow,
      duration: 0.7,
      opacity: baseOpacity,
      shadowBlur: baseBlur,
      easing: Konva.Easings.EaseOut,
      onFinish: () => {
        glow.setAttr("tween", null);
        glow.visible(baseOpacity > 0);
      },
    });
    glow.setAttr("tween", tween);
    tween.play();
  }

  private openEvidence(ref: VRef): void {
    const pointer = this.stage?.getPointerPosition();
    if (!pointer) return;
    const host = this.hostRef().nativeElement;
    this.tooltip.set(null);
    this.check.set(null);
    this.evidence.set({
      x: Math.max(8, Math.min(pointer.x + 12, host.clientWidth - 432)),
      y: Math.max(8, Math.min(pointer.y + 12, host.clientHeight * 0.4)),
      ref,
    });
  }

  protected async checkData(ref: VRef): Promise<void> {
    this.check.set({ refId: ref.id, loading: true, result: null });
    const result = await this.workload.checkRelation(ref);
    if (this.check()?.refId === ref.id) this.check.set(result ? { refId: ref.id, loading: false, result } : null);
  }

  protected promote(ref: VRef): void {
    this.workload.promote(ref);
    this.evidence.set(null);
  }

  // ------------------------------------------------------------------ tooltips

  private showTableTooltip(box: TableBox): void {
    const table = box.table;
    const fact = this.workload.enabled() ? this.workload.facts().get(table.id) : undefined;
    const rate = this.workload.enabled() ? this.workload.rates().get(table.id) : undefined;
    if (!fact && !rate && !table.note) return;
    const pointer = this.stage?.getPointerPosition();
    if (!pointer) return;
    const lines: string[] = [];
    if (fact) {
      const dead = fact.deadRatio >= 0.01 ? ` · ${Math.round(fact.deadRatio * 100)}% dead tuples` : "";
      lines.push(`~${fmtInt(fact.rows)} rows${dead}`);
      lines.push(
        `${fmtInt(fact.seqScan)} seq scans / ${fmtInt(fact.idxScan)} index scans` +
          (fact.seqScanHeavy ? " ⚑ mostly sequential on a large table" : ""),
      );
      lines.push(`${fmtInt(fact.inserts)} inserts · ${fmtInt(fact.updates)} updates · ${fmtInt(fact.deletes)} deletes`);
      if (fact.neverUsed) lines.push("idle: no reads or writes since the statistics were reset");
      if (fact.lastAutovacuum) lines.push(`last autovacuum ${fact.lastAutovacuum.slice(0, 19).replace("T", " ")}`);
    }
    if (rate && (rate.readsPerSec > 0 || rate.writesPerSec > 0)) {
      lines.push(`live: ${fmtRate(rate.writesPerSec)} writes/s · ${fmtRate(rate.readsPerSec)} reads/s`);
    }
    const hostW = this.hostRef().nativeElement.clientWidth;
    this.tooltip.set({ x: Math.min(pointer.x + 14, hostW - 350), y: pointer.y + 16, title: table.label, lines, note: table.note });
  }

  private showFieldTooltip(table: VTable, f: VField): void {
    const pointer = this.stage?.getPointerPosition();
    if (!pointer) return;
    const flags = [
      f.pk && "primary key",
      f.fk && "foreign key",
      f.unique && "unique",
      f.notNull && "not null",
      f.increment && "auto-increment",
      f.isEnum && "enum",
    ].filter(Boolean);
    const lines = [f.type + (flags.length ? ` · ${flags.join(", ")}` : "")];
    const profiled = this.browser.profiles().get(table.id)?.columns.find((c) => c.name === f.name);
    if (profiled) lines.push(`sample: ${profileSummary(profiled)}`);
    if (f.defaultValue !== null) lines.push(`default: ${f.defaultValue}`);
    const xray = this.workload.enabled();
    const report = this.workload.report();
    for (const r of this.store.view().refs) {
      if (r.from.table !== table.id || !r.from.fields.includes(f.name)) continue;
      lines.push(`→ ${r.to.table}(${r.to.fields.join(", ")})`);
      if (!xray) continue;
      const usage = this.workload.fkUsage().get(refKeyOf(r));
      if (report?.available && usage) {
        lines.push(usage.calls === 0 ? "   never joined by any recorded query" : `   joined in ${fmtInt(usage.calls)} calls`);
      }
      const card = this.workload.cardinality().get(`${table.id}.${f.name}`);
      if (card) {
        const nulls = card.childNullFrac >= 0.005 ? `, ${Math.round(card.childNullFrac * 100)}% null` : "";
        lines.push(
          `   in the data: ${card.verdict} · ${card.childrenPerParent.toFixed(card.childrenPerParent < 10 ? 1 : 0)} per parent, ` +
            `${Math.round(card.parentCoverage * 100)}% of parents referenced${nulls}`,
        );
      }
    }
    const hostW = this.hostRef().nativeElement.clientWidth;
    this.tooltip.set({
      x: Math.min(pointer.x + 14, hostW - 350),
      y: pointer.y + 16,
      title: `${table.label}.${f.name}`,
      lines,
      note: f.note,
    });
  }

  private setCursor(cursor: string): void {
    if (this.stage) this.stage.container().style.cursor = cursor;
  }

  // ------------------------------------------------------------------ viewport

  private onWheel(evt: WheelEvent): void {
    const stage = this.stage;
    if (!stage) return;
    evt.preventDefault();
    if (evt.ctrlKey || evt.metaKey) {
      const pointer = stage.getPointerPosition() ?? { x: stage.width() / 2, y: stage.height() / 2 };
      this.zoomAt(pointer, Math.exp(-evt.deltaY * 0.0025));
    } else {
      stage.position({ x: stage.x() - evt.deltaX, y: stage.y() - evt.deltaY });
      this.onViewportChanged();
    }
  }

  protected zoomBy(factor: number): void {
    const stage = this.stage;
    if (stage) this.zoomAt({ x: stage.width() / 2, y: stage.height() / 2 }, factor);
  }

  private zoomAt(pointer: Point, factor: number): void {
    const stage = this.stage;
    if (!stage) return;
    const old = stage.scaleX();
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, old * factor));
    const world = { x: (pointer.x - stage.x()) / old, y: (pointer.y - stage.y()) / old };
    stage.scale({ x: scale, y: scale });
    stage.position({ x: pointer.x - world.x * scale, y: pointer.y - world.y * scale });
    this.onViewportChanged();
  }

  private applyViewport(vp: Viewport): void {
    if (!this.stage) return;
    this.stage.scale({ x: vp.scale, y: vp.scale });
    this.stage.position({ x: vp.x, y: vp.y });
    this.onViewportChanged(false);
  }

  /** Updates the zoom label and background grid; persists the viewport (debounced). */
  private onViewportChanged(persist = true): void {
    const stage = this.stage;
    if (!stage) return;
    const scale = stage.scaleX();
    this.zoomPct.set(Math.round(scale * 100));
    const style = (this.el.nativeElement as HTMLElement).style;
    const size = GRID * scale;
    style.backgroundSize = `${size}px ${size}px`;
    style.backgroundPosition = `${stage.x()}px ${stage.y()}px`;
    this.updateViewRect();
    this.tooltip.set(null);
    this.menu.set(null);
    this.columnForm.set(null);
    // Overlays are positioned in screen space; panning or zooming commits an open rename.
    if (this.inlineEdit()) this.inlineInput()?.nativeElement.blur();
    if (!persist) return;
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      this.store.setViewport({ x: Math.round(stage.x()), y: Math.round(stage.y()), scale: +scale.toFixed(4) });
    }, 400);
  }

  private updateViewRect(): void {
    const stage = this.stage;
    if (!stage) return;
    const s = stage.scaleX();
    this.viewRect.set({ x: -stage.x() / s, y: -stage.y() / s, w: stage.width() / s, h: stage.height() / s });
    this.updateVisibility();
  }

  protected centerOn(p: Point): void {
    const stage = this.stage;
    if (!stage) return;
    const s = stage.scaleX();
    stage.position({ x: stage.width() / 2 - p.x * s, y: stage.height() / 2 - p.y * s });
    this.onViewportChanged();
  }

  protected toggleMinimap(): void {
    this.showMinimap.update((v) => !v);
    writeFlag("xdiagram.minimap", this.showMinimap());
  }

  // ------------------------------------------------------------------ DiagramHandle

  fit(): void {
    const stage = this.stage;
    const scene = this.scene;
    if (!stage || !scene || scene.tables.size === 0) return;
    const b = sceneBounds(scene);
    const pad = 48;
    const scale = Math.min(
      1,
      Math.max(MIN_SCALE, Math.min((stage.width() - pad * 2) / b.w, (stage.height() - pad * 2) / b.h)),
    );
    stage.scale({ x: scale, y: scale });
    stage.position({
      x: (stage.width() - b.w * scale) / 2 - b.x * scale,
      y: (stage.height() - b.h * scale) / 2 - b.y * scale,
    });
    this.onViewportChanged();
  }

  focusTable(id: string): void {
    const stage = this.stage;
    const box = this.scene?.tables.get(id);
    if (!stage || !box) return;
    const scale = Math.max(stage.scaleX(), 0.75);
    stage.scale({ x: scale, y: scale });
    stage.position({
      x: stage.width() / 2 - (box.x + box.w / 2) * scale,
      y: stage.height() / 2 - (box.y + box.h / 2) * scale,
    });
    this.selection = new Set([id]);
    this.applyHighlight();
    this.onViewportChanged();
  }

  /** Ctrl+A: every table on the canvas (hidden tables are not on it). */
  selectAll(): void {
    if (!this.scene || this.scene.tables.size === 0) return;
    this.selection = new Set(this.scene.tables.keys());
    this.applyHighlight();
    this.store.flash(`${this.selection.size} tables selected`);
  }

  /** Escape: false when there was nothing to clear or another canvas gesture owns Escape. */
  clearSelection(): boolean {
    if (!this.selection.size || this.menu() || this.inlineEdit() || this.columnForm() || this.linking || this.band) return false;
    this.selection.clear();
    this.applyHighlight();
    return true;
  }

  /**
   * Shift+drag on the empty background draws a selection box; the tables it touches join the
   * selection. Called in the capture phase, before Konva would start panning the stage.
   */
  private maybeStartBand(e: PointerEvent): void {
    const stage = this.stage;
    if (!stage || this.band || this.linking || e.button !== 0 || !e.shiftKey) return;
    stage.setPointersPositions(e);
    const pointer = stage.getPointerPosition();
    const start = stage.getRelativePointerPosition();
    if (!pointer || !start || stage.getIntersection(pointer)) return; // on a table or edge
    stage.draggable(false);
    const accent = this.palette.edgeHighlight;
    const rect = new Konva.Rect({
      x: start.x, y: start.y, width: 0, height: 0, listening: false,
      stroke: accent, strokeWidth: 1, strokeScaleEnabled: false, dash: [4, 3],
      // A faint wash of the accent colour (#rrggbb + alpha).
      fill: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}1f` : undefined,
    });
    this.layer.add(rect);
    const update = (ev: PointerEvent): Rect => {
      stage.setPointersPositions(ev);
      const at = stage.getRelativePointerPosition() ?? start;
      const r = normalizeRect(start, at);
      rect.setAttrs({ x: r.x, y: r.y, width: r.w, height: r.h });
      this.layer.batchDraw();
      return r;
    };
    const onMove = (ev: PointerEvent) => update(ev);
    const onUp = (ev: PointerEvent) => {
      const r = update(ev);
      end();
      if (!this.scene || r.w < 2 || r.h < 2) return;
      for (const id of tablesInRect(this.scene.tables, r)) this.selection.add(id);
      this.applyHighlight();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") end();
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
      rect.destroy();
      this.layer.batchDraw();
      stage.draggable(true);
      // Released after Konva reports the click, so the click still sees the band and keeps the selection.
      setTimeout(() => (this.band = null), 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
    this.band = { start, rect, end };
  }

  exportPng(): string | null {
    const stage = this.stage;
    if (!stage || !this.scene || this.scene.tables.size === 0) return null;
    // Exports use the light palette, without hover/selection state or the live overlay.
    const saved = { palette: this.palette, selection: this.selection, hoverTable: this.hoverTable, scale: stage.scaleX(), pos: stage.position() };
    this.exporting = true;
    this.palette = LIGHT;
    this.selection = new Set();
    this.hoverTable = null;
    this.rerender();

    const b = sceneBounds(this.scene);
    const pad = 40;
    const w = b.w + pad * 2;
    const h = b.h + pad * 2;
    const bg = new Konva.Rect({ x: b.x - pad, y: b.y - pad, width: w, height: h, fill: LIGHT.background, listening: false });
    this.layer.add(bg);
    bg.moveToBottom();
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: -(b.x - pad), y: -(b.y - pad) });
    // Stay inside browser canvas limits for very large diagrams.
    const pixelRatio = Math.max(0.25, Math.min(2, 16000 / w, 16000 / h, Math.sqrt(120_000_000 / (w * h))));
    let url: string | null = null;
    try {
      url = stage.toDataURL({ x: 0, y: 0, width: w, height: h, pixelRatio, mimeType: "image/png" });
    } finally {
      bg.destroy();
      stage.scale({ x: saved.scale, y: saved.scale });
      stage.position(saved.pos);
      this.palette = saved.palette;
      this.selection = saved.selection;
      this.hoverTable = saved.hoverTable;
      this.exporting = false;
      this.rerender();
    }
    return url;
  }

  exportSvg(): string | null {
    if (!this.scene || this.scene.tables.size === 0) return null;
    return sceneToSvg(this.scene, LIGHT, this.store.exportBaseName());
  }
}

/** A table's Konva node and the parts updated in place (highlight, overlay, level of detail). */
interface TableView {
  /** Content signature (see `tableSig`): the node is reused while it stays the same. */
  sig: string;
  node: Konva.Group;
  body: Konva.Rect;
  glow: Konva.Rect;
  title: Konva.Text;
  rate: Konva.Text;
  /** Created the first time the table is drawn up close. */
  rows: Konva.Group | null;
  lint: Konva.Group | null;
  /** Mid zoom: row dividers and a large name instead of the rows (created on first use). */
  skeleton: Konva.Shape | null;
  label: Konva.Text | null;
  shown: boolean;
  level: DetailMode;
}

/** How a table is drawn at the current zoom: everything, a large name, or just its box. */
type DetailMode = "full" | "mid" | "far";

interface EdgeView {
  sig: string;
  node: Konva.Group;
  strokes: Konva.Line[];
  bounds: Rect;
  shown: boolean;
}

/** Below this zoom, rows are too small to read: tables are drawn without rows or shadows. */
const DETAIL_SCALE = 0.45;
/** Below this zoom, table names are not drawn either (boxes only). */
const TITLE_SCALE = 0.22;
/** On-screen size (px) of the table names drawn at mid zoom. */
const MID_LABEL_PX = 12;
/** Nodes this close to the viewport (screen pixels) are drawn too, so panning shows no gaps. */
const CULL_MARGIN = 200;

/** Everything a table's node is drawn from, besides its position. */
function tableSig(box: TableBox): string {
  const t = box.table;
  let sig = `${box.w}|${box.h}|${t.label}|${t.headerColor ?? ""}`;
  for (const f of box.fields) sig += `|${f.name}:${f.type}:${f.pk ? 1 : 0}${f.fk ? 1 : 0}`;
  return sig;
}

function edgeSig(e: EdgeRoute): string {
  return `${e.kind}|${e.directed ? 1 : 0}|${e.weight}|${e.from.side}${e.from.many ? 1 : 0}|${e.to.side}${e.to.many ? 1 : 0}|${e.points.join(",")}`;
}

/** Bounding box of a polyline, padded for the end markers. */
function pointsBounds(points: number[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  const pad = 16;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** Shift, Ctrl or Cmd held: a click adds to (or removes from) the selection instead of replacing it. */
function isAdditive(evt: Event | undefined): boolean {
  const e = evt as Partial<MouseEvent> | undefined;
  return !!(e?.shiftKey || e?.ctrlKey || e?.metaKey);
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* best-effort preference */
  }
}

function refKeyOf(r: VRef): string {
  const side = (e: { table: string; fields: string[] }) => `${e.table}(${[...e.fields].sort().join(",")})`;
  const [a, b] = [side(r.from), side(r.to)].sort();
  return `${a}|${b}`;
}

function fmtRate(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10) return String(Math.round(v));
  return v.toFixed(1);
}

function fmtInt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
