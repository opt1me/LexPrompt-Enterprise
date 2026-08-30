-- §6.3 and S17: ASKING A COLLEAGUE TO LOOK AT A CLAUSE.
--
-- 013, not the plan's 012: `011_close_unused_finding_grants.sql` landed in
-- Stage 3's fix round and `012_audit_event.sql` is Task 11's. An applied
-- migration is immutable, so the number moves and the file does not.
--
-- ## An assignment is a REQUEST, not a disposition
--
-- Nothing here touches `finding_disposition`, and no route below writes a
-- `finding_disposition_event`. Overriding somebody's judgement and asking
-- somebody to check one are different acts, and the app keeps them different
-- (§6.3). This is the owner's escape hatch, in his own framing: a trainee
-- verifies the clauses they are sure of and hands the rest to a person who
-- can decide.
--
-- ## The row is MUTABLE, which is why the audit log carries it
--
-- Unlike a disposition change — recorded once, in `finding_disposition_event`,
-- and never also in `audit_event` (S22) — an assignment has no append-only
-- log of its own, because it RESOLVES: one row, created and then closed. So
-- the act itself belongs in `audit_event` (`assignment.created`,
-- `assignment.resolved`), and that asymmetry is deliberate rather than an
-- inconsistency. There is exactly one record of each fact either way.
create table assignment (
  id                  text primary key,
  review_id           text not null,
  findings_key        text not null,
  clause_id           text not null,
  workspace_id        uuid not null references workspace(id),
  -- BOTH people, always. An assignment with no assigner is a request nobody
  -- made, and the assignee reads "who asked me?" off this row.
  assignee_user_id    uuid not null references app_user(id),
  assigned_by_user_id uuid not null references app_user(id),
  message             text,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by_user_id uuid references app_user(id),
  -- The finding must exist, in this workspace, and an assignment dies with
  -- it: a request to look at a clause that has been deleted is a request
  -- addressed to nothing.
  foreign key (review_id, findings_key, clause_id)
    references finding (review_id, findings_key, clause_id) on delete cascade,
  -- Resolution is a PAIR OR NEITHER. A `resolved_at` with no resolver is an
  -- assignment that closed itself, which nothing does — every close is a
  -- person, either the assignee finishing or the assigner withdrawing.
  constraint assignment_resolution_is_a_pair
    check ((resolved_at is null) = (resolved_by_user_id is null)),
  -- A message is absent or it says something. An empty string is a message
  -- that renders as a message and carries nothing, which is the blank-CSV-
  -- cell defect at a new surface: the assignee opens the clause to find out
  -- what was wanted and finds an empty line.
  constraint assignment_message_says_something
    check (message is null or btrim(message) <> '')
);

-- ONE OPEN ASSIGNMENT PER FINDING PER ASSIGNEE.
--
-- Not one per finding: two people can each be asked to look at the same
-- clause — a second opinion is a normal thing to want — and the day that
-- happens a unique constraint on the finding alone would refuse the second
-- request with a constraint name. What it does forbid is asking the SAME
-- person twice for the same clause while the first request is still open,
-- which would put two identical rows in front of them.
create unique index assignment_open_idx
  on assignment (review_id, findings_key, clause_id, assignee_user_id)
  where resolved_at is null;

-- "What has been asked of me", scoped by workspace and newest first — the
-- shape `GET /v1/assignments?state=open` reads.
create index assignment_assignee_idx
  on assignment (workspace_id, assignee_user_id, created_at desc)
  where resolved_at is null;

-- …and the other direction: every open request on one review, which is what
-- a review screen loads.
create index assignment_review_idx
  on assignment (workspace_id, review_id, created_at desc)
  where resolved_at is null;

grant select, insert, update on assignment to lexprompt_app;

-- THE WORKER GETS NOTHING, not even select.
--
-- It performs no act that assigns anything and reads nothing that depends on
-- one, and a grant it does not need is a grant nobody notices becoming
-- load-bearing. Stated as an explicit REVOKE as well as an absent GRANT, the
-- way 006 and 012 state theirs and for the same reason: an absent grant is
-- undone by one careless `grant all`, and a revoke standing in the record is
-- not.
revoke all on assignment from lexprompt_worker;
