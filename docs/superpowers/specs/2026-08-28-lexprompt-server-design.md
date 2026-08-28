# LexPrompt Server — from a browser-only tool to a firm-deployed, collaborative one

**Date:** 2026-08-28
**Revised:** 2026-08-28, three times — for three owner decisions, then for a fourth, then for a fifth that corrects a framing error running through §10 and §12. See "Revision", "Revision 2" and "Revision 3" below.
**Status:** Spec written. Three spikes gate parts of it (§15); none of them gates the sequencing, because Stage 1 does not depend on any of the three.
**Builds on:** the whole of the redesign (sub-projects A–G) and `docs/superpowers/redesign/rulings.md`, which this document continues.
**Supersedes:** ruling **R1** and its sub-project-G restatement **R-G1** — see §3.
**Source:** the owner's constraints, gathered in conversation on 2026-08-28. Those constraints are settled and are not relitigated here; where this design adds something they did not settle, it is a ruling in §16 or an open question in §17.

### Revision, 2026-08-28 — three decisions the owner has made

The owner has answered §17 Q1 and §17 Q9 and has changed what the gateway talks to. All three answers change what this document says. They are recorded here at the top, and the body has been rewritten to match rather than annotated around:

1. **Verification is mutable, and a Partner may override it.** *"Partner may override a verification (and something can change from Verified, back to another state, at any time)."* This **supersedes** the first-to-verify-wins model the original §6.3 and ruling **S4** were built on. A finding now carries **one current disposition** and a **complete append-only history** of every change to it. §6.3 is rewritten; §3, §4, §7, §8, §9.1, §12, §13, §14, §16 and §18 are swept for the old model. **No part of this document still describes insert-once verification or first-to-verify-wins**, and if a reader finds one, it is a defect in this revision, not a surviving decision.
2. **Precedent documents may be stored server-side.** *"Precedent documents can be stored server-side."* This answers §17 Q9 and amends ruling **S19**. §11.1 is new and specifies it, including the on-screen sentence that becomes false and must change in the same stage.
3. **The inference gateway is multi-provider, not Azure-Foundry-only.** *"I think we probably want different AI layers — Foundry, OpenRouter, Claude, OpenAI, Azure OpenAI etc. And they choose. That's particularly useful for any smaller firms or individuals running it locally who won't have Azure infrastructure."* This **supersedes** ruling **S2** and **amends S15**; §5, §10, §12 and §13 are rewritten around it, and the operator — not the user — chooses the backend at deploy time.

   **The security guarantee is restated, and this is the most important line in the revision.** It is two sentences, and they are deliberately never merged:

   > **No credential ever leaves the gateway, and every call is logged with its provider and its jurisdiction, whichever backend is configured.**

   > **Separately: an Azure-only deployment authenticating by Entra managed identity retains the stronger property — no key exists at all.** That is the recommended posture for a firm with Azure infrastructure, and it is a *deployment choice*, not a property of the design.

   Both are true. Collapsing them into the old "there are no provider keys anywhere in the system" would state a security property that is **false for every deployment using OpenAI, Anthropic or OpenRouter directly**, which is the whole reason this revision exists. **No part of this document still states the unconditional no-keys claim as live**; if a reader finds one, it is a defect in this revision, not a surviving decision.

None of the three is relitigated below. Where each one creates a consequence the owner did not settle, that consequence is a new ruling (**S21–S27**) or a sharpened open question, not a silent choice.

### Revision 2, 2026-08-28 — a fourth decision: one system, two environments

The owner has answered §17 Q11:

> *"I want it to work cohesively when deployed within a firm, but also make it easy for someone to build and test on their own machine for testing. So ideally best of both."*

Q11 offered three answers and the owner took none of them, because **the question was framed wrongly**. It asked which *deployment mode* the local path is. It is not a deployment mode. **It is a development environment for the one system this document specifies**, and the answer is therefore structural rather than a choice between three products. Six parts, each of which changes something below:

1. **One authentication path — OIDC — with two issuers.** Entra ID *is* an OIDC provider. The application validates OIDC tokens against a **configured** issuer and reads group claims from a **configured** claim; it never special-cases Entra. Locally, a lightweight OIDC issuer runs in `docker compose` with seeded users and groups. **This generalises S10 rather than reversing it**: the three roles, the group-to-role mapping, and the refusal of SAML, Okta and any application-held password all survive untouched. Only "the issuer is Entra" becomes "the issuer is configured, and is Entra in the firm deployment". S10 is amended with a dated note, not edited away.
2. **There is no development bypass.** No `SKIP_AUTH`, no local anonymous mode, no trusted header. §7 gives the two reasons and S29 records them; the decisive one for this project is that **a bypass tests a different code path from the one that ships**, which is the same class of error as a test that passes against unfixed code.
3. **The local issuer seeds several users, across all three roles.** Not convenience: every collaborative behaviour this design adds — first sight of a colleague, a Partner override, the stale-version refusal, assignment, presence — is *unobservable with one user*, so a single-user local mode could not exercise the features Stages 3 to 5 exist to build.
4. **The same principle extends to the whole stack: local dependencies are faithful emulators of the deployed services, not near-equivalents.** **Azurite**, Microsoft's own Blob emulator — not MinIO, and not anything "S3-compatible", which is exactly the class of near-equivalence that produces a defect visible only in production. Postgres container ↔ Postgres Flexible Server. Redis container ↔ Azure Cache for Redis.
5. **The divergences are enumerated, and the list is exhaustive** (§5.1). **Exactly one of them is a different code path** — the gateway's provider adapter, keyed locally and managed-identity in an Azure deployment — and it is not new: it is already ruled by the third decision above (D3/S2). Naming it as the single deliberate divergence is what makes the list readable as exhaustive rather than optimistic.
6. **What local development does NOT prove is written down, in the same section.** Managed-identity acquisition, Entra's group-claim shape and consent, Azure networking and private endpoints, and real provider latency and rate limits are none of them exercised by `docker compose up`. **A developer must not read "it works on my machine" as "it will work in the tenant"**, and the boundary is stated where they will meet it.

New rulings **S28–S31**; **S10 amended**; §17 **Q11 ANSWERED**. A new **§17 Q13** is opened for the question Q11 conflated with this one — a *production* deployment on non-Azure infrastructure — because this decision does not answer that and must not be read as answering it.

### Revision 3, 2026-08-28 — a fifth decision, and it is a correction rather than an addition

The owner, on where the jurisdiction rules get their authority:

> *"It's basically for the person running the solution to be happy with the provider they're using, and the associated contracts and data provisions that those providers will give them (the API key is just the interface into the service, backed by those guarantees)."*

**This changes no mechanism and every justification.** Revision 1 built the jurisdiction rules as though the system were protecting an operator from their own provider choice, with US processing as a hazard to be defended against and UK/EU as the safe default. That is not the operator's position and the spec had no standing to take it. A firm may hold entirely sound provisions with a US provider — standard contractual clauses, a data processing agreement, negotiated retention and training terms — settled with legal input long before anyone opens a deployment configuration. **The API key is the interface to a service whose guarantees live in the contract behind it, not in the key.** The system's job is to enforce *what the operator declared*, not what this document's author assumed a law firm ought to want.

Four consequences, and the fourth is the one to check every future edit against:

1. **The declared jurisdiction set has no default at all** — not `UK,EU`, not anything. A default encodes an assumption about one firm's contracts. The gateway **refuses to start** when the set is unset, exactly as it refuses to start on an undeclared entry or a missing log sink. Fail-closed is unchanged and is now *stronger*: unconfigured is an error rather than a guess. The deployment template carries `UK,EU` as a **commented example with its reasoning**, never as a silent default (§10.3, §12 Q5, S27).
2. **The refusal survives verbatim; its reasoning is restated.** It is no longer "a cross-border transfer needs a firm-level consent a lawyer at their desk cannot give" *as a claim about what is acceptable*. It is: the operator has declared which providers they hold provisions for, and a request outside that set is a **misconfiguration, not a decision to re-take at request time**. The asymmetry argument is untouched — a wrong refusal costs a config change, a wrong transmission cannot be un-sent — and it now serves honouring the policy rather than substituting for it.
3. **`dataHandling` is the operator's record of terms they agreed, not the system's assessment of a provider.** It exists to be shown to a reviewer and re-read when it ages; the staleness marker prompts the operator to re-check their own contract and implies no judgement about the provider (§10.1).
4. **The labels are factual, never evaluative.** Every model still shows its provider and jurisdiction, always — that ruling is unchanged and its reason (a badge shown only on some entries makes its absence meaningful) is unchanged. What changes is that a label states where processing occurs and never implies one option is safer than another.

**What does not change, and must not be lost to over-correction:** the per-call record of provider and jurisdiction; the snapshot on the `run` row, so a past review's processing location cannot be rewritten by a later configuration change; the refusal to start when misconfigured; the exhaustive labelling; the refusal to route outside the declared set. Only the *authority being claimed* moved.

**S15, S26 and S27 are amended with dated notes**; §10.1, §10.3, §12.0, §12 Q5, §4's Out list, §14, §17 Q4 and §18 are swept for the old framing. Recorded in `rulings.md` as **D5**.

---

## 1. What this is for

LexPrompt currently tells one lawyer, in one browser, what is in a contract. It does this well and it does it honestly: every claim it makes about a document is traceable to a quote, every human judgement is a human's, and nothing derives a verification.

It cannot tell two lawyers anything. A trainee who verifies forty findings and needs a Partner's eye on three has no way to ask, and the app is deliberately built not to pretend otherwise (R-G1). A matter lives in one browser's IndexedDB, which means it lives on one laptop, which means it is one disk failure from gone and cannot be handed over. And every model call carries contract text from a lawyer's browser to OpenRouter under a key that lawyer pasted in themselves — a sentence that ends a Security review before it starts. **What ends it is the pasted key and the unreviewed destination, not the provider's name**: the 2026-08-28 revision makes the provider the firm's choice (§10), and OpenRouter behind a gateway with an operator credential, an allowlist and a call log is a different sentence from OpenRouter behind a paste box.

This design makes LexPrompt a service the firm deploys: one database, real accounts, real collaboration, and — the part that decides whether any of the rest is allowed to exist — an inference path the firm can describe to its own Risk function without flinching.

**The binding constraint is the Security / Risk review, and it outranks feature convenience throughout this document.** Where a feature and the Risk story disagree, the Risk story wins and the feature is named as out of scope rather than smuggled in.

The central architectural claim, stated once here because §5 and §10 exist to make it true:

> **The inference gateway is the only component in the system permitted to egress. Nothing else can call a model — not as a convention, as a network fact.**

That claim is **architectural**: it is true of every deployment, it is a network fact, and a Risk reviewer verifies it once.

Its companion answers the first question every Risk reviewer asks — *where are the keys?* — and it is **two sentences that must never be merged into one**, because the second is true of some deployments and not others:

> **No credential ever leaves the gateway, and every call is logged with its provider and its jurisdiction, whichever backend is configured.** The gateway is the only component that holds a provider credential, the only one that can use it, and the only one that can egress. `apps/web` and `apps/api` never see one, in any deployment, ever. This is architectural.

> **An Azure-only deployment, authenticating to Azure AI Foundry or Azure OpenAI by Entra managed identity, retains the stronger property: there is no key at all.** No key in a browser, no key in an environment variable, no key in Key Vault — nothing to leak, rotate, or find in a git history. **This is a deployment choice, not a property of the design**, and it is the posture recommended to any firm that has Azure infrastructure.

The firm now chooses its backend (§10): Azure AI Foundry, Azure OpenAI, OpenAI, Anthropic or OpenRouter, in whatever combination its Risk function has approved. A small firm or an individual with no Azure tenant gets a first-class deployment rather than a degraded one — same allowlist, same logging, same jurisdiction record. What it does not get is the second sentence above, and **the design's job is to make sure nobody believes otherwise**: §12 answers "where are the keys" per deployment, and the shorthand "there are no provider keys anywhere" is retired from this document.

---

## 2. What becomes untrue

The README is a promise about privacy, and this design breaks specific sentences in it. They are listed precisely, because a stale privacy claim is worse than none: a reader who trusts an out-of-date sentence has been misled by us, not by their own carelessness.

The table below now covers **the app's own on-screen copy as well as the README**, because the revision's second decision (§11.1) falsifies a sentence a user reads while uploading, not only one a developer reads in a repository. A false sentence on a screen is worse than a false sentence in a README by exactly the distance between the two readers.

| Location | What it says | What replaces it |
|---|---|---|
| Line 3, intro | "no backend, no database, and no user accounts — a static site that runs entirely in your browser and talks directly to OpenRouter" | A deployed service: a static web app, an API, an inference gateway, Postgres and Blob Storage, all in the firm's own Azure subscription. |
| §"No backend, no accounts" (101–103) | The whole section | Deleted. Replaced by a deployment section describing `docker compose up` locally and `azd up` to Azure. |
| §"You need an OpenRouter API key" (105–113) | The whole section, including "your API key is stored only in your browser's local storage" and "there is no server for LexPrompt to leak it to" | Deleted. **No user supplies a key, and no key reaches a browser.** Users sign in with their firm Entra account; models come from an admin-configured allowlist of provider+model pairs (§10). Where the firm's chosen provider authenticates by key rather than by managed identity, that key is the *operator's*, it is held only by the gateway, and no user ever sees, supplies or rotates one. The replacement README section says which of the two the firm's own deployment uses — it does not say "there are no keys" unconditionally. |
| §Privacy bullet 1 (127) | "stored in this browser's IndexedDB … and nowhere else" | Stored in the firm's Azure Postgres (metadata, extracted text, findings) and Blob Storage (original bytes), UK region, private endpoints. |
| §Privacy bullet 2 (128) | "Nothing is uploaded anywhere except to the model you chose, via OpenRouter" | Documents are uploaded to the firm's own API. Model calls go, through the gateway and nowhere else, to **the provider the firm configured** — Foundry, Azure OpenAI, OpenAI, Anthropic or OpenRouter. **What changes is not that OpenRouter is gone; it is that the destination stops being a user's paste and becomes a reviewed, allowlisted, logged deployment decision.** The subprocessor list is therefore a property of the deployment, and §12 Q5 answers it from configuration and from the call log rather than from a fixed sentence. |
| §Privacy bullet 4 (130) | "Data is per-browser, with no sync and no backup" | Data is server-side, backed up, and shared across the firm's users by design. |
| §Privacy bullet 6 (132) | Templates in IndexedDB; the `localStorage` migration backup | Playbooks are server-side. The `localStorage` backup remains untouched in whatever browser holds it — §13's uploader still never deletes it. |
| §Privacy closing (134) | "the reversal is bounded to your own browser" | No longer bounded to a browser. It is bounded to the firm's tenant. |
| §Visual system (96) | "the app's own disclosure says nothing leaves the browser except calls to OpenRouter" | The fonts decision stands and the reason strengthens — the app should not contact a third-party host on a page view — but the sentence is rewritten around the firm's own API. |
| §Visual system (97) | "The chrome is honest about being single-user … no assignee chip … The matter activity feed is derived … not a stored event log" | Superseded (§3). Assignee chips, an "assigned to me" counter and an activity feed with real actors become honest, and the feed is read from the stored audit log. |
| §"How it's built" (138) | "No backend, no server-side anything" | A monorepo: `packages/core`, `apps/web`, `apps/api`, `apps/gateway`. |
| §"Building and deploying" (204–225) | Static host, SPA rewrite, Firebase | `azd up` to Azure, **and `docker compose up` for the whole stack locally** — web, api, gateway, the local OIDC issuer with its seeded accounts, Postgres and Azurite (§5.1). The SPA rewrite note survives for the web app's own hosting. The replacement section also carries §5.1's list of what a local run does *not* prove, because the reader who needs that sentence is the developer who has just had a green local run. |
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
2. **The inference gateway** — sole egress; **pluggable provider adapters behind one interface** (Azure AI Foundry, Azure OpenAI, OpenAI, Anthropic, OpenRouter), chosen by the operator at deploy time; managed-identity auth where the provider supports it and an operator key held only here where it does not; a metadata-only call log carrying **provider and jurisdiction** on every call; an allowlist of provider+model pairs; budgets.
3. **Server persistence** — Postgres for records, Blob Storage for original document bytes; the nine IndexedDB repositories become an HTTP API over the same nine (plus new) concerns.
4. **OIDC authentication against a configured issuer** — Entra ID in the firm deployment, a seeded container in local development — and three roles mapped from the issuer's group claim (§7, §5.1).
5. **The review engine server-side** — runs as queued, resumable, cancellable jobs.
6. **Realtime collaboration** — presence, live findings, live human judgements, with an explicit resynchronisation path.
7. **The collaboration model** — one current, attributed disposition per finding (`unchecked` / `verified` / `flagged` / `rejected`), changeable by any authorised user in any direction at any time, over a complete append-only history of every change; and assignment that reaches a person in-app.
8. **An append-only audit log**, and the activity feed built from it. A disposition's history is part of that log, not a second copy of it (S22).
9. **Server-side storage for precedent documents** — the "Learn from redlines" inputs, stored as first-class documents distinguished from matter documents in both storage and UI (§11.1), with the on-screen non-storage promise replaced in the same stage.
10. **Deployment** — `docker compose up` locally and `azd up` to Azure, running **the same code path** both ways, with the divergences enumerated exhaustively and checked mechanically (§5.1, §18).
11. **A one-time migration** for the data currently in the owner's browser.

