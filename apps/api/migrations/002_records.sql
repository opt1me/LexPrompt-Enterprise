-- Ids are TEXT and client-minted (P6). `uid()` is base36, not a UUID, and
-- re-keying every record would mean rewriting ids inside jsonb — a migration
-- that must edit nested JSON to stay consistent is the "failed storage
-- migration" shape with extra moving parts. `workspace_id` is what actually
-- scopes them, and every read carries it.
--
-- `document.kind` ('matter'|'precedent') is NOT created here — it arrives in
-- migration 003 (Task 19), together with the copy change S24 requires
-- alongside it. `doc_type` below is the unrelated FILE type
-- ('pdf'|'docx'|'txt'), which this table has needed since the first read.

create table matter (
  id           text primary key,
  workspace_id uuid not null references workspace(id),
  name         text not null,
  client       text,
  reference    text,
  -- §6.4: already populated from the local profile, and now a foreign key.
  -- NULLABLE because P16 maps an empty attribution to NULL rather than
  -- claiming the uploader wrote it — `src/types.ts`'s `Matter.ownerId` is a
  -- required `string` on the wire, so `rows.ts` is what turns '' into NULL
  -- on the way in and back into '' on the way out.
  owner_id     uuid references app_user(id),
  created_at   timestamptz not null,
  updated_at   timestamptz not null,
  version      bigint not null default 1,
  -- The tiebreak `_seq` used to provide. IndexedDB's getAll() promised no
  -- order, so sub-project A persisted a counter; Postgres gives one free.
  -- The wire type does not carry it, exactly as `stripSeq` did not.
  seq          bigint generated always as identity
);
create index matter_workspace_idx on matter (workspace_id, updated_at desc, seq desc);

-- `src/types.ts`'s `DocumentRecord.matterId` is a required `string` — a
-- persisted document always belongs to a matter (its own docstring says so:
-- "once it belongs to a Matter"). The reference brief for this migration
-- left this column nullable; that disagreed with the shipped wire type, so
-- it is NOT NULL here (`records.pg.test.ts`'s "refuses a document with no
-- matter_id" is written against this).
create table document (
  id               text primary key,
  workspace_id     uuid not null references workspace(id),
  matter_id        text not null references matter(id) on delete cascade,
  name             text not null,
  -- `kind` in types.ts is 'pdf'|'docx'|'txt' — the FILE type. §11.1's
  -- `document.kind` is 'matter'|'precedent'. Two different facts with one
  -- word, and conflating them would be a defect nobody could see. The file
  -- type is `doc_type` here and migration 003 adds `kind` for the other.
  doc_type         text not null check (doc_type in ('pdf', 'docx', 'txt')),
  text             text not null,
  -- Not on `DocumentRecord` — the browser extracts text synchronously
  -- before a document is ever written, so nothing today produces 'pending'.
  -- Kept as a valid state for a future async ingest path; `rows.ts` derives
  -- 'parsed'/'failed' from `parseError`'s presence and never reads this
  -- column back onto the wire type.
  parse_state      text not null check (parse_state in ('pending', 'parsed', 'failed')),
  parse_error      text,
  markup_notice    text,
  byte_size        bigint not null,
  -- Not on `DocumentRecord` either: the file's bytes are a Blob, stored and
  -- addressed separately (CLAUDE.md: page images are derived and never
  -- persisted, and the original bytes are the one thing that is). A future
  -- document repository supplies both from the Blob it is storing.
  mime             text not null,
  blob_key         text not null,
  content_sha256   text,
  -- 'standalone' unless the document belongs to a collection. `collection_id`
  -- carries NO foreign key on purpose: CLAUDE.md is explicit that grouping
  -- and ungrouping write the collection record and a member's `role` as
  -- SEPARATE writes, so the two can briefly disagree, and `Collection`'s own
  -- `baseDocumentId`/`variesDocumentIds` — not this column — is authoritative.
  -- An enforced FK here would reject the very non-atomicity CLAUDE.md
  -- documents as expected.
  role             text not null check (role in ('base', 'varies', 'standalone')),
  collection_id    text,
  document_date    timestamptz,
  added_at         timestamptz not null,
  added_by_user_id uuid references app_user(id),
  version          bigint not null default 1,
  seq              bigint generated always as identity
);
create index document_matter_idx on document (workspace_id, matter_id);

create table collection (
  id                  text primary key,
  workspace_id        uuid not null references workspace(id),
  matter_id           text not null references matter(id) on delete cascade,
  name                text not null,
  base_document_id    text not null,
  -- Ordered EXPLICITLY (ruling R-C3) — a jsonb ARRAY, never an object, so a
  -- collection whose amendments are keyed rather than ordered fails loudly
  -- rather than silently losing the order a person chose.
  varies_document_ids jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(varies_document_ids) = 'array'),
  created_at          timestamptz not null,
  created_by_user_id  uuid references app_user(id),
  version             bigint not null default 1,
  seq                 bigint generated always as identity
);
create index collection_matter_idx on collection (workspace_id, matter_id);

