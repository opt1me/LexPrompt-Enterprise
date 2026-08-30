# LexPrompt Server — Stage 3: the server-side engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a review run from something one browser orchestrates into a queued, resumable, cancellable server-side job; turn `review.findings` from a `jsonb` blob written whole into `finding` rows written one cell at a time; give a finding one current disposition and a complete append-only history of every change to it; delete `carryHumanState` and `findingMerge.ts`; and do all of that without losing one lawyer's verification.

**Architecture:** The domain logic the engine is made of — `extractClause`, `extractCollectionClause` and their closure — moves into `packages/core` and takes its model client as a parameter instead of importing the browser's. `apps/api` gains a `run` / `run_cell` queue, an in-process worker pool that leases cells with `SELECT … FOR UPDATE SKIP LOCKED`, a parse worker that writes `parse_state`, and one transaction per completed cell. Human-authored state moves out of the findings blob into `finding_disposition`, `finding_disposition_event` and `note`, on which **the worker's database role holds no grant at all** — so there is no snapshot to merge and nothing to clobber. The migration from blob to rows is done in two moves with a proof between them: rows are built and shadow-written first while the blob stays authoritative, reconciled key by key on every write, and only then does the reader flip, the writer flip, and the blob freeze.

**Tech Stack:** Everything Stage 2 shipped, plus `@napi-rs/canvas` (server-side page rendering, Spike 1 — or nothing, if Spike 1 says no) and `pdfjs-dist` 6 under Node 22 in `apps/api`. No queue library, no job framework, no ORM: the queue is two tables and `FOR UPDATE SKIP LOCKED`, which Postgres does correctly and a dependency would only wrap. TypeScript 5.8, Vitest 3.2 (`test.projects`: `web` jsdom, `core`/`gateway`/`api` node, plus the `api-pg` and compose configs), Fastify 5, `pg` 8, `@azure/storage-blob` 12, undici, `jose`, `oidc-client-ts`, Keycloak, Azurite, Postgres 16, Docker Compose, `azd` + Bicep.

**Spec:** `docs/superpowers/specs/2026-08-28-lexprompt-server-design.md` (binding authority). Stage 3's boundary is §13; its definition of done is §18 item 4; the engine is §9 and §9.1; findings as rows is §6.2; the collaboration tables are §6.3 and §6.3.1; what is new is §6.5; settings are §6.6; ingest and parsing are §11; the testing bar is §14; Spike 1 is §15; rulings **S3**, **S5**, **S9**, **S11**, **S12**, **S14**, **S16**, **S17**, **S19 (amended)**, **S21**, **S22**, **S23**, **S26**, **S30**; and `CLAUDE.md`, which was rewritten during Stage 2 and binds everything below.

**Preceding plan:** `docs/superpowers/plans/2026-08-29-lexprompt-server-stage-2-storage-and-auth.md` and its ledger `.superpowers/sdd/2026-08-29-lexprompt-server-stage-2-storage-and-auth/progress.md`. **Read the ledger's standing rules and its pre-flight before Task 1**, and read that plan's closing section *"Interfaces Stage 3 and later must honour"* — eighteen numbered items, every one of which this plan either consumes or supersedes explicitly. This plan continues the decision numbering: Stage 1's are **P1–P5**, Stage 2's are **P6–P16**, this plan's are **P17–P28**. `rulings.md`'s **D1–D5** remain the *owner's* decisions. A `D<n>` is a reference to `rulings.md`; a `P<n>` is a reference to a plan.

---

## Scope check, before anything else: one stage, two parts, and the reason the seam is where it is

§20 estimates Stage 3 at **1.5–2 sub-project equivalents**. §13 says a stage larger than its estimate is **decomposed further rather than compressed**, and §19 says the same from the other side. Two things make the real size larger than the spec drew it, and both are findings rather than opinions:

1. **Stage 0 never happened for the review path.** §5 lists a `packages/core` inventory of some thirty modules including `extractClause` / `extractCollectionClause` themselves, and §9 says the workers *"execute `extractClause` or `extractCollectionClause` from `packages/core`"*. The shipped `packages/core` has **five** source modules: `json/parseJsonLoose`, `model/protocol`, `model/client`, `model/sse`, `api/records` and `playbook/applyChangeset`. `extractClause` lives in `src/features/review/`, imports nine modules from `src/lib/`, imports `src/types.ts`, and calls `gatewayModelClient` **by import** rather than taking a client. None of it is reachable from `apps/api` today. Completing that extraction is Stage 0's unfinished half and it is Tasks 2 and 3 here, because the server cannot run an extractor that lives in the browser.
2. **Spike 1 is unrun.** §15 says server-side page rendering is unproven and §19 says *"the whole scanned-document path depends on it, and the scanned-document path is this project's founding defect."* The fallback (Document Intelligence OCR at ingest) is not a drop-in: it is a subprocessor and a §12 change. Task 1 runs the spike as a task, with a named branch either way, before anything depends on the answer.

**So it is planned as two execution cycles with a review gate between them, in one document** — the shape Stage 2 used, for the reason Stage 2 gave: the second cycle's tasks consume the first cycle's routes and types, and a second document would reproduce Stage 1's most expensive failure, a brief naming an interface that had moved. One document, two parts, and **Part 3B does not begin until Part 3A's definition of done is met and verified on a running stack.**

| | Part 3A — *the rows exist and are proven equal* | Part 3B — *the engine is the writer and the browser watches* |
|---|---|---|
| Tasks | 1–13 | 14–26 |
| Ships | the core extraction; `finding`, `note`, `finding_disposition`, `finding_disposition_event`, `run`, `run_cell`, `event`; the jsonb→rows migration with its census and report; a shadow writer that keeps the rows in step with the blob on every write, and a reconciliation that proves it; the queue, the worker, cancel, resume, the reaper, the parse worker | the read flip (findings come from rows); disposition and note routes; the re-run reset transaction; the browser's run client; `handleStartRun` / `handleVerify` / `handleRetryCell` rewired to the server; **`carryHumanState` and `findingMerge.ts` deleted**; the blob frozen; exports over rows; the sweeps |
| Its own DoD | rows equal the blob for every review in the database, key by key and disposition by disposition; a run survives a worker restart and completes; cancelling leaves no cell in `pending`; the worker role provably cannot write either disposition table | §18 item 4 in full, plus: `carryHumanState` is deleted and nothing regressed; re-running a clause clears its disposition and its net position in one transaction and records the clearing, attributed |
| Shippable alone? | **Yes, and it must be.** At the end of 3A the app behaves exactly as it does today — the browser still orchestrates, still reads and writes `review.findings` — with a proven shadow copy in rows and a queue nothing has been pointed at yet. | Yes. It flips the reader, then the writer, then freezes the source. |

**The one thing the split may not do.** The reader flip (Task 14), the writer flip (Tasks 18–20), the deletion of `carryHumanState` (Task 21) and the freezing of `review.findings` (Task 22) are **one sequence in one part**, in that order. There is no arrangement in which the browser has stopped writing the blob while the rows are not yet authoritative, and none in which `carryHumanState` is deleted while a browser still orchestrates a run — `runReview` overwrites human state twice per cell without it, and that is not hypothetical, it is what the function exists to prevent.

**What this costs if the split is wrong:** one review gate's worth of ceremony between Task 13 and Task 14, plus a shadow-write path that lives for one part and is deleted in Task 22 (expected work, named, exactly as the uploader's removal was). What the alternative costs: the largest single data migration in the design, performed in the same commit that changes who writes the data, with a lawyer's verification inside it.

---

## What Stage 2 shipped that this plan builds on

Read the shipped source before writing code against any of it. **Where the shipped source disagrees with this brief, the shipped source wins** — that sentence appears in every task's Interfaces block, and it is there because thirteen Stage 1 briefs and several Stage 2 briefs named a signature that had moved.

| Shipped in Stage 2 | Where | What Stage 3 does with it |
|---|---|---|
| `Db` / `Tx` / `makeDb` / `makePool`; `BEGIN` at depth 0, `SAVEPOINT` below it | `apps/api/src/db/pool.ts` | The worker's per-cell transaction is a `db.tx`, and it nests inside a route's transaction in tests without becoming a fake one |
| `runMigrations(db, dir)` — ordered, once, under `pg_advisory_xact_lock`; **an applied file is immutable** | `apps/api/src/db/migrate.ts` | Adds `005`–`008`. Never edits `001`–`004` |
| Two roles: `lexprompt_migrator` (schema owner) and `lexprompt_app` (every request) | `apps/api/migrations/000_preconditions.sql` | Adds a **third**, `lexprompt_worker`, with no grant on either disposition table |
| `review` table with `findings jsonb` and `version bigint`, and the `where review.version = $N` refusal | `apps/api/migrations/002_records.sql`, `apps/api/src/routes/reviews.ts` | The blob is shadowed, then frozen by column-level `REVOKE UPDATE`, and never dropped |
| `ROUTE_POLICY` with **no default**; a route with no entry throws at registration | `apps/api/src/auth/routeTable.ts` | Every new route adds a line in the task that registers it |
| `Actor { id, issuer, subject, email?, displayName, initials, role, workspaceId }`, resolved once per request | `apps/api/src/auth/actor.ts` | The run's `requested_by_user_id`, every disposition's `by_user_id`, and the gateway's `actorUserId` |
| `ModelError(message, code, status, callId)` + `registerErrorEnvelope`; a closed set of codes | `packages/core/src/model/protocol.ts` | New codes are added to that set, never invented at a route |
| `GatewayClient { infer, models, stream }` and `withActor(body, workspaceId, actor)` | `apps/api/src/gatewayClient.ts`, `apps/api/src/actorBody.ts` | The worker's model client. The **actor stays the person who asked for the run**, never a service identity |
| `ConflictError` — the 409 that carries the current row | `apps/api/src/errors.ts` | Reused verbatim for a stale disposition change |
| `withPg` / `appDb()` / `migratorDb()` / `dbOn(t)`; `.pg.test.ts` runs against a real Postgres and **does not skip** | `apps/api/test/helpers/pgHarness.ts` | Every schema, grant and migration test in this stage |
| `blobKeyFor(workspaceId, documentId)` — the only place a blob key is built | `apps/api/src/routes/documents.ts` (verify the export site before importing it) | The parse worker and the page-image renderer read bytes through it |
| `document.parse_state` / `parse_error`, written from the browser's own parse (P12) | `apps/api/migrations/002_records.sql` | **Stage 3 changes only who writes them.** `'pending'` stops being unused |
| `workspace_setting.concurrency`, stored and unenforced (§6.6) | `apps/api/src/routes/workspaceSettings.ts` | Becomes a real per-run bound, snapshotted onto `run.concurrency` |
| `npm run typecheck` — discovery over `packages/*` and `apps/*` | `scripts/typecheck.mjs` | The gate. Bare `tsc --noEmit` is **not** the gate |

---

## Stage 1 and 2's lessons, encoded here rather than rediscovered

Each one changed something in the tasks below, and the change is named.

**1. Every dispatched brief in both stages contained real bugs in its reference code** — 19 of 23 in Stage 1, 17 of 17 in Stage 2. The worst would have refused `saveDraftAsV1` and `importPlaybook`, turned every mistyped URL into a 503, made "create a matter" a 500 with every unit test green, and refused every review and changeset a firm owns for want of a version-id remap. **Every code block below will be run by an implementer who has been told to distrust it.** Where this plan quotes a shipped signature it was read from the file; where it invents one, Step 1 writes the test that pins it before Step 3 writes the implementation. If a block does not compile, the shipped source wins and the implementer says so in their report.

**2. Interfaces drift between a brief being written and run.** Every task's **Interfaces** block carries *"read the shipped source; where it disagrees with this brief, the shipped source wins."* It is not boilerplate — it is the instruction that saved two Stage 1 tasks whose brief imported `Principal` from a file that does not exist.

**3. A test that cannot fail is this project's recurring defect** — at least eight across the two stages, including a `for update` mutation that did not fail because a unique constraint refused the duplicate either way, and an `authz` matrix that stayed green when a partner gate was downgraded because it used a fixture policy rather than the shipped table. So: **every guard in this plan carries the mutation that proves it bites, named by test title**, and **every scanner carries a sanity check that it finds what it scans** before it is used to assert an absence. A `not.toContain` gets a companion positive assertion in the same test.

**4. Three undeclared-cap defects have been found, all on the scanned-document path** — Fastify `bodyLimit`, nginx `client_max_body_size`, busboy `fieldSize`. A queue adds more tiers that can silently cap or time out, and one is new in kind: **the Postgres pool.** N worker slots each holding a transaction, plus M request handlers, must not exceed `API_DATABASE_POOL_MAX`, or the API deadlocks under its own worker and every symptom points somewhere else. The **Declared caps** table below is part of this plan's deliverable, and Task 10 fails if a value in it has no reader.

**5. The gate is `npm run typecheck`, and no gate is read through a pipe.** `npx vitest run` can report every test PASSED and still exit 1 on an unhandled rejection. Redirect to a file, capture `$?`, then read the file. `npm run test:pg` needs `scripts/pg-forward.sh` running and both `LEXPROMPT_TEST_DATABASE_URL` and `LEXPROMPT_TEST_MIGRATION_URL` exported.

**6. Plan tasks that RUN things, and assume browser automation is unavailable.** Stage 2 could not drive the UI at all — the Chrome extension disconnected, the Playwright MCP times out — and said so rather than reporting green over it. This plan does the same: Tasks 1, 7, 10, 11, 13, 18, 21 and 26 each carry a **run it** step against the live compose stack, using `curl`, `docker compose exec`, real Keycloak tokens and real Postgres, none of which needs a browser. **What only a human at a browser can confirm is listed once, in Task 26, by name**, and it is not pretended away.

**7. Fail loudly rather than answer quietly wrong** is the review standard for every task. In a stage that moves a lawyer's judgement from a blob into rows and hands the run to a worker nobody is watching, the specific shapes to watch are: a job that dies looking like a job that finished; a partial run reading as a complete one; a cancelled run indistinguishable from a failed one; a migration reporting success over a gap; and a disposition that arrives in the new table with the wrong person's name on it.

---

## Global Constraints

Copied from the spec, from `CLAUDE.md` and from the two preceding plans' still-binding constraints. Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** Prefer a loud, specific, recoverable failure over anything that could be mistaken for a successful empty result.
- **Human judgement is never derived.** A finding's disposition is a person's judgement about a specific answer, not a status the engine infers. `extractClause` and `extractCollectionClause` never write anything but `unchecked()`; the only writers of `finding_disposition` are the disposition route and the re-run reset. **The run worker's database role has no grant on `finding_disposition` or `finding_disposition_event` at all** — asserted by attempting the write and getting a permission error, never by grepping for call sites. (§3, §6.3, §14)
- **The re-run reset moves a disposition only *to* `unchecked`, never to `verified`.** A rule that can only remove a claim of human checking cannot manufacture one. `check (cause <> 'rerun_reset' or to_state = 'unchecked')` is a database constraint, not a convention. (§3, S21)
- **Re-running a clause resets its verification and its net position.** Load-bearing and mutation-tested today in `resetVerification` / `resetPosition` / `handleRetryCell`; findings-as-rows must **preserve** that behaviour, not re-implement it differently. Notes are **not** touched: a note is about the clause, not about one run's output. (§9.1, `CLAUDE.md`)
- **`findingsKeyFor` is the only place a findings key is derived**, and a collection review keys by the **collection** id, not by a document. It moves to `packages/core` and both sides call it. Six defects in sub-project C came from code that keyed by document id directly; a client/server split is the seventh opportunity. (§6.2)
- **`await-then-apply` survives verbatim.** No optimistic update for any human-authored state — not a disposition, not a note, not a net-position confirmation. The UI renders from the response the store returned and from nothing else. (§3, S8)
- **A load path distinguishes `not yet known`, `broken` and `empty`, and each renders differently.** **The fourth state, `stale`, is realtime's and arrives in Stage 4.** Do not build it here and do not half-build it. (§3)
- **`NULL` versus empty is load-bearing in the schema.** `truncated_documents` is `NULL` on a single-document finding, never `'{}'`. `net_position` is `NULL` on a standalone finding, never `'{}'`. `position_outcome` is `NULL` when there was no standard position to compare against, which is a different fact from `'unclear'`. `structuredClone` preserves an `undefined`-valued key, so `absentUnless` is used on every read-back and `expect('k' in obj).toBe(false)` is how absence is asserted — `toEqual` cannot tell absent from `undefined`. (§6.2, `CLAUDE.md`)
- **`workspace_id uuid not null` on every new table, and every query is scoped by it.** Task 25's scanner enforces it. (§6, S9)
- **Every check happens in the API.** The web app hides what a role cannot do; the API refuses it. `ROUTE_POLICY` has no default and a route with no entry fails registration. (§7)
- **A published `playbook_version` is immutable by grant, and `finding_disposition_event` is insert-only by grant** — `GRANT INSERT, SELECT` and nothing else, to any app role. Not a convention. (§6.1, §6.3, S11)
- **The two disposition tables are written in one transaction, always.** There is no path that writes `finding_disposition` without its `finding_disposition_event`. `finding_disposition` is a cache of the last row of the history, and a reconciliation that recomputes it from the history and finds it equal is part of the suite. (§6.3)
- **Page images are never persisted** — not in Postgres, not in Blob Storage, not anywhere. They are regenerated on demand for a document whose pages fall below `SCAN_TEXT_THRESHOLD` and held in an in-process LRU for the life of the run. (§6.5, §11, S12)
- **Scan detection is per page, not per document.** `SCAN_TEXT_THRESHOLD` is applied to each `[Page N]` segment. This blind spot has had to be fixed three times. (`CLAUDE.md`, §11)
- **Extraction takes documents hydrated *for review*.** A `DocumentRecord` and a `documentFileForViewing` result both lack page images; handing either to an extractor reviews a scanned document as though it said nothing — this project's founding defect, which has reopened twice. The server-side worker hydrates **for review**. (§11, `CLAUDE.md`)
- **`repairCitations` / `derivePage` read `doc.text`, never the readability-filtered text.** `usableText` strips `[Page N]` markers, so deriving a page from it would silently make "page where derivable" mean "page: never". (`CLAUDE.md`)
- **`verificationLabel` and `exportSummaryLine` in `findingOutcome.ts` remain the only place export wording lives.** `dispositionLabel` / `dispositionHistoryLine` are added **beside** them when the surfaces that need them ship — **in Stage 4**, not here. (§6.3)
- **Behaviour stays single-user.** R-G1 continues to bind until Stage 4: no assignee chip, no assign action, no second person's name anywhere, no presence, no realtime, **and no attribution or history surface**. Stage 3 ships the tables and the mechanism; §13 puts the surfaces in Stage 4 and is explicit that shipping mutability-by-others without them is the quiet lie the design exists to prevent. (§3.1, §13, S18)
- **`api` still may not egress.** The gateway remains the only route to a model. The worker calls the gateway through `apps/api`'s existing `GatewayClient` and nothing else. (§5)
- **The gateway is unchanged in this stage.** No new purpose, no new route, no new configuration key. `review.clause` and `review.collection_clause` are already in its purpose allowlist. If a task believes it needs a gateway change, that is a finding to report before making one.
- **When you find yourself writing a second copy of something, extract it then.** Not after the third. (§19, S14)
- **Mutation-test anything load-bearing.** Break the implementation, confirm the **named** test fails, restore. A green suite is not evidence.
- **A task that claims to change only a mechanism must not need a copy test edited.** `git status --porcelain -- '*.test.ts' '*.test.tsx'` after such a task should show only the tests that task was for. If a wording assertion moved, that is the finding, not a chore to absorb. (R-G22)
- **Gates for every task:** `npm run typecheck` clean (discovery-based, never bare `tsc`); `npm test` green **read from an exit code, not a summary line and never through a pipe**; `npm run build` clean with no externalization warning; `npm run test:pg` where the task touched SQL; `npm run test:compose` where the task touched the stack.
- **Commit at the end of every task, by pathspec — never `git add -A`** — then run `git show --stat HEAD` and read it. The verification, not the pathspec, is what catches a swept commit.

---

## Twelve decisions this plan makes, and why

Numbered **P17–P28**, continuing Stage 2's P6–P16 in the same repository. Each is load-bearing across several tasks, and each carries its cost if wrong, in `rulings.md`'s format. Task 26 records them there.

**P17 — The blob-to-rows migration is done in two moves with a proof between them: build and shadow-write the rows while the blob stays authoritative, reconcile key by key on every write, then flip the reader, then the writer, then freeze the blob.**
§13 calls this *"the largest single data migration in the plan"* and §19 has nothing kinder to say about it. The single-move alternative — migrate, flip, delete, in one release — puts a lawyer's verification inside a change that is also changing who writes it, which is two unrelated risks multiplied. Two moves means that at every moment there is a copy of every human judgement that the change under test has not touched, and the reconciliation is what turns "we believe the rows are right" into "the rows and the blob agree for every finding in the database, checked". The shadow writer is deleted in Task 22 and its removal is planned work, not debt.
*Cost if wrong:* one route writes two representations for the length of Part 3B, and a reconciliation test that runs against real data on every write in `.pg.test.ts`. Against that: a one-move flip whose defect is discovered later has no second copy to recover from, because the blob would already be gone.

