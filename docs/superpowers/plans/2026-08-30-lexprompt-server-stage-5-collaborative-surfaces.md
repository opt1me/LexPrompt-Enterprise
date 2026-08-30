# LexPrompt Server — Stage 5: the collaborative surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put back every affordance R-G1 dropped **whose mechanism Stage 4 made real** — the assignee chip, the "assigned to me" counter, firm-wide search and the Report tab — and build the four administrative surfaces the design names and the code has never had: role mapping, a person's account lifecycle, the provider allowlist with its credential status, and the workspace-wide audit export. Without, at any point, putting a number on screen that is wrong, a search box that misses a matter, an admin screen that widens access more quietly than it says, or an export that reads as complete when it is not.

**Architecture:** Three parts, in ascending order of what a mistake costs. **Part 5A** is aggregation over Stage 4's `assignment` table: an inbox that works across matters, a counter with three states, a chip on a card — no new grant, no new table, no new policy. **Part 5B** is finding things: one `GET /v1/search` over a **declared** corpus that reports its outcome per source, the `⌘K` palette that renders it, and the Report tab as a **third renderer over the one findings map** (never a third pipeline). **Part 5C** is administration, and it is a different kind of work: `role_mapping` becomes writable by a screen for the first time, bounded by a row-level policy rather than by a habit; a person can be disabled and pseudonymised; the provider allowlist and its credential status get an honest read-only surface; and the workspace audit export becomes an artefact that states its coverage and refuses to be partial. **Part 5D** closes the design: the definition of done in P44's three categories, the rulings, and a plain statement of what is still not built.

**Tech Stack:** Everything Stage 4 shipped. **No new runtime dependency in any workspace** — that is a constraint, not an observation, and Task 4 takes an explicit decision against `pg_trgm` because the migrator role cannot create an extension. TypeScript 5.8, Vitest 3.2 (`test.projects`: `web` jsdom, `core`/`gateway`/`api` node, plus the `api-pg` and compose configs), React 19, Fastify 5, `pg` 8, `@fastify/websocket`, `@azure/storage-blob` 12, undici, `jose`, `oidc-client-ts`, Keycloak, Azurite, Postgres 16, Docker Compose, `azd` + Bicep.

**Spec:** `docs/superpowers/specs/2026-08-28-lexprompt-server-design.md` (binding authority). Stage 5's boundary is §13's last paragraph; its definition of done is **§18 item 6**; the roles and what each may do are §7; the collaboration tables are §6.3; the export's point-in-time framing is §6.3.1; the allowlist, jurisdiction and credential rules are §10–§10.5; the environments are §5.1; the testing bar is §14; the still-open owner questions are §17 Q2, Q3, Q4, Q6, Q12 and Q13; the estimate is §20; rulings **S2**, **S9**, **S10**, **S11**, **S15**, **S17**, **S18**, **S22**, **S23**, **S25**, **S26**, **S27**, **S28**, **S29**, **S30**; and `CLAUDE.md`, which binds everything below and **which Stage 4 rewrote** — read its "Deliberate non-features" section in the shipped file before planning anything that touches presence, assignment or attribution, because the paragraph most people remember ("multi-user is schema-ready but not built") is no longer there.

**Preceding plan:** `docs/superpowers/plans/2026-08-30-lexprompt-server-stage-4-live-change.md` and its ledger `.superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/progress.md`. **Read the ledger's standing rules before Task 1**, and read that plan's closing sections — *"Interfaces Stage 5 and later must honour"* (eighteen numbered items, every one of which this plan either consumes or supersedes explicitly) and *"What Stage 4 deliberately leaves to Stage 5"*, which is this stage's scope in Stage 4's own words. Also read `.superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/stage-4-report.md`, whose *"What only a person at a browser can confirm"* list is this stage's starting position rather than its excuse. This plan continues the decision numbering: Stage 1's are **P1–P5**, Stage 2's **P6–P16**, Stage 3's **P17–P28**, Stage 4's **P29–P44**, and this plan's are **P45–P61**.

---

## Scope check, before anything else

§20 estimates Stage 5 at **~0.5 sub-project equivalents** — the smallest number in the table, and by some distance. **My decomposition comes out at 17 tasks, which is roughly two to three times that**, and I am saying so at the top because all three preceding plans said the same thing about their own stage and all three were right.

§20's estimate is not careless; it is answering a different question. It reads Stage 5 as *"the superseded surfaces"* — UI over mechanisms earlier stages already built — and for **Part 5A that is exactly right**: the `assignment` table, its routes, its socket events and its name resolution are all Stage 4's, and the chip and the counter really are a day's work over them. What the estimate does not price is that **three of the five things §13 assigns to Stage 5 have no mechanism at all**, which I established by reading the shipped code rather than by reading the stage list:

1. **`role_mapping` cannot be written by the application, and that is not merely a missing grant.** `grant select on role_mapping to lexprompt_app` (001) is one half. The other half is `seedRoleMappings` (`apps/api/src/auth/roles.ts`), which runs at **every** startup on the migrator connection and **deletes every row not named in `API_ROLE_MAPPINGS`**. So an admin screen written against the table as it stands would take a write, show it as applied, and have it deleted at the next container restart — silently, with no error anywhere, and the screen would go on showing the mapping as current until somebody reloaded it. §7 says the table is *"seeded by deployment configuration **and editable by an admin**"*; as shipped, those two sentences cannot both be true. Reconciling them is a migration, a row-level security policy, a rewrite of the seed and a new set of audit actions — Tasks 8, 9 and 10 — before a single pixel of a screen exists.
2. **§7's "disabling a user" has no route.** `apps/api/src/auth/actor.ts` refuses a `status = 'disabled'` row with a specific 403, and `GET /v1/workspace/users` returns the column — but nothing in the API can set it. The refusal path is real, tested, and unreachable except by a hand-written `UPDATE` on the migrator connection. §17 Q6's only available remedy, pseudonymisation at `app_user`, has no route either.
3. **§14's `credential` suite names an admin endpoint that does not exist.** *"the admin endpoint reports only whether a credential is configured and when it was rotated"*. `apps/gateway/src/routes/` has `health`, `infer`, `inferStream` and `models`, and `apps/gateway/test/credentials.test.ts` exercises `DefaultCredentialResolver` directly. There is nothing for a providers screen to read, so Task 13 builds the endpoint before Task 14 builds the screen.

Two smaller ones push in the same direction: `AssignmentView` carries no matter, review name or clause title, so the cross-matter inbox the shipped client already asks for (`getOpenAssignments()` with no review id) returns rows nothing can render (Task 1); and there is no full-text index, no `pg_trgm`, and **no way for `lexprompt_migrator` to create one** — it is not a superuser and `pg_trgm` is not a trusted extension — so the search corpus is a design decision rather than a query (Task 4).

**The verdict: one document, three parts, two hard gates, and a named degradation order.** I am not proposing a second plan document, for the reason Stages 2, 3 and 4 each gave and Stage 1 paid for: a second document is a second set of briefs naming interfaces that have moved. But I am recording the seam, because this stage has a cleaner one than any before it:

> **If this must become two stages, the seam is between Part 5B and Part 5C, and the line is privilege.** Parts 5A and 5B add **no grant, no policy table, no new admin power and no new egress**; every route they add is `reviewer` over data a reviewer can already read one record at a time. Part 5C does nothing else: every task in it either widens a database grant, exposes a credential fact, or produces an artefact a firm would hand to an auditor. That is a real difference in blast radius, and it is where a reviewer's attention should be concentrated rather than diluted across a search box.

| | Part 5A — *the affordances* | Part 5B — *finding things* | Part 5C — *administration* |
|---|---|---|---|
| Tasks | 1–3 | 4–7 | 8–15 |
| Adds a grant? | No | No | **Yes — Task 8, bounded by RLS** |
| Ships | the cross-matter inbox with the context to act on it; the "assigned to me" counter with three states; the assignee chip on a card, and the rule that a chip is not a disposition | `GET /v1/search` over a declared corpus with a per-source outcome; the `⌘K` palette and its four states; the Report tab as a third renderer over one findings map; the Part 5A+5B gate | `role_mapping.source` and the row-level policy; the seed that owns configuration rows only; the role-mapping routes and screen; disable and pseudonymise; the gateway's credential-status endpoint; the providers screen; the workspace audit export |
| Its own DoD | three seeded accounts, over real HTTP: an assignment made in one matter appears in the assignee's cross-matter list with its matter, review and clause named; the counter renders "not known" when the read fails and never `0`; the chip names the assignee and never a state | a matter created by another account is found by search; a precedent document is never returned as a matter document; a source that fails is named as failed and the result set is never presented as complete; the Report tab renders `findingOutcome.ts`'s strings and declares no new ones | the app role provably cannot write a `source = 'configuration'` row; a restart does not delete an admin-authored one; a change that would leave no admin mapping is refused; no key reaches the credential endpoint; the audit export states its coverage, its instant and its completeness and refuses to truncate |
| Shippable alone? | **Yes.** It closes S18 and nothing else moves. | Yes. It discharges R-G14 and R-G11 and touches no policy. | Yes, and it is the half a firm deployment actually needs. |

**The degradation order, if the Task 7 gate slips.** Named now so nobody decides it at 17:40: **Task 6 (the Report tab) comes out first** — R-G11 has been deferred for a whole redesign and one more stage costs a ruling line, not a lie. **Then Tasks 4–5 (search)**, in that order, into a Part 5E with its own gate; a deferred search box is R-G14 standing, which is the status quo. **Nothing in Part 5C may be cut, and nothing in Part 5C may be *half* cut** — Tasks 8, 9 and 10 are one change in three commits, and shipping 8 without 9 leaves a `source` column nobody reads while the seed still deletes admin rows, which is worse than shipping neither. **Part 5A may not be cut**: S18's whole content is that those two affordances land once their mechanism is real, and the mechanism has been real since the day Stage 4 closed.

**What this costs if the split is wrong:** two review gates' ceremony inside one stage. What the alternative costs: an admin screen reviewed in the same breath as a keyboard shortcut.

---

## What Stage 4 shipped that this plan builds on

Read the shipped source before writing code against any of it. **Where the shipped source disagrees with this brief, the shipped source wins** — that sentence is in every task's Interfaces block, and it is there because **19 of 23 Stage 1 briefs, 21 of 21 Stage 2 briefs, 26 of 26 Stage 3 briefs and 25 of 26 Stage 4 briefs contained real bugs in their reference code.**

