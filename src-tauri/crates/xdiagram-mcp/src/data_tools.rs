//! Data tools: rows, counts, value counts, column profiles and join queries, read-only through
//! the same generated SELECTs as xdiagram's data browser, with personal data masked on "masked"
//! connections and nothing at all on "schema" ones.

use std::collections::BTreeMap;
use std::time::Duration;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use xdiagram_core::db::browse::{BrowseRequest, BrowseResult, CountRequest, OrderBy};
use xdiagram_core::db::dispatch;
use xdiagram_core::db::filter::FilterNode;
use xdiagram_core::db::profile::ProfileRequest;
use xdiagram_core::db::query::{JoinClause, JoinRequest, JoinTable, QueryColumn, QueryOrder};
use xdiagram_core::db::values::ValuesRequest;

use crate::access::{Conn, run_op};
use crate::mask::{self, MaskReport};
use crate::schema_tools::{TableRef, resolve_table};
use crate::server::{MAX_REPLY_LEN, ToolResult, XdiagramServer, json_text, text};

const DEFAULT_ROWS: u32 = 50;
const MAX_ROWS: u32 = 200;
/// Values are cut to this many characters for the agent (the grid's own limit is 4,000).
const MAX_VALUE_CHARS: usize = 500;

/// The filter's schema where browse_rows already gives it in full: an object (a filter node), to
/// keep the tool list short. Deserialized as a `FilterNode` all the same.
type FilterTree = serde_json::Map<String, serde_json::Value>;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SortArg {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowseArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The table: `schema.table`, or the table name when it is unique.
    pub table: String,
    /// Which rows (see the tool description for the node types).
    #[serde(default)]
    pub filter: Option<FilterNode>,
    /// The columns to return, in this order (default: all).
    #[serde(default)]
    pub columns: Vec<String>,
    /// Sort keys, first one first (the primary key is always added last, so pages are stable).
    #[serde(default)]
    pub sort: Vec<SortArg>,
    /// Rows to return (default 50, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Rows to skip, for the next page.
    #[serde(default)]
    pub offset: u64,
    /// Also return the SELECT with the values written in, to show the user or run elsewhere.
    #[serde(default)]
    pub include_sql: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CountArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The table: `schema.table`, or the table name when it is unique.
    pub table: String,
    /// Which rows to count: a filter tree as described in browse_rows; all rows when left out.
    #[serde(default)]
    #[schemars(with = "Option<FilterTree>")]
    pub filter: Option<FilterNode>,
    /// Stop counting at this many (default 100,000; at most 10,000,000).
    #[serde(default)]
    pub cap: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ValuesArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The table: `schema.table`, or the table name when it is unique.
    pub table: String,
    /// The column whose values to count.
    pub column: String,
    /// Only among the rows this filter matches: a filter tree as described in browse_rows.
    #[serde(default)]
    #[schemars(with = "Option<FilterTree>")]
    pub filter: Option<FilterNode>,
    /// Only values containing this text.
    #[serde(default)]
    pub search: Option<String>,
    /// Values to list (default 50, at most 500).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProfileArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The table: `schema.table`, or the table name when it is unique.
    pub table: String,
    /// Rows to sample (default: the app's setting, 20,000; 100 to 100,000).
    #[serde(default)]
    pub sample_rows: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JoinTableArg {
    /// The table: `schema.table`, or the table name when it is unique.
    pub table: String,
    /// Its alias in the query (letters, digits, `_`; at most 30).
    pub alias: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JoinArg {
    /// Alias of the table being joined.
    pub alias: String,
    /// Alias of a table joined before it (or the first table).
    pub parent: String,
    /// `[parent column, joined column]` pairs (find_join_paths gives them).
    pub on: Vec<(String, String)>,
    /// LEFT JOIN instead of INNER JOIN (keep parent rows without a match).
    #[serde(default)]
    pub left: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ColumnArg {
    pub alias: String,
    pub column: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JoinOrderArg {
    pub alias: String,
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JoinQueryArgs {
    /// The saved connection: its name as list_connections shows it, or its id.
    pub connection: String,
    /// The tables, the first one being the FROM table.
    pub tables: Vec<JoinTableArg>,
    /// How each further table joins one before it.
    pub joins: Vec<JoinArg>,
    /// The columns to return (default: every column of every table).
    #[serde(default)]
    pub columns: Vec<ColumnArg>,
    /// Which rows: a filter tree as described in browse_rows, with columns written `alias.column`.
    #[serde(default)]
    #[schemars(with = "Option<FilterTree>")]
    pub filter: Option<FilterNode>,
    #[serde(default)]
    pub order_by: Option<JoinOrderArg>,
    /// Rows to return (default 50, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: u64,
    /// Also return the SELECT with the values written in.
    #[serde(default)]
    pub include_sql: bool,
}

/// Rows as the agent gets them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rows {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    has_more: bool,
    offset: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    order: Vec<String>,
    #[serde(skip_serializing_if = "MaskReport::is_empty", flatten)]
    masked: MaskReport,
    /// Values cut to 500 characters.
    #[serde(skip_serializing_if = "is_zero")]
    shortened_values: usize,
    /// Rows of the page left out so the reply fits; they start the next page.
    #[serde(skip_serializing_if = "is_zero")]
    rows_cut: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sql: Option<String>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// Gives every filter node without an id one, so problems can name the condition.
fn number_nodes(node: &mut FilterNode, next: &mut usize) {
    let id = match node {
        FilterNode::Group { id, .. }
        | FilterNode::Cond { id, .. }
        | FilterNode::Search { id, .. }
        | FilterNode::Rel { id, .. }
        | FilterNode::Cols { id, .. }
        | FilterNode::Dup { id, .. } => id,
    };
    if id.is_empty() {
        *next += 1;
        *id = format!("n{next}");
    }
    match node {
        FilterNode::Group { items, .. } => items.iter_mut().for_each(|item| number_nodes(item, next)),
        FilterNode::Rel { filter: Some(inner), .. } => number_nodes(inner, next),
        _ => {}
    }
}

/// The filter ready to send: ids filled in, and related-row conditions kept to the connection's
/// schemas.
fn prepare_filter(conn: &Conn, filter: Option<FilterNode>) -> Result<Option<FilterNode>, String> {
    fn check(conn: &Conn, node: &FilterNode) -> Result<(), String> {
        match node {
            FilterNode::Group { items, .. } => items.iter().try_for_each(|i| check(conn, i)),
            FilterNode::Rel { schema, filter, .. } => {
                conn.check_schema(schema)?;
                filter.as_deref().map_or(Ok(()), |f| check(conn, f))
            }
            _ => Ok(()),
        }
    }
    let Some(mut node) = filter else { return Ok(None) };
    let mut next = 0;
    number_nodes(&mut node, &mut next);
    check(conn, &node)?;
    Ok(Some(node))
}

fn row_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS)
}

/// A table of the connection, after the scope and data-access checks every data tool makes.
async fn data_table(server: &XdiagramServer, conn: &Conn, name: &str, ct: &CancellationToken) -> Result<TableRef, String> {
    conn.require_rows()?;
    let schema = server.cache.get(conn, false, ct).await?;
    let table = resolve_table(&schema, name)?;
    conn.check_schema(&table.schema)?;
    Ok(table)
}

/// Cuts values longer than `MAX_VALUE_CHARS`; how many were cut, row by row.
fn shorten(rows: &mut [Vec<Option<String>>]) -> Vec<usize> {
    rows.iter_mut()
        .map(|row| {
            let mut cut = 0;
            for v in row.iter_mut().flatten() {
                if v.chars().count() > MAX_VALUE_CHARS {
                    *v = format!("{}…", v.chars().take(MAX_VALUE_CHARS).collect::<String>());
                    cut += 1;
                }
            }
            cut
        })
        .collect()
}

/// A page of rows as the agent gets it: masked, long values cut, and when the page would not fit
/// in one reply, only the rows that do (the others start the next page).
fn rows_reply(conn: &Conn, result: BrowseResult, offset: u64, sql: Option<String>) -> ToolResult {
    let columns: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
    let mut rows = result.rows;
    let masked = mask::mask_rows(conn.profile.mcp.data, &columns, &mut rows);
    let cut_by_row = shorten(&mut rows);
    let page = Rows {
        columns,
        rows: Vec::new(),
        has_more: result.has_more,
        offset,
        order: result.ordered_by,
        masked,
        shortened_values: 0,
        rows_cut: 0,
        note: None,
        sql,
    };
    text(fit_rows(page, rows, &cut_by_row)?)
}

/// The page with as many of `rows` as fit in `MAX_REPLY_LEN`, serialized.
fn fit_rows(mut page: Rows, rows: Vec<Vec<Option<String>>>, cut_by_row: &[usize]) -> Result<String, String> {
    let all = rows.len();
    let (has_more, columns) = (page.has_more, page.columns.len());
    let mut render = |kept: usize| -> Result<String, String> {
        page.rows = rows[..kept].to_vec();
        page.shortened_values = cut_by_row[..kept].iter().sum();
        page.masked.keep_rows(kept);
        page.rows_cut = all - kept;
        page.has_more = has_more || kept < all;
        page.note = (kept < all).then(|| {
            format!(
                "Only {kept} of the {all} rows fit in one reply; the next page starts at offset {}. Pass fewer `columns` or a smaller `limit` for more rows per reply.",
                page.offset + kept as u64
            )
        });
        serde_json::to_string(&page).map_err(|e| e.to_string())
    };
    let whole = render(all)?;
    if whole.len() <= MAX_REPLY_LEN {
        return Ok(whole);
    }
    let one = render(1)?;
    if one.len() > MAX_REPLY_LEN {
        return Err(format!(
            "One row with these {columns} columns is already {} characters, more than a reply carries. Pass `columns` to choose some.",
            one.len()
        ));
    }
    // The longest prefix that fits: `fits` always fits, `over` never does.
    let (mut fits, mut over) = (1, all);
    while over - fits > 1 {
        let mid = (fits + over) / 2;
        if render(mid)?.len() <= MAX_REPLY_LEN { fits = mid } else { over = mid }
    }
    render(fits)
}

impl XdiagramServer {
    /// Statement time limit (the app's setting) and the time allowed for the whole call.
    fn limits(&self) -> (u32, Duration) {
        let secs = self.access().settings().query_timeout_secs;
        (secs, Duration::from_secs(u64::from(secs) + 30))
    }
}

#[tool_router(router = data_router, vis = "pub(crate)")]
impl XdiagramServer {
    #[tool(
        name = "browse_rows",
        description = r#"Rows of a table, a page at a time, optionally filtered, sorted and limited to some columns. Values are text (null is NULL). On a masked connection, values that look like personal data read "[masked: kind]".

The filter is a tree of nodes, each with `t`:
- {"t":"group","op":"and"|"or","not":false,"items":[...]}
- {"t":"cond","column":"status","op":"eq","args":["paid"]}; op: eq ne lt le gt ge between range in notIn isNull notNull contains notContains startsWith endsWith isEmpty regex isBlank isPadded. Values are text in `args`: between takes 2, range takes [from, to) (dates), in/notIn any number, isNull none. "cs":true makes text matching case-sensitive.
- {"t":"search","text":"smith"}: the text in any text column.
- {"t":"cols","left":"ends_on","op":"lt","right":"starts_on"}: two columns of the row.
- {"t":"dup","columns":["email"]}: values found in more than one row.
- {"t":"rel","schema":"public","table":"orders","on":[["id","user_id"]],"quant":"some"|"none"|{"count":{"op":"ge","n":3}},"filter":{...}}: rows by their related rows; `on` pairs this table's column with the related table's, `filter` applies to the related rows.
Write dates out (2026-11-01); describe_table gives each column's kind, which decides the operators that apply."#,
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn browse_rows(&self, Parameters(args): Parameters<BrowseArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let table = data_table(self, &conn, &args.table, &ct).await?;
        let (secs, budget) = self.limits();
        let request = BrowseRequest {
            schema: table.db_schema(),
            table: table.table.clone(),
            filter: prepare_filter(&conn, args.filter)?,
            sort: args.sort.into_iter().map(|s| OrderBy { column: s.column, desc: s.desc }).collect(),
            limit: row_limit(args.limit),
            offset: args.offset,
            timeout_secs: Some(secs),
            columns: args.columns,
            ..Default::default()
        };
        let sql = if args.include_sql {
            let (input, req) = (conn.input.clone(), request.clone());
            Some(run_op(&ct, budget, async move { dispatch::filter_sql(&input, req).await }).await.map_err(|e| conn.explain(e))?)
        } else {
            None
        };
        let input = conn.input.clone();
        let offset = request.offset;
        let result = run_op(&ct, budget, async move { dispatch::browse(&input, request).await }).await.map_err(|e| conn.explain(e))?;
        rows_reply(&conn, result, offset, sql)
    }

    #[tool(
        name = "count_rows",
        description = "How many rows of a table match a filter (the filter tree browse_rows describes), counted up to a cap.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn count_rows(&self, Parameters(args): Parameters<CountArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let table = data_table(self, &conn, &args.table, &ct).await?;
        let (secs, budget) = self.limits();
        let request = CountRequest {
            request: BrowseRequest {
                schema: table.db_schema(),
                table: table.table.clone(),
                filter: prepare_filter(&conn, args.filter)?,
                limit: 1,
                timeout_secs: Some(secs),
                ..Default::default()
            },
            cap: args.cap,
        };
        let input = conn.input.clone();
        let result = run_op(&ct, budget, async move { dispatch::count_rows(&input, request).await }).await.map_err(|e| conn.explain(e))?;
        json_text(&result)
    }

    #[tool(
        name = "value_counts",
        description = "A column's values with how often each occurs among the rows a filter matches (most frequent first), with the smallest and largest value for numbers and dates. Sampled on large tables. Refused on a masked connection for columns that hold personal data.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn value_counts(&self, Parameters(args): Parameters<ValuesArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let table = data_table(self, &conn, &args.table, &ct).await?;
        let access = conn.profile.mcp.data;
        let refuse = |kind: &str| {
            Err(format!(
                "\"{}\" looks like personal data ({kind}), so its values are masked on this connection. Filter on it with browse_rows or count_rows instead.",
                args.column
            ))
        };
        if access != xdiagram_core::profiles::DataAccess::Full
            && let Some(kind) = mask::column_kind(&args.column, &[])
        {
            return refuse(kind);
        }
        let (secs, budget) = self.limits();
        let request = ValuesRequest {
            schema: table.db_schema(),
            table: table.table.clone(),
            column: args.column.clone(),
            filter: prepare_filter(&conn, args.filter)?,
            search: args.search,
            limit: args.limit,
            timeout_secs: Some(secs),
        };
        let input = conn.input.clone();
        let mut result = run_op(&ct, budget, async move { dispatch::value_counts(&input, request).await }).await.map_err(|e| conn.explain(e))?;
        if access != xdiagram_core::profiles::DataAccess::Full {
            let values: Vec<&str> = result.values.iter().filter_map(|v| v.value.as_deref()).collect();
            if let Some(kind) = mask::column_kind(&args.column, &values) {
                return refuse(kind);
            }
            for v in result.values.iter_mut() {
                mask::mask_value(access, &mut v.value);
            }
            mask::mask_value(access, &mut result.min);
            mask::mask_value(access, &mut result.max);
        }
        json_text(&result)
    }

    #[tool(
        name = "profile_table",
        description = "Column statistics from a sample of a table: nulls, distinct values, minimum and maximum, lengths, the most common values, and which columns look like personal data. On a masked connection the values of those columns are masked.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn profile_table(&self, Parameters(args): Parameters<ProfileArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        let table = data_table(self, &conn, &args.table, &ct).await?;
        let settings = self.access().settings();
        let (_, budget) = self.limits();
        let request = ProfileRequest {
            schema: table.db_schema(),
            table: table.table.clone(),
            sample_rows: Some(args.sample_rows.unwrap_or(settings.profile_sample_rows)),
            timeout_secs: Some(settings.query_timeout_secs.max(20)),
        };
        let input = conn.input.clone();
        let mut profile = run_op(&ct, budget + Duration::from_secs(20), async move { dispatch::profile_table(&input, request).await })
            .await
            .map_err(|e| conn.explain(e))?;
        let report = mask::mask_profile(conn.profile.mcp.data, &mut profile);
        let mut out = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
        if !report.is_empty() {
            out["masked"] = serde_json::to_value(&report).map_err(|e| e.to_string())?;
        }
        let mut reply = out.to_string();
        if reply.len() > MAX_REPLY_LEN {
            // A wide table: the most common values go first (value_counts gives them per column).
            for col in out["columns"].as_array_mut().into_iter().flatten() {
                col["top"] = serde_json::json!([]);
            }
            out["note"] = "The most common values are left out to fit the reply; value_counts gives them for one column.".into();
            reply = out.to_string();
        }
        if reply.len() > MAX_REPLY_LEN {
            return Err(format!(
                "The profile of {} columns is {} characters, more than a reply carries. Use value_counts on the columns you need.",
                profile.columns.len(),
                reply.len()
            ));
        }
        text(reply)
    }

    #[tool(
        name = "run_join_query",
        description = "Rows of several tables joined together: give the tables with aliases and, for each further table, the columns it joins on (find_join_paths gives them). Filter and order by `alias.column`. Read-only and paged like browse_rows, with the same masking.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn run_join_query(&self, Parameters(args): Parameters<JoinQueryArgs>, ct: CancellationToken) -> ToolResult {
        let conn = self.conn(&args.connection)?;
        conn.require_rows()?;
        if args.tables.is_empty() {
            return Err("Name at least one table.".into());
        }
        let schema = self.cache.get(&conn, false, &ct).await?;
        let mut tables = Vec::new();
        let mut columns_of: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for t in &args.tables {
            let r = resolve_table(&schema, &t.table)?;
            conn.check_schema(&r.schema)?;
            let cols = schema.fields.get(&r.key()).map(|f| f.iter().map(|f| f.name.clone()).collect()).unwrap_or_default();
            columns_of.insert(t.alias.clone(), cols);
            tables.push(JoinTable { schema: r.db_schema(), table: r.table, alias: t.alias.clone() });
        }
        let columns: Vec<QueryColumn> = if args.columns.is_empty() {
            args.tables
                .iter()
                .flat_map(|t| columns_of.get(&t.alias).cloned().unwrap_or_default().into_iter().map(|c| QueryColumn { alias: t.alias.clone(), column: c }))
                .collect()
        } else {
            args.columns.into_iter().map(|c| QueryColumn { alias: c.alias, column: c.column }).collect()
        };
        let (secs, budget) = self.limits();
        let request = JoinRequest {
            tables,
            joins: args.joins.into_iter().map(|j| JoinClause { alias: j.alias, parent: j.parent, on: j.on, left: j.left }).collect(),
            columns,
            filters: Vec::new(),
            filter: prepare_filter(&conn, args.filter)?,
            order_by: args.order_by.map(|o| QueryOrder { alias: o.alias, column: o.column, desc: o.desc }),
            limit: row_limit(args.limit),
            offset: args.offset,
            timeout_secs: Some(secs),
        };
        let sql = if args.include_sql {
            let (input, req) = (conn.input.clone(), request.clone());
            Some(run_op(&ct, budget, async move { dispatch::join_sql(&input, req).await }).await.map_err(|e| conn.explain(e))?)
        } else {
            None
        };
        let offset = request.offset;
        let input = conn.input.clone();
        let result = run_op(&ct, budget, async move { dispatch::browse_join(&input, request).await }).await.map_err(|e| conn.explain(e))?;
        rows_reply(&conn, result, offset, sql)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn numbers_filter_nodes_without_ids() {
        let mut node: FilterNode = serde_json::from_value(serde_json::json!({
            "t": "group", "op": "and", "items": [
                { "t": "cond", "column": "a", "op": "eq", "args": ["1"] },
                { "t": "cond", "id": "mine", "column": "b", "op": "isNull" },
                { "t": "rel", "schema": "public", "table": "o", "on": [["id", "u_id"]], "quant": "some",
                  "filter": { "t": "cond", "column": "x", "op": "gt", "args": ["2"] } }
            ]
        }))
        .unwrap();
        number_nodes(&mut node, &mut 0);
        let FilterNode::Group { id, items, .. } = &node else { panic!() };
        assert_eq!(id, "n1");
        let ids: Vec<&str> = items
            .iter()
            .map(|i| match i {
                FilterNode::Cond { id, .. } | FilterNode::Rel { id, .. } => id.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(ids, ["n2", "mine", "n3"]);
        let FilterNode::Rel { filter: Some(inner), .. } = &items[2] else { panic!() };
        assert!(matches!(inner.as_ref(), FilterNode::Cond { id, .. } if id == "n4"));
    }

    fn page(columns: usize, rows: usize, value_len: usize) -> (Rows, Vec<Vec<Option<String>>>) {
        let page = Rows {
            columns: (0..columns).map(|i| format!("c{i}")).collect(),
            rows: Vec::new(),
            has_more: false,
            offset: 40,
            order: Vec::new(),
            masked: MaskReport { values_by_row: vec![1; rows], masked_values: rows, ..Default::default() },
            shortened_values: 0,
            rows_cut: 0,
            note: None,
            sql: None,
        };
        (page, vec![vec![Some("x".repeat(value_len)); columns]; rows])
    }

    #[test]
    fn cuts_pages_to_fit_a_reply() {
        let (small, rows) = page(3, 10, 20);
        let whole: Value = serde_json::from_str(&fit_rows(small, rows, &[0; 10]).unwrap()).unwrap();
        assert_eq!((whole["rows"].as_array().unwrap().len(), whole["hasMore"].as_bool()), (10, Some(false)));
        assert!(whole.get("rowsCut").is_none() && whole.get("note").is_none());

        // 200 rows of 40 columns × 100 characters: about 830 kB, so a few dozen rows fit.
        let (wide, rows) = page(40, 200, 100);
        let reply = fit_rows(wide, rows, &[1; 200]).unwrap();
        assert!(reply.len() <= MAX_REPLY_LEN);
        let cut: Value = serde_json::from_str(&reply).unwrap();
        let kept = cut["rows"].as_array().unwrap().len();
        assert!((10..20).contains(&kept), "{kept}");
        assert_eq!(cut["rowsCut"], 200 - kept);
        assert_eq!(cut["hasMore"], true);
        assert_eq!((cut["shortenedValues"].as_u64(), cut["maskedValues"].as_u64()), (Some(kept as u64), Some(kept as u64)), "counts of the kept rows");
        assert!(cut["note"].as_str().unwrap().contains(&format!("offset {}", 40 + kept)), "{}", cut["note"]);
        // One more row would not have fitted.
        let (wide, rows) = page(40, kept + 1, 100);
        assert!(fit_rows(wide, rows, &[1; 201][..kept + 1]).unwrap().contains("rowsCut"));

        let (huge, rows) = page(200, 3, 500);
        assert!(fit_rows(huge, rows, &[0; 3]).unwrap_err().contains("Pass `columns`"));
    }

    #[test]
    fn filter_input_has_a_schema() {
        let schema = schemars::schema_for!(BrowseArgs);
        let text = serde_json::to_string(&schema).unwrap();
        assert!(text.contains("\"cond\"") && text.contains("notIn") && text.contains("\"rel\""), "{text}");
    }
}
