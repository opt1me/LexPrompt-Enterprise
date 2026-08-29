-- §11.1 / S23. A precedent is somebody else's deal, brought in to learn
-- from, usually with an opposing party's markup still in it. If it appeared
-- in a matter's document list it could be opened as though it were the deal
-- under review, added to a collection, run through a playbook, or cited in
-- an export — and a citation pointing into the wrong client's lease is the
-- kind of error this app exists to make impossible.
--
-- NOT a nullable matter_id alone, and NOT a naming convention: this is a
-- distinction that must survive somebody writing a new query.
--
-- SHIPPED IN THE SAME COMMIT AS THE COPY CHANGE. §11.1 states it as an
-- acceptance condition: "There is no release in which the storage exists and
-- the sentence does." The sentence is `PrecedentIntake.tsx`'s "Read once to
-- learn from. Never stored.", replaced by `PRECEDENT_STORAGE_PRIVACY` in
-- `src/lib/privacyCopy.ts`. If you are reading this file in a commit that
-- does not also touch `src/features/redlines/PrecedentIntake.tsx`, something
-- has gone wrong that no test can see.

create table precedent_set (
  id                 text primary key,
  workspace_id       uuid not null references workspace(id),
  name               text not null,
  -- NULL until a playbook adopts from it (§6.5). No foreign key action
  -- beyond `set null`: deleting a playbook must not destroy the firm's own
  -- precedent documents, which are evidence in their own right.
  playbook_id        text references playbook(id) on delete set null,
  created_by_user_id uuid references app_user(id),
  created_at         timestamptz not null,
  version            bigint not null default 1,
  seq                bigint generated always as identity
);
create index precedent_set_workspace_idx on precedent_set (workspace_id, created_at desc, seq desc);

-- `kind` is 'matter'|'precedent' — §11.1's distinction. `doc_type` is the
-- unrelated FILE type ('pdf'|'docx'|'txt'), which 002 named apart from this
-- one deliberately: two different facts with one word would be a defect
-- nobody could see.
alter table document add column kind text not null default 'matter'
  check (kind in ('matter', 'precedent'));
alter table document add column precedent_set_id text references precedent_set(id) on delete cascade;
-- The default exists only so the ALTER above can run against rows that
-- already exist, every one of which is a matter document. It is DROPPED
-- immediately, because a default is how a future INSERT that forgets `kind`
-- silently becomes a matter document — and "silently becomes a matter
-- document" is precisely the failure this column exists to prevent. Every
-- statement that writes a `document` row now names `kind` explicitly, in
-- the routes and in the test fixtures alike.
alter table document alter column kind drop default;

-- `matter_id` was NOT NULL in 002, because every document then belonged to a
-- matter. A precedent belongs to none, so the column becomes nullable and
-- the check below takes over the job the NOT NULL was doing — in BOTH
-- directions, so "a document with no matter and no set" cannot quietly
-- become a third state nothing filters.
alter table document alter column matter_id drop not null;

alter table document add constraint document_kind_shape check (
  (kind = 'matter'    and matter_id is not null and precedent_set_id is null) or
  (kind = 'precedent' and matter_id is null     and precedent_set_id is not null)
);

create index document_precedent_set_idx on document (workspace_id, precedent_set_id);

grant select, insert, update, delete on precedent_set to lexprompt_app;
