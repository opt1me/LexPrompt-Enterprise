# LexPrompt Server — Stage 2: storage and auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every record and every document byte out of one browser's IndexedDB and into the firm's Postgres and Blob Storage, behind the nine repositories' existing function signatures; make sign-in a real gate whose roles are mapped from the issuer's group claim and **refused by the API**; store precedent documents server-side and replace the on-screen sentence that says they are not stored, in the same change; ship a one-time uploader that moves the owner's browser data and reports by name anything it could not; and retire browser-local mode at the end.

**Architecture:** `apps/api` gains a Postgres pool, a SQL migration runner and a Blob Storage client, and grows one HTTP route group per repository concern. `src/lib/db/*.ts` keeps every exported name and signature it has today and swaps its bodies from `idb` calls to `fetch` calls against those routes — **that substitution is the deliverable**, because the repositories were made Promise-returning in sub-project A precisely so a storage swap would not touch a caller (R3). Identity becomes an `app_user` row keyed `(issuer, subject)`, provisioned just-in-time on first successful sign-in; `role_mapping (issuer, group_value, role)` turns a group claim into one of three roles, seeded per issuer and exercised against **both** issuers from the day the table exists. Nothing collaborative ships: one person, one browser, one workspace, with a real server underneath.

**Tech Stack:** Everything Stage 1 shipped, plus `pg` 8 (node-postgres — no ORM, no query builder, plain SQL files applied by a small runner), `@azure/storage-blob` 12 with Azurite locally and Azure Blob Storage in the tenant (never MinIO, never "S3-compatible" — S30), Postgres 16 in compose and Azure Database for PostgreSQL Flexible Server in the tenant. TypeScript 5.8, Vitest 3.2 (`test.projects`: `web` jsdom, `core`/`gateway`/`api` node), Node 22 in containers, Fastify 5, undici, `jose`, `oidc-client-ts`, Keycloak, Docker Compose, `azd` + Bicep. **No ORM and no migration framework are added**: a migration tool is a dependency whose failure mode is a schema this project cannot read, and the whole of what is needed here is "apply these `.sql` files once, in order, under a lock".

**Spec:** `docs/superpowers/specs/2026-08-28-lexprompt-server-design.md` (binding authority). Stage 2's boundary is §13; the definition of done is §18 item 3; the data model is §6 (§6.1 the nine stores as tables, §6.4 what already carries identity, §6.5 what is new, §6.6 settings); auth and roles are §7; precedent storage is §11.1; the uploader is §13.1; the local/deployed equivalence is §5.1; the Risk story is §12; rulings **S9**, **S10 (amended)**, **S11**, **S12**, **S13**, **S14**, **S16**, **S17**, **S19 (amended)**, **S23**, **S24**, **S28**, **S29**, **S30**, **S31**, and the testing bar in §14.

**Preceding plan:** `docs/superpowers/plans/2026-08-28-lexprompt-server-stage-1-gateway.md`, and its execution ledger `.superpowers/sdd/2026-08-28-lexprompt-server-stage-1-gateway/progress.md`. Read the ledger's **Rulings** and **Final whole-branch review** sections before Task 1. This plan continues that plan's decision numbering: Stage 1's own decisions are **P1–P5**; this plan's are **P6–P16**. `rulings.md`'s **D1–D5** remain the *owner's* decisions. A `D<n>` anywhere in this document is a reference to `rulings.md`; a `P<n>` is a reference to a plan.

---

## Scope check, before anything else: this is two stages, and here is the split

§20 estimates Stage 2 at **2.5–3 sub-project equivalents**, the largest in the design. §13 says a stage larger than its estimate is **decomposed further rather than compressed**, and §19 says the same thing from the other side. Stage 1 came out at ~1.25–1.5 units and took **26 tasks and 9,835 lines of plan**, plus three fix rounds and a four-reviewer final pass. A faithful Stage 2 at the same density is roughly twice that.

**So it is planned as two execution cycles with a review gate between them, in one document.** Not two documents: the second cycle's tasks consume the first cycle's routes and types, and a second document would reproduce Stage 1's most expensive failure — a brief naming an interface that had moved (thirteen of twenty-six briefs). One document, two parts, and **Part 2B does not begin until Part 2A's definition of done is met and verified on a running stack.**

| | Part 2A — *the firm's database holds the work* | Part 2B — *precedent storage, the uploader, and the retirement* |
|---|---|---|
| Tasks | 1–18 | 19–27 |
| Ships | Postgres + Blob behind the nine repositories; `app_user`; roles refused by the API; workspace settings | precedent storage and its copy change; `position_basis`; the one-time uploader; browser-local mode retired; the sweep |
| Its own DoD | §18 item 3, first four clauses: role refusal verified against both issuers, every record type round-trips through Postgres, bytes round-trip through Blob, deleting a matter purges its blobs | §18 item 3, remaining clauses: the uploader moves the owner's data and names what it could not; a precedent is stored, is not offerable as a review target or collection member, and no screen says it is not stored |
| Shippable alone? | **Yes, and it must be.** At the end of 2A the app works end to end against the server for a signed-in user with a role. The browser's IndexedDB is still readable and is still the source of the owner's existing data, which is exactly why the uploader has not run yet. | Yes. It closes the migration and turns the local store off. |

**The one thing the split may not do**, and it is a ruling in the spec rather than a preference (S24, §11.1): **precedent storage and the sentence that says precedents are not stored cannot be separated.** They are Task 19, one task, one commit. There is no arrangement of these tasks in which `document.kind = 'precedent'` is writable while `PrecedentIntake.tsx` still reads *"Read once to learn from. Never stored."* If Task 19 has to be split for size, it splits **after** the copy is true — `position_basis` (Task 20) is the tail that may follow, because storing a precedent's basis does not change what the screen promises.

**What this costs if the split is wrong:** one review gate's worth of ceremony between Task 18 and Task 19. What the alternative costs is on the record: Stage 1's plan was written as one 26-task run, nineteen of its twenty-three dispatched briefs contained real bugs in their reference code, and three of its worst defects were only findable by running the stack. A longer single run makes both numbers worse, not better.

---

## What Stage 1 shipped that this plan builds on

Read the shipped source before writing code against any of it. **Where the shipped source disagrees with this brief, the shipped source wins** — that sentence appears in every task's Interfaces block for a reason, and the reason is thirteen Stage 1 briefs that named a signature which had moved.