### Out, and why

- **Multi-tenancy beyond schema-readiness.** Every table carries `workspace_id` and every query is scoped by it from day one, so a second tenant is a data-model no-op. Not built: tenant onboarding, per-tenant configuration, cross-tenant administration, or tenant-aware billing. *Reason: one firm now; the schema is the expensive half and the rest is speculative product work.*
- **SSO beyond Entra, and any credential the application itself holds.** No SAML, no Okta, no application username/password. *Reason: a local account is a credential store the firm would then have to defend at the Risk review, in exchange for a convenience nobody asked for. The firm is an Entra shop.* **Unchanged by the fourth revision, and worth stating precisely so it is not misread**: the local development issuer (§5.1, S31) is a second *issuer of the same protocol*, not a second authentication mechanism, and it is not a deployed component. The application holds no credential in any environment, which is the property this exclusion actually asserts.
- **Phone layouts.** Still sub-project H. *Reason: unchanged by this design and separately specced.*
- **Offline mode.** Browser-local persistence is retired, not reduced. *Reason: one persistence story. Two is how the app ends up with a browser copy and a server copy disagreeing about who verified what — this project's most repeated defect, at its most dangerous.*
- **Concurrent text-editing merge (OT / CRDT).** Presence exists to *prevent* collisions, per the owner. Free-text fields (a note, an amended net position, a playbook draft) are last-write-wins **with the loser told, loudly, and shown what replaced their text** — never a silent overwrite. *Reason: genuine simultaneous editing of the same sentence is expected to be rare, and a merge engine is a large subsystem defending against it.*
- **Per-matter access control.** One firm; everyone in the workspace sees every matter. Role gates *actions*, not *visibility*. *Reason: §7. A richer permission system than one firm needs is a permanent tax and a new class of "why can't I see this" defect.*
- **Notification outside the app.** Email and Teams are §17 Q2, deliberately undesigned. *Reason: each adds a subprocessor and a data-flow line to the Risk story, and the owner has not decided.*
- **User-chosen models.** Models are an admin-configured allowlist of **provider+model pairs**, each declaring the jurisdiction its processing happens in. *Reason: §10 and §12 — a user-entered model id is an unreviewable egress destination. The 2026-08-28 revision made the **provider** a choice; it did not make it a **user's** choice, and that property is unchanged.*
- **Silent provider failover, and any user-facing override of the allowlist or the declared jurisdiction set.** A call that cannot run where the operator configured it fails loudly; it does not quietly run somewhere else, and no screen offers a lawyer a way to proceed anyway. *Reason: §10.3. A request that ran somewhere other than where the operator believed is the jurisdiction guarantee failing invisibly. And the declared set is the operator's own policy, arrived at with their own contracts and legal input; a lawyer at a model picker is not the person who amends it, so a request outside it is a misconfiguration to fix in configuration, not a decision to re-take at request time.*
- **Ingest OCR.** Not built now; named as the fallback if Spike 1 fails (§15).
- **Public or anonymous share links, and any anonymous mode at all.** *Reason: a link that works without an account from the configured issuer is a hole in every sentence of §12 — and an anonymous local mode is the same hole with a promise attached that it will only ever be opened on a laptop (S29).*
- **Usage billing / chargeback.** The gateway's call log carries token counts, so this is later reporting over existing data, not a subsystem.

---

## 5. Service topology

```
┌──────────────┐    HTTPS + OIDC access token    ┌───────────────┐
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
                                                   │  the ONLY holder   │
                                                   │  of a credential   │
                                                   └─────────┬──────────┘
                                                             │ managed identity, OR an
                                                             │ operator key held only here
                                                             ▼
                                          ONE configured provider adapter, from:
                                          Azure AI Foundry · Azure OpenAI · OpenAI ·
                                          Anthropic · OpenRouter — each entry in the
                                          allowlist declaring its processing jurisdiction
```

**The operator picks the provider at deploy time; the shape above does not change when they do.** Every arrow, every denial in the table below, and the call log are identical whether the bottom box is a UK Foundry deployment or an OpenRouter account. That is the point of the boundary: the thing a Risk reviewer verifies is the topology, and the topology is provider-agnostic.

**`packages/core`** — every piece of domain logic that is neither React nor IO. It is a library, not a service, and it is the same bytes on both sides of the wire. Contents: `citations`, `citationPage`, `citationRepair`, `pageSegments`, `modelContext`, `findingOutcome`, `verification`, `reviewTarget`, `netPosition`, `collectionOrder`, `collectionPrompt`, `collectionSuggest`, `positionHealth`, `positionHealthMap`, `strength`, `inferPositions`, `buildChangeset`, `chains`, `docxRedlines`, `docxMarkup`, `pdfRedlineDiff`, `standardPositions`, `positionOutcome`, `matterActivity`, `matterStats`, `reviewProgress`, `riskBlock`, `uid`, `concurrency`, `playbookScan`, `playbookDefaults`, the prompt builders, `extractClause` / `extractCollectionClause` themselves, and — new in the 2026-08-28 multi-provider revision — **the SSE transport decoder** (§10.4), which is the one place a byte stream becomes frames for every provider adapter and for the browser's own consumption of the chat proxy. This is not aspirational: `src/lib` today contains React in exactly one file (`router.ts`), which stays in `apps/web`.

**`apps/web`** — the React SPA, unchanged in shape. It keeps `pdfjs` for *rendering* the viewer and for `findQuoteRects`, which matches a quote to on-screen coordinates and must run where the canvas is. It owns no domain logic that the server also needs.

**`apps/api`** — HTTP + WebSocket. Owns: authentication, authorisation, every read and write to Postgres and Blob Storage, the run queue and its workers, the realtime hub, and the audit log. **`api` may not egress.** Its only outbound routes are to Postgres, Blob Storage and the gateway, all over private endpoints; the public internet is denied by network policy (§15, Spike 2), not by code review.

**`apps/gateway`** — a small, stateless HTTP service. Owns: the model call, the provider adapters, and — in a keyed deployment — **the only provider credential in the system**. It has **no database credential, no Blob credential and no read path to either**, so compromising it yields the calls in flight and, where the provider authenticates by key, that key; never the archive. §10 is its full specification, and §12 Q6 states the breach consequence per deployment rather than in one sentence that is only true of the managed-identity case.

**What may talk to what, exhaustively:**

| From | To | Allowed |
|---|---|---|
| web | api | yes (only destination) |
| web | gateway | **no** |
| web | any model provider | **no** |
| api | Postgres, Blob Storage | yes, private endpoint |
| api | gateway | yes, internal only |
| api | internet | **no** |
| gateway | the configured provider endpoints, and only those | yes — private endpoint and managed identity for Foundry / Azure OpenAI; TLS to the provider's public endpoint with an operator key for OpenAI, Anthropic, OpenRouter |
| gateway | any host not in the provider allowlist | **no** — an egress allowlist of hostnames, not just a config value the adapter happens to read |
| gateway | Postgres, Blob | **no** |
| gateway | api | **no** (the gateway never calls back) |

**Why a separate service rather than a module in `api`.** Three reasons, in the order a Risk reviewer cares about them. First, *evidence*: "the API cannot reach a model" becomes a network rule an auditor reads from infrastructure-as-code, not a claim they have to take on trust from a code review. Second, *blast radius*: a prompt-injection- or dependency-driven SSRF in `api` — the service that handles uploads and untrusted document text — has nowhere to go. Third, *drift*: a module is one refactor away from being called from a second place; a service with one network peer is not.

**Local development runs the same code, not merely the same shape**, and §5.1 states exactly how far that goes and where it stops. `docker compose up` brings up web, api, gateway, **the local OIDC issuer with its seeded accounts** (§5.1, S31), Postgres and Azurite — and Redis with `api` at two replicas if Spike 3 requires a Redis-backed fan-out, because a fan-out path exercised against a single replica is not exercised. The gateway points at any configured provider: a Foundry deployment using developer Entra credentials via `DefaultAzureCredential`, a keyed provider using a secret from a local env file, or the `recorded` stub adapter for offline work (§5.1). `azd up` provisions the same services in Azure. The compose network denies `api` egress the same way the Container Apps environment does, so the central claim is exercised in development rather than only asserted in production.

**A no-Azure deployment is a first-class path, and it is not a lesser one.** The owner's reason for making providers pluggable is the firm or individual with no Azure tenant, so the local path runs the *same* gateway binary, the *same* allowlist, the *same* jurisdiction check and the *same* per-call log as the Azure one — see §10.4, which states that as an acceptance condition and refuses to let logging become the thing a local deployment quietly skips.

**§17 Q11 is answered, and it changes what this paragraph could previously claim.** Identity is no longer the blocker it looked like: §7 is not Entra-only any more, it is OIDC against a configured issuer of which Entra is one (S28) — and Entra ID itself does not require an Azure subscription, so a firm with no Azure *infrastructure* still has an identity answer. Storage is a hosting question rather than a design one: Postgres is Postgres, and the blob store is Azurite locally and Azure Blob in the deployment, through the same SDK and the same calls — **never an S3-compatible substitute** (S30). What remains genuinely open is *production* hosting off Azure — where Postgres and the blob store live, and what that does to §12's residency, backup and subprocessor answers — and that is now **§17 Q13**, asked as its own question rather than smuggled into a local-development one. **Local development is settled, and it is not a deployment**: §5.1 specifies it, enumerates every way it differs from the deployed system, and says what it does not prove.

### 5.1 One system, two environments

**The claim this section exists to make true:** *the code that runs on a developer's laptop is the code that runs in the firm's tenant.* Not similar code, and not the same code with a development branch in it — the same code path, differing only in configuration values, with one enumerated exception.

That deserves a section rather than a sentence, because the alternative is this project's founding failure one level up. A test that passes against unfixed code proves nothing; **a local stack that exercises a different code path from the deployed one is the same error with a deployment attached**, and its symptom is a green `docker compose up` that says nothing whatever about the tenant.

**Deployment-varying values are read in exactly one place per app.** Each of `apps/web`, `apps/api` and `apps/gateway` has a single typed configuration module, and a boundary test forbids every other module from reading `process.env` — the same shape as S14's import boundary and S25's adapter boundary, applied to configuration. **No module anywhere branches on the environment**: no `isLocal`, no `NODE_ENV === 'development'` outside build tooling, no `if (dev)`. That is an assertion a test makes, not a habit somebody keeps (S30).

The consequence is the point of the whole arrangement: **the diff between the local configuration and the deployed one *is* the divergence list.** It is not a document maintained alongside the truth and liable to rot away from it; it is the truth, and §18 checks the set of differing keys against the table below.

#### The enumerated divergences

| # | What | Local | Firm deployment | Kind |
|---|---|---|---|---|
| 1 | Identity issuer | Keycloak container, realm imported from version control | Microsoft Entra ID | **Configuration.** Same OIDC discovery, same token validation, same group-claim read (§7, S28). |
| 2 | Inference provider and credential | a keyed adapter (OpenRouter / OpenAI / Anthropic) reading a mounted secret | Foundry or Azure OpenAI by managed identity | **A different code path — the one deliberate divergence**, and not a new one: already ruled by D3/S2 (§10). |
| 3 | Provider secret source | mounted secret file | Azure Key Vault | Configuration, behind one secret-loader interface. |
| 4 | Relational store | Postgres container, same major version, same migrations | Azure Database for PostgreSQL Flexible Server | Configuration. Same engine. |
| 5 | Blob store | **Azurite** — Microsoft's own emulator | Azure Blob Storage | Configuration. Same SDK, same calls (S30). |
| 6 | Realtime fan-out, if Spike 3 requires Redis | Redis container, **with `api` at two replicas** | Azure Cache for Redis | Configuration. Two replicas locally, or the fan-out path is never exercised. |
| 7 | `api` egress denial | compose network policy | Container Apps egress rules | **Infrastructure, not application code.** Different mechanism, identical assertion; §14's `egress` suite runs against both (§15, Spike 2). |
| 8 | Gateway log sink | a collector shipped in the compose file | Azure Monitor | Configuration. The gateway writes the same JSON lines to stdout in both (§10.5). |
| 9 | Ingress and TLS | compose, on loopback | Container Apps managed ingress | Infrastructure. No application code reads it. |

**Nothing else differs, and that is the claim §18 makes checkable.** If a tenth row is ever needed, it is added here first and to the configuration modules second — a divergence that exists in code and not in this table is the defect, not a missing row.

**Row 2 is the only place where different code executes.** A developer with an Azure tenant can close even that: §5's compose stack will point the Foundry adapter at a real deployment through `DefaultAzureCredential` and a developer sign-in, which runs the deployed adapter locally. §10.2's one interface with one registration point is what keeps the swap to a registry entry rather than a second call path.

**The offline stub is an adapter, not a bypass.** For work with no network, a `recorded` provider is registered like any other adapter, passes §14's `adapterConformance` suite like any other, and declares its jurisdiction like any other — so a firm deployment refuses it through S27's existing mechanism rather than through a new one. **And every response it produces is marked**: the flag is stored on the finding, the `run` row records `provider = 'recorded'`, and the UI renders a loud, non-dismissible banner saying these findings did not come from a model. The stub is the one component of the local stack capable of producing a confident wrong answer, so it is the one that says loudest what it is.

#### The seeded users, and why there must be more than one

**The local issuer seeds several users across all three roles.** At minimum a reviewer (a trainee), a partner and an admin, in the corresponding groups, with credentials in the version-controlled realm file and printed by `docker compose up`. **Plus a fourth: a user in no mapped group**, because "told plainly that you have no access" is a load-bearing behaviour (§7) and it needs an account to test with.

**This is not convenience. It is what makes Stages 3 to 5 buildable at all.** Every collaborative behaviour in this design is *unobservable with one user*: first sight of a colleague, a Partner overriding a trainee's verification, the stale-version refusal, assignment reaching a person, presence, and a card changing attribution without a reload each require two browsers signed in as two different people. **A single-user local mode would not be a cheaper version of this; it would be a local stack that runs green on the half of the system that does not need testing.**

The effect on the plan is larger than it looks. §14 already required browser verification with two accounts; before this decision that meant a deployed environment and two real Entra accounts for every Stage 4 defect. It now means two browser profiles on one laptop — the difference between reproducing a collaboration bug in a minute and reproducing it in an afternoon, repeatedly, through the stage where this design's entire collaborative half lands.

#### What running locally does NOT prove

Being honest about the boundary is the point of listing it. **A developer must not read "it works on my machine" as "it will work in the tenant."** None of the following is exercised by `docker compose up`:

