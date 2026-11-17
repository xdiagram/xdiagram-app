//! Column profiling: a bounded sample of a table is read (read-only, as text) and summarised in
//! Rust — nulls, distinct values, min/max, lengths, most common values — with hints for columns
//! that look like personal data. The SQL side is one plain SELECT per engine.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::browse::BrowseColumn;
use super::sql::Dialect;

pub const DEFAULT_SAMPLE: u32 = 20_000;
pub const MAX_SAMPLE: u32 = 100_000;
/// Values are cut to this many characters before they are counted.
const STAT_CHARS: usize = 200;
/// Distinct values tracked per column (memory bound); beyond it the count is a lower bound.
const DISTINCT_CAP: usize = 50_000;
const TOP: usize = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequest {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub sample_rows: Option<u32>,
    /// Statement time limit in seconds (default 20).
    #[serde(default)]
    pub timeout_secs: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValueCount {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnProfile {
    pub name: String,
    pub type_name: String,
    pub nulls: u32,
    pub non_null: u32,
    pub distinct: u32,
    /// `distinct` stopped counting at the cap.
    pub distinct_capped: bool,
    /// Every non-null sampled value is different.
    pub unique: bool,
    pub numeric: bool,
    pub min: Option<String>,
    pub max: Option<String>,
    pub avg_length: Option<f64>,
    pub max_length: Option<u32>,
    pub top: Vec<ValueCount>,
    /// What kind of personal data the column seems to hold, if any.
    pub pii: Option<String>,
    /// `values` (most sampled values match a pattern) or `name` (only the column name suggests it).
    pub pii_basis: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableProfile {
    pub schema: String,
    pub table: String,
    pub row_estimate: f64,
    pub sample_size: u32,
    /// The sample is smaller than the table (stats describe the sample).
    pub sampled: bool,
    pub method: String,
    pub columns: Vec<ColumnProfile>,
    pub elapsed_ms: u64,
}

/// The sampling SELECT: `(sql, method)`. `select` is the select list, `from` the qualified table.
pub fn sample_sql(d: Dialect, select: &str, from: &str, estimate: f64, n: u32) -> (String, String) {
    let big = estimate > (n as f64) * 2.0;
    // TABLESAMPLE picks pages; ask for ~50% more than needed, the LIMIT trims.
    let pct = ((n as f64) * 1.5 / estimate.max(1.0) * 100.0).clamp(0.0001, 100.0);
    match d {
        Dialect::Postgres if big => (
            format!("SELECT {select} FROM {from} TABLESAMPLE SYSTEM ({pct:.4}) LIMIT {n}"),
            format!("random sample of ~{n} rows (TABLESAMPLE)"),
        ),
        Dialect::Mssql if big => (
            format!("SELECT TOP ({n}) {select} FROM {from} TABLESAMPLE SYSTEM ({pct:.4} PERCENT)"),
            format!("random sample of ~{n} rows (TABLESAMPLE)"),
        ),
        Dialect::Mssql => (format!("SELECT TOP ({n}) {select} FROM {from}"), format!("first {n} rows")),
        _ => (format!("SELECT {select} FROM {from} LIMIT {n}"), format!("first {n} rows")),
    }
}

fn cut(value: &str) -> &str {
    match value.char_indices().nth(STAT_CHARS) {
        Some((i, _)) => &value[..i],
        None => value,
    }
}

/// Summarises the sampled `rows` (cells as text, in `columns` order).
pub fn profile_columns(columns: &[BrowseColumn], rows: &[Vec<Option<String>>]) -> Vec<ColumnProfile> {
    columns
        .iter()
        .enumerate()
        .map(|(i, col)| {
            let mut nulls = 0u32;
            let mut counts: HashMap<&str, u32> = HashMap::new();
            let mut capped = false;
            let mut numeric = true;
            let mut num_min: Option<(f64, &str)> = None;
            let mut num_max: Option<(f64, &str)> = None;
            let mut text_min: Option<&str> = None;
            let mut text_max: Option<&str> = None;
            let mut total_len = 0usize;
            let mut max_len = 0usize;
            let mut values: Vec<&str> = Vec::new();

            for row in rows {
                let Some(raw) = row.get(i).and_then(|v| v.as_deref()) else {
                    nulls += 1;
                    continue;
                };
                let v = cut(raw);
                values.push(v);
                if let Some(c) = counts.get_mut(v) {
                    *c += 1;
                } else if counts.len() < DISTINCT_CAP {
                    counts.insert(v, 1);
                } else {
                    capped = true;
                }
                let len = raw.chars().count();
                total_len += len;
                max_len = max_len.max(len);
                if numeric {
                    match v.trim().parse::<f64>() {
                        Ok(x) if x.is_finite() => {
                            if num_min.is_none_or(|(m, _)| x < m) {
                                num_min = Some((x, v));
                            }
                            if num_max.is_none_or(|(m, _)| x > m) {
                                num_max = Some((x, v));
                            }
                        }
                        _ => numeric = false,
                    }
                }
                if text_min.is_none_or(|m| v < m) {
                    text_min = Some(v);
                }
                if text_max.is_none_or(|m| v > m) {
                    text_max = Some(v);
                }
            }

            let non_null = values.len() as u32;
            let numeric = numeric && non_null > 0;
            let distinct = counts.len() as u32;
            let mut top: Vec<ValueCount> = counts.iter().filter(|(_, c)| **c > 1).map(|(v, c)| ValueCount { value: v.to_string(), count: *c }).collect();
            top.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value)));
            top.truncate(TOP);
            let (min, max) = if numeric {
                (num_min.map(|(_, s)| s.to_string()), num_max.map(|(_, s)| s.to_string()))
            } else {
                (text_min.map(str::to_string), text_max.map(str::to_string))
            };
            let (pii, pii_basis) = match detect_pii(&values) {
                Some(kind) => (Some(kind.to_string()), Some("values".to_string())),
                None => match pii_from_name(&col.name) {
                    Some(kind) => (Some(kind.to_string()), Some("name".to_string())),
                    None => (None, None),
                },
            };
            ColumnProfile {
                name: col.name.clone(),
                type_name: col.type_name.clone(),
                nulls,
                non_null,
                distinct,
                distinct_capped: capped,
                unique: non_null > 0 && !capped && distinct == non_null,
                numeric,
                min,
                max,
                avg_length: (!numeric && non_null > 0).then(|| total_len as f64 / non_null as f64),
                max_length: (!numeric && non_null > 0).then_some(max_len as u32),
                top,
                pii,
                pii_basis,
            }
        })
        .collect()
}

