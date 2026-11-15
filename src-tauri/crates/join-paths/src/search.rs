//! Finding the join paths: Yen's k shortest simple paths over the links between tables, each
//! shortest path computed by a dynamic program layered by hops, so the hop limit is exact.

use std::collections::{BTreeSet, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::cost::units;
use crate::graph::{ColumnPair, Crossing, EdgeKind, Index, Multiplicity, SchemaGraph};

/// Most paths and hops a request may ask for.
pub const LIMIT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PathOpts {
    /// How many routes to return (1–10).
    pub max_paths: usize,
    /// Most joins in a route (1–10).
    pub max_hops: usize,
    /// Tables no route may go through.
    pub avoid: Vec<String>,
}

impl Default for PathOpts {
    fn default() -> Self {
        PathOpts { max_paths: 3, max_hops: 6, avoid: Vec::new() }
    }
}

/// One way to make a step: an edge, oriented in the walking direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepVariant {
    pub edge: String,
    /// Walked from the edge's referencing side to its referenced side.
    pub forward: bool,
    /// `from` is a column of the step's left table, `to` of its right table.
    pub on: Vec<ColumnPair>,
    pub left_mult: Multiplicity,
    pub right_mult: Multiplicity,
    pub kind: EdgeKind,
    pub calls: u64,
    pub cost: f64,
}

/// One join of a route, from `left` to `right`. Parallel relationships between the two tables are
/// its variants, cheapest first; the first one is the default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStep {
    pub left: String,
    pub right: String,
    pub variants: Vec<StepVariant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinPath {
    /// From the start table to the end table.
    pub tables: Vec<String>,
    pub steps: Vec<PathStep>,
    /// With each step's first variant, including the penalty of the hub tables it goes through.
    pub cost: f64,
    pub hops: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NoPathReason {
    /// No chain of relationships links the two tables.
    NotConnected,
    /// They are linked only through tables the request avoids.
    OnlyThroughAvoided,
    /// The shortest route needs more joins than allowed.
    TooLong { hops: usize },
    /// Start and end are the same table, which does not reference itself.
    NoSelfReference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "table", rename_all = "camelCase")]
