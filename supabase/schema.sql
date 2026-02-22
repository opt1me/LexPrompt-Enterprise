-- LexPrompt collaboration schema (beta)
-- Run this in Supabase SQL editor for durable workspace collaboration persistence.

create extension if not exists "pgcrypto";

create table if not exists public.workspaces (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  owner_id text not null,
  retain_source_documents boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.workspace_members (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id text not null,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'editor', 'reviewer')),
  invited_by text not null,
  joined_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create table if not exists public.workspace_invites (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'editor', 'reviewer')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.finding_comments (
  id text primary key default gen_random_uuid()::text,
  finding_id text not null,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  author_id text not null,
  author_email text not null,
  text text not null,
  mentions text[] not null default '{}',
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create table if not exists public.finding_status_history (
  id text primary key default gen_random_uuid()::text,
  finding_id text not null,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  from_status text not null check (from_status in ('open', 'needs-review', 'approved')),
  to_status text not null check (to_status in ('open', 'needs-review', 'approved')),
  changed_by text not null,
  changed_by_email text not null,
  changed_at timestamptz not null default now()
);

create table if not exists public.activity_events (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  actor_id text not null,
  actor_email text not null,
  type text not null,
  entity_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.collaboration_events (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  type text not null check (type in ('comment_added', 'status_changed', 'analysis_completed')),
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_email text not null,
  type text not null check (type in ('mention', 'assignment', 'job_completed')),
  title text not null,
  entity_id text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.review_sessions (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  title text not null,
  template_snapshot jsonb not null default '{}'::jsonb,
  findings jsonb not null default '{}'::jsonb,
  doc_order jsonb not null default '[]'::jsonb,
  provider text,
  model text,
  region text,
  policy_version text,
  status text not null default 'complete' check (status in ('complete', 'incomplete')),
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.review_documents (
  id text primary key default gen_random_uuid()::text,
  review_id text not null references public.review_sessions(id) on delete cascade,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  name text not null,
  mime_type text not null,
  doc_type text not null check (doc_type in ('pdf', 'docx', 'txt')),
  size_bytes bigint,
  page_count int,
  char_count int,
  storage_path text,
  source_url text,
  source_base64 text,
  content_text text,
  created_at timestamptz not null default now()
);

alter table public.workspaces
  add column if not exists retain_source_documents boolean not null default false;

alter table public.review_documents
  alter column content_text drop not null;
alter table public.review_documents
  alter column content_text drop default;

create index if not exists idx_workspace_members_workspace on public.workspace_members(workspace_id);
create index if not exists idx_workspace_members_email on public.workspace_members(email);
create index if not exists idx_invites_workspace on public.workspace_invites(workspace_id);
create index if not exists idx_comments_workspace_finding on public.finding_comments(workspace_id, finding_id);
create index if not exists idx_status_workspace_finding on public.finding_status_history(workspace_id, finding_id);
create index if not exists idx_activity_workspace_created on public.activity_events(workspace_id, created_at desc);
create index if not exists idx_events_workspace_created on public.collaboration_events(workspace_id, created_at desc);
create index if not exists idx_notifications_workspace_user on public.notifications(workspace_id, user_email, created_at desc);
create index if not exists idx_review_sessions_workspace_created on public.review_sessions(workspace_id, created_at desc);
create index if not exists idx_review_documents_review on public.review_documents(review_id);
create index if not exists idx_review_documents_workspace on public.review_documents(workspace_id, created_at desc);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.finding_comments enable row level security;
alter table public.finding_status_history enable row level security;
alter table public.activity_events enable row level security;
alter table public.collaboration_events enable row level security;
alter table public.notifications enable row level security;
alter table public.review_sessions enable row level security;
alter table public.review_documents enable row level security;

-- Starter policies for authenticated users based on membership email claim.
-- Assumes auth.jwt()->>'email' is available.
create policy if not exists workspace_member_select on public.workspaces
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = workspaces.id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy if not exists workspace_members_member_select on public.workspace_members
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = workspace_members.workspace_id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy if not exists comments_member_select on public.finding_comments
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = finding_comments.workspace_id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy if not exists status_member_select on public.finding_status_history
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = finding_status_history.workspace_id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy if not exists activity_member_select on public.activity_events
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = activity_events.workspace_id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy if not exists event_member_select on public.collaboration_events
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = collaboration_events.workspace_id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy if not exists notification_owner_select on public.notifications
for select using (lower(user_email) = lower(auth.jwt()->>'email'));

create policy if not exists review_sessions_member_select on public.review_sessions
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = review_sessions.workspace_id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);

create policy if not exists review_documents_member_select on public.review_documents
for select using (
  exists (
    select 1 from public.workspace_members m
    where m.workspace_id = review_documents.workspace_id and lower(m.email) = lower(auth.jwt()->>'email')
  )
);