- **Managed-identity acquisition.** `DefaultAzureCredential` against a real IMDS endpoint, the role assignments behind it, and how it fails when one is missing. Row 2 is the divergence; this is what it costs.
- **Entra's group claim** — its name, its shape (group *object ids*, not names), whether the app registration emits it at all, and the specific case that will bite: **group overage**. A user in more groups than a token can carry gets no `groups` claim and a `_claim_names` pointer to Microsoft Graph instead. Locally, no seeded user is in more than one group, so the claim path is always the simple one and always works. §7 requires overage to be detected and reported as its own error rather than read as "in no mapped group".
- **Admin consent, conditional access, MFA and tenant token lifetimes.** All tenant policy; none of it exists in a seeded realm.
- **Azure networking** — private endpoints, private DNS resolution, and the real egress denial (Spike 2). Row 7's local mechanism asserts the same thing by different means; it does not prove the Azure one.
- **Postgres Flexible Server's own behaviour** — connection limits and pooling, enforced TLS, failover, and which extensions are actually available. The same engine is not the same service.
- **Azurite's own gaps.** It is Microsoft's emulator and that is exactly why it is the right choice, but it is not feature-complete: it does not authenticate by managed identity, and lifecycle, immutability and newer APIs are absent or approximate.
- **Real provider latency, rate limits and stream behaviour** — 429s under load, long-tail latency, and streams from a real server through real proxies, which is where the CRLF defect that §10.4 exists to prevent actually lived.
- **Container Apps scale-to-zero and multi-replica WebSocket behaviour** (Spike 3).

**Keycloak is not an Entra emulator, and this section must not be read as claiming it is.** Azurite emulates Blob Storage; Keycloak *implements the same protocol* Entra implements. That distinction is precisely where the list above bites, and it is why "faithful emulator" is stated per dependency rather than as a slogan.

**This list belongs in the repository's README as well as here** (§2), because the reader who needs it is the developer who has just had a green local run, and they are not reading a design document at that moment.

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
                    issuer  text not null                   -- the OIDC issuer URL, as configured
                    subject text not null                   -- the value of the configured subjectClaim:
                                                            --   'oid' under Entra, 'sub' under a
                                                            --   standard issuer. Opaque either way.
                    unique (issuer, subject)                -- THE identity. Never the email (§7).
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
                    requested_by_user_id
                    provider text       -- foundry|azure_openai|openai|anthropic|openrouter
                    model text          -- the allowlisted model or deployment name
                    jurisdiction text   -- e.g. 'UK', 'EU', 'US' — as declared at the moment
                                        -- of the call, NOT re-derived from current config
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

role_mapping        issuer text, group_value text, role text
                    primary key (issuer, group_value)
                    -- group_value is an Entra security-group object id in the firm
                    -- deployment and a Keycloak group name locally. The code reads a
                    -- string from the configured groupsClaim and looks it up; it does
                    -- not know the difference (§7, S28).
```

**`run.provider` / `run.model` / `run.jurisdiction` are a snapshot, for the same reason `playbookSnapshot` is.** A firm may change its allowlist — swap a provider, retire a model, tighten its allowed jurisdictions — and a review run last March must not have its answer to *"where was this processed?"* silently rewritten by a configuration change made since. Re-deriving the jurisdiction from current configuration at read time is the same defect as editing a playbook and having it rewrite history, applied to the one fact a data-protection question turns on. The gateway returns the provider, model and jurisdiction it actually used on every response, and the run row stores what it was told rather than what the config now says.

**Document bytes live in Azure Blob Storage**, one blob per document, keyed `workspace/{workspace_id}/document/{document_id}`, private container, no public access, server-side encryption, reachable only through the API's managed identity. `document.blob_key`, `byte_size`, `mime` and `content_sha256` live in Postgres. Deleting a matter deletes its documents' rows *and* their blobs, in that order, with a reconciliation job that deletes orphaned blobs — because the cascade is a promise the README makes and a half-done cascade is the failure mode that promise exists to prevent.

**Page images are still never persisted.** Not in Postgres, not in Blob Storage, not anywhere. They are regenerated on demand by the API at run time and held in an in-process LRU for the life of that run (§11). The rule was about derived data being ~⅓ larger than its source and regenerable; nothing about a server changes that.

### 6.6 Settings

`Settings.apiKey` is deleted. `Settings.modelId` becomes workspace configuration an admin sets from the allowlist of **provider+model pairs**. `Settings.concurrency` becomes a server-side per-run bound. `modelSupportsImages` / `modelSupportsStructuredOutput` / `modelContextLength` become properties of the allowlisted pair, known server-side and sent to the client for capability display — and so is its **declared jurisdiction**, which the picker shows (§10.3). `modelContext.ts` is unchanged in substance and moves to `packages/core` as planned: the rule that a model unable to read images must not be handed a scan is a per-model property, and it was never a per-provider one.

**R6 survives for what is left.** Genuine per-user UI preferences — and nothing else — stay in `localStorage`, synchronously, for the reason R6 gave. R6's API-key clause is void, because the key is gone.

---

## 7. Auth and roles

**One authentication path: OIDC authorization code with PKCE, against a configured issuer.** The issuer is Microsoft Entra ID in the firm deployment and a Keycloak container in local development (§5.1, S28, S31), and **the application does not know which**. It reads the issuer's discovery document, validates tokens against it, and maps group claims to roles from configuration. **There is no Entra branch anywhere in the codebase**, and §14's `auth` suite asserts it rather than trusting it.

**The browser uses a standards-only OIDC client, not MSAL.** MSAL is Entra's own library; reaching for it would either tie the sign-in path to one issuer or produce a second sign-in path for the other — two implementations of one idea, at the front door, which is this project's most repeated defect in the worst place to put it. `oidc-client-ts` or equivalent speaks discovery, authorization code and PKCE to any conformant issuer, Entra included. *This is a change from the pre-revision design and is flagged as one, because "use MSAL for Entra" is the obvious choice and it is the wrong one here.*

**The API validates the access token on every request** against the configured issuer: signature against the JWKS named by discovery, plus `iss`, `aud`, `exp`, and **any required claim values the issuer's configuration names**. Entra's tenant check — `tid` equals the firm's tenant — is one such configured required claim rather than a code path, which is what keeps "never special-cases Entra" literally true instead of aspirational. No session cookie of its own: one credential, refreshed by the client, used for both HTTP and the WebSocket upgrade. A WebSocket whose token expires is closed by the server and reconnected by the client with a fresh one.

**The authentication configuration in full**, because it is the whole of what varies between the two environments (§5.1, row 1):

```
issuer          -- the OIDC issuer URL; discovery is read from it
audience        -- the API's client id
subjectClaim    -- the claim carrying this person's stable identity.
                --   'oid' for Entra (stable across the tenant); 'sub' elsewhere.
groupsClaim     -- the claim carrying group membership. Named, never assumed.
requiredClaims  -- claim/value pairs that must match. { tid: <tenant id> } for Entra.
```

**The API refuses to start with no issuer configured, and refuses a non-HTTPS issuer that does not resolve to loopback.** Same posture as the gateway's refusal to start with no declared jurisdiction set, on an undeclared entry, or with a missing log sink (§10.3, §10.5): a misconfiguration must not become a system that runs and mostly works. It is also the mechanism that makes "a deployed environment pointed at a development issuer" a startup failure rather than a silent one (§12 Q2, S29).

**There is no development bypass, and there is no configuration that disables authentication.** Not a `SKIP_AUTH` flag, not a local anonymous mode, not a trusted header. Two reasons, and the second is the decisive one for this project (S29):

1. **A bypass is a deployment liability.** The recurring industry failure is precisely that such a flag reaches production enabled, and this system holds privileged client material. A control that depends on a flag never being set in one environment is a control held by discipline, and `CLAUDE.md`'s list is a record of what discipline loses to.
2. **A bypass tests a different code path from the one that ships.** This is the same class of error as a test that passes against unfixed code — the worst kind of test this project has shipped. Under a bypass, a local run exercises a token validation, a role mapping and a set of authorisation checks that the deployed system does not have, and it comes out green. It would prove nothing. The entire value of a faithful local stack is that a green run is evidence, and a bypass is exactly what would take that away.

The cost of having no bypass is that a developer runs one more container. That is the whole cost, and §5.1's compose stack pays it once.

**A user row is created on first successful sign-in** (just-in-time provisioning) from the token's configured `subjectClaim`, its `iss`, and its name and email claims. **`(issuer, subject)` is the identity, never the email** — an email can be reassigned; an issuer-scoped subject cannot. The pair is also what makes one implementation correct against both issuers: a Keycloak subject and an Entra `oid` are both opaque stable strings, and neither is ever compared with the other.

**Three roles, mapped from the issuer's group claim** through `role_mapping (issuer, group_value, role)`, seeded by deployment configuration and editable by an admin. The values are Entra security-group object ids in the firm deployment and Keycloak group names locally; the code reads strings from a configured claim and looks them up. A user in no mapped group has no access at all and is told so plainly — not shown an empty app, which would be the "empty is not broken" rule failing at the front door.

**A missing group claim is not the same fact as an empty one, and Entra makes that difference real.** When a user belongs to more groups than a token can carry, Entra omits `groups` entirely and emits `_claim_names` / `_claim_sources` pointing at Microsoft Graph. Read naively, that is indistinguishable from "in no mapped group" — so a partner in forty groups would be told they have no access, which is a wrong answer delivered confidently, the exact shape this project exists to prevent. **The absent-claim case is detected and reported as its own error**, naming overage as the cause and telling the user to contact an admin, rather than being folded into the no-role message. It cannot be reproduced locally (§5.1), which is why it is specified here rather than discovered in the tenant.

| Role | Can |
|---|---|
| `reviewer` | Create and edit matters, documents, collections and reviews; run reviews; **set a finding's disposition to any state, including one a colleague set** (§6.3); note; assign; confirm or amend net positions; edit playbook drafts; bring in precedent documents and infer positions from them; export. |
| `partner` | Everything a reviewer can, **plus** publish a playbook version. |
| `admin` | Everything a partner can, plus: role mapping, model deployment selection, retention configuration, disabling a user, and exporting the audit log — including the disposition history export (§6.3.1). An admin is not a super-reviewer; the actions are administrative. |

**§17 Q1 is answered, and the answer is broader than the question.** The owner asked whether a Partner may override a verification and said yes. The design does not build "override" as a Partner-only power, because the mechanism the owner actually described — *"something can change from Verified, back to another state, at any time"* — is not a hierarchy feature, it is the disposition being mutable. A trainee who verifies the wrong finding at 09:00 must be able to un-verify it at 09:01 without waiting for a Partner; a rule that made overriding a partner privilege would produce exactly that wait, and the app would be manufacturing a silence again. **What makes this safe is not who may change it. It is that every change is recorded, attributed, and shown** (§6.3).

*If the firm later wants overrides restricted to Partners*, that is a role check on one route plus a UI gate — not a data-model change, because the history already records who did what. Recorded here so a later narrowing is understood as cheap rather than as a reversal of the design.

**Deliberately not built:** per-matter ACLs, guest accounts, deny rules, delegated permissions, custom roles. One firm, one workspace, everybody sees the work (S10). **Nor a second authentication mechanism:** the issuer varies between environments, the protocol and the code do not (S28).

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

**Streaming.** The cell events *are* the stream: `run.started`, `finding.running`, `finding.done`, `finding.error`, `run.finished`. Token-level streaming exists only for the assistant chat, proxied browser ← api ← gateway; nothing in the review path needs it. **That proxy is the only place a user sees a provider's stream**, so it is where §10.4's per-adapter frame mapping is actually exercised in anger, and it decodes with the same `packages/core` decoder rather than a browser-side second copy — the sibling drift rule, on the one function whose last defect lost the final token of every answer.

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

A small, stateless HTTP service, **and as of the 2026-08-28 revision a multi-provider one**. Two routes:

```
POST /v1/infer          -> { content, usage: { promptTokens, completionTokens },
                             provider, model, jurisdiction }
POST /v1/infer/stream   -> SSE of content deltas, terminated by the same
                           { provider, model, jurisdiction, usage } envelope
```

Request body:

```
{ provider, model, purpose, system, user, images?, jsonSchema?, temperature?,
  workspaceId, actorIssuer, actorSubject,
  matterId?, reviewId?, clauseId?, documentIds? }
```

**Both responses carry the provider, model and jurisdiction actually used.** The caller does not infer them from its own configuration — it is told, and it stores what it was told (§6.5). A gateway that answered without saying where it had been would make the run row a guess.

**The actor is `(issuer, subject)` until Stage 2, and then `app_user.id` beside it.** `app_user` does not exist before Stage 2, so Stage 1's gateway records the pair the token carried — the configured `subjectClaim`'s value and its issuer — rather than an id it cannot yet resolve. Stage 2 adds `actorUserId` **alongside** the pair rather than replacing it, so records written before `app_user` existed stay joinable to records written after. An earlier draft of this section wrote `actorUserId` alone; that would have meant either an unresolvable id in Stage 1 or an Entra-shaped one, and S28 forbids the second.

**Who may call it.** Only `apps/api`, authenticated by its Azure managed identity (or mTLS in local compose). The gateway has no public ingress and no route from the internet.

**How it authenticates, per provider.** The credential is acquired by the configured adapter (§10.2) and **never leaves the gateway process**:

| Provider | Credential | Key exists? |
|---|---|---|
| Azure AI Foundry | `DefaultAzureCredential` → token for `https://cognitiveservices.azure.com/.default` | **No** |
| Azure OpenAI | the same managed identity, same scope | **No** |
| OpenAI | operator API key, from Key Vault (Azure) or a mounted secret (local) | Yes |
| Anthropic | operator API key, same handling | Yes |
| OpenRouter | operator API key, same handling | Yes |

**Where a key exists, these hold without exception:** it is the *operator's*, never a user's; it is read once at startup from a secret store or a mounted secret and never from source, from the database, or from a request; it is never written to a log, an error message, a metric label, or a response body; it is never returned by any admin endpoint, which reports only *whether* a credential is configured and when it was last rotated; rotation is a configuration change with no code change and no schema change. A credential-acquisition failure — a missing secret, an expired token, a rejected key — is a loud `503` naming the provider and the failure, and **never a fallback to an unauthenticated call, to a different credential, or to a different provider.** Silent provider failover is not built and must not be added: a request that quietly ran somewhere other than where the operator believed is the jurisdiction guarantee failing invisibly, which is the exact shape this project's founding defect takes.

**What it enforces.**

- **An allowlist of provider+model pairs.** A request naming a pair not on the list is rejected. Each entry carries its **declared processing jurisdiction**, and the gateway refuses a jurisdiction the operator has not declared — at startup and again per call (§10.3, S27). A user still cannot name an arbitrary model; that property is exactly as it was under the Foundry-only design, and only the shape of the entry changed.
- **A purpose allowlist** — `review.clause`, `review.collection_clause`, `assistant.chat`, `playbook.draft`, `playbook.suggest`, `redlines.infer`, `changeset.build`, `export.email`, `export.suggest_fix`. An unknown purpose is rejected. This makes "what does this system send to a model, and why" answerable from configuration rather than from reading the application.
- **Budgets and rate limits**, per workspace and per actor, in tokens and in requests.
- **A maximum prompt size** and a request timeout.
- **Retry on 429 and 5xx only; fail fast on 400/401/402/403.** This is `openrouter.ts`'s rule, carried over verbatim because it was right: retrying a rejected credential wastes the user's time before telling them the same thing. It lives in the gateway core and runs **once**, over the adapter's normalised error class — not five times, once per adapter (§10.2). `parseJsonLoose` moves to `packages/core` and stays the fallback for models that wrap JSON in prose.

**What it logs, per call.** Timestamp, purpose, **provider**, **model**, **jurisdiction**, workspace id, actor user id, matter/review/clause ids, prompt token count, completion token count, latency, HTTP status, retry count, whether images were attached and how many, and `sha256` of the prompt. Retained 90 days.

**Provider and jurisdiction are not optional fields on that record.** They are what makes "where has privileged text been processed, and how often" answerable at all once the destination is configuration rather than a fixed fact, and they are what §12 Q5 now reads to answer the subprocessor question honestly. A log line that omits them is a defect, not a shorter log line, and the redaction test of §14 is joined by a completeness test asserting every call log line carries all three.

**What it does not log: prompt content and completion content, ever.** The prompt hash exists so that "was this the same prompt?" is answerable in support without keeping the prompt. A content-logging debug mode is not built; if one is ever wanted it must be admin-enabled, time-boxed, and itself audit-logged — named as §17 Q8, not designed here. A redaction test asserts no log line can carry document text (§14).

### 10.1 Risk item the owner must decide: provider-side retention, starting with Foundry abuse monitoring

