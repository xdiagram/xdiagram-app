//! The SQL skeleton of a path: `SELECT … FROM … JOIN … ON …`, in a dialect's quoting. Text only:
//! nothing here runs it.

use serde::{Deserialize, Serialize};

use crate::graph::{EdgeKind, TableNode};
use crate::search::JoinPath;

/// The schema DBML leaves unnamed, and the queries leave out.
pub const DEFAULT_SCHEMA: &str = "public";

/// How identifiers are quoted (the same rules as the app's query builder).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Postgres,
    Mysql,
    Mssql,
    Sqlite,
}

impl Dialect {
    /// `"name"` (PostgreSQL, SQLite), `` `name` `` (MySQL) or `[name]` (SQL Server), with the
    /// closing quote doubled inside.
    pub fn quote(self, ident: &str) -> String {
        match self {
            Dialect::Mysql => format!("`{}`", ident.replace('`', "``")),
            Dialect::Mssql => format!("[{}]", ident.replace(']', "]]")),
            Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", ident.replace('"', "\"\"")),
        }
    }

    /// The table as a query names it: without the default schema, and never with one on SQLite.
    pub fn table(self, t: &TableNode) -> String {
        if self == Dialect::Sqlite || t.schema.is_empty() || t.schema == DEFAULT_SCHEMA {
            self.quote(&t.name)
        } else {
            format!("{}.{}", self.quote(&t.schema), self.quote(&t.name))
        }
    }
}

/// Words an alias must not be on its own (it gets a `_`).
const SHORT_WORDS: [&str; 24] = [
    "as", "at", "by", "do", "go", "if", "in", "is", "no", "of", "on", "or", "to", "all", "and", "any", "asc", "end", "for", "key", "not", "set", "top", "use",
];

/// Short aliases, one per position: `project_members` → `pm`, `isActive` → `ia`, clashes get a
/// number (`o`, `o2`). The same rules as the query builder's `makeAliases`.
pub fn aliases(table_ids: &[&str]) -> Vec<String> {
    let mut used: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(table_ids.len());
    for id in table_ids {
        let name = id.split_once('.').map_or(*id, |(_, n)| n);
        let mut initials = String::new();
        let mut prev: Option<char> = None;
        for c in name.chars() {
            let separator = c == '_' || c.is_whitespace();
            let camel = prev.is_some_and(|p| p.is_ascii_lowercase()) && c.is_ascii_uppercase();
            let starts_word = !separator && (prev.is_none_or(|p| p == '_' || p.is_whitespace()) || camel);
            if starts_word {
                initials.extend(c.to_lowercase());
            }
            prev = Some(c);
        }
        let mut base: String = initials.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_').collect();
        if base.is_empty() {
            base = "t".into();
        }
        if !base.starts_with(|c: char| c.is_ascii_lowercase() || c == '_') {
            base = format!("t{base}");
        }
        if SHORT_WORDS.contains(&base.as_str()) {
            base.push('_');
        }
        let mut alias = base.clone();
        let mut n = 2;
        while used.contains(&alias) {
            alias = format!("{base}{n}");
            n += 1;
        }
        used.push(alias.clone());
        out.push(alias);
    }
    out
}

