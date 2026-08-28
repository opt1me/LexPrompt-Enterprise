# LexPrompt Server — from a browser-only tool to a firm-deployed, collaborative one

**Date:** 2026-08-28
**Status:** Spec written. Three spikes gate parts of it (§15); none of them gates the sequencing, because Stage 1 does not depend on any of the three.
**Builds on:** the whole of the redesign (sub-projects A–G) and `docs/superpowers/redesign/rulings.md`, which this document continues.
**Supersedes:** ruling **R1** and its sub-project-G restatement **R-G1** — see §3.
**Source:** the owner's constraints, gathered in conversation on 2026-08-28. Those constraints are settled and are not relitigated here; where this design adds something they did not settle, it is a ruling in §16 or an open question in §17.

---

## 1. What this is for

LexPrompt currently tells one lawyer, in one browser, what is in a contract. It does this well and it does it honestly: every claim it makes about a document is traceable to a quote, every human judgement is a human's, and nothing derives a verification.

It cannot tell two lawyers anything. A trainee who verifies forty findings and needs a Partner's eye on three has no way to ask, and the app is deliberately built not to pretend otherwise (R-G1). A matter lives in one browser's IndexedDB, which means it lives on one laptop, which means it is one disk failure from gone and cannot be handed over. And every model call carries contract text from a lawyer's browser to OpenRouter under a key that lawyer pasted in themselves — a sentence that ends a Security review before it starts.

This design makes LexPrompt a service the firm deploys: one database, real accounts, real collaboration, and — the part that decides whether any of the rest is allowed to exist — an inference path the firm can describe to its own Risk function without flinching.

**The binding constraint is the Security / Risk review, and it outranks feature convenience throughout this document.** Where a feature and the Risk story disagree, the Risk story wins and the feature is named as out of scope rather than smuggled in.

The central architectural claim, stated once here because §5 and §10 exist to make it true:

> **The inference gateway is the only component in the system permitted to egress. Nothing else can call a model — not as a convention, as a network fact.**

And its companion, which is the answer to the first question every Risk reviewer asks:

> **There are no provider API keys anywhere in the system.** The gateway authenticates to Azure AI Foundry with an Entra managed identity. There is no key in a browser, no key in an environment variable, no key in Key Vault. There is nothing to leak, rotate, or find in a git history.

---

## 2. What becomes untrue

The README is a promise about privacy, and this design breaks specific sentences in it. They are listed precisely, because a stale privacy claim is worse than none: a reader who trusts an out-of-date sentence has been misled by us, not by their own carelessness.

| README location | What it says | What replaces it |
|---|---|---|
| Line 3, intro | "no backend, no database, and no user accounts — a static site that runs entirely in your browser and talks directly to OpenRouter" | A deployed service: a static web app, an API, an inference gateway, Postgres and Blob Storage, all in the firm's own Azure subscription. |
| §"No backend, no accounts" (101–103) | The whole section | Deleted. Replaced by a deployment section describing `docker compose up` locally and `azd up` to Azure. |
| §"You need an OpenRouter API key" (105–113) | The whole section, including "your API key is stored only in your browser's local storage" and "there is no server for LexPrompt to leak it to" | Deleted. **There is no user-supplied key at all.** Users sign in with their firm Entra account; models come from an admin-configured Foundry deployment allowlist. |
| §Privacy bullet 1 (127) | "stored in this browser's IndexedDB … and nowhere else" | Stored in the firm's Azure Postgres (metadata, extracted text, findings) and Blob Storage (original bytes), UK region, private endpoints. |
| §Privacy bullet 2 (128) | "Nothing is uploaded anywhere except to the model you chose, via OpenRouter" | Documents are uploaded to the firm's own API. Model calls go to the firm's Foundry deployment through the gateway. **OpenRouter is removed as a subprocessor**, along with every model provider it fronted. |
| §Privacy bullet 4 (130) | "Data is per-browser, with no sync and no backup" | Data is server-side, backed up, and shared across the firm's users by design. |
| §Privacy bullet 6 (132) | Templates in IndexedDB; the `localStorage` migration backup | Playbooks are server-side. The `localStorage` backup remains untouched in whatever browser holds it — §13's uploader still never deletes it. |
| §Privacy closing (134) | "the reversal is bounded to your own browser" | No longer bounded to a browser. It is bounded to the firm's tenant. |
| §Visual system (96) | "the app's own disclosure says nothing leaves the browser except calls to OpenRouter" | The fonts decision stands and the reason strengthens — the app should not contact a third-party host on a page view — but the sentence is rewritten around the firm's own API. |
| §Visual system (97) | "The chrome is honest about being single-user … no assignee chip … The matter activity feed is derived … not a stored event log" | Superseded (§3). Assignee chips, an "assigned to me" counter and an activity feed with real actors become honest, and the feed is read from the stored audit log. |
| §"How it's built" (138) | "No backend, no server-side anything" | A monorepo: `packages/core`, `apps/web`, `apps/api`, `apps/gateway`. |
| §"Building and deploying" (204–225) | Static host, SPA rewrite, Firebase | `azd up`. The SPA rewrite note survives for the web app's own hosting. |
| §Known limitations (243) | "Verification is single-reviewer … nothing here notifies anybody of anything" | Superseded. Verification is attributed to a real account, assignment reaches a real person, and §17 Q2 decides whether it also leaves the app. |

**What stays true, verbatim:** page images are never persisted (§6, and now not server-side either); citations never guess a page; scan detection is per page; re-running a clause resets its verification and its net position; a review snapshots what it claims to have checked; deleting a matter genuinely purges its documents' bytes.

---

## 3. The rules that survive, and the one that is superseded

`CLAUDE.md`'s opening rule binds this design without amendment:

> **Fail loudly rather than answer quietly wrong.**

A network makes this harder, not easier, in exactly one way, and it is the most important thing in this document after the gateway:

**A load path must now distinguish four facts, not two.** *Not yet known* (a request in flight), *broken* (a request that failed), *empty* (a request that succeeded and returned nothing), and — new — *stale* (a client whose realtime connection dropped and which has not yet resynchronised). Every one of those renders differently, and none of them may render as any of the others. A spinner is not an empty list; an empty list is not a failure; and a disconnected client showing yesterday's findings without saying so is the network-era version of the CSV that wrote unreviewed clauses as blank cells. `describeLoadError` / `LoadErrorPanel` carry forward and gain the two new states rather than being replaced.

**`await-then-apply` survives verbatim, and realtime does not soften it.** The rule is that a reviewer never sees a state the store did not take. On a server that means three separate things, and they must not be conflated:

1. **Your own write** is an HTTP request that returns the persisted row. The UI renders from that response and from nothing else. There is **no optimistic update** for any human-authored state — not for a verification, a challenge, a note, a net-position confirmation, or an assignment. The control shows a busy affordance and then the confirmed value.
2. **Someone else's write** arrives as a push. It is a fact about the server's state, so rendering it is not optimism.
3. **Your own write also arrives back as a push.** It is dropped if its version is not newer than the row the client already holds, so the confirmed value never flickers into and out of existence.

The app will *feel* live. It will never be live ahead of the database.

**Verification is set only by a human action, and nothing derives it.** Unchanged, and §6's shape makes it structurally harder to break: a verification is a row a person's request inserts, and the review engine's database role has no permission to insert it.

**A review snapshots what it claims to have checked.** `playbookSnapshot` stays a deep copy — now a `jsonb` column rather than a structured-clone, which is the same guarantee by different means.

**Citations never guess a page; scan detection is per page.** `derivePage` and `SCAN_TEXT_THRESHOLD` move into `packages/core` unchanged and are used by the server, which is the only way the two sides can agree.

### 3.1 R-G1 / R1 is superseded, as of 2026-08-28

