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
- **Report a problem** (About xdiagram, the palette, or **Report** on an error): opens a GitHub
  issue form in your browser with the app's version, Windows and WebView2 versions and the kind of
  document open filled in (never names), plus the error when there is one.
- **DBML editor** (Monaco):
  - Highlighting and autocomplete for tables, columns, settings and enums (Ctrl+Space).
  - Go to definition (F12 / Ctrl+click) and find usages (Shift+F12).
  - Editing re-renders the diagram. Errors show inline while the last valid diagram stays on screen.
- **Edit on the canvas.** Every action below is one undo step (Ctrl+Z / Ctrl+Shift+Z), even with focus on the canvas.
  - Double-click a table header or a column to rename it.
  - Right-click a table for header colour, add column, hide, show only it and its directly related
    tables, browse or profile data, add to query, sample data, reveal in editor and copy name.
  - Right-click the background for a new table.
  - Select several tables with Shift/Ctrl+click or by Shift+dragging a box on the background
    (Ctrl+A selects all, Esc clears). Dragging one moves them all; right-click to hide them, show
    only them, or show only them and their directly related tables.
  - Drag from a column's connector dot to another table's column to add a `Ref`.
- **Big schemas**:
  - Ctrl+K / Ctrl+P palette: fuzzy search over tables, columns and commands.
  - A minimap.
  - Detail levels: all columns, keys only, names only.
  - Focus mode (F): fades tables more than one hop from the selection.
  - Saved views stored as DBML `DiagramView` blocks.
  - **Find modules**: groups the tables by how they work together (X-ray's join traffic on
    PostgreSQL, else the declared relationships), in a layout of its own next to yours. Accepted
    modules become coloured `TableGroup`s, and a click on one opens it as a saved view (see below).
  - **Join paths**: select two tables (click, Shift+click) and **Show join path**, or type
    `path orders → users` in the palette: the best ways to join them, highlighted with the rest
    dimmed, and **Copy as SQL** (see below).
  - Parallel edge lanes so relationships sharing a side don't overlap.
  - Hundreds of tables stay smooth: parsing, completion and layout run off the main thread, and
    the canvas draws only what is on screen, in less detail when zoomed out (see below).
- **Data browser** (read-only, every engine), a bottom drawer with three views:
  - **Rows:** paging, sorting and filters. Foreign-key values are links to the parent row,
    "Referenced by" opens the child rows, and a breadcrumb trail lets you go back. Right-click a row
    to follow a key, copy a value, copy the row as JSON or show its related data.
  - **Filters** (see "Filtering rows" below): a bar of chips, a filter box per column, Filter by
    from any cell, AND/OR groups, operators that fit each column's type, periods such as "this week",
    and a count of the matching rows. Each table's filter and sort are remembered per database.
    - Search all columns, with the matches highlighted, or type the whole filter as one line of
      text with suggestions.
    - Pick values from a list with their counts, or a referenced row by its name.
    - Save named filters, copy the filter or the rows as SQL, and export the rows as CSV or JSON.
    - Filter by related rows ("users with no orders", "with at least 3 orders over 100"), compare
      two columns, find duplicates and orphans, and narrow with facets.
  - **Sorting:** click a header to sort, Shift+click to sort by several columns. The primary key is
    always added last, so pages never repeat or skip rows.
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
    - Pick columns, choose INNER or LEFT joins, and copy the SQL in the connection's dialect.
    - Filter with the same bar, text box and column boxes as the Rows view, on any joined table's
      columns (`alias.column`). Opening Query from a filtered table starts from that table and filter.
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
- **Per database / file**: table positions, hidden tables, viewport and detail level are remembered,
  and the Modules layout next to yours.
