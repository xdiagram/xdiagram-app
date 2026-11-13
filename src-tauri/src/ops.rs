//! Cancellable operations. A long command (introspection, browse, profile, query, X-ray) gets an
//! id from the frontend; `cancel` stops waiting for it at once and, where the engine allows,
//! stops the work on the server too: PostgreSQL gets a cancel request, SQLite is interrupted.
//! MySQL and SQL Server connections are simply dropped (their statements also have time limits).

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{LazyLock, Mutex};

use tokio_postgres_rustls::MakeRustlsConnect;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;

/// What to poke so the server-side work stops when an operation is cancelled.
pub enum Interrupt {
    Postgres(tokio_postgres::CancelToken, MakeRustlsConnect),
    Sqlite(rusqlite::InterruptHandle),
}

struct Op {
    token: CancellationToken,
    interrupts: Vec<Interrupt>,
}

static OPS: LazyLock<Mutex<HashMap<String, Op>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

tokio::task_local! {
    static CURRENT_OP: String;
}

thread_local! {
    /// The operation a blocking (SQLite) closure runs for; task-locals do not cross `spawn_blocking`.
    static BLOCKING_OP: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// The id of the operation the current task (or blocking closure) runs for.
pub fn current() -> Option<String> {
    CURRENT_OP.try_with(Clone::clone).ok().or_else(|| BLOCKING_OP.with(|op| op.borrow().clone()))
}

/// Runs `f` (on a blocking thread) as part of operation `op`.
pub fn with_op<T>(op: Option<String>, f: impl FnOnce() -> T) -> T {
    BLOCKING_OP.with(|cell| *cell.borrow_mut() = op);
    let result = f();
    BLOCKING_OP.with(|cell| *cell.borrow_mut() = None);
    result
}

/// Runs `fut` as operation `op_id` (when given): `cancel(op_id)` makes it return `Cancelled`.
pub async fn cancellable<T>(op_id: Option<String>, fut: impl Future<Output = Result<T, AppError>>) -> Result<T, AppError> {
    let Some(id) = op_id else { return fut.await };
    let token = CancellationToken::new();
    OPS.lock().unwrap().insert(id.clone(), Op { token: token.clone(), interrupts: Vec::new() });
    let result = tokio::select! {
        r = CURRENT_OP.scope(id.clone(), fut) => r,
        _ = token.cancelled() => Err(AppError::Cancelled),
    };
    OPS.lock().unwrap().remove(&id);
    result
}

/// Records how to stop server-side work for the current operation (no-op outside one).
pub fn register(interrupt: Interrupt) {
    let Some(id) = current() else { return };
    if let Some(op) = OPS.lock().unwrap().get_mut(&id) {
        op.interrupts.push(interrupt);
    }
}

/// Cancels an operation; false when it already finished (or never existed).
pub fn cancel(op_id: &str) -> bool {
    let Some(op) = OPS.lock().unwrap().remove(op_id) else { return false };
    op.token.cancel();
    for interrupt in op.interrupts {
        match interrupt {
            Interrupt::Postgres(token, tls) => {
                tauri::async_runtime::spawn(async move {
                    let _ = token.cancel_query(tls).await;
                });
            }
            Interrupt::Sqlite(handle) => handle.interrupt(),
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn cancelling_returns_at_once() {
        let started = Instant::now();
        let slow = async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok::<_, AppError>(1)
        };
        let task = tokio::spawn(cancellable(Some("op-1".into()), slow));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(cancel("op-1"));
        let result = task.await.unwrap();
        assert!(matches!(result, Err(AppError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!cancel("op-1"), "finished operations are forgotten");
        assert_eq!(cancellable(None, async { Ok::<_, AppError>(2) }).await.unwrap(), 2);
    }

    #[test]
    fn interrupts_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let handle = conn.get_interrupt_handle();
        let op = Some("op-sqlite".to_string());
        OPS.lock().unwrap().insert("op-sqlite".into(), Op { token: CancellationToken::new(), interrupts: Vec::new() });
        with_op(op, || register(Interrupt::Sqlite(handle)));
        assert_eq!(OPS.lock().unwrap().get("op-sqlite").map(|o| o.interrupts.len()), Some(1));
        let t = std::thread::spawn(move || {
            conn.query_row("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c", [], |r| r.get::<_, i64>(0))
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(cancel("op-sqlite"));
        assert!(t.join().unwrap().is_err(), "the endless query was interrupted");
    }
}