| Shipped in Stage 1 | Where | What Stage 2 does with it |
|---|---|---|
| `apps/api` — Fastify, `requireUser` preHandler, `registerErrorEnvelope`, `/healthz` excluded by URL | `apps/api/src/server.ts` | Adds route groups inside `buildServer`; `requireUser` gains a role resolution step behind it (Task 4), never a second hook chain |
| OIDC validation against a **configured** issuer, `Principal { issuer, subject, groups, name?, email? }`, group-overage detection, `readGroups` refusing an unreadable claim shape | `apps/api/src/oidc.ts` | `Principal.groups` is read for the first time — nothing read it in Stage 1 (`readGroups`'s own comment says so) |
| `AuthConfig { issuer, discoveryUrl, audience, subjectClaim, groupsClaim, requiredClaims }` | `apps/api/src/oidc.ts` | Unchanged. No new auth configuration key is added |
| `ApiConfig` and the one `process.env` reader per app | `apps/api/src/config.ts` | Gains database and blob keys **in that file only** |
| `assertIssuerUsable` — the S29 startup refusal, including `plaintextPermitted`'s documented widening | `apps/api/src/oidc.ts` | Unchanged, and its residual risk (a single-label host like `http://sso` in a firm network) stays an open question for the owner (ledger ruling E2) |
| `ModelError(message, code, status, callId)` + `SERVICE_CONFIG_HINT`, both in `packages/core` | `packages/core/src/model/protocol.ts` | The error vocabulary for **every** new route. New codes are added to the closed set there, never invented at a route |
| The browser's error classification — `isSignInError`, `isServiceConfigError`, `authFailure.ts` | `src/lib/model/…`, `src/lib/authFailure.ts` | The repository transport raises the same `ModelError`s so one classifier serves both |
| `getAccessToken()` — the one token source in the browser | `src/lib/auth/oidc.ts` | The repository transport's only credential |
| `config` — the web app's one `import.meta.env` reader, `apiBaseUrl` | `src/lib/config.ts` | The repository transport's base URL. **No new `VITE_*` key** |
| `configSurface.test.ts` + `divergence.json` + `sourceScan.ts` (`walk`, `codeOf`, `rel`, `ENV_NAME`) | `apps/api/test/` | Extended with §5.1 rows **4** (Postgres) and **5** (Azurite), both directions |
| The compose stack: `frontend` / `internal` / `egress`, `api` on `internal` alone with no published port | `docker-compose.yml` | `postgres` and `azurite` join `internal` **only** — they must not be reachable from the host, and they must not have a route out |
| The seeded Keycloak realm: groups `reviewers`, `partners`, `admins` (`full.path: false`, so the claim carries bare names), users `trainee` / `partner` / `admin` / `nogroups` | `infra/keycloak/lexprompt-realm.json` | Their groups acquire roles here. **No realm edit is needed** and none should be made — Stage 1's interface note 15 seeded all four deliberately |
| `npm run typecheck` — discovery over `packages/*` and `apps/*`, reporting every failing project | `scripts/typecheck.mjs` | The gate. Bare `tsc --noEmit` is **not** the gate |

---

## Stage 1's lessons, encoded here rather than rediscovered

These are not background. Each one changed something in the tasks below, and the change is named.

**1. Nineteen of twenty-three dispatched briefs contained real bugs in their reference code.** Several were type errors only `npm run typecheck` catches (a spread of a `never`-typed value; a self-referential indexed-access type on a private field; `return reply;` from a `Promise<void>`); one imported `Principal` from a nonexistent `../entra.ts`, twice; one wrote a test against MSAL's error vocabulary (`InteractionRequiredAuthError`) for a library that does not export it. **Every code block below will be run by an implementer who has been told to distrust it.** Where this plan quotes a shipped signature it has been read from the file, not remembered; where it invents one, the task's Step 1 writes the test that pins it before Step 3 writes the implementation. If a block does not compile, the shipped source wins and the implementer says so in their report.

**2. Interfaces drift between when a brief is written and when it runs.** Every task's **Interfaces** block carries the sentence *"read the shipped source; where it disagrees with this brief, the shipped source wins."* It is not boilerplate — it is the instruction that saved Tasks 17 and 18 when `Principal`'s import path in the brief did not exist.

**3. A test that cannot fail is worse than no test.** Stage 1 shipped a scanner that matched nothing, a mock supplying what production never did (`AdapterRequest.purpose`, absent in production, hand-built in the test), two `not.toContain` assertions passing vacuously, and an egress test whose timeout made it unpassable in both directions. So: **every guard in this plan comes with the mutation that proves it bites**, named by test title, and **every scanner comes with a sanity check that it finds something** before it is used to assert an absence. A `not.toContain` gets a companion positive assertion in the same test.

**4. The gate is `npm run typecheck`, and no gate is read through a pipe.** `npx vitest run` can report every test PASSED and still exit 1 on an unhandled rejection — that is how a stream's missing `'error'` listener survived a task review, and how a `setState`-after-unmount survived to the final round. Redirect to a file, capture `$?`, then read the file.

**5. Plan tasks that run things.** Three of Stage 1's worst defects were invisible to 2,257 passing tests: `api` had full internet access while `docker-compose.yml` read as correct; a Keycloak realm import silently replaced the built-in client scopes, so every token carried no `sub`; nginx's 1 MiB default silently capped this app's core workflow with an HTML 413. Tasks 1, 10, 11, 19, 22, 23 and 27 each carry a **run it** step against the live compose stack, and each says what the run proves that a unit test cannot.

**6. Fail loudly rather than answer quietly wrong** is the review standard for every task. In a stage that moves a lawyer's matters from a disk they can see to a database they cannot, the specific shapes to watch are: a load path that renders empty when it means broken; a migration that reports success over a gap; a query that forgets its `workspace_id` or its `kind` predicate and fails by showing *too much*; and an attribution rewritten without saying so.

---

## Global Constraints

Copied verbatim from the spec, from `CLAUDE.md`, and from Stage 1's still-binding constraints. Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** Prefer a loud, specific, recoverable failure over anything that could be mistaken for a successful empty result.
- **A load path must distinguish `not yet known` (in flight), `broken` (failed) and `empty` (succeeded and returned nothing).** Every one renders differently and none may render as any of the others. `describeLoadError` / `LoadErrorPanel` carry forward and are extended, never replaced. **The fourth state, `stale`, arrives with realtime in Stage 4 and is not built here.** (§3)
- **`await-then-apply` survives verbatim.** No optimistic update for any human-authored state — not for a verification, a note, a net-position confirmation, or a profile edit. The UI renders from the response the store returned and from nothing else. (§3, S8)
- **Verification state is set only by a human action; nothing derives it.** Stage 2 adds no writer of verification state and must not add one. `finding_disposition` and its history are **Stage 3** and are not created here.
- **`workspace_id uuid not null` on every table, and every query is scoped by it.** One workspace row is seeded at deploy. A query with no workspace predicate is a defect, and Task 27 scans for it. (§6, S9)
- **Every check happens in the API.** The web app hides what a role cannot do, because a dead button is bad design; the API refuses it, because a hidden button is not a security control. The authorisation suite is table-driven over the route list, so **a new route with no entry fails the build** rather than shipping open. (§7)
- **Identity is `(issuer, subject)`, never the email.** `app_user.id` is added **alongside** the pair, never in place of it, so records the gateway wrote in Stage 1 — which carry `actorIssuer`/`actorSubject` and no user id — stay joinable. (§6.5, §7, and the spec's note at line 679: *"`AuditStart` should then gain `actorUserId` **alongside** `actorIssuer`/`actorSubject` rather than replacing them"*)
- **Three roles — `reviewer`, `partner`, `admin` — mapped from the issuer's group claim through `role_mapping (issuer, group_value, role)`.** The value is a Keycloak group name locally and an Entra security-group object id in a tenant; the code reads a string from the configured `groupsClaim` and looks it up, and **does not know the difference**. There is no Entra branch anywhere in the codebase. (§7, S10 amended, S28)
- **The role table is exercised against both issuers from the day it exists.** It is the one behaviour whose *input shape* differs between Entra and Keycloak, so a test that only ever sees Keycloak's bare group names is a test about one issuer. (§13, §18 item 3)
- **A user in no mapped group has no access at all and is told so plainly** — not shown an empty app, which would be "empty is not broken" failing at the front door. **A missing group claim is not an empty one**: Entra's group overage is already detected by `oidc.ts` as its own `group_overage` error and must not be folded into the no-role message. (§7)
- **There is no development bypass and no configuration that disables authentication** — no `SKIP_AUTH`, no anonymous local mode, no trusted header, and no role override. The absence is mutation-tested. (§7, S29)
- **Behaviour stays single-user.** R-G1 continues to bind until Stage 4: no assignee chip, no assign action, no "assigned to me" counter, no second person's name anywhere, no presence, no realtime. Signing in exists to authenticate and authorise a caller, not to introduce colleagues. (§3.1, S18)
- **The nine repositories keep their exported names, parameters and return types.** If a caller has to change, that is a **finding** — written into the task's report and into `rulings.md` — not a silent widening. (§13, R3)
- **Document bytes live in Blob Storage**, one blob per document, keyed `workspace/{workspace_id}/document/{document_id}`, private container, no public access. `document.blob_key`, `byte_size`, `mime` and `content_sha256` live in Postgres. **No bytes in Postgres.** (§6.5, S12)
- **Deleting a matter deletes its documents' rows *and* their blobs, in that order**, with a reconciliation path for orphaned blobs — because the cascade is a promise the README makes and a half-done cascade is the failure that promise exists to prevent. (§6.5)
- **Page images are still never persisted** — not in Postgres, not in Blob Storage, not anywhere. (§6.5, S12)
- **A published `playbook_version` is immutable, enforced by `REVOKE UPDATE, DELETE` from the app role, not by convention.** (§6.1)
- **`document.kind` is `matter` or `precedent`, `NOT NULL`, with a check constraint that a `precedent` row has a `precedent_set_id` and a `NULL` `matter_id`, and a `matter` row the reverse.** Every review-target, collection-member and matter-document query filters `kind = 'matter'`, and the API refuses a precedent as a review target or a collection member — refused, not merely absent from a picker. (§11.1, S23)
- **The on-screen non-storage promise changes in the same stage and the same change as the storage; its replacement lives in `src/lib/privacyCopy.ts`; and the tests asserting the old promise are rewritten, never deleted.** (§11.1, S24)
- **The uploader reports exactly what it moved and what it could not, by name. A partial migration says so and never reports success over a gap. It never deletes the local copy.** (§13.1, S13)
- **Local dependencies are faithful emulators, not near-equivalents**: Azurite — Microsoft's own Blob emulator — never MinIO and never anything merely "S3-compatible"; Postgres for Postgres. (S30)
- **No module branches on the environment**: no `isLocal`, no `if (dev)`, no `NODE_ENV` read outside build tooling, no `process.env` read outside each app's single typed configuration module, and no `import.meta.env` read outside `src/lib/config.ts`. (§5.1, S30)
- **The configuration diff *is* §5.1's divergence list.** A key that differs between the local and deployed configurations and is not in the table fails the build — **and so does a table row with no key behind it.** Stage 2 adds rows 4 and 5. (§18 item 10, S30)
- **The gateway is unchanged in this stage except for one field.** `apps/gateway` gains nothing but `actorUserId` on its audit record (Task 6). It gets no database credential, ever — it has none by design, and the gateway's call log and the (Stage 3+) `audit_event` table are deliberately two different logs. (§5, §12 Q3, S22)
- **`api` still may not egress.** Postgres and Blob Storage are reached over private endpoints in the tenant and over the `internal` compose network locally; the public internet stays denied by network policy, not by code review. (§5)
- **When you find yourself writing a second copy of something, extract it then.** Not after the third. A client/server split doubles the surface for sibling drift, which is this project's most repeated defect by a wide margin. (§19, S14)
- **Mutation-test anything load-bearing.** Break the implementation, confirm the *named* test fails, restore. A green suite is not evidence.
- **Gates for every task:** `npm run typecheck` clean (discovery-based, four projects and rising — never bare `tsc`); `npm test` green **read from an exit code, not a summary line and never through a pipe**; `npm run build` clean with no externalization warning.
- **Commit at the end of every task, by pathspec — never `git add -A`** — then run `git show --stat HEAD` and read it. The verification, not the pathspec, is what catches a swept commit.

---

## Eleven decisions this plan makes, and why

Numbered **P6–P16**, continuing Stage 1's P1–P5 in the same repository. Each is load-bearing across several tasks and a reader should not have to reconstruct it from the task list. Each carries its cost if wrong, in `rulings.md`'s format, and Task 27 records them there.

**P6 — Record ids stay `text` and stay client-minted by `uid()`. Only `workspace.id` and `app_user.id` are `uuid`, and only those are minted server-side.**
`uid()` is `Math.random().toString(36).slice(2) + Date.now().toString(36)` — not a UUID. Making every record id a UUID would turn the uploader into a re-keying exercise across every reference in the data: `document.matterId`, `review.documentIds`, `review.target.collectionId`, `collection.baseDocumentId` and `variesDocumentIds`, `playbook.currentVersionId`, `review.playbookVersionId`, `changeset.fromVersionId`, and — inside `jsonb` — `Finding.citations[].documentId`, `NetPosition.trail[].documentId`, `ChangesetItem.basis[].documentId`. A migration that must rewrite ids inside nested JSON to stay consistent is precisely *"a failed storage migration rendering an empty library"* with more moving parts. Keeping `text` makes the upload a straight copy and makes the uploader's per-record report meaningful, because the id in the report is the id the record has always had.
*Cost if wrong:* an id that is not globally unique. Two workspaces could in principle mint the same `uid()`. Mitigated structurally rather than by hope: every table carries `workspace_id not null`, every read is scoped by it, and every write is an upsert whose `DO UPDATE` is conditional on the existing row belonging to the same workspace — so a collision across workspaces is a `409`, never a silent overwrite. Task 8 tests exactly that.

**P7 — One `PUT /v1/<thing>/{id}` per repository `save*` function, and it is an idempotent upsert. No `POST` create/`PATCH` update split.**
`saveMatter`, `saveCollection`, `saveReview`, `savePlaybook` and `saveChangeset` are all "write this whole record" today, and the caller does not know or care whether it exists. Splitting them into create and update at the wire would put a decision at every call site that no call site has, which is the caller change the seam exists to prevent.
*Cost if wrong:* a client that sends a whole record can send a stale one. That is what the `version` column in P9 is for.

**P8 — `src/lib/db/` keeps its path and its file names, and its bodies become HTTP.**
A rename to `src/lib/repo/` would touch every importing file in `src/` for no behaviour, and would make the claim this stage exists to prove — *no caller changed* — unverifiable from a diff. The directory's own docstrings are corrected in the same commit as each swap, because a comment saying "IndexedDB" over a `fetch` call is how a true statement gets restored by a well-meaning refactor.
*Cost if wrong:* a directory named `db` holds no database. Named in each file's header, and in `rulings.md`.

**P9 — Every mutable record table carries `version bigint not null default 1`, and a stale write is refused with `409` and the current row. The *UI* for that refusal is Stage 4's; the *refusal* is here.**
§6.3's stale-change refusal is written for dispositions and Stage 4, but the mechanism belongs to whatever is written concurrently, and in Stage 2 that is two browser tabs — the situation `DbBlockedError` exists today because it happens. Without a version, `createDebouncedReviewSaver`'s fire-and-forget write would silently overwrite a review a second tab had changed, and nothing would be on screen to show it. Stage 2 refuses it and reports the refusal through `onError` and the load-error panel; Stage 4 adds *"Priya changed this at 14:22 — your change was not applied"* over the same number.
*Cost if wrong:* one column per table, one predicate per write, and a `409` a single user can provoke by having two tabs open — which is the correct outcome, said out loud. **The version the client sends and the version realtime will later broadcast must stay one number** (§8's *"they must not be allowed to become two numbers"*), which is why it is introduced now rather than invented twice.

**P10 — Postgres has two roles: `lexprompt_migrator` (owns the schema, used only by the migration runner) and `lexprompt_app` (used by every request). Grants are part of the migration, not part of a deployment runbook.**
S11's *"append-only by database grant, not by convention"* and §6.1's *"`REVOKE UPDATE, DELETE` from the app role"* are both unenforceable if the application connects as the schema owner, because an owner's grants are advisory to itself. Two roles is what makes the immutability of a published playbook version a property of the database rather than a property of the code that happens not to write it.
*Cost if wrong:* two connection strings instead of one, and a migration that must run as a different principal than the app. Both are set in both environments (`sameEverywhere`), so neither is a divergence. Task 13 mutation-tests the revoke by attempting an `UPDATE` as `lexprompt_app` and asserting a permission error — not by grepping for call sites.

**P11 — Findings stay a `jsonb` column on `review` in Stage 2. They become rows in Stage 3, with the engine that forces it.**
§6.2 is emphatic that findings must become rows, and §13 is equally emphatic about *when*: *"Findings become rows, which is the largest single data migration in the plan and is done here rather than in Stage 2 because the engine is what forces it."* Doing it early would mean building `finding` rows that only the browser writes, and then rebuilding their write path in Stage 3 when the worker takes over — two implementations of one table's write path, a stage apart.
*Cost if wrong:* Stage 3 carries a data migration from `review.findings jsonb` to `finding` rows, over data written during Stage 2. That migration is named in "Interfaces Stage 3 and later must honour" so it is planned rather than discovered, and Task 15 stores the column as the exact `Record<findingsKey, Record<clauseId, Finding>>` shape the type already has, so the Stage 3 migration is a shred rather than a translation.

**P12 — Document parsing stays in the browser in Stage 2 and moves server-side in Stage 3, with the engine. `parse_state` is stored from the day the column exists.**
§11/S19 move parsing server-side, and the reason they give is the engine: *"a queued run could only start from a browser that happened to have the document open — which is not a queue."* There is no queue until Stage 3. Moving the parser now would change `addDocument(rec, bytes)`'s contract — the browser would send bytes and the text would arrive later, asynchronously — which is exactly the caller change the seam exists to prevent, made for a benefit that does not exist yet.
So Stage 2 keeps `parseFile` in the browser and stores `parse_state` as `'parsed'` or `'failed'` from the browser's own parse, with `parse_error` beside it. Stage 3 changes **who writes those columns**, not what they are.
*Cost if wrong:* the server holds a `parse_state` nothing server-side produced for one stage. Against that: the alternative rewrites the ingest path twice and makes Stage 2's DoD ("every record type round-trips") depend on a parse worker that Stage 3's DoD is about. **This is the one place where the spec's §11 and the spec's §13 pull in different directions, and it is recorded as a finding in Task 27 rather than resolved silently.**

**P13 — `position_basis` keys on `(playbook_id, clause_id)` — the clause's identity across versions — and additionally records `adopted_in_version_id` and the position text as adopted.**
§6.5 writes `position_basis(standard_position_id, …)`, but a `StandardPosition` has no id in `types.ts`: it is a field on a `PlaybookClause`, inside an immutable `PlaybookVersion`. Keying on the version would make a position's evidence disappear the next time anyone published, which is the opposite of §11.1's whole argument (*"a position adopted six months ago still resolves to the documents and the specific edits that produced it"*). Keying on the clause makes the evidence follow the position.
The stored adopted text is what keeps it honest: if the clause's current standard position differs from the text that was adopted, the evidence panel says *"this evidence was gathered for the wording adopted in v3, which has since been edited"* rather than implying four leases support a sentence nobody has tested. That is `positionHealth.ts`'s wording-scoping rule, one layer down.
*Cost if wrong:* one extra column and one extra comparison. Without it, either the evidence vanishes on publish or it silently re-attaches itself to text it never supported.

**P14 — Blob credentials are resolved from an explicitly configured *source*, never inferred from which value happens to be set, and the sources never fall back to one another.**
This is Stage 1's Task 7 shape reused verbatim, and reusing it is the point: `API_BLOB_CREDENTIAL_SOURCE` is `connection-string` or `managed-identity`, and a failure to resolve the configured one is a loud `503` naming it — never a silent attempt at the other. Azurite cannot authenticate by managed identity (§5.1 says so explicitly), so the two environments genuinely need different credential *sources*, and "whichever variable is set" would be an environment branch wearing a convenience's clothes.
*Cost if wrong:* one configuration key that must be set in both environments. Against it: `DefaultAzureCredential` silently succeeding against a developer's `az login` while the operator believed a connection string was in use is a credential path nobody chose.

**P15 — The uploader is a route, not a modal, and it is idempotent.**
`/upload-local-data`, reachable from a banner while local data exists, and safe to run twice: every write is the same `PUT … {id}` upsert every repository uses, so a second run over a partially-successful first one re-sends what failed and re-confirms what did not. A one-shot modal that cannot be reopened is how a partial migration becomes an unrecoverable one — and §13.1's *"a partial migration says so"* is only useful if the person told can then do something.
*Cost if wrong:* a route that exists for one release and is then deleted. §13.1 already says the screen is *"available for one release"*, so its removal is expected work, not debt.

**P16 — Every attribution field in uploaded data is rewritten to the uploading user's `app_user.id`, and the report says how many were rewritten and where.**
The local profile is one person — `getProfile()` mints exactly one record under key `'local'` — so every `ownerId`, `addedByUserId`, `createdByUserId`, `publishedByUserId`, `Verification.byUserId`, `Note.byUserId` and `NetPosition.byUserId` in a browser's data holds that one id. Those columns become foreign keys to `app_user` (§6.4), so uploading them unrewritten would fail every insert. Rewriting them is faithful *and* it is a change to who the data says did something, so it is disclosed on the report rather than performed quietly. An empty-string attribution (`importPlaybook`'s `byUserId = ''` default) becomes `NULL`, not the uploader — an unattributed import must not acquire an author it never had.
*Cost if wrong:* if the browser's data was ever authored by more than one person, this flattens them to one. It was not: there is one profile record, and the README's own privacy section says the data is per-browser. Recorded so a reader can see the assumption was checked rather than assumed.

---

## File Structure

```
apps/api/
  migrations/000_preconditions.sql      NEW  refuses to run if the two roles do not exist (Task 1)
  migrations/001_identity.sql           NEW  workspace, app_user, role_mapping, workspace_setting
  migrations/002_records.sql            NEW  matter, document, collection, playbook,
                                             playbook_version, review, changeset  (+grants)
  migrations/003_precedent.sql          NEW  document.kind, precedent_set
                                             — lands in Task 19, WITH the copy change
  migrations/004_position_basis.sql     NEW  position_basis (Task 20; 003 has shipped by then,
                                             and an applied migration file is immutable)
  src/config.ts                      MODIFY  + database and blob keys, in this file ONLY
  src/db/pool.ts                        NEW  Db / Tx over `pg`; the only place a query runs
  src/db/migrate.ts                     NEW  the SQL runner: ordered, once, under a lock
  src/db/rows.ts                        NEW  row <-> wire mapping helpers (nulls, dates, jsonb)
  src/auth/roles.ts                     NEW  role_mapping lookup -> Role; the no-role refusal
  src/auth/actor.ts                     NEW  Principal -> app_user (JIT provisioning), Actor
  src/auth/requireRole.ts               NEW  registerRoleGate — one hook, reading the table
  src/auth/routeTable.ts                NEW  ROUTE_POLICY: no default, no route without an entry
  src/errors.ts                         NEW  ConflictError — the 409 that carries the current row
  src/blob/store.ts                     NEW  BlobStore interface + AzureBlobStore
  src/blob/credential.ts                NEW  P14: source selection, no fallback
  src/routes/me.ts                      NEW  GET /v1/me, PUT /v1/me
  src/routes/matters.ts                 NEW
  src/routes/documents.ts               NEW  + bytes, + the delete cascade
  src/routes/collections.ts             NEW
  src/routes/playbooks.ts               NEW  + versions, + publishAndPoint's transaction
  src/routes/reviews.ts                 NEW
  src/routes/changesets.ts              NEW
  src/routes/workspaceSettings.ts       NEW
  src/routes/precedents.ts              NEW  Task 19
  src/server.ts                      MODIFY  register the route groups; resolve the actor once
  src/main.ts                        MODIFY  build the pool, run migrations, build the blob store
  test/helpers/pgHarness.ts             NEW  a REAL Postgres, per-test transaction, rolled back
  test/helpers/apiHarness.ts         MODIFY  + a signed-in actor with a role
  test/roles.pg.test.ts                 NEW  BOTH issuers, from the day the table exists
  test/authz.route.test.ts              NEW  table-driven; a route with no entry fails the build
  test/matters.pg.test.ts               NEW  (and one .pg.test.ts per repository concern)
  test/documents.pg.test.ts             NEW
  test/blobStore.test.ts                NEW
  test/collections.pg.test.ts           NEW
  test/playbooks.pg.test.ts             NEW
  test/reviews.pg.test.ts               NEW
  test/changesets.pg.test.ts            NEW
  test/precedent.pg.test.ts             NEW  Task 19
  test/grants.pg.test.ts                NEW  P10: the revoke, proved by attempting the write
  test/workspaceScope.test.ts           NEW  every query carries a workspace predicate
  test/configSurface.test.ts         MODIFY  rows 4 and 5
  test/divergence.json               MODIFY  rows 4 and 5, both directions

apps/gateway/
  src/audit.ts                       MODIFY  AuditStart gains actorUserId ALONGSIDE the pair
  test/audit.test.ts                 MODIFY

packages/core/
  src/model/protocol.ts              MODIFY  new ModelError codes (closed set)
  src/api/records.ts                    NEW  the wire types shared by browser and server
  src/api/records.test.ts               NEW

src/lib/
  api/client.ts                         NEW  THE one HTTP transport for repositories
  api/client.test.ts                    NEW
  db/open.ts                         MODIFY  read-only after Task 23; the uploader's last reader
  db/matters.ts                      MODIFY  same exports, HTTP bodies
  db/documents.ts                    MODIFY
  db/blobs.ts                        MODIFY
  db/collections.ts                  MODIFY
  db/reviews.ts                      MODIFY
  db/playbooks.ts                    MODIFY
  db/playbookVersions.ts             MODIFY
  db/changesets.ts                   MODIFY
  db/profile.ts                      MODIFY  getProfile() resolves the signed-in user
  db/seq.ts                          DELETE  (Task 23) — Postgres orders; nothing allocates _seq
  loadError.ts                       MODIFY  + the HTTP shapes
  privacyCopy.ts                     MODIFY  STORAGE_PRIVACY rewritten; PRECEDENT_STORAGE added
  role.ts                               NEW  the browser's read of its own role
  upload/scan.ts                        NEW  Task 21: what is in this browser
  upload/run.ts                         NEW  Task 22: move it, and report by name
  upload/report.ts                      NEW  the report type both halves share

src/features/
  auth/NoRolePanel.tsx                  NEW  "you have no access", not an empty app
  settings/WorkspaceModelPanel.tsx      NEW  the admin's model choice (§6.6)
  redlines/PrecedentIntake.tsx       MODIFY  Task 19 — the sentence
  redlines/PrecedentUploadPanel.tsx  MODIFY  Task 19 — the stale docstring only
  redlines/TheWorkings.tsx           MODIFY  Task 20 — evidence from position_basis
  upload/UploadLocalData.tsx            NEW  Tasks 21, 22
  upload/LocalDataBanner.tsx            NEW

src/App.tsx                          MODIFY  role gate, the upload route, the redlines comment
src/App.redlines.test.tsx            MODIFY  Task 19 — REWRITTEN, never deleted
src/lib/router.ts                    MODIFY  + { name: 'upload-local-data' }
src/types.ts                         MODIFY  Role, WorkspaceSettings; Settings loses modelChoice*

docker-compose.yml                   MODIFY  postgres, azurite — `internal` only
.env.example                         MODIFY
infra/modules/postgres.bicep            NEW
infra/modules/storage.bicep             NEW
infra/main.bicep                     MODIFY
README.md                            MODIFY  §2's Stage-2 rows
docs/superpowers/redesign/rulings.md MODIFY  P6–P16 as executed, and Stage 2's own rulings
```

---

# Part 2A — the firm's database holds the work

Tasks 1–18. **Definition of done for this part** (§18 item 3, first four clauses): a user signs in against the configured issuer and sees only what their role permits, refused by the API and not merely hidden by the UI, verified against both issuers; every record type round-trips through Postgres; document bytes round-trip through Blob Storage; deleting a matter purges its blobs. Task 18 ends with the live-stack pass that proves it. **Do not begin Task 19 until that pass has been run and reported.**

---

## Task 1: Postgres in compose, the migration runner, and a test harness against a real database

**Type:** infrastructure

**Files:**
- Modify: `package.json` (add `pg`, `@types/pg`; add a `test:pg` script)
- Modify: `apps/api/package.json` (add `pg` to the workspace that uses it)
- Create: `apps/api/src/db/pool.ts`
- Create: `apps/api/src/db/migrate.ts`
- Create: `apps/api/migrations/000_preconditions.sql`
- Modify: `apps/api/src/config.ts` (database keys — this file and no other)
- Modify: `apps/api/src/main.ts` (build the pool, run migrations, refuse to start on failure)
- Create: `apps/api/test/helpers/pgHarness.ts`
- Create: `apps/api/test/pool.test.ts`
- Create: `apps/api/test/migrate.pg.test.ts`
- Create: `apps/api/test/pgSuiteWiring.test.ts`
- Create: `vitest.pg.config.ts`
- Modify: `vitest.config.ts` (exclude `*.pg.test.ts` from the `api` project)
- Create: `infra/postgres/init.sql`
- Create: `scripts/pg-forward.sh`
- Modify: `docker-compose.yml` (the `postgres` service, on `internal` only)
- Modify: `.env.example`, `scripts/print-local-accounts.sh`

**Interfaces:**
- Consumes: `apps/api/src/config.ts`'s `ApiConfig`, `ConfigError`, its file-local `int` and `required`, `loadConfig`, `describeConfig`; `apps/api/src/main.ts`'s `refuseToStart`. **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `Db`, `Tx`, `PgClientLike`, `PgPoolLike`, `makeDb(pool)`, `makePool(dsn, max)`, `runMigrations(db, dir)`, `appliedVersions(db)`, the harness `appDb()` / `migratorDb()` / `withPg(body, db?)`, and the configuration keys `API_DATABASE_URL`, `API_DATABASE_MIGRATION_URL`, `API_DATABASE_POOL_MAX`.

**Why this task exists before any table:** every later task writes SQL, and a SQL-writing task with no transaction primitive and no real database to run against will invent one. Stage 1's `unlimitedRateLimiter` (ledger ruling R1) is the record of what a placeholder primitive costs when the real one arrives three tasks later.

- [ ] **Step 1: Add the dependency, and a separate test project for the suites that need a database**

```bash
npm install pg@^8.13.0
npm install -D @types/pg@^8.11.10
```

`pg` also goes in `apps/api/package.json`'s `dependencies` — that is what the container installs. Read that file and follow how `fastify` and `jose` are declared there.

`vitest.pg.config.ts`:

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The suites that need a REAL Postgres, in their own project.
 *
 * A fake Postgres is not acceptable (§14): half the point of moving to
 * Postgres is that it enforces constraints IndexedDB could not, and a
 * substitute that behaves subtly differently is the exact defect class this
 * project keeps finding. So these tests need a database, which means Docker,
 * which is why they are not part of `npm test` — the same reasoning that
 * already keeps `test:compose` in its own config.
 *
 * They are NOT optional and they do NOT skip. `pgHarness.ts` fails loudly
 * with the command that fixes it when the database is absent, because a
 * suite that skips itself reports green while testing nothing.
 */
export default defineConfig({
  resolve: { alias: { '@lexprompt/core': path.resolve(__dirname, 'packages/core/src/index.ts') } },
  test: {
    name: 'api-pg',
    environment: 'node',
    globals: false,
    include: ['apps/api/test/**/*.pg.test.ts'],
    // One database, one schema: these files share a pool and each test rolls
    // its own transaction back, so they must not race each other.
    fileParallelism: false,
  },
});
```

`package.json`'s `scripts` gains one entry — read the shipped block and add to it:

```json
"test:pg": "vitest run --config vitest.pg.config.ts"
```

- [ ] **Step 2: Write the failing test for the pool's transaction nesting**

`apps/api/test/pool.test.ts` — in the ordinary `api` project, because it tests the nesting *logic* against a fake client, not the database:

```ts
import { describe, it, expect } from 'vitest';
import { makeDb, type PgClientLike } from '../src/db/pool.ts';

/** Records every statement issued, and answers every query with no rows. */
function recorder(): { client: PgClientLike; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    client: {
      query: async (text: string) => { statements.push(text); return { rows: [] }; },
      release: () => { statements.push('RELEASE-CLIENT'); },
    },
  };
}

describe('Db.tx nests with savepoints, never with a second BEGIN', () => {
  it('opens a real transaction at depth 0', async () => {
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await db.tx(async t => { await t.query('select 1'); });
    expect(statements).toEqual(['BEGIN', 'select 1', 'COMMIT', 'RELEASE-CLIENT']);
  });

  it('uses a SAVEPOINT for a nested tx, not a second BEGIN', async () => {
    // A second BEGIN inside an open transaction is a WARNING and a no-op in
    // Postgres: the inner "transaction" silently shares the outer one, so an
    // inner rollback takes the outer's work with it and an inner commit
    // commits the outer early. Both failures are invisible.
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await db.tx(async outer => {
      await outer.tx(async inner => { await inner.query('select 2'); });
    });
    expect(statements).toEqual([
      'BEGIN', 'SAVEPOINT sp1', 'select 2', 'RELEASE SAVEPOINT sp1', 'COMMIT', 'RELEASE-CLIENT',
    ]);
    expect(statements.filter(s => s === 'BEGIN')).toHaveLength(1);
  });

  it('rolls back to the savepoint when the inner block throws, and lets the error out', async () => {
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await expect(db.tx(async outer => {
      await outer.tx(async () => { throw new Error('inner failed'); });
    })).rejects.toThrow('inner failed');
    expect(statements).toEqual([
      'BEGIN', 'SAVEPOINT sp1', 'ROLLBACK TO SAVEPOINT sp1', 'ROLLBACK', 'RELEASE-CLIENT',
    ]);
  });

  it('releases the client even when the outermost block throws', async () => {
    const { client, statements } = recorder();
    const db = makeDb({ connect: async () => client });
    await expect(db.tx(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(statements.at(-1)).toBe('RELEASE-CLIENT');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run --project api apps/api/test/pool.test.ts`
Expected: FAIL — `Cannot find module '../src/db/pool.ts'`.

- [ ] **Step 4: Write `pool.ts`**

```ts
import { Pool, type QueryResultRow } from 'pg';

/** The slice of `pg`'s client this module uses. Narrowed deliberately so a
 *  test can supply one without reproducing sixty members, and so nothing
 *  here reaches for a `pg` convenience a pinned test client cannot answer. */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface PgPoolLike { connect(): Promise<PgClientLike>; }

export interface Tx {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]>;
  /** Nested work in the same transaction, isolated by a savepoint. */
  tx<T>(run: (t: Tx) => Promise<T>): Promise<T>;
}

export interface Db {
  /** A single statement outside any transaction. */
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]>;
  /** Everything in `run` succeeds together or not at all. */
  tx<T>(run: (t: Tx) => Promise<T>): Promise<T>;
}

/**
 * `BEGIN` at depth 0, `SAVEPOINT` below it.
 *
 * Postgres answers a second `BEGIN` inside an open transaction with a
 * warning and does nothing, so a naive nested implementation gives the inner
 * block a transaction that is not one: its `ROLLBACK` discards the outer
 * block's work and its `COMMIT` commits the outer block early, neither of
 * them raising anything. Every write path in this stage is at least two
 * levels deep somewhere — a route's transaction containing a helper's — so
 * this is not a nicety, and the test harness depends on it besides.
 */
function bind(client: PgClientLike, depth: number): Tx {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> {
      const result = await client.query(text, values);
      return result.rows as R[];
    },
    async tx<T>(run: (t: Tx) => Promise<T>): Promise<T> {
      const name = `sp${depth + 1}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const value = await run(bind(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    },
  };
}

export function makeDb(pool: PgPoolLike): Db {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> {
      const client = await pool.connect();
      try {
        const result = await client.query(text, values);
        return result.rows as R[];
      } finally {
        client.release();
      }
    },
    async tx<T>(run: (t: Tx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const value = await run(bind(client, 0));
          await client.query('COMMIT');
          return value;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      } finally {
        client.release();
      }
    },
  };
}

/** Builds the real pool. The only place `pg`'s `Pool` is constructed. */
export function makePool(connectionString: string, max: number): Pool {
  return new Pool({ connectionString, max });
}
```

`pg`'s `Pool` is expected to satisfy `PgPoolLike` structurally. **Verify that with `npm run typecheck` rather than assuming it** — `pg`'s `query` is heavily overloaded and its `PoolClient` may not line up. If it does not, adapt inside `makePool` with an explicit wrapper object; do **not** widen `PgClientLike` to `any`, which would make the fake client in the test above prove nothing about the real one.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run --project api apps/api/test/pool.test.ts`
Expected: PASS, 4 tests.

**Mutation (do it, confirm, restore):** change `bind`'s `SAVEPOINT ${name}` to `BEGIN`. Expected: `uses a SAVEPOINT for a nested tx, not a second BEGIN` **and** `rolls back to the savepoint when the inner block throws, and lets the error out` fail by name.

- [ ] **Step 6: Add the database configuration, in the one file allowed to read the environment**

In `apps/api/src/config.ts`, extend `ApiConfig` and `loadConfig`. Read the shipped file first: `int(env, name, fallback)` and `required(env, name)` already exist there with those signatures.

```ts
  /** The app role's connection. Every request runs as `lexprompt_app`, which
   *  by design cannot UPDATE or DELETE a published playbook version (P10).
   *  Set in BOTH environments — the value differs, the key does not — so
   *  this is `sameEverywhere` and not a §5.1 divergence. */
  databaseUrl: string;
  /** The migrator role's connection, used ONLY by `runMigrations` at startup
   *  and by nothing else. It owns the schema; the app role does not. Two
   *  roles is what makes an immutability grant a fact about the database
   *  rather than a fact about the code that happens not to write. */
  databaseMigrationUrl: string;
  databasePoolMax: number;
```

in `loadConfig`:

```ts
    databaseUrl: required(env, 'API_DATABASE_URL'),
    databaseMigrationUrl: required(env, 'API_DATABASE_MIGRATION_URL'),
    databasePoolMax: int(env, 'API_DATABASE_POOL_MAX', 10),
```

in `describeConfig`, one more banner line — the boot banner is where a misrouted deployment shows up first, and a database is exactly the kind of thing that gets pointed at the wrong host:

```ts
    `Database: ${redactDsn(cfg.databaseUrl)}`,
```

and, in the same file:

```ts
/** A DSN in a log line must never carry its password. `postgres://u:p@h/db`
 *  becomes `postgres://u@h/db`. Returned verbatim when it does not parse,
 *  because a malformed DSN is worth seeing in full at boot and there is no
 *  password in it to leak — it is not a DSN. */
export function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    url.password = '';
    return url.toString();
  } catch {
    return dsn;
  }
}
```

Add to `apps/api/test/config.test.ts` (it has eleven cases already — **add**, do not rewrite): each new required key refuses by name when unset; and

```ts
  it('never prints a database password in the boot banner', () => {
    const cfg = loadConfig({ ...baseEnv, API_DATABASE_URL: 'postgres://app:hunter2@db:5432/lex' });
    const banner = describeConfig(cfg);
    // The positive assertion is what makes the negative one mean something:
    // without it, a banner that dropped the Database line entirely passes.
    expect(banner).toContain('postgres://app@db:5432/lex');
    expect(banner).not.toContain('hunter2');
  });
```

- [ ] **Step 7: Write the migration runner's failing test**

`apps/api/test/migrate.pg.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migratorDb } from './helpers/pgHarness.ts';
import { runMigrations, appliedVersions } from '../src/db/migrate.ts';

describe('runMigrations applies each file once, in order, under a lock', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lexmig-'));
    writeFileSync(path.join(dir, '901_a.sql'), 'create table mig_probe_a (x int);');
    writeFileSync(path.join(dir, '902_b.sql'), 'create table mig_probe_b (x int);');
  });

  it('applies both files and records both versions', async () => {
    const db = migratorDb();
    await db.query('drop table if exists mig_probe_a, mig_probe_b');
    await db.query("delete from schema_migration where version in ('901_a','902_b')");
    await runMigrations(db, dir);
    expect(await appliedVersions(db)).toEqual(expect.arrayContaining(['901_a', '902_b']));
  });

  it('is idempotent: a second run applies nothing and does not throw', async () => {
    // The first run created `mig_probe_a`; re-running the same SQL would fail
    // with "relation already exists" if the ledger were not consulted, which
    // is what stops this being a tautology.
    await expect(runMigrations(migratorDb(), dir)).resolves.toBeUndefined();
  });

  it('two concurrent runners do not both apply the same file', async () => {
    // The IndexedDB precedent is exact: a flag alone was not enough for the
    // pre-D playbook migration, because two callers both read no flag and
    // both published. The lock is what actually closes it, and only if it is
    // taken BEFORE the ledger is read.
    const dir2 = mkdtempSync(path.join(tmpdir(), 'lexmig2-'));
    writeFileSync(path.join(dir2, '903_once.sql'), 'create table mig_probe_once (x int);');
    const a = migratorDb(); const b = migratorDb();
    await a.query('drop table if exists mig_probe_once');
    await a.query("delete from schema_migration where version = '903_once'");
    const results = await Promise.allSettled([runMigrations(a, dir2), runMigrations(b, dir2)]);
    expect(results.filter(r => r.status === 'rejected')).toEqual([]);
    const rows = await a.query<{ n: string }>(
      "select count(*)::text as n from schema_migration where version = '903_once'",
    );
    expect(rows[0].n).toBe('1');
  });

  it('names the file when one fails, rather than reporting a bare syntax error', async () => {
    const bad = mkdtempSync(path.join(tmpdir(), 'lexmigbad-'));
    writeFileSync(path.join(bad, '904_broken.sql'), 'this is not sql;');
    await expect(runMigrations(migratorDb(), bad)).rejects.toThrow(/904_broken\.sql/);
  });
});
```

- [ ] **Step 8: Write the harness**

`apps/api/test/helpers/pgHarness.ts`:

```ts
import { afterAll } from 'vitest';
import { Pool } from 'pg';
import { makeDb, type Db, type Tx } from '../../src/db/pool.ts';

/**
 * These suites need a REAL Postgres and they do not skip without one.
 *
 * A skipped suite reports green while testing nothing — the shape §14 calls
 * unacceptable and the shape this project has already shipped. So the
 * absence of a database is a loud failure carrying the command that fixes
 * it, not a `describe.skip`.
 */
function requireUrl(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set, and these suites run against a real Postgres by design `
      + '(spec §14: "A fake Postgres is not acceptable"). Start the stack with '
      + '`npm run compose:up`, run `scripts/pg-forward.sh`, then export the two URLs it '
      + 'prints. These suites are NOT skipped without a database.',
    );
  }
  return value;
}

let appPool: Pool | undefined;
let migratorPool: Pool | undefined;

/** A `Db` on the migrator role — the schema owner. */
export function migratorDb(): Db {
  migratorPool ??= new Pool({ connectionString: requireUrl('LEXPROMPT_TEST_MIGRATION_URL'), max: 4 });
  return makeDb(migratorPool);
}

/** A `Db` on the app role — the role a request actually runs as, and
 *  therefore the only role a grant test can prove anything with. */
export function appDb(): Db {
  appPool ??= new Pool({ connectionString: requireUrl('LEXPROMPT_TEST_DATABASE_URL'), max: 4 });
  return makeDb(appPool);
}

afterAll(async () => {
  await appPool?.end();
  await migratorPool?.end();
  appPool = undefined;
  migratorPool = undefined;
});

class RollbackSignal extends Error {}

/**
 * Runs `body` inside a transaction that is ALWAYS rolled back.
 *
 * The `Tx` handed in is bound to one pinned client, so everything the body
 * does — including its own nested `tx()` calls, which become savepoints — is
 * discarded at the end. That is what lets these suites share one database
 * with no truncate between tests, and it is why `pool.ts`'s savepoint
 * nesting is load-bearing rather than tidy.
 *
 * The body's own failure is captured and re-thrown AFTER the rollback, so a
 * failing assertion still leaves the database clean.
 */
export async function withPg(body: (t: Tx) => Promise<void>, db: Db = appDb()): Promise<void> {
  let thrown: unknown;
  await db.tx(async t => {
    try { await body(t); } catch (err) { thrown = err; }
    throw new RollbackSignal();
  }).catch((err: unknown) => { if (!(err instanceof RollbackSignal)) throw err; });
  if (thrown) throw thrown;
}
```

- [ ] **Step 9: Write `migrate.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db, Tx } from './pool.ts';

/** A stable key for the advisory lock. Any constant works as long as it is
 *  the same in every process; a literal is clearer in `pg_locks` than a hash
 *  of a string nobody would recognise. */
const MIGRATION_LOCK = 8_142_337_001;

async function ensureLedger(runner: Pick<Tx, 'query'>): Promise<void> {
  await runner.query(`
    create table if not exists schema_migration (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function appliedVersions(db: Db): Promise<string[]> {
  await ensureLedger(db);
  const rows = await db.query<{ version: string }>(
    'select version from schema_migration order by version',
  );
  return rows.map(r => r.version);
}

/**
 * Applies every `.sql` file in `dir` this database has not seen, in filename
 * order, recording each — the whole lot in ONE transaction holding an
 * advisory lock taken BEFORE the ledger is read.
 *
 * The ordering is the entire guarantee, and the pre-D playbook migration is
 * the precedent: a flag alone was not enough there, because two concurrent
 * callers both read no flag and both published. Postgres serialises on the
 * advisory lock exactly as IndexedDB serialises overlapping readwrite
 * transactions, so a second runner blocks, then re-reads the ledger inside
 * its own transaction and finds the first runner's rows.
 *
 * `pg_advisory_xact_lock`, not `pg_advisory_lock`: the transaction lock is
 * released by COMMIT or ROLLBACK and cannot be leaked by a process that dies
 * holding it. A leaked session lock would leave every future deploy hanging
 * with no message at all.
 */
export async function runMigrations(db: Db, dir: string): Promise<void> {
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  await db.tx(async t => {
    await t.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await ensureLedger(t);
    const done = new Set(
      (await t.query<{ version: string }>('select version from schema_migration')).map(r => r.version),
    );
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      try {
        await t.query(sql);
      } catch (err) {
        // Named, always. A migration that fails with only Postgres's own
        // message leaves an operator reading a syntax error with no idea
        // which of eleven files produced it.
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      await t.query('insert into schema_migration (version) values ($1)', [version]);
    }
  });
}
```

Run `npm run typecheck` before moving on — **`npm run typecheck`, not `tsc`**: the root config carries a DOM lib and `apps/api` does not, so a type error here is invisible to the root run. That is precisely how two real errors survived two Stage 1 task reviews (ledger ruling T1).

- [ ] **Step 10: Write `000_preconditions.sql`**

```sql
-- Refuses the migration when the deployment has not created the two roles P10
-- requires. Without this, the first GRANT in 001 fails with Postgres's own
-- "role does not exist", which is true and says nothing about what the
-- operator is supposed to do about it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lexprompt_app') then
    raise exception 'The role lexprompt_app does not exist. LexPrompt runs every request as an app role that cannot modify a published playbook version, and the schema owner is a different role. Create both roles as part of the deployment: infra/postgres/init.sql is the local form, and the README carries the Azure step. A migration deliberately does not create its own principal, because it would then have to carry that principal password in version control.';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'lexprompt_migrator') then
    raise exception 'The role lexprompt_migrator does not exist. See infra/postgres/init.sql.';
  end if;
end $$;
```

- [ ] **Step 11: The compose service, on `internal` only, and the forwarder**

`infra/postgres/init.sql`, mounted into `docker-entrypoint-initdb.d` and run once at first boot:

```sql
-- The two roles P10 requires. Created by the DEPLOYMENT, not by a migration.
-- In Azure the equivalent is run once by the Flexible Server admin;
-- infra/modules/postgres.bicep (Task 24) names it and the README carries it
-- as a deployment step rather than leaving it to be discovered.
create role lexprompt_migrator login password 'lexprompt_migrator_dev';
create role lexprompt_app      login password 'lexprompt_app_dev';
alter schema public owner to lexprompt_migrator;
grant usage on schema public to lexprompt_app;
-- The app role gets NOTHING else here. Every grant it holds is granted by the
-- migration that creates the table it applies to, so a table added without a
-- grant is a table the app cannot read — which fails loudly on the first
-- request rather than quietly widening.
```

`docker-compose.yml`, inside `services:`:

```yaml
  postgres:
    image: postgres:16
    # `internal` ONLY, and no published port. It holds the firm's matters: it
    # must be unreachable from the host and it must have no route out.
    # `api` reaches it by service name over this network, exactly as it
    # reaches keycloak and the gateway.
    networks: [internal]
    environment:
      POSTGRES_USER: lexprompt_root
      POSTGRES_PASSWORD: lexprompt_root_dev
      POSTGRES_DB: lexprompt
    volumes:
      - "lexprompt-pgdata:/var/lib/postgresql/data"
      - "./infra/postgres:/docker-entrypoint-initdb.d:ro"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lexprompt_root -d lexprompt"]
      interval: 5s
      retries: 30
```

and at the top level:

```yaml
volumes:
  lexprompt-pgdata:
```

`api` gains `postgres: { condition: service_healthy }` in `depends_on`, and:

```yaml
      API_DATABASE_URL: postgres://lexprompt_app:lexprompt_app_dev@postgres:5432/lexprompt
      API_DATABASE_MIGRATION_URL: postgres://lexprompt_migrator:lexprompt_migrator_dev@postgres:5432/lexprompt
```

**A published `5432` would be the obvious way to let the `.pg.test.ts` suites reach the database, and it is not what happens here.** Outbound access in Docker comes from being attached to any non-internal network, and Stage 1's worst compose defect was exactly that reasoning going the other way: `api` sat on `frontend`, held `default via 172.21.0.1`, and had full internet access while the file read as correct. `postgres` holds the firm's matters and must not acquire a route out to make a test convenient. `scripts/pg-forward.sh` instead runs a throwaway forwarder that joins the internal network and publishes a host port for as long as it is running:

```bash
#!/usr/bin/env bash
# A temporary bridge from the host to the compose-internal Postgres, for the
# .pg.test.ts suites. Deliberately NOT a published port on the postgres
# service: a container attached to a routable network has a route out, and
# the database must not have one. Runs in the foreground; Ctrl-C removes it.
set -euo pipefail
NET="$(docker compose ls --format json >/dev/null 2>&1 && echo lexprompt_internal)"
echo "export LEXPROMPT_TEST_DATABASE_URL=postgres://lexprompt_app:lexprompt_app_dev@127.0.0.1:55432/lexprompt"
echo "export LEXPROMPT_TEST_MIGRATION_URL=postgres://lexprompt_migrator:lexprompt_migrator_dev@127.0.0.1:55432/lexprompt"
exec docker run --rm --network "$NET" -p 127.0.0.1:55432:55432 alpine/socat \
  tcp-listen:55432,fork,reuseaddr tcp-connect:postgres:5432
```

Verify the network's actual name with `docker network ls` on the running stack before hard-coding `lexprompt_internal` — compose's project name prefix is set by `name: lexprompt` at the top of the compose file, so it should be right, but a script that silently attaches to the wrong network fails with a confusing timeout.

- [ ] **Step 12: Wire it into `main.ts`, inside the existing startup banner**

Read the shipped `main.ts` first. Its `refuseToStart` and its two `try` blocks already have a shape; add to it rather than restructuring:

```ts
  let db: Db;
  try {
    // …existing `config = loadConfig(process.env)` and `gateway = makeGatewayClient(config)`…
    db = makeDb(makePool(config.databaseUrl, config.databasePoolMax));
  } catch (err) { refuseToStart(err); }

  process.stdout.write(`${describeConfig(config)}\n`);

  // Migrations run on the MIGRATOR connection, and that pool is closed
  // immediately: the schema owner's credential must not sit in a live pool
  // for the process's lifetime, where any later code could reach it.
  try {
    const migrationPool = makePool(config.databaseMigrationUrl, 2);
    try {
      await runMigrations(makeDb(migrationPool), fileURLToPath(new URL('../migrations/', import.meta.url)));
    } finally {
      await migrationPool.end();
    }
  } catch (err) { refuseToStart(err); }
```

The migrations directory resolves from `import.meta.url`, never from `process.cwd()` — the container's working directory is not the source tree's. **Read `apps/api/Dockerfile` and confirm it copies `apps/api/migrations/`** rather than assuming: a migrations directory missing from the image is a container that starts, migrates nothing, and answers every query with "relation does not exist".

- [ ] **Step 13: The wiring guard — a pg suite cannot silently stop running**

`apps/api/test/pgSuiteWiring.test.ts`, in the ordinary `api` project so it runs with `npm test`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './sourceScan.ts';

describe('the real-Postgres suites are wired to something that runs them', () => {
  it('finds the .pg.test.ts files (a guard that matches nothing passes vacuously)', () => {
    const files = readdirSync(path.join(ROOT, 'apps/api/test')).filter(f => f.endsWith('.pg.test.ts'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('the ordinary api project EXCLUDES them, so npm test needs no database', () => {
    expect(readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8'))
      .toContain("'apps/api/test/**/*.pg.test.ts'");
  });

  it('and vitest.pg.config.ts includes them', () => {
    expect(readFileSync(path.join(ROOT, 'vitest.pg.config.ts'), 'utf8'))
      .toContain("include: ['apps/api/test/**/*.pg.test.ts']");
  });

  it('package.json has a script that runs them', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as
      { scripts: Record<string, string> };
    expect(pkg.scripts['test:pg']).toContain('vitest.pg.config.ts');
  });
});
```

…and add `'apps/api/test/**/*.pg.test.ts'` to the `api` project's `exclude` array in `vitest.config.ts`, beside the `*.compose.test.ts` entry already there.

- [ ] **Step 14: Run the stack, and prove the database is where it should be and nowhere else**

```bash
npm run compose:up
docker compose ps
docker compose logs api | tail -20
docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com; echo "exit=$?"'
```

Expected: `postgres` shows **no** published port in the `PORTS` column; `api` is healthy; the boot banner reads `Database: postgres://lexprompt_app@postgres:5432/lexprompt` with **no password**; the egress probe fails exactly as it did before this task.

Then, in a second terminal:

```bash
bash scripts/pg-forward.sh    # prints the two exports; leave it running
# in a third terminal, with those two exports set:
npm run test:pg > /tmp/tp.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/tp.txt
```
Expected: EXIT=0.

**What this proves that no unit test can:** that the migrations directory is in the image, that the two roles were created and the app role can connect, that the boot banner does not leak a password, and — the one that matters most — that adding a database did not give `api` a route to the internet. Read `docker compose ps` output yourself; do not infer it from the compose file, which is the mistake that produced Stage 1's `97d2b66`.

- [ ] **Step 15: Commit**

```bash
git add package.json package-lock.json vitest.config.ts vitest.pg.config.ts \
  apps/api/package.json apps/api/src/config.ts apps/api/src/main.ts apps/api/src/db \
  apps/api/migrations apps/api/test/pool.test.ts apps/api/test/migrate.pg.test.ts \
  apps/api/test/pgSuiteWiring.test.ts apps/api/test/helpers/pgHarness.ts \
  apps/api/test/config.test.ts docker-compose.yml infra/postgres \
  scripts/pg-forward.sh scripts/print-local-accounts.sh .env.example
git commit -m "feat(api): Postgres, a migration runner that cannot run twice, and a real-database harness"
git show --stat HEAD
```

---

## Task 2: Migration 001 — `workspace`, `app_user`, `role_mapping`, `workspace_setting`

**Type:** schema

**Files:**
- Create: `apps/api/migrations/001_identity.sql`
- Create: `apps/api/test/identity.pg.test.ts`

**Interfaces:**
- Consumes: Task 1's `Db`, `Tx`, `runMigrations`, `appDb()`, `migratorDb()`, `withPg`, and `ApiConfig.workspaceId` (the shipped `API_WORKSPACE_ID`, which is already `00000000-0000-0000-0000-000000000001` in compose — read `docker-compose.yml` and match it). **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: the tables `workspace`, `app_user`, `role_mapping`, `workspace_setting`, and the grants `lexprompt_app` holds on each.

- [ ] **Step 1: Write the failing test**

`apps/api/test/identity.pg.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, withPg } from './helpers/pgHarness.ts';

const WS = '00000000-0000-0000-0000-000000000001';
const insertUser = (subject: string, issuer = 'https://issuer.test', role = 'reviewer') =>
  [`insert into app_user
      (id, workspace_id, issuer, subject, email, display_name, initials, role, status)
    values (gen_random_uuid(), $1, $2, $3, 'a@x', 'A', 'A', $4, 'active')`,
   [WS, issuer, subject, role]] as const;

describe('001_identity', () => {
  it('seeds exactly one workspace', async () => {
    const rows = await migratorDb().query<{ n: string }>('select count(*)::text n from workspace');
    expect(rows[0].n).toBe('1');
  });

  it('keys a person on (issuer, subject) and refuses a duplicate pair', async () => {
    await withPg(async t => {
      await t.query(...insertUser('sub-1'));
      await expect(t.query(...insertUser('sub-1'))).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it('lets the SAME subject exist under a DIFFERENT issuer', async () => {
    // Not a curiosity. A Keycloak `sub` and an Entra `oid` are both opaque
    // strings and neither is ever compared with the other (§7). A unique
    // constraint on `subject` alone would make one issuer's account collide
    // with the other's — a bug only ever met in a tenant.
    await withPg(async t => {
      await t.query(...insertUser('collide', 'http://keycloak:8080/realms/lexprompt'));
      await t.query(...insertUser('collide', 'https://login.microsoftonline.com/t/v2.0'));
      const rows = await t.query<{ n: string }>("select count(*)::text n from app_user where subject = 'collide'");
      expect(rows[0].n).toBe('2');
    });
  });

  it('refuses a role outside the three', async () => {
    await withPg(async t => {
      await expect(t.query(...insertUser('sub-2', 'https://issuer.test', 'superuser')))
        .rejects.toThrow(/check constraint/i);
    });
  });

  it('refuses a status outside active/disabled', async () => {
    await withPg(async t => {
      await expect(t.query(
        `insert into app_user (id, workspace_id, issuer, subject, email, display_name, initials, role, status)
         values (gen_random_uuid(), $1, 'i', 's', 'a@x', 'A', 'A', 'reviewer', 'pending')`, [WS],
      )).rejects.toThrow(/check constraint/i);
    });
  });

  it('keys role_mapping on (issuer, group_value), so two issuers can name one role differently', async () => {
    await withPg(async t => {
      await t.query(
        `insert into role_mapping (workspace_id, issuer, group_value, role) values
           ($1, 'http://keycloak:8080/realms/lexprompt', 'partners', 'partner'),
           ($1, 'https://login.microsoftonline.com/t/v2.0', '8f2c1a55-0000-4000-8000-000000000002', 'partner')`,
        [WS],
      );
      const rows = await t.query<{ n: string }>("select count(*)::text n from role_mapping where role = 'partner'");
      expect(rows[0].n).toBe('2');
    }, migratorDb());
  });

  it('gives the app role what a request needs on app_user, and nothing on workspace', async () => {
    await withPg(async t => {
      await expect(t.query('select count(*) from app_user')).resolves.toBeDefined();
      await expect(t.query("insert into workspace (id, name) values (gen_random_uuid(), 'sneaky')"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });

  it('gives the app role no DELETE on app_user — disabling is the mechanism, not deletion', async () => {
    await withPg(async t => {
      await expect(t.query("delete from app_user where subject = 'nobody'"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:pg -- identity`
Expected: FAIL — `relation "workspace" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/001_identity.sql`:

```sql
-- gen_random_uuid() is core from Postgres 13; no extension is created,
-- because an extension is a privilege the app role would then have to be
-- granted around.

create table workspace (
  id         uuid primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

-- S9: one workspace now, and every table below carries workspace_id from day
-- one so a second tenant is a data-model no-op rather than a migration. The
-- id is FIXED rather than random because API_WORKSPACE_ID names it in both
-- environments, and a random seed would make that key unsettable.
insert into workspace (id, name)
values ('00000000-0000-0000-0000-000000000001', 'LexPrompt')
on conflict (id) do nothing;

create table app_user (
  id            uuid primary key,
  workspace_id  uuid not null references workspace(id),
  -- THE identity, and never the email (§7). An email can be reassigned; an
  -- issuer-scoped subject cannot. 'oid' under Entra, 'sub' under a standard
  -- issuer — opaque either way, and the two are never compared.
  issuer        text not null,
  subject       text not null,
  email         text,
  display_name  text not null,
  initials      text not null,
  role          text not null check (role in ('reviewer', 'partner', 'admin')),
  status        text not null check (status in ('active', 'disabled')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (issuer, subject)
);
create index app_user_workspace_idx on app_user (workspace_id);

-- The group-to-role table (§6.5). `group_value` is a Keycloak group NAME
-- locally and an Entra security-group OBJECT ID in a firm deployment; the
-- code reads a string from the configured groupsClaim and looks it up, and
-- does not know the difference (S28). The primary key carries the issuer
-- because the same string means different things under two issuers, and a
-- mapping without one would let a local group name grant a role in a tenant.
create table role_mapping (
  workspace_id uuid not null references workspace(id),
  issuer       text not null,
  group_value  text not null,
  role         text not null check (role in ('reviewer', 'partner', 'admin')),
  primary key (issuer, group_value)
);

-- §6.6: Settings.modelId becomes workspace configuration an admin sets from
-- the allowlist. One row per workspace, created lazily by the route.
create table workspace_setting (
  workspace_id        uuid primary key references workspace(id),
  model_choice_id     text,
  model_choice_label  text,
  model_choice_model  text,
  concurrency         int  not null default 5 check (concurrency between 1 and 20),
  version             bigint not null default 1,
  updated_at          timestamptz not null default now(),
  updated_by_user_id  uuid references app_user(id)
);

-- Grants (P10). The app role gets exactly what a request needs.
grant select on workspace to lexprompt_app;
grant select, insert, update on app_user to lexprompt_app;
-- role_mapping is SEEDED BY DEPLOYMENT CONFIGURATION in this stage and
-- administered from a screen in a later one, so the app role reads it and
-- does not write it. An admin route that could write it does not exist yet,
-- and the absent grant is what keeps that true rather than a comment.
grant select on role_mapping to lexprompt_app;
grant select, insert, update on workspace_setting to lexprompt_app;
-- No DELETE on app_user, deliberately: §7's admin power is to DISABLE a
-- user, and deleting one would orphan every attribution they authored.
-- `status` is the mechanism, and the absent grant is what makes it the only
-- one rather than the preferred one.
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test:pg -- identity`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation-test the three constraints that carry the design**

1. Change `unique (issuer, subject)` to `unique (subject)`. Expected: `lets the SAME subject exist under a DIFFERENT issuer` fails by name. Restore.
2. Drop `check (role in (...))` from `app_user`. Expected: `refuses a role outside the three` fails by name. Restore.
3. Add `grant delete on app_user to lexprompt_app;`. Expected: `gives the app role no DELETE on app_user` fails by name. Restore.

**Dropping a table between mutation runs:** the ledger is what makes a migration idempotent, so editing an applied file changes nothing on a re-run. Between mutations, `drop table if exists workspace_setting, role_mapping, app_user, workspace cascade; delete from schema_migration where version = '001_identity';` as the migrator, then re-run. Put that in the task report so the next person does not spend an hour on it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/001_identity.sql apps/api/test/identity.pg.test.ts
git commit -m "feat(api): workspace, app_user keyed on (issuer, subject), role_mapping keyed per issuer"
git show --stat HEAD
```

---

## Task 3: `app_user` just-in-time provisioning, and `GET /v1/me`

**Type:** feature

**Files:**
- Create: `packages/core/src/api/records.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/model/protocol.ts`
- Modify: `packages/core/test/importBoundary.test.ts` (extend the `exported` array — S14)
- Create: `apps/api/src/auth/actor.ts`
- Create: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/server.ts` (resolve the actor once, after `requireUser`)
- Modify: `apps/api/test/helpers/apiHarness.ts`
- Create: `apps/api/test/actor.pg.test.ts`, `apps/api/test/me.route.test.ts`

**Interfaces:**
- Consumes: `Principal` from **`apps/api/src/oidc.ts`** — `{ issuer, subject, groups, name?, email? }`. It is **not** in an `entra.ts`; two Stage 1 briefs said it was and neither compiled. `requireUser` and `ServerDeps` from `apps/api/src/server.ts`; `ModelError` from `@lexprompt/core`; Task 1's `Db`/`Tx`; Task 2's tables. **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `Actor`, `initialsFrom(name)`, `resolveActor(t, principal, role, workspaceId)`, `FastifyRequest.actor`, `ServerDeps.resolveActor`, `GET /v1/me`, `PUT /v1/me`, and `packages/core`'s `Role`, `ROLES`, `isRole`, `MeResponse`.

**Why the role is a parameter rather than something `resolveActor` derives:** Task 4 owns the group→role mapping and this task owns the row. Split, neither can quietly become the other, and this task's tests can drive every role without inventing a group claim.

- [ ] **Step 1: Write the failing test**

`apps/api/test/actor.pg.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { withPg } from './helpers/pgHarness.ts';
import { resolveActor } from '../src/auth/actor.ts';
import { ModelError } from '@lexprompt/core';
import type { Principal } from '../src/oidc.ts';

const WS = '00000000-0000-0000-0000-000000000001';
const principal = (over: Partial<Principal> = {}): Principal => ({
  issuer: 'http://keycloak:8080/realms/lexprompt',
  subject: 'kc-sub-1',
  groups: [],
  name: 'Ada Trainee',
  email: 'trainee@lexprompt.local',
  ...over,
});

describe('resolveActor', () => {
  it('creates a row on first sight, with the role it was given', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      expect(actor.role).toBe('reviewer');
      expect(actor.displayName).toBe('Ada Trainee');
      expect(actor.initials).toBe('AT');
      expect(actor.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  it('returns the SAME id on the second sight of the same (issuer, subject)', async () => {
    await withPg(async t => {
      const first = await resolveActor(t, principal(), 'reviewer', WS);
      const second = await resolveActor(t, principal({ email: 'renamed@lexprompt.local' }), 'reviewer', WS);
      expect(second.id).toBe(first.id);
      // The email moved and the identity did not — the whole argument for
      // keying on (issuer, subject) rather than on the email.
      expect(second.email).toBe('renamed@lexprompt.local');
    });
  });

  it('updates the role when the mapping has changed since the last sign-in', async () => {
    await withPg(async t => {
      await resolveActor(t, principal(), 'reviewer', WS);
      expect((await resolveActor(t, principal(), 'partner', WS)).role).toBe('partner');
    });
  });

  it('refuses a disabled account as its own thing, not as a sign-in failure', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      await t.query("update app_user set status = 'disabled' where id = $1", [actor.id]);
      const err = await resolveActor(t, principal(), 'reviewer', WS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe('account_disabled');
      expect((err as ModelError).status).toBe(403);
      // NOT sign_in_required: signing in again is exactly what a disabled
      // user would try, it would succeed, and they would meet the same
      // refusal forever — a loop the message would have caused.
    });
  });

  it('never lets a re-sign-in re-enable a disabled account', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      await t.query("update app_user set status = 'disabled' where id = $1", [actor.id]);
      await resolveActor(t, principal(), 'admin', WS).catch(() => undefined);
      const rows = await t.query<{ status: string }>('select status from app_user where id = $1', [actor.id]);
      expect(rows[0].status).toBe('disabled');
    });
  });

  it('still records last_seen_at for a disabled account that tried', async () => {
    // An administrator seeing "still trying, twice today" is the fact that
    // makes a disabled account actionable. Refusing before the write would
    // hide it.
    await withPg(async t => {
      const actor = await resolveActor(t, principal(), 'reviewer', WS);
      await t.query("update app_user set status = 'disabled', last_seen_at = '2000-01-01' where id = $1", [actor.id]);
      await resolveActor(t, principal(), 'reviewer', WS).catch(() => undefined);
      const rows = await t.query<{ y: string }>(
        "select to_char(last_seen_at, 'YYYY') y from app_user where id = $1", [actor.id]);
      expect(rows[0].y).not.toBe('2000');
    });
  });

  it('falls back to the email local part when the token carries no name', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal({ name: undefined }), 'reviewer', WS);
      expect(actor.displayName).toBe('trainee');
      expect(actor.initials).toBe('T');
    });
  });

  it('names the subject when there is neither a name nor an email, rather than showing nothing', async () => {
    await withPg(async t => {
      const actor = await resolveActor(t, principal({ name: undefined, email: undefined }), 'reviewer', WS);
      expect(actor.displayName).toBe('kc-sub-1');
      expect(actor.initials).toBe('K');
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:pg -- actor`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the shared wire vocabulary and the new error codes**

`packages/core/src/api/records.ts` — the first file in what becomes the shared record vocabulary. It exists so the browser and the server cannot disagree about a field name, which is S14 applied to a wire format:

```ts
/** The three roles (§7). A closed set, here, because both sides read it. */
export const ROLES = ['reviewer', 'partner', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Who the caller is, as the API answers it.
 *
 * `id` is the `app_user` row's uuid, and it is what every `*UserId` field in
 * a record holds from this stage onwards. `issuer` and `subject` travel WITH
 * it and are not replaced by it (§6.5): the gateway's Stage 1 call log
 * carries the pair and no user id, so a record written before this stage
 * stays joinable to the person who wrote it only while both are present.
 */
export interface MeResponse {
  id: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName: string;
  initials: string;
  role: Role;
  workspaceId: string;
}
```

In `packages/core/src/model/protocol.ts`, **append to** the existing `MODEL_ERROR_CODES` array — read it first and add; do not retype it:

```ts
  'account_disabled',   // 403 — an admin turned this account off. Signing in again changes nothing.
  'no_role',            // 403 — authenticated, in no mapped group. §7's "told plainly", not an empty app.
  'not_found',          // 404 — no such record in this workspace.
  'conflict',           // 409 — a stale write (P9), or an id already owned by another workspace.
```

Export `Role`, `ROLES`, `isRole` and `MeResponse` from `packages/core/src/index.ts`, and add all four to `packages/core/test/importBoundary.test.ts`'s `exported` array — that array is the S14 boundary, and a new export missing from it is invisible to the guard.

- [ ] **Step 4: Write `actor.ts`**

```ts
import { ModelError, type Role } from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';
import type { Principal } from '../oidc.ts';

export interface Actor {
  id: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName: string;
  initials: string;
  role: Role;
  workspaceId: string;
}

/**
 * A display name from the best thing the token actually carries.
 *
 * Never "Unknown" and never blank. An attribution line reading "Verified by
 * Unknown" is worse than one reading "Verified by kc-sub-1", because the
 * second is at least resolvable by an administrator. Order: the name claim,
 * the email's local part, then the subject itself.
 */
function nameFrom(p: Principal): string {
  if (p.name?.trim()) return p.name.trim();
  if (p.email?.includes('@')) return p.email.split('@')[0];
  if (p.email?.trim()) return p.email.trim();
  return p.subject;
}

/** Two letters from two or more words, one from a single word. Mirrors the
 *  local profile's own initials so a migrated matter's owner does not change
 *  shape when the uploader rewrites its attribution (P16). */
export function initialsFrom(displayName: string): string {
  const words = displayName.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Just-in-time provisioning (§7): a row is created on first successful
 * sign-in from the token's configured subject claim, its issuer, and its
 * name and email claims.
 *
 * ONE statement, deliberately. A read-then-write would let two tabs signing
 * in at once both see no row and both insert, and the unique constraint
 * would answer the loser with a duplicate-key error at sign-in — a hard
 * failure on the happy path, which is the exact race `getProfile`'s
 * in-flight memoisation exists to close one layer up.
 *
 * `status` is in the INSERT and NOT in the DO UPDATE list. A disabled
 * account that signs in again must stay disabled; including `status` there
 * would make re-authentication the undo button for an administrator's
 * decision, and nothing in the UI would ever show it happening.
 *
 * The disabled check reads the row the upsert RETURNED — after the write,
 * not before it. Refusing first would suppress `last_seen_at`, which is the
 * fact an administrator uses to see that a disabled person is still trying.
 */
export async function resolveActor(
  t: Tx, principal: Principal, role: Role, workspaceId: string,
): Promise<Actor> {
  const displayName = nameFrom(principal);
  const rows = await t.query<{
    id: string; email: string | null; display_name: string;
    initials: string; role: Role; status: string;
  }>(
    `insert into app_user
       (id, workspace_id, issuer, subject, email, display_name, initials, role, status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'active')
     on conflict (issuer, subject) do update set
       email        = excluded.email,
       display_name = excluded.display_name,
       initials     = excluded.initials,
       role         = excluded.role,
       last_seen_at = now()
     returning id, email, display_name, initials, role, status`,
    [workspaceId, principal.issuer, principal.subject, principal.email ?? null,
      displayName, initialsFrom(displayName), role],
  );
  const row = rows[0];
  if (row.status === 'disabled') {
    throw new ModelError(
      'Your LexPrompt account has been disabled by an administrator. Signing in again will '
      + 'not change this — your sign-in is working, and it is the account that is turned '
      + 'off. Ask an administrator to re-enable it.',
      'account_disabled', 403,
    );
  }
  return {
    id: row.id,
    issuer: principal.issuer,
    subject: principal.subject,
    email: row.email ?? undefined,
    displayName: row.display_name,
    initials: row.initials,
    role: row.role,
    workspaceId,
  };
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run test:pg -- actor`
Expected: PASS, 8 tests.

**Mutation:** add `status = 'active'` to the `do update set` list. Expected: `never lets a re-sign-in re-enable a disabled account` **and** `refuses a disabled account as its own thing` both fail by name. Restore.

- [ ] **Step 6: Resolve the actor once, in the server, and answer `/v1/me`**

Read the shipped `buildServer` before editing. It registers `registerInfer` and `registerInferStream`, and its one `preHandler` excludes `/healthz` by URL.

```ts
declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    /** Set by the SAME preHandler that sets `principal`, once, so no route
     *  resolves an actor of its own. A route reading `req.actor!` reads a
     *  value the hook guarantees; a route that resolved its own would be a
     *  second implementation of provisioning. */
    actor?: Actor;
  }
}
```

and, replacing the hook's body:

```ts
  const auth = requireUser(deps.verify);
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    await auth(req, reply);
    // `requireUser` answers the reply itself on failure and `reply.sent`
    // records that. Continuing past it would resolve an actor for a caller
    // that has already been refused — and would create an `app_user` row for
    // a token that did not validate.
    if (reply.sent) return;
    req.actor = await deps.resolveActor(req.principal!);
  });
```

`ServerDeps` gains `resolveActor(principal: Principal): Promise<Actor>` — injected, so a route test needs no database and so Task 4's role lookup has exactly one place to live. A `ModelError` thrown out of it is already answered verbatim by `registerErrorEnvelope`; confirm that by reading the shipped error handler rather than assuming.

`apps/api/src/routes/me.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { ModelError, type MeResponse } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { initialsFrom } from '../auth/actor.ts';

export function registerMe(app: FastifyInstance, db: Db): void {
  app.get('/v1/me', async (req): Promise<MeResponse> => {
    const a = req.actor!;
    return {
      id: a.id, issuer: a.issuer, subject: a.subject, email: a.email,
      displayName: a.displayName, initials: a.initials, role: a.role,
      workspaceId: a.workspaceId,
    };
  });

  // The one thing a person may change about themselves. Role, status, issuer
  // and subject are NOT here: a role a user can set is not a role.
  app.put<{ Body: { displayName?: unknown } }>('/v1/me', async (req): Promise<MeResponse> => {
    const a = req.actor!;
    const name = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    if (!name) throw new ModelError('A display name cannot be empty.', 'conflict', 400);
    const initials = initialsFrom(name);
    await db.query('update app_user set display_name = $2, initials = $3 where id = $1',
      [a.id, name, initials]);
    return {
      id: a.id, issuer: a.issuer, subject: a.subject, email: a.email,
      displayName: name, initials, role: a.role, workspaceId: a.workspaceId,
    };
  });
}
```

- [ ] **Step 7: Route tests**

Extend `apps/api/test/helpers/apiHarness.ts` with an `actor` option defaulting to a reviewer, passing a `resolveActor` stub into `buildServer`. **Read the shipped harness and extend it** — several Stage 1 suites depend on its current shape.

`apps/api/test/me.route.test.ts`, in the ordinary `api` project:

1. `GET /v1/me` with no bearer token → 401 `sign_in_required` (the hook, not the route).
2. `GET /v1/me` signed in → 200, and the body's `issuer`/`subject` are the token's. Send a request body naming a **different** subject and assert it is ignored. This is Stage 1 Task 17's overwrite property re-asserted at the one route that reports identity.
3. `PUT /v1/me` with `{ displayName: '  Ada Lovelace  ' }` → 200, `displayName` `'Ada Lovelace'`, `initials` `'AL'`.
4. `PUT /v1/me` with `{ displayName: '   ' }` → 400, **and** the fake `db.query` was not called.
5. `PUT /v1/me` with `{ displayName: 'Ada Lovelace', role: 'admin' }` → the response's `role` is unchanged **and** its `displayName` did change. The second assertion is what stops the first passing because the route ignored the whole body.
6. A `ModelError` thrown by `resolveActor` (an `account_disabled` stub) reaches the client as 403 with code `account_disabled`, not as a 500.

- [ ] **Step 8: Gates, then commit**

```bash
npm run typecheck > /tmp/tc.txt 2>&1; echo "EXIT=$?"; cat /tmp/tc.txt
npx vitest run > /tmp/t.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t.txt
npm run test:pg > /tmp/tp.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/tp.txt
```
Read the **exit codes**. `npx vitest run` reports every test PASSED and exits 1 on an unhandled rejection, which is how a missing stream `'error'` listener survived a Stage 1 task review.

```bash
git add packages/core/src/api packages/core/src/index.ts packages/core/src/model/protocol.ts \
  packages/core/test/importBoundary.test.ts apps/api/src/auth apps/api/src/routes/me.ts \
  apps/api/src/server.ts apps/api/test/actor.pg.test.ts apps/api/test/me.route.test.ts \
  apps/api/test/helpers/apiHarness.ts
git commit -m "feat(api): app_user provisioned just-in-time on (issuer, subject), and GET /v1/me"
git show --stat HEAD
```

---

## Task 4: The group claim becomes a role — against both issuers, from the day the table exists

**Type:** feature

**Files:**
- Create: `apps/api/src/auth/roles.ts`
- Modify: `apps/api/src/config.ts` (`API_ROLE_MAPPINGS`, seeded at startup)
- Modify: `apps/api/src/main.ts` (seed the mappings, then build `resolveActor`)
- Create: `apps/api/test/roles.pg.test.ts`, `apps/api/test/roleMappingConfig.test.ts`
- Modify: `docker-compose.yml`, `.env.example`, `azure.yaml`/`infra/modules/containerApps.bicep`

**Interfaces:**
- Consumes: `Principal.groups` (`string[]`, produced by `oidc.ts`'s `readGroups`, which **throws** a `service_misconfigured` `ModelError` on a claim shape it cannot read, and which nothing has read until now); `oidc.ts`'s `group_overage` `ModelError` (403, thrown before `Principal` is built); Task 3's `resolveActor`; Task 2's `role_mapping`. **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `roleFor(t, issuer, groups)`, `seedRoleMappings(db, workspaceId, mappings)`, `parseRoleMappings(raw)`, and the configuration key `API_ROLE_MAPPINGS`.

**The one behaviour whose input shape differs between the two issuers, and therefore the one that is tested against both from the start** (§13, §18 item 3). Keycloak's mapper is configured `full.path: false`, so its claim carries `["partners"]`; Entra's carries group **object ids**, `["8f2c1a55-…"]`. Nothing in the code knows which it is looking at, and the tests below are what proves that rather than assuming it.

- [ ] **Step 1: Write the failing test**

`apps/api/test/roles.pg.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { migratorDb, withPg } from './helpers/pgHarness.ts';
import { roleFor, seedRoleMappings, parseRoleMappings } from '../src/auth/roles.ts';

const WS = '00000000-0000-0000-0000-000000000001';
const KC = 'http://keycloak:8080/realms/lexprompt';
const ENTRA = 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0';

const seed = (t: Parameters<typeof seedRoleMappings>[0]) => seedRoleMappings(t, WS, [
  // Keycloak: bare group NAMES, because the realm's mapper sets
  // full.path=false. Read infra/keycloak/lexprompt-realm.json and confirm
  // before trusting this sentence.
  { issuer: KC, groupValue: 'reviewers', role: 'reviewer' },
  { issuer: KC, groupValue: 'partners', role: 'partner' },
  { issuer: KC, groupValue: 'admins', role: 'admin' },
  // Entra: security-group OBJECT IDS. Same table, same lookup, same code.
  { issuer: ENTRA, groupValue: '8f2c1a55-0000-4000-8000-000000000001', role: 'reviewer' },
  { issuer: ENTRA, groupValue: '8f2c1a55-0000-4000-8000-000000000002', role: 'partner' },
  { issuer: ENTRA, groupValue: '8f2c1a55-0000-4000-8000-000000000003', role: 'admin' },
]);

describe('roleFor, against both issuers', () => {
  it('maps a Keycloak group NAME to a role', async () => {
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, KC, ['partners'])).toBe('partner');
    }, migratorDb());
  });

  it('maps an Entra group OBJECT ID to a role, through the same code', async () => {
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, ENTRA, ['8f2c1a55-0000-4000-8000-000000000002'])).toBe('partner');
    }, migratorDb());
  });

  it('does NOT let one issuer group grant a role under the other issuer', async () => {
    // The reason the primary key carries the issuer. A local realm's group
    // name must be worth nothing in a tenant, and vice versa.
    await withPg(async t => {
      await seed(t);
      const err = await roleFor(t, ENTRA, ['admins']).catch((e: unknown) => e);
      expect((err as ModelError).code).toBe('no_role');
    }, migratorDb());
  });

  it('takes the HIGHEST role when a person is in several mapped groups', async () => {
    // admin > partner > reviewer. A person in reviewers and admins is an
    // admin: taking the lowest would mean adding a group could remove
    // access, which nobody would predict.
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, KC, ['reviewers', 'admins'])).toBe('admin');
      expect(await roleFor(t, KC, ['admins', 'reviewers'])).toBe('admin');
    }, migratorDb());
  });

  it('ignores unmapped groups alongside a mapped one', async () => {
    await withPg(async t => {
      await seed(t);
      expect(await roleFor(t, KC, ['all-staff', 'london-office', 'reviewers'])).toBe('reviewer');
    }, migratorDb());
  });

  it('refuses a user in no mapped group, plainly, and not as an empty app', async () => {
    await withPg(async t => {
      await seed(t);
      const err = await roleFor(t, KC, ['all-staff']).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe('no_role');
      expect((err as ModelError).status).toBe(403);
      expect((err as ModelError).message).toMatch(/administrator/i);
    }, migratorDb());
  });

  it('refuses an EMPTY group list the same way, and says which groups it saw', async () => {
    await withPg(async t => {
      await seed(t);
      const err = await roleFor(t, KC, []).catch((e: unknown) => e) as ModelError;
      expect(err.code).toBe('no_role');
      // Naming the groups is what makes the message actionable: an
      // administrator reading "you are in: all-staff" can map it; one
      // reading "no access" cannot do anything at all.
      expect(err.message).toMatch(/no groups/i);
    }, migratorDb());
  });
});

describe('parseRoleMappings', () => {
  it('reads issuer|group|role triples', () => {
    expect(parseRoleMappings(`${KC}|partners|partner, ${KC}|admins|admin`)).toEqual([
      { issuer: KC, groupValue: 'partners', role: 'partner' },
      { issuer: KC, groupValue: 'admins', role: 'admin' },
    ]);
  });
  it('refuses a role outside the three, naming the entry', () => {
    expect(() => parseRoleMappings(`${KC}|everyone|superuser`)).toThrow(/superuser/);
  });
  it('refuses a malformed entry rather than skipping it', () => {
    // Skipping is how a firm ends up with a partner group nobody mapped and
    // a partner who is told they have no access.
    expect(() => parseRoleMappings('not-a-triple')).toThrow(/issuer\|group\|role/);
  });
  it('reads an unset value as no mappings, which the API then refuses at startup', () => {
    expect(parseRoleMappings(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:pg -- roles` and `npx vitest run --project api roleMappingConfig`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `roles.ts`**

```ts
import { ModelError, isRole, type Role } from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';

export interface RoleMapping { issuer: string; groupValue: string; role: Role; }

/** admin > partner > reviewer. A person in several mapped groups gets the
 *  highest, because taking the lowest would mean ADDING a group could REMOVE
 *  access — an outcome nobody at a directory console would predict. */
const RANK: Record<Role, number> = { reviewer: 1, partner: 2, admin: 3 };

/**
 * `API_ROLE_MAPPINGS` is a comma-separated list of `issuer|group|role`.
 *
 * Shaped like `API_REQUIRED_CLAIMS`'s parser next door and for the same
 * reason: the API has no idea what a group value MEANS. A Keycloak group
 * name and an Entra group object id are both opaque strings here (S28).
 *
 * A malformed entry throws rather than being skipped. Skipping is how a firm
 * ends up with a partners group nobody mapped and a partner who is told,
 * confidently, that they have no access.
 */
export function parseRoleMappings(raw: string | undefined): RoleMapping[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  return trimmed.split(',').map(entry => {
    const parts = entry.split('|').map(s => s.trim());
    if (parts.length !== 3 || parts.some(p => !p)) {
      throw new Error(`API_ROLE_MAPPINGS entry ${JSON.stringify(entry)} is not "issuer|group|role".`);
    }
    const [issuer, groupValue, role] = parts;
    if (!isRole(role)) {
      throw new Error(
        `API_ROLE_MAPPINGS entry ${JSON.stringify(entry)} names the role ${JSON.stringify(role)}, `
        + 'which is not one of reviewer, partner, admin.',
      );
    }
    return { issuer, groupValue, role };
  });
}

/** Writes the configured mappings, replacing whatever a previous deployment
 *  configured for the same (issuer, group). Runs on the MIGRATOR connection
 *  at startup — the app role holds no write grant on this table (Task 2), so
 *  no request can change a role mapping in this stage. */
export async function seedRoleMappings(
  runner: Db | Tx, workspaceId: string, mappings: RoleMapping[],
): Promise<void> {
  for (const m of mappings) {
    await runner.query(
      `insert into role_mapping (workspace_id, issuer, group_value, role)
       values ($1, $2, $3, $4)
       on conflict (issuer, group_value) do update set role = excluded.role, workspace_id = excluded.workspace_id`,
      [workspaceId, m.issuer, m.groupValue, m.role],
    );
  }
}

/**
 * The group claim becomes a role, or the request is refused.
 *
 * `groups` comes from `oidc.ts`'s `readGroups`, which has already refused a
 * claim shape it could not read and has already raised `group_overage` for
 * an ABSENT claim with `_claim_names` beside it. So an empty array here
 * genuinely means "authenticated, in no group the token could carry", and
 * refusing it is correct — that distinction is the whole of §7's
 * missing-versus-empty rule, and it is upheld one module upstream. Do not
 * re-derive it here; there is exactly one place it lives.
 */
export async function roleFor(runner: Tx | Db, issuer: string, groups: string[]): Promise<Role> {
  if (groups.length > 0) {
    const rows = await runner.query<{ role: Role }>(
      'select role from role_mapping where issuer = $1 and group_value = any($2::text[])',
      [issuer, groups],
    );
    let best: Role | undefined;
    for (const row of rows) if (!best || RANK[row.role] > RANK[best]) best = row.role;
    if (best) return best;
  }
  throw new ModelError(
    'Your account is not in any group that LexPrompt maps to a role, so you have no access '
    + `to it yet. ${groups.length === 0
      ? 'Your sign-in carries no groups at all.'
      : `Your sign-in carries these groups: ${groups.join(', ')}.`} `
    + 'Ask an administrator to add one of them to the LexPrompt role mapping. This is not '
    + 'something signing in again will change.',
    'no_role', 403,
  );
}
```

**Note the message names the groups the token carried.** An administrator reading *"your sign-in carries these groups: all-staff, london-office"* can map one of them. One reading *"no access"* can do nothing, and the user will be back tomorrow.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test:pg -- roles`
Expected: PASS, 7 tests. And `npx vitest run --project api roleMappingConfig` → PASS, 4 tests.

- [ ] **Step 5: Configuration and startup**

`apps/api/src/config.ts` gains `roleMappings: RoleMapping[]` parsed by `parseRoleMappings(env.API_ROLE_MAPPINGS)`, **and refuses an empty list at startup**:

```ts
  const roleMappings = parseRoleMappings(env.API_ROLE_MAPPINGS);
  if (roleMappings.length === 0) {
    throw new ConfigError(
      'API_ROLE_MAPPINGS is not set. LexPrompt maps the issuer\'s group claim to its three '
      + 'roles, and with no mapping every user who signs in is told they have no access — '
      + 'a deployment that runs and refuses everybody. Set it to a comma-separated list of '
      + '"issuer|group|role", one per group your directory uses.',
    );
  }
```

Same posture as the gateway's jurisdiction refusal (P4) and the API's issuer refusal (S29): a misconfiguration must not become a system that runs and mostly works. **There is no default and none is shipped** — a default would be this plan guessing at a firm's directory.

`describeConfig` prints the mapping table at boot, one line per entry, so the answer to *"why can nobody sign in"* is in the first screen of logs.

`main.ts`, inside the migration `try` and on the **migrator** connection, before the pool is closed:

```ts
      await runMigrations(migratorDbHandle, migrationsDir);
      await seedRoleMappings(migratorDbHandle, config.workspaceId, config.roleMappings);
```

and `ServerDeps.resolveActor` is built as:

```ts
    resolveActor: async principal => db.tx(async t =>
      resolveActor(t, principal, await roleFor(t, principal.issuer, principal.groups), config.workspaceId)),
```

One transaction, so a person cannot be provisioned with a role that was removed between the two reads.

`docker-compose.yml`'s `api` gains `API_ROLE_MAPPINGS: ${OIDC_ROLE_MAPPINGS}`, and `.env.example`:

```
# issuer|group|role, comma separated. THERE IS NO DEFAULT: the API refuses to
# start unset, because a deployment with no mapping refuses every user.
# The seeded realm's three groups (infra/keycloak/lexprompt-realm.json), which
# its mapper emits as bare names because full.path is false:
OIDC_ROLE_MAPPINGS=http://localhost:8088/realms/lexprompt|reviewers|reviewer,http://localhost:8088/realms/lexprompt|partners|partner,http://localhost:8088/realms/lexprompt|admins|admin
```

**The issuer in each entry must be the one the API validates** — `OIDC_ISSUER_BROWSER`, the published address, not the container-network one. Stage 1's critical defect `9fde55f` was exactly this pair of strings being confused, and this is a second place where getting it wrong produces "you have no access" for everybody with no clue why. Consider interpolating `${OIDC_ISSUER_BROWSER}` into the value rather than repeating the literal, and say in `.env.example` why.

- [ ] **Step 6: Run the stack and sign in as each seeded account**

```bash
npm run compose:up
docker compose logs api | grep -A5 'Role mappings'
```
Then, in a browser, for each of `trainee`, `partner`, `admin`, `nogroups` (passwords are the usernames; `scripts/print-local-accounts.sh` prints them): sign in and call `GET /api/v1/me` from the browser console with the access token.

Expected: three 200s carrying `reviewer` / `partner` / `admin`; one 403 carrying `no_role` whose message names `nogroups`'s actual groups. **The fourth account is the point** — Stage 1 seeded it deliberately and deferred its behaviour to this stage.

Write down which of these you actually ran. If a live sign-in was not possible, say so plainly rather than implying it: Stage 1's Task 19 report did exactly that and it was the right call.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/roles.ts apps/api/src/config.ts apps/api/src/main.ts \
  apps/api/test/roles.pg.test.ts apps/api/test/roleMappingConfig.test.ts \
  docker-compose.yml .env.example azure.yaml infra/modules/containerApps.bicep
git commit -m "feat(api): map the issuer's group claim to a role, exercised against both issuers"
git show --stat HEAD
```

---

## Task 5: `requireRole`, and a route table a new route cannot escape

**Type:** feature

**Files:**
- Create: `apps/api/src/auth/requireRole.ts`
- Create: `apps/api/src/auth/routeTable.ts`
- Create: `apps/api/test/authz.route.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: Task 3's `Actor` and `FastifyRequest.actor`; `Role`/`ROLES` from `@lexprompt/core`; Fastify's `FastifyInstance`. **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `registerRoleGate(app)` (in `requireRole.ts` — the file is named for the rule, the export for what it does to a server), `ROUTE_POLICY`, `routeKey(method, url)`, and the build-failing coverage test. **There is deliberately no `requireRole(min)` decorator to attach per route** — see Step 3 for why a hook beats an opt-in.

**§7's sentence, in one place:** *"The web app hides what a role cannot do, because a dead button is bad design; the API refuses it, because a hidden button is not a security control. §14's authorisation suite is table-driven over the route list, so a new route with no entry fails the build rather than shipping open."*

- [ ] **Step 1: Write the failing test**

`apps/api/test/authz.route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ROLES, type Role } from '@lexprompt/core';
import { buildTestServer } from './helpers/apiHarness.ts';
import { ROUTE_POLICY, routeKey } from '../src/auth/routeTable.ts';

/** Every route the server actually registers, read from Fastify itself
 *  rather than from a list somebody maintains. */
async function registeredRoutes(): Promise<string[]> {
  const app = buildTestServer();
  await app.ready();
  const found: string[] = [];
  // `printRoutes` is a tree; `app.routes` is not public API in Fastify 5.
  // Use the onRoute hook instead — see the implementation note in Step 3.
  for (const { method, url } of collectRoutes(app)) {
    if (url === '/healthz') continue;
    found.push(routeKey(method, url));
  }
  await app.close();
  return found;
}

describe('every route has a declared minimum role', () => {
  it('finds a realistic number of routes (a scanner that matches nothing passes vacuously)', async () => {
    expect((await registeredRoutes()).length).toBeGreaterThan(3);
  });

  it('has a policy entry for every registered route', async () => {
    const missing = (await registeredRoutes()).filter(k => !(k in ROUTE_POLICY));
    // A new route with no entry FAILS THE BUILD. That is the whole mechanism:
    // the default is not "reviewer", it is "you have not decided yet".
    expect(missing).toEqual([]);
  });

  it('has no policy entry for a route that does not exist', async () => {
    const routes = new Set(await registeredRoutes());
    expect(Object.keys(ROUTE_POLICY).filter(k => !routes.has(k))).toEqual([]);
  });
});

describe('the API refuses, rather than the UI hiding', () => {
  const cases: { key: string; allowed: Role[] }[] = [
    { key: 'POST /v1/playbooks/:id/versions', allowed: ['partner', 'admin'] },
    { key: 'POST /v1/changesets/:id/publish', allowed: ['partner', 'admin'] },
    { key: 'PUT /v1/workspace/settings', allowed: ['admin'] },
    { key: 'GET /v1/matters', allowed: ['reviewer', 'partner', 'admin'] },
  ];

  for (const { key, allowed } of cases) {
    for (const role of ROLES) {
      const should = allowed.includes(role) ? 'allows' : 'refuses';
      it(`${should} a ${role} at ${key}`, async () => {
        const [method, url] = key.split(' ');
        const app = buildTestServer({ actor: { role } });
        const res = await app.inject({ method, url: url.replace(':id', 'x'), payload: {} });
        if (allowed.includes(role)) {
          expect(res.statusCode).not.toBe(403);
        } else {
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('not_permitted');
          // The message must name what is needed. "Forbidden" sends a
          // trainee to a support queue with nothing to say.
          expect(res.json().error.message).toMatch(/partner|administrator/i);
        }
        await app.close();
      });
    }
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project api authz`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route table and the gate**

Collecting registered routes: Fastify 5 has no stable `app.routes`, and `printRoutes()` returns a formatted tree that is a poor thing to parse. Use the `onRoute` hook, which fires once per registration:

```ts
// in apps/api/test/helpers/apiHarness.ts
export function collectRoutes(app: FastifyInstance): { method: string; url: string }[] {
  // Populated by an onRoute hook the harness installs BEFORE registering
  // anything. Reading Fastify's internals instead would break on a minor
  // upgrade and the failure would be "no routes found", which passes
  // vacuously — hence the length assertion in the suite above.
  return (app as unknown as { __routes: { method: string; url: string }[] }).__routes;
}
```

`apps/api/src/auth/routeTable.ts`:

```ts
import type { Role } from '@lexprompt/core';

/** `GET /v1/matters/:id` — the method and Fastify's own URL pattern, so the
 *  key a route registers under and the key the table names are the same
 *  string and cannot drift into two vocabularies. */
export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * The minimum role for every route. **There is no default.** A route absent
 * from this table fails `authz.route.test.ts`, which fails the build — the
 * mechanism §7 asks for, and the reason the type below is a total record
 * rather than a lookup with a fallback.
 *
 * `reviewer` covers most of the app because §7 says so: a reviewer creates
 * and edits matters, documents, collections and reviews, runs reviews, sets
 * dispositions, notes, assigns, confirms net positions, edits playbook
 * drafts, brings in precedent documents and exports. What a reviewer cannot
 * do is publish a playbook version (partner) or change workspace
 * configuration and role mapping (admin).
 */
export const ROUTE_POLICY: Record<string, Role> = {
  'GET /v1/me': 'reviewer',
  'PUT /v1/me': 'reviewer',
  'POST /v1/infer': 'reviewer',
  'POST /v1/infer/stream': 'reviewer',
  'GET /v1/models': 'reviewer',
  // …one line per route, added by the task that registers it…
  'POST /v1/playbooks/:id/versions': 'partner',
  'POST /v1/changesets/:id/publish': 'partner',
  'GET /v1/workspace/settings': 'reviewer',
  'PUT /v1/workspace/settings': 'admin',
};
```

`apps/api/src/auth/requireRole.ts`:

```ts
import { ModelError, type Role } from '@lexprompt/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ROUTE_POLICY, routeKey } from './routeTable.ts';

const RANK: Record<Role, number> = { reviewer: 1, partner: 2, admin: 3 };
const NEEDED: Record<Role, string> = {
  reviewer: 'a LexPrompt role',
  partner: 'the partner role',
  admin: 'an administrator',
};

/**
 * One hook, reading the table, applied to every route.
 *
 * Deliberately NOT a per-route decorator. A decorator is opt-in, and a route
 * whose author forgot it ships open — which is the exact failure §7's
 * table-driven suite exists to make impossible. Here the hook runs for every
 * route and a missing entry is a startup refusal, so "forgot" is not a state
 * this server can be in.
 */
export function registerRoleGate(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (req.url === '/healthz') return;
    const key = routeKey(req.method, req.routeOptions.url ?? req.url);
    const required = ROUTE_POLICY[key];
    if (!required) {
      // A route with no policy entry refuses EVERYTHING rather than
      // allowing it. The build test above is what stops this ever being
      // reached; this is what happens if it somehow is.
      throw new ModelError(
        `LexPrompt has no authorisation policy for ${key}. This is a deployment fault, not `
        + 'something you can fix.', 'service_misconfigured', 503,
      );
    }
    const actor = req.actor!;
    if (RANK[actor.role] < RANK[required]) {
      throw new ModelError(
        `This needs ${NEEDED[required]}, and your LexPrompt role is ${actor.role}. `
        + 'Ask a colleague with that role, or ask an administrator to change yours.',
        'not_permitted', 403,
      );
    }
  });
}
```

`req.routeOptions.url` is Fastify 5's pattern (`/v1/matters/:id`); **verify that against the installed version** — it was `req.routerPath` in Fastify 3 and `req.routeOptions.url` in 4/5, and reading the wrong one yields `undefined`, which would make every route hit the "no policy" branch. That failure is loud, which is the right direction, but it is worth ten seconds of reading rather than a debugging session.

Register it in `buildServer` **after** the actor hook — Fastify runs `preHandler` hooks in registration order, and this one reads `req.actor`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --project api authz`
Expected: PASS. Route-policy coverage plus 12 role cases.

- [ ] **Step 5: Mutation-test the gate three ways**

1. Delete one entry from `ROUTE_POLICY`. Expected: `has a policy entry for every registered route` fails, naming the key. Restore.
2. Change `RANK[actor.role] < RANK[required]` to `<=`. Expected: several `allows a …` cases fail. Restore.
3. Change the "no policy entry" branch from `throw` to `return`. Expected: `has a policy entry for every registered route` still passes (it is a different test), so **write the mutation's own test if none fails**: a route registered in the harness with no policy entry must be refused at request time. This is Stage 1's Task 15 lesson exactly — a security control tested only in isolation is not tested where it matters, and the implementer there had to write the missing test rather than report the mutation as unkilled.

- [ ] **Step 6: The absence of a bypass, mutation-tested**

Add to `apps/api/test/authz.route.test.ts`:

```ts
describe('there is no way to turn authorisation off (S29)', () => {
  it('no environment key anywhere disables auth or overrides a role', () => {
    const sources = [...walk(path.join(ROOT, 'apps/api/src')), ...walk(path.join(ROOT, 'src'))];
    const offenders: string[] = [];
    for (const file of sources) {
      const code = codeOf(file);
      if (/SKIP_AUTH|DISABLE_AUTH|AUTH_BYPASS|ALLOW_ANONYMOUS|FORCE_ROLE|ROLE_OVERRIDE/i.test(code)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
    // The scanner must be able to find something, or this assertion is
    // decoration. Stage 1 shipped a scanner that matched nothing.
    expect(sources.length).toBeGreaterThan(100);
  });
});
```

**Mutation:** add `const SKIP_AUTH = false;` to any file under `apps/api/src`. Expected: this test fails naming that file. Restore.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/requireRole.ts apps/api/src/auth/routeTable.ts \
  apps/api/src/server.ts apps/api/test/authz.route.test.ts apps/api/test/helpers/apiHarness.ts
git commit -m "feat(api): a route table with no default, and a role gate a new route cannot escape"
git show --stat HEAD
```

---

## Task 6: `actorUserId` on the gateway's audit record — alongside the pair, never replacing it

**Type:** feature

**Files:**
- Modify: `apps/gateway/src/audit.ts` (`AuditStart` gains one optional field)
- Modify: `apps/gateway/src/routes/infer.ts`, `apps/gateway/src/routes/inferStream.ts`, `apps/gateway/src/callModel.ts` (whichever carry `CallContext` — read them)
- Modify: `apps/api/src/routes/infer.ts`, `apps/api/src/routes/inferStream.ts`, `apps/api/src/actorBody.ts`
- Modify: `apps/gateway/test/audit.test.ts`, `apps/api/test/infer.route.test.ts`, `apps/api/test/inferStream.pipe.test.ts`

**Interfaces:**
- Consumes: `AuditStart`, `AuditStartInput`, `AuditFinish`, `AuditRecord`, `AuditSink`, `AuditLogger` from `apps/gateway/src/audit.ts`; `withActor()` from `apps/api/src/actorBody.ts` (Stage 1's Task 18 extraction — the spread-then-overwrite that stops a client naming its own actor); `CallContext` and `prepare` from `apps/gateway/src/callModel.ts`. **Read all of these; where they disagree with this brief, the shipped source wins.** Stage 1's ledger records that `prepare` omitted `purpose` from `AdapterRequest` in production while a hand-built test object supplied it — so check what `withActor` actually spreads rather than trusting its name.
- Produces: `AuditStart.actorUserId?: string`, and `withActor` carrying it.

**This is the whole of Stage 1's interface note 3, and its wording is the requirement:** *"`AuditStart` should then gain `actorUserId` **alongside** `actorIssuer`/`actorSubject` rather than replacing them, so records written before and after Stage 2 remain joinable."* The spec says the same at §6.5 and at line 679. A record written in Stage 1 has the pair and no id; a record written now has all three; a query joining the gateway's call log to `app_user` works across both only while the pair survives.

- [ ] **Step 1: Write the failing test**

In `apps/gateway/test/audit.test.ts`:

```ts
it('carries actorUserId ALONGSIDE actorIssuer and actorSubject, never instead of them', async () => {
  const { sink, lines } = capturingSink();
  const logger = makeAuditLogger(sink);
  await logger.start({ ...baseStart(), actorIssuer: 'https://iss', actorSubject: 'sub-9',
    actorUserId: '3f1c0f9e-0000-4000-8000-000000000001' });
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  expect(record.actorIssuer).toBe('https://iss');
  expect(record.actorSubject).toBe('sub-9');
  expect(record.actorUserId).toBe('3f1c0f9e-0000-4000-8000-000000000001');
});

it('still writes a complete record when there is no actorUserId — a Stage 1 caller', async () => {
  // Not hypothetical: the gateway is versioned separately from the API and
  // an older api may be in flight during a rolling deploy. A record missing
  // its user id must still name WHO through the pair, or the call is
  // unattributable and the log stops being evidence.
  const { sink, lines } = capturingSink();
  await makeAuditLogger(sink).start({ ...baseStart(), actorIssuer: 'https://iss', actorSubject: 'sub-9' });
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  expect(record.actorSubject).toBe('sub-9');
  expect('actorUserId' in record).toBe(false);
});
```

and in `apps/api/test/infer.route.test.ts`:

```ts
it('sends the actor id from the TOKEN-derived actor, overwriting anything the client sent', async () => {
  const app = buildTestServer({ actor: { id: 'server-side-id', issuer: 'https://iss', subject: 'sub-9' } });
  await app.inject({ method: 'POST', url: '/v1/infer', payload: {
    ...validBody, actorUserId: 'i-am-someone-else', actorSubject: 'also-not-me',
  } });
  expect(forwarded.body.actorUserId).toBe('server-side-id');
  expect(forwarded.body.actorSubject).toBe('sub-9');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway audit` and `npx vitest run --project api infer.route`
Expected: FAIL — `actorUserId` is not a property of `AuditStartInput`.

- [ ] **Step 3: Add the field**

In `apps/gateway/src/audit.ts`, add to `AuditStart` / `AuditStartInput`:

```ts
  /**
   * The `app_user.id` of the person who made this call, from Stage 2 onward.
   *
   * ALONGSIDE `actorIssuer`/`actorSubject`, never in place of them (§6.5).
   * Stage 1 wrote the pair and no id, so a query joining this log to
   * `app_user` spans both eras only while the pair survives — and a rolling
   * deploy can put a Stage 1 `api` in front of this gateway for minutes,
   * which is why the field is OPTIONAL rather than required.
   *
   * Optional here does NOT mean optional at the API: `apps/api` always sets
   * it, and its own route tests assert that.
   */
  actorUserId?: string;
```

In `apps/api/src/actorBody.ts`'s `withActor`, add `actorUserId: principal-derived-actor.id` **after** the spread, in the same named-properties block that already carries `actorIssuer` and `actorSubject`. Read the shipped function: its guarantee is `{ ...client, workspaceId, actorIssuer, actorSubject }` — spread first, named properties after, **no `??` or `||` anywhere on that path**. Add the fourth name in the same style. `withActor` now needs the `Actor`, not just the `Principal`; change its parameter and let the type checker find both call sites.

- [ ] **Step 4: Run and watch it pass, then mutate**

**Mutation:** reorder the spread in `withActor` so the client's properties win. Expected: **three** named tests fail — the two Stage 1 ones (`OVERWRITES a client-supplied actor rather than trusting it`, one per route) plus the new one. Stage 1's ledger records the extraction making that guarantee stronger, not merely preserved; this task must keep it that way and the report should say how many fail.

**Second mutation:** replace `actorIssuer`/`actorSubject` with `actorUserId` alone in `AuditStart`. Expected: `still writes a complete record when there is no actorUserId` fails, and so does the alongside test. This is the mutation that proves the spec's "alongside, never replacing" is enforced rather than intended.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/audit.ts apps/gateway/test/audit.test.ts apps/api/src/actorBody.ts \
  apps/api/src/routes/infer.ts apps/api/src/routes/inferStream.ts \
  apps/api/test/infer.route.test.ts apps/api/test/inferStream.pipe.test.ts
git commit -m "feat(gateway): audit records carry actorUserId alongside (issuer, subject), never instead"
git show --stat HEAD
```

---

## Task 7: The browser's one HTTP transport, and what `describeLoadError` must now distinguish

**Type:** feature

**Files:**
- Create: `src/lib/api/client.ts`, `src/lib/api/client.test.ts`
- Modify: `src/lib/loadError.ts`, `src/lib/loadError.test.ts`
- Modify: `vitest.setup.ts` (a default `fetch` stub, as `oidc-client-ts` is already stubbed there)

**Interfaces:**
- Consumes: `config.apiBaseUrl` from `src/lib/config.ts`; `getAccessToken()` from `src/lib/auth/oidc.ts`; `ModelError`, `isModelErrorCode` from `@lexprompt/core`; `DbBlockedError`, `DbOpenTimeoutError` from `src/lib/db/open.ts`; `UnconvertedPlaybookError` from `src/lib/db/playbookMigration.ts`. **Read the shipped source; where it disagrees with this brief, the shipped source wins** — in particular `gatewayModelClient.ts`'s `toModelError` and `codeFromStatus`, which this transport must not reimplement.
- Produces: `apiGet<T>(path)`, `apiSend<T>(method, path, body)`, `apiSendBlob<T>(path, form)`, `apiGetBlob(path)`, `apiDelete(path)`, and the extended `describeLoadError`.

**The sibling-drift risk this task exists to close.** `gatewayModelClient.ts` already turns a failed `Response` into a `ModelError`, already maps 401/403 by status when the body names no code, and already carries the reasoning for both (an ingress can answer 401 with HTML; `openrouter.ts`'s `isAuthError` was `401 || 403` and that half is deliberately restored). A second transport that re-derived any of that would be Stage 1's `SERVICE_CONFIG_HINT` finding all over again — five copies of one sentence across three workspaces, with nothing making them agree. **So `toModelError` and `codeFromStatus` move out of `gatewayModelClient.ts` into `src/lib/api/client.ts`, and `gatewayModelClient.ts` imports them.** Extract at the second copy, not the third.

- [ ] **Step 1: Write the failing test**

`src/lib/api/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { apiGet, apiSend, apiDelete, makeApiClient } from './client';

const token = () => Promise.resolve('tok-123');

describe('the repository transport', () => {
  it('sends the bearer token and the JSON content type', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const api = makeApiClient({ baseUrl: 'https://x/api', getToken: token, fetch: fetchSpy });
    await api.send('PUT', '/v1/matters/m1', { id: 'm1' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x/api/v1/matters/m1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"id":"m1"}');
  });

  it('returns null for a 404 on a get-or-null, and does NOT throw', async () => {
    // `getMatter` and friends return `T | null` today and callers rely on it.
    // A 404 that threw would turn "no such matter" into a red error panel.
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 404 })) });
    expect(await api.getOrNull('/v1/matters/gone')).toBeNull();
  });

  it('throws a ModelError carrying the body code for a refusal', async () => {
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: { code: 'not_permitted', message: 'This needs the partner role.' } }),
        { status: 403, headers: { 'content-type': 'application/json' } })) });
    const err = await api.get('/v1/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe('not_permitted');
    expect((err as ModelError).message).toContain('partner role');
  });

  it('falls back to the STATUS when the body is not ours — an ingress 401 is still a sign-in problem', async () => {
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockResolvedValue(new Response('<html>Unauthorized</html>', { status: 401 })) });
    const err = await api.get('/v1/x').catch((e: unknown) => e) as ModelError;
    expect(err.code).toBe('sign_in_required');
  });

  it('reports a transport failure as `network`, not as an empty result', async () => {
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });
    const err = await api.get('/v1/x').catch((e: unknown) => e) as ModelError;
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/could not reach/i);
  });

  it('lets an abort through as an abort, never as a network failure', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockRejectedValue(abort) });
    await expect(api.get('/v1/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not send a body on DELETE, and treats 204 as success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = makeApiClient({ baseUrl: '/api', getToken: token, fetch: fetchSpy });
    await expect(api.del('/v1/matters/m1')).resolves.toBeUndefined();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).body).toBeUndefined();
  });

  it('refuses to send when no access token can be obtained, rather than sending an unauthenticated request', async () => {
    // An unauthenticated request would be answered 401 and would look
    // identical to an expired session — sending the user round a sign-in
    // loop that cannot terminate. Stage 1's Task 19 mutation found exactly
    // this gap on `getAccessToken` returning empty.
    const fetchSpy = vi.fn();
    const api = makeApiClient({ baseUrl: '/api', getToken: async () => '', fetch: fetchSpy });
    const err = await api.get('/v1/x').catch((e: unknown) => e) as ModelError;
    expect(err.code).toBe('sign_in_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project web src/lib/api/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Move `toModelError`/`codeFromStatus` and write the client**

Cut `codeFromStatus` and `toModelError` out of `src/lib/model/gatewayModelClient.ts` **with their comments intact** — those comments carry the reasoning for the 401/403 status fallback and for checking `body.error.code` against `MODEL_ERROR_CODES` rather than casting — into `src/lib/api/client.ts`, and import them back in `gatewayModelClient.ts`. Its own tests must pass unedited; if any assertion has to move, that is a finding, not a chore.

```ts
import { ModelError } from '@lexprompt/core';
import { getAccessToken } from '../auth/oidc';
import { config } from '../config';

// …codeFromStatus and toModelError, moved verbatim from gatewayModelClient.ts…
export { codeFromStatus, toModelError };

export interface ApiDeps {
  baseUrl: string;
  getToken(): Promise<string>;
  fetch: typeof globalThis.fetch;
}

export interface ApiClient {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  /** For the repository reads that answer `T | null`. A 404 is "no such
   *  record", which is a fact, not a failure — `getDocumentBlob`'s docstring
   *  makes the same distinction and gives the same reason. */
  getOrNull<T>(path: string, signal?: AbortSignal): Promise<T | null>;
  send<T>(method: 'PUT' | 'POST' | 'PATCH', path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  sendForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T>;
  getBlobOrNull(path: string, signal?: AbortSignal): Promise<Blob | null>;
  del(path: string, signal?: AbortSignal): Promise<void>;
}

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

export function makeApiClient(deps: ApiDeps): ApiClient {
  async function call(method: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const token = await deps.getToken();
    if (!token) {
      // Never send an unauthenticated request. It would be answered 401 and
      // would be indistinguishable from an expired session, which is a
      // sign-in loop with no exit — the shape Stage 1's Task 19 mutation
      // found on `getAccessToken` resolving empty rather than rejecting.
      throw new ModelError(
        'You are not signed in to LexPrompt. Sign in again to continue.',
        'sign_in_required', 401,
      );
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.body !== undefined && !(init.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      return await deps.fetch(`${deps.baseUrl}${path}`, { ...init, method, headers, signal });
    } catch (err) {
      // An abort is a cancellation and must propagate as one: swallowing it
      // into a network error would make a user's navigation look like a
      // failure of the firm's service.
      if (isAbort(err)) throw err;
      throw new ModelError(
        `LexPrompt could not reach your firm's service (${(err as Error).message}). Your work `
        + 'is on the server, not in this browser, so nothing is lost — but nothing can be '
        + 'read or saved until the connection is back.',
        'network', 0,
      );
    }
  }
  // …get / getOrNull / send / sendForm / getBlobOrNull / del, each calling
  // `call` and each throwing `await toModelError(response)` when
  // `!response.ok` (with `getOrNull`/`getBlobOrNull` returning null on 404
  // FIRST, before that check)…
  return { /* … */ } as ApiClient;
}

/** The app's one instance. A second `makeApiClient` call in `src/` is a
 *  second transport and is what `client.test.ts`'s wiring case forbids. */
export const api: ApiClient = makeApiClient({
  baseUrl: config.apiBaseUrl,
  getToken: getAccessToken,
  fetch: (...args) => globalThis.fetch(...args),
});
```

The elided methods are mechanical; write them out in full and do not leave the ellipsis in the shipped file. `sendForm` must **not** set `Content-Type` — the browser sets the multipart boundary itself, and setting it by hand produces a body the server cannot parse, with an error that names neither cause.

- [ ] **Step 4: Run, watch it pass, mutate**

**Mutation 1:** delete the empty-token guard. Expected: `refuses to send when no access token can be obtained` fails by name.
**Mutation 2:** make `getOrNull` throw on 404. Expected: `returns null for a 404 on a get-or-null` fails by name.
**Mutation 3:** remove the `isAbort` re-throw. Expected: `lets an abort through as an abort` fails by name.

- [ ] **Step 5: Extend `describeLoadError` for the states a network adds**

`src/lib/loadError.ts` keeps its signature and its three existing pass-through classes — **`DbBlockedError`, `DbOpenTimeoutError` and `UnconvertedPlaybookError` stay**, because the uploader (Tasks 21–22) is still an IndexedDB reader and still meets all three. It gains one branch:

```ts
/**
 * …existing docstring, kept…
 *
 * A `ModelError` joins them, and for the same reason each of the others is
 * here: it already carries a specific, user-facing message that the generic
 * fallback cannot produce. "This needs the partner role" and "you are not
 * signed in" and "LexPrompt could not reach your firm's service" are three
 * different instructions, and folding any of them into "the matters could
 * not be loaded. Try again." would leave a reader retrying something that
 * will keep failing — which is the failure `DbBlockedError` was added here
 * to prevent, one transport later.
 *
 * The fourth load state, `stale`, arrives with realtime in Stage 4 and is
 * deliberately NOT here: nothing in Stage 2 can be stale, because nothing
 * pushes.
 */
export function describeLoadError(e: unknown, fallback: string): string {
  if (
    e instanceof DbBlockedError
    || e instanceof UnconvertedPlaybookError
    || e instanceof DbOpenTimeoutError
    || e instanceof ModelError
  ) return e.message;
  return fallback;
}
```

Add to `src/lib/loadError.test.ts`: a `ModelError` with each of `sign_in_required`, `not_permitted`, `network` and `service_misconfigured` returns its own message; a bare `Error` still returns the fallback. **The last case is what stops the new branch swallowing everything** and it already exists — confirm it still passes unedited.

- [ ] **Step 6: A guard against a second transport**

Add to `src/lib/api/client.test.ts`:

```ts
it('is the only place src/ calls fetch (a second transport is a second error vocabulary)', async () => {
  const files = await import('node:fs').then(fs =>
    fs.readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx')));
  expect(files.length).toBeGreaterThan(80);   // the scanner finds something
  const offenders = files.filter(f => {
    if (f === 'lib/api/client.ts') return false;
    // `gatewayModelClient.ts` takes `fetch` as an INJECTED dependency and
    // does not reach for the global; that is the shape allowed here.
    const code = readFileSync(`src/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return /\b(globalThis\.fetch|window\.fetch)\b/.test(code);
  });
  expect(offenders).toEqual([]);
});
```

**Mutation:** add `void globalThis.fetch;` to `src/lib/documents.ts`. Expected: fails naming that file. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api src/lib/loadError.ts src/lib/loadError.test.ts \
  src/lib/model/gatewayModelClient.ts vitest.setup.ts
git commit -m "feat(web): one HTTP transport for the repositories, sharing the gateway client's error vocabulary"
git show --stat HEAD
```

---

## Task 8: Migration 002 — the record tables, `workspace_id` everywhere, and the immutability grant

**Type:** schema

**Files:**
- Create: `apps/api/migrations/002_records.sql`
- Create: `apps/api/test/records.pg.test.ts`, `apps/api/test/grants.pg.test.ts`
- Create: `apps/api/src/db/rows.ts`, `apps/api/test/rows.test.ts`

**Interfaces:**
- Consumes: Task 1's `Db`/`Tx`/harness; Task 2's `workspace` and `app_user`; `src/types.ts`'s `Matter`, `DocumentRecord`, `Collection`, `Playbook`, `PlaybookVersion`, `Review`, `Changeset`, `PlaybookDraft`, `Finding`. **Read `src/types.ts`; where it disagrees with this brief, it wins** — it is 511 lines and several fields are optional-and-absent-on-purpose.
- Produces: the seven record tables and their grants; `rows.ts`'s `toMatterRow`/`fromMatterRow` family and the shared `absentUnless` helper.

**`document` is created here without a `kind` column.** It gains one in migration `003`, in Task 19, **with** the copy change — S24 is explicit that the storage and the sentence ship together, and a `kind` column whose `'precedent'` value nothing can write is close enough to the line that it is simply kept on the other side of it.

- [ ] **Step 1: Write the failing test**

`apps/api/test/records.pg.test.ts` — the shape below repeats per table; write all seven:

```ts
import { describe, it, expect } from 'vitest';
import { migratorDb, withPg } from './helpers/pgHarness.ts';

const WS = '00000000-0000-0000-0000-000000000001';

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

describe('002_records', () => {
  it('every record table carries workspace_id NOT NULL', async () => {
    const rows = await migratorDb().query<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname in ('matter','document','collection','playbook','playbook_version','review','changeset')
         and not exists (
           select 1 from information_schema.columns col
            where col.table_name = c.relname and col.column_name = 'workspace_id'
              and col.is_nullable = 'NO')
    `);
    // S9 is a property of every table or of none: one table without the
    // column is one query that cannot be scoped, and it would be the query
    // nobody thought about.
    expect(rows.map(r => r.table_name)).toEqual([]);
  });

  it('refuses an owner_id that is not a real user', async () => {
    await withPg(async t => {
      await expect(t.query(
        `insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
         values ('m1', $1, 'M', gen_random_uuid(), now(), now())`, [WS],
      )).rejects.toThrow(/foreign key/i);
    });
  });

  it('accepts a NULL owner_id — an unattributed import is not the uploader', async () => {
    // P16: `importPlaybook(json, byUserId = '')` produces an empty
    // attribution today, and the uploader maps it to NULL rather than
    // claiming the person doing the upload wrote it.
    await withPg(async t => {
      await t.query(
        `insert into playbook (id, workspace_id, name, created_at, updated_at, created_by_user_id)
         values ('p1', $1, 'P', now(), now(), null)`, [WS]);
      const rows = await t.query<{ n: string }>("select count(*)::text n from playbook where id = 'p1'");
      expect(rows[0].n).toBe('1');
    });
  });

  it('starts every mutable record at version 1', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(
        `insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
         values ('m2', $1, 'M', $2, now(), now())`, [WS, owner]);
      const rows = await t.query<{ version: string }>("select version::text from matter where id = 'm2'");
      expect(rows[0].version).toBe('1');
    });
  });

  it('cascades a matter delete to its documents, collections and reviews', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(`insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
                     values ('m3', $1, 'M', $2, now(), now())`, [WS, owner]);
      await t.query(`insert into document (id, workspace_id, matter_id, name, doc_type, text, byte_size,
                       mime, blob_key, parse_state, role, added_at, added_by_user_id)
                     values ('d3', $1, 'm3', 'D', 'pdf', 't', 1, 'application/pdf',
                       'workspace/x/document/d3', 'parsed', 'standalone', now(), $2)`, [WS, owner]);
      await t.query("delete from matter where id = 'm3'");
      const rows = await t.query<{ n: string }>("select count(*)::text n from document where id = 'd3'");
      expect(rows[0].n).toBe('0');
    });
  });

  it('refuses a review whose playbook_snapshot is not an object', async () => {
    // `playbookSnapshot` is the record of what a review CLAIMS to have
    // checked. A review with a string or a null there is a review that
    // cannot say what it ran, which is worse than a review that failed.
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(`insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
                     values ('m4', $1, 'M', $2, now(), now())`, [WS, owner]);
      await expect(t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                             model_id, started_at, created_by_user_id)
         values ('r4', $1, 'm4', '"oops"'::jsonb, '{}'::jsonb, '{}'::jsonb, 'x', now(), $2)`,
        [WS, owner])).rejects.toThrow(/check constraint/i);
    });
  });
});
```

`apps/api/test/grants.pg.test.ts`:

```ts
describe('a published playbook version is immutable by GRANT, not by convention', () => {
  it('lets the app role INSERT a version', async () => {
    // The positive half. Without it, a revoke of every grant would pass the
    // two below and break publishing entirely.
    await withPg(async t => { /* insert a playbook + a version, expect it to succeed */ }, appDb());
  });

  it('refuses an UPDATE by the app role', async () => {
    await withPg(async t => {
      await expect(t.query("update playbook_version set summary = 'rewritten'"))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });

  it('refuses a DELETE by the app role', async () => {
    await withPg(async t => {
      await expect(t.query('delete from playbook_version')).rejects.toThrow(/permission denied/i);
    }, appDb());
  });

  it('…and the migrator CAN, which is what makes the refusal above about the role and not the table', async () => {
    await withPg(async t => {
      await expect(t.query("update playbook_version set summary = summary")).resolves.toBeDefined();
    }, migratorDb());
  });
});
```

That last case is the one that makes the suite mean something. Without it, a `playbook_version` table that does not exist would also produce "permission denied"-shaped failures, and three green tests would be proving nothing.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test:pg -- records` / `npm run test:pg -- grants`
Expected: FAIL — `relation "matter" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/002_records.sql`. The full file is long and mechanical; the shape and the non-obvious parts are:

```sql
-- Ids are TEXT and client-minted (P6). `uid()` is base36, not a UUID, and
-- re-keying every record would mean rewriting ids inside jsonb — a migration
-- that must edit nested JSON to stay consistent is the "failed storage
-- migration" shape with extra moving parts. `workspace_id` is what actually
-- scopes them, and every read carries it.

create table matter (
  id           text primary key,
  workspace_id uuid not null references workspace(id),
  name         text not null,
  client       text,
  reference    text,
  -- §6.4: already populated from the local profile, and now a foreign key.
  -- NULLABLE because P16 maps an empty attribution to NULL rather than
  -- claiming the uploader wrote it.
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

create table document (
  id             text primary key,
  workspace_id   uuid not null references workspace(id),
  matter_id      text references matter(id) on delete cascade,
  name           text not null,
  -- `kind` in types.ts is 'pdf'|'docx'|'txt' — the FILE type. §11.1's
  -- `document.kind` is 'matter'|'precedent'. Two different facts with one
  -- word, and conflating them would be a defect nobody could see. The file
  -- type is `doc_type` here and migration 003 adds `kind` for the other.
  doc_type       text not null check (doc_type in ('pdf', 'docx', 'txt')),
  text           text not null,
  parse_state    text not null check (parse_state in ('pending', 'parsed', 'failed')),
  parse_error    text,
  markup_notice  text,
  byte_size      bigint not null,
  mime           text not null,
  blob_key       text not null,
  content_sha256 text,
  role           text not null check (role in ('base', 'varies', 'standalone')),
  collection_id  text,
  document_date  timestamptz,
  added_at       timestamptz not null,
  added_by_user_id uuid references app_user(id),
  version        bigint not null default 1,
  seq            bigint generated always as identity
);
create index document_matter_idx on document (workspace_id, matter_id);

-- collection, playbook, playbook_version, review, changeset follow the same
-- pattern. The three that carry a shape worth naming:

create table review (
  id                  text primary key,
  workspace_id        uuid not null references workspace(id),
  matter_id           text not null references matter(id) on delete cascade,
  -- A deep copy of what this review CLAIMS to have checked. `jsonb` rather
  -- than a structured clone — the same guarantee by different means (§3).
  playbook_snapshot   jsonb not null check (jsonb_typeof(playbook_snapshot) = 'object'),
  playbook_version_id text references playbook_version(id),
  target              jsonb not null check (jsonb_typeof(target) = 'object'),
  -- P11: findings stay a jsonb map in Stage 2 and become rows in Stage 3,
  -- with the engine that forces it (§13). Stored as the EXACT
  -- Record<findingsKey, Record<clauseId, Finding>> shape types.ts already
  -- has, so Stage 3's migration is a shred rather than a translation.
  findings            jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(findings) = 'object'),
  model_id            text not null,
  started_at          timestamptz not null,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_by_user_id  uuid references app_user(id),
  version             bigint not null default 1,
  seq                 bigint generated always as identity
);

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
```

Write out `collection`, `playbook` and `changeset` in full following the same pattern — `workspace_id`, the `*_user_id` foreign keys nullable, `version`, `seq`, and a `jsonb_typeof(...) = 'object'` check on `playbook.draft` and on `changeset.items` (which is an **array**, so its check is `= 'array'` — a `changeset` whose items are an object is not a changeset).

- [ ] **Step 4: Write `rows.ts` and its test**

One module, per table a `toRow` and a `fromRow`, extracted immediately rather than after the third copy:

```ts
/**
 * Row <-> wire mapping, in one place.
 *
 * Three conversions that every table needs and that every table would
 * otherwise get slightly differently:
 *
 *  - `timestamptz` <-> the epoch milliseconds `types.ts` uses everywhere
 *    (`createdAt: number`). `pg` hands back a `Date`; sending one back needs
 *    `new Date(ms)`, not a bare number, or Postgres reads it as seconds.
 *  - NULL <-> ABSENT. `structuredClone` preserves an `undefined`-valued key
 *    (CLAUDE.md), and so does `JSON.stringify` — no, it drops it, which is
 *    the *other* half of the same trap: a wire record built by spreading
 *    `{ collectionId: undefined }` loses the key over JSON and keeps it in
 *    IndexedDB, so the two stores disagree about whether a document is
 *    ungrouped. `absentUnless` makes the intent explicit at every site.
 *  - The empty-string attribution. `''` in, NULL in the column, `''` out —
 *    so a caller reading `Matter.ownerId: string` still gets a string.
 */
export function absentUnless<K extends string, V>(key: K, value: V | null | undefined):
  Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
```

`rows.test.ts` covers, per direction: an epoch round-trip through a real `Date`; a NULL column becoming an **absent** key (`expect('collectionId' in doc).toBe(false)`, never `toEqual` — `toEqual` treats `{a:1}` and `{a:1,b:undefined}` as equal, and absence is the thing being asserted); and `''`↔NULL for every `*UserId`.

- [ ] **Step 5: Run, watch pass, mutate**

**Mutation 1:** drop `on delete cascade` from `document.matter_id`. Expected: `cascades a matter delete to its documents…` fails by name. Restore.
**Mutation 2:** change `grant select, insert on playbook_version` to `grant select, insert, update`. Expected: `refuses an UPDATE by the app role` fails by name. Restore.
**Mutation 3:** make `absentUnless` return `{ [key]: undefined }` for a null. Expected: the absent-key test fails. Restore. **If it does not fail, the test used `toEqual` and must be rewritten** — that is the trap CLAUDE.md names and it is load-bearing here because these records go into `jsonb`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/002_records.sql apps/api/src/db/rows.ts \
  apps/api/test/records.pg.test.ts apps/api/test/grants.pg.test.ts apps/api/test/rows.test.ts
git commit -m "feat(api): the record tables, workspace_id on every one, and an insert-only grant on published versions"
git show --stat HEAD
```

---

## Task 9: `matters` over HTTP — the first proof that the seam holds

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/matters.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/auth/routeTable.ts`
- Create: `apps/api/test/matters.pg.test.ts`, `apps/api/test/matters.route.test.ts`
- Modify: `src/lib/db/matters.ts` (bodies only — **every export keeps its name and signature**)
- Rewrite: `src/lib/db/matters.test.ts` (now a transport test)
- Modify: `apps/api/test/workspaceScope.test.ts` (created here, extended by every later route task)

**Interfaces:**
- Consumes: Task 7's `api` client; Task 8's `matter` table and `rows.ts`; Task 5's `ROUTE_POLICY`; `src/types.ts`'s `Matter`. **Read `src/lib/db/matters.ts` before touching it**; its five exports are `newMatter(name, ownerId): Matter`, `listMatters(): Promise<Matter[]>`, `getMatter(id): Promise<Matter | null>`, `saveMatter(m): Promise<Matter>`, `deleteMatter(id): Promise<void>`, and a file-local `stripSeq`. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `GET/PUT/DELETE /v1/matters`, and the pattern every later repository task follows.

**This task establishes the pattern, so it carries more explanation than the six that follow it.** Read it before Tasks 11–15 even if you are not implementing it.

- [ ] **Step 1: Write the API's failing test**

`apps/api/test/matters.pg.test.ts`:

```ts
describe('matter routes', () => {
  it('round-trips a matter through Postgres, unchanged', async () => {
    // §18 item 3's "every record type round-trips through Postgres", at its
    // first table. The assertion is `toEqual` on the WHOLE record, so a
    // dropped field fails rather than a spot-check passing.
    const saved = await put('/v1/matters/m1', {
      id: 'm1', name: 'Brookvale', client: 'Acme', reference: 'ACM-1',
      ownerId: actor.id, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    });
    expect(await get('/v1/matters/m1')).toEqual(saved);
  });

  it('sets updatedAt server-side, as saveMatter always did', async () => {
    const saved = await put('/v1/matters/m2', { ...base, updatedAt: 1 });
    expect(saved.updatedAt).toBeGreaterThan(1);
  });

  it('orders the list by updatedAt then seq, so a same-millisecond pair is stable', async () => {
    // The tiebreak `_seq` provided. Two saves in one millisecond ordered by
    // updatedAt alone are ordered arbitrarily, which is the defect
    // sub-project A added `_seq` to fix — and losing it here would lose it
    // silently, because the list would still render.
    const t = 1_700_000_000_000;
    await put('/v1/matters/a', { ...base, id: 'a', updatedAt: t });
    await put('/v1/matters/b', { ...base, id: 'b', updatedAt: t });
    const list = await get('/v1/matters');
    expect(list.map((m: Matter) => m.id).slice(0, 2)).toEqual(['b', 'a']);
  });

  it('answers 404 for a matter that does not exist, not 200 with null', async () => {
    expect((await raw('GET', '/v1/matters/nope')).statusCode).toBe(404);
  });

  it('refuses a stale write with 409 and returns the current row (P9)', async () => {
    const first = await put('/v1/matters/m3', base);
    await put('/v1/matters/m3', { ...first, name: 'Renamed' });
    const res = await raw('PUT', '/v1/matters/m3', { ...first, name: 'From a stale tab' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
    // The current row travels with the refusal, so Stage 4's "here is what
    // replaced it" needs no second round trip and no second mechanism.
    expect(res.json().current.name).toBe('Renamed');
  });

  it('never lets a record be read or written across workspaces', async () => {
    await migratorDb().query(
      "insert into workspace (id, name) values ('00000000-0000-0000-0000-0000000000ff', 'Other')");
    await migratorDb().query(`insert into matter (id, workspace_id, name, created_at, updated_at)
      values ('foreign', '00000000-0000-0000-0000-0000000000ff', 'Theirs', now(), now())`);
    expect((await raw('GET', '/v1/matters/foreign')).statusCode).toBe(404);
    // …and a WRITE to the same id is a conflict, not a silent takeover.
    expect((await raw('PUT', '/v1/matters/foreign', { ...base, id: 'foreign' })).statusCode).toBe(409);
  });

  it('deletes a matter and its documents, and the response says nothing survived', async () => {
    // The cascade is a promise the README makes. Task 11 adds the blob half.
    /* … */
  });
});
```

- [ ] **Step 2: Run and watch it fail**, then write the route

`apps/api/src/routes/matters.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { ModelError } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { fromMatterRow, type MatterRow } from '../db/rows.ts';

export function registerMatters(app: FastifyInstance, db: Db): void {
  app.get('/v1/matters', async req => {
    const rows = await db.query<MatterRow>(
      `select * from matter where workspace_id = $1 order by updated_at desc, seq desc`,
      [req.actor!.workspaceId],
    );
    return rows.map(fromMatterRow);
  });

  app.get<{ Params: { id: string } }>('/v1/matters/:id', async req => {
    const rows = await db.query<MatterRow>(
      'select * from matter where id = $1 and workspace_id = $2',
      [req.params.id, req.actor!.workspaceId],
    );
    // A record in another workspace is NOT FOUND, not FORBIDDEN. A 403 here
    // would confirm the id exists somewhere, which is a fact this workspace
    // is not entitled to. `getMatter` maps 404 to `null`, so the caller sees
    // exactly what it saw when IndexedDB had no such key.
    if (!rows[0]) throw new ModelError('No such matter.', 'not_found', 404);
    return fromMatterRow(rows[0]);
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/v1/matters/:id', async (req, reply) => {
    const ws = req.actor!.workspaceId;
    const input = parseMatter(req.params.id, req.body);   // throws a 400 ModelError on a bad shape
    const rows = await db.query<MatterRow>(
      `insert into matter (id, workspace_id, name, client, reference, owner_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), now())
       on conflict (id) do update set
         name = excluded.name, client = excluded.client, reference = excluded.reference,
         owner_id = excluded.owner_id, updated_at = now(), version = matter.version + 1
       where matter.workspace_id = $2 and matter.version = $8
       returning *`,
      [input.id, ws, input.name, input.client, input.reference, input.ownerId, input.createdAt, input.version],
    );
    if (!rows[0]) {
      // Three different situations, one shape: the row moved on (a stale
      // write), or it belongs to another workspace (P6's id collision). Both
      // are answered with the CURRENT row when this workspace may see it,
      // and with a bare conflict when it may not — never with a silent
      // overwrite and never with a 200 over a write that did not happen.
      const current = await db.query<MatterRow>(
        'select * from matter where id = $1 and workspace_id = $2', [input.id, ws]);
      throw new ConflictError(current[0] ? fromMatterRow(current[0]) : undefined);
    }
    return fromMatterRow(rows[0]);
  });

  app.delete<{ Params: { id: string } }>('/v1/matters/:id', async (req, reply) => {
    // The blob half of the cascade arrives in Task 11 and MUST be added
    // here, not beside here. Task 11's own test asserts it from this route.
    const rows = await db.query<{ id: string }>(
      'delete from matter where id = $1 and workspace_id = $2 returning id',
      [req.params.id, req.actor!.workspaceId]);
    if (!rows[0]) throw new ModelError('No such matter.', 'not_found', 404);
    return reply.code(204).send();
  });
}
```

`ConflictError` is a `ModelError` subclass carrying `current`, so `registerErrorEnvelope` can put it in the body: add it to `apps/api/src/errors.ts` (new, one file) and use it from every later route task rather than composing a 409 body seven times.

**The `where matter.version = $8` clause on a `DO UPDATE` is the part most likely to be got wrong.** Postgres evaluates it against the *existing* row, and when it is false the statement affects no rows and `RETURNING` yields none — which is exactly the signal wanted. Verify that behaviour with the stale-write test before trusting it, because the alternative reading (the clause silently doing nothing) would make every stale write succeed.

- [ ] **Step 3: Swap `src/lib/db/matters.ts`'s bodies**

Every export keeps its name, its parameters and its return type. Only bodies and docstrings change:

```ts
import { api } from '../api/client';
import type { Matter } from '../../types';
import { uid } from '../uid';

/**
 * The matters repository — an HTTP client over `apps/api` since Stage 2.
 *
 * The file is still `src/lib/db/matters.ts` and every export still has the
 * signature it had when this read IndexedDB (P8). That is not inertia: the
 * repositories were made Promise-returning in sub-project A precisely so a
 * storage swap would not touch a caller (R3), and keeping the path is what
 * makes "no caller changed" a claim a reader can check against one diff.
 */
export function newMatter(name: string, ownerId: string): Matter {
  // Unchanged: still pure, still client-side, still mints a `uid()`.
}

export async function listMatters(): Promise<Matter[]> {
  return api.get<Matter[]>('/v1/matters');
}

export async function getMatter(id: string): Promise<Matter | null> {
  return api.getOrNull<Matter>(`/v1/matters/${encodeURIComponent(id)}`);
}

export async function saveMatter(m: Matter): Promise<Matter> {
  // Still returns the SAVED record, and the caller still renders from it and
  // from nothing else (`await-then-apply`, S8). What changed is which store
  // confirmed the write.
  return api.send<Matter>('PUT', `/v1/matters/${encodeURIComponent(m.id)}`, m);
}

export async function deleteMatter(id: string): Promise<void> {
  await api.del(`/v1/matters/${encodeURIComponent(id)}`);
}
```

`encodeURIComponent` on every id segment, everywhere, without exception: `uid()` produces base36 so it is safe today, but the uploader will send ids from a browser that may hold anything, and a path-traversal in an id is not a defect this app should have to think about twice.

**`Matter` gains an optional `version?: number`.** That is a type change, and therefore a **finding** to write down: it is the one field the seam could not absorb, because optimistic concurrency needs the client to say what it was looking at. It is optional so `newMatter` is unchanged and so a record from the uploader (which has no version) is accepted as a create.

- [ ] **Step 4: Rewrite `src/lib/db/matters.test.ts` as a transport test**

The behaviour it used to assert — ordering, the `_seq` tiebreak, the cascade — has moved to `matters.pg.test.ts`, where a real Postgres can prove it. What stays here is what the browser still owns:

1. `newMatter` is unchanged (keep those cases verbatim — they should need no edit at all, and if they do, that is a finding).
2. `saveMatter` PUTs to the right path with the whole record as the body.
3. `getMatter` returns `null` on a 404 and the record on a 200.
4. `deleteMatter` issues a DELETE and resolves on 204.
5. A `ModelError` from the transport propagates rather than being swallowed into `null` — **the one that matters**: `getMatter` returning `null` on a 500 would render "no such matter" over a broken server, which is the "empty is not broken" rule failing at the transport.

**Say in the report how many assertions moved and why.** A repository swap that rewrote its own tests wholesale is indistinguishable from one that changed behaviour, and this is the task that sets the expectation for the six that follow.

- [ ] **Step 5: The workspace-scope guard, created here and extended by every later route task**

`apps/api/test/workspaceScope.test.ts`:

```ts
it('every SQL statement in a route module names workspace_id', () => {
  const files = walk(path.join(ROOT, 'apps/api/src/routes'));
  expect(files.length).toBeGreaterThan(0);           // the scanner finds something
  const offenders: string[] = [];
  for (const file of files) {
    const code = codeOf(file);
    // Every `from <table>` / `insert into <table>` / `update <table>` /
    // `delete from <table>` naming a workspace-scoped table must have
    // `workspace_id` somewhere in the same statement.
    for (const stmt of statementsIn(code)) {
      if (!SCOPED_TABLES.some(t => stmt.includes(t))) continue;
      if (!/workspace_id/.test(stmt)) offenders.push(`${rel(file)}: ${stmt.slice(0, 80)}`);
    }
  }
  expect(offenders).toEqual([]);
});
```

**Mutation:** drop `and workspace_id = $2` from `GET /v1/matters/:id`. Expected: this test fails naming the statement. Restore. §19 says the thing to watch is *"a query that forgets the `kind` predicate, because such a query fails by showing too much rather than too little, and nothing on screen would look wrong"* — the same is true of `workspace_id`, and this is the guard for both (Task 19 adds `kind` to it).

- [ ] **Step 6: Add `GET/PUT/DELETE /v1/matters` and `/v1/matters/:id` to `ROUTE_POLICY`** as `reviewer`, and run the whole gate set. Then commit.

```bash
git add apps/api/src/routes/matters.ts apps/api/src/errors.ts apps/api/src/server.ts \
  apps/api/src/auth/routeTable.ts apps/api/test/matters.pg.test.ts \
  apps/api/test/matters.route.test.ts apps/api/test/workspaceScope.test.ts \
  src/lib/db/matters.ts src/lib/db/matters.test.ts src/types.ts
git commit -m "feat: matters over HTTP, with the repository signatures unchanged"
git show --stat HEAD
```

---

## Task 10: Blob Storage — Azurite in compose, the `BlobStore` seam, and a credential source that never falls back

**Type:** infrastructure

**Files:**
- Create: `apps/api/src/blob/store.ts`, `apps/api/src/blob/credential.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/main.ts`
- Create: `apps/api/test/blobCredential.test.ts`, `apps/api/test/blobStore.compose.test.ts`
- Modify: `docker-compose.yml` (the `azurite` service, `internal` only), `.env.example`
- Modify: `package.json`, `apps/api/package.json` (`@azure/storage-blob`)

**Interfaces:**
- Consumes: `apps/api/src/config.ts` (the one env reader); `@azure/identity`'s `DefaultAzureCredential`, already a Stage 1 dependency — **read `apps/gateway/src/credentials/managedIdentity.ts` and follow its shape**, because this is the same problem one service over and a second solution to it would be the sibling drift S25 was written about. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `BlobStore` (`put`, `get`, `delete`, `deletePrefix`, `list`), `AzureBlobStore`, `blobKeyFor(workspaceId, documentId)`, `resolveBlobCredential(config)`, and the keys `API_BLOB_CREDENTIAL_SOURCE`, `API_BLOB_CONNECTION_STRING`, `API_BLOB_ACCOUNT_URL`, `API_BLOB_CONTAINER`.

**Azurite, never MinIO and never anything "S3-compatible" (S30).** The reason is written in the ruling and is worth having in front of you while you work: *"S3-compatible is exactly the class of near-equivalence that produces a defect visible only in production, because the local run is green and the difference is in a header, an error code, or a consistency guarantee nobody read."*

- [ ] **Step 1: The credential rule, and its failing test**

`apps/api/test/blobCredential.test.ts`:

```ts
describe('the blob credential comes from ONE configured source and never falls back', () => {
  it('uses the connection string when that is the configured source', () => {
    const c = resolveBlobCredential({ source: 'connection-string', connectionString: 'UseDevelopmentStorage=true' });
    expect(c.kind).toBe('connection-string');
  });

  it('uses a managed identity when THAT is the configured source, even with a connection string present', () => {
    // "Whichever value is set" would be an environment branch wearing a
    // convenience's clothes, and it would let a developer's `az login`
    // silently satisfy a deployment the operator believed was keyed.
    const c = resolveBlobCredential({
      source: 'managed-identity', accountUrl: 'https://x.blob.core.windows.net',
      connectionString: 'UseDevelopmentStorage=true',
    });
    expect(c.kind).toBe('managed-identity');
  });

  it('refuses loudly when the configured source has no material, and NEVER tries the other', () => {
    const err = (() => { try { resolveBlobCredential({ source: 'managed-identity',
      connectionString: 'UseDevelopmentStorage=true' }); } catch (e) { return e; } })();
    expect((err as Error).message).toMatch(/API_BLOB_ACCOUNT_URL/);
    // Naming the OTHER source in the message would invite exactly the
    // fallback this refuses. Assert it does not.
    expect((err as Error).message).not.toMatch(/connection string/i);
  });

  it('refuses an unknown source rather than defaulting to one', () => {
    expect(() => resolveBlobCredential({ source: 'guess' as never })).toThrow(/API_BLOB_CREDENTIAL_SOURCE/);
  });
});
```

This is Stage 1's Task 7 mutation, restated: *"adding a fallback from managed-identity failure into `readEnv` failed exactly one named test: `a managed-identity failure is a loud 503 and NEVER falls back to a key`."* Do the same mutation here — add a fallback from the missing account URL into the connection string — and confirm `refuses loudly when the configured source has no material` fails by name.

- [ ] **Step 2: `blobKeyFor`, and the one place a key is built**

```ts
/**
 * `workspace/{workspaceId}/document/{documentId}` — §6.5's key, built here
 * and nowhere else.
 *
 * One function for the same reason `findingsKeyFor` is one function: six
 * defects in sub-project C came from code that derived a key inline. A blob
 * key derived in two places is a blob that a delete cascade cannot find,
 * which makes the README's "deleting a matter deletes its documents' bytes"
 * false in exactly the direction nobody would notice.
 */
export function blobKeyFor(workspaceId: string, documentId: string): string {
  return `workspace/${workspaceId}/document/${documentId}`;
}
```

- [ ] **Step 3: `BlobStore`**

```ts
export interface BlobStore {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  /** `null` when there is no blob — NOT an error. A `DocumentRecord` can
   *  outlive its bytes (a partial failure, a manual purge), and the UI must
   *  still show that document's metadata with an "unavailable" state rather
   *  than the whole view blowing up. `getDocumentBlob`'s docstring already
   *  says this at length; the rule is unchanged by the store moving. */
  get(key: string): Promise<{ bytes: Buffer; mime: string } | null>;
  /** Resolves whether or not the blob was there. Deleting a blob that has
   *  already gone is the cascade succeeding, not failing. */
  delete(key: string): Promise<void>;
  /** For the matter cascade and for orphan reconciliation. */
  list(prefix: string): Promise<string[]>;
}
```

`AzureBlobStore` wraps `BlobServiceClient` — `fromConnectionString(...)` or `new BlobServiceClient(accountUrl, new DefaultAzureCredential())` selected by the resolved credential and by nothing else. Create the container at startup with `createIfNotExists({ access: undefined })` — **`undefined`, explicitly, not `'blob'` and not `'container'`**: both of those are public access, §6.5 says private container, no public access, and the default is easy to get wrong by writing the option and picking the wrong value.

- [ ] **Step 4: Azurite in compose**

```yaml
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite:latest
    # Microsoft's own emulator (S30). `internal` only and no published port,
    # for the same reason postgres has none: it holds the firm's document
    # bytes and must have no route out.
    command: ["azurite-blob", "--blobHost", "0.0.0.0", "--loose"]
    networks: [internal]
    volumes: ["lexprompt-azurite:/data"]
    healthcheck:
      test: ["CMD-SHELL", "nc -z 127.0.0.1 10000"]
      interval: 5s
      retries: 30
```

`api` gains:

```yaml
      API_BLOB_CREDENTIAL_SOURCE: connection-string
      API_BLOB_CONNECTION_STRING: ${AZURITE_CONNECTION_STRING}
      API_BLOB_CONTAINER: documents
```

`.env.example` carries the well-known Azurite development connection string with a comment saying **exactly** what it is: a fixed, published, non-secret credential for an emulator, which is why it may sit in version control and why a real one never may. Azure sets `API_BLOB_CREDENTIAL_SOURCE: managed-identity` and `API_BLOB_ACCOUNT_URL`, and sets **no** connection string — that asymmetry is §5.1 row 5 and Task 25 tables it.

- [ ] **Step 5: A compose test that puts and gets real bytes**

`apps/api/test/blobStore.compose.test.ts` (the `*.compose.test.ts` suffix is already excluded from `npm test` — read `vitest.compose.config.ts` and follow it):

1. `put` then `get` returns byte-identical content and the same mime. **Use a payload with a null byte and a 0xFF byte in it** — a text round-trip proves nothing about a PDF, and a UTF-8 conversion slipped in somewhere is exactly the defect that would survive a "hello world" test and corrupt every document.
2. `get` on a missing key returns `null`, not a throw.
3. `delete` on a missing key resolves.
4. `list(prefix)` returns only keys under that prefix — seed one blob under a **different** workspace's prefix and assert it is absent. Without that, a cascade that ignored the prefix would pass.

- [ ] **Step 6: Run the stack and check the container's access level by hand**

```bash
npm run compose:up
npm run test:compose
docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com; echo "exit=$?"'
```

Expected: the blob suite passes; `api` still has no route out. **And read `docker compose ps`**: `azurite` must show no published port. A blob store reachable from the host is a blob store reachable from anything else on that host, and this is a file whose lesson is that reading it is not enough.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json apps/api/package.json apps/api/src/blob \
  apps/api/src/config.ts apps/api/src/main.ts apps/api/test/blobCredential.test.ts \
  apps/api/test/blobStore.compose.test.ts docker-compose.yml .env.example
git commit -m "feat(api): Blob Storage behind one interface, Azurite locally, one credential source with no fallback"
git show --stat HEAD
```

---

## Task 11: `documents` and `blobs` over HTTP, and a cascade that reaches the bytes

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/matters.ts` (the delete cascade gains its blob half — **in this file**, not beside it)
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`
- Create: `apps/api/test/documents.pg.test.ts`, `apps/api/test/cascade.compose.test.ts`
- Modify: `src/lib/db/documents.ts`, `src/lib/db/blobs.ts` (bodies only)
- Rewrite: `src/lib/db/documents.test.ts`, `src/lib/db/blobs.test.ts`

**Interfaces:**
- Consumes: Task 10's `BlobStore` and `blobKeyFor`; Task 8's `document` table; Task 7's `api.sendForm`/`api.getBlobOrNull`. **Read `src/lib/db/documents.ts` first.** Its exports are `migrateDocumentRecord(raw): DocumentRecord`, `listDocuments(matterId)`, `getDocument(id)`, `addDocument(rec, bytes: Blob): Promise<void>`, `setDocumentRole(id, role, collectionId?): Promise<void>`, `deleteDocument(id)`; `blobs.ts` exports only `getDocumentBlob(id): Promise<Blob | null>`. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `POST /v1/documents` (multipart), `GET /v1/matters/:id/documents`, `GET /v1/documents/:id`, `GET /v1/documents/:id/bytes`, `PATCH /v1/documents/:id/role`, `DELETE /v1/documents/:id`.

**Two rules from `CLAUDE.md` govern this task and neither may be relaxed for convenience:** *page images are never persisted* (only the original bytes go to Blob Storage, and nothing in this route touches `DocumentFile.pageImages`), and *a partial write leaves an orphan nobody can see* (`addDocument` writes the row and the blob together today, in one IndexedDB transaction, for exactly that reason).

- [ ] **Step 1: The write-order decision, written down before the code**

Postgres and Blob Storage cannot share a transaction, so `addDocument`'s single-transaction guarantee cannot survive as such. **Blob first, row second**, and the reasoning is the direction of the failure:

- **Blob first:** a failure after the blob and before the row leaves an *orphaned blob* — invisible to the UI, costing storage, and reclaimed by the reconciliation sweep in Step 6.
- **Row first:** a failure between them leaves a *document record with no bytes* — visible to the user as a document that opens to nothing, which is a document that lies about existing.

The first failure is a storage leak with a sweeper. The second is a document a lawyer can select for review that has no content, on the path whose founding defect is a document reviewed as though it said nothing. **Blob first.** Write this reasoning into the route's docstring; it is the kind of decision a later reader reverses because the other order looks tidier.

- [ ] **Step 2: Write the failing tests**

`apps/api/test/documents.pg.test.ts`:

```ts
it('stores the row and puts the bytes under blobKeyFor, and returns the row', async () => { /* … */ });

it('writes the blob BEFORE the row, so a failure leaves an orphan and never a contentless document', async () => {
  // Injected failing Db; the blob store must already hold the bytes.
  const store = recordingStore();
  const app = buildTestServer({ blob: store, db: failingOnInsert() });
  await app.inject({ method: 'POST', url: '/v1/documents', payload: form });
  expect(store.keys()).toEqual(['workspace/…/document/d1']);
});

it('rejects a document whose matter is in another workspace, without storing bytes', async () => {
  // The order above makes this the case that matters: an unauthorised upload
  // must not leave its bytes behind. So the WORKSPACE CHECK runs before the
  // blob put, and only the row insert is after it.
});

it('serves the bytes back with the stored mime and a content-length', async () => { /* … */ });

it('answers 404 for bytes that are not there, so getDocumentBlob can return null', async () => {
  // BLOB_UNAVAILABLE_MESSAGE exists because a record can outlive its bytes.
  // A 500 here would turn a known, handled state into a broken screen.
});

it('setDocumentRole leaves every other field untouched, including one it does not know about', async () => {
  // The shipped implementation reads inside its own transaction and spreads,
  // so a field added later survives. The route must do the same: an UPDATE
  // naming only role and collection_id, never a whole-row rewrite.
});

it('ungrouping REMOVES collection_id rather than setting it to undefined', async () => {
  const doc = await patchRole('d1', 'standalone');
  expect('collectionId' in doc).toBe(false);   // NOT toEqual — absence is the assertion
});
```

`apps/api/test/cascade.compose.test.ts` — against the real stack, because this is the promise that has to be true of the deployment and not only of the code:

```ts
it('deleting a matter deletes its documents AND their blobs', async () => {
  // Seed a matter with two documents, confirm both blobs are listable,
  // delete the matter, then list the prefix again.
  expect(await store.list(`workspace/${WS}/document/`)).toEqual([]);
});

it('deletes the blobs even when one of them is already gone', async () => {
  // A half-done cascade is the failure the promise exists to prevent, and
  // the likeliest cause is one delete throwing and aborting the rest.
});

it('reports the delete as failed when a blob could NOT be removed', async () => {
  // Loudly. A cascade that reports success over a surviving blob makes the
  // README's sentence false and nothing on screen would show it.
  expect(res.statusCode).toBe(500);
  expect(res.json().error.message).toMatch(/could not be deleted/i);
});
```

That last case is the one to think hardest about. The rows are gone by then (the transaction committed), so the failure cannot be undone — the honest answer is to say so, name the keys, and leave them for the sweeper. Silence would be the README's promise failing invisibly.

- [ ] **Step 3: The routes**

`POST /v1/documents` takes multipart: a `record` part (the JSON `DocumentRecord`) and a `bytes` part. Register `@fastify/multipart` with `limits: { fileSize: config.maxBodyBytes }` so the declared cap is the one that applies — Stage 1's final round found nginx's undeclared 1 MiB silently capping this app's core workflow, and a multipart default is the same trap one layer in. **Check `apps/api/Dockerfile` and `infra/nginx/` for the body-size settings that already exist, and make the four limits agree**: nginx's `client_max_body_size`, Fastify's `bodyLimit`, multipart's `fileSize`, and the gateway's prompt cap.

The delete cascade, **inside `registerMatters`' delete handler** so there is exactly one:

```ts
    // The keys are read BEFORE the rows go, because after the cascade there
    // is nothing left to derive them from. Rows first, then blobs: a blob
    // deleted before a committed row rollback would leave a document
    // pointing at bytes that no longer exist — visible, and worse.
    const keys = await db.query<{ blob_key: string }>(
      'select blob_key from document where matter_id = $1 and workspace_id = $2', [id, ws]);
    await db.tx(async t => { /* delete matter; documents/collections/reviews cascade */ });
    const failed: string[] = [];
    for (const { blob_key } of keys) {
      try { await blob.delete(blob_key); } catch { failed.push(blob_key); }
    }
    if (failed.length > 0) {
      throw new ModelError(
        `The matter and its records were deleted, but ${failed.length} document `
        + `${failed.length === 1 ? 'file' : 'files'} could not be deleted from storage. `
        + 'The bytes are still held. Tell an administrator, quoting: ' + failed.join(', '),
        'unknown', 500,
      );
    }
```

- [ ] **Step 4: Swap the browser bodies**

```ts
export async function addDocument(rec: DocumentRecord, bytes: Blob): Promise<void> {
  const form = new FormData();
  form.append('record', JSON.stringify(rec));
  // The filename matters: some servers reject a file part without one, and
  // the mime is what `getDocumentBlob` will hand back to the viewer.
  form.append('bytes', bytes, rec.name);
  await api.sendForm<void>('/v1/documents', form);
}

export async function getDocumentBlob(id: string): Promise<Blob | null> {
  // `null` — never a throw — when no blob is on record, exactly as before,
  // and for exactly the reason the old docstring gives: a document can
  // outlive its bytes and the UI must still render its metadata with an
  // "unavailable" state. A genuine failure still propagates.
  return api.getBlobOrNull(`/v1/documents/${encodeURIComponent(id)}/bytes`);
}
```

`migrateDocumentRecord` **stays in the browser and stays exported**: it upgrades a record read from an older shape, and the uploader (Task 22) is its remaining caller. Do not delete it in this task; Task 23 decides its fate.

- [ ] **Step 5: `parse_state`, written by the browser's own parse (P12)**

`toDocumentRecord` (in `src/lib/documents.ts`) already produces `parseError` when parsing failed. The route derives `parse_state` from the record: `'failed'` when `parseError` is present, `'parsed'` otherwise, and **never `'pending'` in Stage 2** — nothing here is asynchronous. A test asserts that a record carrying a `parseError` stores `parse_state = 'failed'`, because Stage 3's parse worker will read this column and a document silently marked `parsed` with no text is the founding defect wearing a database column.

- [ ] **Step 6: The orphan sweeper**

`GET /v1/admin/blob-orphans` (admin only, in `ROUTE_POLICY`) lists blob keys under the workspace prefix with no `document` row, and `POST /v1/admin/blob-orphans/delete` removes them. §6.5 asks for *"a reconciliation job that deletes orphaned blobs — because the cascade is a promise the README makes and a half-done cascade is the failure mode that promise exists to prevent."* Two routes and no scheduler: a scheduled job is a Stage 3 concern (there is no worker yet), and an admin who can *see* the orphans is worth more right now than one who is told a job ran.

- [ ] **Step 7: Gates, the live run, and commit**

Run the whole gate set, then `npm run compose:up && npm run test:compose`, then **upload a real scanned PDF through the running app and open it in the viewer**. That is the check nothing else makes: it exercises multipart limits, the mime round-trip, and `documentFileForViewing` reading bytes over HTTP. Say plainly in the report whether you did it.

```bash
git add apps/api/src/routes/documents.ts apps/api/src/routes/matters.ts \
  apps/api/src/auth/routeTable.ts apps/api/src/server.ts apps/api/test/documents.pg.test.ts \
  apps/api/test/cascade.compose.test.ts src/lib/db/documents.ts src/lib/db/blobs.ts \
  src/lib/db/documents.test.ts src/lib/db/blobs.test.ts
git commit -m "feat: documents and their bytes over HTTP, with a cascade that reaches Blob Storage"
git show --stat HEAD
```

---

## Task 12: `collections` over HTTP

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/collections.ts`
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`
- Create: `apps/api/test/collections.pg.test.ts`
- Modify: `src/lib/db/collections.ts` (bodies only)
- Rewrite: `src/lib/db/collections.test.ts`

**Interfaces:**
- Consumes: Task 9's route pattern; Task 8's `collection` table; `src/lib/db/documents.ts`'s `setDocumentRole`. **Read `src/lib/db/collections.ts`**: `newCollection(matterId, name, baseDocumentId, createdByUserId)`, `listCollections(matterId)`, `getCollection(id)`, `saveCollection(c)`, `deleteCollection(id)`, plus a file-local `stripSeq`. **Where the shipped source disagrees, the shipped source wins.**
- Produces: `GET /v1/matters/:id/collections`, `GET/PUT/DELETE /v1/collections/:id`.

- [ ] **Step 1: Follow Task 9's pattern exactly** — the same six route tests (round-trip, ordering, 404, stale-write 409, cross-workspace, delete), the same `PUT`-as-upsert, the same 404-not-403, the same `encodeURIComponent`.

- [ ] **Step 2: The two rules this table carries, each with a test**

```ts
it('preserves variesDocumentIds ORDER exactly, including a reordering that is not a sort', async () => {
  // R-C3 / `orderedMembers`: the order amendments take effect is a legal
  // judgement someone recorded, not something to re-derive. Stored as a
  // text[] and read back in array order; a `jsonb` array would also work,
  // but an ordering that a query could accidentally sort is one nobody
  // would notice losing.
  const saved = await put('/v1/collections/c1', { ...base, variesDocumentIds: ['d3', 'd1', 'd2'] });
  expect((await get('/v1/collections/c1')).variesDocumentIds).toEqual(['d3', 'd1', 'd2']);
});

it('never orders members by documentDate, at the wire or in SQL', async () => {
  // `documentDate` is DISPLAYED and never governs order. The guard is a
  // source scan over the route module for `document_date` appearing in an
  // ORDER BY — cheap, and it names the one mistake this table invites.
  expect(codeOf(collectionsRoute)).not.toMatch(/order\s+by[^;]*document_date/i);
  // …with the companion positive assertion, or this passes vacuously:
  expect(codeOf(collectionsRoute)).toMatch(/varies_document_ids/);
});
```

- [ ] **Step 3: State the grouping non-atomicity, unchanged**

`Collection.baseDocumentId`/`variesDocumentIds` stays **authoritative**, and `document.role` stays a denormalised convenience written by a separate call (`setDocumentRole`), exactly as `CLAUDE.md` describes. **The temptation this task must refuse:** Postgres could now write both in one transaction, closing a window that has been open since sub-project C. Doing so would make `role` authoritative-in-practice while every reader still treats it as denormalised, and the next person to write a query would have no way to tell which rule now applies. Record it as a Stage 3 candidate — the grouping call becomes one route with one transaction when the collection UI is next touched — and change nothing here. Write that in the report.

- [ ] **Step 4: Gates and commit**

```bash
git add apps/api/src/routes/collections.ts apps/api/src/auth/routeTable.ts \
  apps/api/src/server.ts apps/api/test/collections.pg.test.ts \
  src/lib/db/collections.ts src/lib/db/collections.test.ts
git commit -m "feat: collections over HTTP, with member order preserved and never re-derived"
git show --stat HEAD
```

---

## Task 13: `playbooks` and `playbookVersions` over HTTP — `publishAndPoint` as one Postgres transaction

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/playbooks.ts`
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`
- Create: `apps/api/test/playbooks.pg.test.ts`
- Modify: `src/lib/db/playbooks.ts`, `src/lib/db/playbookVersions.ts` (bodies only)
- Rewrite: `src/lib/db/playbooks.test.ts`, `src/lib/db/playbookVersions.test.ts`

**Interfaces:**
- Consumes: Task 8's `playbook` / `playbook_version` tables and their **insert-only** grant; Task 5's `ROUTE_POLICY` (publishing is `partner`). **Read both shipped modules.** `playbooks.ts` exports `newPlaybook`, `newPlaybookDraft`, `draftFromVersion`, `listPlaybooks`, `getPlaybook`, `getPlaybookContent`, `savePlaybook`, `publishAndPoint`, `saveDraft`, `discardDraft`, `deletePlaybook`, `exportPlaybook`, `importPlaybook`. `playbookVersions.ts` exports `publishVersion`, `publishVersionIn`, `getVersion`, `listVersions`. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `GET /v1/playbooks`, `GET/PUT/DELETE /v1/playbooks/:id`, `GET /v1/playbooks/:id/content`, `POST /v1/playbooks/:id/versions`, `GET /v1/playbooks/:id/versions`, `GET /v1/versions/:id`, `POST /v1/playbooks/import`.

**The one export whose *type* cannot survive, and it is a finding.** `publishVersionIn<TxStores extends ArrayLike<StoreNames<LexPromptDB>>>(store, playbookId, draft, byUserId)` takes an **`idb` object-store handle** — a type from the storage layer this stage is removing. Its callers are all inside `src/lib/db/` (`playbooks.ts`, `playbookVersions.ts`, `migrate.ts`); **nothing outside the repository directory imports it** — verify that with `grep -rn "publishVersionIn" src --include=*.ts --include=*.tsx | grep -v "^src/lib/db/"` before you rely on it. So the seam holds for every *caller*, and what changes is an internal helper's shape. **Record it as a finding**: the seam held at the boundary and did not hold one level in, which is exactly the distinction worth writing down rather than glossing.

- [ ] **Step 1: Write the failing test for the transaction that is the whole point**

```ts
describe('publishing a version and pointing the playbook at it', () => {
  it('does both, or neither', async () => {
    // `publishAndPoint`'s own docstring: two separate transactions left an
    // orphaned version on any failure between them, and for an imported
    // playbook an orphan with NO identity record at all — permanently
    // unreachable, since nothing but the startup migration adopts orphans
    // and that only looks at playbooks that still exist.
    const app = buildTestServer({ db: failingAfterVersionInsert() });
    await app.inject({ method: 'POST', url: '/v1/playbooks/p1/versions', payload: draft });
    expect(await countVersions('p1')).toBe(0);
    expect(await currentVersionOf('p1')).toBeUndefined();
  });

  it('mints a fresh id on every publish and never reuses one', async () => {
    // Immutability is a property of how ids are allocated, not a check that
    // could be forgotten. Two publishes of byte-identical content produce
    // two versions with two ids.
    const a = await publish('p1', draft);
    const b = await publish('p1', draft);
    expect(b.id).not.toBe(a.id);
    expect(b.versionNumber).toBe(a.versionNumber + 1);
  });

  it('refuses a REVIEWER, and allows a partner', async () => {
    expect((await publishAs('reviewer')).statusCode).toBe(403);
    expect((await publishAs('partner')).statusCode).toBeLessThan(400);
  });

  it('refuses a version after v1 with no change summary', async () => {
    // D's rule, carried over: `publishVersionIn` throws on it today and
    // `PublishDialog` is where the author is asked. The API refuses it too,
    // because a hidden dialog field is not a control.
  });

  it('allocates version numbers with no gap and no duplicate under concurrent publishes', async () => {
    // The `unique (playbook_id, version_number)` constraint plus a
    // SELECT ... FOR UPDATE on the playbook row inside the transaction. Two
    // concurrent publishes: one wins, one either retries or is refused —
    // never two rows claiming to be v3.
    const [a, b] = await Promise.allSettled([publish('p1', draft), publish('p1', draft)]);
    const numbers = await versionNumbersOf('p1');
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('an imported playbook and its v1 appear together or not at all', async () => {
    // The orphan-with-no-identity-record case, which is the worse of the
    // two `publishAndPoint` was written for.
  });
});
```

- [ ] **Step 2: The route**

`POST /v1/playbooks/:id/versions` runs one `db.tx`:

```ts
    return db.tx(async t => {
      // FOR UPDATE on the playbook row: the version number is derived from
      // what exists, so two concurrent publishes must not both read the same
      // maximum. This is `nextSeq`'s argument, one store over — and the
      // reason `seq.ts` is type-enforced is that the same pattern was got
      // wrong twice before it was extracted.
      const pb = await t.query<PlaybookRow>(
        'select * from playbook where id = $1 and workspace_id = $2 for update',
        [id, ws]);
      if (!pb[0]) throw new ModelError('No such playbook.', 'not_found', 404);
      const next = await t.query<{ n: number }>(
        'select coalesce(max(version_number), 0) + 1 as n from playbook_version where playbook_id = $1',
        [id]);
      if (next[0].n > 1 && !summary?.trim()) {
        throw new ModelError(
          'A new version needs a short note saying what changed. Every version after the '
          + 'first carries one, so a reader of the history can see what moved.', 'conflict', 400);
      }
      const version = await t.query<PlaybookVersionRow>(
        `insert into playbook_version (id, workspace_id, playbook_id, version_number, content,
                                       summary, published_at, published_by_user_id)
         values ($1, $2, $3, $4, $5, $6, now(), $7) returning *`,
        [uid(), ws, id, next[0].n, content, summary ?? null, actor.id]);
      await t.query(
        'update playbook set current_version_id = $3, draft = null, updated_at = now(), version = version + 1 '
        + 'where id = $1 and workspace_id = $2',
        [id, ws, version[0].id]);
      return fromVersionRow(version[0]);
    });
```

Both writes in one transaction spanning both tables — the Postgres form of the guarantee `publishAndPoint`'s docstring describes, with the same reasoning and none of `idb`'s auto-commit hazards.

- [ ] **Step 3: Swap the browser bodies**

`publishAndPoint(playbook, draft, byUserId)` becomes one `POST`; `publishVersionIn` **loses its `idb` type parameter** and becomes an internal detail of the route, deleted from `playbookVersions.ts`. `saveDraft`/`discardDraft` become `PUT /v1/playbooks/:id` with the draft embedded — §6.1: *"`draft` stays embedded as `jsonb` — a draft is edited as one document, and splitting it invents a merge problem that does not exist."*

`exportPlaybook(content): Blob` is **unchanged**: it is pure, it builds a Blob in the browser from content the browser already has, and there is no reason for it to become a round trip. `importPlaybook(json, byUserId = '')` posts to `/v1/playbooks/import`, and its `''` default maps to a **NULL** `created_by_user_id` (P16) — not to the importing user. A playbook imported from a file was written by whoever wrote the file.

- [ ] **Step 4: Mutations**

1. Split the route's transaction into two `db.tx` calls. Expected: `does both, or neither` fails by name.
2. Remove `for update`. Expected: `allocates version numbers with no gap and no duplicate` fails — **if it does not, make the test genuinely concurrent** (two clients on two connections, not two awaited calls on one), because a serialised pair proves nothing about a race.
3. Change `POST /v1/playbooks/:id/versions` to `reviewer` in `ROUTE_POLICY`. Expected: `refuses a REVIEWER, and allows a partner` fails, **and** so does Task 5's role-matrix case for that key. Two failures is the right number: the table and the behaviour are checked separately.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/playbooks.ts apps/api/src/auth/routeTable.ts apps/api/src/server.ts \
  apps/api/test/playbooks.pg.test.ts src/lib/db/playbooks.ts src/lib/db/playbookVersions.ts \
  src/lib/db/playbooks.test.ts src/lib/db/playbookVersions.test.ts
git commit -m "feat: playbooks and versions over HTTP; publish-and-point is one Postgres transaction"
git show --stat HEAD
```

---

## Task 14: `changesets` over HTTP — an error type that has to survive the wire

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/changesets.ts`
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`
- Create: `apps/api/test/changesets.pg.test.ts`
- Modify: `src/lib/db/changesets.ts` (bodies only)
- Rewrite: `src/lib/db/changesets.test.ts`
- Modify: `packages/core/src/model/protocol.ts` (one new code)

**Interfaces:**
- Consumes: Task 13's version-publishing transaction; Task 8's `changeset` table. **Read `src/lib/db/changesets.ts`.** It exports `ChangesetStaleBaseError` (a class), `saveChangeset`, `getChangeset`, `listChangesets`, `recordDecision`, `publishChangeset(changeset, byUserId): Promise<PlaybookVersion>`, plus a dozen file-local helpers (`isDecided`, `isPublishable`, `publishedTextFor`, `provenanceFor`, `newClauseTitle`, `defaultExtractPrompt`, `applyItem`, `changeSummaryFor`). **Where the shipped source disagrees, the shipped source wins.**
- Produces: `GET /v1/playbooks/:id/changesets`, `GET/PUT /v1/changesets/:id`, `POST /v1/changesets/:id/publish`, and `'changeset_stale_base'` in `MODEL_ERROR_CODES`.

**The finding this task is really about.** `ChangesetStaleBaseError` is an **error class** that callers catch by identity: `publishChangeset` refuses outright, rather than silently reverting anyone's work, if the playbook has been published again since the changeset was built. Over HTTP the class does not travel — an exception's identity dies at the wire, and what arrives is a status and a body. This is the same shape as Stage 1's ruling **S1**: five copies of one sentence across three workspaces, with a browser matching on the gateway's exact wording and nothing making them agree. *"Reword any one and the browser silently stops classifying: no error, no failing test, just a firm-configuration fault shown to a lawyer as an ordinary one they might fix."*

**So the contract is the CODE, never the message.** `'changeset_stale_base'` joins `MODEL_ERROR_CODES` in `packages/core`; the route throws a `ModelError` carrying it; `src/lib/db/changesets.ts` reconstructs `ChangesetStaleBaseError` from that code, so `ChangesetReview.tsx` and every existing test keep catching the class they already catch.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/changesets.pg.test.ts
it('refuses a publish whose fromVersionId is no longer the playbook current version', async () => {
  await publishVersion('p1');                       // the changeset's base
  const cs = await putChangeset({ fromVersionId: 'v1', items: [accepted] });
  await publishVersion('p1');                       // somebody else publishes v2
  const res = await raw('POST', `/v1/changesets/${cs.id}/publish`);
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('changeset_stale_base');
  // Names both versions, because "stale" with no numbers tells a person
  // nothing they can act on.
  expect(res.json().error.message).toMatch(/v1.*v2|v2.*v1/);
});

it('publishes nothing at all when it refuses', async () => {
  expect(await versionNumbersOf('p1')).toEqual([1, 2]);
});

it('needs the partner role to publish, and a reviewer may still save decisions', async () => {
  expect((await publishAs('reviewer')).statusCode).toBe(403);
  expect((await saveDecisionAs('reviewer')).statusCode).toBeLessThan(400);
});
```

```ts
// src/lib/db/changesets.test.ts — the browser half of the same contract
it('reconstructs ChangesetStaleBaseError from the wire CODE, not from the message', async () => {
  mockFetch(409, { error: { code: 'changeset_stale_base', message: 'anything at all' } });
  await expect(publishChangeset(cs, 'u1')).rejects.toBeInstanceOf(ChangesetStaleBaseError);
});

it('does NOT match on wording — a reworded message still classifies', async () => {
  mockFetch(409, { error: { code: 'changeset_stale_base', message: 'totally different words' } });
  await expect(publishChangeset(cs, 'u1')).rejects.toBeInstanceOf(ChangesetStaleBaseError);
});

it('a different 409 is NOT a stale base', async () => {
  mockFetch(409, { error: { code: 'conflict', message: 'stale write' } });
  const err = await publishChangeset(cs, 'u1').catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(ChangesetStaleBaseError);
  expect(err).toBeInstanceOf(ModelError);
});
```

- [ ] **Step 2: Move the publish logic, and be honest about where it goes**

`publishChangeset`'s helpers (`applyItem`, `publishedTextFor`, `provenanceFor`, `changeSummaryFor`, `newClauseTitle`, `defaultExtractPrompt`) are **domain logic with no IO** — they turn a changeset and a version into the next version's content. Spec §5 says `packages/core` is *"every piece of domain logic that is neither React nor IO"*, and this is now needed on the server.

**Move them to `packages/core/src/playbook/applyChangeset.ts`, whole, with their tests, and have both sides import them.** Do not copy them: two copies of the code that decides what a published version says is the worst possible instance of this project's most repeated defect, and the two would be reachable only from two different processes. Their existing tests should pass with an import-path change and **nothing else** — if an assertion has to move, that module was not as pure as it looked and the edit is worth examining rather than making quietly (§14's rule for the 111 files, applied to six functions).

- [ ] **Step 3: The route, the class reconstruction, and the mutations**

The route runs the same one transaction Task 13 established: read the playbook `for update`, compare `current_version_id` with the changeset's `fromVersionId`, refuse or publish.

In `src/lib/db/changesets.ts`:

```ts
/** Unchanged in shape and in meaning; only its provenance moved. It used to
 *  be thrown here after a local read; it is now reconstructed from the API's
 *  `changeset_stale_base` code. The CODE is the contract and the message is
 *  not: a browser matching on wording across a network is a coupling nothing
 *  tests, and this project has already shipped that exact defect (S1). */
export class ChangesetStaleBaseError extends Error { /* …unchanged… */ }
```

**Mutation:** reword the route's message entirely. Expected: **every test still passes**, and that is the point — demonstrate it and say so in the report, exactly as Stage 1's S1 fix demonstrated rather than asserted. Then **second mutation:** change the route's code to `'conflict'`. Expected: `reconstructs ChangesetStaleBaseError from the wire CODE` fails by name.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/changesets.ts apps/api/src/auth/routeTable.ts apps/api/src/server.ts \
  apps/api/test/changesets.pg.test.ts packages/core/src/playbook packages/core/src/index.ts \
  packages/core/test/importBoundary.test.ts packages/core/src/model/protocol.ts \
  src/lib/db/changesets.ts src/lib/db/changesets.test.ts src/lib/buildChangeset.ts
git commit -m "feat: changesets over HTTP; the stale-base refusal travels as a code, never as wording"
git show --stat HEAD
```

---

## Task 15: `reviews` over HTTP — the debounced saver, and a write that cannot silently lose a colleague's

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/reviews.ts`
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`
- Create: `apps/api/test/reviews.pg.test.ts`
- Modify: `src/lib/db/reviews.ts` (bodies only; `createDebouncedReviewSaver` keeps its interface)
- Rewrite: `src/lib/db/reviews.test.ts`
- Modify: `src/App.tsx` (the saver's `onError`, and nothing else)

**Interfaces:**
- Consumes: Task 8's `review` table with its `findings jsonb`; Task 9's stale-write 409; `src/types.ts`'s `Review`, `Finding`, `ReviewTarget`. **Read `src/lib/db/reviews.ts`**: `listReviews(matterId)`, `getReview(id)`, `saveReview(r)`, `deleteReview(id)`, `DebouncedReviewSaver`, `createDebouncedReviewSaver(debounceMs?, onError?)`, plus file-local `buildVersionIndex` and an **async** `stripSeq`. **Where the shipped source disagrees, the shipped source wins.**
- Produces: `GET /v1/matters/:id/reviews`, `GET/PUT/DELETE /v1/reviews/:id`.

**Three things about this table that are not true of the other six.**

1. **It is the largest record by far.** A 3-document × 20-clause review holds sixty findings with citations, and the debounced saver writes the whole thing every two seconds during a run. That is fine over IndexedDB and expensive over HTTP. It stays a whole-record write in Stage 2 anyway (P11) — Stage 3 makes findings rows and the per-cell write follows the engine that needs it — but the request size must be checked against `API_MAX_BODY_BYTES` and the review path must not become the second place a body limit surprises someone.
2. **`saveReview` deep-clones `playbookSnapshot` before storing**, so a caller mutating its in-memory playbook right after an `await` cannot corrupt what was saved. Over HTTP that is free — `JSON.stringify` already copies — but the **returned** value must still be a copy the caller can hold, which it now is, because it is parsed from the response.
3. **The debounced saver's write is fire-and-forget.** Nothing awaits it, so a rejection cannot surface on a promise the caller holds. It already reports through `debug()` and through the optional `onError`. Over a network, failures go from rare to routine, so **`onError` must now be wired**: `App.tsx` passes one that raises a visible, non-blocking notice saying the in-progress review is not saving. Today it passes none, which was defensible against a local disk and is not against a network.

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips a review with sixty findings, citations and a net position, unchanged', async () => {
  // toEqual on the whole record. A findings map that loses one clause is a
  // review that silently claims less than it checked.
});

it('keeps an ABSENT optional key absent, rather than storing it as null', async () => {
  // `position_outcome` absent means "no standard position to compare
  // against"; `'unclear'` means "we have one and could not tell". These are
  // different facts and only the first should produce no comparison — and
  // `jsonb` will happily store `{"positionOutcome": null}`, which reads back
  // as a claim that a comparison was attempted.
  const saved = await put(`/v1/reviews/r1`, withFinding({ /* no positionOutcome key */ }));
  const finding = (await get('/v1/reviews/r1')).findings.k.c1;
  expect('positionOutcome' in finding).toBe(false);
});

it('keeps truncatedDocuments NULL rather than an empty array on a single-document finding', async () => {
  expect('truncatedDocuments' in finding).toBe(false);
});

it('preserves a verification exactly, including its byUserId and at', async () => {
  // Nothing derives a verification, and a round trip must not become the
  // first thing that does.
});

it('refuses a stale save with 409 and the current review', async () => { /* P9 */ });

it('refuses a review naming a document from another matter', async () => {
  // `ReviewTarget` carries documentIds; a target pointing outside the matter
  // is a review that would cite the wrong client's document — the failure
  // S23 exists to prevent, one table early.
});
```

```ts
// src/lib/db/reviews.test.ts
it('scheduleSave throttles rather than resetting, so a continuous run still saves', async () => {
  // The shipped comment is emphatic: a reset-on-every-call debounce could in
  // principle never fire, because `onUpdate` fires continuously through a
  // run. This behaviour is unchanged by the transport and its tests should
  // need no edit — if they do, say why.
});

it('hands a save failure to onError rather than losing it', async () => {
  // Newly load-bearing: over a network this fires.
});

it('saveNow cancels a pending timer and its promise is returned as-is', async () => { /* unchanged */ });
```

- [ ] **Step 2: The route**

`PUT /v1/reviews/:id` upserts, with `findings` and `playbook_snapshot` and `target` as `jsonb` parameters. **Pass them as JSON strings with an explicit `::jsonb` cast** rather than relying on `pg`'s object serialisation — `pg` stringifies a plain object into `json` correctly, but an array parameter is ambiguous (`text[]` versus `jsonb`) and getting it wrong produces a cryptic type error at run time, not at typecheck.

Validate the target against the matter in the same transaction as the write:

```ts
      const target = parseTarget(input.target);      // 400 on a shape that is not one of the two
      const ids = target.documentIds;
      if (ids.length > 0) {
        const rows = await t.query<{ id: string }>(
          'select id from document where workspace_id = $1 and matter_id = $2 and id = any($3::text[])',
          [ws, input.matterId, ids]);
        if (rows.length !== ids.length) {
          const missing = ids.filter(id => !rows.some(r => r.id === id));
          throw new ModelError(
            `This review names ${missing.length} document(s) that are not in this matter: `
            + `${missing.join(', ')}. A review can only cover documents in the matter it belongs to.`,
            'conflict', 400);
        }
      }
```

Task 19 adds `and kind = 'matter'` to that query, and the test that proves a precedent cannot be a review target lands with it.

- [ ] **Step 3: Wire `onError` in `App.tsx`**

The saver is constructed in `App.tsx`; find it and pass an `onError` that sets a visible notice. **This is a caller change, and it is a deliberate one, so it is a finding**: the seam held for the repository's *signature* (`createDebouncedReviewSaver(debounceMs?, onError?)` is unchanged — `onError` was already optional and already there for exactly this), and what changed is that a parameter nobody needed against a local disk is needed against a network. Write it up that way: the interface anticipated this, and the change is a caller taking an option that already existed.

The notice must not block the run and must not look like a finding: a run whose auto-save is failing is still producing correct answers, and saying *"this review is not being saved — your work is at risk if you close this tab"* is the honest wording. Wire it into the existing notice surface rather than inventing one.

- [ ] **Step 4: Mutations**

1. Store `findings` as `text` instead of `jsonb`. Expected: the absent-key tests still pass (JSON text preserves absence) but the round-trip test fails on type. **The point of doing it:** confirm the absent-key assertions are load-bearing on `jsonb` specifically, and if they pass under both, say so — an assertion that cannot distinguish the thing it names should be rewritten or removed.
2. Change the target validation to check the workspace but not the matter. Expected: `refuses a review naming a document from another matter` fails by name.
3. Remove the `onError` wiring in `App.tsx`. Expected: the App-level test for the save-failure notice fails by name. Write that test if none exists — a notice with no test is a notice the next restyle deletes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reviews.ts apps/api/src/auth/routeTable.ts apps/api/src/server.ts \
  apps/api/test/reviews.pg.test.ts src/lib/db/reviews.ts src/lib/db/reviews.test.ts src/App.tsx
git commit -m "feat: reviews over HTTP, with the debounced saver reporting a failed auto-save"
git show --stat HEAD
```

---

## Task 16: `profile` becomes `app_user` — `getProfile()` stops minting a person

**Type:** feature

**Files:**
- Modify: `src/lib/db/profile.ts` (bodies only — both exports keep their signatures)
- Rewrite: `src/lib/db/profile.test.ts`
- Modify: `src/App.tsx` (the one `.catch` that must now be reconsidered)
- Create: `src/lib/role.ts`, `src/lib/role.test.ts`

**Interfaces:**
- Consumes: Task 3's `GET /v1/me` and `PUT /v1/me`; Task 7's `api`; `src/types.ts`'s `UserProfile { id, name, initials }`; `MeResponse` from `@lexprompt/core`. **Read `src/lib/db/profile.ts`** — `getProfile(): Promise<UserProfile>` and `saveProfile(p: UserProfile): Promise<void>`, plus a module-level `creating` promise that memoises the in-flight default creation. **Where the shipped source disagrees, the shipped source wins.**
- Produces: `getProfile`/`saveProfile` over HTTP, `currentRole()`, `useRole()`.

**What changes in meaning, and it is the most interesting change in Part 2A.** Today `getProfile()` *mints a person*: it reads the single-record store, finds nothing on a fresh install, and creates `{ id: uid(), name: 'Me', initials: 'ME' }`. Its docstring says why — *"Nothing in the app is ever blocked on the user naming themselves first."* From Stage 2 there is a real person behind a real token, and inventing one would be inventing an attribution. So:

- **`getProfile()` resolves the signed-in user and never creates one.** The `creating` memoisation goes with the creation it guarded. What replaces it is a **cache of the response**, for the same reason it existed: `getProfile()` is called at ten sites in `App.tsx`, several of them on a write path, and ten round trips per save is not a design.
- **`saveProfile(p)` writes only the display name.** `id`, and now `role`, are not the user's to set. The signature keeps taking a whole `UserProfile` because every caller passes one; the route ignores what it may not accept, and a test asserts that.
- **A failure now matters.** `App.tsx:569` does `getProfile().then(setProfile).catch(() => {})` with the comment *"display-only; initials falls back to 'ME'"*. That stays correct for the header. The **write** paths (`App.tsx:1853`, `2081`, `2152`, `2208`, `2249`, `2570`, `2624`, `2912`, `2963`) do `const profile = await getProfile()` and will now reject on a network failure — which is right: a write that cannot say who made it must not happen. Confirm each of those nine call sites is inside a `try` that reports, rather than inside one that swallows. **List them in the report with what each does on failure.** This is exactly the kind of sweep that gets skipped and exactly the kind whose omission shows up as a silently unattributed write.

- [ ] **Step 1: Write the failing test**

```ts
describe('getProfile', () => {
  it('returns the signed-in user, with the app_user id', async () => {
    mockMe({ id: 'uuid-1', displayName: 'Ada Lovelace', initials: 'AL', role: 'partner' });
    expect(await getProfile()).toEqual({ id: 'uuid-1', name: 'Ada Lovelace', initials: 'AL' });
  });

  it('NEVER invents a profile when the request fails', async () => {
    // The old behaviour minted one, deliberately, so nothing was blocked on
    // a user naming themselves. Inventing one now would invent an
    // ATTRIBUTION: `ownerId`, `addedByUserId`, `byUserId` all come from
    // here, and a made-up id in any of them is a record claiming a person
    // who does not exist.
    mockMeFailure(503);
    await expect(getProfile()).rejects.toBeInstanceOf(ModelError);
  });

  it('makes one request for concurrent callers, and one more after a failure', async () => {
    // The cache replaces `creating` and inherits its rule: cleared on
    // failure so one rejection does not poison every future call, which is
    // the rule `getDb` follows too.
    mockMe(user); const [a, b] = await Promise.all([getProfile(), getProfile()]);
    expect(a).toBe(b); expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes after saveProfile, so the header shows the new name', async () => { /* … */ });
});

describe('saveProfile', () => {
  it('sends only the display name', async () => {
    await saveProfile({ id: 'uuid-1', name: 'Ada L', initials: 'AL' });
    expect(JSON.parse(body)).toEqual({ displayName: 'Ada L' });
    // Not `{ id, name, initials }`: a route that accepted an id would accept
    // a request to become somebody else, and a route that accepted initials
    // would let the two disagree.
  });
});

describe('currentRole', () => {
  it('is undefined before /v1/me has answered, and NOT "reviewer"', async () => {
    // A default role is a permission granted by a loading state. The UI must
    // render "not yet known" rather than the lowest role, or a partner sees
    // Publish disabled for a moment and clicks something else.
    expect(currentRole()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement**

```ts
/**
 * The one local profile becomes the signed-in `app_user` (§6.5).
 *
 * It no longer MINTS a person. The old implementation created a default on
 * first call so nothing was blocked on a user naming themselves; there is a
 * real person behind a real token now, and a minted id would go straight
 * into `ownerId`, `addedByUserId` and `Verification.byUserId` as an
 * attribution to somebody who does not exist.
 *
 * The in-flight memoisation survives its original reason and keeps it: ten
 * call sites, several on write paths, must not each cost a round trip.
 * Cleared on failure — so one rejection does not poison every later call,
 * the rule `getDb` follows — and cleared by `saveProfile`, so the header
 * shows a renamed user without a reload.
 */
let inFlight: Promise<UserProfile> | null = null;
let cached: UserProfile | null = null;
let cachedRole: Role | undefined;

export async function getProfile(): Promise<UserProfile> {
  if (cached) return cached;
  inFlight ??= api.get<MeResponse>('/v1/me')
    .then(me => {
      cachedRole = me.role;
      cached = { id: me.id, name: me.displayName, initials: me.initials };
      return cached;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function saveProfile(p: UserProfile): Promise<void> {
  const me = await api.send<MeResponse>('PUT', '/v1/me', { displayName: p.name });
  cachedRole = me.role;
  cached = { id: me.id, name: me.displayName, initials: me.initials };
}

/** Clears the cache. Called on sign-out and by tests. */
export function forgetProfile(): void { cached = null; inFlight = null; cachedRole = undefined; }
```

`src/lib/role.ts` exposes `currentRole(): Role | undefined` reading `cachedRole` after `getProfile()` has resolved, plus a `useRole()` hook with **three** states — `undefined` (not yet known), a role, or a failure — because two states would make "loading" indistinguishable from "reviewer", and that is the load-state rule applied to a permission.

- [ ] **Step 3: The nine write-path call sites**

Read each of the nine `await getProfile()` sites in `App.tsx` and confirm what happens when it rejects. Several already sit inside a `try` that sets an error state; any that do not get one. **Do not add a fallback id anywhere** — the correct behaviour on "we cannot say who you are" is to refuse the write and say so, not to write it anonymously.

- [ ] **Step 4: Mutations**

1. Make `getProfile` return a default on failure. Expected: `NEVER invents a profile when the request fails` fails by name.
2. Remove the `.finally(() => { inFlight = null; })`. Expected: write a test for it if none fails — a poisoned in-flight promise means every later call replays one failure forever, and the symptom is an app that never recovers from one blip.
3. Make `currentRole()` return `'reviewer'` when unknown. Expected: `is undefined before /v1/me has answered` fails by name.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/profile.ts src/lib/db/profile.test.ts src/lib/role.ts src/lib/role.test.ts src/App.tsx
git commit -m "feat(web): getProfile resolves the signed-in app_user and never invents one"
git show --stat HEAD
```

---

## Task 17: Told plainly — the no-role screen, the disabled-account screen, and the role gate in the UI

**Type:** feature

**Files:**
- Create: `src/features/auth/AccessRefusedPanel.tsx`, `src/features/auth/AccessRefusedPanel.test.tsx`
- Modify: `src/App.tsx` (the gate, beside Stage 1's sign-in gate)
- Modify: `src/lib/authFailure.ts` (one classifier, extended)
- Modify: `src/features/templates/PublishDialog.tsx` and wherever Publish is offered

**Interfaces:**
- Consumes: Task 16's `useRole()`; Task 7's `describeLoadError`; `isSignInError`/`isServiceConfigError` from `src/lib/authFailure.ts` (Stage 1's extraction, made because the disjunction had **nine** call sites); `ServiceConfigError` from `src/components/ServiceConfigError.tsx`. **Read `src/lib/authFailure.ts` and `src/components/ServiceConfigError.tsx`; where they disagree with this brief, the shipped source wins.**
- Produces: `AccessRefusedPanel`, and the role-aware disabling of the two partner-only actions.

**§7's requirement, in its own words:** *"A user in no mapped group has no access at all and is told so plainly — not shown an empty app, which would be the 'empty is not broken' rule failing at the front door."* Stage 1 deferred this explicitly and seeded the `nogroups` account for it. This is the task it was seeded for.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('a user in no mapped group', () => {
  it('is told plainly, and is not shown an empty app', async () => {
    mockMeFailure(403, 'no_role', 'Your account is not in any group… Your sign-in carries these groups: all-staff.');
    const { container } = await mountApp();
    expect(container.textContent).toMatch(/do not have access to LexPrompt/i);
    // The groups the token carried are shown, because they are what an
    // administrator needs in order to fix it.
    expect(container.textContent).toContain('all-staff');
    // …and nothing that looks like a working, empty app is on screen.
    expect(container.textContent).not.toMatch(/no matters yet/i);
    expect(container.querySelector('button[aria-label="New matter"]')).toBeNull();
  });

  it('offers Sign out, and NOT Retry', async () => {
    // Retry is the wrong affordance: nothing about signing in again changes
    // a group mapping, and offering it manufactures a loop. Signing out and
    // in as somebody else is the only thing the person at the keyboard can
    // actually do.
    expect(buttonNamed(/sign out/i)).toBeTruthy();
    expect(queryButtonNamed(/^retry$/i)).toBeNull();
  });

  it('a DISABLED account gets a different screen from a no-role one', async () => {
    mockMeFailure(403, 'account_disabled', 'Your LexPrompt account has been disabled…');
    expect(container.textContent).toMatch(/has been disabled/i);
    expect(container.textContent).not.toMatch(/not in any group/i);
  });

  it('GROUP OVERAGE gets its own screen, and is not folded into "no access"', async () => {
    // §7's hardest case, and the one that cannot be reproduced locally.
    // Reading it as "in no mapped group" would tell a partner in forty
    // groups that they have no access — a wrong answer delivered
    // confidently, to the person least able to accept it.
    mockMeFailure(403, 'group_overage', 'Your account is in too many groups…');
    expect(container.textContent).toMatch(/too many groups/i);
    expect(container.textContent).toMatch(/administrator/i);
    expect(container.textContent).not.toMatch(/not in any group/i);
  });

  it('a 503 service_misconfigured still routes to ServiceConfigError, not here', async () => {
    // Task 23 of Stage 1 split these deliberately: "the user's problem" and
    // "the firm's problem" are different screens, and a configuration fault
    // must not be shown to a lawyer as something about their account.
  });
});

describe('the role gate in the UI', () => {
  it('disables Publish for a reviewer and says why', async () => {
    expect(publishButton().getAttribute('aria-disabled')).toBe('true');
    expect(publishButton().getAttribute('title')).toMatch(/partner/i);
  });

  it('enables it for a partner', async () => { /* … */ });

  it('does not disable it while the role is still unknown — it hides the whole panel instead', async () => {
    // Rendering a disabled Publish during loading tells a partner they
    // cannot publish. "Not yet known" is a third state and renders as one.
  });
});
```

- [ ] **Step 2: Build the panel**

One component, three messages, chosen by `ModelError.code` — never by matching wording (S1). It renders the **API's own message** rather than a local paraphrase, for the reason `describeLoadError` passes a `DbBlockedError`'s message through: the server knows the groups the token carried and the browser does not.

`src/index.css` gains no new colour role; if the design needs one, add it to `index.css` **in the same commit** that first uses it (`CLAUDE.md`), and build the class name as a complete literal string — never `` `text-${kind}` ``, which Tailwind's scanner cannot see and which fails silently with no error and no test.

- [ ] **Step 3: The two partner-only actions**

Publish a playbook version, and publish a changeset. Both get a disabled control with a `title` naming the role needed. **The API already refuses both** (Task 13, Task 14) and its tests prove it; this is the "a dead button is bad design" half, and it is explicitly *not* the security control.

Add a test asserting the pairing: for each gated control, the UI disables it **and** the corresponding `ROUTE_POLICY` entry is `partner`. A control disabled with no API entry behind it is theatre, and an API entry with no control is a button that fails when clicked.

- [ ] **Step 4: Run the app and sign in as all four accounts**

`npm run compose:up`, then in four browser profiles sign in as `trainee`, `partner`, `admin`, `nogroups`. Confirm: three get the app with Publish enabled for two of them; the fourth gets the refusal screen naming its groups. **Screenshot each.** Say plainly if you could not — Stage 1's Task 22 could not reach Settings past the sign-in gate and said so rather than weakening the gate to see past it, which was the right call and is the standard here.

- [ ] **Step 5: Commit**

```bash
git add src/features/auth src/App.tsx src/lib/authFailure.ts src/features/templates/PublishDialog.tsx
git commit -m "feat(web): a user with no mapped role is told plainly, and the two partner actions say so"
git show --stat HEAD
```

---

## Task 18: Workspace settings — the model choice becomes the admin's, and Part 2A's definition of done

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/workspaceSettings.ts`, `apps/api/test/workspaceSettings.pg.test.ts`
- Create: `src/features/settings/WorkspaceModelPanel.tsx` and its test
- Modify: `src/lib/storage.ts`, `src/types.ts` (`Settings` loses its model fields)
- Modify: `src/features/settings/SettingsPanel.tsx`, `src/features/settings/ModelPicker.tsx`
- Modify: `apps/api/src/auth/routeTable.ts`

**Interfaces:**
- Consumes: Stage 1's `GET /v1/models` (the allowlist's **only** wire surface — `apps/api` must not start validating a model choice, and must not hold a second list); `Settings` from `src/types.ts` (`modelChoiceId`, `modelChoiceLabel`, `modelChoiceModel`, `concurrency`, `modelSupportsImages`, `modelSupportsStructuredOutput`, `modelContextLength`); `loadSettings()` returning `{ settings, purgedApiKey }`. **Read `src/lib/storage.ts` and `src/types.ts`; where they disagree with this brief, the shipped source wins.**
- Produces: `GET /v1/workspace/settings` (any role), `PUT /v1/workspace/settings` (admin), and `Settings` reduced to genuine per-user preferences.

**§6.6, and S16's limit on it.** *"`Settings.modelId` becomes workspace configuration an admin sets from the allowlist of provider+model pairs. `Settings.concurrency` becomes a server-side per-run bound."* The second half is **Stage 3's**: there is no run on the server yet, so `concurrency` moves to the workspace row and is *stored* here, and the thing that enforces it as a per-run bound arrives with the runs. Say that rather than half-implementing it. **R6 survives for what is left**: genuine per-user UI preferences stay in `localStorage`, synchronously, for the reason R6 gave — and after this task there may be none left, in which case `storage.ts` keeps only the API-key purge and says so.

- [ ] **Step 1: Write the failing tests**

```ts
it('answers the workspace model choice to any signed-in role', async () => { /* … */ });

it('refuses a PUT from a reviewer and from a partner, and accepts one from an admin', async () => {
  expect((await putAs('reviewer')).statusCode).toBe(403);
  expect((await putAs('partner')).statusCode).toBe(403);
  expect((await putAs('admin')).statusCode).toBeLessThan(400);
});

it('records WHO changed it and when', async () => {
  // Not a collaboration affordance (R-G1 still binds): it is the same
  // attribution every other record carries, and an administrator changing
  // which provider the firm's text goes to is exactly the change §12 asks to
  // be answerable about.
  expect((await get()).updatedByUserId).toBe(adminId);
});

it('refuses a model choice the gateway allowlist does not contain', async () => {
  // The allowlist has ONE home and it is the gateway (Stage 1, interface
  // note 2). So this route asks the gateway rather than holding a list: it
  // calls GET /v1/models through the same gatewayClient every other route
  // uses, and refuses an id that is not there. A second list here would be
  // the drift that note exists to prevent.
  expect((await put({ modelChoiceId: 'not-on-the-list' })).statusCode).toBe(400);
});

it('refuses a stale write with 409 (P9)', async () => { /* … */ });
```

```tsx
it('shows a reviewer the workspace model, read-only, with its provider and jurisdiction', async () => {
  // Unconditional labelling, in the same neutral form for every entry (S27):
  // labelling only some models would make the ABSENCE of a label carry
  // meaning, which is the blank-CSV-cell defect exactly.
  expect(container.textContent).toContain('UK');
  expect(container.textContent).toMatch(/set by an administrator/i);
});

it('shows an admin a picker, and writes through it', async () => { /* … */ });

it('distinguishes not-yet-loaded, failed and empty when the allowlist will not load', async () => {
  // Three states, three renderings. An empty allowlist is a real
  // configuration and reads as "your administrator has configured no
  // models"; a failure reads as a failure.
});
```

- [ ] **Step 2: Move the fields**

`Settings` in `src/types.ts` loses `modelChoiceId`, `modelChoiceLabel`, `modelChoiceModel`, `concurrency`, `modelSupportsImages`, `modelSupportsStructuredOutput` and `modelContextLength`. They become a `WorkspaceSettings` type in `packages/core/src/api/records.ts`, read by both sides.

`loadSettings()` keeps its signature and its **API-key purge**, which is Stage 1's DoD and must not be lost: *"no OpenRouter key exists in any browser"*, and `loadSettings` is where that becomes true rather than intended. It gains the removal of the model fields from a stored blob, for the same reason — a stale `modelChoiceId` in `localStorage` after the choice became the workspace's would be a value nothing reads, sitting behind a screen that used to imply it was in use.

**Every caller that reads `settings.modelChoiceId` changes.** That is roughly ten call sites — `extractClause`, `extractCollectionClause`, `chatContext`, `generateDraft`, `suggestField`, `suggestMissingClauses`, `inferPositions`, `buildChangeset`, `draftEmail`, `suggestRevision` — and it is a **caller change, so it is a finding.** It is also not a repository-seam failure: `Settings` was never one of the nine repositories, it is `localStorage` by R6, and §6.6 moves it deliberately. Say exactly that in the report, so a reader does not count it against R3.

Thread the workspace settings the same way Stage 1 threaded `purpose` and `context`: a `WorkspaceSettings` argument, appended last and optional where a default is honest. Stage 1's Task 21 found that putting new fields **ahead** of `signal` in a parameter list silently broke a mock that destructured the fifth positional argument — append, and check the mocks.

- [ ] **Step 3: Part 2A's definition of done, on a live stack**

This is the gate on Part 2B. Run it, record the result, and do not start Task 19 until it passes.

```bash
npm run compose:up
npm run typecheck > /tmp/tc.txt 2>&1; echo "EXIT=$?"
npx vitest run   > /tmp/t.txt  2>&1; echo "EXIT=$?"
npm run test:pg  > /tmp/tp.txt 2>&1; echo "EXIT=$?"
npm run test:compose > /tmp/tc2.txt 2>&1; echo "EXIT=$?"
npm run build    > /tmp/b.txt  2>&1; echo "EXIT=$?"; grep -i external /tmp/b.txt
```

Then, in a browser, as each of the four seeded accounts:

1. **`nogroups`** — refused, plainly, groups named. *(§7, and the account Stage 1 seeded for this.)*
2. **`trainee`** — creates a matter, uploads a **scanned PDF** and a **marked-up DOCX**, opens both in the viewer, runs a review, verifies a finding, writes a note, exports a DOCX. Then **reloads** and confirms every one of those survived. *(Every record type round-trips; bytes round-trip.)*
3. **`trainee`** — Publish is disabled and says why. **`partner`** — Publish works; a version is created and the playbook points at it.
4. **`admin`** — changes the workspace model choice; `trainee`'s next review uses it.
5. **`trainee`** — deletes the matter, then check Azurite: `docker compose exec api node -e "…blobStore.list('workspace/…/document/')"` returns nothing. *(Deleting a matter purges its blobs.)*
6. **Two tabs** — save the same matter from both; the second is refused with a message, not silently applied. *(P9.)*
7. **`docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com'`** — still fails. *(§5's central claim, re-checked after three new dependencies.)*

**Write down which of these you ran and which you could not.** If a step could not be run, say so in exactly those words rather than implying it: Stage 1's ledger is full of such statements and each of them was worth more than a claim would have been.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/workspaceSettings.ts apps/api/src/auth/routeTable.ts \
  apps/api/test/workspaceSettings.pg.test.ts src/features/settings src/lib/storage.ts \
  src/types.ts src/features/review src/features/assistant src/features/authoring \
  src/features/templates src/lib/inferPositions.ts src/lib/buildChangeset.ts
git commit -m "feat: the model choice becomes workspace configuration an admin sets"
git show --stat HEAD
```

---

# Part 2B — precedent storage, the uploader, and the retirement

Tasks 19–27. **Do not start until Part 2A's definition of done (Task 18 Step 3) has been run on a live stack and reported.**

**Definition of done for this part** (§18 item 3, remaining clauses): the browser uploader moves the owner's data and names anything it could not; **a precedent document is stored, is not offerable as a review target or a collection member, and no screen in the app says it is not stored — searched, not assumed, across `src/`, the README and the test suite.**

---

## Task 19: Precedent storage and the copy change — one task, one commit, and they cannot be separated

**Type:** feature — **and this is the task in this plan most likely to be split for size. It must not be.**

**Files:**
- Create: `apps/api/migrations/003_precedent.sql`
- Create: `apps/api/src/routes/precedents.ts`
- Modify: `apps/api/src/routes/documents.ts`, `collections.ts`, `reviews.ts` (the `kind = 'matter'` predicate)
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`
- Create: `apps/api/test/precedent.pg.test.ts`
- Modify: `apps/api/test/workspaceScope.test.ts` (the scanner learns about `kind`)
- **Modify: `src/lib/privacyCopy.ts`** — the replacement sentence, in the one place disclosure wording lives (R-G5)
- **Modify: `src/features/redlines/PrecedentIntake.tsx`** — the header sentence
- **Modify: `src/features/redlines/PrecedentUploadPanel.tsx`** — its **docstring only**; its on-screen sentence is unchanged and stays where it is
- **Modify: `src/App.tsx`** — the `redlinesDocs` comment, and the upload wiring
- **Rewrite (never delete): `src/App.redlines.test.tsx`** — the `occurrences('Never stored')` assertion and the whole `describe('a precedent document is read and never stored (spec §4, §11)')` block
- **Modify: `src/types.ts`** — the `Changeset.basis` remark about source documents being "read, never stored"
- **Modify: `README.md`** — the §Learning from redlines bullet
- Create: `src/lib/db/precedents.ts` and its test

**Interfaces:**
- Consumes: Task 8's `document` table (which has **no** `kind` column — this task adds it); Task 10's `BlobStore` and `blobKeyFor`; Task 11's `POST /v1/documents` multipart handler and its blob-first write order; `src/lib/chains.ts`'s `PrecedentDocument`; `App.tsx`'s `redlinesDocs` / `redlinesFilesRef` session state. **Read all of these; where they disagree with this brief, the shipped source wins.**
- Produces: `document.kind`, `precedent_set`, `POST /v1/precedent-sets`, `POST /v1/precedent-sets/:id/documents`, `GET /v1/precedent-sets/:id`, `src/lib/db/precedents.ts`, and `PRECEDENT_STORAGE_PRIVACY` in `privacyCopy.ts`.

### Why this is one task

§11.1 states it as an acceptance condition, not a note: *"The same stage, and the same change. The migration that adds `document.kind = 'precedent'` and the copy change land together. There is no release in which the storage exists and the sentence does."* S24 gives the cost of not following it: *"the app shows a lawyer 'Never stored' on the screen where they choose which of their client's documents to upload, while storing them. That is not a copy defect; it is the founding defect of this project in its purest form, and it would be shipped deliberately."*

And §13 forecloses the obvious escape: *"If Stage 2 is decomposed further, that split must not put the storage in one piece and the sentence in the next."*

**If this task is too large to run in one dispatch, the thing to move out is `position_basis` (Task 20), which is already out.** Nothing else may leave.

### The six places the old promise lives, all of which change here

Found by search, not by memory — run this first and reconcile the result against the list, because a seventh would be exactly the kind of thing this task exists to catch:

```bash
grep -rn "Never stored\|never stored\|stores none of them\|read once" \
  src README.md docs/superpowers/redesign/rulings.md
```

| # | Where | What it says today | What happens |
|---|---|---|---|
| 1 | `src/features/redlines/PrecedentIntake.tsx:147` | **"Read once to learn from. Never stored."** — the on-screen promise, at the moment of upload | Replaced by `PRECEDENT_STORAGE_PRIVACY`, **in the same place** so the promise is still said exactly once |
| 2 | `PrecedentIntake.tsx:141–146` | The comment explaining why the strong form was chosen | Rewritten to explain why the **new** sentence is the strong form, and to record that the old one was true when written |
| 3 | `src/features/redlines/PrecedentUploadPanel.tsx:18, 44` | A docstring saying the sibling promises "never stored" | Docstring corrected. **Its on-screen sentence — "Marked-up .docx files are read for tracked changes; anything else, including PDFs, can be compared against another version instead" — is UNCHANGED and stays where it is.** It is true, it is about what is *read*, and it says nothing about storage (§2's table says exactly this) |
| 4 | `src/App.tsx:648` | *"read once, never stored"* on `redlinesDocs` | Rewritten. A stale comment is how a true statement gets restored by a well-meaning refactor |
| 5 | `src/types.ts:314` | `Changeset.basis` exists *"after the source documents (which are read, never stored — spec §4.1) are gone"* | Rewritten: the sources are now kept, so the durable copy becomes a **corroboration** rather than the only surviving witness (§11.1's own words) |
| 6 | `README.md:70` | *"stores none of them: not in IndexedDB, not in `localStorage`, not in the URL"* | Replaced (§2's table). **What survives verbatim: *only the standard positions you go on to adopt reach a playbook*** — storing a precedent does not put it in a playbook |

### The replacement sentence

It goes in `src/lib/privacyCopy.ts` and nowhere else (R-G5, and §11.1 requirement 2). It must be as strong in its new direction as the old one was in its: it says what happens, where, and what it is kept apart from.

```ts
/**
 * Replaces `PrecedentIntake`'s "Read once to learn from. Never stored."
 *
 * That sentence was TRUE when it was written and this module's job is to
 * make sure the one that replaces it is true now. §11.1 stores precedent
 * documents server-side, so the promise changes in the same commit as the
 * storage — a screen that told a lawyer their client's marked-up lease was
 * never stored, while storing it, is this project's founding defect in its
 * purest form.
 *
 * Three facts, in the order a person choosing a file needs them: it is
 * kept, it is kept apart, and somebody decides for how long. The middle one
 * is the one S23 exists for — a precedent that could be opened as the deal
 * in hand is a citation with apparent authority pointing at another client's
 * document.
 */
export const PRECEDENT_STORAGE_PRIVACY =
  "Stored in your firm's LexPrompt, with the playbook you build from them. Kept apart from "
  + 'matter documents: a precedent is never offered as something to review, added to a '
  + 'collection, or cited in a report. Your firm decides how long they are kept.';
```

**And `STORAGE_PRIVACY` is rewritten in this stage too** — `privacyCopy.ts`'s own comment says so: *"Stage 1 makes the first sentence true; Stage 2 makes the second one true and rewrites `STORAGE_PRIVACY` with it."* Its IndexedDB sentences become the firm's Postgres and Blob Storage, per §2's table. The two clauses that survive verbatim are *"Deleting a matter deletes its documents and their stored bytes, not just its entry in a list"* and the page-images sentence, **including its straight apostrophes** — that file's own comment records that an extraction whose purpose was to stop wording drifting must not itself change two characters of a frozen disclosure.

- [ ] **Step 1: Write the failing tests — storage first**

`apps/api/test/precedent.pg.test.ts`:

```ts
describe('a precedent document is a document, and is not a matter document', () => {
  it('stores a precedent with a set and no matter', async () => {
    const doc = await uploadPrecedent(setId, file);
    expect(doc.kind).toBe('precedent');
    expect('matterId' in doc).toBe(false);
  });

  it('refuses a precedent row with a matter_id', async () => {
    await withPg(async t => {
      await expect(t.query(
        `insert into document (id, workspace_id, kind, matter_id, precedent_set_id, name, doc_type,
                               text, byte_size, mime, blob_key, parse_state, role, added_at)
         values ('x', $1, 'precedent', 'm1', 's1', 'D', 'docx', 't', 1, 'm', 'k', 'parsed', 'standalone', now())`,
        [WS])).rejects.toThrow(/check constraint/i);
    });
  });

  it('refuses a matter row with a precedent_set_id', async () => { /* the reverse */ });

  it('refuses a matter row with NO matter_id', async () => {
    // Not a nullable matter_id alone (§11.1): the constraint has to bite in
    // both directions, or "a document with no matter" quietly becomes a
    // third state nothing filters.
  });

  it('a precedent NEVER appears in a matter document list', async () => {
    await uploadPrecedent(setId, file);
    expect(await get(`/v1/matters/m1/documents`)).toEqual([]);
  });

  it('REFUSES a precedent as a review target — not merely absent from a picker', async () => {
    // §11.1: "refused by the API rather than merely absent from a picker."
    // A picker that omits it is a UI convention; a refusal is a control.
    const res = await raw('PUT', '/v1/reviews/r1', { ...review, target: {
      kind: 'documents', documentIds: [precedentId] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/precedent/i);
  });

  it('REFUSES a precedent as a collection member, base or varies', async () => {
    for (const body of [{ baseDocumentId: precedentId }, { variesDocumentIds: [precedentId] }]) {
      expect((await raw('PUT', '/v1/collections/c1', { ...collection, ...body })).statusCode).toBe(400);
    }
  });

  it('refuses a precedent by DIRECT id fetch through the matter-document route', async () => {
    // The predicate has to be on the READ as well as on the list, or a
    // deep link is a way round it.
    expect((await raw('GET', `/v1/documents/${precedentId}`)).statusCode).toBe(404);
  });

  it('serves a precedent through its OWN route, so the workings can still show it', async () => {
    // The positive half. Without it, a `kind` predicate on every route would
    // pass all of the above and make precedents unreachable — which is a
    // different bug with the same green suite.
    expect((await raw('GET', `/v1/precedent-documents/${precedentId}`)).statusCode).toBe(200);
  });

  it('deleting a precedent set deletes its documents and their blobs', async () => { /* … */ });
});
```

And the scanner, extended in `workspaceScope.test.ts`:

```ts
it('every statement reading `document` in a matter context also names kind', () => {
  // §19: "the thing to watch in implementation is a query that forgets the
  // kind predicate, because such a query fails by showing TOO MUCH rather
  // than too little, and nothing on screen would look wrong."
  const offenders = statementsIn(codeOf(f))
    .filter(s => /\bfrom document\b|\bjoin document\b/.test(s))
    .filter(s => /matter_id/.test(s))
    .filter(s => !/\bkind\b/.test(s));
  expect(offenders).toEqual([]);
  // The scanner must find statements at all, or this is decoration.
  expect(statementsIn(codeOf(documentsRoute)).length).toBeGreaterThan(3);
});
```

- [ ] **Step 2: Write the copy tests — in the same step, deliberately**

Rewriting `src/App.redlines.test.tsx` is **requirement 4 of §11.1** and is not optional: *"The tests that assert the promise are rewritten in the same change, not deleted. A promise test that is deleted rather than replaced is how the next person learns there was never a promise."*

```tsx
// Was: it('renders one heading and states the storage promise once, in the strong form')
it('renders one heading and states the STORAGE promise once, in the strong form', async () => {
  // `PrecedentUploadPanel` and `PrecedentIntake` are siblings on this route,
  // and two wordings of one promise was a real defect that had to be fixed
  // once already. The promise has CHANGED — precedents are stored now
  // (§11.1) — and it is still said exactly once, in the same place, in the
  // strong form. What the panel says is unchanged: it is about what is READ.
  await openRedlinesIntake();
  const text = container.textContent ?? '';
  const occurrences = (needle: string) => text.split(needle).length - 1;

  expect(occurrences('Bring in what you negotiated')).toBe(1);
  expect(occurrences(PRECEDENT_STORAGE_PRIVACY)).toBe(1);
  // The old promise is GONE from the screen, and this assertion is paired
  // with the positive one above so it cannot pass by the screen being empty.
  expect(text).not.toContain('Never stored');
  expect(text).not.toContain('Not stored with the playbook');
  // The panel's own sentence is untouched and still there.
  expect(text).toContain('Marked-up .docx files are read for tracked changes');
});

// Was: describe('a precedent document is read and never stored (spec §4, §11)')
describe('a precedent document is stored, and is never a matter document (spec §11.1)', () => {
  it('uploads to the precedent set and NOT through addDocument', async () => {
    await reachTheDraftReview();
    // `addDocument` is the MATTER ingest path. A precedent going through it
    // would be a precedent in a matter's document list — S23's whole point.
    expect(addDocumentMock).not.toHaveBeenCalled();
    // …and the positive half, which the old test could not have: something
    // was stored, and it was stored as a precedent.
    expect(uploadPrecedentMock).toHaveBeenCalledTimes(2);
    expect(uploadPrecedentMock.mock.calls[0][1].kind).toBe('precedent');
  });

  it('still writes nothing about a precedent to localStorage or the URL', async () => {
    // What DID survive from the old promise. Server-side storage is the
    // change; a document's text in `localStorage` was never the plan and
    // still is not.
    const keys = Object.keys(localStorage);
    for (const key of keys) expect(localStorage.getItem(key)).not.toMatch(/Brookvale|TEXT OF/);
    expect(window.location.href).not.toMatch(/Brookvale/);
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

Run: `npm run test:pg -- precedent` and `npx vitest run --project web App.redlines`
Expected: both FAIL. **Confirm the copy test fails on the assertion you expect** — `expect(occurrences(PRECEDENT_STORAGE_PRIVACY)).toBe(1)` receiving `0` — rather than on an import error, which would prove nothing about the screen.

- [ ] **Step 4: Migration 003**

```sql
-- §11.1 / S23. A precedent is somebody else's deal, brought in to learn
-- from, usually with an opposing party's markup still in it. If it appeared
-- in a matter's document list it could be opened as though it were the deal
-- under review, added to a collection, run through a playbook, or cited in
-- an export — and a citation pointing into the wrong client's lease is the
-- kind of error this app exists to make impossible.
--
-- NOT a nullable matter_id alone, and NOT a naming convention: this is a
-- distinction that must survive somebody writing a new query.

create table precedent_set (
  id                 text primary key,
  workspace_id       uuid not null references workspace(id),
  name               text not null,
  -- NULL until a playbook adopts from it (§6.5).
  playbook_id        text references playbook(id) on delete set null,
  created_by_user_id uuid references app_user(id),
  created_at         timestamptz not null,
  version            bigint not null default 1,
  seq                bigint generated always as identity
);

alter table document add column kind text not null default 'matter'
  check (kind in ('matter', 'precedent'));
alter table document add column precedent_set_id text references precedent_set(id) on delete cascade;
-- The default exists only so this ALTER can run against rows that already
-- exist, every one of which is a matter document. It is DROPPED immediately,
-- because a default is how a future INSERT that forgets `kind` silently
-- becomes a matter document — and "silently becomes a matter document" is
-- precisely the failure the column exists to prevent.
alter table document alter column kind drop default;

alter table document add constraint document_kind_shape check (
  (kind = 'matter'    and matter_id is not null and precedent_set_id is null) or
  (kind = 'precedent' and matter_id is null     and precedent_set_id is not null)
);

create index document_precedent_set_idx on document (workspace_id, precedent_set_id);

grant select, insert, update, delete on precedent_set to lexprompt_app;
```

- [ ] **Step 5: The `kind = 'matter'` predicate, everywhere it belongs**

`document.matter_id` is nullable now, so a query joining on it already excludes precedents — **and relying on that would be exactly the convention S23 refuses.** Add the predicate explicitly to every matter-context query in `documents.ts`, `collections.ts` and `reviews.ts`, and let the scanner in Step 1 hold it there. A predicate that is redundant today and load-bearing after the next schema change is the cheap half of this ruling.

The review-target and collection-member checks from Task 12 and Task 15 gain `and kind = 'matter'` **and a specific refusal message**: a generic "document not found" would send someone hunting for a document that is right there in front of them on the playbook side of the app.

- [ ] **Step 6: The upload path**

`POST /v1/precedent-sets` creates a set. `POST /v1/precedent-sets/:id/documents` takes the same multipart shape `POST /v1/documents` takes and **shares its handler body** — §13's own words are *"the ingest path they already share"*, and two ingest handlers would be two places for a blob-first ordering to drift. Extract the shared part rather than copying it; that is the extract-at-the-second-copy rule on the path where the first copy is four days old.

`src/lib/db/precedents.ts` is the browser side: `createPrecedentSet(name)`, `uploadPrecedent(setId, rec, bytes)`, `getPrecedentSet(id)`, `listPrecedentDocuments(setId)`, `deletePrecedentSet(id)`.

In `App.tsx`, `handleAddRedlinesFiles` uploads each file as it is brought in, **in addition to** the existing in-session parse. The parse stays in the browser: `docxRedlines.ts` reads the OOXML directly (never through `mammoth`, which silently discards `<w:ins>` and `<w:del>`), it needs the raw bytes, and it already runs there. What changes is that the bytes now also go to the server. `redlinesFilesRef` keeps holding the live `File` for the session, exactly as it does today.

**What must NOT change:** the session is still lost on reload (`useUnsavedDraftGuard`'s two exits stay), because an `AuthoringDraft` is still never persisted (R-E1) — storing the *documents* does not store the *draft*, and conflating those would put half-reviewed model output into persistence. And *"only the standard positions you go on to adopt survive, inside the playbook you eventually save"* stays exactly as true as it was: a playbook is house rules, not a document archive.

- [ ] **Step 7: The copy, in all six places, in this commit**

Work down the table above. Then re-run the search from the top of this task and confirm nothing is left:

```bash
grep -rn "Never stored\|never stored\|stores none of them" src README.md
```

Expected: only `positionHealth.ts` (a derived value, unrelated), `MatterActivity.tsx` (the derived feed, unrelated), `DocumentNotices.tsx` and `privacyCopy.ts`'s **page images** sentence (all unrelated and all still true). **If anything about precedent documents survives, this task is not finished.**

- [ ] **Step 8: Run everything, mutate, and check the screen**

**Mutation 1:** drop `document_kind_shape`. Expected: `refuses a precedent row with a matter_id` and both of its siblings fail by name.
**Mutation 2:** remove `and kind = 'matter'` from the review-target check. Expected: `REFUSES a precedent as a review target` fails by name.
**Mutation 3:** put `Never stored.` back into `PrecedentIntake.tsx`. Expected: the copy test fails by name. **This is the mutation that proves S24 is enforced rather than intended, and it is the single most important mutation in this plan.**
**Mutation 4:** remove the `kind` predicate from the matter-document list. Expected: `a precedent NEVER appears in a matter document list` fails by name.

Then **run the app**: bring two `.docx` files into "Learn from redlines", read the header sentence on screen, and confirm the documents appear in Postgres and Azurite while appearing nowhere in the matter. Screenshot the header. §19 names this exact area as the one where *"nothing on screen would look wrong"* if a query forgot its predicate, so looking at the screen is the check.

- [ ] **Step 9: Commit — one commit, everything**

```bash
git add apps/api/migrations/003_precedent.sql apps/api/src/routes/precedents.ts \
  apps/api/src/routes/documents.ts apps/api/src/routes/collections.ts apps/api/src/routes/reviews.ts \
  apps/api/src/auth/routeTable.ts apps/api/src/server.ts apps/api/test/precedent.pg.test.ts \
  apps/api/test/workspaceScope.test.ts src/lib/db/precedents.ts src/lib/db/precedents.test.ts \
  src/lib/privacyCopy.ts src/features/redlines/PrecedentIntake.tsx \
  src/features/redlines/PrecedentUploadPanel.tsx src/App.tsx src/App.redlines.test.tsx \
  src/types.ts README.md
git commit -m "feat: precedent documents are stored server-side, and the screen says so"
git show --stat HEAD
```

**Read the `--stat` output and confirm it contains BOTH `003_precedent.sql` and `PrecedentIntake.tsx`.** Check the output, never the command: a pathspec that looks right and a commit that is right are different things, and Stage 1's ledger records a commit made with a message claiming a green suite that was not. A commit carrying the storage without the sentence is the one outcome this task exists to prevent, and `git show --stat` is where you find out.

---

## Task 20: `position_basis` — a house rule that can still show its evidence next year

**Type:** feature

**Files:**
- Modify: `apps/api/migrations/003_precedent.sql` — **no.** Create `apps/api/migrations/004_position_basis.sql`; 003 has shipped and a migration file is immutable once applied
- Create: `apps/api/src/routes/positionBasis.ts`, `apps/api/test/positionBasis.pg.test.ts`
- Modify: `src/features/redlines/TheWorkings.tsx` and its test
- Modify: `src/features/redlines/positionsToDraft.ts`, `src/features/authoring/saveDraftAsV1.ts` (wherever an adopted position is carried into a draft — **read both**)
- Create: `src/lib/db/positionBasis.ts`

**Interfaces:**
- Consumes: Task 19's `precedent_set` and `document.kind`; `src/lib/inferPositions.ts`'s `InferredPosition` (`{ id, clauseTitle, statement, strength, supporting, total, basis: { documentId, supports, edits: ParsedEdit[] }[], contradicted, disposition, rewordedText?, diffDerivedOnly }`); `src/types.ts`'s `StandardPosition` (`{ text, origin, reviewedByHuman, provenance? }`) and `RedlineEdit`. **Read all three; where they disagree with this brief, the shipped source wins.**
- Produces: `position_basis`, `GET /v1/playbooks/:id/clauses/:clauseId/basis`, `recordPositionBasis(...)`.

**P13 restated, because the spec's column name does not fit the shipped types.** §6.5 writes `position_basis(standard_position_id, precedent_set_id, document_id, edit_locator jsonb)`, but a `StandardPosition` has **no id**: it is a field on a `PlaybookClause` inside an immutable `PlaybookVersion`. Keying on the version would make a position's evidence vanish the next time anyone published — the opposite of §11.1's argument that *"a position adopted six months ago still resolves to the documents and the specific edits that produced it, and a partner asking 'where did this house rule come from?' gets the four leases and the four strikes rather than a shrug."*

So the key is `(playbook_id, clause_id)` — the clause's identity **across** versions — and the row additionally records `adopted_in_version_id` and `adopted_text`.

**`adopted_text` is what keeps it honest, and it is the same rule `positionHealth.ts` already applies one layer up.** Health counts only verifications made against the position's *current wording*, because *"one filter catches a verification made late against wording since superseded, the other catches one made early against wording since reverted to."* Evidence has the same problem: four leases support the sentence that was adopted, not whatever the sentence says today. So the panel compares, and says so.

- [ ] **Step 1: Write the failing test**

```ts
it('resolves a position adopted six months ago to its documents and its edits', async () => {
  await recordBasis({ playbookId: 'p1', clauseId: 'c1', versionId: 'v1', text: 'No unreasonable withholding.',
    entries: [{ precedentSetId: 's1', documentId: 'd1', edits: [edit1] }, /* …four in all… */] });
  await publishVersion('p1'); await publishVersion('p1');   // two more versions since
  const basis = await get('/v1/playbooks/p1/clauses/c1/basis');
  expect(basis.entries).toHaveLength(4);
  expect(basis.entries[0].documentId).toBe('d1');
  expect(basis.entries[0].edits[0].text).toBe(edit1.text);
});

it('says the wording has moved when the clause has been edited since adoption', async () => {
  await recordBasis({ /* adoptedText: 'No unreasonable withholding.' */ });
  await publishVersionWithClauseText('p1', 'c1', 'Consent not to be unreasonably withheld or delayed.');
  const basis = await get('/v1/playbooks/p1/clauses/c1/basis');
  expect(basis.adoptedTextMatchesCurrent).toBe(false);
  expect(basis.adoptedText).toBe('No unreasonable withholding.');
  // Rendering four leases beside a sentence they never supported would be
  // exactly the confidently-wrong claim `positionHealth`'s wording scope
  // exists to prevent, one layer down.
});

it('says the basis is UNRESOLVABLE when the precedent set has been deleted', async () => {
  await del('/v1/precedent-sets/s1');
  const basis = await get('/v1/playbooks/p1/clauses/c1/basis');
  expect(basis.resolvable).toBe(false);
  // §11.1: "delete the set and a position's basis becomes unresolvable (and
  // must then say so on screen rather than showing an empty evidence panel
  // — 'empty is not broken', again)."
  expect(basis.entries).toEqual([]);
});

it('carries diffDerivedOnly through, so weaker evidence stays weaker', async () => {
  // `source: 'diff'` never wears `source: 'tracked'`'s confidence. A
  // position resting solely on diff-derived edits is flagged and rendered as
  // weaker evidence EVERYWHERE it appears — and "everywhere" now includes a
  // panel opened six months later.
  expect(basis.diffDerivedOnly).toBe(true);
});

it('never records a strength, a supporting count or a total', async () => {
  // `strength.ts` computes them and the model never returns them. Storing
  // them here would create a second, frozen copy of the one number this
  // feature's credibility rests on — and it would be the copy nobody
  // recomputed.
  expect(Object.keys(row)).not.toContain('strength');
  expect(Object.keys(row)).toContain('edits');   // the positive half
});
```

- [ ] **Step 2: The migration**

```sql
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
  -- rule `positionHealth.ts` applies to verifications.
  adopted_in_version_id text references playbook_version(id),
  adopted_text          text not null,
  precedent_set_id      text references precedent_set(id) on delete set null,
  document_id           text references document(id) on delete set null,
  -- The durable copy of the edits, exactly as `Changeset.basis` takes one.
  -- With the sources now KEPT, this becomes a corroboration rather than the
  -- only surviving witness (§11.1) — and `on delete set null` above is why
  -- it still has to be a copy: a set can be disposed of under a retention
  -- schedule while the playbook lives on.
  edits                 jsonb not null check (jsonb_typeof(edits) = 'array'),
  diff_derived_only     boolean not null,
  created_at            timestamptz not null,
  created_by_user_id    uuid references app_user(id)
);
create index position_basis_clause_idx on position_basis (workspace_id, playbook_id, clause_id);
grant select, insert, delete on position_basis to lexprompt_app;
```

**No `strength`, no `supporting`, no `total` columns.** `strength.ts` computes them from the basis and `inferPositions.ts` discards any the model volunteers; a stored copy would be a second answer to the one number this feature's credibility rests on, frozen at adoption time, and it would be the copy a panel read.

- [ ] **Step 3: Record the basis where a position is adopted**

Find where an adopted `InferredPosition` becomes a `StandardPosition` — `positionsToDraft.ts`, then E's save gate. The basis is recorded **when the draft is saved as v1**, in the same request as the publish, because a position that was never saved has no house rule to be the basis of. One transaction: `publishAndPoint` plus the `position_basis` inserts.

`StandardPosition.provenance` stays what it is — *"Free text naming where it came from ('6 redlines across 4 documents'). Presentational; nothing resolves it."* — and its docstring gains one sentence: something **does** resolve it now, through `position_basis`, and the free text remains the summary rather than the link.

- [ ] **Step 4: `TheWorkings` reads it after the session**

Today `TheWorkings.tsx` renders `InferredPosition.basis` from React state. It gains a second source: when there is no live session, it fetches `/v1/playbooks/:id/clauses/:clauseId/basis`. **Three load states**, plus the fourth thing this panel can be — *unresolvable*, when the set has been deleted — rendered as its own sentence naming what happened, never as an empty panel.

- [ ] **Step 5: Mutations, then commit**

1. Key `position_basis` on the version id. Expected: `resolves a position adopted six months ago` fails after the two publishes.
2. Drop `adopted_text`. Expected: `says the wording has moved` fails by name.
3. Render an empty panel instead of the unresolvable sentence. Expected: the component test fails by name.

```bash
git add apps/api/migrations/004_position_basis.sql apps/api/src/routes/positionBasis.ts \
  apps/api/test/positionBasis.pg.test.ts apps/api/src/auth/routeTable.ts \
  src/lib/db/positionBasis.ts src/features/redlines/TheWorkings.tsx \
  src/features/redlines/TheWorkings.test.tsx src/features/redlines/positionsToDraft.ts \
  src/features/authoring/saveDraftAsV1.ts src/types.ts
git commit -m "feat: a learned position's basis outlives the session that produced it"
git show --stat HEAD
```

---

## Task 21: The uploader, part 1 — reading the browser and saying exactly what is there

**Type:** feature

**Files:**
- Create: `src/lib/upload/report.ts`, `src/lib/upload/scan.ts`, `src/lib/upload/scan.test.ts`
- Create: `src/features/upload/UploadLocalData.tsx`, `src/features/upload/LocalDataBanner.tsx` and their tests
- Modify: `src/lib/router.ts` (`{ name: 'upload-local-data' }`), `src/App.tsx`

**Interfaces:**
- Consumes: `getDb`, `DbBlockedError`, `DbOpenTimeoutError` from `src/lib/db/open.ts`; `STORES`, `PROFILE_KEY`, `DB_NAME`, `DB_VERSION` from `src/lib/db/schema.ts`; `migrateDocumentRecord` from `src/lib/db/documents.ts`; `describeLoadError`; `parseRoute`/`buildPath`/`Route` from `src/lib/router.ts`. **Read all of these; where they disagree with this brief, the shipped source wins.**
- Produces: `scanLocalData(): Promise<LocalDataScan>`, `LocalDataScan`, `UploadReport`, `RecordOutcome`.

**§13.1's requirement, and the defect it is written against.** *"A single screen, available for one release, that reads the local IndexedDB, uploads each matter, document (bytes and text), collection, review, playbook, version and changeset, and reports exactly what it moved and what it could not, by name. A partial migration says so; it never reports success over a gap."* `CLAUDE.md`'s list has the shipped instance: *"a failed storage migration rendering an empty library, indistinguishable from a fresh install."*

**Scanning is its own task because the scan is what makes the report honest.** A report can only say *"3 of 4 matters moved"* if something counted the four **before** the upload started. Counting as you go can only ever report what it managed to reach, which is the failure mode dressed as a summary.

- [ ] **Step 1: Write the failing test**

```ts
describe('scanLocalData', () => {
  it('counts every store and names every record', async () => {
    await seedLocal({ matters: 2, documents: 3, blobs: 3, collections: 1, reviews: 2,
      playbooks: 1, playbookVersions: 2, changesets: 1, profile: true });
    const scan = await scanLocalData();
    expect(scan.totals).toEqual({ matters: 2, documents: 3, collections: 1, reviews: 2,
      playbooks: 1, playbookVersions: 2, changesets: 1 });
    // Named, not just counted: "3 of 4 moved" is useless without which one.
    expect(scan.records.matters.map(r => r.label)).toEqual(['Brookvale Retail Park', 'Ashfield Mill']);
  });

  it('reports a document whose BLOB is missing as a record that will move incompletely', async () => {
    // A DocumentRecord can outlive its bytes (`getDocumentBlob` returns null
    // for exactly this). The scan must say so BEFORE the upload, so nobody
    // reads "3 documents moved" and assumes three files came with them.
    await seedLocal({ documents: 1, blobs: 0 });
    const scan = await scanLocalData();
    expect(scan.records.documents[0].warning).toMatch(/original file is not in this browser/i);
  });

  it('reports a store it could not read, and does NOT report zero for it', async () => {
    // Zero and unreadable are different facts, and this is the exact place
    // where confusing them produces the CLAUDE.md defect: an empty library
    // indistinguishable from a fresh install.
    failStore('reviews');
    const scan = await scanLocalData();
    expect(scan.unreadable).toEqual(['reviews']);
    expect(scan.totals.reviews).toBeUndefined();
  });

  it('surfaces DbBlockedError as itself, so the screen can say "close your other tabs"', async () => {
    mockBlocked();
    const err = await scanLocalData().catch((e: unknown) => e);
    expect(describeLoadError(err, 'fallback')).toMatch(/another tab/i);
  });

  it('reports an EMPTY browser as empty, distinctly from a browser it could not read', async () => {
    const scan = await scanLocalData();
    expect(scan.isEmpty).toBe(true);
    expect(scan.unreadable).toEqual([]);
  });

  it('estimates the total bytes, so a person is not surprised by a 400 MB upload', async () => {
    expect((await scanLocalData()).totalBytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: The report types, shared by both halves**

```ts
/** What happened to ONE record. The unit the report is built from, because
 *  §13.1's requirement is "by name" and a per-store counter cannot be. */
export interface RecordOutcome {
  store: StoreName;
  id: string;
  /** What a person would call it: a matter's name, a document's filename, a
   *  review's playbook and date. An id alone is not a name. */
  label: string;
  status: 'moved' | 'moved-without-bytes' | 'failed' | 'skipped-already-there';
  /** Present on 'failed' and on 'moved-without-bytes'. The API's own message
   *  where there is one — it knows things the browser does not. */
  reason?: string;
}

export interface UploadReport {
  startedAt: number;
  finishedAt?: number;
  /** From the SCAN, not from the upload. This is what makes "3 of 4" a
   *  sentence the report is entitled to say. */
  expected: Record<StoreName, number>;
  outcomes: RecordOutcome[];
  /** A store the scan could not read at all. Its records are neither moved
   *  nor failed — they are unknown, and that is a third thing. */
  unreadable: StoreName[];
  /** True only when every expected record moved AND nothing was unreadable
   *  AND no document moved without its bytes. Derived, never set: a flag
   *  somebody sets is a flag somebody sets wrongly. */
  complete: boolean;
}
```

`complete` is computed by a pure function in `report.ts` with its own tests, including the three near-misses: one failed record, one unreadable store, one document without bytes. **Each must produce `complete: false`.** That function is the whole of §13.1's *"never reports success over a gap"* and it is mutation-tested in Task 22.

- [ ] **Step 3: The screen and the banner**

`UploadLocalData.tsx` at `/upload-local-data` shows the scan: every store, its count, every record by name, every warning, and the total size. Nothing has moved yet; the only action is **Upload everything**.

`LocalDataBanner.tsx` appears at the top of the app whenever a local database exists with records in it, saying that data is in this browser and offering the screen. It is **not** a modal (P15): a modal that can be dismissed once is a migration a person can lose, and one that cannot is an app they cannot use.

- [ ] **Step 4: The scan must survive a database it cannot open**

`getDb()` can reject with `DbBlockedError` (another tab holds an upgrade), `DbOpenTimeoutError` (nothing answered) or `UnconvertedPlaybookError`. All three already have user-facing messages and `describeLoadError` already passes them through. Use it. **Do not catch and flatten** — the whole point of those three classes is that each names something a person can act on, and "your local data could not be read" is the sentence that would replace three useful ones with a shrug.

- [ ] **Step 5: Mutations, then commit**

1. Make `scanLocalData` report `0` for an unreadable store. Expected: `reports a store it could not read` fails by name.
2. Make `isEmpty` true when a store was unreadable. Expected: `reports an EMPTY browser as empty, distinctly` fails.

```bash
git add src/lib/upload src/features/upload src/lib/router.ts src/lib/router.test.ts src/App.tsx
git commit -m "feat(web): read the local database and say exactly what is in it, before moving anything"
git show --stat HEAD
```

---

## Task 22: The uploader, part 2 — moving it, and reporting by name what did not move

**Type:** feature

**Files:**
- Create: `src/lib/upload/run.ts`, `src/lib/upload/run.test.ts`
- Modify: `src/features/upload/UploadLocalData.tsx` and its test
- Create: `apps/api/test/upload.pg.test.ts`

**Interfaces:**
- Consumes: Task 21's `scanLocalData`, `UploadReport`, `RecordOutcome`; every repository's `save*`/`add*` from `src/lib/db/*` (which are HTTP clients now — the uploader uses the **same** write paths as the app, deliberately); `getProfile()` for the uploading user's `app_user.id`. **Read the shipped repositories; where they disagree with this brief, the shipped source wins.**
- Produces: `runUpload(scan, opts): Promise<UploadReport>`, and `rewriteAttribution`.

**Two rules that shape every line of this task.**

**It uses the ordinary write paths.** `saveMatter`, `addDocument`, `saveCollection`, `savePlaybook`, `publishAndPoint`, `saveReview`, `saveChangeset`. Not a bulk import endpoint. A second write path would be a second set of validations, a second set of constraints, and the uploaded data would be the data that never went through the checks — which is how a migration produces records the app itself would have refused.

**It never deletes the local copy.** §13.1, S13, and `CLAUDE.md`'s *"never delete what you cannot read"*. The IndexedDB database is left exactly as it was.

- [ ] **Step 1: Write the failing tests**

```ts
describe('runUpload', () => {
  it('moves every record type and reports each one moved, by name', async () => {
    const report = await runUpload(await scanLocalData());
    expect(report.complete).toBe(true);
    expect(report.outcomes.filter(o => o.status === 'moved')).toHaveLength(12);
    expect(report.outcomes.map(o => o.label)).toContain('Brookvale Retail Park');
  });

  it('NAMES what it could not move, and reports the run as incomplete', async () => {
    failUploadOf('documents', 'Brookvale - executed.pdf', new ModelError('too large', 'prompt_too_large', 413));
    const report = await runUpload(await scanLocalData());
    expect(report.complete).toBe(false);
    const failed = report.outcomes.find(o => o.status === 'failed')!;
    expect(failed.label).toBe('Brookvale - executed.pdf');
    expect(failed.reason).toMatch(/too large/);
  });

  it('KEEPS GOING after a failure rather than stopping at the first', async () => {
    // Stopping would report one failure and eleven unknowns, and the person
    // reading it could not tell which of the eleven were fine.
    failUploadOf('documents', 'a.pdf', boom);
    const report = await runUpload(await scanLocalData());
    expect(report.outcomes.filter(o => o.status === 'moved').length).toBeGreaterThan(9);
  });

  it('records a document whose bytes are missing as moved-WITHOUT-BYTES, never as moved', async () => {
    // "3 documents moved" over a document with no file is the blank-CSV-cell
    // defect: technically true, read as complete.
    await seedLocal({ documents: 1, blobs: 0 });
    const report = await runUpload(await scanLocalData());
    expect(report.outcomes[0].status).toBe('moved-without-bytes');
    expect(report.complete).toBe(false);
  });

  it('is idempotent — a second run over a partial first one re-sends only what failed', async () => {
    // P15. Every write is the same PUT-as-upsert the app uses, so a record
    // that is already there is confirmed rather than duplicated.
    failUploadOf('documents', 'a.pdf', boom);
    await runUpload(await scanLocalData());
    unfail();
    const second = await runUpload(await scanLocalData());
    expect(second.complete).toBe(true);
    expect(await countRemote('documents')).toBe(3);
  });

  it('DELETES NOTHING from the local database', async () => {
    const before = await dumpLocal();
    await runUpload(await scanLocalData());
    expect(await dumpLocal()).toEqual(before);
  });

  it('uploads in dependency order, so a document never arrives before its matter', async () => {
    // matters -> collections -> documents -> playbooks -> versions -> reviews
    // -> changesets. The foreign keys enforce it; getting the order wrong
    // would produce a wall of "matter not found" for data that is fine.
    expect(orderOf(calls)).toEqual(['matters', 'collections', 'documents',
      'playbooks', 'playbookVersions', 'reviews', 'changesets']);
  });
});

describe('rewriteAttribution (P16)', () => {
  it('rewrites every *UserId from the local profile id to the uploading app_user id', () => {
    const out = rewriteAttribution({ ownerId: 'local-abc' }, 'local-abc', 'uuid-1');
    expect(out.ownerId).toBe('uuid-1');
  });

  it('rewrites attributions nested inside a review findings map', () => {
    // `Verification.byUserId`, `Note.byUserId`, `NetPosition.byUserId` all
    // live inside `review.findings` jsonb. A dangling id there breaks no
    // constraint — which is exactly why it would survive — and renders as
    // "Verified by <nobody>".
    const out = rewriteAttribution(reviewWithVerification, 'local-abc', 'uuid-1');
    expect(out.findings.k.c1.verification.byUserId).toBe('uuid-1');
  });

  it('maps an EMPTY attribution to null, not to the uploading user', () => {
    // `importPlaybook(json, byUserId = '')` produces one. A playbook
    // imported from a file was written by whoever wrote the file, and
    // claiming the person doing the upload wrote it would be a fabricated
    // provenance in the one place provenance is the product.
    expect(rewriteAttribution({ createdByUserId: '' }, 'local-abc', 'uuid-1').createdByUserId).toBeNull();
  });

  it('leaves an id that is NOT the local profile id alone, and counts it', () => {
    // There has only ever been one local profile, so this should not happen.
    // If it does, the honest thing is to leave it and say so on the report,
    // not to sweep it into the uploader's own identity.
    const { record, unmapped } = rewriteAttributionCounted({ ownerId: 'someone-else' }, 'local-abc', 'uuid-1');
    expect(record.ownerId).toBe('someone-else');
    expect(unmapped).toBe(1);
  });
});
```

- [ ] **Step 2: The report screen, and the sentence it must never say**

The screen renders the finished `UploadReport`: a heading that is **"Everything moved"** only when `report.complete`, and otherwise **"Some of your data did not move"** with the failures listed by name and reason above the successes. Add a component test asserting that a report with one failure renders neither the word "complete" nor a tick, **paired with** a positive assertion that a complete report does — a `not.toContain` with no companion is how Stage 1 shipped two vacuous assertions.

The screen also states, permanently and not behind a disclosure: *"Your data is still in this browser as well. Nothing here has been deleted."*

- [ ] **Step 3: An FK failure must be a named failure, not a wall**

`rewriteAttribution` runs before each record is sent. If it misses one, the API answers a foreign-key violation, and Postgres's message (`violates foreign key constraint "matter_owner_id_fkey"`) is true and useless to a lawyer. The route catches `23503` and answers something a person can read — *"this record names a person LexPrompt does not know"* — and the uploader puts that on the report beside the record's name. Test it end to end in `apps/api/test/upload.pg.test.ts` with a deliberately unrewritten attribution.

- [ ] **Step 4: Mutations**

1. Make `complete` a field the run sets rather than a derived value, and set it `true` at the end. Expected: `NAMES what it could not move, and reports the run as incomplete` fails by name. **This is the mutation that proves §13.1's central requirement**, and it is the shape `CLAUDE.md` names as a shipped defect.
2. Make a failed record stop the run. Expected: `KEEPS GOING after a failure` fails by name.
3. Make `rewriteAttribution` map `''` to the uploading user. Expected: `maps an EMPTY attribution to null` fails by name.
4. Delete the local database at the end of a successful run. Expected: `DELETES NOTHING from the local database` fails by name.

- [ ] **Step 5: Run it for real, against the owner's own data if possible**

This is the only task in the plan whose subject is a specific person's data. Run the stack, open a browser holding real LexPrompt data (or a seeded copy of a realistic size — several matters, a scanned PDF, a marked-up DOCX, a completed review with verifications and notes, two playbook versions, a changeset), and upload it. Then **reload the app and read the data back**: every matter, every document opening in the viewer, every finding with its verification attributed to you, every playbook at the right version.

**Compare the report against what actually arrived, record by record.** A report that says twelve moved while eleven are there is the failure this whole task exists to prevent, and only this step can find it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/upload src/features/upload apps/api/test/upload.pg.test.ts apps/api/src/routes
git commit -m "feat(web): move this browser's data to the server, and report by name what did not move"
git show --stat HEAD
```

---

## Task 23: Retiring browser-local mode

**Type:** refactor

**Files:**
- Modify: `src/lib/db/open.ts` (read-only, and say so), `src/lib/db/schema.ts`
- Delete: `src/lib/db/seq.ts` and its usages, `src/lib/db/migrate.ts`'s write paths, `src/lib/db/playbookMigration.ts`'s write paths, `src/lib/db/reviewMigration.ts`'s write paths — **read each before deleting; some are still the uploader's readers**
- Modify: `vitest.setup.ts` (`fake-indexeddb` scoped, not removed)
- Modify: `README.md`, `src/lib/privacyCopy.ts`

**Interfaces:**
- Consumes: everything Tasks 9–16 replaced. **Read `src/lib/db/open.ts`, `migrate.ts`, `playbookMigration.ts` and `reviewMigration.ts` before touching any of them** — three of the four exist to upgrade a record read from an older shape, and the uploader is still reading old shapes.
- Produces: an IndexedDB layer that is read-only, and a `fake-indexeddb` dependency scoped to the tests that still need it.

**What §14 says, and the part of it that is not yet true.** *"`fake-indexeddb` is deleted along with the last IndexedDB test. So is the `node:buffer` Blob workaround, which existed only because Blobs do not round-trip through `fake-indexeddb`."* **That moment is not this task.** The uploader reads IndexedDB and will for as long as it ships — §13.1 says the screen is available *"for one release"* and that a later release deletes the local database *"once the owner confirms the server copy is good."* So: `fake-indexeddb` is **scoped**, not deleted, and this task records the deletion as belonging to the release that removes the uploader.

- [ ] **Step 1: Make the local database read-only, in code and not by convention**

`getDb()` keeps opening the database. What goes is every write path: `put`, `delete`, `add`, and every `'readwrite'` transaction. The cheapest honest enforcement is a wrapper around the opened `IDBPDatabase` that throws on a `readwrite` transaction, with a message saying the server is authoritative now — a convention would last until the first person who needed a quick write.

```ts
/**
 * The local database is READ-ONLY from Stage 2.
 *
 * It is not deleted (S13, and "never delete what you cannot read"): it is
 * the owner's only copy until the uploader has run and they have confirmed
 * the server copy is good, and a later release removes it. Until then it is
 * readable by exactly one screen and writable by nothing.
 *
 * Enforced rather than agreed. A `'readwrite'` transaction throws here,
 * naming the rule, because a convention lasts until the first person who
 * needs a quick write — and a write to a store nothing reads is work
 * silently lost.
 */
```

Test: `getDb()` then a `'readwrite'` transaction throws with a message naming the reason; a `'readonly'` one still works. **Mutation:** remove the guard. Expected: the first test fails by name.

- [ ] **Step 2: The banner, and what the app says while the local copy exists**

While the local database holds records, `LocalDataBanner` (Task 21) is up. §13.1: *"the app opens it read-only afterwards behind a banner explaining that the server is now authoritative."* After a complete upload, the banner changes rather than disappearing — *"Your data is on the server. A copy is still in this browser and will be removed in a later release."* — because a banner that vanishes is a person who never learns the copy is still there.

- [ ] **Step 3: `seq.ts` goes, and its reasoning is preserved where it moved**

`seq.ts` allocated `_seq` because *"IndexedDB's `getAll()` makes no such promise"*. Postgres's `seq bigint generated always as identity` (Task 8) is the same guarantee, and Task 9's ordering test is the same test. Delete `seq.ts` and its tests, and **copy its reasoning into `002_records.sql`'s comment on the `seq` column** — the file is going, the lesson is not. Its type-enforcement trick (pinning the parameter to a single-store `'readwrite'` handle so a wrong-mode store fails to compile) has no Postgres equivalent and needs none; say so in the commit message rather than leaving a reader to wonder whether it was lost.

- [ ] **Step 4: Scope `fake-indexeddb`, and say when it goes**

It stays in `vitest.setup.ts` because the uploader's tests need it. Add a comment naming the release that removes it and the file that will be the last to need it. Same for the `node:buffer` Blob workaround: **it is still needed**, because the uploader stores and reads Blobs, and CLAUDE.md's warning about which `Blob` to use where is still live for exactly one screen's tests.

- [ ] **Step 5: The dead-write scan**

```ts
it('nothing outside the uploader opens a readwrite IndexedDB transaction', () => {
  const files = walk('src').filter(f => !f.includes('lib/upload') && !f.includes('features/upload'));
  expect(files.length).toBeGreaterThan(80);
  const offenders = files.filter(f => /'readwrite'/.test(codeOf(f)));
  expect(offenders).toEqual([]);
});
```

**Mutation:** add a `'readwrite'` transaction to `src/lib/documents.ts`. Expected: fails naming it. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/open.ts src/lib/db/schema.ts src/lib/db/seq.ts src/lib/db/seq.test.ts \
  src/lib/db/migrate.ts src/lib/db/playbookMigration.ts src/lib/db/reviewMigration.ts \
  vitest.setup.ts src/features/upload README.md
git commit -m "refactor: the local database becomes read-only, kept for the uploader and deleted later"
git show --stat HEAD
```

---

## Task 24: Compose, Bicep and `azd` for Postgres and Blob Storage

**Type:** infrastructure

**Files:**
- Create: `infra/modules/postgres.bicep`, `infra/modules/storage.bicep`
- Modify: `infra/main.bicep`, `infra/main.parameters.json`, `infra/modules/containerApps.bicep`, `infra/modules/identity.bicep`, `azure.yaml`
- Modify: `docker-compose.yml`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: Tasks 1 and 10's configuration keys. **Read `infra/main.bicep` and `infra/modules/containerApps.bicep` before editing** — Stage 1's final round changed the topology so that `api` has **no public ingress in either environment** and the SPA calls `/api` on its own origin, and a change here that reintroduces a cross-origin call would reintroduce a defect that broke Azure end to end (`142e0a4`).
- Produces: `postgres.bicep`, `storage.bicep`, the role assignments, and the two deployment steps that cannot be expressed in Bicep.

**What each module must express** (not transcribed ARM — the exact values depend on a subscription's naming and a tenant's policy, and inventing them would be worse than naming the requirement precisely):

**`postgres.bicep`** — a PostgreSQL Flexible Server, version 16, in the same region as everything else; **public network access disabled** and a private endpoint into the Container Apps environment's VNet, with private DNS; TLS enforced; a firewall with no rules, because there is nothing to allow; automated backups with the retention the operator sets as a parameter; and outputs giving the two connection strings the API reads. The **admin password is a Key Vault reference**, never a parameter with a default and never an output.

**`storage.bicep`** — a Storage account with `allowBlobPublicAccess: false`, `minimumTlsVersion: TLS1_2`, `publicNetworkAccess: Disabled` and a private endpoint; one container, private; soft delete on, with the retention the operator sets. Its output is the **account URL**, and there is deliberately **no connection-string output** — S2's property is that no credential exists where managed identity is available, and an output is a place a credential would be.

**The role assignments** are the part most likely to be got wrong and the part with no local equivalent: the API's managed identity needs **Storage Blob Data Contributor** on the container (not on the subscription, and not Owner), and — if the operator chooses Entra authentication for Postgres — the corresponding database role. Name them explicitly in `identity.bicep`.

- [ ] **Step 1: The two steps that Bicep cannot do, written into the README as deployment steps**

1. **Creating `lexprompt_migrator` and `lexprompt_app`.** `infra/postgres/init.sql` is the local form; in Azure this is one `psql` run by the Flexible Server admin after provisioning, before the first `azd deploy`. `000_preconditions.sql` refuses the migration with a message naming this step if it has not been done — which is why the refusal exists rather than letting `GRANT` fail with "role does not exist".
2. **Confirming the private endpoints resolve.** §5.1's own list says Azure networking is not exercised locally. The README says which command to run and what a correct answer looks like.

- [ ] **Step 2: The check nobody can automate, so it is a checklist**

Add to the README's Azure section a short, blunt list a deployer ticks: public access disabled on both; the private endpoints resolving from inside the Container Apps environment; the admin password only in Key Vault; **no storage connection string anywhere in the template, the parameters file, or the azd environment** — searched, not assumed:

```bash
grep -rniE 'AccountKey=|DefaultEndpointsProtocol=|API_BLOB_CONNECTION_STRING' infra azure.yaml
```

Expected: nothing. That is the Azure half of S2's stronger property, expressed as an absence exactly as Stage 1 expressed it for provider keys.

- [ ] **Step 3: Say plainly what was not run**

`az`/`azd`/`bicep` may not be available. Stage 1's Task 25 was in exactly that position and cross-referenced every environment variable against both config loaders **by name** instead — which caught a real defect (`oidcRequiredClaims` given as JSON when the parser wanted `claim=value`, which would have stopped the API booting in every real Entra deployment). Do the same here, and say plainly that the templates have not been deployed.

Cross-reference, by name, every key the Bicep sets against `apps/api/src/config.ts`'s reads: `API_DATABASE_URL`, `API_DATABASE_MIGRATION_URL`, `API_DATABASE_POOL_MAX`, `API_BLOB_CREDENTIAL_SOURCE`, `API_BLOB_ACCOUNT_URL`, `API_BLOB_CONTAINER`, `API_ROLE_MAPPINGS`. A name that appears in one and not the other is a container that will not boot.

- [ ] **Step 4: Commit**

```bash
git add infra azure.yaml docker-compose.yml .env.example README.md
git commit -m "feat(infra): Postgres and Blob Storage in Bicep, with no credential in any output"
git show --stat HEAD
```

---

## Task 25: `configSurface` and divergence rows 4 and 5

**Type:** infrastructure

**Files:**
- Modify: `apps/api/test/divergence.json`, `apps/api/test/configSurface.test.ts`

**Interfaces:**
- Consumes: **read `apps/api/test/divergence.json` and `configSurface.test.ts` in full before editing.** The JSON carries a long `_` preamble explaining that the keys are the names the **applications** read — container environment variables and Vite build args — and **not** `.env.example`'s host-side interpolation names. Getting that wrong is what produced Stage 1's finding H6.
- Produces: rows 4 and 5, and the two lists they touch.

**§18 item 10(b), and the half that is load-bearing:** the configuration diff **is** §5.1's divergence list, *"and fails equally if the table names a row with no key behind it, so the table cannot decay into a list of good intentions."* Both directions.

- [ ] **Step 1: Add the rows**

```json
    {
      "n": 4,
      "what": "Relational store",
      "keys": ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"],
      "why": "API_DATABASE_URL, API_DATABASE_MIGRATION_URL and API_DATABASE_POOL_MAX are set in BOTH environments with different VALUES and identical NAMES, so they are sameEverywhere — exactly like the identity keys in row 1. What exists in only one environment is the Postgres container's own bootstrap: locally the database is a container this stack runs, and in a tenant it is a Flexible Server somebody provisioned. The two roles P10 requires are created by infra/postgres/init.sql locally and by one psql run by the Flexible Server admin in Azure; 000_preconditions.sql refuses the migration, naming that step, when they are absent."
    },
    {
      "n": 5,
      "what": "Blob store",
      "keys": ["API_BLOB_CONNECTION_STRING", "API_BLOB_ACCOUNT_URL"],
      "why": "Azurite cannot authenticate by managed identity (§5.1's own 'what local does not prove' list says so), so the two environments genuinely need different credential MATERIAL. API_BLOB_CREDENTIAL_SOURCE and API_BLOB_CONTAINER are set in both and are sameEverywhere; the source key's VALUE selects which material is used, and resolveBlobCredential never falls back from one to the other (P14). The connection string exists only locally and the account URL only in Azure — and the absence of a connection-string output in storage.bicep is S2's stronger property expressed as an absence, exactly as Stage 1 expressed it for provider keys."
    }
```

`sameEverywhere` gains `API_DATABASE_URL`, `API_DATABASE_MIGRATION_URL`, `API_BLOB_CREDENTIAL_SOURCE`, `API_BLOB_CONTAINER`, `API_ROLE_MAPPINGS`. `defaultedInBothEnvironments` gains `API_DATABASE_POOL_MAX`. `localOnlyServices` gains `postgres` and `azurite`.

- [ ] **Step 2: Mutate the table in both directions**

1. **A key with no row:** add `API_SOMETHING_NEW` to compose's `api` block. Expected: `the configuration diff is exactly §5.1s divergence list` fails naming it. Restore.
2. **A row with no key:** add a row 11 naming a key nothing sets. Expected: the same suite fails on the other side. Restore.
3. **A `sameEverywhere` key that stops being same:** remove `API_BLOB_CONTAINER` from the Bicep. Expected: fails. Restore.

All three must fail, and the report must name which test each one failed. §19's warning about this suite is that *"they are cheap, and being cheap is exactly why they will be proposed for deletion"* — a mutation record is what makes them defensible.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/divergence.json apps/api/test/configSurface.test.ts
git commit -m "test: §5.1 rows 4 and 5, checked in both directions"
git show --stat HEAD
```

---

## Task 26: The README and `privacyCopy` sweep — every sentence §2 lists for this stage

**Type:** documentation

**Files:**
- Modify: `README.md`, `src/lib/privacyCopy.ts` and the tests that assert its wording

**Interfaces:**
- Consumes: §2's table of *what becomes untrue*, which lists thirteen locations. **Read the shipped `README.md` and `privacyCopy.ts` before writing a word.** `CLAUDE.md`'s rule applies with full force here: *"A 'frozen copy' list is a snapshot, and it goes stale the moment anyone fixes the string it names. Before applying any string a spec calls frozen, diff it against the shipped source file, not against the spec — the shipped wording always wins on a mismatch."* Stage 1 already rewrote several of these sentences, so §2's quotations of them are from before that.
- Produces: a README with no false sentence in it.

**Which of §2's rows this stage owns** (Stage 1 took the inference ones; Stages 3–5 take the collaboration ones):

| §2 row | Now |
|---|---|
| Privacy bullet 1 — "stored in this browser's IndexedDB … and nowhere else" | The firm's Postgres and Blob Storage |
| Privacy bullet 2 — "Nothing is uploaded anywhere except to the model you chose" | Already rewritten in Stage 1 around the firm's own service; **check it, do not assume** |
| Privacy bullet 4 — "Data is per-browser, with no sync and no backup" | Server-side, backed up. **And the sentence "there is no equivalent export for matters or documents yet" is what justified the uploader existing at all** — it stays true and stays |
| Privacy bullet 6 — templates in IndexedDB; the `localStorage` migration backup | Playbooks are server-side. **The `localStorage` backup remains untouched** in whatever browser holds it, and §13.1's uploader still never deletes it |
| Privacy closing — "the reversal is bounded to your own browser" | Bounded to the firm's tenant |
| §"No database yet" (the whole section) | Deleted, and replaced. Its opening sentence — *"There are three services, and none of them is a database"* — is now false in its first clause |
| §Learning from redlines — "stores none of them" | Done in Task 19. **Verify it, do not redo it** |
| §"How it's built" — "No backend, no server-side anything" | Already rewritten in Stage 1; check |
| §Known limitations | Whatever is no longer a limitation, and whatever now is |

**Add a section the README does not have and now needs:** *"What is stored, and where"* — one table, matter documents and precedent documents side by side, saying which store holds what and what a delete removes. §11.1's retention question (§17 Q3) is **open**, and the README says so plainly rather than implying an answer: *"How long precedent documents are kept is your firm's decision and LexPrompt does not decide it."*

- [ ] **Step 1: Diff every frozen string before touching it**

For each row above, open the shipped file and read the sentence as it actually is. Where the shipped wording differs from §2's quotation, **the shipped wording wins** and the divergence goes in the report. Getting this backwards silently reintroduces a defect a review already fixed, and it takes a test edit to do it — which is this project's signal that a "pure documentation change" quietly changed behaviour (R-G22).

- [ ] **Step 2: `git status --porcelain -- '*.test.ts' '*.test.tsx'` after the README half**

Expected: **nothing**. A README rewrite that requires a test edit is not a README rewrite. The `privacyCopy.ts` half **will** require test edits — its strings are asserted — and those edits are the finding: list which assertion moved and which shipped sentence it now matches.

- [ ] **Step 3: The one thing that must not be merged**

§19: *"The strongest guarantee in this design is now the one most easily overstated… the pressure to re-merge them is permanent, because one sentence is shorter and sounds better. Watch for it in the README rewrite, which is where a summary gets written by someone reading this document quickly."* The two sentences are **credential custody** (architectural, every deployment) and **no key at all** (a deployment choice, Azure with managed identity). Stage 1 wrote them as two. **Do not merge them while rewriting the sections around them**, and add a test asserting the README does not contain the unconditional claim:

```ts
it('the README never states the unconditional "no provider keys anywhere" claim', () => {
  const readme = readFileSync('README.md', 'utf8');
  expect(readme).not.toMatch(/no provider (api )?keys anywhere/i);
  // Companion positive: the two sentences that replaced it are both there.
  expect(readme).toMatch(/no credential ever leaves the gateway/i);
  expect(readme).toMatch(/managed identity/i);
});
```

- [ ] **Step 4: Commit**

```bash
git add README.md src/lib/privacyCopy.ts src/features/settings src/App.test.tsx
git commit -m "docs: the README and the disclosures describe a server, and say what is stored where"
git show --stat HEAD
```

---

## Task 27: The Stage 2 definition-of-done sweep, the rulings, and the live verification

**Type:** verification

**Files:**
- Create: `apps/api/test/stage2DoD.test.ts`
- Modify: `docs/superpowers/redesign/rulings.md`
- Modify: `README.md` (whatever the sweep finds)
- Create: `.superpowers/sdd/2026-08-29-lexprompt-server-stage-2-storage-and-auth/progress.md` (the ledger, if it does not already exist — **create it at Setup, not at Task 7**, which is when Stage 1's was reconstructed and its Tasks 1–6 rulings were lost)

**Interfaces:**
- Consumes: `sourceScan.ts`'s `ROOT`, `walk`, `codeOf`, `rel`, `ENV_NAME`; `jurisdictionDefault.ts`'s helpers; **read `apps/api/test/stage1DoD.test.ts` if one exists** and extend that file's shape rather than inventing a second one. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: the Stage 2 definition-of-done suite and the rulings record.

**§18 item 3, clause by clause, as tests where a test can carry it and as a live step where only a run can:**

| Clause | How it is checked |
|---|---|
| a user signs in against the configured issuer and sees only what their role permits | `authz.route.test.ts` (Task 5), plus the live pass below |
| **refused by the API and not merely hidden by the UI** | `authz.route.test.ts`'s role matrix, and the pairing test in Task 17 Step 3 |
| **verified against both issuers** | `roles.pg.test.ts` (Task 4) offline against both shapes; Entra itself only in a tenant, and the report must say so |
| every record type round-trips through Postgres | one `*.pg.test.ts` per table, each with a whole-record `toEqual` |
| document bytes round-trip through Blob Storage | `blobStore.compose.test.ts` (Task 10), including a payload with a null byte |
| deleting a matter purges its blobs | `cascade.compose.test.ts` (Task 11) |
| the browser uploader moves the owner's data and names anything it could not | `run.test.ts` (Task 22), plus the real-data run in Task 22 Step 5 |
| a precedent document is stored | `precedent.pg.test.ts` (Task 19) |
| is not offerable as a review target or a collection member | `precedent.pg.test.ts`'s two refusal cases, plus the `kind` scanner |
| **and no screen in the app says it is not stored — searched, not assumed, across `src/`, the README and the test suite** | the scan below |

- [ ] **Step 1: Write the sweep**

```ts
describe('Stage 2 definition of done (§18 item 3)', () => {
  const SOURCES = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'apps')),
                   ...walk(path.join(ROOT, 'packages'))];

  it('the scanners find something', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(readFileSync(path.join(ROOT, 'README.md'), 'utf8').length).toBeGreaterThan(5000);
  });

  it('NO SCREEN, README LINE OR TEST says a precedent document is not stored', () => {
    // §18 item 3's own words: "searched, not assumed, across src/, the README
    // and the test suite." The test suite is in scope deliberately — a test
    // still asserting the old promise is a test that will be restored by
    // someone treating a red suite as a regression.
    const haystack = [
      ...SOURCES.map(f => ({ where: rel(f), text: readFileSync(f, 'utf8') })),
      { where: 'README.md', text: readFileSync(path.join(ROOT, 'README.md'), 'utf8') },
    ];
    const offenders: string[] = [];
    for (const { where, text } of haystack) {
      // The page-images sentence is a DIFFERENT true claim about a
      // DIFFERENT thing, and it stays. Scope the match to precedent context.
      for (const m of text.matchAll(/[^.\n]*\b(precedent|redline)[^.\n]*never stored[^.\n]*/gi)) {
        offenders.push(`${where}: ${m[0].trim()}`);
      }
      for (const m of text.matchAll(/stores none of them|Read once to learn from/gi)) {
        offenders.push(`${where}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('…and the replacement promise IS on the intake screen, exactly once', () => {
    // The positive half. Without it, deleting the sentence entirely passes
    // the test above and leaves the screen saying nothing at all about
    // storage — which is worse than the old sentence, not better.
    const intake = readFileSync(path.join(ROOT, 'src/features/redlines/PrecedentIntake.tsx'), 'utf8');
    expect(intake).toContain('PRECEDENT_STORAGE_PRIVACY');
    const copy = readFileSync(path.join(ROOT, 'src/lib/privacyCopy.ts'), 'utf8');
    expect(copy).toMatch(/export const PRECEDENT_STORAGE_PRIVACY/);
  });

  it('no OpenRouter or provider key survives anywhere (Stage 1 DoD, re-checked)', () => {
    // Re-run rather than assumed. Three new dependencies and a new store
    // arrived this stage, and `sk-or-v1-` appearing in a seed fixture is
    // exactly the shape that slips in.
    for (const { where, text } of allText()) expect(text, where).not.toMatch(/sk-or-v1-/);
  });

  it('no database or blob credential is read outside apps/api/src/config.ts', () => {
    const offenders = SOURCES
      .filter(f => rel(f) !== 'apps/api/src/config.ts')
      .filter(f => /API_DATABASE_URL|API_BLOB_CONNECTION_STRING|API_DATABASE_MIGRATION_URL/.test(codeOf(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('the gateway holds no database or blob credential, and no client for either', () => {
    // §5: "no database credential, no Blob credential and no read path to
    // either, so compromising it yields the calls in flight and never the
    // archive." A dependency is the shape this would arrive in.
    const gatewayPkg = JSON.parse(readFileSync(path.join(ROOT, 'apps/gateway/package.json'), 'utf8'));
    expect(Object.keys(gatewayPkg.dependencies ?? {})).not.toContain('pg');
    expect(Object.keys(gatewayPkg.dependencies ?? {})).not.toContain('@azure/storage-blob');
    for (const f of walk(path.join(ROOT, 'apps/gateway/src'))) {
      expect(codeOf(f), rel(f)).not.toMatch(/API_DATABASE|BLOB_/);
    }
  });

  it('no collaborative affordance shipped (R-G1 binds until Stage 4)', () => {
    // Stage 2 introduced real accounts, and the temptation that comes with
    // them is an assignee chip. R-G1 binds until the mechanism is real.
    const web = walk(path.join(ROOT, 'src'));
    const offenders = web.filter(f =>
      /assignedTo|assigneeId|assign(ed)?[- ]?to[- ]?me|presence|whoIsHere/i.test(codeOf(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('every route has an authorisation policy and every policy has a route', async () => {
    // Restated here so the DoD suite fails on its own if Task 5's suite is
    // ever weakened. Two suites asserting one property is not drift when the
    // property is "a route cannot ship open".
  });
});
```

- [ ] **Step 2: Run every gate, in order, reading exit codes**

```bash
npm run typecheck    > /tmp/tc.txt  2>&1; echo "typecheck EXIT=$?"
npx vitest run       > /tmp/t.txt   2>&1; echo "unit      EXIT=$?"
npm run test:pg      > /tmp/tp.txt  2>&1; echo "postgres  EXIT=$?"
npm run test:compose > /tmp/tc2.txt 2>&1; echo "compose   EXIT=$?"
npm run build        > /tmp/b.txt   2>&1; echo "build     EXIT=$?"; grep -i external /tmp/b.txt
```

**Read every exit code.** `npx vitest run` reports every test PASSED and exits 1 on an unhandled rejection; reading a gate through a pipe reports the last command's status, not the first's. Both cost Stage 1 real time and both are written into its ledger.

Run the unit suite **three consecutive times** and confirm exit 0 each time. Stage 1's final round found an intermittent exit 1 with every test passing — a `setState` after unmount in a migration effect — and one green run would not have found it.

- [ ] **Step 3: The live pass, on a running stack, with the four seeded accounts**

Everything from Task 18 Step 3, **plus** what Part 2B added:

8. **`trainee`** — brings two `.docx` precedents into "Learn from redlines". Read the header sentence on screen. Confirm both documents are rows in Postgres and blobs in Azurite, and that **neither appears** in any matter's document list, in a collection picker, or as a review target.
9. **`trainee`** — adopts a position from those precedents, saves the playbook as v1, publishes v2 with an edit to that clause, then reopens the position's evidence. Confirm it still resolves and says the wording has moved.
10. **Delete the precedent set.** Confirm the evidence panel says it is unresolvable rather than showing an empty panel.
11. **The uploader**, against a browser holding real data (Task 22 Step 5). Compare the report record by record against what arrived.
12. **The banner** — still up after a complete upload, saying the local copy is still there.
13. `docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com'` — **still fails.** Four new dependencies arrived this stage and §5's central claim is a network fact that has to be re-checked, not inherited.

**Record what you ran and what you could not, in those words.** Entra itself cannot be exercised without a tenant; say so. `az`/`azd`/`bicep` may be unavailable; say so.

- [ ] **Step 4: Write the rulings**

Into `docs/superpowers/redesign/rulings.md`, in its established format and in a section headed for this stage, each with its cost if wrong:

- **P6–P16** as executed, with any that changed during execution recorded as amended-with-a-dated-note rather than edited away — the convention every superseded ruling in that file follows.
- **Every ruling an implementer took mid-task**, with its cost. Stage 1's ledger lost the rulings from Tasks 1–6 because the ledger was created at Task 7; create this stage's at Setup.
- **The findings this plan predicted and the ones it did not**, specifically: which caller changes were forced, and whether the seam held. The honest answer at the time of writing is that it held for all nine repositories' **public** signatures, and did not hold for `publishVersionIn`'s `idb`-typed parameter (Task 13), for `Matter` and its siblings gaining an optional `version` (Task 9, P9), for `Settings` losing its model fields (Task 18, §6.6 — not a repository), and for the nine `await getProfile()` write paths that can now reject (Task 16). **Four is the number to check the execution against.**

- [ ] **Step 5: The spec-versus-plan disagreements, recorded rather than smoothed**

Three, and each belongs in `rulings.md` beside the plan decision that resolved it:

1. **§11 says parsing moves server-side; §13 puts the engine that needs it in Stage 3.** Resolved by P12: parsing stays in the browser this stage and `parse_state` is stored from the day the column exists. The spec is not wrong — the two sections are about different things — but a reader of §11 alone would expect a parse worker here.
2. **§6.5 writes `position_basis(standard_position_id, …)`; `types.ts`'s `StandardPosition` has no id.** Resolved by P13: keyed on `(playbook_id, clause_id)` with the adopted text and version recorded. **This is a genuine spec/code disagreement and the spec cannot be satisfied literally.**
3. **§6.1 lists nine IndexedDB stores as tables including `blobs → (none)`, and §13's Stage 2 sentence says "the nine repositories".** There are nine repository *modules* and eight tables; `blobs.ts` becomes a route over Blob Storage rather than a table. Recorded so a later reader counting tables does not conclude one is missing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/stage2DoD.test.ts docs/superpowers/redesign/rulings.md README.md
git commit -m "test: the Stage 2 definition of done, searched rather than assumed"
git show --stat HEAD
```

---

## Interfaces Stage 3 and later must honour

Recorded here so a later stage extends rather than duplicates. Each is a thing this stage built that a later one will be tempted to build again.

1. **`findings` is a `jsonb` column on `review` and Stage 3 turns it into rows (P11, §6.2).** The column holds the exact `Record<findingsKey, Record<clauseId, Finding>>` shape `types.ts` declares, so the migration is a `jsonb_each` shred and not a translation. **`findingsKeyFor` moves to `packages/core` in Stage 3** and both sides call it; six defects in sub-project C came from code that derived that key inline, and a client/server split is the seventh opportunity.
2. **`finding_disposition` and `finding_disposition_event` do not exist yet, and Stage 3 creates them with the findings they belong to.** The re-run reset is a Stage 3 transaction and needs both. `Finding.verification` is `jsonb` inside the findings map until then, and the migration that promotes it must **seed the first `finding_disposition_event`** (`from_state = 'unchecked'`, `cause = 'human'`) from `Verification.byUserId`/`at` — §6.4 says why: an empty history under a non-`unchecked` current state is indistinguishable from a change that failed to record itself.
3. **The run worker's database role does not exist yet.** Stage 3 adds `lexprompt_worker` beside `lexprompt_migrator` and `lexprompt_app` (P10), with **no grant on either disposition table**, and asserts it by attempting the write and getting a permission error — not by grepping for call sites (§14).
4. **Parsing is still in the browser, and `parse_state` is already stored (P12).** Stage 3 changes **who writes those columns**, not what they are. `'pending'` is in the check constraint and unused; the parse worker is what starts using it, and the "Reading…" state §11 asks for renders from it.
5. **`document.kind` filters every matter-context query, and `workspaceScope.test.ts` holds it there.** A Stage 3 route that reads `document` in a matter context adds the predicate and the scanner enforces it. §19 names this as the thing to watch, because such a query fails by showing too much.
6. **`version` on every mutable record is the SAME number realtime will broadcast (P9, §8).** *"The stale-change refusal and the realtime version guard are the same number doing two jobs, and they must not be allowed to become two numbers."* Stage 4's event payloads carry this column; they do not introduce a second.
7. **The 409 already returns the current row.** Stage 4's *"Priya changed this to Rejected at 14:22, after you loaded it"* needs no second round trip and no second mechanism — it needs the actor and the time, which arrive when dispositions do.
8. **`ROUTE_POLICY` has no default and a route with no entry fails the build (Task 5).** Every Stage 3–5 route adds a line. Do not add a fallback.
9. **`role_mapping` is seeded from `API_ROLE_MAPPINGS` at startup and the app role has SELECT only.** §7's admin power to edit it needs an `UPDATE`/`INSERT` grant and an admin route; adding one is a deliberate act, and the absent grant is what makes it deliberate.
10. **`app_user` has no DELETE grant. Disabling is the mechanism (§7).** A Stage 5 admin screen disables; it does not delete, and it cannot.
11. **`audit_event` does not exist yet.** §6.5 declares it and §13 places the activity feed that reads it in Stage 4. When it lands: `GRANT INSERT, SELECT` only, partitioned monthly, and **it does not restate a disposition change** — `finding_disposition_event` is that change's one record (S22). The gateway's stdout call log and `audit_event` are **two different logs and must stay two** (§12 Q3); the gateway must not gain a database credential to write one, and Task 27's DoD test asserts it has neither client.
12. **`workspace_setting.concurrency` is stored and not yet enforced (§6.6, Task 18).** Stage 3's run queue is what makes it a per-run bound. It is a column with no reader until then, and that is written in its migration comment.
13. **The uploader ships for one release (§13.1, P15).** The release that removes it is the release that deletes the local IndexedDB database, **after the owner confirms the server copy is good** — and it is also when `fake-indexeddb` and the `node:buffer` Blob workaround finally go (§14). Until then they are scoped, not deleted (Task 23).
14. **`packages/core/src/api/records.ts` is the shared wire vocabulary.** A Stage 3 event payload's types go there, not into a second shared module, and every new export goes into `importBoundary.test.ts`'s `exported` array or the S14 guard cannot see it.
15. **The blob key has one home: `blobKeyFor` (Task 10).** Stage 3's run worker regenerating page images reads bytes through it. Page images are still never persisted — not in Postgres, not in Blob Storage, not anywhere (S12).
16. **`documentFileForReview` versus `documentFileForViewing` survives the move server-side (§11).** This project's founding defect has reopened twice and both times it was a review path handed a view-hydrated document. Stage 3's worker hydrates **for review**.
17. **`describeLoadError` has three states and Stage 4 adds the fourth.** `stale` is realtime's, and §3 says it is *"the one most likely to be skipped, because the app looks fine without it."*
18. **Two migration files are immutable once applied.** `runMigrations` consults a ledger, so editing an applied file changes nothing on a re-run and everything on a fresh database — which is the worst kind of divergence, because it only appears in a new environment. Add `005_…`, never edit `003_…`.

---

## Self-review

### 1. Spec coverage

Every Stage 2 requirement, with the task that implements it.

| Requirement | Source | Task |
|---|---|---|
| Postgres behind the nine repositories' existing interfaces | §13, R3 | 1, 8, 9, 11, 12, 13, 14, 15, 16 |
| Blob Storage for document bytes | §6.5, S12 | 10, 11 |
| No bytes in Postgres | §6.5 | 8 (no bytes column), 27 (sweep) |
| Page images still never persisted | §6.5, S12 | 11 (nothing writes them), 27 |
| Deleting a matter purges its blobs | §6.5 | 11 |
| A reconciliation path for orphaned blobs | §6.5 | 11 (Step 6) |
| Sign-in becomes the real gate | §13 | 3, 4, 5, 17 |
| `app_user` keyed `(issuer, subject)`, replacing the local profile | §6.5, §7 | 2, 3, 16 |
| `actorUserId` **alongside** the pair, never replacing it | §6.5, spec line 679 | 6 |
| Just-in-time provisioning on first sign-in | §7 | 3 |
| Roles mapped from the issuer's group claim into `role_mapping` | §7, §13 | 2, 4 |
| **Exercised against both issuers from the day it exists** | §13, §18.3 | 4 |
| Refused by the API, not merely hidden by the UI | §7, §18.3 | 5 (API), 17 (UI), 27 |
| A route with no policy entry fails the build | §7, §14 | 5 |
| A user in no mapped group is told plainly | §7 | 4 (the refusal), 17 (the screen) |
| Group overage stays its own error | §7 | 17 (Stage 1 detects it; this stage renders it) |
| No development bypass; the absence is mutation-tested | §7, S29 | 5 (Step 6) |
| `workspace_id` on every table; every query scoped | §6, S9 | 2, 8, 9 (the scanner) |
| A published version is immutable by grant | §6.1 | 8, 13 |
| `audit_event` append-only by grant | S11 | **Deferred to Stage 3/4** — see below |
| `Verification.assigneeId` retired | S17 | **Deferred to Stage 3** — it lives inside `Finding` and goes when dispositions become rows |
| `Settings` shrinks; the model choice becomes workspace configuration | §6.6, S16 | 18 |
| Precedent documents stored server-side | §11.1, S19 amended | 19 |
| `document.kind`, check-constrained both ways | §11.1, S23 | 19 |
| Every matter query filters `kind = 'matter'` | §11.1, S23 | 19 (and the scanner) |
| A precedent refused as review target / collection member | §11.1, §18.3 | 19 |
| `precedent_set` | §6.5, §11.1 | 19 |
| `position_basis` | §6.5, §11.1 | 20 |
| **The copy change ships in the same change as the storage** | §11.1, S24 | **19 — one task, one commit** |
| The replacement lives in `privacyCopy.ts` | §11.1 | 19 |
| The old promise's tests rewritten, never deleted | §11.1 | 19 |
| The stale comments corrected (`App.tsx`, `PrecedentUploadPanel`, `types.ts`) | §11.1 | 19 |
| The README's redlines bullet replaced | §2, §11.1 | 19, 26 |
| The one-time uploader, reporting by name | §13.1, S13 | 21, 22 |
| A partial migration says so and never reports success over a gap | §13.1 | 22 (the `complete` mutation) |
| It never deletes the local copy | §13.1, S13 | 22, 23 |
| Browser-local mode retired at the end of the stage | §13, S13 | 23 |
| Three load states, none rendering as another | §3 | 7 (`describeLoadError`), 17, 18, 20, 21 |
| `await-then-apply`; no optimistic update | §3, S8 | 9 (the pattern), 15, 16 |
| Behaviour stays single-user; R-G1 binds | §3.1, S18 | Global constraint; 27 asserts it |
| Local dependencies are faithful emulators | S30 | 1 (Postgres), 10 (Azurite) |
| No module branches on the environment | §5.1, S30 | 1, 10 (config in one file), 25 |
| The configuration diff **is** the divergence list, both directions | §18.10 | 25 |
| `docker compose up` and `azd up` run the same code | §5.1 | 1, 10, 24 |
| `api` still may not egress | §5 | 1, 10, 27 (re-checked after every new dependency) |
| Every record type round-trips | §18.3 | 9, 11, 12, 13, 14, 15 |
| The README's untrue sentences replaced | §2 | 19, 23, 26 |
| Mutation tests on everything load-bearing | §14 | 1–27, each naming its mutation |
| `tsc` clean, tests pass, build clean | §18.1 | Global constraint; every task's gate |

**Requirements I could not assign to a task, and why:**

- **`audit_event` (§6.5, S11).** §13's Stage 2 sentence does not include it, and §13's Stage 4 sentence puts the activity feed that reads it there. Building the table now would mean an append-only log with one writer (role changes) and no reader, and the grant test §14 asks for would be asserting a property of a table nothing uses. **Stage 3/4 work**, named in the interfaces list above rather than left to be discovered. *The cost of the deferral: role changes and workspace-setting changes in Stage 2 are attributed on the row (`updated_by_user_id`) but not logged as events. Say so in the README's admin section.*
- **`Verification.assigneeId`'s retirement (S17) and the `assignment` table.** `Verification` is a field inside `Finding` inside `review.findings` jsonb until Stage 3 makes findings rows. Retiring the field now would mean a jsonb migration this stage, immediately followed by the real one next stage. **Stage 3.**
- **`carryHumanState`'s retirement (§9.1, S5).** It exists because `runReview` owns its own copy of the run in the browser. The engine is Stage 3 and the deletion goes with it. Stage 2 must **keep calling it** — a run still orchestrated in the browser still overwrites human state without it.
- **§17 Q3 — retention, and specifically precedent retention.** An owner decision, not an implementation step, and §11.1 is explicit that the design *"refuses to let it be decided by default"*. Task 26's README says the question is open and that LexPrompt does not decide it. **Ask the owner.**
- **§17 Q13 — production hosting off Azure.** Unchanged by this stage and unanswered. Postgres is Postgres and Azurite/Azure Blob go through the same SDK (S30), so nothing here forecloses it; where a non-Azure production deployment puts its database and blobs, and what that does to §12's residency answers, is still open.
- **§18 item 10(c) — "the same suites run against both environments".** Task 25 covers 10(a) and 10(b) mechanically; wiring the integration suites to run against an ephemeral deployed environment before release is CI work this stage does not build, exactly as Stage 1 did not. **Named rather than left to be found by someone reading §18 and counting two of three.**
- **Spike 1 (server-side PDF rendering) and Spike 2 (the Azure egress assertion).** Spike 1 gates Stage 3's parse worker, not this stage — P12 keeps parsing in the browser, so nothing here depends on it. Spike 2's local half is Stage 1's `egress.compose.test.ts` and is re-run in Task 27; its Azure half is unproven and Task 24's README says so.
- **An admin screen for `role_mapping`.** §7 lists it among an admin's powers. Stage 2 seeds the table from deployment configuration and grants the app role SELECT only; the screen is Stage 5's, with the other administrative surfaces, and the absent grant is what keeps that a decision rather than an oversight.

### 2. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `fill in`, `appropriate error handling`, `similar to Task`, `and so on`, `etc.` in step bodies, and for test steps with no test. Four things found and fixed inline:

- Task 1's `MIGRATION_LOCK` initialiser was invalid TypeScript in the first draft. It is **left visible and named as invalid in Step 9**, deliberately, so it cannot be pasted without being read — the only such device in this plan, and it is there because Stage 1's briefs were pasted.
- Task 7's `makeApiClient` returns an elided object. Step 3 says in terms that the ellipsis must not survive into the shipped file and names what each method must do.
- Task 8's migration shows three tables in full and names the four that follow the same pattern. That is a **deliberate delegation** rather than a placeholder: transcribing four near-identical `create table` statements would add 120 lines that a reader skims and an implementer copies wrong, and the pattern plus the field list in `types.ts` is more reliable than a transcription of it.
- Task 24's Bicep names what each module must express rather than transcribing ARM. Same delegation Stage 1's Task 25 made, for the same reason: the exact values depend on a subscription's naming and a tenant's policy, and invented ones would be worse than a precise requirement. Stage 1's report confirms that approach caught a real defect.

Three further deliberate delegations, marked as such rather than hidden: Task 5's route-collection helper describes the `onRoute` hook rather than transcribing Fastify's internals (which change between minors); Task 12 gives its route tests as a numbered list because they are Task 9's six, repeated; Task 22's seeded-data description names the shape of a realistic browser rather than a fixture file, because the fixture that matters is the owner's real data.

### 3. Type and name consistency

Checked across all 27 tasks:

- **`Role` / `ROLES` / `isRole`** — declared once in `packages/core/src/api/records.ts` (Task 3), used in Tasks 4, 5, 16, 17, 18. Never a bare `string`.
- **`Actor`** — `{ id, issuer, subject, email?, displayName, initials, role, workspaceId }`, declared in `apps/api/src/auth/actor.ts` (Task 3), used in Tasks 5, 6, 9–20. **`Principal`** is the *token's* shape and stays in `apps/api/src/oidc.ts` with the fields it already has; the two are never conflated, and `Principal` is never imported from an `entra.ts`, which does not exist and which two Stage 1 briefs claimed did.
- **`resolveActor(t, principal, role, workspaceId)`** — four parameters, in that order, in Tasks 3 and 4. **`roleFor(runner, issuer, groups)`** — three, in that order, Task 4.
- **`Db` / `Tx` / `makeDb` / `makePool` / `PgClientLike` / `PgPoolLike`** — Task 1, used unchanged in every later API task. `Tx` has `query` and `tx`; `Db` has `query` and `tx`. `ensureLedger` takes `Pick<Tx, 'query'>`.
- **`withPg(body, db?)` / `appDb()` / `migratorDb()`** — Task 1, used in every `*.pg.test.ts`. `appDb()` is the role a request runs as and is what every **grant** test uses; `migratorDb()` is the schema owner and is what **seeding** uses. Using the wrong one is how a grant test passes for the wrong reason.
- **`ModelError` codes** — the Stage 1 set plus exactly four added in Task 3 (`account_disabled`, `no_role`, `not_found`, `conflict`) and one in Task 14 (`changeset_stale_base`). Every code used in Tasks 3, 4, 5, 7, 9, 11, 13, 14, 15, 16, 17, 19, 22 is on that list. **No route composes an error body by hand**; `registerErrorEnvelope` answers a `ModelError` verbatim, which Stage 1 shipped and Task 3 relies on.
- **`blobKeyFor(workspaceId, documentId)`** — Task 10, the only place a blob key is built, used in Tasks 11, 19, 27.
- **`ROUTE_POLICY` / `routeKey(method, url)`** — Task 5, extended by Tasks 9, 11, 12, 13, 14, 15, 18, 19, 20. Keys are `"METHOD /v1/pattern"` with Fastify's own `:id` pattern, so the registered key and the table key are one string.
- **`document.doc_type` versus `document.kind`** — the file type (`pdf`|`docx`|`txt`, which `types.ts` calls `kind`) is `doc_type` in SQL; §11.1's matter-versus-precedent distinction is `kind`. **Two different facts that share one word in the TypeScript**, named apart in the schema in Task 8's comment and in Task 19's migration, because a query filtering `kind = 'pdf'` and one filtering `kind = 'matter'` would both compile and one would be catastrophic.
- **`version`** — the optimistic-concurrency column on every mutable record (Tasks 8, 9, 15, 18), the field the client sends back, and the number Stage 4's realtime events carry. One number, three jobs, never two numbers.
- **`seq`** — the ordering tiebreak, `bigint generated always as identity`, replacing `_seq` (Tasks 8, 9, 23). It is **not** on the wire, exactly as `stripSeq` kept `_seq` off it.
- **`PRECEDENT_STORAGE_PRIVACY`** — Task 19, in `privacyCopy.ts`, rendered by `PrecedentIntake.tsx`, asserted by `App.redlines.test.tsx` and by `stage2DoD.test.ts`. One constant, one screen, one place.
- **`UploadReport` / `RecordOutcome` / `LocalDataScan` / `scanLocalData` / `runUpload` / `rewriteAttribution`** — Tasks 21 and 22, with `complete` **derived** and never assigned.
- **`getProfile` / `saveProfile` / `forgetProfile` / `currentRole` / `useRole`** — Task 16. `getProfile` returns `UserProfile` (`{ id, name, initials }`) unchanged; `MeResponse` is the wire shape and the two are mapped, never conflated.
- **Decision labels** — this plan's are **P6–P16**, continuing Stage 1's P1–P5. `rulings.md`'s owner decisions are **D1–D5** and its execution rulings are **A1, E1, E2, F1, H1, L1, O1, R1, S1, T1**. No label in this document collides with one of those; where this plan refers to a Stage 1 ruling it names the file it lives in.
- **Migration file names** — `000_preconditions`, `001_identity`, `002_records`, `003_precedent`, `004_position_basis`. Applied in filename order; **immutable once applied** (Task 27's interface note 18).

### 4. What I would check first if this plan turns out to be wrong

In order of how likely the failure is and how quiet it would be:

1. **A query that forgets `kind = 'matter'` or `workspace_id`.** It fails by showing too much, and nothing on screen looks wrong. The scanner in Tasks 9 and 19 is the guard; check it actually matches statements rather than passing vacuously.
2. **The uploader reporting success over a gap.** Task 22's `complete` mutation is the test; run it, do not assume it.
3. **`PrecedentIntake.tsx` shipping with the old sentence.** Task 19 Step 9 says to read `git show --stat` and confirm both the migration and the component are in the commit. Do that.
4. **A `.pg.test.ts` suite quietly not running.** Task 1's wiring guard is the defence, and it is the guard most likely to be thought unnecessary.
5. **`pg`'s `Pool` not satisfying `PgPoolLike`.** Task 1 Step 4 says to verify with `npm run typecheck` and to adapt rather than widen. A widened `PgClientLike` would make the fake client in `pool.test.ts` prove nothing about the real one.
