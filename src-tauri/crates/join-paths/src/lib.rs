//! Join paths between two tables of a schema: the cheapest ways to join them, for the app's
//! "Show join path" and for any other tool that has the same graph.
//!
//! Pure code: no I/O, no Tauri, no database. The caller builds a [`SchemaGraph`] (tables and the
//! relationships between them, declared or seen in query traffic) and asks
//! [`find_join_paths`] for the best routes.

pub mod cost;
pub mod graph;
pub mod search;
pub mod sql;

pub use graph::{ColumnPair, Edge, EdgeKind, Multiplicity, SchemaGraph, TableNode};
pub use search::{InputError, JoinPath, NoPathReason, PathOpts, PathOutcome, PathStep, StepVariant, find_join_paths};
pub use sql::{Dialect, aliases, path_sql};
