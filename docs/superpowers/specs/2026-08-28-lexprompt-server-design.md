# LexPrompt Server — from a browser-only tool to a firm-deployed, collaborative one

**Date:** 2026-08-28
**Revised:** 2026-08-28, for two owner decisions — see "Revision" below.
**Status:** Spec written. Three spikes gate parts of it (§15); none of them gates the sequencing, because Stage 1 does not depend on any of the three.
**Builds on:** the whole of the redesign (sub-projects A–G) and `docs/superpowers/redesign/rulings.md`, which this document continues.
**Supersedes:** ruling **R1** and its sub-project-G restatement **R-G1** — see §3.
**Source:** the owner's constraints, gathered in conversation on 2026-08-28. Those constraints are settled and are not relitigated here; where this design adds something they did not settle, it is a ruling in §16 or an open question in §17.

### Revision, 2026-08-28 — two decisions the owner has made

The owner has answered §17 Q1 and §17 Q9, and both answers change what this document says. They are recorded here at the top, and the body has been rewritten to match rather than annotated around:

1. **Verification is mutable, and a Partner may override it.** *"Partner may override a verification (and something can change from Verified, back to another state, at any time)."* This **supersedes** the first-to-verify-wins model the original §6.3 and ruling **S4** were built on. A finding now carries **one current disposition** and a **complete append-only history** of every change to it. §6.3 is rewritten; §3, §4, §7, §8, §9.1, §12, §13, §14, §16 and §18 are swept for the old model. **No part of this document still describes insert-once verification or first-to-verify-wins**, and if a reader finds one, it is a defect in this revision, not a surviving decision.
2. **Precedent documents may be stored server-side.** *"Precedent documents can be stored server-side."* This answers §17 Q9 and amends ruling **S19**. §11.1 is new and specifies it, including the on-screen sentence that becomes false and must change in the same stage.

Neither decision is relitigated below. Where each one creates a consequence the owner did not settle, that consequence is a new ruling (**S21–S24**) or a sharpened open question, not a silent choice.

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

The table below now covers **the app's own on-screen copy as well as the README**, because the revision's second decision (§11.1) falsifies a sentence a user reads while uploading, not only one a developer reads in a repository. A false sentence on a screen is worse than a false sentence in a README by exactly the distance between the two readers.

| Location | What it says | What replaces it |
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
| §Known limitations (243) | "Verification is single-reviewer … nothing here notifies anybody of anything" | Superseded. A finding's disposition is attributed to a real account, is **changeable by any authorised user at any time**, and carries a full history of who changed it from what to what (§6.3). Assignment reaches a real person, and §17 Q2 decides whether it also leaves the app. |
| §Learning from redlines (70) | "LexPrompt reads them for this one session and **stores none of them**: not in IndexedDB, not in `localStorage`, not in the URL. Close the tab and they're gone" | **False under §11.1.** Precedent documents are stored server-side, in the firm's tenant, as `kind = 'precedent'` documents belonging to a precedent set. Replaced by: they are stored in the firm's Azure like any other document, kept separate from matter documents, never offered as something to review, and covered by the firm's retention schedule (§17 Q3). What survives verbatim from that bullet: *only the standard positions you go on to adopt reach a playbook* — storing a precedent does not put it in a playbook. |
| **App copy** — `src/features/redlines/PrecedentIntake.tsx` | "Read once to learn from. Never stored." | **False under §11.1, and it is on screen at the moment of upload.** Must change in the same stage as the storage — §11.1 states the requirement and its non-negotiable ordering. |
| **App copy** — `src/features/redlines/PrecedentUploadPanel.tsx` | "Marked-up .docx files are read for tracked changes; anything else, including PDFs, can be compared against another version instead." | **Unchanged.** It is true, it is about what is *read*, and it says nothing about storage. §11.1 rules that the new storage sentence goes where the old one was — `PrecedentIntake`'s header — so the promise is still said exactly **once**, which two wordings on this same screen have already cost the project once. |
| **App copy** — `src/lib/privacyCopy.ts` | The storage disclosures, which today have no precedent clause at all because there was nothing to disclose | Gains one. `privacyCopy.ts` is the extracted single home for disclosure wording (R-G5); a new storage promise that lives anywhere else is the drift that module exists to prevent. |

**What stays true, verbatim:** page images are never persisted (§6, and now not server-side either); citations never guess a page; scan detection is per page; re-running a clause resets its verification and its net position; a review snapshots what it claims to have checked; deleting a matter genuinely purges its documents' bytes.

---

## 3. The rules that survive, and the one that is superseded

`CLAUDE.md`'s opening rule binds this design without amendment:

> **Fail loudly rather than answer quietly wrong.**

A network makes this harder, not easier, in exactly one way, and it is the most important thing in this document after the gateway:

**A load path must now distinguish four facts, not two.** *Not yet known* (a request in flight), *broken* (a request that failed), *empty* (a request that succeeded and returned nothing), and — new — *stale* (a client whose realtime connection dropped and which has not yet resynchronised). Every one of those renders differently, and none of them may render as any of the others. A spinner is not an empty list; an empty list is not a failure; and a disconnected client showing yesterday's findings without saying so is the network-era version of the CSV that wrote unreviewed clauses as blank cells. `describeLoadError` / `LoadErrorPanel` carry forward and gain the two new states rather than being replaced.

**`await-then-apply` survives verbatim, and realtime does not soften it.** The rule is that a reviewer never sees a state the store did not take. On a server that means three separate things, and they must not be conflated:

1. **Your own write** is an HTTP request that returns the persisted row. The UI renders from that response and from nothing else. There is **no optimistic update** for any human-authored state — not for a disposition change, a note, a net-position confirmation, or an assignment. The control shows a busy affordance and then the confirmed value.
2. **Someone else's write** arrives as a push. It is a fact about the server's state, so rendering it is not optimism.
3. **Your own write also arrives back as a push.** It is dropped if its version is not newer than the row the client already holds, so the confirmed value never flickers into and out of existence.

The app will *feel* live. It will never be live ahead of the database.

**Verification is set only by a human action, and nothing derives it.** Unchanged by the revision, and §6's shape makes it structurally harder to break: a disposition is a row a person's request writes, and **the run worker's database role has no grant on `finding_disposition` or `finding_disposition_event` at all** — it can neither insert, update nor delete them.

The revision makes verification *mutable*, which is a different axis from *derived*, and conflating the two would be the easiest mistake to make while reading §6.3. Mutable means a person may change their mind, or a colleague may change it for them, and the change is recorded. Derived would mean the engine inferring a human judgement from a model's output, which nothing anywhere does. The one write that is not a fresh human judgement is the re-run reset, and it is safe for a specific, checkable reason: **it only ever moves a disposition *to* `unchecked`, never to `verified`.** A rule that can only remove a claim of human checking cannot manufacture one. That direction constraint is a check constraint in the database, not a convention (S21).

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
7. **The collaboration model** — one current, attributed disposition per finding (`unchecked` / `verified` / `flagged` / `rejected`), changeable by any authorised user in any direction at any time, over a complete append-only history of every change; and assignment that reaches a person in-app.
8. **An append-only audit log**, and the activity feed built from it. A disposition's history is part of that log, not a second copy of it (S22).
9. **Server-side storage for precedent documents** — the "Learn from redlines" inputs, stored as first-class documents distinguished from matter documents in both storage and UI (§11.1), with the on-screen non-storage promise replaced in the same stage.
10. **Deployment** — `docker compose up` locally and `azd up` to Azure, the same shape both ways.
11. **A one-time migration** for the data currently in the owner's browser.

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
| `documents` | `document` | `added_by_user_id` already exists. Gains `blob_key`, `content_sha256`, `parse_state`, and — new in the 2026-08-28 revision — `kind text not null` (`matter` \| `precedent`) with `matter_id` nullable and `precedent_set_id` populated exactly when `kind = 'precedent'` (§11.1). |
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