Azure OpenAI's default abuse-monitoring behaviour, as documented at the time of writing, **stores prompts and completions for up to 30 days**, and flagged content may be reviewed by authorised Microsoft personnel. Opting out — "modified abuse monitoring" under Limited Access — requires an application to Microsoft and approval; it is not a portal setting.

Stated plainly, because a Risk reviewer will ask and this is the honest answer: **until that exemption is applied for and granted, contract text this app sends for review is retained by Microsoft for up to 30 days and may be seen by a human.** That is a materially different sentence from "the credential never leaves the gateway", and both are true at once.

**Multi-provider makes this a question per provider, not one question.** Every provider the firm may configure has its own answer to *how long is our text kept, who may read it, and is it used for training* — and those answers differ, change on the provider's own schedule, and are not equivalent to each other. The design does not restate any of them here, because a spec written by a model with a knowledge cutoff is the worst possible place for a compliance fact with a shelf life. What the design requires instead:

1. **Each allowlist entry carries a `dataHandling` note, and the note is the operator's record of the terms they agreed — not the system's assessment of the provider.** A short statement of the retention, training and sub-processing terms *this operator holds* for that provider, with the date they were last checked and a link to the terms or the contract reference. Those terms may be the published defaults, or they may be a negotiated DPA and standard contractual clauses the firm settled with legal input long before this deployment existed; the field records whichever it is. It is configuration, so it can be corrected without a release. **The system does not grade it, score it, or infer anything from it**; it stores it, shows it, and says how old it is.
2. **It is surfaced where the choice is made** (the admin provider screen) and in the audit export beside the call counts, so "what did we agree to, and how much did we send under it" is one answer rather than two.
3. **A stale entry is visible as stale, which is a prompt to the operator and not a verdict on the provider.** A `dataHandling` note older than the firm's review interval renders as needing re-checking rather than as current — it asks the operator to re-read their own contract, because provider terms change on the provider's schedule and a note that was accurate two years ago reads exactly like one written this morning. An unchecked compliance claim presented as checked is this document's founding failure mode wearing a procurement hat. **What the marker never means is that the provider has become less trustworthy**; it means the record has aged and only the operator can refresh it.

The owner decides (§17 Q4): which providers to configure at all, and — for Foundry — whether to apply for the modified-abuse-monitoring exemption before go-live or accept and disclose it. **Every provider's terms must be re-confirmed against that provider's current documentation at implementation time.** Do not take this section as the citation; verify it.

### 10.2 Provider adapters, and the one thing they must not become

**One interface, one registration point, one call path.** Adding a sixth provider must not require touching a call site:

```ts
interface ProviderAdapter {
  readonly id: ProviderId              // 'foundry' | 'azure_openai' | 'openai' | 'anthropic' | 'openrouter'
  credential(): Promise<Credential>    // managed identity token, or the operator key
  buildRequest(call: NormalisedCall): ProviderRequest
  parseResponse(res: ProviderResponse): NormalisedResult
  parseStreamFrame(frame: SseFrame): Delta | Done | Ignore
  classifyError(res: ProviderResponse | Error): ErrorClass  // retryable | fatal | auth | budget
}
```

Adapters are registered in one table, keyed by `ProviderId`, and the gateway core resolves one from the allowlist entry the request named. **`apps/api` does not know which adapter exists, and neither does the browser.** Both name a provider+model pair from the allowlist and receive a normalised result.

**What the adapter owns, exhaustively:** credential acquisition, request shaping, response parsing, stream-frame decoding, and error classification. Nothing else.

**What the gateway core owns, and what an adapter must therefore never contain:** the allowlist check, the jurisdiction check, the purpose allowlist, budgets and rate limits, the prompt-size cap, the timeout, the retry policy, and the call log. Each of those runs **once**, around every adapter, for every provider.

**This is a ruling (S25) and it is stated here in the strongest terms the document has**, because duplicated per-provider logic would be this project's most expensive recurring defect placed in the worst possible location. Six separate findings in the redesign came from two implementations of one idea drifting apart; `uid()` was extracted only after seven byte-identical copies. Five adapters, each with its own retry loop, its own idea of what counts as a 429, or its own call-log line, is that failure with a factor of five and a Risk story attached — the divergence would be between what the firm believes it logs and what it logs for one provider nobody tested. **An adapter that logs, or that checks an allowlist, is not a working adapter with an extra feature; it is the defect.** §14 enforces it: an adapter-boundary test asserts no module under `apps/gateway/adapters/` imports the logger, the allowlist, the budget module or the retry policy — the same shape as S14's import-boundary test, applied one level down.

### 10.3 Jurisdiction: declared, enforced, recorded, shown

**Whose decision this is, stated first because everything below is a mechanism for it.** Choosing a provider is the operator's, and it is a decision made on the contracts and data provisions that provider gives them — standard contractual clauses, a data processing agreement, negotiated retention and training terms, whatever their own legal review settled on. **The API key is the interface into that service; the guarantees live in the contract behind it, not in the key.** A firm may hold perfectly sound provisions with a US provider and a different firm may hold none. This design has no standing to decide which, and does not try to. **What it enforces is the operator's own declared policy, faithfully and without exception** — nothing here is the system protecting an operator from a choice they made deliberately.

**The vocabulary is a closed set of processing blocs, and they are deliberately not ISO country codes.** The permitted values are `UK`, `EU`, `US` and `other`. Two of those — `EU` and `other` — are not countries at all, so a set containing one ISO alpha-2 code (`GB`) alongside them would invite exactly the wrong inference: that these are country codes, that they join to country data, and that `DE` or `FR` would be valid. They are not; a German deployment declares `EU`. **`UK`, never `GB`**, and this paragraph exists because the next reader's instinct will be to "correct" it. A finer-grained vocabulary is a later decision, and it would replace the set rather than extend it.

**Every allowlist entry declares the jurisdiction its processing happens in.** Not the provider's head office and not where the account was opened — where the inference runs. `foundry/gpt-4o@uksouth` is `UK`; `openai/gpt-4o` is `US`; `anthropic/claude-*` direct is `US`; `openrouter/*` is `US` and additionally routes onward to a provider the operator did not individually choose, which is a distinct fact and is recorded as such in the entry's `dataHandling` note. These are statements of where processing occurs; none of them is a statement about whether an operator should be content with it.

**The jurisdiction set is declared by the operator, and it has no default.** It is one configuration value — `GATEWAY_ALLOWED_JURISDICTIONS` — and it ships **unset**. Not `UK,EU`; not anything. A default here would encode an assumption about one particular firm's contracts, which is exactly the assumption this design has no standing to make, and a default that happens to match a firm's policy is indistinguishable at a glance from a firm that declared it. **The gateway refuses to start when the set is unset**, naming the variable and saying what it is for. Fail-closed is not weakened by removing the default — it is strengthened, because *unconfigured* becomes an error instead of a guess. The deployment template carries `UK,EU` as a **commented example with its reasoning written beside it**, so an operator reads why the line exists and then types their own.

**The ruling (S27): the gateway refuses a jurisdiction the operator has not declared. It does not merely surface it.** The reasoning, because this is the decision most likely to be reopened:

- **Refusing is the same mechanism, not a new one.** The gateway already refuses an un-allowlisted model. Jurisdiction is a field on the allowlist entry, so enforcing it is one more predicate in a check that already exists. *Surfacing* it would create a second, weaker class of rule inside one allowlist — some entries refused, others merely annotated — and a reader would have to know which kind each was.
- **A declared policy enforced by attentiveness is not enforced.** Every serious defect on `CLAUDE.md`'s list is something incorrect presented in a way that read as correct. A badge in a picker is precisely a thing that gets read past at 17:40 on a deadline — so a policy the operator wrote down would hold only on the days everyone was concentrating, which is not what writing it down was for.
- **The person at the picker is not the person who sets the policy.** Which providers the firm has provisions for was settled with legal input, in a DPIA, in engagement terms, sometimes in the client's own instructions. A lawyer choosing a model is not amending that, and a screen inviting them to would manufacture a record of a decision they had no authority to take. **A request outside the declared set is a misconfiguration, not a decision to re-take at request time** — the fix is a configuration change by whoever owns the policy, not a click by whoever is next to the keyboard.
- **The costs are asymmetric, and only one of them is recoverable.** Refuse wrongly and a call fails loudly with a `403` naming the provider, its declared jurisdiction and the declared set — one configuration change, minutes, nothing lost. Route wrongly and the text has already gone somewhere the operator did not declare; there is no retry that un-sends it. Given that asymmetry the loud, cheap failure wins. This is `CLAUDE.md`'s opening rule applied to a network boundary, in service of the operator's policy rather than in place of it.
- **Fail closed on *undeclared*, not open.** An allowlist entry with no jurisdiction is treated as disallowed. The gateway **refuses to start** on any of three misconfigurations: the declared set unset, an entry declaring no jurisdiction, or an entry declaring one outside the set. Undeclared is not permission, and a misconfiguration must not become a system that runs and mostly works.

**Refusing does not replace surfacing; it makes surfacing honest.** Both happen, at different altitudes:

- **To the operator, where the choice is made.** The admin provider screen shows each entry's provider, model, endpoint, jurisdiction, credential mode and `dataHandling` note, and the declared jurisdiction set as an explicit, dated configuration value. Adding a provider is a deliberate act with all of that in view.
- **To the user, in the model picker.** Every allowlisted model shows its **provider and jurisdiction, always** — every entry, never a subset, and never on hover. **Ruling: the label is unconditional**, because a badge shown only on some entries makes its *absence* carry meaning, and absence carrying meaning is this project's blank-CSV-cell defect exactly. **The label is factual, not evaluative**: it says where processing occurs, in the same neutral form for every entry, and it never implies that one allowlisted option is safer than another. It cannot honestly imply otherwise — by the time a model reaches the picker the operator has already declared its jurisdiction acceptable under contracts the picker knows nothing about. The label's job is that a lawyer is never *surprised* by where their client's text went, not that they approve it and not that they rank it.
- **To the reader of a report.** The run records what was used (§6.5) and the export can state it. A firm that ran forty reviews in one jurisdiction and four in another must be able to tell which is which afterwards; a single sentence composed from current configuration would be a claim about the wrong runs.

**A firm must never be able to believe its client's text is processed only where it declared, while some of it routes elsewhere.** That sentence is the requirement; every bullet above is a mechanism for it, and if a mechanism is trimmed the requirement is what to check against.

### 10.4 Streaming has five surfaces now, and it is the highest-risk part of Stage 1

The suite already carries a regression for an SSE parser that **dropped the final token of every streamed answer and returned nothing at all against a server using CRLF**. That bug had one instance when there was one provider. Naively, multi-provider gives it one instance per adapter — five chances to lose the last sentence of a clause analysis, four of which nobody would exercise until a firm switched provider in production.

So the parsing is split in two, and only the thin half is per-provider:

- **One transport decoder**, in `packages/core`, shared by every adapter: byte stream → SSE frames. It owns line splitting, `\n` / `\r\n` / `\r`, chunk boundaries falling mid-frame, multi-line `data:` fields, comments and heartbeats, and the flush of a final frame with no trailing newline. **This is the code the original bug lived in, and there is exactly one of it.**
- **A per-adapter frame mapper**: frame → `Delta | Done | Ignore`. This is where providers genuinely differ (`[DONE]` sentinels versus typed events versus terminal usage frames), and it is a small pure function with no IO.

**A shared conformance suite runs over every registered adapter**, table-driven exactly as §14's `authz` suite is over routes — so **a new adapter with no fixture entry fails the build** rather than shipping untested. Its cases, at minimum: CRLF throughout; a final frame with no trailing newline; a frame split across chunk boundaries at every byte position; an empty completion; a heartbeat/comment stream; a mid-stream provider error; a stream that ends without a terminator. The assertion that matters most is the one the original defect failed: **the concatenated deltas equal the non-streamed completion for the same input, byte for byte.**

**Stage 1 should expect its bugs here.** Not in the allowlist, not in the credential handling — in the five stream mappings, because they are the part with per-provider behaviour, the part hardest to exercise against a real provider in CI, and the part whose failure is quiet: a truncated clause analysis reads as a model that had little to say. §19 carries this as a risk.

### 10.5 A deployment with no Azure is not a degraded mode

The owner's reason for pluggable providers is the small firm or individual with no Azure infrastructure. That path runs the same gateway with a keyed adapter, and **it keeps every property that makes the gateway worth having**:

- The **allowlist** applies. A local deployment does not get to accept an arbitrary model id because it is small.
- The **jurisdiction declaration and refusal** apply, unchanged (§10.3).
- The **per-call log** applies, with the same fields including provider and jurisdiction. The gateway holds no database credential (§5), so it writes structured JSON lines to stdout in every deployment — collected by Azure Monitor in Azure, and by a collector the compose file ships in a local one. **The gateway refuses to start with no log sink configured**, for the same reason it refuses to start with no declared jurisdiction set or on an undeclared entry: a deployment that fails to log would teach its operator to expect a gateway that does not, and that expectation would eventually be carried into a deployment where it mattered.
- The **credential rule** applies: the key lives in the gateway's secret, not in the app, not in the database, not in a browser.

What it does not get is the no-key property of §1, and the README and admin screen say so in that deployment rather than repeating a sentence that is only true elsewhere. **Retention, budgets and rate limits are also not optional locally**; the numbers are configuration and the mechanisms are not.

**And the development stack is the same stack** (§5.1), which is what makes each of the four properties above something a developer exercises on a laptop rather than something the design merely asserts about an environment nobody can run.

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

### 12.0 Which guarantees are architectural, and which are a deployment's own

**A Risk reviewer needs to know which of these they verify once and which they must check per environment.** Before the 2026-08-28 revision every claim in this section was of the first kind, so the distinction did not need drawing. Now it does, and drawing it badly — presenting a configuration as a property — is how a firm ends up believing something about a deployment that is only true of a different one.

| Guarantee | Kind | How it is verified |
|---|---|---|
| The gateway is the only component permitted to egress; nothing else can call a model | **Architectural** | Once, from infrastructure-as-code plus the Spike 2 egress test. Unchanged by this revision, and still the design's central claim. |
| No credential ever leaves the gateway — not to `api`, not to the browser, not to the database | **Architectural** | Once, from the topology and §14's tests. True in every deployment. |
| Every model call is logged with its purpose, provider, model and jurisdiction, and no content | **Architectural** | Once, from the gateway's log schema and §14's redaction and completeness tests. |
| A user cannot name a model; only allowlisted provider+model pairs are callable | **Architectural** | Once, from the allowlist check. |
| The gateway routes only where the operator declared, refuses anything outside that set, and refuses to start when the set is unset or an entry is undeclared | **Architectural** | Once, from S27's startup and per-call checks. **What is architectural is the enforcement, not the contents of the set** — the set itself is the operator's declared policy, and is the "which providers, and therefore which subprocessors and which jurisdictions" row below. |
| Authentication is OIDC against a configured issuer, and **no configuration disables it** — there is no bypass flag, no anonymous mode and no trusted header | **Architectural** | Once, from §7's configuration surface and §14's `auth` suite, which asserts that no code path yields an authenticated principal without a validated token. The API also refuses to start with no issuer configured (S28, S29). |
| **Which issuer** | **Deployment choice** | **Per environment**, from one configuration value a reviewer reads beside the database and storage endpoints. Entra ID in the firm deployment; a container in local development. A non-HTTPS issuer that does not resolve to loopback is refused at startup. |
| **The code path is the same in every environment**, and the divergences are the enumerated list in §5.1 | **Architectural**, and mechanically checked | Once, from §18's three checks: no module branches on the environment; the configuration key diff equals §5.1's table; the same suites run against both environments. |
| **No key exists at all** | **Deployment choice** | **Per environment.** True of an Azure-only deployment using managed identity. False of any deployment using OpenAI, Anthropic or OpenRouter directly, where an operator key exists inside the gateway. |
| **Which providers, and therefore which subprocessors and which jurisdictions** | **Deployment choice** | **Per environment**, from the provider configuration and the call log — Q5 below. |
| **Where inference is processed** | **Deployment choice** | **Per environment**, and per run: the run row records what was actually used (§6.5). |
| Provider-side retention and training posture | **Deployment choice**, and time-varying | **Per environment and per review interval** — §10.1. |