**P18 — `review.findings` is frozen, never dropped. Column-level `REVOKE UPDATE (findings) ON review FROM lexprompt_app` in Task 22; the column and its data stay.**
*"Never delete what you cannot read"* is `CLAUDE.md`'s own rule and it is what the `localStorage` → IndexedDB migration did, deliberately, and disclosed. A `drop column` is unrecoverable and its failure mode — a finding whose verification did not make it across — is invisible for exactly as long as nobody looks at that clause. The column is dropped by a later release once the owner confirms the rows are good, in the same release that deletes the browser's local IndexedDB database (Stage 2's interface note 13).
*Cost if wrong:* a dead `jsonb` column carrying data no code reads, on every review row, for a release or two. Named in the README and in the migration's own comment so it is not mistaken for something still live.

**P19 — The migration is census-first, reconciles by key, and refuses on any human judgement it cannot place. It never reports success over a gap.**
Before it moves anything it records every finding whose `verification.state <> 'unchecked'` and every finding whose `netPosition.state <> 'unconfirmed'`, by `(review_id, findings_key, clause_id)`, into `finding_migration_census`. After it moves, it re-derives that same set from the rows and compares **by key, not by count** — a count-only check passes when two verifications swap places, which is the one arithmetic that would let a rejection land on the wrong clause. A `verification` naming a `byUserId` that resolves to no `app_user`, or a `rejected` with no reason, or a note whose `findingId` cannot be parsed back into `(findings_key, clauseId)`, **fails the whole migration by name and rolls it back**. It does not attribute to the operator, it does not downgrade to `unchecked`, and it does not skip the row.
*Cost if wrong:* a migration that can refuse to complete on data that is already in the database, blocking a deploy until someone looks at a named list of rows. That is recoverable in minutes. The alternative — attributing a lawyer's rejection to whoever ran the deploy, or quietly turning it into "not checked" — is the failure this whole project is organised against, and it would be invisible.

**P20 — Stage 0's core extraction is completed here for the review closure only, and `src/types.ts` is re-exported rather than moved.**
The server cannot run an extractor that lives in `src/features/`. What moves is the transitive closure `extractClause` and `extractCollectionClause` actually need — and nothing else, because a wholesale move of `src/lib` would touch every file in `src/` for no behaviour and make the diff unreviewable. The domain types those modules need move to `packages/core/src/domain/types.ts`, and **`src/types.ts` re-exports them**, so not one importing file in `src/` changes. §5's full inventory (`matterActivity`, `matterStats`, `docxRedlines`, `inferPositions`, `strength`, …) is **not** moved here: none of it is on the engine's path, and moving it would be a large mechanical change riding along with the most dangerous data migration in the project.
*Cost if wrong:* `packages/core` ends this stage with about half of §5's list rather than all of it, and a later stage moves the rest. Recorded as an open item in "Interfaces Stage 4 and later must honour" so it is a plan rather than an omission. The import-boundary test (S14) covers what has moved, so the half that has moved cannot be re-implemented in an app.

**P21 — The extractors take a `ModelClient` as a parameter. They do not import one.**
`extractClause` imports `gatewayModelClient` today, which is a browser module that reads `src/lib/config.ts` and `src/lib/auth/oidc.ts`. `packages/core` already declares `ModelClient` (`packages/core/src/model/client.ts`) and it is the obvious seam. The browser passes its existing `gatewayModelClient`; `apps/api` passes an adapter over the `GatewayClient` it already has. **One interface, two implementations, one extractor.**
*Cost if wrong:* one added parameter on two functions and on every test that calls them, and the parameter position matters — `App.verification.test.tsx`'s `extractClauseMock` destructures the fifth positional argument as the abort signal, so the client goes **first** (it is what the function is *for*) and `signal`/`context` keep their positions after it. Task 3 pins that with a test before changing anything.

**P22 — Run progress reaches the browser by polling the same `event` rows Stage 4 will push. One payload vocabulary, two transports.**
§8 puts WebSocket in Stage 4 and §13 agrees. Stage 3 still has to tell a browser that a cell finished. Inventing a Stage-3-only progress shape and replacing it in Stage 4 is two implementations of one idea a stage apart — this project's most repeated defect, on a schedule. So the `event` table (§6.5) and its payloads land here, `GET /v1/runs/:id/events?after=<id>` serves them over HTTP with the monotonic cursor §8 specifies, and Stage 4 changes the transport and the `resync_required` path, not the payloads.
*Cost if wrong:* a poll loop that exists for one stage, and a 7-day outbox filled a stage before anything replays from it. Against that: Stage 4 inheriting a cursor protocol it can test against an HTTP client before it has a socket.

**P23 — `audit_event` stays deferred, and Stage 3 does not invent a substitute for it.**
§13 puts the activity feed that reads it in Stage 4 and Stage 2 deferred the table for the reason that an append-only log with a writer and no reader makes its own grant test vacuous. Stage 3 produces the first acts that genuinely belong in it — a run started, a run cancelled — and it is tempting to create it here. It is not created here, and **nothing else is created in its place**: `run.requested_by_user_id`, `started_at`, `cancel_requested_at`, `finished_at` and `error` already record who did what to a run, and Stage 4's feed reads the `run` table alongside `audit_event` and `finding_disposition_event` in the `UNION` S22 already requires.
*Cost if wrong:* runs started and cancelled before Stage 4 are reconstructable from the `run` table but are not in the append-only audit log, so an audit export covering that period must say where its run history came from. Written into Task 26's README paragraph, and into `rulings.md`, rather than left for an auditor to notice.

**P24 — Notes become their own table now. Assignment does not, and `Verification.assigneeId` is dropped with its values named.**
§6.3 gives notes their own table and calls it R-B3's deferred migration; findings-as-rows is that migration, because a note cannot stay inside a `Finding` that no longer exists as an object. Assignment (§6.3's `assignment` table) is Stage 4's — it needs an assigner, a resolution and a person to reach, none of which exists before collaboration. `Verification.assigneeId` therefore has no home: S17 retires it, R1 says it reached nobody, and Stage 2's ledger deferred it here. It is **dropped**, and the migration **names every finding that carried a non-empty value** in its report rather than discarding them silently.
*Cost if wrong:* if any `assigneeId` in the owner's data meant something to someone, it is on the report and in the frozen blob (P18), so it is recoverable. Discarding it silently would not be.

**P25 — The sticky refused save is remedied by removing the whole-review write, not by weakening the version guard. An engine or metadata `409` re-reads and retries once; a human-authored write never auto-retries.**
Stage 2's Task 11–15 report: *"Once another writer moves the server past what this browser remembers, every subsequent save from this tab is refused until the review is re-read … during a live run it means the rest of that run is not persisted."* The cause is a browser holding a whole review and writing it repeatedly. When findings are rows written per cell by the server, the debounced whole-review saver goes away entirely and so does the stickiness (Task 18). What remains is the `review` row's own metadata, which a browser still writes rarely; there, a `409` triggers **one** re-read and one retry, because a metadata field carries no human judgement. A disposition or note `409` is never retried automatically — it is refused, and Stage 4 puts *"Priya changed this at 14:22"* on the same refusal.
*Cost if wrong:* one automatic retry on a metadata write could still lose a concurrent metadata edit — of which there are none in a single-user stage, and Stage 4's realtime version guard is the same number (Stage 2's interface note 6). Named so Stage 4 does not have to rediscover which writes retry and which do not.

**P26 — Concurrency is enforced at two tiers, both from stored configuration, and every other cap in the queue is declared in one table with a test that each has a reader.**
§9: *"Concurrency is bounded per run and per workspace, so a forty-document batch cannot starve a colleague's three-clause retry."* The per-run bound is `workspace_setting.concurrency`, snapshotted onto `run.concurrency` when the run is created (the same snapshot argument as `run.provider` / `run.model` / `run.jurisdiction` in §6.5 — a configuration change must not rewrite what a past run actually did). The per-workspace ceiling is `API_WORKSPACE_RUN_CONCURRENCY`. Three undeclared caps have already been found in this project, all on the scanned-document path; a queue adds at least eight more tiers, and the new one in kind is the **Postgres pool**.
*Cost if wrong:* a configuration table with a dozen rows and a test that walks it. Against that: a worker pool that quietly exhausts `API_DATABASE_POOL_MAX` and deadlocks the API under its own load, with every symptom pointing at the database.

**P27 — The worker is in-process in `apps/api`, behind an interface, on a single replica, and it is not a second deployable.**
§9 says exactly this (*"in-process in `api` at this scale, behind an interface so they can move to their own container without touching call sites"*), and Spike 3 has not run, so `api` is single-replica anyway. The lease (`leased_by`, `lease_expires_at`) is what makes a second replica or a second container a configuration change rather than a rewrite, and it is what makes "a worker that dies mid-cell" testable **today**, by killing the container.
*Cost if wrong:* a run's throughput is bounded by one API replica's worker slots. Named in the README. Moving to a separate container later touches the process that starts the pool and nothing else, because leasing already assumes competitors.

**P28 — Stage 3 changes no card copy and ships no attribution surface.**
§13: what Stage 3 does not ship is *"the history and attribution surfaces, and the export's point-in-time framing — all of which are Stage 4."* §6.3 states the attribution requirements in the present tense and a reader of §6.3 alone would build them here. They must not be built here: a card reading *"Verified by R. Okafor, 16:04 · was Rejected"* without the mutability, the realtime push and the export's "as at" stamp is a surface for a mechanism that does not exist yet, and half of it would be built twice.
*Cost if wrong:* the card in Stage 3 says exactly what it says today, over a data model that could say more. Which is the correct trade for one stage, and is why Task 21's proof is a mechanism test rather than a screenshot.

---

## Declared caps and timeouts

Every tier that can silently cap, truncate or time out a run. **Task 10 Step 7 asserts that each name below has a reader in the shipped source**, and the test names the ones that do not — because three undeclared-cap defects have already been found in this repository and every one of them read as correct code.

| Tier | Name | Value | Declared in | What happens at the cap |
|---|---|---|---|---|
| HTTP body | `API_MAX_BODY_BYTES` | 16 MiB | `apps/api/src/config.ts` (shipped) | 413 naming the limit |
| Proxy body | nginx `client_max_body_size` | matches the above | `infra/nginx` (shipped) | 413 from nginx — the defect Stage 1 shipped and fixed |
| Multipart field | busboy `fieldSize` | matches the above | `apps/api/src/routes/documents.ts` (shipped) | refusal naming the field |
| Gateway response headers | `GATEWAY_HEADERS_TIMEOUT_MS` | 300 000 ms | `apps/api/src/gatewayClient.ts` (shipped) | the cell errors, naming a gateway timeout |
| **Per-cell model call** | `API_RUN_CELL_TIMEOUT_MS` | 300 000 ms | `apps/api/src/config.ts` (**new**) | the cell errors with its own message; `attempts` increments |
| **Cell lease** | `API_RUN_LEASE_MS` | 120 000 ms | `apps/api/src/config.ts` (**new**) | an expired lease makes the cell re-leasable |
| **Lease renewal / heartbeat** | `API_RUN_HEARTBEAT_MS` | 30 000 ms | `apps/api/src/config.ts` (**new**) | the worker renews its lease and `run.heartbeat_at` |
| **Reaper threshold** | 3 × `API_RUN_HEARTBEAT_MS` | derived, not configured | `apps/api/src/run/reaper.ts` (**new**) | the run is marked `failed` and says so |
| **Attempts per cell** | `API_RUN_ATTEMPTS_MAX` | 3 (§9) | `apps/api/src/config.ts` (**new**) | the cell becomes `error` carrying its last error text |
| **Worker slots per replica** | `API_RUN_WORKERS` | 4 | `apps/api/src/config.ts` (**new**) | cells wait in `queued` |
| **Per-run concurrency** | `workspace_setting.concurrency`, snapshotted to `run.concurrency` | operator's | Postgres (shipped column, enforced here) | cells of that run wait |
| **Per-workspace ceiling** | `API_WORKSPACE_RUN_CONCURRENCY` | 8 | `apps/api/src/config.ts` (**new**) | cells of a second run wait behind the first |
| **Postgres pool** | `API_DATABASE_POOL_MAX` | **must exceed `API_RUN_WORKERS` + expected request concurrency** | `apps/api/src/config.ts` (shipped; the *check* is new) | **startup refusal** naming both numbers — see Task 10 |
| **Worker statement timeout** | `statement_timeout` on `lexprompt_worker` | 60 000 ms | `apps/api/migrations/005_findings.sql` (**new**) | the cell's transaction aborts and the lease expires |
| **Page render** | `API_PAGE_RENDER_TIMEOUT_MS` | 30 000 ms per page | `apps/api/src/config.ts` (**new**, Task 1/9) | the document is `parse_state = 'failed'` naming the page |
| **Pages rendered per document** | `API_PAGE_IMAGE_MAX_PAGES` | 50 | `apps/api/src/config.ts` (**new**) | the finding is `truncated` and says which pages were not sent |
| **Page-image LRU** | `API_PAGE_IMAGE_LRU_BYTES` | 256 MiB | `apps/api/src/config.ts` (**new**) | oldest document's images are dropped and re-rendered on demand |
| **Event outbox retention** | `API_EVENT_RETENTION_DAYS` | 7 (§6.5) | `apps/api/src/config.ts` (**new**) | a cursor older than the window gets `resync_required` (Stage 4 renders it; Stage 3 refetches) |
| **Event cursor page** | `API_EVENT_PAGE_MAX` | 500 | `apps/api/src/config.ts` (**new**) | the response says there are more and carries the next cursor |

**Every new key above is `sameEverywhere` and must be added to `divergence.json` accordingly, or `configSurface.test.ts` fails** — in both directions, which is the half that catches a row with no key behind it. Task 25 does that sweep; a task that adds a key adds its row in the same commit.
---

## File Structure

```
packages/core/
  src/domain/types.ts                   NEW  the domain types the engine needs; src/types.ts RE-EXPORTS (Task 2)
  src/domain/verification.ts            NEW  moved from src/lib/verification.ts
  src/domain/reviewTarget.ts            NEW  moved — findingsKeyFor lives HERE and only here
  src/domain/netPosition.ts             NEW  moved
  src/domain/positionOutcome.ts         NEW  moved
  src/domain/riskBlock.ts               NEW  moved
  src/domain/pageSegments.ts            NEW  moved
  src/domain/modelContext.ts            NEW  moved (SCAN_TEXT_THRESHOLD's consumer)
  src/domain/citations.ts               NEW  moved
  src/domain/citationPage.ts            NEW  moved (derivePage)
  src/domain/citationRepair.ts          NEW  moved
  src/domain/collectionOrder.ts         NEW  moved
  src/domain/collectionPrompt.ts        NEW  moved
  src/domain/concurrency.ts             NEW  moved (mapWithConcurrency)
  src/domain/uid.ts                     NEW  moved
  src/review/extractClause.ts           NEW  moved, + a ModelClient parameter (Task 3)
  src/review/extractCollectionClause.ts NEW  moved, + a ModelClient parameter (Task 3)
  src/index.ts                       MODIFY  every new export named here or S14 cannot see it

apps/api/
  migrations/005_findings.sql           NEW  finding, note, lexprompt_worker + its grants (Task 4)
  migrations/006_dispositions.sql       NEW  finding_disposition, finding_disposition_event (Task 5)
  migrations/007_findings_backfill.sql  NEW  the census, the shred, the reconciliation (Task 6)
  migrations/008_runs.sql               NEW  run, run_cell, event (Task 8)
  migrations/009_freeze_findings.sql    NEW  REVOKE UPDATE (findings) ON review (Task 22)
  src/config.ts                      MODIFY  the new caps, in this file ONLY
  src/findings/rows.ts                  NEW  Finding <-> finding row; the ONE mapping (Task 4)
  src/findings/write.ts                 NEW  writeFindingRows / writeOneFinding, one transaction (Task 7)
  src/findings/read.ts                  NEW  findingsMapFor(reviewId) -> the wire shape (Task 14)
  src/findings/reconcile.ts             NEW  rows vs blob, key by key (Task 7)
  src/dispositions/service.ts           NEW  setDisposition / resetForRerun — the ONLY writers (Task 5, 15, 16)
  src/routes/findings.ts                NEW  GET findings, PUT disposition, POST note (Tasks 14, 15)
  src/routes/runs.ts                    NEW  POST runs, GET run, POST cancel, POST retry, GET events
  src/run/queue.ts                      NEW  create a run and its cells; the two concurrency tiers
  src/run/worker.ts                     NEW  lease, execute, one transaction per cell
  src/run/reaper.ts                     NEW  expired leases, stale heartbeats
  src/run/events.ts                     NEW  appendEvent — the one writer of `event`
  src/run/modelClient.ts                NEW  ModelClient over GatewayClient (P21)
  src/parse/parseDocument.ts            NEW  server-side parse; who writes parse_state changes (Task 9)
  src/parse/pageImages.ts               NEW  render + LRU, never persisted (Task 1/9) — or absent if Spike 1 says no
  src/parse/hydrate.ts                  NEW  documentFileForReview / ForViewing, server side (Task 9)
  src/main.ts                        MODIFY  start the worker pool and the reaper; the pool-size check
  src/server.ts                      MODIFY  register the route groups
  src/auth/routeTable.ts             MODIFY  one line per new route
  test/findings.pg.test.ts              NEW
  test/dispositions.pg.test.ts          NEW  every check constraint, both grant mutations
  test/findingsBackfill.pg.test.ts      NEW  the census, the refusals, the by-key reconciliation
  test/shadowWrite.pg.test.ts           NEW  rows == blob after every write (Task 7)
  test/runQueue.pg.test.ts              NEW
  test/runLifecycle.pg.test.ts          NEW  lease expiry, cancel, attempts, the reaper
  test/rerunReset.pg.test.ts            NEW  the two mutations §14 names
  test/workerGrants.pg.test.ts          NEW  the worker role attempting the write it must not have
  test/parseDocument.test.ts            NEW
  test/pageImages.compose.test.ts       NEW  a real scanned PDF through the real container
  test/runWorker.compose.test.ts        NEW  kill the worker mid-run; watch it resume
  test/caps.test.ts                     NEW  every declared cap has a reader
  test/configSurface.test.ts         MODIFY  the new keys, both directions
  test/divergence.json               MODIFY  the new keys as sameEverywhere
  test/authz.route.test.ts           MODIFY  one entry per new route
  test/stage3DoD.test.ts                NEW  Task 26

src/
  types.ts                           MODIFY  re-exports packages/core/src/domain/types.ts (Task 2)
  lib/verification.ts                 DELETE  (re-exported from core until Task 2's callers move)
  lib/reviewTarget.ts                 DELETE
  lib/netPosition.ts                  DELETE   … and the ten other moved modules
  lib/findingMerge.ts                 DELETE  Task 21 — with carryHumanState
  lib/db/reviews.ts                  MODIFY  the debounced whole-review saver goes (Task 18)
  lib/api/runs.ts                       NEW  the browser's run client: start, poll, cancel, retry
  lib/api/findings.ts                   NEW  read findings; write a disposition or a note
  features/review/runReview.ts       MODIFY  emptyRun stays; runReview/retryCell go (Tasks 18, 20)
  features/review/extractClause.ts    DELETE  moved to core (Task 3)
  features/review/extractCollectionClause.ts DELETE
  App.tsx                            MODIFY  Tasks 18, 19, 20, 21
```

---

# PART 3A — the rows exist, are proven equal, and nothing yet depends on them

---

## Task 1: Spike 1, executed — can the server render page images?

**Type:** spike, with kept code on a yes and a named branch on a no

