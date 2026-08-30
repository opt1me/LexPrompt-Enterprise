-- §6.5 and §9: a run is a row, its work is a queue of cells, and everything
-- either of them does is announced on an outbox the browser can replay.
--
-- Three tables and one rule that runs through all of them: A RUN THAT DIED
-- MUST NOT LOOK FINISHED. `CLAUDE.md` lists "an abandoned run reopening with
-- every cell spinning forever, unfinishable" among the defects this project
-- has already shipped, and every column below that looks like bookkeeping --
-- `heartbeat_at`, `cancel_requested_at`, `lease_expires_at`, `attempts` -- is
-- there so a reader can tell four different endings apart:
--
--   succeeded   every cell reached `done` or `error`, and the run finished
--   cancelled   a person asked it to stop; what completed stays completed
--   failed      it stopped WITHOUT being asked, and `error` says so
--   running     in flight, and the heartbeat is what proves it
--
-- Collapsing any pair of those is this stage's version of answering quietly
-- wrong.
create table run (
  id                   text primary key,
  review_id            text not null references review(id) on delete cascade,
  workspace_id         uuid not null references workspace(id),
  state                text not null check (state in
                         ('queued','running','cancelling','cancelled','succeeded','failed')),
  requested_by_user_id uuid not null references app_user(id),
  -- A SNAPSHOT, for the reason `playbook_snapshot` is one (§6.5): a firm that
  -- changes its allowlist must not silently rewrite where a review it ran
  -- last March was processed. The gateway RETURNS these on every response and
  -- the run stores what it was told, never what the configuration now says.
  --
  -- NULLABLE, and that is not laxity. A queued run has not called anything
  -- yet, so there is nothing true to put here; `not null` would force the API
  -- to guess them from configuration at creation, which is the exact
  -- re-derivation §6.5 forbids. The first cell that gets an answer from the
  -- gateway writes them, once.
  provider             text,
  model                text,
  -- jsonb, NOT a text label, and the shape is the point. `Jurisdiction` is
  -- `{ bloc, region, label }` -- "a firm must not be able to believe it is
  -- UK-only while routing privileged text to a US region", and the defence
  -- against that is the REGION travelling with the bloc. A `text` column here
  -- would have had to hold either the bloc alone (losing the region, which is
  -- the half that answers the question) or a JSON string in a column typed as
  -- prose, which is the same loss wearing a cast.
  jurisdiction         jsonb check (jurisdiction is null or jsonb_typeof(jurisdiction) = 'object'),
  -- The per-run bound, snapshotted from `workspace_setting.concurrency` at
  -- creation for the same reason (P26). Stage 2's ledger recorded that column
  -- as "stored but not enforced"; this is where it becomes real.
  concurrency          int not null check (concurrency between 1 and 32),
  started_at           timestamptz,
  finished_at          timestamptz,
  -- NULL until a worker picks the run up. A run that has NEVER started has no
  -- heartbeat and must not be reaped for waiting -- a busy queue and a broken
  -- one are different facts (Task 11 Step 4).
  heartbeat_at         timestamptz,
  cancel_requested_at  timestamptz,
  error                text,
  created_at           timestamptz not null default now(),
  -- Every event carries the version of the row it describes (§8), so a client
  -- can drop one that is not newer. That is what makes replay safe, and it
  -- needs a version to carry.
  version              bigint not null default 1
);
create index run_review_idx on run (workspace_id, review_id);
-- Findable by the reaper without a sequential scan over finished runs.
create index run_live_idx on run (state, heartbeat_at) where state in ('running','cancelling');

-- ONE LIVE RUN PER REVIEW, enforced by the database rather than by the route
-- that checks for one.
--
-- Two concurrent runs over one review would be two writers per finding, which
-- is the thing this stage exists to end. `runs.ts` refuses with a sentence
-- (409, "This review is already running"), and this index is what makes that
-- refusal true under a race the route's own SELECT cannot see: two requests
-- arriving in the same millisecond both read no live run and both insert.
create unique index run_one_live_per_review on run (review_id)
  where state in ('queued','running','cancelling');

