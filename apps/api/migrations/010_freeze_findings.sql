-- 010: `review.findings` is FROZEN. The column and its data STAY.
--
-- P18, and CLAUDE.md's own rule: "Never delete what you cannot read." The
-- `finding`, `finding_disposition` and `note` tables have been the
-- authoritative record since Task 14 flipped the reader and Tasks 18-21
-- flipped the writer. This column is what the shred in 007 read FROM, and it
-- is the only thing that can still answer "did the migration lose anything?"
-- — which `reconcileFindings` asks, key by key, and which is why that
-- function survives the deletion of the shadow writer beside it.
--
-- It is dropped by a LATER release, once the owner confirms the rows are
-- good, and that is the same release that deletes the browser's local
-- IndexedDB database (Stage 2's interface note 13).
--
--
-- ## Why this is a REVOKE-then-GRANT and not `revoke update (findings)`
--
-- `revoke update (findings) on review from lexprompt_app` DOES NOTHING when
-- the role holds a TABLE-level UPDATE, which 002 granted it. Postgres keeps
-- table privileges in `relacl` and column privileges in `attacl`; a
-- column-level revoke only removes from the second. Verified against this
-- project's own database before this file was written:
--
--   grant select, insert, update, delete on _probe to lexprompt_app;
--   revoke update (b) on _probe from lexprompt_app;
--   select has_column_privilege('lexprompt_app','_probe','b','update');  -- t
--
-- No error. No warning. A freeze that froze nothing, and every test that
-- believed it would have been asserting about a grant that was still there.
-- So the table-level UPDATE is revoked and every column EXCEPT `findings` is
-- granted back by name.
--
--
-- ## What this does NOT revoke, and why
--
-- INSERT. It stays table-level, deliberately:
--
--  * The verb that can destroy the pre-migration backup is UPDATE. An INSERT
--    can only ever write this column on a row being CREATED now, which has
--    no backup to lose — a review that does not exist yet has no history for
--    a blob to be the record of.
--  * The suites that READ and RECONCILE the frozen blob have to be able to
--    construct one, inside the rolled-back app-role transaction they all
--    run in. Making that impossible would leave `reconcileFindings` — the
--    one tool for a future doubt about the migration — testable only by
--    reaching for the migrator connection, which is outside every one of
--    those suites' isolation.
--
-- The route no longer names `findings` in its INSERT either (the column
-- default `'{}'::jsonb` applies), and `stage3DoD.test.ts` scans the source
-- for any statement that does. Grant plus scan, and the gap between them is
-- named here rather than left for a reader to discover.
--
-- `lexprompt_worker` holds `select on review` and nothing else (005), so
-- there is no UPDATE of its to revoke. Asserted rather than restated:
-- `frozenBlob.pg.test.ts` asks `has_column_privilege` for both roles.

revoke update on review from lexprompt_app;

grant update (
  id, workspace_id, matter_id, playbook_snapshot, playbook_version_id,
  document_ids, target, model_id, started_at, completed_at, cancelled_at,
  created_by_user_id, version
) on review to lexprompt_app;

-- `seq` is `generated always as identity` and is not updatable by anybody,
-- so it is absent from the list above rather than granted uselessly. A
-- column added to `review` by a later migration is likewise absent, which
-- means an UPDATE of it fails LOUDLY with a permission error rather than
-- quietly succeeding — and `frozenBlob.pg.test.ts` asserts the updatable set
-- is exactly every column but these two, so the new column's own migration
-- has to add its grant.

comment on column review.findings is
  'FROZEN 2026-08-30 (Stage 3, P18). The authoritative findings are the finding, '
  'finding_disposition and note tables. This column is the pre-migration backup, is not '
  'updatable by any application role, and is read only by reconcileFindings. Do not read it '
  'as a source of truth; do not drop it without the owner confirming the rows are good.';