**A finding carries exactly one current disposition and a complete history of every change to it.** This is the owner's model as revised on 2026-08-28: a Partner may override a verification, and a finding may move from `verified` back to any other state, at any time, by any authorised user. Nothing is locked by having been verified once.

```
finding_disposition                       -- exactly one row per finding. Mutable.
  review_id, findings_key, clause_id      primary key  (FK to finding)
  state            text not null          -- unchecked|verified|flagged|rejected
  reason           text                   -- NOT NULL when state='rejected' (check constraint)
  by_user_id       uuid                   -- who set the CURRENT state, not who set the first.
                                          -- NULL only while changed_count = 0 (check constraint):
                                          -- a never-touched finding has no actor, and that is a
                                          -- different fact from an unchecked one someone reset.
  at               timestamptz            -- when the CURRENT state was set; NULL on the same terms
  changed_count    int  not null default 0 -- 0 = never touched by anyone
  version          bigint not null default 1  -- optimistic concurrency (§8)

finding_disposition_event                 -- append-only. One row per change, forever.
  id               bigint generated always as identity
  review_id, findings_key, clause_id      (FK to finding)
  from_state       text not null          -- 'unchecked' on the first change; never NULL
  to_state         text not null          -- unchecked|verified|flagged|rejected
  reason           text                   -- NOT NULL when to_state='rejected'
  cause            text not null          -- 'human' | 'rerun_reset'
  by_user_id       uuid not null          -- the person; on a rerun_reset, whoever asked for the re-run
  at               timestamptz not null
  -- check: cause = 'rerun_reset' implies to_state = 'unchecked'
  -- GRANT INSERT, SELECT only. No UPDATE, no DELETE, to any app role (S11's grant).

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

**The two tables are written in one transaction, always.** A disposition change is an `UPDATE finding_disposition … RETURNING` plus an `INSERT INTO finding_disposition_event`, in the same transaction as the `event` row that pushes it to other clients. There is no path that writes one without the other, so a current state whose history does not explain it cannot exist. `finding_disposition` is a **cache of the last row of the history** — it exists because every card render needs the current state and no card render needs to fold three years of changes — and a reconciliation check that recomputes it from the history is part of §14's suite, because a derived cache that can silently disagree with its source is this project's favourite defect wearing a database hat.

**Flag and reject are dispositions now, not a separate table.** The old model needed `finding_challenge` because a verification could not be changed: a colleague who disagreed had nowhere to put the disagreement except beside the verification. Once the disposition itself can move, a rejection *is* a disposition change, and the "both facts standing" property the challenge table existed to give is now the property the history gives — better, because it covers every change rather than only disagreements, and it covers a person changing their own mind. `withdrawn_at` disappears with it: withdrawing a rejection is changing the disposition back, which is the same mechanism as everything else rather than a special case with its own rules about who may perform it.

**A stale change is refused, loudly, and never silently applied.** Every disposition change carries the `version` the client was looking at. If the row has moved on, the request is refused with `409` and the current row, and the UI says *"Priya changed this to Rejected at 14:22, after you loaded it. Your change was not applied."* — with the change offered again against the new state. This is S20's posture for free text applied to dispositions, and it is the whole of the answer to "what happens when two people change it at once": **not** last-write-wins, and **not** a silent overwrite of a judgement the changer never saw. Two people racing produce one change and one refusal; a person who then repeats the change produces a second history row, so both intentions are on the record.

**Attribution is of the current state, and the card must say when it is not the whole story.** `finding_disposition.by_user_id` is *who set the state the card is showing* — never who set the first one. A card reading "Verified by A. Trainee" for a finding a Partner reverted and re-verified would be a quiet lie of exactly the kind this project exists to prevent, and it is the most likely defect in this section. The requirements, as requirements:

- A disposition is **never** shown without its actor and its time. "Verified" alone is not a legal statement; "Verified by R. Okafor, 16:04" is. The one disposition with no actor is a never-touched `unchecked` (`changed_count = 0`), which renders as "Not checked" and names nobody — the honest reading of a NULL, and the reason the column is nullable rather than back-filled with whoever ran the review.
- Whenever `changed_count > 0`, the card shows that fact inline and makes the history reachable in one action — *"Verified by R. Okafor, 16:04 · changed twice"*, opening the full list.
- The immediately preceding state is named on the face of the card, not only inside the history, because it is the single most load-bearing fact after the current one: *"Verified by R. Okafor, 16:04 · was Rejected"*. It is not stored twice to achieve this: the finding read returns its current disposition **and its most recent `finding_disposition_event`**, and `finding.disposition_changed` carries both (§8), so `from_state` is on hand at first render and after every push without a second query and without a duplicated column.
- A disposition set by a re-run reset (`cause = 'rerun_reset'`) reads as what it is — *"Unchecked — this clause was re-run by A. Gray at 11:07"* — and never as a person having un-verified it by hand. The two are different acts and the history distinguishes them; the card must not flatten them.

**The one word a card shows still has exactly one home.** The current state is now stored rather than folded from two tables, so the folding function goes; what remains is the *wording*, and that stays where wording has always lived: `verificationLabel` and `exportSummaryLine` in `findingOutcome.ts`, moving to `packages/core`, gain `dispositionLabel(disposition)` and `dispositionHistoryLine(event)` beside them. The DOCX exporter, the CSV exporter, the card and the history panel all call these. They have drifted apart once before over exactly this kind of string.

**Notes are their own table now.** R-B3 kept them on the `Finding` and said "a notes store becomes a later migration". This is that migration. Notes survive a re-run, as they always have, because they are about the clause rather than about one run's output — and they are untouched by a disposition change for the same reason: a note is a person's remark about the clause, not a component of their judgement on one answer.

**`Verification.assigneeId` is retired** (S17). It existed for schema-readiness under R1 and reached nobody. A real assignment needs an assigner, a time and a resolution, none of which a single id can carry. **Assignment is unchanged by the 2026-08-28 revision** and remains the way to ask a colleague to look at something — a request, not a disposition. Overriding a disposition and asking someone to check one are different acts, and the app keeps them different.

### 6.3.1 The history is load-bearing, and an export is a point-in-time claim

Under the old model, "has a human checked this, and who" was answerable from a row that could never change, so an export could state it as a fact with no shelf life. **That is no longer true, and the export must not go on implying it is.** With a disposition changeable by anyone at any time, the only complete answer to *"who says this was checked, and as of when"* is the history; the current row answers only *"as of right now"*.

So, three requirements that hold together:

1. **Every export carries the instant its dispositions were read**, on the document, not in a filename: *"Dispositions as at 2026-08-28 16:41 (Europe/London)."* Without it the document silently claims to be current forever.
2. **Every export carries the same "was X" and "changed N times" facts the card carries.** A DOCX or CSV that flattens a contested finding into "Verified" is the network-era version of the CSV that wrote unreviewed clauses as blank cells: technically the current state, read by a partner as the whole state.
3. **An export states, in its own words, that a disposition can change**, and that LexPrompt's history is authoritative over any printed copy. One sentence in the export's summary block, composed by `exportSummaryLine` like every other piece of export wording.

The full history is exportable in its own right — per review, and per workspace for the audit export (§12 Q3) — because "reconstruct what this report would have said on the day it was signed" is a question a firm will eventually ask, and only the history can answer it.

**The re-run reset still applies and still reads correctly.** Re-running a clause still clears its disposition, for exactly the reason it always did: the judgement described a specific answer, and once that answer is replaced, keeping it would let an export claim a human checked text they never saw. Under a mutable disposition that argument gets *stronger*, not weaker — the reset is now the same operation any person could perform (a change to `unchecked`), so it needs no special mechanism, and it is the one write the system performs on its own behalf, which is why it is constrained to that single direction (§3) and why its history row names the person who asked for the re-run rather than "system".

### 6.4 What already carries identity and needs no change

`Matter.ownerId`, `DocumentRecord.addedByUserId`, `Collection.createdByUserId`, `Review.createdByUserId`, `PlaybookVersion.publishedByUserId`, `Changeset.createdByUserId`, `Note.byUserId`, `Verification.byUserId`, `NetPosition.byUserId`. Every one of these is already populated from the local profile. They become foreign keys to `app_user` and are otherwise untouched. **This is R1's schema-readiness paying for itself**, and it is the single largest reason this migration is a data move rather than a redesign.

`Verification.byUserId` and `Verification.at` land in `finding_disposition` **and** seed the finding's first `finding_disposition_event` row (`from_state = 'unchecked'`, `cause = 'human'`) at migration time, so a migrated finding's history is not empty. An empty history under a non-`unchecked` current state would be indistinguishable from a change that failed to record itself, which is precisely the ambiguity §6.3's one-transaction rule exists to make impossible — a migration must not be the one place it is allowed.

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
                    action text                             -- e.g. playbook.published
                    subject_type, subject_id
                    matter_id, review_id
                    detail jsonb
                    -- GRANT INSERT, SELECT only. No UPDATE, no DELETE, to any app role.
                    -- Partitioned monthly.
                    -- Does NOT restate a disposition change: finding_disposition_event
                    -- is that change's one record, under the same grant (S22).

precedent_set       id, workspace_id, name                  -- §11.1
                    created_by_user_id, created_at
                    playbook_id                             -- NULL until a playbook adopts from it
                    -- The batch brought in for one "learn from redlines" session.
                    -- Its documents are document rows with kind = 'precedent'.

position_basis      standard_position_id, precedent_set_id  -- §11.1
                    document_id, edit_locator jsonb
                    -- The durable link from an inferred house position to the
                    -- precedent text that produced it. Was in-session only.

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
| `reviewer` | Create and edit matters, documents, collections and reviews; run reviews; **set a finding's disposition to any state, including one a colleague set** (§6.3); note; assign; confirm or amend net positions; edit playbook drafts; bring in precedent documents and infer positions from them; export. |
| `partner` | Everything a reviewer can, **plus** publish a playbook version. |
| `admin` | Everything a partner can, plus: role mapping, model deployment selection, retention configuration, disabling a user, and exporting the audit log — including the disposition history export (§6.3.1). An admin is not a super-reviewer; the actions are administrative. |

**§17 Q1 is answered, and the answer is broader than the question.** The owner asked whether a Partner may override a verification and said yes. The design does not build "override" as a Partner-only power, because the mechanism the owner actually described — *"something can change from Verified, back to another state, at any time"* — is not a hierarchy feature, it is the disposition being mutable. A trainee who verifies the wrong finding at 09:00 must be able to un-verify it at 09:01 without waiting for a Partner; a rule that made overriding a partner privilege would produce exactly that wait, and the app would be manufacturing a silence again. **What makes this safe is not who may change it. It is that every change is recorded, attributed, and shown** (§6.3).

*If the firm later wants overrides restricted to Partners*, that is a role check on one route plus a UI gate — not a data-model change, because the history already records who did what. Recorded here so a later narrowing is understood as cheap rather than as a reversal of the design.

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

**A disposition change is the event type this matters most for**, because it is the only one where a dropped or out-of-order event leaves a *human judgement* on screen that the database does not hold. `finding.disposition_changed` carries the whole new `finding_disposition` row plus the `finding_disposition_event` that produced it, so a client applies one push and has both the current state and the fact that it changed — it never has to re-derive "was Rejected" from an event it may not have received. The client's local `version` is also what it sends back on its own next change, which is how the `409` in §6.3 happens at all: **the stale-change refusal and the realtime version guard are the same number doing two jobs, and they must not be allowed to become two numbers.**

Combined with the four load states of §3, this produces the rule a reviewer's safety actually rests on: **a disconnected client must not offer to change a disposition.** It is showing a state it cannot vouch for, and a change submitted against a version that may be minutes old would be refused anyway. The stale indicator disables the disposition controls and says why — one more place where "empty is not broken" becomes "stale is not current".

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

With findings as rows (§6.2), the engine writes only the model-authored columns of the one cell it just ran, and a human write goes to `finding_disposition` / `finding_disposition_event` or `note` — tables the run worker's role cannot write to at all. There is no snapshot, so there is nothing to merge, so nothing can clobber a human write. **`carryHumanState` and `findingMerge.ts` are deleted, not ported.** One writer replaces N racing browsers, and this is the single largest simplification in the design.

**What does not retire is the re-run reset.** Re-running a clause still resets its disposition and its net position, for the reason it always did: the judgement described a specific answer, and once that answer is replaced, keeping it would let an export claim a human checked text they never saw. A mutable disposition does not weaken that by one word — if anything it sharpens it, because the reset is now expressible as an ordinary disposition change rather than a deletion, so the fact that the clause *was* verified before the re-run survives in the history instead of vanishing with the row.

Server-side it is one transaction, run **in the retry request handler** — a person asked for this — and not by the worker, which has no grant on either disposition table:

```sql
BEGIN;
  UPDATE finding SET status = 'pending', … , version = version + 1
    WHERE (review_id, findings_key, clause_id) = …;

  -- The disposition moves to 'unchecked'. It is never deleted: deleting the row
  -- would lose who last held it, and the history's from_state would have nothing
  -- to be read against.
  INSERT INTO finding_disposition_event
         (…, from_state, to_state, reason, cause, by_user_id, at)
  SELECT  …, state,      'unchecked', NULL, 'rerun_reset', :actor, now()
    FROM finding_disposition WHERE (review_id, findings_key, clause_id) = …;

  UPDATE finding_disposition
     SET state = 'unchecked', reason = NULL, by_user_id = :actor, at = now(),
         changed_count = changed_count + 1, version = version + 1
   WHERE (review_id, findings_key, clause_id) = …;

  -- the net position is cleared by the same transaction, for the same reason
  -- notes are NOT touched: a note is about the clause, not about one run's output
  INSERT INTO event …;
