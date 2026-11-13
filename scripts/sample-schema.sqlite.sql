-- SQLite sample (build with: python -c "import sqlite3,sys; sqlite3.connect(sys.argv[1]).executescript(open(sys.argv[2]).read())" shop.db scripts/sample-schema.sqlite.sql)
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'guest')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE organizations (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL
);
CREATE UNIQUE INDEX organizations_name_slug ON organizations (name, slug);
CREATE INDEX organizations_lower_slug ON organizations (lower(slug));

CREATE TABLE memberships (
  org_id    INTEGER NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users (id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE project_members (
  project_id INTEGER NOT NULL,
  org_id     INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id)
);

INSERT INTO organizations (id, name, slug) VALUES (1, 'Acme', 'acme'), (2, 'Globex', 'globex');
INSERT INTO users (email, full_name, role) VALUES ('ann@x.io', 'Ann', 'admin'), ('bob@x.io', 'Bob', 'member');
INSERT INTO memberships VALUES (1, 1, '2026-01-01'), (2, 2, '2026-02-01');