**Ruling R1** (identity: build schema-ready, single-user-in-practice) and its sub-project-G restatement **R-G1** (every multi-user affordance is dropped or resolved to the local profile) forbade any UI that implied collaboration. That was correct, and its reasoning was exactly right at the time: *"the opposite error has a lawyer waiting on a review nobody was asked for — a silence the app manufactured."*

**This design removes the condition that made it correct.** Assignment now reaches a real person with a real account, a verification is attributed to someone who can be asked about it, and the activity feed reads from a stored audit log rather than being derived from one browser's own actions. The affordances R-G1 dropped — the assignee chip, the assign action, the "assigned to me" counter, "flagged for X" phrasing, actors in the activity feed — become honest, and are built in Stage 4 (§13), **not before**. Until Stage 4 ships, R-G1 continues to bind: Stages 1–3 must not add a collaborative affordance ahead of the mechanism that makes it true.

Recorded so a future reader finding R-G1 does not conclude this design violated it. **R1's schema-readiness is what makes this cheap**: `ownerId`, `addedByUserId`, `createdByUserId`, `publishedByUserId`, `byUserId` all already exist and are already populated. See §6.4.

---

## 4. Scope

### In

1. **A monorepo with four workspaces** — `packages/core`, `apps/web`, `apps/api`, `apps/gateway`.
2. **The inference gateway** — sole egress, managed-identity auth to Foundry, metadata-only call log, deployment allowlist, budgets.
3. **Server persistence** — Postgres for records, Blob Storage for original document bytes; the nine IndexedDB repositories become an HTTP API over the same nine (plus new) concerns.
4. **Entra ID authentication and three roles** mapped from Entra security groups.
5. **The review engine server-side** — runs as queued, resumable, cancellable jobs.
6. **Realtime collaboration** — presence, live findings, live human judgements, with an explicit resynchronisation path.
7. **The collaboration model** — first-to-verify-wins with attribution, separately attributed challenges (flag / reject), and assignment that reaches a person in-app.
8. **An append-only audit log**, and the activity feed built from it.
9. **Deployment** — `docker compose up` locally and `azd up` to Azure, the same shape both ways.
10. **A one-time migration** for the data currently in the owner's browser.

### Out, and why

- **Multi-tenancy beyond schema-readiness.** Every table carries `workspace_id` and every query is scoped by it from day one, so a second tenant is a data-model no-op. Not built: tenant onboarding, per-tenant configuration, cross-tenant administration, or tenant-aware billing. *Reason: one firm now; the schema is the expensive half and the rest is speculative product work.*
- **SSO beyond Entra.** No SAML, no Okta, no local username/password. *Reason: a local account is a credential store the firm would then have to defend at the Risk review, in exchange for a convenience nobody asked for. The firm is an Entra shop.*
- **Phone layouts.** Still sub-project H. *Reason: unchanged by this design and separately specced.*
- **Offline mode.** Browser-local persistence is retired, not reduced. *Reason: one persistence story. Two is how the app ends up with a browser copy and a server copy disagreeing about who verified what — this project's most repeated defect, at its most dangerous.*
- **Concurrent text-editing merge (OT / CRDT).** Presence exists to *prevent* collisions, per the owner. Free-text fields (a note, an amended net position, a playbook draft) are last-write-wins **with the loser told, loudly, and shown what replaced their text** — never a silent overwrite. *Reason: genuine simultaneous editing of the same sentence is expected to be rare, and a merge engine is a large subsystem defending against it.*
- **Per-matter access control.** One firm; everyone in the workspace sees every matter. Role gates *actions*, not *visibility*. *Reason: §7. A richer permission system than one firm needs is a permanent tax and a new class of "why can't I see this" defect.*
- **Notification outside the app.** Email and Teams are §17 Q2, deliberately undesigned. *Reason: each adds a subprocessor and a data-flow line to the Risk story, and the owner has not decided.*
- **User-chosen models.** Models are an admin-configured allowlist of Foundry deployments. *Reason: §10 and §12 — a user-entered model id is an unreviewable egress destination.*
- **Ingest OCR.** Not built now; named as the fallback if Spike 1 fails (§15).
- **Public or anonymous share links.** *Reason: a link that works without an Entra account is a hole in every sentence of §12.*
- **Usage billing / chargeback.** The gateway's call log carries token counts, so this is later reporting over existing data, not a subsystem.

---

## 5. Service topology

```
┌──────────────┐   HTTPS + Entra access token    ┌───────────────┐
│  apps/web    │ ──────────────────────────────► │   apps/api    │
│  (static SPA)│ ◄────── WebSocket events ────── │  (Node/TS)    │
└──────────────┘                                  └───┬───┬───┬───┘
                                                      │   │   │
                        Postgres (private endpoint) ◄──┘   │   │
                        Blob Storage (private endpoint) ◄──┘   │
                                                              │  internal only
                                                              ▼
                                                   ┌────────────────────┐
                                                   │   apps/gateway     │
                                                   │  the ONLY egress   │
                                                   └─────────┬──────────┘
                                                             │ managed identity
                                                             ▼
                                                   Azure AI Foundry (UK/EU)
```

**`packages/core`** — every piece of domain logic that is neither React nor IO. It is a library, not a service, and it is the same bytes on both sides of the wire. Contents: `citations`, `citationPage`, `citationRepair`, `pageSegments`, `modelContext`, `findingOutcome`, `verification`, `reviewTarget`, `netPosition`, `collectionOrder`, `collectionPrompt`, `collectionSuggest`, `positionHealth`, `positionHealthMap`, `strength`, `inferPositions`, `buildChangeset`, `chains`, `docxRedlines`, `docxMarkup`, `pdfRedlineDiff`, `standardPositions`, `positionOutcome`, `matterActivity`, `matterStats`, `reviewProgress`, `riskBlock`, `uid`, `concurrency`, `playbookScan`, `playbookDefaults`, the prompt builders, and `extractClause` / `extractCollectionClause` themselves. This is not aspirational: `src/lib` today contains React in exactly one file (`router.ts`), which stays in `apps/web`.

**`apps/web`** — the React SPA, unchanged in shape. It keeps `pdfjs` for *rendering* the viewer and for `findQuoteRects`, which matches a quote to on-screen coordinates and must run where the canvas is. It owns no domain logic that the server also needs.

**`apps/api`** — HTTP + WebSocket. Owns: authentication, authorisation, every read and write to Postgres and Blob Storage, the run queue and its workers, the realtime hub, and the audit log. **`api` may not egress.** Its only outbound routes are to Postgres, Blob Storage and the gateway, all over private endpoints; the public internet is denied by network policy (§15, Spike 2), not by code review.

**`apps/gateway`** — a small, stateless HTTP service. Owns: the model call. It has **no database credential, no Blob credential and no read path to either**, so compromising it yields the calls in flight and nothing at rest. §10 is its full specification.

**What may talk to what, exhaustively:**

| From | To | Allowed |
|---|---|---|
| web | api | yes (only destination) |
| web | gateway | **no** |
| web | any model provider | **no** |
| api | Postgres, Blob Storage | yes, private endpoint |
| api | gateway | yes, internal only |
| api | internet | **no** |
| gateway | Foundry | yes, private endpoint, managed identity |
| gateway | Postgres, Blob | **no** |
| gateway | api | **no** (the gateway never calls back) |

**Why a separate service rather than a module in `api`.** Three reasons, in the order a Risk reviewer cares about them. First, *evidence*: "the API cannot reach a model" becomes a network rule an auditor reads from infrastructure-as-code, not a claim they have to take on trust from a code review. Second, *blast radius*: a prompt-injection- or dependency-driven SSRF in `api` — the service that handles uploads and untrusted document text — has nowhere to go. Third, *drift*: a module is one refactor away from being called from a second place; a service with one network peer is not.

**Local development is the same shape.** `docker compose up` brings up web, api, gateway, Postgres and Azurite, with the gateway pointed at either a Foundry deployment (using developer Entra credentials via `DefaultAzureCredential`) or a recorded-response stub for offline work. `azd up` provisions the same five things in Azure. The compose network denies `api` egress the same way the Container Apps environment does, so the central claim is exercised in development rather than only asserted in production.

