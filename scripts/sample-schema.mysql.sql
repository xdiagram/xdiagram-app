-- MySQL / MariaDB sample for parity checks (database `shop`).
DROP DATABASE IF EXISTS shop;
CREATE DATABASE shop;
USE shop;

CREATE TABLE users (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL UNIQUE COMMENT 'Login e-mail',
  full_name   VARCHAR(120),
  role        ENUM('admin','member','guest') NOT NULL DEFAULT 'member',
  login_count INT NOT NULL DEFAULT 0 CHECK (login_count >= 0),
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  name_upper  VARCHAR(120) GENERATED ALWAYS AS (UPPER(full_name)) VIRTUAL
) COMMENT = 'Application accounts';

CREATE TABLE organizations (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  name  VARCHAR(120) NOT NULL,
  slug  VARCHAR(60) NOT NULL,
  UNIQUE KEY organizations_name_slug (name, slug)
);
CREATE INDEX organizations_slug_prefix ON organizations (slug(10));
CREATE INDEX organizations_lower_name ON organizations ((LOWER(name)));

CREATE TABLE memberships (
  org_id    INT NOT NULL,
  user_id   BIGINT NOT NULL,
  joined_at DATE NOT NULL,
  PRIMARY KEY (org_id, user_id),
  CONSTRAINT memberships_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT memberships_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE TABLE projects (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  org_id    INT NOT NULL,
  name      VARCHAR(200) NOT NULL,
  budget    DECIMAL(12,2) DEFAULT 0.00,
  starts_on DATE,
  ends_on   DATE,
  CONSTRAINT projects_dates_chk CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT projects_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id)
);
CREATE INDEX projects_name_idx ON projects (name);

CREATE TABLE project_members (
  project_id INT NOT NULL,
  org_id     INT NOT NULL,
  user_id    BIGINT NOT NULL,
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT pm_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT pm_membership_fk FOREIGN KEY (org_id, user_id) REFERENCES memberships(org_id, user_id)
);

INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme'), ('Globex', 'globex');
INSERT INTO users (email, full_name, role) VALUES ('ann@x.io', 'Ann', 'admin'), ('bob@x.io', 'Bob', 'member'), ('cid@x.io', NULL, 'guest');
INSERT INTO memberships VALUES (1, 1, '2026-01-01'), (1, 2, '2026-02-01'), (2, 2, '2026-03-01');
