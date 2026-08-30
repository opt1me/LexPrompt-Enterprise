-- §6.2: findings become rows keyed (review_id, findings_key, clause_id).
--
-- `findings_key` is produced by packages/core's `findingsKeyFor` and by
-- nothing else: a document id for a document review, the COLLECTION id for a
-- collection review. Six defects in sub-project C came from code that keyed
-- by document id directly — an empty findings pane, a verification and a note
-- written under a key nothing read, two silently empty exports, and a retry
-- that overwrote a synthesised net position with a one-document answer. The
-- column is deliberately NOT a foreign key to `document`: a collection key
-- names no document, and an FK here would make the collection case
-- unrepresentable and push somebody toward keying by document to satisfy it.
create table finding (
  review_id            text not null references review(id) on delete cascade,
  findings_key         text not null,
  clause_id            text not null,
  workspace_id         uuid not null references workspace(id),
  primary key (review_id, findings_key, clause_id),
  status               text not null
                         check (status in ('pending','running','done','error','cancelled')),
  summary              text,
  risk_level           text check (risk_level in ('High','Medium','Low','Info')),
  risk_analysis        text,
  error                text,
  auth_error           boolean not null default false,
  truncated            boolean not null default false,
  -- NULL on a single-document finding, NEVER '{}'. `truncated` alone already
  -- names the only document there is; an empty array here would read as
  -- "several documents, none cut short", which is a different fact (§6.2).
  truncated_documents  text[],
  no_content           boolean not null default false,
  edited               boolean not null default false,
  -- NULL = there was no standard position to compare against. 'unclear' =
  -- there was one and the model could not tell. Different facts (§6.2), and
  -- the reason `fromFindingRow` returns an ABSENT key rather than a null one.
  position_outcome     text check (position_outcome in ('meets','deviates','unclear')),
  position_rationale   text,
  citations            jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(citations) = 'array'),
  -- NULL on a standalone finding, never '{}'. An empty net position would
  -- read as "we synthesised across the documents and found nothing", where
  -- absence means "this question did not arise".
  net_position         jsonb check (jsonb_typeof(net_position) = 'object'),
  version              bigint not null default 1,
  updated_at           timestamptz not null default now()
);
create index finding_review_idx on finding (workspace_id, review_id);

-- §6.3: notes are their own table now. R-B3 said "a notes store becomes a
-- later migration"; this is that migration, forced by the Finding object it
-- used to live inside ceasing to exist.
--
-- `by_user_id` is NOT NULL and a real foreign key, unlike every other
-- attribution column in this schema (`matter.owner_id`,
-- `review.created_by_user_id`, ...), which are nullable because P16 maps the
-- wire type's empty-string attribution to NULL. A note is different in kind:
-- those columns record who touched a record, and an unattributed record is a
-- fact about old data. A note is a person's remark addressed to the next
-- reader, and "somebody wrote this about your clause" with no somebody is not
-- a remark anyone can weigh. `Note.byUserId` is a required, non-optional
-- `string` on the shipped wire type for the same reason.
create table note (
  id           text primary key,
  review_id    text not null references review(id) on delete cascade,
  findings_key text not null,
  clause_id    text not null,
  workspace_id uuid not null references workspace(id),
  text         text not null check (btrim(text) <> ''),
  by_user_id   uuid not null references app_user(id),
  at           timestamptz not null,
  foreign key (review_id, findings_key, clause_id)
    references finding (review_id, findings_key, clause_id) on delete cascade
);
create index note_finding_idx on note (workspace_id, review_id, findings_key, clause_id);

-- The third role (§9, §14). It leases cells and writes model output. Its
-- grants on the two disposition tables are declared in 006: NONE.
--
-- ASSERTED, not created -- the same posture as `000_preconditions.sql`, and
-- for the reason written there: a migration that created its own principal
-- would have to carry that principal's password in version control.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lexprompt_worker') then
    raise exception 'The role lexprompt_worker does not exist. Stage 3 runs the review engine as a third role that can write model output and CANNOT touch a disposition or a note - that separation is what makes "nothing derives a human judgement" a fact about the database rather than a fact about the code. Create it as part of the deployment: infra/postgres/init.sql is the local form, and the README carries the Azure step beside the other two roles.';
  end if;
  -- The declared cap, CHECKED rather than set.
  --
  -- The reference for this file wrote `alter role lexprompt_worker set
  -- statement_timeout = '60s'` here. Run against the real database that
  -- fails: "permission denied to alter role / Only roles with the CREATEROLE
  -- attribute and the ADMIN option on role lexprompt_worker may alter this
  -- role." `lexprompt_migrator` owns the schema and has neither,
  -- deliberately - a migrator that could alter roles could grant itself
  -- anything - so the statement aborts the whole migration.
  --
  -- Setting it belongs with creating the role, in the deployment. What
  -- belongs here is refusing to proceed when it was skipped: an undeclared
  -- statement_timeout means a runaway query in the worker holds its lease on
  -- a cell until somebody notices, and the cell reads as still running. The
  -- VALUE is the operator's; its ABSENCE is not.
  if not exists (
    select 1 from pg_roles
    where rolname = 'lexprompt_worker'
      and coalesce(array_to_string(rolconfig, ','), '') like '%statement_timeout%'
  ) then
    raise exception 'The role lexprompt_worker has no statement_timeout set. The run worker holds a lease on a cell while it queries; with no declared timeout a runaway statement holds that lease until somebody notices, and the cell reads as still running. Set it where the role is created - 60s is what the plan declares - with: ALTER ROLE lexprompt_worker SET statement_timeout = ''60s''; Run that as the database admin, not as lexprompt_migrator, which deliberately cannot alter a role.';
  end if;
end $$;

-- Grants, in `002_records.sql`'s style.
--
-- DELETE on `finding` for the app role, which the reference for this file did
-- not grant: Task 7's shadow writer must delete the rows for a key the
-- re-saved review no longer carries, or a clause removed from a playbook
-- leaves an orphan finding whose disposition still counts toward a standard
-- position's health. It cascades to that finding's disposition and its
-- history, which is acceptable only because the BLOB is authoritative for the
-- whole of Part 3A: a key absent from the blob is a judgement that no longer
-- exists in the record of truth either, and the shadow's job is to agree with
-- it. Revisit when Task 14 flips the reader.
grant select, insert, update, delete on finding to lexprompt_app;
-- No UPDATE on a note: a remark is not edited in place, it is added or
-- withdrawn.
grant select, insert, delete on note to lexprompt_app;

grant select, insert, update on finding to lexprompt_worker;
grant select on review, document, playbook_version, workspace_setting to lexprompt_worker;
-- The worker may not write a note either: a note is a person's remark.
grant select on note to lexprompt_worker;