---

## 6. Data model

Postgres 16 on Azure Database for PostgreSQL Flexible Server, UK South. Every table carries `workspace_id uuid not null` and every query is scoped by it (S9). One workspace row is seeded at deploy.

### 6.1 The nine IndexedDB stores as tables

| IndexedDB store | Table | Notes |
|---|---|---|
| `profile` (one record, key `'local'`) | `app_user` | One row per person. The single-record store is gone. |
| `matters` | `matter` | `owner_id` already exists as `Matter.ownerId`. |
| `documents` | `document` | `added_by_user_id` already exists. Gains `blob_key`, `content_sha256`, `parse_state`. |
| `blobs` | *(none)* | Bytes move to Blob Storage; `document.blob_key` points at them. No bytes in Postgres. |
| `collections` | `collection` | `created_by_user_id` already exists. |
| `playbooks` | `playbook` | `draft` stays embedded as `jsonb` — a draft is edited as one document, and splitting it invents a merge problem that does not exist. |
| `playbookVersions` | `playbook_version` | `published_by_user_id` already exists. Immutable — enforced by `REVOKE UPDATE, DELETE` from the app role, not by convention. |
| `reviews` | `review` | `created_by_user_id` already exists. `playbook_snapshot jsonb`. **`findings` no longer lives here** — see §6.2. |
| `changesets` | `changeset` | `created_by_user_id` already exists. |

### 6.2 The one shape that must change: findings become rows

Today a review holds `findings: Record<key, Record<clauseId, Finding>>` as one nested object, written whole. In one browser that was already delicate enough to produce a defect the project fixed by hand (`the handleVerify/handleAddNote read-modify-write race on latestRunRef`). With two people and a server-side engine writing concurrently, a whole-object write is not delicate — it is unfixable. Two writes to two different clauses of one review would race, and the loser's work would vanish with nothing on screen to show it.

```
finding
  review_id            uuid    not null
  findings_key         text    not null   -- from packages/core's findingsKeyFor
  clause_id            text    not null
  primary key (review_id, findings_key, clause_id)
  status               text    not null   -- pending|running|done|error|cancelled
  summary              text
  risk_level           text
  risk_analysis        text
  error                text
  auth_error           boolean not null default false
  truncated            boolean not null default false
  truncated_documents  text[]             -- NULL, never '{}', on a single-document finding
  no_content           boolean not null default false
  edited               boolean not null default false
  position_outcome     text               -- meets|deviates|unclear, NULL = no position to compare
  position_rationale   text
  citations            jsonb   not null default '[]'
  net_position         jsonb              -- NULL on a standalone finding, never '{}'
  version              bigint  not null default 1   -- optimistic concurrency
  updated_at           timestamptz not null
```

**`findings_key` is still produced in exactly one place.** `findingsKeyFor` moves to `packages/core` and both the API and the web app call it. The six defects sub-project C produced by keying findings by document id are the reason this sentence exists; a client/server split is a seventh opportunity to make the same mistake.

**`NULL` versus empty stays load-bearing.** `truncated_documents` is `NULL` on a single-document finding, not an empty array. `net_position` is `NULL` on a standalone finding, not `'{}'`. `position_outcome` is `NULL` when there was no standard position to compare against, which is a different fact from `'unclear'`. These are the same distinctions `types.ts` documents at length, restated in a database that has a real null.

### 6.3 The collaboration tables

**A finding carries at most one verification, and any number of challenges.** This is the owner's model — first to verify wins and is attributed; a colleague who disagrees flags or rejects, as a separately attributed action — expressed as a constraint rather than as a convention.

```
finding_verification                      -- insert-once. First to verify wins.
  review_id, findings_key, clause_id      primary key  (FK to finding)
  by_user_id       uuid not null
  at               timestamptz not null

finding_challenge                         -- append-only. Zero or more.
  id               uuid primary key
  review_id, findings_key, clause_id      (FK to finding)
  kind             text not null          -- 'flag' | 'reject'
  reason           text                   -- NOT NULL when kind='reject' (check constraint)
  by_user_id       uuid not null
  at               timestamptz not null
  withdrawn_at     timestamptz            -- only the author may withdraw; never deleted

note
  id               uuid primary key
  review_id, findings_key, clause_id      (FK to finding)
  text             text not null
  by_user_id       uuid not null
  at               timestamptz not null

assignment
  id               uuid primary key
  review_id, findings_key, clause_id      (FK to finding)
  assignee_user_id uuid not null
  assigned_by_user_id uuid not null
  message          text
  created_at       timestamptz not null
  resolved_at      timestamptz
  resolved_by_user_id uuid
```

**First-to-verify-wins is `INSERT … ON CONFLICT DO NOTHING`, and losing is a visible answer, not an error.** A second person's verify request that hits the conflict gets back the existing verification and the UI says *"Already verified by Priya, 14:22"* — a specific, true, non-alarming outcome. It does not say "failed", and it does not silently do nothing.

**A challenge never overwrites a verification.** A verified finding that someone then rejects shows both: *"Verified by Priya · Rejected by Andy — 'the break date is wrong'"*. That is the legible chain the owner asked for, and it is more useful than either fact alone.

**The one word a card shows is derived in exactly one place.** `dispositionFor(verification, challenges)` in `packages/core` is the single home for "what does this finding's human state say", alongside `verificationLabel` and `exportSummaryLine`, which already exist to stop the DOCX and CSV exporters drifting apart. **This does not weaken "nothing derives verification"**: that rule forbids *inferring a human judgement from a model's output*. Composing a display label from acts people actually took is what `verificationLabel` has always done. Nothing here writes a verification; only a person's request does, and the engine's database role lacks the grant to.

**Notes are their own table now.** R-B3 kept them on the `Finding` and said "a notes store becomes a later migration". This is that migration. Notes survive a re-run, as they always have, because they are about the clause rather than about one run's output.

**`Verification.assigneeId` is retired** (S17). It existed for schema-readiness under R1 and reached nobody. A real assignment needs an assigner, a time and a resolution, none of which a single id can carry.

### 6.4 What already carries identity and needs no change

`Matter.ownerId`, `DocumentRecord.addedByUserId`, `Collection.createdByUserId`, `Review.createdByUserId`, `PlaybookVersion.publishedByUserId`, `Changeset.createdByUserId`, `Note.byUserId`, `Verification.byUserId`, `NetPosition.byUserId`. Every one of these is already populated from the local profile. They become foreign keys to `app_user` and are otherwise untouched. **This is R1's schema-readiness paying for itself**, and it is the single largest reason this migration is a data move rather than a redesign.

### 6.5 What is new

```
workspace           id, name, created_at                    -- one row now (S9)

app_user            id uuid pk
                    workspace_id
                    entra_object_id text unique not null    -- the oid claim
                    entra_tenant_id text not null
                    email, display_name, initials
                    role text not null                      -- reviewer|partner|admin
                    status text not null                    -- active|disabled
                    first_seen_at, last_seen_at

audit_event         id bigint generated always as identity  -- append-only (S11)
                    workspace_id, at, actor_user_id
                    action text                             -- e.g. finding.verified
                    subject_type, subject_id
                    matter_id, review_id
                    detail jsonb
                    -- GRANT INSERT, SELECT only. No UPDATE, no DELETE, to any app role.
                    -- Partitioned monthly.

run                 id, review_id, workspace_id
                    state text          -- queued|running|cancelling|cancelled|succeeded|failed
                    requested_by_user_id, model_deployment
                    concurrency int
                    started_at, finished_at, heartbeat_at
                    cancel_requested_at, error

run_cell            run_id, findings_key, clause_id  (pk)
                    state text          -- queued|leased|done|error|cancelled
                    attempts int not null default 0
                    leased_by text, lease_expires_at timestamptz
                    last_error text

event               id bigint generated always as identity  -- the realtime cursor (§8)
                    workspace_id, matter_id, review_id
                    type text, payload jsonb, at timestamptz
                    -- retained 7 days; this is a reconnection buffer, not an archive

role_mapping        entra_group_object_id text pk, role text
```

