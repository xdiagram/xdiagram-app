//! One runner for the row queries (browse, counts, values) on every engine: it loads the
//! metadata of the tables a request names, lets a pure planner write the statements (so the SQL
//! is unit-tested without a server), then runs each one read-only and time-limited and hands
//! the results to a finisher. Optional statements (counts, value lists) may time out without
//! failing the request.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use mysql_async::prelude::Queryable;
use rusqlite::Connection;

use super::catalog::{self, not_found, Catalog};
use super::connect::{connect, ConnectionInput, Engine};
use super::sql::Dialect;
use super::{mssql, mysql, sqlite};
use crate::error::AppError;

/// One statement to run: text-only result columns, bound text parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct Stmt {
    pub sql: String,
    pub params: Vec<String>,
    pub timeout_s: u32,
    /// A timeout or failure becomes a result (`Ran::TimedOut` / `Failed`) instead of an error.
    pub optional: bool,
}

#[derive(Debug)]
pub enum Ran {
    Rows(Vec<Vec<Option<String>>>),
    TimedOut,
    Failed(AppError),
    /// Not run: an earlier timeout left the connection unusable (SQL Server).
    Skipped,
}

enum RunError {
    Timeout,
    Other(AppError),
}

fn timeout_error(secs: u32) -> AppError {
    AppError::Invalid(format!("The query took longer than {secs} s (Settings → query time limit)"))
}

/// Runs `plan`'s statements for the tables in `tables` and passes the results to `finish`.
pub async fn run<T: Send + 'static>(
    input: &ConnectionInput,
    tables: Vec<(String, String)>,
    plan: impl FnOnce(Dialect, &Catalog) -> Result<Vec<Stmt>, AppError> + Send + 'static,
    finish: impl FnOnce(Dialect, &Catalog, Vec<Ran>) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    match input.engine {
        Engine::Postgres => {
            let mut client = connect(input).await?;
            let mut cat = Catalog::new();
            for (schema, table) in tables {
                let meta = catalog::pg_meta(&client, &schema, &table).await?.ok_or_else(|| not_found(&schema, &table))?;
                cat.insert((schema, table), meta);
            }
            let mut out = Vec::new();
            for st in plan(Dialect::Postgres, &cat)? {
                let ran = pg_run(&mut client, &st).await;
                out.push(settle(&st, ran)?);
            }
            finish(Dialect::Postgres, &cat, out)
        }
        Engine::Mysql => {
            let mut conn = mysql::connect(input).await?;
            let result = async {
                let mut cat = Catalog::new();
                for (schema, table) in tables {
                    let meta = catalog::mysql_meta(&mut conn, &schema, &table).await?.ok_or_else(|| not_found(&schema, &table))?;
                    cat.insert((schema, table), meta);
                }
                let mut out = Vec::new();
                for st in plan(Dialect::Mysql, &cat)? {
                    let ran = mysql_run(&mut conn, &st).await;
                    out.push(settle(&st, ran)?);
                }
                finish(Dialect::Mysql, &cat, out)
            }
            .await;
            let _ = conn.disconnect().await;
            result
        }
        Engine::Mssql => {
            let mut client = mssql::connect(input).await?;
            let mut cat = Catalog::new();
            for (schema, table) in tables {
                let meta = catalog::mssql_meta(&mut client, &schema, &table).await?.ok_or_else(|| not_found(&schema, &table))?;
                cat.insert((schema, table), meta);
            }
            let mut out = Vec::new();
            let mut broken = false;
            for st in plan(Dialect::Mssql, &cat)? {
                if broken {
                    out.push(Ran::Skipped);
                    continue;
                }
                let ran = mssql_run(&mut client, &st).await;
                // tiberius cannot reuse a connection whose response was abandoned mid-stream.
                broken = matches!(ran, Err(RunError::Timeout));
                out.push(settle(&st, ran)?);
            }
            finish(Dialect::Mssql, &cat, out)
        }
        Engine::Sqlite => {
            let input = input.clone();
            let op = crate::ops::current();
            tokio::task::spawn_blocking(move || crate::ops::with_op(op, || run_sqlite(&sqlite::open(&input)?, tables, plan, finish)))
                .await
                .map_err(|e| AppError::Invalid(e.to_string()))?
        }
    }
}