// ------------------------------------------------------------------ personal data

pub fn is_email(v: &str) -> bool {
    let v = v.trim();
    let Some((local, domain)) = v.split_once('@') else { return false };
    !local.is_empty()
        && v.len() <= 254
        && !v.contains(char::is_whitespace)
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

/// Separated digits (`+40 721 234 567`, `(555) 010-2030`): 7–15 digits with a `+` or separators.
pub fn is_phone(v: &str) -> bool {
    let v = v.trim();
    let digits = v.chars().filter(char::is_ascii_digit).count();
    let allowed = v.chars().all(|c| c.is_ascii_digit() || " +-().".contains(c));
    let formatted = v.starts_with('+') || v.chars().any(|c| " -().".contains(c));
    allowed && formatted && !is_date_like(v) && (7..=15).contains(&digits) && v.chars().next().is_some_and(|c| c == '+' || c == '(' || c.is_ascii_digit())
}

/// `2026-11-13`, `13.11.2026`, `11/13/26`: three numeric groups shaped like a date.
fn is_date_like(v: &str) -> bool {
    let groups: Vec<&str> = v.split(['-', '.', '/']).collect();
    groups.len() == 3
        && groups.iter().all(|g| !g.is_empty() && g.chars().all(|c| c.is_ascii_digit()))
        && (groups[0].len() == 4 || groups[2].len() == 4 || groups.iter().all(|g| g.len() <= 2))
}

pub fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.chars().rev().enumerate() {
        let Some(mut d) = c.to_digit(10) else { return false };
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

pub fn is_card(v: &str) -> bool {
    let v = v.trim();
    if !v.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') {
        return false;
    }
    let digits: String = v.chars().filter(char::is_ascii_digit).collect();
    (13..=19).contains(&digits.len()) && luhn(&digits)
}

pub fn is_iban(v: &str) -> bool {
    let s: String = v.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    if !(15..=34).contains(&s.len()) || !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    let b = s.as_bytes();
    if !(b[0].is_ascii_alphabetic() && b[1].is_ascii_alphabetic() && b[2].is_ascii_digit() && b[3].is_ascii_digit()) {
        return false;
    }
    // ISO 13616 mod-97 over the rearranged, letter-expanded string.
    let rearranged = format!("{}{}", &s[4..], &s[..4]);
    let mut rem: u64 = 0;
    for c in rearranged.chars() {
        let n = c.to_digit(36).unwrap_or(0) as u64;
        rem = if n >= 10 { (rem * 100 + n) % 97 } else { (rem * 10 + n) % 97 };
    }
    rem == 1
}

pub fn is_ipv4(v: &str) -> bool {
    let parts: Vec<&str> = v.trim().split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.parse::<u16>().is_ok_and(|n| n <= 255))
}

