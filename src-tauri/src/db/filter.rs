//! Row filters: a tree of conditions (AND/OR groups, NOT) sent by the frontend, checked against
//! the live catalog and rendered into a WHERE clause for any engine. Operators come from a fixed
//! enum (an unknown one fails to deserialize), every column must exist in the table's metadata,
//! and every value is a bound parameter, converted to the column's type so indexes can be used.
//! Problems are collected per node (`Issue`), so the UI can mark each condition that cannot run.

use serde::{Deserialize, Serialize};

use super::browse::{BrowseColumn, BrowseFilter};
use super::catalog::TableMeta;
use super::sql::{Anchor, ColKind, Dialect};
use crate::error::AppError;

/// Statement parameters (SQL Server accepts 2100; the same limit everywhere keeps it predictable).
pub const MAX_PARAMS: usize = 2000;
pub const MAX_LIST: usize = 1000;
pub const MAX_NODES: usize = 200;
pub const MAX_DEPTH: usize = 6;
/// Longer values would be sent as `nvarchar(max)` on SQL Server, which cannot use an index.
pub const MAX_VALUE_CHARS: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoolOp {
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    /// Inclusive on both ends.
    Between,
    /// Half-open `[from, to)`: dates and relative periods.
    Range,
    In,
    NotIn,
    IsNull,
    NotNull,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    IsEmpty,
    Regex,
    /// Empty or only spaces.
    IsBlank,
    /// Leading or trailing spaces.
    IsPadded,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum FilterNode {
    Group {
        id: String,
        op: BoolOp,
        #[serde(default)]
        not: bool,
        #[serde(default)]
        items: Vec<FilterNode>,
    },
    Cond {
        id: String,
        column: String,
        op: Op,
        #[serde(default)]
        args: Vec<String>,
        /// Case-sensitive text matching (pattern operators only).
        #[serde(default)]
        cs: bool,
    },
    /// The text in any of `columns` (empty: every text-like column): contains for text, equal
    /// for numbers, dates and UUIDs when the text is one.
    Search {
        id: String,
        text: String,
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        cs: bool,
    },
}

/// Columns a search may name (each takes a parameter: MySQL cannot reuse one).
pub const MAX_SEARCH_COLUMNS: usize = 64;

/// A condition that cannot run, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub node: String,
    pub message: String,
}

/// The table a condition's columns belong to, and its alias in the statement.
pub struct Scope<'a> {
    pub meta: &'a TableMeta,
    pub alias: String,
}

/// Renders one statement's conditions; parameters are numbered across the whole statement.
pub struct Render {
    pub d: Dialect,
    pub params: Vec<String>,
    pub issues: Vec<Issue>,
    nodes: usize,
}

impl Render {
    pub fn new(d: Dialect) -> Self {
        Render { d, params: Vec::new(), issues: Vec::new(), nodes: 0 }
    }

    /// Binds a value and returns its placeholder.
    pub fn bind(&mut self, value: String) -> String {
        self.params.push(value);
        self.d.param(self.params.len())
    }

    fn issue<T>(&mut self, node: &str, message: impl Into<String>) -> Option<T> {
        self.issues.push(Issue { node: node.to_string(), message: message.into() });
        None
    }

    /// The condition for `node` (None: no condition, or it has issues).
    pub fn render(&mut self, scope: &Scope, node: &FilterNode) -> Option<String> {
        let sql = self.node(scope, node, 1);
        if self.nodes > MAX_NODES {
            self.issue::<()>(node_id(node), format!("The filter has more than {MAX_NODES} conditions"));
        }
        if self.params.len() > MAX_PARAMS {
            self.issue::<()>(node_id(node), format!("The filter has more than {MAX_PARAMS} values"));
        }
        sql
    }

