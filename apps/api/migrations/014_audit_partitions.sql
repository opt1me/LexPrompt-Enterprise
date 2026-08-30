-- 014: the partition horizon rolls forward, and the routine actually exists.
--
--
-- ## WHAT WAS WRONG
--
-- `012_audit_event.sql` created twelve monthly partitions from the month it
-- ran in, and said:
--
--   "The partition-creation routine that keeps that horizon rolling is a
--    deployment concern named in the README, not something the API does on
--    its own behalf."
--
-- It was not named in the README. Nothing anywhere created a thirteenth
-- partition -- `grep -rn partition apps/api/src` returned no source file at
-- all -- so twelve months after a deployment's first migration, the last
-- partition ends and the next `insert into audit_event` fails with
-- `no partition of relation "audit_event" found for row`.
--
-- `appendAudit` has no try/catch (deliberately, and the reasoning is right)
-- and runs in the CALLER'S transaction, so that error rolls back the act it
-- was recording. From that date the deployment cannot create a matter, add a
-- document, publish a playbook, start a run, make an assignment or change a
-- workspace setting. Verified against the running stack: the last partition
-- ended 2027-08-01, and an insert dated 2027-09-01 raised exactly that.
--
-- A loud failure is the right DIRECTION -- an audit log that silently drops
-- rows is worse than none -- but this one arrives at a moment nobody is
-- watching for, with no runbook, and takes down writes that have nothing to
-- do with audit. And the justification for not automating it rested on a
-- document that did not say what it was cited for, which is its own defect:
-- a comment asserting a routine that does not exist protects nothing.
--
--
-- ## WHAT THIS DOES
--
-- One function, idempotent, that creates every missing monthly partition
-- from the current month out to a horizon. `apps/api/src/main.ts` calls it at
-- startup on the MIGRATOR connection, immediately after `runMigrations` --
-- the one connection in the process that owns the schema, and one that is
-- closed again seconds later.
--
-- Startup, not a background timer: the horizon is a year wide, so a process
-- restarted at any point in a year keeps it a year wide, and a timer would
-- be a second mechanism to reason about for a fact that moves monthly. A
-- deployment whose API process runs for more than the horizon without
-- restarting is the residual case, and it is now named in the README with
-- the command to run by hand -- for real this time.
--
-- `create table if not exists` throughout, so two replicas starting at once
-- both succeed. Postgres takes an ACCESS EXCLUSIVE lock on the parent while
-- attaching a partition, so concurrent callers serialise rather than race;
-- the `if not exists` is what makes the loser a no-op instead of an error.
create or replace function ensure_audit_partitions(horizon_months int default 12)
returns int
language plpgsql
as $$
declare
  start_month date := date_trunc('month', now())::date;
  m           int;
  from_date   date;
  to_date     date;
  made        int := 0;
  existed     boolean;
begin
  if horizon_months < 1 then
    raise exception 'ensure_audit_partitions needs a horizon of at least one month, not %',
      horizon_months;
  end if;
  for m in 0..(horizon_months - 1) loop
    from_date := (start_month + (m || ' months')::interval)::date;
    to_date := (start_month + ((m + 1) || ' months')::interval)::date;
    select exists (
      select 1 from pg_class
       where relname = 'audit_event_' || to_char(from_date, 'YYYY_MM')
         and relkind = 'r')
      into existed;
    -- `format` with %I/%L rather than concatenation, for the reason 012
    -- gives: the names are derived from a date and are not
    -- attacker-influenced, but a migration is where a habit becomes a
    -- pattern somebody copies.
    execute format(
      'create table if not exists %I partition of audit_event for values from (%L) to (%L)',
      'audit_event_' || to_char(from_date, 'YYYY_MM'), from_date, to_date);
    if not existed then
      -- The same explicit grant 012 makes on every partition, so a statement
      -- naming a partition directly behaves as one naming the parent does.
      execute format('grant insert, select on %I to lexprompt_app',
        'audit_event_' || to_char(from_date, 'YYYY_MM'));
      made := made + 1;
    end if;
  end loop;
  return made;
end $$;

-- NOT executable by the app role. Creating a partition requires ownership of
-- the parent, so an app-role call would fail anyway -- but an absent grant is
-- a fact about the database, and "it would fail anyway" is the reasoning that
-- leaves a privilege lying around until something changes underneath it.
revoke all on function ensure_audit_partitions(int) from public;
grant execute on function ensure_audit_partitions(int) to lexprompt_migrator;

-- Top the horizon up now, for a deployment already running against 012's
-- original twelve.
select ensure_audit_partitions(12);
