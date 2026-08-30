-- §6.3: a finding's `Verification` — a person's judgement about a specific
-- answer — becomes a row of its own, with a complete history beside it.
--
-- Everything below is a constraint rather than a convention on purpose. The
-- rule this schema exists to keep is "verification state is set only by a
-- human action; nothing derives it", and a rule enforced only by the code
-- that happens not to break it is a rule that survives exactly until the next
-- person writes a query.
create table finding_disposition (
  review_id     text not null,
  findings_key  text not null,
  clause_id     text not null,
  workspace_id  uuid not null references workspace(id),
  primary key (review_id, findings_key, clause_id),
  foreign key (review_id, findings_key, clause_id)
    references finding (review_id, findings_key, clause_id) on delete cascade,
  state         text not null check (state in ('unchecked','verified','flagged','rejected')),
  reason        text,
  -- WHO SET THE CURRENT STATE — never who set the first. A card reading
  -- "Verified by A. Trainee" for a finding a Partner reverted and re-verified
  -- would be a quiet lie (§6.3). Stage 4 renders it; Stage 3 stores it.
  by_user_id    uuid references app_user(id),
  at            timestamptz,
  changed_count int not null default 0,
  version       bigint not null default 1,
  -- A rejection without a reason is not a rejection anyone can act on.
  constraint disposition_reason_on_reject
    check (state <> 'rejected' or btrim(coalesce(reason, '')) <> ''),
  -- A never-touched finding has NO actor, and that is a different fact from
  -- an unchecked one somebody reset. NULL is the honest reading, and it is
  -- why the column is nullable rather than back-filled with whoever ran the
  -- review (§6.3).
  constraint disposition_actor_iff_touched
    check ((changed_count = 0 and by_user_id is null and at is null)
        or (changed_count > 0 and by_user_id is not null and at is not null))
);

-- The history, and §12 Q3's third log. INSERT-only to every application role
-- (the grants below), which is what makes it evidence rather than a claim.
create table finding_disposition_event (
  id            bigint generated always as identity primary key,
  review_id     text not null,
  findings_key  text not null,
  clause_id     text not null,
  workspace_id  uuid not null references workspace(id),
  foreign key (review_id, findings_key, clause_id)
    references finding (review_id, findings_key, clause_id) on delete cascade,
  from_state    text not null check (from_state in ('unchecked','verified','flagged','rejected')),
  to_state      text not null check (to_state in ('unchecked','verified','flagged','rejected')),
  reason        text,
  cause         text not null check (cause in ('human','rerun_reset')),
  by_user_id    uuid not null references app_user(id),
  at            timestamptz not null,
  constraint event_reason_on_reject
    check (to_state <> 'rejected' or btrim(coalesce(reason, '')) <> ''),
  -- S21, and it is the whole of "nothing derives a verification" made
  -- structural: the one write the system performs on its own behalf can only
  -- ever REMOVE a claim of human checking. A rule that can only move a
  -- disposition to `unchecked` cannot manufacture a `verified`.
  constraint rerun_reset_only_unchecks
    check (cause <> 'rerun_reset' or to_state = 'unchecked')
);
create index disposition_event_finding_idx
  on finding_disposition_event (workspace_id, review_id, findings_key, clause_id, id);

-- S11's grant. Insert and select on the history; no update, no delete, to any
-- application role.
grant select, insert on finding_disposition_event to lexprompt_app;
grant select, insert, update on finding_disposition to lexprompt_app;
-- Redundant for an identity column — Postgres charges no sequence privilege
-- for one, unlike a `serial` — and granted anyway, because
-- `002_records.sql`'s blanket `grant usage, select on all sequences` covered
-- only the sequences that existed when it ran, and a reader comparing the two
-- files should not have to know which kind of default this column uses.
grant usage, select on sequence finding_disposition_event_id_seq to lexprompt_app;

-- §9.1 and §14: the run worker's role can neither insert, update nor delete
-- either of them, and cannot READ them either.
--
-- Stated as an explicit REVOKE as well as an absent GRANT, because a future
-- `grant all on all tables in schema public` is exactly the kind of
-- convenience that would silently undo it.
--
-- Note the SELECT. §6.3 says the worker "can neither insert, update nor
-- delete them"; this revokes select too, because the worker has no reason to
-- read a disposition and a select grant is how a future "just check whether
-- it was verified before overwriting" gets written. If a later task finds a
-- legitimate need for the worker to read one, that is a change to this ruling
-- with its own reasoning, not a quiet grant.
revoke all on finding_disposition, finding_disposition_event from lexprompt_worker;
revoke all on sequence finding_disposition_event_id_seq from lexprompt_worker;
