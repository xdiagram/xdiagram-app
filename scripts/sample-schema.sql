-- Sample schema exercising the introspection edge cases (used for parity checks and demos).
DROP SCHEMA IF EXISTS billing CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA billing;

CREATE TYPE public.user_role AS ENUM ('admin', 'member', 'guest');
CREATE TYPE billing.invoice_status AS ENUM ('draft', 'sent', 'paid', 'void');

CREATE TABLE public.users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       varchar(255) NOT NULL UNIQUE,
  full_name   text,
  role        public.user_role NOT NULL DEFAULT 'member',
  tags        text[] DEFAULT ARRAY['new'::text, 'trial'::text],
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  login_count integer NOT NULL DEFAULT 0 CHECK (login_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.users IS 'Application accounts';
-- Regression: expressions containing commas. @dbml/connector split these on ',' into duplicate
-- fragments, and generateDbml failed with "Index column '*'::text) existed".
CREATE INDEX users_name_email_idx ON public.users (COALESCE(full_name, '*'::text), role, COALESCE(email::text, '*'::text));
COMMENT ON COLUMN public.users.email IS 'Login e-mail, unique';

CREATE TABLE public.organizations (
  id    serial PRIMARY KEY,
  name  varchar(120) NOT NULL,
  slug  varchar(60) NOT NULL
);
CREATE UNIQUE INDEX organizations_lower_slug_idx ON public.organizations (lower(slug));

CREATE TABLE public.memberships (
  org_id   integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id  bigint  NOT NULL REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  joined_at date NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE public.projects (
  id         serial PRIMARY KEY,
  org_id     integer NOT NULL REFERENCES public.organizations(id),
  name       varchar(200) NOT NULL,
  budget     numeric(12,2) DEFAULT 0.00,
  starts_on  date,
  ends_on    date,
  CONSTRAINT projects_dates_chk CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX projects_org_name_key ON public.projects (org_id, name);
CREATE INDEX projects_name_idx ON public.projects USING btree (name);
-- Advisor fixture: an exact duplicate of projects_name_idx.
CREATE INDEX projects_name_dup_idx ON public.projects USING btree (name);

CREATE TABLE public.project_members (
  project_id integer NOT NULL REFERENCES public.projects(id),
  org_id     integer NOT NULL,
  user_id    bigint  NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES public.memberships(org_id, user_id)
);

CREATE TABLE billing.invoices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     integer NOT NULL REFERENCES public.organizations(id),
  status     billing.invoice_status NOT NULL DEFAULT 'draft',
  amount     numeric(10,2) NOT NULL CHECK (amount >= 0),
  currency   char(3) NOT NULL DEFAULT 'EUR',
  issued_at  timestamp
);
COMMENT ON TABLE billing.invoices IS 'Invoices issued to organizations';

CREATE TABLE billing.invoice_lines (
  invoice_id  uuid NOT NULL REFERENCES billing.invoices(id) ON DELETE CASCADE,
  line_no     smallint NOT NULL,
  description text NOT NULL,
  quantity    integer NOT NULL DEFAULT 1,
  unit_price  numeric(10,2) NOT NULL,
  PRIMARY KEY (invoice_id, line_no)
);

-- X-ray fixtures: a table that queries join but that declares no foreign keys,
-- and a table that nothing ever reads or writes.
CREATE TABLE public.events (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id  bigint NOT NULL,
  org_id   integer,
  kind     varchar(40) NOT NULL,
  external_ref varchar(40),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.legacy_notes (
  id    serial PRIMARY KEY,
  body  text
);

-- Seed data, so that pg_stats has something to say (de facto cardinality, row estimates).
INSERT INTO public.organizations (name, slug)
  SELECT 'Org ' || g, 'org-' || g FROM generate_series(1, 50) g;
INSERT INTO public.users (email, full_name, role)
  SELECT 'user' || g || '@example.com', 'User ' || g,
         (ARRAY['admin', 'member', 'guest'])[1 + g % 3]::public.user_role
  FROM generate_series(1, 2000) g;
-- Every user belongs to exactly one organization: declared 1:N, de facto 1:1 from the users side.
INSERT INTO public.memberships (org_id, user_id)
  SELECT 1 + (g % 50), g FROM generate_series(1, 2000) g;
-- Only 20 of the 50 organizations have projects: 40% parent coverage.
INSERT INTO public.projects (org_id, name, budget)
  SELECT 1 + (g % 20), 'Project ' || g, (g * 100)::numeric FROM generate_series(1, 200) g;
INSERT INTO public.events (user_id, org_id, kind, external_ref)
  SELECT 1 + (g % 2000), 1 + (g % 50), (ARRAY['login', 'view', 'edit'])[1 + g % 3], 'ref-' || g
  FROM generate_series(1, 20000) g;
INSERT INTO billing.invoices (org_id, status, amount)
  SELECT 1 + (g % 50), 'sent', (g * 10)::numeric FROM generate_series(1, 500) g;
INSERT INTO billing.invoice_lines (invoice_id, line_no, description, quantity, unit_price)
  SELECT i.id, l, 'Line ' || l, 1, 9.99 FROM billing.invoices i, generate_series(1, 3) l;
ANALYZE;

-- Dropping schema "public" above also drops the pg_stat_statements view (X-ray mode reads it).
-- The module stays loaded, so the statistics survive; this just recreates the view.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
