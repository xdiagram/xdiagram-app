//! Pure analysis for X-ray mode: join predicates extracted from SQL text, orientation of a
//! discovered relationship, and de facto cardinality from planner statistics.
//! Nothing here touches the database, so it is unit-tested directly.

use sqlparser::ast::{
    BinaryOperator, Expr, FromTable, FunctionArg, FunctionArgExpr, FunctionArguments, Ident, InTarget, Join,
    JoinConstraint, JoinOperator, ObjectName, ObjectNamePart, Query, Select, SetExpr, Statement, TableFactor,
    TableWithJoins, UpdateTableFromKind,
};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

/// A column as written in a query, with the table alias already resolved to the table name.
/// `schema` is only set when the query qualified the table.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ColumnRef {
    pub schema: Option<String>,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinPredicate {
    pub left: ColumnRef,
    pub right: ColumnRef,
}

/// How a column is filtered against a constant (a literal, `$n`, `now()`, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum FilterOp {
    Eq,
    In,
    Range,
    IsNull,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterUse {
    pub column: ColumnRef,
    pub op: FilterOp,
}

/// What one statement does with columns: joins between tables and filters on constants.
#[derive(Debug, Default)]
pub struct SqlUsage {
    pub joins: Vec<JoinPredicate>,
    pub filters: Vec<FilterUse>,
}

/// Answers "does table (schema?, name) have this column?". Used to resolve unqualified column
/// names and `USING (...)` joins.
pub type HasColumn<'a> = &'a dyn Fn(Option<&str>, &str, &str) -> bool;

/// Equality predicates between columns of two different table references, taken from JOIN ... ON,
/// JOIN ... USING and WHERE clauses (including CTEs, subqueries, UPDATE ... FROM and
/// DELETE ... USING). OR branches are not descended. Returns `Err` when the text does not parse.
pub fn extract_join_predicates(sql: &str, has_column: HasColumn) -> Result<Vec<JoinPredicate>, String> {
    analyze_sql(sql, has_column).map(|u| u.joins)
}

/// Join predicates plus filter columns (`col = $1`, `col > now()`, `col IN (…)`, `col IS NULL`, …).
pub fn analyze_sql(sql: &str, has_column: HasColumn) -> Result<SqlUsage, String> {
    let statements = Parser::new(&PostgreSqlDialect {})
        .with_recursion_limit(200)
        .try_with_sql(sql)
        .map_err(|e| e.to_string())?
        .parse_statements()
        .map_err(|e| e.to_string())?;
    let mut walker = Walker { scopes: Vec::new(), out: Vec::new(), filters: Vec::new(), has_column };
    for statement in &statements {
        walker.statement(statement);
    }
    Ok(SqlUsage { joins: walker.out, filters: walker.filters })
}

/// No column reference inside: literals, placeholders, intervals, casts and calls of those.
fn is_constant(e: &Expr) -> bool {
    match e {
        Expr::Value(_) | Expr::TypedString(_) | Expr::Interval(_) => true,
        Expr::Cast { expr, .. } | Expr::Nested(expr) | Expr::UnaryOp { expr, .. } => is_constant(expr),
        // Functions with their own syntax get dedicated nodes rather than `Function`.
        Expr::Floor { expr, .. } | Expr::Ceil { expr, .. } | Expr::Extract { expr, .. } => is_constant(expr),
        Expr::BinaryOp { left, right, .. } => is_constant(left) && is_constant(right),
        Expr::Function(f) => match &f.args {
            FunctionArguments::None => true,
            FunctionArguments::List(list) => list.args.iter().all(|a| match a {
                FunctionArg::Unnamed(FunctionArgExpr::Expr(e)) => is_constant(e),
                _ => false,
            }),
            FunctionArguments::Subquery(_) => false,
        },
        _ => false,
    }
}

#[derive(Clone)]
struct Binding {
    alias: String,
    /// `None` for CTEs, derived tables and table functions: columns of those never form a relationship.
    table: Option<(Option<String>, String)>,
}

struct Walker<'a> {
    scopes: Vec<Vec<Binding>>,
    out: Vec<JoinPredicate>,
    filters: Vec<FilterUse>,
    has_column: HasColumn<'a>,
}