| Shipped | Where | What Stage 5 does with it |
|---|---|---|
| `assignment` table: `id`, `review_id`, `findings_key`, `clause_id`, `workspace_id`, `assignee_user_id`, `assigned_by_user_id`, `message`, `created_at`, `resolved_at`, `resolved_by_user_id`; partial unique index on the open row per assignee; indexes on `(workspace_id, assignee_user_id, created_at desc)` and `(workspace_id, review_id, created_at desc)`, both `where resolved_at is null` | `apps/api/migrations/013_assignment.sql` | **No schema change.** Both indexes this stage needs already exist and were written for these two reads. Task 1 uses the first; Task 3 uses the second |
| `GET /v1/assignments?state=open[&review=…]` — the **caller's own** open requests, from the token and never from a query parameter | `apps/api/src/routes/assignments.ts` | Task 1 adds the context fields for the cross-matter case. **The "whose queue" rule does not move**: Task 3's review-scoped route is a different question with its own entry |
| `AssignmentView` / `AssignmentsPage` / `AssignmentEventPayload`; `assignment.created` and `assignment.resolved` on the outbox and the socket | `packages/core/src/api/records.ts` | Consumed unchanged. `AssignmentInboxItem` **composes** `AssignmentView` rather than extending it (P46) |
| `createAssignment` / `resolveAssignment` / `getOpenAssignments(reviewId?)` — three calls and **no cache**, rejecting on failure and never resolving to an empty list | `src/lib/api/assignments.ts` | Task 2's counter reads through these. Its docstring already says the firm-wide counter is Stage 5's; that sentence becomes true |
| `userName(id)` / `userInitials(id)` / `loadDirectory()` — the **only** id→name resolver; returns `undefined` for an unknown id, never a fabricated label and never a raw id | `src/lib/api/users.ts` | Every name in this stage resolves through it. No route in this plan returns a display name in a payload (Stage 4's interface note 3) |
| `GET /v1/workspace/users` → `WorkspaceUsers { users: WorkspaceUser[] }` with `id`, `displayName`, `initials`, `role`, `status`, optional `email` | `apps/api/src/routes/users.ts` | Read by the assignee picker, the chip and the admin People panel. **`role` here is a cache — see disagreement 4** |
| `audit_event`, partitioned monthly, `grant insert, select` and explicit `revoke update, delete, truncate`; `appendAudit(t, e)` the one writer, taking a `Tx`, resolving `matter_id` at the writer | `apps/api/migrations/012_audit_event.sql`, `apps/api/src/audit/write.ts` | Tasks 10, 12 and 15 add actions and read it. **No new writer, and no disposition action ever** (S22) |
| `AUDIT_ACTIONS` — a closed set of fourteen strings, including `user.role_changed` and `workspace.settings_changed` | `apps/api/src/audit/actions.ts` | Widened deliberately in Tasks 10 and 12. The closure and its "no disposition action" scan stay |
| `GET /v1/matters/:id/activity` — one `UNION` over `finding_disposition_event`, `audit_event` and `run`, scoped per arm, ordered and limited in SQL | `apps/api/src/routes/activity.ts` | Task 15's workspace export is the **same three arms at a different scope**. Read this file first; the export is not a second query language |
| `GET /v1/reviews/:id/history` → `ReviewHistory`; `exportHistoryCsv` | `apps/api/src/routes/history.ts` | Task 15's export includes the same rows workspace-wide. The per-review one stays and is not re-implemented |
| `ExportContext { readAt, timeZone, dispositionOf, audience }`, `NO_EXPORT_CONTEXT`, `dispositionsAsAtLine`, `dispositionsMayChangeLine`, `exportDispositionLine`, `dispositionLabel`, `dispositionHistoryLine` | `src/lib/findingOutcome.ts` | **Task 6's Report tab renders these and declares nothing new.** Task 15's export manifest uses the same "as at" idiom |
| `describeLoadError`, `LoadErrorPanel`, `STALE_NOTICE`, `STALE_CONTROL_NOTICE`, `RESYNCING_NOTICE`, `controlDisabledReason` | `src/lib/loadError.ts`, `src/components/LoadErrorPanel.tsx` | Every new load path in this stage uses them. **Nothing hand-rolls a fourth error sentence** |
| `ROUTE_POLICY` with **no default**; a route with no entry throws at registration; `'GET /v1/admin/blob-orphans'` and `'POST /v1/admin/blob-orphans/delete'` already sit at `admin` and are called by no screen, deliberately | `apps/api/src/auth/routeTable.ts` | Every route below adds its line in the task that registers it. Task 14's screen does **not** adopt the blob-orphan routes — they stay operator-only, and the plan says so rather than letting a new admin screen quietly grow them a button |
| `resolveActor` — resolves `role` **per request** from `role_mapping` through `roleFor`, upserts it onto `app_user.role`, and refuses a `status = 'disabled'` row with `account_disabled` 403 | `apps/api/src/auth/actor.ts` | Task 10's screen must state that a mapping change takes effect on the **next request**, including for people already signed in; Task 12's disable takes effect the same way |
| `twoAccounts()` → `{ trainee, partner }`; `signIn(username)` reading passwords out of `infra/keycloak/lexprompt-realm.json`; `asUser(who, method, path, body)`; the realm seeds `trainee`, `partner`, `admin`, `nogroups` | `apps/api/test/helpers/twoAccounts.ts` | **Task 1 adds `threeAccounts()`.** `signIn('admin')` already works — the helper is the missing piece, not the account (P61) |
| `connect()` / `socketsOnDistinctReplicas()` / `WS_SUBPROTOCOL` | `apps/api/test/helpers/wsClient.ts` | Task 2's live-counter assertion connects the assignee's own socket rather than polling |
| `sourceScan.ts`'s `ROOT`, `walk`, `rel`, `codeOf`; `stage4DoD.test.ts`'s `at`, `WEB_SOURCES`, `API_SOURCES`, `CORE_SOURCES`, `ALL_SOURCES`, `grepRepo`, `COMPONENTS` | `apps/api/test/` | Every scanner in this plan reuses them. **Every scanner also carries a sanity check**, and one shipped one does not — see disagreement 6 |
| `lexprompt_migrator` **owns** `schema public`; `lexprompt_app` and `lexprompt_worker` hold only what each migration granted | `infra/postgres/init.sql` | Task 8 depends on the ownership: RLS without `FORCE` does not apply to a table's owner, which is exactly the split between "configuration writes" and "a screen writes" |

---

## Where the spec and the shipped code disagree — ruled before Task 1

Six, found by reading the shipped source against §7, §14 and §18. Each is ruled here so no task has to decide it alone.

**1. §7 says `role_mapping` is "seeded by deployment configuration **and editable by an admin**". As shipped it can only be the first.** `grant select on role_mapping to lexprompt_app`, and `seedRoleMappings` deletes every row the configuration does not name, on every start. **Ruling:** both halves become true, by giving the row a `source` and giving each writer one half of the table — Tasks 8 and 9. The configuration keeps its delete-half over its own rows, because its own docstring is right about why it has one ("a revocation that silently did not happen"), and it gains nothing over rows it did not write.

**2. §14's `credential` suite names an admin endpoint that does not exist.** Nothing in `apps/gateway/src/routes/` reports credential status. **Ruling:** Task 13 builds it, in the gateway, reporting `configured: boolean` and `rotatedAt?: string` per provider and nothing else — and the assertion §14 actually asks for (no key in any response body) is written against the shipped route rather than against a resolver in isolation.

**3. §7 lists "disabling a user" among an admin's powers and no route sets `app_user.status`.** **Ruling:** Task 12 builds it. The refusal path in `actor.ts` is already correct and already tested; what is missing is the door.

**4. `app_user.role` is a per-request cache and reads like the policy.** `resolveActor` writes the role it just derived onto the row on every request; `GET /v1/workspace/users` returns that column. So a person who has not made a request since a mapping changed shows the **role of their last request**. **Ruling (P54):** no admin screen renders `app_user.role` as the effective policy. The People panel labels it *"role at their last request"* with the instant; the Role mapping panel is the only place policy is shown. Getting this wrong is precisely rule 3's "shows a stale mapping as current", and it would be an easy screen to build by accident.

**5. `AssignmentView` carries no matter, no review name and no clause title**, while `getOpenAssignments()` already supports the cross-matter call. A firm-wide inbox built on it renders three opaque ids. **Ruling:** Task 1 adds an `AssignmentInboxItem` that **composes** the view with its context, resolved server-side in the same statement. The socket payload keeps carrying the bare `AssignmentView` — a push is an invalidation with a row attached, not the inbox.

**6. One shipped guard has no sanity check, and it is a guard this stage inverts.** `stage4DoD.test.ts`'s *"still defers ⌘K and the Report tab, by absence"* asserts `grepRepo(/cmdk|CommandPalette/i, WEB_SOURCES)` is empty and asserts **nothing positive** — a palette named `SearchPalette` would have passed it since the day it was written. Its neighbour, *"still ships no assignee chip…"*, does carry one (`expect(FORBIDDEN.test('const n = assignedToMe.length')).toBe(true)`), which is the pattern to copy. **Ruling:** every guard this stage writes or inverts carries a sanity check in the same `it`, and Task 7 asserts that each *inverted* guard's replacement is a **positive** assertion rather than a deleted one (P46).

---

## Stages 1–4's lessons, encoded here rather than rediscovered

Each changed something in the tasks below, and the change is named.

**1. Every dispatched brief in four stages contained real bugs in its reference code** — 19/23, 21/21, 26/26, 25/26. The worst would have refused every review a firm owns, left the queue claiming nothing forever, forged attribution on a colleague's verification, and made a WebSocket handshake fail at the only hop compose can test. **Every code block below will be run by an implementer who has been told to distrust it.** Where this plan quotes a shipped signature it was read from the file on 2026-08-30; where it invents one, Step 1 writes the test that pins it before the implementation exists. **Each task's report names which of its blocks failed to compile or to run**, and that list is the task's most useful output after the code.

**2. Interfaces drift between a brief being written and run.** Every task's **Interfaces** block carries *"read the shipped source; where it disagrees with this brief, the shipped source wins."*

**3. Thirteen guards have been found not guarding across four stages** — including a route invisible to the very sweep asserting it was authenticated, a scanner that walked `routes/` while 34 unscoped statements sat outside it, a sweep that found its own sanity string in its own source, and a substring match that reported a shipped presence marker as a forbidden hook. So: **every guard in this plan carries the mutation that proves it bites, named by test title**, and **every scanner carries a sanity check that it finds what it claims to scan.** A `not.toContain` gets a companion positive assertion in the same `it`. This matters more in Part 5C than anywhere in this project so far, because the things being asserted are *privileges*, and a privilege test that cannot fail is indistinguishable from a privilege that is not there.

**4. Plan tasks that RUN things.** Every stage's worst defects were found live: a cell with no finding row spinning forever, a first verification answering 404, an `assignment.created` audit row the feed's own query could not reach. Tasks 1, 2, 3, 5, 7, 9, 10, 12, 13, 15 and 16 each carry a **run it** step against the live stack, with three real tokens, `curl`, a Node socket client, `docker compose exec` and a real Postgres. None of them needs a browser.

**5. Browser automation has been unavailable for four stages** (the Chrome extension disconnects; the Playwright MCP timed out again at this session's start). **Assume it stays unavailable — and this stage is almost entirely UI, so that hurts more here than anywhere.** The plan's answer is four-part and is stated as a method rather than an apology:
   - **(a) Drive every mechanism headlessly** with three real accounts over real HTTP against the compose stack. Every privilege claim, every scoping claim, every "the export contains X" claim is a mechanism claim and is proved this way.
   - **(b) Drive every rendered string through `src/test/mount.tsx`**, asserting the exact words each surface shows in each state, table-driven over the states rather than over the happy path.
   - **(c) Prefer surfaces that produce bytes.** The audit export and the Report tab both render from `findingOutcome.ts`, and the export produces a file — so a test reads the whole artefact and there is **no verification gap at all** for those clauses. That is why the Report tab renders the export's own strings rather than new ones (P50): it converts an unverifiable screen claim into a verifiable string claim.
   - **(d) Say what is left.** Task 16 categorises every §18 item 6 clause as **met by mechanism / met by rendered string / unmet**, and lists by name what only a person can confirm. Do not pretend them away.

**6. The gate is `npm run typecheck` (discovery over four projects), and no gate is read through a pipe.** `npx vitest run` can report every test PASSED and still exit 1 on an unhandled rejection. Redirect to a file, capture the exit code, then read the file. `npm run test:pg` needs `scripts/pg-forward.sh` running and **three** exported URLs. `npm run test:compose` needs the stack up and **must never run concurrently with `test:pg`** — they share one database.

**7. ⚠️ Never bare `docker compose up -d`.** The repo `.env` is a single bare line (a provider key) and bakes empty OIDC build arguments into `web`. Use `npm run compose:up`, or `docker compose --env-file /tmp/compose.env up -d --build`.

**8. `test:pg` and `test:compose` share one database and one stack.** A suite that leaves state behind breaks a different file's assertions with a message pointing at the wrong feature — Stage 4 lost time to exactly this twice (assignment audit counts across the whole workspace; a `LISTEN` that changed a pinned `pg_stat_activity.query`). Every task that seeds a user, a matter, a mapping or an assignment **deletes what it created** and says in its report that it did. **Task 10's tests are the sharpest case: a role mapping left behind changes who can do what in every subsequent suite.**

**9. Fail loudly rather than answer quietly wrong** is the review standard for every task. In a stage of counters, searches, admin screens and exports, the shapes to watch are: a badge showing `0` because a fetch failed; a search returning nothing because one arm threw; an admin screen showing a mapping that was deleted at the last restart; an export that stops at a row limit and says nothing; a chip that reads as a judgement; and a "no results" that is really a broken query.

---

## Global Constraints

Copied from the spec, from `CLAUDE.md` (as Stage 4 rewrote it) and from the four preceding plans' still-binding constraints. Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** Prefer a loud, specific, recoverable failure over anything mistakable for a successful empty result.
- **Do not add an affordance implying collaboration the app cannot deliver.** R1's surviving rule, restated in `CLAUDE.md` this stage: *"what changed is which affordances it can."* An "assigned to me" counter that is wrong, or a search that silently misses a matter, is worse than its absence — and "worse" here means a lawyer not doing something they were asked to do.
- **Search must distinguish "no results" from "the search failed".** This is the founding defect at a new surface. An empty result list that actually means a broken query is a blank CSV cell with a cursor in it.
- **An admin screen writes policy.** `role_mapping` decides who can do what. A screen that can silently widen access, or that shows a stale mapping as current, is the most dangerous thing in this stage. Every write names its effect before it happens, is audited, and is bounded by a database policy rather than by the screen.
- **Nothing derives a human judgement**, at every new surface. A chip, a counter, a search hit and a report row all *render* judgements; none of them writes one. The run worker still holds no grant on `finding_disposition` or `finding_disposition_event`, and this stage adds none.
- **A face is not a disposition, and neither is a chip** (`CLAUDE.md`, Stage 4). An assignee marker means somebody was asked to look and never that somebody has checked. It carries no tick, no flag, no cross, and no state or outcome ink.
- **A disposition is never shown without its actor and its time** (§6.3), including in the Report tab and in any export this stage produces. The one exception is a never-touched `unchecked`, which names nobody.
- **`verificationLabel`, `exportSummaryLine`, `dispositionLabel`, `dispositionHistoryLine`, `dispositionsAsAtLine` and `dispositionsMayChangeLine` in `src/lib/findingOutcome.ts` are the only place this wording lives.** Task 6 renders them; it does not compose a seventh string beside them.
- **`await-then-apply` survives verbatim** (§3, S8). No optimistic update for any human-authored state, anywhere in this stage, including a role mapping and a disabled account.
- **A load path distinguishes four facts** (§3): *not yet known*, *broken*, *empty*, *stale*. None renders as any other. `describeLoadError` / `LoadErrorPanel` are used; nothing hand-rolls a new one.
- **`workspace_id` on every new table and every query scoped by it** (§6, S9). `workspaceScope.test.ts` walks the whole of `apps/api/src`.
- **Every check happens in the API.** The web app hides what a role cannot do; the API refuses it. `ROUTE_POLICY` has no default and a route with no entry fails registration (§7). **Every new admin route is asserted refused for `reviewer` and for `partner`, live, over real HTTP** — not only in the table.
- **Three roles, no per-matter ACLs, no custom roles, no deny rules** (S10). This stage adds no fourth role and no per-matter visibility rule; if search feels like it needs one, that is a conflicts wall and it is out of scope by §16 S10.
- **`audit_event` is append-only by database grant** (S11), holds **no disposition action** (S22), and its retention is a partition `DETACH`, never a `DELETE`.
- **A precedent document can never be a review target, a collection member, or a matter-document search hit** (S23). A query that forgets the `kind` predicate fails by showing too much, and nothing on screen looks wrong.
- **No provider credential exists outside the gateway process**, and no log line, error, metric label, response body or admin endpoint contains one (§10, S2). Task 13 is the first endpoint in this system that talks about credentials at all, and it is the one that must be most careful.
- **The two sentences of S2 must stay two.** No screen, README line or admin panel may state the unconditional *"there are no provider keys anywhere"* claim as live; the no-key property belongs to a managed-identity configuration and is reported separately from the custody property (§18 item 8). Task 14's screen states which of the two **this** deployment has.
- **The divergences between the two environments are §5.1's enumerated list and nothing else** (S30). Every new configuration key is added to `apps/api/test/divergence.json` in the same commit, or `configSurface.test.ts` fails — in both directions.
- **No module branches on the environment**, and no module outside each app's single typed configuration module reads `process.env` (§18 item 10a).
- **No new runtime dependency**, in any workspace, without a task that says why and a `package.json` diff a reviewer can see. Part 5B was designed around this and Task 4 records the specific alternative it declined.
- **Colour lives in two layers and only the top one is a Tailwind utility.** No hex or `rgb()` in a `className`, no arbitrary colour value, no `--lex-*` reference, no generic Tailwind palette class. A role that does not exist yet is added to `src/index.css` **in the same commit that first uses it**. `SCAN_EXEMPT` is empty and stays empty (`src/test/palette.test.ts`).
- **A Tailwind class built by string interpolation produces no styling at all, silently.** Map each variant's complete class string in a `Record<Variant, string>` and index into it. Never build the tail of a class name from a variable.
- **Every migration file is immutable once applied.** The next free number was `014` when this plan was written; **check `apps/api/migrations/` before creating one** and take the next unused number, exactly as `012_audit_event.sql` and `013_assignment.sql` each did when a fix round landed a file ahead of them ("013, not the plan's 012: an applied migration is immutable, so the number moves and the file does not"). Wherever this plan says `014_role_mapping_source.sql`, it means *the next free number*; the filename moves, the content does not. Never edit an existing one.
- **Mutation-test anything load-bearing.** Break it, confirm a named test fails, restore, and record which test in the task's report.

---

## Seventeen decisions this plan makes, and why

Numbered **P45–P61**, continuing Stage 4's P29–P44 in the same repository. Each is load-bearing across several tasks and carries its cost if wrong, in `rulings.md`'s format. Task 17 records them there.

**P45 — This stage is 17 tasks against §20's ~0.5 estimate, and it ships as one document in three parts with two hard gates.**
The estimate priced UI over existing mechanisms; three of the five named deliverables have no mechanism (see the Scope check). The seam, if the owner wants two stages, is between Parts 5B and 5C, and the line is privilege.
*Cost if wrong:* one extra gate's ceremony. Against it: an admin screen reviewed in the same pass as a keyboard shortcut.

**P46 — Stage 2's and Stage 4's absence assertions are inverted task by task, in the task that makes each false, never deleted wholesale.**
Carries P30 forward. `stage2DoD.test.ts`'s *"no collaborative affordance shipped AHEAD OF ITS MECHANISM (R-G1)"* forbids `assign(ed)?[- ]?to[- ]?me` and `assigneeChip` in `src/`, and forbids `assigneeId` in any `.tsx`. `stage4DoD.test.ts` forbids the same two strings and defers `⌘K`. Each becomes a **positive** assertion in the task that lands the thing: Task 2 flips the counter, Task 3 flips the chip, Task 5 flips the palette, Task 6 flips the Report tab. **`assigneeId` in a `.tsx` stays forbidden** — the chip renders `assigneeUserId` from an `AssignmentView`, which is a different field on a different record, and the retired `Verification.assigneeId` must not come back through a component.
*Cost if wrong:* deleting the guards instead would remove the record of a deliberate boundary and leave nothing asserting the affordances that are still absent.

**P47 — A cross-matter aggregation renders three states, and "not known" never renders as a number.**
The counter is `{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; count: number; capped: boolean }`. `ready` with `count: 0` renders as **nothing at all** (no badge); `error` renders as a visible marker carrying `describeLoadError`'s sentence, never as `0` and never as an absent badge. The two must not be the same pixel.
*Cost if wrong:* a badge that hides a request a colleague is waiting on. This is the failed-migration-showing-an-empty-library defect at a surface a person checks in half a second.

**P48 — Search declares its corpus on screen, and document body text is outside it in this stage.**
The corpus is matters (name, client, reference), matter documents (name), precedent documents (name, labelled as precedents), reviews (name), collections (name), playbooks (name) and clause titles inside the current published version. Not the text inside documents. The palette says so in words, at the bottom of every result set including an empty one.
*Cost if wrong:* a lawyer searches for a phrase they remember from a lease and gets nothing. That is survivable **only because the screen says the phrase was never being searched for**; without the sentence it is exactly the silent miss this stage exists not to ship. Adding body text later needs a `tsvector` column and a GIN index — both core Postgres, no extension — plus a second match semantics the screen would have to explain, which is why it is named as the next thing rather than folded in here.

**P49 — Search reports an outcome per source, and a partial answer is never presented as complete.**
`GET /v1/search` returns `sources: SearchSourceOutcome[]` alongside the hits. One arm throwing does not fail the request and does not silently shrink it: the palette renders the hits it has **and** a line naming the source that failed, with a retry. A source that hit its `LIMIT` says so, with the limit.
*Cost if wrong:* a search that answers "nothing" because one arm threw is the founding defect wearing a search box. The `sources` array is what makes the difference visible, and it is the field most likely to be dropped as clutter.

**P50 — The Report tab is a third renderer over one findings map, and it declares no new wording.**
`CLAUDE.md`: *"The card view and the tabular grid are two renderers over one `findings` map. Never build a second pipeline for a second view."* The Report tab is the third, and every string it shows comes from `findingOutcome.ts` — including `dispositionsAsAtLine` and `dispositionsMayChangeLine`, so a reader sees on screen exactly what the export will say. That is what discharges R-G11 honestly: the objection was that a Report tab *"advertises a live report view the app does not have"*, and the answer is a view of the report the app actually produces.
*Cost if wrong:* one tab. If it grows its own wording it becomes a fourth place export copy lives, which is the drift `verificationLabel` exists to prevent.

**P51 — `role_mapping` gains `source ('configuration' | 'admin')`, and the app role's write is bounded by row-level security to `source = 'admin'`.**
The absent grant is replaced by a **bounded** grant, never by a broad one. `lexprompt_migrator` owns the table and RLS is enabled **without `FORCE`**, so the startup seed is unaffected and no request can touch a configuration row — enforced by the database, asserted by attempting the statement as the app role, and mutation-tested.
*Cost if wrong:* one migration and four policies. Without it, "an admin screen cannot widen deployment configuration" would be a property of the handler, i.e. of whichever `where` clause somebody remembers to write next time.

**P52 — The startup seed owns configuration rows only, and a collision supersedes loudly.**
`seedRoleMappings`'s delete-half is scoped to `source = 'configuration'`. If `API_ROLE_MAPPINGS` names an `(issuer, group_value)` an admin authored, configuration **wins**, the row is converted with its prior state recorded in `audit_event`, a startup line names it, and the screen shows the supersession permanently on that row.
*Cost if wrong:* the alternative that reads as safer — refusing to start on a collision — bricks a deployment whose only repair tool is the screen it just refused to serve. Configuration winning is the same direction the seed already takes and it is the one that always recovers.

**P53 — Every role-mapping write states its effect in words before it happens, is audited, and a change that would leave no admin mapping is refused.**
The effect sentence is produced **server-side** and returned by the write route's `preview`, so the screen cannot invent a milder one. The refusal names `API_ROLE_MAPPINGS` as the recovery path. **The screen also states when a change takes effect: the next request, including for people already signed in** — which is true (`resolveActor` re-derives the role per request) and is the more alarming of the two possible answers, which is why it must be the one on screen.
*Cost if wrong:* one confirmation step. Without it an admin grants `admin` to a group with the same two clicks as renaming a matter.

**P54 — No admin screen renders `app_user.role` as the effective policy.**
It is the role of that person's last request. The People panel labels it as such with its instant; the Role mapping panel is the only place policy is shown, read fresh on every open with the instant it was read.
*Cost if wrong:* a screen that shows a stale mapping as current — named in the brief as the most dangerous thing in this stage, and one careless label away.

**P55 — The providers screen is read-only by construction: there is no write route, and the screen says why.**
The allowlist is gateway configuration (S15, S26, S27); a screen that could edit it would be a screen that could change where privileged text is processed, which the design deliberately makes a deploy-time act with a Risk sign-off. The screen shows each entry with provider, jurisdiction and its dated `dataHandling` note with staleness, and states **which of S2's two guarantees this deployment actually has**.
*Cost if wrong:* an admin must edit configuration and redeploy to change a model. That is the intended cost and §16 S15 says so.

**P56 — The credential endpoint reports `configured` and `rotatedAt` and nothing else, and the test asserts over the shipped route.**
§14's `credential` suite is currently written against a resolver rather than an endpoint, because the endpoint does not exist. Task 13 builds it and extends the suite to sweep every response body, error path and log line of the shipped route for every configured credential's value.
*Cost if wrong:* a key in a response body, on the one screen an administrator would screenshot for a Risk pack.

**P57 — The audit export declares its coverage, its instant and its completeness, and refuses rather than truncating.**
Every export carries a manifest: workspace, the `from`/`to` instants, the three sources by name, the row count per source, the instant it was taken, and the timezone. If any source would exceed `API_AUDIT_EXPORT_MAX_ROWS`, the request is **refused** with a 413 naming the source and the count, and telling the caller to narrow the range — never a file with the first N rows in it.
*Cost if wrong:* an auditor is handed an extract that is silently short. §19 already names the export as the worst-consequence artefact in this design because it leaves the building and has no refresh button; a truncated audit export is that failure with legal weight attached.

**P58 — Pseudonymisation acts on `app_user` and rewrites no history row, and it is irreversible.**
§17 Q6's only available remedy. The display name and email are replaced by a stable pseudonym derived from the row's own id; every `by_user_id` foreign key is untouched; `finding_disposition_event` and `audit_event` are not written to at all. The screen says the word "permanent" and requires the person's current display name to be typed.
*Cost if wrong:* an irreversible act behind one click. Against it: the alternative to having the remedy is a DPO request this system cannot answer at all.

**P59 — No out-of-app notification ships, and the assign surface says so.**
§17 Q2 is unanswered and each channel adds a subprocessor and a line to §12 — an owner decision with a Risk consequence, not a feature to infer from silence. What ships is the sentence, where the request is made: nothing will reach this person outside LexPrompt. **No seam, no interface, no stub** — YAGNI, and an unused notification interface is a promise in the shape of code.
*Cost if wrong:* an assignment waits until the assignee opens the app. Stated on the screen, that is a known property; unstated, it is the silence R-G1 was written about.

**P60 — §17 Q12 stays open: the export does not state where the review was processed.**
The `run` row carries `provider`, `model` and `jurisdiction`, but `finding` carries **no `run_id`**, so a review's clauses cannot honestly be attributed to a run — a retry re-runs one clause under whatever the workspace's model choice is now. A summary line listing every run of the review would invite a reader to attribute a clause to a run that did not produce it, at the one surface §19 calls worst-consequence. Closing it needs `finding.run_id`, a migration, and a backfill that must say "not recorded" for every existing row.
*Cost if wrong:* a fact §12 might want is absent from the export and is still available from the call log, which §12 Q5 already names as the evidence. The opposite error puts a jurisdiction claim on a clause it is not true of.

**P61 — Three accounts, not two.** `threeAccounts()` joins `twoAccounts()`: a `trainee` who must be refused, a `partner` who must also be refused, and an `admin` who must be allowed. Every privilege assertion in Part 5C needs all three, because a test with only the privileged caller proves the route works and proves nothing about the gate.
*Cost if wrong:* one helper. Without it, "an admin route refuses a reviewer" is asserted only in a table.

---

## The definition of done, and the part no test can reach

§18 item 6 is one sentence — *"every affordance R-G1 dropped is back only where its mechanism is real"* — so this table expands it against R-G1's own list plus §13's Stage 5 scope, with the evidence each clause will actually have. **This is the plan's promise about its own verification**, and Task 16 fills in the right-hand column with results rather than intentions.

| Clause | Category | The evidence, and its limit |
|---|---|---|
| The **assignee chip** is back, and only where the mechanism is real | **Mechanism + rendered string** | Task 3's pg test (an assignment made by the trainee is visible on the partner's review-scoped read, with the assignee's id) plus a `mount.tsx` test asserting the chip's exact words and the absence of every disposition word and every state ink. *Does not prove:* that it reads as "asked to look" rather than "owns this". |
| The **"assigned to me" counter** is back, and is never wrong | **Mechanism + rendered string** | Task 2's compose test (assign across two matters; the count is 2; resolve one; the socket pushes and the count is 1) plus a table-driven render over all three states. *Does not prove:* that a person notices the badge. **The failure state is fully provable** and is the clause that matters most. |
| The **firm tag**, the **mobile Assigned tab** and any **second person's name in the header avatar** stay absent | **Mechanism (a scanner)** | Task 16's scanner over `src/`, with its sanity check. R-G1 dropped these and no mechanism has arrived for them. |
| **Firm-wide search** ships, and discharges R-G14 | **Mechanism + rendered string** | Task 4's pg tests (a matter created by the partner is found by the trainee; a precedent is never a matter hit; one arm throwing yields `status: 'failed'` and the other arms' hits survive) plus Task 5's four-state render. *Does not prove:* that the corpus sentence is read. |
| A search **failure is distinguishable from an empty result** | **Fully provable, and it needs no browser** | Task 4's per-source outcome asserted over the response, and Task 5's render asserting the two states produce different text and different elements. Say so in the report; it is the good news in this table. |
| The **Report tab** ships, and discharges R-G11 | **Rendered string** | Task 6's render asserting every line it shows is produced by a `findingOutcome.ts` export, plus a scanner asserting the component declares no display string of its own. *Does not prove:* that the tab is the report anyone wanted. |
| An **admin can change a role mapping**, and cannot change deployment configuration | **Fully provable** | Task 8's grant tests (the app role's `insert`/`update`/`delete` of a `source='configuration'` row is refused **by the database**), Task 10's live 403s for trainee and partner, and Task 9's restart test (an admin row survives; a configuration row the variable no longer names does not). No verification gap. |
| A role-mapping change **names its effect before it happens** | **Rendered string** | Task 10's route returns the sentence; Task 11's render asserts the confirmation shows it verbatim and that the confirm control is disabled until the role name is typed. *Does not prove:* that an admin reads it. |
| An admin can **disable and pseudonymise a person** | **Fully provable** | Task 12's compose test: disable, then that person's next request is `account_disabled` 403; pseudonymise, then the directory shows the pseudonym and `finding_disposition_event`'s rows are byte-identical before and after. No verification gap. |
| The **providers screen** shows jurisdiction and credential status and **no key** | **Mechanism + rendered string** | Task 13's sweep over the shipped route's bodies, errors and logs for every configured credential value, plus Task 14's render. *Does not prove:* that the S2 sentence is understood. |
| The **workspace audit export** states coverage, instant and completeness | **Fully provable, over bytes** | Task 15 generates the export in a test and asserts over its bytes: the manifest, the three source names, the counts, the instant, the timezone — and that an over-limit request is **refused** rather than truncated. No verification gap. |
| **Nothing notifies outside the app**, and the app says so | **Rendered string + scanner** | Task 2's copy assertion and Task 16's scanner (no mail transport, no webhook, no outbound host in `apps/api`). |

**What only a person at a browser can confirm, listed once and not pretended away** — carried to Task 16, to the report and to the README:

