//! The schema graph the caller sends, and the index the search runs on.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::cost::{edge_cost, hub_penalty};

/// A table. `id` is how edges and requests name it (the app uses `schema.table`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNode {
    pub id: String,
    pub schema: String,
    pub name: String,
}

/// Where a relationship comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    /// A foreign key (or a `Ref` in the DBML).
    Declared,
    /// A join seen in the query traffic that no foreign key backs.
    Discovered,
}

/// How many rows of a side match one row of the other side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Multiplicity {
    One,
    Many,
    Unknown,
}

/// One column of each side, joined with `=`. `from` is a column of the edge's `from` table.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPair {
    pub from: String,
    pub to: String,
}

/// A relationship between two tables. A composite foreign key is one edge with several pairs;
/// two foreign keys between the same tables are two edges.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    /// Unique in the graph; reported back in the paths.
    pub id: String,
    /// The referencing side (the foreign key's table).
    pub from: String,
    /// The referenced side.
    pub to: String,
    pub pairs: Vec<ColumnPair>,
    pub kind: EdgeKind,
    pub from_mult: Multiplicity,
    pub to_mult: Multiplicity,
    /// Join calls seen in the query traffic (0 when unknown).
    #[serde(default)]
    pub calls: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaGraph {
    pub tables: Vec<TableNode>,
    pub edges: Vec<Edge>,
}

/// One way to cross a link: an edge, walked forward (from its `from` table) or backward.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Crossing {
    /// Index into `Index::edges`.
    pub edge: usize,
    pub forward: bool,
    pub cost: u64,
}

/// All the edges between two tables, seen from one of them. The search treats it as one step;
/// its edges are the step's variants, cheapest first (then by edge id).
#[derive(Debug, Clone)]
pub(crate) struct Link {
    pub to: usize,
    pub cost: u64,
    pub crossings: Vec<Crossing>,
}

/// The graph ready for searching: tables and edges sorted by id (so the input order never
/// matters), links per table sorted by neighbour, and each table's hub penalty.
pub(crate) struct Index<'a> {
    pub tables: Vec<&'a TableNode>,
    pub edges: Vec<&'a Edge>,
    pub pos: HashMap<&'a str, usize>,
    pub links: Vec<Vec<Link>>,
    /// Self-references of each table, cheapest first.
    pub self_loops: Vec<Vec<Crossing>>,
    pub hub: Vec<u64>,
}

impl<'a> Index<'a> {
    /// Skips what cannot be joined: duplicate tables and edges (the first one wins), edges to
    /// unknown tables and edges without column pairs.
    pub fn build(graph: &'a SchemaGraph) -> Self {
        let mut tables: Vec<&TableNode> = Vec::with_capacity(graph.tables.len());
        let mut seen = HashSet::new();
        for t in &graph.tables {
            if seen.insert(t.id.as_str()) {
                tables.push(t);
            }
        }
        tables.sort_by(|a, b| a.id.cmp(&b.id));
        let pos: HashMap<&str, usize> = tables.iter().enumerate().map(|(i, t)| (t.id.as_str(), i)).collect();

        let mut edges: Vec<&Edge> = Vec::with_capacity(graph.edges.len());
        let mut ids = HashSet::new();
        for e in &graph.edges {
            let usable = pos.contains_key(e.from.as_str()) && pos.contains_key(e.to.as_str()) && !e.pairs.is_empty();
            if usable && ids.insert(e.id.as_str()) {
                edges.push(e);
            }
        }
        edges.sort_by(|a, b| a.id.cmp(&b.id));
        let max_calls = edges.iter().map(|e| e.calls).max().unwrap_or(0);

        let n = tables.len();
        let mut by_pair: Vec<HashMap<usize, Vec<Crossing>>> = vec![HashMap::new(); n];
        let mut self_loops: Vec<Vec<Crossing>> = vec![Vec::new(); n];
        for (i, e) in edges.iter().enumerate() {
            let (a, b) = (pos[e.from.as_str()], pos[e.to.as_str()]);
            let cost = edge_cost(e.kind, e.calls, max_calls);
            if a == b {
                self_loops[a].push(Crossing { edge: i, forward: true, cost });
                continue;
            }
            by_pair[a].entry(b).or_default().push(Crossing { edge: i, forward: true, cost });
            by_pair[b].entry(a).or_default().push(Crossing { edge: i, forward: false, cost });
        }

        // Edges are sorted by id, so equal costs keep the id order.
        let by_cost = |x: &Crossing, y: &Crossing| x.cost.cmp(&y.cost).then(x.edge.cmp(&y.edge));
        let mut links: Vec<Vec<Link>> = Vec::with_capacity(n);
        for pairs in by_pair {
            let mut list: Vec<Link> = pairs
                .into_iter()
                .map(|(to, mut crossings)| {
                    crossings.sort_by(by_cost);
                    Link { to, cost: crossings[0].cost, crossings }
                })
                .collect();
            list.sort_by_key(|l| l.to);
            links.push(list);
        }
        for loops in &mut self_loops {
            loops.sort_by(by_cost);
        }
        let hub = links.iter().map(|l| hub_penalty(l.len())).collect();
        Index { tables, edges, pos, links, self_loops, hub }
    }