**Files:**
- Create: `apps/api/src/parse/pageImages.ts` (on a yes)
- Create: `apps/api/test/pageImages.compose.test.ts`
- Modify: `apps/api/package.json` (`@napi-rs/canvas`, `pdfjs-dist`), `apps/api/Dockerfile` if a native build needs it
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/spike-1-report.md`

**Interfaces:**
- Consumes: `blobKeyFor` and the blob store from Stage 2 — **read `apps/api/src/blob/store.ts` and `apps/api/src/routes/documents.ts` for the actual export sites and signatures. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `renderPageImages(bytes: Uint8Array, opts: { maxPages: number; timeoutMs: number }): Promise<{ images: string[]; renderedPages: number; totalPages: number }>` — base64 PNG data, **in memory only**.

**Why this is Task 1.** §15: server-side PDF page rendering is unproven, and §19: *"the whole scanned-document path depends on it, and the scanned-document path is this project's founding defect."* Tasks 9 and 10 both branch on the answer. Getting the answer first costs a day; getting it after Task 10 costs Task 10.

- [ ] **Step 1: Write the test that will fail until it works, against a real scanned PDF**

Use a genuinely scanned fixture — one whose per-page text is below `SCAN_TEXT_THRESHOLD` on every page. If the repository has none, produce one and commit it under `apps/api/test/fixtures/`, and say in the report how it was made.

```ts
// apps/api/test/pageImages.compose.test.ts — runs inside the api container,
// where the native canvas binding actually has to work. A test that passes on
// a laptop's Node and fails in the image proves nothing about the deployment.
it('renders every page of a scanned PDF to a base64 image, in the container', async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const out = await renderPageImages(bytes, { maxPages: 50, timeoutMs: 30_000 });
  expect(out.totalPages).toBeGreaterThan(1);
  expect(out.images).toHaveLength(out.totalPages);
  // Not "it returned strings": a blank page and a rendered page are both
  // strings. Assert the decoded bytes are a PNG and are not trivially small.
  for (const image of out.images) {
    const buf = Buffer.from(image, 'base64');
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(buf.byteLength).toBeGreaterThan(5_000);
  }
});
```

- [ ] **Step 2: Run it and record a timing, not an impression**

`docker compose exec api node --version`, then run the suite in the container. Record: pages per second on the fixture, peak RSS during the render, the image sizes, and the cold-start cost of loading `pdfjs-dist` under Node. **A number, in the report.** §15 asks for *"a go/no-go with a worked example and a timing"* and an impression is not one.

- [ ] **Step 3: The branch, taken explicitly**

**On a yes:** `pageImages.ts` is kept, `API_PAGE_RENDER_TIMEOUT_MS`, `API_PAGE_IMAGE_MAX_PAGES` and `API_PAGE_IMAGE_LRU_BYTES` are added to `config.ts` (that file only), and Task 9 proceeds as written.

**On a no** — it cannot build in the image, it is too slow to be usable, or the output is unfaithful: **stop and report.** Do not improvise OCR. §15's fallback is Azure AI Document Intelligence at ingest, which *"removes the image path entirely but adds a subprocessor to §12"* — a Risk-story change the owner decides, not an implementation detail. The report says what failed, with the timing, and names the three things that change: §12 Q5's subprocessor answer, `modelContext.ts`'s image path, and Task 9's parse worker. **Part 3A continues without Task 9's image half** — every other task in this stage is unaffected, which is why this is Task 1 and not a blocker on the stage.

- [ ] **Step 4: Whatever the answer, the images are never persisted**

Add the assertion now, because it is cheap and it is a promise the README makes:

```ts
it('writes no image anywhere — not to Postgres, not to the blob store', () => {
  const code = codeOf(resolve('apps/api/src/parse/pageImages.ts'));
  expect(code).not.toMatch(/blobStore|upload|insert into/i);
  // The companion positive assertion, or the above passes on an empty file:
  expect(code).toMatch(/renderPageImages/);
});
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/parse/pageImages.ts apps/api/test/pageImages.compose.test.ts \
  apps/api/test/fixtures apps/api/package.json package-lock.json \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/spike-1-report.md
git commit -m "spike: can the server render page images, answered with a timing"
git show --stat HEAD
```

---

## Task 2: `packages/core` extraction I — the review closure's pure half

**Type:** refactor, no behaviour change

**Files:**
- Create: `packages/core/src/domain/{types,verification,reviewTarget,netPosition,positionOutcome,riskBlock,pageSegments,modelContext,citations,citationPage,citationRepair,collectionOrder,collectionPrompt,concurrency,uid}.ts` and their moved `.test.ts` siblings
- Modify: `packages/core/src/index.ts`, `src/types.ts`
- Delete: the corresponding `src/lib/*.ts` and `src/lib/*.test.ts`
- Modify: `apps/api/test/importBoundary.test.ts` (or wherever S14's guard lives — **find it before writing**)

**Interfaces:**
- Consumes: nothing new. **Read every module before moving it.** The list above was read from the imports of `src/features/review/extractClause.ts` and `extractCollectionClause.ts` on 2026-08-30; **re-derive it** with `npx tsc --noEmit --traceResolution` or by following imports by hand, and if the closure has grown, move what it has grown to and say so. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: every name in those modules, exported from `@lexprompt/core`. The ones later tasks name explicitly: `findingsKeyFor`, `isCollectionTarget`, `targetDocumentIds`, `unchecked`, `applyVerification`, `resetVerification`, `requiresReason`, `VerificationError`, `findingKey`, `makeNote`, `unconfirmedPosition`, `confirmPosition`, `amendPosition`, `resetPosition`, `NetPositionError`, `normalisePositionOutcome`, `repairCitations`, `derivePage`, `assessDocument`, `contextBudgetChars`, `SCAN_TEXT_THRESHOLD`'s consumer, `mapWithConcurrency`, `uid`, `buildCollectionPrompt`, `CollectionMember`.

**The acceptance criterion is §13 Stage 0's, verbatim: every test that moves must still pass unchanged.** If a moved test needs editing beyond its import path, that module was not as pure as it looked, and the edit is worth examining rather than making quietly. Report every such edit.

- [ ] **Step 1: Move the types, and re-export rather than rewrite every importer**

`src/types.ts` is 627 lines and is imported across `src/`. Move the domain types the closure needs into `packages/core/src/domain/types.ts` — at minimum `Finding`, `Citation`, `Verification`, `VerificationState`, `Note`, `NetPosition`, `TrailStep`, `RiskLevel`, `ReviewTarget`, `ReviewRun`, `DocumentFile`, `DocumentRecord`, `PlaybookClause`, `PlaybookVersion`, `StandardPosition` — and leave `src/types.ts` re-exporting them:

```ts
// src/types.ts — the browser's own view of the domain types. The definitions
// now live in packages/core so the server can run the same extractors over
// the same shapes (P20); this file re-exports them so that not one importing
// file in src/ changed when they moved. Types that only the browser has
// (router state, view models) stay declared here.
export type {
  Finding, Citation, Verification, VerificationState, Note, NetPosition, TrailStep,
  RiskLevel, ReviewTarget, ReviewRun, DocumentFile, DocumentRecord,
  PlaybookClause, PlaybookVersion, StandardPosition,
} from '@lexprompt/core';
```

**`PlaybookClause` and `StandardPosition` are already declared in `packages/core/src/playbook/applyChangeset.ts`.** Do not declare them a second time in `domain/types.ts`; re-export the existing ones, or move them into `domain/types.ts` and have `applyChangeset.ts` import them. Two declarations of one type that structurally match is exactly the drift S14 exists to prevent, and TypeScript will not complain.

- [ ] **Step 2: Move the modules, one commit's worth at a time, imports last**

Move file and test together. Inside `packages/core`, imports are relative with the `.ts` extension (match what `packages/core/src/index.ts` already does). Outside, everything comes from `@lexprompt/core`.

Order matters only in that `types.ts` goes first and `collectionPrompt.ts` last (it depends on `collectionOrder` and `pageSegments`).

- [ ] **Step 3: Export every moved name from `index.ts`, and register it with the S14 guard**

Stage 2's interface note 14: *"every new export goes into `importBoundary.test.ts`'s `exported` array or the S14 guard cannot see it."* Find that array, add every name, and **prove the guard bites**:

```ts
it('refuses an app-local re-implementation of a core export', () => {
  // The mutation this test exists for: paste `export function findingsKeyFor`
  // into src/lib/ and confirm THIS test fails. Restore. A boundary guard that
  // has never been shown to fail is a comment.
  expect(reimplementedInApps()).toEqual([]);
  // Sanity check: the scanner must actually be reading files.
  expect(scannedFileCount()).toBeGreaterThan(50);
});
```

- [ ] **Step 4: `findingsKeyFor` gets the sentence it will need in Stage 4**

It is now callable from three places (browser, API, worker). Its docstring keeps R-C1's reasoning and gains one line: *"Six defects in sub-project C came from code that keyed by document id directly. This function is now the client/server boundary's copy of that rule as well; if you are reading a findings key anywhere, come through here."*

- [ ] **Step 5: Gates**

`npm run typecheck` (four projects), `npm test` (exit code, not the summary line), `npm run build`. **`git status --porcelain -- '*.test.ts' '*.test.tsx'` should show moves and import-path edits and nothing else.** Any assertion that changed is a finding.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src src/types.ts src/lib apps/api/test/importBoundary.test.ts
git commit -m "refactor: the review closure moves to packages/core, unchanged"
git show --stat HEAD
```

---

## Task 3: `packages/core` extraction II — the two extractors, with the model client injected

**Type:** refactor, one signature change

**Files:**
- Create: `packages/core/src/review/extractClause.ts`, `packages/core/src/review/extractCollectionClause.ts` and their moved tests
- Delete: `src/features/review/extractClause.ts`, `src/features/review/extractCollectionClause.ts` and their tests (moved, not rewritten)
- Modify: `packages/core/src/index.ts`, `src/features/review/runReview.ts`, `src/App.tsx` (call sites only)
- Create: `apps/api/src/run/modelClient.ts`

**Interfaces:**
- Consumes: Task 2's `@lexprompt/core` exports; `ModelClient` from `packages/core/src/model/client.ts` — **read it; it is the shipped interface and this task must fit it rather than replace it.** `gatewayModelClient` (`src/lib/model/gatewayModelClient.ts`) is the browser's implementation and stays where it is. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  extractClause(client: ModelClient, doc: DocumentFile, clause: PlaybookClause,
                template: PlaybookVersion, settings: WorkspaceSettings,
                signal?: AbortSignal, context?: ExtractClauseContext): Promise<Finding>
  extractCollectionClause(client: ModelClient, members: CollectionMember<DocumentFile>[],
                clause: PlaybookClause, template: PlaybookVersion, settings: WorkspaceSettings,
                signal?: AbortSignal, context?: ExtractCollectionContext): Promise<Finding>
  ```

**The parameter goes FIRST, and that is not a style choice.** `src/App.verification.test.tsx`'s `extractClauseMock` destructures the **fifth positional argument** as the abort signal, and `extractClause.ts`'s own comment says so at the point where `context` was appended last for exactly this reason. Adding the client anywhere but position 0 either moves `signal` or moves `context`, and both silently hand a mock the wrong object — not a type error, just a mock that stops seeing the abort.

- [ ] **Step 1: Pin the argument positions before changing anything**

```ts
// packages/core/src/review/extractClause.test.ts — first test in the file.
it('takes the client first and leaves signal at position 5', async () => {
  const seen: unknown[] = [];
  const client = { chatJson: async (...args: unknown[]) => { seen.push(args); return { summary: 's', citations: [] }; } } as unknown as ModelClient;
  const controller = new AbortController();
  await extractClause(client, doc, clause, template, settings, controller.signal, { reviewId: 'r1' });
  // `chatJson`'s own second argument is the signal it was handed.
  expect((seen[0] as unknown[])[1]).toBe(controller.signal);
});
```

Run it against the un-moved implementation first (adapted to today's signature) so you know the assertion is about the right thing.

- [ ] **Step 2: Move both files, replacing the import with the parameter**

The only edits inside the two files are: delete `import { gatewayModelClient } …`, add `client` as the first parameter, and change `gatewayModelClient.chatJson(` to `client.chatJson(`. **Nothing else changes.** In particular:

- `repairCitations(raw.citations, doc.id, doc.text)` keeps `doc.text` — not `readability.text`. `usableText` strips `[Page N]`, and passing the filtered text would make "page where derivable" mean "page: never" for every citation this app produces.
- The empty-`summary` guard stays, with `noContent: true` and an `error` status. A schema-valid empty answer is not a finding.
- The `...(truncated ? { truncated: true } : {})` spreads stay spreads. `truncated: undefined` persists a key that reads to an `in` check as "truncation was recorded here".
- `normalisePositionOutcome` stays the only producer of `positionOutcome`, and it stays returning `{}` — an absent key — where there is no standard position.
- Every `unchecked()` stays. The extractors write no other verification state, ever, and that is the property the whole stage rests on.

- [ ] **Step 3: `isAuthFailure` is a browser concern; check where it belongs**

`extractClause` imports `isAuthFailure` from `src/lib/model/authFailure.ts`, which classifies an error the browser then routes on. Read it. If it is pure (a status/code test), move it to core with the rest. If it reaches for browser state, **leave it in the browser and have the extractor set `authError` from the `ModelError` code instead** — `packages/core/src/model/protocol.ts` already exports `isSignInError`, which is the same question asked in the shared vocabulary. Report which it was.

- [ ] **Step 4: The API's `ModelClient`**

```ts
// apps/api/src/run/modelClient.ts
import { ModelError, type ModelClient, type InferRequest } from '@lexprompt/core';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Actor } from '../auth/actor.ts';
import { withActor } from '../actorBody.ts';

/**
 * The engine's route to a model: the SAME gateway client the inference proxy
 * uses, with the SAME actor body. `apps/api` may not egress (§5) and this
 * does not change that — every call still leaves through the gateway.
 *
 * `actor` is the person who ASKED FOR THE RUN, never a service identity.
 * The gateway's call log is what answers "where has privileged text been
 * processed, and on whose behalf" (§10, §12 Q5); a worker that logged itself
 * as the actor would make every server-side review anonymous in the one
 * record that exists to say otherwise.
 */
export function workerModelClient(
  gateway: GatewayClient, workspaceId: string, actor: Actor,
): ModelClient {
  return {
    async chatJson<T>(request: InferRequest, signal?: AbortSignal): Promise<T> {
      const { status, json } = await gateway.infer(withActor({ ...request }, workspaceId, actor));
      if (status >= 400) throw modelErrorFrom(status, json);
      return contentOf(json) as T;
    },
    // chat/chatStream: implement only what the extractors call. An unused
    // method that throws is better than one that half-works — read
    // packages/core/src/model/client.ts and answer its ACTUAL shape.
  };
}
```

**This block is a sketch and the implementer must reconcile it with two shipped files**: `packages/core/src/model/client.ts` (what `ModelClient` actually requires) and `src/lib/model/gatewayModelClient.ts` (how the browser already parses a gateway response, including `parseJsonLoose` for models that wrap JSON in prose). **The parsing must not be written twice** — if the browser's response handling is not already a pure function, extract it to core in this task and have both call it. That is S14's rule at the exact place the client/server split invites its violation.

- [ ] **Step 5: Update the browser's call sites and prove nothing moved**

`runReview.ts` and `App.tsx` pass `gatewayModelClient` as the new first argument. Every moved test passes with its import path and one argument changed and **no assertion edited**. If an assertion moved, say so.

- [ ] **Step 6: Gates and commit**

```bash
git add packages/core/src/review packages/core/src/index.ts apps/api/src/run/modelClient.ts \
  src/features/review src/App.tsx src/lib/model
git commit -m "refactor: the extractors take a model client instead of importing one"
git show --stat HEAD
```

---

## Task 4: Migration 005 — `finding` and `note` rows, and the `lexprompt_worker` role

**Type:** schema

**Files:**
- Create: `apps/api/migrations/005_findings.sql`
- Create: `apps/api/src/findings/rows.ts`
- Create: `apps/api/test/findings.pg.test.ts`, `apps/api/test/workerGrants.pg.test.ts`
- Modify: `apps/api/src/config.ts` (the worker's connection string)

**Interfaces:**
- Consumes: `002_records.sql`'s `review` table; `000_preconditions.sql`'s role pattern — **read both.** `absentUnless` from `apps/api/src/db/rows.ts` is the NULL↔absent helper and this task uses it rather than a second one. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: the `finding` and `note` tables; `toFindingRow(f, reviewId, findingsKey, workspaceId)` / `fromFindingRow(row)`; the `lexprompt_worker` role.

- [ ] **Step 1: The migration**

```sql
-- 005_findings.sql
-- §6.2: findings become rows keyed (review_id, findings_key, clause_id).
-- `findings_key` is produced by packages/core's findingsKeyFor and by nothing
-- else: a document id for a document review, the COLLECTION id for a
-- collection review. Six defects in sub-project C came from code that keyed
-- by document id directly.
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
  -- there was one and the model could not tell. Different facts (§6.2).
  position_outcome     text check (position_outcome in ('meets','deviates','unclear')),
  position_rationale   text,
  citations            jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(citations) = 'array'),
  -- NULL on a standalone finding, never '{}'.
  net_position         jsonb check (jsonb_typeof(net_position) = 'object'),
  version              bigint not null default 1,
  updated_at           timestamptz not null default now()
);
create index finding_review_idx on finding (workspace_id, review_id);

-- §6.3: notes are their own table now. R-B3 said "a notes store becomes a
-- later migration"; this is that migration, forced by the Finding object it
-- used to live inside ceasing to exist.
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
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lexprompt_worker') then
    raise exception 'role lexprompt_worker does not exist; create it before migrating '
      '(see 000_preconditions.sql for the pattern the other two roles follow)';
  end if;
end $$;

alter role lexprompt_worker set statement_timeout = '60s';

grant select, insert, update on finding to lexprompt_worker;
grant select on review, document, playbook_version, workspace_setting to lexprompt_worker;
grant select, insert, update on finding to lexprompt_app;
grant select, insert, delete on note to lexprompt_app;
-- The worker may not write a note either: a note is a person's remark.
grant select on note to lexprompt_worker;
```

**Two things to verify against the shipped `000_preconditions.sql` before writing this**: whether roles are created by the migration or asserted to exist (the block above assumes asserted, matching Stage 2's precondition pattern), and what `002_records.sql` actually granted to `lexprompt_app`, so this file grants in the same style rather than a second one.

- [ ] **Step 2: The row mapping, in one place**

`toFindingRow` / `fromFindingRow` in `apps/api/src/findings/rows.ts`, alongside the other mappings in style but in its own file because it is the biggest and it is the one the migration, the shadow writer, the worker and the read route all share. Rules, each with a test:

```ts
it('keeps an absent truncatedDocuments absent, and never returns []', async () => {
  const back = fromFindingRow(await roundTrip({ ...single, truncated: true }));
  expect('truncatedDocuments' in back).toBe(false);   // NOT toEqual — see CLAUDE.md
});

it('keeps an absent positionOutcome absent, and distinguishes it from unclear', async () => {
  expect('positionOutcome' in fromFindingRow(await roundTrip(noPosition))).toBe(false);
  expect(fromFindingRow(await roundTrip(unclearPosition)).positionOutcome).toBe('unclear');
});

it('keeps an absent netPosition absent on a standalone finding', async () => {
  expect('netPosition' in fromFindingRow(await roundTrip(standalone))).toBe(false);
});
```

**`verification` and `notes` are NOT columns on `finding` and `fromFindingRow` does not produce them.** They come from `finding_disposition` and `note`, assembled by Task 14's read. A `fromFindingRow` that invented `verification: unchecked()` would be the engine deriving a human judgement, one layer down, and it would be invisible.

- [ ] **Step 3: The grant test, proved by attempting the write**

```ts
// apps/api/test/workerGrants.pg.test.ts
it('lets the worker role write a finding', async () => {
  await expect(workerDb().query('update finding set summary = $1 where …', ['x'])).resolves.toBeDefined();
});

it('refuses the worker role a note', async () => {
  await expect(workerDb().query('insert into note … values (…)'))
    .rejects.toThrow(/permission denied/i);
});
```

`workerDb()` is a third harness connection beside `appDb()` and `migratorDb()` — add it to `pgHarness.ts` reading `LEXPROMPT_TEST_WORKER_URL`, failing loudly with the command that fixes it, **never skipping**. Update `scripts/pg-forward.sh` to print the third URL.

- [ ] **Step 4: Gates and commit**

```bash
npm run test:pg   # exit code, not the summary line
git add apps/api/migrations/005_findings.sql apps/api/src/findings/rows.ts \
  apps/api/test/findings.pg.test.ts apps/api/test/workerGrants.pg.test.ts \
  apps/api/test/helpers/pgHarness.ts apps/api/src/config.ts scripts/pg-forward.sh
git commit -m "feat(db): findings and notes as rows, and a worker role that cannot write a note"
git show --stat HEAD
```

---

## Task 5: Migration 006 — `finding_disposition` and `finding_disposition_event`

**Type:** schema, and it is the most constraint-dense file in the project

**Files:**
- Create: `apps/api/migrations/006_dispositions.sql`
- Create: `apps/api/src/dispositions/service.ts`
- Create: `apps/api/test/dispositions.pg.test.ts`

**Interfaces:**
- Consumes: Task 4's `finding` and the three roles.
- Produces: both tables; `setDisposition(t, key, change, actor)` and `dispositionFor(t, key)` — **the only writers of either table in the codebase**, and Task 25's scanner asserts it.

- [ ] **Step 1: The migration, with every constraint §6.3 names**

```sql
-- 006_dispositions.sql
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

-- S11's grant, on the table that is now a THIRD log (§12 Q3). Insert and
-- select; no update, no delete, to any application role. This is what makes
-- the history evidence rather than a claim.
grant select, insert on finding_disposition_event to lexprompt_app;
grant select, insert, update on finding_disposition to lexprompt_app;
grant usage, select on sequence finding_disposition_event_id_seq to lexprompt_app;

-- §9.1 and §14: the run worker's role can neither insert, update nor delete
-- either of them. Stated as an explicit REVOKE as well as an absent GRANT,
-- because a future `grant all on all tables in schema public` is exactly the
-- kind of convenience that would silently undo it.
revoke all on finding_disposition, finding_disposition_event from lexprompt_worker;
```

- [ ] **Step 2: The tests that are the point of the file**

Each of these is a `.pg.test.ts` against the real database. Every one carries the mutation that proves it bites — **remove the named constraint, confirm the named test fails, restore.**

```ts
it('refuses a rerun_reset that does not move to unchecked', async () => {
  await expect(insertEvent({ cause: 'rerun_reset', to_state: 'verified' }))
    .rejects.toThrow(/rerun_reset_only_unchecks/);
});
// Mutation: drop constraint rerun_reset_only_unchecks. This test must fail.

it('refuses a rejection with no reason, in both tables', async () => { … });
it('refuses an actor on a never-touched disposition, and a touched one with none', async () => { … });