- **Your DBML on a database tab is kept.** Header colours, saved views, groups, notes and refs
  you add stay with that database, also after closing the tab or the app (there is nothing to
  save). On **Refresh**, or the next time you connect, what changed in the database is merged
  into your text (three-way, line by line, against the schema as last read). A banner then says
  what changed, with a **Details** list (tables, columns, relationships; indexes are not compared).
  Where you and the database changed the same lines, the database's version is kept and Details
  shows your lines so you can copy them back. **Discard DBML edits** (palette) goes back to the
  database's schema.
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
- **AI agents (MCP)**: `xdiagram-mcp`, a Model Context Protocol server installed with the app, lets
  Claude Code, Claude Desktop and other MCP clients read the connections you open to them: the schema
  as DBML, rows, counts, profiles, join paths and X-ray. Read-only, with personal data masked by
  default (see below).

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
- **Report a problem** sends nothing: it opens the issue form in your browser, where you read it
  (and remove anything private from a copied error) before submitting it, or not.

## Filtering rows

Filters live in a bar above the grid. Each condition or group is a chip:

- **Click** a chip to edit it, **tick** it to switch it off without losing it, **×** to remove it.
- **All of / Any of** sets how the chips combine. **+ Group** adds conditions of which any (or
  all) must match.
- Chips that came from following a foreign key are dashed. Chips the database rejected are red,
  with the reason.

The editor offers the operators that fit the column:

| Column | Operators |
|---|---|
| Numbers, dates, times | =, ≠, <, ≤, >, ≥, between, one of, none of |
| Dates and timestamps | also **is in** a period: today, yesterday, this week (from Monday), this month, this year, the last N days, a given day |
| Text | =, ≠, contains, does not contain, starts with, ends with, one of, is empty, is blank, has extra spaces, matches regex (PostgreSQL, MySQL); **Aa** makes matching case-sensitive |
| Enums, booleans | a list of the allowed values |
| Any nullable column | is null, is not null |

**Column boxes.** Each column's box under the header takes a short syntax (Enter applies, an empty
box removes that column's filter):

| Type | Means |
|---|---|
| `abc` | equals |
| `!=x` | not equal |
| `>5` `>=5` `<5` `<=5` | compare |
| `10..20` `10..` `..20` | between, at least, at most |
| `~x` `!~x` | contains, does not contain |
| `^x` `*x` | starts with, ends with |
| `/re/` | regular expression |
| `null` `!null` | is null, is not null |
| `''` | is empty |
| `"NULL"` | the text NULL (quotes make any value literal) |
| `1,2,3` `!1,2` | one of, none of (not for text columns, whose values may contain commas) |
| `today` `thisweek` `last7d` | a period (date columns) |
| `>-7d` `<-2h` | relative to now: h, d, w, mo, y |
| `2026-11-14` | that whole day (timestamp columns) |

**From the grid.**
- Right-click a cell: **Filter by** that value (=, ≠, <, >, or is null).
- Ctrl+click cells of one column, then right-click: **is one of** the picked values.
- Right-click a header: sort, then by this column, Filter…, clear the column's filter.

**Search all columns.** The box at the end of the bar finds rows where any column holds the text.
Text, enum and JSON columns are matched with "contains". Number, date and UUID columns are matched
exactly when the text is one of their values, so an index can help. Matches are highlighted in the
grid, and so are the values of contains, starts with, ends with and = conditions in their column.

**As text.** **Text** opens the whole filter as one line, for example
`role = admin and (created_at: last 7 days or email ~ gmail)`.

- Enter applies, Esc undoes the edit, and Ctrl+Space suggests columns, operators that fit the
  column, values and periods.
- A mistake is underlined where it is, with the reason, and nothing is applied.
- The chips and the text are two views of the same filter. Switched-off chips are not in the text
  and stay switched off.
- An empty box offers the expressions used before in this database.

| Write | Means |
|---|---|
| `col = v` `!=` `<` `<=` `>` `>=` | compare |
| `col ~ v` `!~` `^=` `$=` | contains, does not contain, starts with, ends with (add `cs` for case-sensitive) |
| `col matches v` | regular expression |
| `col in (a, b)` `col not in (a, b)` | one of, none of |
| `col between a and b` | between |
| `col is null` `is not null` `is empty` `is blank` `is padded` | null, empty, only spaces, extra spaces |
| `col: today` `this week` `last 30 days` `2026-11-14` | a period |
| `any ~ v` | search all columns |
| `has orders` `no orders` | rows with some / no related rows |
| `count(orders) >= 3` | a number of related rows (=, !=, <, <=, >, >=) |
| `has orders(total > 100)` | only related rows that match count; inside, names are the related table's |
| ``ends_on < `starts_on` `` | another column of the same row (back quotes on the right) |
| `dup(email, org_id)` | values that occur in more than one row |
| `not (…)` `and` `or` `( )` | combine (`and` binds tighter than `or`) |

