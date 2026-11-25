//! Masking personal data in what agents read, on connections shared as "masked" (the default).
//!
//! It uses the profiler's detectors (xdiagram-core `db::profile`): a column is masked when its
//! name suggests personal or secret data (`email`, `password`, `dob`, …) or when most of its
//! values look like emails, card numbers, IBANs, phone numbers or IP addresses; and any single
//! value that looks like an email, card number, IBAN or phone number is masked wherever it is.
//! This limits what reaches an agent by accident. It is not a security boundary: an agent can
//! still filter on a masked column, so a schema-only connection or a restricted database login
//! is the way to keep data out of reach.

use std::collections::BTreeMap;

use serde::Serialize;
use xdiagram_core::db::profile::{ColumnProfile, TableProfile, detect_pii, is_card, is_email, is_iban, is_phone, pii_from_name};
use xdiagram_core::profiles::DataAccess;

/// What a masked value reads as.
pub fn masked(kind: &str) -> String {
    format!("[masked: {kind}]")
}

/// The personal-data kind of one value, when it is unmistakably one on its own.
fn cell_kind(value: &str) -> Option<&'static str> {
    let v = value.trim();
    if is_email(v) {
        Some("email")
    } else if is_card(v) {
        Some("card number")
    } else if is_iban(v) {
        Some("IBAN")
    } else if is_phone(v) {
        Some("phone")
    } else {
        None
    }
}

/// The column part of a result column name (`alias.column` in joins).
fn bare(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

/// What was masked in a result.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaskReport {
    /// Whole columns masked, with the kind of data they hold.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub masked_columns: BTreeMap<String, String>,
    /// Other values masked one by one.
    #[serde(skip_serializing_if = "is_zero")]
    pub masked_values: usize,
    /// `masked_values` row by row (rows: `mask_rows` only).
    #[serde(skip)]
    pub values_by_row: Vec<usize>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl MaskReport {
    pub fn is_empty(&self) -> bool {
        self.masked_columns.is_empty() && self.masked_values == 0
    }

    /// The report for the first `rows` rows only (a page cut to fit a reply).
    pub fn keep_rows(&mut self, rows: usize) {
        self.masked_values = self.values_by_row.iter().take(rows).sum();
    }
}

/// The personal-data kind of a whole column, from its name or from these values of it.
pub fn column_kind(name: &str, values: &[&str]) -> Option<&'static str> {
    pii_from_name(bare(name)).or_else(|| detect_pii(values))
}

/// Masks rows of text values (`None` is NULL, which stays as it is) under `columns`.
pub fn mask_rows(access: DataAccess, columns: &[String], rows: &mut [Vec<Option<String>>]) -> MaskReport {
    let mut report = MaskReport { values_by_row: vec![0; rows.len()], ..Default::default() };
    if access == DataAccess::Full {
        return report;
    }
    for (i, name) in columns.iter().enumerate() {
        let values: Vec<&str> = rows.iter().filter_map(|r| r.get(i).and_then(|v| v.as_deref())).collect();
        if let Some(kind) = column_kind(name, &values) {
            for row in rows.iter_mut() {
                if let Some(Some(v)) = row.get_mut(i) {
                    *v = masked(kind);
                }
            }
            report.masked_columns.insert(name.clone(), kind.to_string());
            continue;
        }
        for (r, row) in rows.iter_mut().enumerate() {
            if let Some(Some(v)) = row.get_mut(i)
                && let Some(kind) = cell_kind(v)
            {
                *v = masked(kind);
                report.masked_values += 1;
                report.values_by_row[r] += 1;
            }
        }
    }
    report
}

/// Masks one value on its own (a single cell, a top value, a minimum).
pub fn mask_value(access: DataAccess, value: &mut Option<String>) -> bool {
    if access == DataAccess::Full {
        return false;
    }
    match value.as_deref().and_then(cell_kind) {
        Some(kind) => {
            *value = Some(masked(kind));
            true
        }
        None => false,
    }
}