it('cannot update or delete a history row, as any app role', async () => {
  await expect(appDb().query('update finding_disposition_event set to_state = $1', ['verified']))
    .rejects.toThrow(/permission denied/i);
  await expect(appDb().query('delete from finding_disposition_event')).rejects.toThrow(/permission denied/i);
});
// Mutation: `grant update on finding_disposition_event to lexprompt_app`.
// This test must fail. Then REVOKE and confirm it passes again — a grant
// test that has only ever been run in the passing direction proves nothing,
// which is exactly how one of Stage 2's tests came to prove nothing.

it('refuses the worker role either table, in all four verbs', async () => {
  for (const sql of [SELECT_D, INSERT_D, UPDATE_D, INSERT_E]) {
    await expect(workerDb().query(sql)).rejects.toThrow(/permission denied/i);
  }
});
```

**Note the `select` in that last loop.** §6.3 says the worker *"can neither insert, update nor delete them"*; this plan revokes `select` too, because the worker has no reason to read a disposition and a `select` grant is how a future "just check whether it was verified before overwriting" gets written. If a later task finds a legitimate need for the worker to read one, that is a change to this ruling with its own reasoning, not a quiet `grant`.

- [ ] **Step 3: `setDisposition` — the one writer, one transaction, always**

```ts
// apps/api/src/dispositions/service.ts
/**
 * The ONLY place either disposition table is written. Both rows, one
 * transaction, never one without the other (§6.3) — so a current state whose
 * history does not explain it cannot exist.
 *
 * `expectedVersion` is the version the caller was looking at. If the row has
 * moved on, this REFUSES with the current row (ConflictError) and applies
 * nothing. Stage 4 puts "Priya changed this to Rejected at 14:22" on that
 * refusal; the refusal itself is here, because the alternative is a silent
 * overwrite of a judgement the changer never saw.
 */
export async function setDisposition(
  t: Tx,
  key: FindingKey,
  change: { state: VerificationState; reason?: string },
  cause: 'human' | 'rerun_reset',
  actor: { id: string },
  expectedVersion: number,
): Promise<DispositionRow> { … }
```

The `UPDATE … where version = $n returning *` is what refuses; the `INSERT INTO finding_disposition_event` reads `from_state` from the row it just replaced. **The mutation §14 names explicitly**: delete the event insert and leave the update — *"a disposition that clears without recording that it cleared"* — and confirm a named test fails.

- [ ] **Step 4: The reconciliation test §6.3 asks for**

```ts
it('recomputes finding_disposition from its history and finds it equal', async () => {
  // The cache-versus-source check. §19: "This project has been bitten by a
  // derived value that could disagree with its source more than once; the
  // difference here is that the disagreement would be between what a card
  // says a person judged and what actually happened."
  await makeSomeChanges();
  const stored = await allDispositions();
  const recomputed = await foldHistory();   // last event per finding, in id order
  expect(recomputed).toEqual(stored);
});
```

Make several changes across several findings, including one that returns to `unchecked`, before comparing. A reconciliation over one change proves the trivial case.

- [ ] **Step 5: Gates and commit**

```bash
npm run test:pg
git add apps/api/migrations/006_dispositions.sql apps/api/src/dispositions/service.ts \
  apps/api/test/dispositions.pg.test.ts
git commit -m "feat(db): one disposition and a complete history, enforced by the database"
git show --stat HEAD
```
---

## Task 6: Migration 007 — the census, the shred, and the report

**Type:** data migration. **This is the largest single data migration in the plan (§13) and the most dangerous change in this stage.**

**Files:**
- Create: `apps/api/migrations/007_findings_backfill.sql`
- Create: `apps/api/src/findings/backfill.ts` (the report and the refusals, in TypeScript where they can say something useful)
- Create: `apps/api/test/findingsBackfill.pg.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5's tables; `findingsKeyFor` from `@lexprompt/core`; `review.findings` and `review.target` as they are stored today — **read `apps/api/src/db/rows.ts`'s `toReviewRow`/`fromReviewRow` and `002_records.sql`'s comment about the exact stored shape. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `finding`, `note`, `finding_disposition` and `finding_disposition_event` rows for every review already in the database; `finding_migration_census` and `finding_migration_report` tables that outlive the migration.

**What this must never do**, stated before the how, because every design choice below serves one of them:

1. **Never report success over a gap.** *"A failed storage migration rendering an empty library, indistinguishable from a fresh install"* is on `CLAUDE.md`'s list, and this is the same migration one level up with a lawyer's judgement inside it.
2. **Never invent a human judgement, and never destroy one.** It carries across exactly what the blob literally held. It does not upgrade, downgrade, guess an actor, or default a reason.
3. **Never leave a non-`unchecked` disposition with an empty history.** §6.4: *"an empty history under a non-`unchecked` current state would be indistinguishable from a change that failed to record itself"*.
4. **Never delete its source.** `review.findings` is untouched by this migration and frozen (not dropped) in Task 22.

- [ ] **Step 1: Write the census first, and make it a table**

```sql
-- Every human judgement in the database, BEFORE anything moves. A table
-- rather than a log line, because the comparison in Step 4 is a SQL join and
-- because an operator asking "what did the migration claim to find?" six
-- months later should not be reading a container log.
create table finding_migration_census (
  review_id     text not null,
  findings_key  text not null,
  clause_id     text not null,
  workspace_id  uuid not null,
  kind          text not null check (kind in ('verification','net_position','note','assignee')),
  detail        jsonb not null,
  primary key (review_id, findings_key, clause_id, kind)
);

insert into finding_migration_census (review_id, findings_key, clause_id, workspace_id, kind, detail)
select r.id, k.key, c.key, r.workspace_id, 'verification',
       jsonb_build_object('state', c.value->'verification'->>'state',
                          'byUserId', c.value->'verification'->>'byUserId',
                          'at', c.value->'verification'->>'at',
                          'reason', c.value->'verification'->>'reason')
from review r,
     lateral jsonb_each(r.findings) as k(key, value),
     lateral jsonb_each(k.value)    as c(key, value)
where coalesce(c.value->'verification'->>'state', 'unchecked') <> 'unchecked';
-- …and three more inserts, the same shape, for net_position (state <>
-- 'unconfirmed'), note (jsonb_array_length(notes) > 0) and assignee
-- (verification->>'assigneeId' is not null). Write all four; do not write
-- one and describe the others.
```

- [ ] **Step 2: The shred**

One `insert … select` per table, from `jsonb_each(review.findings)` → `jsonb_each(that)`. The outer key is the `findings_key` **exactly as stored** — do not re-derive it from `review.target`, and do not "correct" it. If a stored key disagrees with `findingsKeyFor(target, …)`, that is a fact about the data, and Step 3 refuses on it rather than silently rewriting a key.

Points that will bite:

- **`net_position` is `NULL`, not `'{}'`**, where the blob has no `netPosition`: `nullif(c.value->'netPosition', 'null'::jsonb)` and a `case` for the absent key. Test both spellings — an absent key and a JSON `null` — because both exist in real data.
- **`truncated_documents` is `NULL`, not `'{}'`**, on a single-document finding: `case when c.value ? 'truncatedDocuments' then … else null end`.
- **`position_outcome` is `NULL` where the key is absent**, and `'unclear'` only where the blob literally says so.
- **`status` maps 1:1.** A `pending` or `running` finding in a stored review is a run that was abandoned mid-flight; it migrates as `pending`/`running` and Task 11's reaper is what resolves it. Do not "tidy" it to `error`.
- **`note.id` is the note's own id and `note.findingId` is `findingKey(documentId, clauseId)`** — a `::`-joined string, from `src/lib/verification.ts` (now `@lexprompt/core`). It does **not** match `(review_id, findings_key, clause_id)`, so the migration re-keys it from the position the note occupies in the blob rather than by parsing that string. Parse it anyway as a **check**: if the parsed pair disagrees with where the note is stored, refuse and name it.

- [ ] **Step 3: The refusals, each naming rows**

In `backfill.ts`, run inside the same transaction as the SQL, before the commit. Every one of these **aborts the whole migration**, names every offending row, and says what to do:

```ts
const refusals: string[] = [];

// A human judgement whose author cannot be resolved. NOT attributed to the
// operator, NOT downgraded to unchecked, NOT skipped. §6.4 seeds the first
// history event from Verification.byUserId/at, and an event needs a real
// app_user (by_user_id is NOT NULL there).
refusals.push(...await namedRows(t, `
  select c.review_id, c.findings_key, c.clause_id, c.detail->>'byUserId' as by_user_id
  from finding_migration_census c
  left join app_user u on u.id::text = c.detail->>'byUserId'
  where c.kind in ('verification','net_position','note')
    and (c.detail->>'byUserId' is null or btrim(c.detail->>'byUserId') = '' or u.id is null)
`, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: byUserId ${JSON.stringify(r.by_user_id)} resolves to no app_user`));

// A rejection with no reason. The check constraint would refuse it anyway;
// refusing here means the operator gets a list rather than one Postgres
// error naming the first row it happened to reach.
refusals.push(...);

// A findings_key that no target explains — see Step 2.
refusals.push(...);

if (refusals.length > 0) {
  throw new Error(
    `The findings migration has NOT been applied. ${refusals.length} human-authored records `
    + 'could not be moved without guessing who made them, and this migration does not guess.\n\n'
    + refusals.join('\n')
    + '\n\nNothing has been changed. review.findings is untouched. Fix the rows above '
    + '(or map the missing users) and run the migration again.',
  );
}
```

**The sentence "Nothing has been changed" must be true.** The whole migration runs inside `runMigrations`' single transaction, so a throw rolls it back — verify that by reading `apps/api/src/db/migrate.ts`, and if it is not true, make it true before writing this.

- [ ] **Step 4: The reconciliation, by key, and it is not a count**

```sql
-- Every censused judgement must appear in the rows, at the same key, with
-- the same state, the same actor and the same instant. A count-only check
-- passes when two verifications swap places, which is precisely the
-- arithmetic that would land a rejection on the wrong clause.
create table finding_migration_report (
  at            timestamptz not null default now(),
  censused      int not null,
  landed        int not null,
  discrepancies jsonb not null
);

with expected as (select * from finding_migration_census where kind = 'verification'),
     actual as (
       select d.review_id, d.findings_key, d.clause_id, d.state, d.by_user_id::text as by_user_id,
              extract(epoch from d.at) * 1000 as at_ms
       from finding_disposition d where d.state <> 'unchecked')
select … -- full outer join on the three key columns; every row where either
         -- side is null, or where state/by_user_id/at differ, is a discrepancy
```

If `discrepancies` is non-empty, **throw with the list**, same shape as Step 3. If it is empty, insert the report row and let the migration commit.

- [ ] **Step 5: Seed the first history event — §6.4's requirement, restated as code**

Every migrated non-`unchecked` disposition gets exactly one `finding_disposition_event`: `from_state = 'unchecked'`, `to_state` = the migrated state, `cause = 'human'`, `by_user_id` = the verification's own author, `at` = the verification's own instant, `reason` carried where present. And the disposition row gets `changed_count = 1`, which is what its own `disposition_actor_iff_touched` constraint requires alongside a non-NULL actor.

**A migrated `unchecked` finding gets a disposition row with `changed_count = 0`, `by_user_id` NULL, `at` NULL, and NO event.** That is the honest reading: nobody has touched it, there is nothing to attribute, and §6.3 says such a finding *"renders as 'Not checked' and names nobody"*.

- [ ] **Step 6: The tests, over data shaped like real data**

```ts
it('lands every verification at the same key, with the same actor and instant', async () => { … });

it('seeds exactly one history event per migrated verification, and none for an unchecked one', async () => {
  expect(await eventCountFor(verifiedKey)).toBe(1);
  expect(await eventCountFor(uncheckedKey)).toBe(0);
  expect(await dispositionFor(uncheckedKey)).toMatchObject({ changed_count: 0, by_user_id: null });
});

it('REFUSES the whole migration when one verification names an unknown user, and changes nothing', async () => {
  await seedReviewWithOrphanVerification();
  await expect(runMigrations(migratorDb(), MIGRATIONS)).rejects.toThrow(/resolves to no app_user/);
  expect(await rowCount('finding')).toBe(0);          // nothing landed
  expect(await blobStillIntact()).toBe(true);          // and the source is untouched
});
// Mutation: replace the refusal with `coalesce(byUserId, :operator)`. The
// test above must fail. This is the single most important mutation in the
// stage: it is the difference between a lawyer's judgement and the deploy
// operator's name on it.

it('names a discarded assigneeId rather than dropping it silently (P24, S17)', async () => {
  expect(await reportLine()).toMatch(/assigneeId/);
});

it('never reports success over a gap', async () => {
  // Mutation: make the Step 4 reconciliation compare COUNTS instead of keys,
  // then seed two verifications whose keys are swapped. This test must fail.
  await seedSwappedKeys();
  await expect(runMigrations(migratorDb(), MIGRATIONS)).rejects.toThrow(/discrepanc/i);
});
```

- [ ] **Step 7: Run it against a copy of real data**

`npm run test:pg` is not the whole check. Take the compose stack's database (which by now holds whatever Stage 2's uploader moved), `pg_dump` it, restore into a scratch database, run the migration against that, and **read the report row**. Record in the task report: how many findings, how many verifications, how many net positions, how many notes, how many discrepancies (must be 0), and how long it took. **If the owner's real data is not in the compose database, say so** — a migration proven only against fixtures is proven against fixtures.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/007_findings_backfill.sql apps/api/src/findings/backfill.ts \
  apps/api/test/findingsBackfill.pg.test.ts
git commit -m "feat(db): findings become rows, and the migration refuses rather than guess"
git show --stat HEAD
```

---

## Task 7: The shadow writer, and the reconciliation that proves it

**Type:** feature. This is P17's first move.

**Files:**
- Create: `apps/api/src/findings/write.ts`, `apps/api/src/findings/reconcile.ts`
- Modify: `apps/api/src/routes/reviews.ts`
- Create: `apps/api/test/shadowWrite.pg.test.ts`

**Interfaces:**
- Consumes: Task 4's `toFindingRow`; Task 5's `setDisposition`; `apps/api/src/routes/reviews.ts`'s `PUT /v1/reviews/:id` transaction — **read it in full before touching it; it carries three long-form comments about refusals that must survive this change verbatim.** **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `writeFindingRows(t, review, actor)`, `reconcileFindings(t, reviewId): Promise<Discrepancy[]>`.

**What this task is for.** After Task 6, rows exist for every review that existed. The browser keeps writing whole reviews for the whole of Part 3A, so without this the rows go stale the moment anyone verifies anything. The shadow writer keeps them in step — **inside the same transaction as the blob write**, so the two cannot diverge even under a crash — and `reconcileFindings` is what proves it, on real data, on every write, in the `.pg.test.ts` suite.

- [ ] **Step 1: Write the reconciliation before the writer**

```ts
/**
 * Every difference between `review.findings` and the `finding` /
 * `finding_disposition` / `note` rows for one review, as a list a human can
 * read. Empty means they agree.
 *
 * Compared BY KEY and field by field, never by count: a count-only check
 * passes when two findings swap places. The fields compared are every one
 * `toFindingRow` writes, plus the disposition's state/actor/instant and the
 * notes' ids — i.e. exactly what a reader would lose if the flip in Task 14
 * were wrong.
 */
export async function reconcileFindings(t: Tx, reviewId: string): Promise<Discrepancy[]>
```

Its own test seeds a review, corrupts one row directly in SQL, and asserts the discrepancy is found and names the key. **A reconciliation that has never been shown to find something is a reconciliation that returns `[]`** — this project has shipped a scanner that matched nothing.

- [ ] **Step 2: The writer, in the existing transaction**

Inside `PUT /v1/reviews/:id`'s `db.tx`, after the review upsert succeeds and before the return:

```ts
// P17, and it is temporary by design (deleted in Task 22). The browser still
// owns the findings blob for the whole of Part 3A; these rows are its shadow,
// written in the SAME transaction so a crash cannot leave them disagreeing.
// The blob stays authoritative until Task 14 flips the reader.
await writeFindingRows(t, { ...input, id: row.id }, req.actor!);
```

`writeFindingRows` deletes nothing it cannot see: it upserts every `(findings_key, clause_id)` the body carries, and **deletes rows for keys the body no longer has** — a clause removed from a re-saved review must not leave an orphan finding whose disposition still counts. Test both directions.

- [ ] **Step 3: The disposition half, and the only place a whole-record write may set one**

The blob carries `verification` inside each finding. The shadow writer translates it through `setDisposition` — **only when the state or reason differs from the stored disposition**, with `cause = 'human'`, `by_user_id = req.actor.id`, and `at` taken from **the verification's own timestamp**, not `now()`. A whole-record write that appended an event every two seconds during a run would fill the history with a hundred identical rows and make the one real change unfindable.

**Write the reason down in the code**, because this is the one place in the design where a disposition is written from something other than a deliberate disposition request, and the next reader will be right to be suspicious:

```ts
// The browser still writes a verification inside the findings blob (it does
// until Task 19), and dropping it here would lose a human's judgement between
// Part 3A and Part 3B. So it is translated — but ONLY on a real change, and
// with the human's own instant, so the history says when they decided rather
// than when their browser next autosaved. This path is deleted in Task 22,
// with the blob write it exists to shadow.
```

- [ ] **Step 4: The test that is this task's whole reason for existing**

```ts
it('leaves the rows equal to the blob after every kind of write', async () => {
  for (const write of [initialSave, midRunSave, verifySave, noteSave, rerunSave, clauseRemovedSave]) {
    await put('/v1/reviews/r1', write);
    expect(await reconcileFindings(t, 'r1')).toEqual([]);
  }
});
// Mutation: drop the `net_position` column from writeFindingRows' upsert.
// This test must fail, naming netPosition. Restore.

it('appends no history row when a whole-review save repeats an unchanged verification', async () => {
  await put('/v1/reviews/r1', verified);
  const before = await eventCount(key);
  await put('/v1/reviews/r1', { ...verified, version: 2 });   // an autosave
  expect(await eventCount(key)).toBe(before);
});
```

- [ ] **Step 5: Run it against the live stack**

Start the stack, sign in with a real Keycloak token (`scripts/print-local-accounts.sh` prints the accounts; Stage 2's ledger records that `directAccessGrantsEnabled` is **false**, so obtain the token the way Stage 2's compose tests do — read one and copy it, do not weaken the realm). `PUT` a review with findings over `curl`, then read the rows back with `docker compose exec postgres psql`. **Confirm by looking, not by inference**, that a verification in the body produced a disposition row and exactly one event.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/findings/write.ts apps/api/src/findings/reconcile.ts \
  apps/api/src/routes/reviews.ts apps/api/test/shadowWrite.pg.test.ts
git commit -m "feat: findings rows shadow the blob in one transaction, and a reconciliation proves it"
git show --stat HEAD
```

---

## Task 8: Migration 008 — `run`, `run_cell`, `event`, and the queue's routes

**Type:** schema + feature

**Files:**
- Create: `apps/api/migrations/008_runs.sql`, `apps/api/src/run/queue.ts`, `apps/api/src/run/events.ts`, `apps/api/src/routes/runs.ts`
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`, `apps/api/src/config.ts`
- Create: `apps/api/test/runQueue.pg.test.ts`

**Interfaces:**
- Consumes: `findingsKeyFor` from `@lexprompt/core`; `workspace_setting` (Stage 2 Task 18) — **read `apps/api/src/routes/workspaceSettings.ts` for the actual column and shape.** **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `POST /v1/reviews/:id/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/cancel`, `GET /v1/runs/:id/events`; `createRun(t, review, actor)`; `appendEvent(t, e)`.

- [ ] **Step 1: The schema, following §6.5 field for field**

```sql
create table run (
  id                   text primary key,
  review_id            text not null references review(id) on delete cascade,
  workspace_id         uuid not null references workspace(id),
  state                text not null check (state in
                         ('queued','running','cancelling','cancelled','succeeded','failed')),
  requested_by_user_id uuid not null references app_user(id),
  -- A SNAPSHOT, for the reason playbook_snapshot is one (§6.5): a firm that
  -- changes its allowlist must not silently rewrite where a review it ran
  -- last March was processed. The gateway RETURNS these on every response and
  -- the run stores what it was told, never what the config now says.
  provider             text,
  model                text,
  jurisdiction         text,
  -- The per-run bound, snapshotted from workspace_setting.concurrency at
  -- creation for the same reason (P26).
  concurrency          int not null check (concurrency between 1 and 32),
  started_at           timestamptz,
  finished_at          timestamptz,
  heartbeat_at         timestamptz,
  cancel_requested_at  timestamptz,
  error                text
);
create index run_review_idx on run (workspace_id, review_id);
-- Findable by the reaper without a sequential scan over finished runs.
create index run_live_idx on run (state, heartbeat_at) where state in ('running','cancelling');

create table run_cell (
  run_id            text not null references run(id) on delete cascade,
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
-- The leasing index. Without it, `for update skip locked` still works and
-- scans every cell of every finished run to find one.
create index run_cell_claimable_idx on run_cell (state, lease_expires_at) where state in ('queued','leased');

create table event (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references workspace(id),
  matter_id    text,
  review_id    text,
  type         text not null,
  payload      jsonb not null,
  at           timestamptz not null default now()
);
create index event_review_idx on event (workspace_id, review_id, id);
grant select, insert on event to lexprompt_app, lexprompt_worker;
grant usage, select on sequence event_id_seq to lexprompt_app, lexprompt_worker;
grant select, insert, update on run, run_cell to lexprompt_app, lexprompt_worker;
```

