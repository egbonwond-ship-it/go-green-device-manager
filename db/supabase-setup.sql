-- Run once in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Creates the tables GO-Green Device Manager uses. Row Level Security is on with no
-- policies, so the public "anon" key can't read or write them; only the server-side
-- service key used by the Azure API can.
create table if not exists public.ggt_devices (
  id text primary key,
  name text not null,
  platform text not null,
  last_seen timestamptz not null,
  doc jsonb not null
);
create table if not exists public.ggt_deployment_status (
  id bigserial primary key,
  device_id text not null,
  deployment_id text not null,
  state text not null,
  error_code text,
  at timestamptz not null
);
create index if not exists ggt_status_device_idx on public.ggt_deployment_status (device_id, at desc);
-- Console configuration and activity: collections, applications, deployments, scripts,
-- commands, alerts, the activity log and settings.
create table if not exists public.ggt_objects (
  kind text not null,
  id text not null,
  doc jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);
create index if not exists ggt_objects_kind_idx on public.ggt_objects (kind, updated_at desc);
alter table public.ggt_devices enable row level security;
alter table public.ggt_deployment_status enable row level security;
alter table public.ggt_objects enable row level security;
