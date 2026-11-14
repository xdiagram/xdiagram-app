# xdiagram

Desktop app (Tauri 2 + Angular) that connects to a database, generates
[DBML](https://dbml.dbdiagram.io) for its schema and shows it like dbdiagram.io: an editable
DBML editor on the left, a live ER diagram on the right. The DBML text is the source of truth, and
every change made on the canvas is an edit to it.

- **Connect** to PostgreSQL, MySQL / MariaDB, SQL Server or a SQLite file.
  - Use the form or paste a URL: `postgres://`, `mysql://`, `mariadb://`, `sqlserver://`, `mssql://` or `sqlite:path`.
  - SSL / encryption modes work like libpq's: `prefer` and `require` encrypt without checking the
    certificate (self-signed servers work), and `verify-full` checks the certificate and host name.
  - PostgreSQL and SQL Server have a schema filter.
  - **SSH tunnels** to reach databases behind a bastion host: password or private key (see below).
  - Profiles are saved in the app data dir. If you choose to remember the password, it goes to the OS keychain,
    tied to the server it was typed for: it is never sent to a different host, port, database or user.
- **Tabs**: several databases and files open at once (Ctrl+T, Ctrl+W, Ctrl+Tab). Each tab keeps
  its own undo history. Opening something that is already open switches to its tab.
- **Sessions**: the open tabs come back on the next start (Settings). A database tab reconnects when
  its tab is shown, and asks for the password when none is saved.
- **Save .dbml files**: Ctrl+S saves an open `.dbml` file in place; Ctrl+Shift+S (or Ctrl+S on a
  database) saves a new file, which the tab then follows. When another program changes an open
  file, a tab without unsaved edits reloads it; otherwise a banner offers **Reload from disk** or
  **Keep mine**.
- **Cancel** any long operation (reading a schema, browsing, profiling, queries, X-ray) from the
  spinner. On PostgreSQL the running statement is cancelled on the server too.
- **Settings** (gear button, Ctrl+,): theme (system, light, dark), editor font size, query time
  limit, profiling sample size, session restore, automatic reload of changed files, update checks.
- **DBML editor** (Monaco):
  - Highlighting and autocomplete for tables, columns, settings and enums (Ctrl+Space).
  - Go to definition (F12 / Ctrl+click) and find usages (Shift+F12).
  - Editing re-renders the diagram. Errors show inline while the last valid diagram stays on screen.
- **Edit on the canvas.** Every action below is one undo step (Ctrl+Z / Ctrl+Shift+Z), even with focus on the canvas.
  - Double-click a table header or a column to rename it.
  - Right-click a table for header colour, add column, hide, show only it and its directly related
    tables, browse or profile data, add to query, sample data, reveal in editor and copy name.
  - Right-click the background for a new table.
  - Drag from a column's connector dot to another table's column to add a `Ref`.
- **Big schemas**:
  - Ctrl+K / Ctrl+P palette: fuzzy search over tables, columns and commands.
  - A minimap.
  - Detail levels: all columns, keys only, names only.
  - Focus mode (F): fades tables more than one hop from the selection.
  - Saved views stored as DBML `DiagramView` blocks.
  - Parallel edge lanes so relationships sharing a side don't overlap.
  - Hundreds of tables stay smooth: parsing, completion and layout run off the main thread, and
    the canvas draws only what is on screen, in less detail when zoomed out (see below).
- **Data browser** (read-only, every engine), a bottom drawer with three views:
  - **Rows:** paging, sorting and per-column filters. Foreign-key values are links to the parent row,
    "Referenced by" opens the child rows, and a breadcrumb trail lets you go back. Right-click a row
    to follow a key, copy a value, copy the row as JSON or show its related data.
  - **Profile:** per-column statistics from a sample of up to 20,000 rows (random `TABLESAMPLE` on
    PostgreSQL and SQL Server, the first rows on MySQL and SQLite).
    - Shows nulls, distinct values, range, lengths and the most common values.
    - Columns that look like personal data (emails, phones, card numbers with a Luhn check, IBANs,
      IP addresses, or names like `password`/`dob`) are flagged, and their values masked until you
      reveal them.
    - Profiles are cached for the session, and the column tooltip on the diagram shows their summary.
  - **Query:** pick tables and they are joined along the shortest relationship path (declared
    relationships first, then X-ray's discovered ones). Bridge tables are added automatically, and
    the path is outlined on the diagram.
    - Pick columns, filter, choose INNER or LEFT joins, and copy the SQL in the connection's dialect.
    - Run it read-only, a page at a time. The query is built from a structured request: identifiers
      are checked against the catalog, and values are always parameters.
- **Related data** (read-only, every engine): a map of one row and the rows linked to it, opened
  from a row of the data browser (right-click, or its ⇄ button).
  - The row is a card in the middle. The rows it references are on the left and the rows that
    reference it on the right, with edges like the diagram's. X-ray's discovered relationships
    count too, drawn dashed.
  - **+** on a card loads that row's own links, so you can keep following keys. A row reached by
    two paths is one card. Cards already placed never move when the map grows; drag them, or use
    **Tidy** to lay them out again.
  - Cards show key columns and the first few others ("+N more columns" shows the rest). Each
    relationship loads 10 rows first, then **More** (up to 100) or **All in grid**.
  - **Open in grid** shows a card's row in the data browser, keeping the breadcrumb trail.
    **Start here** makes a card the centre of a new map.
  - Closing the map hides it; **Related data** in the drawer brings it back. Picking another row
    replaces it, and switching database discards it.
  - Each expansion is one batch of lookups on one connection. Values are compared in the column's
    own type rather than as text, so foreign-key and primary-key indexes are used.
- **Schema lint** (side panel tab, every engine and DBML files): FK type mismatches, FKs to
  non-unique columns, missing primary keys, unindexed FKs, duplicate or redundant indexes, reserved
  words, possible missing FKs (with an **Add Ref** quick fix), nullable FKs (opt-in), naming-style
  outliers and very wide tables.
  - Findings link to the table and the editor line, and tables get a badge on the diagram.
  - Each rule can be turned off.
- **Per database / file**: table positions, hidden tables, viewport and detail level are remembered.
- **Export**:
  - PNG, SVG or `.dbml`.
  - **SQL DDL** for PostgreSQL, MySQL, SQL Server or Oracle (see below).
  - **Sample data**: INSERT scripts with fake but consistent rows. Parents come first so every
    foreign key points at a generated row, and keys and unique columns stay unique. Values follow
    the type and column name (emails, names, prices, dates…). A seed makes it repeatable. There are
    PostgreSQL, MySQL, SQL Server and SQLite flavours (identity inserts and sequence resets included).
  - Documentation as one self-contained HTML file (searchable table of contents, clickable diagram, light/dark, print styles).
  - Documentation as GitHub Markdown with a Mermaid ER diagram.
- **Open** existing `.dbml` files, or **import SQL DDL**:
  - Accepts `.sql` files or pasted text (PostgreSQL, MySQL, SQL Server, SQLite, Oracle, Snowflake)
    and Rails `schema.rb`.
  - The dialect is detected and can be changed, and errors point at the offending line.
  - `pg_dump` output works, data and `COPY` blocks included (they are skipped).
- **X-ray mode** (PostgreSQL): the diagram of what the database *actually does*, plus an FK & index
  advisor (see below).

Everything is read-only against the database. SQL the app generates (DDL, sample data, index
advice) is shown, copied or saved, never executed. The query builder only runs the read-only
SELECTs it builds itself.

- **PostgreSQL** sessions start with `default_transaction_read_only=on`, and data reads also run in
  `READ ONLY` transactions with a statement timeout. Behind a pooler that refuses startup options
  (PgBouncer), the session option is left out and the read-only transactions remain.
- **MySQL / MariaDB** sessions are `SET SESSION TRANSACTION READ ONLY`, and data reads run in
  `START TRANSACTION READ ONLY` with `MAX_EXECUTION_TIME`.
- **SQL Server** has no read-only session mode: the guarantee is that only generated SELECTs run.
  Reads set `LOCK_TIMEOUT` to the query time limit. For extra safety, connect with a login that
  only has `db_datareader`.
- **SQLite** files are opened read-only.
- Cancelling stops the statement on the server for PostgreSQL and SQLite. For MySQL and SQL
  Server the connection is closed, and the server ends the statement when it notices.

App safety:

- A content security policy limits the window to the app's own scripts.
- `.dbml` files are written in place only if they were picked in an open or save dialog (also in
  later sessions); reopening a tab by path never makes a file writable.
- Saves go to a temporary file that then replaces the original, so a crash never leaves half a
  file. The app's own settings files are checked at start-up and restored from the previous
  start's copy if one was damaged.

## SQL DDL import and export

`@dbml/core` does the parsing and the CREATE statements. On their own its exporters only change
the syntax around each column, so xdiagram adapts the schema to the target first
(`src/app/export/ddl-translate.ts`, `type-map.ts`):

- **Column types** are converted between dialects. For example, `timestamptz` becomes
  `datetimeoffset` on SQL Server and `datetime` on MySQL, `uuid` becomes `uniqueidentifier` or
  `char(36)`, and `bool` becomes `bit` or `tinyint(1)`.
- **Text columns that are part of a key or index** become `varchar(255)` / `nvarchar(450)`,
  because `longtext` and `nvarchar(max)` cannot be indexed.
- **Defaults and CHECK expressions** are translated: functions such as `now()` and
  `gen_random_uuid()`, PostgreSQL `::` casts, booleans and arrays (which become JSON).
- **Referential actions** an engine lacks become NO ACTION, or are dropped.
- **MySQL:** each schema becomes a database, and the default schema becomes `main`.
- **Left out and listed in the script header:** anything that cannot be expressed, such as
  expression indexes or PostgreSQL-only defaults.

PostgreSQL, MySQL and SQL Server outputs were checked by running them on real servers in every
direction. Oracle output has not been run.

SQLite DDL has no `@dbml/core` importer. Its `CREATE TABLE` / `CREATE INDEX` statements are run
in a private in-memory SQLite database, never on a file, and then read back like a real file.

## Requirements

- Node.js **≥ 24.15** (required by Angular CLI 22), Rust stable, and the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Run

```sh
npm install
npm run tauri dev      # development
npm run release        # signed installers + latest.json (see "Releases and updates")
npm test               # frontend unit tests (Vitest)
npm run test:scripts   # tests of the release script
cd src-tauri && cargo test
```

`npm run tauri build` also works for a quick local installer, but it fails at the end without the
update signing key, because the bundle includes updater artifacts.

## How it works

```
Rust (tokio-postgres / mysql_async / tiberius / rusqlite)
                       ──introspect──▶  DatabaseSchema JSON (same shape as @dbml/connector)
Angular                ──@dbml/core importer.generateDbml──▶  DBML
parse worker           ──@dbml/parse compiler──▶  diagram model, lint findings, editor completions
layout worker          ──ELK──▶  table positions
Angular                ──Konva canvas──▶  diagram
```

`@dbml/connector` needs Node and cannot run in the webview, so the Rust side ports it:

- **PostgreSQL** (`src-tauri/src/db/introspect.rs`) is a port of the connector's queries.
- **MySQL / MariaDB** (`mysql.rs`) is a port of the connector's queries. It reads the connection's
  database.
- **SQL Server** (`mssql.rs`) is a port of the connector's queries. It supports SQL logins;
  Windows integrated auth is not supported.
- **SQLite** (`sqlite.rs`) has no connector to port. It reads `sqlite_master` and the table
  PRAGMAs, and opens the file read-only. CHECK constraints are not read, because SQLite keeps
  them only inside the `CREATE TABLE` text.

`src-tauri/src/db/dispatch.rs` routes each command to the right engine. The port differs from the
connector on purpose where the connector is buggy:

- The schema filter is a bind parameter.
- Foreign keys to tables outside the selected schemas are dropped (any engine). The connector
  keeps them, so `generateDbml` fails with "Can't find table".
- PostgreSQL index keys are read one position at a time. The connector splits index expressions on
  commas, so `generateDbml` fails with "Index column ... existed". It also drops expression-only
  indexes and lists `INCLUDE` columns as keys. Indexes need PostgreSQL 11+.
- SQL Server referential actions are written `SET NULL`, not `SET_NULL`, which DBML rejects.
- Backtick-quoted identifiers inside expressions (MySQL CHECK clauses, SQLite) are unquoted. DBML
  delimits expressions with backticks, so the connector's MySQL output does not parse.

`@dbml/core` is lazy-loaded. It bundles ANTLR parsers for every SQL dialect (~16 MB), and loading it
lazily keeps the startup bundle around 0.6 MB.

## SSH tunnels

Turn on **Connect through an SSH tunnel** in the connection dialog. Enter the SSH server, user and
either a password or a private key file (OpenSSH, PEM or PuTTY `.ppk`; ed25519, ECDSA or RSA),
with its passphrase if it has one. The database host and port are then the ones the SSH server
sees, often `localhost`. This works for PostgreSQL, MySQL and SQL Server, X-ray included.

- **Host keys.** The first time, the app shows the server's key fingerprint (`SHA256:…`) and asks
  whether to trust it. Accepted keys are kept in `known_hosts` in the app data folder; keys already
  in your `~/.ssh/known_hosts` are trusted too. A server whose key has changed is refused.
- **Secrets.** The SSH password or key passphrase goes to the OS keychain (`ssh:<profile id>`) only
  when you choose to remember passwords.
- **TLS** still checks the database's real host name through the tunnel (`verify-full`).
- **Tunnels** (`src-tauri/src/db/ssh.rs`, russh) listen on `127.0.0.1` only. They are shared by
  everything that talks to the same database, and close after five idle minutes.

## Big schemas

`node scripts/bench-big-schema.mjs setup` creates a 300-table PostgreSQL database
(`xdiagram_bench`, ~400 foreign keys) in the test container. `run` drives the running dev app over
the DevTools protocol and reports timings; `drop` removes the database. On that schema:

| | before | now |
|---|---|---|
| first diagram (connect → drawn) | 3.0 s | 1.6 s, 0.9 s of it reading the catalog |
| canvas frame while hovering, dragging or panning | 150–230 ms | under 17 ms (60 fps) |
| longest freeze after typing | 0.65 s | none over 50 ms |

What made the difference:

- The canvas draws only the tables and relationships near the viewport. Zoomed out it skips
  rows, shadows and finally names (at mid zoom, each table shows its name in large type), and a
  table's rows are created the first time it is shown up close.
- Re-rendering keeps the nodes of tables and relationships that did not change, so typing in one
  table or moving one does not rebuild the rest.
- Parsing, lint and editor completion run in a Web Worker (`src/app/core/parse.worker.ts`). It uses
  `@dbml/parse` and `@dbml/core`'s model classes only, not its SQL parsers (0.6 MB instead of ~16 MB).
- ELK lays out in its own worker, started while the app is idle.

## Releases and updates

The app checks for new versions on start (Settings) and from **About xdiagram** (palette, or the
link at the bottom of Settings). A banner offers **Install & restart**. The download is checked
against the update signing key before anything is installed.

1. **Release feed.** Set the GitHub repository in `src-tauri/tauri.conf.json` →
   `plugins.updater.endpoints`. It is a placeholder (`YOUR-ACCOUNT`), and while it is, update
   checks are skipped and About says so. The About links point at the same repository.
2. **Signing key.** The key was generated into `%USERPROFILE%\.tauri\xdiagram-updater.key`, with
   its password in `xdiagram-updater.password` next to it. Its public half is in `tauri.conf.json`.
   **Back both files up to a password manager**: without them, installed copies can no longer be
   updated. Never commit them.
3. **Build** with `npm run release -- --notes "What changed"`. Bump `version` in `tauri.conf.json`
   first. The script signs the installers and writes `src-tauri/target/release/bundle/latest.json`.
4. **Publish** a GitHub release tagged `v<version>` with the installers, their `.sig` files and
   `latest.json`. Installed copies find it through `…/releases/latest/download/latest.json`.

On Windows the update installs with the NSIS installer in passive mode (a progress window, no
questions). The installer images come from `scripts/installer-images.mjs`, and the app icons from
`app-icon.svg` (`npx tauri icon app-icon.svg`).

## X-ray mode (PostgreSQL)

Every diagram tool draws the schema as it is *declared*. X-ray (toolbar button, `Ctrl+Shift+X`)
overlays how the database is actually used, read from PostgreSQL's own statistics:

- **Relationships found in queries.**
  - The real workload from `pg_stat_statements` is parsed in Rust (`sqlparser`).
  - Every `JOIN … ON` / `USING` / `WHERE a.x = b.y` between two tables is collected.
  - Joins that no foreign key backs are drawn as dashed amber edges, weighted by call count.
  - Click one to see the queries behind it. **Add Ref to DBML** writes the relationship into the
    editor, and the edge turns solid.
- **Check data** (in the relationship popover):
  - Counts null and orphan child rows, with sample orphan values. Tables over ~5M rows are sampled,
    and the query runs read-only with a 15 s timeout.
  - Reports whether the parent key is unique and whether the child columns are indexed.
  - Generates the safe migration as text: index `CONCURRENTLY`, FK `NOT VALID`, then
    `VALIDATE CONSTRAINT`.
- **Index suggestions**, with Copy and Save `.sql` for each:
  - unindexed FK and discovered join columns
  - columns filtered in queries on large tables that are scanned sequentially
  - unused indexes (since the last stats reset)
  - duplicate indexes
- **Live activity.**
  - `pg_stat_user_tables` is sampled on an interval (one connection, Rust side).
  - Tables glow by reads/writes per second, and tables with no recorded activity are dimmed.
  - Large tables scanned sequentially more often than by index get a ⚑ flag.
- **Facts on hover.**
  - Row estimates, dead tuples and scan counts.
  - How often each declared FK is joined, or that it never is.
  - The *de facto* cardinality of each FK from `pg_stats` ("declared 1:N, in the data 1.0 per parent,
    40% of parents referenced").

Requirements:

- The live overlay and the facts work on any PostgreSQL ≥ 11.
- Relationship discovery and filter-based index suggestions need the `pg_stat_statements`
  extension. It is standard on managed services. On your own server, add it to
  `shared_preload_libraries` and run `CREATE EXTENSION pg_stat_statements`.
- To see other roles' queries, the connecting role needs `pg_read_all_stats`.

Everything is read-only and stays on your machine. Statistics are never reset. For other engines the
X-ray button is disabled.

Code:

- `src-tauri/src/db/workload.rs` — SQL analysis, unit-tested
- `workload_db.rs` — catalog queries
- `advisor.rs` — data checks and index advice
- `src-tauri/src/live.rs` — sampling session
- `src/app/state/workload.store.ts` and `src/app/sidebar/workload-panel.component.ts` — UI

## Checking the introspection

`scripts/parity.mjs` runs the Rust introspection and `@dbml/connector` against the same database. It
diffs the JSON and the generated DBML, and checks that the DBML parses:

```sh
# PostgreSQL
docker run -d --name xdiagram-pg -e POSTGRES_PASSWORD=xdiagram -p 55432:5432 postgres:17-alpine \
  -c shared_preload_libraries=pg_stat_statements
docker exec -i xdiagram-pg psql -U postgres < scripts/sample-schema.sql
npm run parity -- "postgres://postgres:xdiagram@127.0.0.1:55432/postgres?sslmode=disable" [schema1,schema2]

# MySQL
docker run -d --name xdiagram-mysql -e MYSQL_ROOT_PASSWORD=xdiagram -p 53306:3306 mysql:8.4
docker exec -i xdiagram-mysql mysql -uroot -pxdiagram < scripts/sample-schema.mysql.sql
npm run parity -- --engine mysql "mysql://root:xdiagram@127.0.0.1:53306/shop"

# SQL Server
docker run -d --name xdiagram-mssql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Xdiagram#2026" -p 51433:1433 \
  mcr.microsoft.com/mssql/server:2022-latest
docker cp scripts/sample-schema.mssql.sql xdiagram-mssql:/tmp/s.sql
MSYS_NO_PATHCONV=1 docker exec xdiagram-mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "Xdiagram#2026" -i /tmp/s.sql
npm run parity -- --engine mssql \
  "Server=127.0.0.1,51433;Database=shop;User Id=sa;Password=Xdiagram#2026;Encrypt=true;TrustServerCertificate=true"
```

Use `127.0.0.1` rather than `localhost`, because Node may try IPv6 first and time out. To build the
SQLite sample, see the first line of `scripts/sample-schema.sqlite.sql`.

`cd src-tauri && cargo run --example dump_schema -- --engine <engine> <connection>` prints the Rust
side alone.

To exercise X-ray, load the sample schema into the PostgreSQL container, then generate workload and
print the report:

```sh
for i in $(seq 30); do docker exec -i xdiagram-pg psql -U postgres -q < scripts/sample-workload.sql; done
cd src-tauri && cargo run --example dump_workload -- "postgres://postgres:xdiagram@127.0.0.1:55432/postgres?sslmode=disable"
```

The report lists:

- `events → users` and `events → organizations` as found-in-queries relationships (the `events`
  table declares no foreign keys)
- `project_members.project_id` as never joined
- `legacy_notes` as idle
- index suggestions for the unindexed `events` columns, the `external_ref` filter, and the unused
  and duplicate indexes