Values can be bare (`admin`, `42`, `-7d` for seven days ago) or quoted with `'…'` or `"…"`; column
names that need it go in back quotes.

**Picking values.** In the condition editor:

- **Values** lists the column's values among the rows the rest of the filter matches, most frequent
  first, with their counts.
  - Click one to use it, or tick several for "is one of". NULL makes the condition "is null".
  - A find box narrows the list; numbers and dates also show their smallest and largest value.
  - It counts at most the first 200,000 matching rows and says so.
- On a foreign-key column, a second button (for example **users**) lists the referenced table's rows
  as key and name, to pick one by its name. The column shown as the name can be changed and is
  remembered for that table.
- Date columns have a calendar. A day picked for `=` on a timestamp means that whole day.

**Related rows.** **+ Related** filters rows by their rows in a related table: rows that have, have
no, or have at least / at most / exactly N related rows. Conditions on the related table's own
columns narrow which related rows count.
- Relationships come from the diagram (declared and X-ray's). Tables pointing here are named after
  themselves (`orders`); tables this one points at are named after the key column (`org` for
  `org_id`). Composite keys and a table related to itself work.
- **Related rows of these…** in the footer opens a related table filtered to the rows related to
  every row that matches here, not just one: the memberships of these users, then their
  organizations. Each is a step of the trail; its dashed chip is not remembered for that table.
- They run as `EXISTS` / `NOT EXISTS` or a correlated `COUNT(*)`, nested up to three levels.

**Two columns.** In the editor, **vs column** compares a column with another of the same row
(`ends_on < starts_on`). Only columns of a comparable type are offered; a NULL on either side
matches nothing.

**Checks.** **Checks ▾** has ready-made data checks:
- **Duplicate values**: tick the columns whose values repeat. It counts over the whole table, and
  a NULL is never a duplicate.
- **Orphans**: a key that is set but points at no row.
- **Without any …**: rows nothing points at.
- **Empty or blank text**, and **text with extra spaces**.

**Facets.** **Facets** opens a panel beside the grid. For a few columns (by default the enums,
booleans and foreign keys) it shows their most frequent values among the matching rows, with counts.
- Tick values to filter the column to them. A column's counts leave out its own condition, so its
  other values stay visible.
- Facets can be added and removed per table, and the choice is remembered.

**A whole-table read (PostgreSQL).** For a table of 10,000 rows or more, counting also asks
PostgreSQL how it would run the filter (`EXPLAIN`, nothing runs). If it would read the whole table
because no index serves the filter, the footer says "reads all ~N rows" and links to X-ray's index
advice.

**Saved filters.** **★ Saved** keeps named filters per table, conditions and sort together. The one
matching what is shown is marked, and its tooltip spells it out. They are kept with the remembered
filters of the database.

**Copy and export.** **Copy / Export** offers:

- **Copy the filter as text:** the line the text box shows.
- **Copy the rows as SQL:** one SELECT with the filter's values written in, escaped for the engine,
  ready to run in its own client.
- **Export rows as CSV / JSON:** all matching rows (the first 50,000), sorted, with whole values
  instead of the grid's shortened ones.
  - CSV follows RFC 4180: NULL is an empty field, and an empty text is `""`.
  - JSON is an array of objects.

**How values are compared.** A value is converted to the column's type, never the column to text,
so an index on the column can serve the filter.
- A value that cannot match its column (`abc` for a number, a date that does not exist) is
  reported on its chip before anything is sent.
- Text matching (contains, …) is case-insensitive by default: `ILIKE` on PostgreSQL, the column's
  collation on MySQL and SQL Server, `LIKE` on SQLite (ASCII only). `%` and `_` in a value are
  literal.
- Periods use your computer's local time. `between` with two dates on a timestamp column includes
  all of the second day.
- SQL semantics apply: "does not equal", "none of" and switched groups do not match NULL.

**Counting.** After a page loads, the footer shows how many rows match (up to 100,000, shown as
"100,000+") or that counting took too long. The count runs within the same time limit as the
query.

**Remembered.** The last filter and sort of every table are kept per database and come back when
the table is opened again, also after a restart. Conditions that came from following a foreign key
are not kept. If a remembered condition names a column that no longer exists, it is switched off
and the rows load without it.

Filtering is read-only like the rest of the browser. Values are always bound parameters, columns are
checked against the live table, and operators come from a fixed list. There is no free SQL box.

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
npm run test:scripts   # tests of the release and build scripts
cd src-tauri && cargo test --workspace   # Rust tests, the app and src-tauri/crates/*
```

The Rust side is a workspace: the app (`src-tauri`), its Tauri-free database layer
(`crates/xdiagram-core`), the join-path engine (`crates/join-paths`) and the MCP server
(`crates/xdiagram-mcp`, see "AI agents (MCP)").

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

- **PostgreSQL** (`src-tauri/crates/xdiagram-core/src/db/introspect.rs`) is a port of the connector's queries.
- **MySQL / MariaDB** (`mysql.rs`) is a port of the connector's queries. It reads the connection's
  database.
- **SQL Server** (`mssql.rs`) is a port of the connector's queries. It supports SQL logins;
  Windows integrated auth is not supported.
- **SQLite** (`sqlite.rs`) has no connector to port. It reads `sqlite_master` and the table
  PRAGMAs, and opens the file read-only. CHECK constraints are not read, because SQLite keeps
  them only inside the `CREATE TABLE` text.

`src-tauri/crates/xdiagram-core/src/db/dispatch.rs` routes each command to the right engine. The port differs from the
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
- **Tunnels** (`src-tauri/crates/xdiagram-core/src/db/ssh.rs`, russh) listen on `127.0.0.1` only. They are shared by
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

## Finding modules

At a few hundred tables any diagram is a wall, and grouping by schema or name prefix says how the
database was named, not how it works. **Find modules** (View menu, the palette, or the Modules tab
of the side panel) groups the tables that work together:

- **The graph.** Tables are nodes. On PostgreSQL the edges are weighted by how often the tables
  are joined in `pg_stat_statements` (X-ray's analysis, read-only; it runs for Find modules even
  with the X-ray overlay off), plus a fixed weight for each declared relationship, so traffic shifts
  the weights without drowning the structure. Without the extension, and on MySQL, SQL Server,
  SQLite and `.dbml` files, the declared relationships are used alone; the panel says which.
- **The modules** are Louvain communities on that graph, split into connected parts, with tiny ones
  joined to their closest neighbour. The algorithm is deterministic: the same schema always gives
  the same modules, and they are only recomputed when you ask. Coarser / Normal / Finer changes
  their size.
- **Common tables.** Tables linked to far more tables than the rest (`users`, `tenants`) would pull
  every module into one. They are left out of the calculation and shown in their own zone. A table
  whose links mostly stay in one module is that module's centre instead (`products` with its
  images and prices). You can make a table common, or put a detected one back, in the panel.
  Tables linked only to a common table form that table's own module.
- **Names** come from each module's central table (the one with the most links inside it), made
  unique; rename them and change their colours in the panel.

The modules come in a **layout of their own**: each module laid out on its own and packed with the
modules it is most linked to, common tables in a strip on top, each module in a coloured zone.
View → Layout switches between it and **My layout**, which is never changed; each keeps its
viewport, and Auto-arrange on the Modules layout lays the modules out again. Far out, each zone
shows its name in large type.

Until you **Accept**, nothing is in the DBML. Accept writes the modules as `TableGroup` blocks
with their colour, in one undoable edit:

- Existing TableGroups are kept. **Find** only adds new tables to them, so the modules stay stable
  as the schema grows. **Recompute all** recomputes everything; modules that overlap an existing
  group continue it (same name and colour), and the panel lists the tables that would move and the
  groups that would be removed.
- Existing groups are edited in place (notes and comments kept); members written as aliases are
  left alone, and the result is checked by parsing it before anything is written.
- **Reject** discards the proposal and goes back to the modules accepted before, if any.

A click on a zone's name opens that module as a saved view: the `DiagramView` of the same name, or
a new one with the module's tables and the common tables they link to.

On the 300-table bench schema (as a `.dbml` file, declared relationships only), finding and laying
out the modules takes about 0.2 s; it finds ten modules that follow the schemas the synthetic
foreign keys were planted in.

Code: `src/app/modules/` (graph, common tables, Louvain, modules, packing and TableGroup text, all
pure and unit-tested), `src/app/state/modules.store.ts`, `src/app/state/arrangements.ts` and
`src/app/sidebar/modules-panel.component.ts`.

## Join paths

"How do I get from `invoice_lines` to `users`?" Select the two tables (click the first, Shift+click
the second), right-click, **Show join path**. Or right-click one table, **Find join path to…**, and
type the other; or type `path invoice_lines → users` (`->` and `>` work too) in the palette.

- **Up to 3 routes, at most 6 joins each**, best first. The route shown is lit and the rest of the
  diagram is dimmed. ◀ ▶ (or ← →) go through the others, ⇄ swaps the ends, Esc or ✕ leaves.
- **The bar under it lists each join**: its cardinality in the walking direction (`N:1`, `1:N`) and
  its columns. When two tables are linked by several foreign keys (`created_by`, `updated_by`), they
  are one step with a choice of relationship, not separate routes, so they cannot hide a really
  different route. ⊘ on a table in the middle searches again without it.
- **Joins seen in the queries** (X-ray, PostgreSQL) count too, marked "from queries" with their
  calls; **Joins from queries** turns them off. Without X-ray the declared relationships are used,
  on every engine and on `.dbml` files. Nothing is read from the database for this: only a traffic
  report already loaded (X-ray's, or Find modules') is used.
- **No route:** the bar says why. The tables are not connected, or only through the tables you
  avoid, or the shortest route needs more than 6 joins.
- **Hidden tables** are searched too; when a route goes through one, the bar offers to show it.
- **Copy as SQL** copies the skeleton, never runs it:

  ```sql
  SELECT "il".*, "u".*
  FROM "billing"."invoice_lines" AS "il"
  JOIN "billing"."invoices" AS "i" ON "i"."id" = "il"."invoice_id"
  JOIN "organizations" AS "o" ON "o"."id" = "i"."org_id"
  JOIN "memberships" AS "m" ON "m"."org_id" = "o"."id"
  JOIN "users" AS "u" ON "u"."id" = "m"."user_id"
  ```

  Identifiers are quoted for the database's engine (a file: its import dialect, else PostgreSQL's),
  with the relationship chosen for each step. A join that only the queries show gets a comment.

How routes are ranked (cost, lowest first):

- A declared foreign key costs 0.8–1.0, less when the queries use it often. A join seen only in the
  queries costs 1.2–2.4, less the more it runs: one busy discovered join beats two declared hops,
  a rare one does not.
- A table in the middle of a route with more than 8 neighbours adds 0.5 per doubling (0.5 at 16,
  1.0 at 32): routes through `users` or `tenants` are valid, but rarely the one meant.
- Ties go to fewer joins, then to the table names, so the same schema always gives the same answer.

The engine is a separate Rust crate, `src-tauri/crates/join-paths`, with no Tauri or database
dependency, so other tools can use it. The frontend sends it the graph (tables and relationships
from the DBML, plus X-ray's joins); it never parses DBML. It runs Yen's k shortest simple paths over
the links between tables, each shortest path computed layer by layer up to the join limit.

On 1000 tables and 2861 relationships, a search takes about 2 ms in the engine and 24 ms (35 ms at
worst) through the app's IPC, most of it sending the graph (release build).

Code: `src-tauri/crates/join-paths` (graph, costs, search, SQL; unit-tested, with a timing test run
by `cargo test -p join-paths --release -- --ignored`), `src/app/paths/` and
`src/app/state/join-path.store.ts`.

## AI agents (MCP)

`xdiagram-mcp` (installed next to `xdiagram.exe`) is a [Model Context Protocol](https://modelcontextprotocol.io)
server. MCP clients such as Claude Code and Claude Desktop start it themselves and talk to it over
stdio, so the app does not need to be open. It uses the connections saved in xdiagram, with the
passwords the app keeps in the keychain, and it reads the same way the data browser does: read-only,
and only SELECTs it builds itself.

### Setting it up

1. **Open a connection to agents.** Connect, pick the connection, tick **Let AI agents use this
   connection (MCP)**, choose what agents may read, and press **Connect** (that saves it). Connections
   are closed to agents until you do this. Agents use the password saved in the keychain, so keep
   **Remember password** ticked.
2. **Add the server to your client.** Settings → **AI agents** shows where the server is.
   **Copy Claude Code command** gives a command to run in a terminal:

   ```sh
   claude mcp add --scope user xdiagram -- "<path to>\xdiagram-mcp.exe"
   ```

   **Copy JSON configuration** gives the `mcpServers` entry for clients that have a configuration
   file (Claude Desktop: `claude_desktop_config.json`).

Turning a connection on or off applies at once: the server reads the app's files on every call.

### What agents can do

| Tool | What it does |
|---|---|
| `list_connections` | The connections open to agents, with their engine, scope and data access |
| `list_schemas`, `list_tables` | Schemas, then tables with their column counts, notes and neighbours |
| `get_schema_dbml` | The schema as DBML, as the editor shows it; for big schemas, chosen tables and their neighbours |
| `describe_table` | One table: columns, kinds, keys, row estimate, its DBML and relationships |
| `get_saved_dbml` | The DBML the app keeps for the database, with your notes, groups and views |
| `browse_rows`, `count_rows` | Rows a page at a time, and counts, with the data browser's filters |
| `value_counts`, `profile_table` | A column's values with their counts; per-column statistics from a sample |
| `find_join_paths`, `run_join_query` | The best ways to join two tables, and rows across joined tables |
| `xray_report`, `check_relation` | PostgreSQL: X-ray's report, and whether an undeclared relationship holds |

Filters are the tree the app sends to its Rust side (every condition type: comparisons, lists, text
matching, searches, column-vs-column, duplicates and related rows); `browse_rows` describes it. The
DBML comes from the Rust port of `generateDbml` (`xdiagram-core/src/dbml.rs`), checked against
`@dbml/core` by `cargo test` and `npm run parity`.

Replies stay under 60,000 characters, as clients cap tool output (Claude Code at 25,000 tokens by
default): a page of rows that would be larger carries the rows that fit and says where the next page
starts, a long saved DBML comes in parts, and a table list, DBML selection, profile or X-ray report
that is too large drops its least useful part first or asks for a narrower request.

### What agents may read

Each connection is set to one of:

- **The schema only**: tables, columns, keys, relationships, join paths and the X-ray report. No tool
  reads rows.
- **Rows, with personal data masked** (the default): a column is masked when its name suggests
  personal or secret data (`email`, `phone`, `password`, `dob`, `iban`, names, addresses…) or when
  most of its values look like emails, card numbers (Luhn-checked), IBANs, phone numbers or IP
  addresses; any other single value that looks like an email, card number, IBAN or phone number is
  masked too. Masked values read `[masked: kind]`. Profiles mask the values of such columns, and
  `value_counts` refuses them.
- **Rows as they are.**

Masking catches most personal data, not all, and it is not a security boundary: an agent can still
filter on a masked column (for example, ask whether some email exists). Share sensitive databases as
schema only, or connect with a login that cannot read those tables.

### Safety

- Only connections you turned on exist for the server, and each keeps the app's scope: its schema
  list, and on MySQL only its database.
- Reads are as read-only as in the app (see the top of this README). SQL Server has no read-only
  session mode, so there the guarantee is that only generated SELECTs run; a `db_datareader` login
  adds a second line.
- The server never runs SQL from the agent. SQL it returns (`include_sql`, join path skeletons, index
  advice, the `ALTER TABLE` of `check_relation`) is text.
- Passwords never leave the Rust side. Without a saved password, or for an SSH server whose host key
  you have not accepted in the app, the error says what to do; the server never accepts host keys.
- It reads the app's files and never writes them. Each call has the query time limit from Settings
  and stops when the client cancels it.
- Close the MCP client before updating xdiagram: while it runs, `xdiagram-mcp.exe` is in use and the
  installer cannot replace it.

### Development

```sh
cd src-tauri
cargo build -p xdiagram-mcp   # target/debug/xdiagram-mcp.exe; Settings finds it next to the dev app
cargo test -p xdiagram-mcp    # unit tests, and the server over stdio against SQLite copies of the sample
XDIAGRAM_TEST_PG=postgres://postgres:xdiagram@127.0.0.1:55432/postgres \
  cargo test -p xdiagram-mcp --test postgres -- --ignored   # every tool against the test container
npx @modelcontextprotocol/inspector target/debug/xdiagram-mcp.exe --data-dir <folder>
```

`--data-dir` (or `XDIAGRAM_DATA_DIR`) points the server at a folder other than the app's, such as one
with a test `connections.json`. The PostgreSQL test needs the X-ray workload (see "Checking the
introspection"); it saves the password in the keychain under a throwaway id and deletes it afterwards.

- `src-tauri/crates/xdiagram-mcp/src/server.rs` — the server and the connection tools
- `src-tauri/crates/xdiagram-mcp/src/access.rs` — which connections, scope, time limits, errors
- `src-tauri/crates/xdiagram-mcp/src/{schema,data,path}_tools.rs` — the other tools
- `src-tauri/crates/xdiagram-mcp/src/mask.rs` — masking
- `src-tauri/crates/xdiagram-core/src/profiles.rs` — the saved connections, read as the app writes them

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
   first. The script builds the MCP server (`scripts/build-mcp.mjs`), which
   `src-tauri/tauri.release.conf.json` bundles next to the app, then signs the installers and writes
   `src-tauri/target/release/bundle/latest.json`.
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

- `src-tauri/crates/xdiagram-core/src/db/workload.rs` — SQL analysis, unit-tested
- `workload_db.rs` — catalog queries
- `advisor.rs` — data checks and index advice
- `src-tauri/src/live.rs` — sampling session
- `src/app/state/workload.store.ts` and `src/app/sidebar/workload-panel.component.ts` — UI

## Checking the introspection

`scripts/parity.mjs` runs the Rust introspection and `@dbml/connector` against the same database. It
diffs the JSON and the generated DBML, and checks that the DBML parses. It also checks that the Rust
DBML writer (`xdiagram-core/src/dbml.rs`, used by the MCP server) writes exactly what
`generateDbml` writes:

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
SQLite sample, see the first line of `scripts/sample-schema.sqlite.sql`. SQLite has no connector, so
`npm run parity -- --engine sqlite <file>` runs only the DBML checks.

The Rust DBML writer is also unit-tested against `@dbml/core` without a database: `cargo test`
compares it with the `.dbml` files next to the schema fixtures in `xdiagram-core/tests/dbml`, which
`node scripts/dbml-fixtures.mjs` regenerates.

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

## License

Copyright (C) 2026 the xdiagram authors.

xdiagram is free software: you can redistribute it and/or modify it under the terms of the GNU
Affero General Public License as published by the Free Software Foundation, either version 3 of
the License, or (at your option) any later version. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

This covers the whole repository, the join-path engine in `src-tauri/crates/join-paths` included.
The libraries xdiagram is built on keep their own licenses (MIT, Apache-2.0, ISC; ELK is used under
its GPL-3.0-or-later option); About xdiagram lists them.