1. Whether the counter's "not known" marker reads as *not known* rather than as decoration — the single most consequential rendering judgement in Part 5A.
2. Whether the assignee chip reads as *asked to look* rather than as *checked* or as *owns this*.
3. Whether the `⌘K` palette's failed state reads as a failure rather than as an empty result, and whether the corpus sentence is noticed at all.
4. Whether the Report tab reads as a report or as a third list.
5. Whether an administrator reads the widening sentence before confirming, and whether the typed-role confirmation reads as a safeguard rather than as friction.
6. Whether the audit export, opened in a spreadsheet, reads as an extract with a stated scope.
7. Everything Stage 4's report already listed and nobody has seen: two profiles in one review, presence appearing and going, the stale banner on a cut network, the refusal notice.
8. The deployed two-account pass (§18 item 9), Entra's group-claim shape and its overage case (§5.1's "what local does not prove").
9. Container Apps ingress for a long-lived WebSocket (**Spike 3's unanswered half**), **Spike 2's Azure half**, and **§18 item 10(c)** — all three still open, all three needing an environment that has not been reachable for four stages.

---

## Declared surfaces, caps and timeouts

Every tier that can silently cap, drop or truncate. **Task 16 asserts each name below has a reader in the shipped source**, extending `caps.test.ts` rather than duplicating it. Four undeclared-cap defects have been found in this repository and every one read as correct code.

| Tier | Name | Value | Declared in | What happens at the cap |
|---|---|---|---|---|
| Search hits per source | `API_SEARCH_LIMIT_PER_SOURCE` | 20 | `apps/api/src/config.ts` (**new**) | that source reports `status: 'capped'` with its limit; the palette says so |
| Search minimum query | `SEARCH_MIN_CHARS` | 2 | `src/features/search/useSearch.ts` (**new**) | below it the palette shows its idle state, never an empty result |
| Search debounce | `SEARCH_DEBOUNCE_MS` | 200 ms | `src/features/search/useSearch.ts` (**new**) | keystrokes coalesce; a response for an older query is discarded by sequence, never rendered |
| Audit export row ceiling | `API_AUDIT_EXPORT_MAX_ROWS` | 50 000 per source | `apps/api/src/config.ts` (**new**) | the request is **refused** `413` naming the source and its count (P57) |
| Audit export default range | `AUDIT_EXPORT_DEFAULT_DAYS` | 90 | `src/features/admin/AuditExportPanel.tsx` (**new**) | the panel opens on a bounded range rather than "everything", and the range is always in the manifest |
| Assignee inbox page | `API_ASSIGNMENT_INBOX_LIMIT` | 200 | `apps/api/src/config.ts` (**new**) | the page reports `capped: true`; the counter renders `200+` and never a wrong exact number |

**Every new key above is `sameEverywhere` and is added to `apps/api/test/divergence.json` in the commit that introduces it**, or `configSurface.test.ts` fails — in both directions, which is the half that catches a row with no key behind it.

---

## File Structure

```
packages/core/
  src/api/records.ts                 MODIFY  AssignmentInboxItem, AssignmentInboxPage, ReviewAssignments (T1,T3);
                                             SearchHit, SearchSourceOutcome, SearchResults (T4);
                                             RoleMappingView, RoleMappingsPage, RoleMappingEffect (T10);
                                             ProviderStatus, ProvidersPage (T13);
                                             AuditExportManifest (T15)
  src/index.ts                       MODIFY  every new export named here or S14 cannot see it

apps/api/
  migrations/014_role_mapping_source.sql NEW  source column, backfill, RLS, bounded grants (T8)
  src/config.ts                      MODIFY  the four new caps, in this file ONLY
  src/routes/assignments.ts          MODIFY  the inbox's context fields (T1); the review-scoped read (T3)
  src/routes/search.ts                  NEW  GET /v1/search — one statement, per-source outcome (T4)
  src/routes/admin/roleMappings.ts      NEW  list, create, update, delete — admin rows only (T10)
  src/routes/admin/people.ts            NEW  disable, enable, pseudonymise (T12)
  src/routes/admin/providers.ts         NEW  proxies the gateway's credential status (T14)
  src/routes/admin/auditExport.ts       NEW  the manifest and the three arms (T15)
  src/auth/roles.ts                  MODIFY  seedRoleMappings owns configuration rows only (T9)
  src/audit/actions.ts               MODIFY  role_mapping.* and user.* verbs (T10, T12)
  src/auth/routeTable.ts             MODIFY  one line per new route
  src/server.ts                      MODIFY  register the new route groups
  test/helpers/threeAccounts.ts         NEW  trainee + partner + admin (T1)
  test/assignmentInbox.pg.test.ts       NEW  T1
  test/assignedToMe.compose.test.ts     NEW  T2: two matters, one socket, a live count
  test/reviewAssignments.pg.test.ts     NEW  T3
  test/search.pg.test.ts                NEW  T4: corpus, scoping, precedents, a failing arm
  test/roleMappingGrants.pg.test.ts     NEW  T8: the policy, both directions, mutation-tested
  test/roleMappingSeed.pg.test.ts       NEW  T9: restart semantics and the loud supersession
  test/roleMappings.compose.test.ts     NEW  T10: three accounts, three statuses
  test/people.compose.test.ts           NEW  T12: disable, refuse, pseudonymise, history untouched
  test/providers.compose.test.ts        NEW  T14: no key anywhere in the proxied answer
  test/auditExport.pg.test.ts           NEW  T15: the manifest, the counts, the refusal
  test/stage5abDoD.test.ts              NEW  T7: the part gate, and what is guarded from arriving early
  test/stage5DoD.test.ts                NEW  T16
  test/stage5DoD.compose.test.ts        NEW  T16
  test/stage2DoD.test.ts             MODIFY  R-G1's guard, inverted where a mechanism now exists (T2,T3)
  test/stage4DoD.test.ts             MODIFY  the three Stage 5 absences, inverted (T2,T3,T5,T6)
  test/caps.test.ts                  MODIFY  the new tiers
  test/configSurface.test.ts         MODIFY  the new keys, both directions
  test/divergence.json               MODIFY  the new keys
  test/authz.route.test.ts           MODIFY  one entry per new route
  test/grants.pg.test.ts             MODIFY  the role_mapping assertion, narrowed rather than deleted (T8)

apps/gateway/
  src/routes/adminCredentials.ts        NEW  GET /v1/admin/credentials — configured, rotatedAt, nothing else (T13)
  src/server.ts                      MODIFY  register it
  test/credentials.test.ts           MODIFY  §14's sweep, against the shipped ROUTE (T13)

src/
  lib/api/assignments.ts             MODIFY  the inbox call and the review-scoped call (T1, T3)
  lib/api/search.ts                     NEW  the search client — rejects, never resolves empty (T4)
  lib/api/admin.ts                      NEW  role mappings, people, providers, audit export (T10,T12,T14,T15)
  lib/assignedToMe.ts                   NEW  the three-state store, fed by the socket (T2)
  features/assignments/AssignedToMe.tsx NEW  the counter and its "not known" marker (T2)
  features/assignments/AssigneeChip.tsx NEW  a chip is not a disposition (T3)
  features/search/useSearch.ts          NEW  debounce, sequence, four states (T5)
  features/search/SearchPalette.tsx     NEW  the palette, and the sentence saying what it searches (T5)
  features/review/ReportView.tsx        NEW  the third renderer over one findings map (T6)
  features/admin/AdminScreen.tsx        NEW  the admin shell and its four panels (T11)
  features/admin/RoleMappingPanel.tsx   NEW  policy, its source, and the widening sentence (T11)
  features/admin/PeoplePanel.tsx        NEW  disable, enable, pseudonymise (T12)
  features/admin/ProvidersPanel.tsx     NEW  read-only by construction (T14)
  features/admin/AuditExportPanel.tsx   NEW  coverage, instant, refusal (T15)
  lib/router.ts                      MODIFY  { name: 'admin'; section } (T11)
  App.tsx                            MODIFY  T2, T5, T6, T11
  index.css                          MODIFY  any new colour role, in the commit that uses it

CLAUDE.md                            MODIFY  T2, T3, T5, T6, T11 — one clause each, in the task that makes it true
README.md                            MODIFY  T14, T16, T17
docs/superpowers/redesign/rulings.md MODIFY  T17
```

---

# PART 5A — the affordances R-G1 dropped, over the mechanism Stage 4 built

---

## Task 1: The cross-matter inbox, and the context an assignee needs to act

**Type:** feature, and the stage's pre-flight. **Start here even if you intend to start elsewhere** — Step 1 is a demonstration, not a formality, and it decides the shape of Tasks 2 and 3.

**Files:**
- Create: `apps/api/test/helpers/threeAccounts.ts`, `apps/api/test/assignmentInbox.pg.test.ts`
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `apps/api/src/routes/assignments.ts`, `apps/api/src/config.ts`
- Modify: `apps/api/test/divergence.json`, `apps/api/test/configSurface.test.ts`, `apps/api/test/caps.test.ts`
- Modify: `src/lib/api/assignments.ts`, `src/lib/api/assignments` callers in `src/App.tsx` (read them first; there are two)

**Interfaces:**
- Consumes: `AssignmentView`, `AssignmentsPage` (`packages/core/src/api/records.ts` — **do not redeclare either**); the `assignment_assignee_idx` partial index (`013_assignment.sql`); `twoAccounts` / `signIn` / `asUser` (`apps/api/test/helpers/twoAccounts.ts`); `readConfig`'s existing integer-cap idiom in `apps/api/src/config.ts` — copy the shape of `API_EVENT_PAGE_MAX`, do not invent a second one.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // packages/core/src/api/records.ts
  /**
   * One open request, with enough context to act on it from a screen that
   * is not inside any particular matter.
   *
   * COMPOSED, not extended. `AssignmentView` is the row and is what the
   * socket carries; this is the row PLUS the names of the things it points
   * at, resolved server-side in the same statement. Extending would have
   * made one type mean two things depending on where it came from, which is
   * how a payload ends up carrying a name (Stage 4 interface note 3).
   */
  export interface AssignmentInboxItem {
    assignment: AssignmentView;
    matterId: string;
    matterName: string;
    reviewName: string;
    /** The clause's title from the review's own playbook SNAPSHOT, never
     *  from the playbook as it stands today — a review's snapshot is what it
     *  claims to have checked, and a title read live would rename history.
     *  ABSENT when the snapshot no longer holds that clause id: "a clause
     *  this review no longer has" is a real state and inventing a title for
     *  it would be worse than saying so. */
    clauseTitle?: string;
  }

  export interface AssignmentInboxPage {
    items: AssignmentInboxItem[];
    /** True when `API_ASSIGNMENT_INBOX_LIMIT` was reached. A counter reads
     *  this and renders `200+` rather than a number that is wrong. */
    capped: boolean;
  }
  ```
  ```ts
  // src/lib/api/assignments.ts
  /** Every open request addressed to ME, across every matter. Rejects on
   *  failure; NEVER resolves to an empty page. */
  export async function getMyInbox(): Promise<AssignmentInboxPage>;
  ```

- [ ] **Step 1: Demonstrate what the shipped cross-matter call actually returns**

Not a test yet — a run, written down. This is the finding Tasks 2 and 3 are built on and it must be seen rather than believed.

```bash
npm run compose:up
# two accounts, two matters, one assignment each way
node --input-type=module -e "$(cat <<'JS'
import { twoAccounts, asUser } from './apps/api/test/helpers/twoAccounts.ts';
const { trainee, partner } = await twoAccounts();
const r = await asUser(partner, 'GET', '/v1/assignments?state=open');
console.log(r.status, JSON.stringify(await r.json(), null, 2));
JS
)"
```

Record in the task report: the response carries `reviewId`, `findingsKey`, `clauseId` and two user ids, and **no matter, no review name and no clause title**. A cross-matter inbox rendered from this shows three opaque strings. That is disagreement 5, confirmed rather than assumed.

- [ ] **Step 2: `threeAccounts` — the helper Part 5C cannot be written without**

```ts
// apps/api/test/helpers/threeAccounts.ts
import { signIn, type TestAccount } from './twoAccounts.ts';

/**
 * A trainee, a partner and an admin (P61).
 *
 * `twoAccounts()` answers "two people in one review". Every privilege
 * assertion in Part 5C needs a THIRD shape: a caller who holds the
 * privilege, and two who do not and must be refused for two different
 * reasons — a reviewer because they are a reviewer, a partner because
 * `partner` is not a superset of `admin` (§7: "an admin is not a
 * super-reviewer").
 *
 * A test with only the admin proves the route works and proves nothing
 * about the gate, which is the shape of a test that cannot fail.
 */
export async function threeAccounts(): Promise<{
  trainee: TestAccount; partner: TestAccount; admin: TestAccount;
}> {
  const [trainee, partner, admin] = await Promise.all([
    signIn('trainee'), signIn('partner'), signIn('admin'),
  ]);
  return { trainee, partner, admin };
}
```

Run it once before writing anything against it: `signIn('admin')` must return `role: 'admin'`. If it does not, the realm's group mapping is the finding and it is reported before Task 8 is planned around it.

- [ ] **Step 3: The failing tests**

```ts
// apps/api/test/assignmentInbox.pg.test.ts
it('answers every open request addressed to me, across matters', async () => {
  // Two matters, two reviews, one assignment in each, both to the partner.
  const page = await inboxOf(partner);
  expect(page.items.map(i => i.matterName).sort()).toEqual(['Matter A', 'Matter B']);
  expect(page.items.every(i => i.reviewName.length > 0)).toBe(true);
  expect(page.capped).toBe(false);
});

it('names the clause from the review SNAPSHOT, not the playbook as it stands', async () => {
  // Rename the clause in the live playbook version after the review ran.
  await renameClauseInPlaybook(clauseId, 'Liability cap (revised)');
  const [item] = (await inboxOf(partner)).items;
  expect(item.clauseTitle).toBe('Liability cap');
});

it('omits clauseTitle rather than inventing one when the snapshot lost the clause', async () => {
  const [item] = (await inboxOf(partner)).items;
  // ABSENT, not undefined-valued: structuredClone preserves an
  // undefined-valued key and an `in` check would read it as a title.
  expect('clauseTitle' in item).toBe(false);
});

it('answers only MY requests — the assigner sees nothing of their own', async () => {
  expect((await inboxOf(trainee)).items).toHaveLength(0);
  expect((await inboxOf(partner)).items).toHaveLength(2);
});

it('never crosses a workspace, and never returns a resolved request', async () => { /* … */ });

it('reports capped rather than silently returning a short page', async () => {
  // Seed API_ASSIGNMENT_INBOX_LIMIT + 1 open requests.
  const page = await inboxOf(partner);
  expect(page.items).toHaveLength(INBOX_LIMIT);
  expect(page.capped).toBe(true);
});
```

- [ ] **Step 4: Run and watch them fail.** `npm run test:pg -- assignmentInbox`. Expected: the route answers `AssignmentsPage`, so every assertion on `items` fails on an undefined property — which is the right failure.

- [ ] **Step 5: One statement, joining the context**

The handler keeps its existing shape (`state=open`, actor from the token, never a query parameter) and gains a second projection selected by whether `review` was supplied:

- with `review`: unchanged, answers `AssignmentsPage`. Stage 4's callers keep working, byte for byte.
- without `review`: answers `AssignmentInboxPage`, from **one** statement joining `assignment` → `review` → `matter`, `order by created_at desc`, `limit $limit + 1` so `capped` is honest rather than guessed (the same `limit + 1` idiom `readEvents` already uses — read it and copy it rather than writing a `count(*)`).

`clauseTitle` comes out of `review.playbook_snapshot`'s JSON in the same statement. **Do not join the playbook version.** The snapshot is what the review claims to have checked (`CLAUDE.md`), and a title read live renames history.

- [ ] **Step 6: The cap, declared where a cap is declared**

`API_ASSIGNMENT_INBOX_LIMIT`, default 200, in `apps/api/src/config.ts` **only**; added to `apps/api/test/divergence.json` as `sameEverywhere` and to `caps.test.ts`'s tier list **in this commit**, or `configSurface.test.ts` fails in one direction and `caps.test.ts` in the other.

- [ ] **Step 7: The client**

`getMyInbox()` beside the shipped three calls, with the same rules stated in that file's own docstring: **no cache, rejects on failure, never resolves to an empty page.** Do not change `getOpenAssignments`; Task 3 and the Stage 4 review surface both still use it.

- [ ] **Step 8: Gates and commit**

```bash
npm run typecheck
npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"; tail -30 /tmp/t.txt
npm run test:pg
git add apps/api/test/helpers/threeAccounts.ts apps/api/test/assignmentInbox.pg.test.ts \
  packages/core/src/api/records.ts packages/core/src/index.ts \
  apps/api/src/routes/assignments.ts apps/api/src/config.ts \
  apps/api/test/divergence.json apps/api/test/configSurface.test.ts apps/api/test/caps.test.ts \
  src/lib/api/assignments.ts
git commit -m "feat: the inbox answers across matters, and says what each request is about"
git show --stat HEAD
```

---

## Task 2: "Assigned to me" — a counter that never says zero when it does not know

**Type:** feature. **Inverts two shipped absence assertions (P46).** Edits `CLAUDE.md`.

**Files:**
- Create: `src/lib/assignedToMe.ts`, `src/lib/assignedToMe.test.ts`, `src/features/assignments/AssignedToMe.tsx`, `src/features/assignments/AssignedToMe.test.tsx`
- Create: `apps/api/test/assignedToMe.compose.test.ts`
- Modify: `src/App.tsx`, `src/index.css` (only if a new colour role is needed — in this commit if so)
- Modify: `apps/api/test/stage2DoD.test.ts`, `apps/api/test/stage4DoD.test.ts`
- Modify: `src/features/assignments/AssignPanel.tsx` and its test (P59's sentence)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `getMyInbox` (Task 1); `AssignmentInboxPage`; `describeLoadError` (`src/lib/loadError.ts`); the socket's `assignment.created` / `assignment.resolved` frames and `src/lib/api/socket.ts`'s subscription API — **read that file before assuming a subscribe shape**; `userName` (`src/lib/api/users.ts`).
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // src/lib/assignedToMe.ts
  /**
   * THREE STATES, and the third is the point (P47).
   *
   * `ready` with `count: 0` renders as nothing at all. `error` renders as a
   * marker with a sentence. They must not be the same pixel: a badge that
   * hides a request because a fetch failed is a lawyer not doing something a
   * colleague is waiting on, and it looks exactly like a quiet week.
   */
  export type AssignedToMe =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; count: number; capped: boolean };

  /** Reads the inbox now, and re-reads it when the socket says something
   *  addressed to this person changed. Returns an unsubscribe. */
  export function watchAssignedToMe(
    onChange: (state: AssignedToMe) => void,
    deps?: { load?: () => Promise<AssignmentInboxPage>; subscribe?: Subscribe },
  ): () => void;
  ```

- [ ] **Step 1: The failing tests, table-driven over the states**

```ts
// src/lib/assignedToMe.test.ts
it('starts in loading and never in ready-zero', async () => {
  const seen: AssignedToMe[] = [];
  watchAssignedToMe(s => seen.push(s), { load: neverResolves });
  expect(seen[0]).toEqual({ status: 'loading' });
  // The mutation this kills: `useState({ status: 'ready', count: 0 })`.
  expect(seen.some(s => s.status === 'ready')).toBe(false);
});

it('reports a failed read as an error carrying describeLoadError s sentence', async () => {
  const seen: AssignedToMe[] = [];
  watchAssignedToMe(s => seen.push(s), { load: () => Promise.reject(new Error('offline')) });
  await flushUntil(() => seen.at(-1)?.status === 'error');
  expect(seen.at(-1)).toMatchObject({ status: 'error' });
  expect((seen.at(-1) as { message: string }).message).toContain('offline');
});

it('re-reads when the socket says a request addressed to me changed', async () => { /* … */ });

it('does not re-read for somebody else s assignment', async () => {
  // The frame carries the whole row; the guard is assigneeUserId === me.
  // Without it every assignment in the workspace costs every open tab a read.
});
```

```tsx
// src/features/assignments/AssignedToMe.test.tsx
const CASES: [AssignedToMe, { text: string; hasBadge: boolean }][] = [
  [{ status: 'loading' }, { text: '', hasBadge: false }],
  [{ status: 'ready', count: 0, capped: false }, { text: '', hasBadge: false }],
  [{ status: 'ready', count: 3, capped: false }, { text: '3', hasBadge: true }],
  [{ status: 'ready', count: 200, capped: true }, { text: '200+', hasBadge: true }],
  [{ status: 'error', message: 'The network is unavailable.' },
   { text: 'not known', hasBadge: true }],
];

it.each(CASES)('renders %o distinctly', (state, expected) => { /* … */ });

it('never renders a digit in the error state', () => {
  const { root } = mountOnce(<AssignedToMe state={{ status: 'error', message: 'x' }} />);
  expect(root.textContent).not.toMatch(/\d/);
  expect(root.textContent).toMatch(/not known/i);   // the sanity half
});

it('carries the reason where a person can reach it', () => {
  // title AND aria-label, because a marker whose explanation is only in a
  // hover is an explanation a keyboard user does not have.
});
```

- [ ] **Step 2: Run and watch fail.** `npx vitest run src/lib/assignedToMe src/features/assignments/AssignedToMe`.

- [ ] **Step 3: Implement, and read the socket before wiring it**

`watchAssignedToMe` loads once, then re-loads (coalesced, one in flight at a time) on an `assignment.created` or `assignment.resolved` frame **whose `assignment.assigneeUserId` is the local user**. Nothing derives the count from the frames themselves: a frame is a doorbell (P39, Stage 4 interface note 6), and a count maintained by incrementing on pushes diverges the first time a frame is missed.

`AssignedToMe.tsx` maps each state's **complete** class string in a `Record<AssignedToMeKind, string>` and indexes into it. Never build the tail of a class name from a variable — Tailwind will silently generate nothing.

- [ ] **Step 4: Invert the two shipped absence assertions, in this commit (P46)**

`apps/api/test/stage2DoD.test.ts`, in *"no collaborative affordance shipped AHEAD OF ITS MECHANISM (R-G1)"*: the forbidden pattern currently covers `assign(ed)?[- ]?to[- ]?me` and `assigneeChip`. Remove the first from the forbidden set and add a **positive** assertion in its place:

```ts
// The counter's mechanism is real (Stage 4's assignment table; Stage 5
// Task 1's cross-matter inbox), so S18 releases it. What replaces the
// prohibition is the thing that keeps it honest:
expect(grepRepo(/assignedToMe/, WEB_SOURCES)).toContain('src/lib/assignedToMe.ts');
// …and the counter has THREE states, asserted at its source rather than by
// hoping the component test covers it.
expect(codeOf(at('src/lib/assignedToMe.ts'))).toMatch(/status: 'error'/);
// `assigneeChip` stays forbidden until Task 3, and `assigneeId` in a .tsx
// stays forbidden for good.
```

Do the same in `apps/api/test/stage4DoD.test.ts`'s *"still ships no assignee chip and no assigned-to-me counter (S18)"*: split it into two `it`s — the chip's prohibition survives to Task 3 unchanged, the counter's becomes the positive assertion above. **Keep the existing sanity line** (`expect(FORBIDDEN.test('const n = assignedToMe.length')).toBe(true)`) on whichever half still forbids something.

- [ ] **Step 5: P59's sentence, where the request is made**

In `AssignPanel.tsx`, beside the assignee picker, one line of declared copy:

> They will see this the next time they open LexPrompt. Nothing is sent by email or chat.

Asserted by `AssignPanel.test.tsx` as an exact string. This is the honest form of §17 Q2 being unanswered: the app states its own reach rather than letting a person assume a notification that does not exist.

- [ ] **Step 6: The live check — two matters, one socket, a moving number**

```ts
// apps/api/test/assignedToMe.compose.test.ts
it('counts across matters and moves when a request is resolved, within a second', async () => {
  // trainee assigns in matter A and matter B, both to partner
  // partner's inbox: 2
  // partner's own socket receives assignment.created twice
  // trainee resolves one; partner's inbox: 1, and the frame arrived
});
```

Delete every row this suite created before it finishes (standing rule 8): two matters, two reviews, two findings, two assignments. Say in the report that you did.

- [ ] **Step 7: Edit `CLAUDE.md`, in this commit (P38 carried forward)**

In "Deliberate non-features", the sentence *"Still **not** built, and still Stage 5 (S18): the assignee **chip** on a card in a list, the **"assigned to me"** counter on the home screen, and firm-wide search…"* loses the counter and keeps the rest, and gains:

> **As of Stage 5 there is an "assigned to me" counter, and it has three states rather than two.** It reads the cross-matter inbox (`GET /v1/assignments?state=open` with no review), re-reads when the socket says a request addressed to *you* changed, and never derives a number from the frames themselves — a count maintained by incrementing on pushes diverges the first time one is missed. `ready` with a count of zero renders **nothing**; a failed read renders a marker saying **"not known"** with the reason, and never a digit. Those two must not be the same pixel: a badge showing `0` because a fetch failed is a lawyer not doing something a colleague is waiting on, and it looks exactly like a quiet week. `AssignedToMe.test.tsx` asserts the absence of any digit in the error state. **Nothing notifies anybody outside the app** — the assign panel says so where the request is made, because §17 Q2 is the owner's to answer and an unstated absence is the silence R-G1 was written about.

- [ ] **Step 8: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npm run test:compose
git add src/lib/assignedToMe.ts src/lib/assignedToMe.test.ts \
  src/features/assignments/AssignedToMe.tsx src/features/assignments/AssignedToMe.test.tsx \
  src/features/assignments/AssignPanel.tsx src/features/assignments/AssignPanel.test.tsx \
  src/App.tsx src/index.css \
  apps/api/test/assignedToMe.compose.test.ts \
  apps/api/test/stage2DoD.test.ts apps/api/test/stage4DoD.test.ts CLAUDE.md
