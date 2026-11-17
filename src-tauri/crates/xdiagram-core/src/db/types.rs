//! Mirror of `@dbml/connector`'s `DatabaseSchema` (connectors/types.ts).
//!
//! The JSON produced here is fed unchanged to `@dbml/core`'s `importer.generateDbml`,
//! so key names (including their mixed casing) must match the TypeScript interfaces exactly.
//! It can be read back (tests, `xdiagram-core::dbml` parity checks).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteInfo {
    pub value: String,
}

impl NoteInfo {
    pub fn from_opt(value: Option<String>) -> Self {
        NoteInfo { value: value.filter(|v| !v.is_empty()).unwrap_or_default() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TypeInfo {
    pub type_name: String,
    #[serde(rename = "schemaName")]
    pub schema_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DefaultInfo {
    /// 'string' | 'number' | 'boolean' | 'expression'
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: TypeInfo,
    pub dbdefault: Option<DefaultInfo>,
    pub not_null: bool,
    pub increment: bool,
    pub note: NoteInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Table {
    pub name: String,
    /// Empty for engines without schemas in the connector output (MySQL): the key is then omitted.
    #[serde(rename = "schemaName", default, skip_serializing_if = "String::is_empty")]
    pub schema_name: String,
    pub note: NoteInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CheckConstraint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub expression: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ColumnConstraint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pk: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    pub checks: Vec<CheckConstraint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RefEndpoint {
    #[serde(rename = "tableName")]
    pub table_name: String,
    #[serde(rename = "schemaName", default, skip_serializing_if = "String::is_empty")]
    pub schema_name: String,
    #[serde(rename = "fieldNames")]
    pub field_names: Vec<String>,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Ref {
    pub name: String,
    pub endpoints: Vec<RefEndpoint>,
    #[serde(rename = "onDelete")]
    pub on_delete: Option<String>,
    #[serde(rename = "onUpdate")]
    pub on_update: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnumValue {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Enum {
    pub name: String,
    #[serde(rename = "schemaName", default, skip_serializing_if = "String::is_empty")]
    pub schema_name: String,
    pub values: Vec<EnumValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexColumn {
    /// 'column' | 'expression'
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Index {
    pub name: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub index_type: Option<String>,
    pub columns: Vec<IndexColumn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pk: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
}

/// Dictionaries are keyed by `schemaName.tableName`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DatabaseSchema {
    pub tables: Vec<Table>,
    pub fields: BTreeMap<String, Vec<Field>>,
    pub enums: Vec<Enum>,
    #[serde(rename = "tableConstraints")]
    pub table_constraints: BTreeMap<String, BTreeMap<String, ColumnConstraint>>,
    pub refs: Vec<Ref>,
    pub indexes: BTreeMap<String, Vec<Index>>,
    pub checks: BTreeMap<String, Vec<CheckConstraint>>,
}
