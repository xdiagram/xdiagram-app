/** Types shared by the module finder (pure code: no Angular, no I/O). */

/** Where the edge weights came from: X-ray's query traffic, or only the declared relationships. */
export type GraphSource = "traffic" | "declared";

/** "extend": existing TableGroups stay as they are and only gain tables. "all": everything is recomputed. */
export type FindMode = "extend" | "all";

/** Every relationship between two different tables, merged per table pair (`a` < `b`). */
export interface Link {
  a: string;
  b: string;
  /** Some declared foreign key links the two tables. */
  declared: boolean;
  /** Join calls seen in the query traffic (declared FK usage plus undeclared joins); 0 without traffic. */
  calls: number;
}

/** A DBML `TableGroup` already in the document. */
export interface ExistingGroup {
  id: string;
  name: string;
  color: string | null;
  tables: string[];
}

export interface ProposedModule {
  /** Stable within a series of proposals: the group id it updates, else derived from its first centre. */
  key: string;
  name: string;
  color: string;
  /** Table ids, sorted. */
  tables: string[];
  /** The table the name was taken from (for a hub's own tables: the hub, which is not a member). */
  central: string;
  /** Id of the DBML TableGroup this module updates, or null for a new group. */
  existing: string | null;
  /** An existing group kept as it is (extend mode): its tables never left it. */
  locked: boolean;
  /** Tables that join the existing group. */
  added: number;
  /** Set when the module is the tables that link only to this common table. */
  satelliteOf: string | null;
}

/** A table that would change group. `to` is null when it leaves for the common or other tables. */
export interface ModuleMove {
  table: string;
  from: string;
  to: string | null;
}

export interface ModuleProposal {
  mode: FindMode;
  source: GraphSource;
  resolution: number;
  /** Largest first. */
  modules: ProposedModule[];
  /** Common (hub) tables, kept out of the modules. Most linked first. */
  common: string[];
  /** The common tables found from the data, before the user's own additions and removals. */
  detected: string[];
  /** Tables with no relationship to any module. */
  other: string[];
  moves: ModuleMove[];
  /** Ids of existing groups that no module continues (all mode only). */
  removedGroups: string[];
  /** Number of tables the proposal was computed on, to notice tables added since. */
  tableCount: number;
}

/**
 * What Find modules keeps for a document next to the Modules arrangement's positions (in
 * `layouts.json`): the DBML has no place for the common tables or a proposal not yet accepted.
 */
export interface ModulesDoc {
  /** Tables the user made common, and detected ones they put back; kept across recomputations. */
  commonAdded: string[];
  commonRemoved: string[];
  /** Common tables of the accepted modules (a pending proposal has its own). */
  common: string[];
  /** Found but not yet accepted or rejected. */
  proposal: ModuleProposal | null;
  /** What Reject goes back to when the proposal replaced accepted modules (null: discard them). */
  previous: { positions: Record<string, { x: number; y: number }>; common: string[] } | null;
  /** Granularity last used (Louvain resolution). */
  resolution: number;
}
