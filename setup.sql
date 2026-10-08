-- Run once in Supabase: SQL Editor > New query > paste > Run.
create table if not exists public.osu_coop_rooms (
  code text primary key,
  path text not null,
  type text not null,
  token text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.osu_coop_msgs (
  id bigint generated always as identity primary key,
  code text not null references public.osu_coop_rooms(code) on delete cascade,
  from_id text not null,
  msg jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists osu_coop_msgs_code_id on public.osu_coop_msgs (code, id);

-- Lock the tables: with RLS on and no policies, only the Edge Function (service role) can touch them.
alter table public.osu_coop_rooms enable row level security;
alter table public.osu_coop_msgs enable row level security;

-- Private bucket for the temporary match music (skipped if you already have it).
insert into storage.buckets (id, name, public) values ('osu-temp-music', 'osu-temp-music', false)
on conflict (id) do nothing;
