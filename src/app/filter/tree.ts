import type { BrowseFilter } from "../core/tauri-api.service";
import { type CondNode, type FilterNode, type GroupNode, newId, SEARCH_COLUMN } from "./model";

/** All edits return a new tree (signals compare by reference). */

export function emptyRoot(): GroupNode {
  return { t: "group", id: newId(), op: "and", items: [] };
}

/** Equality filters (FK navigation, older callers) as a tree. */
export function fromEquality(filters: BrowseFilter[], origin?: "nav"): GroupNode {
  const root = emptyRoot();
  root.items = filters.map(
    (f): CondNode => ({ t: "cond", id: newId(), column: f.column, op: f.value === null ? "isNull" : "eq", args: f.value === null ? [] : [f.value], ...(origin ? { origin } : {}) }),
  );
  return root;
}

function mapTree(node: FilterNode, fn: (n: FilterNode) => FilterNode | null): FilterNode | null {
  const mapped = fn(node);
  if (!mapped || mapped.t !== "group") return mapped;
  return { ...mapped, items: mapped.items.map((i) => mapTree(i, fn)).filter((i): i is FilterNode => !!i) };
}

export function findNode(root: FilterNode, id: string): FilterNode | null {
  if (root.id === id) return root;
  if (root.t === "group") {
    for (const item of root.items) {
      const found = findNode(item, id);
      if (found) return found;
    }
  }
  return null;
}

/** Adds `node` to the group `groupId` (default: the root). */
export function addNode(root: GroupNode, node: FilterNode, groupId = root.id): GroupNode {
  return mapTree(root, (n) => (n.id === groupId && n.t === "group" ? { ...n, items: [...n.items, node] } : n)) as GroupNode;
}

export function replaceNode(root: GroupNode, id: string, node: FilterNode): GroupNode {
  if (root.id === id) return node.t === "group" ? node : { ...root, items: [node] };
  return mapTree(root, (n) => (n.id === id ? node : n)) as GroupNode;
}

/** Removes a node; a group left empty goes too (except the root). */
export function removeNode(root: GroupNode, id: string): GroupNode {
  const pruned = mapTree(root, (n) => (n.id === id ? null : n)) as GroupNode;
  return mapTree(pruned, (n) => (n.t === "group" && n.id !== root.id && n.items.length === 0 ? null : n)) as GroupNode;
}

/** Switches a node off (kept, not applied) or back on. */
export function toggleOff(root: GroupNode, id: string): GroupNode {
  return mapTree(root, (n) => (n.id === id ? { ...n, off: !n.off } : n)) as GroupNode;
}

/** The conditions directly under the root on `column` (what that column's filter box shows). */
export function topConds(root: GroupNode, column: string): CondNode[] {
  return root.items.filter((n): n is CondNode => n.t === "cond" && n.column === column);
}

/**
 * Replaces the root's direct nodes for `column` (conditions on it, or a one-column group from the
 * quick syntax) with `node`; `null` only removes them.
 */
export function setColumnFilter(root: GroupNode, column: string, node: FilterNode | null): GroupNode {
  const kept = root.items.filter((n) => singleColumn(n) !== column);
  return { ...root, items: node ? [...kept, node] : kept };
}

/** The column a node is about, when it is a condition or a group of conditions on one column. */
export function singleColumn(n: FilterNode): string | null {
  if (n.t === "cond") return n.column;
  const cols = new Set(n.items.map(singleColumn));
  return cols.size === 1 && !cols.has(null) ? [...cols][0] : null;
}

/**
 * The tree with each condition's column renamed by `fn` (searches across all columns are
 * kept); `null` removes the condition, and groups it leaves empty (not the root).
 */
export function renameColumns(root: GroupNode, fn: (column: string) => string | null): GroupNode {
  const renamed = mapTree(root, (n) => {
    if (n.t !== "cond" || n.column === SEARCH_COLUMN) return n;
    const column = fn(n.column);
    return column === null ? null : column === n.column ? n : { ...n, column };
  }) as GroupNode;
  return mapTree(renamed, (n) => (n.t === "group" && n.id !== root.id && n.items.length === 0 ? null : n)) as GroupNode;
}

/** The same tree with new ids (a saved filter applied again is a new set of chips). */
export function reId<T extends FilterNode>(n: T): T {
  return n.t === "group" ? { ...n, id: newId(), items: n.items.map(reId) } : { ...n, id: newId() };
}

export function countNodes(n: FilterNode): number {
  return n.t === "group" ? 1 + n.items.reduce((s, i) => s + countNodes(i), 0) : 1;
}

/** Whether any condition applies (switched-off ones and empty groups do not). */
export function hasActive(n: FilterNode | null): boolean {
  if (!n || n.off) return false;
  return n.t === "cond" || n.items.some(hasActive);
}

export function columnsUsed(n: FilterNode, into = new Set<string>()): Set<string> {
  if (n.t === "cond") into.add(n.column);
  else for (const i of n.items) columnsUsed(i, into);
  return into;
}

/** The tree without nodes that came from FK navigation (what is remembered for a table). */
export function withoutNav(root: GroupNode): GroupNode {
  return removeWhere(root, (n) => n.t === "cond" && n.origin === "nav");
}

function removeWhere(root: GroupNode, pred: (n: FilterNode) => boolean): GroupNode {
  return mapTree(root, (n) => (n.id !== root.id && pred(n) ? null : n)) as GroupNode;
}
