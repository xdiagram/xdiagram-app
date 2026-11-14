//! SQL text per engine for the read-only features that build their own SELECTs (browsing,
//! filters, profiling, the join query builder): identifier quoting, parameters, column kinds,
//! typed comparisons, casting to text and paging. Identifiers passed here must already be
//! checked against the catalog; values always go in parameters.

use serde::Serialize;

use super::connect::Engine;

/// What a column holds, for choosing filter operators and comparing values (see `classify`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColKind {
    Int,
    Decimal,
    Float,
    Bool,
    Text,
    Enum,
    Uuid,
    Date,
    Time,
    Timestamp,
    Timestamptz,
    Json,
    Binary,
    #[default]
    Other,
}

/// How a text pattern is anchored (`LIKE` with `%` on one or both sides).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    Contains,
    StartsWith,
    EndsWith,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
    Mssql,
    Sqlite,
}

impl From<Engine> for Dialect {
    fn from(e: Engine) -> Self {
        match e {
            Engine::Postgres => Dialect::Postgres,
            Engine::Mysql => Dialect::Mysql,
            Engine::Mssql => Dialect::Mssql,
            Engine::Sqlite => Dialect::Sqlite,
        }
    }
}

impl Dialect {
    pub fn quote(self, ident: &str) -> String {
        match self {
            Dialect::Mysql => format!("`{}`", ident.replace('`', "``")),
            Dialect::Mssql => format!("[{}]", ident.replace(']', "]]")),
            Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", ident.replace('"', "\"\"")),
        }
    }

    /// `schema.table` (SQLite has no schemas). `schema` is the resolved one (database for MySQL).
    pub fn qualified(self, schema: &str, table: &str) -> String {
        match self {
            Dialect::Sqlite => self.quote(table),
            _ => format!("{}.{}", self.quote(schema), self.quote(table)),
        }
    }

    /// Placeholder for the `n`-th (1-based) bound parameter.
    pub fn param(self, n: usize) -> String {
        match self {
            Dialect::Postgres => format!("${n}"),
            Dialect::Mysql => "?".into(),
            Dialect::Mssql => format!("@P{n}"),
            Dialect::Sqlite => format!("?{n}"),
        }
    }

    /// A select-list item returning `expr` as text. MySQL and SQLite values are converted when
    /// read, so they are selected as they are (MySQL binaries as `0x…` hex, bits as numbers).
    pub fn select_text(self, expr: &str, type_name: &str) -> String {
        match self {
            Dialect::Postgres => format!("({expr})::text"),
            Dialect::Mssql => match type_name.to_ascii_lowercase().as_str() {
                "binary" | "varbinary" | "image" | "timestamp" | "rowversion" => format!("CONVERT(NVARCHAR(MAX), {expr}, 1)"),
                "datetime" | "datetime2" | "smalldatetime" | "datetimeoffset" | "date" | "time" => format!("CONVERT(NVARCHAR(MAX), {expr}, 126)"),
                "geography" | "geometry" | "hierarchyid" => format!("{expr}.ToString()"),
                // Style 3: all 17 significant digits (the default keeps 6, so a value shown in the
                // grid would not match the column). Money: 4 decimals instead of 2.
                "float" | "real" => format!("CONVERT(NVARCHAR(MAX), {expr}, 3)"),
                "money" | "smallmoney" => format!("CONVERT(NVARCHAR(MAX), {expr}, 2)"),
                _ => format!("CONVERT(NVARCHAR(MAX), {expr})"),
            },
            Dialect::Mysql => match mysql_kind(type_name) {
                ColKind::Binary => format!("CONCAT('0x', HEX({expr}))"),
                ColKind::Bool if type_name.trim().to_ascii_lowercase().starts_with("bit") => format!("CAST({expr} AS UNSIGNED)"),
                _ => expr.to_string(),
            },
            Dialect::Sqlite => expr.to_string(),
        }
    }

    /// `expr` as the text the grid shows for it: what text filters (contains, …) and the
    /// fallback comparison for types without a typed one compare against.
    pub fn text_expr(self, expr: &str, kind: ColKind, type_name: &str) -> String {
        match self {
            // Text columns as they are, so a trigram index can serve LIKE / ILIKE.
            Dialect::Postgres if kind == ColKind::Text => expr.to_string(),
            Dialect::Postgres => format!("({expr})::text"),
            Dialect::Mysql => match kind {
                ColKind::Text | ColKind::Enum => expr.to_string(),
                ColKind::Binary => self.select_text(expr, type_name),
                ColKind::Bool if type_name.trim().to_ascii_lowercase().starts_with("bit") => self.select_text(expr, type_name),
                _ => format!("CAST({expr} AS CHAR)"),
            },
            Dialect::Mssql => match kind {
                ColKind::Text if !matches!(type_name.to_ascii_lowercase().as_str(), "text" | "ntext") => expr.to_string(),
                _ => self.select_text(expr, type_name),
            },
            Dialect::Sqlite => match kind {
                // Shown as `\x…` (see `sqlite::cell_text`).
                ColKind::Binary => format!("('\\x' || lower(hex({expr})))"),
                ColKind::Text => expr.to_string(),
                _ => format!("CAST({expr} AS TEXT)"),
            },
        }
    }

