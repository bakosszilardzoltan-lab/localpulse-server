-- audit_snapshots: per-run snapshot of numeric metrics + structured recommendations,
-- keyed by (user_id, tool_name, stable_key) so consecutive runs for the same
-- business/handle can be diffed. Mirrors the no-RLS, anon-key trust model
-- already used by public.generations -- see Task 2/3 report for the caveat.

create table if not exists public.audit_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  tool_name text not null,
  stable_key text not null,
  metrics jsonb not null default '{}'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  generation_id uuid
);

create index if not exists idx_audit_snapshots_lookup
  on public.audit_snapshots (user_id, tool_name, stable_key, created_at desc);