**One recommendation, and its scope is narrow, stated so a reviewer is not left to infer it:** where a provider supports managed identity, use it — a firm with Azure infrastructure configuring Foundry or Azure OpenAI that way gets the credential rows above in their strongest form, because no key exists to steal or rotate. **That is a recommendation about credential custody and nothing else.** It is not a recommendation about *which* provider a firm should contract with, or in which jurisdiction: that turns on the contracts and data provisions the operator holds, which this document cannot see. Every other configuration is supported, logged and honestly described; what it does not get is the no-key row, and this document does not let a keyed deployment be presented as though it did.

**1. Where does client data live?**
In the firm's own Azure subscription, UK South. Document metadata, extracted text, findings, playbooks and the audit log in Azure Database for PostgreSQL Flexible Server (encrypted at rest, private endpoint, no public network access). Original document bytes in Azure Blob Storage (private container, no anonymous access, service-side encryption, private endpoint). Nothing persists in the browser except a rendered view and a short-lived Entra token; browser-local persistence is retired and the old IndexedDB database is removed after §13's migration.

**This now includes precedent documents** (§11.1) — the "Learn from redlines" inputs, which were previously read in the browser and stored nowhere. A Risk reviewer should be told this explicitly rather than left to infer it from "documents", because a precedent set is the one place in this app where **another client's** executed documents are likely to be held, brought in as house-rule evidence rather than as work on the matter they belong to. They are stored in the same database and container as everything else, distinguished by `document.kind` and separated in the UI, and they are the reason §17 Q3 now asks a retention question the matter-file schedule does not answer.

**2. Who can access it?**
In the firm deployment: named members of the firm's Entra tenant who are in one of three mapped security groups. There is no password login, no shared key, no user API key, no anonymous link, and no external sharing. **That sentence is about credentials that grant a *person* access, and it is unconditional.** A provider credential, where the deployment has one, is a machine credential held only by the gateway (§10, §12.0): it authenticates the gateway to a model provider and grants no access to this system, to a document, or to a record. The two are named separately here because a reader who collapses them will either over-claim ("no keys anywhere") or under-claim ("there are keys, so someone could log in with one"), and both are wrong. Access is removed by Entra group removal or account disable: HTTP access ends at the next token refresh (issuer-configured; ≤ 60 minutes in the Entra deployment) and WebSocket connections for a disabled user are closed immediately by the server. Infrastructure access (DBA, blob) is Azure RBAC with PIM approval and is recorded in Azure activity logs, outside the application's control.

**A reviewer will ask whether a development configuration could be deployed by accident. It cannot, and the reason is structural rather than procedural** (S28, S29). **There is no configuration that disables authentication — there is only a different issuer.** The issuer is a single deployment configuration value sitting in the same file as the database and storage endpoints, so a reviewer inspects it exactly as they already inspect those; the API refuses to start with no issuer, and refuses a non-HTTPS issuer that does not resolve to loopback, so a deployed environment pointed at a development issuer fails at startup rather than serving requests. The seeded local realm does carry usernames and passwords — they are **Keycloak's, not the application's**, they never leave the compose file, and they are a development dependency rather than a deployed component. **The application holds no credential in any environment**, which is the property §7 and S10 actually assert and which the fourth revision leaves exactly where it was.

**3. What is logged?**
Two logs, deliberately separate. **`audit_event`** records who did what to which record: every assignment, every publish, every export, every document added or deleted, every role change, every run started or cancelled, every net position confirmed or amended. It is append-only by database grant, not by convention (S11) — the application role holds `INSERT` and `SELECT` and nothing else. **The gateway call log** records metadata for every model call and no content (§10). Application logs never contain document text; a redaction test enforces it (§14).

**`finding_disposition_event` is the third — and it is a log, not a convenience.** Every change to a finding's disposition, in either direction, with the state it came from, the state it went to, the reason where one exists, whether it was a human act or a re-run reset, who, and when. It is held to the same insert-only grant as `audit_event`, and it is what makes "who says this was checked, and as of when" answerable at all now that a disposition can change (§6.3.1).

**It is deliberately *not* also written into `audit_event`, and that is a ruling (S22).** Two append-only records of the same fact is this project's most repeated defect — two implementations of one idea, drifting — in the worst possible location: the divergence would be between the history a lawyer reads on the card and the history the firm exports for an audit, and the audit export is precisely the artefact nobody re-reads until it matters. So a disposition change is recorded once, in the table the card reads, and the audit export and activity feed read that table alongside `audit_event` rather than a copy of it. `audit_event` carries every other kind of act; the join is a `UNION` in one query, which is a smaller thing to get right than two writers staying in agreement forever.

**4. What is retained, and for how long?**
Documents, reviews and findings until the firm deletes them; deleting a matter cascades to its documents' rows and their blobs. Audit log: 7 years by default — **§17 Q3, the firm's retention schedule decides.** A finding's disposition history is retained **for as long as the finding**, not on the audit log's clock: it is what the finding's current state means, and a finding outliving the record of how it got there would leave "Verified by R. Okafor" standing with nothing behind it. Gateway call log: 90 days. Realtime event outbox: 7 days (a reconnection buffer, not an archive). Postgres point-in-time backups: 35 days. **Provider-side retention is the configured provider's, not ours, and it is answered per provider from its allowlist entry's `dataHandling` note (§10.1)** — for Foundry, up to 30 days of abuse-monitoring retention unless the exemption is granted; for OpenAI, Anthropic or OpenRouter, whatever that provider's current terms say, which must be read at implementation time rather than taken from this document. **§17 Q4.** The one thing the design guarantees here is that the question is answerable per provider and per call rather than in general: the call log says which provider saw what, and when.

**Precedent documents** (§11.1) are retained until the firm deletes their precedent set. They belong to no matter, so the matter-file schedule does not reach them, and a house position adopted from a set may be relied on long after the set itself would have been disposed of — **§17 Q3 asks this explicitly.** Deleting a set deletes its documents' rows and blobs by the same cascade a matter uses; positions that cited it then say their basis is no longer held, rather than showing an empty evidence panel.

**5. Who are the subprocessors?**
**This answer is now a property of the deployment, and the honest form of it is that the gateway records it and can report it** — not a fixed sentence that would be true of one firm's configuration and false of another's.

**In every deployment this design specifies:** Microsoft, for the hosting, storage and identity — Azure Container Apps, Azure Database for PostgreSQL, Azure Blob Storage, Microsoft Entra ID, Azure Monitor. Client data at rest and the identity layer are Microsoft-only regardless of which model provider is configured, and **the multi-provider revision changes nothing about either.** (Local development substitutes the storage half with Azurite and the identity half with a container — but it is a *development environment*, not a deployment, and it introduces no subprocessor because nothing of a client's leaves a laptop; §5.1. A fully self-hosted **production** deployment on non-Azure infrastructure is a different question, is not answered by that, and is now §17 Q13 — named here so the qualifier above is read as bounded rather than as an oversight.)

**For inference, whoever the operator configured**, from: Azure AI Foundry, Azure OpenAI, OpenAI, Anthropic, OpenRouter. The answer for a given environment comes from two places, and a Risk reviewer should be given both:

- **What is configured** — the allowlist, listing each provider+model pair with its endpoint, declared jurisdiction, credential mode and `dataHandling` note (§10.1), plus the declared jurisdiction set. This is the firm's own policy, written down: which providers it holds provisions for, and on what terms.
- **What was actually used** — the gateway call log, aggregated by provider and jurisdiction over any period. This is what the firm actually *did*, and it is the half a reviewer cannot get from a configuration file. "We declared UK deployments only" and "every one of the 12,400 calls last quarter went to a UK deployment" are different statements, and the second is the one that is evidence.

Both are exportable by an admin, together, as the subprocessor report.

**What the system asserts here, precisely, because it is easy to over-read.** It asserts that inference went where the operator declared it should, that it can prove that per call, and that a run's record of where it went cannot be rewritten later. **It asserts nothing about whether a given provider is a good one to have contracted with.** That judgement is the firm's, it rests on the provisions the firm negotiated, and the system's contribution to it is the `dataHandling` record the operator wrote and the call counts beside it.

**On jurisdiction, plainly, as facts about where processing happens.** OpenRouter, Anthropic direct and OpenAI direct are **US-processing**, and OpenRouter additionally routes onward to a provider the operator did not individually select. Foundry and Azure OpenAI can be pinned to a UK or EU region. A firm wanting a UK/EU-only answer to this question allowlists only UK/EU-pinned entries and declares its jurisdiction set accordingly; **a firm holding standard contractual clauses and a DPA that cover US processing declares `US` and gets the same enforcement of that policy, and the same evidence for it.** In either case the gateway refuses anything the operator did not declare (§10.3, S27), including an entry added later by mistake. Where a desired model has no deployment in a declared jurisdiction, it is not allowlisted and the app cannot use it — a deliberate consequence of the operator's own policy rather than an assumption baked into the design. **The design ships no answer to this question and no default set**: the template carries a commented example with its reasoning, the operator declares, and the gateway refuses to start until they have (§10.3).

**6. What happens on breach?**
The gateway holds nothing **at rest**; compromising it exposes calls in flight, not the archive, and it holds no credential that reaches Postgres or Blob. Postgres and Blob have no public endpoint.

**What compromising the gateway additionally yields depends on the deployment, and it is stated separately for that reason.** In an Azure-only deployment using managed identity there is no key to take: the attacker gets a token bound to that identity, revoked by removing the role assignment. **In a keyed deployment they get the operator's provider API key**, which is why response for such an environment adds one step — rotate the provider key at the provider, not only in Azure — and why the key must be held in a secret store that supports rotation without a redeploy (§10). The blast radius of a stolen provider key is spend and a third party's model quota, not client data at rest; it is nonetheless a real credential and this answer does not round it to zero.

Response: disable the Entra app registration (all sessions end at next refresh; WebSockets are closed), rotate managed-identity role assignments, **rotate any configured provider key**, and read `audit_event` **and `finding_disposition_event`** for the actor's complete trail. **Both being append-only with no `UPDATE`/`DELETE` grant is what makes that trail evidence rather than a claim** — and the disposition history is the half that answers the question a compromised account raises here: *did anyone touch the professional judgements?* Under the superseded model an attacker could only add a verification; under a mutable disposition they could change one, and the history is why that is detectable rather than merely feared.

**7. What happens on offboarding?**
Disabling the Entra account ends access. The person's authored records remain, attributed: a verification is a professional judgement someone made, and a report that silently loses its reviewer is a report that lies. `app_user.status = 'disabled'` renders as "A. Gray (no longer active)". **Deleting a user is not offered**, because it would either orphan or falsify the verification chain. That has a GDPR-erasure consequence and it is **§17 Q6** for the firm's DPO — not a decision this design makes on its own.

**The 2026-08-28 revision widens this, and the widening is not cosmetic.** Under the superseded model a leaver's name appeared on the verifications they still held — a bounded, shrinking set, since a re-run deleted the row. Under a mutable disposition, a leaver's name appears on **every change they ever made**, in `finding_disposition_event`, including ones a colleague has since superseded and ones a re-run reset away. Those rows are permanent by grant (S11): they cannot be updated or deleted by any application role, which is the property that makes them evidence. So the question the DPO is being asked is larger than it was, and §17 Q6 is restated to ask it accurately rather than leaving the DPO to discover the difference. A pseudonymisation path, if one is required, has to act on `app_user` — replacing a display name with a stable pseudonym while the `by_user_id` foreign keys stay intact — because rewriting the history rows is the one remedy this design cannot offer without destroying what the history is for.

---

## 13. Migration and sequencing

Staged so the app keeps working at every point, and ordered so the Risk posture improves before any multi-user surface exists.

**This document is one design, but it is not one implementation plan.** Each stage below is its own spec-to-plan-to-implementation cycle, exactly as sub-projects A through G each were; §20 sizes them. Nothing here should be planned as a single unit of work, and a stage that turns out larger than its estimate is decomposed further rather than compressed.

**Stage 0 — `packages/core`.** Convert to an npm-workspaces monorepo and move the domain logic (§5) with no behaviour change. Every test that moves with it must still pass unchanged; that is the acceptance criterion. An import-boundary test forbids `apps/*` from reimplementing anything `packages/core` exports (S14) — this project's most repeated defect is two copies of one idea drifting, and a client/server split is that hazard at scale.

**Stage 1 — the gateway, while the app is still browser-only.** `openrouter.ts` becomes a `ModelClient` interface with one implementation pointing at the gateway through a minimal `api` whose only route is the inference proxy. The browser signs in — OIDC authorization code with PKCE against the configured issuer (§7). Everything else still lives in IndexedDB.

**The local OIDC issuer ships in this stage, not later, and the sequencing is forced rather than chosen.** Stage 1 is the first stage that requires a signed-in user, and there is no bypass to stand in for one (S29) — so without the issuer, Stage 1 is a stage nobody can run on a laptop. It ships with its **full seeded set** — a reviewer, a partner, an admin, and a user in no mapped group — because seeding one account now and three in Stage 3 is two edits to one file for no benefit, and because the no-role account tests a Stage 1 behaviour (§7). Roles are not yet *enforced* here; that is Stage 2. The accounts exist from the start so nothing in Stages 2 to 4 has to invent them.

**The compose stack of §5.1 lands with it**, gaining each dependency in the stage that first needs it, along with the configuration-boundary test and the configuration-diff check that make §5.1's divergence table verifiable rather than aspirational (§18). Both are cheap now and retrofitting is not: the first module that reads `process.env` outside its configuration module will be written the week the split lands, for the same reason S14 gives about `packages/core`.

**Stage 1 now also builds the provider-adapter boundary, and building it here is deliberate.** The five adapters, the registry, the allowlist of provider+model pairs, the jurisdiction declaration and its refusal, and the shared stream decoder with its conformance suite (§10.2–§10.4) all land in this stage. **The boundary must exist before the second provider does**, for the reason S14 gives about `packages/core`: the first duplicated helper is written the week the split lands, and an adapter interface retrofitted around two providers that already work is an interface shaped by whichever of them was written first. Building all five in Stage 1 is not required; **building the interface, the registry, the shared decoder and the conformance suite is**, and a second adapter is what proves the first one was an adapter rather than the old code with an interface drawn round it.

**This stage is shippable and valuable on its own, and it is still the whole reason for the ordering** — but the claim it earns is now stated correctly. It deletes the per-user OpenRouter key, ends the era of a lawyer pasting a credential into a browser, and moves every model call behind **one logged, allowlisted, jurisdiction-declared egress point the firm controls** — the three things that most improve the Risk answer — *before* a single multi-user feature exists to argue about. **Where the firm configures Foundry or Azure OpenAI with managed identity, it additionally moves inference into the firm's own tenant, in a region the firm chooses, with no key in existence.** That last sentence is about a configuration, and Stage 1's own definition of done (§18) checks it as one.

**Stage 2 — storage and auth.** Postgres and Blob behind the nine repositories' existing interfaces. **R3's seam holds a second time**: those repositories are already Promise-returning, precisely so a storage swap would not touch callers. Sign-in becomes the real gate; roles are mapped from the issuer's group claim into `role_mapping`; `app_user` replaces the local profile, keyed by `(issuer, subject)` (§6.5). The seeded local accounts of Stage 1 acquire their roles here, and the role table is therefore exercised against both issuers from the day it exists. Behaviour stays single-user. Browser-local mode is retired at the end of this stage, and §13.1's uploader ships with it.

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

**The 24 openrouter tests split.** The client interface survives with a new transport; the retry-policy tests move to the gateway's own suite, where they belong, and are joined by: the allowlist refuses an unknown provider+model pair; the purpose allowlist refuses an unknown purpose; **no log line contains prompt or completion content**; a credential failure — a managed-identity token failure or a rejected operator key — produces a loud 503 naming the provider and never an unauthenticated call, a different credential, or a different provider.

**The multi-provider gateway adds four suites of its own, and they are Stage 1 work:**

| Suite | Covers |
|---|---|
| `adapterConformance` | table-driven over **every registered adapter**, so a new adapter with no entry fails the build: request shaping round-trips; error classification maps each provider's 429/5xx/4xx to the right class; **the concatenated stream deltas equal the non-streamed completion byte for byte**; CRLF throughout; a final frame with no trailing newline; a frame split at every chunk boundary; an empty completion; heartbeats and comments ignored; a mid-stream error surfaced rather than swallowed; a stream ending with no terminator fails loudly |
| `adapterBoundary` | no module under `apps/gateway/adapters/` imports the logger, the allowlist, the budget module, the jurisdiction check or the retry policy (S25) — the import-boundary shape of S14, one level down, so per-provider logic cannot grow where it must not |
| `jurisdiction` | a pair whose declared jurisdiction is outside the declared set is refused with a `403` naming provider, jurisdiction and declared set, and **no request reaches the provider**; an entry declaring no jurisdiction is refused; the gateway **refuses to start** on any of the three misconfigurations — **an unset jurisdiction set**, an undeclared entry, an entry outside the set — and on a missing log sink; **no default set is applied when the variable is absent**, asserted directly (load configuration with it unset and assert a startup failure naming the variable, not a running gateway that allows `UK,EU`); the picker labels every model with provider and jurisdiction in the same form, with no entry unlabelled and no entry labelled differently for being outside any particular jurisdiction; a run row stores the jurisdiction the gateway returned and does not re-derive it from configuration |
| `credential` | no log line, error message, metric label, response body or admin endpoint contains a provider key, asserted over every adapter and every error path; the admin endpoint reports only whether a credential is configured and when it was rotated |

**The `authz` suite gains the admin provider routes**, since provider configuration is an admin action and a route with no entry fails the build.

**The 14 App tests keep this project's harness.** R-B8 holds: `createRoot`/`act` via `src/test/mount.tsx`, no `@testing-library/react`. What changes is the seam beneath them — a DB mock becomes an HTTP-and-WebSocket mock. **MSW is added** for this, because hand-rolling both a `fetch` stub and a WebSocket fake would be the third copy of something (S14's own rule, applied to test infrastructure).

