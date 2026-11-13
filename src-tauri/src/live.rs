//! Live activity session for X-ray mode: one connection samples `pg_stat_user_tables` on an
//! interval and emits per-table rates to the window as `xdiagram://live` events.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::task::AbortHandle;

use crate::db::workload_db::{sample_tables, TableCounters};
use crate::db::{self, ConnectionInput};
use crate::error::AppError;

pub const LIVE_EVENT: &str = "xdiagram://live";
pub const LIVE_ERROR_EVENT: &str = "xdiagram://live-error";

#[derive(Default)]
pub struct LiveState {
    handle: Mutex<Option<AbortHandle>>,
}

impl LiveState {
    /// Aborting the task drops its client, which closes the connection.
    pub fn stop(&self) {
        if let Some(handle) = self.handle.lock().expect("live state lock").take() {
            handle.abort();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRate {
    pub id: String,
    pub rows: f64,
    pub dead_ratio: f64,
    pub reads_per_sec: f64,
    pub writes_per_sec: f64,
    pub seq_scans_per_sec: f64,
    pub idx_scans_per_sec: f64,
    pub wrote_since_last: bool,
    pub total_reads: i64,
    pub total_writes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSample {
    pub interval_ms: u64,
    /// Unix time in milliseconds.
    pub at: u64,
    pub tables: Vec<TableRate>,
}

pub async fn start(
    app: AppHandle,
    state: &LiveState,
    input: ConnectionInput,
    schemas: Vec<String>,
    interval_ms: u64,
) -> Result<(), AppError> {
    state.stop();
    let interval = Duration::from_millis(interval_ms.clamp(1000, 60_000));
    let client = db::connect(&input).await?;
    let first = sample_tables(&client, &schemas).await?;

    let task = tokio::spawn(async move {
        let mut prev_at = Instant::now();
        let mut prev = first;
        loop {
            tokio::time::sleep(interval).await;
            let now = Instant::now();
            match sample_tables(&client, &schemas).await {
                Ok(current) => {
                    let sample = diff(&prev, &current, now.duration_since(prev_at), interval);
                    let _ = app.emit(LIVE_EVENT, &sample);
                    prev = current;
                    prev_at = now;
                }
                Err(e) => {
                    let _ = app.emit(LIVE_ERROR_EVENT, e.to_string());
                    break;
                }
            }
        }
    });
    *state.handle.lock().expect("live state lock") = Some(task.abort_handle());
    Ok(())
}

fn diff(prev: &[TableCounters], current: &[TableCounters], elapsed: Duration, interval: Duration) -> LiveSample {
    let dt = elapsed.as_secs_f64().max(0.001);
    let by_id: HashMap<&str, &TableCounters> = prev.iter().map(|t| (t.id.as_str(), t)).collect();
    // Counters only go up unless the statistics were reset; a reset shows as zero activity.
    let rate = |now: i64, before: i64| ((now - before).max(0) as f64) / dt;
    let tables = current
        .iter()
        .map(|t| {
            let p = by_id.get(t.id.as_str()).copied();
            let total = t.n_live_tup + t.n_dead_tup;
            TableRate {
                id: t.id.clone(),
                rows: t.rows,
                dead_ratio: if total > 0 { t.n_dead_tup as f64 / total as f64 } else { 0.0 },
                reads_per_sec: p.map_or(0.0, |p| rate(t.tuples_read, p.tuples_read)),
                writes_per_sec: p.map_or(0.0, |p| rate(t.tuples_written, p.tuples_written)),
                seq_scans_per_sec: p.map_or(0.0, |p| rate(t.seq_scan, p.seq_scan)),
                idx_scans_per_sec: p.map_or(0.0, |p| rate(t.idx_scan, p.idx_scan)),
                wrote_since_last: p.is_some_and(|p| t.tuples_written > p.tuples_written),
                total_reads: t.tuples_read,
                total_writes: t.tuples_written,
            }
        })
        .collect();
    LiveSample {
        interval_ms: interval.as_millis() as u64,
        at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        tables,
    }
}