    /// Parameter `n` converted to the column's type, so the comparison can use an index on the
    /// column (the column is never converted). `None`: the column has no usable typed
    /// comparison, compare `text_expr` with the plain parameter instead. `value` is the checked,
    /// normalised value (see `check_value`).
    pub fn typed_param(self, kind: ColKind, type_name: &str, n: usize, value: &str) -> Option<String> {
        let p = self.param(n);
        let lower = type_name.trim().to_ascii_lowercase();
        match self {
            Dialect::Postgres => pg_key_type(type_name).map(|ty| format!("({p}::text)::{ty}")),
            Dialect::Mysql => match kind {
                ColKind::Int | ColKind::Bool => Some(match mysql_key(type_name) {
                    Some(Key::Signed) => format!("CAST({p} AS SIGNED)"),
                    _ => format!("CAST({p} AS UNSIGNED)"),
                }),
                ColKind::Decimal => Some(format!("CAST({p} AS DECIMAL(65,30))")),
                ColKind::Binary => Some(format!("UNHEX({p})")),
                ColKind::Float | ColKind::Text | ColKind::Enum | ColKind::Uuid | ColKind::Date | ColKind::Time | ColKind::Timestamp => Some(p),
                ColKind::Timestamptz | ColKind::Json | ColKind::Other => None,
            },
            Dialect::Mssql => match kind {
                // `text`, `ntext` and `image` have no `=`.
                _ if matches!(lower.as_str(), "text" | "ntext" | "image") => None,
                // A non-ASCII value cannot be a varchar parameter without losing characters.
                ColKind::Text if matches!(lower.as_str(), "varchar" | "char") && value.is_ascii() => Some(format!("CAST({p} AS VARCHAR(8000))")),
                ColKind::Binary => Some(format!("CONVERT(VARBINARY(8000), {p}, 1)")),
                ColKind::Text | ColKind::Int | ColKind::Decimal | ColKind::Float | ColKind::Bool | ColKind::Uuid | ColKind::Date | ColKind::Time | ColKind::Timestamp | ColKind::Timestamptz => Some(p),
                ColKind::Enum | ColKind::Json | ColKind::Other => None,
            },
            // The column's affinity converts the parameter; blob and untyped columns have none.
            Dialect::Sqlite => (kind != ColKind::Binary && sqlite_keyed(type_name)).then_some(p),
        }
    }