-- `playbook.current_version_id` and `playbook_version.playbook_id` point at
-- each other, so ONE of the two FKs has to be added after both tables
-- exist — added below, once `playbook_version` is in place, rather than
-- reordering the tables to hide the cycle.
create table playbook (
  id                  text primary key,
  workspace_id        uuid not null references workspace(id),
  name                text not null,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  current_version_id  text,
  -- The mutable working copy (`PlaybookDraft`), present only while there are
  -- unpublished edits — hence nullable, unlike every other jsonb column
  -- here, which are all NOT NULL columns on records that always have one.
  draft               jsonb check (draft is null or jsonb_typeof(draft) = 'object'),
  schema_version      int  not null,
  -- Not on `Playbook` in `src/types.ts` today — playbooks are a shared
  -- editorial asset with no ownership field on the wire type, so nothing
  -- writes this column yet. Kept nullable and untouched by `rows.ts`,
  -- exactly as `document.content_sha256` is: a column the schema is ready
  -- for before the application is (`records.pg.test.ts`'s "accepts a NULL
  -- owner_id" — P16 — exercises it directly).
  created_by_user_id  uuid references app_user(id),
  version             bigint not null default 1,
  seq                 bigint generated always as identity
);
create index playbook_workspace_idx on playbook (workspace_id, updated_at desc, seq desc);

-- Immutable (§6.1): nothing overwrites a version once published, because a
-- review that says "ran against v4" has to be able to prove what v4 was.
-- `content` carries everything of `PlaybookVersion` that is not its own
-- column — name, contractType, systemPrompt, formatPrompt, riskTolerance,
-- clauses, changeSummary, schemaVersion (`Omit<PlaybookVersion, 'id' |
-- 'playbookId' | 'version' | 'publishedAt' | 'publishedByUserId'>` in
-- `rows.ts`). `summary` mirrors `content.changeSummary` for the same reason
-- `playbook.name` mirrors its current version's — a version-history list
-- reads it without parsing jsonb.
create table playbook_version (
  id                    text primary key,
  workspace_id          uuid not null references workspace(id),
  playbook_id           text not null references playbook(id) on delete cascade,
  version_number        int  not null,
  content               jsonb not null check (jsonb_typeof(content) = 'object'),
  summary               text,
  published_at          timestamptz not null,
  published_by_user_id  uuid references app_user(id),
  unique (playbook_id, version_number)
);
create index playbook_version_playbook_idx on playbook_version (workspace_id, playbook_id);

alter table playbook
  add constraint playbook_current_version_fk
  foreign key (current_version_id) references playbook_version(id);

create table review (
  id                   text primary key,
  workspace_id         uuid not null references workspace(id),
  matter_id            text not null references matter(id) on delete cascade,
  -- A deep copy of what this review CLAIMS to have checked. `jsonb` rather
  -- than a structured clone — the same guarantee by different means (§3).
  playbook_snapshot    jsonb not null check (jsonb_typeof(playbook_snapshot) = 'object'),
  playbook_version_id  text references playbook_version(id),
  -- `Review.documentIds` on the wire — a convenience mirror of the ids
  -- already nested inside `target`; kept as its own column so a full
  -- round-trip through `rows.ts` does not have to unpack `target` to answer
  -- "which documents did this review cover".
  document_ids         jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(document_ids) = 'array'),
  target               jsonb not null check (jsonb_typeof(target) = 'object'),
  -- P11: findings stay a jsonb map in Stage 2 and become rows in Stage 3,
  -- with the engine that forces it (§13). Stored as the EXACT
  -- Record<findingsKey, Record<clauseId, Finding>> shape types.ts already
  -- has, so Stage 3's migration is a shred rather than a translation.
  findings             jsonb not null default '{}'::jsonb
                         check (jsonb_typeof(findings) = 'object'),
  model_id             text not null,
  started_at           timestamptz not null,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  created_by_user_id   uuid references app_user(id),
  version              bigint not null default 1,
  seq                  bigint generated always as identity
);
create index review_matter_idx on review (workspace_id, matter_id);

-- `Changeset.fromVersionId` in `src/types.ts` is a required (non-optional)
-- `string` — a changeset is always computed against a specific, already
-- published version — so `from_version_id` is NOT NULL, unlike the
-- `*_user_id` columns' empty-string-as-NULL convention, which exists
-- precisely because THOSE wire fields tolerate an unattributed ''.
create table changeset (
  id                     text primary key,
  workspace_id           uuid not null references workspace(id),
  playbook_id            text not null references playbook(id) on delete cascade,
  from_version_id        text not null references playbook_version(id),
  source_summary         text not null,
  -- An ARRAY, not an object (unlike every other jsonb column above): a
  -- changeset whose items are keyed rather than a list is not a changeset.
  items                  jsonb not null default '[]'::jsonb
                          check (jsonb_typeof(items) = 'array'),
  created_at             timestamptz not null,
  created_by_user_id     uuid references app_user(id),
  -- Set on publish. References `playbook_version` rather than being folded
  -- into `from_version_id`, which stays the version this changeset was
  -- computed AGAINST — the two answer different questions once a changeset
  -- is published.
  published_version_id  text references playbook_version(id),
  version                bigint not null default 1,
  seq                    bigint generated always as identity
);
create index changeset_playbook_idx on changeset (workspace_id, playbook_id);

-- Grants (P10). Note what playbook_version does NOT get.
grant select, insert, update, delete on matter, document, collection, playbook, review, changeset
  to lexprompt_app;
grant usage, select on all sequences in schema public to lexprompt_app;
-- §6.1: "Immutable — enforced by REVOKE UPDATE, DELETE from the app role,
-- not by convention." An INSERT-only grant is what makes a published
-- version's immutability a property of the database rather than a property
-- of the code that happens not to write it. `publishVersion` mints a fresh
-- id on every call and never reuses one, so there is nothing to update.
grant select, insert on playbook_version to lexprompt_app;