create table run_cell (
  run_id            text not null references run(id) on delete cascade,
  -- Produced by `findingsKeyFor` and by nothing else: a document id for a
  -- document review, the COLLECTION id for a collection review. Six defects
  -- in sub-project C came from code that keyed by document id directly.
  findings_key      text not null,
  clause_id         text not null,
  workspace_id      uuid not null references workspace(id),
  primary key (run_id, findings_key, clause_id),
  state             text not null check (state in ('queued','leased','done','error','cancelled')),
  attempts          int not null default 0,
  leased_by         text,
  lease_expires_at  timestamptz,
  last_error        text
);
-- The leasing index. Without it `for update skip locked` still works and
-- scans every cell of every finished run to find one.
create index run_cell_claimable_idx on run_cell (state, lease_expires_at)
  where state in ('queued','leased');

-- §8, P22: the outbox. One payload vocabulary, two transports -- HTTP now,
-- Stage 4's socket later -- so Stage 4 inherits a protocol rather than
-- inventing one.
create table event (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references workspace(id),
  matter_id    text,
  review_id    text,
  run_id       text,
  type         text not null,
  payload      jsonb not null check (jsonb_typeof(payload) = 'object'),
  at           timestamptz not null default now()
);
create index event_review_idx on event (workspace_id, review_id, id);
-- The pruner's index (§6.5: "a reconnection buffer, not an archive").
create index event_at_idx on event (at);

grant select, insert on event to lexprompt_app, lexprompt_worker;
grant usage, select on sequence event_id_seq to lexprompt_app, lexprompt_worker;
-- DELETE for the app role only: the pruner runs beside the reaper in the API
-- process, and the worker has no business deleting anything.
grant delete on event to lexprompt_app;
grant select, insert, update on run, run_cell to lexprompt_app, lexprompt_worker;
-- Cancel writes `state = 'cancelled'` on the cells a cancelled run leaves
-- behind; the reaper writes `error`. Both run on the app connection.
grant delete on run to lexprompt_app;

-- The run worker reads a collection to decide READING ORDER.
--
-- `orderedMembers` is the only place that order is decided and `document_date`
-- never sorts it (CLAUDE.md): the order in which amendments take effect is a
-- legal judgement someone recorded when they built the collection, not
-- something to re-derive. 005 granted the worker `select` on review, document,
-- playbook_version and workspace_setting and did not grant this one, so a
-- collection cell would have failed with a permission error naming a table
-- rather than reading the order it must not guess at.
grant select on collection to lexprompt_worker;

-- WHO WRITES `parse_state`, and nothing else does (§9, P12).
--
-- Column-level, deliberately, and THREE COLUMNS. The parse worker re-reads a
-- document's bytes and writes what it found; it has no business renaming a
-- document, moving it between matters, or changing its role. A blanket
-- `update on document` would have granted all three, and the grant is the
-- guarantee -- not the code that happens not to write.
--
-- `markup_notice` is deliberately NOT here, and the absence is a recorded
-- limitation rather than an oversight. Detecting tracked changes means
-- reading `<w:ins>`/`<w:del>` out of the .docx package (src/lib/docxMarkup.ts),
-- which still lives browser-side; the uploader supplies the notice and this
-- worker must not overwrite it with a blank. A worker that could write the
-- column would, on its very first docx, replace "this document carries
-- tracked changes" with nothing -- which is the counterparty's redline read
-- back as the contract, the second entry on CLAUDE.md's list.
grant update (text, parse_state, parse_error) on document to lexprompt_worker;

-- WHO ASKED FOR THIS RUN, so the gateway's call log can name them.
--
-- FOUND BY RUNNING IT, not by a test: every cell of the first real run failed
-- with "permission denied for table app_user", because `actorForRun` reads the
-- requester's identity to build the actor every gateway call carries -- and
-- 005 granted the worker `select` on review, document, playbook_version and
-- workspace_setting and not on this. The run still ENDED (three error
-- findings, a `succeeded` run, a message naming the table), which is the
-- system failing in the loud direction; it did not silently review nothing.
--
-- COLUMN-LEVEL, and `email` is deliberately not among them. The gateway's
-- call body carries `actorUserId` plus the (issuer, subject) pair and no
-- address, so a worker that could read one would be able to read something
-- nothing it does needs. `status` is included because a person the firm has
-- disabled is a fact a later reader of this code may need; `email` is not.
grant select (id, workspace_id, issuer, subject, display_name, initials, role, status)
  on app_user to lexprompt_worker;

-- NOTHING on `finding_disposition` or `finding_disposition_event`, and the
-- absence is deliberate and load-bearing (006 revokes both explicitly). If a
-- code path ever needs the worker to write one, that is a finding and not a
-- reason to widen this.