    /// Checks a filter value against the column's kind and returns it in the form this engine
    /// parses (dates, booleans, hex). `Err` holds a message for the user: the value cannot match
    /// any row (or would make the server fail the query).
    pub fn check_value(self, kind: ColKind, type_name: &str, value: &str) -> Result<String, String> {
        let v = value.trim();
        let bad = |what: &str| Err(format!("“{v}” is not {what}"));
        match kind {
            ColKind::Int => {
                let unsigned = self == Dialect::Mysql && type_name.to_ascii_lowercase().contains("unsigned");
                match v.parse::<i128>() {
                    Ok(n) if unsigned && n < 0 => bad("a positive whole number"),
                    Ok(_) => Ok(v.trim_start_matches('+').to_string()),
                    Err(_) => bad("a whole number"),
                }
            }
            ColKind::Decimal => {
                if is_decimal(v) {
                    Ok(v.trim_start_matches('+').to_string())
                } else {
                    bad("a number")
                }
            }
            ColKind::Float => match v.parse::<f64>() {
                Ok(f) if f.is_finite() => Ok(v.to_string()),
                _ => bad("a number"),
            },
            ColKind::Bool => {
                let truth = match v.to_ascii_lowercase().as_str() {
                    "true" | "t" | "1" | "yes" | "y" | "on" => true,
                    "false" | "f" | "0" | "no" | "n" | "off" => false,
                    _ => return bad("true or false"),
                };
                Ok(match self {
                    Dialect::Postgres => if truth { "true" } else { "false" }.to_string(),
                    _ => if truth { "1" } else { "0" }.to_string(),
                })
            }
            ColKind::Uuid => {
                let hex: String = v.chars().filter(|c| !matches!(c, '-' | '{' | '}')).collect();
                if hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit()) { Ok(v.to_string()) } else { bad("a UUID") }
            }
            ColKind::Date => match parse_date(v) {
                Some(d) if v.len() == 10 => Ok(d),
                _ => bad("a date (YYYY-MM-DD)"),
            },
            ColKind::Time => parse_time(v).ok_or(()).or_else(|_| bad("a time (HH:MM:SS)")),
            ColKind::Timestamp | ColKind::Timestamptz => {
                let Some(ts) = parse_timestamp(v) else { return bad("a date and time (YYYY-MM-DD HH:MM:SS)") };
                if ts.offset.is_some() && kind == ColKind::Timestamp && self != Dialect::Sqlite {
                    return bad("a date and time without a time zone");
                }
                // SQLite keeps dates as text: compare with what was typed.
                if self == Dialect::Sqlite {
                    return Ok(v.to_string());
                }
                let mssql_datetime = self == Dialect::Mssql && matches!(type_name.to_ascii_lowercase().as_str(), "datetime" | "smalldatetime");
                let frac = if mssql_datetime { ts.frac.chars().take(3).collect::<String>() } else { ts.frac.clone() };
                let sep = if self == Dialect::Mssql { 'T' } else { ' ' };
                let mut out = format!("{}{sep}{}", ts.date, ts.time);
                if !frac.is_empty() {
                    out.push('.');
                    out.push_str(&frac);
                }
                if let Some(off) = &ts.offset {
                    out.push_str(off);
                }
                Ok(out)
            }
            ColKind::Binary => {
                let hex = v.strip_prefix("0x").or_else(|| v.strip_prefix("0X")).or_else(|| v.strip_prefix("\\x")).unwrap_or(v);
                if hex.is_empty() || !hex.len().is_multiple_of(2) || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    return bad("hex bytes (0x…)");
                }
                Ok(match self {
                    Dialect::Postgres => format!("\\x{}", hex.to_ascii_lowercase()),
                    Dialect::Mysql => hex.to_ascii_uppercase(),
                    Dialect::Mssql => format!("0x{}", hex.to_ascii_uppercase()),
                    Dialect::Sqlite => format!("\\x{}", hex.to_ascii_lowercase()),
                })
            }
            ColKind::Text | ColKind::Enum | ColKind::Json | ColKind::Other => Ok(value.to_string()),
        }
    }

    /// `text LIKE param ESCAPE '!'`, case-insensitive unless `cs`. The parameter must hold a
    /// pattern from `like_pattern`. SQLite's case-sensitive matching has no LIKE form (see
    /// `filter.rs`, which uses `instr`/`substr` instead).
    pub fn like(self, text: &str, param: &str, cs: bool) -> String {
        match (self, cs) {
            (Dialect::Postgres, false) => format!("{text} ILIKE {param} ESCAPE '!'"),
            (Dialect::Mysql, true) => format!("{text} LIKE ({param} COLLATE utf8mb4_bin) ESCAPE '!'"),
            (Dialect::Mssql, true) => format!("{text} COLLATE Latin1_General_100_BIN2 LIKE {param} ESCAPE '!'"),
            _ => format!("{text} LIKE {param} ESCAPE '!'"),
        }
    }

    /// `value` as a LIKE pattern for `like`, with `!`, `%`, `_` (and `[` on SQL Server) escaped.
    pub fn like_pattern(self, anchor: Anchor, value: &str) -> String {
        let mut escaped = String::with_capacity(value.len() + 2);
        for c in value.chars() {
            if matches!(c, '!' | '%' | '_') || (c == '[' && self == Dialect::Mssql) {
                escaped.push('!');
            }
            escaped.push(c);
        }
        match anchor {
            Anchor::Contains => format!("%{escaped}%"),
            Anchor::StartsWith => format!("{escaped}%"),
            Anchor::EndsWith => format!("%{escaped}"),
        }
    }

    /// A regular-expression match, where the engine has one.
    pub fn regex(self, text: &str, param: &str, cs: bool) -> Option<String> {
        match self {
            Dialect::Postgres => Some(format!("{text} {} {param}", if cs { "~" } else { "~*" })),
            Dialect::Mysql => Some(if cs { format!("{text} REGEXP ({param} COLLATE utf8mb4_bin)") } else { format!("{text} REGEXP {param}") }),
            Dialect::Mssql | Dialect::Sqlite => None,
        }
    }

    /// One ORDER BY item with NULLs last on every engine. NOT NULL columns get the plain form, so
    /// an ordinary index can serve the sort.
    pub fn order_item(self, expr: &str, desc: bool, nullable: bool) -> String {
        if !nullable {
            return if desc { format!("{expr} DESC") } else { expr.to_string() };
        }
        match (self, desc) {
            (Dialect::Postgres, true) => format!("{expr} DESC NULLS LAST"),
            (Dialect::Postgres, false) => expr.to_string(),
            (Dialect::Sqlite, false) => format!("{expr} ASC NULLS LAST"),
            (Dialect::Mysql, false) => format!("{expr} IS NULL, {expr}"),
            (Dialect::Mssql, false) => format!("CASE WHEN {expr} IS NULL THEN 1 ELSE 0 END, {expr}"),
            (_, true) => format!("{expr} DESC"),
        }
    }

    /// Whether rows can be sorted by a column of this type.
    pub fn sortable(self, kind: ColKind, type_name: &str) -> bool {
        let t = type_name.trim().to_ascii_lowercase();
        match self {
            Dialect::Postgres => !matches!(t.as_str(), "json" | "xml" | "point" | "line" | "lseg" | "box" | "path" | "polygon" | "circle"),
            Dialect::Mssql => !matches!(t.as_str(), "text" | "ntext" | "image" | "xml" | "geography" | "geometry"),
            Dialect::Mysql | Dialect::Sqlite => kind != ColKind::Json || self == Dialect::Sqlite,
        }
    }

    /// `expr` compared, as text, with parameter `n`.
    pub fn eq_text(self, expr: &str, type_name: &str, n: usize) -> String {
        let lhs = match self {
            Dialect::Postgres => format!("({expr})::text"),
            Dialect::Mysql => format!("CAST({expr} AS CHAR)"),
            Dialect::Mssql => self.select_text(expr, type_name),
            Dialect::Sqlite => format!("CAST({expr} AS TEXT)"),
        };
        format!("{lhs} = {}", self.param(n))
    }

    /// `expr` equal to parameter `n`, with the parameter converted to the column's type (instead of
    /// the column to text) so an index on the column can serve the lookup. Falls back to
    /// `eq_text` for types whose text form does not round-trip or that lack a usable equality.
    /// Values should pass `value_fits` first.
    pub fn eq_key(self, expr: &str, type_name: &str, n: usize) -> String {
        let p = self.param(n);
        let typed = match self {
            Dialect::Postgres => pg_key_type(type_name).map(|ty| format!("{expr} = ({p}::text)::{ty}")),
            Dialect::Mysql => match mysql_key(type_name) {
                Some(Key::Signed) => Some(format!("{expr} = CAST({p} AS SIGNED)")),
                Some(Key::Unsigned) => Some(format!("{expr} = CAST({p} AS UNSIGNED)")),
                Some(Key::Decimal) => Some(format!("{expr} = CAST({p} AS DECIMAL(65,30))")),
                Some(_) => Some(format!("{expr} = {p}")),
                None => None,
            },
            Dialect::Mssql => match mssql_key(type_name) {
                Some(Key::Varchar) => Some(format!("{expr} = CAST({p} AS VARCHAR(8000))")),
                Some(Key::Binary) => Some(format!("{expr} = CONVERT(VARBINARY(8000), {p}, 1)")),
                Some(_) => Some(format!("{expr} = {p}")),
                None => None,
            },
            Dialect::Sqlite => sqlite_keyed(type_name).then(|| format!("{expr} = {p}")),
        };
        typed.unwrap_or_else(|| self.eq_text(expr, type_name, n))
    }

    /// Whether `value` can be compared with `eq_key` without an error or a wrong match (MySQL
    /// casts junk to 0; SQL Server fails the conversion). False means no row can match.
    /// PostgreSQL reports bad input as a data exception, which the caller treats as no match.
    pub fn value_fits(self, type_name: &str, value: &str) -> bool {
        let key = match self {
            Dialect::Mysql => mysql_key(type_name),
            Dialect::Mssql => mssql_key(type_name),
            Dialect::Postgres | Dialect::Sqlite => return true,
        };
        match key {
            Some(Key::Signed) => value.parse::<i128>().is_ok(),
            Some(Key::Unsigned) => !value.starts_with('-') && value.parse::<i128>().is_ok(),
            Some(Key::Decimal) => is_decimal(value),
            Some(Key::Guid) => {
                let hex: String = value.chars().filter(|c| !matches!(c, '-' | '{' | '}')).collect();
                hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit())
            }
            Some(Key::Bit) => matches!(value.to_ascii_lowercase().as_str(), "0" | "1" | "true" | "false"),
            // `get` rather than slicing: the value is row data and may start with a multi-byte character.
            Some(Key::Binary) => value.len().is_multiple_of(2) && value.len() > 2 && value.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("0x")) && value.get(2..).is_some_and(|h| h.chars().all(|c| c.is_ascii_hexdigit())),
            _ => true,
        }
    }

    /// ORDER BY + paging. `order` is the ORDER BY list (empty for none); SQL Server needs one for
    /// OFFSET, so it orders by nothing in particular then.
    pub fn paging(self, order: &str, limit: u32, offset: u64) -> String {
        match self {
            Dialect::Mssql => {
                let order = if order.is_empty() { "(SELECT NULL)" } else { order };
                format!(" ORDER BY {order} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
            }
            _ => {
                let order = if order.is_empty() { String::new() } else { format!(" ORDER BY {order}") };
                format!("{order} LIMIT {limit} OFFSET {offset}")
            }
        }
    }
}

