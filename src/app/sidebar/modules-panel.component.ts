import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";

import { displayTable, relatedTables } from "../diagram/view-model";
import { MODULE_COLORS, RESOLUTIONS } from "../modules/find-modules";
import type { ProposedModule } from "../modules/types";
import { ModulesStore } from "../state/modules.store";
import { WorkspaceStore } from "../state/workspace.store";

interface Row {
  key: string;
  name: string;
  color: string | null;
  tables: string[];
  badge: string | null;
  title: string;
  module: ProposedModule | null;
}

/** Side-panel tab: find modules, review the proposal (names, colours, common tables), accept or reject. */
@Component({
  selector: "app-modules-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="title">Modules</span>
      <span class="actions">
        <button type="button" class="link" (click)="modules.find('extend')" [disabled]="busy()"
          title="Group the tables by how they work together. Existing TableGroups are kept and only gain tables.">Find</button>
        <button type="button" class="link" (click)="modules.find('all')" [disabled]="busy()"
          title="Recompute every module, existing TableGroups included (nothing changes until you accept)">Recompute all</button>
      </span>
    </div>

    @if (!doc()) {
      <div class="intro">
        <p>Groups the tables into modules by how they work together: tables joined together often end up in one module.
          Tables linked to everything (users, tenants) are kept apart as common tables.</p>
        <p class="muted">{{ basisHint() }}</p>
        <p class="muted">The modules get their own layout, next to yours: <b>View → Layout</b> switches between them.
          Nothing is written to the DBML until you accept.</p>
        <button type="button" class="primary" (click)="modules.find()" [disabled]="busy() || !store.view().tables.length">Find modules</button>
      </div>
    } @else {
      @if (proposal(); as p) {
        <div class="bar">
          <div class="summary">
            <b>{{ p.modules.length }}</b> modules · <b>{{ p.common.length }}</b> common · <b>{{ p.other.length }}</b> other
            <span class="muted">— not saved yet</span>
          </div>
          <div class="buttons">
            <button type="button" class="ghost" (click)="modules.reject()" title="Discard this proposal">Reject</button>
            <button type="button" class="primary small" (click)="modules.accept()" [disabled]="busy() || store.diagnostics().length > 0"
              [title]="store.diagnostics().length ? 'Fix the errors in the DBML first' : acceptTitle(p.modules.length, p.removedGroups.length)">Accept</button>
          </div>
        </div>
        <div class="note" [class.warn]="basis().warn">{{ basis().text }}</div>
        @if (modules.stale(); as n) {
          <div class="note warn">{{ n }} {{ n === 1 ? "table was" : "tables were" }} added since.
            <button type="button" class="link" (click)="modules.find(p.mode, p.resolution)">Find again</button></div>
        }
        <div class="granularity" role="radiogroup" aria-label="Module size">
          @for (g of granularities; track g.value) {
            <button type="button" role="radio" [attr.aria-checked]="p.resolution === g.value" [class.on]="p.resolution === g.value"
              (click)="modules.setResolution(g.value)" [disabled]="busy()" [title]="g.title">{{ g.label }}</button>
          }
        </div>
      } @else {
        <div class="bar">
          <div class="summary"><b>{{ rows().length }}</b> modules in the DBML · <b>{{ commonRows().length }}</b> common</div>
        </div>
      }

      <div class="list">
        @for (r of rows(); track r.key) {
          <div class="row" [class.sel]="modules.selected() === r.key">
            @if (r.module) {
              <button type="button" class="swatch" [style.background]="r.color" (click)="colorFor.set(colorFor() === r.key ? null : r.key)"
                title="Change the colour" aria-label="Change the colour"></button>
              <input class="name" [value]="r.name" spellcheck="false" aria-label="Module name"
                (keydown.enter)="$any($event.target).blur()" (change)="rename(r.key, $event)" />
            } @else {
              <span class="swatch" [style.background]="r.color ?? 'var(--border)'"></span>
              <span class="name static">{{ r.name }}</span>
            }
            <button type="button" class="count" (click)="modules.showModule(r.key, r.tables)" [title]="r.title">
              {{ r.tables.length }}
              @if (r.badge) {
                <span class="badge">{{ r.badge }}</span>
              }
            </button>
          </div>
          @if (colorFor() === r.key) {
            <div class="colors">
              @for (c of colors; track c) {
                <button type="button" [style.background]="c" [class.on]="c === r.color" (click)="modules.setColor(r.key, c); colorFor.set(null)"
                  [attr.aria-label]="'Colour ' + c"></button>
              }
            </div>
          }
        }

        <div class="section">
          <div class="s-head">Common tables <span class="count-muted">{{ commonRows().length }}</span></div>
          @for (c of commonRows(); track c.id) {
            <div class="item">
              <button type="button" class="t" (click)="focus(c.id)" [title]="c.detected ? 'Found from the relationships' : 'Made common by you'">
                {{ short(c.id) }} <span class="muted">· links {{ c.modules }} {{ c.modules === 1 ? "module" : "modules" }}</span>
              </button>
              @if (proposal()) {
                <button type="button" class="x" (click)="modules.toggleCommon(c.id)" [disabled]="busy()" title="Put it back into a module">×</button>
              }
            </div>
          }
          @if (proposal()) {
            <input class="add" list="modules-tables" placeholder="Add a common table…" aria-label="Add a common table" spellcheck="false"
              (change)="addCommon($event)" />
            <datalist id="modules-tables">
              @for (t of candidates(); track t) {
                <option [value]="short(t)"></option>
              }
            </datalist>
          }
        </div>

        @if (otherTables().length) {
          <div class="section">
            <button type="button" class="s-head toggle" (click)="otherOpen.set(!otherOpen())" [attr.aria-expanded]="otherOpen()">
              {{ otherOpen() ? "▾" : "▸" }} Other tables <span class="count-muted">{{ otherTables().length }}</span>
            </button>
            @if (otherOpen()) {
              @for (t of otherTables(); track t) {
                <button type="button" class="t" (click)="focus(t)">{{ short(t) }}</button>
              }
            }
          </div>
        }

        @if (proposal(); as p) {
          @if (p.moves.length || p.removedGroups.length) {
            <div class="section">
              <div class="s-head">What would change in the DBML</div>
              @for (g of p.removedGroups; track g) {
                <div class="move">Group <b>{{ groupName(g) }}</b> would be removed</div>
              }
              @for (m of p.moves; track m.table) {
                <div class="move">{{ short(m.table) }}: {{ m.from }} → {{ m.to ?? "no group" }}</div>
              }
            </div>
          }
        }
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
    .head { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 12px;
      border-bottom: 1px solid var(--border); font-size: 12px; flex: none; }
    .title { font-weight: 600; letter-spacing: 0.04em; color: var(--text-muted); }
    .actions { display: flex; gap: 12px; }
    .link { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; padding: 0; }
    .link:disabled { opacity: 0.5; cursor: default; }
    .intro { padding: 12px; font-size: 12.5px; line-height: 1.5; overflow: auto; }
    .intro p { margin: 0 0 10px; }
    .muted { color: var(--text-muted); }
    .primary { font: inherit; font-size: 12.5px; font-weight: 600; border: 0; border-radius: 6px; padding: 6px 12px;
      background: var(--accent); color: #fff; cursor: pointer; }
    .primary:disabled { opacity: 0.5; cursor: default; }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; font-size: 12px;
      border-bottom: 1px solid var(--border); flex: none; }
    .buttons { display: flex; gap: 6px; flex: none; }
    .ghost { font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text);
      border-radius: 6px; padding: 3px 10px; cursor: pointer; }
    .ghost:disabled, .primary.small:disabled { opacity: 0.5; cursor: default; }
    .primary.small { padding: 3px 10px; font-size: 12px; }
    .note { padding: 6px 12px; font-size: 11.5px; color: var(--text-muted); border-bottom: 1px solid var(--border); flex: none; }
    .note.warn { color: var(--warn, #b45309); }
    .granularity { display: flex; gap: 4px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex: none; }
    .granularity button { flex: 1; font: inherit; font-size: 11.5px; border: 1px solid var(--border); background: var(--panel);
      color: var(--text); border-radius: 6px; padding: 3px 0; cursor: pointer; }
    .granularity button.on { border-color: var(--accent); background: var(--accent-soft); font-weight: 600; }
    .list { overflow: auto; flex: 1; padding: 6px 6px 14px; }
    .row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 6px; }
    .row:hover, .row.sel { background: var(--hover); }
    .swatch { width: 14px; height: 14px; border-radius: 4px; border: 0; padding: 0; flex: none; cursor: pointer; }
    span.swatch { cursor: default; }
    .name { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: var(--text); background: transparent;
      border: 1px solid transparent; border-radius: 5px; padding: 3px 5px; }
    .name:hover, .name:focus { border-color: var(--border); background: var(--input-bg); }
    .name.static { border: 0; padding: 4px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { flex: none; display: flex; align-items: center; gap: 4px; font: inherit; font-size: 12px; font-variant-numeric: tabular-nums;
      border: 0; background: none; color: var(--text-muted); cursor: pointer; padding: 3px 4px; border-radius: 5px; }
    .count:hover { color: var(--accent); }
    .badge { font-size: 10.5px; color: var(--accent); background: var(--accent-soft); border-radius: 8px; padding: 0 5px; }
    .colors { display: flex; flex-wrap: wrap; gap: 5px; padding: 4px 8px 6px 26px; }
    .colors button { width: 18px; height: 18px; border-radius: 5px; border: 2px solid transparent; cursor: pointer; padding: 0; }
    .colors button.on { border-color: var(--text); }
    .section { margin-top: 12px; }
    .s-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em; padding: 4px 6px; }
    .s-head.toggle { border: 0; background: none; font-family: inherit; cursor: pointer; width: 100%; text-align: left; }
    .count-muted { font-weight: 500; }
    .item { display: flex; align-items: center; border-radius: 6px; }
    .item:hover { background: var(--hover); }
    .t { flex: 1; min-width: 0; display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--text);
      font: inherit; font-size: 12px; padding: 4px 6px; cursor: pointer; border-radius: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t:hover { background: var(--hover); }
    .x { flex: none; border: 0; background: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 0 8px; }
    .x:hover { color: var(--danger); }
    .add { margin: 4px 6px; width: calc(100% - 12px); box-sizing: border-box; font: inherit; font-size: 12px; color: var(--text);
      background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 7px; }
    .move { font-size: 12px; padding: 3px 6px; color: var(--text); }
  `,
})
export class ModulesPanelComponent {
  protected readonly modules = inject(ModulesStore);
  protected readonly store = inject(WorkspaceStore);
  protected readonly short = displayTable;
  protected readonly colors = MODULE_COLORS;
  protected readonly colorFor = signal<string | null>(null);
  protected readonly otherOpen = signal(false);
  protected readonly granularities = [
    { label: "Coarser", value: RESOLUTIONS.coarser, title: "Fewer, larger modules" },
    { label: "Normal", value: RESOLUTIONS.normal, title: "The default module size" },
    { label: "Finer", value: RESOLUTIONS.finer, title: "More, smaller modules" },
  ];

  protected readonly doc = this.modules.doc;
  protected readonly proposal = this.modules.proposal;
  protected readonly busy = computed(() => this.modules.computing() || !!this.store.busy());

  /** The modules shown: the proposal's, or the DBML groups once accepted. */
  protected readonly rows = computed<Row[]>(() => {
    const p = this.proposal();
    if (p) {
      return p.modules.map((m) => ({
        key: m.key,
        name: m.name,
        color: m.color,
        tables: m.tables,
        module: m,
        badge: m.existing ? (m.added ? `+${m.added}` : "kept") : m.satelliteOf ? `${this.short(m.satelliteOf)}'s` : null,
        title: m.existing
          ? `Existing group${m.added ? `, ${m.added} tables join it` : ""}. Click to show it.`
          : m.satelliteOf
            ? `Tables linked only to ${this.short(m.satelliteOf)}. Click to show them.`
            : `Central table: ${this.short(m.central)}. Click to show the module.`,
      }));
    }
    return this.store.view().groups.map((g) => ({ key: g.id, name: g.name, color: g.color, tables: g.tables, module: null, badge: null, title: "Click to show it" }));
  });

  protected readonly commonRows = computed(() => {
    const p = this.proposal();
    const doc = this.doc();
    const ids = p ? p.common : (doc?.common ?? []);
    const view = this.store.view();
    const moduleOf = new Map<string, string>();
    for (const r of this.rows()) for (const t of r.tables) moduleOf.set(t, r.key);
    return ids
      .filter((id) => view.tables.some((t) => t.id === id))
      .map((id) => {
        const near = relatedTables(view.refs, id);
        const touched = new Set([...near].map((t) => moduleOf.get(t)).filter(Boolean));
        return { id, modules: touched.size, detected: !!p?.detected.includes(id) };
      });
  });

  protected readonly otherTables = computed(() => {
    const p = this.proposal();
    if (p) return p.other;
    if (!this.doc()) return [];
    const placed = new Set([...this.rows().flatMap((r) => r.tables), ...this.commonRows().map((c) => c.id)]);
    return this.store.view().tables.map((t) => t.id).filter((id) => !placed.has(id));
  });

  /** Tables that can still be made common. */
  protected readonly candidates = computed(() => {
    const common = new Set(this.proposal()?.common ?? []);
    return this.store.view().tables.map((t) => t.id).filter((id) => !common.has(id));
  });

  protected readonly basisHint = computed(() => {
    const src = this.store.source();
    if (src?.kind === "db" && src.engine === "postgres") {
      return "Uses the query traffic (pg_stat_statements, read-only) and the declared relationships.";
    }
    return "Uses the declared relationships (query traffic is read on PostgreSQL only).";
  });

  protected readonly basis = computed(() => {
    const p = this.proposal();
    const src = this.modules.source();
    if (!p) return { text: "", warn: false };
    if (!p.modules.length && !p.common.length) return { text: "No relationships to work from: every table is in Other tables.", warn: true };
    if (p.source === "traffic") {
      const joins = src?.joins ? ` (${src.joins.toLocaleString()} join calls)` : "";
      return { text: `Based on query traffic${joins} and the declared relationships.`, warn: false };
    }
    const db = this.store.source();
    if (db?.kind === "db" && db.engine === "postgres") {
      const why = src?.note ? `: ${src.note}` : "";
      return { text: `Based on the declared relationships only, no query traffic${why}.`, warn: true };
    }
    return { text: "Based on the declared relationships (query traffic is read on PostgreSQL only).", warn: false };
  });

  protected rename(key: string, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!this.modules.rename(key, input.value)) {
      input.value = this.proposal()?.modules.find((m) => m.key === key)?.name ?? input.value;
    }
  }

  protected addCommon(event: Event): void {
    const input = event.target as HTMLInputElement;
    const typed = input.value.trim();
    const id = this.store.view().tables.find((t) => this.short(t.id) === typed || t.id === typed)?.id;
    input.value = "";
    if (!id) {
      if (typed) this.store.flash(`No table named “${typed}”`);
      return;
    }
    void this.modules.toggleCommon(id);
  }

  protected acceptTitle(modules: number, removed: number): string {
    const rm = removed ? `, removes ${removed}` : "";
    return `Writes ${modules} TableGroups into the DBML${rm} (one Ctrl+Z undoes it)`;
  }

  protected groupName(id: string): string {
    return this.store.view().groups.find((g) => g.id === id)?.name ?? id;
  }

  protected focus(id: string): void {
    if (this.store.hidden().has(id)) this.store.toggleHidden(id);
    setTimeout(() => this.store.diagram?.focusTable(id), 0);
  }
}