**Document bytes live in Azure Blob Storage**, one blob per document, keyed `workspace/{workspace_id}/document/{document_id}`, private container, no public access, server-side encryption, reachable only through the API's managed identity. `document.blob_key`, `byte_size`, `mime` and `content_sha256` live in Postgres. Deleting a matter deletes its documents' rows *and* their blobs, in that order, with a reconciliation job that deletes orphaned blobs — because the cascade is a promise the README makes and a half-done cascade is the failure mode that promise exists to prevent.

**Page images are still never persisted.** Not in Postgres, not in Blob Storage, not anywhere. They are regenerated on demand by the API at run time and held in an in-process LRU for the life of that run (§11). The rule was about derived data being ~⅓ larger than its source and regenerable; nothing about a server changes that.

### 6.6 Settings

`Settings.apiKey` is deleted. `Settings.modelId` becomes workspace configuration an admin sets from the Foundry deployment allowlist. `Settings.concurrency` becomes a server-side per-run bound. `modelSupportsImages` / `modelSupportsStructuredOutput` / `modelContextLength` become properties of the allowlisted deployment, known server-side and sent to the client for capability display.

**R6 survives for what is left.** Genuine per-user UI preferences — and nothing else — stay in `localStorage`, synchronously, for the reason R6 gave. R6's API-key clause is void, because the key is gone.

---

## 7. Auth and roles

**Entra ID, OIDC authorization code with PKCE**, via MSAL in the browser. The API validates the access token on every request: signature against the tenant JWKS, issuer, audience, tenant id, expiry. No session cookie of its own — one credential, refreshed by MSAL, used for both HTTP and the WebSocket upgrade. A WebSocket whose token expires is closed by the server and reconnected by the client with a fresh one.

**A user row is created on first successful sign-in** (just-in-time provisioning) from the token's `oid`, `tid`, `name` and `preferred_username`. `entra_object_id` is the identity, never the email — an email can be reassigned, an object id cannot.

**Three roles, mapped from Entra security groups** through `role_mapping`, seeded by deployment configuration and editable by an admin. A user in no mapped group has no access at all and is told so plainly — not shown an empty app, which would be the "empty is not broken" rule failing at the front door.

| Role | Can |
|---|---|
| `reviewer` | Create and edit matters, documents, collections and reviews; run reviews; verify, flag, reject and note; assign; confirm or amend net positions; edit playbook drafts; export. |
| `partner` | Everything a reviewer can, **plus** publish a playbook version. Whether a partner may also override a verification is **§17 Q1, undecided**. |
| `admin` | Everything a partner can, plus: role mapping, model deployment selection, retention configuration, disabling a user, and exporting the audit log. An admin is not a super-reviewer; the actions are administrative. |

**Deliberately not built:** per-matter ACLs, guest accounts, deny rules, delegated permissions, custom roles. One firm, one workspace, everybody sees the work (S10).

**Every check happens in the API.** The web app hides what a role cannot do, because a dead button is bad design; the API refuses it, because a hidden button is not a security control. §14's authorisation suite is table-driven over the route list, so a new route with no entry fails the build rather than shipping open.

---

## 8. The realtime design

**Transport: WebSocket**, one connection per browser tab, multiplexed across subscriptions. Chosen over SSE because presence needs a client→server channel — a heartbeat, and "I am looking at clause 14" — and SSE would require a second POST channel to carry it, which is two transports to keep in agreement.

**Subscriptions** are `matter:{id}` and `review:{id}`. A client subscribes on opening a screen and unsubscribes on leaving.

**Every event carries the monotonic `event.id`.** The client keeps the highest id it has applied, per subscription. This is the only piece of state the reconnection protocol needs.

**Reconnection, and the rule that matters:**

1. The client reconnects and sends `{ subscribe, lastEventId }`.
2. If `lastEventId` is within the retained window, the server replays every later event for that subscription and then sends `caught_up`. The client applies them in order and resumes.
3. If it is not — the client was away longer than the 7-day retention, or the outbox was pruned — the server sends **`resync_required`**. The client discards its local copy of that subscription's state, refetches it over HTTP, and **says so in the UI while it does** ("Reconnecting — refreshing this review").
4. While disconnected, the client shows a persistent, non-modal *stale* indicator. **It never shows disconnected data as though it were current.** This is the fourth load state from §3, and it is the one most likely to be skipped, because the app looks fine without it.

**Events are idempotent and version-guarded.** Each carries the `version` of the row it describes; an event whose version is not newer than what the client holds is dropped. That makes replay safe, makes your own write's echo a no-op, and makes out-of-order delivery survivable.

**Presence** is a heartbeat every 10 seconds with a 15-second TTL, carrying `{ userId, initials, screen, clauseId? }`. The roster is broadcast to the subscription on change. **Presence is never persisted** (S6): it is ephemeral, and a stale "Priya is here" row surviving a crash is a lie the app would tell indefinitely. It is also **advisory** — it locks nothing, blocks nothing, and gates no write. Its whole job is to let two people see each other and not collide.

**Fan-out** is in-process while `api` runs as a single replica. Spike 3 (§15) establishes whether Container Apps' ingress and scaling force a Redis-backed fan-out from day one; the hub is written behind an interface either way, so the answer changes one implementation and no call sites.

---

## 9. The review engine, server-side

The engine moves because collaboration forces it: with two people in one review, neither browser can own the run. It also makes the gateway a real boundary — once model calls originate server-side by construction, "the browser cannot call a model" needs no enforcement, because the browser has no reason to.

**Starting a run.** `POST /reviews/{id}/runs` creates a `run` row and one `run_cell` per unit of work — document × clause for a standalone review, clause alone for a collection review — in state `queued`, and returns immediately. The response is the run, not the results.

**Executing.** Workers (in-process in `api` at this scale, behind an interface so they can move to their own container without touching call sites) lease cells with `SELECT … FOR UPDATE SKIP LOCKED LIMIT n`, set `lease_expires_at`, and execute `extractClause` or `extractCollectionClause` from `packages/core` with a model client that points at the gateway. Each completed cell writes its `finding` row and appends one `event`, in one transaction. Concurrency is bounded per run and per workspace, so a forty-document batch cannot starve a colleague's three-clause retry.

**Cancelling.** `POST /runs/{id}/cancel` sets `cancel_requested_at`. Workers check it between cells and abort the in-flight HTTP call. Every cell not already `done` becomes `cancelled` — **never left `pending`**. The defect this prevents is named in `CLAUDE.md`: *an abandoned run reopening with every cell spinning forever, unfinishable.*

**Resuming.** A worker that dies mid-cell leaves a lease that expires; the cell is re-leased and re-run. `attempts` is bounded (3); a cell that exhausts them becomes `error` carrying its last error text, which is a finding a person can retry by hand — not a cell that quietly never finishes. A run whose `heartbeat_at` is older than three intervals is marked `failed` by a reaper and says so, rather than sitting `running` forever.

**Streaming.** The cell events *are* the stream: `run.started`, `finding.running`, `finding.done`, `finding.error`, `run.finished`. Token-level streaming exists only for the assistant chat, proxied browser ← api ← gateway; nothing in the review path needs it.

### 9.1 `carryHumanState` retires

`carryHumanState` exists because `runReview` owns its own copy of the run and emits a full snapshot roughly twice per cell, so anything a human wrote from outside the engine was invisible to it and got overwritten by the next unrelated cell. That is a consequence of a whole-object write from a single in-browser orchestrator.