**`run.provider` / `model` / `jurisdiction` are nullable and are filled by the first cell that gets an answer from the gateway**, because a queued run has not called anything yet. A `not null` here would force the API to guess them from configuration at creation — which is the exact re-derivation §6.5 forbids.

- [ ] **Step 2: The two state machines, and which one is authoritative — a finding to record**

§6.2 gives `finding.status` five values and §6.5 gives `run_cell.state` five different ones. They describe the same cell. **The ruling: `run_cell.state` is the queue's, `finding.status` is the reader's, and the worker writes both in one transaction.** They are not merged because they answer different questions — `attempts`, `leased_by` and `lease_expires_at` are meaningless to a card, and `summary`/`citations` are meaningless to a scheduler — and because a finding outlives every run that touched it while a cell does not. **A `run_cell` in `done` whose `finding` is still `running` is a bug and Task 11's test asserts it cannot happen.** Record this in the report: the spec names both and does not say which governs.

- [ ] **Step 3: `POST /v1/reviews/:id/runs` — create, return, do not execute**

§9: *"creates a `run` row and one `run_cell` per unit of work — document × clause for a standalone review, clause alone for a collection review — in state `queued`, and returns immediately. The response is the run, not the results."*

The cell list comes from `review.playbook_snapshot`'s clauses × the target, **through `findingsKeyFor`**:

```ts
const clauses = clausesOf(review.playbookSnapshot);
const cells = isCollectionTarget(target)
  ? clauses.map(c => ({ findingsKey: findingsKeyFor(target), clauseId: c.id }))
  : target.documentIds.flatMap(d => clauses.map(c => ({ findingsKey: findingsKeyFor(target, d), clauseId: c.id })));
```

In the same transaction: seed a `pending` `finding` row per cell (so the reader has something to render immediately and so the `run_cell`'s foreign key has a parent), snapshot `concurrency` from `workspace_setting`, and `appendEvent({ type: 'run.started', … })`.

**Two refusals, both `409`:**
- a run already `queued`/`running`/`cancelling` for this review — *"This review is already running."* Two concurrent runs over one review would have two writers per finding, which is the thing this stage exists to end.
- a review whose target names a document with `parse_state <> 'parsed'` — *"`X` has not finished being read."* §11's third load state, enforced rather than rendered around.

- [ ] **Step 4: The two concurrency tiers (P26)**

Both are read at lease time, not at creation, so a cancelled run releases its share immediately: a run may hold at most `run.concurrency` leased cells, and a workspace at most `API_WORKSPACE_RUN_CONCURRENCY` across all its runs. Expressed as predicates in the leasing query (Task 10), tested here as *"a forty-cell run and a three-cell retry: the retry gets a slot"* — which is §9's own sentence, as a test.

- [ ] **Step 5: `GET /v1/runs/:id/events?after=<id>&limit=` (P22)**

Returns `{ events: Event[], nextCursor: number, hasMore: boolean }`, ordered by `id`. `after` older than `API_EVENT_RETENTION_DAYS` returns `{ resyncRequired: true }` — the same signal §8 gives a reconnecting WebSocket, over HTTP, so Stage 4 inherits a protocol rather than inventing one. Every event carries the `version` of the row it describes (§8), and the client drops one that is not newer.

- [ ] **Step 6: Route policy and gates**

Four lines in `ROUTE_POLICY` (`reviewer` for all four — §7 says a reviewer runs reviews). `authz.route.test.ts` fails without them, which is the point.

```bash
npm run test:pg
git add apps/api/migrations/008_runs.sql apps/api/src/run apps/api/src/routes/runs.ts \
  apps/api/src/auth/routeTable.ts apps/api/src/server.ts apps/api/src/config.ts \
  apps/api/test/runQueue.pg.test.ts apps/api/test/authz.route.test.ts
git commit -m "feat: a run is a row and a queue of cells, created and returned without executing"
git show --stat HEAD
```

---

## Task 9: The parse worker — who writes `parse_state` changes, and nothing else does

**Type:** feature. Depends on Task 1's answer.

**Files:**
- Create: `apps/api/src/parse/parseDocument.ts`, `apps/api/src/parse/hydrate.ts`
- Modify: `apps/api/src/routes/documents.ts`, `apps/api/src/main.ts`
- Create: `apps/api/test/parseDocument.test.ts`, `apps/api/test/hydrate.pg.test.ts`

**Interfaces:**
- Consumes: Task 1's `renderPageImages` (or its absence); `pdfjs-dist`, `mammoth`; `blobKeyFor` and the blob store; `SCAN_TEXT_THRESHOLD`, `assessDocument`, `pageSegments` from `@lexprompt/core` (moved in Task 2). **Read `src/lib/documents.ts`** — `parseFile`, `documentFileForViewing`, `documentFileForReview`, `extractPageText`, `PAGE_IMAGE_CACHE_MAX_DOCUMENTS`, `evictPageImages` — because the server's parse must produce **the same text, with the same `[Page N]` markers**, as the browser's, or a review of a document uploaded before this stage and one uploaded after would read differently. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `parseDocument(bytes, mime, name)` → `{ text, pageCount, parseError?, hasTrackedChanges }`; `documentFileForReview(record, bytes)` and `documentFileForViewing(record, bytes)`, server-side.

**P12, closed.** Stage 2 stored `parse_state` from the browser's own parse and said *"Stage 3 changes only who writes it."* This is that change. `'pending'` — in the check constraint since Stage 2 and unused — starts being used.

- [ ] **Step 1: Upload returns before the text exists**

`POST /v1/documents` stores the blob, writes the row with `parse_state = 'pending'` and **returns**. A parse worker picks it up. The browser's `addDocument(record, bytes)` signature does not change (R3's seam), but what it returns is now a document with no text yet — **which is a caller change and therefore a finding**, recorded, with Task 24 rendering "Reading…" over it.

- [ ] **Step 2: Two parsers must produce one text, and the test is byte equality**

```ts
it('produces the same text as the browser parser, marker for marker', async () => {
  // The sibling-drift guard, on the one pair of functions this stage
  // deliberately leaves as two implementations (the browser keeps pdfjs for
  // the viewer and findQuoteRects; the server parses for the engine).
  // Byte equality, not "similar": a [Page N] marker that moved would move
  // every citation's derived page silently.
  const fromBrowser = await parseFile(fileFromFixture());       // jsdom project
  const fromServer  = await parseDocument(bytesOf(fixture), 'application/pdf', 'x.pdf');
  expect(fromServer.text).toBe(fromBrowser.text);
});
```

If they cannot be made equal, **do not paper over it**: one of them is wrong about page markers and that decides every citation page in the app. Report it and stop.

**Consider the stronger fix while you are here**: if the browser's `parseFile` and the server's `parseDocument` are the same algorithm over different IO, extract the algorithm to `packages/core` and give each a thin IO shell. That is S14's rule, and this is the third copy-shaped thing in the stage. Decide, and say which you did and why.

- [ ] **Step 3: Scan detection stays per page**

`SCAN_TEXT_THRESHOLD` applied to each `[Page N]` segment, never to the document total. A document-wide check lets one typed cover page carry a scanned body over the bar; **this blind spot has had to be fixed three times.** The test uses a fixture with one typed page and nine scanned ones and asserts the document is treated as needing images.

- [ ] **Step 4: `parse_state = 'failed'` is a real answer with a real message**

A parse that throws writes `parse_state = 'failed'` and `parse_error` naming the cause, and the document is **refused as a review target** (Task 8 Step 3). It is never `'parsed'` with empty text: *"a document silently marked `parsed` with no text is the founding defect wearing a database column"* — Stage 2's own words, in the migration comment this task makes true.

- [ ] **Step 5: The two hydrations, server-side, and the difference that has reopened twice**

```ts
/**
 * The hydration mode matters as much as the type.
 *
 * `documentFileForViewing` carries no page images — correct for a viewer that
 * renders the PDF itself. `documentFileForReview` regenerates them for a
 * document whose pages fall below SCAN_TEXT_THRESHOLD and caches them in an
 * in-process LRU for the life of the run.
 *
 * Handing a view-hydrated (or raw-record) document to an extractor reviews a
 * scanned document as though it said nothing — this project's FOUNDING
 * DEFECT. It has reopened twice: once one level up (a collection of records)
 * and once one level sideways (a retry on a reopened review). The run worker
 * hydrates FOR REVIEW, and the test below is what keeps that true when this
 * file is next refactored.
 */
```

```ts
it('hands the worker a review-hydrated document, never a view-hydrated one', async () => {
  const spy = spyOnHydration();
  await runOneCell(scannedDocument);
  expect(spy.calls).toEqual(['forReview']);
});
// Mutation: change the worker's call to `documentFileForViewing`. This test
// must fail. It is the only guard between this stage and the defect the
// project was founded on.
```

- [ ] **Step 6: The LRU, and the promise it keeps**

Bounded by `API_PAGE_IMAGE_LRU_BYTES`, keyed by document id, **dropped at the end of the run**. A test asserts no image reaches Postgres or the blob store (the scan from Task 1 Step 4, now over the worker as well, with its companion positive assertion).

- [ ] **Step 7: Gates and commit**

```bash
npm run test:pg && npm run test:compose
git add apps/api/src/parse apps/api/src/routes/documents.ts apps/api/src/main.ts \
  apps/api/test/parseDocument.test.ts apps/api/test/hydrate.pg.test.ts
git commit -m "feat: the server reads documents, and hydrates for review where the engine looks"
git show --stat HEAD
```
---

## Task 10: The run worker — leasing, one cell per transaction, every cap declared

**Type:** feature. The centre of the stage.

**Files:**
- Create: `apps/api/src/run/worker.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/config.ts`
- Create: `apps/api/test/runWorker.pg.test.ts`, `apps/api/test/caps.test.ts`

**Interfaces:**
- Consumes: Task 3's `extractClause` / `extractCollectionClause` and `workerModelClient`; Task 8's `run` / `run_cell` / `appendEvent`; Task 9's hydration; Task 4's `toFindingRow`. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `startWorkerPool(deps): { stop(): Promise<void> }`.

- [ ] **Step 1: The lease, which is the whole design**

```sql
-- One statement. `for update skip locked` is what lets N workers share one
-- queue with no coordinator: a row another worker holds is skipped, not
-- waited for. `limit 1` per worker slot, not per poll — a slot that grabs
-- five cells and dies orphans five leases instead of one.
with claimable as (
  select c.run_id, c.findings_key, c.clause_id
  from run_cell c
  join run r on r.id = c.run_id
  where r.state = 'running'
    and r.cancel_requested_at is null
    and c.attempts < $1                                  -- API_RUN_ATTEMPTS_MAX
    and (c.state = 'queued'
         or (c.state = 'leased' and c.lease_expires_at < now()))
    -- The per-run bound (P26): this run's currently-leased cells, live.
    and (select count(*) from run_cell x
          where x.run_id = c.run_id and x.state = 'leased'
            and x.lease_expires_at > now()) < r.concurrency
    -- The per-workspace ceiling.
    and (select count(*) from run_cell y join run ry on ry.id = y.run_id
          where ry.workspace_id = r.workspace_id and y.state = 'leased'
            and y.lease_expires_at > now()) < $2         -- API_WORKSPACE_RUN_CONCURRENCY
  order by c.run_id, c.findings_key, c.clause_id
  for update of c skip locked
  limit 1
)
update run_cell c
   set state = 'leased', leased_by = $3, lease_expires_at = now() + ($4 || ' ms')::interval,
       attempts = c.attempts + 1
  from claimable k
 where c.run_id = k.run_id and c.findings_key = k.findings_key and c.clause_id = k.clause_id
returning c.*;
```

**Verify this against a real Postgres before trusting it.** `for update of c` with correlated subqueries in the same `where` is the part most likely to be wrong; if Postgres refuses it, restructure rather than dropping the bound. `attempts` increments **on lease**, not on failure, so a worker that dies without reporting still consumes an attempt — otherwise a cell that crashes the worker is retried forever.

- [ ] **Step 2: One transaction per completed cell**

§9: *"Each completed cell writes its `finding` row and appends one `event`, in one transaction."* The model call happens **outside** the transaction (a five-minute HTTP call must not hold a connection or a row lock); the write is a short transaction afterwards that:

1. re-reads the cell and **abandons quietly if the lease has expired or the run is cancelling** — another worker may already have it;
2. `update finding set …` from `toFindingRow`, `version = version + 1`;
3. `update run_cell set state = 'done'`;
4. `appendEvent({ type: 'finding.done', payload: { findingsKey, clauseId, version } })`.

**The worker writes model-authored columns and nothing else.** It has no grant on either disposition table (Task 5), so `carryHumanState`'s whole reason for existing is gone by construction rather than by care: there is no snapshot, so there is nothing to merge.

- [ ] **Step 3: The two extractors, chosen by target — through `findingsKeyFor`**

A collection cell calls `extractCollectionClause` over the ordered, review-hydrated members; a document cell calls `extractClause`. **Never fall back from one to the other.** `handleRetryCell`'s comment says why: *"silently falling back to `extractClause` … would replace that synthesis with a one-document answer, on screen indistinguishable from a correct re-run."* If a collection's members cannot be assembled, the cell becomes `error` naming that, and the run continues.

`orderedMembers` decides reading order and `documentDate` never sorts it (`collectionOrder.ts`, now in core). The worker reads the collection record for the order; it does not re-derive it.

- [ ] **Step 4: `run.provider` / `model` / `jurisdiction`, written once from what the gateway said**

The first cell that gets a `200` from the gateway writes them onto the run — from the response, never from configuration (§6.5, S26). A test asserts a run whose gateway returned `jurisdiction: 'UK'` stores `'UK'` even when the configuration has since changed, which is the assertion §14's `jurisdiction` suite names.

- [ ] **Step 5: The pool-size check, at startup, loudly**

```ts
// The new cap tier, and the one with no precedent in this repository. Each
// worker slot holds a pool connection for the length of its write
// transaction; request handlers hold one for the length of a request. If
// API_RUN_WORKERS plus the expected request concurrency exceeds
// API_DATABASE_POOL_MAX, the API deadlocks under its OWN worker, and every
// symptom points at the database.
if (config.databasePoolMax <= config.runWorkers + POOL_HEADROOM) {
  throw new ConfigError(
    `API_DATABASE_POOL_MAX is ${config.databasePoolMax}, which is not enough for `
    + `API_RUN_WORKERS=${config.runWorkers} plus ${POOL_HEADROOM} for request handlers. `
    + 'Raise the pool or lower the worker count.',
  );
}
```

The same posture as every other startup refusal in this system: a misconfiguration must not become a service that runs and mostly works.

- [ ] **Step 6: The cap-reader test**

```ts
// apps/api/test/caps.test.ts
it('gives every declared cap a reader in the shipped source', () => {
  const declared = ['API_RUN_CELL_TIMEOUT_MS', 'API_RUN_LEASE_MS', 'API_RUN_HEARTBEAT_MS',
    'API_RUN_ATTEMPTS_MAX', 'API_RUN_WORKERS', 'API_WORKSPACE_RUN_CONCURRENCY',
    'API_PAGE_RENDER_TIMEOUT_MS', 'API_PAGE_IMAGE_MAX_PAGES', 'API_PAGE_IMAGE_LRU_BYTES',
    'API_EVENT_RETENTION_DAYS', 'API_EVENT_PAGE_MAX'];
  const config = codeOf('apps/api/src/config.ts');
  const rest = allSourceExceptConfig();
  for (const name of declared) {
    expect(config, `${name} is not read in config.ts`).toContain(name);
    const field = fieldNameFor(name);
    expect(rest.some(f => f.includes(field)), `${field} is declared and never used`).toBe(true);
  }
  // Sanity check: the scanner is reading files, not an empty list.
  expect(rest.length).toBeGreaterThan(30);
});
```

Three undeclared-cap defects have been found in this repository, all on the scanned-document path. This test is what makes the fourth one loud.

- [ ] **Step 7: Run it, against the live stack, with a real run**

Start the stack, create a review with two documents and three clauses over `curl`, `POST` a run, poll `GET /v1/runs/:id` and `GET /v1/runs/:id/events`. **Watch the findings arrive in Postgres one at a time.** Record the wall-clock, the number of gateway calls in the gateway's stdout log, and confirm each carries `purpose: review.clause` and the **requesting user's** `actorUserId` — not a service identity.

- [ ] **Step 8: Commit**

```bash
npm run test:pg && npm run test:compose
git add apps/api/src/run/worker.ts apps/api/src/main.ts apps/api/src/config.ts \
  apps/api/test/runWorker.pg.test.ts apps/api/test/caps.test.ts
git commit -m "feat: the engine runs server-side, one leased cell per transaction"
git show --stat HEAD
```

---

## Task 11: Cancel, resume, and the reaper — a run that died must not look finished

**Type:** feature. This is §18 item 4's first two clauses and the whole of rule 4.

**Files:**
- Create: `apps/api/src/run/reaper.ts`
- Modify: `apps/api/src/routes/runs.ts`, `apps/api/src/run/worker.ts`, `apps/api/src/main.ts`
- Create: `apps/api/test/runLifecycle.pg.test.ts`, `apps/api/test/runWorker.compose.test.ts`

**Interfaces:**
- Consumes: Tasks 8 and 10. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `startReaper(deps)`; the terminal-state rules below.

**The four facts a run must keep distinguishable**, because collapsing any pair of them is this stage's version of answering quietly wrong:

| State | What it means | What the reader must be able to tell |
|---|---|---|
| `succeeded` | every cell reached `done` or `error`, and the run finished | a cell in `error` is a finding a person can retry; the run is over |
| `cancelled` | a person asked it to stop | **not a failure.** Everything already completed stays; nothing is `pending` |
| `failed` | the run stopped without being asked — a reaped heartbeat, or a fatal error | **not a cancellation, and not a success.** It says why |
| `running` with a live heartbeat | in flight | not "stuck": the heartbeat is what distinguishes them |

- [ ] **Step 1: Cancel leaves no cell in `pending`**

§9, and `CLAUDE.md` names the defect it prevents: *"an abandoned run reopening with every cell spinning forever, unfinishable."*

`POST /v1/runs/:id/cancel` sets `cancel_requested_at` and `state = 'cancelling'`. Workers check it between cells and abort the in-flight call (`AbortController`, threaded into `chatJson` exactly as the browser threads it today). When the last lease is released:

```sql
update run_cell set state = 'cancelled' where run_id = $1 and state in ('queued','leased');
update finding set status = 'cancelled', version = version + 1
 where (review_id, findings_key, clause_id) in (…the cancelled cells…)
   and status in ('pending','running');
update run set state = 'cancelled', finished_at = now();
```

A **`done` cell is never rewritten**: a cancelled run is real, partial work, and `cancelPendingCells` in today's browser engine already gets this right. The test asserts a cancelled run has zero cells in `queued` or `leased` **and** that its completed findings are untouched.

- [ ] **Step 2: A dead worker's cell is re-leased and completes**

```ts
it('re-leases a cell whose lease expired and finishes the run', async () => {
  const cell = await leaseOne('worker-a');
  await expireLease(cell);                       // the worker died holding it
  const again = await leaseOne('worker-b');
  expect(keyOf(again)).toEqual(keyOf(cell));
  expect(again.attempts).toBe(2);
});
// Mutation: drop `or (c.state = 'leased' and c.lease_expires_at < now())`
// from Task 10's claim query. This test must fail — and note that WITHOUT the
// mutation check it would pass against a queue that simply never leases
// anything, which is how a Stage 2 test came to prove nothing.
```

- [ ] **Step 3: `attempts` exhausted is an `error` finding, never a silent stop**

§9: *"`attempts` is bounded (3); a cell that exhausts them becomes `error` carrying its last error text, which is a finding a person can retry by hand — not a cell that quietly never finishes."* The finding's `error` column carries the text and the card shows it exactly as it shows an extraction error today.

- [ ] **Step 4: The reaper**

Every `API_RUN_HEARTBEAT_MS`, a run whose `heartbeat_at` is older than three intervals becomes `failed` with `error = 'This run stopped without finishing. No worker has reported on it since <time>.'` Its `queued`/`leased` cells become `error` (not `cancelled` — nobody cancelled it) and their findings become `error` with the same message.

**A run that has never started has no heartbeat and is not reaped.** A `queued` run with no worker (the pool is busy, or the API restarted before starting one) must not be marked failed for waiting. Test that explicitly: it is the difference between a busy queue and a broken one.

- [ ] **Step 5: The compose test that no unit test can replace**

```ts
// apps/api/test/runWorker.compose.test.ts
it('survives the API being killed mid-run and finishes', async () => {
  const run = await startRunOverHttp(review);
  await waitForCells(run, 2);                       // some done, some in flight
  await sh('docker compose restart api');
  await waitForState(run, 'succeeded', { timeoutMs: 180_000 });
  expect(await cellsIn(run, 'pending')).toBe(0);
  expect(await findingsFor(review)).toHaveLength(expectedCells);
});
```

**Run it, and put the wall-clock in the report.** §18 item 4's first clause is *"a run survives a worker restart mid-run and completes"*, and it is not a claim a unit test can make.