COMMIT;
```

Note what the history row makes visible that the old `DELETE` did not: **the export of a re-reviewed clause can now say "unchecked — re-run by A. Gray at 11:07, previously verified by R. Okafor"**, which is a materially more useful sentence than "unchecked" and is the first thing a partner reading a re-run report wants to know.

A partial reset is now impossible rather than merely tested against. It stays mutation-tested regardless (§14), because it is the load-bearing claim in every export the app produces — and the mutation test gains a case: breaking the `cause = 'rerun_reset'` history insert while leaving the `UPDATE` must fail, because a reset that clears a verification without recording that it did is the same lie as a reset that does not happen.

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

### 11.1 Precedent documents are stored server-side

**§17 Q9 is answered: precedent documents may be stored server-side, and they are.** They become ordinary documents — a blob, a row, a `parse_state`, the same ingest path as everything else — rather than the session-only special case sub-project F built.

**What this makes better, and it is more than convenience.** Three things, in ascending order of how much they matter:

- **Inference can be re-run without re-uploading.** Today, changing the prompt, the model or the clause set means the lawyer goes and finds eight `.docx` files again. That is a per-iteration cost on the feature whose whole value is iteration.
- **The workings can be revisited.** "Learn from redlines" shows the actual redline text behind each proposed position — deletions struck through, insertions underlined, the margin comment and its author. Today that evidence dies with the tab, so a position adopted on Tuesday cannot be re-examined on Wednesday.
- **A position's basis stays inspectable after the session ends.** This is the one that changes the feature's claim rather than its ergonomics. "Learning from redlines" asserts that an inferred house position is *evidenced* — that a lawyer can check what it was built from. Session-only storage made that assertion true for about ninety seconds. `position_basis` (§6.5) makes it durable: a position adopted six months ago still resolves to the documents and the specific edits that produced it, and a partner asking *"where did this house rule come from?"* gets the four leases and the four strikes rather than a shrug. `Changeset.basis` already took a durable copy of the edits for exactly this reason (`types.ts` says so, and says it takes the copy *because* the source documents are gone); with the sources kept, the copy becomes a corroboration rather than the only surviving witness.

**Precedent documents are distinguished from matter documents, in storage and in the UI. This is a ruling (S23), not a detail.** A precedent is somebody else's deal, brought in to learn from, usually with an opposing party's markup still in it. If it appeared in a matter's document list it could be opened as though it were the deal under review, added to a collection, run through a playbook, or cited in an export — and a citation pointing into the wrong client's lease is the kind of error this app exists to make impossible. So:

- **In storage:** `document.kind` is `matter` or `precedent`, `NOT NULL`, with a check that a `precedent` row has a `precedent_set_id` and a `NULL` `matter_id`, and a `matter` row the reverse. Not a nullable `matter_id` alone, and not a naming convention: this is a distinction that must survive somebody writing a new query.
- **In queries:** every review-target, collection-member and matter-document query filters `kind = 'matter'`. §14 gets a test that a precedent document cannot be added to a collection or named as a review target, refused by the API rather than merely absent from a picker.
- **In the UI:** precedent sets live in the playbook side of the app, where they were brought in, and never in a matter's documents. A precedent document opened in the viewer is labelled as precedent on the document itself, not only in the list it was reached from.

**Retention now applies to them, and they do not fit the matter-file schedule.** A precedent belongs to no matter, so "document retention follows the firm's matter-file policy" (§17 Q3) does not reach it. Two facts make this a real question rather than a formality: a precedent set is likely to contain *another client's* executed documents, and a house position adopted from it may be relied on for years after the set that produced it would otherwise have been disposed of. **§17 Q3 is extended to ask it explicitly**, with the trade named: delete the set and a position's basis becomes unresolvable (and must then say so on screen rather than showing an empty evidence panel — "empty is not broken", again); keep the set and the firm holds another client's documents for as long as the playbook lives. The design does not decide this; it refuses to let it be decided by default.

**The copy change ships in the same stage as the storage. Never after.**

`src/features/redlines/PrecedentIntake.tsx` renders, today, at the top of the intake screen:

> **"Read once to learn from. Never stored."**

That sentence is **true today** and becomes **false the moment the first precedent byte reaches Blob Storage**. The component's own comment explains that it was deliberately strengthened from a narrower phrasing because "understating a privacy promise is the one direction it must never drift" — which is the argument for changing it now, not against. Shipping the storage while that sentence is still on the screen would be precisely the failure this project is organised against: something incorrect presented as if it were correct, to a lawyer, at the moment they are deciding whether to hand over a document.

The requirement, stated as an acceptance condition rather than a note:

1. **The same stage, and the same change.** The migration that adds `document.kind = 'precedent'` and the copy change land together. There is no release in which the storage exists and the sentence does.
2. **The replacement lives in `src/lib/privacyCopy.ts`**, not inline. That module is the extracted single home for disclosure wording (R-G5), and a storage promise written anywhere else is the exact drift it exists to prevent.
3. **It is still said once, in the strong form.** `PrecedentIntake.tsx` and `PrecedentUploadPanel.tsx` are siblings on that route, and the panel's comment records that two wordings of one promise was a real defect that had to be fixed. The new sentence goes in the same place the old one did — `PrecedentIntake`'s header — and the panel keeps saying only what is read. `PrecedentUploadPanel.tsx`'s existing sentence, *"Marked-up .docx files are read for tracked changes; anything else, including PDFs, can be compared against another version instead,"* stays true and stays where it is.
4. **The tests that assert the promise are rewritten in the same change, not deleted.** `src/App.redlines.test.tsx` asserts `occurrences('Never stored') === 1` and has a whole describe block titled *"a precedent document is read and never stored (spec §4, §11)"*. Those become assertions about the new promise. A promise test that is deleted rather than replaced is how the next person learns there was never a promise.
5. **The comments carrying the old promise are corrected too** — `App.tsx`'s "read once, never stored" note on `redlinesDocs`, `PrecedentUploadPanel.tsx`'s docstring, `types.ts`'s remark that a changeset's basis exists because the source documents "are read, never stored". A stale comment is how a true statement gets restored by a well-meaning refactor.
6. **The README's §Learning from redlines bullet** — *"stores none of them: not in IndexedDB, not in `localStorage`, not in the URL"* — is in §2's table and is replaced with it.

**Sub-project F's spec is superseded on this point, and not edited.** `docs/superpowers/specs/2026-08-27-redesign-f-learning-from-redlines.md` §4.1 and its §11 state the non-storage promise as a design commitment. It was correct when written; it is superseded here, as of 2026-08-28, and the F spec is left standing so a reader can see the position changed rather than finding it quietly rewritten — the same posture `rulings.md` takes.

**What does not change.** Storing a precedent does not put it in a playbook: *"only the standard positions you go on to adopt survive, inside the playbook you eventually save"* stays exactly as true as it was. A playbook is house rules, not a document archive, and F's reasoning for that separation is untouched. Tracked changes are still read from the OOXML directly and never through `mammoth` — the defect that rule prevents (reading a counterparty's redline back as though every change were accepted) is unaffected by where the file lives.

---

## 12. The Risk-review story

Written as answers, because these are the questions actually asked.

**1. Where does client data live?**
In the firm's own Azure subscription, UK South. Document metadata, extracted text, findings, playbooks and the audit log in Azure Database for PostgreSQL Flexible Server (encrypted at rest, private endpoint, no public network access). Original document bytes in Azure Blob Storage (private container, no anonymous access, service-side encryption, private endpoint). Nothing persists in the browser except a rendered view and a short-lived Entra token; browser-local persistence is retired and the old IndexedDB database is removed after §13's migration.

**This now includes precedent documents** (§11.1) — the "Learn from redlines" inputs, which were previously read in the browser and stored nowhere. A Risk reviewer should be told this explicitly rather than left to infer it from "documents", because a precedent set is the one place in this app where **another client's** executed documents are likely to be held, brought in as house-rule evidence rather than as work on the matter they belong to. They are stored in the same database and container as everything else, distinguished by `document.kind` and separated in the UI, and they are the reason §17 Q3 now asks a retention question the matter-file schedule does not answer.

**2. Who can access it?**
Named members of the firm's Entra tenant who are in one of three mapped security groups. There is no password login, no shared key, no API key, no anonymous link, and no external sharing. Access is removed by Entra group removal or account disable: HTTP access ends at the next token refresh (≤ 60 minutes) and WebSocket connections for a disabled user are closed immediately by the server. Infrastructure access (DBA, blob) is Azure RBAC with PIM approval and is recorded in Azure activity logs, outside the application's control.

**3. What is logged?**
Two logs, deliberately separate. **`audit_event`** records who did what to which record: every assignment, every publish, every export, every document added or deleted, every role change, every run started or cancelled, every net position confirmed or amended. It is append-only by database grant, not by convention (S11) — the application role holds `INSERT` and `SELECT` and nothing else. **The gateway call log** records metadata for every model call and no content (§10). Application logs never contain document text; a redaction test enforces it (§14).

**`finding_disposition_event` is the third — and it is a log, not a convenience.** Every change to a finding's disposition, in either direction, with the state it came from, the state it went to, the reason where one exists, whether it was a human act or a re-run reset, who, and when. It is held to the same insert-only grant as `audit_event`, and it is what makes "who says this was checked, and as of when" answerable at all now that a disposition can change (§6.3.1).

**It is deliberately *not* also written into `audit_event`, and that is a ruling (S22).** Two append-only records of the same fact is this project's most repeated defect — two implementations of one idea, drifting — in the worst possible location: the divergence would be between the history a lawyer reads on the card and the history the firm exports for an audit, and the audit export is precisely the artefact nobody re-reads until it matters. So a disposition change is recorded once, in the table the card reads, and the audit export and activity feed read that table alongside `audit_event` rather than a copy of it. `audit_event` carries every other kind of act; the join is a `UNION` in one query, which is a smaller thing to get right than two writers staying in agreement forever.

**4. What is retained, and for how long?**
Documents, reviews and findings until the firm deletes them; deleting a matter cascades to its documents' rows and their blobs. Audit log: 7 years by default — **§17 Q3, the firm's retention schedule decides.** A finding's disposition history is retained **for as long as the finding**, not on the audit log's clock: it is what the finding's current state means, and a finding outliving the record of how it got there would leave "Verified by R. Okafor" standing with nothing behind it. Gateway call log: 90 days. Realtime event outbox: 7 days (a reconnection buffer, not an archive). Postgres point-in-time backups: 35 days. **Foundry abuse monitoring: up to 30 days unless the exemption in §10.1 is granted — §17 Q4.**

**Precedent documents** (§11.1) are retained until the firm deletes their precedent set. They belong to no matter, so the matter-file schedule does not reach them, and a house position adopted from a set may be relied on long after the set itself would have been disposed of — **§17 Q3 asks this explicitly.** Deleting a set deletes its documents' rows and blobs by the same cascade a matter uses; positions that cited it then say their basis is no longer held, rather than showing an empty evidence panel.

**5. Who are the subprocessors?**
Microsoft only: Azure Container Apps, Azure Database for PostgreSQL, Azure Blob Storage, Azure AI Foundry, Microsoft Entra ID, Azure Monitor. **OpenRouter is removed**, and with it every model provider it fronted — which is the single largest change to this answer and the reason Stage 1 is sequenced first. Inference is region-pinned: only UK/EU Foundry deployments are on the allowlist, and the gateway refuses anything else. Where a desired model has no UK/EU deployment, it is not allowlisted and the app cannot use it — a capability limit accepted deliberately in exchange for the answer to this question.

**6. What happens on breach?**
The gateway holds nothing at rest; compromising it exposes calls in flight, not the archive, and it holds no credential that reaches Postgres or Blob. Postgres and Blob have no public endpoint. Response: disable the Entra app registration (all sessions end at next refresh; WebSockets are closed), rotate managed-identity role assignments, and read `audit_event` **and `finding_disposition_event`** for the actor's complete trail. **Both being append-only with no `UPDATE`/`DELETE` grant is what makes that trail evidence rather than a claim** — and the disposition history is the half that answers the question a compromised account raises here: *did anyone touch the professional judgements?* Under the superseded model an attacker could only add a verification; under a mutable disposition they could change one, and the history is why that is detectable rather than merely feared.

**7. What happens on offboarding?**
Disabling the Entra account ends access. The person's authored records remain, attributed: a verification is a professional judgement someone made, and a report that silently loses its reviewer is a report that lies. `app_user.status = 'disabled'` renders as "A. Gray (no longer active)". **Deleting a user is not offered**, because it would either orphan or falsify the verification chain. That has a GDPR-erasure consequence and it is **§17 Q6** for the firm's DPO — not a decision this design makes on its own.

**The 2026-08-28 revision widens this, and the widening is not cosmetic.** Under the superseded model a leaver's name appeared on the verifications they still held — a bounded, shrinking set, since a re-run deleted the row. Under a mutable disposition, a leaver's name appears on **every change they ever made**, in `finding_disposition_event`, including ones a colleague has since superseded and ones a re-run reset away. Those rows are permanent by grant (S11): they cannot be updated or deleted by any application role, which is the property that makes them evidence. So the question the DPO is being asked is larger than it was, and §17 Q6 is restated to ask it accurately rather than leaving the DPO to discover the difference. A pseudonymisation path, if one is required, has to act on `app_user` — replacing a display name with a stable pseudonym while the `by_user_id` foreign keys stay intact — because rewriting the history rows is the one remedy this design cannot offer without destroying what the history is for.

---

## 13. Migration and sequencing

Staged so the app keeps working at every point, and ordered so the Risk posture improves before any multi-user surface exists.

**This document is one design, but it is not one implementation plan.** Each stage below is its own spec-to-plan-to-implementation cycle, exactly as sub-projects A through G each were; §20 sizes them. Nothing here should be planned as a single unit of work, and a stage that turns out larger than its estimate is decomposed further rather than compressed.

**Stage 0 — `packages/core`.** Convert to an npm-workspaces monorepo and move the domain logic (§5) with no behaviour change. Every test that moves with it must still pass unchanged; that is the acceptance criterion. An import-boundary test forbids `apps/*` from reimplementing anything `packages/core` exports (S14) — this project's most repeated defect is two copies of one idea drifting, and a client/server split is that hazard at scale.

**Stage 1 — the gateway, while the app is still browser-only.** `openrouter.ts` becomes a `ModelClient` interface with one implementation pointing at the gateway through a minimal `api` whose only route is the inference proxy. The browser signs in with Entra. Everything else still lives in IndexedDB.

**This stage is shippable and valuable on its own, and it is the whole reason for the ordering:** it deletes the per-user OpenRouter key, removes OpenRouter and its providers as subprocessors, and moves inference into the firm's UK/EU tenant — the three things that most improve the Risk answer — *before* a single multi-user feature exists to argue about.

**Stage 2 — storage and auth.** Postgres and Blob behind the nine repositories' existing interfaces. **R3's seam holds a second time**: those repositories are already Promise-returning, precisely so a storage swap would not touch callers. Entra sign-in becomes the real gate; roles are mapped; `app_user` replaces the local profile. Behaviour stays single-user. Browser-local mode is retired at the end of this stage, and §13.1's uploader ships with it.

**Precedent storage (§11.1) lands here**, because it is document storage and nothing more — `document.kind`, `precedent_set`, `position_basis`, and the ingest path they already share. **The copy change lands in the same stage, in the same change**: `PrecedentIntake.tsx`'s "Read once to learn from. Never stored." cannot survive into a release where the storage exists. If Stage 2 is decomposed further (§13 says a stage larger than its estimate is split rather than compressed), that split must not put the storage in one piece and the sentence in the next.

**Stage 3 — the server-side engine.** Runs become jobs; the browser stops orchestrating; `carryHumanState` and `findingMerge.ts` are deleted; cancel and resume become real. Findings become rows, which is the largest single data migration in the plan and is done here rather than in Stage 2 because the engine is what forces it.

**`finding_disposition` and `finding_disposition_event` land here too, with the findings they belong to** — the re-run reset (§9.1) is a Stage 3 transaction and needs both tables to exist. Behaviour stays single-user: a person changes their own dispositions and the history records it. What Stage 3 does **not** ship is the collaborative half — one user changing another's disposition, the stale-version refusal, the realtime push, the history and attribution surfaces, and the export's point-in-time framing — all of which are Stage 4. The ordering constraint from S4 is satisfied a fortiori by this: **the history exists a stage before mutability-by-others does, and never the other way round.**

**Stage 4 — realtime and collaboration.** WebSocket, presence, live findings, **one person changing another's disposition** with the stale-version refusal, assignment, and the activity feed read from `audit_event` and `finding_disposition_event`.

**The attribution and export surfaces ship with the mutability, in the same stage — they are one feature.** Stage 3 has already built the history; what Stage 4 must not do is turn on change-by-others while the card still shows a bare "Verified" and the export still reads like a permanent claim. That is not a lesser version of this design, it is the quiet lie the design exists to prevent, with the evidence written to a table nobody is shown. The card's attribution, the "was Rejected" line, the reachable history and the export's "as at" stamp (§6.3.1) are not polish on top of the mechanism — they are what makes the mechanism honest, and a plan that sequences them after it has sequenced them wrong.

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

- a disposition change against a stale `version` is refused with `409` and the current row, and does **not** apply — under two genuinely concurrent changes, one applies and one is refused;
- `finding_disposition_event` cannot be updated or deleted by any app role, by anyone, ever;
- every disposition change writes exactly one history row, and `finding_disposition` recomputed from the history always equals the stored row (the cache-versus-source reconciliation of §6.3);
- the run worker's role cannot write `finding_disposition` or `finding_disposition_event` at all — asserted by attempting it and getting a permission error, not by grepping for call sites;
- `cause = 'rerun_reset'` can only ever produce `to_state = 'unchecked'`, refused by check constraint (§3's direction rule);
- a `kind = 'precedent'` document cannot be added to a collection or named as a review target, refused by the API;
- a published `playbook_version` cannot be updated by the app role;
- `audit_event` cannot be updated or deleted by the app role;
- the re-run reset is atomic — a failure mid-transaction leaves neither a new finding, nor a cleared disposition, nor a history row without the change it describes.

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
| `disposition` | a card never shows a disposition without its actor and time; a changed disposition shows that it changed and names the state it came from; a re-run reset renders as a re-run and not as a person un-verifying; a stale client's disposition controls are disabled and say why; an export carries its "as at" instant and its changed-from facts |
| `precedentCopy` | the intake screen states the storage promise **once**, in its current true form, and the string asserted by the test is the one in `privacyCopy.ts` — so a future change to the promise breaks a test rather than silently disagreeing with the disclosure module |

**Mutation-test, without exception:** the re-run reset (now transactional, including its history row), the stale-change refusal, the disposition history's insert-only grant, the `resync_required` path, the audit log's insert-only grant, and the egress restriction. Break each, confirm a test fails, restore. A green suite is not evidence.

**Two of those deserve naming as the specific mutations to try**, because both have an obvious wrong implementation that passes a careless test: (a) delete the `INSERT INTO finding_disposition_event` from the re-run reset and leave the `UPDATE` — a disposition that clears without recording that it cleared; (b) make the stale-change path apply the write and *then* return the current row — a UI that looks correct and a database where the later click silently won. Neither is caught by asserting the happy path.

**Browser verification is still mandatory and now needs two accounts.** The claims this design adds — presence, live updates, a Partner overriding a trainee's verification and the card immediately reading the Partner's name, the loser of a race being told rather than silently overwritten, assignment reaching a person — cannot be verified by one person on one machine, and unit tests will not catch what breaks. The override case in particular is a two-account, two-browser check: **verify as one user, override as the other, and confirm the first user's card changes attribution without a reload.** `CLAUDE.md`'s rule applies: if it cannot be done, say so plainly rather than implying it was.

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
- **S4 (rewritten 2026-08-28, on the owner's decision). A finding carries one current disposition (`unchecked` / `verified` / `flagged` / `rejected`) and a complete append-only history of every change to it. Any authorised user may change it in any direction at any time; nothing is locked by having been verified once; a change against a stale version is refused rather than applied.** *Cost if wrong: a colleague can move a judgement you made, and the only thing standing between that and a quiet overwrite is the history being written, shown on the card and carried into the export. If the history is skipped, weakened, or shipped a stage later than the mutability, the app tells a lawyer "verified" with no way to find out by whom, when, or over what — which is worse than the model this replaced, not better. The three of them are one feature.*
  - *Superseded, 2026-08-28: the original S4 read "a finding carries at most one verification (insert-once, first wins) plus append-only challenges", with the cost "a person who verified in error cannot un-verify without a partner override (§17 Q1)". The owner has decided that a Partner may override and that a disposition may change from verified back to any other state at any time, so insert-once is no longer the shape. `finding_challenge` folds into the disposition; `withdrawn_at` disappears. Recorded rather than deleted, so a reader of an earlier draft can see the position changed.*
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
- **S19 (amended 2026-08-28). Document parsing moves server-side; the browser keeps `pdfjs` only for the viewer and `findQuoteRects`. Ingest is asynchronous with a real `parse_state`. Precedent documents go through that same ingest and are stored, not held in memory.** *Cost if wrong: if Spike 1 fails, ingest OCR replaces server-side rendering — a subprocessor added and a better citation story gained. Parsing in the browser instead would make a queued run depend on a browser having the document open, which is not a queue.*
  - *Superseded, 2026-08-28: S19 as originally written left precedent documents to §17 Q9, and §11 offered "parsed in memory and never written to Postgres or Blob, asserted by a test (no row, no blob, for a `purpose: 'redlines'` upload)" as the likely shape. The owner has decided they may be stored server-side, so that test is inverted, not written: there **is** a row and there **is** a blob, and what the tests assert instead is that a precedent is distinguishable from a matter document and cannot be reviewed as one (S23). Recorded rather than deleted.*
- **S20. Free-text conflicts are last-write-wins with the loser told and shown what replaced their text; no OT, no CRDT.** *Cost if wrong: a rare simultaneous edit costs one person a retype, having been told; a merge engine is a subsystem defending against something the owner expects to be rare.*
- **S21 (2026-08-28). The re-run reset is the only non-human write to a disposition, it runs in the retry request handler rather than the worker, it is attributed to the person who asked for the re-run, and a check constraint holds it to `to_state = 'unchecked'`.** *Cost if wrong: one constraint and one handler placement. Without the direction constraint, "nothing derives a verification" stops being a structural fact and becomes a code-review habit, on the one code path that writes a disposition without a person deciding to — which is exactly where it would eventually fail.*
- **S22 (2026-08-28). A disposition change is recorded once, in `finding_disposition_event`, and is not also written to `audit_event`. The activity feed and the audit export read both tables.** *Cost if wrong: one `UNION` in the feed and export queries, and an auditor who must be told there are two tables rather than one. The alternative is two append-only records of the same fact, which is this project's most repeated defect placed exactly where a divergence would be least likely to be noticed and most damaging — between what a lawyer reads on the card and what the firm exports as evidence.*
- **S23 (2026-08-28). Precedent documents are stored, and are distinguished from matter documents in storage (`document.kind`, enforced by check constraint), in every query, and in the UI. A precedent can never be a review target or a collection member.** *Cost if wrong: one `NOT NULL` column, one predicate on the matter-document queries, and a separate place in the UI for precedent sets. Without it, another client's marked-up lease can be opened, reviewed and cited as though it were the deal in hand — a citation with apparent authority pointing at the wrong client's document, which is the failure mode `derivePage` exists to prevent, one level up.*
- **S24 (2026-08-28). The on-screen non-storage promise changes in the same stage and the same change as the storage, its replacement lives in `privacyCopy.ts`, and the tests that assert the old promise are rewritten rather than deleted.** *Cost if wrong: none if followed — it is one sentence and one test file. If not followed, the app shows a lawyer "Never stored" on the screen where they choose which of their client's documents to upload, while storing them. That is not a copy defect; it is the founding defect of this project in its purest form, and it would be shipped deliberately.*

---

## 17. Open questions for the owner

Not rhetorical. Each changes something in this document. **Two are now answered** — Q1 and Q9, decided by the owner on 2026-08-28. They are kept in place with their answers rather than deleted, so a reader can see what was asked, what was decided, and when.

1. **~~May a Partner override a trainee's verification, or only flag it?~~ ANSWERED 2026-08-28: yes, and more than that.** The owner: *"Partner may override a verification (and something can change from Verified, back to another state, at any time)."*
   *The recommendation in this document was flag-only*, on the reasoning that an override erases a professional judgement and leaves no trace of the disagreement. **The owner's answer removes the premise rather than overruling the reasoning**: an override erases nothing, because §6.3's append-only history keeps every superseded disposition with its actor, its time and the state it came from. The concern was right; the fix was a history, not a prohibition.
   The design goes one step past the question, deliberately and on the record: the power is **not** Partner-only, because the mechanism the owner described is mutability rather than hierarchy, and restricting it would make a trainee wait for a Partner to undo their own mistake (§7). Narrowing it later is a role check on one route.
   **Changed §2, §3, §4, §6.3, §6.3.1, §6.4, §7, §8, §9.1, §12 Q3, §12 Q4, §12 Q6, §12 Q7, §13 (Stages 3 and 4), §14, §16 (S4 rewritten, S21–S22 added), §17 Q6, §18, §19 and §20.**
2. **Does assignment notify by email or Teams, or in-app only?** In-app is the floor and is built. Each external channel adds a subprocessor and a line to §12. **Affects §4, §12.**
3. **Retention.** How long is the audit log kept (7 years is a default standing in for the firm's own schedule, not a decision this design makes)? Is a matter ever hard-deleted, or only closed? Does document retention follow the firm's matter-file policy? **And, new on 2026-08-28: how long are precedent documents kept?** They belong to no matter, so the matter-file schedule does not reach them; a set is likely to contain another client's executed documents; and a house position adopted from a set may be relied on for years after the set would otherwise have been disposed of. The trade, stated so it is not decided by default: delete the set and a position's basis becomes unresolvable (and must say so, rather than showing an empty evidence panel); keep it and the firm holds another client's documents for as long as the playbook lives. **Affects §11.1 and §12 Q4.**
4. **Foundry abuse monitoring (§10.1).** Apply for the modified-abuse-monitoring exemption before go-live, or accept and disclose up-to-30-day retention with possible human review? **Affects §12 Q4 and the disclosure the app itself shows.**
5. **The data currently in the owner's browser** — migrate it with §13.1's uploader, or start clean?
6. **GDPR erasure versus the disposition history — sharpened by Q1's answer, and the DPO should be asked the sharpened version.** It is no longer only "a leaver's name stays on the verifications they still hold". Under a mutable disposition, a leaver's name stays on **every disposition change they ever made** — the ones that still stand, the ones a colleague has since superseded, and the ones a re-run reset away — in `finding_disposition_event`, which no application role can update or delete, because that permanence is what makes it evidence rather than a claim (§12 Q7). The set is therefore larger than before, permanent rather than shrinking, and includes judgements the person themselves later changed their mind about.
   Does the firm's DPO accept that as a business record? If not, the only remedy this design can offer is pseudonymisation at `app_user` — a stable pseudonym replacing the display name while every `by_user_id` foreign key stays intact — because rewriting the history rows destroys the thing they exist to be. **Affects §6.3, §6.5 and §12 Q7.**
7. **One region or two.** UK South alone, or a paired region for disaster recovery? What RPO and RTO does the firm need? **Affects §5's infrastructure and §12 Q1.**
8. **A content-logging debug mode.** Should one exist at all — admin-enabled, time-boxed, itself audit-logged — or is "the gateway never logs content, full stop" the simpler thing to defend? *My recommendation is the latter*, because a mode that can be enabled is a mode a Risk reviewer must be told about.
9. **~~"Learn from redlines" (§11). Do precedent documents pass through the server to be parsed — read in memory, never written — or keep a browser-only parse path so the current README sentence stays literally true?~~ ANSWERED 2026-08-28: neither. They are stored.** The owner: *"Precedent documents can be stored server-side."*
   The question offered two ways to keep the non-storage promise; the answer declines both and changes the promise instead. That is the more useful outcome — inference re-runs without re-uploading, the workings survive the session, and a position's basis stays inspectable, which is the feature's central claim and was previously true for about as long as the tab stayed open (§11.1).
   **The cost is a sentence on a screen, and it is not optional**: `PrecedentIntake.tsx`'s "Read once to learn from. Never stored." is true today and false the moment this ships, so S24 requires it to change in the same stage and the same change.
   **Changed §2 (five rows), §4, §6.1, §6.5, §11.1 (new), §12 Q1, §12 Q4, §13 Stage 2, §14, §16 (S19 amended, S23–S24 added), §17 Q3, §18, §19 and §20.**
10. **Whether the assistant / chat feature is in scope for the server release.** It streams and it sends document text, so it is a second egress path through the gateway with its own purpose tag and rate limit. *My recommendation is to keep it* (R4's reasoning holds: it works, it declines honestly, and dropping a working feature by omission is the wrong reading of silence) — but it is work, and the owner may prefer it deferred to a later stage.

---

## 18. Definition of done

Per stage, since this ships in five.

1. `tsc --noEmit` clean across all four workspaces; every suite passes; every app builds clean.
2. **Stage 1:** no OpenRouter key exists anywhere in the codebase or in any browser; every model call goes through the gateway; the gateway holds no key and authenticates by managed identity; the call log contains no prompt content, asserted by a test.
3. **Stage 2:** a user signs in with Entra and sees only what their role permits, refused by the API and not merely hidden by the UI; every record type round-trips through Postgres; document bytes round-trip through Blob Storage; deleting a matter purges its blobs; the browser uploader moves the owner's data and names anything it could not. **And: a precedent document is stored, is not offerable as a review target or a collection member, and no screen in the app says it is not stored** — searched for, not assumed, across `src/`, the README and the test suite.
4. **Stage 3:** a run survives a worker restart mid-run and completes; cancelling leaves no cell in `pending`; re-running a clause clears its disposition and its net position in one transaction **and records the clearing in `finding_disposition_event`, attributed to whoever asked for the re-run**; the run worker's role provably cannot write either disposition table; `carryHumanState` is deleted and nothing regressed.
5. **Stage 4:** two people in one review see each other's presence and each other's writes without reloading; **a Partner overrides a trainee's verification and the trainee's open card immediately reads the Partner's name and time, without a reload**; a change submitted against a stale version is refused, shown what replaced it, and offered again; every disposition on screen carries its actor and time, and a changed one says so; an export carries its "as at" instant; a disconnected client shows itself as stale, disables its disposition controls and resynchronises visibly; an assignment reaches the assignee.
6. **Stage 5:** every affordance R-G1 dropped is back only where its mechanism is real.
7. `api` provably cannot reach a model endpoint directly, asserted by a test (Spike 2).
8. §12 is answerable end to end by someone who did not write it, and the README's untrue sentences (§2) are all replaced.
9. Verified in a browser, on a deployed environment, with two real accounts.

---

## 19. Risks

**The Risk review is a gate held by people, not by tests, and it can be failed on a true answer.** §10.1's 30-day abuse-monitoring retention is the likeliest place. Everything else in §12 is a good answer; that one is honest rather than good, and it should be raised early rather than discovered at sign-off.

**The audit log is only evidence if nothing can rewrite it.** S11 makes that a grant rather than a habit, but a future migration run as a superuser could still alter it. The mutation test for the insert-only grant is the guard, and it must run in CI against the real database rather than being asserted once at deploy.

**The realtime stale state is the defect this design is most likely to ship *in the app*.** Everything else fails loudly by construction; a client showing yesterday's findings because its socket dropped looks completely normal. It is the reason §3 adds a fourth load state and §14 gives it a suite of its own, and it is still the thing to check first in browser verification. (The 2026-08-28 revision adds one that is worse in consequence though not in likelihood — the export, below — because a stale card has a reader who can refresh it and an exported DOCX does not.)

**Server-side page rendering is unproven** (Spike 1). The whole scanned-document path depends on it, and the scanned-document path is this project's founding defect. The OCR fallback is real but is a Risk-story change, not a drop-in.

**A client/server split doubles the surface for sibling drift**, which is this project's most repeated failure by a wide margin — six findings from two implementations of one idea. `packages/core` plus the import-boundary test is the structural defence, and it has to be enforced from Stage 0 rather than retrofitted, because the first duplicated helper will be written the week the split lands.

**Retiring browser-local mode removes the app's fallback.** Today a network failure means one broken feature; afterwards it means an unusable app. That is the correct trade for a firm tool with one persistence story, but it raises the cost of every availability decision in §5, and it is worth saying out loud to the owner rather than discovering during the first Azure incident.

**A mutable disposition makes the export a snapshot of something that moves, and the export is the artefact that leaves the building.** A card is read next to its history; a DOCX is read on a train, six weeks later, by a partner who was not in the review. Under the superseded insert-once model an export was a claim about a row that could not change, so "Verified by Priya" aged well. It no longer does, and the failure is completely silent: the document looks exactly the same whether or not the disposition it reports still holds. §6.3.1's three requirements — the "as at" instant, the changed-from facts, the sentence saying a disposition can change — are the whole of the defence, and every one of them is the kind of thing that gets trimmed for looking like boilerplate. **This is the worst-consequence defect the revision introduces**: less likely to be shipped than the realtime stale state above, but unrecoverable when it is, because the reader of a printed report has no refresh button and no reason to suspect there is anything to refresh.

**The disposition history is a cache away from being wrong.** `finding_disposition` is derived from `finding_disposition_event` and stored anyway, for render cost. This project has been bitten by a derived value that could disagree with its source more than once; the difference here is that the disagreement would be between what a card says a person judged and what actually happened. The one-transaction rule and §14's reconciliation test are the guard, and the reconciliation must run over real data in CI rather than being asserted once by construction.

**Storing precedent documents puts another client's papers in the matter database for the first time.** Not a legal problem in itself — a firm holds its own executed documents — but it is a new *category* of content in a store whose access model, retention schedule and deletion cascade were all designed around matter files. S23's separation is the structural answer and §17 Q3 is the policy one; the thing to watch in implementation is a query that forgets the `kind` predicate, because such a query fails by showing too much rather than too little, and nothing on screen would look wrong.

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

**The 2026-08-28 revision does not move these numbers much, and it is worth saying why rather than leaving it inferred.** Stage 2 gains precedent storage, which is a `kind` column, two small tables and a copy change on a flow whose ingest path already exists — inside the noise of a 2.5–3 estimate. Stage 4 gains the disposition history, which *replaces* the insert-once verification and the challenge table rather than adding to them: one mutable row plus one append-only log is not more work than one immutable row plus one append-only log with withdrawal semantics. What genuinely grows is the **UI and export surface** — attribution on every disposition, "was X", a history panel, the stale-change refusal dialogue, and the export's point-in-time framing — which is real work at the top of Stage 4's ~1.5–2 rather than a new stage. If anything in the revision is under-estimated it is that, and it is the half that must not be trimmed (§19).

The mitigating fact is real and worth stating: **111 of 133 test files and almost all of `src/lib` move to `packages/core` unchanged.** The domain logic this app is actually made of — citation matching, scan detection, position strength, net positions, the extractors — does not change at all. What changes is everything around it.