With findings as rows (§6.2), the engine writes only the model-authored columns of the one cell it just ran, and a human write goes to `finding_verification`, `finding_challenge` or `note` — tables the engine's role cannot write to at all. There is no snapshot, so there is nothing to merge, so nothing can clobber a human write. **`carryHumanState` and `findingMerge.ts` are deleted, not ported.** One writer replaces N racing browsers, and this is the single largest simplification in the design.

**What does not retire is the re-run reset.** Re-running a clause still resets its verification and its net position, for the reason it always did: the judgement described a specific answer, and once that answer is replaced, keeping it would let an export claim a human checked text they never saw. Server-side this becomes stronger, not weaker — it is one transaction:

```sql
BEGIN;
  UPDATE finding SET … , version = version + 1 WHERE (review_id, findings_key, clause_id) = …;
  DELETE FROM finding_verification WHERE (review_id, findings_key, clause_id) = …;
  UPDATE finding_challenge SET withdrawn_at = now() WHERE … AND withdrawn_at IS NULL;
  -- notes are NOT touched: a note is about the clause, not about one run's output
  INSERT INTO audit_event …;   -- 'finding.rerun_reset', naming what was cleared
  INSERT INTO event …;
COMMIT;
```

A partial reset is now impossible rather than merely tested against. It stays mutation-tested regardless (§14), because it is the load-bearing claim in every export the app produces.

---

## 10. The inference gateway

A small, stateless HTTP service. Two routes:

```
POST /v1/infer          -> { content, usage: { promptTokens, completionTokens } }
POST /v1/infer/stream   -> SSE of content deltas
```

Request body:

```
{ deployment, purpose, system, user, images?, jsonSchema?, temperature?,
  workspaceId, actorUserId, matterId?, reviewId?, clauseId? }
```

**Who may call it.** Only `apps/api`, authenticated by its Azure managed identity (or mTLS in local compose). The gateway has no public ingress and no route from the internet.

**How it authenticates to Foundry.** `DefaultAzureCredential` → a token for `https://cognitiveservices.azure.com/.default` from the container's managed identity, refreshed automatically. **No provider API key exists in the system.** Not in a browser, not in an env var, not in Key Vault, not in a git history. A token acquisition failure is a loud `503` naming the failure — **never a fallback to an unauthenticated or differently-authenticated call**, which is the shape of "answer quietly wrong" available to this service.

**What it enforces.**

- **A deployment allowlist.** A request naming a deployment not on the list is rejected. The list is region-pinned: a deployment whose region is outside the UK/EU is not on it, and the gateway refuses one even if configuration is wrong (§12 Q5).
- **A purpose allowlist** — `review.clause`, `review.collection_clause`, `assistant.chat`, `playbook.draft`, `playbook.suggest`, `redlines.infer`, `changeset.build`, `export.email`, `export.suggest_fix`. An unknown purpose is rejected. This makes "what does this system send to a model, and why" answerable from configuration rather than from reading the application.
- **Budgets and rate limits**, per workspace and per actor, in tokens and in requests.
- **A maximum prompt size** and a request timeout.
- **Retry on 429 and 5xx only; fail fast on 400/401/402/403.** This is `openrouter.ts`'s rule, carried over verbatim because it was right: retrying a rejected credential wastes the user's time before telling them the same thing. `parseJsonLoose` moves to `packages/core` and stays the fallback for models that wrap JSON in prose.

**What it logs, per call.** Timestamp, purpose, deployment, workspace id, actor user id, matter/review/clause ids, prompt token count, completion token count, latency, HTTP status, retry count, whether images were attached and how many, and `sha256` of the prompt. Retained 90 days.

**What it does not log: prompt content and completion content, ever.** The prompt hash exists so that "was this the same prompt?" is answerable in support without keeping the prompt. A content-logging debug mode is not built; if one is ever wanted it must be admin-enabled, time-boxed, and itself audit-logged — named as §17 Q8, not designed here. A redaction test asserts no log line can carry document text (§14).

### 10.1 Risk item the owner must decide: Foundry abuse-monitoring retention

Azure OpenAI's default abuse-monitoring behaviour, as documented at the time of writing, **stores prompts and completions for up to 30 days**, and flagged content may be reviewed by authorised Microsoft personnel. Opting out — "modified abuse monitoring" under Limited Access — requires an application to Microsoft and approval; it is not a portal setting.

Stated plainly, because a Risk reviewer will ask and this is the honest answer: **until that exemption is applied for and granted, contract text this app sends for review is retained by Microsoft for up to 30 days and may be seen by a human.** That is a materially different sentence from "there are no keys and nothing leaves the tenant", and both are true at once.

The owner decides (§17 Q4): apply for the exemption before go-live, or accept and disclose it. **The exact terms must be re-confirmed against Microsoft's current documentation at implementation time** — this is a compliance fact with a shelf life, and it is being written by a model with a knowledge cutoff. Do not take this paragraph as the citation; verify it.

---

## 11. Ingest and parsing

**Parsing moves server-side** (S19), and this is the least obvious ruling in the document, so here is the reasoning.

The engine now runs server-side, and a scanned document needs page images at run time. If only the browser can render them, a queued run could only start from a browser that happened to have the document open — which is not a queue. So the server must be able to render page images from stored bytes. And once the server can render, it can parse; two parsers for one file format is precisely the sibling drift this project has paid for six times.

**The flow.** Upload sends bytes only. The API stores the blob, creates a `document` row with `parse_state = 'pending'`, and returns. A parse worker extracts text (`pdfjs` for PDF, `mammoth` for DOCX, plain read for TXT), inserts the `[Page N]` markers exactly as today, runs the per-page scan check with `SCAN_TEXT_THRESHOLD` from `packages/core`, runs `detectDocxMarkup` for the tracked-changes notice, and sets `parse_state = 'parsed'` or `'failed'` with a `parse_error`.

**`parse_state` is a real state and is rendered as one.** A document being read shows "Reading…", not an empty text panel and not a document that looks ready. That is the third load state again, at ingest.

**Page images stay unpersisted.** The run worker regenerates them from the stored blob for a document whose pages fall below `SCAN_TEXT_THRESHOLD`, holds them in an in-process LRU for the life of the run, and drops them. `documentFileForReview` / `documentFileForViewing` survive as the two hydration modes they already are, now server-side — and the rule that extraction takes review-hydrated documents survives with them, because it is the project's founding defect and it has already reopened twice.

**The browser keeps `pdfjs` for the viewer and for `findQuoteRects`.** That is a different job — matching a quote to on-screen coordinates, where the canvas is — and it is not a second copy of anything the server does.

**Server-side PDF rendering is unproven here and is Spike 1** (§15). If it fails, the fallback is Azure AI Document Intelligence OCR at ingest, in-region, which produces a text layer and removes the image path entirely — better for citations, but a new subprocessor and a new line in §12.

**"Learn from redlines" needs an explicit decision, and it is §17 Q9.** Today, precedent documents are read in the browser and stored nowhere — a promise the README makes in so many words. If they are uploaded to be parsed server-side, that promise changes shape: they would be parsed in memory and never written to Postgres or Blob. That may well be acceptable, but it is not the same sentence, and it must be re-stated in the README and asserted by a test (no row, no blob, for a `purpose: 'redlines'` upload) rather than assumed.

---

## 12. The Risk-review story

Written as answers, because these are the questions actually asked.

**1. Where does client data live?**
In the firm's own Azure subscription, UK South. Document metadata, extracted text, findings, playbooks and the audit log in Azure Database for PostgreSQL Flexible Server (encrypted at rest, private endpoint, no public network access). Original document bytes in Azure Blob Storage (private container, no anonymous access, service-side encryption, private endpoint). Nothing persists in the browser except a rendered view and a short-lived Entra token; browser-local persistence is retired and the old IndexedDB database is removed after §13's migration.