    fn node(&mut self, s: &Scope, node: &FilterNode, depth: usize) -> Option<String> {
        self.nodes += 1;
        match node {
            FilterNode::Group { id, op, not, items } => {
                if depth > MAX_DEPTH {
                    return self.issue(id, format!("Groups can be nested {MAX_DEPTH} deep at most"));
                }
                // Every item is rendered (not only up to the first problem), so all issues show.
                let parts: Vec<String> = items.iter().filter_map(|item| self.node(s, item, depth + 1)).collect();
                if parts.is_empty() {
                    return None;
                }
                let sep = if *op == BoolOp::And { " AND " } else { " OR " };
                let joined = if parts.len() == 1 { parts.into_iter().next().unwrap() } else { format!("({})", parts.join(sep)) };
                Some(if *not { format!("NOT {}", parenthesize(&joined)) } else { joined })
            }
            FilterNode::Cond { id, column, op, args, cs } => self.cond(s, id, column, *op, args, *cs),
            FilterNode::Search { id, text, columns, cs } => self.search(s, id, text, columns, *cs),
        }
    }

    fn search(&mut self, s: &Scope, id: &str, text: &str, columns: &[String], cs: bool) -> Option<String> {
        if text.trim().is_empty() {
            return None;
        }
        if text.chars().count() > MAX_VALUE_CHARS {
            return self.issue(id, format!("Values are limited to {MAX_VALUE_CHARS} characters"));
        }
        let d = self.d;
        let mut cols: Vec<&BrowseColumn> = Vec::new();
        if columns.len() > MAX_SEARCH_COLUMNS {
            return self.issue(id, format!("A search can name {MAX_SEARCH_COLUMNS} columns at most"));
        }
        // All columns: no cap of its own (a very wide table meets the parameter limit, which is reported).
        if columns.is_empty() {
            cols.extend(s.meta.columns.iter());
        } else {
            for name in columns {
                match s.meta.column(name) {
                    Some(c) => cols.push(c),
                    None => return self.issue(id, format!("Unknown column “{name}”")),
                }
            }
        }
        let mut parts = Vec::new();
        for col in cols {
            let expr = format!("{}.{}", d.quote(&s.alias), d.quote(&col.name));
            match col.kind {
                ColKind::Text | ColKind::Enum | ColKind::Json | ColKind::Other => {
                    let t = d.text_expr(&expr, col.kind, &col.type_name);
                    parts.push(self.text_match(&t, Anchor::Contains, text, cs));
                }
                ColKind::Binary => {}
                // Numbers, dates, UUIDs: equal, when the text is one (an index can serve it).
                _ => {
                    if let Ok(v) = d.check_value(col.kind, &col.type_name, text)
                        && let Some(p) = d.typed_param(col.kind, &col.type_name, self.params.len() + 1, &v)
                    {
                        self.params.push(v);
                        parts.push(format!("{expr} = {p}"));
                    }
                }
            }
        }
        if parts.is_empty() {
            return Some("1 = 0".into());
        }
        Some(if parts.len() == 1 { parts.pop().unwrap() } else { format!("({})", parts.join(" OR ")) })
    }

