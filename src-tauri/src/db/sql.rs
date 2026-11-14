//! SQL text per engine for the read-only features that build their own SELECTs (profiling, the
//! join query builder): identifier quoting, parameters, casting to text and paging. Identifiers
//! passed here must already be checked against the catalog; values always go in parameters.

use super::connect::Engine;

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
    /// read, so they are selected as they are.
    pub fn select_text(self, expr: &str, type_name: &str) -> String {
        match self {
            Dialect::Postgres => format!("({expr})::text"),
            Dialect::Mssql => match type_name.to_ascii_lowercase().as_str() {
                "binary" | "varbinary" | "image" | "timestamp" | "rowversion" => format!("CONVERT(NVARCHAR(MAX), {expr}, 1)"),
                "datetime" | "datetime2" | "smalldatetime" | "datetimeoffset" | "date" | "time" => format!("CONVERT(NVARCHAR(MAX), {expr}, 126)"),
                "geography" | "geometry" | "hierarchyid" => format!("{expr}.ToString()"),
                _ => format!("CONVERT(NVARCHAR(MAX), {expr})"),
            },
            Dialect::Mysql | Dialect::Sqlite => expr.to_string(),
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
        assert_eq!(Mssql.eq_key("[m]", "money", 1), "CONVERT(NVARCHAR(MAX), [m]) = @P1");
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