**2. Who can access it?**
Named members of the firm's Entra tenant who are in one of three mapped security groups. There is no password login, no shared key, no API key, no anonymous link, and no external sharing. Access is removed by Entra group removal or account disable: HTTP access ends at the next token refresh (≤ 60 minutes) and WebSocket connections for a disabled user are closed immediately by the server. Infrastructure access (DBA, blob) is Azure RBAC with PIM approval and is recorded in Azure activity logs, outside the application's control.

**3. What is logged?**
Two logs, deliberately separate. **`audit_event`** records who did what to which record: every human judgement (verify, flag, reject, note, confirm, amend), every assignment, every publish, every export, every document added or deleted, every role change, every run started or cancelled. It is append-only by database grant, not by convention (S11) — the application role holds `INSERT` and `SELECT` and nothing else. **The gateway call log** records metadata for every model call and no content (§10). Application logs never contain document text; a redaction test enforces it (§14).

**4. What is retained, and for how long?**
Documents, reviews and findings until the firm deletes them; deleting a matter cascades to its documents' rows and their blobs. Audit log: 7 years by default — **§17 Q3, the firm's retention schedule decides.** Gateway call log: 90 days. Realtime event outbox: 7 days (a reconnection buffer, not an archive). Postgres point-in-time backups: 35 days. **Foundry abuse monitoring: up to 30 days unless the exemption in §10.1 is granted — §17 Q4.**

**5. Who are the subprocessors?**
Microsoft only: Azure Container Apps, Azure Database for PostgreSQL, Azure Blob Storage, Azure AI Foundry, Microsoft Entra ID, Azure Monitor. **OpenRouter is removed**, and with it every model provider it fronted — which is the single largest change to this answer and the reason Stage 1 is sequenced first. Inference is region-pinned: only UK/EU Foundry deployments are on the allowlist, and the gateway refuses anything else. Where a desired model has no UK/EU deployment, it is not allowlisted and the app cannot use it — a capability limit accepted deliberately in exchange for the answer to this question.

**6. What happens on breach?**
The gateway holds nothing at rest; compromising it exposes calls in flight, not the archive, and it holds no credential that reaches Postgres or Blob. Postgres and Blob have no public endpoint. Response: disable the Entra app registration (all sessions end at next refresh; WebSockets are closed), rotate managed-identity role assignments, and read `audit_event` for the actor's complete trail. **The audit log being append-only with no `UPDATE`/`DELETE` grant is what makes that trail evidence rather than a claim.**

**7. What happens on offboarding?**
Disabling the Entra account ends access. The person's authored records remain, attributed: a verification is a professional judgement someone made, and a report that silently loses its reviewer is a report that lies. `app_user.status = 'disabled'` renders as "A. Gray (no longer active)". **Deleting a user is not offered**, because it would either orphan or falsify the verification chain. That has a GDPR-erasure consequence and it is **§17 Q6** for the firm's DPO — not a decision this design makes on its own.

---

## 13. Migration and sequencing

Staged so the app keeps working at every point, and ordered so the Risk posture improves before any multi-user surface exists.

**This document is one design, but it is not one implementation plan.** Each stage below is its own spec-to-plan-to-implementation cycle, exactly as sub-projects A through G each were; §20 sizes them. Nothing here should be planned as a single unit of work, and a stage that turns out larger than its estimate is decomposed further rather than compressed.

**Stage 0 — `packages/core`.** Convert to an npm-workspaces monorepo and move the domain logic (§5) with no behaviour change. Every test that moves with it must still pass unchanged; that is the acceptance criterion. An import-boundary test forbids `apps/*` from reimplementing anything `packages/core` exports (S14) — this project's most repeated defect is two copies of one idea drifting, and a client/server split is that hazard at scale.

**Stage 1 — the gateway, while the app is still browser-only.** `openrouter.ts` becomes a `ModelClient` interface with one implementation pointing at the gateway through a minimal `api` whose only route is the inference proxy. The browser signs in with Entra. Everything else still lives in IndexedDB.

**This stage is shippable and valuable on its own, and it is the whole reason for the ordering:** it deletes the per-user OpenRouter key, removes OpenRouter and its providers as subprocessors, and moves inference into the firm's UK/EU tenant — the three things that most improve the Risk answer — *before* a single multi-user feature exists to argue about.

**Stage 2 — storage and auth.** Postgres and Blob behind the nine repositories' existing interfaces. **R3's seam holds a second time**: those repositories are already Promise-returning, precisely so a storage swap would not touch callers. Entra sign-in becomes the real gate; roles are mapped; `app_user` replaces the local profile. Behaviour stays single-user. Browser-local mode is retired at the end of this stage, and §13.1's uploader ships with it.

**Stage 3 — the server-side engine.** Runs become jobs; the browser stops orchestrating; `carryHumanState` and `findingMerge.ts` are deleted; cancel and resume become real. Findings become rows, which is the largest single data migration in the plan and is done here rather than in Stage 2 because the engine is what forces it.

**Stage 4 — realtime and collaboration.** WebSocket, presence, live findings, first-to-verify-wins, challenges, assignment, and the activity feed read from `audit_event`.

**Stage 5 — the superseded surfaces.** Assignee chips, "assigned to me", actors in the feed, firm-wide search. **Not before Stage 4** — R-G1 binds until the mechanism behind each affordance is real (§3.1).

### 13.1 What happens to data already in a browser

It is one person's browser — the owner's — and the app has no export for matters or documents today; the README says so. So the honest options were "move it" or "lose it", and losing it is not this project's habit.

**A one-time uploader ships with Stage 2**: a single screen, available for one release, that reads the local IndexedDB, uploads each matter, document (bytes and text), collection, review, playbook, version and changeset, and **reports exactly what it moved and what it could not, by name**. A partial migration says so; it never reports success over a gap. That rule is not new — *"a failed storage migration rendering an empty library, indistinguishable from a fresh install"* is on `CLAUDE.md`'s list.

**It never deletes the local copy.** The IndexedDB database is left in place, and the app opens it read-only afterwards behind a banner explaining that the server is now authoritative. A later release deletes it, once the owner confirms the server copy is good. This is the same posture the `localStorage` → IndexedDB migration took, for the same reason: never delete what you cannot read. *Cost: a stale local copy sits in one browser for a release or two.*

**§17 Q5 lets the owner decline all of this** and start clean, which is a legitimate answer for a tool this early.

---

## 14. Testing

**First, a correction to the premise.** The suite is 133 test files and `vitest.setup.ts` loads `fake-indexeddb/auto` globally, so it *looks* as though all of them assume IndexedDB. They do not. Measured:

- **111 files** import neither the DB layer nor `App` — pure logic over data, exactly as `src/lib` was designed to be.
- **22 files** import `src/lib/db`.
- **14 files** mount `App` (overlapping with the 22).
- **24 files** exercise `openrouter`.

So the migration is much smaller than "~130 tests to rewrite", and saying so is worth more than a dramatic number.

**The 111 move to `packages/core` and run unchanged**, without jsdom and without `fake-indexeddb`. If any of them needs editing beyond an import path, that file was not as pure as it looked and the edit is worth examining rather than making quietly.

**The 22 DB tests are rewritten against a real Postgres**, not a fake. Testcontainers locally and in CI (or the compose-provided database), each test in a transaction rolled back at teardown. **A fake Postgres is not acceptable**: a substitute that behaves subtly differently from the real thing is the exact defect class this project keeps finding, and half the point of moving to Postgres is that it enforces constraints IndexedDB could not. Those constraints get tests of their own, which are new work rather than ports:

- first-to-verify-wins really conflicts under two concurrent inserts, and the loser gets the winner's row;
- `finding_challenge` cannot be deleted or updated by another user;
- a published `playbook_version` cannot be updated by the app role;
- `audit_event` cannot be updated or deleted by the app role;
- the re-run reset is atomic — a failure mid-transaction leaves neither a new finding nor a cleared verification.

