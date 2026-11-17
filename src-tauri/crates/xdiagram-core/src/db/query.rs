//! Join query builder: one SELECT over a tree of tables joined along their relationships. The
//! request is structured (tables, join keys, columns, a filter tree), never SQL text; every
//! identifier is checked against the catalog before it is quoted, values are bound parameters.

use std::collections::HashMap;

use serde::Deserialize;

use super::browse::MAX_LIMIT;
use super::catalog::{Catalog, TableMeta};
use super::filter::{where_clause, BoolOp, FilterNode, Op, Render, Scope};
use super::sql::Dialect;
use crate::error::AppError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinTable {
    pub schema: String,
    pub table: String,
    pub alias: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinClause {
    /// Alias of the table being joined.
    pub alias: String,
    /// Alias of a table already in the query.
    pub parent: String,
    /// `(parent column, joined column)` pairs.
    pub on: Vec<(String, String)>,
    #[serde(default)]
    pub left: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryColumn {
    pub alias: String,
    pub column: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryFilter {
    pub alias: String,
    pub column: String,
    /// `None` means `IS NULL`.
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOrder {
    pub alias: String,
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    /// The first table is the FROM table.
    pub tables: Vec<JoinTable>,
    pub joins: Vec<JoinClause>,
    pub columns: Vec<QueryColumn>,
    /// Equality filters (older callers); AND-ed with `filter`.
    #[serde(default)]
    pub filters: Vec<QueryFilter>,
    /// The filter tree (see `filter.rs`); its columns are named `alias.column`.
    #[serde(default)]
    pub filter: Option<FilterNode>,
    pub order_by: Option<QueryOrder>,
    pub limit: u32,
    #[serde(default)]
    pub offset: u64,
    /// Statement time limit in seconds (default 15).
    #[serde(default)]
    pub timeout_secs: Option<u32>,
}

/// How the SQL is written: to read and copy, or to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Plain columns, values inline as literals.
    Readable,
    /// Every column cast to text, values as parameters, one extra row to detect more pages.
    Execute,
}

fn valid_alias(a: &str) -> bool {
    !a.is_empty() && a.len() <= 30 && a.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The SELECT for `req` and its parameters (Readable: none, the values are written in). `tables`
/// maps each alias to its table; when a table's column list is empty, its selected and join
/// columns are not checked (conditions always are).
pub fn build(d: Dialect, req: &JoinRequest, tables: &HashMap<String, TableMeta>, cat: Option<&Catalog>, mode: Mode) -> Result<(String, Vec<String>), AppError> {
    let invalid = |m: String| Err(AppError::Invalid(m));
    if req.tables.is_empty() {
        return invalid("Add a table to the query".into());
    }
    for t in &req.tables {
        if !valid_alias(&t.alias) {
            return invalid(format!("Invalid alias {}", t.alias));
        }
    }
    let type_of = |alias: &str, column: &str| -> Result<String, AppError> {
        let t = tables.get(alias).ok_or_else(|| AppError::Invalid(format!("Unknown table alias {alias}")))?;
        if t.columns.is_empty() {
            return Ok(String::new());
        }
        t.columns
            .iter()
            .find(|c| c.name == column)
            .map(|c| c.type_name.clone())
            .ok_or_else(|| AppError::Invalid(format!("Unknown column {alias}.{column}")))
    };
    let col = |alias: &str, column: &str| format!("{}.{}", d.quote(alias), d.quote(column));

    if req.columns.is_empty() {
        return invalid("Pick at least one column".into());
    }
    let mut select = Vec::new();
    for c in &req.columns {
        let ty = type_of(&c.alias, &c.column)?;
        let expr = col(&c.alias, &c.column);
        select.push(match mode {
            Mode::Execute => d.select_text(&expr, &ty),
            Mode::Readable => expr,
        });
    }

    let root = &req.tables[0];
    let from_of = |alias: &str| -> Result<&str, AppError> {
        tables.get(alias).map(|t| t.qualified.as_str()).ok_or_else(|| AppError::Invalid(format!("Unknown table alias {alias}")))
    };
    let sep = if mode == Mode::Readable { "\n" } else { " " };
    let mut sql = format!("SELECT {}{sep}FROM {} AS {}", select.join(", "), from_of(&root.alias)?, d.quote(&root.alias));
    let mut joined = vec![root.alias.as_str()];
    for j in &req.joins {
        if !joined.contains(&j.parent.as_str()) {
            return invalid(format!("{} is joined before {}", j.alias, j.parent));
        }
        if j.on.is_empty() {
            return invalid(format!("No join columns for {}", j.alias));
        }
        let mut conds = Vec::new();
        for (p, c) in &j.on {
            type_of(&j.parent, p)?;
            type_of(&j.alias, c)?;
            conds.push(format!("{} = {}", col(&j.alias, c), col(&j.parent, p)));
        }
        sql.push_str(&format!(
            "{sep}{} JOIN {} AS {} ON {}",
            if j.left { "LEFT" } else { "INNER" },
            from_of(&j.alias)?,
            d.quote(&j.alias),
            conds.join(" AND ")
        ));
        joined.push(&j.alias);
    }
    if joined.len() != req.tables.len() {
        return invalid("Every table after the first needs a join".into());
    }

    // The equality filters and the filter tree, rendered together (typed comparisons, every
    // column checked; `alias.column` reaches any table of the join).
    let mut items: Vec<FilterNode> = req
        .filters
        .iter()
        .enumerate()
        .map(|(i, f)| FilterNode::Cond {
            id: format!("filter-{i}"),
            column: format!("{}.{}", f.alias, f.column),
            op: if f.value.is_some() { Op::Eq } else { Op::IsNull },
            args: f.value.iter().cloned().collect(),
            cs: false,
        })
        .collect();
    items.extend(req.filter.iter().cloned());
    let mut r = Render::new(d);
    if !items.is_empty() {
        let main = tables.get(&root.alias).ok_or_else(|| AppError::Invalid(format!("Unknown table alias {}", root.alias)))?;
        let joined = req.tables[1..].iter().filter_map(|t| tables.get(&t.alias).map(|m| (t.alias.clone(), m))).collect();
        let scope = Scope { meta: main, alias: root.alias.clone(), joined, cat };
        let node = if items.len() == 1 { items.remove(0) } else { FilterNode::Group { id: "query".into(), op: BoolOp::And, not: false, items } };
        if let Some(c) = where_clause(&mut r, &scope, Some(&node))? {
            sql.push_str(&format!("{sep}WHERE {c}"));
        }
    }
    let order = match &req.order_by {
        Some(o) => {
            type_of(&o.alias, &o.column)?;
            format!("{}{}", col(&o.alias, &o.column), if o.desc { " DESC" } else { "" })
        }
        None => String::new(),
    };
    let limit = req.limit.clamp(1, MAX_LIMIT);
    let fetch = if mode == Mode::Execute { limit + 1 } else { limit };
    let paging = d.paging(&order, fetch, req.offset);
    sql.push_str(&if mode == Mode::Readable { paging.replacen(' ', "\n", 1) } else { paging });
    Ok(match mode {
        Mode::Execute => (sql, r.params),
        Mode::Readable => (d.inline_params(&sql, &r.params), Vec::new()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::browse::BrowseColumn;

    fn meta(d: Dialect, table: &str, cols: &[(&str, &str)]) -> TableMeta {
        TableMeta { qualified: d.qualified("public", table), columns: cols.iter().map(|(n, t)| BrowseColumn::named(d, n, t)).collect(), ..Default::default() }
    }

    fn request() -> (JoinRequest, HashMap<String, TableMeta>) {
        request_for(Dialect::Postgres)
    }

    fn request_for(d: Dialect) -> (JoinRequest, HashMap<String, TableMeta>) {
        let req = JoinRequest {
            tables: vec![
                JoinTable { schema: "public".into(), table: "users".into(), alias: "u".into() },
                JoinTable { schema: "public".into(), table: "memberships".into(), alias: "m".into() },
            ],
            joins: vec![JoinClause { alias: "m".into(), parent: "u".into(), on: vec![("id".into(), "user_id".into())], left: false }],
            columns: vec![QueryColumn { alias: "u".into(), column: "email".into() }, QueryColumn { alias: "m".into(), column: "org_id".into() }],
            filters: vec![QueryFilter { alias: "m".into(), column: "org_id".into(), value: Some("7".into()) }],
            filter: None,
            order_by: Some(QueryOrder { alias: "u".into(), column: "email".into(), desc: false }),
            limit: 50,
            offset: 100,
            timeout_secs: None,
        };
        let mut t = HashMap::new();
        t.insert("u".to_string(), meta(d, "users", &[("id", "integer"), ("email", "text")]));
        t.insert("m".to_string(), meta(d, "memberships", &[("user_id", "integer"), ("org_id", "integer")]));
        (req, t)
    }

    #[test]
    fn filter_tree_reaches_every_table() {
        let (mut req, t) = request();
        req.filters.clear();
        let cond = |id: &str, column: &str, op: Op, v: &str| FilterNode::Cond { id: id.into(), column: column.into(), op, args: vec![v.into()], cs: false };
        req.filter = Some(FilterNode::Group {
            id: "g".into(),
            op: BoolOp::Or,
            not: false,
            items: vec![
                cond("a", "u.email", Op::Contains, "x'y"),
                cond("b", "m.org_id", Op::Gt, "3"),
                FilterNode::Search { id: "s".into(), text: "7".into(), columns: vec![], cs: false },
            ],
        });
        let (sql, params) = build(Dialect::Postgres, &req, &t, None, Mode::Execute).unwrap();
        assert!(
            sql.contains(
                "WHERE (\"u\".\"email\" ILIKE $1 ESCAPE '!' OR \"m\".\"org_id\" > ($2::text)::integer OR (\"u\".\"id\" = ($3::text)::integer \
                 OR \"u\".\"email\" ILIKE $4 ESCAPE '!' OR \"m\".\"user_id\" = ($5::text)::integer OR \"m\".\"org_id\" = ($6::text)::integer))"
            ),
            "{sql}"
        );
        assert_eq!(params, vec!["%x'y%", "3", "7", "%7%", "7", "7"]);
        let (readable, none) = build(Dialect::Postgres, &req, &t, None, Mode::Readable).unwrap();
        assert!(none.is_empty() && readable.contains("\"u\".\"email\" ILIKE '%x''y%' ESCAPE '!'"), "{readable}");
        req.filter = Some(cond("z", "x.id", Op::Eq, "1"));
        assert!(matches!(build(Dialect::Postgres, &req, &t, None, Mode::Execute), Err(AppError::Filter(_))));
        req.filter = Some(cond("z", "u.id", Op::Eq, "abc"));
        assert!(matches!(build(Dialect::Postgres, &req, &t, None, Mode::Execute), Err(AppError::Filter(_))));
    }

    #[test]
    fn executable_postgres() {
        let (req, t) = request();
        let (sql, params) = build(Dialect::Postgres, &req, &t, None, Mode::Execute).unwrap();
        assert_eq!(
            sql,
            "SELECT (\"u\".\"email\")::text, (\"m\".\"org_id\")::text FROM \"public\".\"users\" AS \"u\" \
             INNER JOIN \"public\".\"memberships\" AS \"m\" ON \"m\".\"user_id\" = \"u\".\"id\" \
             WHERE \"m\".\"org_id\" = ($1::text)::integer ORDER BY \"u\".\"email\" LIMIT 51 OFFSET 100"
        );
        assert_eq!(params, vec!["7"]);
    }

    #[test]
    fn readable_and_other_dialects() {
        let (req, t) = request_for(Dialect::Mysql);
        let (sql, params) = build(Dialect::Mysql, &req, &t, None, Mode::Readable).unwrap();
        assert!(sql.contains("\nINNER JOIN `public`.`memberships` AS `m` ON `m`.`user_id` = `u`.`id`"), "{sql}");
        assert!(sql.contains("\nWHERE `m`.`org_id` = CAST('7' AS SIGNED)"), "{sql}");
        assert!(sql.ends_with("\nORDER BY `u`.`email` LIMIT 50 OFFSET 100"), "{sql}");
        assert!(params.is_empty());
        let (mut req, t) = request_for(Dialect::Mssql);
        req.order_by = None;
        req.joins[0].left = true;
        let (sql, _) = build(Dialect::Mssql, &req, &t, None, Mode::Execute).unwrap();
        assert!(sql.contains("LEFT JOIN"));
        assert!(sql.contains("= @P1"));
        assert!(sql.ends_with("ORDER BY (SELECT NULL) OFFSET 100 ROWS FETCH NEXT 51 ROWS ONLY"), "{sql}");
    }

    #[test]
    fn rejects_unknown_identifiers() {
        let (mut req, t) = request();
        req.columns.push(QueryColumn { alias: "u".into(), column: "password; DROP TABLE x".into() });
        assert!(build(Dialect::Postgres, &req, &t, None, Mode::Execute).is_err());
        let (mut req, t) = request();
        req.tables[1].alias = "m\"; --".into();
        assert!(build(Dialect::Postgres, &req, &t, None, Mode::Execute).is_err());
        let (mut req, t) = request();
        req.joins[0].parent = "x".into();
        assert!(build(Dialect::Postgres, &req, &t, None, Mode::Execute).is_err());
    }
}