- [ ] **Step 6: The invariant test between the two state machines (Task 8 Step 2)**

```ts
it('never leaves a done cell whose finding is still running', async () => {
  expect(await query(`select 1 from run_cell c join finding f using (findings_key, clause_id)
                      join run r on r.id = c.run_id and r.review_id = f.review_id
                      where c.state = 'done' and f.status in ('pending','running')`)).toEqual([]);
});
```

Run it after every scenario in this file, not once. An invariant checked in one scenario is an assertion about one scenario.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/run apps/api/src/routes/runs.ts apps/api/src/main.ts \
  apps/api/test/runLifecycle.pg.test.ts apps/api/test/runWorker.compose.test.ts
git commit -m "feat: cancel, resume and a reaper, so a run that died cannot look finished"
git show --stat HEAD
```

---

## Task 12: The event outbox, its retention, and the cursor Stage 4 inherits

**Type:** feature

**Files:**
- Modify: `apps/api/src/run/events.ts`, `apps/api/src/routes/runs.ts`, `apps/api/src/run/reaper.ts`
- Create: `apps/api/test/events.pg.test.ts`
- Modify: `packages/core/src/api/records.ts` (the event payload types — the shared vocabulary, per Stage 2's interface note 14)

**Interfaces:**
- Consumes: Task 8's `event` table. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `RunEvent` and its five payload types in `@lexprompt/core`; `GET /v1/runs/:id/events`; the pruner.

- [ ] **Step 1: Five types, named by §9, in the shared vocabulary**

`run.started`, `finding.running`, `finding.done`, `finding.error`, `run.finished`. Declared in `packages/core/src/api/records.ts` because both sides read them and Stage 4's socket will send exactly these — *"one payload vocabulary, two transports"* (P22). Every payload carries the `version` of the row it describes, so a client can drop one that is not newer (§8's idempotence rule, which is what makes replay safe).

- [ ] **Step 2: `appendEvent` is the only writer, and it writes in the caller's transaction**

Never its own. An event committed while the row it describes rolled back is a client told about a finding that does not exist — the network-era version of every defect on `CLAUDE.md`'s list. A test asserts it: roll back a worker transaction and confirm no event survives.

- [ ] **Step 3: Retention, and the honest answer past it**

A pruner deletes events older than `API_EVENT_RETENTION_DAYS` (7, §6.5 — *"a reconnection buffer, not an archive"*). A cursor older than the oldest surviving event gets `{ resyncRequired: true }` rather than a silently short list. **Silently short is the failure**: a client that asked for everything after 400 and got everything after 900 has a hole it cannot see.

- [ ] **Step 4: Commit**

```bash
npm run test:pg
git add apps/api/src/run/events.ts apps/api/src/routes/runs.ts packages/core/src/api/records.ts \
  packages/core/src/index.ts apps/api/test/events.pg.test.ts
git commit -m "feat: the run's events and a cursor, over HTTP now and a socket in Stage 4"
git show --stat HEAD
```

---

## Task 13: Part 3A gate — the definition of done, on a running stack

**Type:** verification. **Part 3B does not begin until this passes.**

**Files:**
- Create: `apps/api/test/stage3aDoD.test.ts`
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/part-3a-report.md`

- [ ] **Step 1: The searched checks, not the assumed ones**

```ts
it('gives the worker role no path to a disposition, by grant', async () => { … });   // Task 5, re-run here
it('leaves review.findings equal to the rows for every review in the database', async () => {
  for (const id of await allReviewIds()) expect(await reconcileFindings(t, id)).toEqual([]);
});
it('has exactly one writer of finding_disposition in the source', () => {
  const writers = filesMatching(/insert\s+into\s+finding_disposition|update\s+finding_disposition/i);
  expect(writers).toEqual(['apps/api/src/dispositions/service.ts']);
  expect(filesScanned()).toBeGreaterThan(30);          // the sanity check
});
it('still calls carryHumanState — it is deleted in Task 21, not before', () => {
  expect(codeOf('src/App.tsx')).toContain('carryHumanState');
});
```

That last one is not a joke. Part 3A's whole claim is that nothing about the browser changed, and `carryHumanState` still being called is the cheapest possible proof that the browser still orchestrates. **Its deletion is Task 21 and it is guarded from arriving early.**

- [ ] **Step 2: The live checks, in order, with the results written down**