type Detector = (&'static str, fn(&str) -> bool);

/// The personal-data kind most sampled values match (≥ 60% of up to 1000 values).
pub fn detect_pii(values: &[&str]) -> Option<&'static str> {
    let sample: Vec<&str> = values.iter().take(1000).copied().collect();
    if sample.len() < 3 {
        return None;
    }
    let detectors: [Detector; 5] =
        [("email", is_email), ("card number", is_card), ("IBAN", is_iban), ("phone", is_phone), ("IP address", is_ipv4)];
    detectors
        .iter()
        .find(|(_, f)| sample.iter().filter(|v| f(v)).count() * 10 >= sample.len() * 6)
        .map(|(k, _)| *k)
}

/// Personal or secret data suggested by the column name alone.
pub fn pii_from_name(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if has(&["password", "passwd", "pwd", "secret", "token", "api_key", "apikey", "salt"]) {
        Some("secret")
    } else if has(&["email", "e_mail"]) {
        Some("email")
    } else if has(&["phone", "mobile", "fax"]) || n == "tel" {
        Some("phone")
    } else if has(&["ssn", "social_security", "cnp", "national_id", "passport", "tax_id", "nin"]) {
        Some("national id")
    } else if has(&["birth", "dob"]) {
        Some("date of birth")
    } else if has(&["iban", "card_number", "credit_card", "ccn", "account_number"]) {
        Some("financial")
    } else if has(&["address", "street", "postal", "zip"]) {
        Some("address")
    } else if has(&["first_name", "last_name", "full_name", "surname", "firstname", "lastname"]) {
        Some("name")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str) -> BrowseColumn {
        BrowseColumn { name: name.into(), type_name: "text".into(), ..Default::default() }
    }

    #[test]
    fn summarises_columns() {
        let rows: Vec<Vec<Option<String>>> = vec![
            vec![Some("10".into()), Some("b".into()), Some("ann@x.io".into())],
            vec![Some("9".into()), Some("a".into()), Some("bob@x.io".into())],
            vec![Some("100".into()), Some("b".into()), None],
            vec![None, Some("b".into()), Some("cid@x.io".into())],
        ];
        let p = profile_columns(&[col("n"), col("tag"), col("contact")], &rows);
        assert!(p[0].numeric);
        assert_eq!((p[0].min.as_deref(), p[0].max.as_deref()), (Some("9"), Some("100")));
        assert_eq!((p[0].nulls, p[0].non_null, p[0].distinct), (1, 3, 3));
        assert!(p[0].unique);
        assert!(!p[1].numeric && !p[1].unique);
        assert_eq!(p[1].top, vec![ValueCount { value: "b".into(), count: 3 }]);
        assert_eq!((p[1].min.as_deref(), p[1].max.as_deref()), (Some("a"), Some("b")));
        assert_eq!(p[2].pii.as_deref(), Some("email"));
        assert_eq!(p[2].pii_basis.as_deref(), Some("values"));
        assert_eq!(p[1].avg_length, Some(1.0));
    }

    #[test]
    fn detects_personal_data() {
        assert!(is_email("a.b@example.co.uk") && !is_email("a@b") && !is_email("not an@email.com"));
        assert!(is_phone("+40 721 234 567") && is_phone("(555) 010-2030") && !is_phone("12345678") && !is_phone("2026-11-13"));
        assert!(is_card("4111 1111 1111 1111") && !is_card("4111 1111 1111 1112"));
        assert!(is_iban("GB82 WEST 1234 5698 7654 32") && !is_iban("GB82 WEST 1234 5698 7654 33"));
        assert!(is_ipv4("10.0.0.255") && !is_ipv4("10.0.0.256"));
        assert_eq!(pii_from_name("password_hash"), Some("secret"));
        assert_eq!(pii_from_name("date_of_birth"), Some("date of birth"));
        assert_eq!(pii_from_name("quantity"), None);
    }

    #[test]
    fn sampling_sql() {
        let (sql, method) = sample_sql(Dialect::Postgres, "a", "\"t\"", 1_000_000.0, 20_000);
        assert!(sql.contains("TABLESAMPLE SYSTEM (3.0000) LIMIT 20000"), "{sql}");
        assert!(method.contains("random"));
        assert_eq!(sample_sql(Dialect::Postgres, "a", "\"t\"", 500.0, 20_000).0, "SELECT a FROM \"t\" LIMIT 20000");
        assert!(sample_sql(Dialect::Mssql, "a", "[t]", 10.0, 50).0.starts_with("SELECT TOP (50) a FROM [t]"));
        assert_eq!(sample_sql(Dialect::Sqlite, "a", "\"t\"", 1e9, 5).1, "first 5 rows");
    }
}