/// How a key column's value is compared in `eq_key`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Signed,
    Unsigned,
    Decimal,
    Guid,
    Bit,
    Varchar,
    Binary,
    /// Compared directly with the parameter (strings, dates, …).
    Plain,
}

fn is_decimal(v: &str) -> bool {
    let v = v.strip_prefix(['-', '+']).unwrap_or(v);
    let (int, frac) = v.split_once('.').unwrap_or((v, ""));
    !(int.is_empty() && frac.is_empty()) && int.chars().all(|c| c.is_ascii_digit()) && frac.chars().all(|c| c.is_ascii_digit())
}

/// The type a PostgreSQL parameter is cast to for a key lookup, from `format_type()` output:
/// numeric type modifiers are dropped (an explicit cast to `varchar(n)`, `numeric(p,s)` or
/// `timestamp(p)` would truncate or round the value, matching the wrong row), and `character`
/// becomes `bpchar` (a bare `character` means `char(1)`). `None` = compare as text.
fn pg_key_type(format_type: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = format_type.chars().peekable();
    let mut quoted = false;
    while let Some(c) = chars.next() {
        if c == '"' {
            quoted = !quoted;
            out.push(c);
        } else if c == '(' && !quoted {
            let mut inner = String::new();
            for d in chars.by_ref() {
                if d == ')' {
                    break;
                }
                inner.push(d);
            }
            // A non-numeric modifier (PostGIS `geometry(Point,4326)`, …): leave it as text.
            if !inner.chars().all(|d| d.is_ascii_digit() || d == ',' || d == ' ') {
                return None;
            }
        } else {
            out.push(c);
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let (base, array) = match out.find("[]") {
        Some(i) => (out[..i].trim_end().to_string(), out[i..].to_string()),
        None => (out.clone(), String::new()),
    };
    let lower = base.to_ascii_lowercase();
    let base = match lower.as_str() {
        "json" | "xml" | "point" | "line" | "lseg" | "box" | "path" | "polygon" | "circle" | "bit" | "bit varying" | "geometry" | "geography" => return None,
        "character" => "bpchar".to_string(),
        l if l.starts_with("interval") => "interval".to_string(),
        _ => base,
    };
    Some(format!("{base}{array}"))
}

/// MySQL `column_type` (`int(11) unsigned`, `varchar(255)`, `enum('a','b')`, …). Never spliced.
fn mysql_key(column_type: &str) -> Option<Key> {
    let t = column_type.trim().to_ascii_lowercase();
    let base = t.split(|c: char| c == '(' || c == ' ').next().unwrap_or("");
    Some(match base {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" => {
            if t.contains("unsigned") {
                Key::Unsigned
            } else {
                Key::Signed
            }
        }
        "decimal" | "numeric" | "dec" | "fixed" => Key::Decimal,
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set" | "date" | "datetime" | "timestamp" | "time" | "year" => Key::Plain,
        _ => return None,
    })
}

/// SQL Server type name (bare, as `sys.types` gives it).
fn mssql_key(type_name: &str) -> Option<Key> {
    Some(match type_name.to_ascii_lowercase().as_str() {
        "tinyint" | "smallint" | "int" | "bigint" => Key::Signed,
        "decimal" | "numeric" => Key::Decimal,
        "bit" => Key::Bit,
        "uniqueidentifier" => Key::Guid,
        "date" | "datetime" | "datetime2" | "smalldatetime" | "time" | "nvarchar" | "nchar" | "sysname" => Key::Plain,
        "varchar" | "char" => Key::Varchar,
        "binary" | "varbinary" | "timestamp" | "rowversion" => Key::Binary,
        _ => return None,
    })
}

/// SQLite compares a bound value with a column after applying the column's affinity, so any
/// typed column can be compared directly; only blob/untyped columns (no affinity) cannot.
fn sqlite_keyed(declared: &str) -> bool {
    let t = declared.to_ascii_lowercase();
    !(t.trim().is_empty() || (t.contains("blob") && !t.contains("int") && !t.contains("char") && !t.contains("clob") && !t.contains("text")))
}

/// The kind of a column from its type name as the engine's catalog reports it (PostgreSQL
/// `format_type()`, MySQL `column_type`, SQL Server's system type name, SQLite's declared type).
/// PostgreSQL enums are recognised from the catalog instead (see `catalog.rs`).
pub fn classify(d: Dialect, type_name: &str) -> ColKind {
    match d {
        Dialect::Postgres => pg_kind(type_name),
        Dialect::Mysql => mysql_kind(type_name),
        Dialect::Mssql => mssql_kind(type_name),
        Dialect::Sqlite => sqlite_kind(type_name),
    }
}

/// `format_type()` output without its modifiers: `character varying(255)` → `character varying`.
fn strip_modifiers(t: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in t.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn pg_kind(format_type: &str) -> ColKind {
    let t = strip_modifiers(&format_type.to_ascii_lowercase());
    if t.ends_with("[]") {
        return ColKind::Other;
    }
    match t.as_str() {
        "smallint" | "integer" | "bigint" => ColKind::Int,
        "numeric" => ColKind::Decimal,
        "real" | "double precision" => ColKind::Float,
        "boolean" => ColKind::Bool,
        "character varying" | "character" | "text" | "citext" | "name" | "\"char\"" => ColKind::Text,
        "uuid" => ColKind::Uuid,
        "date" => ColKind::Date,
        "time without time zone" | "time with time zone" => ColKind::Time,
        "timestamp without time zone" => ColKind::Timestamp,
        "timestamp with time zone" => ColKind::Timestamptz,
        "json" | "jsonb" => ColKind::Json,
        "bytea" => ColKind::Binary,
        _ => ColKind::Other,
    }
}

fn mysql_kind(column_type: &str) -> ColKind {
    let t = column_type.trim().to_ascii_lowercase();
    let base = t.split(['(', ' ']).next().unwrap_or("");
    match base {
        "tinyint" if t.starts_with("tinyint(1)") => ColKind::Bool,
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year" => ColKind::Int,
        "decimal" | "numeric" | "dec" | "fixed" => ColKind::Decimal,
        "float" | "double" | "real" => ColKind::Float,
        "bool" | "boolean" => ColKind::Bool,
        "bit" if t == "bit" || t == "bit(1)" => ColKind::Bool,
        "bit" => ColKind::Binary,
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "set" => ColKind::Text,
        "enum" => ColKind::Enum,
        "uuid" => ColKind::Uuid,
        "date" => ColKind::Date,
        "time" => ColKind::Time,
        "datetime" | "timestamp" => ColKind::Timestamp,
        "json" => ColKind::Json,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => ColKind::Binary,
        _ => ColKind::Other,
    }
}

fn mssql_kind(type_name: &str) -> ColKind {
    match type_name.trim().to_ascii_lowercase().as_str() {
        "tinyint" | "smallint" | "int" | "bigint" => ColKind::Int,
        "decimal" | "numeric" | "money" | "smallmoney" => ColKind::Decimal,
        "real" | "float" => ColKind::Float,
        "bit" => ColKind::Bool,
        "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" | "sysname" => ColKind::Text,
        "uniqueidentifier" => ColKind::Uuid,
        "date" => ColKind::Date,
        "time" => ColKind::Time,
        "datetime" | "datetime2" | "smalldatetime" => ColKind::Timestamp,
        "datetimeoffset" => ColKind::Timestamptz,
        "binary" | "varbinary" | "image" | "timestamp" | "rowversion" => ColKind::Binary,
        _ => ColKind::Other,
    }
}

/// SQLite's declared types are free text: the affinity rules (INT first), then common names.
fn sqlite_kind(declared: &str) -> ColKind {
    let t = declared.trim().to_ascii_lowercase();
    if t.is_empty() {
        ColKind::Other
    } else if t.contains("int") {
        ColKind::Int
    } else if t.contains("bool") {
        ColKind::Bool
    } else if t.contains("datetime") || t.contains("timestamp") {
        ColKind::Timestamp
    } else if t.contains("date") {
        ColKind::Date
    } else if t.contains("time") {
        ColKind::Time
    } else if t.contains("uuid") || t.contains("guid") {
        ColKind::Uuid
    } else if t.contains("json") {
        ColKind::Json
    } else if t.contains("char") || t.contains("clob") || t.contains("text") {
        ColKind::Text
    } else if t.contains("blob") {
        ColKind::Binary
    } else if t.contains("real") || t.contains("floa") || t.contains("doub") {
        ColKind::Float
    } else if t.contains("numeric") || t.contains("decimal") {
        ColKind::Decimal
    } else {
        ColKind::Other
    }
}

fn digits(s: &str, n: usize) -> Option<u32> {
    (s.len() == n && s.chars().all(|c| c.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// `YYYY-MM-DD` with real calendar dates (leap years included).
fn parse_date(v: &str) -> Option<String> {
    let mut parts = v.get(..10)?.split('-');
    let (y, m, d) = (digits(parts.next()?, 4)?, digits(parts.next()?, 2)?, digits(parts.next()?, 2)?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    ((1..=12).contains(&m) && d >= 1 && d <= days[m as usize - 1]).then(|| format!("{y:04}-{m:02}-{d:02}"))
}

/// `HH:MM`, `HH:MM:SS` or `HH:MM:SS.fff…` → `HH:MM:SS[.fff…]`.
fn parse_time(v: &str) -> Option<String> {
    let (hms, frac) = v.split_once('.').map_or((v, None), |(a, b)| (a, Some(b)));
    let mut parts = hms.split(':');
    let h = digits(parts.next()?, 2)?;
    let m = digits(parts.next()?, 2)?;
    let s = match parts.next() {
        Some(s) => digits(s, 2)?,
        None => 0,
    };
    if parts.next().is_some() || h > 23 || m > 59 || s > 59 {
        return None;
    }
    let mut out = format!("{h:02}:{m:02}:{s:02}");
    if let Some(f) = frac {
        if f.is_empty() || f.len() > 9 || !f.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        out.push('.');
        out.push_str(f);
    }
    Some(out)
}

struct Timestamp {
    date: String,
    time: String,
    frac: String,
    offset: Option<String>,
}

/// `YYYY-MM-DD`, then optionally `T`/space and a time, then optionally `Z` or `±HH[:MM]`.
fn parse_timestamp(v: &str) -> Option<Timestamp> {
    let date = parse_date(v)?;
    let rest = &v[10..];
    if rest.is_empty() {
        return Some(Timestamp { date, time: "00:00:00".into(), frac: String::new(), offset: None });
    }
    let rest = rest.strip_prefix(['T', 't', ' '])?;
    let (clock, offset) = match rest.find(['Z', 'z', '+', '-']) {
        Some(i) => (&rest[..i], Some(&rest[i..])),
        None => (rest, None),
    };
    let time = parse_time(clock.trim_end())?;
    let (time, frac) = time.split_once('.').map_or((time.clone(), String::new()), |(t, f)| (t.to_string(), f.to_string()));
    let offset = match offset {
        None => None,
        Some(o) if o.eq_ignore_ascii_case("z") => Some("+00:00".to_string()),
        Some(o) => {
            let (sign, body) = o.split_at(1);
            let body = body.replace(':', "");
            let (h, m) = match body.len() {
                2 => (digits(&body, 2)?, 0),
                4 => (digits(&body[..2], 2)?, digits(&body[2..], 2)?),
                _ => return None,
            };
            if h > 14 || m > 59 {
                return None;
            }
            Some(format!("{sign}{h:02}:{m:02}"))
        }
    };
    Some(Timestamp { date, time, frac, offset })
}

#[cfg(test)]
mod tests {
    use super::Dialect::*;

    #[test]
    fn key_equality_per_engine() {
        // PostgreSQL: cast the text parameter to the base type, without length/precision.
        assert_eq!(Postgres.eq_key("\"id\"", "integer", 1), "\"id\" = ($1::text)::integer");
        assert_eq!(Postgres.eq_key("\"c\"", "character varying(255)", 2), "\"c\" = ($2::text)::character varying");
        assert_eq!(Postgres.eq_key("\"c\"", "numeric(10,2)", 1), "\"c\" = ($1::text)::numeric");
        assert_eq!(Postgres.eq_key("\"c\"", "timestamp(3) without time zone", 1), "\"c\" = ($1::text)::timestamp without time zone");
        assert_eq!(Postgres.eq_key("\"c\"", "character(10)", 1), "\"c\" = ($1::text)::bpchar");
        assert_eq!(Postgres.eq_key("\"c\"", "character(10)[]", 1), "\"c\" = ($1::text)::bpchar[]");
        assert_eq!(Postgres.eq_key("\"c\"", "uuid", 1), "\"c\" = ($1::text)::uuid");
        assert_eq!(Postgres.eq_key("\"c\"", "billing.\"Status(x)\"", 1), "\"c\" = ($1::text)::billing.\"Status(x)\"");
        assert_eq!(Postgres.eq_key("\"c\"", "bit(8)", 1), "(\"c\")::text = $1");
        assert_eq!(Postgres.eq_key("\"c\"", "json", 1), "(\"c\")::text = $1");
        assert_eq!(Postgres.eq_key("\"c\"", "geometry(Point,4326)", 1), "(\"c\")::text = $1");
        // MySQL: integers and decimals cast explicitly (no float comparison), strings/dates as is.
        assert_eq!(Mysql.eq_key("`id`", "bigint unsigned", 1), "`id` = CAST(? AS UNSIGNED)");
        assert_eq!(Mysql.eq_key("`id`", "int(11)", 1), "`id` = CAST(? AS SIGNED)");
        assert_eq!(Mysql.eq_key("`p`", "decimal(10,2)", 1), "`p` = CAST(? AS DECIMAL(65,30))");
        assert_eq!(Mysql.eq_key("`s`", "varchar(64)", 1), "`s` = ?");
        assert_eq!(Mysql.eq_key("`s`", "enum('a','b')", 1), "`s` = ?");
        assert_eq!(Mysql.eq_key("`f`", "double", 1), "CAST(`f` AS CHAR) = ?");
        // SQL Server: no CONVERT_IMPLICIT on varchar columns; binaries from their 0x text.
        assert_eq!(Mssql.eq_key("[id]", "int", 1), "[id] = @P1");
        assert_eq!(Mssql.eq_key("[c]", "varchar", 2), "[c] = CAST(@P2 AS VARCHAR(8000))");
        assert_eq!(Mssql.eq_key("[b]", "varbinary", 1), "[b] = CONVERT(VARBINARY(8000), @P1, 1)");
        assert_eq!(Mssql.eq_key("[m]", "money", 1), "CONVERT(NVARCHAR(MAX), [m], 2) = @P1");
        // SQLite: the column affinity converts the parameter.
        assert_eq!(Sqlite.eq_key("\"id\"", "integer", 1), "\"id\" = ?1");
        assert_eq!(Sqlite.eq_key("\"b\"", "blob", 1), "CAST(\"b\" AS TEXT) = ?1");
        assert_eq!(Sqlite.eq_key("\"x\"", "", 1), "CAST(\"x\" AS TEXT) = ?1");
    }

    #[test]
    fn values_that_cannot_match() {
        assert!(Mysql.value_fits("int(11)", "-42"));
        assert!(!Mysql.value_fits("int(11)", "abc"));
        assert!(!Mysql.value_fits("int unsigned", "-1"));
        assert!(Mysql.value_fits("decimal(10,2)", "12.50"));
        assert!(!Mysql.value_fits("decimal(10,2)", "1e5"));
        assert!(Mysql.value_fits("varchar(10)", "anything"));
        assert!(Mssql.value_fits("uniqueidentifier", "6F9619FF-8B86-D011-B42D-00C04FD430C8"));
        assert!(!Mssql.value_fits("uniqueidentifier", "nope"));
        assert!(Mssql.value_fits("varbinary", "0x0A1B"));
        assert!(!Mssql.value_fits("varbinary", "0A1B"));
        // Non-ASCII values must not panic (byte slicing would cut a character in half).
        assert!(!Mssql.value_fits("varbinary", "€0"));
        assert!(!Mssql.value_fits("varbinary", "0x€0"));
        assert!(!Mssql.value_fits("varbinary", "é1"));
        assert!(!Mssql.value_fits("bit", "2"));
        assert!(Postgres.value_fits("integer", "abc"));
    }

    #[test]
    fn column_kinds_per_engine() {
        use super::{classify, ColKind::*};
        assert_eq!(classify(Postgres, "character varying(255)"), Text);
        assert_eq!(classify(Postgres, "timestamp(3) without time zone"), Timestamp);
        assert_eq!(classify(Postgres, "timestamp with time zone"), Timestamptz);
        assert_eq!(classify(Postgres, "numeric(10,2)"), Decimal);
        assert_eq!(classify(Postgres, "integer[]"), Other);
        assert_eq!(classify(Postgres, "jsonb"), Json);
        assert_eq!(classify(Mysql, "tinyint(1)"), Bool);
        assert_eq!(classify(Mysql, "int(11) unsigned"), Int);
        assert_eq!(classify(Mysql, "enum('a','b')"), Enum);
        assert_eq!(classify(Mysql, "bit(8)"), Binary);
        assert_eq!(classify(Mysql, "varbinary(16)"), Binary);
        assert_eq!(classify(Mssql, "datetimeoffset"), Timestamptz);
        assert_eq!(classify(Mssql, "uniqueidentifier"), Uuid);
        assert_eq!(classify(Mssql, "money"), Decimal);
        assert_eq!(classify(Sqlite, "integer"), Int);
        assert_eq!(classify(Sqlite, "datetime"), Timestamp);
        assert_eq!(classify(Sqlite, "varchar(20)"), Text);
        assert_eq!(classify(Sqlite, ""), Other);
    }

    #[test]
    fn typed_parameters_use_the_column_type() {
        use super::ColKind::*;
        assert_eq!(Postgres.typed_param(Int, "bigint", 1, "5").as_deref(), Some("($1::text)::bigint"));
        assert_eq!(Postgres.typed_param(Timestamp, "timestamp(3) without time zone", 2, "x").as_deref(), Some("($2::text)::timestamp without time zone"));
        assert_eq!(Postgres.typed_param(Json, "json", 1, "{}"), None);
        assert_eq!(Mysql.typed_param(Int, "int unsigned", 1, "5").as_deref(), Some("CAST(? AS UNSIGNED)"));
        assert_eq!(Mysql.typed_param(Bool, "tinyint(1)", 1, "1").as_deref(), Some("CAST(? AS SIGNED)"));
        assert_eq!(Mysql.typed_param(Binary, "varbinary(16)", 1, "0A").as_deref(), Some("UNHEX(?)"));
        assert_eq!(Mysql.typed_param(Json, "json", 1, "{}"), None);
        assert_eq!(Mssql.typed_param(Text, "varchar", 3, "abc").as_deref(), Some("CAST(@P3 AS VARCHAR(8000))"));
        assert_eq!(Mssql.typed_param(Text, "varchar", 3, "é").as_deref(), Some("@P3"));
        assert_eq!(Mssql.typed_param(Text, "ntext", 1, "a"), None);
        assert_eq!(Mssql.typed_param(Timestamp, "datetime2", 1, "x").as_deref(), Some("@P1"));
        assert_eq!(Sqlite.typed_param(Int, "integer", 2, "5").as_deref(), Some("?2"));
        assert_eq!(Sqlite.typed_param(Binary, "blob", 1, "\\x0a"), None);
    }

    #[test]
    fn values_are_checked_and_normalised() {
        use super::ColKind::*;
        assert_eq!(Postgres.check_value(Int, "integer", " +42 "), Ok("42".into()));
        assert!(Postgres.check_value(Int, "integer", "abc").unwrap_err().contains("whole number"));
        assert!(Mysql.check_value(Int, "int unsigned", "-1").is_err());
        assert_eq!(Mysql.check_value(Decimal, "decimal(10,2)", "12.50"), Ok("12.50".into()));
        assert!(Mysql.check_value(Decimal, "decimal(10,2)", "1e5").is_err());
        assert_eq!(Postgres.check_value(Bool, "boolean", "Yes"), Ok("true".into()));
        assert_eq!(Mssql.check_value(Bool, "bit", "false"), Ok("0".into()));
        assert_eq!(Postgres.check_value(Date, "date", "2024-02-29"), Ok("2024-02-29".into()));
        assert!(Postgres.check_value(Date, "date", "2023-02-29").is_err());
        assert!(Postgres.check_value(Date, "date", "2024-02-29 10:00").is_err());
        assert_eq!(Postgres.check_value(Time, "time without time zone", "9:30"), Err("“9:30” is not a time (HH:MM:SS)".into()));
        assert_eq!(Postgres.check_value(Time, "time without time zone", "09:30"), Ok("09:30:00".into()));
        assert_eq!(Postgres.check_value(Timestamp, "timestamp without time zone", "2026-11-14"), Ok("2026-11-14 00:00:00".into()));
        assert_eq!(Mssql.check_value(Timestamp, "datetime", "2026-11-14 10:20:30.123456"), Ok("2026-11-14T10:20:30.123".into()));
        assert_eq!(Mssql.check_value(Timestamp, "datetime2", "2026-11-14 10:20:30.123456"), Ok("2026-11-14T10:20:30.123456".into()));
        assert_eq!(Postgres.check_value(Timestamptz, "timestamp with time zone", "2026-11-14T00:00:00+0100"), Ok("2026-11-14 00:00:00+01:00".into()));
        assert_eq!(Postgres.check_value(Timestamptz, "timestamp with time zone", "2026-11-14T00:00:00Z"), Ok("2026-11-14 00:00:00+00:00".into()));
        assert!(Mysql.check_value(Timestamp, "datetime", "2026-11-14T00:00:00+01:00").is_err());
        assert_eq!(Sqlite.check_value(Timestamp, "datetime", "2026-11-14T10:00"), Ok("2026-11-14T10:00".into()));
        assert!(Postgres.check_value(Uuid, "uuid", "nope").is_err());
        assert_eq!(Mysql.check_value(Binary, "varbinary(4)", "0x0a1b"), Ok("0A1B".into()));
        assert_eq!(Mssql.check_value(Binary, "varbinary", "\\x0a1b"), Ok("0x0A1B".into()));
        assert_eq!(Postgres.check_value(Binary, "bytea", "0x0A"), Ok("\\x0a".into()));
        assert!(Postgres.check_value(Binary, "bytea", "0x0").is_err(), "odd length");
        assert_eq!(Mysql.check_value(Text, "varchar(5)", "  keep spaces "), Ok("  keep spaces ".into()));
    }

    #[test]
    fn text_matching_per_engine() {
        use super::Anchor::*;
        assert_eq!(Postgres.like_pattern(Contains, "50%_off!"), "%50!%!_off!!%");
        assert_eq!(Mssql.like_pattern(StartsWith, "[a]"), "![a]%");
        assert_eq!(Mysql.like_pattern(EndsWith, "x"), "%x");
        assert_eq!(Postgres.like("t", "$1", false), "t ILIKE $1 ESCAPE '!'");
        assert_eq!(Postgres.like("t", "$1", true), "t LIKE $1 ESCAPE '!'");
        assert_eq!(Mysql.like("t", "?", true), "t LIKE (? COLLATE utf8mb4_bin) ESCAPE '!'");
        assert_eq!(Mssql.like("t", "@P1", true), "t COLLATE Latin1_General_100_BIN2 LIKE @P1 ESCAPE '!'");
        assert_eq!(Sqlite.like("t", "?1", false), "t LIKE ?1 ESCAPE '!'");
        assert_eq!(Postgres.regex("t", "$1", false).as_deref(), Some("t ~* $1"));
        assert_eq!(Mysql.regex("t", "?", true).as_deref(), Some("t REGEXP (? COLLATE utf8mb4_bin)"));
        assert_eq!(Sqlite.regex("t", "?1", false), None);
        assert_eq!(Sqlite.text_expr("\"b\"", super::ColKind::Binary, "blob"), "('\\x' || lower(hex(\"b\")))");
        assert_eq!(Mysql.text_expr("`n`", super::ColKind::Int, "int"), "CAST(`n` AS CHAR)");
        assert_eq!(Mysql.select_text("`b`", "varbinary(16)"), "CONCAT('0x', HEX(`b`))");
        assert_eq!(Mssql.select_text("[f]", "float"), "CONVERT(NVARCHAR(MAX), [f], 3)");
    }

    #[test]
    fn nulls_sort_last_everywhere() {
        assert_eq!(Postgres.order_item("c", false, true), "c");
        assert_eq!(Postgres.order_item("c", true, true), "c DESC NULLS LAST");
        assert_eq!(Postgres.order_item("c", true, false), "c DESC");
        assert_eq!(Mysql.order_item("c", false, true), "c IS NULL, c");
        assert_eq!(Mssql.order_item("c", false, true), "CASE WHEN c IS NULL THEN 1 ELSE 0 END, c");
        assert_eq!(Sqlite.order_item("c", false, true), "c ASC NULLS LAST");
        assert_eq!(Mssql.order_item("c", true, true), "c DESC");
        assert!(!Postgres.sortable(super::ColKind::Json, "json"));
        assert!(Postgres.sortable(super::ColKind::Json, "jsonb"));
        assert!(!Mssql.sortable(super::ColKind::Text, "ntext"));
    }

    #[test]
    fn quoting_params_and_paging() {
        assert_eq!(Postgres.quote("a\"b"), "\"a\"\"b\"");
        assert_eq!(Mysql.quote("a`b"), "`a``b`");
        assert_eq!(Mssql.quote("a]b"), "[a]]b]");
        assert_eq!(Sqlite.qualified("main", "t"), "\"t\"");
        assert_eq!(Mssql.qualified("dbo", "t"), "[dbo].[t]");
        assert_eq!(Postgres.param(2), "$2");
        assert_eq!(Mssql.param(2), "@P2");
        assert_eq!(Sqlite.param(2), "?2");
        assert_eq!(Mysql.eq_text("`a`", "int", 1), "CAST(`a` AS CHAR) = ?");
        assert_eq!(Mssql.select_text("[d]", "datetime2"), "CONVERT(NVARCHAR(MAX), [d], 126)");
        assert_eq!(Postgres.paging("\"id\"", 10, 20), " ORDER BY \"id\" LIMIT 10 OFFSET 20");
        assert_eq!(Mssql.paging("", 10, 0), " ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY");
    }
}
