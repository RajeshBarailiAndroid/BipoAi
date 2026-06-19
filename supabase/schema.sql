-- Run this in Supabase → SQL Editor → New query → Run

create table if not exists profiles (
  id text primary key,
  email text,
  name text,
  picture text,
  provider text not null default 'email',
  plan text not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);

create table if not exists study_sessions (
  id text primary key,
  owner_id text not null,
  name text not null,
  source text,
  notes jsonb,
  quiz jsonb,
  flashcards jsonb,
  podcast jsonb,
  source_text text,
  card_count integer not null default 0,
  quiz_count integer not null default 0,
  tutor_done boolean not null default false,
  input_type text not null default 'files',
  input_text text,
  audio_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists folders (
  id text primary key,
  owner_id text not null,
  name text not null,
  description text default '',
  created_at timestamptz not null default now()
);

create table if not exists decks (
  id text primary key,
  owner_id text not null,
  folder_id text references folders(id) on delete set null,
  name text not null,
  cards jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_study_sessions_owner_created
  on study_sessions (owner_id, created_at desc);

create index if not exists idx_folders_owner_created
  on folders (owner_id, created_at desc);

create index if not exists idx_decks_owner_updated
  on decks (owner_id, updated_at desc);

create index if not exists idx_profiles_email
  on profiles (email);

-- If tables already exist, run in SQL Editor:
-- alter table study_sessions add column if not exists input_type text not null default 'files';
-- alter table study_sessions add column if not exists input_text text;
-- alter table study_sessions add column if not exists audio_url text;