git commit -m "feat: assigned to me, and the state where it does not know"
git show --stat HEAD
```

**Mutation to run and record:** replace the error branch's marker with `count: 0`'s empty render. `AssignedToMe.test.tsx` › *"never renders a digit in the error state"* and the `it.each` row for `error` must both go red. If only one does, the table is not covering what it claims.

---

## Task 3: The assignee chip — and a chip is not a disposition

**Type:** feature. **Inverts the last of `stage4DoD`'s two Stage 5 prohibitions.** Edits `CLAUDE.md`.

**Files:**
- Create: `src/features/assignments/AssigneeChip.tsx` and its test
- Create: `apps/api/test/reviewAssignments.pg.test.ts`
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `apps/api/src/routes/assignments.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/test/authz.route.test.ts`
- Modify: `src/lib/api/assignments.ts`, `src/features/review/FindingCard.tsx`, `src/features/review/ClauseIndex.tsx`, `src/features/tabular/TabularReview.tsx` and their tests
- Modify: `apps/api/test/stage2DoD.test.ts`, `apps/api/test/stage4DoD.test.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `assignment_review_idx` (`013_assignment.sql`, `where resolved_at is null`); `userName` / `userInitials`; `PresenceRoster.tsx` — **read it, and copy its structure**: it is the shipped answer to "a marker on a clause that is not a state", down to its own colour role and its "is viewing" wording, and this chip is the same problem one step along.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // packages/core/src/api/records.ts
  /** Every OPEN request on one review, whoever it was addressed to. A
   *  different question from `GET /v1/assignments`, which answers only the
   *  caller's own queue — and it needs its own route entry for that reason
   *  (`routeTable.ts`'s own docstring makes the distinction). */
  export interface ReviewAssignments {
    assignments: AssignmentView[];
  }
  ```
  ```ts
  // src/lib/api/assignments.ts
  export async function getReviewAssignments(reviewId: string): Promise<AssignmentView[]>;
  ```

- [ ] **Step 1: The failing tests**

```ts
// apps/api/test/reviewAssignments.pg.test.ts
it('lists every OPEN request on the review, whoever was asked', async () => {
  // trainee asks partner about clause A; partner asks trainee about clause B
  const seen = await reviewAssignments(trainee, reviewId);
  expect(seen.map(a => a.clauseId).sort()).toEqual(['A', 'B']);
});

it('drops a resolved request', async () => { /* … */ });
it('never crosses a workspace', async () => { /* … */ });
it('refuses an unauthenticated caller with 401 and not an empty list', async () => { /* … */ });
```

```tsx
// src/features/assignments/AssigneeChip.test.tsx
it('names the person asked, and says what the chip means in words', () => {
  const { root } = mountOnce(<AssigneeChip assignment={ASKED_OF_PARTNER} nameOf={nameOf} />);
  expect(root.textContent).toContain('R. Okafor');
  expect(root.textContent).toMatch(/asked to look/i);
});

it('never uses a disposition word', () => {
  const { root } = mountOnce(<AssigneeChip assignment={ASKED_OF_PARTNER} nameOf={nameOf} />);
  for (const word of ['Verified', 'Flagged', 'Rejected', 'Checked', 'Unchecked', 'Approved']) {
    expect(root.textContent).not.toContain(word);
  }
  // The sanity half: the scan can see the words it is looking for.
  expect('Verified by R. Okafor').toContain('Verified');
});

it('never draws itself in a state or outcome ink', () => {
  // Mirrors PresenceRoster.test.tsx's own assertion. Read that test and
  // reuse its class list rather than writing a second one.
});

it('renders the assigner and the message when there is one', () => { /* … */ });

it('renders nothing at all for an id the directory does not hold', () => {
  // NOT a raw id, and NOT "Unknown". `userName` returns undefined; the chip
  // renders "someone this workspace does not name", the wording Stage 4
  // already chose for the activity feed. One wording, two surfaces.
});
```

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- reviewAssignments` and `npx vitest run AssigneeChip`.

- [ ] **Step 3: The route, with its own `ROUTE_POLICY` line and its own reasoning**

```
'GET /v1/reviews/:id/assignments': 'reviewer',
```

with a comment saying why it is not "reading another person's queue": it answers *what is outstanding on this review*, scoped to one review the caller can already read, and it is the fact a card needs to show that somebody has been asked. The caller's own queue stays at `GET /v1/assignments` and stays token-scoped. Add the entry to `authz.route.test.ts` in this commit or registration fails.

- [ ] **Step 4: The chip, and where it goes**

`FindingCard` renders it beside the disposition line — **never inside it and never in its place**. `ClauseIndex` renders the initials form on the clause row, exactly as `ClausePresence` does. `TabularReview` renders the initials form in the cell, which is the surface Stage 4 had to declare an exemption for on attribution (R-S4E10) — **do not extend that exemption**: a chip is not a disposition, so it has nothing to be exempt from.

- [ ] **Step 5: Invert the last prohibition (P46)**

In both `stage2DoD.test.ts` and `stage4DoD.test.ts`, `assigneeChip` comes out of the forbidden set and is replaced by positive assertions:

```ts
expect(grepRepo(/AssigneeChip/, COMPONENTS)).toContain('src/features/assignments/AssigneeChip.tsx');
// …and the rule that outlives the prohibition: the chip may not render a
// disposition word or a state ink, asserted over the component's source as
// well as over its render, because a class added in a hurry is not
// something a render test with three fixtures would catch.
const chip = codeOf(at('src/features/assignments/AssigneeChip.tsx'));
expect(chip).not.toMatch(/text-state-|bg-state-|text-outcome-/);
expect('text-state-verified').toMatch(/text-state-/);   // the sanity half
```

**`assigneeId` in a `.tsx` stays forbidden.** The chip reads `assignment.assigneeUserId`; the retired `Verification.assigneeId` (S17) must not return through a component. Confirm that half of the shipped assertion is untouched.

- [ ] **Step 6: Edit `CLAUDE.md`, in this commit**

Add, beside "A face is not a disposition":

> **A chip is not a disposition either, and for the same reason.** The assignee chip (`src/features/assignments/AssigneeChip.tsx`, Stage 5) says somebody was **asked to look** at a clause. It carries no tick, no flag and no cross; it never uses a disposition word; it never draws itself in a state or outcome ink; and it renders "someone this workspace does not name" for an id the directory does not hold — the same wording the activity feed uses, because two wordings for one fact is how they come to disagree. `AssigneeChip.test.tsx` asserts the absence of every disposition word and every state class, over the render **and** over the source. The retired `Verification.assigneeId` (S17) stays retired: no `.tsx` may name it, and the chip reads `AssignmentView.assigneeUserId`, which is a different field on a different record.

Remove the assignee chip from the "Still not built" sentence; **firm-wide search stays in it until Task 5**.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npm run test:pg
git add packages/core/src/api/records.ts packages/core/src/index.ts \
  apps/api/src/routes/assignments.ts apps/api/src/auth/routeTable.ts \
  apps/api/test/reviewAssignments.pg.test.ts apps/api/test/authz.route.test.ts \
  apps/api/test/stage2DoD.test.ts apps/api/test/stage4DoD.test.ts \
  src/lib/api/assignments.ts src/features/assignments/AssigneeChip.tsx \
  src/features/assignments/AssigneeChip.test.tsx \
  src/features/review/FindingCard.tsx src/features/review/FindingCard.test.tsx \
  src/features/review/ClauseIndex.tsx src/features/review/ClauseIndex.test.tsx \
  src/features/tabular/TabularReview.tsx src/features/tabular/TabularReview.test.tsx \
  src/App.tsx CLAUDE.md
git commit -m "feat: who was asked, on the card and on the clause"
git show --stat HEAD
```

**Mutation to run and record:** give the chip `className="text-state-verified"`. `AssigneeChip.test.tsx` › *"never draws itself in a state or outcome ink"* and `stage4DoD.test.ts`'s source scan must both go red.

---

# PART 5B — finding things, and seeing what the export will say

---

## Task 4: The search corpus, declared — and an outcome for every source

**Type:** feature. This task decides what "firm-wide search" means in this system, and the decision is more of the work than the query is.

**Files:**
- Create: `apps/api/src/routes/search.ts`, `apps/api/test/search.pg.test.ts`, `src/lib/api/search.ts`, `src/lib/api/search.test.ts`
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/api/src/auth/routeTable.ts`
- Modify: `apps/api/test/authz.route.test.ts`, `apps/api/test/divergence.json`, `apps/api/test/configSurface.test.ts`, `apps/api/test/caps.test.ts`, `apps/api/test/workspaceScope.test.ts`

**Interfaces:**
- Consumes: `matter`, `document` (with its `kind` column from `003_precedent.sql` — **read it**), `review`, `collection`, `playbook`, `playbook_version` and its clause JSON; `apps/api/src/routes/activity.ts`'s `UNION` — read it first, because this is the same statement shape at a different scope and it is not a second query language; `ModelError` for the refusals.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // packages/core/src/api/records.ts
  export type SearchSource =
    | 'matter' | 'document' | 'precedent' | 'review' | 'collection'
    | 'playbook' | 'clause';

  export interface SearchHit {
    source: SearchSource;
    /** The record's own id. A `clause` hit carries the PLAYBOOK's id here
     *  and the clause id in `clauseId`, because a clause is not a record a
     *  URL can open on its own. */
    id: string;
    title: string;
    /** The one line of context that makes a hit legible — a matter's client,
     *  a document's matter name, a clause's playbook name. ABSENT rather
     *  than empty when there is none. */
    context?: string;
    clauseId?: string;
    matterId?: string;
  }

  /**
   * WHAT HAPPENED TO EACH ARM, always, including on a completely successful
   * search (P49).
   *
   * A result set with no per-source outcome cannot distinguish "nothing
   * matched" from "one arm threw and the rest matched nothing" — and those
   * two render identically as an empty list, which is this project's
   * founding defect at a search box.
   */
  export interface SearchSourceOutcome {
    source: SearchSource;
    status: 'ok' | 'failed' | 'capped';
    count: number;
    /** Present only for `failed`; a sentence, never a stack. */
    message?: string;
    /** Present only for `capped`; the limit that was reached. */
    limit?: number;
  }

  export interface SearchResults {
    query: string;
    hits: SearchHit[];
    sources: SearchSourceOutcome[];
  }
  ```
  ```ts
  // src/lib/api/search.ts
  /** Rejects on a transport failure; NEVER resolves to an empty result set
   *  to represent one. A per-SOURCE failure is inside the answer, not an
   *  exception — the difference is that the other sources' hits survive. */
  export async function search(query: string, signal?: AbortSignal): Promise<SearchResults>;
  ```

- [ ] **Step 1: Record the corpus decision before writing the query (P48)**

Write this into the route's docstring, in full, because it is the fact the screen will state and a future reader will want the reasoning:

> **What is searched:** matter name, client and reference; matter-document name; precedent-document name (returned as its own source, never as a matter document — S23); review name; collection name; playbook name; and clause titles inside each playbook's **current published version**.
>
> **What is not searched: the text inside documents.** Not an oversight and not a limitation of the data — `document.text` is right there. Two reasons. First, there is no index for it and there cannot be a cheap one: `lexprompt_migrator` is not a superuser and `pg_trgm` is not a trusted extension, so a substring index over document bodies is unavailable; Postgres's built-in `tsvector` needs no extension and **would** work, but it matches by stemmed word, so a lawyer searching for a phrase they remember verbatim would sometimes get nothing back from a document that contains it. Second, and decisive: mixing two match semantics in one result list makes an empty result mean two different things, which is exactly what this feature exists not to do. **The screen therefore states the corpus in words, on every result set including an empty one.** Closing this needs a `tsvector` column, a GIN index, and a second labelled section on the palette that explains its own matching — a real feature, named as the next one rather than folded in here.

- [ ] **Step 2: The failing tests**

```ts
// apps/api/test/search.pg.test.ts
it('finds a matter another account created, by name, client and reference', async () => {
  await asUser(partner, 'PUT', `/v1/matters/${id}`, { name: 'Ashcroft lease', client: 'Ashcroft Ltd', reference: 'AL-2026' });
  for (const q of ['ashcroft', 'AL-2026', 'Ashcroft Ltd']) {
    const r = await searchAs(trainee, q);
    expect(r.hits.some(h => h.source === 'matter' && h.id === id)).toBe(true);
  }
});

it('is case-insensitive and matches inside a name, not only at its start', async () => {
  expect((await searchAs(trainee, 'CROFT')).hits.some(h => h.id === id)).toBe(true);
});

it('never returns a precedent document as a matter document (S23)', async () => {
  const r = await searchAs(trainee, 'precedent-name');
  expect(r.hits.filter(h => h.source === 'document')).toHaveLength(0);
  expect(r.hits.filter(h => h.source === 'precedent')).toHaveLength(1);
});

it('never crosses a workspace, in every arm', async () => {
  // Table-driven over SearchSource, so a NEW arm with no entry fails.
  for (const source of ALL_SOURCES) { /* seed in ws2, assert absent */ }
});

it('reports every source on a completely successful search', async () => {
  const r = await searchAs(trainee, 'zzzznothing');
  expect(r.hits).toHaveLength(0);
  expect(r.sources.map(s => s.source).sort()).toEqual([...ALL_SOURCES].sort());
  expect(r.sources.every(s => s.status === 'ok' && s.count === 0)).toBe(true);
});

it('answers with the other arms hits when ONE arm throws (P49)', async () => {
  // Injected: the clause arm is given a runner that rejects.
  const r = await searchWithBrokenArm('clause', 'ashcroft');
  expect(r.hits.some(h => h.source === 'matter')).toBe(true);
  const clause = r.sources.find(s => s.source === 'clause')!;
  expect(clause.status).toBe('failed');
  expect(clause.message).toMatch(/could not be searched/i);
  // …and the response is NOT a 500: a failure in one arm must not throw
  // away the four arms that answered.
});

it('reports capped rather than silently returning a short list', async () => {
  // Seed API_SEARCH_LIMIT_PER_SOURCE + 1 matching matters.
  const m = (await searchAs(trainee, 'many')).sources.find(s => s.source === 'matter')!;
  expect(m).toMatchObject({ status: 'capped', limit: SEARCH_LIMIT });
});

it('refuses a query below the minimum, and says so, rather than answering empty', async () => {
  const res = await asUser(trainee, 'GET', '/v1/search?q=a');
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('query_too_short');
});

it('refuses an unauthenticated caller with 401 and not an empty result', async () => { /* … */ });
```

- [ ] **Step 3: Run and watch fail.** `npm run test:pg -- search`. Expected: 404 on every case, because the route does not exist.

- [ ] **Step 4: Implement — one statement per arm, each arm independently recoverable**

Not one `UNION` this time, and the departure from `activity.ts` is deliberate and worth stating in the docstring: the activity feed's arms must be **ordered and limited together**, which forces one statement; search's arms are **reported separately**, which forces the opposite — a `UNION` that throws loses every arm, and P49's whole content is that it must not. So: one parameterised query per source, run concurrently, each wrapped so a rejection becomes a `SearchSourceOutcome` with `status: 'failed'` rather than a rejected request.

Each arm:
- carries its own `workspace_id = $1` predicate (`workspaceScope.test.ts` walks all of `apps/api/src`);
- carries `kind = 'matter'` or `kind = 'precedent'` on the document arms, never neither;
- matches with `ilike '%' || $2 || '%'` on the named columns, with `$2` **escaped for `like` metacharacters** — `%` and `_` in a user's query must match themselves, or a search for `50%` returns everything;
- `limit $3 + 1` so `capped` is measured rather than guessed.

The clause arm reads titles out of the playbook's **current published version**, joined by `playbook.current_version_id`; an unpublished draft is not searched, and the docstring says so (a draft is a playbook nobody has agreed to — R-E1's reasoning, one layer along).

`ROUTE_POLICY`: `'GET /v1/search': 'reviewer'` with a comment saying why it is not higher — it returns names of records every reviewer can already list, and S10 has no per-matter ACLs for it to respect. **If that ever stops being true, this is the route that has to change first**, and the comment says that too.

- [ ] **Step 5: The cap and the client**

`API_SEARCH_LIMIT_PER_SOURCE` (20) into `config.ts`, `divergence.json` and `caps.test.ts` **in this commit**. `src/lib/api/search.ts` passes an `AbortSignal` through to `apiGet` — read `src/lib/api/client.ts` first and check whether it already accepts one; if it does not, that is a finding for the report rather than a second fetch helper.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npm run test:pg
git add apps/api/src/routes/search.ts apps/api/src/server.ts apps/api/src/config.ts \
  apps/api/src/auth/routeTable.ts apps/api/test/search.pg.test.ts \
  apps/api/test/authz.route.test.ts apps/api/test/divergence.json \
  apps/api/test/configSurface.test.ts apps/api/test/caps.test.ts \
  apps/api/test/workspaceScope.test.ts \
  packages/core/src/api/records.ts packages/core/src/index.ts \
  src/lib/api/search.ts src/lib/api/search.test.ts
git commit -m "feat: one search, a declared corpus, and an outcome for every source"
git show --stat HEAD
```

**Mutation to run and record:** make the failed arm's wrapper swallow the error and return `status: 'ok', count: 0`. `search.pg.test.ts` › *"answers with the other arms hits when ONE arm throws"* must go red on the `status` assertion. **This is the mutation that matters most in Part 5B** — it is the one whose wrong implementation passes every happy-path test.

---

## Task 5: The palette — four states, and the sentence saying what it searches

**Type:** feature. **Discharges R-G14 and inverts its absence assertion (P46).** Edits `CLAUDE.md`.

**Files:**
- Create: `src/features/search/useSearch.ts` and its test, `src/features/search/SearchPalette.tsx` and its test
- Modify: `src/App.tsx`, `src/index.css` (if a new role is needed, in this commit)
- Modify: `apps/api/test/stage4DoD.test.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `search` (Task 4); `SearchResults`; `describeLoadError`; `Modal.tsx` — **read it**, and use it rather than writing a second overlay; `src/lib/router.ts`'s `navigate` for opening a hit.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // src/features/search/useSearch.ts
  /**
   * FOUR states, and the fourth is why this hook exists.
   *
   * `idle` — nothing typed, or below SEARCH_MIN_CHARS.
   * `searching` — a request is in flight.
   * `results` — an answer came back. It may hold zero hits AND a failed
   *   source; those are two different facts and both are in the value.
   * `failed` — the request itself failed. Distinct from `results` with zero
   *   hits, distinct from `results` with a failed source, and rendered
   *   differently from both.
   */
  export type SearchState =
    | { status: 'idle' }
    | { status: 'searching'; query: string }
    | { status: 'results'; results: SearchResults }
    | { status: 'failed'; query: string; message: string };

  export const SEARCH_MIN_CHARS = 2;
  export const SEARCH_DEBOUNCE_MS = 200;

  export function useSearch(deps?: { run?: typeof search }): {
    state: SearchState; query: string; setQuery: (q: string) => void; retry: () => void;
  };
  ```

- [ ] **Step 1: The failing tests**

```ts
// src/features/search/useSearch.test.ts
it('stays idle below the minimum, and never shows an empty result for one letter', async () => {
  // The defect this kills: typing "a" firing a search that returns nothing
  // and rendering "No results" — which is a false statement about the corpus.
});

it('discards a response for a query the user has moved on from', async () => {
  // Two in flight, the FIRST resolving second. The rendered state must be
  // the second query's, by sequence number and not by arrival.
  // Without this, a slow "a" answer overwrites a fast "ashcroft" answer and
  // the screen shows results for something nobody asked.
});

it('renders failed and results-with-zero-hits as different states', async () => {
  expect(afterReject.status).toBe('failed');
  expect(afterEmpty.status).toBe('results');
});

it('retry re-runs the same query rather than clearing it', async () => { /* … */ });
```

```tsx
// src/features/search/SearchPalette.test.tsx
it('says what it searches, on every state including an empty result', () => {
  for (const state of [IDLE, SEARCHING, EMPTY_RESULTS, FAILED]) {
    const { root } = mountOnce(<SearchPalette state={state} … />);
    expect(root.textContent).toMatch(/does not search the text inside documents/i);
  }
});

it('an empty result and a failure do not read the same', () => {
  const empty = textOf(<SearchPalette state={EMPTY_RESULTS} … />);
  const failed = textOf(<SearchPalette state={FAILED} … />);
  expect(empty).toMatch(/nothing matched/i);
  expect(failed).toMatch(/search could not be run/i);
  expect(empty).not.toEqual(failed);
  // …and the failure offers a retry the empty state does not.
  expect(controlsIn(FAILED).map(c => c.textContent)).toContain('Try again');
});

it('names a source that failed even when other sources answered', () => {
  const { root } = mountOnce(<SearchPalette state={PARTIAL} … />);
  expect(root.textContent).toMatch(/clause titles could not be searched/i);
  expect(root.textContent).toContain('Ashcroft lease');   // the hits that DID arrive
});

it('says when a source was capped, with the limit', () => { /* … */ });

it('labels a precedent hit as a precedent and never as a matter document', () => { /* … */ });

it('opens on the shortcut, closes on Escape, and returns focus to what opened it', () => {
  // keyDown from src/test/mount.tsx. jsdom has no scrollIntoView — it is
  // stubbed globally in vitest.setup.ts, call sites do not guard for it.
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

`useSearch` debounces by `SEARCH_DEBOUNCE_MS`, holds a monotonic sequence number, and **discards** any response whose sequence is not the latest — never merges, never renders a stale answer. `AbortSignal` on the superseded request if `client.ts` supports one.

`SearchPalette` uses `Modal.tsx`. The corpus sentence is a module-level constant rendered in every state. Result groups are ordered by source with the group heading naming the source; a `precedent` group is labelled as precedents (S23 in the UI as well as in the query).

**Colour:** if a "this source failed" line needs a role that does not exist, add it to `src/index.css` **in this commit** and map complete class strings in a `Record<SearchSource, string>` — never `` `text-source-${source}` ``.

- [ ] **Step 4: Invert R-G14's absence assertion — and fix its missing sanity check (disagreement 6)**

`stage4DoD.test.ts`'s *"still defers ⌘K and the Report tab, by absence"* is split. The `⌘K` half becomes:

```ts
it('ships firm-wide search, and it declares its own corpus (R-G14 discharged)', () => {
  const palette = grepRepo(/SearchPalette/, COMPONENTS);
  expect(palette).toContain('src/features/search/SearchPalette.tsx');
  // The rule that outlives the deferral: the corpus sentence exists, in ONE
  // place, and the palette renders it.
  expect(codeOf(at('src/features/search/SearchPalette.tsx')))
    .toMatch(/does not search the text inside documents/);
  // The sanity check the shipped guard never had: the scanner can find a
  // component that IS present.
  expect(grepRepo(/LoadErrorPanel/, COMPONENTS).length).toBeGreaterThan(3);
});
```

The Report tab half stays, unchanged, until Task 6 — **and gains the sanity check it has always lacked**, in this commit, because a guard found not guarding is fixed where it is found and not where it is convenient.

- [ ] **Step 5: Edit `CLAUDE.md`, in this commit**

Remove "firm-wide search" from the "Still not built" sentence, and remove `⌘K` from the "Still deferred" sentence. Add:

> **As of Stage 5 there is a firm-wide search, and it says what it searches.** `GET /v1/search` runs one query per source — matters, matter documents, precedent documents, reviews, collections, playbooks and the clause titles of each playbook's **current published version** — concurrently, each scoped by workspace, each independently recoverable, and returns a `SearchSourceOutcome` for **every** source on **every** answer. A source that throws does not fail the request and does not silently shrink it: its hits are missing, the palette names it, and the reader is told. **It does not search the text inside documents**, and the palette says so on every result set including an empty one — matching document bodies needs a `tsvector` column and a GIN index (both core Postgres; `pg_trgm` is unavailable because `lexprompt_migrator` is not a superuser), plus a second match semantics the screen would have to explain. An empty result and a failed search render as different sentences with different controls, asserted by `SearchPalette.test.tsx`: an empty list that really means a broken query is this project's founding defect with a cursor blinking in it.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npx vitest run src/test/palette.test.ts
git add src/features/search/useSearch.ts src/features/search/useSearch.test.ts \
  src/features/search/SearchPalette.tsx src/features/search/SearchPalette.test.tsx \
  src/App.tsx src/index.css apps/api/test/stage4DoD.test.ts CLAUDE.md
git commit -m "feat: firm-wide search, and the difference between nothing and broken"
git show --stat HEAD
```

