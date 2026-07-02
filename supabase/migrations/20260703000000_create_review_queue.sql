-- Review Reply Approval Queue: agency creates AI-drafted review replies,
-- client approves/edits/regenerates/skips via a magic-link token with no
-- account needed. Unlike audit_snapshots/generations, this table is accessed
-- exclusively through the Express API using the Supabase SERVICE ROLE key,
-- so RLS is enabled and left deny-all -- there is no anon-key path into
-- these tables at all, by design (the magic-link token is verified in the
-- API layer, not by Postgres).

create table if not exists public.review_businesses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null,           -- Clerk user id of the agency user
  business_name text not null,
  business_type text,
  default_tone text default 'professional',
  default_language text default 'en',
  owner_sign_name text,
  approval_token text unique not null,   -- random 32+ char token for the magic link
  created_at timestamptz not null default now()
);

create index if not exists idx_review_businesses_owner
  on public.review_businesses (owner_user_id);

create unique index if not exists idx_review_businesses_token
  on public.review_businesses (approval_token);

create table if not exists public.review_replies (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.review_businesses(id) on delete cascade,
  review_text text not null,
  review_author text,
  review_rating int,
  draft_reply text not null,
  status text not null default 'pending', -- pending | approved | rejected | posted
  regeneration_count int not null default 0,
  client_note text,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create index if not exists idx_review_replies_business_status
  on public.review_replies (business_id, status, created_at desc);

alter table public.review_businesses enable row level security;
alter table public.review_replies enable row level security;

-- No policies are created for anon/authenticated roles -- every request from
-- the frontend goes through the Express API, which uses the service_role key
-- and therefore bypasses RLS entirely. This leaves anon/authenticated access
-- fully denied by default, which is the intent (no direct client access).