    pub fn len(&self) -> usize {
        self.tables.len()
    }

    pub fn link(&self, from: usize, to: usize) -> Option<&Link> {
        let list = &self.links[from];
        list.binary_search_by_key(&to, |l| l.to).ok().map(|i| &list[i])
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn table(id: &str) -> TableNode {
        let (schema, name) = id.split_once('.').unwrap_or(("public", id));
        TableNode { id: id.to_string(), schema: schema.to_string(), name: name.to_string() }
    }

    /// A declared many-to-one FK `from.<to>_id -> to.id`, named `id`.
    pub fn fk(id: &str, from: &str, to: &str) -> Edge {
        let column = format!("{}_id", to.rsplit('.').next().unwrap());
        fk_on(id, from, &[(&column, "id")], to)
    }

    pub fn fk_on(id: &str, from: &str, pairs: &[(&str, &str)], to: &str) -> Edge {
        Edge {
            id: id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            pairs: pairs.iter().map(|(f, t)| ColumnPair { from: f.to_string(), to: t.to_string() }).collect(),
            kind: EdgeKind::Declared,
            from_mult: Multiplicity::Many,
            to_mult: Multiplicity::One,
            calls: 0,
        }
    }

    pub fn graph(tables: &[&str], edges: Vec<Edge>) -> SchemaGraph {
        SchemaGraph { tables: tables.iter().map(|t| table(t)).collect(), edges }
    }

    #[test]
    fn skips_what_cannot_be_joined() {
        let mut no_pairs = fk("c", "a", "b");
        no_pairs.pairs.clear();
        let g = graph(&["b", "a", "a"], vec![fk("x", "a", "b"), fk("x", "b", "a"), fk("y", "a", "ghost"), no_pairs]);
        let ix = Index::build(&g);
        assert_eq!(ix.tables.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(ix.edges.len(), 1);
        assert_eq!(ix.edges[0].from, "a");
    }

    #[test]
    fn merges_parallel_edges_into_one_link_with_its_variants_cheapest_first() {
        let mut busy = fk_on("b2", "a", &[("updated_by", "id")], "b");
        busy.calls = 100;
        let g = graph(&["a", "b"], vec![fk_on("b1", "a", &[("created_by", "id")], "b"), busy, fk_on("b3", "b", &[("a_id", "id")], "a")]);
        let ix = Index::build(&g);
        let from_a = ix.link(0, 1).unwrap();
        // b2 is joined often, so cheaper; then b1 and b3 by id.
        let order: Vec<(&str, bool)> = from_a.crossings.iter().map(|c| (ix.edges[c.edge].id.as_str(), c.forward)).collect();
        assert_eq!(order, [("b2", true), ("b1", true), ("b3", false)]);
        assert_eq!(from_a.cost, 800);
        assert_eq!(ix.link(1, 0).unwrap().crossings.len(), 3);
        assert_eq!(ix.links[0].len(), 1);
    }

    #[test]
    fn keeps_self_references_apart_and_counts_distinct_neighbours() {
        let mut edges = vec![fk_on("boss", "hub", &[("manager_id", "id")], "hub")];
        let names: Vec<String> = (0..16).map(|i| format!("t{i:02}")).collect();
        for n in &names {
            edges.push(fk(&format!("{n}_hub"), n, "hub"));
        }
        let mut tables: Vec<&str> = names.iter().map(String::as_str).collect();
        tables.push("hub");
        let g = graph(&tables, edges);
        let ix = Index::build(&g);
        let hub = ix.pos["hub"];
        assert_eq!(ix.self_loops[hub].len(), 1);
        assert_eq!(ix.links[hub].len(), 16);
        assert_eq!(ix.hub[hub], 500);
        assert_eq!(ix.hub[ix.pos["t00"]], 0);
    }

    #[test]
    fn reads_the_json_the_app_sends() {
        let json = r#"{"tables":[{"id":"public.a","schema":"public","name":"a"}],
          "edges":[{"id":"e","from":"public.a","to":"public.a","pairs":[{"from":"x","to":"y"}],
          "kind":"discovered","fromMult":"unknown","toMult":"unknown"}]}"#;
        let g: SchemaGraph = serde_json::from_str(json).unwrap();
        assert_eq!(g.edges[0].kind, EdgeKind::Discovered);
        assert_eq!(g.edges[0].calls, 0);
    }
}
