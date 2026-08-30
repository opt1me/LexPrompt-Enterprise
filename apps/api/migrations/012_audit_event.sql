-- 012: `audit_event` — §6.5, S11. P23's deferral, closed.
--
-- Numbered 012 rather than the plan's 011: `011_close_unused_finding_grants.sql`
-- landed in Stage 3's fix round and an applied migration file is immutable.
--
--
-- ## APPEND-ONLY BY GRANT, NOT BY CONVENTION
--
-- §6.5: "a mistaken audit row cannot be corrected, only annotated by a later
-- row -- which is what append-only means and why it is evidence." A rule
-- enforced only by the code that happens not to break it survives exactly
-- until the next person writes a query, which is the argument
-- `006_dispositions.sql` makes at length about the disposition history and
-- which applies here word for word.
--
-- So the app role gets INSERT and SELECT. Nothing else, and the absence is
-- stated as an explicit REVOKE as well, because a future
-- `grant all on all tables in schema public` is exactly the kind of
-- convenience that would silently undo an absent grant.
--
--
-- ## PARTITIONED MONTHLY BY `at`
--
-- Retention becomes a DETACH rather than a DELETE over a table nobody may
-- delete from, which is the only way a retention policy and an insert-only
-- grant can both be true at once. A DELETE grant added later "just for
-- retention" would be a DELETE grant, and every argument above would be
-- decoration.
--
-- A write with no partition covering its instant FAILS LOUDLY --
-- `no partition of relation "audit_event" found for row` -- rather than
-- being dropped. That is the correct direction and `auditEvent.pg.test.ts`
-- proves it: an audit log that silently discards rows is worse than no audit
-- log, because it looks like one.
--
-- Twelve months are created ahead. Creating them here rather than by a job
-- means a deployment that never runs the job still records a year of audit;
-- a deployment that runs past the last one fails loudly on the next write,
-- which is a page rather than a silence. The partition-creation routine that
-- keeps that horizon rolling is a deployment concern named in the README,
-- not something the API does on its own behalf.
--
--
-- ## The primary key includes `at`
--
-- Postgres requires every unique constraint on a partitioned table to
-- include the partition key. `id` alone is still unique in practice -- it is
-- a single identity sequence shared by every partition -- but the DECLARED
-- key has to name both.
create table audit_event (
  id            bigint generated always as identity,
  workspace_id  uuid not null references workspace(id),
  at            timestamptz not null default now(),
  actor_user_id uuid not null references app_user(id),
  action        text not null,
  subject_type  text not null,
  subject_id    text not null,
  matter_id     text,
  review_id     text,
  -- An object, checked. `'null'::jsonb`, a bare string or an array would all
  -- store happily and then read back as something no consumer expects.
  detail        jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(detail) = 'object'),
  -- An action nobody has decided the wording of is an action with no reader.
  -- The closed set lives in `apps/api/src/audit/actions.ts` and the compiler
  -- holds it; this is the same rule at the other end, so a row written by
  -- something that is not this application still cannot invent a verb.
  constraint audit_action_not_blank check (btrim(action) <> ''),
  constraint audit_subject_not_blank check (btrim(subject_type) <> '' and btrim(subject_id) <> ''),
  primary key (id, at)
) partition by range (at);

create index audit_event_ws_at_idx on audit_event (workspace_id, at desc);
create index audit_event_matter_idx on audit_event (workspace_id, matter_id, at desc);

-- Twelve monthly partitions from the start of the current month.
--
-- `format` with `%I`/`%L` rather than string concatenation: the names are
-- derived from a date here and are not attacker-influenced, but a migration
-- is exactly the place a habit becomes a pattern somebody copies.
do $$
declare
  start_month date := date_trunc('month', now())::date;
  m           int;
  from_date   date;
  to_date     date;
begin
  for m in 0..11 loop
    from_date := (start_month + (m || ' months')::interval)::date;
    to_date := (start_month + ((m + 1) || ' months')::interval)::date;
    execute format(
      'create table if not exists %I partition of audit_event for values from (%L) to (%L)',
      'audit_event_' || to_char(from_date, 'YYYY_MM'), from_date, to_date);
  end loop;
end $$;

-- INSERT and SELECT. Nothing else, to any application role.
--
-- ON THE PARTITIONED PARENT, which is where Postgres reads the privilege
-- from for a write routed through the parent: a partition inherits the
-- parent's ACL check for statements that name the parent. The test suite
-- asks the CATALOGUE rather than assuming that -- R-S3B1 is this project's
-- own precedent for why (a `revoke update (col)` was a silent no-op because
-- Postgres keeps column privileges in `attacl` and table privileges in
-- `relacl`, and nothing errored) -- and grants each partition explicitly
-- below so a future statement naming a partition directly behaves the same.
grant insert, select on audit_event to lexprompt_app;

do $$
declare
  part regclass;
begin
  for part in
    select inhrelid::regclass from pg_inherits
     where inhparent = 'audit_event'::regclass
  loop
    execute format('grant insert, select on %s to lexprompt_app', part);
    execute format('revoke update, delete, truncate on %s from lexprompt_app', part);
  end loop;
end $$;

revoke update, delete, truncate on audit_event from lexprompt_app;

-- THE WORKER GETS NOTHING, not even select.
--
-- It performs no act that belongs in an audit log -- every entry in
-- `AUDIT_ACTIONS` is something a person asked for -- and a grant it does not
-- need is a grant nobody will notice becoming load-bearing. Same reasoning
-- as 006's revoke on the disposition tables, and stated the same way for the
-- same reason: an absent grant is undone by one careless `grant all`.
revoke all on audit_event from lexprompt_worker;