    fn cond(&mut self, s: &Scope, id: &str, column: &str, op: Op, args: &[String], cs: bool) -> Option<String> {
        let d = self.d;
        let Some(col) = s.meta.column(column) else { return self.issue(id, format!("Unknown column “{column}”")) };
        let expr = format!("{}.{}", d.quote(&s.alias), d.quote(&col.name));
        let arity = match op {
            Op::IsNull | Op::NotNull | Op::IsEmpty | Op::IsBlank | Op::IsPadded => Some(0),
            Op::Between | Op::Range => Some(2),
            Op::In | Op::NotIn => None,
            _ => Some(1),
        };
        if let Some(n) = arity
            && args.len() != n
        {
            return self.issue(id, format!("“{}” needs {n} value{}", op_label(op), if n == 1 { "" } else { "s" }));
        }
        if args.len() > MAX_LIST {
            return self.issue(id, format!("A list can hold {MAX_LIST} values at most"));
        }
        if args.iter().any(|a| a.chars().count() > MAX_VALUE_CHARS) {
            return self.issue(id, format!("Values are limited to {MAX_VALUE_CHARS} characters"));
        }
        let text = || d.text_expr(&expr, col.kind, &col.type_name);
        match op {
            Op::IsNull => Some(format!("{expr} IS NULL")),
            Op::NotNull => Some(format!("{expr} IS NOT NULL")),
            Op::Eq | Op::Ne | Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                let sym = match op {
                    Op::Eq => "=",
                    Op::Ne => "<>",
                    Op::Lt => "<",
                    Op::Le => "<=",
                    Op::Gt => ">",
                    _ => ">=",
                };
                let (lhs, rhs) = self.operand(id, col, &expr, op, &args[0])?;
                Some(format!("{lhs} {sym} {rhs}"))
            }
            Op::Between | Op::Range => {
                // Both ends are checked (and reported) before giving up.
                let first = self.operand(id, col, &expr, op, &args[0]);
                let second = self.operand(id, col, &expr, op, &args[1]);
                let ((lhs, from), (_, to)) = (first?, second?);
                Some(if op == Op::Between { format!("{lhs} BETWEEN {from} AND {to}") } else { format!("({lhs} >= {from} AND {lhs} < {to})") })
            }
            Op::In | Op::NotIn => {
                if args.is_empty() {
                    return Some(if op == Op::In { "1 = 0" } else { "1 = 1" }.into());
                }
                let mut lhs = String::new();
                let mut items = Vec::with_capacity(args.len());
                let mut ok = true;
                for a in args {
                    match self.operand(id, col, &expr, op, a) {
                        Some((l, r)) => {
                            lhs = l;
                            items.push(r);
                        }
                        None => ok = false,
                    }
                }
                ok.then(|| format!("{lhs} {}IN ({})", if op == Op::NotIn { "NOT " } else { "" }, items.join(", ")))
            }
            Op::Contains | Op::NotContains | Op::StartsWith | Op::EndsWith => {
                let anchor = match op {
                    Op::StartsWith => Anchor::StartsWith,
                    Op::EndsWith => Anchor::EndsWith,
                    _ => Anchor::Contains,
                };
                let matched = self.text_match(&text(), anchor, &args[0], cs);
                Some(if op == Op::NotContains { format!("NOT ({matched})") } else { matched })
            }
            Op::IsEmpty | Op::IsBlank | Op::IsPadded => {
                if !matches!(col.kind, ColKind::Text | ColKind::Json | ColKind::Other) {
                    return self.issue(id, format!("“{}” applies to text columns", op_label(op)));
                }
                let t = text();
                Some(match (op, d) {
                    (Op::IsEmpty, Dialect::Mssql) => format!("DATALENGTH({t}) = 0"),
                    (Op::IsEmpty, _) => format!("{t} = ''"),
                    (Op::IsBlank, Dialect::Postgres) => format!("btrim({t}) = ''"),
                    (Op::IsBlank, Dialect::Mysql) => format!("TRIM({t}) = ''"),
                    (Op::IsBlank, Dialect::Mssql) => format!("DATALENGTH(LTRIM(RTRIM({t}))) = 0"),
                    (Op::IsBlank, Dialect::Sqlite) => format!("trim({t}) = ''"),
                    (_, Dialect::Postgres) => format!("length({t}) <> length(btrim({t}))"),
                    (_, Dialect::Mysql) => format!("CHAR_LENGTH({t}) <> CHAR_LENGTH(TRIM({t}))"),
                    (_, Dialect::Mssql) => format!("DATALENGTH({t}) <> DATALENGTH(LTRIM(RTRIM({t})))"),
                    (_, Dialect::Sqlite) => format!("length({t}) <> length(trim({t}))"),
                })
            }
            Op::Regex => {
                if d.regex("", "", cs).is_none() {
                    return self.issue(id, "Regular expressions need PostgreSQL or MySQL");
                }
                let p = self.bind(args[0].clone());
                d.regex(&text(), &p, cs)
            }
        }
    }

    /// The column side and the value side of a comparison. The value is checked against the
    /// column's kind and bound converted to its type; columns without a typed comparison are
    /// compared as text, which only supports equality.
    fn operand(&mut self, id: &str, col: &BrowseColumn, expr: &str, op: Op, value: &str) -> Option<(String, String)> {
        let d = self.d;
        let checked = match d.check_value(col.kind, &col.type_name, value) {
            Ok(v) => v,
            Err(message) => return self.issue(id, message),
        };
        let equality = matches!(op, Op::Eq | Op::Ne | Op::In | Op::NotIn);
        // MySQL compares a single-precision float with a decimal string as a double: never equal.
        let force_text = d == Dialect::Mysql && col.kind == ColKind::Float && equality;
        let typed = if force_text { None } else { d.typed_param(col.kind, &col.type_name, self.params.len() + 1, &checked) };
        match typed {
            Some(param) => {
                self.params.push(checked);
                Some((expr.to_string(), param))
            }
            None if equality => {
                let p = self.bind(checked);
                Some((d.text_expr(expr, col.kind, &col.type_name), p))
            }
            None => self.issue(id, format!("“{}” can only be compared with = or ≠", col.name)),
        }
    }

    /// A LIKE (or, case-sensitive on SQLite, `instr`/`substr`) match of `text` against `value`.
    fn text_match(&mut self, text: &str, anchor: Anchor, value: &str, cs: bool) -> String {
        if cs && self.d == Dialect::Sqlite {
            // SQLite's LIKE ignores case (ASCII); its GLOB would need the pattern escaped differently.
            let p = self.bind(value.to_string());
            return match anchor {
                Anchor::Contains => format!("instr({text}, {p}) > 0"),
                Anchor::StartsWith => format!("substr({text}, 1, length({p})) = {p}"),
                Anchor::EndsWith => format!("substr({text}, -length({p})) = {p}"),
            };
        }
        let p = self.bind(self.d.like_pattern(anchor, value));
        self.d.like(text, &p, cs)
    }
}