**Mutation to run and record:** render the `failed` state with the empty state's sentence. `SearchPalette.test.tsx` › *"an empty result and a failure do not read the same"* must go red on both the text and the control assertions.

---

## Task 6: The Report tab — a third renderer over one findings map

**Type:** feature. **Discharges R-G11.** Edits `CLAUDE.md`.

**Files:**
- Create: `src/features/review/ReportView.tsx` and its test
- Modify: `src/App.tsx` (the Cards/Grid segmented control becomes three)
- Modify: `apps/api/test/stage4DoD.test.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: the `findings` map and `dispositions` map App already holds for the card and grid views — **read how `TabularReview` receives them and take the same props**; `ExportContext`, `NO_EXPORT_CONTEXT`, `exportSummaryLine`, `verificationLabel`, `dispositionLabel`, `dispositionsAsAtLine`, `dispositionsMayChangeLine`, `exportDispositionLine`, `positionOutcomeLabel`, `truncationLabel`, `verificationCounts`, `positionOutcomeCounts` (all `src/lib/findingOutcome.ts`). **Every one of these is shipped; none of them is redeclared.**
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `ReportView` — no new exported function, no new string, and that is the deliverable.

**Why this discharges R-G11 rather than reopening it.** R-G11 dropped the tab because *"a `Report` tab advertises a live report view the app does not have, and the handoff never draws one."* The app now has one: `exportDocx.ts` and `csv.ts` produce a report, and every sentence in it comes from `findingOutcome.ts`. So the tab is **a view of the document the export produces** — same data, same functions, same words, before it leaves the building. That is worth having for exactly the reason §19 gives for fearing the export: *"a card is read next to its history; a DOCX is read on a train, six weeks later, by a partner who was not in the review"*. This tab is the last place anyone can look at what the train will carry.

- [ ] **Step 1: The failing tests**

```tsx
// src/features/review/ReportView.test.tsx
it('renders the same summary line the export writes', () => {
  const { root } = mountOnce(<ReportView findings={FINDINGS} context={CONTEXT} … />);
  expect(root.textContent).toContain(exportSummaryLine(FINDINGS));
});

it('renders the as-at instant and the can-change sentence, verbatim', () => {
  expect(text).toContain(dispositionsAsAtLine(CONTEXT.readAt, CONTEXT.timeZone));
  expect(text).toContain(dispositionsMayChangeLine());
});

it('says "not recorded" loudly when nothing was read, exactly as the export does', () => {
  const { root } = mountOnce(<ReportView findings={FINDINGS} context={NO_EXPORT_CONTEXT} … />);
  expect(root.textContent).toContain(dispositionsAsAtLine(undefined, 'UTC'));
});

it('never shows a disposition without its actor and its time', () => {
  // Reuses FindingCard.test.tsx's own eight disposition shapes. Import the
  // fixture rather than writing a ninth: two fixture sets for one rule is
  // how the rule comes to be true of one of them.
  expect(root.textContent).not.toMatch(/Verified(?!\s+by)/);
});

it('declares no display string of its own', () => {
  // The structural half of P50, asserted over the component's source: every
  // string literal in the file is a className, a data attribute, an aria
  // attribute or a heading. Anything else is a fourth home for export
  // wording.
  const literals = displayLiteralsIn(codeOf('src/features/review/ReportView.tsx'));
  expect(literals).toEqual([]);
  // Sanity: the extractor finds literals in a file that HAS them.
  expect(displayLiteralsIn(codeOf('src/components/StalePanel.tsx')).length).toBeGreaterThan(0);
});

