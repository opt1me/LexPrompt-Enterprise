-- §6.5 / §11.1: the durable link from a firm's house position back to the
-- precedent text that produced it.
--
-- "A position adopted six months ago still resolves to the documents and the
-- specific edits that produced it, and a partner asking 'where did this house
-- rule come from?' gets the four leases and the four strikes rather than a
-- shrug." Session-only, that claim was true for about ninety seconds.
--
-- P13: THE KEY IS NOT WHAT §6.5 WRITES, and this is a ruling rather than a
-- liberty. §6.5 writes `position_basis(standard_position_id, …)`, and a
-- `StandardPosition` HAS NO ID — it is a field on a `PlaybookClause` inside
-- an immutable `PlaybookVersion`. The only id-shaped thing nearby is the
-- version's, and keying on that would make a position's evidence vanish the
-- next time anybody published: the exact opposite of the argument above. So
-- the key is `(playbook_id, clause_id)` — the clause's identity ACROSS
-- versions — and the row records separately which version adopted it and
-- what it said at the time.

create table position_basis (
  id                    text primary key,
  workspace_id          uuid not null references workspace(id),
  -- (playbook_id, clause_id), NOT a version id (P13): a clause's standard
  -- position is edited across versions and its evidence should follow the
  -- clause, or it would vanish on the next publish.
  playbook_id           text not null references playbook(id) on delete cascade,
  clause_id             text not null,
  -- What the position SAID when this evidence was gathered, and which
  -- version it was adopted in. Four leases support the sentence that was
  -- adopted, not whatever the sentence says today — the same wording-scoping
  -- rule `positionHealth.ts` applies to verifications, one layer down.
  -- Rendering four leases beside a sentence they never supported would be
  -- exactly the confidently-wrong claim that rule exists to prevent, so the
  -- panel COMPARES and says when the wording has moved.
  adopted_in_version_id text references playbook_version(id),
  adopted_text          text not null,
  -- NULL here means the set was DELETED, never "there never was one": every
  -- insert supplies both, so `precedent_set_id is null` is what makes a
  -- basis unresolvable — which the panel says in its own sentence rather
  -- than rendering an empty evidence panel ("empty is not broken", again).
  precedent_set_id      text references precedent_set(id) on delete set null,
  document_id           text references document(id) on delete set null,
  -- The durable copy of the edits, exactly as `Changeset.basis` takes one.
  -- With the sources now KEPT (§11.1) this is a corroboration rather than the
  -- only surviving witness — and `on delete set null` above is why it still
  -- has to be a copy: a set can be disposed of under a retention schedule
  -- while the playbook lives on.
  edits                 jsonb not null check (jsonb_typeof(edits) = 'array'),
  -- `source: 'diff'` never wears `source: 'tracked'`'s confidence, and
  -- "everywhere it appears" now includes a panel opened six months later.
  diff_derived_only     boolean not null,
  created_at            timestamptz not null,
  created_by_user_id    uuid references app_user(id),
  -- The reading order, and it has to be a column. Every row of one basis is
  -- inserted inside a single transaction, so `created_at` (`now()`, the
  -- transaction timestamp) is IDENTICAL across all four — and the id is a
  -- random `uid()`, so ordering by it shuffles the four leases into an
  -- arbitrary order on every read. "Two sorts that must agree" is this
  -- project's most repeated defect; here it is one sort that agreed with
  -- nothing. `seq` is the same answer `matter`, `document` and the rest use.
  seq                   bigint generated always as identity
);
create index position_basis_clause_idx on position_basis (workspace_id, playbook_id, clause_id);

-- NO `strength`, NO `supporting`, NO `total` COLUMNS, and their absence is
-- the point. `strength.ts` computes them from the basis and
-- `inferPositions.ts` discards any the model volunteers; a stored copy would
-- be a second, frozen answer to the one number this feature's credibility
-- rests on — and it would be the copy a panel read. `positionBasis.pg.test.ts`
-- asserts against `information_schema` that no such column exists, so adding
-- one is a test failure rather than a review catch.

-- INSERT and DELETE, no UPDATE. Evidence is recorded once, at the moment a
-- position is adopted; a row that could be edited afterwards is not evidence
-- of anything. DELETE exists for the playbook cascade to be honest about
-- what a delete removes.
grant select, insert, delete on position_basis to lexprompt_app;
