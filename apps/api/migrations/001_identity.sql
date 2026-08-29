-- gen_random_uuid() is core from Postgres 13; no extension is created,
-- because an extension is a privilege the app role would then have to be
-- granted around.

create table workspace (
  id         uuid primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

-- S9: one workspace now, and every table below carries workspace_id from day
-- one so a second tenant is a data-model no-op rather than a migration. The
-- id is FIXED rather than random because API_WORKSPACE_ID names it in both
-- environments, and a random seed would make that key unsettable.
insert into workspace (id, name)
values ('00000000-0000-0000-0000-000000000001', 'LexPrompt')
on conflict (id) do nothing;

create table app_user (
  id            uuid primary key,
  workspace_id  uuid not null references workspace(id),
  -- THE identity, and never the email (§7). An email can be reassigned; an
  -- issuer-scoped subject cannot. 'oid' under Entra, 'sub' under a standard
  -- issuer — opaque either way, and the two are never compared.
  issuer        text not null,
  subject       text not null,
  email         text,
  display_name  text not null,
  initials      text not null,
  role          text not null check (role in ('reviewer', 'partner', 'admin')),
  status        text not null check (status in ('active', 'disabled')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (issuer, subject)
);
create index app_user_workspace_idx on app_user (workspace_id);

-- The group-to-role table (§6.5). `group_value` is a Keycloak group NAME
-- locally and an Entra security-group OBJECT ID in a firm deployment; the
-- code reads a string from the configured groupsClaim and looks it up, and
-- does not know the difference (S28). The primary key carries the issuer
-- because the same string means different things under two issuers, and a
-- mapping without one would let a local group name grant a role in a tenant.
create table role_mapping (
  workspace_id uuid not null references workspace(id),
  issuer       text not null,
  group_value  text not null,
  role         text not null check (role in ('reviewer', 'partner', 'admin')),
  primary key (issuer, group_value)
);

-- §6.6: Settings.modelId becomes workspace configuration an admin sets from
-- the allowlist. One row per workspace, created lazily by the route.
create table workspace_setting (
  workspace_id        uuid primary key references workspace(id),
  model_choice_id     text,
  model_choice_label  text,
  model_choice_model  text,
  concurrency         int  not null default 5 check (concurrency between 1 and 20),
  version             bigint not null default 1,
  updated_at          timestamptz not null default now(),
  updated_by_user_id  uuid references app_user(id)
);

-- Grants (P10). The app role gets exactly what a request needs.
grant select on workspace to lexprompt_app;
grant select, insert, update on app_user to lexprompt_app;
-- role_mapping is SEEDED BY DEPLOYMENT CONFIGURATION in this stage and
-- administered from a screen in a later one, so the app role reads it and
-- does not write it. An admin route that could write it does not exist yet,
-- and the absent grant is what keeps that true rather than a comment.
grant select on role_mapping to lexprompt_app;
grant select, insert, update on workspace_setting to lexprompt_app;
-- No DELETE on app_user, deliberately: §7's admin power is to DISABLE a
-- user, and deleting one would orphan every attribution they authored.
-- `status` is the mechanism, and the absent grant is what makes it the only
-- one rather than the preferred one.