/// The SELECT skeleton of a path: the two end tables' columns, then one JOIN per step on the
/// chosen variant (`variant[i]` for step i; missing or out of range = the first). Joins seen only
/// in the query traffic are marked with a comment.
pub fn path_sql(path: &JoinPath, tables: &[TableNode], dialect: Dialect, variant: &[usize]) -> String {
    let ids: Vec<&str> = path.tables.iter().map(String::as_str).collect();
    let alias = aliases(&ids);
    let q = |s: &str| dialect.quote(s);
    let table = |id: &str| match tables.iter().find(|t| t.id == id) {
        Some(t) => dialect.table(t),
        None => {
            let (schema, name) = id.split_once('.').unwrap_or((DEFAULT_SCHEMA, id));
            dialect.table(&TableNode { id: id.to_string(), schema: schema.to_string(), name: name.to_string() })
        }
    };
    let last = alias.len() - 1;
    let mut sql = format!("SELECT {}.*, {}.*\nFROM {} AS {}", q(&alias[0]), q(&alias[last]), table(ids[0]), q(&alias[0]));
    for (i, step) in path.steps.iter().enumerate() {
        let Some(v) = step.variants.get(variant.get(i).copied().unwrap_or(0)).or(step.variants.first()) else { continue };
        let (left, right) = (&alias[i], &alias[i + 1]);
        let on: Vec<String> = v.on.iter().map(|p| format!("{}.{} = {}.{}", q(right), q(&p.to), q(left), q(&p.from))).collect();
        if v.kind == EdgeKind::Discovered {
            sql.push_str("\n-- seen in queries, not a declared foreign key");
        }
        sql.push_str(&format!("\nJOIN {} AS {} ON {}", table(&step.right), q(right), on.join(" AND ")));
    }
    sql
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::{fk, fk_on, graph, table};
    use crate::search::{PathOpts, PathOutcome, find_join_paths};

    fn path(g: &crate::graph::SchemaGraph, from: &str, to: &str) -> JoinPath {
        match find_join_paths(g, from, to, &PathOpts::default()) {
            PathOutcome::Found { mut paths } => paths.remove(0),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn aliases_follow_the_query_builder() {
        let ids = ["public.project_members", "public.projects", "public.organizations", "public.orders", "billing.invoice_lines", "public.isActive"];
        assert_eq!(aliases(&ids), ["pm", "p", "o", "o2", "il", "ia"]);
        assert_eq!(aliases(&["public.audit_sessions"]), ["as_"]);
        assert_eq!(aliases(&["public.2fa_codes", "public.Ärger", "public.emp", "public.emp"]), ["t2c", "t", "e", "e2"]);
    }

    #[test]
    fn writes_a_join_per_step_in_postgres_quoting() {
        let g = graph(
            &["public.orders", "public.order_items", "catalog.products"],
            vec![
                fk_on("oi_o", "public.order_items", &[("order_id", "id")], "public.orders"),
                fk_on("oi_p", "public.order_items", &[("product_id", "id")], "catalog.products"),
            ],
        );
        let p = path(&g, "public.orders", "catalog.products");
        assert_eq!(
            path_sql(&p, &g.tables, Dialect::Postgres, &[]),
            "SELECT \"o\".*, \"p\".*\nFROM \"orders\" AS \"o\"\n\
             JOIN \"order_items\" AS \"oi\" ON \"oi\".\"order_id\" = \"o\".\"id\"\n\
             JOIN \"catalog\".\"products\" AS \"p\" ON \"p\".\"id\" = \"oi\".\"product_id\""
        );
    }

    #[test]
    fn quotes_and_escapes_in_each_dialect() {
        let t = TableNode { id: "sales.we\"ird]`".into(), schema: "sales".into(), name: "we\"ird]`".into() };
        assert_eq!(Dialect::Postgres.table(&t), "\"sales\".\"we\"\"ird]`\"");
        assert_eq!(Dialect::Mysql.table(&t), "`sales`.`we\"ird]```");
        assert_eq!(Dialect::Mssql.table(&t), "[sales].[we\"ird]]`]");
        assert_eq!(Dialect::Sqlite.table(&t), "\"we\"\"ird]`\"");
        assert_eq!(Dialect::Mssql.table(&table("public.users")), "[users]");
    }

    #[test]
    fn composite_keys_and_chosen_variants() {
        let g = graph(
            &["members", "roles"],
            vec![
                fk_on("m_r", "members", &[("org_id", "org_id"), ("role", "name")], "roles"),
                fk_on("m_r2", "members", &[("granted_role", "name")], "roles"),
            ],
        );
        let p = path(&g, "members", "roles");
        assert_eq!(p.steps[0].variants.len(), 2);
        let first = path_sql(&p, &g.tables, Dialect::Mysql, &[]);
        assert!(first.ends_with("JOIN `roles` AS `r` ON `r`.`org_id` = `m`.`org_id` AND `r`.`name` = `m`.`role`"), "{first}");
        let second = path_sql(&p, &g.tables, Dialect::Mysql, &[1]);
        assert!(second.ends_with("JOIN `roles` AS `r` ON `r`.`name` = `m`.`granted_role`"), "{second}");
        // Out of range: the first variant.
        assert_eq!(path_sql(&p, &g.tables, Dialect::Mysql, &[9]), first);
    }

    #[test]
    fn marks_joins_seen_only_in_queries_and_self_joins() {
        let mut seen = fk("e_d", "emp", "dept");
        seen.kind = EdgeKind::Discovered;
        let g = graph(&["emp", "dept"], vec![seen, fk_on("boss", "emp", &[("manager_id", "id")], "emp")]);
        let sql = path_sql(&path(&g, "dept", "emp"), &g.tables, Dialect::Sqlite, &[]);
        assert!(sql.contains("\n-- seen in queries, not a declared foreign key\nJOIN \"emp\" AS \"e\""), "{sql}");
        let own = path_sql(&path(&g, "emp", "emp"), &g.tables, Dialect::Mssql, &[]);
        assert_eq!(own, "SELECT [e].*, [e2].*\nFROM [emp] AS [e]\nJOIN [emp] AS [e2] ON [e2].[id] = [e].[manager_id]");
    }
}
