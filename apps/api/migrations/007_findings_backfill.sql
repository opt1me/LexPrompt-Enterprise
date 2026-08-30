-- The two tables the findings backfill leaves behind, and nothing else.
--
-- The movement itself — the census, the refusals, the shred, the
-- reconciliation and the report — is `apps/api/src/findings/backfill.ts`,
-- registered in `db/migrationSteps.ts` and run by `runMigrations` INSIDE the
-- same transaction as this file, before the ledger row for it is written. Two
-- reasons it is not SQL:
--
--  1. The refusals have to say something an operator can act on. A migration
--     that stops on the first `insert ... select` to hit a constraint names
--     one row and the constraint it violated; this one names EVERY row it
--     cannot move, says what is wrong with each, and says what to do. That
--     difference is the whole of "refuse rather than guess".
--  2. `findingsKeyFor` is the only place a findings key is derived
--     (CLAUDE.md), and it is TypeScript. Re-implementing its collection
--     branch in SQL to CHECK a stored key would be the second copy that rule
--     exists to prevent.
--
-- Both tables OUTLIVE the migration. They are how an operator answers "what
-- did it claim to find?" six months later without reading a container log
-- that has long since rotated.

-- Every human judgement in the database, recorded BY KEY before anything
-- moves. §19's census.
create table finding_migration_census (
  review_id     text not null,
  findings_key  text not null,
  clause_id     text not null,
  workspace_id  uuid not null,
  kind          text not null check (kind in ('verification','net_position','note','assignee')),
  detail        jsonb not null,
  primary key (review_id, findings_key, clause_id, kind)
);

-- One row per run of the backfill. `discrepancies` is empty or the migration
-- did not commit — the report is written last, inside the same transaction,
-- so a report row exists if and only if the movement it describes is real.
create table finding_migration_report (
  at            timestamptz not null default now(),
  censused      int not null,
  landed        int not null,
  discrepancies jsonb not null,
  -- What was carried across and could NOT be stored, NAMED rather than
  -- dropped (P24, S17). `Verification.assigneeId` is the whole of it today:
  -- the field reaches nobody (ruling R1) and has no home in the new schema,
  -- and a migration that silently discarded it would leave no trace that a
  -- clause had ever been assigned to anybody.
  discarded     jsonb not null default '[]'::jsonb,
  summary       text not null
);

-- Read-only to the app role. Nothing in a request path writes either table —
-- only the migration does — but "what did the migration find" is a question
-- worth being able to answer through a support route later without handing
-- somebody the schema owner's credential.
grant select on finding_migration_census, finding_migration_report to lexprompt_app;