/// The SQLite path of `run`, on an open connection (also what the tests use).
pub fn run_sqlite<T>(
    conn: &Connection,
    tables: Vec<(String, String)>,
    plan: impl FnOnce(Dialect, &Catalog) -> Result<Vec<Stmt>, AppError>,
    finish: impl FnOnce(Dialect, &Catalog, Vec<Ran>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut cat = Catalog::new();
    for (schema, table) in tables {
        let meta = catalog::sqlite_meta(conn, &table)?.ok_or_else(|| not_found(&schema, &table))?;
        cat.insert((schema, table), meta);
    }
    let mut out = Vec::new();
    for st in plan(Dialect::Sqlite, &cat)? {
        let ran = sqlite_run(conn, &st);
        out.push(settle(&st, ran)?);
    }
    finish(Dialect::Sqlite, &cat, out)
}

/// A statement's outcome: rows, or (for optional statements) a timeout or failure as a result.
fn settle(st: &Stmt, ran: Result<Vec<Vec<Option<String>>>, RunError>) -> Result<Ran, AppError> {
    match ran {
        Ok(rows) => Ok(Ran::Rows(rows)),
        Err(RunError::Timeout) if st.optional => Ok(Ran::TimedOut),
        Err(RunError::Timeout) => Err(timeout_error(st.timeout_s)),
        Err(RunError::Other(AppError::Cancelled)) => Err(AppError::Cancelled),
        Err(RunError::Other(e)) if st.optional => Ok(Ran::Failed(e)),
        Err(RunError::Other(e)) => Err(e),
    }
}

/// One read-only transaction per statement, so a timeout does not end the ones after it.
async fn pg_run(client: &mut tokio_postgres::Client, st: &Stmt) -> Result<Vec<Vec<Option<String>>>, RunError> {
    let other = |e: tokio_postgres::Error| RunError::Other(e.into());
    let values: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = st.params.iter().map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
    let tx = client.transaction().await.map_err(other)?;
    tx.batch_execute(&format!("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '{}s'", st.timeout_s)).await.map_err(other)?;
    let result = tx.query(st.sql.as_str(), &values).await;
    let _ = tx.rollback().await;
    match result {
        Ok(rows) => Ok(rows.iter().map(|r| (0..r.len()).map(|i| r.get::<_, Option<String>>(i)).collect()).collect()),
        Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED) => Err(RunError::Timeout),
        Err(e) => Err(other(e)),
    }
}

async fn mysql_run(conn: &mut mysql_async::Conn, st: &Stmt) -> Result<Vec<Vec<Option<String>>>, RunError> {
    // MySQL limits SELECTs with MAX_EXECUTION_TIME (ms); MariaDB has max_statement_time (s).
    if conn.query_drop(format!("SET SESSION MAX_EXECUTION_TIME = {}", st.timeout_s * 1000)).await.is_err() {
        let _ = conn.query_drop(format!("SET SESSION max_statement_time = {}", st.timeout_s)).await;
    }
    mysql::fetch_rows(conn, &st.sql, &st.params).await.map_err(|e| match e {
        // 3024: MySQL's execution time exceeded; 1969: MariaDB's statement timeout.
        mysql_async::Error::Server(ref s) if s.code == 3024 || s.code == 1969 => RunError::Timeout,
        e => RunError::Other(e.into()),
    })
}

async fn mssql_run(client: &mut mssql::MsClient, st: &Stmt) -> Result<Vec<Vec<Option<String>>>, RunError> {
    mssql::limit_lock_wait(client, st.timeout_s as u64).await.map_err(RunError::Other)?;
    match tokio::time::timeout(Duration::from_secs(st.timeout_s as u64), mssql::fetch_rows(client, &st.sql, &st.params)).await {
        Err(_) => Err(RunError::Timeout),
        Ok(result) => result.map_err(RunError::Other),
    }
}

/// SQLite has no statement timeout: a watchdog interrupts the statement when time is up.
fn sqlite_run(conn: &Connection, st: &Stmt) -> Result<Vec<Vec<Option<String>>>, RunError> {
    let watchdog = Watchdog::start(conn, st.timeout_s);
    match sqlite::fetch_text(conn, &st.sql, &st.params) {
        Ok(rows) => Ok(rows),
        Err(_) if watchdog.fired() => Err(RunError::Timeout),
        Err(e) => Err(RunError::Other(e)),
    }
}

struct Watchdog {
    done: Arc<(Mutex<bool>, Condvar)>,
    fired: Arc<AtomicBool>,
}

impl Watchdog {
    fn start(conn: &Connection, secs: u32) -> Self {
        let handle = conn.get_interrupt_handle();
        let done = Arc::new((Mutex::new(false), Condvar::new()));
        let fired = Arc::new(AtomicBool::new(false));
        let (d, f) = (done.clone(), fired.clone());
        std::thread::spawn(move || {
            let (lock, cv) = &*d;
            let guard = lock.lock().unwrap();
            let (guard, wait) = cv.wait_timeout_while(guard, Duration::from_secs(secs as u64), |finished| !*finished).unwrap();
            if !*guard && wait.timed_out() {
                f.store(true, Ordering::SeqCst);
                handle.interrupt();
            }
        });
        Watchdog { done, fired }
    }

    fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let (lock, cv) = &*self.done;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_statements_time_out() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        let slow = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n";
        let stmt = |optional| Stmt { sql: slow.into(), params: vec![], timeout_s: 1, optional };
        let started = std::time::Instant::now();
        let ran = run_sqlite(&conn, vec![("public".into(), "t".into())], |_, _| Ok(vec![stmt(true)]), |_, _, ran| Ok(ran)).unwrap();
        assert!(matches!(ran[0], Ran::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(5));
        let err = run_sqlite(&conn, vec![("public".into(), "t".into())], |_, _| Ok(vec![stmt(false)]), |_, _, ran| Ok(ran)).unwrap_err();
        assert!(err.to_string().contains("longer than 1 s"), "{err}");
        let fast = Stmt { sql: "SELECT 1".into(), params: vec![], timeout_s: 1, optional: false };
        let ran = run_sqlite(&conn, vec![], |_, _| Ok(vec![fast]), |_, _, ran| Ok(ran)).unwrap();
        assert!(matches!(&ran[0], Ran::Rows(r) if r[0][0].as_deref() == Some("1")));
        assert!(run_sqlite(&conn, vec![("public".into(), "missing".into())], |_, _| Ok(vec![]), |_, _, ran| Ok(ran)).is_err());
    }
}