**New suites:**

| Suite | Covers |
|---|---|
| `realtime` | reconnect replays from the cursor and reaches `caught_up`; a cursor beyond retention forces `resync_required` **and the UI renders the stale state while it refetches**; an out-of-order or duplicate event is dropped by version guard |
| `runLifecycle` | an expired lease is re-leased; cancel leaves no cell in `pending`; a cell exhausting attempts becomes `error` with its text; a stale heartbeat marks the run `failed` |
| `authz` | table-driven over every route × every role, so a new route with no entry fails the build |
| `auth` | **no code path yields an authenticated principal without a validated token** — searched for, and asserted route by route, table-driven like `authz` so a new route with no entry fails the build; the token validator is exercised against both issuers' discovery documents and rejects a token minted by the other; a missing group claim is reported as overage and not as "in no mapped group"; the API refuses to start with no issuer, and with a non-HTTPS issuer that does not resolve to loopback (S28, S29) |
| `configSurface` | **no module branches on the environment** — no `isLocal`, no `if (dev)`, no `NODE_ENV` read outside build tooling — and no module outside each app's single typed configuration module reads `process.env`; and the set of configuration keys that differ between the local and deployed configurations is **exactly** §5.1's enumerated list, so a key that differs and is not in the table fails the build, and so does a table row with no key behind it. The table therefore cannot rot into optimism (S30). *These two assertions live here together and nowhere else: they are one idea — what is allowed to vary between environments — and splitting them across two suites is the drift this project keeps paying for.* |
| `egress` | an integration test asserting `api` cannot reach the model endpoint directly (Spike 2 establishes how) — **run against both the compose network and the deployed environment**, since §5.1 row 7 is the one place the mechanism differs and a denial proven in only one of them is evidence about only one of them |
| `loadStates` | in-flight, failed, empty and stale each render distinctly, on every screen that loads from the API |
| `migration` | the browser uploader reports what it moved and what it could not; a partial migration never reports success; the local copy is not deleted |
| `disposition` | a card never shows a disposition without its actor and time; a changed disposition shows that it changed and names the state it came from; a re-run reset renders as a re-run and not as a person un-verifying; a stale client's disposition controls are disabled and say why; an export carries its "as at" instant and its changed-from facts |
| `precedentCopy` | the intake screen states the storage promise **once**, in its current true form, and the string asserted by the test is the one in `privacyCopy.ts` — so a future change to the promise breaks a test rather than silently disagreeing with the disclosure module |

**Mutation-test, without exception:** the re-run reset (now transactional, including its history row), the stale-change refusal, the disposition history's insert-only grant, the `resync_required` path, the audit log's insert-only grant, the egress restriction, the jurisdiction refusal, the stream decoder's final-frame flush, and — added by the fourth revision — **the absence of an authentication bypass**: add a `SKIP_AUTH` path and the `auth` suite must fail. **The fifth revision adds a second absence: the absence of a default jurisdiction set.** Reintroduce `?? 'UK,EU'` in configuration loading and the `jurisdiction` suite must fail — a default is the one mutation that leaves every happy-path test green while silently substituting the spec author's guess for the operator's declared policy. Mutation-testing an *absence* is unusual and it is deliberate; it is the only way an absence stays true (S29, S27). Break each, confirm a test fails, restore. A green suite is not evidence.

**Two more specific mutations to try, added by the multi-provider revision**, both of which have an obvious wrong implementation that passes a careless test: (c) make the jurisdiction check log a warning and proceed — every happy-path test still passes, and the only test that fails is the one asserting no request reached the provider, which is why that assertion is written that way rather than by checking the response code alone; (d) drop the final-frame flush from the shared stream decoder — the streamed answer is short by one token and every fixture whose last frame happens to end with a newline still passes, which is exactly how the original defect survived.

**Two of those deserve naming as the specific mutations to try**, because both have an obvious wrong implementation that passes a careless test: (a) delete the `INSERT INTO finding_disposition_event` from the re-run reset and leave the `UPDATE` — a disposition that clears without recording that it cleared; (b) make the stale-change path apply the write and *then* return the current row — a UI that looks correct and a database where the later click silently won. Neither is caught by asserting the happy path.

**Browser verification is still mandatory and still needs two accounts — and as of the fourth revision it no longer needs a deployed environment to get them.** The claims this design adds — presence, live updates, a Partner overriding a trainee's verification and the card immediately reading the Partner's name, the loser of a race being told rather than silently overwritten, assignment reaching a person — cannot be verified by one person on one machine, and unit tests will not catch what breaks. The override case in particular is a two-account, two-browser check: **verify as one user, override as the other, and confirm the first user's card changes attribution without a reload.**

**The seeded local issuer supplies those accounts** (§5.1), so every one of these checks is reproducible with two browser profiles on one laptop. **The deployed two-account pass is still required** (§18.9): what the local run cannot prove is §5.1's own list, and Entra's group claim is on it. Neither substitutes for the other — the local run is where a defect is *reproduced and fixed*, the deployed run is where the divergences are exercised. `CLAUDE.md`'s rule applies to both: if it cannot be done, say so plainly rather than implying it was.

---

## 15. Three spikes

Each has an answer as its output, not code that is kept. None of them gates the sequencing: Stage 1 depends on none of the three.

**Spike 1 — server-side PDF page rendering.** Can `pdfjs-dist` v6 render page images under Node 22 with `@napi-rs/canvas`, at acceptable speed and fidelity, for a real scanned contract? Output: a go/no-go with a worked example and a timing. **Fallback if no:** Azure AI Document Intelligence OCR at ingest, in-region, which removes the image path entirely but adds a subprocessor to §12 Q5. Gates §11 only.

**Spike 2 — provable egress restriction.** In an Azure Container Apps environment, can `api`'s outbound access be denied to the public internet while it still reaches Postgres, Blob Storage and the gateway over private endpoints — and can that denial be **asserted by an automated test** rather than by reading configuration? Output: the network configuration and the test. This spike matters more than its size suggests: it is the difference between the design's central claim being architecture and being a promise.

**The multi-provider revision widens this spike's second half without changing its first.** `api`'s denial is unchanged. What changes is the *gateway's* own egress: under Foundry-only it needed one private endpoint and no public route at all, whereas a keyed provider is reached over the public internet. So the spike must also establish how to constrain the gateway to an **allowlist of provider hostnames** — not merely "the gateway may egress" — because an SSRF or a dependency compromise in the one component that is allowed out is otherwise unbounded. Output gains: the hostname-allowlist mechanism and a test that a request to any other host fails. *This is a real widening of Spike 2's scope and is called out rather than absorbed silently.*

**And it now has a local half.** §5.1 row 7 is the one divergence where the mechanism differs between the two environments, so the spike's output must include the compose-network equivalent of the denial and the same `egress` test running against both. A denial proven only in Azure would leave the local stack quietly permissive — and a developer's laptop is where the SSRF would first be written.

**Spike 3 — WebSocket through Container Apps.** How do WebSockets behave through Container Apps ingress with scale-to-zero and more than one replica, and does fan-out therefore need Redis from day one? Output: a yes/no on Redis and a minimum-replica recommendation. Gates §8's implementation choice, not its protocol.

---

## 16. Rulings

Recorded in `rulings.md`'s format. Each carries its cost if wrong.

