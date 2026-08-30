-- Two repairs found by Part 3A's adversarial review, and one of them is
-- about what "evidence" means.
--
-- ============================================================
-- 1. THE HISTORY IS EVIDENCE, SO NOTHING MAY DELETE IT BY REFLEX
-- ============================================================
--
-- `006_dispositions.sql` says `finding_disposition_event` is "INSERT-only to
-- every application role (the grants below), WHICH IS WHAT MAKES IT EVIDENCE
-- RATHER THAN A CLAIM", and grants only `select, insert`. But it also gave
-- the table a foreign key to `finding (...) on delete cascade`, and
-- `005_findings.sql` grants `delete on finding to lexprompt_app`. So the app
-- role held a TRANSITIVE delete on the evidence table: one `delete from
-- finding` and the record of who verified that clause, when, and what they
-- changed it from is gone, with the grant that was supposed to prevent it
-- still in place and still true on its face.
--
-- 005's justification for that DELETE was "a key absent from the blob is a
-- judgement that no longer exists in the record of truth either". That is
-- true of the CURRENT disposition, which the blob carries a copy of and the
-- shadow writer keeps in step with it. It is false of the HISTORY, which
-- never had a copy in the blob and never will: nothing anywhere else records
-- that a rejection was withdrawn on Tuesday.
--
-- So the history's parent becomes the REVIEW rather than the finding.
--
--   * A finding deleted key by key -- which is what the shadow writer does
--     when a re-saved review no longer carries a clause -- no longer takes
--     its history with it. The evidence outlives the row it was about, which
--     is precisely what evidence is for.
--   * Deleting the whole REVIEW still removes everything about it. That is a
--     deliberate, whole-record deletion by somebody who asked for it, and it
--     is the case 005's sentence actually covers.
--
-- The `finding_disposition` table KEEPS its cascade from `finding`: the
-- current disposition is the blob's mirror, it is what 005's reasoning was
-- written about, and a current judgement about a finding nobody has is not
-- evidence of anything.
--
-- The columns do not change. Only what the row hangs from does.
--
-- The old constraint is dropped BY LOOKUP rather than by its generated name.
-- Postgres would have called it
-- `finding_disposition_event_review_id_findings_key_clause_id_fkey`, which is
-- exactly 63 characters -- the identifier limit -- so a name written out here
-- is one rename or one column away from being silently truncated to
-- something else, and `drop constraint <wrong name>` fails the whole
-- migration at deploy time.
do $$
declare
  fk text;
begin
  select conname into fk
    from pg_constraint
   where conrelid = 'finding_disposition_event'::regclass
     and confrelid = 'finding'::regclass
     and contype = 'f';
  if fk is null then
    raise exception 'finding_disposition_event has no foreign key to finding to replace. Either 006 changed, or this migration has already been applied by hand.';
  end if;
  execute format('alter table finding_disposition_event drop constraint %I', fk);
end $$;

alter table finding_disposition_event
  add constraint finding_disposition_event_review_fkey
  foreign key (review_id) references review(id) on delete cascade;

-- `disposition_event_finding_idx` still covers reads by finding; the key
-- columns are still there and still written. Nothing reads this table by
-- review alone yet -- Task 14 will -- so no second index is added for a
-- query nobody issues.

-- ============================================================
-- 2. THE EVENTS ROUTE'S OWN QUERY HAD NO INDEX
-- ============================================================
--
-- `readEvents` filters `where workspace_id = $1 and run_id = $2 and id > $3`,
-- and `event` carried only `event_review_idx (workspace_id, review_id, id)`,
-- `event_at_idx (at)` and the primary key. Every poll of a live run scanned
-- the workspace's whole seven-day buffer. Stage 4's socket polls this harder
-- than the HTTP route does.
--
-- Column order matches the predicate: the two equalities first, the range
-- last, so the `id > $3` is a scan of the tail of a matching prefix rather
-- than a filter after one.
create index event_run_idx on event (workspace_id, run_id, id);