1. `npm run compose:up`; all services healthy.
2. Sign in with a real token; `GET /v1/matters` unauthenticated is still `401 sign_in_required`, **not an empty list** (Stage 2's own check, re-run because a new route group landed).
3. Create a review, `POST` a run, watch findings land in Postgres.
4. `docker compose restart api` mid-run; the run completes.
5. Cancel a second run; no cell in `pending`; completed findings untouched.
6. Kill the gateway; a cell errors loudly and the run does not hang.
7. `docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com'` — **still fails.** New dependencies arrived this part and §5's central claim is a network fact that has to be re-checked, not inherited.
8. The reconciliation over the real database, printed.

- [ ] **Step 3: Say what you could not do**

Browser automation is expected to be unavailable. **Say so plainly rather than implying otherwise** — Stage 2's ledger did, and it is why its gap is a known one rather than a surprise.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/stage3aDoD.test.ts \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/part-3a-report.md
git commit -m "test: Part 3A's definition of done, searched and run rather than assumed"
git show --stat HEAD
```

---

# PART 3B — the engine is the writer, the browser watches

---

## Task 14: Findings are read from rows

**Type:** feature. P17's second move: the reader flips.

**Files:**
- Create: `apps/api/src/findings/read.ts`; modify `apps/api/src/routes/findings.ts`, `apps/api/src/routes/reviews.ts`
- Create: `src/lib/api/findings.ts`; modify `src/lib/db/reviews.ts`
- Create: `apps/api/test/findingsRead.pg.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7. **Read `src/lib/db/reviews.ts` in full**: `getReview`, `listReviews`, `saveReview`, `forgetReviewVersion`, `createDebouncedReviewSaver`, and the private `repair` / `buildVersionIndex` that upgrade an older stored shape on read. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `GET /v1/reviews/:id/findings` → `{ findings: Record<findingsKey, Record<clauseId, Finding>>, version: number }`.

- [ ] **Step 1: Assemble the wire shape from three tables**

`finding` + `finding_disposition` + `note`, keyed by `findings_key` then `clause_id` — **the same nested shape `types.ts` declares**, so not one consumer of `run.findings` in `src/` changes in this task. The read is one query with two left joins, not N+1.

`verification` is assembled from the disposition: `{ state, byUserId, at, reason? }` where `changed_count > 0`, and `unchecked()` where it is 0. **`assigneeId` is gone** (P24) and is not synthesised.

- [ ] **Step 2: The absent-key rules survive the reassembly**

Every rule from Task 4 Step 2 is re-asserted here, on the assembled object rather than the row, because this is what a caller actually sees:

```ts
it('assembles a standalone finding with no netPosition key at all', async () => {
  expect('netPosition' in (await read('r1')).findings['d1']['c1']).toBe(false);
});
it('assembles a collection finding under the COLLECTION key, not a document id', async () => {
  const f = (await read('r-collection')).findings;
  expect(Object.keys(f)).toEqual(['col-1']);
});
```

The second is R-C1 restated at the client/server boundary. Six defects came from getting it wrong once.

- [ ] **Step 3: `getReview` reads findings from the new route**

`getReview(id)` returns a `Review` whose `findings` came from `GET /v1/reviews/:id/findings` rather than from the review row's blob. Its signature does not change. **`repair`/`buildVersionIndex` keep running** — they upgrade an older shape and a review read today can still be one.

`GET /v1/reviews/:id` **stops returning `findings`** and Task 22 makes the column unreadable to the app role. Until then, a test asserts the two agree — one more instance of P17's reconciliation, at the read.

- [ ] **Step 4: Gates and commit**

```bash
npm run test:pg && npm test
git add apps/api/src/findings/read.ts apps/api/src/routes/findings.ts \
  apps/api/src/routes/reviews.ts apps/api/src/auth/routeTable.ts src/lib/api/findings.ts \
  src/lib/db/reviews.ts apps/api/test/findingsRead.pg.test.ts src/lib/db/reviews.test.ts
git commit -m "feat: findings are read from rows, in the shape every caller already expects"
git show --stat HEAD
```

---

## Task 15: Dispositions and notes — the only writers are people

**Type:** feature

**Files:**
- Modify: `apps/api/src/routes/findings.ts`, `apps/api/src/auth/routeTable.ts`
- Create: `apps/api/test/dispositionRoutes.pg.test.ts`
- Modify: `packages/core/src/model/protocol.ts` (any new `ModelErrorCode`, into the closed set)

**Interfaces:**
- Consumes: Task 5's `setDisposition`; `ConflictError` from `apps/api/src/errors.ts`. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `PUT /v1/reviews/:id/findings/:findingsKey/:clauseId/disposition`, `POST …/notes`, `GET …/history`.

- [ ] **Step 1: The disposition route, await-then-apply, version-guarded**

Body: `{ state, reason?, version }`. Response: the persisted `finding_disposition` **and the `finding_disposition_event` that produced it** — §8 says the finding read returns both so `from_state` is on hand at first render without a second query, and Stage 4's *"was Rejected"* needs no new mechanism.

A stale `version` is `409` **carrying the current row** (`ConflictError`, already shipped). Stage 3 shows a plain refusal; Stage 4 puts the sentence on it. **The refusal is here, and it must not be softened into a retry** (P25).

- [ ] **Step 2: The route refuses what the type system cannot**

- `rejected` with no reason → `400` naming the rule (the constraint would refuse it too; the route says which field).
- a `findingsKey`/`clauseId` naming no `finding` → `404`, never a row created on the fly. A disposition on a finding that does not exist is a judgement about nothing.
- `cause` is **not** in the body. A request can only ever produce `cause = 'human'`; `'rerun_reset'` is written by Task 16's handler alone. A body field would be a way for a client to write a history row that lies about why.

- [ ] **Step 3: Notes**

`POST …/notes` with `{ text }`; the actor and instant come from the server. Notes are **not** touched by a disposition change and **not** reset by a re-run — *"a note is a person's remark about the clause, not a component of their judgement on one answer."* A test asserts a re-run leaves the notes exactly as they were, which is the same test `App.rerunResets.test.tsx` makes today, moved to the server.

- [ ] **Step 4: `GET …/history` exists and nothing renders it yet**

The route lands here because it is one query over a table this stage created, and because Stage 4's history panel should inherit a tested endpoint rather than write one. **No UI reads it in Stage 3** (P28). Say so in the route's docstring so the next reader does not think it was forgotten.

- [ ] **Step 5: Commit**

```bash
npm run test:pg
git add apps/api/src/routes/findings.ts apps/api/src/auth/routeTable.ts \
  packages/core/src/model/protocol.ts apps/api/test/dispositionRoutes.pg.test.ts \
  apps/api/test/authz.route.test.ts
git commit -m "feat: a disposition is a person's request, refused when stale and never derived"
git show --stat HEAD
```

---

## Task 16: The re-run reset, as one transaction, in the retry handler

**Type:** feature. **Mutation-tested twice, by name, per §14.**

**Files:**
- Modify: `apps/api/src/routes/runs.ts`, `apps/api/src/dispositions/service.ts`
- Create: `apps/api/test/rerunReset.pg.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 8, 15. **Read `src/App.tsx`'s `handleRetryCell`** — the shipped browser implementation of this rule, with the reasoning in its comments; the server version must preserve its behaviour, not reinvent it. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `POST /v1/reviews/:id/findings/:findingsKey/:clauseId/retry`.

- [ ] **Step 1: The transaction, exactly as §9.1 writes it**

```sql
BEGIN;
  UPDATE finding SET status = 'pending', summary = NULL, citations = '[]'::jsonb,
         risk_level = NULL, risk_analysis = NULL, error = NULL, no_content = false,
         truncated = false, truncated_documents = NULL,
         position_outcome = NULL, position_rationale = NULL,
         net_position = NULL,                        -- cleared by the SAME transaction
         version = version + 1
   WHERE (review_id, findings_key, clause_id) = (:r, :k, :c);

  INSERT INTO finding_disposition_event
         (review_id, findings_key, clause_id, workspace_id,
          from_state, to_state, reason, cause, by_user_id, at)
  SELECT  :r, :k, :c, :ws, state, 'unchecked', NULL, 'rerun_reset', :actor, now()
    FROM finding_disposition WHERE (review_id, findings_key, clause_id) = (:r, :k, :c);

  UPDATE finding_disposition
     SET state = 'unchecked', reason = NULL, by_user_id = :actor, at = now(),
         changed_count = changed_count + 1, version = version + 1
   WHERE (review_id, findings_key, clause_id) = (:r, :k, :c);

  -- Notes are NOT touched: a note is about the clause, not about one run's output.
  INSERT INTO run_cell (…) VALUES (… 'queued' …) ON CONFLICT DO UPDATE SET state='queued', attempts=0;
  INSERT INTO event (…) VALUES (…);
COMMIT;
```

**Three things this must not do**, each of which the shipped browser code gets right and a fresh implementation would get wrong:

- **It runs in the retry request handler, never in the worker** (S21). A person asked for this; the worker's role cannot write either table at all, so putting it there would not merely be wrong, it would fail — which is the point of the grant.
- **It attributes to the person who asked for the re-run**, not to `'system'` and not to whoever last held the disposition. §9.1: that is what lets an export say *"unchecked — re-run by A. Gray at 11:07, previously verified by R. Okafor"*.
- **The disposition row is updated, never deleted.** Deleting it would lose who last held it and leave the history's `from_state` with nothing to be read against.

- [ ] **Step 2: The two mutations §14 names, written as tests before the code**

```ts
it('records the clearing as well as performing it', async () => {
  await verify(key); await retry(key);
  expect(await dispositionFor(key)).toMatchObject({ state: 'unchecked', changed_count: 2 });
  const last = await lastEvent(key);
  expect(last).toMatchObject({ from_state: 'verified', to_state: 'unchecked', cause: 'rerun_reset', by_user_id: actor.id });
});
// MUTATION (a): delete the INSERT INTO finding_disposition_event and leave
// the UPDATE. This test must fail. §14: "a reset that clears a verification
// without recording that it did is the same lie as a reset that does not
// happen."

it('clears the net position too, in the same transaction', async () => { … });
// MUTATION: drop `net_position = NULL`. This test must fail. resetPosition
// mirrors resetVerification for the same reason and is mutation-tested for
// the same reason.

it('is atomic — a failure mid-transaction leaves nothing half-done', async () => {
  await failAfterTheEventInsert();
  expect(await dispositionFor(key)).toMatchObject({ state: 'verified' });   // unchanged
  expect(await eventCount(key)).toBe(1);                                    // no orphan row
});

it('leaves the notes alone', async () => {
  await addNote(key, 'still relevant'); await retry(key);
  expect(await notesFor(key)).toHaveLength(1);
});
```

- [ ] **Step 3: A collection retry re-runs the collection extractor**

The retry enqueues a cell whose `findings_key` is the **collection** id, so Task 10's dispatch picks `extractCollectionClause`. There is no path by which a collection clause is retried through the single-document extractor — the browser's own comment explains what that would cost: *"replace that synthesis with a one-document answer, on screen indistinguishable from a correct re-run."*

- [ ] **Step 4: Commit**

```bash
npm run test:pg
git add apps/api/src/routes/runs.ts apps/api/src/dispositions/service.ts \
  apps/api/test/rerunReset.pg.test.ts apps/api/src/auth/routeTable.ts
git commit -m "feat: re-running a clause clears its disposition and records that it did"
git show --stat HEAD
```
---

## Task 17: The browser's run client

**Type:** feature

**Files:**
- Create: `src/lib/api/runs.ts`, `src/lib/api/runs.test.ts`
- Modify: `src/lib/loadError.ts` (the run-specific shapes)

**Interfaces:**
- Consumes: `src/lib/api/client.ts` (Stage 2's one HTTP transport — **read it**; it owns the token, the base URL and the `ModelError` classification, and this module adds none of its own). **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  startRun(reviewId: string): Promise<Run>
  getRun(runId: string): Promise<Run>
  cancelRun(runId: string): Promise<Run>
  retryCell(reviewId: string, findingsKey: string, clauseId: string): Promise<Run>
  watchRun(runId: string, onEvent: (e: RunEvent) => void, onError: (e: unknown) => void): () => void
  ```

- [ ] **Step 1: `watchRun` polls the cursor, and its shape is Stage 4's**

```ts
/**
 * Polls GET /v1/runs/:id/events?after=<cursor> and calls `onEvent` for each,
 * in order, keeping the highest id it has applied. Returns an unsubscribe.
 *
 * This is deliberately the SAME contract a WebSocket subscription will have
 * in Stage 4 (§8): subscribe, receive events in id order, keep a cursor, and
 * be told `resync_required` when the cursor falls outside the retention
 * window. Stage 4 replaces the transport inside this function and changes no
 * caller — which is why the poll lives here rather than in App.tsx (P22).
 *
 * What it is NOT: the fourth load state. `stale` is realtime's and arrives
 * in Stage 4 (§3). A polling client that misses a beat is not stale, it is
 * one interval behind, and inventing a stale indicator here would ship half
 * of Stage 4's most easily-skipped feature.
 */
```

Poll interval: 1 000 ms while the run is `queued`/`running`/`cancelling`, stopping on a terminal state. On `resyncRequired`, refetch the findings map over HTTP and continue — the same recovery §8 specifies, without the UI language Stage 4 adds.

- [ ] **Step 2: The three load states, and the fourth fact a run has**

`describeLoadError` gains nothing new; what is new is that a **run** has a terminal state that is not an error and not a success. `failed` is rendered as a failure with its `error` text; `cancelled` is rendered calmly. A test asserts the two produce different strings — the same rule `Finding.status`'s `cancelled` already follows, one level up.

- [ ] **Step 3: A polling error does not silently stop the poll**

If three consecutive polls fail, `onError` fires and the caller shows it. A poll loop that dies quietly leaves a run apparently frozen at whatever it last saw — a job that died looking like a job still working, which is rule 4 inverted.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/runs.ts src/lib/api/runs.test.ts src/lib/loadError.ts src/lib/loadError.test.ts
git commit -m "feat(web): the browser asks about a run instead of performing one"
git show --stat HEAD
```

---

## Task 18: `handleStartRun` asks the server

**Type:** feature. The writer flip begins.

**Files:**
- Modify: `src/App.tsx`, `src/features/review/runReview.ts`, `src/lib/db/reviews.ts`
- Modify: `src/App.interrupted.test.tsx`, `src/App.reviewSaveError.test.tsx` and the run-related App tests
- Delete: `src/features/review/runReview.test.ts`'s engine cases (the engine is gone; `emptyRun`'s cases stay)

**Interfaces:**
- Consumes: Task 17's client. **Read `src/App.tsx`'s `handleStartRun` in full** — it is ~200 lines and carries five separate guards (a deleted matter checked twice, the new-document persist, the debounced saver's `onError`, `persistFinal`'s reading of `latestRunRef`, and the abort-is-not-a-failure branch). **Every one of those guards has a reason written beside it and most of them survive.** **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: an `App.tsx` in which no model call originates.

- [ ] **Step 1: What survives, what moves, and what goes**

| In `handleStartRun` today | After |
|---|---|
| the deleted-matter checks (twice) | **survive** — the matter can still be deleted between click and request |
| persisting newly-uploaded documents into the matter | **survives**, and now must wait for `parse_state = 'parsed'` before the run is startable (Task 9) |
| `emptyRun(template, docs, target)` | **survives in the browser** for the optimistic view of a run's shape? **No** — `POST /v1/reviews/:id/runs` seeds the `pending` findings server-side (Task 8), and the browser renders what it reads. `emptyRun` stays exported only if a caller still needs it; if none does, it goes with `runReview` and its tests go with it |
| `runReview(...)` and its `handleUpdate` | **gone.** Replaced by `startRun` + `watchRun` |
| `carryHumanState(latestRunRef.current, updated)` | **still called** on each applied event's re-read until Task 21. Do not delete it here |
| `createDebouncedReviewSaver` and `persistFinal` | **gone.** The server writes findings; there is no whole-review save during a run. **This is the sticky-409 remedy (P25)** |
| `abortControllerRef` / `handleCancelRun` | `handleCancelRun` calls `cancelRun(runId)`; the local `AbortController` goes |
| the abort-is-a-deliberate-stop branch | **survives as a state**, not an exception: `run.state === 'cancelled'` is calm, `'failed'` is not |

- [ ] **Step 2: The one behavioural change a user can see, named**

Today the results view fills in progressively as `onUpdate` fires, and *"that progressive fill is the entire feel of the app"* — `handleStartRun`'s own comment. Polling at one second keeps it, one second coarser. **Say so in the report and check it by eye** (Task 26's human list). If it reads as sluggish, the interval is the knob, not the architecture — and Stage 4's socket removes the question.

- [ ] **Step 3: A run started in another tab, or before a reload, is findable**

Today the run lives in React state and dies with the tab. Now it is a row. On opening a review, the browser asks for its live run (`GET /v1/reviews/:id/runs?state=live` or the run id on the review) and resumes watching. **This is new behaviour and it is the point of the stage** — it is also §18 item 4's first clause seen from the reader's side.

- [ ] **Step 4: The tests that change, and the ones that must not**

`App.interrupted.test.tsx` and `App.reviewSaveError.test.tsx` are about a browser-orchestrated run and will change. **`App.verification.test.tsx` and `App.rerunResets.test.tsx` must keep asserting exactly what they assert now** — that a verification survives a run and that a re-run clears it. Those are the behaviours this stage is most able to break, and a test edit there is a finding, not a chore (R-G22). If one of them has to change shape because the seam moved, the assertion inside it stays word for word.

- [ ] **Step 5: Gates and the live check**

```bash
npm run typecheck && npm test && npm run build
```
Then, on the live stack: start a run, reload the page mid-run, confirm the results view picks it up and finishes. That is the check no unit test makes and it is the one users will do first.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/features/review/runReview.ts src/lib/db/reviews.ts src/App.*.test.tsx \
  src/features/review/runReview.test.ts
git commit -m "feat(web): the browser starts a run and watches it, instead of running it"
git show --stat HEAD
```

---

## Task 19: Human writes go to their own routes

**Type:** feature

**Files:**
- Modify: `src/App.tsx`, `src/lib/api/findings.ts`
- Modify: `src/App.verification.test.tsx` (its seam, not its assertions)

**Interfaces:**
- Consumes: Task 15's routes. **Read `handleVerify`, `handleAddNote`, `handleConfirmNetPosition`, `handleAmendNetPosition` in `src/App.tsx`** — all four share a shape (read `latestRunRef`, `await getProfile()`, `await saveReview(...)`, re-read the ref, merge, set state, schedule a save) and all four carry a comment explaining that the re-read after the awaits is what stops a live run's `onUpdate` from being discarded. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: four handlers that write one thing each.

- [ ] **Step 1: Each handler becomes: call the route, apply what it returned**

```ts
const handleVerify = async (docId: string, clauseId: string, change: VerificationChange) => {
  const key = findingsKeyFor(current.target, docId);
  setVerifyBusyKey(findingKey(docId, clauseId));
  try {
    // await-then-apply, unchanged in substance (§3, S8): the UI renders the
    // row the store confirmed and nothing else. What has gone is the
    // read-modify-write over a whole review, and with it the race
    // `latestRunRef`'s re-read existed to close — there is nothing left to
    // merge, because this write touches one row and the engine cannot touch
    // that row at all.
    const applied = await setDisposition(reviewId, key, clauseId, change, versionOf(existing));
    applyDisposition(key, clauseId, applied);
  } catch (e) {
    if (isConflict(e)) notify('This finding changed while you were looking at it. Reload the review and try again.', 'error');
    else notify(e instanceof Error ? `This verification was not saved: ${e.message}` : 'This verification was not saved.', 'error');
  } finally { setVerifyBusyKey(null); }
};
```

**The `409` message above is Stage 3's, and it is deliberately less helpful than Stage 4's.** §6.3's *"Priya changed this to Rejected at 14:22, after you loaded it"* needs the actor and the time on the card, which is the attribution surface Stage 4 ships (P28). Do not build half of it here.

- [ ] **Step 2: `getProfile()` is no longer needed on these paths**

The server knows who is asking. Removing the `await getProfile()` from each handler removes one of the two awaits each of those long comments is about — **say so in the report**, because Stage 2's Task 16 found five unhandled-rejection bugs among these very call sites and this is the change that retires them.

- [ ] **Step 3: `net position` confirm and amend, the same shape**

`confirmPosition` / `amendPosition` / `NetPositionError` stay in `@lexprompt/core` and stay the only producers of a `NetPosition`. The route stores what they produce. **A net position is synthesised text no document contains** — it starts unconfirmed for the same reason a finding starts `unchecked()`, and only a human confirms or amends it. Nothing about moving the store changes that, and a test asserts the engine's write path cannot produce a confirmed one.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/lib/api/findings.ts src/App.verification.test.tsx
git commit -m "feat(web): a verification, a note and a net position are each their own write"
git show --stat HEAD
```

---

## Task 20: `handleRetryCell` asks the server, and the browser stops hydrating for review

**Type:** feature

**Files:**
- Modify: `src/App.tsx`, `src/lib/documents.ts`
- Modify: `src/App.rerunResets.test.tsx` (its seam, not its assertions)

**Interfaces:**
- Consumes: Task 16's retry route. **Read `handleRetryCell`, `failRetryCell`, `persistRetryResult`, `hydrateRecordForReview` and `hydrateIdForReview` in `src/App.tsx`** — about 200 lines carrying the founding defect's guard, the collection-retry refusal, the busy-state-before-hydration fix and the reset notice. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: a retry that is one POST.

- [ ] **Step 1: What the server now owns, and what the browser keeps**

| Today, in the browser | After |
|---|---|
| the verification/net-position reset, with `resetVerification`/`resetPosition` | **server**, Task 16, in one transaction with a history row the browser never had |
| re-hydrating the document **for review** (`hydrateIdForReview`) | **server**, Task 9. `hydrateRecordForReview` / `hydrateIdForReview` are **deleted** |
| the collection-retry refusal when `activeCollectionRef` is missing | **server** — it reads the collection record; the browser's refusal message goes with the ref |
| `failRetryCell`'s "the stored file could not be read" path | **server**: hydration reports failure as `parseError` and the cell becomes an `error` finding naming the real cause |
| the "this clause is being re-run, so its verification was cleared" notice | **browser** — it is a message to the person who clicked, and the route's response says what was cleared |

- [ ] **Step 2: The notice keeps its three wordings**

`handleRetryCell` composes one of *"verification and net position were"*, *"net position was"*, *"verification was"* from what the finding actually held. The response now says what the transaction cleared, so the browser composes from that rather than from its own copy — **same three strings, same rule**. This is a place where a "pure mechanism" change could quietly reword a user-facing sentence; the test asserting those strings must not be edited (R-G22).

- [ ] **Step 3: Delete the hydration helpers and prove nothing else used them**

```bash
grep -rn "hydrateIdForReview\|hydrateRecordForReview\|documentFileForReview" src --include=*.ts --include=*.tsx
```
`documentFileForReview` may still have a browser caller (check the assistant panel and the redlines path). If it does, it stays; if it does not, it goes, and `PAGE_IMAGE_CACHE_MAX_DOCUMENTS` / `evictPageImages` go with it. **Say which in the report** — the founding-defect guard now lives on the server (Task 9 Step 5) and it must not end up living nowhere.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/lib/documents.ts src/App.rerunResets.test.tsx src/lib/documents.test.ts
git commit -m "feat(web): a retry is a request, and the server hydrates for review"
git show --stat HEAD
```

---

## Task 21: Delete `carryHumanState` and `findingMerge.ts`

**Type:** deletion. **S5, and the single most-watched change in this stage.**

**Files:**
- Delete: `src/lib/findingMerge.ts`, `src/lib/findingMerge.test.ts`
- Modify: `src/App.tsx`
- Create: `apps/api/test/humanStateSurvives.pg.test.ts`

**Interfaces:**
- Consumes: Tasks 14–20 — **all of them.** This task is not startable until no browser code path orchestrates a run or writes a whole review. Check by grep, not by memory:
  ```bash
  grep -rn "runReview(\|createDebouncedReviewSaver\|scheduleSave" src --include=*.tsx --include=*.ts
  ```
  Anything that returns is a Task 18/19/20 remnant and this task waits.

**Why it may go.** §9.1: *"With findings as rows, the engine writes only the model-authored columns of the one cell it just ran, and a human write goes to `finding_disposition` / `finding_disposition_event` or `note` — tables the run worker's role cannot write to at all. There is no snapshot, so there is nothing to merge, so nothing can clobber a human write."*

**Why this is dangerous.** `carryHumanState` is the only thing standing between a live run and a lost verification **today**. Deleting it before the property that replaces it is real would lose a lawyer's judgement silently — nothing on screen would say anything. So the deletion is gated on a proof, and the proof is structural rather than behavioural.

- [ ] **Step 1: Write the proof first, and make it fail for the right reason**

```ts
// apps/api/test/humanStateSurvives.pg.test.ts
it('keeps a verification made mid-run across every subsequent cell', async () => {
  const run = await startRun(review);                  // 20 cells
  await completeCells(run, 5);
  await setDisposition(keyOf(cell3), { state: 'verified' }, actor, 1);
  await completeCells(run, 15);                        // fifteen unrelated cells finish
  expect(await dispositionFor(keyOf(cell3))).toMatchObject({ state: 'verified', by_user_id: actor.id });
});

it('cannot lose it, because the worker has no grant to lose it with', async () => {
  // THE MUTATION THAT MATTERS: `grant update on finding_disposition to
  // lexprompt_worker`, then re-run the whole file. The test above STILL
  // passes — the worker does not attempt the write — which is exactly why
  // this second test exists: the guarantee is the grant, not the behaviour.
  await expect(workerDb().query('update finding_disposition set state = $1', ['unchecked']))
    .rejects.toThrow(/permission denied/i);
});
```

**Read that pair carefully before deleting anything.** The behavioural test passes with or without the grant, which is precisely the shape of a test that cannot fail. The grant test is the one that bites, and running the mutation on **both** is how you find that out rather than assume it.

- [ ] **Step 2: Delete, and check the two callers**

`carryHumanState` has (today) three call sites: `handleUpdate` inside `handleStartRun`, `failRetryCell`, and `onRetryUpdate`. All three should already be gone after Tasks 18 and 20. Delete the module and its test; delete `import { carryHumanState } …`.

**`findingMerge.test.ts` is deleted, not rewritten.** It tests a merge that no longer exists. What it was *protecting* — a verification surviving an unrelated cell — is now Step 1's test, on the server, over the real database. §11.1's rule about rewriting rather than deleting a promise test does not apply here: that rule is about a **promise to a user**, and this was a test of an internal defence. Say that in the report so the deletion reads as considered.

- [ ] **Step 3: `unchecked()` stays, and stays the only thing the engine writes**

```ts
it('has no writer of a non-unchecked verification in packages/core', () => {
  const core = allFilesUnder('packages/core/src');
  for (const f of core) {
    expect(codeOf(f), `${f} writes a verification state`).not.toMatch(/state:\s*['"](verified|flagged|rejected)['"]/);
  }
  expect(core.length).toBeGreaterThan(15);        // the sanity check
});
```

- [ ] **Step 4: Gates, and read the diff**

`npm run typecheck && npm test && npm run test:pg`. Then **read `git show --stat`** and confirm the deletion is exactly two files plus the import removal. A deletion commit that touches ten files is a deletion commit doing something else.

- [ ] **Step 5: Commit**

```bash
git add src/lib/findingMerge.ts src/lib/findingMerge.test.ts src/App.tsx \
  apps/api/test/humanStateSurvives.pg.test.ts
git commit -m "refactor: carryHumanState retires, because there is no longer a snapshot to merge"
git show --stat HEAD
```

---

## Task 22: `review.findings` is frozen, not dropped; `Verification.assigneeId` retires

**Type:** schema + cleanup. P17's last move and P18.

**Files:**
- Create: `apps/api/migrations/009_freeze_findings.sql`
- Modify: `apps/api/src/routes/reviews.ts` (delete the shadow writer), `apps/api/src/findings/write.ts`
- Delete: `apps/api/src/findings/reconcile.ts`'s route usage (**keep the function** — Task 26 runs it once more)
- Modify: `src/types.ts` / `packages/core/src/domain/types.ts`

**Interfaces:**
- Consumes: Task 14's read flip and Tasks 18–21's writer flip. **Do not start this until `PUT /v1/reviews/:id` has had no `findings` in its body from any shipped client.** Check by reading the browser's `saveReview` body, not by assuming.
- Produces: a `review.findings` column that no application role can write.

- [ ] **Step 1: The freeze**

```sql
-- 009_freeze_findings.sql
-- P18. The column and its data STAY. "Never delete what you cannot read" —
-- CLAUDE.md's own rule, and what the localStorage -> IndexedDB migration did
-- deliberately and disclosed. The rows are authoritative from here; this is
-- the backup, and it is dropped by a later release once the owner confirms
-- the rows are good — the same release that deletes the browser's local
-- IndexedDB database (Stage 2's interface note 13).
revoke update (findings) on review from lexprompt_app;
revoke update (findings) on review from lexprompt_worker;
comment on column review.findings is
  'FROZEN 2026-08-30 (Stage 3, P18). The authoritative findings are the `finding`,
   `finding_disposition` and `note` tables. This column is the pre-migration
   backup and is not written by any application role. Do not read it; do not
   drop it without the owner confirming the rows are good.';
```

- [ ] **Step 2: The route refuses rather than ignores**

`PUT /v1/reviews/:id` with a body carrying a non-empty `findings` answers `400` naming the reason. **Accept-and-ignore is the wrong answer**: a client that believes it saved sixty findings and did not is the exact shape of a quiet wrong answer, and an old browser tab left open across a deploy is how it would happen.

- [ ] **Step 3: Delete the shadow writer**

`writeFindingRows`'s call from the review route goes; the function itself goes with it. `reconcileFindings` **stays** — Task 26 runs it once more, and it is the tool anyone reaches for if a doubt about the migration ever surfaces.

- [ ] **Step 4: `assigneeId` retires (P24, S17)**

Remove it from `Verification` in `packages/core/src/domain/types.ts`, from `applyVerification` (which carries it across today) and from `resetVerification` (which deliberately preserves it). `npm run typecheck` finds every reader. **Task 6's report already named every finding that carried a non-empty value**, and the frozen blob still holds them — so this is a removal with a record, not a discard.

- [ ] **Step 5: Commit**

```bash
npm run test:pg && npm test
git add apps/api/migrations/009_freeze_findings.sql apps/api/src/routes/reviews.ts \
  apps/api/src/findings/write.ts packages/core/src/domain/types.ts src/types.ts \
  apps/api/test/shadowWrite.pg.test.ts
git commit -m "feat(db): the findings blob is frozen and kept, and assigneeId retires with a record"
git show --stat HEAD
```

---

## Task 23: Exports and the tabular grid read rows

**Type:** feature, with a wording rule that must not move

**Files:**
- Modify: `src/features/review/exportDocx.ts`, `src/features/tabular/csv.ts`, `src/features/tabular/TabularReview.tsx`, `src/features/review/ResultsView.tsx`
- Modify: their tests **only where the seam moved**

**Interfaces:**
- Consumes: Task 14's assembled findings map — **the same nested shape these files read today**, so most of them should not change at all. **Read `src/lib/findingOutcome.ts`**: `verificationLabel` and `exportSummaryLine` are the only place export wording lives and both exporters call them. **Where the shipped source disagrees with this brief, the shipped source wins.**

- [ ] **Step 1: Confirm how little changes, and report the number**

If Task 14 assembled the shape faithfully, the card view, the grid, the DOCX exporter and the CSV exporter change **not at all**. Run them and see. **A change here is a finding**: it means the assembled shape is not the shape `types.ts` declares, and that is worth knowing before Stage 4 builds on it.

- [ ] **Step 2: The wording does not move, and no `dispositionLabel` appears yet**

`verificationLabel` and `exportSummaryLine` stay exactly as they are. §6.3 adds `dispositionLabel` / `dispositionHistoryLine` beside them — **in Stage 4, with the surfaces that need them** (P28). A `dispositionLabel` in this stage would be a function with no caller, and the CSV/DOCX drift this module exists to prevent is at its most likely when two label functions sit side by side and only one is used.

**Specifically not built here** (§6.3.1, all Stage 4): the *"Dispositions as at …"* instant, the *"was Rejected"* line, *"changed twice"*, and the sentence saying a disposition can change. §19 calls the export *"the worst-consequence defect the revision introduces"* and the reason those three requirements are Stage 4's is that they are only true once a disposition can be changed by somebody else — which it cannot, in a single-user stage.

- [ ] **Step 3: `findingsKeyFor` is still the only key derivation, on both sides**

`TabularReview.collectionKey.test.tsx` exists because of exactly one of sub-project C's six defects. Run it. If the grid now derives a key from a document id anywhere, that is the seventh.

- [ ] **Step 4: Commit**

```bash
git add src/features/review src/features/tabular
git commit -m "feat(web): the exporters and the grid read findings from the server, wording unchanged"
git show --stat HEAD
```

---

## Task 24: "Reading…" — the parse state on screen

**Type:** feature

**Files:**
- Modify: `src/features/upload/*`, `src/features/matters/MatterHome.tsx`, `src/lib/api/*`
- Modify: `src/lib/privacyCopy.ts` only if a disclosure sentence moved (**it should not** — check, do not assume)

**Interfaces:**
- Consumes: Task 9's `parse_state`. **Where the shipped source disagrees with this brief, the shipped source wins.**

- [ ] **Step 1: Three states, three renderings**

§11: *"A document being read shows 'Reading…', not an empty text panel and not a document that looks ready. That is the third load state again, at ingest."*

- `pending` → "Reading…", with the document listed and **not** offerable as a review target.
- `failed` → the `parse_error`, with a retry, and **not** offerable as a review target.
- `parsed` → as today.

A document in `pending` that is silently offered as a target is the "empty is not broken" rule failing at ingest — and Task 8 Step 3 already refuses it server-side, so the UI is telling the truth rather than being the enforcement.

- [ ] **Step 2: The polling stops**

An upload's `pending` state resolves within seconds. Poll `GET /v1/documents/:id` while any document in view is `pending`, and stop when none is. **Not a permanent poll**: a tab left open on a matter should not talk to the server forever.

- [ ] **Step 3: Commit**

```bash
git add src/features/upload src/features/matters src/lib/api
git commit -m "feat(web): a document being read says so, and cannot be reviewed until it is"
git show --stat HEAD
```

---

## Task 25: The sweeps — workspace scope, import boundary, route policy, configuration surface

**Type:** guard

**Files:**
- Modify: `apps/api/test/workspaceScope.test.ts`, `apps/api/test/importBoundary.test.ts`, `apps/api/test/authz.route.test.ts`, `apps/api/test/configSurface.test.ts`, `apps/api/test/divergence.json`
- Create: `apps/api/test/dispositionWriters.test.ts`

**Interfaces:**
- Consumes: every task above. **Read each scanner before extending it**; three of them are Stage 2's and one is Stage 1's, and each has its own idea of what "a source file" is.

- [ ] **Step 1: `workspaceScope` covers the six new tables**

`finding`, `note`, `finding_disposition`, `finding_disposition_event`, `run`, `run_cell`, `event`. **And prove the scanner finds what it scans:**

```ts
it('finds a query with no workspace predicate', () => {
  // The sanity check that makes the assertion below mean something. A
  // scanner that matched nothing reported zero violations repo-wide for a
  // whole sub-project once (the PdfCanvas exemption).
  expect(violationsIn('select * from finding where review_id = $1')).toHaveLength(1);
});
```

- [ ] **Step 2: One writer of each disposition table, asserted over the source**

```ts
it('has exactly one module writing finding_disposition and one writing its history', () => {
  expect(writersOf(/finding_disposition\b/)).toEqual(['apps/api/src/dispositions/service.ts']);
  expect(writersOf(/finding_disposition_event/)).toEqual(['apps/api/src/dispositions/service.ts']);
  expect(filesScanned()).toBeGreaterThan(30);
});
```

The grant is the real defence; this is the one that tells you *before* a permission error at run time.

- [ ] **Step 3: `configSurface` and `divergence.json`, both directions**

Every new key from the Declared caps table is `sameEverywhere`. §18 item 10(b): a key that differs and is not in §5.1's table fails the build, **and so does a table row with no key behind it**. Both directions, or the table decays into good intentions.

- [ ] **Step 4: The import boundary covers what moved**

Every name Task 2 and Task 3 moved is in the `exported` array, and the guard has been shown to bite by pasting a re-implementation into `src/lib/` and watching it fail.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test
git commit -m "test: the scanners cover the new tables, the new keys and the one disposition writer"
git show --stat HEAD
```

---

## Task 26: Stage 3's definition of done, the rulings, and what Stage 4 inherits

**Type:** verification and documentation

**Files:**
- Create: `apps/api/test/stage3DoD.test.ts`
- Modify: `README.md`, `docs/superpowers/redesign/rulings.md`
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/stage-3-report.md`

- [ ] **Step 1: §18 item 4, searched rather than assumed**

```ts
it('survives a worker restart mid-run', async () => { /* Task 11's compose test, re-run */ });
it('leaves no cell in pending after a cancel', async () => { … });
it('clears a disposition and a net position in one transaction, and records the clearing', async () => { … });
it('gives the run worker no grant on either disposition table', async () => { … });
it('has deleted carryHumanState and findingMerge.ts', () => {
  expect(existsSync('src/lib/findingMerge.ts')).toBe(false);
  expect(grepRepo('carryHumanState')).toEqual([]);
  expect(grepRepo('findingsKeyFor').length).toBeGreaterThan(3);   // the sanity check
});
it('ships no attribution surface (P28, §13)', () => {
  // Stage 4's, not this stage's. A `dispositionLabel` or a "was X" string in
  // the browser here would be half of Stage 4's most important feature.
  expect(grepRepo('dispositionLabel')).toEqual([]);
  expect(grepRepo('dispositions as at', { ignoreCase: true })).toEqual([]);
});
```

- [ ] **Step 2: The reconciliation, one last time, over real data**

Run `reconcileFindings` over every review in the compose database and print the result. It must be empty. **This is the last moment the frozen blob can still answer the question "did the migration lose anything?"** — and it is why P18 keeps it.

- [ ] **Step 3: The README**

Replace what is no longer true and add what a reader now needs: reviews run on the server as jobs; a run survives a restart; a cancelled run is distinguishable from a failed one; documents are parsed server-side and a document being read says so; `review.findings` is a frozen backup column that a later release drops; **run starts and cancellations are recorded on the `run` row and not yet in an append-only audit log** (P23), so an audit export covering this period says where its run history came from.

- [ ] **Step 4: The rulings**

Into `rulings.md`, in its established format, in a section for this stage: **P17–P28 as executed**, with any that changed recorded as amended-with-a-dated-note rather than edited away; **every ruling an implementer took mid-task**, with its cost; and the spec/shipped disagreements below.

- [ ] **Step 5: The spec-versus-shipped disagreements, recorded rather than smoothed**

1. **§5's `packages/core` inventory does not exist**, and §9 tells the worker to run extractors from it. Resolved by P20: the review closure moves here, the rest is named for a later stage. **A genuine gap between the spec and the repository, not a misreading.**
2. **`extractClause` imports its model client**, so §9's *"a model client that points at the gateway"* was not expressible without a signature change. Resolved by P21.
3. **§6.2 and §6.5 give the same cell two state machines** (`finding.status`, `run_cell.state`) and do not say which governs. Ruled in Task 8 Step 2, with an invariant test.
4. **§6.3 states the attribution requirements in the present tense; §13 puts those surfaces in Stage 4.** Ruled by P28 in favour of §13. A reader of §6.3 alone would build them here.
5. **§6.5's `run.provider`/`model`/`jurisdiction` cannot be non-null at creation** — a queued run has called nothing. Nullable, filled from the gateway's own answer.
6. **`Note.findingId` is `findingKey(documentId, clauseId)`**, a `::`-joined string that does not match `(review_id, findings_key, clause_id)`. Re-keyed by position, checked by parsing, refused on disagreement (Task 6).
7. **`Verification.assigneeId` has no home in the new schema.** Dropped, with every non-empty value named in the migration report (P24).
8. **§14's `runLifecycle` suite and §18 item 4 overlap but are not the same list.** Both are covered; the mapping is in the self-review table below.

- [ ] **Step 6: What only a human at a browser can confirm — the list, not an apology**

Browser automation has been unavailable for this whole project (the Chrome extension disconnects; the Playwright MCP times out). These are the checks that need a person, and they are named rather than implied:

1. A run started, then the tab reloaded mid-run — the results view picks it up and finishes.
2. The progressive fill at a one-second poll: does it still read as live? (Task 18 Step 2.)
3. A scanned PDF uploaded, showing "Reading…", then reviewable, with citations landing on the right pages.
4. A verification made **while a run is still going**, and still there when the run finishes. This is the human-visible form of Task 21's proof.
5. A retry on a verified clause: the notice appears, the verification clears, the answer is replaced.
6. A cancel mid-run: the cells stop, nothing spins forever, completed work is still there.
7. A collection review's retry: the answer is still a synthesis across every member.

**If they cannot be done, say so plainly rather than implying they were** — `CLAUDE.md`'s rule, and it applies to this report as much as to any other.

- [ ] **Step 7: Commit**

```bash
git add apps/api/test/stage3DoD.test.ts README.md docs/superpowers/redesign/rulings.md \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/stage-3-report.md
git commit -m "test: Stage 3's definition of done, and the rulings it took"
git show --stat HEAD
```
---

## Interfaces Stage 4 and later must honour

Recorded here so a later stage extends rather than duplicates. Each is a thing this stage built that a later one will be tempted to build again.

1. **`finding_disposition.version` is the SAME number Stage 4's realtime events carry and the same number a stale change is refused on.** §8: *"the stale-change refusal and the realtime version guard are the same number doing two jobs, and they must not be allowed to become two numbers."* Stage 4's `finding.disposition_changed` payload carries this column; it does not introduce a second.
2. **The `409` already returns the current row**, and the disposition route already returns the row **and the event that produced it**. Stage 4's *"Priya changed this to Rejected at 14:22, after you loaded it"* needs no second round trip and no new mechanism — it needs the actor and the time on screen, which is the surface.
3. **The event vocabulary is `packages/core/src/api/records.ts`'s, and there are five types** (P22). Stage 4 replaces the transport in `src/lib/api/runs.ts`'s `watchRun` and adds `finding.disposition_changed`, `note.added` and presence. It does not redefine the five.
4. **`resync_required` already exists over HTTP** (Task 12 Step 3) and its retention is `API_EVENT_RETENTION_DAYS`. Stage 4 adds the **UI** §8 requires — *"Reconnecting — refreshing this review"* — and the stale indicator, which §3 calls *"the one most likely to be skipped, because the app looks fine without it."*
5. **The attribution and export surfaces are Stage 4's, and they are one feature with the mutability** (§13, P28): the actor and time on every disposition, *"was Rejected"*, *"changed twice"*, the reachable history (the `GET …/history` route exists and is untested by any UI), the export's *"Dispositions as at …"* instant, and the sentence saying a disposition can change. `dispositionLabel` and `dispositionHistoryLine` go **beside** `verificationLabel` and `exportSummaryLine` in `findingOutcome.ts`, never in a second module.
6. **`audit_event` still does not exist** (P23). When it lands: `GRANT INSERT, SELECT` only, partitioned monthly, and **it does not restate a disposition change** — `finding_disposition_event` is that change's one record (S22), and the feed reads both plus the `run` table in one `UNION`. The gateway's stdout call log and `audit_event` are two different logs and must stay two; the gateway must not gain a database credential.
7. **The `assignment` table is Stage 4's** and `Verification.assigneeId` is already gone (P24, Task 22). An assignment needs an assigner, a message and a resolution; do not resurrect the field.
8. **`ROUTE_POLICY` has no default and a route with no entry fails registration.** Every Stage 4–5 route adds a line. Do not add a fallback.
9. **The worker role has no grant on either disposition table, and no `select` either.** If Stage 4 finds a legitimate reason for the worker to read one, that is an amendment to this plan's ruling with its own reasoning, not a `grant`.
10. **`review.findings` is frozen, not dropped** (P18). The release that drops it is the release that deletes the browser's local IndexedDB database, **after the owner confirms**, and that release also removes `fake-indexeddb` and the `node:buffer` Blob workaround (§14, Stage 2's interface note 13).
11. **`reconcileFindings` survives Task 22 deliberately.** It is the tool for any future doubt about the migration, and it works for exactly as long as the frozen column exists.
12. **The worker is in-process, behind an interface, leased** (P27). Moving it to its own container touches the process that starts the pool and nothing else. Spike 3's answer about Redis does not change that.
13. **`packages/core` holds the review closure and not yet §5's full inventory** (P20). `matterActivity`, `matterStats`, `docxRedlines`, `docxMarkup`, `pdfRedlineDiff`, `inferPositions`, `buildChangeset`, `strength`, `standardPositions`, `positionHealth`, `positionHealthMap`, `chains`, `matterStats`, `playbookScan`, `playbookDefaults` and the prompt builders are still in `src/lib`. Moving them is a later stage's mechanical task, and the S14 boundary already covers everything that has moved.
14. **Two hydration modes, server-side, and the founding defect's guard is Task 9 Step 5's test.** Anything that will be handed to an extractor hydrates **for review**. It has reopened twice.
15. **Every migration file is immutable once applied.** Add `010_…`; never edit `005_…`.
16. **The declared caps table is part of the plan and `caps.test.ts` enforces it.** A new tier gets a row and a reader in the same commit.
17. **Spike 2's Azure half and §18 item 10(c) are still unproven**, unchanged by this stage. Spike 1 is answered by Task 1, either way.

---

## What Stage 3 deliberately leaves to Stages 4 and 5

Named, not omitted.

**Stage 4 (realtime and collaboration):** WebSocket transport and presence; one person changing another's disposition; the stale-version refusal's *message* (the refusal itself is here); the fourth load state; `audit_event` and the activity feed; the `assignment` table and assignment reaching a person; **every attribution and history surface**, including the card's actor and time, *"was Rejected"*, *"changed N times"*, the history panel, and the export's *"Dispositions as at …"* framing and its sentence that a disposition can change (§6.3.1); `dispositionLabel` / `dispositionHistoryLine`; the two-account browser verification §14 requires.

**Stage 5 (the superseded surfaces):** assignee chips, "assigned to me", actors in the feed, firm-wide search, the admin screens for `role_mapping` and providers. R-G1 binds until each mechanism is real.

**Neither, and still open:** §17 Q3 (retention, including precedent retention) — an owner decision; §17 Q4 (which providers, and the declared jurisdiction set) — an owner decision; §17 Q6 (GDPR erasure versus the disposition history, now larger because the history is permanent by grant) — a DPO question this stage makes concrete for the first time and which should be raised now that the table exists; §17 Q12 (does an export state where the review was processed — the `run` row can now answer it); §17 Q13 (production hosting off Azure); Spike 2's Azure half; §18 item 10(c).

---

## Self-review

### 1. Spec coverage

Every Stage 3 requirement, with the task that implements it.

| Requirement | Source | Task |
|---|---|---|
| Runs become queued jobs; the response is the run, not the results | §9, §13 | 8 |
| Cells are document × clause, or clause alone for a collection | §9 | 8 |
| Workers lease with `FOR UPDATE SKIP LOCKED` and execute the core extractors | §9 | 10 |
| Each completed cell writes its finding and one event, in one transaction | §9 | 10, 12 |
| Concurrency bounded per run **and** per workspace | §9, §6.6, S16 | 8, 10 (P26) |
| `workspace_setting.concurrency` becomes a real per-run bound | §6.6 | 8 (snapshot), 10 (enforcement) |
| Cancel: every cell not `done` becomes `cancelled`, never left `pending` | §9, §18.4 | 11 |
| Resume: an expired lease is re-leased; `attempts` bounded at 3 | §9 | 10, 11 |
| A stale heartbeat marks the run `failed` and says so | §9 | 11 |
| A cancelled run is distinguishable from a failed one | §9, rule 4 | 11, 17 |
| The cell events **are** the stream | §9 | 12 |
| Findings become rows keyed `(review_id, findings_key, clause_id)` | §6.2, S3 | 4, 6, 7, 14 |
| `findingsKeyFor` is the only key derivation, in `packages/core` | §6.2 | 2, 8, 14, 23, 25 |
| `NULL` versus empty preserved (`truncated_documents`, `net_position`, `position_outcome`) | §6.2 | 4, 6, 14 |
| The jsonb→rows migration, reporting what it moved and what it could not | §13, `CLAUDE.md` | 6 (P19) |
| First `finding_disposition_event` seeded from `Verification.byUserId`/`at` | §6.4 | 6 |
| `finding_disposition` — one current disposition, mutable, versioned | §6.3, S4 | 5 |
| `finding_disposition_event` — append-only, insert-only by grant | §6.3, S11 | 5 |
| Both written in one transaction, always | §6.3 | 5 |
| The cache reconciles with its history | §6.3, §19 | 5 |
| `cause = 'rerun_reset'` implies `to_state = 'unchecked'`, by check constraint | §3, S21 | 5 |
| A rejection needs a reason; a never-touched disposition names nobody | §6.3 | 5 |
| A stale disposition change is refused with `409` and the current row | §6.3, §8 | 15 |
| The re-run reset is one transaction in the retry handler, attributed | §9.1, S21 | 16 |
| Re-running clears the net position too | §9.1, `CLAUDE.md` | 16 |
| Notes survive a re-run and a disposition change | §6.3 | 15, 16 |
| Notes become their own table | §6.3 (R-B3's migration) | 4, 6 (P24) |
| `Verification.assigneeId` retired | S17 | 22 (P24) |
| `carryHumanState` and `findingMerge.ts` deleted | §9.1, S5, §18.4 | 21 |
| The worker's role cannot write either disposition table | §3, §9.1, §14, §18.4 | 4, 5, 21, 26 |
| Parsing moves server-side; `parse_state` is a real state | §11, S19 | 9 |
| `parse_state` rendered as "Reading…" | §11 | 24 |
| Scan detection stays per page | §11, `CLAUDE.md` | 9 |
| Page images regenerated per run, held in an LRU, never persisted | §6.5, §11, S12 | 1, 9 |
| Extraction takes review-hydrated documents | §11, `CLAUDE.md` | 9, 10 |
| Server-side rendering proven or its fallback named | §15 Spike 1, §19 | 1 |
| `run.provider`/`model`/`jurisdiction` snapshotted from the gateway's answer | §6.5, S26 | 8, 10 |
| The gateway call log still names the person who asked | §10, §12 Q5 | 3, 10 |
| `extractClause`/`extractCollectionClause` in `packages/core` | §5, §9 | 2, 3 (P20, P21) |
| The import boundary covers what moved | S14 | 2, 25 |
| `workspace_id` on every new table, every query scoped | §6, S9 | 4, 5, 8, 25 |
| A route with no policy entry fails the build | §7, §14 | 8, 15, 16, 25 |
| Three load states, none rendering as another; the fourth is Stage 4's | §3 | 17, 24 |
| `await-then-apply`, no optimistic update | §3, S8 | 19 |
| Behaviour stays single-user; no attribution surface | §3.1, §13, S18 | Global; 23, 26 assert it |
| `api` still may not egress | §5 | 13 (re-checked) |
| Every declared cap has a reader | `CLAUDE.md` lesson, §14 | 10 |
| Mutation tests on everything load-bearing | §14 | 4, 5, 6, 7, 9, 11, 16, 21, 25 |
| `tsc` clean, tests pass, build clean | §18.1 | Global; every task's gate |

**Requirements I could not assign to a task, and why:**

- **`audit_event` and its grants (§6.5, S11).** §13 puts the feed that reads it in Stage 4, and Stage 2 deferred the table on the grounds that a log with no reader makes its own grant test vacuous. Stage 3 produces the first acts that belong in it and still does not build it (P23) — but it also builds no substitute, and the cost (run starts and cancels are on the `run` row, not in the append-only log) is written into the README and `rulings.md` rather than left for an auditor. **Stage 4.**
- **The `assignment` table (§6.3) and everything assignment reaches.** Stage 4. Its absence is why `assigneeId` could be dropped rather than migrated.
- **§6.3.1's three export requirements.** Stage 4, with the mutability they describe. Building them here would put an "as at" stamp on a document whose dispositions nobody else can change.
- **§8's WebSocket, presence and the `stale` load state.** Stage 4. Task 17's poll is deliberately shaped so the transport is the only thing that changes.
- **§5's remaining `packages/core` inventory.** P20 moves the review closure and names the rest. A later mechanical stage.
- **§17 Q3, Q4, Q6, Q12, Q13.** Owner and DPO decisions. Q6 is the one this stage makes concrete — the history is permanent by grant from Task 5 onward — and Task 26's report raises it.
- **Spike 2's Azure half and §18 item 10(c).** Unchanged by this stage, unproven, named in Task 26's report exactly as Stage 2 named them.

### 2. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `fill in`, `appropriate error handling`, `similar to Task`, `and so on`, `etc.` in step bodies, and for test steps with no test. Found and fixed inline. What remains, and why each is a **deliberate delegation** rather than a placeholder:

- **Task 4's migration shows two tables in full and Task 6's shred shows one census insert of four.** Transcribing four near-identical `insert … select` statements would add lines a reader skims and an implementer copies wrong; the pattern plus the shape in `types.ts` is more reliable than a transcription of it. Task 6 Step 1 says explicitly *"Write all four; do not write one and describe the others."*
- **Task 3's `workerModelClient` is a sketch and is labelled one**, with the two shipped files it must be reconciled against named. Writing it out fully would be inventing a signature for `ModelClient` I have read but which may have moved, which is the exact failure mode Stage 1 and 2 both suffered.
- **Task 10's lease SQL is given in full and flagged as the thing most likely to be wrong** (`for update of c` with correlated subqueries). It is written out rather than described because the *shape* is the design, and it is flagged rather than trusted because Postgres is the authority on whether it parses.
- **Task 9 Step 2 asks the implementer to decide** whether to extract a shared parse algorithm or keep two, and to say which. That is a genuine judgement that depends on what the two functions actually look like when read side by side, and pre-deciding it from a distance would be pre-deciding it wrongly.

### 3. Type and name consistency

Checked across all 26 tasks:

- **`findingsKeyFor(target, documentId?)`** — moved to `packages/core/src/domain/reviewTarget.ts` in Task 2, used in Tasks 8, 10, 14, 16, 23, 25. Never re-derived; never a bare string concatenation.
- **`FindingKey`** — `{ reviewId, findingsKey, clauseId }`, the tuple every route, service and test names. Declared in `apps/api/src/findings/rows.ts` (Task 4). **Not** `findingKey(documentId, clauseId)`, which is the browser's `::`-joined **note** key from `verification.ts` and stays exactly that. Two different things, named apart, because a note's stored `findingId` uses the second and the tables use the first — Task 6 Step 2 is where that difference bites.
- **`toFindingRow` / `fromFindingRow`** — Task 4, used by 6, 7, 10, 14. One mapping.
- **`setDisposition(t, key, change, cause, actor, expectedVersion)`** — six parameters, in that order, Task 5; called from Tasks 7, 15, 16 and nowhere else, asserted by Task 25.
- **`writeFindingRows(t, review, actor)` / `reconcileFindings(t, reviewId)`** — Task 7. The first is deleted in Task 22; the second survives.
- **`Run` / `RunCell` / `RunEvent`** — `RunEvent` and its five payload types in `packages/core/src/api/records.ts` (Task 12), shared by browser and server. `Run` and `RunCell` row types in `apps/api/src/db/rows.ts`'s style.
- **`run.state`** = `queued|running|cancelling|cancelled|succeeded|failed`; **`run_cell.state`** = `queued|leased|done|error|cancelled`; **`finding.status`** = `pending|running|done|error|cancelled`. Three vocabularies, three purposes, ruled in Task 8 Step 2 and pinned by Task 11 Step 6's invariant.
- **`extractClause(client, doc, clause, template, settings, signal?, context?)`** — client **first**, `signal` fifth, Task 3, and the reason is `App.verification.test.tsx`'s positional mock.
- **`workerModelClient(gateway, workspaceId, actor)`** — Task 3, used in Task 10.
- **`startWorkerPool(deps)` / `startReaper(deps)`** — Tasks 10 and 11, started in `main.ts`.
- **`appendEvent(t, e)`** — Task 8/12, the only writer of `event`, in the caller's transaction.
- **`parseDocument(bytes, mime, name)` / `renderPageImages(bytes, opts)` / `documentFileForReview` / `documentFileForViewing`** — Tasks 1 and 9. The last two keep the browser's names deliberately: they are the same distinction, and giving the server's copies different names is how the founding defect would reopen a third time.
- **`startRun` / `getRun` / `cancelRun` / `retryCell` / `watchRun`** — Task 17. Note `retryCell` **shadows the name of the browser engine function it replaces**; that is intentional and the old one is deleted in Task 18, so the two never coexist. If they would, rename the new one.
- **Decision labels** — this plan's are **P17–P28**, continuing P1–P5 (Stage 1) and P6–P16 (Stage 2). `rulings.md`'s owner decisions are **D1–D5**; its execution rulings are lettered. No label here collides.
- **Migration file names** — `005_findings`, `006_dispositions`, `007_findings_backfill`, `008_runs`, `009_freeze_findings`. Applied in filename order; immutable once applied.
- **New config keys** — the eleven in the Declared caps table, all `sameEverywhere`, all in `apps/api/src/config.ts` and nowhere else.

### 4. What I would check first if this plan turns out to be wrong

In order of how likely the failure is and how quiet it would be:

1. **Task 6's refusal being softened into a default.** Someone hits the orphan-attribution refusal on real data at deploy time, under pressure, and reaches for `coalesce(byUserId, :operator)`. The mutation test in Task 6 Step 6 is the guard; **run it, do not assume it.** This is the single change that would put a deploy operator's name on a lawyer's judgement, and nothing on any screen would look wrong.
2. **The reconciliation comparing counts rather than keys.** It is the natural simplification and it passes on swapped keys. Task 6 Step 6 and Task 7 Step 4 both mutate it.
3. **`carryHumanState` deleted one task early.** Task 21's Interfaces block says to check by grep, and Task 13's DoD test asserts it is still present at the end of Part 3A. If a run is still orchestrated anywhere in the browser when it goes, a verification made mid-run is lost silently.
4. **Task 10's lease SQL not doing what it reads like.** Correlated subqueries inside `for update of c` are the part most likely to be refused or mis-scoped by Postgres, and the failure mode is a bound that never binds — which looks exactly like a fast queue. Task 11 Step 2's mutation is what proves the re-lease path exists at all.
5. **The worker handed a view-hydrated document.** Task 9 Step 5's mutation test is the only guard between this stage and the founding defect, and this is the third time the same mistake would be available.
6. **A `finding` read that quietly invents `verification: unchecked()`.** `fromFindingRow` must not produce a verification at all (Task 4 Step 2); if it does, an unverified finding and a verified one whose disposition row failed to load become the same thing on screen.
7. **A query over the new tables with no `workspace_id` predicate.** It fails by showing too much and nothing on screen looks wrong. Task 25's scanner is the guard; check that it finds what it scans.