it('is the third renderer and not a third pipeline', () => {
  // No fetch, no api import, no findings assembly of its own.
  expect(codeOf('src/features/review/ReportView.tsx')).not.toMatch(/from '.*lib\/api/);
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

`ReportView` takes exactly the props `TabularReview` takes plus the `ExportContext` App already builds for the exporters, and renders, in order: the review's name and playbook version; `exportSummaryLine`; `dispositionsAsAtLine`; `dispositionsMayChangeLine`; then per clause, the summary, `exportDispositionLine`, `positionOutcomeLabel`, `truncationLabel` and the citations. **Print-friendly by CSS, not by a second component** — no separate print renderer, which would be the fourth copy.

If the segmented control needs a third option, extend the shipped one; do not add a second control beside it.

- [ ] **Step 4: Invert R-G11's absence assertion**

```ts
it('ships a Report view, and it renders the export s own words (R-G11 discharged)', () => {
  expect(grepRepo(/ReportView/, COMPONENTS)).toContain('src/features/review/ReportView.tsx');
  // The rule that outlives the deferral: it borrows every sentence.
  const src = codeOf(at('src/features/review/ReportView.tsx'));
  expect(src).toMatch(/dispositionsAsAtLine/);
  expect(src).toMatch(/exportSummaryLine/);
  expect(grepRepo(/export function dispositionsAsAtLine/, WEB_SOURCES))
    .toEqual(['src/lib/findingOutcome.ts']);   // still exactly one home
});
```

- [ ] **Step 5: Edit `CLAUDE.md`, in this commit**

Remove the Report tab from the "Still deferred" sentence, and add to the Architecture section, beside the "two renderers over one findings map" rule:

> **Three renderers now, over the same one map** (Stage 5): the card view, the tabular grid and `ReportView` — which is a view of the document the export produces, and which is why it discharges R-G11 rather than reopening it. It renders `findingOutcome.ts`'s strings and **declares none of its own**, including `exportSummaryLine`, `dispositionsAsAtLine` and `dispositionsMayChangeLine`, so a reader can see on screen exactly what a DOCX read six weeks later on a train will say. `ReportView.test.tsx` asserts that the component holds no display string literal at all, and that it imports nothing from `lib/api` — a report that fetched its own data would be the second pipeline this rule exists to forbid.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npx vitest run src/test/palette.test.ts
git add src/features/review/ReportView.tsx src/features/review/ReportView.test.tsx \
  src/App.tsx apps/api/test/stage4DoD.test.ts CLAUDE.md
git commit -m "feat: a third renderer, showing what the export will say"
git show --stat HEAD
```

**Mutation to run and record:** replace one rendered call with a hand-written equivalent string (`'Dispositions as at ' + new Date(readAt).toISOString()`). `ReportView.test.tsx` › *"renders the as-at instant and the can-change sentence, verbatim"* **and** › *"declares no display string of its own"* must both go red. If only the second does, the first is comparing against something it computed the same wrong way.

---

## Task 7: Parts 5A and 5B gate — the affordances, with three accounts on a running stack

**Type:** verification. **Part 5C does not begin until this passes.**

**Files:**
- Create: `apps/api/test/stage5abDoD.test.ts`, `apps/api/test/stage5abDoD.compose.test.ts`
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-5-collaborative-surfaces/part-5ab-report.md`

- [ ] **Step 1: The searched checks, each with its sanity check**

```ts
it('every inverted guard became a POSITIVE assertion, not a deletion (P46)', () => {
  // The four strings Stage 2 and Stage 4 forbade, and where each now
  // asserts presence instead. A guard that simply lost its `it` would pass
  // every other test in the repository, which is why this one exists.
  const s2 = codeOf(at('apps/api/test/stage2DoD.test.ts'));
  const s4 = codeOf(at('apps/api/test/stage4DoD.test.ts'));
  expect(s2).toMatch(/assignedToMe/);
  expect(s4).toMatch(/AssigneeChip/);
  expect(s4).toMatch(/SearchPalette/);
  expect(s4).toMatch(/ReportView/);
  // …and the two that must STILL be forbidden.
  expect(s2).toMatch(/assigneeId/);
  expect(s4).toMatch(/firm tag|firmTag/i);
  expect(codeOf(at('apps/api/test/stage2DoD.test.ts'))).toContain('R-G1');
});

it('has exactly one id-to-name resolver, still', () => {
  expect(filesDeclaring(/export function userName/)).toEqual(['src/lib/api/users.ts']);
  expect(filesScanned()).toBeGreaterThan(60);
});

it('has exactly one home for every piece of export wording, still', () => {
  for (const fn of ['exportSummaryLine', 'dispositionsAsAtLine', 'dispositionsMayChangeLine',
                    'dispositionLabel', 'verificationLabel']) {
    expect(filesDeclaring(new RegExp(`export function ${fn}`))).toEqual(['src/lib/findingOutcome.ts']);
  }
});

it('has no admin write route yet — Part 5C, not before', () => {
  expect(existsSync(at('apps/api/migrations/014_role_mapping_source.sql'))).toBe(false);
  expect(grepRepo(/RoleMappingPanel/, COMPONENTS)).toEqual([]);
  const grants = codeOf(at('apps/api/migrations/001_identity.sql'));
  expect(grants).toMatch(/grant select on role_mapping to lexprompt_app/);
  expect(grants).not.toMatch(/grant .*insert.* on role_mapping/);
});

it('adds no runtime dependency in any workspace', () => {
  // Compared against the versions Stage 4 closed with, listed here as data.
});
```

- [ ] **Step 2: The live checks, with three accounts, in order, results written down**

1. `npm run compose:up`; all services healthy. `signIn('admin')` returns `role: 'admin'` (P61's premise, re-checked).
2. Unauthenticated `GET /v1/search?q=ashcroft` is **401 `sign_in_required`, not an empty result set**.
3. The trainee creates two matters, two reviews, two findings. The partner is assigned one clause in each. **The partner's inbox names both matters, both reviews and both clause titles.**
4. The trainee resolves one. The partner's inbox is 1, and the partner's own socket received `assignment.resolved` within a second.
5. `GET /v1/reviews/:id/assignments` as the **partner** lists the trainee's request — a request addressed to somebody else on a review they can read.
6. Search for the matter name as the **trainee**: the matter, its documents, its review and its collection are all found. Search for the precedent set's document name: it comes back as `source: 'precedent'` and **never** as `source: 'document'`.
7. Break one arm deliberately (rename a column in a `select` against a scratch copy of the route, or point the clause arm at a table that does not exist) and confirm the response is **200 with `status: 'failed'` on that source and hits from the others**. Restore.
8. `docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com'` — **still fails.** §5's central claim is a network fact and a new route group landed, so it is re-checked rather than inherited.
9. Everything this gate created is deleted (standing rule 8), and the report says so by name.

- [ ] **Step 3: Say what you could not do**

Browser automation is expected to be unavailable — check `list_connected_browsers` and record the result rather than assuming it. Name specifically: nobody has *seen* the counter's "not known" marker, the palette's failed state, the chip on a card, or the Report tab. Every rendered-string claim in Parts 5A and 5B is asserted in jsdom and by nothing that has looked at a screen.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/stage5abDoD.test.ts apps/api/test/stage5abDoD.compose.test.ts \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-5-collaborative-surfaces/part-5ab-report.md
git commit -m "test: the affordances are back, and only where the mechanism is"
git show --stat HEAD
```

---

# PART 5C — administration, where a screen writes policy

> **Read this before Task 8.** Everything in Part 5A and 5B could be wrong and cost a person a retry. Everything in this part could be wrong and cost a firm an access-control failure, a credential in a log, or an incomplete extract handed to a regulator. The three rules that govern it, stated once:
>
> 1. **A privilege is enforced by the database, and the test attempts the statement.** Not by a `where` clause somebody remembered, and not by a route table alone. Every grant claim in this part is asserted by *executing the forbidden statement as the role that must not be able to run it* and asserting the error.
> 2. **Every write names its effect before it happens, and the sentence is produced by the server.** A screen that composes its own description of what a change does is a screen that can describe it more mildly than it is.
> 3. **Three accounts, three outcomes.** `admin` allowed; `partner` refused; `trainee` refused. A test that exercises only the allowed caller proves the route works and nothing about the gate.

---

## Task 8: Migration 014 — `role_mapping` gains a source, and a policy decides who may write which rows

**Type:** migration + grants. **The most dangerous single commit in this stage.** It does not add a screen and it does not add a route; it changes what a request is *capable* of.

**Files:**
- Create: `apps/api/migrations/014_role_mapping_source.sql`, `apps/api/test/roleMappingGrants.pg.test.ts`
- Modify: `apps/api/test/grants.pg.test.ts` (narrowed, never deleted), `apps/api/test/identity.pg.test.ts` (its `role_mapping` insert now needs a `source`)

**Interfaces:**
- Consumes: `001_identity.sql`'s `role_mapping (workspace_id, issuer, group_value, role)` with `primary key (issuer, group_value)`; `infra/postgres/init.sql`'s ownership (`alter schema public owner to lexprompt_migrator`) — **this is what makes the design work and it must be re-read, not assumed**; `apps/api/test/helpers/pgHarness.ts`'s `migratorDb()` / `appDb()` / `workerDb()`.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: the `source` column, four row-level policies, and three new grants to `lexprompt_app`.

**Why row-level security rather than a `where` clause.** §7 requires the table to be both deployment configuration and admin-editable. If the boundary between those two lives in a handler, it lives in whichever `where` clause the next person writes — and the failure mode is an admin screen quietly overwriting a deployment's own policy, which nobody would see until a redeploy silently reverted it. `lexprompt_migrator` **owns** the table, and RLS enabled **without `FORCE`** does not apply to a table's owner: so the startup seed keeps full reach over the table and every request is bounded to `source = 'admin'` rows, by the database, with no handler involved.

- [ ] **Step 1: The failing tests — written before the migration, and they are the deliverable**

```ts
// apps/api/test/roleMappingGrants.pg.test.ts
describe('what the APP role may write to role_mapping (P51)', () => {
  it('reads every row, whatever its source', async () => {
    // Both rows seeded as the migrator; both visible to appDb().
    const rows = await appDb().query('select source from role_mapping order by source');
    expect(rows.map(r => r.source)).toEqual(['admin', 'configuration']);
  });

  it('inserts an admin row', async () => {
    await expect(appDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, 'stage5-test-a', 'reviewer', 'admin')`, [WS, ISSUER])).resolves.toBeDefined();
  });

  it('CANNOT insert a configuration row', async () => {
    await expect(appDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, 'stage5-test-b', 'admin', 'configuration')`, [WS, ISSUER]))
      .rejects.toThrow(/row-level security/i);
  });

  it('CANNOT insert without naming a source — the DEFAULT is refused, not applied', async () => {
    // The column defaults to 'configuration' (so migration 014 back-fills
    // correctly), which means an INSERT that omits it is refused by the
    // policy rather than quietly becoming deployment configuration. That
    // is the direction that fails loudly.
    await expect(appDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role)
       values ($1, $2, 'stage5-test-c', 'admin')`, [WS, ISSUER]))
      .rejects.toThrow(/row-level security/i);
  });

  it('CANNOT update a configuration row — not its role, not its source, not anything', async () => {
    for (const stmt of [
      `update role_mapping set role = 'admin' where group_value = 'cfg'`,
      `update role_mapping set source = 'admin' where group_value = 'cfg'`,
    ]) {
      const before = await migratorDb().query('select role, source from role_mapping where group_value = $1', ['cfg']);
      await appDb().query(stmt).catch(() => {});
      const after = await migratorDb().query('select role, source from role_mapping where group_value = $1', ['cfg']);
      // An UPDATE that matches no row under RLS AFFECTS NOTHING and does not
      // throw. So the assertion is over the DATA, not over an exception —
      // asserting only `.rejects` here would pass against a policy that
      // silently did nothing, and would also pass against no policy at all
      // if the statement happened to error for another reason.
      expect(after).toEqual(before);
    }
  });

  it('CANNOT promote an admin row to configuration', async () => {
    await appDb().query(`update role_mapping set source = 'configuration' where group_value = 'stage5-test-a'`)
      .catch(() => {});
    const [row] = await migratorDb().query('select source from role_mapping where group_value = $1', ['stage5-test-a']);
    expect(row.source).toBe('admin');
  });

  it('CANNOT delete a configuration row, and CAN delete an admin one', async () => { /* … both by data */ });

  it('the WORKER role holds nothing on role_mapping, not even select', async () => {
    await expect(workerDb().query('select 1 from role_mapping')).rejects.toThrow(/permission denied/i);
  });

  it('the MIGRATOR is unaffected by the policy — it owns the table', async () => {
    // Without this the seed silently stops working and the only symptom is
    // that role mappings stop being revoked by configuration.
    await expect(migratorDb().query(
      `insert into role_mapping (workspace_id, issuer, group_value, role, source)
       values ($1, $2, 'stage5-test-d', 'reviewer', 'configuration')`, [WS, ISSUER])).resolves.toBeDefined();
  });
});
```

Every row this suite creates is deleted in its own `afterAll`, **as the migrator** (the app role cannot delete a configuration row, which is the point). A role mapping left behind changes who can do what in every suite that runs afterwards — standing rule 8's sharpest case.

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- roleMappingGrants`. Expected: the `source` column does not exist, so every case fails on a column error — which is the right failure, and confirms the suite is talking to a real database rather than a fixture.

- [ ] **Step 3: The migration**

```sql
-- 014: role_mapping becomes BOTH deployment configuration and an admin
-- surface -- which section 7 has always said it is, and which the shipped
-- table could not be.
--
-- ## The problem this closes
--
-- `seedRoleMappings` (auth/roles.ts) runs on the MIGRATOR connection at
-- every startup and DELETES every row `API_ROLE_MAPPINGS` does not name.
-- Its docstring is right about why: "an upsert-only seed would leave the
-- removed row in place and keep granting the role forever, with the
-- configuration file saying otherwise -- a revocation that silently did not
-- happen". That reasoning is unchanged and survives here in full.
--
-- What it cannot survive is a SECOND writer. An admin screen writing this
-- table as it stands would take the write, show it applied, and have it
-- deleted at the next container restart -- silently, with nothing on screen
-- and nothing in a log. So the two writers get one half of the table each,
-- and the boundary is enforced by the DATABASE rather than by whichever
-- `where` clause a handler happens to carry.
--
-- ## Why row-level security, and why WITHOUT `force`
--
-- `infra/postgres/init.sql` makes `lexprompt_migrator` the owner of schema
-- public. A table's owner BYPASSES row-level security unless the table is
-- `force`d -- so `enable` alone gives exactly the split wanted: the seed
-- keeps full reach, and every request is bounded to `source = 'admin'`.
-- Adding `force row level security` here would break the seed, and the
-- symptom would be that configuration silently stops revoking. Do not add
-- it.
alter table role_mapping
  add column source text not null default 'configuration'
    check (source in ('configuration', 'admin')),
  -- WHO and WHEN, for an admin row. Null on a configuration row: nobody
  -- typed it into a screen, and naming the deployment as an author would be
  -- an attribution nobody made.
  add column created_at timestamptz not null default now(),
  add column created_by_user_id uuid references app_user(id),
  add column updated_at timestamptz,
  add column updated_by_user_id uuid references app_user(id),
  -- P52: an admin row that deployment configuration later claimed. The row
  -- becomes `source = 'configuration'`, and this column keeps the fact
  -- visible on the row FOREVER rather than only in the audit log -- an
  -- administrator looking at the screen must be able to see that their
  -- change was superseded without going and reading a log for it.
  add column converted_from_admin_at timestamptz;

-- Existing rows are deployment configuration, which is what they are.

alter table role_mapping enable row level security;

-- READ EVERYTHING. `roleFor` must see configuration rows or every sign-in
-- fails; there is no privacy boundary inside this table.
create policy role_mapping_read on role_mapping
  for select to lexprompt_app using (true);

-- WRITE ONLY ADMIN ROWS. Three policies rather than one `for all`, because
-- `for all` would also govern SELECT and would silently narrow the read
-- above to `source = 'admin'` -- which would make every sign-in through a
-- configuration mapping fail, at startup, in production, for everyone.
create policy role_mapping_insert_admin on role_mapping
  for insert to lexprompt_app with check (source = 'admin');
create policy role_mapping_update_admin on role_mapping
  for update to lexprompt_app using (source = 'admin') with check (source = 'admin');
create policy role_mapping_delete_admin on role_mapping
  for delete to lexprompt_app using (source = 'admin');

grant insert, update, delete on role_mapping to lexprompt_app;

-- THE WORKER GETS NOTHING, not even select, and the revoke stands in the
-- record beside the absent grant -- the same reasoning 006, 012 and 013
-- each give: an absent grant is undone by one careless `grant all`, and a
-- revoke is not.
revoke all on role_mapping from lexprompt_worker;
```

- [ ] **Step 4: Narrow the shipped assertion rather than deleting it**

`apps/api/test/grants.pg.test.ts` › *"the app role cannot insert into role_mapping"* is now false, and it is **narrowed, not removed** — the describe becomes *"the app role has no write on a CONFIGURATION role mapping, and none at all on workspace"*, and the insert it attempts carries `source = 'configuration'`. Its neighbour asserting the `workspace` table is untouched. Add a comment naming migration 014 and P51, so the next reader can see the boundary moved deliberately.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck
npm run test:pg
npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
git add apps/api/migrations/014_role_mapping_source.sql \
  apps/api/test/roleMappingGrants.pg.test.ts apps/api/test/grants.pg.test.ts \
  apps/api/test/identity.pg.test.ts
git commit -m "feat: a role mapping knows where it came from, and the database decides who may write it"
git show --stat HEAD
```

**Mutations to run and record — all four, and each names its test:**
1. Drop `role_mapping_insert_admin`'s `with check` → *"CANNOT insert a configuration row"* goes red.
2. Replace the three write policies with one `for all to lexprompt_app using (source = 'admin')` → *"reads every row, whatever its source"* goes red. **This is the mutation that matters**: it is the natural, tidier-looking implementation, it passes every write test, and it breaks every sign-in.
3. Add `force row level security` → *"the MIGRATOR is unaffected by the policy"* goes red.
4. Grant `lexprompt_worker` a `select` → *"the WORKER role holds nothing"* goes red.

---

## Task 9: The seed owns configuration rows only, and a collision supersedes loudly

**Type:** behaviour change to startup. Small diff, large consequence.

**Files:**
- Modify: `apps/api/src/auth/roles.ts`, `apps/api/src/main.ts`
- Create: `apps/api/test/roleMappingSeed.pg.test.ts`
- Modify: `apps/api/test/roles.pg.test.ts` (its existing seed assertions gain a `source`)

**Interfaces:**
- Consumes: `seedRoleMappings(runner, workspaceId, mappings)` — **read the whole function and its docstring before changing a character of it**; `appendAudit` (`apps/api/src/audit/write.ts`), which takes a `Tx`; `AUDIT_ACTIONS`.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `seedRoleMappings` unchanged in signature, changed in scope; a new audit action `role_mapping.superseded_by_configuration`.

- [ ] **Step 1: The failing tests**

```ts
// apps/api/test/roleMappingSeed.pg.test.ts
it('deletes a configuration row the variable no longer names', async () => {
  await seedRoleMappings(migratorDb(), WS, [{ issuer: I, groupValue: 'keep', role: 'reviewer' }]);
  expect(await groupValues()).toEqual(['keep']);   // 'drop' is gone
});

it('LEAVES an admin-authored row alone', async () => {
  await insertAdminRow('house-counsel', 'partner');
  await seedRoleMappings(migratorDb(), WS, [{ issuer: I, groupValue: 'keep', role: 'reviewer' }]);
  expect(await groupValues()).toEqual(['house-counsel', 'keep']);
  // The mutation this kills: leaving the delete-half unscoped, which wipes
  // every admin mapping on every container restart and looks, from a
  // screen, exactly like a change that never saved.
});

it('supersedes an admin row that configuration later claims, and records it (P52)', async () => {
  await insertAdminRow('house-counsel', 'partner');
  await seedRoleMappings(migratorDb(), WS, [{ issuer: I, groupValue: 'house-counsel', role: 'admin' }]);
  const [row] = await migratorDb().query(
    'select role, source, converted_from_admin_at from role_mapping where group_value = $1',
    ['house-counsel']);
  expect(row.role).toBe('admin');                       // configuration wins
  expect(row.source).toBe('configuration');
  expect(row.converted_from_admin_at).not.toBeNull();   // permanently visible on the row
  const audits = await migratorDb().query(
    "select detail from audit_event where action = 'role_mapping.superseded_by_configuration'");
  expect(audits).toHaveLength(1);
  expect(audits[0].detail).toMatchObject({ groupValue: 'house-counsel', previousRole: 'partner' });
});

it('is idempotent — a second run supersedes nothing further', async () => {
  // Run the collision case twice. The audit row count stays 1. Without the
  // `converted_from_admin_at is null` guard, every restart writes another
  // row and an auditor reads one supersession as a hundred.
});

it('an empty mapping list still empties CONFIGURATION rows and still leaves admin ones', async () => {
  // config.ts refuses to start with API_ROLE_MAPPINGS unset; an explicitly
  // EMPTY list is a deliberate "no configured mappings" and is honoured.
});
```

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- roleMappingSeed`.

- [ ] **Step 3: The change, in three places and no more**

1. The upsert names `source = 'configuration'` in its insert and, in the `do update` branch, sets `converted_from_admin_at = case when role_mapping.source = 'admin' then now() else role_mapping.converted_from_admin_at end` and `source = 'configuration'`.
2. The delete gains `and source = 'configuration'`. **That single predicate is the whole of the change's risk**: without it, every restart erases every admin mapping; with it in the wrong arm, configuration stops revoking.
3. Before the upsert, `select` the `(issuer, group_value)` pairs the configuration is about to claim that currently hold `source = 'admin'` and `converted_from_admin_at is null`, and write one `role_mapping.superseded_by_configuration` audit row for each, **in the same transaction**, carrying `groupValue`, `previousRole` and `previousCreatedByUserId` in `detail`.

`appendAudit` requires an `actorUserId` (`not null` on the table). There is no actor at startup, so **the audit row is attributed to the workspace's configured bootstrap admin if one is resolvable and the write is skipped with a loud log line if it is not** — never to an arbitrary user, and never with a fabricated id. Decide this in the task and record it: if `appendAudit`'s shape makes attribution impossible at startup, the supersession is recorded on the row (`converted_from_admin_at`) and in a **startup log line naming every superseded pair**, and the plan's claim narrows to that. **Report which of the two you shipped.**

4. `main.ts` logs one line per supersession at startup, naming issuer, group and both roles. A supersession that happened only in a table nobody watches is a supersession nobody sees.

- [ ] **Step 4: The live check — a real restart**

```bash
# admin row in place, configuration naming something else
docker compose --env-file /tmp/compose.env restart api
# assert: the admin row is still there; the dropped configuration row is gone
```

A `pg` test proves the function; only a restart proves the wiring. Stage 3 and Stage 4 each found a defect that only a running container exposed.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
git add apps/api/src/auth/roles.ts apps/api/src/main.ts apps/api/src/audit/actions.ts \
  apps/api/test/roleMappingSeed.pg.test.ts apps/api/test/roles.pg.test.ts
git commit -m "feat: configuration owns its own rows, and says so when it takes one back"
git show --stat HEAD
```

**Mutation to run and record:** remove `and source = 'configuration'` from the delete. *"LEAVES an admin-authored row alone"* must go red. Then remove the supersession insert: *"supersedes an admin row that configuration later claims"* must go red on the audit assertion **and not on the `role` assertion** — if both go red, the two facts are being produced by one statement and the test is weaker than it looks.

---

## Task 10: The role-mapping routes — read the policy, write only admin rows, refuse the lock-out

**Type:** feature. Three accounts, three outcomes.

**Files:**
- Create: `apps/api/src/routes/admin/roleMappings.ts`, `apps/api/test/roleMappings.compose.test.ts`
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `apps/api/src/audit/actions.ts`, `apps/api/src/server.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/test/authz.route.test.ts`
- Modify: `src/lib/api/admin.ts` (created here), `src/features/matters/MatterActivity.tsx` (the new verbs need renderings)

**Interfaces:**
- Consumes: `role_mapping` with its `source` (Task 8); `Actor`; `appendAudit`; `ModelError`; `ROLE_RANK` and `Role` from `apps/api/src/auth/roles.ts`.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // packages/core/src/api/records.ts
  export interface RoleMappingView {
    issuer: string;
    groupValue: string;
    role: Role;
    source: 'configuration' | 'admin';
    createdAt: number;
    /** Absent on a configuration row — nobody typed it into a screen, and
     *  naming the deployment as an author would be an attribution nobody
     *  made. */
    createdByUserId?: string;
    updatedAt?: number;
    updatedByUserId?: string;
    /** Present when deployment configuration later claimed a row an admin
     *  authored (P52). The screen shows this permanently. */
    convertedFromAdminAt?: number;
  }

  export interface RoleMappingsPage {
    mappings: RoleMappingView[];
    /** WHEN THIS WAS READ. The same idiom as the export's "as at" instant,
     *  and for the same reason: a policy screen showing a mapping with no
     *  instant is a screen that cannot be told apart from a stale one. */
    readAt: number;
    /** The variable a configuration row comes from, named so an admin can
     *  see that some of what they are looking at is not theirs to change. */
    configurationSource: 'API_ROLE_MAPPINGS';
  }

  /** What a proposed write WOULD do, in words, decided by the server (P53). */
  export interface RoleMappingEffect {
    /** e.g. "Anyone whose sign-in carries the group \"house-counsel\" from
     *  this issuer will be an administrator." */
    sentence: string;
    /** True when the change grants a strictly higher role than the mapping
     *  currently gives — the screen requires a typed confirmation for these
     *  and not for the others. */
    widens: boolean;
    grantsRole: Role;
  }
  ```

- [ ] **Step 1: The failing tests, three accounts, every route**

```ts
// apps/api/test/roleMappings.compose.test.ts
const WRITES = [
  ['POST',   '/v1/admin/role-mappings',              { issuer: I, groupValue: 'g', role: 'reviewer' }],
  ['PUT',    '/v1/admin/role-mappings/…',            { role: 'partner' }],
  ['DELETE', '/v1/admin/role-mappings/…',            undefined],
] as const;

it.each(WRITES)('refuses %s %s for a trainee AND for a partner', async (m, p, body) => {
  expect((await asUser(trainee, m, p, body)).status).toBe(403);
  expect((await asUser(partner, m, p, body)).status).toBe(403);
});

it('refuses every route unauthenticated with 401, not an empty list', async () => { /* … */ });

it('lists configuration and admin rows together, each naming its source and the variable', async () => {
  const page = await json(await asUser(admin, 'GET', '/v1/admin/role-mappings'));
  expect(page.configurationSource).toBe('API_ROLE_MAPPINGS');
  expect(page.readAt).toBeGreaterThan(Date.now() - 60_000);
  expect(page.mappings.some(m => m.source === 'configuration')).toBe(true);
});

it('REFUSES to write a configuration row through the route, before the policy has to', async () => {
  // Defence in depth, and the order matters: the handler refuses with a
  // sentence a person can act on ("that mapping comes from
  // API_ROLE_MAPPINGS"), and the POLICY refuses with a Postgres error if
  // the handler ever stops. Both are asserted; neither is trusted alone.
  const res = await asUser(admin, 'PUT', `/v1/admin/role-mappings/${cfgId}`, { role: 'admin' });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('mapping_is_configuration');
});

it('names the effect of a widening BEFORE it is applied, in the server s own words', async () => {
  const preview = await json(await asUser(admin, 'POST', '/v1/admin/role-mappings/preview',
    { issuer: I, groupValue: 'house-counsel', role: 'admin' }));
  expect(preview.widens).toBe(true);
  expect(preview.grantsRole).toBe('admin');
  expect(preview.sentence).toContain('house-counsel');
  expect(preview.sentence).toMatch(/administrator/i);
  expect(preview.sentence).toMatch(/next request/i);   // when it takes effect
});

it('REFUSES a change that would leave no admin mapping, naming the recovery path', async () => {
  const res = await asUser(admin, 'DELETE', `/v1/admin/role-mappings/${theOnlyAdminMapping}`);
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('last_admin_mapping');
  expect(body.message).toContain('API_ROLE_MAPPINGS');
});

it('writes exactly one audit row per change, naming both roles', async () => {
  // …and NOTHING is written to finding_disposition_event (S22's direction,
  // asserted at a new surface rather than assumed to hold).
});

it('takes effect on the NEXT REQUEST for a session already open', async () => {
  // The live proof of the sentence the screen shows. Map the trainee's
  // group to `partner`; the trainee's very next call to a partner-only
  // route (POST /v1/playbooks/:id/versions) succeeds with the SAME token.
  // Then unmap it and confirm the same call is refused again.
});
```

**Cleanup is not optional in this suite** (standing rule 8). Every mapping it creates is removed as the migrator in `afterAll`, and the report says so. A stray `admin` mapping makes every later suite pass for the wrong reason.

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

Four routes, all `admin` in `ROUTE_POLICY`, each with a comment giving §7's sentence as the reason:

```
'GET /v1/admin/role-mappings': 'admin',
'POST /v1/admin/role-mappings/preview': 'admin',
'POST /v1/admin/role-mappings': 'admin',
'PUT /v1/admin/role-mappings/:issuer/:groupValue': 'admin',
'DELETE /v1/admin/role-mappings/:issuer/:groupValue': 'admin',
```

The list read returns `readAt: Date.now()` measured **at the query**, not at serialisation.

The lock-out check runs **inside the write transaction** with `select … from role_mapping where role = 'admin' for update`, so two concurrent deletes cannot both see two rows. A `select` outside the transaction is the classic wrong implementation here and it passes every single-caller test.

`AUDIT_ACTIONS` gains `role_mapping.created`, `role_mapping.changed`, `role_mapping.removed`, `role_mapping.superseded_by_configuration`. **`user.role_changed` is already in the set and has no writer** — it is rendered by `MatterActivity.tsx` and written by nothing. Do **not** reuse it for a mapping change: a mapping is not a person. Either give it its writer in Task 12 or record in this task's report that it remains a verb with a reader and no writer, so Task 16's scanner can assert the resolution either way.

The effect sentence is built server-side from the proposed role and the current mapping, and always ends with when it applies: *"…This takes effect on their next request, including for anyone already signed in."*

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npm run test:compose
git add apps/api/src/routes/admin/roleMappings.ts apps/api/src/server.ts \
  apps/api/src/auth/routeTable.ts apps/api/src/audit/actions.ts \
  apps/api/test/roleMappings.compose.test.ts apps/api/test/authz.route.test.ts \
  packages/core/src/api/records.ts packages/core/src/index.ts \
  src/lib/api/admin.ts src/features/matters/MatterActivity.tsx \
  src/features/matters/MatterActivity.test.tsx
git commit -m "feat: role mapping is administrable, and every change says what it does"
git show --stat HEAD
```

**Mutations to run and record:** (a) move the lock-out `select` outside the transaction and drop `for update` → the concurrency case must go red (write one if the suite has only the single-caller case; a lock-out guard with no concurrent test is a guard nobody has tried to beat). (b) Make `preview` return `widens: false` unconditionally → *"names the effect of a widening BEFORE it is applied"* goes red. (c) Delete the handler's `mapping_is_configuration` refusal → the route test goes red **and the write still fails**, at the policy, with a Postgres error — confirm both, because that is the evidence that the two layers are independent rather than one layer written twice.

---

## Task 11: The admin screen — policy, its source, and the sentence before the click

**Type:** feature. Adds a route to the browser's router and a screen behind a role.

**Files:**
- Create: `src/features/admin/AdminScreen.tsx`, `src/features/admin/RoleMappingPanel.tsx` and their tests
- Modify: `src/lib/router.ts` and its test, `src/App.tsx`, `src/index.css` (if a role is needed, in this commit)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `RoleMappingsPage`, `RoleMappingEffect`; `src/lib/api/admin.ts` (Task 10); `useRole` / `RoleState` (`src/lib/role.ts`); `WorkspaceModelPanel.tsx` — **read it**: it is the shipped pattern for "any role reads, only an admin writes", including its refusal to render a dropdown that looks live and silently 403s, and this screen follows it; `LoadErrorPanel`; `Modal`.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `{ name: 'admin'; section: 'roles' | 'people' | 'providers' | 'audit' }` on `Route`, and the screen.

- [ ] **Step 1: The failing tests**

```tsx
// src/features/admin/RoleMappingPanel.test.tsx
it('shows the instant the policy was read', () => {
  expect(text).toMatch(/read at /i);
  // P54's whole content in one assertion: a policy screen with no instant
  // cannot be told apart from a stale one.
});

it('marks a configuration row as not editable, and names the variable', () => {
  expect(rowFor('cfg').textContent).toContain('API_ROLE_MAPPINGS');
  expect(controlsIn(rowFor('cfg')).every(c => c.disabled)).toBe(true);
  // …and says WHY it is disabled, rather than being a dead control.
  expect(rowFor('cfg').textContent).toMatch(/deployment configuration/i);
});

it('shows a superseded row as superseded, permanently', () => {
  expect(rowFor('house-counsel').textContent).toMatch(/replaced by deployment configuration/i);
});

it('renders the server s effect sentence verbatim before a widening', async () => {
  await click(addAdminMappingButton);
  expect(dialogText()).toContain(EFFECT.sentence);
  // NOT a sentence the component composed: the assertion compares against
  // the fixture the server returned.
});

it('keeps the confirm control disabled until the role name is typed', async () => {
  expect(confirmButton().disabled).toBe(true);
  type(confirmInput(), 'admin');
  expect(confirmButton().disabled).toBe(false);
});

it('does not require typing for a change that does not widen', () => { /* … */ });

it('never renders app_user.role as the effective policy (P54)', () => {
  // The panel takes NO WorkspaceUser prop at all. Asserted structurally as
  // well as by render, because "we just won't pass it" is a habit.
  expect(codeOf('src/features/admin/RoleMappingPanel.tsx')).not.toMatch(/WorkspaceUser/);
});

it('renders loading, error and empty distinctly, and empty is not a blank panel', () => {
  // An empty role_mapping means NOBODY can sign in. The empty state says
  // that in words rather than showing an empty table.
});
```

```tsx
// src/features/admin/AdminScreen.test.tsx
it('renders nothing an admin could act on for a reviewer or a partner', () => {
  // The courtesy half only; the API is the gate. Asserted so that a
  // non-admin who reaches /admin by URL gets a refusal panel and not a
  // half-drawn screen that 403s on every fetch.
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

`AdminScreen` is a shell with four sections; Tasks 12, 14 and 15 fill the other three. The route is `{ name: 'admin'; section }`, parsed from `/admin/:section` with an unknown section going to `not-found` — `router.ts`'s own docstring forbids a silent fallback to the home route and that rule is not relaxed here.

`RoleMappingPanel` reads `GET /v1/admin/role-mappings` **on every open**, shows `readAt` in words, groups rows by source, disables every control on a configuration row **with a reason**, and renders `convertedFromAdminAt` as a permanent line on the row. A widening opens a `Modal` showing the server's `sentence`, requiring the role name typed, and only then enabling the confirm.

Every state string is a literal in this component (it is a screen, not an exporter) but **no policy sentence is** — those come from the server.

- [ ] **Step 4: Edit `CLAUDE.md`, in this commit**

> **An admin screen writes policy, and `role_mapping` is the policy.** As of Stage 5 an administrator can add, change and remove a group-to-role mapping from `/admin/roles`. Four things make that safe enough to ship and every one of them is load-bearing. (1) **The database decides which rows a request may touch**: `role_mapping.source` is `'configuration'` or `'admin'`, row-level security bounds `lexprompt_app` to the second, and `lexprompt_migrator` owns the table so the startup seed is unaffected (migration 014). Enabling `force row level security` would break every sign-in; do not. (2) **The startup seed owns configuration rows only** — its delete-half carries `and source = 'configuration'`, or every restart would erase every admin mapping and look, from the screen, exactly like a change that never saved. Configuration that later claims an admin row **wins**, and the supersession is recorded on the row (`converted_from_admin_at`), in `audit_event` and in a startup log line. (3) **Every write names its effect first, in the server's words** — the screen renders the sentence `POST /v1/admin/role-mappings/preview` returns, verbatim, and a change that grants a higher role needs the role name typed. The sentence always says when it applies: **the next request, including for anyone already signed in**, which is true because `resolveActor` re-derives the role per request. (4) **A change that would leave no admin mapping is refused**, inside the write transaction, naming `API_ROLE_MAPPINGS` as the recovery path. And one absence: **`app_user.role` is never rendered as the effective policy** — it is the role of that person's last request, and a screen showing it as their role shows a stale mapping as current, which is the exact failure this whole apparatus exists to prevent.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npx vitest run src/test/palette.test.ts
git add src/features/admin/AdminScreen.tsx src/features/admin/AdminScreen.test.tsx \
  src/features/admin/RoleMappingPanel.tsx src/features/admin/RoleMappingPanel.test.tsx \
  src/lib/router.ts src/lib/router.test.ts src/App.tsx src/index.css CLAUDE.md
git commit -m "feat: the role mapping screen, and what it says before it changes anything"
git show --stat HEAD
```

**Mutation to run and record:** have the panel compose its own sentence from `grantsRole` instead of rendering `effect.sentence`. *"renders the server s effect sentence verbatim before a widening"* must go red — and if it does not, the fixture and the component are computing the same string two ways, which is the drift this rule exists to prevent.

---

## Task 12: Disabling and pseudonymising a person

**Type:** feature. Closes §7's unreachable admin power and builds §17 Q6's only available remedy.

**Files:**
- Create: `apps/api/src/routes/admin/people.ts`, `apps/api/test/people.compose.test.ts`
- Create: `src/features/admin/PeoplePanel.tsx` and its test
- Modify: `apps/api/src/audit/actions.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`, `apps/api/test/authz.route.test.ts`, `src/lib/api/admin.ts`
- Modify: `src/features/matters/MatterActivity.tsx` (renderings for the new verbs)

**Interfaces:**
- Consumes: `app_user` with `grant select, insert, update` and **no `delete`, deliberately** (001's own comment: *"deleting one would orphan every attribution they authored"*); `resolveActor`'s `account_disabled` refusal — **read it**, it is already correct and already tested and this task supplies the door, not the lock; `WorkspaceUser`; `appendAudit`.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `POST /v1/admin/users/:id/disable`, `/enable`, `/pseudonymise`, all `admin`.

- [ ] **Step 1: The failing tests**

```ts
// apps/api/test/people.compose.test.ts
it('refuses all three routes for a trainee and for a partner', async () => { /* 403 × 6 */ });

it('a disabled person s NEXT REQUEST is refused, with the same token', async () => {
  expect((await asUser(trainee, 'GET', '/v1/matters')).status).toBe(200);
  await asUser(admin, 'POST', `/v1/admin/users/${trainee.userId}/disable`, {});
  const res = await asUser(trainee, 'GET', '/v1/matters');
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe('account_disabled');
  // …and signing in again does not undo it — `resolveActor`'s upsert keeps
  // `status` out of its DO UPDATE list, and this is the test that proves the
  // comment.
  const again = await signIn('trainee');
  // (signIn itself calls /v1/me, so this REJECTS; assert on the rejection.)
});

it('enable restores access, and both acts are audited', async () => { /* … */ });

it('an admin cannot disable themselves', async () => {
  const res = await asUser(admin, 'POST', `/v1/admin/users/${admin.userId}/disable`, {});
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('cannot_disable_self');
  // A locked-out administrator's only repair is a database session, which
  // is not a repair a firm has at 17:40.
});

it('pseudonymise replaces the name and email and TOUCHES NO HISTORY ROW (P58)', async () => {
  const before = await migratorDb().query(
    'select id, by_user_id, from_state, to_state, at from finding_disposition_event order by id');
  await asUser(admin, 'POST', `/v1/admin/users/${trainee.userId}/pseudonymise`, {});
  const after = await migratorDb().query(
    'select id, by_user_id, from_state, to_state, at from finding_disposition_event order by id');
  expect(after).toEqual(before);          // byte for byte, foreign keys intact
  const [u] = await migratorDb().query('select display_name, email from app_user where id = $1', [trainee.userId]);
  expect(u.display_name).toMatch(/^Former user /);
  expect(u.email).toBeNull();
});

it('the pseudonym is STABLE — a second call changes nothing further', async () => { /* … */ });

it('the directory renders the pseudonym, and a card attributing an old change shows it too', async () => {
  // The whole point: attribution survives, the name does not.
});

it('pseudonymise also disables, and says so — a pseudonymised account that could still sign in would rename itself back on the next request', async () => {
  // resolveActor's DO UPDATE excludes display_name (Stage 3's fix), so this
  // is belt and braces rather than the only defence — assert BOTH, and if
  // the shipped upsert has changed, that is the finding.
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

Three routes. `disable` and `enable` set `status`; `pseudonymise` sets `display_name = 'Former user ' || left(id::text, 8)`, `initials` to the corresponding two characters, `email = null`, and `status = 'disabled'`, **in one statement**. Nothing else in the database is touched — no history row, no audit row rewritten, no `by_user_id` changed. The whole of §17 Q6's remedy is this one row.

`AUDIT_ACTIONS` gains `user.disabled`, `user.enabled`, `user.pseudonymised`. If Task 10 did not give `user.role_changed` a writer, note here that it still has none.

`PeoplePanel` lists `GET /v1/workspace/users`, shows `status`, and shows `role` **labelled as "role at their last request"** with no instant claimed that the API does not carry (P54, disagreement 4 — if the directory has no `lastSeenAt` on the wire, the label says so rather than inventing a time). Pseudonymise requires the person's current display name typed, and the confirmation uses the word **permanent**.

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npm run test:compose
git add apps/api/src/routes/admin/people.ts apps/api/src/audit/actions.ts \
  apps/api/src/auth/routeTable.ts apps/api/src/server.ts \
  apps/api/test/people.compose.test.ts apps/api/test/authz.route.test.ts \
  src/lib/api/admin.ts src/features/admin/PeoplePanel.tsx \
  src/features/admin/PeoplePanel.test.tsx src/features/matters/MatterActivity.tsx \
  src/features/matters/MatterActivity.test.tsx
git commit -m "feat: an account can be turned off, and a name can be retired without losing who did what"
git show --stat HEAD
```

**Mutation to run and record:** make `pseudonymise` also `update finding_disposition_event set by_user_id = null`. The history-equality assertion must go red — **and the statement should also fail at the grant**, because the app role holds no `update` on that table (006). Confirm both, and report which fired first; if only the test fires, the grant assertion in `grants.pg.test.ts` is worth re-reading.

---

## Task 13: The gateway's credential-status endpoint — the one §14 names and nobody built

**Type:** feature, in the gateway. **The only task in this stage that touches `apps/gateway`.**

**Files:**
- Create: `apps/gateway/src/routes/adminCredentials.ts`
- Modify: `apps/gateway/src/server.ts`, `apps/gateway/test/credentials.test.ts`
- Modify: `packages/core/src/api/records.ts` (or `packages/core/src/model/protocol.ts` — put `ProviderStatus` beside `AllowedModel`, which is where a reader will look), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CredentialResolver` / `ResolvedCredential` (`apps/gateway/src/credentials/types.ts`), `DefaultCredentialResolver`, `redactCredential` (`credentials/resolve.ts`), the `Allowlist` (`allowlist.ts`), `callerAuth.ts` — **read how the gateway authenticates its one caller**, because this route sits behind the same check and must not invent a second one; `registerHealth`'s docstring, which explains why `/healthz` reports nothing about configuration and is the reasoning this route has to answer to.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  /**
   * WHETHER a credential is configured, and WHEN it was rotated. §14's
   * `credential` suite: "the admin endpoint reports only whether a
   * credential is configured and when it was rotated." Nothing else is on
   * this type, and the absence is the feature.
   *
   * There is no `key`, no `keyPrefix`, no `last4`, no `fingerprint` and no
   * `length`. Each of those has been argued for somewhere as a debugging
   * aid; each is a fact about a secret, on an endpoint an administrator
   * would screenshot into a Risk pack.
   */
  export interface ProviderStatus {
    provider: ProviderId;
    /** How this deployment authenticates to that provider. `'managed-identity'`
     *  is the case where S2's no-key half is TRUE and the screen may say so;
     *  every other value is the case where only the custody half holds. */
    auth: 'managed-identity' | 'key' | 'none';
    configured: boolean;
    /** ISO 8601, or absent. Absent means "not recorded", never "never". */
    rotatedAt?: string;
    /** How many allowlist entries route to this provider. Zero is a real
     *  and useful answer: a configured credential nothing uses. */
    modelCount: number;
  }

  export interface ProvidersPage {
    providers: ProviderStatus[];
    /** The operator's declared jurisdiction set (S27), echoed so a screen
     *  can show what is enforced rather than what it assumes. */
    declaredJurisdictions: Bloc[];
  }
  ```

- [ ] **Step 1: The failing tests — §14's sweep, this time against a route**

```ts
// apps/gateway/test/credentials.test.ts (extended, not replaced)
describe('the admin credential endpoint (S2, P56)', () => {
  const SECRET = 'sk-test-DO-NOT-LEAK-0123456789abcdef';

  it('reports configured and rotatedAt, and nothing that is a fact about the secret', async () => {
    const body = await get('/v1/admin/credentials');
    expect(body.providers.find(p => p.provider === 'openai')).toMatchObject({
      configured: true, auth: 'key',
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain(SECRET);
    for (const forbidden of ['last4', 'prefix', 'fingerprint', 'length', 'key']) {
      expect(Object.keys(body.providers[0])).not.toContain(forbidden);
    }
    // The sanity half: the sweep can see a leak when there is one.
    expect(JSON.stringify({ k: SECRET })).toContain(SECRET);
  });

  it('leaks nothing on the ERROR path either', async () => {
    // A resolver that throws with the credential in its message — which is
    // exactly how a leak has happened in real systems.
    const res = await getWithBrokenResolver(new Error(`bad key ${SECRET}`));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('leaks nothing into the LOG for this route', async () => {
    expect(capturedLogLines().join('\n')).not.toContain(SECRET);
  });

  it('reports auth: managed-identity without ever acquiring a token', async () => {
    // Reporting status must not itself perform a credential acquisition: an
    // admin refreshing a screen would otherwise mint tokens, and a failing
    // acquisition would make the STATUS page the thing that is down.
    expect(tokenAcquisitions()).toBe(0);
  });

  it('is refused for a caller the gateway does not authenticate', async () => { /* … */ });
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

One route, `GET /v1/admin/credentials`, behind the gateway's existing caller authentication and **not** a second mechanism. It reports from **configuration**, not from an acquisition: `configured` is "a source is configured for this provider", never "a token was obtained". `rotatedAt` comes from whatever the credential source can honestly report (a Key Vault secret's `updatedOn`, a mounted secret file's `mtime`) and is **absent** when nothing can — absent means *not recorded*, never *never*.

`redactCredential` already exists; use it on any error path that could carry a message from a provider. Do not write a second redactor.

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
git add apps/gateway/src/routes/adminCredentials.ts apps/gateway/src/server.ts \
  apps/gateway/test/credentials.test.ts \
  packages/core/src/model/protocol.ts packages/core/src/index.ts
git commit -m "feat: whether a credential is configured, and when — and nothing else"
git show --stat HEAD
```

**Mutation to run and record:** add `keyLast4` to the response. *"reports configured and rotatedAt, and nothing that is a fact about the secret"* must go red on the key-list assertion. Then throw the secret in an error message: the error-path case must go red. **Run both**; the second is the one that has caught real leaks in real systems and the first is the one everybody writes.

---

## Task 14: The providers screen — read-only by construction, and honest about which guarantee this deployment has

**Type:** feature. **Read `docs/superpowers/specs/…§12.0` before writing a word of copy.**

**Files:**
- Create: `apps/api/src/routes/admin/providers.ts`, `apps/api/test/providers.compose.test.ts`
- Create: `src/features/admin/ProvidersPanel.tsx` and its test
- Modify: `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`, `apps/api/test/authz.route.test.ts`, `src/lib/api/admin.ts`, `README.md`

**Interfaces:**
- Consumes: `ProvidersPage` (Task 13); `AllowedModel` with its `jurisdiction` and dated `dataHandling` (`packages/core/src/model/protocol.ts` — **read `DataHandling`'s docstring in full**: it is the operator's record of terms they agreed, *"never graded, scored, or read by any code path that decides anything"*, and a screen that scored it would falsify the ruling that put it there); `gatewayClient.ts`'s existing proxying of `GET /v1/models`; `jurisdictionLabel`.
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces: `GET /v1/admin/providers` (`admin`) proxying the gateway, and the panel.

- [ ] **Step 1: The failing tests**

```ts
// apps/api/test/providers.compose.test.ts
it('refuses a trainee and a partner', async () => { /* 403 × 2 */ });

it('carries no credential value through the proxy, on success or on failure', async () => {
  // The same sweep as Task 13, one hop further out: a proxy that passes an
  // upstream error body through verbatim is how a redaction gets undone.
});

it('answers a loud 503 when the gateway is unreachable, and NEVER an empty provider list', async () => {
  const res = await asUser(admin, 'GET', '/v1/admin/providers');
  expect(res.status).toBe(503);
  // An empty list here reads as "this deployment has no providers
  // configured", which is a statement about the firm's configuration that
  // the API is in no position to make.
});
```

```tsx
// src/features/admin/ProvidersPanel.test.tsx
it('labels every model with provider AND jurisdiction, with no entry unlabelled', () => {
  // S27: the ABSENCE of a label must not carry meaning. Table-driven over a
  // fixture that includes an out-of-bloc entry, asserting the label form is
  // identical for every row.
});

it('shows the dataHandling note with its date, and never grades it', () => {
  expect(text).toContain('Reviewed 2026-02-14');
  for (const word of ['good', 'poor', 'safe', 'risky', 'compliant', 'recommended']) {
    expect(text.toLowerCase()).not.toContain(word);
  }
});

it('marks a note older than a year as needing re-reading, without judging the provider', () => {
  expect(text).toMatch(/last reviewed over a year ago/i);
});

it('states which of S2 s two guarantees THIS deployment has', () => {
  const managed = render({ providers: [{ provider: 'azureFoundry', auth: 'managed-identity', … }] });
  expect(managed).toMatch(/no provider key exists in this deployment/i);
  const keyed = render({ providers: [{ provider: 'openai', auth: 'key', … }] });
  expect(keyed).toMatch(/the key is held only by the gateway/i);
  expect(keyed).not.toMatch(/no provider key exists/i);
  // §18 item 8: the unconditional claim must not appear anywhere, ever.
});

it('offers nothing that looks editable', () => {
  expect(controlsIn(root).filter(c => c.tagName === 'INPUT' || c.tagName === 'SELECT')).toEqual([]);
  expect(text).toMatch(/changed in this deployment s configuration/i);
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

The API route proxies the gateway's `GET /v1/models` and `GET /v1/admin/credentials` and joins them by provider. It holds **no copy** of the allowlist (S14: the gateway is its single home) and it has **no write route at all** (P55) — the absence is the design, and the screen says so in words rather than by showing disabled inputs.

The panel is read-only, groups by provider, and states, per provider, which of S2's two sentences applies. **Never both, and never the unconditional one.** §18 item 8 requires that no sentence anywhere in the app, README, admin screens or spec states *"there are no provider keys anywhere"* as live; this is the screen most likely to grow one, and its test is the guard.

`README.md` gains a short section pointing at `/admin/providers` and repeating the split — it is the other place §18 item 8 names, and the two are written in the same commit so they cannot drift.

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npm run test:compose
git add apps/api/src/routes/admin/providers.ts apps/api/src/auth/routeTable.ts \
  apps/api/src/server.ts apps/api/test/providers.compose.test.ts \
  apps/api/test/authz.route.test.ts src/lib/api/admin.ts \
  src/features/admin/ProvidersPanel.tsx src/features/admin/ProvidersPanel.test.tsx README.md
git commit -m "feat: the providers an admin can see, and the guarantee this deployment actually has"
git show --stat HEAD
```

**Mutation to run and record:** replace the two conditional sentences with the unconditional *"there are no provider keys anywhere in this system"*. *"states which of S2 s two guarantees THIS deployment has"* must go red on the keyed case. This is the mutation §19 says the pressure is permanent for — *"one sentence is shorter and sounds better"* — so run it, and record that you did.

---

## Task 15: The workspace audit export — evidence that says what it covers

**Type:** feature. The artefact that leaves the building.

**Files:**
- Create: `apps/api/src/routes/admin/auditExport.ts`, `apps/api/test/auditExport.pg.test.ts`
- Create: `src/features/admin/AuditExportPanel.tsx` and its test
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/src/server.ts`
- Modify: `apps/api/test/authz.route.test.ts`, `apps/api/test/divergence.json`, `apps/api/test/configSurface.test.ts`, `apps/api/test/caps.test.ts`, `src/lib/api/admin.ts`

**Interfaces:**
- Consumes: `apps/api/src/routes/activity.ts`'s three-arm `UNION` — **read it first and follow it**; `apps/api/src/routes/history.ts`'s `ReviewHistory` and `src/features/review/exportHistoryCsv.ts` — the per-review export already exists and is **not** re-implemented; `dispositionsAsAtLine`'s idiom (the manifest's instant is the same idea at a different scope).
- **Read the shipped source; where it disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  /**
   * WHAT THIS EXTRACT COVERS, WHEN IT WAS TAKEN, AND THAT IT IS COMPLETE
   * FOR THAT RANGE (P57).
   *
   * §19 already names the export as the worst-consequence artefact in this
   * design, because a card has a reader who can refresh and a printed
   * document does not. An audit extract is that with legal weight attached:
   * it is read months later, by somebody who was not there, as evidence.
   *
   * So it carries its own scope. A file with rows in it and no statement of
   * what it covers is a file whose gaps are indistinguishable from absences
   * of activity.
   */
  export interface AuditExportManifest {
    workspaceId: string;
    /** Epoch milliseconds, inclusive of `from`, exclusive of `to`. */
    from: number;
    to: number;
    /** When the extract was TAKEN. Different from `to`, always stated. */
    takenAt: number;
    takenByUserId: string;
    timeZone: string;
    /** Every source by name, with its row count. A source with zero rows is
     *  LISTED with zero — an omitted source reads as a source that was not
     *  covered, which is the blank-CSV-cell defect on an evidence file. */
    sources: { source: 'audit_event' | 'finding_disposition_event' | 'run'; rows: number }[];
    /** Always `true` in a delivered file: an incomplete extract is REFUSED
     *  rather than produced (P57). The field exists so a reader of the file
     *  does not have to know that, and so a future paged export cannot ship
     *  without deciding what to put here. */
    complete: true;
  }
  ```

- [ ] **Step 1: The failing tests**

```ts
// apps/api/test/auditExport.pg.test.ts
it('refuses a trainee and a partner', async () => { /* 403 × 2 */ });

it('lists every source, including one with no rows in the range', async () => {
  const { manifest } = await exportAs(admin, { from, to });
  expect(manifest.sources.map(s => s.source).sort())
    .toEqual(['audit_event', 'finding_disposition_event', 'run']);
  expect(manifest.sources.find(s => s.source === 'run')!.rows).toBe(0);
});

it('states when it was taken, distinctly from the end of its range', async () => {
  expect(manifest.takenAt).toBeGreaterThan(manifest.to);
  expect(manifest.timeZone.length).toBeGreaterThan(0);
});

it('counts EXACTLY what it delivers', async () => {
  const { manifest, rows } = await exportAs(admin, { from, to });
  for (const s of manifest.sources) {
    expect(rows.filter(r => r.source === s.source)).toHaveLength(s.rows);
  }
  // The mutation this kills: a manifest count from a `count(*)` and rows
  // from a second, differently-scoped query. Two statements, one claim.
});

it('REFUSES rather than truncating when a source would exceed the ceiling (P57)', async () => {
  const res = await asUser(admin, 'GET', `/v1/admin/audit-export?from=0&to=${Date.now()}`);
  expect(res.status).toBe(413);
  const body = await res.json();
  expect(body.code).toBe('export_too_large');
  expect(body.message).toMatch(/audit_event/);
  expect(body.message).toMatch(/narrow the range/i);
});

it('refuses an unbounded range rather than defaulting to everything', async () => {
  expect((await asUser(admin, 'GET', '/v1/admin/audit-export')).status).toBe(400);
});

it('carries no disposition act from audit_event (S22), and both records exactly once', async () => {
  // The same act must appear in finding_disposition_event and NOT in
  // audit_event — an auditor reconciling two logs must not find a
  // discrepancy that is really a duplicate.
});

it('scopes to the workspace in every arm', async () => { /* … */ });
```

```tsx
// src/features/admin/AuditExportPanel.test.tsx
it('opens on a bounded range and never on everything', () => {
  expect(defaultRangeDays()).toBe(AUDIT_EXPORT_DEFAULT_DAYS);
});

it('renders the refusal as a refusal, naming the source and offering a narrower range', () => {
  expect(text).toMatch(/too large to export/i);
  expect(text).toContain('audit_event');
  expect(controlsIn(root).map(c => c.textContent)).toContain('Last 30 days');
});

it('states the manifest above the download, not only inside the file', () => {
  // A person choosing a range should see what they are about to take
  // before they take it.
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

`GET /v1/admin/audit-export?from=&to=` at `admin`. The three arms are `activity.ts`'s three arms with the matter predicate removed and a workspace predicate kept — **read that file and follow its shape**; a second query language for the same three tables is exactly the drift S22 was written about.

The ceiling check and the delivery come from **one** statement per source, `limit $n + 1`: if the extra row comes back, refuse. Never `count(*)` then `select` — those are two claims and they can disagree.

The response is `{ manifest, rows }` as JSON; the panel renders `exportHistoryCsv`'s idiom for the CSV form, with the **manifest as the first block of the file**, exactly as the DOCX puts `dispositionsAsAtLine` first.

`API_AUDIT_EXPORT_MAX_ROWS` (50 000) into `config.ts`, `divergence.json` and `caps.test.ts` in this commit.

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npx vitest run > /tmp/t.txt 2>&1; echo "exit=$?"
npm run test:pg
git add apps/api/src/routes/admin/auditExport.ts apps/api/src/config.ts \
  apps/api/src/auth/routeTable.ts apps/api/src/server.ts \
  apps/api/test/auditExport.pg.test.ts apps/api/test/authz.route.test.ts \
  apps/api/test/divergence.json apps/api/test/configSurface.test.ts apps/api/test/caps.test.ts \
  packages/core/src/api/records.ts packages/core/src/index.ts \
  src/lib/api/admin.ts src/features/admin/AuditExportPanel.tsx \
  src/features/admin/AuditExportPanel.test.tsx
git commit -m "feat: an audit export that says what it covers, and refuses to be partial"
git show --stat HEAD
```

**Mutation to run and record:** replace the refusal with a `limit` that truncates and a manifest count taken from `count(*)`. *"REFUSES rather than truncating"* and *"counts EXACTLY what it delivers"* must **both** go red. If only the first does, the count and the rows are coming from one statement already and the second assertion is not testing what it says.

---

# PART 5D — closing the design

---

## Task 16: Stage 5's definition of done, with three accounts, in the three categories P44 requires

**Type:** verification. **Nothing after this task changes behaviour.**

**Files:**
- Create: `apps/api/test/stage5DoD.test.ts`, `apps/api/test/stage5DoD.compose.test.ts`
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-5-collaborative-surfaces/stage-5-report.md`
- Modify: `README.md`

- [ ] **Step 1: The scanners, each with its sanity check**

```ts
describe('the scanners find something before anything is checked with them', () => {
  it('walks a realistic number of files in every workspace', () => {
    expect(WEB_SOURCES.length).toBeGreaterThan(130);
    expect(API_SOURCES.length).toBeGreaterThan(35);
    expect(COMPONENTS.length).toBeGreaterThan(45);
  });
});

it('§18 item 6: every R-G1 affordance is back ONLY where its mechanism is real', () => {
  // Back, with its mechanism named:
  expect(grepRepo(/AssigneeChip/, COMPONENTS)).not.toEqual([]);      // assignment table
  expect(grepRepo(/assignedToMe/, WEB_SOURCES)).not.toEqual([]);     // the inbox route
  expect(grepRepo(/SearchPalette/, COMPONENTS)).not.toEqual([]);     // GET /v1/search
  expect(grepRepo(/ReportView/, COMPONENTS)).not.toEqual([]);        // the findings map
  // STILL ABSENT, because no mechanism arrived:
  expect(grepRepo(/firmTag|firm-tag/i, WEB_SOURCES)).toEqual([]);
  expect(grepRepo(/\bassigneeId\b/, COMPONENTS)).toEqual([]);        // S17, retired for good
  expect(grepRepo(/mobileAssignedTab|AssignedTab/i, WEB_SOURCES)).toEqual([]);
  // The sanity half, on both directions:
  expect(/firmTag/i.test('const firmTag = 1')).toBe(true);
  expect(grepRepo(/LoadErrorPanel/, COMPONENTS).length).toBeGreaterThan(3);
});

it('the header avatar is still the local profile s own initials and never a stranger s', () => {
  // R-G1's one surviving single-user affordance. Stage 4 made presence real
  // and this stage made assignment visible; neither is a reason for the
  // avatar to become somebody else.
});

it('nothing notifies outside the app (P59), and the assign panel says so', () => {
  expect(grepRepo(/nodemailer|sendgrid|smtp|webhookUrl|teams\.microsoft/i, API_SOURCES)).toEqual([]);
  expect(codeOf(at('src/features/assignments/AssignPanel.tsx')))
    .toMatch(/Nothing is sent by email or chat/);
});

it('every piece of export and disposition wording still has exactly one home', () => { /* … */ });
it('every new config key has a reader and a divergence row', () => { /* … */ });
it('no module outside a config module reads process.env', () => { /* … */ });
it('audit_event still holds no disposition action (S22)', () => { /* … */ });
it('every applied migration is immutable, and the numbering has no gap or duplicate', () => { /* … */ });
it('user.role_changed either has a writer or is recorded as having none', () => {
  // Task 10 found it: declared in AUDIT_ACTIONS, rendered by
  // MatterActivity.tsx, written by nothing. Either a route writes it now,
  // or this assertion pins the fact so it is a known gap rather than a
  // verb nobody noticed was dead.
});
```

- [ ] **Step 2: The live pass, with three accounts, results written down**

1. `npm run compose:up`; healthy; `threeAccounts()` returns three roles.
2. **Every admin route, three times each**: admin 200, partner 403, trainee 403. Enumerated from `ROUTE_POLICY` rather than typed by hand, so a route added later with no live check fails here.
3. A role mapping is added, previewed, confirmed, used (the trainee's very next request gains the role), removed, and the removal takes effect on the next request. `audit_event` holds four rows and `finding_disposition_event` holds none.
4. `docker compose --env-file /tmp/compose.env restart api`; the admin mapping survives; a configuration row the variable no longer names does not.
5. A person is disabled, refused, re-enabled, pseudonymised; `finding_disposition_event` is byte-identical throughout.
6. The providers screen's data is fetched as admin; the response is swept for every configured credential value.
7. The audit export is taken for a bounded range and its manifest counts are compared against the rows; an unbounded range is refused.
8. `docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com'` — **still fails**.
9. Everything created is deleted, by name, in the report.

- [ ] **Step 3: The three categories, filled in with results**

Reproduce the definition-of-done table from this plan with the **evidence that actually exists**, in P44's three categories: met by mechanism, met by rendered string, unmet. **A green sweep over all of them would be the worst outcome** — say which clauses have no verification gap (the audit export, the disable/pseudonymise path, the grant boundary, the search failure states) and which have only a jsdom assertion behind them.

- [ ] **Step 4: Say what could not be done, by name**

Check `list_connected_browsers` and record the result. Then the list from this plan's DoD section, unchanged and unsoftened, plus the three environment-gated items: **Spike 2's Azure half, Spike 3's Container Apps half, and §18 item 10(c)** — named together, as Stage 4 named them, with the sentence that four stages have now closed without them.

- [ ] **Step 5: `README.md`**

The affordances that exist now, what still does not (below), and — in the same edit — the deployment steps this stage added: `role_mapping` is now two-sourced and an administrator can edit the admin half; a person can be disabled and pseudonymised; the audit export exists and is bounded; the providers screen states which S2 guarantee the deployment has. Keep §18 item 8's rule: no unconditional no-keys sentence, anywhere.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/stage5DoD.test.ts apps/api/test/stage5DoD.compose.test.ts \
  README.md .superpowers/sdd/2026-08-30-lexprompt-server-stage-5-collaborative-surfaces/stage-5-report.md
git commit -m "test: Stage 5's definition of done, and the categories it honestly falls into"
git show --stat HEAD
```

---

## Task 17: The rulings, and what is still not built

**Type:** documentation. **The last commit of the last planned stage.**

**Files:**
- Modify: `docs/superpowers/redesign/rulings.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Record P45–P61 in `rulings.md`**

In its established format, under a heading naming this stage, each with its cost if wrong — copied from this plan's decisions section and **amended where the implementation differed**, which it will have. Where a task's report says a decision was implemented differently (Task 9's audit attribution at startup is the likeliest), the ruling records what shipped and notes what the plan said, in `rulings.md`'s own supersession idiom. A ruling that describes a plan rather than a codebase is a ruling nobody can check.

- [ ] **Step 2: Record the four R-G rulings this stage discharged, and the ones it did not**

- **R-G1 / R1** — fully discharged across Stages 4 and 5. Its *rule* survives verbatim and is the one that still binds.
- **R-G11** — discharged (Task 6), and the record says *how*: not by building the live report view R-G11 doubted, but by rendering the report the export already produces.
- **R-G14** — discharged (Tasks 4–5), with P48's corpus limit recorded as part of the discharge rather than as a footnote to it.
- **S18** — discharged.
- **Still standing:** R-G12 (no AI playbook suggestion in intake), R-G13 (no OCR progress UI), R-G15 (no playbook version diff). None of them acquired a mechanism and none of them is Stage 5's.

- [ ] **Step 3: `CLAUDE.md`'s closing edit — what is not built**

Replace the "Still not built" sentence with the full statement, because after this stage there is no later stage to defer to:

> **What is still not built, after Stage 5, and it is a list rather than a gap.** There is **no out-of-app notification** of any kind (§17 Q2 is the owner's: each channel is a subprocessor and a line in §12, and the assign panel says plainly that nothing is sent). **Search does not read the text inside documents** — it searches names, references and clause titles, and says so on screen; closing it needs a `tsvector` column, a GIN index and a second labelled section that explains its own matching. **No export says where a review was processed** (§17 Q12): the `run` row carries provider, model and jurisdiction, but `finding` carries no `run_id`, so a clause cannot honestly be attributed to a run, and the call log remains the evidence. **There is no retention job**: `audit_event` is partitioned monthly and its retention is a `DETACH` somebody has to schedule (§17 Q3). **There is no second workspace** — the column is on every table and one workspace is seeded (S9). **There are no per-matter ACLs**, so a conflicts wall is an addition rather than a configuration (S10). **The admin surface covers role mapping, people, providers and the audit export; it does not cover retention configuration**, which §7 lists and which is Q3's answer's shape rather than a screen anyone can design yet. And **the blob-orphan routes are still operator-only, reached with `curl`** — a deliberate absence, not an oversight (`routeTable.ts` says so).

- [ ] **Step 4: `README.md`'s closing section — what a first firm deployment still needs**

Six items, none of which is code this project can write on its own:

1. **The owner's answers to §17 Q3 (retention, including precedent retention), Q4 (which providers and the declared jurisdiction set), Q6 (GDPR erasure versus a permanent history — now larger, because `audit_event` is a second insert-only table with no application erasure path and the only remedy is the `app_user` pseudonymisation this stage built), Q12 and Q13 (a non-Azure production deployment).** Q4 is not optional: the gateway **refuses to start** until a jurisdiction set is declared.
2. **An Entra app registration**, its group claim, admin consent, and a deployed run against it — §5.1's "what local does not prove" list, and its **group overage** case, which §19 names as the thing most likely to be met in a real tenant and impossible to meet locally.
3. **Spike 2's Azure half** — `api`'s egress denial and the gateway's provider-hostname allowlist, proven by a test in Azure rather than in compose.
4. **Spike 3's Container Apps half** — a long-lived WebSocket through Container Apps ingress with scale-to-zero, and whether the `maxReplicas` Task 14 of Stage 4 pinned still holds there.
5. **§18 item 10(c)** — the integration and end-to-end suites run against an ephemeral deployed environment, not only against compose. A test that only ever runs in one environment is evidence about one environment.
6. **A browser pass with two real accounts, on the deployed environment** (§18 item 9) — and, before it, the local two-profile pass that four stages have now closed without. Every rendered-string claim in Stages 4 and 5 is asserted in jsdom and by nothing that has looked at a screen; the reports say so and the README should not soften it.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/redesign/rulings.md CLAUDE.md README.md
git commit -m "docs: Stage 5's rulings, and what is still not built when it is done"
git show --stat HEAD
```

---

## Interfaces a later stage must honour

Recorded so a later change extends rather than duplicates. Each is something this stage built that the next person will be tempted to build again.

1. **`role_mapping.source` is the boundary between two writers, and row-level security is what enforces it.** RLS is enabled **without `force`** so the migrator-owned seed still reaches every row; adding `force` breaks every sign-in through a configuration mapping. Three separate write policies, never one `for all` — `for all` governs `select` too and would narrow the read that `roleFor` depends on.
2. **The startup seed's delete-half carries `and source = 'configuration'`.** Removing that predicate erases every admin mapping on every restart, and the symptom is a screen that looks like it never saved.
3. **`GET /v1/assignments` answers the caller's own queue and nothing else**; `GET /v1/reviews/:id/assignments` answers one review's open requests. Two questions, two routes, two entries in `ROUTE_POLICY`. Do not merge them with a query parameter.
4. **`AssignmentInboxItem` composes `AssignmentView`; the socket payload carries the bare view.** A push is a doorbell with a row attached, not the inbox — and no event payload ever carries a display name (Stage 4 interface note 3).
5. **`src/lib/api/users.ts` is still the only id→name resolver**, and `undefined` for an unknown id renders as "someone this workspace does not name" in every surface that has met the case — the feed, the chip, the report. One wording.
6. **A count is read, never accumulated from pushes.** `assignedToMe` re-reads on a relevant frame. A counter maintained by incrementing diverges the first time a frame is missed and never recovers.
7. **Search's arms are separate statements on purpose**, unlike `activity.ts`'s single `UNION`. The feed must order and limit its arms together; search must report them separately, and a `UNION` that throws loses every arm.
8. **`SearchSourceOutcome` is returned for every source on every answer**, including a completely successful one. Dropping it for tidiness re-creates the ambiguity the feature exists to remove.
9. **`ReportView` declares no display string.** It is the third renderer over one findings map, and everything it says comes from `findingOutcome.ts`. A fourth renderer follows the same rule.
10. **The providers surface has no write route, and that is the design** (S15, S27). Adding one would move "where privileged text is processed" from a deploy-time act with a Risk sign-off to a click.
11. **`ProviderStatus` carries `configured` and `rotatedAt` and no fact about a secret.** Not a prefix, not a length, not a fingerprint.
12. **S2's two sentences stay two, everywhere** — the app, the README, the admin screens and the spec (§18 item 8). Task 14's test is the guard and the pressure to merge them is permanent.
13. **The audit export refuses rather than truncates**, and its manifest counts come from the same statement that produced its rows.
14. **`audit_event` still holds no disposition action** (S22), and `AUDIT_ACTIONS` is still a closed set. A new verb is a decision made once, in that file.
15. **Pseudonymisation touches `app_user` and nothing else.** No history row is ever rewritten; that is what makes the history evidence.
16. **`ROUTE_POLICY` has no default, and every admin route is asserted refused for `reviewer` and `partner` live**, not only in the table. Check that `oidc.test.ts`'s route scanner still discovers every route after any registration-shape change.
17. **Every migration file is immutable once applied, and a plan's stated number is advisory.** Read `apps/api/migrations/` and take the next unused number; three migrations have already moved from the number their plan gave them because a fix round landed a file first.
18. **`findingOutcome.ts` has still not moved to `packages/core`** (P33), and §6.3 says it should when a server-side export needs it. Task 15's export is server-side but exports *audit rows*, not findings, so the pressure has not arrived yet. It will.
19. **Spike 2's Azure half, Spike 3's Container Apps half, and §18 item 10(c) are all still unproven** after five stages. Any later work in an Azure environment should close them before it closes anything else.

---

## What is not built when Stage 5 is done, and what a first firm deployment still needs

This is the last planned stage, so this section is a statement rather than a deferral. Task 17 writes both halves into `CLAUDE.md` and `README.md`; they are here so a reader of the plan does not have to reach the last task to find them.

**Not built, and each is a decision rather than a gap:**

1. **No out-of-app notification of any kind.** An assignment reaches somebody who opens LexPrompt. §17 Q2 is the owner's — every channel is a subprocessor and a line in §12 — and the assign panel says plainly that nothing is sent (P59).
2. **Search does not read the text inside documents.** Names, clients, references and clause titles only, stated on screen. Closing it needs a `tsvector` column, a GIN index and a second labelled section that explains its own matching (P48).
3. **No export says where a review was processed** (§17 Q12). `run` carries provider, model and jurisdiction; `finding` carries no `run_id`, so no clause can honestly be attributed to a run. The gateway's call log remains the evidence (P60).
4. **No retention job and no retention screen.** `audit_event` is partitioned monthly and its retention is a `DETACH` somebody has to schedule (§17 Q3). §7 lists retention configuration among an admin's powers; a screen for a policy nobody has chosen would choose one.
5. **One workspace.** The column is on every table and a second tenant is not a schema migration (S9) — but nothing seeds, names or switches one.
6. **No per-matter access control.** A conflicts wall is a `matter_access` table and a predicate, and it is an addition the design costs rather than a configuration (S10).
7. **The blob-orphan routes are still operator-only**, reached with `curl` and a bearer token, deliberately (`routeTable.ts` says so). The new admin screen does not adopt them.
8. **`findingOutcome.ts` is still in `src/`, not `packages/core`** (P33). §6.3 says it moves when a server-side export needs it; Task 15's export carries audit rows rather than findings, so the pressure has not arrived. It will.

**What a first firm deployment still needs, none of which this project can write on its own:**

1. **Owner and DPO answers to §17 Q3, Q4, Q6, Q12 and Q13.** Q4 is not optional — the gateway **refuses to start** until a jurisdiction set is declared, and nothing ships a default (S27). Q6 is materially larger than it was: `audit_event` is now a second insert-only table with no application erasure path, alongside `finding_disposition_event`, and the only remedy this design can offer is the `app_user` pseudonymisation Task 12 builds. That is the operational half; the policy half is the DPO's.
2. **An Entra app registration**, its group claim, admin consent, and a deployed run against it — §5.1's "what local does not prove" list, and its **group overage** case, which §19 names as the thing most likely to be met in a real tenant and impossible to meet locally.
3. **Spike 2's Azure half** — `api`'s egress denial and the gateway's provider-hostname allowlist, proven by a test in Azure rather than in compose. Open since Stage 1.
4. **Spike 3's Container Apps half** — a long-lived WebSocket through Container Apps ingress with scale-to-zero, and whether the `maxReplicas` Stage 4 pinned holds there. Cross-replica fan-out is proved locally at two replicas and has never been proved through Container Apps.
5. **§18 item 10(c)** — the integration and end-to-end suites run against an ephemeral deployed environment, not only against compose.
6. **A browser pass with two real accounts on a deployed environment** (§18 item 9), and, before it, the local two-profile pass that five stages have now closed without. Every rendered-string claim in Stages 4 and 5 is asserted in jsdom and by nothing that has looked at a screen. Say that, rather than implying otherwise.

---

## Self-review

### 1. Spec coverage

Every Stage 5 requirement, with the task that implements it.

| Requirement | Source | Task |
|---|---|---|
| Every affordance R-G1 dropped is back **only** where its mechanism is real | §18 item 6, S18 | 2, 3, 5, 6; asserted by 16 |
| The assignee chip | §13 Stage 5, S18 | 3 |
| The "assigned to me" counter | §13 Stage 5, S18 | 1, 2 |
| Actors in the feed | §13 Stage 5 | **Shipped in Stage 4** (Task 12 there). Nothing to do; Task 16 asserts it did not regress |
| Firm-wide search | §13 Stage 5, R-G14 | 4, 5 |
| The Report tab | R-G11 | 6 |
| Admin: role mapping | §7 | 8, 9, 10, 11 |
| Admin: model / provider selection | §7, §6.6, S15 | **Model choice shipped in Stage 2** (`WorkspaceModelPanel`). The provider *view* is 13, 14 |
| Admin: disabling a user | §7 | 12 |
| Admin: exporting the audit log, including the disposition history | §7, §6.3.1, §12 Q3 | 15 |
| Admin: retention configuration | §7 | **Not built.** §17 Q3 is unanswered, and a screen for a policy nobody has set would be a screen that invents one. Named in Task 17's "what is not built" |
| The credential admin endpoint reports configured / rotated and nothing else | §14 `credential` suite, §10 | 13 |
| Every model labelled with provider and jurisdiction, in the same form, with no entry unlabelled | S27 | 14 |
| The `dataHandling` note shown, dated, staleness marked, never graded | S26 | 14 |
| S2's two sentences stay two; no unconditional no-keys claim anywhere | §18 item 8, S2 | 14, 16, 17 |
| An admin route is refused by the API, not merely hidden by the UI | §7 | 10, 12, 14, 15; live in 16 |
| `workspace_id` on every new table, every query scoped | §6, S9 | 4, 8, 15 |
| `audit_event` append-only, no disposition action, retention by `DETACH` | S11, S22 | 10, 12, 15, 16 |
| Nothing derives a human judgement, at every new surface | §3, §9.1 | global; 16 asserts it |
| A load path distinguishes not-known / broken / empty / stale | §3 | 2, 5, 11, 15 |
| No development bypass; no route without a policy | S29, §7 | every route task; 16 |
| Divergence list stays exact | S30, §18 item 10 | 1, 4, 15 |
| Mutation tests on everything load-bearing | §14 | 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15 |
| `tsc` clean, tests pass, build clean | §18 item 1 | every task's gate |
| §17 Q2 (out-of-app notification) | §17 | **Left open, deliberately** — P59, and the sentence ships in Task 2 |
| §17 Q12 (does the export say where it was processed) | §17 | **Left open, deliberately** — P60, with what closing it would take |
| §17 Q3, Q4, Q6, Q13 | §17 | **Owner and DPO decisions.** Q6's only available *remedy* is built (Task 12); the policy question is not this plan's to answer |

**Requirements I could not assign to a task, and why:**

- **Retention configuration (§7).** A screen for a policy nobody has chosen would choose one. Q3 first.
- **Spike 2's Azure half, Spike 3's Container Apps half, §18 item 10(c).** Unreachable environments, five stages running. Named together in Task 16's report and in Task 17's README section, as Stage 4 named them.
- **§18 item 9's deployed two-account pass.** Same reason. The local pass is named as still-undone too, because browser automation has been unavailable throughout and pretending otherwise is the thing `CLAUDE.md` forbids by name.
- **The full-text half of search.** P48 records the decision, the reason, and the exact shape of the work that would close it.

### 2. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `fill in`, `appropriate error handling`, `similar to Task`, `and so on`, `etc.` in step bodies, and for test steps with no test. Fixed inline. What remains, and why each is a **deliberate delegation** rather than a placeholder:

- **Several test blocks carry `/* … */` for a body whose *assertions* are stated in the surrounding prose or in a sibling case.** In every instance the assertion that matters is written out and the elided part is seeding. Where the elided part *is* the point — Task 8's four data-comparison cases, Task 12's history-equality case, Task 15's manifest-versus-rows case — it is written in full, because those are the tests that would otherwise be written wrongly.
- **Task 9's audit attribution at startup is left as an explicit branch with both outcomes specified**, because `appendAudit` requires an `actorUserId` and there is no actor at container start. The task says: resolve a bootstrap admin, or record the supersession on the row and in a startup log line, and **report which shipped**. Pre-deciding it would be inventing a fact about a function this plan has not run.
- **Task 13's `rotatedAt` source is described by its meaning rather than transcribed**, because it depends on which credential source is configured (Key Vault's `updatedOn`, a mounted file's `mtime`, or nothing). The rule that matters — *absent means not recorded, never never* — is stated as a rule.
- **Task 15's three `UNION` arms are specified by their scoping, ordering and limit rather than transcribed.** They already exist in `activity.ts` at a different scope, and transcribing them here is how a reader gets a fourth copy of three near-identical `select`s, one of them subtly wrong.
- **No task quotes a component's exact shipped wording as frozen.** `CLAUDE.md`'s "frozen copy list" lesson: before applying any string a spec calls frozen, diff it against the shipped source. Every copy assertion in this plan is over a string the task itself introduces.

### 3. Type and name consistency

Checked across all 17 tasks:

- **`AssignmentView` / `AssignmentsPage` / `AssignmentEventPayload`** — shipped in `packages/core/src/api/records.ts`; **reused, never redeclared**.
- **`AssignmentInboxItem { assignment, matterId, matterName, reviewName, clauseTitle? }` / `AssignmentInboxPage { items, capped }`** — Task 1, consumed by Task 2. `clauseTitle` is **absent**, never `undefined`-valued.
- **`ReviewAssignments { assignments }`** — Task 3. Distinct from `AssignmentsPage`, and the distinction is which question is being answered.
- **`AssignedToMe`** — Task 2, three variants, `error` carrying `message: string`. `ready` carries `count` **and** `capped`.
- **`SearchSource` / `SearchHit` / `SearchSourceOutcome` / `SearchResults`** — Task 4, consumed by Task 5. `SearchSourceOutcome.status` is `'ok' | 'failed' | 'capped'` — three, not two, and `capped` is not a kind of failure.
- **`SearchState`** — Task 5, four variants. `results` may hold zero hits **and** a failed source; `failed` is the request itself failing. Not merged.
- **`SEARCH_MIN_CHARS` / `SEARCH_DEBOUNCE_MS`** — Task 5, `src/features/search/useSearch.ts`. `API_SEARCH_LIMIT_PER_SOURCE` is the server's and lives in `apps/api/src/config.ts` only.
- **`RoleMappingView` / `RoleMappingsPage` / `RoleMappingEffect`** — Tasks 10 and 11. `RoleMappingsPage.readAt` is the "as at" idiom; `RoleMappingEffect.sentence` is produced server-side and rendered verbatim.
- **`role_mapping.source`, `created_at`, `created_by_user_id`, `updated_at`, `updated_by_user_id`, `converted_from_admin_at`** — Task 8's column names, used verbatim by Tasks 9, 10 and 11.
- **`ProviderStatus` / `ProvidersPage`** — Task 13, consumed by Task 14. `auth: 'managed-identity' | 'key' | 'none'` is what decides which of S2's two sentences the screen shows; it is not a boolean.
- **`AuditExportManifest`** — Task 15. `complete: true` is a literal type, so a future paged export cannot ship without deciding what to put there.
- **`AUDIT_ACTIONS` additions** — `role_mapping.created`, `role_mapping.changed`, `role_mapping.removed`, `role_mapping.superseded_by_configuration` (Tasks 9, 10); `user.disabled`, `user.enabled`, `user.pseudonymised` (Task 12). **`user.role_changed` is shipped, rendered and unwritten** — Task 10 records it, Task 16 pins the resolution either way.
- **`threeAccounts()`** — Task 1, `apps/api/test/helpers/threeAccounts.ts`, importing `signIn` and `TestAccount` from `twoAccounts.ts`. `twoAccounts()` is not changed and not wrapped.
- **New config keys** — `API_ASSIGNMENT_INBOX_LIMIT` (T1), `API_SEARCH_LIMIT_PER_SOURCE` (T4), `API_AUDIT_EXPORT_MAX_ROWS` (T15). All `sameEverywhere`, all in `apps/api/src/config.ts` and nowhere else, all added to `divergence.json` and `caps.test.ts` in the commit that introduces them.
- **Routes and their `ROUTE_POLICY` entries** — `GET /v1/reviews/:id/assignments` (reviewer, T3); `GET /v1/search` (reviewer, T4); `GET|POST /v1/admin/role-mappings`, `POST /v1/admin/role-mappings/preview`, `PUT|DELETE /v1/admin/role-mappings/:issuer/:groupValue` (admin, T10); `POST /v1/admin/users/:id/disable|enable|pseudonymise` (admin, T12); `GET /v1/admin/providers` (admin, T14); `GET /v1/admin/audit-export` (admin, T15). Plus the gateway's `GET /v1/admin/credentials` (T13), which is behind `callerAuth` and **not** in `apps/api`'s `ROUTE_POLICY` — two different servers, two different tables, and conflating them is the mistake to avoid.
- **Migration** — `014_role_mapping_source.sql`, the only one. `001`–`013` untouched.
- **Decision labels** — this plan's are **P45–P61**, continuing P1–P5, P6–P16, P17–P28, P29–P44. `rulings.md`'s owner decisions are **D1–D5**; its execution rulings are lettered (`R-G*`, `R-E*`, `R-S4E*`). No label here collides.

### 4. What I would check first if this plan turns out to be wrong

In order of how likely the failure is and how quiet it would be:

1. **Task 8's policies written as one `for all` instead of three.** It is tidier, it is what a reviewer would suggest, it passes every write test in the suite — and it silently narrows `select` to `source = 'admin'`, so `roleFor` stops seeing configuration mappings and **every sign-in through a configured group fails**. The mutation is named in the task; run it, do not assume it. This is the single most damaging plausible error in the stage.
2. **Task 9's delete-half left unscoped.** Every admin mapping is erased on every container restart. Nothing errors, nothing logs, and from the screen it looks exactly like a write that never saved — which is the failure this whole part exists to prevent, produced by the fix for it. The `pg` test catches it; the **restart** check is what proves the wiring.
3. **The counter rendering `0` when the read failed.** One `catch` that sets `count: 0` and the badge disappears; a lawyer does not do something a colleague is waiting on and there is nothing on screen to notice. Confirm `AssignedToMe.test.tsx` › *"never renders a digit in the error state"* exists **and that its mutation reddens it**.
4. **A search arm swallowing its own failure into `status: 'ok', count: 0`.** Every happy-path test still passes and the empty result is a lie. Task 4's mutation is the guard and it is the one to run first in Part 5B.
5. **The lock-out check run outside its transaction.** Two administrators removing two mappings at once both see two admin rows and both are allowed; the workspace has none, and the only repair is a database session. Single-caller tests all pass. Task 10 names the mutation and the concurrent case.
6. **`app_user.role` rendered as the effective policy.** The most natural screen to build from `GET /v1/workspace/users`, and it shows the role of somebody's last request as their role. Task 11 asserts the panel does not even import `WorkspaceUser`; check that assertion exists.
7. **The providers screen merging S2's two sentences.** §19 says the pressure is permanent because the merged sentence is shorter and sounds better. Task 14's mutation is exactly this; run it.
8. **The audit export's manifest counted separately from its rows.** Two statements, one claim, and they disagree the first time anything is written between them. Task 15's `counts EXACTLY what it delivers` is the guard.
9. **A guard inverted by deletion rather than by replacement.** Four absence assertions are being flipped in this stage; a deleted `it` passes every other test in the repository. Task 7's first check is the only thing standing between that and a boundary nobody is holding — and disagreement 6 has already found one shipped guard with no sanity check at all, so the class is live rather than hypothetical.