`fake-indexeddb` is deleted along with the last IndexedDB test. So is the `node:buffer` Blob workaround, which existed only because Blobs do not round-trip through `fake-indexeddb`.

**The 24 openrouter tests split.** The client interface survives with a new transport; the retry-policy tests move to the gateway's own suite, where they belong, and are joined by: the deployment allowlist refuses an unknown deployment; the purpose allowlist refuses an unknown purpose; **no log line contains prompt or completion content**; a managed-identity token failure produces a loud 503 and never an unauthenticated call.

**The 14 App tests keep this project's harness.** R-B8 holds: `createRoot`/`act` via `src/test/mount.tsx`, no `@testing-library/react`. What changes is the seam beneath them — a DB mock becomes an HTTP-and-WebSocket mock. **MSW is added** for this, because hand-rolling both a `fetch` stub and a WebSocket fake would be the third copy of something (S14's own rule, applied to test infrastructure).

**New suites:**

| Suite | Covers |
|---|---|
| `realtime` | reconnect replays from the cursor and reaches `caught_up`; a cursor beyond retention forces `resync_required` **and the UI renders the stale state while it refetches**; an out-of-order or duplicate event is dropped by version guard |
| `runLifecycle` | an expired lease is re-leased; cancel leaves no cell in `pending`; a cell exhausting attempts becomes `error` with its text; a stale heartbeat marks the run `failed` |
| `authz` | table-driven over every route × every role, so a new route with no entry fails the build |
| `egress` | an integration test asserting `api` cannot reach the model endpoint directly (Spike 2 establishes how) |
| `loadStates` | in-flight, failed, empty and stale each render distinctly, on every screen that loads from the API |
| `migration` | the browser uploader reports what it moved and what it could not; a partial migration never reports success; the local copy is not deleted |

**Mutation-test, without exception:** the re-run reset (now transactional), first-to-verify-wins, the `resync_required` path, the audit log's insert-only grant, and the egress restriction. Break each, confirm a test fails, restore. A green suite is not evidence.

**Browser verification is still mandatory and now needs two accounts.** The claims this design adds — presence, live updates, first-to-verify-wins, assignment reaching a person — cannot be verified by one person on one machine, and unit tests will not catch what breaks. `CLAUDE.md`'s rule applies: if it cannot be done, say so plainly rather than implying it was.

---

## 15. Three spikes

Each has an answer as its output, not code that is kept. None of them gates the sequencing: Stage 1 depends on none of the three.

**Spike 1 — server-side PDF page rendering.** Can `pdfjs-dist` v6 render page images under Node 22 with `@napi-rs/canvas`, at acceptable speed and fidelity, for a real scanned contract? Output: a go/no-go with a worked example and a timing. **Fallback if no:** Azure AI Document Intelligence OCR at ingest, in-region, which removes the image path entirely but adds a subprocessor to §12 Q5. Gates §11 only.

**Spike 2 — provable egress restriction.** In an Azure Container Apps environment, can `api`'s outbound access be denied to the public internet while it still reaches Postgres, Blob Storage and the gateway over private endpoints — and can that denial be **asserted by an automated test** rather than by reading configuration? Output: the network configuration and the test. This spike matters more than its size suggests: it is the difference between the design's central claim being architecture and being a promise.

**Spike 3 — WebSocket through Container Apps.** How do WebSockets behave through Container Apps ingress with scale-to-zero and more than one replica, and does fan-out therefore need Redis from day one? Output: a yes/no on Redis and a minimum-replica recommendation. Gates §8's implementation choice, not its protocol.

---

## 16. Rulings

Recorded in `rulings.md`'s format. Each carries its cost if wrong.

- **S1. Four workspaces — `packages/core`, `apps/web`, `apps/api`, `apps/gateway` — and `api` may not egress.** The topology is the security control. *Cost if wrong: a monorepo and one extra container to operate for a firm-sized deployment; the alternative makes the design's central claim unprovable.*
- **S2. The gateway is the only egress, and it authenticates to Foundry by Entra managed identity. There are no provider API keys anywhere in the system.** *Cost if wrong: nothing runs where managed identity is unavailable, and local development without Azure credentials needs a stubbed gateway — which is built anyway.*
- **S3. Findings become rows keyed `(review_id, findings_key, clause_id)`, not a JSON blob on the review.** *Cost if wrong: a larger migration and more SQL than a `jsonb` column; keeping the blob makes concurrent writes lose work with nothing on screen to show it, which is not a cost, it is the defect.*
- **S4. A finding carries at most one verification (insert-once, first wins) plus append-only challenges.** *Cost if wrong: a person who verified in error cannot un-verify without a partner override (§17 Q1); the alternative lets a second person quietly overwrite a colleague's judgement.*
- **S5. `carryHumanState` and `findingMerge.ts` are deleted; the re-run reset becomes one transaction and is not deleted.** *Cost if wrong: none identified — the merge exists only to defend against a whole-object write that no longer happens. Deleting the reset instead would let an export claim a human checked text they never saw.*
- **S6. Presence is never persisted and locks nothing.** *Cost if wrong: presence is lost on an api restart and rebuilds within one heartbeat.*
- **S7. WebSocket with a monotonic event cursor, replay on reconnect, and an explicit `resync_required` that the UI shows.** *Cost if wrong: a 7-day outbox costs storage; without the cursor a reconnected client diverges silently, which is the network-era version of every defect on `CLAUDE.md`'s list.*
- **S8. No optimistic UI for any human-authored state. Own writes render from the HTTP response; others' arrive as pushes; echoes are dropped by version guard.** *Cost if wrong: a verify click has a perceptible round trip, exactly as R-B2 accepted a perceptible disk write.*
- **S9. `workspace_id` on every table from day one; one workspace seeded.** *Cost if wrong: one unused column per table and one predicate per query, in exchange for a second tenant never being a schema migration.*
- **S10. Three roles from Entra groups; no per-matter ACLs, no custom roles, no deny rules.** *Cost if wrong: if the firm later needs matter-level confidentiality (a conflicts wall), that is a real addition — a `matter_access` table and a predicate on the matter queries, not a redesign, because everything already scopes by workspace.*
- **S11. The audit log is append-only by database grant, not by convention.** *Cost if wrong: a mistaken audit row cannot be corrected, only annotated by a later row — which is what append-only means and why it is evidence.*
- **S12. Document bytes in Blob Storage; page images still never persisted, regenerated per run and held in an in-process LRU.** *Cost if wrong: a scanned document's images are re-rendered for each run rather than cached across runs — seconds, and R2's original reasoning, on a server.*
- **S13. Browser-local mode is retired. A one-time uploader migrates the existing browser's data, reports what it could not move by name, and never deletes the local copy.** *Cost if wrong: a stale local copy sits in one browser for a release or two.*
- **S14. `packages/core` is the single home for domain logic, enforced by an import-boundary test.** *Cost if wrong: an occasional awkward extraction to satisfy the boundary; the alternative is this project's most repeated defect, at client/server scale, where the two copies cannot even be read side by side.*
- **S15. Models are an admin-configured allowlist of Foundry deployments, region-pinned to UK/EU. A user cannot enter a model id.** *Cost if wrong: a model with no UK/EU deployment is unavailable, and adding one is a configuration change plus a Risk sign-off — which is the point.*
- **S16. `Settings` shrinks to genuine UI preferences; R6 survives for those and its API-key clause is void.** *Cost if wrong: none — the fields being removed have no server-side meaning.*
- **S17. `Verification.assigneeId` is retired in favour of an `assignment` table.** *Cost if wrong: one field's worth of migration; keeping it would under-specify an assignment, which needs an assigner, a time and a resolution.*
- **S18. R1 / R-G1 is superseded as of 2026-08-28, and its collaborative affordances land in Stage 5 — not before Stage 4.** *Cost if wrong: shipping a chip before its mechanism reproduces exactly the silence R-G1 was written to prevent, which is why the staging is part of the ruling rather than a note.*
- **S19. Document parsing moves server-side; the browser keeps `pdfjs` only for the viewer and `findQuoteRects`. Ingest is asynchronous with a real `parse_state`.** *Cost if wrong: if Spike 1 fails, ingest OCR replaces server-side rendering — a subprocessor added and a better citation story gained. Parsing in the browser instead would make a queued run depend on a browser having the document open, which is not a queue.*
- **S20. Free-text conflicts are last-write-wins with the loser told and shown what replaced their text; no OT, no CRDT.** *Cost if wrong: a rare simultaneous edit costs one person a retype, having been told; a merge engine is a subsystem defending against something the owner expects to be rare.*