- **S1. Four workspaces — `packages/core`, `apps/web`, `apps/api`, `apps/gateway` — and `api` may not egress.** The topology is the security control. *Cost if wrong: a monorepo and one extra container to operate for a firm-sized deployment; the alternative makes the design's central claim unprovable.*
- **S2 (rewritten 2026-08-28, on the owner's decision). The gateway is the only egress, and it is the only component that holds a provider credential. No credential ever leaves it, and every call is logged with its provider and its jurisdiction, whichever backend is configured. Separately: an Azure-only deployment authenticating by Entra managed identity has no key at all, and that is the recommended posture for a firm with Azure infrastructure.** *Cost if wrong: the two sentences are separate because merging them states a security property that is false for any deployment using OpenAI, Anthropic or OpenRouter directly. If they are ever merged — in a README, a slide, a Risk answer, or a later edit to this spec — the firm is told there is nothing to steal in a system that holds an operator API key. That is not an overstatement of a benefit; it is a false control, and a false control is worse than a missing one because nobody looks for it. The credential-custody half is architectural and cheap to keep true; the no-key half costs a firm without Azure nothing it ever had.*
  - *Superseded, 2026-08-28: the original S2 read "The gateway is the only egress, and it authenticates to Foundry by Entra managed identity. **There are no provider API keys anywhere in the system**", with the cost "nothing runs where managed identity is unavailable, and local development without Azure credentials needs a stubbed gateway". That claim was true **only** of the Azure-managed-identity case, which was the only case the design then had. The owner has decided the gateway is multi-provider — Foundry, Azure OpenAI, OpenAI, Anthropic, OpenRouter, chosen by the operator at deploy time — expressly so that a firm or individual with no Azure infrastructure can run it. The original cost line turned out to name the exact problem the owner then solved. Recorded rather than deleted, so a reader of an earlier draft can see that the unconditional no-keys claim was retired deliberately and not lost in an edit.*
- **S3. Findings become rows keyed `(review_id, findings_key, clause_id)`, not a JSON blob on the review.** *Cost if wrong: a larger migration and more SQL than a `jsonb` column; keeping the blob makes concurrent writes lose work with nothing on screen to show it, which is not a cost, it is the defect.*
- **S4 (rewritten 2026-08-28, on the owner's decision). A finding carries one current disposition (`unchecked` / `verified` / `flagged` / `rejected`) and a complete append-only history of every change to it. Any authorised user may change it in any direction at any time; nothing is locked by having been verified once; a change against a stale version is refused rather than applied.** *Cost if wrong: a colleague can move a judgement you made, and the only thing standing between that and a quiet overwrite is the history being written, shown on the card and carried into the export. If the history is skipped, weakened, or shipped a stage later than the mutability, the app tells a lawyer "verified" with no way to find out by whom, when, or over what — which is worse than the model this replaced, not better. The three of them are one feature.*
  - *Superseded, 2026-08-28: the original S4 read "a finding carries at most one verification (insert-once, first wins) plus append-only challenges", with the cost "a person who verified in error cannot un-verify without a partner override (§17 Q1)". The owner has decided that a Partner may override and that a disposition may change from verified back to any other state at any time, so insert-once is no longer the shape. `finding_challenge` folds into the disposition; `withdrawn_at` disappears. Recorded rather than deleted, so a reader of an earlier draft can see the position changed.*
- **S5. `carryHumanState` and `findingMerge.ts` are deleted; the re-run reset becomes one transaction and is not deleted.** *Cost if wrong: none identified — the merge exists only to defend against a whole-object write that no longer happens. Deleting the reset instead would let an export claim a human checked text they never saw.*
- **S6. Presence is never persisted and locks nothing.** *Cost if wrong: presence is lost on an api restart and rebuilds within one heartbeat.*
- **S7. WebSocket with a monotonic event cursor, replay on reconnect, and an explicit `resync_required` that the UI shows.** *Cost if wrong: a 7-day outbox costs storage; without the cursor a reconnected client diverges silently, which is the network-era version of every defect on `CLAUDE.md`'s list.*
- **S8. No optimistic UI for any human-authored state. Own writes render from the HTTP response; others' arrive as pushes; echoes are dropped by version guard.** *Cost if wrong: a verify click has a perceptible round trip, exactly as R-B2 accepted a perceptible disk write.*
- **S9. `workspace_id` on every table from day one; one workspace seeded.** *Cost if wrong: one unused column per table and one predicate per query, in exchange for a second tenant never being a schema migration.*
- **S10 (amended 2026-08-28). Three roles from the configured issuer's group claim; no per-matter ACLs, no custom roles, no deny rules.** *Cost if wrong: if the firm later needs matter-level confidentiality (a conflicts wall), that is a real addition — a `matter_access` table and a predicate on the matter queries, not a redesign, because everything already scopes by workspace.*
  - *Amended, 2026-08-28: S10 originally read "three roles from **Entra** groups". The owner's fourth decision makes the issuer a configuration value — Entra ID in the firm deployment, a seeded container in local development — so the roles come from a **configured group claim** rather than from Entra specifically. **This is a generalisation, not a reversal**, and the distinction matters: the three roles, the group-to-role mapping, the absence of ACLs, deny rules and custom roles, and the refusal of SAML, Okta and any application-held password are all unchanged. The only thing that moved is which issuer emits the claim. Recorded rather than edited away, so a reader does not conclude that "no SSO beyond Entra" (§4) was quietly abandoned — it was not. **A second issuer is not a second mechanism**, and S28 is the ruling that keeps it from becoming one.*
- **S11. The audit log is append-only by database grant, not by convention.** *Cost if wrong: a mistaken audit row cannot be corrected, only annotated by a later row — which is what append-only means and why it is evidence.*
- **S12. Document bytes in Blob Storage; page images still never persisted, regenerated per run and held in an in-process LRU.** *Cost if wrong: a scanned document's images are re-rendered for each run rather than cached across runs — seconds, and R2's original reasoning, on a server.*
- **S13. Browser-local mode is retired. A one-time uploader migrates the existing browser's data, reports what it could not move by name, and never deletes the local copy.** *Cost if wrong: a stale local copy sits in one browser for a release or two.*
- **S14. `packages/core` is the single home for domain logic, enforced by an import-boundary test.** *Cost if wrong: an occasional awkward extraction to satisfy the boundary; the alternative is this project's most repeated defect, at client/server scale, where the two copies cannot even be read side by side.*
- **S15 (amended twice, 2026-08-28). Models are an admin-configured allowlist of provider+model pairs, each declaring the jurisdiction its processing happens in, and the operator declares an explicit jurisdiction set the gateway enforces, with no default shipped. A user still cannot enter a model id.** *Cost if wrong: a model whose provider or region the firm has not declared is unavailable, and adding one is a configuration change plus a Risk sign-off — which is the point, and is unchanged. The property that a user cannot name an arbitrary egress destination is the half that must not move; the shape of the allowlist entry is the half that did.*
  - *Amended, 2026-08-28: S15 originally read "an admin-configured allowlist of **Foundry deployments**, region-pinned to UK/EU", which assumed one provider and inferred jurisdiction from an Azure region name. With five possible providers, region is no longer a property the design can read off the entry, so each entry **declares** its jurisdiction and the allowed set is explicit configuration rather than a hard-coded UK/EU rule (S26, S27). Recorded rather than deleted: a reader must be able to see that "UK/EU-pinned" moved from an assumption to a configured, enforced, per-deployment fact.*
  - *Amended again, 2026-08-28 (Revision 3): the first amendment said the owner's UK/EU constraint "becomes what the shipped deployment template configures". It does not. The template ships **no** jurisdiction set — only a commented example — because a shipped default is an assumption about one firm's contracts wearing the clothes of a decision. The operator declares the set and the gateway refuses to start until they do. What is unchanged: a user cannot enter a model id, and every entry declares its jurisdiction.*
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
- **S25 (2026-08-28). One `ProviderAdapter` interface and one registration point. An adapter owns credential acquisition, request shaping, response parsing, stream-frame mapping and error classification — and nothing else. The allowlist check, the jurisdiction check, the purpose check, budgets, the prompt-size cap, the timeout, the retry policy and the call log live in the gateway core and run once, around every adapter. Adding a sixth provider touches the registry and no call site, and an import-boundary test forbids an adapter from reaching the core's concerns.** *Cost if wrong: an interface that occasionally makes a provider's quirk awkward to express, and one boundary test to keep green. The alternative is five parallel implementations of one idea — this project's most expensive recurring defect, at a factor of five, in the component whose whole purpose is to be the one describable egress. The divergence would be between what the firm believes it logs, retries and allowlists and what it actually does for the one provider nobody exercised, and it would surface the day a firm switched provider in production. An adapter that logs, or checks an allowlist, is not a working adapter with an extra feature; it is the defect.*
- **S26 (2026-08-28, amended same day). Every allowlist entry declares its processing jurisdiction and carries a dated `dataHandling` note recording the terms the operator agreed with that provider. Provider, model and jurisdiction are returned on every gateway response, written on every call-log line, and stored on the `run` row as a snapshot rather than re-derived from current configuration. The per-call log is not optional in any deployment, and the gateway refuses to start with no log sink configured.** *Cost if wrong: three columns, three log fields and one startup check. Without the declaration, "where is privileged text processed?" stops being answerable the moment the destination becomes configuration — and without the snapshot, a firm that later changes its allowlist silently rewrites the answer for every run it already performed, which is `playbookSnapshot`'s failure applied to the one fact a data-protection question turns on. Without the logging floor, a local deployment becomes the one that quietly skips the record, and it would be the deployment least likely to have anyone checking.*
  - *Amended, 2026-08-28 (Revision 3): the `dataHandling` note is the **operator's record of the terms they hold**, not the system's assessment of a provider, and the staleness marker prompts them to re-read their own contract rather than casting doubt on the provider. The field is stored, displayed and dated; it is never graded, scored, or read by any code path that decides anything. The mechanism is unchanged; only what it claims to be is.*
- **S27 (2026-08-28, amended same day). The gateway routes only where the operator declared and refuses anything else — it does not merely surface it. An entry declaring no jurisdiction is refused; there is no default jurisdiction set and none is shipped; the gateway refuses to start on any of the three misconfigurations (set unset, entry undeclared, entry outside the set). Surfacing happens as well, at two altitudes: the operator sees jurisdiction where the choice is made, and the model picker labels every model with its provider and jurisdiction unconditionally and in the same neutral form.** *Cost if wrong: a misconfiguration fails loudly — a `403` naming the provider, its jurisdiction and the declared set, or a startup failure naming the variable — one config change, minutes, nothing lost. The opposite error cannot be undone: text that has gone somewhere the operator did not declare cannot be un-sent. The asymmetry is the whole argument, and it is `CLAUDE.md`'s opening rule at a network boundary, in service of the operator's declared policy rather than in place of it. Enforcing by warning would put the policy in the hands of whoever is at the picker: a lawyer choosing a model at 17:40 is not the person who amends what the firm contracted for, and a record of them appearing to is worse than no record. Labelling only some models would make the **absence** of a label carry meaning, which is the blank-CSV-cell defect exactly. Shipping a default set would be the same failure one level up — the spec's guess about a firm's contracts, running as though it were the firm's decision, and indistinguishable from one.*
  - *Amended, 2026-08-28 (Revision 3): as first written, S27 read as the system protecting an operator from their provider choice — "the allowed set" with `UK,EU` as a shipped default, US processing framed as a hazard, and the refusal justified as "a cross-border transfer needs firm-level consent a lawyer cannot give". The owner corrected the framing: choosing a provider is the operator's decision, made on the contracts and data provisions that provider gives them, and the API key is only the interface to a service whose guarantees live in that contract. **Every mechanism survives unchanged** — refusal, fail-closed on undeclared, startup refusal, per-call and per-run recording, exhaustive labelling. **What changed is the authority claimed**: the gateway enforces the operator's declared policy rather than a view about what a law firm ought to want, the default is removed because it encoded such a view, and the labels are factual rather than evaluative. Recorded rather than edited away, so a reader of an earlier draft can see that the removal of `UK,EU` was a deliberate correction and not a weakening of fail-closed — it is the opposite, since unconfigured is now an error instead of a guess.*

- **S28 (2026-08-28). One authentication path — OIDC authorization code with PKCE against a configured issuer — with two issuers: Entra ID in the firm deployment, a seeded container in local development. The application never special-cases Entra: the tenant check is a configured required claim, the identity is `(issuer, subject)` with the subject claim named in configuration, and roles come from a configured group claim. The browser uses a standards-only OIDC client, not MSAL.** *Cost if wrong: an OIDC client library instead of the vendor's, and one configuration block instead of a hard-coded tenant — and one genuine loss, that MSAL's Entra-specific conveniences (broker accounts, tenant discovery, its own token cache) are given up for a library that treats every issuer alike. Against that: the alternative is two sign-in paths, which is this project's most repeated defect placed at the front door, where the divergence would be between the authentication a developer tests and the authentication a firm actually runs. Note which way each choice fails. If the generalisation is wrong, it fails **loudly, at sign-in, in the environment that is wrong**. If instead the app had special-cased Entra and a second issuer were ever needed, the cost would be a rewrite of §7 rather than an edit to a configuration file — and the second issuer was needed within a day of §7 being written.*
- **S29 (2026-08-28). There is no development bypass and no configuration that disables authentication: no `SKIP_AUTH`, no anonymous local mode, no trusted header. The API refuses to start with no issuer configured, and refuses a non-HTTPS issuer that does not resolve to loopback. The absence is mutation-tested.** *Cost if wrong: a developer runs one more container. That is the entire cost. Against it, two things. First, a bypass is a **deployment liability**: the recurring industry failure is precisely such a flag reaching production enabled, and this system holds privileged client material — a control that depends on a flag never being set is a control held by discipline, and `CLAUDE.md`'s list is a record of what discipline loses to. Second, and decisive for this project, **a bypass tests a different code path from the one that ships** — the same class of error as a test that passes against unfixed code, which is the worst kind of test this project has shipped. A green local run under a bypass would prove nothing about the deployed system, which would remove the only reason to have a faithful local stack at all.*
- **S30 (2026-08-28). Local dependencies are faithful emulators of the deployed services, not near-equivalents: Azurite — Microsoft's own Blob emulator — never MinIO and never anything merely "S3-compatible"; Postgres for Postgres; Redis for Redis. Deployment-varying values are read in one typed configuration module per app; no module branches on the environment; and the divergences between the two environments are §5.1's enumerated list and nothing else, of which exactly one is a different code path (the provider adapter, already ruled by D3/S2).** *Cost if wrong: Azurite is heavier and less convenient than MinIO, one boundary test to keep green, and one configuration-diff test. The alternative is a storage layer that is "S3-shaped" rather than identical — and **"S3-compatible" is exactly the class of near-equivalence that produces a defect visible only in production**, because the local run is green and the difference is in a header, an error code, or a consistency guarantee nobody read. The same argument holds row by row: an unenumerated difference between the two stacks is a test that passes against unfixed code with a deployment attached. Enumerating the differences is what makes "it works locally" mean anything, and **the list being exhaustive is the load-bearing half** — which is why §18 checks it mechanically rather than by reading.*
- **S31 (2026-08-28). The local OIDC issuer is Keycloak, configured by a version-controlled realm import that seeds a reviewer, a partner, an admin, and a user in no mapped group.** *Criteria, and the recommendation against them: a container, standard OIDC discovery, static users carrying group claims, and small. Keycloak meets the first three and fails only the last. Dex is an order of magnitude smaller and its static users carry **no groups at all** (groups arrive only from an upstream connector), which is disqualifying when every role in §7 is read from a group claim. A configurable token mock is smaller still and worse: it mints whatever claims it is asked for, which makes it a **permissive oracle**, and testing the shipped authentication path against something that cannot refuse is S29's error wearing a different hat. Keycloak runs the real authorization-code-plus-PKCE flow, serves real discovery and JWKS, issues real refresh tokens and real expiries, and rejects a malformed request the way an issuer does. Cost if wrong: roughly 450 MB of image and some twenty seconds of cold start on `docker compose up`, paid once per developer per boot, in exchange for a local sign-in that is evidence. If it ever becomes the bottleneck, the swap is one compose service and one realm file, because §7 is issuer-agnostic by S28 — which is the point.*

---

## 17. Open questions for the owner

Not rhetorical. Each changes something in this document. **Three are now answered** — Q1, Q9 and Q11, decided by the owner on 2026-08-28. They are kept in place with their answers rather than deleted, so a reader can see what was asked, what was decided, and when.

1. **~~May a Partner override a trainee's verification, or only flag it?~~ ANSWERED 2026-08-28: yes, and more than that.** The owner: *"Partner may override a verification (and something can change from Verified, back to another state, at any time)."*
   *The recommendation in this document was flag-only*, on the reasoning that an override erases a professional judgement and leaves no trace of the disagreement. **The owner's answer removes the premise rather than overruling the reasoning**: an override erases nothing, because §6.3's append-only history keeps every superseded disposition with its actor, its time and the state it came from. The concern was right; the fix was a history, not a prohibition.
   The design goes one step past the question, deliberately and on the record: the power is **not** Partner-only, because the mechanism the owner described is mutability rather than hierarchy, and restricting it would make a trainee wait for a Partner to undo their own mistake (§7). Narrowing it later is a role check on one route.
   **Changed §2, §3, §4, §6.3, §6.3.1, §6.4, §7, §8, §9.1, §12 Q3, §12 Q4, §12 Q6, §12 Q7, §13 (Stages 3 and 4), §14, §16 (S4 rewritten, S21–S22 added), §17 Q6, §18, §19 and §20.**
2. **Does assignment notify by email or Teams, or in-app only?** In-app is the floor and is built. Each external channel adds a subprocessor and a line to §12. **Affects §4, §12.**
3. **Retention.** How long is the audit log kept (7 years is a default standing in for the firm's own schedule, not a decision this design makes)? Is a matter ever hard-deleted, or only closed? Does document retention follow the firm's matter-file policy? **And, new on 2026-08-28: how long are precedent documents kept?** They belong to no matter, so the matter-file schedule does not reach them; a set is likely to contain another client's executed documents; and a house position adopted from a set may be relied on for years after the set would otherwise have been disposed of. The trade, stated so it is not decided by default: delete the set and a position's basis becomes unresolvable (and must say so, rather than showing an empty evidence panel); keep it and the firm holds another client's documents for as long as the playbook lives. **Affects §11.1 and §12 Q4.**
4. **Provider choice and provider-side retention (§10.1) — widened by the multi-provider decision, and it is now two questions.** *(a)* **Which providers will the firm's own deployment actually configure, and what jurisdiction set does it declare?** **The design has no answer to this and ships no default** (Revision 3, S27): the owner declares it, on the strength of the contracts and data provisions they hold with each provider, and the gateway refuses to start until they have. Configuring OpenAI, Anthropic or OpenRouter directly means US processing (§12 Q5) — a fact about where inference runs, not an objection; whether the firm's provisions cover it is the owner's call, and if they do, `US` is declared and enforced exactly as strictly as any other value. *(b)* For each provider actually configured, what retention and training terms does the firm hold, and are they accepted or mitigated? This is what the entry's `dataHandling` note records. For Foundry that is the modified-abuse-monitoring exemption — apply before go-live, or accept and disclose up-to-30-day retention with possible human review. For the others it is that provider's current terms, read at implementation time. **Affects §10.1, §12 Q4, §12 Q5 and the disclosure the app itself shows.**
5. **The data currently in the owner's browser** — migrate it with §13.1's uploader, or start clean?
6. **GDPR erasure versus the disposition history — sharpened by Q1's answer, and the DPO should be asked the sharpened version.** It is no longer only "a leaver's name stays on the verifications they still hold". Under a mutable disposition, a leaver's name stays on **every disposition change they ever made** — the ones that still stand, the ones a colleague has since superseded, and the ones a re-run reset away — in `finding_disposition_event`, which no application role can update or delete, because that permanence is what makes it evidence rather than a claim (§12 Q7). The set is therefore larger than before, permanent rather than shrinking, and includes judgements the person themselves later changed their mind about.
   Does the firm's DPO accept that as a business record? If not, the only remedy this design can offer is pseudonymisation at `app_user` — a stable pseudonym replacing the display name while every `by_user_id` foreign key stays intact — because rewriting the history rows destroys the thing they exist to be. **Affects §6.3, §6.5 and §12 Q7.**
7. **One region or two.** UK South alone, or a paired region for disaster recovery? What RPO and RTO does the firm need? **Affects §5's infrastructure and §12 Q1.**
8. **A content-logging debug mode.** Should one exist at all — admin-enabled, time-boxed, itself audit-logged — or is "the gateway never logs content, full stop" the simpler thing to defend? *My recommendation is the latter*, because a mode that can be enabled is a mode a Risk reviewer must be told about.
9. **~~"Learn from redlines" (§11). Do precedent documents pass through the server to be parsed — read in memory, never written — or keep a browser-only parse path so the current README sentence stays literally true?~~ ANSWERED 2026-08-28: neither. They are stored.** The owner: *"Precedent documents can be stored server-side."*
   The question offered two ways to keep the non-storage promise; the answer declines both and changes the promise instead. That is the more useful outcome — inference re-runs without re-uploading, the workings survive the session, and a position's basis stays inspectable, which is the feature's central claim and was previously true for about as long as the tab stayed open (§11.1).
   **The cost is a sentence on a screen, and it is not optional**: `PrecedentIntake.tsx`'s "Read once to learn from. Never stored." is true today and false the moment this ships, so S24 requires it to change in the same stage and the same change.
   **Changed §2 (five rows), §4, §6.1, §6.5, §11.1 (new), §12 Q1, §12 Q4, §13 Stage 2, §14, §16 (S19 amended, S23–S24 added), §17 Q3, §18, §19 and §20.**
10. **Whether the assistant / chat feature is in scope for the server release.** It streams and it sends document text, so it is a second egress path through the gateway with its own purpose tag and rate limit. *My recommendation is to keep it* (R4's reasoning holds: it works, it declines honestly, and dropping a working feature by omission is the wrong reading of silence) — but it is work, and the owner may prefer it deferred to a later stage. **The multi-provider revision raises its cost slightly and its risk more than slightly**: it is the only token-streaming path in the app, so it is where §10.4's five stream mappings are actually exercised by a user, and keeping it means the conformance suite is load-bearing from Stage 1 rather than from whenever streaming first ships.
11. **~~NEW, 2026-08-28 — what does "running it locally" mean, and how far does it reach?~~ ANSWERED 2026-08-28: none of the three options — the question was framed wrongly.** The owner: *"I want it to work cohesively when deployed within a firm, but also make it easy for someone to build and test on their own machine for testing. So ideally best of both."*
    The question asked which **deployment mode** the local path is, and offered (a) the inference path only, (b) a single-user local build, (c) a full local deployment with a non-Entra identity provider. The answer is that **local is not a deployment mode at all; it is a development environment for the one system this document specifies** — which is why (a) is too little to build Stages 2 onward against, (b) reopens R1 for no gain and could not exercise a single collaborative feature, and (c) buys a subsystem to solve a problem the owner did not have. What the owner asked for is that a developer can build and test *the whole thing* on a laptop, and the way to give them that is to make the local stack **faithful**, not to make it a second product.
    **The mechanism: one authentication path (OIDC), two issuers** — Entra ID in the firm deployment, Keycloak locally (S28, S31). **This generalises S10 rather than reversing it**: the three roles, the group-to-role mapping and the refusal of any application-held credential all survive; only "the issuer is Entra" becomes "the issuer is configured". There is **no development bypass** (S29), because a bypass tests a different code path from the one that ships — the same class of error as a test that passes against unfixed code. The local issuer seeds a trainee, a partner, an admin and a user in no mapped group, because every collaborative behaviour in Stages 3 to 5 is unobservable with one user. Every other local dependency is a **faithful emulator** — Azurite, never MinIO (S30). The divergences are enumerated in §5.1, **exactly one of them is a different code path** (the provider adapter, already ruled by D3/S2), and §18 checks the list mechanically rather than by reading it.
    **What this does not answer, and must not be read as answering:** a *production* deployment on non-Azure infrastructure. Q11 conflated that with local development, and the owner's answer settles the second. The identity half of the first turns out to be smaller than it looked — Entra ID does not require an Azure subscription, so a firm with no Azure infrastructure still deploys against Entra with a keyed gateway — but the storage and residency half is untouched, and it is now **§17 Q13**.
    **Changed §2, §4, §5, §5.1 (new), §6.5, §7, §10.5, §12.0, §12 Q2, §12 Q5, §13 (Stages 1 and 2), §14, §15 (Spike 2), §16 (S10 amended, S28–S31 added), §17 Q13 (new), §18, §19 and §20.**
12. **NEW, 2026-08-28 — does the export state where the review was processed?** The run now records its provider, model and jurisdiction (§6.5), so an export *can* say "reviewed using `foundry/gpt-4o`, processed in the UK, 2026-08-28". Whether it *should* is a judgement about the audience: it is exactly the fact a partner cannot reconstruct later and exactly the fact a client's own data-protection terms might require, but it is also a line of machine detail in a document written for a lawyer. *My recommendation is that it goes in the export's summary block through `exportSummaryLine` alongside the "dispositions as at" instant (§6.3.1) — one sentence, in the one place export wording lives.* **Affects §6.3.1 and `findingOutcome.ts`.**
13. **NEW, 2026-08-28 — is a production deployment on non-Azure infrastructure supported, and if so, where do Postgres and the blob store live?** Q11 conflated this with local development and its answer settles only the second; this half is opened separately rather than left inside a question that now reads as closed. **The identity half is smaller than it appeared**: Microsoft Entra ID does not require an Azure subscription, so a firm with no Azure infrastructure can still deploy against its own Entra tenant with a keyed gateway (D3) and needs no second identity mechanism — *to be confirmed against Microsoft's current documentation at implementation time, on §10.1's rule that a spec written by a model is the wrong place for a fact with a shelf life.* **The open half is everything else in §12.** Postgres and Blob Storage are Azure services in every sentence of §12 Q1; a self-hosted Postgres and some other object store would change the residency answer, the backup answer, the private-endpoint answer and the subprocessor answer, and **§5.1's Azurite says nothing about any of them** — it is a development emulator, not a deployment target, and reading it as one would be exactly the over-claim the fourth revision exists to prevent. *My recommendation is to leave this out of scope until a firm actually asks, and to keep the local stack Azure-shaped so that answering it later is a hosting exercise rather than a redesign.* **Affects §5.1, §12 Q1 and §12 Q5.**

---

## 18. Definition of done

Per stage, since this ships in five.

1. `tsc --noEmit` clean across all four workspaces; every suite passes; every app builds clean.
2. **Stage 1:** no user-supplied key exists anywhere in the codebase, in any browser, or in any request — searched for, not assumed; every model call goes through the gateway; **no credential of any kind exists outside the gateway process**, asserted by a test over `apps/web` and `apps/api`; every call is logged with its purpose, provider, model and jurisdiction, and with no prompt or completion content, both asserted by tests; the allowlist refuses an unknown provider+model pair and the gateway refuses a jurisdiction outside the declared set without the request reaching the provider; **the gateway refuses to start with no jurisdiction set declared** — searched for, not assumed: no default value appears anywhere in configuration loading — and likewise on an undeclared entry or a missing log sink; the adapter-boundary test passes and the stream conformance suite passes **for every registered adapter**, including the byte-for-byte streamed-equals-non-streamed case on a CRLF fixture.
   **And, on the local stack:** `docker compose up` brings up the whole of §5.1 and a developer signs in against the seeded issuer, with **no bypass available anywhere** — searched for and asserted by the `auth` suite, not assumed; the `configSurface` test passes, so the configuration keys differing between the local and deployed environments are exactly §5.1's enumerated list.
   **And, as a separate check on the deployment rather than on the code:** in a configuration using Foundry or Azure OpenAI with managed identity, **no key exists at all** — verified in that environment. In a keyed configuration, the key is present only in the gateway's secret, appears in no log line, error, metric or response, and can be rotated without a redeploy. **The two are checked separately and reported separately**, because reporting them as one is the false security claim S2 exists to prevent.
3. **Stage 2:** a user signs in against the configured issuer and sees only what their role permits, refused by the API and not merely hidden by the UI — **verified against both issuers**, since the group-to-role mapping is the one behaviour whose input shape differs between them; every record type round-trips through Postgres; document bytes round-trip through Blob Storage; deleting a matter purges its blobs; the browser uploader moves the owner's data and names anything it could not. **And: a precedent document is stored, is not offerable as a review target or a collection member, and no screen in the app says it is not stored** — searched for, not assumed, across `src/`, the README and the test suite.
4. **Stage 3:** a run survives a worker restart mid-run and completes; cancelling leaves no cell in `pending`; re-running a clause clears its disposition and its net position in one transaction **and records the clearing in `finding_disposition_event`, attributed to whoever asked for the re-run**; the run worker's role provably cannot write either disposition table; `carryHumanState` is deleted and nothing regressed.
5. **Stage 4:** two people in one review see each other's presence and each other's writes without reloading; **a Partner overrides a trainee's verification and the trainee's open card immediately reads the Partner's name and time, without a reload**; a change submitted against a stale version is refused, shown what replaced it, and offered again; every disposition on screen carries its actor and time, and a changed one says so; an export carries its "as at" instant; a disconnected client shows itself as stale, disables its disposition controls and resynchronises visibly; an assignment reaches the assignee.
6. **Stage 5:** every affordance R-G1 dropped is back only where its mechanism is real.
7. `api` provably cannot reach a model endpoint directly, asserted by a test (Spike 2).
8. §12 is answerable end to end by someone who did not write it, and the README's untrue sentences (§2) are all replaced. **Including §12.0's architectural-versus-deployment split**: that reader must be able to say, without help, which guarantees they verify once and which they must check in each environment — and must not be able to find a sentence anywhere in the app, the README, the admin screens or this spec that states the unconditional "there are no provider keys anywhere" claim as live.
9. Verified in a browser, on a deployed environment, with two real accounts. **The same checks pass locally first**, against the seeded issuer's accounts (§5.1): the local run is where a defect is reproduced and fixed, the deployed run is where §5.1's "what local does not prove" list is exercised, and **neither substitutes for the other**.
10. **The same code path runs in both environments, and the divergences are exactly §5.1's enumerated list — checked, not asserted.** Three mechanical checks, in ascending order of what they catch:
    - **(a) No module branches on the environment.** A boundary test finds no `NODE_ENV` read outside build tooling, no `isLocal`, no `if (dev)`, and no `process.env` read outside each app's single configuration module.
    - **(b) The configuration diff *is* the divergence list.** A test compares the key sets of the local and deployed configurations and fails if any key differs that §5.1's table does not name — **and fails equally if the table names a row with no key behind it**, so the table cannot decay into a list of good intentions.
    - **(c) The same suites run against both.** Not a local suite and a deployed smoke test: the integration and end-to-end suites run against the compose stack in CI *and* against an ephemeral deployed environment before release, and both must pass. A test that only ever runs in one environment is evidence about one environment.
    A reader who wants to know whether this claim is still true runs (a) and (b) and reads the two result sets from (c). That takes minutes, and it is why the claim is in the definition of done rather than in the prose.

---

## 19. Risks

**The Risk review is a gate held by people, not by tests, and it can be failed on a true answer.** §10.1's 30-day abuse-monitoring retention is the likeliest place. Everything else in §12 is a good answer; that one is honest rather than good, and it should be raised early rather than discovered at sign-off.

**The five stream mappings are the highest-risk code in Stage 1, and their failure is quiet.** The suite already carries a regression for an SSE parser that dropped the final token and returned nothing on CRLF servers; multi-provider gives that bug class one instance per adapter. §10.4's structural answer — one shared decoder, five thin frame mappers, a conformance suite that fails the build for an unregistered adapter — reduces it but does not remove it, because the mapping is where provider behaviour actually differs and CI cannot exercise a real provider's stream. **A truncated clause analysis reads as a model that had little to say**, which is precisely the "answer quietly wrong" shape, and it would be found by a lawyer rather than by a test. The byte-for-byte streamed-equals-non-streamed assertion is the one that matters; it is also the one most likely to be dropped as slow.

**The strongest guarantee in this design is now the one most easily overstated.** "There are no provider keys anywhere" was a memorable sentence, it appeared in several places, and it is exactly the kind of line that survives into a README, a slide or a Risk answer after the thing it described has become conditional. This revision removed every live instance of it and replaced it with two sentences that must stay two — but **the pressure to re-merge them is permanent**, because one sentence is shorter and sounds better. §12.0's table is the defence: it makes the split a structure rather than a phrasing, so re-merging requires deleting a row rather than tightening a sentence. Watch for it in the README rewrite (§2), which is where a summary gets written by someone reading this document quickly.

**A jurisdiction guarantee that lives in configuration can be true of the design and false of an environment.** The gateway enforces the operator's declared set faithfully, so the code cannot be wrong about it — but the *operator* can, by allowlisting an entry whose declared jurisdiction is copied from another entry, or by leaving a `dataHandling` note that was true two years ago. **The declaration is only as good as the person who typed it, and that is the trade this design deliberately accepts**: the alternative is a system that overrides the operator's own contracts with a guess, which would be wrong more often and less visibly. §10.1's staleness rendering and §12 Q5's "what was actually used" call-log report are the mitigations, and the second is the real one: configuration says what a firm permitted, the call log says what it did, and only the second is evidence.

**The audit log is only evidence if nothing can rewrite it.** S11 makes that a grant rather than a habit, but a future migration run as a superuser could still alter it. The mutation test for the insert-only grant is the guard, and it must run in CI against the real database rather than being asserted once at deploy.

**The realtime stale state is the defect this design is most likely to ship *in the app*.** Everything else fails loudly by construction; a client showing yesterday's findings because its socket dropped looks completely normal. It is the reason §3 adds a fourth load state and §14 gives it a suite of its own, and it is still the thing to check first in browser verification. (The 2026-08-28 revision adds one that is worse in consequence though not in likelihood — the export, below — because a stale card has a reader who can refresh it and an exported DOCX does not.)

**Server-side page rendering is unproven** (Spike 1). The whole scanned-document path depends on it, and the scanned-document path is this project's founding defect. The OCR fallback is real but is a Risk-story change, not a drop-in.

**A client/server split doubles the surface for sibling drift**, which is this project's most repeated failure by a wide margin — six findings from two implementations of one idea. `packages/core` plus the import-boundary test is the structural defence, and it has to be enforced from Stage 0 rather than retrofitted, because the first duplicated helper will be written the week the split lands.

**"Could a development configuration be deployed by accident?" is the question a reviewer will ask about §5.1, and the answer is that there is no such configuration.** Authentication cannot be turned off; only the issuer varies (S28, S29), and the issuer is one deployment configuration value sitting beside the database and storage endpoints where a reviewer already looks. The API refuses to start with no issuer, and refuses a non-HTTPS issuer that does not resolve to loopback, so a deployed environment pointed at a development issuer fails at startup rather than serving. **The residual risk is therefore not "the bypass gets left on" — there is no bypass — it is "a firm deployment is pointed at an issuer nobody checked"**, which is a configuration-review item on the same list as the database endpoint. That is a materially smaller and far more familiar risk than the one a bypass flag creates, and it is worth recording which was traded for which.

**The divergence list is a document that can rot, and that is §5.1's real exposure.** Everything else in that section is true of the design; what can become false is the *list*. A tenth difference introduced quietly — a dependency added to the compose file alone, an environment read slipped into one module — turns "the same code runs in both" from a checked fact into a comforting sentence, and it would be discovered on a first deployment, which is the most expensive place to discover anything. §18's three checks exist because a list maintained by discipline is a list that drifts. They are cheap, and being cheap is exactly why they will be proposed for deletion.

**Keycloak is not an Entra emulator, and §5.1 must not be read as claiming it is.** Azurite emulates Blob Storage; Keycloak implements the same *protocol* Entra implements. The gap is precisely where §5.1's "does not prove" list says it is — group-claim shape, group overage, admin consent, conditional access — and **the overage case (§7) is the one most likely to be met in a real tenant and impossible to meet locally**. It is specified rather than left to be discovered, and it is the first thing to check in the deployed two-account pass.

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
| 1 — gateway + sign-in + inference proxy + provider adapters + the local stack | ~1.25–1.5 (was ~1 before the multi-provider revision) |
| 2 — Postgres, Blob, auth, roles, uploader | ~2.5–3 (the largest) |
| 3 — server-side engine, findings as rows | ~1.5–2 |
| 4 — realtime, presence, collaboration | ~1.5–2 |
| 5 — the superseded surfaces | ~0.5 |
| Infrastructure and deployment, spread across all | ~1 |

**The multi-provider revision moves Stage 1 and nothing else, and it is worth saying where the quarter-to-half goes.** Not into the adapters — five adapters over one interface, each shaping a request and mapping a stream frame, is a day's work each and less if the interface is right. It goes into the parts that are *once*: the shared stream decoder and its conformance fixtures (§10.4), the jurisdiction plumbing from allowlist entry through response to `run` row to picker label (§10.3), the credential handling and the tests that assert a key appears nowhere, and the admin provider screen. **The adapters are the cheap half; the boundary and the evidence are the expensive half**, and inverting that estimate is how a plan ends up with five working providers and one shared decoder nobody wrote.

**Total: roughly 8.25–11.5 sub-project equivalents**, against the redesign's seven — with the caveat that Stages 2 and 3 are each larger and less forgiving than any single redesign sub-project was, because a mistake in them is a data migration rather than a component rewrite.

**The 2026-08-28 revision does not move these numbers much, and it is worth saying why rather than leaving it inferred.** Stage 2 gains precedent storage, which is a `kind` column, two small tables and a copy change on a flow whose ingest path already exists — inside the noise of a 2.5–3 estimate. Stage 4 gains the disposition history, which *replaces* the insert-once verification and the challenge table rather than adding to them: one mutable row plus one append-only log is not more work than one immutable row plus one append-only log with withdrawal semantics. What genuinely grows is the **UI and export surface** — attribution on every disposition, "was X", a history panel, the stale-change refusal dialogue, and the export's point-in-time framing — which is real work at the top of Stage 4's ~1.5–2 rather than a new stage. If anything in the revision is under-estimated it is that, and it is the half that must not be trimmed (§19).

**The fourth revision moves Stage 1 slightly upward and Stage 4's verification cost downward, and the second effect is the larger one.** The local issuer is a container and a version-controlled realm file — under a day. The configuration-boundary test and the configuration-diff check are a day more. Both sit inside Stage 1's existing ~1.25–1.5 rather than moving it. What comes *off* the estimate is elsewhere and is not visible in the table: §14's two-account browser verification previously required a deployed environment and two real Entra accounts for **every** Stage 4 defect, and now requires two browser profiles for all but the final pass. That is the difference between reproducing a collaboration bug in a minute and reproducing it in an afternoon, repeatedly, across the stage where this design's entire collaborative half lands — and Stage 4 is the stage whose UI and export surface §19 already names as the thing most likely to be trimmed under time pressure.

The mitigating fact is real and worth stating: **111 of 133 test files and almost all of `src/lib` move to `packages/core` unchanged.** The domain logic this app is actually made of — citation matching, scan detection, position strength, net positions, the extractors — does not change at all. What changes is everything around it.
