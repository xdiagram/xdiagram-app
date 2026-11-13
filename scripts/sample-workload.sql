-- A representative application workload for X-ray mode. Run it repeatedly while the app is open:
--   for i in $(seq 30); do docker exec -i xdiagram-pg psql -U postgres -q < scripts/sample-workload.sql; done
--
-- What it exercises:
--   * undeclared relationships (events has no foreign keys): events -> users, events -> organizations
--   * declared relationships: memberships -> users/organizations, invoice_lines -> invoices
--   * join shapes the analyser must understand: ON, implicit WHERE join, CTE, correlated EXISTS, UPDATE ... FROM
--   * writes on events (live activity) and a sequential scan on it (seq-scan-heavy flag)
--   * never: a join on project_members.project_id, or any access to legacy_notes

-- Undeclared relationships -----------------------------------------------------------------
SELECT e.id, u.email
FROM public.events e
JOIN public.users u ON u.id = e.user_id
WHERE e.kind = 'login'
LIMIT 50;

SELECT count(*)
FROM public.events e, public.organizations o
WHERE o.id = e.org_id AND o.slug = 'org-1';

-- Declared relationships -------------------------------------------------------------------
SELECT u.email, o.name
FROM public.memberships m
JOIN public.users u ON u.id = m.user_id
JOIN public.organizations o ON o.id = m.org_id
LIMIT 20;

SELECT i.id, sum(l.unit_price * l.quantity) AS total
FROM billing.invoices i
JOIN billing.invoice_lines l ON l.invoice_id = i.id
GROUP BY i.id
LIMIT 10;

-- CTE + correlated subquery ----------------------------------------------------------------
WITH active AS (
  SELECT user_id FROM public.events WHERE at > now() - interval '1 day'
)
SELECT u.id
FROM public.users u
WHERE EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id AND m.org_id = 1)
  AND u.id IN (SELECT user_id FROM active)
LIMIT 20;

-- UPDATE ... FROM --------------------------------------------------------------------------
UPDATE public.events e
SET kind = e.kind
FROM public.users u
WHERE u.id = e.user_id AND u.id = 1;

-- Writes -----------------------------------------------------------------------------------
INSERT INTO public.events (user_id, org_id, kind)
  SELECT 1 + (g % 2000), 1 + (g % 50), 'view' FROM generate_series(1, 200) g;

UPDATE public.events SET kind = 'edit'
WHERE id IN (SELECT id FROM public.events ORDER BY id DESC LIMIT 50);

DELETE FROM public.events
WHERE id IN (SELECT id FROM public.events ORDER BY id ASC LIMIT 20);

-- Selective filter without an index (the advisor suggests one on events.external_ref) -------
SELECT id, kind FROM public.events WHERE external_ref = 'ref-' || (1 + floor(random() * 20000))::int;

-- Sequential scan on the biggest table (no index on kind) -----------------------------------
SELECT count(*) FROM public.events WHERE kind = 'edit';
