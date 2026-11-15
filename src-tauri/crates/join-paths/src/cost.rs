//! What a join costs. Costs are integers in thousandths, so ties are exact and the order of the
//! results never depends on floating-point rounding.

use crate::graph::EdgeKind;

/// One unit of cost (a declared foreign key nobody joins on).
pub const UNIT: u64 = 1000;

/// Up to this many distinct neighbours a table is not a hub.
pub const HUB_FREE_DEGREE: usize = 8;

/// Share of the busiest traffic a join has, on a log scale: 0 without traffic, 1 for the busiest.
pub fn traffic_share(calls: u64, max_calls: u64) -> f64 {
    if calls == 0 || max_calls == 0 {
        return 0.0;
    }
    ((calls as f64).ln_1p() / (max_calls as f64).ln_1p()).min(1.0)
}

/// Cost of one join. A declared foreign key costs 0.8–1.0 (cheaper when it is joined often), a join
/// seen only in the query traffic 1.2–2.0 (cheaper the more often it runs): a declared FK is always
/// cheaper than any discovered join, and one busy discovered join beats two declared hops.
pub fn edge_cost(kind: EdgeKind, calls: u64, max_calls: u64) -> u64 {
    let t = traffic_share(calls, max_calls);
    let cost = match kind {
        EdgeKind::Declared => 1.0 - 0.2 * t,
        EdgeKind::Discovered => 2.0 - 0.8 * t,
    };
    (cost * UNIT as f64).round() as u64
}

/// Extra cost of going through a table with many links (`users`, `tenants`): such a route is
/// technically valid but rarely the one meant. 0 up to 8 neighbours, then 0.5 per doubling
/// (0.5 at 16, 1.0 at 32, 1.5 at 64). Only tables in the middle of a path pay it.
pub fn hub_penalty(degree: usize) -> u64 {
    if degree <= HUB_FREE_DEGREE {
        return 0;
    }
    let doublings = (degree as f64 / HUB_FREE_DEGREE as f64).log2();
    (0.5 * doublings * UNIT as f64).round() as u64
}

/// A cost in units, for display.
pub fn units(cost: u64) -> f64 {
    cost as f64 / UNIT as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_is_always_cheaper_than_discovered() {
        assert_eq!(edge_cost(EdgeKind::Declared, 0, 0), 1000);
        assert_eq!(edge_cost(EdgeKind::Declared, 1_000_000, 1_000_000), 800);
        assert_eq!(edge_cost(EdgeKind::Discovered, 1_000_000, 1_000_000), 1200);
        assert_eq!(edge_cost(EdgeKind::Discovered, 1, 1_000_000), 1960);
        assert_eq!(edge_cost(EdgeKind::Discovered, 0, 0), 2000);
    }

    #[test]
    fn a_busy_discovered_join_beats_two_declared_hops() {
        let busy = edge_cost(EdgeKind::Discovered, 5000, 5000);
        assert!(busy < 2 * edge_cost(EdgeKind::Declared, 5000, 5000));
    }

    #[test]
    fn hubs_pay_per_doubling_of_their_links() {
        assert_eq!(hub_penalty(3), 0);
        assert_eq!(hub_penalty(8), 0);
        assert_eq!(hub_penalty(16), 500);
        assert_eq!(hub_penalty(32), 1000);
        assert_eq!(hub_penalty(64), 1500);
        assert_eq!(units(1500), 1.5);
    }
}
