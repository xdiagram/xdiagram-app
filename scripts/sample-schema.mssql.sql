-- SQL Server sample for parity checks (database `shop`, schemas dbo and sales).
IF DB_ID('shop') IS NOT NULL BEGIN ALTER DATABASE shop SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE shop; END;
GO
CREATE DATABASE shop;
GO
USE shop;
GO
CREATE SCHEMA sales;
GO
CREATE TABLE dbo.users (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  email       NVARCHAR(255) NOT NULL UNIQUE,
  full_name   NVARCHAR(120) NULL,
  bio         NVARCHAR(MAX) NULL,
  login_count INT NOT NULL CONSTRAINT users_login_count_df DEFAULT ((0)) CONSTRAINT users_login_count_chk CHECK (login_count >= 0),
  status      VARCHAR(20) NOT NULL DEFAULT ('active'),
  created_at  DATETIME2 NOT NULL DEFAULT (SYSUTCDATETIME()),
  is_active   BIT NOT NULL DEFAULT ((1))
);
EXEC sp_addextendedproperty 'MS_Description', 'Application accounts', 'SCHEMA', 'dbo', 'TABLE', 'users';
EXEC sp_addextendedproperty 'MS_Description', 'Login e-mail', 'SCHEMA', 'dbo', 'TABLE', 'users', 'COLUMN', 'email';
GO
CREATE TABLE dbo.organizations (
  id   INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(120) NOT NULL,
  slug VARCHAR(60) NOT NULL
);
CREATE NONCLUSTERED INDEX organizations_slug_idx ON dbo.organizations (slug);
GO
CREATE TABLE dbo.memberships (
  org_id    INT NOT NULL REFERENCES dbo.organizations(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES dbo.users(id),
  joined_at DATE NOT NULL,
  CONSTRAINT memberships_pk PRIMARY KEY (org_id, user_id)
);
GO
CREATE TABLE sales.invoices (
  id         UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
  org_id     INT NULL,
  amount     DECIMAL(10,2) NOT NULL,
  currency   CHAR(3) NOT NULL DEFAULT ('EUR'),
  issued_at  DATETIME NULL,
  CONSTRAINT invoices_org_fk FOREIGN KEY (org_id) REFERENCES dbo.organizations(id) ON DELETE SET NULL,
  CONSTRAINT invoices_amount_chk CHECK (amount >= 0)
);
GO
CREATE TABLE sales.invoice_lines (
  invoice_id  UNIQUEIDENTIFIER NOT NULL REFERENCES sales.invoices(id) ON DELETE CASCADE,
  line_no     SMALLINT NOT NULL,
  description NVARCHAR(400) NOT NULL,
  quantity    INT NOT NULL DEFAULT ((1)),
  unit_price  MONEY NOT NULL,
  CONSTRAINT invoice_lines_pk PRIMARY KEY (invoice_id, line_no)
);
GO
INSERT INTO dbo.organizations (name, slug) VALUES (N'Acme', 'acme'), (N'Globex', 'globex');
INSERT INTO dbo.users (email, full_name) VALUES (N'ann@x.io', N'Ann'), (N'bob@x.io', N'Bob');
INSERT INTO dbo.memberships VALUES (1, 1, '2026-01-01'), (2, 2, '2026-02-01');
INSERT INTO sales.invoices (org_id, amount) VALUES (1, 120.50), (NULL, 9.99);
GO
