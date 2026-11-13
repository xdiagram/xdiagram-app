import { Injectable, inject } from "@angular/core";

import { loadDbmlCore } from "../core/dbml";
import {
  insertColumn,
  isValidName,
  newTableBlock,
  refLine,
  renameColumnText,
  splitTableId,
  uniqueName,
} from "../diagram/canvas-edit";
import { refKey, type VField } from "../diagram/view-model";
import { findUsages } from "../editor/dbml-language";
import type { Point } from "../persistence/layout.service";
import { WorkspaceStore } from "./workspace.store";

const DEFAULT_SCHEMA = "public";

/**
 * Edits made on the canvas. Each one rewrites the DBML text (the source of truth) through
 * `WorkspaceStore.applyDbmlEdit`, so it shows up in the editor and is one Ctrl+Z away.
 */
@Injectable({ providedIn: "root" })
export class CanvasActions {
  private readonly store = inject(WorkspaceStore);

  /** Offsets come from the last successful parse, so text edits wait until the DBML is valid. */
  canEdit(): boolean {
    if (!this.store.hasModel()) return false;
    if (this.store.diagnostics().length > 0) {
      this.store.flash("Fix the errors in the DBML first");
      return false;
    }
    return true;
  }

  private table(id: string) {
    return this.store.view().tables.find((t) => t.id === id) ?? null;
  }

  /** Returns the new table id, or null when nothing changed. */
  async renameTable(id: string, newName: string): Promise<string | null> {
    const name = newName.trim();
    const { schema, table } = splitTableId(id);
    if (name === table || !this.canEdit()) return null;
    if (!isValidName(name)) return this.reject(`"${name}" is not a valid table name`);
    const newId = `${schema}.${name}`;
    if (this.table(newId)) return this.reject(`A table named ${name} already exists`);

    const { renameTable } = await loadDbmlCore();
    const ident = (t: string) => (schema === DEFAULT_SCHEMA ? { table: t } : { schema, table: t });
    const dbml = this.store.dbml();
    const next = renameTable(ident(table), ident(name), dbml);
    if (next === dbml) return this.reject(`Could not rename ${table}`);
    this.store.renameTableId(id, newId);
    this.store.applyDbmlEdit(next);
    return newId;
  }

  async renameColumn(tableId: string, field: VField, newName: string): Promise<void> {
    const name = newName.trim();
    if (name === field.name || !this.canEdit()) return;
    if (!isValidName(name)) return void this.reject(`"${name}" is not a valid column name`);
    const t = this.table(tableId);
    if (t?.fields.some((f) => f.name === name)) return void this.reject(`${t.name} already has a column named ${name}`);
    if (field.offset === null) return void this.reject("Could not locate the column in the DBML");

    const dbml = this.store.dbml();
    // Position inside the name (past an opening quote) so the service resolves the column.
    const usages = await findUsages(dbml, field.offset + 1);
    this.store.applyDbmlEdit(renameColumnText(dbml, field.offset, usages, name));
  }

  async setHeaderColor(id: string, color: string | null): Promise<void> {
    if (!this.canEdit()) return;
    const { updateElementSetting, SymbolKind } = await loadDbmlCore();
    const { schema, table } = splitTableId(id);
    const target = schema === DEFAULT_SCHEMA ? { kind: SymbolKind.Table, table } : { kind: SymbolKind.Table, schema, table };
    this.store.applyDbmlEdit(updateElementSetting(this.store.dbml(), target as never, "headercolor", color));
  }

  addColumn(tableId: string, name: string, type: string): void {
    if (!this.canEdit()) return;
    const t = this.table(tableId);
    if (!t || t.endOffset === null) return void this.reject("Could not locate the table in the DBML");
    if (!isValidName(name)) return void this.reject(`"${name.trim()}" is not a valid column name`);
    if (t.fields.some((f) => f.name === name.trim())) return void this.reject(`${t.name} already has a column named ${name.trim()}`);
    this.store.applyDbmlEdit(insertColumn(this.store.dbml(), t.endOffset, name, type));
  }

  /** Appends a new table placed at `at` (diagram coordinates); returns its id. */
  newTable(at: Point): string | null {
    if (this.store.hasModel() && this.store.diagnostics().length > 0) {
      this.store.flash("Fix the errors in the DBML first");
      return null;
    }
    const taken = new Set(this.store.view().tables.filter((t) => t.schema === DEFAULT_SCHEMA).map((t) => t.name));
    const id = `${DEFAULT_SCHEMA}.${uniqueName("new_table", taken)}`;
    this.store.moveTables({ [id]: { x: Math.round(at.x), y: Math.round(at.y) } });
    this.store.appendDbml(newTableBlock(id));
    return id;
  }

  /**
   * Adds a relationship drawn between two columns. The side whose column is a primary/unique key
   * is the referenced one; two keys make it one-to-one (`-`).
   */
  addRef(from: { table: string; field: string }, to: { table: string; field: string }): void {
    if (from.table === to.table && from.field === to.field) return;
    if (!this.canEdit()) return;
    const isKey = (end: { table: string; field: string }) => {
      const f = this.table(end.table)?.fields.find((x) => x.name === end.field);
      return !!(f?.pk || f?.unique);
    };
    let child = from;
    let parent = to;
    if (isKey(from) && !isKey(to)) [child, parent] = [to, from];
    const childEnd = { table: child.table, fields: [child.field] };
    const parentEnd = { table: parent.table, fields: [parent.field] };
    const exists = this.store
      .view()
      .refs.some((r) => refKey(r.from, r.to) === refKey({ ...childEnd, many: false }, { ...parentEnd, many: false }));
    if (exists) return void this.store.flash("That relationship already exists");
    const op = isKey(child) && isKey(parent) ? "-" : ">";
    this.store.appendDbml(refLine(childEnd, parentEnd, op));
    this.store.flash(`Added ${child.field} → ${parent.table.replace(/^public\./, "")}.${parent.field}`);
  }

  private reject(message: string): null {
    this.store.flash(message);
    return null;
  }
}