/// Masks a column profile: its values (minimum, maximum, most common) when the column holds
/// personal data, else any value that looks like it on its own.
pub fn mask_profile(access: DataAccess, profile: &mut TableProfile) -> MaskReport {
    let mut report = MaskReport::default();
    if access == DataAccess::Full {
        return report;
    }
    for col in &mut profile.columns {
        let kind = col.pii.clone().or_else(|| pii_from_name(&col.name).map(str::to_string));
        match kind {
            Some(kind) => {
                mask_column_profile(col, &kind);
                report.masked_columns.insert(col.name.clone(), kind);
            }
            None => {
                for v in [&mut col.min, &mut col.max] {
                    if mask_value(access, v) {
                        report.masked_values += 1;
                    }
                }
                for top in &mut col.top {
                    if let Some(kind) = cell_kind(&top.value) {
                        top.value = masked(kind);
                        report.masked_values += 1;
                    }
                }
            }
        }
    }
    report
}

fn mask_column_profile(col: &mut ColumnProfile, kind: &str) {
    let m = masked(kind);
    if col.min.is_some() {
        col.min = Some(m.clone());
    }
    if col.max.is_some() {
        col.max = Some(m.clone());
    }
    for top in &mut col.top {
        top.value = m.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(data: &[&[Option<&str>]]) -> Vec<Vec<Option<String>>> {
        data.iter().map(|r| r.iter().map(|v| v.map(str::to_string)).collect()).collect()
    }

    #[test]
    fn masks_columns_by_name_and_by_values() {
        let cols: Vec<String> = ["id", "email", "contact", "note", "password_hash"].iter().map(|s| s.to_string()).collect();
        let mut data = rows(&[
            &[Some("1"), Some("ann@x.io"), Some("ann@x.io"), Some("call +40 721 234 567"), Some("$2b$...")],
            &[Some("2"), None, Some("bob@x.io"), Some("fine"), Some("$2b$...")],
            &[Some("3"), Some("cy@x.io"), Some("cy@x.io"), Some("+40 721 234 567"), None],
        ]);
        let report = mask_rows(DataAccess::Masked, &cols, &mut data);
        assert_eq!(data[0][1].as_deref(), Some("[masked: email]"), "named email");
        assert_eq!(data[1][1], None, "NULL stays NULL");
        assert_eq!(data[2][2].as_deref(), Some("[masked: email]"), "values that are emails");
        assert_eq!(data[0][4].as_deref(), Some("[masked: secret]"));
        assert_eq!(data[0][3].as_deref(), Some("call +40 721 234 567"), "text that merely mentions a phone stays");
        assert_eq!(data[2][3].as_deref(), Some("[masked: phone]"), "a lone phone number is masked");
        assert_eq!(data[0][0].as_deref(), Some("1"));
        assert_eq!(report.masked_columns.keys().collect::<Vec<_>>(), ["contact", "email", "password_hash"]);
        assert_eq!(report.masked_values, 1);
    }

    #[test]
    fn single_rows_are_covered_too() {
        // Too few values to judge a column, but a value that is an email is still masked.
        let cols = vec!["contact".to_string(), "u.mail".to_string()];
        let mut data = rows(&[&[Some("ann@x.io"), Some("x")]]);
        let report = mask_rows(DataAccess::Masked, &cols, &mut data);
        assert_eq!(data[0][0].as_deref(), Some("[masked: email]"));
        assert_eq!(data[0][1].as_deref(), Some("x"), "`mail` alone is not a personal-data name");
        assert_eq!(report.masked_values, 1);
        let mut joined = rows(&[&[Some("x"), Some("y")]]);
        let r = mask_rows(DataAccess::Masked, &["u.email".to_string(), "o.total".to_string()], &mut joined);
        assert_eq!(r.masked_columns.keys().collect::<Vec<_>>(), ["u.email"], "join columns by their column part");
    }

    #[test]
    fn full_access_masks_nothing() {
        let mut data = rows(&[&[Some("ann@x.io")]]);
        assert!(mask_rows(DataAccess::Full, &["email".to_string()], &mut data).is_empty());
        assert_eq!(data[0][0].as_deref(), Some("ann@x.io"));
    }
}