fn parenthesize(sql: &str) -> String {
    if sql.starts_with('(') && sql.ends_with(')') { sql.to_string() } else { format!("({sql})") }
}

fn node_id(node: &FilterNode) -> &str {
    match node {
        FilterNode::Group { id, .. } | FilterNode::Cond { id, .. } | FilterNode::Search { id, .. } => id,
    }
}

fn op_label(op: Op) -> &'static str {
    match op {
        Op::Eq => "=",
        Op::Ne => "≠",
        Op::Lt => "<",
        Op::Le => "≤",
        Op::Gt => ">",
        Op::Ge => "≥",
        Op::Between => "between",
        Op::Range => "in range",
        Op::In => "in list",
        Op::NotIn => "not in list",
        Op::IsNull => "is null",
        Op::NotNull => "is not null",
        Op::Contains => "contains",
        Op::NotContains => "does not contain",
        Op::StartsWith => "starts with",
        Op::EndsWith => "ends with",
        Op::IsEmpty => "is empty",
        Op::Regex => "matches",
        Op::IsBlank => "is blank",
        Op::IsPadded => "has extra spaces",
    }
}

/// The older equality filters (FK navigation, the Query view) as conditions, AND-ed with `filter`.
pub fn combine(filter: Option<&FilterNode>, legacy: &[BrowseFilter]) -> Option<FilterNode> {
    let mut items: Vec<FilterNode> = legacy
        .iter()
        .enumerate()
        .map(|(i, f)| FilterNode::Cond {
            id: format!("legacy:{i}"),
            column: f.column.clone(),
            op: if f.value.is_some() { Op::Eq } else { Op::IsNull },
            args: f.value.iter().cloned().collect(),
            cs: false,
        })
        .collect();
    if let Some(f) = filter {
        items.push(f.clone());
    }
    match items.len() {
        0 => None,
        1 => items.pop(),
        _ => Some(FilterNode::Group { id: "root".into(), op: BoolOp::And, not: false, items }),
    }
}