---

## 17. Open questions for the owner

Not rhetorical. Each changes something in this document, and none is answered here.

1. **May a Partner override a trainee's verification, or only flag it?** *My recommendation is flag-only:* an override erases a professional judgement someone made and leaves no trace of the disagreement, whereas a flag leaves both facts standing. But this is a professional-hierarchy question, not a technical one. **Affects §6.3 and §7.**
2. **Does assignment notify by email or Teams, or in-app only?** In-app is the floor and is built. Each external channel adds a subprocessor and a line to §12. **Affects §4, §12.**
3. **Retention.** How long is the audit log kept (7 years is a default standing in for the firm's own schedule, not a decision this design makes)? Is a matter ever hard-deleted, or only closed? Does document retention follow the firm's matter-file policy? **Affects §12 Q4.**
4. **Foundry abuse monitoring (§10.1).** Apply for the modified-abuse-monitoring exemption before go-live, or accept and disclose up-to-30-day retention with possible human review? **Affects §12 Q4 and the disclosure the app itself shows.**
5. **The data currently in the owner's browser** — migrate it with §13.1's uploader, or start clean?
6. **GDPR erasure versus the verification chain.** A leaver's name stays on their verifications (§12 Q7). Does the firm's DPO accept that as a business record, or is a pseudonymisation path required? **Affects §6.5 and §12 Q7.**
7. **One region or two.** UK South alone, or a paired region for disaster recovery? What RPO and RTO does the firm need? **Affects §5's infrastructure and §12 Q1.**
8. **A content-logging debug mode.** Should one exist at all — admin-enabled, time-boxed, itself audit-logged — or is "the gateway never logs content, full stop" the simpler thing to defend? *My recommendation is the latter*, because a mode that can be enabled is a mode a Risk reviewer must be told about.
9. **"Learn from redlines" (§11).** Do precedent documents now pass through the server to be parsed — read in memory, never written, asserted by a test — or does that feature keep a browser-only parse path so the current README sentence stays literally true?
10. **Whether the assistant / chat feature is in scope for the server release.** It streams and it sends document text, so it is a second egress path through the gateway with its own purpose tag and rate limit. *My recommendation is to keep it* (R4's reasoning holds: it works, it declines honestly, and dropping a working feature by omission is the wrong reading of silence) — but it is work, and the owner may prefer it deferred to a later stage.

---

## 18. Definition of done

Per stage, since this ships in five.

1. `tsc --noEmit` clean across all four workspaces; every suite passes; every app builds clean.
2. **Stage 1:** no OpenRouter key exists anywhere in the codebase or in any browser; every model call goes through the gateway; the gateway holds no key and authenticates by managed identity; the call log contains no prompt content, asserted by a test.
3. **Stage 2:** a user signs in with Entra and sees only what their role permits, refused by the API and not merely hidden by the UI; every record type round-trips through Postgres; document bytes round-trip through Blob Storage; deleting a matter purges its blobs; the browser uploader moves the owner's data and names anything it could not.
4. **Stage 3:** a run survives a worker restart mid-run and completes; cancelling leaves no cell in `pending`; re-running a clause clears its verification and its net position in one transaction; `carryHumanState` is deleted and nothing regressed.
5. **Stage 4:** two people in one review see each other's presence and each other's writes without reloading; a verify race produces one verification and tells the loser who won; a disconnected client shows itself as stale and resynchronises visibly; an assignment reaches the assignee.
6. **Stage 5:** every affordance R-G1 dropped is back only where its mechanism is real.
7. `api` provably cannot reach a model endpoint directly, asserted by a test (Spike 2).
8. §12 is answerable end to end by someone who did not write it, and the README's untrue sentences (§2) are all replaced.
9. Verified in a browser, on a deployed environment, with two real accounts.

---

## 19. Risks

**The Risk review is a gate held by people, not by tests, and it can be failed on a true answer.** §10.1's 30-day abuse-monitoring retention is the likeliest place. Everything else in §12 is a good answer; that one is honest rather than good, and it should be raised early rather than discovered at sign-off.

**The audit log is only evidence if nothing can rewrite it.** S11 makes that a grant rather than a habit, but a future migration run as a superuser could still alter it. The mutation test for the insert-only grant is the guard, and it must run in CI against the real database rather than being asserted once at deploy.

**The realtime stale state is the defect this design is most likely to ship.** Everything else fails loudly by construction; a client showing yesterday's findings because its socket dropped looks completely normal. It is the reason §3 adds a fourth load state and §14 gives it a suite of its own, and it is still the thing to check first in browser verification.

**Server-side page rendering is unproven** (Spike 1). The whole scanned-document path depends on it, and the scanned-document path is this project's founding defect. The OCR fallback is real but is a Risk-story change, not a drop-in.

**A client/server split doubles the surface for sibling drift**, which is this project's most repeated failure by a wide margin — six findings from two implementations of one idea. `packages/core` plus the import-boundary test is the structural defence, and it has to be enforced from Stage 0 rather than retrofitted, because the first duplicated helper will be written the week the split lands.

**Retiring browser-local mode removes the app's fallback.** Today a network failure means one broken feature; afterwards it means an unusable app. That is the correct trade for a firm tool with one persistence story, but it raises the cost of every availability decision in §5, and it is worth saying out loud to the owner rather than discovering during the first Azure incident.

---

## 20. How big this is

Honestly: **bigger than the redesign that just finished, and differently shaped.**

The redesign was seven sub-projects, ~130 test files and 339 commits — all in one language, one process, one deployable, with no infrastructure and no external identity. This design keeps all of that and adds three things the redesign had none of: infrastructure as code, a database with real migrations and real constraints, and an authentication integration that cannot be unit-tested into existence.

By volume of code, roughly **1.5–2.5× the redesign**. By elapsed effort, more like **3–4×**, because of what does not appear in a diff: Bicep and `azd` templates, a Postgres migration tool and its rollback story, an Entra app registration and its consent, a realtime protocol that has to survive a real network, two spikes against Azure behaviour, and a Risk review that is a conversation rather than a build step. Browser verification alone gets harder: the collaboration claims need two accounts on a deployed environment.

In this project's own units — a "sub-project" being roughly what A through G each were — the stages come out at about:

| Stage | Sub-project equivalents |
|---|---|
| 0 — `packages/core` extraction | ~0.5 (mechanical, but touches everything) |
| 1 — gateway + Entra + inference proxy | ~1 |
| 2 — Postgres, Blob, auth, roles, uploader | ~2.5–3 (the largest) |
| 3 — server-side engine, findings as rows | ~1.5–2 |
| 4 — realtime, presence, collaboration | ~1.5–2 |
| 5 — the superseded surfaces | ~0.5 |
| Infrastructure and deployment, spread across all | ~1 |

**Total: roughly 8–11 sub-project equivalents**, against the redesign's seven — with the caveat that Stages 2 and 3 are each larger and less forgiving than any single redesign sub-project was, because a mistake in them is a data migration rather than a component rewrite.

The mitigating fact is real and worth stating: **111 of 133 test files and almost all of `src/lib` move to `packages/core` unchanged.** The domain logic this app is actually made of — citation matching, scan detection, position strength, net positions, the extractors — does not change at all. What changes is everything around it.