pub enum InputError {
    UnknownTable(String),
    EndpointAvoided(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PathOutcome {
    /// One to `max_paths` routes, best first.
    Found { paths: Vec<JoinPath> },
    NoPath { reason: NoPathReason },
    Invalid { error: InputError },
}

/// The best routes from `from` to `to`, by cost, then joins, then the table ids along the way: the
/// same graph always gives the same answer, whatever order its tables and edges came in.
///
/// Routes are simple (no table twice) and distinct as sequences of tables: relationships between
/// the same two tables are variants of one step, not separate routes. When `from == to`, the
/// table's self-references are the routes.
pub fn find_join_paths(graph: &SchemaGraph, from: &str, to: &str, opts: &PathOpts) -> PathOutcome {
    let ix = Index::build(graph);
    let invalid = |error| PathOutcome::Invalid { error };
    let Some(&s) = ix.pos.get(from) else { return invalid(InputError::UnknownTable(from.to_string())) };
    let Some(&t) = ix.pos.get(to) else { return invalid(InputError::UnknownTable(to.to_string())) };
    let mut avoided = vec![false; ix.len()];
    for a in &opts.avoid {
        if let Some(&i) = ix.pos.get(a.as_str()) {
            avoided[i] = true;
        }
    }
    if avoided[s] {
        return invalid(InputError::EndpointAvoided(from.to_string()));
    }
    if avoided[t] {
        return invalid(InputError::EndpointAvoided(to.to_string()));
    }
    let k = opts.max_paths.clamp(1, LIMIT);
    let max_hops = opts.max_hops.clamp(1, LIMIT);

    if s == t {
        let loops = &ix.self_loops[s];
        if loops.is_empty() {
            return PathOutcome::NoPath { reason: NoPathReason::NoSelfReference };
        }
        let id = &ix.tables[s].id;
        let paths = loops
            .iter()
            .take(k)
            .map(|c| JoinPath {
                tables: vec![id.clone(), id.clone()],
                steps: vec![PathStep { left: id.clone(), right: id.clone(), variants: vec![variant(&ix, c)] }],
                cost: units(c.cost),
                hops: 1,
            })
            .collect();
        return PathOutcome::Found { paths };
    }

    let routes = k_shortest(&ix, s, t, k, max_hops, &avoided);
    if routes.is_empty() {
        return PathOutcome::NoPath { reason: why_none(&ix, s, t, &avoided) };
    }
    let paths = routes.into_iter().map(|(cost, nodes)| to_path(&ix, &nodes, cost)).collect();
    PathOutcome::Found { paths }
}

const NONE: u64 = u64::MAX;

/// Cheapest route from `src` to `dst` in at most `max_hops` joins, avoiding the `banned` tables and
/// the `cut` links (from, to). `best[h][v]` is the cheapest walk of exactly `h` joins; costs are
/// positive, so the cheapest walk overall never repeats a table and is a simple path. Ties keep
/// the first found (tables and links are visited in index order), then the fewest joins.
fn shortest(ix: &Index, src: usize, dst: usize, max_hops: usize, banned: &[bool], cut: &HashSet<(usize, usize)>) -> Option<Vec<usize>> {
    let n = ix.len();
    let mut best = vec![vec![NONE; n]; max_hops + 1];
    let mut prev = vec![vec![usize::MAX; n]; max_hops + 1];
    best[0][src] = 0;
    let mut answer: Option<(u64, usize)> = None;
    for h in 1..=max_hops {
        let (done, rest) = best.split_at_mut(h);
        let (last, cur) = (&done[h - 1], &mut rest[0]);
        let mut reached = false;
        for (u, &du) in last.iter().enumerate() {
            if du == NONE || u == dst {
                continue;
            }
            for link in &ix.links[u] {
                let v = link.to;
                if banned[v] || cut.contains(&(u, v)) {
                    continue;
                }
                let c = du + link.cost + if v == dst { 0 } else { ix.hub[v] };
                if c < cur[v] {
                    cur[v] = c;
                    prev[h][v] = u;
                    reached = true;
                }
            }
        }
        if cur[dst] != NONE && answer.is_none_or(|(c, _)| cur[dst] < c) {
            answer = Some((cur[dst], h));
        }
        if !reached {
            break;
        }
    }
    let (_, hops) = answer?;
    let mut nodes = vec![dst];
    let mut v = dst;
    for h in (1..=hops).rev() {
        v = prev[h][v];
        nodes.push(v);
    }
    nodes.reverse();
    Some(nodes)
}

/// A route's cost: its links (cheapest variant each) and the hub penalty of the tables inside it.
fn route_cost(ix: &Index, nodes: &[usize]) -> u64 {
    let links: u64 = nodes.windows(2).map(|w| ix.link(w[0], w[1]).map_or(NONE / 4, |l| l.cost)).sum();
    let hubs: u64 = nodes[1..nodes.len() - 1].iter().map(|&v| ix.hub[v]).sum();
    links + hubs
}

/// Yen's algorithm: the `k` best simple routes, ordered by (cost, joins, table sequence).
fn k_shortest(ix: &Index, s: usize, t: usize, k: usize, max_hops: usize, avoided: &[bool]) -> Vec<(u64, Vec<usize>)> {
    let Some(first) = shortest(ix, s, t, max_hops, avoided, &HashSet::new()) else { return Vec::new() };
    let mut found = vec![(route_cost(ix, &first), first)];
    let mut candidates: BTreeSet<(u64, usize, Vec<usize>)> = BTreeSet::new();
    while found.len() < k {
        let last = found.last().map(|(_, p)| p.clone()).unwrap_or_default();
        for i in 0..last.len().saturating_sub(1) {
            let root = &last[..=i];
            // The spur may use what the root has not used: tables and joins.
            let mut banned = avoided.to_vec();
            for &r in &root[..i] {
                banned[r] = true;
            }
            let cut: HashSet<(usize, usize)> = found
                .iter()
                .filter(|(_, p)| p.len() > i + 1 && &p[..=i] == root)
                .map(|(_, p)| (p[i], p[i + 1]))
                .collect();
            let Some(spur) = shortest(ix, root[i], t, max_hops - i, &banned, &cut) else { continue };
            let mut route = root[..i].to_vec();
            route.extend(spur);
            if !found.iter().any(|(_, p)| *p == route) {
                candidates.insert((route_cost(ix, &route), route.len() - 1, route));
            }
        }
        let Some((cost, _, route)) = candidates.pop_first() else { break };
        found.push((cost, route));
    }
    found.sort_by(|(ca, a), (cb, b)| ca.cmp(cb).then(a.len().cmp(&b.len())).then(a.cmp(b)));
    found
}

/// Joins of the shortest route that avoids the `banned` tables, ignoring costs and the hop limit.
fn fewest_hops(ix: &Index, s: usize, t: usize, banned: &[bool]) -> Option<usize> {
    let mut depth = vec![usize::MAX; ix.len()];
    depth[s] = 0;
    let mut queue = VecDeque::from([s]);
    while let Some(u) = queue.pop_front() {
        if u == t {
            return Some(depth[u]);
        }
        for link in &ix.links[u] {
            if !banned[link.to] && depth[link.to] == usize::MAX {
                depth[link.to] = depth[u] + 1;
                queue.push_back(link.to);
            }
        }
    }
    None
}

fn why_none(ix: &Index, s: usize, t: usize, avoided: &[bool]) -> NoPathReason {
    if fewest_hops(ix, s, t, &vec![false; ix.len()]).is_none() {
        return NoPathReason::NotConnected;
    }
    match fewest_hops(ix, s, t, avoided) {
        None => NoPathReason::OnlyThroughAvoided,
        Some(hops) => NoPathReason::TooLong { hops },
    }
}

fn variant(ix: &Index, c: &Crossing) -> StepVariant {
    let e = ix.edges[c.edge];
    let on = e
        .pairs
        .iter()
        .map(|p| if c.forward { p.clone() } else { ColumnPair { from: p.to.clone(), to: p.from.clone() } })
        .collect();
    let (left_mult, right_mult) = if c.forward { (e.from_mult, e.to_mult) } else { (e.to_mult, e.from_mult) };
    StepVariant { edge: e.id.clone(), forward: c.forward, on, left_mult, right_mult, kind: e.kind, calls: e.calls, cost: units(c.cost) }
}

fn to_path(ix: &Index, nodes: &[usize], cost: u64) -> JoinPath {
    let steps = nodes
        .windows(2)
        .map(|w| {
            let link = ix.link(w[0], w[1]).expect("a route only uses existing links");
            PathStep {
                left: ix.tables[w[0]].id.clone(),
                right: ix.tables[w[1]].id.clone(),
                variants: link.crossings.iter().map(|c| variant(ix, c)).collect(),
            }
        })
        .collect();
    JoinPath { tables: nodes.iter().map(|&i| ix.tables[i].id.clone()).collect(), steps, cost: units(cost), hops: nodes.len() - 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::{fk, fk_on, graph};
    use crate::graph::{Edge, SchemaGraph};

    fn find(g: &SchemaGraph, from: &str, to: &str) -> PathOutcome {
        find_join_paths(g, from, to, &PathOpts::default())
    }

    fn routes(outcome: &PathOutcome) -> Vec<Vec<&str>> {
        match outcome {
            PathOutcome::Found { paths } => paths.iter().map(|p| p.tables.iter().map(String::as_str).collect()).collect(),
            other => panic!("expected paths, got {other:?}"),
        }
    }

    fn paths(outcome: PathOutcome) -> Vec<JoinPath> {
        match outcome {
            PathOutcome::Found { paths } => paths,
            other => panic!("expected paths, got {other:?}"),
        }
    }

    fn no_path(outcome: PathOutcome) -> NoPathReason {
        match outcome {
            PathOutcome::NoPath { reason } => reason,
            other => panic!("expected no path, got {other:?}"),
        }
    }

    fn pair(from: &str, to: &str) -> ColumnPair {
        ColumnPair { from: from.into(), to: to.into() }
    }

    #[test]
    fn follows_a_chain_keeping_direction_and_cardinality() {
        let g = graph(&["a", "b", "c", "d"], vec![fk("b_a", "b", "a"), fk("c_b", "c", "b"), fk("d_c", "d", "c")]);
        let p = paths(find(&g, "a", "d"));
        assert_eq!(p.len(), 1);
        let p = &p[0];
        assert_eq!(p.tables, ["a", "b", "c", "d"]);
        assert_eq!((p.hops, p.cost), (3, 3.0));
        // a is referenced by b: walking a -> b goes against the FK, one a to many b.
        let v = &p.steps[0].variants[0];
        assert_eq!((v.edge.as_str(), v.forward), ("b_a", false));
        assert_eq!(v.on, [pair("id", "a_id")]);
        assert_eq!((v.left_mult, v.right_mult), (Multiplicity::One, Multiplicity::Many));

        let back = paths(find(&g, "d", "a"));
        let v = &back[0].steps[0].variants[0];
        assert_eq!((back[0].steps[0].left.as_str(), v.forward), ("d", true));
        assert_eq!(v.on, [pair("c_id", "id")]);
        assert_eq!((v.left_mult, v.right_mult), (Multiplicity::Many, Multiplicity::One));
    }

    #[test]
    fn parallel_relationships_are_variants_of_one_step() {
        let g = graph(
            &["orders", "users"],
            vec![
                fk_on("o_updated", "orders", &[("updated_by", "id")], "users"),
                fk_on("o_created", "orders", &[("created_by", "id")], "users"),
                fk_on("u_last_order", "users", &[("last_order_id", "id")], "orders"),
            ],
        );
        let p = paths(find(&g, "orders", "users"));
        assert_eq!(p.len(), 1);
        let vs = &p[0].steps[0].variants;
        // Equal costs: by edge id. The reverse FK is a variant too, walked backward.
        let got: Vec<(&str, bool)> = vs.iter().map(|v| (v.edge.as_str(), v.forward)).collect();
        assert_eq!(got, [("o_created", true), ("o_updated", true), ("u_last_order", false)]);
        assert_eq!(vs[2].on, [pair("id", "last_order_id")]);
    }

    #[test]
    fn parallel_relationships_do_not_crowd_out_another_route() {
        let g = graph(
            &["a", "b", "c"],
            vec![fk_on("ab1", "a", &[("x", "id")], "b"), fk_on("ab2", "a", &[("y", "id")], "b"), fk_on("ab3", "a", &[("z", "id")], "b"), fk("ac", "a", "c"), fk("cb", "c", "b")],
        );
        let out = find(&g, "a", "b");
        assert_eq!(routes(&out), [vec!["a", "b"], vec!["a", "c", "b"]]);
        assert_eq!(paths(out)[0].steps[0].variants.len(), 3);
    }

    /// a and b joined through a hub with 40 other neighbours, or through x and y.
    fn hub_graph() -> SchemaGraph {
        let leaves: Vec<String> = (0..40).map(|i| format!("leaf{i:02}")).collect();
        let mut tables: Vec<&str> = vec!["a", "b", "h", "x", "y"];
        tables.extend(leaves.iter().map(String::as_str));
        let mut edges = vec![fk("a_h", "a", "h"), fk("b_h", "b", "h"), fk("a_x", "a", "x"), fk("x_y", "x", "y"), fk("b_y", "b", "y")];
        edges.extend(leaves.iter().map(|l| fk(&format!("{l}_h"), l, "h")));
        graph(&tables, edges)
    }

    #[test]
    fn prefers_a_longer_route_to_one_through_a_hub() {
        let g = hub_graph();
        let p = paths(find(&g, "a", "b"));
        assert_eq!(p.iter().map(|p| p.tables.join(">")).collect::<Vec<_>>(), ["a>x>y>b", "a>h>b"]);
        assert_eq!(p[0].cost, 3.0);
        // Two joins plus 0.5 · log2(42 / 8) for the hub.
        assert_eq!(p[1].cost, 3.196);
        let avoid_x = PathOpts { avoid: vec!["x".into()], ..PathOpts::default() };
        assert_eq!(routes(&find_join_paths(&g, "a", "b", &avoid_x)), [vec!["a", "h", "b"]]);
        let avoid_h = PathOpts { avoid: vec!["h".into()], ..PathOpts::default() };
        assert_eq!(routes(&find_join_paths(&g, "a", "b", &avoid_h)), [vec!["a", "x", "y", "b"]]);
    }

    #[test]
    fn says_why_there_is_no_path() {
        let g = graph(&["a", "b", "c", "d", "h"], vec![fk("ab", "a", "b"), fk("cd", "c", "d"), fk("ah", "a", "h"), fk("dh", "d", "h")]);
        let only_h = graph(&["a", "b", "h"], vec![fk("ah", "a", "h"), fk("bh", "b", "h")]);
        let avoid_h = PathOpts { avoid: vec!["h".into()], ..PathOpts::default() };
        assert_eq!(no_path(find_join_paths(&only_h, "a", "b", &avoid_h)), NoPathReason::OnlyThroughAvoided);
        let apart = graph(&["a", "b", "c", "d"], vec![fk("ab", "a", "b"), fk("cd", "c", "d")]);
        assert_eq!(no_path(find(&apart, "a", "c")), NoPathReason::NotConnected);
        assert_eq!(routes(&find(&g, "b", "c")), [vec!["b", "a", "h", "d", "c"]]);
    }

    #[test]
    fn a_composite_key_is_one_step_with_all_its_columns() {
        let g = graph(&["members", "roles"], vec![fk_on("m_r", "members", &[("org_id", "org_id"), ("role", "name")], "roles")]);
        let p = paths(find(&g, "roles", "members"));
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].steps[0].variants.len(), 1);
        assert_eq!(p[0].steps[0].variants[0].on, [pair("org_id", "org_id"), pair("name", "role")]);
    }

    #[test]
    fn self_references_are_routes_only_from_a_table_to_itself() {
        let g = graph(&["dept", "emp"], vec![fk_on("boss", "emp", &[("manager_id", "id")], "emp"), fk("emp_dept", "emp", "dept")]);
        assert_eq!(routes(&find(&g, "emp", "dept")), [vec!["emp", "dept"]]);
        let p = paths(find(&g, "emp", "emp"));
        assert_eq!(p[0].tables, ["emp", "emp"]);
        assert_eq!(p[0].steps[0].variants[0].on, [pair("manager_id", "id")]);
        assert_eq!(no_path(find(&g, "dept", "dept")), NoPathReason::NoSelfReference);
    }

    #[test]
    fn routes_around_a_cycle_are_simple() {
        let g = graph(&["a", "b", "c", "d"], vec![fk("ab", "a", "b"), fk("bc", "b", "c"), fk("ca", "c", "a"), fk("cd", "c", "d")]);
        let out = find(&g, "a", "d");
        assert_eq!(routes(&out), [vec!["a", "c", "d"], vec!["a", "b", "c", "d"]]);
        for p in paths(out) {
            let distinct: HashSet<&String> = p.tables.iter().collect();
            assert_eq!(distinct.len(), p.tables.len());
        }
    }

    #[test]
    fn keeps_to_the_hop_limit() {
        let names: Vec<String> = (0..9).map(|i| format!("t{i}")).collect();
        let tables: Vec<&str> = names.iter().map(String::as_str).collect();
        let edges = names.windows(2).map(|w| fk(&format!("{}_{}", w[0], w[1]), &w[0], &w[1])).collect();
        let g = graph(&tables, edges);
        assert_eq!(no_path(find(&g, "t0", "t8")), NoPathReason::TooLong { hops: 8 });
        let longer = PathOpts { max_hops: 10, ..PathOpts::default() };
        assert_eq!(paths(find_join_paths(&g, "t0", "t8", &longer))[0].hops, 8);
    }

    #[test]
    fn the_same_graph_in_any_order_gives_the_same_answer() {
        let g = hub_graph();
        let mut shuffled = g.clone();
        shuffled.tables.reverse();
        shuffled.edges.reverse();
        shuffled.edges.rotate_left(7);
        assert_eq!(find(&g, "a", "b"), find(&shuffled, "a", "b"));
        let json = |o: &PathOutcome| serde_json::to_string(o).unwrap();
        assert_eq!(json(&find(&g, "b", "leaf03")), json(&find(&shuffled, "b", "leaf03")));
    }

    fn discovered(id: &str, from: &str, to: &str, calls: u64) -> Edge {
        let mut e = fk(id, from, to);
        e.kind = EdgeKind::Discovered;
        e.from_mult = Multiplicity::Unknown;
        e.to_mult = Multiplicity::Unknown;
        e.calls = calls;
        e
    }

    #[test]
    fn traffic_decides_between_a_discovered_join_and_two_declared_ones() {
        let base = |calls: u64| {
            graph(
                &["a", "b", "x", "busiest_a", "busiest_b"],
                vec![fk("a_x", "a", "x"), fk("x_b", "x", "b"), discovered("ab", "a", "b", calls), discovered("busiest", "busiest_a", "busiest_b", 1_000_000)],
            )
        };
        assert_eq!(routes(&find(&base(100_000), "a", "b")), [vec!["a", "b"], vec!["a", "x", "b"]]);
        assert_eq!(routes(&find(&base(10), "a", "b")), [vec!["a", "x", "b"], vec!["a", "b"]]);
        // With the same number of joins, the declared one wins.
        let same = graph(&["a", "b", "c"], vec![fk("ab", "a", "b"), discovered("ac", "a", "c", 5), fk("cb", "c", "b")]);
        let p = paths(find(&same, "c", "b"));
        assert_eq!(p[0].tables, ["c", "b"]);
    }

    #[test]
    fn returns_what_exists_and_rejects_bad_requests() {
        let g = graph(&["a", "b"], vec![fk("ab", "a", "b")]);
        assert_eq!(routes(&find(&g, "a", "b")).len(), 1);
        assert_eq!(find(&g, "a", "nope"), PathOutcome::Invalid { error: InputError::UnknownTable("nope".into()) });
        let avoid_a = PathOpts { avoid: vec!["a".into()], ..PathOpts::default() };
        assert_eq!(find_join_paths(&g, "a", "b", &avoid_a), PathOutcome::Invalid { error: InputError::EndpointAvoided("a".into()) });
    }

    #[test]
    fn writes_the_json_the_app_reads() {
        let g = graph(&["a", "b"], vec![fk("ab", "a", "b")]);
        let found = serde_json::to_value(find(&g, "b", "a")).unwrap();
        assert_eq!(found["kind"], "found");
        assert_eq!(found["paths"][0]["steps"][0]["variants"][0]["leftMult"], "one");
        let long = PathOutcome::NoPath { reason: NoPathReason::TooLong { hops: 8 } };
        assert_eq!(serde_json::to_string(&long).unwrap(), r#"{"kind":"noPath","reason":{"kind":"tooLong","hops":8}}"#);
        let bad = PathOutcome::Invalid { error: InputError::UnknownTable("x".into()) };
        assert_eq!(serde_json::to_string(&bad).unwrap(), r#"{"kind":"invalid","error":{"kind":"unknownTable","table":"x"}}"#);
        let opts: PathOpts = serde_json::from_str(r#"{"avoid":["h"]}"#).unwrap();
        assert_eq!(opts, PathOpts { avoid: vec!["h".into()], ..PathOpts::default() });
    }

    /// `cargo test -p join-paths --release -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn under_50_ms_on_a_thousand_tables() {
        let mut seed: u64 = 42;
        let mut rand = move |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n
        };
        let names: Vec<String> = (0..1000).map(|i| format!("s{}.t{i:04}", i % 6)).collect();
        let mut edges = Vec::new();
        for i in 1..names.len() {
            // Mostly near neighbours (modules), some far, a few hubs everyone references.
            for _ in 0..2 {
                let j = if rand(10) < 8 { i.saturating_sub(1 + rand(20)) } else { rand(i) };
                edges.push(fk(&format!("e{}", edges.len()), &names[i], &names[j]));
            }
            if rand(4) == 0 {
                edges.push(fk(&format!("e{}", edges.len()), &names[i], &names[rand(5)]));
            }
        }
        let tables: Vec<&str> = names.iter().map(String::as_str).collect();
        let g = graph(&tables, edges);
        let (mut worst, mut total) = (0u128, 0u128);
        for _ in 0..200 {
            let (a, b) = (rand(1000), rand(1000));
            let started = std::time::Instant::now();
            let out = find(&g, &names[a], &names[b]);
            let us = started.elapsed().as_micros();
            assert!(matches!(out, PathOutcome::Found { .. } | PathOutcome::NoPath { .. }));
            worst = worst.max(us);
            total += us;
        }
        println!("{} edges: average {} µs, worst {} µs", g.edges.len(), total / 200, worst);
        assert!(worst < 50_000, "worst {worst} µs");
    }
}