impl Walker<'_> {
    fn statement(&mut self, s: &Statement) {
        match s {
            Statement::Query(q) => self.query(q),
            Statement::Insert(i) => {
                if let Some(source) = &i.source {
                    self.query(source);
                }
            }
            Statement::Update(u) => {
                self.scopes.push(Vec::new());
                self.register_twj(&u.table);
                let from: &[TableWithJoins] = match &u.from {
                    Some(UpdateTableFromKind::BeforeSet(v)) | Some(UpdateTableFromKind::AfterSet(v)) => v,
                    None => &[],
                };
                for t in from {
                    self.register_twj(t);
                }
                self.constraints_twj(&u.table);
                for t in from {
                    self.constraints_twj(t);
                }
                if let Some(sel) = &u.selection {
                    self.expr(sel);
                }
                self.scopes.pop();
            }
            Statement::Delete(d) => {
                self.scopes.push(Vec::new());
                let from: &[TableWithJoins] = match &d.from {
                    FromTable::WithFromKeyword(v) | FromTable::WithoutKeyword(v) => v,
                };
                let using: &[TableWithJoins] = d.using.as_deref().unwrap_or(&[]);
                for t in from.iter().chain(using) {
                    self.register_twj(t);
                }
                for t in from.iter().chain(using) {
                    self.constraints_twj(t);
                }
                if let Some(sel) = &d.selection {
                    self.expr(sel);
                }
                self.scopes.pop();
            }
            Statement::Explain { statement, .. } => self.statement(statement),
            _ => {}
        }
    }

    fn query(&mut self, q: &Query) {
        self.scopes.push(Vec::new());
        if let Some(with) = &q.with {
            for cte in &with.cte_tables {
                self.query(&cte.query);
                self.bind(ident(&cte.alias.name), None);
            }
        }
        self.set_expr(&q.body);
        self.scopes.pop();
    }

    fn set_expr(&mut self, e: &SetExpr) {
        match e {
            SetExpr::Select(s) => self.select(s),
            SetExpr::Query(q) => self.query(q),
            SetExpr::SetOperation { left, right, .. } => {
                self.set_expr(left);
                self.set_expr(right);
            }
            SetExpr::Insert(s) | SetExpr::Update(s) | SetExpr::Delete(s) => self.statement(s),
            _ => {}
        }
    }

    fn select(&mut self, s: &Select) {
        self.scopes.push(Vec::new());
        for t in &s.from {
            self.register_twj(t);
        }
        for t in &s.from {
            self.constraints_twj(t);
        }
        if let Some(sel) = &s.selection {
            self.expr(sel);
        }
        if let Some(having) = &s.having {
            self.expr(having);
        }
        self.scopes.pop();
    }

    // ---- scope management -------------------------------------------------------------------

    fn bind(&mut self, alias: String, table: Option<(Option<String>, String)>) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.push(Binding { alias, table });
        }
    }

    fn lookup(&self, alias: &str) -> Option<Binding> {
        self.scopes.iter().rev().flat_map(|s| s.iter().rev()).find(|b| b.alias == alias).cloned()
    }

    fn register_twj(&mut self, t: &TableWithJoins) {
        self.register_factor(&t.relation);
        for j in &t.joins {
            self.register_factor(&j.relation);
        }
    }

    fn register_factor(&mut self, f: &TableFactor) {
        match f {
            TableFactor::Table { name, alias, args, .. } => {
                let parts = object_name(name);
                let Some(table) = parts.last().cloned() else { return };
                let alias_name = alias.as_ref().map(|a| ident(&a.name)).unwrap_or_else(|| table.clone());
                let schema = (parts.len() >= 2).then(|| parts[parts.len() - 2].clone());
                // Table functions, and unqualified names that refer to a CTE/derived table in scope.
                let shadowed = schema.is_none() && self.lookup(&table).is_some_and(|b| b.table.is_none());
                if args.is_some() || shadowed {
                    self.bind(alias_name, None);
                } else {
                    self.bind(alias_name, Some((schema, table)));
                }
            }
            TableFactor::Derived { subquery, alias, .. } => {
                self.query(subquery);
                if let Some(a) = alias {
                    self.bind(ident(&a.name), None);
                }
            }
            TableFactor::NestedJoin { table_with_joins, .. } => self.register_twj(table_with_joins),
            _ => {}
        }
    }

    // ---- predicates -------------------------------------------------------------------------

    fn constraints_twj(&mut self, t: &TableWithJoins) {
        self.constraints_factor(&t.relation);
        for j in &t.joins {
            self.constraints_factor(&j.relation);
            self.join_constraint(j);
        }
    }

    fn constraints_factor(&mut self, f: &TableFactor) {
        if let TableFactor::NestedJoin { table_with_joins, .. } = f {
            self.constraints_twj(table_with_joins);
        }
    }

    fn join_constraint(&mut self, j: &Join) {
        use JoinOperator::*;
        let constraint = match &j.join_operator {
            Join(c) | Inner(c) | Left(c) | LeftOuter(c) | Right(c) | RightOuter(c) | FullOuter(c) | CrossJoin(c)
            | Semi(c) | LeftSemi(c) | RightSemi(c) | Anti(c) | LeftAnti(c) | RightAnti(c) | StraightJoin(c) => c,
            AsOf { constraint, .. } => constraint,
            _ => return,
        };
        match constraint {
            JoinConstraint::On(e) => self.expr(e),
            JoinConstraint::Using(cols) | JoinConstraint::UsingAlias(cols, _) => self.using(&j.relation, cols),
            _ => {}
        }
    }

    /// `USING (c)`: pairs the joined relation with the single other table in scope that has `c`.
    fn using(&mut self, relation: &TableFactor, cols: &[ObjectName]) {
        let Some(right_alias) = factor_alias(relation) else { return };
        let Some(Binding { table: Some(right), .. }) = self.lookup(&right_alias) else { return };
        let frame = self.scopes.last().cloned().unwrap_or_default();
        for col in cols {
            let Some(col) = object_name(col).last().cloned() else { continue };
            let lefts: Vec<&Binding> = frame
                .iter()
                .filter(|b| b.alias != right_alias)
                .filter(|b| b.table.as_ref().is_some_and(|(s, t)| (self.has_column)(s.as_deref(), t, &col)))
                .collect();
            if let [left] = lefts[..] {
                let (ls, lt) = left.table.clone().unwrap_or_default();
                self.push(
                    ColumnRef { schema: ls, table: lt, column: col.clone() },
                    ColumnRef { schema: right.0.clone(), table: right.1.clone(), column: col },
                );
            }
        }
    }

    fn expr(&mut self, e: &Expr) {
        match e {
            Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
                self.expr(left);
                self.expr(right);
            }
            Expr::BinaryOp { op: BinaryOperator::Or, .. } => {}
            Expr::BinaryOp { left, op, right }
                if matches!(
                    op,
                    BinaryOperator::Eq | BinaryOperator::Gt | BinaryOperator::Lt | BinaryOperator::GtEq | BinaryOperator::LtEq
                ) =>
            {
                let kind = if *op == BinaryOperator::Eq { FilterOp::Eq } else { FilterOp::Range };
                match (self.column(left), self.column(right)) {
                    (Some(l), Some(r)) if kind == FilterOp::Eq => self.push(l, r),
                    (Some(c), None) if is_constant(right) => self.filter(c, kind),
                    (None, Some(c)) if is_constant(left) => self.filter(c, kind),
                    _ => {
                        self.subqueries(left);
                        self.subqueries(right);
                    }
                }
            }
            Expr::BinaryOp { left, right, .. } => {
                self.subqueries(left);
                self.subqueries(right);
            }
            Expr::Nested(inner) | Expr::UnaryOp { expr: inner, .. } => self.expr(inner),
            Expr::Exists { subquery, .. } | Expr::Subquery(subquery) => self.query(subquery),
            Expr::In { expr, target, negated: false, .. } => {
                if let (Some(c), false) = (self.column(expr), matches!(target, InTarget::Table { .. })) {
                    self.filter(c, FilterOp::In);
                }
                if let InTarget::Subquery(subquery) = target {
                    self.query(subquery);
                }
            }
            Expr::In { target: InTarget::Subquery(subquery), .. } => self.query(subquery),
            Expr::Between { expr, low, high, negated: false } if is_constant(low) && is_constant(high) => {
                if let Some(c) = self.column(expr) {
                    self.filter(c, FilterOp::Range);
                }
            }
            Expr::IsNull(inner) => {
                if let Some(c) = self.column(inner) {
                    self.filter(c, FilterOp::IsNull);
                }
            }
            Expr::AnyOp { left, compare_op, right, .. } => {
                if let (BinaryOperator::Eq, Some(c)) = (compare_op, self.column(left)) {
                    self.filter(c, FilterOp::In);
                }
                self.subqueries(right);
            }
            Expr::AllOp { right, .. } => self.subqueries(right),
            _ => {}
        }
    }

    fn filter(&mut self, column: ColumnRef, op: FilterOp) {
        let f = FilterUse { column, op };
        if !self.filters.contains(&f) {
            self.filters.push(f);
        }
    }

    /// Only descends into subqueries (used where a predicate must not be collected).
    fn subqueries(&mut self, e: &Expr) {
        match e {
            Expr::Exists { subquery, .. } | Expr::Subquery(subquery) => self.query(subquery),
            Expr::In { target: InTarget::Subquery(subquery), .. } => self.query(subquery),
            Expr::Nested(inner) | Expr::Cast { expr: inner, .. } => self.subqueries(inner),
            _ => {}
        }
    }

    /// Resolves an expression to a table column, looking through parentheses and casts.
    fn column(&self, e: &Expr) -> Option<ColumnRef> {
        match e {
            Expr::Nested(inner) | Expr::Cast { expr: inner, .. } => self.column(inner),
            Expr::CompoundIdentifier(parts) if parts.len() >= 2 => {
                let column = ident(&parts[parts.len() - 1]);
                let qualifier = ident(&parts[parts.len() - 2]);
                let binding = self.lookup(&qualifier)?;
                let (mut schema, table) = binding.table?;
                if parts.len() >= 3 && schema.is_none() {
                    schema = Some(ident(&parts[parts.len() - 3]));
                }
                Some(ColumnRef { schema, table, column })
            }
            Expr::Identifier(name) => {
                let column = ident(name);
                // Innermost scope that has candidates wins; exactly one candidate is required.
                for scope in self.scopes.iter().rev() {
                    let candidates: Vec<&Binding> = scope
                        .iter()
                        .filter(|b| b.table.as_ref().is_some_and(|(s, t)| (self.has_column)(s.as_deref(), t, &column)))
                        .collect();
                    match candidates[..] {
                        [] => continue,
                        [one] => {
                            let (schema, table) = one.table.clone()?;
                            return Some(ColumnRef { schema, table, column });
                        }
                        _ => return None,
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn push(&mut self, left: ColumnRef, right: ColumnRef) {
        // `a.id = b.id` on the same table is a de-duplication pattern, not a relationship;
        // `e.manager_id = m.id` on the same table is a self-reference and is kept.
        if left == right {
            return;
        }
        let p = JoinPredicate { left, right };
        if !self.out.contains(&p) {
            self.out.push(p);
        }
    }
}

fn factor_alias(f: &TableFactor) -> Option<String> {
    match f {
        TableFactor::Table { name, alias, .. } => {
            alias.as_ref().map(|a| ident(&a.name)).or_else(|| object_name(name).last().cloned())
        }
        TableFactor::Derived { alias, .. } => alias.as_ref().map(|a| ident(&a.name)),
        _ => None,
    }
}

/// Unquoted identifiers fold to lower case in PostgreSQL; quoted ones keep their spelling.
fn ident(i: &Ident) -> String {
    if i.quote_style.is_some() { i.value.clone() } else { i.value.to_lowercase() }
}

fn object_name(n: &ObjectName) -> Vec<String> {
    n.0.iter()
        .filter_map(|p| match p {
            ObjectNamePart::Identifier(i) => Some(ident(i)),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Oriented {
    /// The referencing (foreign-key) side.
    pub child: ColumnRef,
    /// The referenced side.
    pub parent: ColumnRef,
    /// False when no side could be identified as the referenced one; endpoints are then sorted.
    pub directed: bool,
}

/// Decides which side of a join predicate is the referenced one: a primary/unique key column,
/// else a column named `id`, else the side whose counterpart looks like a foreign key (`*_id`, `*_fk`).
pub fn orient(p: &JoinPredicate, is_key: &dyn Fn(&ColumnRef) -> bool) -> Oriented {
    let (l, r) = (&p.left, &p.right);
    let (lk, rk) = (is_key(l), is_key(r));
    let parent_is_right = if lk != rk {
        rk
    } else if (l.column == "id") != (r.column == "id") {
        r.column == "id"
    } else if looks_like_fk(&l.column) != looks_like_fk(&r.column) {
        looks_like_fk(&l.column)
    } else {
        let (a, b) = if l <= r { (l, r) } else { (r, l) };
        return Oriented { child: a.clone(), parent: b.clone(), directed: false };
    };
    if parent_is_right {
        Oriented { child: l.clone(), parent: r.clone(), directed: true }
    } else {
        Oriented { child: r.clone(), parent: l.clone(), directed: true }
    }
}

fn looks_like_fk(column: &str) -> bool {
    column.ends_with("_id") || column.ends_with("_fk") || column.ends_with("_ref")
}

// ---------------------------------------------------------------------------------------------
// De facto cardinality
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Cardinality {
    /// Average number of child rows per referenced parent (parents that have at least one).
    pub children_per_parent: f64,
    /// Share of parent rows that are referenced by at least one child (0..1).
    pub parent_coverage: f64,
    /// Share of child rows whose foreign-key column is NULL (0..1).
    pub child_null_frac: f64,
    /// "1:1" when each parent has at most about one child, else "1:N".
    pub verdict: &'static str,
}

/// From `pg_stats` (`n_distinct`, `null_frac` of the child column) and `pg_class.reltuples` of
/// both tables. `n_distinct < 0` is a fraction of the row count. `None` when there is no data.
pub fn de_facto_cardinality(child_rows: f64, parent_rows: f64, n_distinct: f64, null_frac: f64) -> Option<Cardinality> {
    if !(child_rows > 0.0) || !(parent_rows > 0.0) {
        return None;
    }
    let distinct = if n_distinct < 0.0 { -n_distinct * child_rows } else { n_distinct };
    if !(distinct > 0.0) {
        return None;
    }
    let null_frac = null_frac.clamp(0.0, 1.0);
    let non_null_children = child_rows * (1.0 - null_frac);
    let children_per_parent = non_null_children / distinct;
    let parent_coverage = (distinct / parent_rows).clamp(0.0, 1.0);
    Some(Cardinality {
        children_per_parent,
        parent_coverage,
        child_null_frac: null_frac,
        verdict: if children_per_parent <= 1.05 { "1:1" } else { "1:N" },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn universe() -> Vec<(&'static str, &'static str, &'static [&'static str])> {
        vec![
            ("public", "events", &["id", "user_id", "org_id", "kind", "at"]),
            ("public", "users", &["id", "email"]),
            ("public", "organizations", &["id", "slug", "name"]),
            ("public", "memberships", &["org_id", "user_id"]),
            ("public", "profiles", &["user_id", "bio"]),
            ("public", "employees", &["id", "manager_id"]),
            ("billing", "invoices", &["id", "org_id"]),
            ("billing", "invoice_lines", &["invoice_id", "line_no"]),
        ]
    }

    fn has_column(schema: Option<&str>, table: &str, column: &str) -> bool {
        universe().iter().any(|(s, t, cols)| {
            *t == table && schema.is_none_or(|x| x == *s) && cols.contains(&column)
        })
    }

    fn col(schema: Option<&str>, table: &str, column: &str) -> ColumnRef {
        ColumnRef { schema: schema.map(str::to_string), table: table.into(), column: column.into() }
    }

    fn pairs(sql: &str) -> Vec<(ColumnRef, ColumnRef)> {
        extract_join_predicates(sql, &has_column).unwrap().into_iter().map(|p| (p.left, p.right)).collect()
    }

    #[test]
    fn join_on_with_aliases_and_placeholders() {
        let got = pairs("SELECT e.id, u.email FROM public.events e JOIN public.users u ON u.id = e.user_id WHERE e.kind = $1 LIMIT $2");
        assert_eq!(got, vec![(col(Some("public"), "users", "id"), col(Some("public"), "events", "user_id"))]);
    }

    #[test]
    fn implicit_where_join() {
        let got = pairs("SELECT count(*) FROM public.events e, public.organizations o WHERE o.id = e.org_id AND o.slug = $1");
        assert_eq!(got, vec![(col(Some("public"), "organizations", "id"), col(Some("public"), "events", "org_id"))]);
    }

    #[test]
    fn using_join() {
        let got = pairs("SELECT * FROM public.memberships m JOIN public.profiles p USING (user_id)");
        assert_eq!(got, vec![(col(Some("public"), "memberships", "user_id"), col(Some("public"), "profiles", "user_id"))]);
    }

    #[test]
    fn cte_exists_and_in_subquery() {
        let got = pairs(
            "WITH active AS (SELECT user_id FROM public.events WHERE at > now() - interval $1) \
             SELECT u.id FROM public.users u \
             WHERE EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id AND m.org_id = $2) \
               AND u.id IN (SELECT user_id FROM active) LIMIT $3",
        );
        assert_eq!(got, vec![(col(Some("public"), "memberships", "user_id"), col(Some("public"), "users", "id"))]);
    }

    #[test]
    fn update_from_and_delete_using() {
        let got = pairs("UPDATE public.events e SET kind = e.kind FROM public.users u WHERE u.id = e.user_id AND u.id = $1");
        assert_eq!(got, vec![(col(Some("public"), "users", "id"), col(Some("public"), "events", "user_id"))]);
        let got = pairs("DELETE FROM public.events e USING public.users u WHERE u.id = e.user_id AND u.email = $1");
        assert_eq!(got, vec![(col(Some("public"), "users", "id"), col(Some("public"), "events", "user_id"))]);
    }

    #[test]
    fn casts_and_unqualified_tables() {
        let got = pairs("SELECT 1 FROM events e JOIN users u ON (u.id)::bigint = e.user_id::bigint WHERE e.at > $1::timestamptz");
        assert_eq!(got, vec![(col(None, "users", "id"), col(None, "events", "user_id"))]);
    }

    #[test]
    fn or_branches_are_not_descended() {
        assert!(pairs("SELECT 1 FROM events e, users u WHERE (u.id = e.user_id OR u.id = e.org_id)").is_empty());
    }

    #[test]
    fn self_joins() {
        assert!(pairs("SELECT 1 FROM users a JOIN users b ON a.id = b.id").is_empty());
        let got = pairs("SELECT 1 FROM employees e JOIN employees m ON m.id = e.manager_id");
        assert_eq!(got, vec![(col(None, "employees", "id"), col(None, "employees", "manager_id"))]);
    }

    #[test]
    fn unqualified_columns() {
        // `id` exists in both tables: ambiguous, skipped.
        assert!(pairs("SELECT 1 FROM events e JOIN users u ON id = user_id").is_empty());
        let got = pairs("SELECT 1 FROM billing.invoice_lines l JOIN billing.invoices i ON invoice_id = i.id");
        assert_eq!(got, vec![(col(Some("billing"), "invoice_lines", "invoice_id"), col(Some("billing"), "invoices", "id"))]);
    }

    #[test]
    fn no_joins_and_unparseable() {
        assert!(pairs("INSERT INTO public.events (user_id, org_id, kind) SELECT $1 + (g % $2), $3 + (g % $4), $5 FROM generate_series($6, $7) g").is_empty());
        assert!(pairs("SELECT count(*) FROM public.events WHERE kind = $1").is_empty());
        assert!(extract_join_predicates("SELEC FROM", &has_column).is_err());
        assert!(extract_join_predicates("<insufficient privilege>", &has_column).is_err());
    }

    fn filters(sql: &str) -> Vec<(String, FilterOp)> {
        analyze_sql(sql, &has_column)
            .unwrap()
            .filters
            .into_iter()
            .map(|f| (format!("{}.{}", f.column.table, f.column.column), f.op))
            .collect()
    }

    #[test]
    fn filter_columns() {
        assert_eq!(
            filters("SELECT * FROM events WHERE kind = $1 AND at > now() - interval $2"),
            vec![("events.kind".to_string(), FilterOp::Eq), ("events.at".to_string(), FilterOp::Range)]
        );
        assert_eq!(filters("SELECT 1 FROM users u WHERE $1 = u.email"), vec![("users.email".to_string(), FilterOp::Eq)]);
        assert_eq!(
            filters("SELECT 1 FROM events WHERE user_id = ANY($1) AND org_id IS NULL"),
            vec![("events.user_id".to_string(), FilterOp::In), ("events.org_id".to_string(), FilterOp::IsNull)]
        );
        assert_eq!(filters("SELECT 1 FROM events WHERE id BETWEEN $1 AND $2"), vec![("events.id".to_string(), FilterOp::Range)]);
        // `floor(...)` is a dedicated `Expr::Floor` node, not a function call.
        assert_eq!(
            filters("SELECT id, kind FROM public.events WHERE kind = $1 || ($2 + floor(random() * $3))::int"),
            vec![("events.kind".to_string(), FilterOp::Eq)]
        );
        assert_eq!(
            filters("DELETE FROM public.events WHERE id IN (SELECT id FROM public.events ORDER BY id LIMIT $1)"),
            vec![("events.id".to_string(), FilterOp::In)]
        );
        // A join predicate is not a filter; OR branches are skipped; column-to-expression is not constant.
        assert!(filters("SELECT 1 FROM events e JOIN users u ON u.id = e.user_id").is_empty());
        assert!(filters("SELECT 1 FROM events WHERE kind = $1 OR kind = $2").is_empty());
        assert!(filters("SELECT 1 FROM events WHERE user_id = org_id + 1").is_empty());
    }

    #[test]
    fn orientation() {
        let is_key = |c: &ColumnRef| c.column == "id";
        let p = JoinPredicate { left: col(None, "events", "user_id"), right: col(None, "users", "id") };
        let o = orient(&p, &is_key);
        assert!(o.directed);
        assert_eq!((o.child.table.as_str(), o.parent.table.as_str()), ("events", "users"));

        // No key on either side: the `*_id` column is the child.
        let p = JoinPredicate { left: col(None, "b", "code"), right: col(None, "a", "ref_id") };
        let o = orient(&p, &|_| false);
        assert!(o.directed);
        assert_eq!(o.child.table, "a");

        // Two keys or no hints at all: undirected, endpoints sorted.
        let p = JoinPredicate { left: col(None, "z", "code"), right: col(None, "a", "code") };
        let o = orient(&p, &|_| false);
        assert!(!o.directed);
        assert_eq!((o.child.table.as_str(), o.parent.table.as_str()), ("a", "z"));
    }

    #[test]
    fn cardinality() {
        // 2000 memberships, user_id all distinct (n_distinct = -1), 2000 users → 1:1, full coverage.
        let c = de_facto_cardinality(2000.0, 2000.0, -1.0, 0.0).unwrap();
        assert_eq!(c.verdict, "1:1");
        assert!((c.children_per_parent - 1.0).abs() < 1e-9);
        assert!((c.parent_coverage - 1.0).abs() < 1e-9);

        // 200 projects over 20 of 50 organizations → 10 per org, 40% coverage.
        let c = de_facto_cardinality(200.0, 50.0, 20.0, 0.0).unwrap();
        assert_eq!(c.verdict, "1:N");
        assert!((c.children_per_parent - 10.0).abs() < 1e-9);
        assert!((c.parent_coverage - 0.4).abs() < 1e-9);

        // Half the children have no parent.
        let c = de_facto_cardinality(100.0, 10.0, 10.0, 0.5).unwrap();
        assert!((c.children_per_parent - 5.0).abs() < 1e-9);
        assert!((c.child_null_frac - 0.5).abs() < 1e-9);

        assert!(de_facto_cardinality(0.0, 10.0, 5.0, 0.0).is_none());
        assert!(de_facto_cardinality(10.0, 10.0, 0.0, 0.0).is_none());
    }
}