/// The WHERE condition (without `WHERE`) for `filter` on the table in `scope`, rendered into
/// `r`, or the issues that keep it from running.
pub fn where_clause(r: &mut Render, scope: &Scope, filter: Option<&FilterNode>) -> Result<Option<String>, AppError> {
    let sql = match filter {
        Some(f) => r.render(scope, f),
        None => None,
    };
    if r.issues.is_empty() { Ok(sql) } else { Err(AppError::Filter(r.issues.clone())) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sql::classify;

    fn meta(d: Dialect, cols: &[(&str, &str)]) -> TableMeta {
        TableMeta {
            qualified: d.qualified("public", "t"),
            schema: "public".into(),
            table: "t".into(),
            columns: cols.iter().map(|(n, t)| BrowseColumn { name: n.to_string(), type_name: t.to_string(), kind: classify(d, t), nullable: true, enum_values: None }).collect(),
            primary_key: vec!["id".into()],
            ..Default::default()
        }
    }

    fn cond(id: &str, column: &str, op: Op, args: &[&str]) -> FilterNode {
        FilterNode::Cond { id: id.into(), column: column.into(), op, args: args.iter().map(|a| a.to_string()).collect(), cs: false }
    }

    fn group(op: BoolOp, not: bool, items: Vec<FilterNode>) -> FilterNode {
        FilterNode::Group { id: "g".into(), op, not, items }
    }

    fn render(d: Dialect, m: &TableMeta, f: &FilterNode) -> Result<(String, Vec<String>), Vec<Issue>> {
        let mut r = Render::new(d);
        let scope = Scope { meta: m, alias: "t0".into() };
        match where_clause(&mut r, &scope, Some(f)) {
            Ok(sql) => Ok((sql.unwrap_or_default(), r.params)),
            Err(AppError::Filter(issues)) => Err(issues),
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn comparisons_bind_typed_values_per_engine() {
        let f = group(BoolOp::And, false, vec![cond("a", "id", Op::Ge, &["10"]), cond("b", "email", Op::Eq, &["a@b.c"])]);
        let pg = meta(Dialect::Postgres, &[("id", "integer"), ("email", "character varying(80)")]);
        assert_eq!(
            render(Dialect::Postgres, &pg, &f).unwrap(),
            ("(\"t0\".\"id\" >= ($1::text)::integer AND \"t0\".\"email\" = ($2::text)::character varying)".into(), vec!["10".into(), "a@b.c".into()])
        );
        let my = meta(Dialect::Mysql, &[("id", "int(11)"), ("email", "varchar(80)")]);
        assert_eq!(render(Dialect::Mysql, &my, &f).unwrap().0, "(`t0`.`id` >= CAST(? AS SIGNED) AND `t0`.`email` = ?)");
        let ms = meta(Dialect::Mssql, &[("id", "int"), ("email", "nvarchar")]);
        assert_eq!(render(Dialect::Mssql, &ms, &f).unwrap().0, "([t0].[id] >= @P1 AND [t0].[email] = @P2)");
        let lite = meta(Dialect::Sqlite, &[("id", "integer"), ("email", "text")]);
        assert_eq!(render(Dialect::Sqlite, &lite, &f).unwrap().0, "(\"t0\".\"id\" >= ?1 AND \"t0\".\"email\" = ?2)");
    }

    #[test]
    fn ranges_lists_nulls_and_groups() {
        let m = meta(Dialect::Postgres, &[("id", "integer"), ("at", "timestamp without time zone"), ("role", "text")]);
        let f = group(
            BoolOp::Or,
            true,
            vec![
                cond("a", "id", Op::Between, &["1", "5"]),
                cond("b", "at", Op::Range, &["2026-11-14", "2026-11-15"]),
                cond("c", "role", Op::In, &["admin", "owner"]),
                cond("d", "role", Op::IsNull, &[]),
                cond("e", "id", Op::NotIn, &[]),
            ],
        );
        let (sql, params) = render(Dialect::Postgres, &m, &f).unwrap();
        assert_eq!(
            sql,
            "NOT (\"t0\".\"id\" BETWEEN ($1::text)::integer AND ($2::text)::integer OR (\"t0\".\"at\" >= ($3::text)::timestamp without time zone AND \"t0\".\"at\" < ($4::text)::timestamp without time zone) OR \"t0\".\"role\" IN (($5::text)::text, ($6::text)::text) OR \"t0\".\"role\" IS NULL OR 1 = 1)"
        );
        assert_eq!(params, vec!["1", "5", "2026-11-14 00:00:00", "2026-11-15 00:00:00", "admin", "owner"]);
    }

    #[test]
    fn text_matching_and_case() {
        let m = meta(Dialect::Mssql, &[("email", "varchar"), ("n", "int")]);
        let f = group(
            BoolOp::And,
            false,
            vec![
                cond("a", "email", Op::Contains, &["50%"]),
                FilterNode::Cond { id: "b".into(), column: "email".into(), op: Op::StartsWith, args: vec!["A".into()], cs: true },
                cond("c", "n", Op::NotContains, &["7"]),
                cond("d", "email", Op::IsEmpty, &[]),
            ],
        );
        let (sql, params) = render(Dialect::Mssql, &m, &f).unwrap();
        assert_eq!(
            sql,
            "([t0].[email] LIKE @P1 ESCAPE '!' AND [t0].[email] COLLATE Latin1_General_100_BIN2 LIKE @P2 ESCAPE '!' AND NOT (CONVERT(NVARCHAR(MAX), [t0].[n]) LIKE @P3 ESCAPE '!') AND DATALENGTH([t0].[email]) = 0)"
        );
        assert_eq!(params, vec!["%50!%%", "A%", "%7%"]);
        let lite = meta(Dialect::Sqlite, &[("email", "text")]);
        let cs = FilterNode::Cond { id: "x".into(), column: "email".into(), op: Op::EndsWith, args: vec!["Com".into()], cs: true };
        assert_eq!(render(Dialect::Sqlite, &lite, &cs).unwrap().0, "substr(\"t0\".\"email\", -length(?1)) = ?1");
    }

    #[test]
    fn problems_are_reported_per_condition() {
        let m = meta(Dialect::Postgres, &[("id", "integer"), ("doc", "json"), ("name", "text")]);
        let f = group(
            BoolOp::And,
            false,
            vec![
                cond("bad-int", "id", Op::Eq, &["abc"]),
                cond("unknown", "nope", Op::Eq, &["1"]),
                cond("json-order", "doc", Op::Lt, &["{}"]),
                cond("arity", "id", Op::Between, &["1"]),
                cond("ok", "name", Op::Eq, &["x"]),
                cond("empty-int", "id", Op::IsEmpty, &[]),
            ],
        );
        let issues = render(Dialect::Postgres, &m, &f).unwrap_err();
        let ids: Vec<&str> = issues.iter().map(|i| i.node.as_str()).collect();
        assert_eq!(ids, vec!["bad-int", "unknown", "json-order", "arity", "empty-int"]);
        assert!(issues[0].message.contains("whole number"));
        let regex = cond("re", "name", Op::Regex, &["^a"]);
        assert!(render(Dialect::Mssql, &meta(Dialect::Mssql, &[("name", "nvarchar")]), &regex).unwrap_err()[0].message.contains("PostgreSQL or MySQL"));
        // JSON equality still works, as text.
        assert_eq!(render(Dialect::Postgres, &m, &cond("j", "doc", Op::Eq, &["{}"])).unwrap().0, "(\"t0\".\"doc\")::text = $1");
    }

    #[test]
    fn limits_and_legacy_filters() {
        let m = meta(Dialect::Mssql, &[("id", "int")]);
        let many: Vec<String> = (0..MAX_LIST + 1).map(|i| i.to_string()).collect();
        let f = FilterNode::Cond { id: "big".into(), column: "id".into(), op: Op::In, args: many, cs: false };
        assert!(render(Dialect::Mssql, &m, &f).unwrap_err()[0].message.contains("1000"));
        let mut deep = cond("leaf", "id", Op::Eq, &["1"]);
        for _ in 0..MAX_DEPTH {
            deep = group(BoolOp::And, false, vec![deep]);
        }
        assert!(render(Dialect::Mssql, &m, &deep).is_ok(), "{MAX_DEPTH} nested groups are allowed");
        deep = group(BoolOp::And, false, vec![deep]);
        assert!(render(Dialect::Mssql, &m, &deep).is_err());
        let legacy = [BrowseFilter { column: "id".into(), value: Some("7".into()) }, BrowseFilter { column: "id".into(), value: None }];
        let combined = combine(None, &legacy).unwrap();
        assert_eq!(render(Dialect::Mssql, &m, &combined).unwrap().0, "([t0].[id] = @P1 AND [t0].[id] IS NULL)");
        // The serialized shape the frontend sends.
        let json = r#"{"t":"group","id":"r","op":"or","items":[{"t":"cond","id":"c","column":"id","op":"notIn","args":["1"]}]}"#;
        let parsed: FilterNode = serde_json::from_str(json).unwrap();
        assert_eq!(render(Dialect::Mssql, &m, &parsed).unwrap().0, "[t0].[id] NOT IN (@P1)");
        assert!(serde_json::from_str::<FilterNode>(r#"{"t":"cond","id":"c","column":"id","op":"drop"}"#).is_err());
    }

    #[test]
    fn search_every_text_column() {
        let m = meta(Dialect::Postgres, &[("id", "bigint"), ("email", "text"), ("born", "date"), ("doc", "jsonb"), ("raw", "bytea")]);
        let f = FilterNode::Search { id: "s".into(), text: "42".into(), columns: vec![], cs: false };
        let (sql, params) = render(Dialect::Postgres, &m, &f).unwrap();
        assert_eq!(sql, "(\"t0\".\"id\" = ($1::text)::bigint OR \"t0\".\"email\" ILIKE $2 ESCAPE '!' OR (\"t0\".\"doc\")::text ILIKE $3 ESCAPE '!')");
        assert_eq!(params, vec!["42", "%42%", "%42%"]);
        let f = FilterNode::Search { id: "s".into(), text: "ann".into(), columns: vec!["email".into()], cs: true };
        assert_eq!(render(Dialect::Mysql, &meta(Dialect::Mysql, &[("email", "varchar(9)")]), &f).unwrap().0, "`t0`.`email` LIKE (? COLLATE utf8mb4_bin) ESCAPE '!'");
        let unknown = FilterNode::Search { id: "s".into(), text: "x".into(), columns: vec!["nope".into()], cs: false };
        assert!(render(Dialect::Postgres, &m, &unknown).is_err());
        let only_numbers = meta(Dialect::Postgres, &[("id", "bigint")]);
        let f = FilterNode::Search { id: "s".into(), text: "ann".into(), columns: vec![], cs: false };
        assert_eq!(render(Dialect::Postgres, &only_numbers, &f).unwrap().0, "1 = 0");
        // A wide table: every column is searched, none skipped.
        let names: Vec<String> = (0..100).map(|i| format!("c{i}")).collect();
        let wide = meta(Dialect::Postgres, &names.iter().map(|n| (n.as_str(), "text")).collect::<Vec<_>>());
        assert_eq!(render(Dialect::Postgres, &wide, &f).unwrap().1.len(), 100);
        let named = FilterNode::Search { id: "s".into(), text: "ann".into(), columns: names, cs: false };
        assert!(render(Dialect::Postgres, &wide, &named).is_err(), "naming more than {MAX_SEARCH_COLUMNS} columns is reported");
    }

    /// Every operator against real data, on SQLite (the engine the tests can run).
    #[test]
    fn operators_match_the_right_rows_on_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, born DATE, flag BOOLEAN, data BLOB);
             INSERT INTO t VALUES (1, 'Ann', 1.0, '2000-01-01', 1, x'0a1b'), (2, 'bob', 2.5, '2010-06-15', 0, NULL),
               (3, ' Cid ', NULL, NULL, 1, x'ff'), (4, '', 10, '2026-11-14', NULL, NULL), (5, NULL, 3, '1999-12-31', 0, NULL),
               (6, '50% off_now!', 0, NULL, 0, NULL);",
        )
        .unwrap();
        let m = crate::db::catalog::sqlite_meta(&conn, "t").unwrap().unwrap();
        let ids = |f: FilterNode| -> Vec<i64> {
            let mut r = Render::new(Dialect::Sqlite);
            let scope = Scope { meta: &m, alias: "t0".into() };
            let sql = where_clause(&mut r, &scope, Some(&f)).unwrap().unwrap();
            let mut stmt = conn.prepare(&format!("SELECT id FROM t AS \"t0\" WHERE {sql} ORDER BY id")).unwrap();
            stmt.query_map(rusqlite::params_from_iter(r.params.iter()), |row| row.get(0)).unwrap().map(Result::unwrap).collect()
        };
        let cs = |op: Op, v: &str| FilterNode::Cond { id: "c".into(), column: "name".into(), op, args: vec![v.into()], cs: true };
        assert_eq!(ids(cond("c", "score", Op::Eq, &["1"])), vec![1], "1 matches the REAL 1.0");
        assert_eq!(ids(cond("c", "score", Op::Gt, &["2"])), vec![2, 4, 5]);
        assert_eq!(ids(cond("c", "score", Op::Between, &["0", "2.5"])), vec![1, 2, 6]);
        assert_eq!(ids(cond("c", "born", Op::Range, &["2000-01-01", "2010-06-16"])), vec![1, 2]);
        assert_eq!(ids(cond("c", "flag", Op::Eq, &["true"])), vec![1, 3]);
        assert_eq!(ids(cond("c", "flag", Op::Ne, &["yes"])), vec![2, 5, 6], "NULL is neither");
        assert_eq!(ids(cond("c", "id", Op::In, &["2", "4", "9"])), vec![2, 4]);
        assert_eq!(ids(cond("c", "id", Op::NotIn, &["1", "2", "3", "4"])), vec![5, 6]);
        assert_eq!(ids(cond("c", "name", Op::IsNull, &[])), vec![5]);
        assert_eq!(ids(cond("c", "name", Op::Contains, &["o"])), vec![2, 6]);
        assert_eq!(ids(cond("c", "name", Op::Contains, &["50%"])), vec![6], "% is literal");
        assert_eq!(ids(cond("c", "name", Op::Contains, &["f_n"])), vec![6], "_ is literal");
        assert_eq!(ids(cond("c", "name", Op::StartsWith, &["a"])), vec![1], "case-insensitive");
        assert_eq!(ids(cs(Op::StartsWith, "a")), Vec::<i64>::new());
        assert_eq!(ids(cs(Op::Contains, "Ann")), vec![1]);
        assert_eq!(ids(cs(Op::EndsWith, "now!")), vec![6]);
        assert_eq!(ids(cond("c", "name", Op::NotContains, &["n"])), vec![2, 3, 4], "NULL excluded");
        assert_eq!(ids(cond("c", "name", Op::IsEmpty, &[])), vec![4]);
        assert_eq!(ids(cond("c", "name", Op::IsBlank, &[])), vec![4]);
        assert_eq!(ids(cond("c", "name", Op::IsPadded, &[])), vec![3]);
        assert_eq!(ids(cond("c", "data", Op::Eq, &["0x0A1B"])), vec![1], "blobs compare by their \\x text");
        assert_eq!(ids(group(BoolOp::Or, false, vec![cond("a", "id", Op::Eq, &["1"]), cond("b", "id", Op::Eq, &["6"])])), vec![1, 6]);
        assert_eq!(ids(group(BoolOp::And, true, vec![cond("a", "id", Op::Le, &["4"])])), vec![5, 6]);
    }
}
