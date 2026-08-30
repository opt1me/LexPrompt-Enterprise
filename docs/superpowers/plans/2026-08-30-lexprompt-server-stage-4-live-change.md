# LexPrompt Server — Stage 4: live change and attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a disposition say whose it is and when; make one person's change visible to another without a reload; make a change submitted against a state that has moved resolve *visibly* rather than by last-write-wins; let two people see each other in one review; and let a trainee hand a clause to a partner — without at any point letting a live update overwrite a judgement the person looking at the screen never saw.

**Architecture:** Two parts. Part 4A makes the *record* honest over the transport Stage 3 already shipped: a workspace user directory, the disposition and the `finding_disposition_event` that produced it carried beside the findings, `dispositionLabel` / `dispositionHistoryLine` beside `verificationLabel`, the actor and time on every card, a reachable history, a refusal that names whose change won and offers yours again, the export's "as at" instant and its changed-from facts, `audit_event`, and an activity feed that names people. Part 4B replaces the transport and adds who-else-is-here: a WebSocket multiplexed over subscriptions, the same monotonic `event` cursor with replay and `resync_required`, a hub behind an interface whose fan-out reads the outbox by cursor (correct at any replica count, with `pg_notify` as a doorbell rather than a delivery), the fourth `stale` load state that disables the disposition controls and says why, presence, and the `assignment` table with an assignment that reaches a person.

**Tech Stack:** Everything Stage 3 shipped, plus `@fastify/websocket` (the only new runtime dependency, and Task 16 takes an explicit branch if its peer range refuses Fastify 5) and a dedicated `pg.Client` per replica for `LISTEN`. No Redis unless Task 14's two-replica test says otherwise, and that is decided as a task with a recorded answer rather than assumed. TypeScript 5.8, Vitest 3.2 (`test.projects`: `web` jsdom, `core`/`gateway`/`api` node, plus the `api-pg` and compose configs), Fastify 5, `pg` 8, `@azure/storage-blob` 12, undici, `jose`, `oidc-client-ts`, Keycloak, Azurite, Postgres 16, Docker Compose, `azd` + Bicep.

**Spec:** `docs/superpowers/specs/2026-08-28-lexprompt-server-design.md` (binding authority). Stage 4's boundary is §13; its definition of done is §18 item 5; realtime is §8; the collaboration tables are §6.3; the export's point-in-time framing is §6.3.1; the four load states and `await-then-apply` are §3; R-G1's supersession is §3.1; the environments are §5.1; the testing bar is §14 (the `realtime`, `disposition`, `loadStates` and `authz` suites); Spike 3 is §15; the estimate is §20; rulings **S4**, **S6**, **S7**, **S8**, **S9**, **S10**, **S11**, **S17**, **S18**, **S20**, **S22**, **S28**, **S29**, **S30**, **S31**; and `CLAUDE.md`, which binds everything below and which **this stage edits** — see P38.

**Preceding plan:** `docs/superpowers/plans/2026-08-30-lexprompt-server-stage-3-engine.md` and its ledger `.superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/progress.md`. **Read the ledger's standing rules before Task 1**, and read that plan's closing sections — *"Interfaces Stage 4 and later must honour"* (seventeen numbered items, every one of which this plan either consumes or supersedes explicitly) and *"What Stage 3 deliberately leaves to Stages 4 and 5"*. Also read `.superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/stage-3-report.md`, whose *"What was not verified"* list is this stage's starting position rather than its excuse. This plan continues the decision numbering: Stage 1's are **P1–P5**, Stage 2's **P6–P16**, Stage 3's **P17–P28**, this plan's **P29–P44**. `rulings.md`'s **D1–D5** remain the *owner's* decisions. A `D<n>` references `rulings.md`; a `P<n>` references a plan.

---

## Scope check, before anything else

§20 estimates Stage 4 at **1.5–2 sub-project equivalents** — the same band as Stage 3, which came out at 26 tasks over two parts. §13 says a stage larger than its estimate is **decomposed further rather than compressed**, and §19 and §20 both say, in their own words, that Stage 4 is the stage whose surface work is likeliest to be trimmed under pressure and most damaging to trim.

My decomposition also comes out at **26 tasks, two parts, one hard gate**. Three things push the real size to the *top* of that band and possibly past it, and they are findings rather than opinions:

1. **Spike 3 is unrunnable in the environment it names.** §15 asks how WebSockets behave through Container Apps ingress with scale-to-zero and more than one replica. No Azure environment has been reachable for three stages (Spike 2's Azure half is still open). So the spike's *cost* does not arrive as an answer — it arrives as local infrastructure: `api` at two replicas behind nginx in compose (§5.1 row 6 requires exactly this), a fan-out correct at any replica count, and a test that fails without it. That is Tasks 14 and 18, and it is work the spec's estimate treats as a question rather than as tasks.
2. **The shipped Bicep already scales `api` to three replicas.** `infra/modules/containerApps.bicep` sets `scale: { minReplicas: 1, maxReplicas: 3 }` for `api`. §8 says fan-out is *"in-process while `api` runs as a single replica"*, and Stage 3's P27 asserted *"Spike 3 has not run, so `api` is single-replica anyway."* **That was wrong about the shipped template.** An in-process hub shipped as-is means a client connected to replica 2 never hears a write made on replica 1 — silently, and only in the deployed environment. That is not a refinement; it is the difference between this stage's central claim being true and being true on a laptop.
3. **The two-account harness is new work no prior stage built.** §14 and §18 item 5 both require two real accounts; the seeded Keycloak realm has four users and `directAccessGrantsEnabled: false`, and Stage 3 declined to change it. Nothing in the repository can currently obtain two tokens, so every collaborative assertion in this stage is unwritable until that exists — which is why it is Task 1 and not an appendix.

**The verdict: one stage, two parts, a hard gate — and a named Part 4C that is *entered* rather than compressed if the gate slips.** I am not proposing a second stage document, for the reason Stages 2 and 3 both gave: Part 4B's tasks consume Part 4A's routes and wire shapes, and a second document reproduces Stage 1's most expensive failure, a brief naming an interface that had moved. I am proposing something the prior plans did not need — an explicit **degradation order** — because this is the first stage where the estimate is genuinely at risk and §19 names in advance which half gets sacrificed if nobody decides beforehand.

| | Part 4A — *the record is honest* | Part 4B — *the change arrives without asking* |
|---|---|---|
| Tasks | 1–13 | 14–26 |
| Ships | the two-account harness; the workspace user directory; the disposition and its most recent event carried beside the findings; `dispositionLabel` / `dispositionHistoryLine`; the actor and time on every card; the reachable history panel; the stale-change refusal that names whose change won and offers yours again; the mid-decision guard; the export's "as at" instant, its changed-from facts and its sentence that a disposition can change; the per-review history export; `audit_event` with its grants and partitions; the activity feed reading three sources and naming people | Spike 3 answered locally at two replicas; the outbox's widened vocabulary and its review and matter subscriptions; the WebSocket server and its subprotocol authentication; the nginx upgrade hop; cross-replica fan-out; the browser socket client behind `watchRun`'s existing signature; the fourth `stale` load state and the disabled disposition controls; someone else's write arriving as a push; presence and its roster; the `assignment` table and an assignment that reaches a person |
| Its own DoD | two seeded accounts, over real HTTP, produce: a disposition set by one and overridden by the other; both cards, read back, name the right person and the right instant; the loser of a genuine race is refused with the winner's name and can re-apply; a DOCX and a CSV carry the "as at" instant, the changed-from facts and the can-change sentence, asserted over their bytes; the feed names both people | §18 item 5 in full, minus what only a human at a browser can confirm — which is listed by name, not implied away |
| Shippable alone? | **Yes, and it must be.** At the end of 4A a firm has honest attribution and a visible refusal, one poll interval behind. Nothing on screen claims to be live. | Yes. It replaces a transport and adds presence and assignment, without changing one word a card says about a disposition. |

**The one thing the split may not do, and it is the opposite of Stage 3's.** §13: *"the attribution and export surfaces ship with the mutability, in the same stage … a plan that sequences them after it has sequenced them wrong."* So the seam is **not** "mechanism in 4A, surfaces in 4B". It is the reverse, and it is forced by a fact Task 1 exists to demonstrate rather than assert:

> **Change-by-others is already live, and already unattributed.** `PUT /v1/reviews/:id/findings/:findingsKey/:clauseId/disposition` is `ROUTE_POLICY: 'reviewer'`, scoped by workspace and by nothing else. `setDisposition` compares a version and a state; it does not compare actors. Stage 2 seeded four accounts in the realm. **The second account that signs in can already overwrite the first account's verification, and the card will read a bare "Verified" with nobody's name on it.** Stage 3 shipped the mechanism and, correctly under P28, shipped no surface — but the gap that leaves is open *now*, not at the end of this stage.

So Part 4A does not add mutability. It closes a gap Stage 3 opened deliberately and named, and that is why every honesty surface comes first and the transport comes second. A plan that built the socket first would spend a fortnight making an unattributed "Verified" arrive faster.

**The degradation order, if the Task 13 or Task 18 gate slips.** Named now, in the plan, so nobody decides it at 17:40 on the day: Tasks 22–23 (presence), then Tasks 24–25 (assignment), come out in that order into a **Part 4C** with its own gate. Neither is load-bearing for honesty — presence *locks nothing, blocks nothing and gates no write* (S6), and an assignment that has not shipped is a feature nobody has been promised. **Nothing in Part 4A may be cut, and Tasks 19–21 may not be cut**, because a socket that delivers findings but not `finding.disposition_changed` is §18 item 5's headline clause missing while the rest of the transport claims to be live. If the choice is between shipping presence and shipping the push that carries a partner's override, the push wins every time.

**What this costs if the split is wrong:** one review gate's ceremony between Tasks 13 and 14, and a poll loop that lives one part longer than it needed to. What the alternative costs: a live transport carrying a state whose card cannot say who put it there — §13's named error, and `CLAUDE.md`'s founding defect at a network boundary.

---

## What Stage 3 shipped that this plan builds on

Read the shipped source before writing code against any of it. **Where the shipped source disagrees with this brief, the shipped source wins** — that sentence is in every task's Interfaces block, and it is there because 19 of 23 Stage 1 briefs, 21 of 21 Stage 2 briefs and 26 of 26 Stage 3 briefs contained real bugs in their reference code.

| Shipped in Stage 3 | Where | What Stage 4 does with it |
|---|---|---|
| `event` table: identity `id`, `workspace_id`, **nullable** `matter_id`, `review_id`, `run_id`, `type`, `payload jsonb`, index on `(workspace_id, review_id, id)` | `apps/api/migrations/008_runs.sql` | **No schema change is needed for the subscriptions.** `run_id` is already nullable and the review index already exists. What changes is `EventToAppend` (which *requires* `runId` today), `readEvents` (which filters on `run_id`), and `matter_id` (which nothing populates) — Task 15 |
| `appendEvent(t, e)` takes a `Tx`, never a `Db`, so an event cannot commit while the row it describes rolls back | `apps/api/src/run/events.ts` | Unchanged and extended. Every new event type goes through this function; there is no second writer |
| `readEvents` — cursor, `limit + 1` for an honest `hasMore`, `resyncRequired` measured against `min(id)` over the **whole** table | `apps/api/src/run/events.ts` | The socket's replay path calls this, unchanged. Stage 4 adds a subscription predicate, not a second protocol |
| `fromEventRow` **throws** on a type outside the five | `apps/api/src/run/events.ts` | Widened deliberately in Task 15, with the closed-set refusal kept. A seventh type arriving unregistered must still throw |
| `setDisposition(t, key, change, cause, actor, at, expectedVersion)` → `DispositionRow`; `ConflictError(currentRow)` on a stale version; the history insert in the same transaction | `apps/api/src/dispositions/service.ts` | **The stale-change refusal is already correct.** Stage 4 adds the sentence, the name and the re-offer — never a retry, never a merge |
| `DispositionView` / `DispositionEventView` / `DispositionWriteResult` / `DispositionHistory`, and `FindingsPage` with `dispositionVersions` and `findingVersions` **beside** the findings | `packages/core/src/api/records.ts` | `FindingsPage` gains `dispositions` on the same terms — beside, never inside `Finding` (P34) |
| `GET /v1/reviews/:id/findings/:findingsKey/:clauseId/history` — shipped, tested, **and read by no UI** | `apps/api/src/routes/findings.ts` | Task 6 is its first reader. Its docstring says so; do not write a second route |
| `watchRun(runId, onEvent, onError, { onResync, intervalMs })` → unsubscribe, cursor kept internally | `src/lib/api/runs.ts` | Task 19 replaces the transport **inside** this function. Interface note 3: the five payload types are not redefined |
| `refreshFindings` / `humanWritesRef` / `applyToFinding` — coalesced re-reads, and a read that predates a confirmed human write is discarded rather than merged | `src/App.tsx` | The push path reuses all three. `carryHumanState` is deleted and nothing brings a merge back |
| `ROUTE_POLICY` with **no default**; a route with no entry throws at registration | `apps/api/src/auth/routeTable.ts` | Every new route adds a line in the task that registers it |
| `Actor { id, issuer, subject, email?, displayName, initials, role, workspaceId }`, resolved once per request | `apps/api/src/auth/actor.ts` | The only source of an actor for any write. Never a body field |
| `GET /v1/me` — the **only** id→name route, and only for yourself | `apps/api/src/routes/me.ts` | Task 2's finding: there is no way to render *another* person's name. Task 2 adds the directory |
| Keycloak realm with four seeded users and `directAccessGrantsEnabled: false` | `infra/keycloak/` | Task 1 adds a **separate** test client with direct grants. The app's own client is untouched (P43) |
| nginx `location /api/` with `proxy_http_version 1.1` and **no `Upgrade`/`Connection` headers** | `infra/nginx/web.conf` | Task 17. A WebSocket handshake through this block fails today, and it fails at the hop local development *can* exercise |
| `scale: { minReplicas: 1, maxReplicas: 3 }` on `api` | `infra/modules/containerApps.bicep` | Task 14's branch decides whether this stands, and pins it with a comment either way |
| `stage3DoD.test.ts` asserting `dispositionLabel`, `"dispositions as at"` and the "was X" strings are **absent** | `apps/api/test/stage3DoD.test.ts` | **Inverted task by task, never deleted wholesale** (P30) |

---

## Stages 1–3's lessons, encoded here rather than rediscovered

Each one changed something in the tasks below, and the change is named.

**1. Every dispatched brief in three stages contained real bugs in its reference code** — 19/23, 21/21, 26/26. The worst would have refused every review and changeset a firm owns, left the queue claiming nothing forever, made "create a matter" a 500 with every unit test green, and silently dropped every verification on an upload. **Every code block below will be run by an implementer who has been told to distrust it.** Where this plan quotes a shipped signature it was read from the file on 2026-08-30; where it invents one, Step 1 writes the test that pins it before Step 3 writes the implementation. **Each task's report names which of its blocks failed to compile or to run**, and that list is the task's most useful output after the code.

**2. Interfaces drift between a brief being written and run.** Every task's **Interfaces** block carries *"read the shipped source; where it disagrees with this brief, the shipped source wins."* It is the instruction that saved two Stage 1 tasks whose brief imported a type from a file that does not exist.

**3. A test that cannot fail is this project's signature defect** — at least eight across Stages 1–2, and **seven guards found not guarding in Stage 3 alone**, including a scanner that walked `routes/` only while 34 unscoped statements sat outside it, and a sweep that found its own sanity string in its own source. So: **every guard in this plan carries the mutation that proves it bites, named by test title**, and **every scanner carries a sanity check that it finds what it claims to scan** before it is used to assert an absence. A `not.toContain` gets a companion positive assertion in the same test. This matters more here than anywhere before, because most of what this stage asserts is an *absence on a screen*: no disposition without an actor, no stale client offering a control, no presence row outliving its TTL.

**4. Plan tasks that RUN things.** Stage 3's worst two defects — a cell with no finding row spinning forever, and a lease that swallowed a missing row — were invisible to every unit test and were found by the compose gate. Tasks 1, 13, 14, 17, 18, 21, 23, 25 and 26 each carry a **run it** step against the live stack, using two real tokens, `curl`, a Node WebSocket client, `docker compose exec` and a real Postgres. None of them needs a browser.

**5. Browser automation has been unavailable for three stages** (the Chrome extension disconnects; the Playwright MCP times out). **Assume it stays unavailable.** This is the stage where that hurts most, because presence and live change are almost entirely visual — so the plan does three things rather than pretending otherwise: (a) it drives every *mechanism* headlessly, with two real accounts and two real sockets; (b) it drives every *rendered string* through `src/test/mount.tsx`, asserting the exact words a card shows in each disposition shape; and (c) **Task 26 lists, by name, what only a human at a browser can confirm, and says plainly that it was not done.** §18 item 5's clauses are marked met-by-mechanism, met-by-rendered-string, or unmet — three categories, not one. See *"The definition of done, and the part of it no test can reach"* below.

**6. The gate is `npm run typecheck` (discovery over four projects), and no gate is read through a pipe.** `npx vitest run` can report every test PASSED and still exit 1 on an unhandled rejection. Redirect to a file, capture the exit code, then read the file. `npm run test:pg` needs `scripts/pg-forward.sh` running and both `LEXPROMPT_TEST_DATABASE_URL` and `LEXPROMPT_TEST_MIGRATION_URL` exported. `npm run test:compose` needs the stack up.

**7. `test:pg` and `test:compose` share one database and one stack** (Stage 3's report, item 4). A suite that leaves state behind breaks a different file's assertions with a message pointing at the wrong feature. Every task that seeds a second user, a presence row or a socket **cleans up what it created**, and says in its report that it did.

**8. Fail loudly rather than answer quietly wrong** is the review standard for every task. In a stage that puts other people's writes on a reviewer's screen, the shapes to watch are: a dropped socket looking like a quiet review; a stale roster claiming a colleague is present; a push landing on top of a half-made decision; a refusal that reads as a network error; an override whose actor is the person reading the card rather than the person who made it; and an export that looks identical whether or not the disposition it reports still holds.

---

## Global Constraints

Copied from the spec, from `CLAUDE.md` and from the three preceding plans' still-binding constraints. Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** Prefer a loud, specific, recoverable failure over anything mistakable for a successful empty result.
- **Nothing derives a human judgement.** A disposition is a person's judgement about a specific answer. The only writers of `finding_disposition` / `finding_disposition_event` are `dispositions/service.ts`'s `setDisposition`, called from the disposition route and from the retry handler's reset. **The run worker's role holds no grant on either table**, and Stage 4 adds none (Stage 3's interface note 9). A live update is not a writer: it *renders* what the database already took.
- **`await-then-apply` survives verbatim, and realtime does not soften it** (§3, S8). Three distinct things: your own write renders from the HTTP response and nothing else — **no optimistic update for any human-authored state**; someone else's write arrives as a push, and rendering a fact about the server's state is not optimism; your own write also arrives back as a push and is **dropped by version guard**, so a confirmed value never flickers.
- **A stale change is refused, never merged and never auto-retried.** `ConflictError` carrying the current row is shipped; Stage 4 adds the actor's name, the instant, and the change offered again against the new version. A repeat produces a **second history row**, so both intentions are on the record (§6.3). P25 stands: an engine or metadata `409` may re-read and retry once; **a human-authored write never auto-retries.**
- **The stale-change refusal and the realtime version guard are the same number** (§8; Stage 3's interface note 1). `finding_disposition.version` is what a client sends back, what a `409` refuses on, and what a `finding.disposition_changed` push carries. **They must not become two numbers.**
- **A disposition is never shown without its actor and its time** (§6.3). The one exception is a never-touched `unchecked` (`changedCount === 0`), which renders as "Not checked" and names nobody — the honest reading of a NULL, and the reason the column is nullable rather than back-filled with whoever ran the review.
- **`by_user_id` is who set the CURRENT state, never who set the first.** A card reading "Verified by A. Trainee" for a finding a partner reverted and re-verified is the quiet lie §6.3 calls the most likely defect in the whole design.
- **A `cause = 'rerun_reset'` disposition reads as a re-run, never as a person un-verifying.** Two different acts; the history distinguishes them; the card must not flatten them.
- **A load path distinguishes four facts, and the fourth arrives here** (§3): *not yet known*, *broken*, *empty*, *stale*. None renders as any other. `describeLoadError` / `LoadErrorPanel` **gain** the state; they are not replaced. **A disconnected client must not offer to change a disposition** (§8).
- **Presence is never persisted, locks nothing, blocks nothing and gates no write** (S6). A stale presence row is a lie the app would tell indefinitely; the TTL is what stops it.
- **Every export carries the instant its dispositions were read, its changed-from facts, and a sentence saying a disposition can change** (§6.3.1). §19 calls the export *"the worst-consequence defect the revision introduces"*, because a card has a reader who can refresh and a printed DOCX does not.
- **`verificationLabel` and `exportSummaryLine` in `findingOutcome.ts` remain the only place export wording lives**, and `dispositionLabel` / `dispositionHistoryLine` go **beside** them in that file, never in a second module (§6.3).
- **A disposition change is recorded once, in `finding_disposition_event`, and is not also written to `audit_event`** (S22). The feed and the audit export read both, plus the `run` table, in one `UNION`.
- **`audit_event` is append-only by database grant** — `GRANT INSERT, SELECT` and nothing else, to any app role (S11). Not a convention.
- **`workspace_id uuid not null` on every new table, and every query scoped by it** (§6, S9). `workspaceScope.test.ts` enforces it and now walks the whole of `apps/api/src`, not only `routes/` (R-S3B8).
- **Every check happens in the API.** The web app hides what a role cannot do; the API refuses it. `ROUTE_POLICY` has no default and a route with no entry fails registration (§7).
- **Three roles, no per-matter ACLs, no custom roles, no deny rules** (S10). Overriding a disposition is **not** role-gated — see P31.
- **There is no development bypass and no configuration that disables authentication** (S29), and that includes the WebSocket: an unauthenticated socket is an authentication bypass with a different protocol. The socket authenticates *before* it is upgraded, and the absence of a bypass is mutation-tested.
- **The divergences between the two environments are §5.1's enumerated list and nothing else** (S30). Every new configuration key is added to `apps/api/test/divergence.json` in the same commit, or `configSurface.test.ts` fails — in both directions.
- **No module branches on the environment**, and no module outside each app's single typed configuration module reads `process.env` (§18 item 10a).
- **Colour lives in two layers and only the top one is a Tailwind utility.** No hex or `rgb()` in a `className`, no arbitrary colour value, no `--lex-*` reference, no generic Tailwind palette class. A role that does not exist yet is added to `src/index.css` in the same commit that first uses it. `SCAN_EXEMPT` is empty and stays empty (`src/test/palette.test.ts`).
- **A Tailwind class built by string interpolation produces no styling at all, silently.** Map each variant's complete class string in a `Record<Variant, string>` and index into it. Never build the tail of a class name from a variable.
- **When you find yourself writing a second copy of something, extract it then.** Not after the third (§19, S14).
- **Mutation-test anything load-bearing.** Break the implementation, confirm the **named** test fails, restore. A green suite is not evidence.
- **A task that claims to change only a mechanism must not need a copy test edited.** `git status --porcelain -- '*.test.ts' '*.test.tsx'` after such a task should show only the tests that task was for. If a wording assertion moved, that is the finding (R-G22).
- **Gates for every task:** `npm run typecheck` clean; `npm test` green **read from an exit code, never a summary line and never through a pipe**; `npm run build` clean with no externalization warning; `npm run test:pg` where the task touched SQL; `npm run test:compose` where the task touched the stack.
- **Commit at the end of every task, by pathspec — never `git add -A`** — then run `git show --stat HEAD` and read it. The verification, not the pathspec, is what catches a swept commit.

---

## Sixteen decisions this plan makes, and why

Numbered **P29–P44**, continuing Stage 3's P17–P28 in the same repository. Each is load-bearing across several tasks and carries its cost if wrong, in `rulings.md`'s format. Task 26 records them there.

**P29 — The seam is honesty first, transport second: Part 4A ships every attribution, history and export surface over Stage 3's poll; Part 4B replaces the transport and adds presence and assignment.**
§13 forbids sequencing the surfaces *after* the mutability. It cannot be read as forbidding sequencing them *before* it, and the shipped code forces that reading: change-by-others is already reachable by any second signed-in reviewer (`ROUTE_POLICY: 'reviewer'`, no actor comparison in `setDisposition`), so the honesty gap is open today. Building the socket first would make an unattributed "Verified" arrive faster.
*Cost if wrong:* one poll interval of latency on someone else's change for the length of Part 4A, on a stage that is not released until both parts land. Against that: the alternative is the exact ordering §13 names as the design's own quiet lie.

**P30 — `stage3DoD.test.ts`'s absence assertions are inverted task by task, in the task that makes each false, never deleted wholesale.**
Stage 3 asserts `dispositionLabel` does not exist, that no source contains "dispositions as at", and that no browser file carries a "was X" string. Those are not obsolete lines to sweep — they are the record of a deliberate boundary, and Stage 3's own report says a file that loses its guard when the guarded thing happens has stopped guarding. Each becomes a **positive** assertion in the task that lands the thing: Task 4 flips `dispositionLabel`, Task 9 flips "dispositions as at", Task 5 flips "was X". Anything still absent at Task 26 stays asserted absent.
*Cost if wrong:* four small edits across four tasks instead of one deletion. Deleting the file's guards in one commit would leave Stage 4 with no mechanical statement of what it had actually built, at the one place a reader looks for it.

**P31 — Overriding another person's disposition is not role-gated. Any authorised reviewer may change any disposition in any direction, and assignment is the escape hatch rather than a permission.**
The owner's sentence is *"Partner may override a verification"*, and S4 as rewritten on the owner's decision reads *"Any authorised user may change it in any direction at any time; nothing is locked by having been verified once."* The partner in the owner's sentence is **who typically does it**, not a restriction — and the trainee's half of the same sentence (*"they flag another for a partner and assign it"*) is served by assignment, which is a request rather than a disposition (§6.3). A role gate would also block the commonest correction of all, a reviewer fixing their own colleague's obvious slip, and S10 forbids per-matter ACLs and custom roles that such a gate would be the first instance of.
*Cost if wrong:* if a firm later wants override restricted to partners, that is one `ROUTE_POLICY` line plus one predicate — the same shape as `POST /v1/playbooks/:id/versions` already has — not a redesign. The opposite error is worse and quieter: a gate shipped now would make "why can I not correct this?" a support question with no answer in the UI, and a trainee would work around it by asking the partner to re-verify, which loses the history the gate was supposedly protecting.

**P32 — A workspace user directory ships, read-only, and it is the only place a user id becomes a name.**
§6.3 requires every disposition to be shown with its actor. The shipped API has exactly one id→name route, `GET /v1/me`, and it answers only for the caller. Without a directory the card can render *your own* name and nobody else's, which is precisely the single-user substrate §3.1 supersedes. One route, one browser-side cache, one resolver; a name is never taken from a payload, because a payload's `byUserId` is an id and an event that carried a display name would be a second copy of a mutable field.
*Cost if wrong:* one route, one small cache, and a directory that lists everyone in the workspace to everyone in the workspace — which is what a firm's address book already does, and which S10's "no per-matter ACLs" already implies. If a firm later needs a conflicts wall, the directory is scoped by `workspace_id` like everything else and gains the same predicate the matter queries would.

**P33 — `dispositionLabel` and `dispositionHistoryLine` are added to `src/lib/findingOutcome.ts`, beside `verificationLabel` and `exportSummaryLine`. `findingOutcome.ts` does NOT move to `packages/core` in this stage, and that deferral is recorded.**
§6.3 says the module is *"moving to `packages/core`"*. Every caller in Stage 4 is browser-side: `FindingCard`, the history panel, `exportDocx.ts` and `csv.ts`. Moving a module to `packages/core` so that no server file imports it is churn across four workspaces with no behaviour, on the one module whose whole value is that both exporters read the same strings — and P20 already left half of §5's inventory in `src/lib` with the same reasoning.
*Cost if wrong:* if a later stage builds a server-rendered export, the move is a Stage-0-shaped mechanical task and the S14 boundary already covers what has moved. Named in "Interfaces Stage 5 and later must honour" so it is a plan rather than an omission.

**P34 — Disposition attribution travels BESIDE the findings, never inside `Finding`.**
`FindingsPage` already carries `dispositionVersions` and `findingVersions` beside the map, for the reason its own docstring gives: an optimistic-concurrency token is a fact about one table's row, not about the answer to a clause, and `Finding` is the domain shape three programs share. `changedCount`, the actor, the instant and the most recent `finding_disposition_event` are facts about the same row and follow the same rule. `Finding.verification` keeps exactly the shape it has, so not one existing consumer changes.
*Cost if wrong:* one more map on the wire and one more lookup at the card. Against that: putting `changedCount` and a `fromState` on `Verification` would push a database-shaped field into the type `extractClause` returns, and the next person to write an extractor would have to decide what to put in it.

**P35 — A stale change is refused, named and re-offered. Never merged, never auto-retried, and the re-offer writes a second history row.**
This is §6.3's own answer to "what happens when two people change it at once", and every part of it is load-bearing. The refusal is shipped (`ConflictError` carrying the current row); Stage 4 adds the sentence with the winner's **name** and **instant**, and a control that submits the same change against the new version. Two people racing therefore produce **one change and one refusal**; a person who then repeats the change produces a **second history row**, so both intentions are on the record. Nothing merges the two states, and nothing retries on the person's behalf (P25).
*Cost if wrong:* a person whose change is refused has to click once more, having been told exactly what happened and by whom. The alternative — last-write-wins, or a silent auto-retry — overwrites a judgement the changer never saw, which is the defect S4's cost line describes.

**P36 — A push never silently replaces what a person is mid-decision on.**
`await-then-apply` says a reviewer never sees a state the store did not take; it does not say a reviewer may have the state under their hand swapped while they are deciding. A `finding.disposition_changed` arriving while a reject-reason modal is open, or while a disposition write is in flight for that same finding, is **held** and rendered as a notice on the card ("R. Okafor changed this to Rejected while you were writing") rather than applied under the open control; the control keeps the version it was opened against, so submitting it produces the ordinary visible refusal of P35 rather than an invisible overwrite. Every other push applies immediately.
*Cost if wrong:* one held update per open modal, resolved the moment the modal closes. Against that: a state that changes under a person's cursor is the network-era form of *"the reviewer must never see a state the store did not actually take"*, inverted — the store took it, and the reviewer never saw the state they were acting on.

**P37 — `audit_event` lands with its reader, insert-only by grant, partitioned monthly, and it does not restate a disposition change.**
Stage 2 deferred it because a log with a writer and no reader makes its own grant test vacuous; Stage 3 produced the first acts that belong in it and still did not build it (P23), writing the cost into the README instead. Stage 4 has the reader — the activity feed — so it lands here with `GRANT INSERT, SELECT` and nothing else, and the feed reads it in a `UNION` with `finding_disposition_event` and the `run` table (S22). It does **not** get a disposition row: two append-only records of one fact is this project's most repeated defect placed where a divergence would be least noticed and most damaging.
*Cost if wrong:* one `UNION` in two queries and an auditor who must be told there are two tables. Named in the README, exactly as P23's gap was.

**P38 — `CLAUDE.md`'s "Deliberate non-features" paragraph is edited in the tasks that make each affordance real, one clause at a time, and never in a single tidy-up commit.**
Stage 2 did exactly this for the precedent-storage promise (S24), and the reason is the same: a document that describes the app is a claim about the app, and a claim edited later than the code it describes is false in the interval. Three clauses become false in this stage, in three different tasks: `ActivityEntry.byYou` gaining an actor (Task 12), the header avatar showing only your own initials (Task 23, presence), and "no assign action" (Task 25). Two clauses stay true and stay written: no assignee chip and no "assigned to me" counter (Stage 5, S18), and no global search and no Report tab (R-G14, R-G11). Each edit says what became true and which stage made it so.
*Cost if wrong:* three small edits in three commits instead of one. If instead they are batched, `CLAUDE.md` spends the stage telling the next implementer that a thing they are about to build must not exist.

**P39 — The realtime hub is behind an interface; its fan-out reads the `event` outbox by cursor; `pg_notify` is a doorbell and never a delivery.**
§8 puts the hub behind an interface either way and leaves Redis to Spike 3. The outbox already exists, is already written in the same transaction as every row it describes, already carries a monotonic id, and its readers already keep a cursor — so a replica that reads it is not a second mechanism, it is the client's own protocol one hop earlier. `pg_notify` from the same transaction wakes a replica immediately; a replica that misses a notification catches up on its next timer tick, because **the durable record is the outbox and the notification carries nothing that matters**. Presence is the one thing not in the outbox (S6 forbids persisting it), so presence rides the notification payload itself — a `NOTIFY` stores nothing, which is why it does not violate S6.
*Cost if wrong:* one dedicated `pg.Client` per replica for `LISTEN`, a poll tick per replica as a floor, and a presence beat that can be lost and is corrected within one 10-second heartbeat. Against that: an in-process hub is silently wrong at more than one replica — which the shipped Bicep already permits — and a Redis dependency added before a test demanded it is a container to operate in every environment for a property Postgres already has.

**P40 — One outbox, one vocabulary. The five event types become nine; `run_id` becomes optional; `matter_id` gets populated; `readEvents` gains a subscription predicate. There is no second event table and no second protocol.**
§8's subscriptions are `matter:{id}` and `review:{id}`; the shipped reader filters on `run_id` and the shipped writer requires one. The table already allows all three to be null and already carries the review index. Widening it is four small changes; inventing a second stream for non-run events would be two implementations of one idea, a stage apart, which is P22's own reasoning turned round.
*Cost if wrong:* a `payload` union with nine members instead of five, and one `fromEventRow` switch to keep exhaustive. The closed-set refusal stays: a type that is not registered still throws, because an event nothing reads is a hole a client cannot see.

**P41 — Spike 3 is answered LOCALLY, at two replicas, because Azure is unreachable; and `api`'s `maxReplicas` in the Bicep is pinned to whatever the answer supports, with the reason in a comment.**
§15 frames Spike 3 as a Container Apps question. No Azure environment has been reachable for three stages. What the spike is *for* — does fan-out need to cross replicas — is fully answerable in compose, and §5.1 row 6 already requires `api` at two replicas locally for exactly this. So Task 14 runs it there, and Task 26 records that the Container Apps ingress half (scale-to-zero, idle timeouts, sticky sessions) is **unanswered**, alongside Spike 2's Azure half.
*Cost if wrong:* Container Apps may terminate an idle WebSocket at an ingress timeout this plan cannot measure, so Task 20's client must reconnect on any close rather than only on an error — which it must do anyway. The Bicep pin is one line and one comment, and un-pinning it later is a deployment decision with a test behind it rather than a default nobody chose.

**P42 — The `stale` load state disables the disposition controls, says why, and is entered on the first missed heartbeat rather than on the first failed frame.**
§8: *"a disconnected client must not offer to change a disposition"*, and §3 calls this the load state most likely to be skipped because the app looks fine without it. §19 calls it the defect this design is most likely to ship in the app. It is therefore a task of its own (Task 20) with its own mutation, rather than a paragraph inside the socket task.
*Cost if wrong:* a reviewer on a flaky connection sees the controls disabled for a few seconds more often than strictly necessary, with a sentence saying so. Against that: a client showing yesterday's findings because its socket dropped looks completely normal, and a change submitted against a version minutes old would be refused anyway.

**P43 — Two accounts are obtained headlessly through a SEPARATE Keycloak client with direct access grants. The application's own client is not touched.**
Stage 3 could make no request as a signed-in user because the realm sets `directAccessGrantsEnabled: false` and the only route to a token is the authorization-code flow. That refusal was right for the *app's* client: S29 says the shipped authentication path is the one that must be tested, and enabling password grants on it would let a test exercise a flow no browser uses. A second, test-only client changes nothing about the app's flow, mints tokens from the same realm with the same issuer, the same signing keys, the same group claims and the same expiries, and is what makes every collaborative assertion in this stage writable at all.
*Cost if wrong:* one client in a version-controlled realm file, present in the local stack only, and named in `divergence.json` as a row of §5.1's identity divergence — which is where a Keycloak-only object belongs. A test asserts the **app's** client still has `directAccessGrantsEnabled: false`, so the concession cannot spread to the thing it was carved out to protect.

**P44 — §18 item 5's clauses are reported in three categories — met by mechanism, met by rendered string, and unmet — and the unmet ones are named rather than implied away.**
Five of the six clauses have a visual subject and no browser is drivable. Reporting them as "met" on the strength of a passing unit test would be the same class of claim as a test that passes against unfixed code, which Stage 3's own report calls the worst kind this project has shipped. Reporting them as "unmet" wholesale would be equally dishonest, because the mechanism half *is* provable with two tokens and two sockets. So each clause gets a category and a piece of evidence.
*Cost if wrong:* a definition of done that reads longer and less triumphantly. That is the correct trade for a document a firm's reviewer will read.

---

## The definition of done, and the part of it no test can reach

§18 item 5, clause by clause, with the evidence each will actually have. **This table is the plan's promise about its own verification**, and Task 26 fills in the right-hand column with results rather than intentions.

| §18.5 clause | Category | The evidence, and its limit |
|---|---|---|
| Two people in one review see each other's **writes** without reloading | **Mechanism** | Task 21's compose test: two tokens, two sockets, user A writes a disposition over HTTP, user B's socket receives `finding.disposition_changed` carrying A's id, the new state and the new version, inside one second. What it does not prove: that B's *screen* repaints. |
| **A Partner overrides a trainee's verification and the trainee's open card immediately reads the Partner's name and time, without a reload** | **Mechanism + rendered string** | The push above, plus Task 5's `mount.tsx` test that feeds the same payload through `FindingCard` and asserts the exact rendered text, including the name resolved through the directory and the localised instant. What it does not prove: that "immediately" feels immediate, or that the transition is not jarring. |
| A change submitted against a stale version is **refused, shown what replaced it, and offered again** | **Mechanism + rendered string** | Task 7's two-account race over real HTTP (one applies, one gets `409` with the current row), plus a component test asserting the refusal sentence names the winner and the instant and that the re-offer control submits the new version. Fully provable without a browser. |
| **Every disposition on screen carries its actor and time, and a changed one says so** | **Rendered string** | Task 5's table-driven render over all eight disposition shapes — never-touched, verified-once, verified-after-rejection, rejected-with-reason, cleared by hand, cleared by re-run, changed twice, changed by someone else — asserting the exact string each produces, plus Task 13's scanner asserting no component renders a bare state chip without going through `dispositionLabel`. What it does not prove: that the line is *legible* where it sits. |
| An export carries its **"as at" instant** | **Fully provable, and it needs no browser at all** | Task 9 generates a real DOCX and a real CSV in a test and asserts over their bytes: the instant, the timezone, the changed-from facts, and the sentence saying a disposition can change. **This is §19's worst-consequence item and it is the one clause with no verification gap.** Say so in the report; it is the good news in an otherwise honest table. |
| A disconnected client **shows itself as stale, disables its disposition controls and resynchronises visibly** | **Rendered string, and one gap** | Task 20's component tests drive the socket client's `onStale` with a fake transport and assert the banner text, the `disabled` attribute on every control, and the "Reconnecting — refreshing this review" line during resync. What no test here reaches: that the banner is *noticed*. |
| An assignment **reaches the assignee** | **Mechanism + rendered string** | Task 25: A assigns to B over HTTP; B's socket receives `assignment.created`; B's inbox route returns it; a component test asserts the surface names the assigner and the message. What it does not prove: that B would notice without looking. |

**What only a human at a browser can confirm, listed once and not pretended away** — carried to Task 26 and to the README:

1. Two browser profiles, two seeded accounts, one review: the trainee's card visibly changing attribution when the partner overrides, with no reload.
2. Presence: seeing a colleague appear, seeing them on a specific clause, and seeing them go within the TTL after they close the tab.
3. The stale banner appearing when the network is cut, the controls going dead, and the recovery reading as a recovery rather than as a failure.
4. Whether a live update arriving mid-scroll is disruptive.
5. The deployed two-account pass (§18 item 9) and Entra's group-claim shape, including overage (§5.1's "what local does not prove").
6. Container Apps ingress behaviour for a long-lived WebSocket (Spike 3's unanswered half).

---

## Declared surfaces, caps and timeouts

Every tier that can silently cap, drop or time out a live connection. **Task 26 asserts each name below has a reader in the shipped source**, and names the ones that do not — the same check `caps.test.ts` already performs for the queue's tiers, extended rather than duplicated. Three undeclared-cap defects have already been found in this repository and every one read as correct code.

| Tier | Name | Value | Declared in | What happens at the cap |
|---|---|---|---|---|
| Presence heartbeat | `API_PRESENCE_HEARTBEAT_MS` | 10 000 ms (§8) | `apps/api/src/config.ts` (**new**) | the client sends a beat; missing one starts the TTL running |
| Presence TTL | `API_PRESENCE_TTL_MS` | 15 000 ms (§8) | `apps/api/src/config.ts` (**new**) | the roster drops the person and broadcasts the change |
| Socket idle / server ping | `API_WS_PING_MS` | 25 000 ms | `apps/api/src/config.ts` (**new**) | a ping keeps the proxy hop alive; two unanswered pings close the socket |
| Client stale threshold | `WS_STALE_AFTER_MS` | 2 × `API_WS_PING_MS` | `src/lib/api/socket.ts` (**new**, derived) | the client enters `stale`, disables disposition controls, says why |
| Client reconnect backoff | `WS_RECONNECT_BASE_MS` / `WS_RECONNECT_MAX_MS` | 500 ms / 15 000 ms, full jitter | `src/lib/api/socket.ts` (**new**) | reconnection attempts space out; the banner stays up throughout |
| Replay page | `API_EVENT_PAGE_MAX` | 500 (shipped) | `apps/api/src/config.ts` | the replay is paged; `caught_up` is sent only after the last page |
| Outbox retention | `API_EVENT_RETENTION_DAYS` | 7 (shipped, §6.5) | `apps/api/src/config.ts` | a cursor past it gets `resync_required`, which the UI now renders |
| Hub fan-out tick | `API_HUB_TICK_MS` | 1 000 ms | `apps/api/src/config.ts` (**new**) | the floor beneath `pg_notify`; a missed doorbell costs one tick |
| Sockets per replica | `API_WS_MAX_CONNECTIONS` | 500 | `apps/api/src/config.ts` (**new**) | a further upgrade is refused **with a sentence**, never dropped silently |
| Subscriptions per socket | `API_WS_MAX_SUBSCRIPTIONS` | 16 | `apps/api/src/config.ts` (**new**) | the subscribe frame is refused, naming the cap |
| Inbound frame size | `API_WS_MAX_FRAME_BYTES` | 16 KiB | `apps/api/src/config.ts` (**new**) | the socket is closed with a code and a reason |
| nginx proxy read timeout on the socket | `proxy_read_timeout` | 3600 s on the socket location | `infra/nginx/web.conf` | below `API_WS_PING_MS` it would kill every idle socket; that is why it is declared |
| `api` replicas (Azure) | `maxReplicas` | pinned by Task 14 | `infra/modules/containerApps.bicep` | above what the fan-out supports, a client on one replica misses another's writes |

**Every new key above is `sameEverywhere` and is added to `apps/api/test/divergence.json` in the commit that introduces it, or `configSurface.test.ts` fails** — in both directions, which is the half that catches a row with no key behind it. The nginx socket location and the Keycloak test client are **row 1 and row 9** divergences and are tabled as such, not as new rows: §5.1 says a tenth row is added to the table first and to the code second.

---

## File Structure

```
packages/core/
  src/api/records.ts                 MODIFY  the event vocabulary (5 -> 9), the socket frames,
                                             DispositionsPage, PresenceMember, AssignmentView (T15, T16, T22, T24)
  src/api/socket.ts                     NEW  the client<->server frame union, shared by both sides (T16)
  src/index.ts                       MODIFY  every new export named here or S14 cannot see it

apps/api/
  migrations/011_audit_event.sql        NEW  audit_event, insert-only grants, monthly partitions (T11)
  migrations/012_assignment.sql         NEW  assignment, its grants, its indexes (T24)
  src/config.ts                      MODIFY  the new caps, in this file ONLY
  src/routes/users.ts                   NEW  GET /v1/workspace/users — the ONE id->name route (T2)
  src/routes/findings.ts             MODIFY  the findings read carries dispositions + last event (T3);
                                             the history route gains its first reader's shape (T6)
  src/routes/history.ts                 NEW  GET /v1/reviews/:id/history — the review's full history (T10)
  src/routes/activity.ts                NEW  GET /v1/matters/:id/activity — the UNION feed (T12)
  src/routes/assignments.ts             NEW  create, resolve, and the assignee's inbox (T24)
  src/audit/write.ts                    NEW  appendAudit — the ONE writer of audit_event (T11)
  src/audit/actions.ts                  NEW  the closed set of action strings (T11)
  src/run/events.ts                  MODIFY  runId optional, matterId populated, subscription predicate (T15)
  src/realtime/hub.ts                   NEW  the Hub interface + subscribe/publish; no transport in it (T16)
  src/realtime/socket.ts                NEW  the WebSocket route, auth-before-upgrade, replay, caught_up (T16)
  src/realtime/feed.ts                  NEW  outbox-by-cursor fan-out + pg_notify doorbell (T18)
  src/realtime/presence.ts              NEW  roster, TTL, never persisted (T22)
  src/main.ts                        MODIFY  start the hub, the feed and the presence reaper
  src/server.ts                      MODIFY  register the new route groups and the socket
  src/auth/routeTable.ts             MODIFY  one line per new route, including the socket
  test/helpers/twoAccounts.ts           NEW  two real tokens from the test client (T1)
  test/helpers/wsClient.ts              NEW  a Node socket client for the compose tests (T16)
  test/twoAccounts.compose.test.ts      NEW  T1: the unattributed-override gap, demonstrated
  test/users.pg.test.ts                 NEW  T2
  test/findingsRead.pg.test.ts       MODIFY  T3: dispositions and the last event, absent-key rules
  test/dispositionRace.pg.test.ts       NEW  T7: two genuine writers, one applies, one refused
  test/historyExport.test.ts            NEW  T10
  test/auditEvent.pg.test.ts            NEW  T11: the insert-only grant, both mutations
  test/activity.pg.test.ts              NEW  T12
  test/stage4aDoD.test.ts               NEW  T13: the part gate, and what is guarded from arriving early
  test/replicaFanout.compose.test.ts    NEW  T14/T18: a write on one replica, a socket on the other
  test/socket.pg.test.ts                NEW  T16: subscribe, replay, caught_up, resync_required
  test/socketAuth.test.ts               NEW  T16: no bypass, mutation-tested
  test/wsProxy.compose.test.ts          NEW  T17: the handshake through nginx
  test/presence.compose.test.ts         NEW  T22: TTL, roster, never persisted
  test/assignments.pg.test.ts           NEW  T24
  test/stage4DoD.test.ts                NEW  T26
  test/caps.test.ts                  MODIFY  the new tiers
  test/configSurface.test.ts         MODIFY  the new keys, both directions
  test/divergence.json               MODIFY  the new keys; the socket location; the test client
  test/authz.route.test.ts           MODIFY  one entry per new route AND the socket
  package.json                       MODIFY  @fastify/websocket

apps/gateway/                                UNCHANGED. No new purpose, no new route, no new key.

infra/
  keycloak/<realm>.json              MODIFY  a test-only client with direct access grants (T1)
  nginx/web.conf                     MODIFY  the socket location and its upgrade headers (T17)
  modules/containerApps.bicep        MODIFY  api maxReplicas, pinned with its reason (T14)
docker-compose.yml                   MODIFY  api at two replicas behind the proxy (T14)

src/
  lib/api/users.ts                      NEW  the directory client and its cache — the ONE resolver (T2)
  lib/api/findings.ts                MODIFY  read and remember the dispositions map (T3)
  lib/api/socket.ts                     NEW  one connection per tab, multiplexed, backoff, stale (T19, T20)
  lib/api/runs.ts                    MODIFY  watchRun keeps its signature; its transport changes (T19)
  lib/api/assignments.ts                NEW  T24
  lib/findingOutcome.ts              MODIFY  dispositionLabel, dispositionHistoryLine (T4)
  lib/loadError.ts                   MODIFY  the fourth state (T20)
  lib/matterActivity.ts              MODIFY  ActivityEntry gains an actor; byYou is derived from it (T12)
  components/LoadErrorPanel.tsx      MODIFY  the stale branch (T20)
  components/StalePanel.tsx             NEW  the persistent, non-modal stale indicator (T20)
  components/PresenceRoster.tsx         NEW  who else is here (T23)
  features/review/FindingCard.tsx    MODIFY  actor, time, "was X", "changed N times" (T5)
  features/review/DispositionHistory.tsx NEW  the reachable history panel (T6)
  features/review/ConflictNotice.tsx    NEW  the refusal that names the winner and re-offers (T7)
  features/review/VerificationControls.tsx MODIFY  disabled while stale, with a reason (T20)
  features/review/exportDocx.ts      MODIFY  the "as at" block and the changed-from facts (T9)
  features/tabular/csv.ts            MODIFY  the same, through the same functions (T9)
  features/matters/MatterActivity.tsx MODIFY  actors (T12)
  features/assignments/AssignPanel.tsx  NEW  ask a colleague to look (T25)
  App.tsx                            MODIFY  T3, T5, T7, T8, T19, T20, T21, T23, T25
  index.css                          MODIFY  the presence and stale colour roles, in the commit that uses them

CLAUDE.md                            MODIFY  T12, T23, T25 — one clause each, in the task that makes it true
README.md                            MODIFY  T26
docs/superpowers/redesign/rulings.md MODIFY  T26
```

---

# PART 4A — the record is honest, one poll interval behind

---

## Task 1: Two accounts, headlessly — and the unattributed override, demonstrated

**Type:** test infrastructure, plus a finding this whole part exists to answer

**Files:**
- Modify: the Keycloak realm import under `infra/keycloak/` (**find the file; do not assume its name**)
- Create: `apps/api/test/helpers/twoAccounts.ts`
- Create: `apps/api/test/twoAccounts.compose.test.ts`
- Modify: `apps/api/test/keycloakRealm.test.ts`, `apps/api/test/divergence.json`
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/task-1-report.md`

**Interfaces:**
- Consumes: the seeded realm's users and its app client; `apps/api/test/helpers/pgHarness.ts` (`withPg`, `appDb`, `dbOn`); the shipped `PUT /v1/reviews/:id/findings/:findingsKey/:clauseId/disposition`. **Read `infra/keycloak/`'s realm file, `apps/api/test/keycloakRealm.test.ts` and `docker-compose.yml`'s `keycloak` service before writing a line. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // apps/api/test/helpers/twoAccounts.ts
  export interface TestAccount { username: string; role: 'reviewer' | 'partner' | 'admin';
                                 token: string; userId: string; displayName: string }
  export async function signIn(username: string): Promise<TestAccount>;
  export async function twoAccounts(): Promise<{ trainee: TestAccount; partner: TestAccount }>;
  export const API_BASE: string;   // http://localhost:3005/api — through the proxy, never at api directly
  ```

**Why this is Task 1.** Every collaborative assertion in this stage needs two tokens, and the repository cannot produce one. Stage 3's report says it plainly: *"No request has been made over HTTP as a signed-in user. The shipped realm has `directAccessGrantsEnabled: false`."* Until this exists, Part 4A's whole premise — that a second person can already overwrite a first person's judgement anonymously — is an argument rather than a demonstration.

- [ ] **Step 1: Add a test-only Keycloak client, and protect the app's client from the concession (P43)**

In the realm import, beside the existing app client, add a **second** client — `lexprompt-test` — with `directAccessGrantsEnabled: true`, `publicClient: true`, `standardFlowEnabled: false`, and the same protocol mappers for the subject claim and the groups claim as the app client carries. Copy the mappers; do not invent them, and do not assume their names — read them out of the shipped realm file, because a token whose `groups` claim has a different name maps to no role and the API answers 403 with a message about groups that reads like a bug in the role table.

Then make the concession un-spreadable:

```ts
// apps/api/test/keycloakRealm.test.ts — added to the shipped suite.
it('leaves the application client with no direct access grants (S29)', () => {
  const app = clientNamed(realm, APP_CLIENT_ID);   // read APP_CLIENT_ID from the shipped config
  expect(app.directAccessGrantsEnabled).toBe(false);
  expect(app.standardFlowEnabled).toBe(true);
  // The sanity check, or the two assertions above pass against a realm with
  // no clients at all — which is exactly the shape of a guard that scans
  // nothing. Stage 3 shipped seven of those.
  expect(realm.clients.length).toBeGreaterThan(1);
});

it('confines the password grant to the test client, which the app never uses', () => {
  const test = clientNamed(realm, 'lexprompt-test');
  expect(test.directAccessGrantsEnabled).toBe(true);
  expect(test.standardFlowEnabled).toBe(false);
  // And nothing under src/ or apps/*/src names it. A test client that the
  // shipped application can reach is not a test client.
  expect(grepRepo('lexprompt-test', { under: ['src', 'apps/api/src', 'apps/gateway/src'] })).toEqual([]);
  expect(grepRepo('lexprompt-test', { under: ['apps/api/test'] }).length).toBeGreaterThan(0);  // sanity
});
```

- [ ] **Step 2: Write `signIn`, and make its failure legible**

```ts
// apps/api/test/helpers/twoAccounts.ts
const TOKEN_URL = `${KEYCLOAK_BASE}/realms/${REALM}/protocol/openid-connect/token`;

export async function signIn(username: string): Promise<TestAccount> {
  const body = new URLSearchParams({
    grant_type: 'password', client_id: 'lexprompt-test',
    username, password: PASSWORD_FOR[username],
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) {
    // NOT `throw new Error(res.statusText)`. A 400 here means one of five
    // things and they are not interchangeable: the realm did not import,
    // the client is missing, direct grants are off, the user does not
    // exist, or the password in this file and the password in the realm
    // have drifted. The body says which; a status line does not.
    throw new Error(
      `Could not sign in as ${username} against ${TOKEN_URL}: ${res.status} ${await res.text()}`);
  }
  const { access_token } = await res.json() as { access_token: string };
  // The API's OWN view of who this is — provisioned on first sight by the
  // shipped actor resolver, so the id is the `app_user.id` every disposition
  // will carry, not a Keycloak subject.
  const me = await fetch(`${API_BASE}/v1/me`, {
    headers: { authorization: `Bearer ${access_token}` } });
  if (!me.ok) throw new Error(`Signed in as ${username} but /v1/me answered ${me.status}: ${await me.text()}`);
  const { id, displayName, role } = await me.json() as { id: string; displayName: string; role: TestAccount['role'] };
  return { username, role, token: access_token, userId: id, displayName };
}
```

**Two things the implementer must check rather than assume**: that `KEYCLOAK_BASE` is the address `api` demands in `iss` (Stage 2's own C1 correction — the local issuer has two addresses and only one is the issuer string), and that `API_BASE` goes through the **proxy** on `localhost:3005/api`, because `api` publishes no host port by construction.

- [ ] **Step 3: Demonstrate the gap. This is the task's real output**

```ts
// apps/api/test/twoAccounts.compose.test.ts
it('lets a second person overwrite the first person s verification, and says nothing about who', async () => {
  const { trainee, partner } = await twoAccounts();
  const { reviewId, findingsKey, clauseId } = await seedOneDoneFinding(trainee);

  const first = await put(trainee, `/v1/reviews/${reviewId}/findings/${findingsKey}/${clauseId}/disposition`,
    { state: 'verified', version: 1 });
  expect(first.status).toBe(200);

  const override = await put(partner, `/v1/reviews/${reviewId}/findings/${findingsKey}/${clauseId}/disposition`,
    { state: 'rejected', reason: 'The cap is uncapped in clause 14.2.', version: 2 });
  // IT SUCCEEDS TODAY. Nothing compares actors; the route is `reviewer`.
  expect(override.status).toBe(200);
  const body = await override.json();
  expect(body.disposition.byUserId).toBe(partner.userId);

  // AND THE GAP: the findings read the browser actually renders from carries
  // the id and nothing that could become a name, and no `changedCount`.
  const page = await get(trainee, `/v1/reviews/${reviewId}/findings`);
  const verification = page.findings[findingsKey][clauseId].verification;
  expect(verification.state).toBe('rejected');
  expect(verification.byUserId).toBe(partner.userId);
  // The three assertions this stage exists to invert. Each names the task
  // that inverts it, so a reader of a red test knows where it goes.
  expect('changedCount' in verification).toBe(false);            // -> Task 3
  expect(page.dispositions).toBeUndefined();                      // -> Task 3
  expect(await routeExists(trainee, '/v1/workspace/users')).toBe(false);  // -> Task 2
});
```

- [ ] **Step 4: Run it against the live stack, and clean up after yourself**

`npm run compose:up`, then `npm run test:compose` for this file alone. Record in the report: whether both tokens were obtained, both users' `app_user` ids, and the review the test seeded — **and delete that review and its findings at teardown** (rule 7: `test:pg` and `test:compose` share one database and a suite that leaves state behind breaks a different file with a message pointing at the wrong feature).

- [ ] **Step 5: Report the finding, not just the fixture**

The report says, in one paragraph a non-implementer can read: two seeded accounts, one review, one clause; the trainee verified it; the partner rejected it; the API accepted both; and the data a card renders from names neither person and cannot say that anything changed. That paragraph is Part 4A's justification and Task 26 quotes it.

- [ ] **Step 6: Commit**

```bash
git add infra/keycloak apps/api/test/helpers/twoAccounts.ts \
  apps/api/test/twoAccounts.compose.test.ts apps/api/test/keycloakRealm.test.ts \
  apps/api/test/divergence.json \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/task-1-report.md
git commit -m "test: two real accounts, and the unattributed override they demonstrate"
git show --stat HEAD
```

---

## Task 2: The workspace user directory — the one place an id becomes a name

**Type:** feature

**Files:**
- Create: `apps/api/src/routes/users.ts`, `apps/api/test/users.pg.test.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/test/authz.route.test.ts`
- Create: `src/lib/api/users.ts`, `src/lib/api/users.test.ts`
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Actor` (`apps/api/src/auth/actor.ts`), `Db` (`apps/api/src/db/pool.ts`), `apiGet` (`src/lib/api/client.ts`), `MeResponse` (`packages/core/src/api/records.ts`). **Read all four. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // packages/core/src/api/records.ts
  export interface WorkspaceUser {
    id: string; displayName: string; initials: string;
    role: Role; status: 'active' | 'disabled';
    /** Absent when the directory holds none. Never an empty string. */
    email?: string;
  }
  export interface WorkspaceUsers { users: WorkspaceUser[] }

  // src/lib/api/users.ts
  export async function loadDirectory(): Promise<void>;         // once per session, awaited before first render of a card
  export function userName(id: string | undefined): string | undefined;
  export function userInitials(id: string | undefined): string | undefined;
  export function forgetDirectory(): void;                      // tests only
  ```

**Why a directory and not a name on the payload (P32).** A `byUserId` on a `finding_disposition` is a foreign key; a display name is a mutable field on `app_user` that a person can change through `PUT /v1/me`. Putting the name into every disposition payload and every event would be a second copy of a mutable field, refreshed at different times in different places — this project's most repeated defect, on the field a reader trusts most.

- [ ] **Step 1: Write the failing test, including the two refusals**

```ts
// apps/api/test/users.pg.test.ts
it('lists the workspace s users, and nobody else s', async () => {
  const users = await readUsers(db, WORKSPACE_A);
  expect(users.map(u => u.id).sort()).toEqual([userA, userB].sort());
  expect(users.some(u => u.id === userInWorkspaceB)).toBe(false);
});

it('returns no email when the record has none, rather than an empty string', async () => {
  const u = (await readUsers(db, WORKSPACE_A)).find(x => x.id === userWithNoEmail)!;
  // `toEqual` cannot tell absent from undefined, and structuredClone keeps an
  // undefined-valued key — so absence is asserted with `in`.
  expect('email' in u).toBe(false);
});

it('lists a disabled user rather than hiding them', async () => {
  // A person who has left the firm still verified things last March, and a
  // card that renders "Verified by (unknown)" for them is worse than one
  // that names them and says the account is disabled. Hiding the row is how
  // history loses a name.
  const u = (await readUsers(db, WORKSPACE_A)).find(x => x.id === disabledUser)!;
  expect(u.status).toBe('disabled');
});
```

- [ ] **Step 2: Run it and watch it fail**

`npm run test:pg -- users.pg` — expect `readUsers is not a function`.

- [ ] **Step 3: The route, and its `ROUTE_POLICY` line**

```ts
// apps/api/src/routes/users.ts
export function registerUsers(app: FastifyInstance, db: Db): void {
  /**
   * The workspace's people (§6.3, P32).
   *
   * The ONE place a user id becomes a name. A display name is a mutable
   * field on `app_user`; carrying it on every disposition and every event
   * would be a second copy of it, refreshed at different times in different
   * places. Cards, the history panel, the activity feed, the refusal notice
   * and the assignment surface all resolve through this.
   *
   * `reviewer`, because a reviewer who cannot resolve the name on a
   * disposition they are shown cannot read their own screen — and S10 has
   * no per-matter ACLs for a directory to respect.
   */
  app.get('/v1/workspace/users', async (req): Promise<WorkspaceUsers> => ({
    users: await readUsers(db, req.actor!.workspaceId),
  }));
}

export async function readUsers(db: Db, workspaceId: string): Promise<WorkspaceUser[]> {
  // ONE literal, not two concatenated: `workspaceScope.test.ts` reads string
  // literals out of the source and checks each one's predicate region, and a
  // statement split across a `+` is reported as an unscoped read.
  const rows = await db.query<{
    id: string; display_name: string; initials: string; role: Role;
    status: 'active' | 'disabled'; email: string | null;
  }>(
    `select id::text as id, display_name, initials, role, status, email from app_user
      where workspace_id = $1 order by display_name, id`, [workspaceId]);
  return rows.map(r => ({
    id: r.id, displayName: r.display_name, initials: r.initials, role: r.role, status: r.status,
    ...(r.email ? { email: r.email } : {}),
  }));
}
```

Add to `ROUTE_POLICY`, with the comment that explains the bar:

```ts
  // §6.3's attribution requirement needs a name for an id, and `GET /v1/me`
  // answers only for the caller. `reviewer`: a person who cannot resolve the
  // name on a disposition they are shown cannot read their own screen.
  'GET /v1/workspace/users': 'reviewer',
```

- [ ] **Step 4: The browser's resolver, and what it does with an id it does not know**

```ts
// src/lib/api/users.ts
let byId: Map<string, WorkspaceUser> | null = null;

/** Loaded once per session, and re-loaded on a 401-driven sign-in. A
 *  directory that refreshes per card would be a request per row. */
export async function loadDirectory(): Promise<void> {
  const { users } = await apiGet<WorkspaceUsers>('/v1/workspace/users');
  byId = new Map(users.map(u => [u.id, u]));
}

/**
 * `undefined` for an id the directory does not hold — NEVER a fabricated
 * label and never the raw id.
 *
 * `matterActivity`'s R-GP5 already ruled this once for the local profile:
 * *"an entry whose author matches nothing known is rendered with NO actor
 * rather than an invented one"*. The same rule, one layer up: a caller that
 * gets `undefined` renders "changed by someone no longer in this workspace"
 * — a true sentence — rather than a raw uuid, which says nothing to a reader
 * while looking like it should.
 */
export function userName(id: string | undefined): string | undefined {
  return id === undefined ? undefined : byId?.get(id)?.displayName;
}
```

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm test
git add apps/api/src/routes/users.ts apps/api/src/server.ts apps/api/src/auth/routeTable.ts \
  apps/api/test/users.pg.test.ts apps/api/test/authz.route.test.ts \
  packages/core/src/api/records.ts packages/core/src/index.ts \
  src/lib/api/users.ts src/lib/api/users.test.ts
git commit -m "feat: the workspace user directory, the one place an id becomes a name"
git show --stat HEAD
```

---

## Task 3: The findings read carries the disposition and the event that produced it

**Type:** feature. The wire shape everything in Part 4A renders from.

**Files:**
- Modify: `apps/api/src/findings/read.ts`, `apps/api/test/findingsRead.pg.test.ts`
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `src/lib/api/findings.ts`, `src/App.tsx`

**Interfaces:**
- Consumes: `SELECT_FINDINGS`, `AssembledRow`, `verificationOf`, `assemble` in `apps/api/src/findings/read.ts`; `DispositionView` / `DispositionEventView` / `FindingsPage` in `packages/core/src/api/records.ts`; `rememberDispositionVersion` / `dispositionVersionFor` in `src/lib/api/findings.ts`. **Read every one. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  // packages/core/src/api/records.ts — added to FindingsPage
  export interface DispositionWithHistory {
    disposition: DispositionView;
    /** The most recent finding_disposition_event, ABSENT when changedCount
     *  is 0 — a finding nobody has touched has no event, and an empty object
     *  would read to an `in` check as an event that happened. */
    last?: DispositionEventView;
  }
  export interface FindingsPage {
    findings: Record<string, Record<string, Finding>>;
    /** findingsKey -> clauseId -> the disposition and the event that produced it. */
    dispositions: Record<string, Record<string, DispositionWithHistory>>;
    dispositionVersions: Record<string, Record<string, number>>;
    findingVersions: Record<string, Record<string, number>>;
    version: number;
  }
  ```

**Why the last event travels with the read.** §8, verbatim: *"the finding read returns its current disposition **and its most recent `finding_disposition_event`**, and `finding.disposition_changed` carries both, so `from_state` is on hand at first render and after every push without a second query and without a duplicated column."* The shipped read returns neither, which is the gap Task 1 demonstrates. Without it, the card's *"was Rejected"* would need a request per clause, and a card that fires sixty requests to render sixty rows will have that loop removed by whoever profiles it next, taking the sentence with it.

- [ ] **Step 1: The failing tests, and the absent-key rules restated on the assembled object**

```ts
// apps/api/test/findingsRead.pg.test.ts
it('carries the disposition and the event that produced it', async () => {
  const page = await readFindings(db, reviewId, WORKSPACE);
  const d = page.dispositions['d1']['c1'];
  expect(d.disposition.state).toBe('rejected');
  expect(d.disposition.changedCount).toBe(2);
  expect(d.last!.fromState).toBe('verified');       // "was Verified" needs no second query
  expect(d.last!.cause).toBe('human');
  expect(d.last!.byUserId).toBe(partnerId);
});

it('gives a never-touched finding a disposition with no actor and NO last event', async () => {
  const d = (await readFindings(db, reviewId, WORKSPACE)).dispositions['d1']['c2'];
  expect(d.disposition.changedCount).toBe(0);
  expect('byUserId' in d.disposition).toBe(false);
  expect('at' in d.disposition).toBe(false);
  expect('last' in d).toBe(false);                  // absent, not {} and not null
});

it('marks a disposition cleared by a re-run as a re-run, not as a person un-verifying', async () => {
  const d = (await readFindings(db, reviewId, WORKSPACE)).dispositions['d1']['c3'];
  expect(d.disposition.state).toBe('unchecked');
  expect(d.disposition.changedCount).toBeGreaterThan(0);   // touched, unlike c2 above
  expect(d.last!.cause).toBe('rerun_reset');
  expect(d.last!.fromState).toBe('verified');
});

it('keys a collection review s dispositions by the COLLECTION, not by a document', async () => {
  const page = await readFindings(db, collectionReviewId, WORKSPACE);
  expect(Object.keys(page.dispositions)).toEqual(['col-1']);
});

it('reads one statement per review, not one per finding', async () => {
  const spy = countingQueries(db);
  await readFindings(spy.db, reviewId, WORKSPACE);
  // Three: the review's version, the findings join, the latest-events join.
  // The mutation this exists for: rewrite the events lookup as a per-finding
  // query and watch this fail. Sixty clauses is sixty round trips, and it is
  // the shape that gets deleted later along with the sentence it fed.
  expect(spy.count).toBeLessThanOrEqual(3);
});
```

- [ ] **Step 2: Run them and watch them fail**

`npm run test:pg -- findingsRead` — expect `Cannot read properties of undefined (reading 'd1')`.

- [ ] **Step 3: One statement for the latest event per finding**

`distinct on`, which is Postgres's own answer and is index-friendly against the primary key ordering. Written as one literal for `workspaceScope.test.ts`'s benefit:

```ts
const SELECT_LATEST_EVENTS = `
  select distinct on (e.review_id, e.findings_key, e.clause_id)
         e.review_id, e.findings_key, e.clause_id, e.id, e.from_state, e.to_state,
         e.reason, e.cause, e.by_user_id::text as by_user_id, e.at
    from finding_disposition_event e
   where e.review_id = any($1::text[]) and e.workspace_id = $2
   order by e.review_id, e.findings_key, e.clause_id, e.id desc`;
```

**The `order by` prefix must match the `distinct on` tuple exactly, in that order, before `e.id desc`** — Postgres refuses otherwise, and the refusal is a parse error rather than a wrong answer, which is the good case. Run it against the real database before believing it.

Assemble `dispositions` alongside the existing `dispositionVersions`, from the rows the existing join already returns, and add `last` only where `changedCount > 0`:

```ts
// The disposition VIEW is built from the row the findings join already
// carries — not from a second read — so the version in `dispositions` and
// the version in `dispositionVersions` are the same number by construction.
// Two reads could disagree, and this is the number a stale-change refusal
// turns on (§8: "they must not be allowed to become two numbers").
```

- [ ] **Step 4: `verificationOf` does not change, and that is the point**

`Finding.verification` keeps the shape it has (P34). Add a test that says so, because the natural mistake here is to enrich it:

```ts
it('leaves Finding.verification exactly as it was — attribution rides beside, not inside', async () => {
  const v = (await readFindings(db, reviewId, WORKSPACE)).findings['d1']['c1'].verification;
  expect(Object.keys(v).sort()).toEqual(['at', 'byUserId', 'reason', 'state']);
  expect('changedCount' in v).toBe(false);
  expect('fromState' in v).toBe(false);
});
```

- [ ] **Step 5: The browser remembers the dispositions beside the versions**

`src/lib/api/findings.ts` already caches `dispositionVersions` per review through `remember`. Extend the same cache — not a second one — with the `DispositionWithHistory` map, and expose `dispositionFor(reviewId, findingsKey, clauseId)`. `App.tsx`'s `refreshFindings` stores it on the same state transition it already performs; **no new fetch and no new effect.**

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm test
git add apps/api/src/findings/read.ts apps/api/test/findingsRead.pg.test.ts \
  packages/core/src/api/records.ts packages/core/src/index.ts \
  src/lib/api/findings.ts src/lib/api/findings.test.ts src/App.tsx
git commit -m "feat: the findings read carries the disposition and the event that produced it"
git show --stat HEAD
```

---

## Task 4: `dispositionLabel` and `dispositionHistoryLine` — the wording, in the one place wording lives

**Type:** feature (pure functions, with their first callers arriving in Task 5)

**Files:**
- Modify: `src/lib/findingOutcome.ts`, `src/lib/findingOutcome.test.ts`
- Modify: `apps/api/test/stage3DoD.test.ts` (**invert, do not delete** — P30)

**Interfaces:**
- Consumes: `DispositionView`, `DispositionEventView`, `DispositionWithHistory` (Task 3); `userName` (Task 2). **Read `src/lib/findingOutcome.ts` in full first** — `verificationLabel`, `exportSummaryLine`, `netPositionLabel`, `positionOutcomeLabel` and `truncationLabel` are its established shape and the new functions must match it: pure, `null` for "no label", never throwing on a missing input.
- Produces:
  ```ts
  export interface DispositionAudience {
    /** Resolves a user id to a name, or `undefined` for one the directory does
     *  not hold. `userName` from src/lib/api/users.ts in the app; a fixture in
     *  tests. Passed in rather than imported so this module stays pure and the
     *  DOCX/CSV exporters can render a name without importing a network cache. */
    nameOf: (id: string | undefined) => string | undefined;
    /** Epoch ms -> a human instant. Injected for the same reason, and because
     *  a test that asserts a formatted time must not depend on the runner's
     *  timezone. */
    timeOf: (at: number) => string;
  }
  export function dispositionLabel(d: DispositionWithHistory | undefined,
                                   a: DispositionAudience): string;
  export function dispositionHistoryLine(e: DispositionEventView,
                                         a: DispositionAudience): string;
  ```

**Why both live here.** `findingOutcome.ts` is `CLAUDE.md`'s named home for export wording, and the reason is on the record: *"the DOCX and CSV exporters have drifted apart on this once before"*. The card, the history panel, the refusal notice, the DOCX and the CSV all render a disposition in Stage 4. Five callers is four more than it takes for two copies to appear.

- [ ] **Step 1: The eight shapes, as a table-driven test, written before the implementation**

These eight are the *complete* set of things a disposition can be, and every later task's rendering test reuses this table. Write it as an exported fixture (`DISPOSITION_SHAPES` in `src/lib/findingOutcome.test.ts` or a small fixture module) so Tasks 5, 6, 9 and 13 index into it rather than re-inventing it.

```ts
const nameOf = (id?: string) => ({ u1: 'A. Trainee', u2: 'R. Okafor' } as Record<string, string>)[id ?? ''];
const timeOf = (at: number) => new Date(at).toISOString().slice(11, 16);   // '16:04', timezone-free
const A = { nameOf, timeOf };

it.each([
  ['never touched',        shape0, 'Not checked'],
  ['verified once',        shape1, 'Verified by A. Trainee, 16:04'],
  ['verified after a rejection', shape2, 'Verified by R. Okafor, 16:04 - was Rejected'],
  ['rejected with a reason',     shape3, 'Rejected by R. Okafor, 16:04 - was Verified'],
  ['flagged',              shape4, 'Flagged by A. Trainee, 16:04 - was Unverified'],
  ['cleared by hand',      shape5, 'Unverified - cleared by A. Trainee, 16:04, was Verified'],
  ['cleared by a re-run',  shape6, 'Unverified - this clause was re-run by A. Trainee at 16:04, was Verified'],
  ['changed three times',  shape7, 'Verified by R. Okafor, 16:04 - was Rejected - changed 3 times'],
])('labels a disposition that was %s', (_what, shape, expected) => {
  expect(dispositionLabel(shape, A)).toBe(expected);
});

it('names nobody for an actor the directory does not hold, and does not print an id', () => {
  const label = dispositionLabel(shapeByStranger, A);
  expect(label).toContain('by someone who is no longer in this workspace');
  expect(label).not.toContain(shapeByStranger.disposition.byUserId!);   // never a raw uuid
});

it('never returns an empty string, for any shape', () => {
  for (const [, shape] of Object.entries(DISPOSITION_SHAPES)) {
    expect(dispositionLabel(shape, A)).not.toBe('');
  }
  // The founding defect, one layer up: an empty label in a cell reads as
  // "checked, nothing found", which is what `verificationLabel` exists to
  // prevent and what this function must not reintroduce beside it.
});
```

**Three of those rows are the whole feature and must not be collapsed into each other:** "cleared by hand" and "cleared by a re-run" are different acts (§6.3: *"the card must not flatten them"*); "never touched" and "cleared by hand" are both `unchecked` and are different facts (`changedCount === 0` versus a person who reset it); and "verified once" versus "verified after a rejection" is the difference between a settled clause and a contested one.

- [ ] **Step 2: Run it and watch it fail**

`npx vitest run src/lib/findingOutcome.test.ts` — expect `dispositionLabel is not a function`. **Read the exit code, not the summary line.**

- [ ] **Step 3: Implement, and let the ASCII rule decide the separator**

`exportSummaryLine`'s own docstring says the line is *"deliberately ASCII-only"* because the CSV is written with no byte-order mark and Excel on Windows reads a BOM-less file as ANSI, so an em-dash arrives as mojibake in the first thing a reader sees. **These two functions go into the same CSV**, so they follow the same rule: `-` and not `—`, `'` and not `'`. There is no version of this that is worth a garbled export.

- [ ] **Step 4: Invert Stage 3's guard rather than deleting it (P30)**

```ts
// apps/api/test/stage3DoD.test.ts — the line that read
//   it('ships no attribution surface (P28, §13)', () => {
//     expect(grepRepo('dispositionLabel')).toEqual([]);
// becomes, with the reason recorded in place:
it('has dispositionLabel, and it lives beside verificationLabel and nowhere else', () => {
  // Stage 3 asserted this was ABSENT (P28): a label with no mechanism behind
  // it was half of Stage 4's most important feature. Stage 4 builds the
  // mechanism, so the assertion INVERTS rather than disappearing — a file
  // that loses its guard when the guarded thing happens has stopped guarding.
  const homes = filesDeclaring(/export function dispositionLabel/);
  expect(homes).toEqual(['src/lib/findingOutcome.ts']);
  expect(filesScanned()).toBeGreaterThan(30);      // the sanity check
});
```

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm test
git add src/lib/findingOutcome.ts src/lib/findingOutcome.test.ts apps/api/test/stage3DoD.test.ts
git commit -m "feat: dispositionLabel and dispositionHistoryLine, beside verificationLabel"
git show --stat HEAD
```

---

## Task 5: The card names its actor and its time

**Type:** feature. §18 item 5's *"every disposition on screen carries its actor and time, and a changed one says so"*.

**Files:**
- Modify: `src/features/review/FindingCard.tsx`, `src/features/review/FindingCard.test.tsx`
- Modify: `src/components/StateChip.tsx` (only if the chip's `title` must change — check first)
- Modify: `src/App.tsx` (pass the disposition and the audience down), `src/index.css` (only if a role is missing)
- Modify: `apps/api/test/stage3DoD.test.ts` (invert the "was X" absence)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `dispositionLabel` / `DispositionAudience` (Task 4); `DispositionWithHistory` from `src/lib/api/findings.ts`'s cache (Task 3); `userName` (Task 2); `mount` / `mountOnce` / `click` / `flushUntil` from `src/test/mount.tsx`. **Read `FindingCard.tsx` in full**, particularly its error branch, which returns early and renders neither `StateChip` nor `VerificationControls`. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `FindingCardProps` gains `disposition?: DispositionWithHistory` and `audience: DispositionAudience`. **`Finding` does not change** (P34).

- [ ] **Step 1: The failing render test, over the same eight shapes**

```tsx
// src/features/review/FindingCard.test.tsx
it.each(Object.entries(DISPOSITION_SHAPES))('renders the %s shape with its actor and time', async (_what, shape) => {
  const { container } = mountOnce(<FindingCard finding={doneFinding} disposition={shape} audience={A} />);
  expect(container.textContent).toContain(dispositionLabel(shape, A));
});

it('never renders a bare state with no actor for a disposition somebody set', async () => {
  const { container } = mountOnce(<FindingCard finding={doneFinding} disposition={verifiedByOther} audience={A} />);
  const text = container.textContent!;
  expect(text).toContain('Verified by R. Okafor');
  // The mutation this exists for: delete the label line from FindingCard and
  // keep the StateChip. The chip still says "Verified", the card still looks
  // finished, and THIS assertion is the only thing that goes red.
  expect(text).not.toMatch(/Verified(?!\s+by)/);
});

it('names nobody for a never-touched finding, rather than naming whoever ran the review', async () => {
  const { container } = mountOnce(<FindingCard finding={doneFinding} disposition={neverTouched} audience={A} />);
  expect(container.textContent).toContain('Not checked');
  expect(container.textContent).not.toContain('by ');
});
```

- [ ] **Step 2: Run them and watch them fail**

`npx vitest run src/features/review/FindingCard.test.tsx`. **`mountOnce`, not `mount`, wherever a test needs a second tree** — `mount` accumulates trees and tears them down in a shared `afterEach`, and two live trees leave two competing `window` listeners, which is how a keyboard test once passed against a stale listener from the first mount.

- [ ] **Step 3: Render it, with the class map written out in full**

The line sits directly beneath `StateChip`, in the disposition block `VerificationControls` already heads. It is one line of `font-ui text-ui-sm text-ink-4`, with the "was X" and "changed N times" segments inside it.

**Do not build any class name by interpolation.** If a variant needs its own ink, map the complete string:

```tsx
// Tailwind's compiler finds classes by scanning source text for complete
// literal strings. `text-state-${state}` never appears as a string anywhere,
// so the utility is never generated and the element renders with no colour,
// silently, with no error and no failing test. HEALTH_INK in TemplateEditor
// and RISK_INK in MatterStats are the shipped examples of the fix.
const DISPOSITION_INK: Record<VerificationState, string> = {
  unchecked: 'text-state-unchecked',
  verified:  'text-state-verified',
  flagged:   'text-state-flagged',
  rejected:  'text-state-rejected',
};
```

- [ ] **Step 4: The `changed N times` segment is a control, not decoration**

§6.3: *"the card shows that fact inline and makes the history reachable in one action"*. Render the segment as a button; Task 6 gives it a panel to open. Until then it is `disabled` with a title saying the history is coming — **no**, that is half a feature. Order the two tasks so this button is added *in* Task 6, and in this task the segment is plain text. Task 6 turns it into the control. Named here so nobody builds a dead button.

- [ ] **Step 5: Invert the "was X" absence guard (P30), and edit `CLAUDE.md`**

The `stage3DoD` line asserting no browser file carries a "was X" string inverts to assert exactly one home for it (`src/lib/findingOutcome.ts`), with its sanity check.

In `CLAUDE.md`, under the verification rule, add one sentence and change nothing else:

> **A disposition is mutable, attributed, and never shown without its actor and its time.** `Verification` is still set only by a human action and nothing derives it — but as of Stage 4 any authorised reviewer may change any disposition in any direction, so the card names *who set the state it is showing* and, when `changedCount > 0`, says so and names the state it came from. `dispositionLabel` in `findingOutcome.ts` is the only place that wording lives.

- [ ] **Step 6: The restyle check, inverted deliberately**

`git status --porcelain -- '*.test.ts' '*.test.tsx'` will show edits, and that is correct here: this task changes what the card *says*, which is behaviour. **Say so in the report.** The rule (R-G22) is that a change claiming to be a restyle must not move a test; a change that declares itself textual must say which strings moved and why.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/features/review/FindingCard.tsx src/features/review/FindingCard.test.tsx \
  src/App.tsx src/index.css apps/api/test/stage3DoD.test.ts CLAUDE.md
git commit -m "feat: a disposition on screen names who set it and when"
git show --stat HEAD
```

---

## Task 6: The history, reachable in one action

**Type:** feature. First reader of a route Stage 3 shipped and left untested by any UI.

**Files:**
- Create: `src/features/review/DispositionHistory.tsx`, `src/features/review/DispositionHistory.test.tsx`
- Modify: `src/features/review/FindingCard.tsx`, `src/lib/api/findings.ts`, `src/App.tsx`
- Modify: `apps/api/src/routes/findings.ts` (docstring only — **the route does not change**)

**Interfaces:**
- Consumes: `GET /v1/reviews/:id/findings/:findingsKey/:clauseId/history` → `DispositionHistory { events: DispositionEventView[] }`, **newest first**; `dispositionHistoryLine` (Task 4); `Modal` (`src/components/Modal.tsx`); `describeLoadError` / `LoadErrorPanel`. **Read `readDispositionEvents` in `apps/api/src/dispositions/service.ts` and the route in `routes/findings.ts`. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `DispositionHistoryProps { reviewId; findingsKey; clauseId; audience; onClose }`.

**Do not write a second route.** The shipped one is tested, workspace-scoped and ordered. Its docstring says *"No UI reads it in Stage 3 (P28). Say so in the route's docstring so the next reader does not think it was forgotten."* — update that sentence to name this component, so the next reader finds the caller.

- [ ] **Step 1: The failing test, including the three load states**

```tsx
it('lists every change, newest first, each with its actor, its time and its cause', async () => {
  const { container } = mountOnce(<DispositionHistory {...props} />);
  await flushUntil(() => container.textContent!.includes('Rejected'));
  const lines = [...container.querySelectorAll('[data-history-line]')].map(n => n.textContent);
  expect(lines).toEqual([
    'Rejected by R. Okafor, 16:04 - was Verified. "The cap is uncapped in clause 14.2."',
    'Verified by A. Trainee, 15:12 - was Unverified',
  ]);
});

it('renders a re-run reset as a re-run, not as a person un-verifying', async () => {
  // The one line in this panel that a reader could act on wrongly. §6.3: the
  // two are different acts and the history distinguishes them.
  await flushUntil(() => text().includes('re-run'));
  expect(text()).toContain('this clause was re-run by A. Gray at 11:07');
  expect(text()).not.toContain('un-verified');
});

it('shows a load failure as a failure, never as an empty history', async () => {
  // An empty history under a non-unchecked disposition is indistinguishable
  // from a change that failed to record itself — the ambiguity §6.4 says the
  // one-transaction rule exists to make impossible. A failed FETCH must not
  // manufacture it.
  fetchFails(new Error('network'));
  await flushUntil(() => container.querySelector('[data-load-error]') !== null);
  expect(text()).not.toContain('No changes');
});

it('says a never-touched finding has no history, and says it in those words', async () => {
  fetchReturns({ events: [] });
  await flushUntil(() => text().includes('has not been changed'));
});
```

- [ ] **Step 2: Run them and watch them fail.** `npx vitest run src/features/review/DispositionHistory.test.tsx`.

- [ ] **Step 3: Implement, and make the `changed N times` segment the opener**

Task 5 left it as text; here it becomes the button that opens this panel — §6.3's *"reachable in one action"*. `jsdom` has no `Element.prototype.scrollIntoView` and `vitest.setup.ts` stubs it globally, so a panel that scrolls needs no guard of its own.

- [ ] **Step 4: The empty case is a sentence, not a blank panel**

`'This finding has not been changed since the review ran.'` — an empty list styled as a list is the blank-CSV-cell defect in a modal.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm test
git add src/features/review/DispositionHistory.tsx src/features/review/DispositionHistory.test.tsx \
  src/features/review/FindingCard.tsx src/lib/api/findings.ts src/App.tsx \
  apps/api/src/routes/findings.ts
git commit -m "feat: the disposition history, reachable in one action"
git show --stat HEAD
```

---

## Task 7: A refused change says whose won, and offers yours again

**Type:** feature. §18 item 5's *"a change submitted against a stale version is refused, shown what replaced it, and offered again"* — and the answer to *"what happens when two people change it at once"*.

**Files:**
- Create: `src/features/review/ConflictNotice.tsx`, `src/features/review/ConflictNotice.test.tsx`
- Modify: `src/App.tsx` (`handleVerify`, `verificationRefusal`), `src/lib/api/findings.ts`
- Modify: `apps/api/src/errors.ts` or `apps/api/src/routes/findings.ts` — **only if the `409` body does not already carry what the sentence needs; check before changing**
- Create: `apps/api/test/dispositionRace.pg.test.ts`
- Modify: `apps/api/test/dispositionRoutes.pg.test.ts`

**Interfaces:**
- Consumes: `ConflictError(currentRow)` (`apps/api/src/errors.ts`); `setDisposition`'s two refusal paths (the version comparison, and the `RETURNING`-empty re-read); `ModelError` with `code === 'conflict'`; `verificationRefusal` in `App.tsx`; `userName` (Task 2); `dispositionLabel` (Task 4). **Read `apps/api/src/errors.ts` and `apps/api/src/dispositions/service.ts` before writing. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `ConflictNoticeProps { current: DispositionWithHistory; attempted: VerificationChange; audience; onReapply: () => void; onDismiss: () => void }`.

**How a partner's override and a trainee's verification resolve, in full (P35).** Four mechanisms, and all four are needed:

1. **The version guard decides.** Both writes carry the `finding_disposition.version` each was looking at. `setDisposition` updates `where … and version = $expected`; the first to commit wins, the second finds no row and is refused with `ConflictError` carrying the **current** row. Shipped, and the two refusal paths are already there — the read-then-compare, and the `RETURNING`-empty case that catches a writer inside the same instant.
2. **The refusal is named.** The `409` body carries the current disposition; Stage 4 resolves `byUserId` through the directory and renders §6.3's own sentence: *"R. Okafor changed this to Rejected at 14:22, after you loaded it. Your change was not applied."*
3. **The change is offered again, against the new state.** One control, which re-submits the same `VerificationChange` with the version from the refusal. **A person clicks it; nothing clicks it for them** (P25: a human-authored write never auto-retries). The re-apply writes a **second history row**, so both intentions are on the record — §6.3's own resolution, and the reason the history is what makes mutability safe.
4. **The loser also gets the winner's change as a push** (Task 21), so a card left alone updates to the partner's name and time without anyone clicking anything. In Part 4A that arrives on the next poll instead, which is why this task is refusal-first and push-second.

**What must never happen, and what the tests assert:** no merge; no silent apply; no auto-retry; and no refusal that reads as a network error. `verificationRefusal` today says *"This finding changed while you were looking at it. Reload the review and try again."* — true, unhelpful, and it asks for a reload the app can now avoid.

- [ ] **Step 1: Two genuine concurrent writers, over a real database**

```ts
// apps/api/test/dispositionRace.pg.test.ts
it('applies exactly one of two changes made against the same version, and refuses the other by name', async () => {
  await seedDisposition({ state: 'unchecked', version: 1 });
  const [a, b] = await Promise.allSettled([
    put(trainee, DISPOSITION_URL, { state: 'verified', version: 1 }),
    put(partner, DISPOSITION_URL, { state: 'rejected', reason: 'Cap is uncapped', version: 1 }),
  ]);
  const codes = [a, b].map(r => r.status === 'fulfilled' ? r.value.status : 500).sort();
  expect(codes).toEqual([200, 409]);

  const refused = [a, b].find(r => r.status === 'fulfilled' && r.value.status === 409)!;
  const body = await (refused as PromiseFulfilledResult<Response>).value.json();
  // The refusal carries the row that WON, so the sentence needs no second
  // round trip — Stage 3's interface note 2.
  expect(body.current.version).toBe(2);
  expect(body.current.byUserId).toBeTruthy();

  // And exactly ONE history row was written, not two.
  const history = await readHistory(db, KEY);
  expect(history).toHaveLength(1);
});

it('records BOTH intentions when the refused person applies again', async () => {
  // §6.3: "a person who then repeats the change produces a second history
  // row, so both intentions are on the record". This is the assertion that
  // makes the refusal a resolution rather than a loss.
  const again = await put(trainee, DISPOSITION_URL, { state: 'verified', version: 2 });
  expect(again.status).toBe(200);
  const history = await readHistory(db, KEY);
  expect(history.map(e => [e.from_state, e.to_state])).toEqual([
    ['rejected', 'verified'],       // the trainee, again, knowingly
    ['unchecked', 'rejected'],      // the partner, first
  ]);
});

it('does NOT apply the refused write, and this is the mutation to try', async () => {
  // §14 names it: "make the stale-change path apply the write and then
  // return the current row — a UI that looks correct and a database where
  // the later click silently won". Change `where … and version = $8` to
  // `where …` alone and THIS test must go red. Nothing else will.
  expect((await readDisposition(db, KEY)).state).toBe('rejected');
});
```

- [ ] **Step 2: Run it and record which way the race actually went**

`npm run test:pg -- dispositionRace`. The test must not depend on *which* of the two wins — only that one does and one is refused. A test that expects the trainee to lose is a test that will flake on a faster machine.

- [ ] **Step 3: The notice**

```tsx
// src/features/review/ConflictNotice.tsx
/**
 * The sentence a person sees when someone else moved a judgement out from
 * under them.
 *
 * §6.3 writes this sentence out, and this component is the only place it
 * exists: *"Priya changed this to Rejected at 14:22, after you loaded it.
 * Your change was not applied."* Three things it must do, and each of them
 * is a defect if it is missing:
 *
 *  - NAME THE PERSON. "This finding changed" tells a reviewer nothing they
 *    can act on. "R. Okafor changed it" tells them who to ask.
 *  - SAY WHAT IT IS NOW, in the same words the card uses, through
 *    `dispositionLabel` — so the notice and the card cannot disagree about
 *    what happened, which is the drift `findingOutcome.ts` exists to stop.
 *  - OFFER THE CHANGE AGAIN, against the version that won. One click, by a
 *    person, writing a second history row. Never an automatic retry: P25,
 *    and a retry would re-create last-write-wins with extra steps.
 *
 * It does NOT offer "keep mine" or "merge". There is nothing to merge —
 * a disposition is one of four words — and "keep mine" IS the re-apply.
 */
```

- [ ] **Step 4: `handleVerify` renders the notice from the refusal, and from nothing else**

`await-then-apply` holds on the failure path too: the card's state does not move, the notice appears beside it carrying the row the server returned, and the local disposition cache is updated **from that row** — because the browser now knows the current state and continuing to show the stale one would be a second lie beside the first.

- [ ] **Step 5: Mutation-test the sentence, not just the code path**

```tsx
it('names the person and the time, and does not fall back to a generic sentence', () => {
  const { container } = mountOnce(<ConflictNotice current={rejectedByOkafor} attempted={{ state: 'verified' }} audience={A} … />);
  expect(container.textContent).toContain('R. Okafor changed this to Rejected at 14:22');
  expect(container.textContent).toContain('Your change was not applied');
  // The mutation: make `nameOf` return undefined for every id and confirm
  // this test fails rather than quietly rendering "someone changed this".
});

it('does not resubmit anything on its own, and asserts that absence', async () => {
  // P25 and P35: a human-authored write NEVER auto-retries. The absence has
  // to be ASSERTED, not assumed, because the pressure to add one automatic
  // re-apply is permanent — the click is annoying, the fix is one line, and
  // it re-creates last-write-wins with a history row saying a person decided
  // it. Mutation: call `onReapply()` from a `useEffect` and watch this fail.
  const put = spyOnDispositionWrite();
  mountOnce(<ConflictNotice current={rejectedByOkafor} attempted={{ state: 'verified' }} audience={A} … />);
  await flush(8);
  expect(put).not.toHaveBeenCalled();
  click(container.querySelector('[data-action="reapply"]')!);
  expect(put).toHaveBeenCalledTimes(1);           // only a person's click
});
```

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm test
git add src/features/review/ConflictNotice.tsx src/features/review/ConflictNotice.test.tsx \
  src/App.tsx src/lib/api/findings.ts apps/api/test/dispositionRace.pg.test.ts \
  apps/api/test/dispositionRoutes.pg.test.ts
git commit -m "feat: a refused change names whose won and offers yours again"
git show --stat HEAD
```

---

## Task 8: A change that arrives while somebody is mid-decision

**Type:** feature. The rule live change is most likely to break, and the one with no visible symptom.

**Files:**
- Create: `src/features/review/pendingUpdate.ts`, `src/features/review/pendingUpdate.test.ts`
- Modify: `src/App.tsx`, `src/features/review/FindingCard.tsx`, `src/features/review/RejectReasonModal.tsx`
- Modify: `src/features/review/FindingCard.test.tsx`

**Interfaces:**
- Consumes: `applyToFinding` / `humanWritesRef` / `refreshFindings` in `App.tsx`; `verifyBusyKey`; `RejectReasonModal`'s open state. **Read all of them. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  /** Whether an incoming disposition for this finding may be applied now, or
   *  must be held and announced. Pure; no React, no network. */
  export function mayApplyNow(state: {
    busyKey: string | null; openModalKey: string | null; findingKey: string;
  }): boolean;
  export interface HeldUpdate { findingKey: string; incoming: DispositionWithHistory }
  ```

**Why this is a task and not a paragraph.** `await-then-apply` says a reviewer never sees a state the store did not take. It does **not** cover the inverse, which realtime introduces: a state the store *did* take, swapped in under a person's hand while they are deciding. A partner's rejection landing while the trainee is three words into a reject reason, replacing the state the reason was being written about, is not a lie about the database — it is worse, because the person then submits a judgement about text that has moved. The symptom is nothing: no error, no flicker anyone would name, and a history row that reads as a considered second opinion.

- [ ] **Step 1: The failing test, driven through the real card**

```tsx
it('holds an incoming change while the reject-reason modal is open, and announces it', async () => {
  const { container, rerender } = mountOnce(<FindingCard {...props} disposition={verifiedByMe} />);
  click(container.querySelector('[data-action="reject"]')!);
  await flushUntil(() => container.querySelector('[role="dialog"]') !== null);

  rerender(<FindingCard {...props} disposition={rejectedByOther} />);
  // NOT applied under the open control...
  expect(container.querySelector('[data-disposition-label]')!.textContent).toContain('Verified by');
  // ...but SAID, so nothing is hidden.
  expect(container.textContent).toContain('R. Okafor changed this while you were writing');
});

it('applies the held change the moment the modal closes without submitting', async () => {
  click(container.querySelector('[data-action="cancel"]')!);
  await flushUntil(() => container.querySelector('[data-disposition-label]')!.textContent!.includes('Rejected by R. Okafor'));
});

it('lets a submission made against the held state be refused, visibly, rather than applied', async () => {
  // The version the modal was opened with is the version it submits. The
  // server refuses it (Task 7) and the ConflictNotice appears. That is the
  // correct outcome: the person acted on what they could see, and they are
  // told what replaced it — rather than their reason landing silently on a
  // state they never read.
  click(container.querySelector('[data-action="submit-reject"]')!);
  await flushUntil(() => container.textContent!.includes('Your change was not applied'));
});

it('applies an incoming change immediately when nothing is open and nothing is in flight', async () => {
  // The default. The guard must not become "hold everything", which would
  // make the app feel broken and would be a second, quieter defect.
  rerender(<FindingCard {...props} disposition={rejectedByOther} />);
  expect(container.textContent).toContain('Rejected by R. Okafor');
});
```

- [ ] **Step 2: Run them and watch the first two fail.** The fourth should already pass; if it does not, the card is memoising something it should not, and that is a finding to report before writing the guard.

- [ ] **Step 3: Implement `mayApplyNow` as a pure function, in its own module**

Two conditions hold an update, and only two: a disposition write is in flight for **this** finding (`busyKey === findingKey`), or a modal that composes a disposition for **this** finding is open. Not "any modal", not "the window is unfocused" — a guard broader than its reason becomes a guard nobody can reason about, and this one is read by the push path in Task 21 as well.

Pure and in its own file so both the poll path (here) and the socket path (Task 21) call the same function. Two copies of "may I apply this now?" is the sibling-drift rule on the decision that decides whether a lawyer sees a state change.

- [ ] **Step 4: The mutation**

Delete the `openModalKey` condition and confirm *"holds an incoming change while the reject-reason modal is open"* goes red. Restore. Then delete the `busyKey` condition and confirm nothing fails — **if nothing does, the second condition has no test and one must be written before this task closes.** A guard with an untested half is half a guard.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm test
git add src/features/review/pendingUpdate.ts src/features/review/pendingUpdate.test.ts \
  src/features/review/FindingCard.tsx src/features/review/FindingCard.test.tsx \
  src/features/review/RejectReasonModal.tsx src/App.tsx
git commit -m "feat: a change that arrives mid-decision is held and announced, never applied silently"
git show --stat HEAD
```

---

## Task 9: The export says when it was true, what changed, and that it can change again

**Type:** feature. §6.3.1's three requirements. **§19's worst-consequence item, and the one clause of §18 item 5 that needs no browser at all.**

**Files:**
- Modify: `src/features/review/exportDocx.ts`, `src/features/review/exportDocx.test.ts`
- Modify: `src/features/tabular/csv.ts` and its test
- Modify: `src/lib/findingOutcome.ts`, `src/lib/findingOutcome.test.ts`
- Modify: `apps/api/test/stage3DoD.test.ts` (invert the *"dispositions as at"* absence — P30)

**Interfaces:**
- Consumes: `exportSummaryLine(findings)`, `verificationLabel`, `describeFindingOutcome`, `collectionExportLabel`, `safeFileName` (`src/lib/findingOutcome.ts`); `dispositionLabel` (Task 4); the `dispositions` map (Task 3). **Read both exporters in full first.** They have drifted once before over exactly this kind of string.
- Produces:
  ```ts
  /** The one-line stamp every export carries. ASCII only, for the reason
   *  `exportSummaryLine` gives: the CSV has no BOM and Excel on Windows reads
   *  a BOM-less file as ANSI, so an em-dash arrives as mojibake in the first
   *  thing a reader sees. */
  export function dispositionsAsAtLine(at: number, timeZone: string): string;
  /** The sentence saying a disposition can change and that LexPrompt's
   *  history is authoritative over any printed copy. */
  export function dispositionsMayChangeLine(): string;
  ```

**Why this matters more than it looks, in the spec's own words.** §19: *"A card is read next to its history; a DOCX is read on a train, six weeks later, by a partner who was not in the review. Under the superseded insert-once model an export was a claim about a row that could not change … It no longer does, and the failure is completely silent: the document looks exactly the same whether or not the disposition it reports still holds. §6.3.1's three requirements are the whole of the defence, and every one of them is the kind of thing that gets trimmed for looking like boilerplate."*

**And the good news, which the report should say out loud:** this is the only clause of §18 item 5 with no verification gap. A DOCX and a CSV are bytes, and a test can read them.

- [ ] **Step 1: The failing tests, over the generated bytes**

```ts
// src/features/review/exportDocx.test.ts
it('stamps the instant its dispositions were read, with a timezone', async () => {
  const text = await docxTextOf(await exportDocx({ ...args, readAt: AT, timeZone: 'Europe/London' }));
  expect(text).toContain('Dispositions as at 2026-08-28 16:41 (Europe/London)');
});

it('says that a disposition can change, and that the app is authoritative', async () => {
  expect(text).toContain('A disposition can be changed by any reviewer at any time');
  expect(text).toContain("LexPrompt's history is authoritative over any printed copy");
});

it('carries the changed-from facts for a contested finding, not just its current state', async () => {
  // The network-era form of the CSV that wrote unreviewed clauses as blank
  // cells: technically the current state, read by a partner as the whole
  // state.
  expect(text).toContain('Verified by R. Okafor, 16:04 - was Rejected - changed 3 times');
});

it('writes the SAME three strings into the CSV', async () => {
  const csv = toCsv({ ...args, readAt: AT, timeZone: 'Europe/London' });
  for (const line of [asAt, mayChange, contested]) expect(csv).toContain(line);
  // The mutation this exists for: change the wording in ONE exporter and
  // watch this fail. They disagreed once before, and the CSV is the one that
  // opens straight into Excel.
});

it('keeps every export string ASCII', () => {
  for (const s of [dispositionsAsAtLine(AT, 'Europe/London'), dispositionsMayChangeLine(),
                   dispositionLabel(contestedShape, A)]) {
    expect(/^[\x20-\x7e\r\n]*$/.test(s)).toBe(true);
  }
});
```

- [ ] **Step 2: Run them and watch them fail.** `npx vitest run src/features/review/exportDocx.test.ts src/features/tabular/csv.test.ts`.

- [ ] **Step 3: Both new lines go into `findingOutcome.ts`, and both exporters call them**

Not into `exportDocx.ts` with a copy in `csv.ts`. That is the specific drift this module exists to prevent, and `CLAUDE.md` names the incident.

- [ ] **Step 4: `readAt` is passed in, never `Date.now()` inside the exporter**

The instant is *when the dispositions were read*, which is when the findings map the export is built from was fetched — not when the file was written. On a slow export those differ, and the second one is a claim the document cannot support. It is also what makes the test above deterministic without mocking the clock.

- [ ] **Step 5: The export gate banner and the summary block agree**

`ExportGateBanner.tsx` already warns about unverified findings. Read it; if its wording now under-states the case (it was written when a verification could not be changed), that is a finding to report and fix here — with the report saying which string moved and why (R-G22).

- [ ] **Step 6: Invert Stage 3's absence guard (P30)**

```ts
it('has exactly one home for the export s point-in-time wording', () => {
  // Stage 3 asserted "dispositions as at" appeared nowhere: an "as at" stamp
  // on a document whose dispositions nobody else can change would have been
  // a claim about a mechanism that did not exist. It exists now.
  expect(filesMatching(/Dispositions as at/)).toEqual(['src/lib/findingOutcome.ts']);
  expect(filesScanned()).toBeGreaterThan(30);   // sanity
});
```

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/features/review/exportDocx.ts src/features/review/exportDocx.test.ts \
  src/features/tabular/csv.ts src/features/tabular/csv.test.ts \
  src/lib/findingOutcome.ts src/lib/findingOutcome.test.ts \
  src/features/review/ExportGateBanner.tsx apps/api/test/stage3DoD.test.ts
git commit -m "feat: an export says when it was true and that it can change"
git show --stat HEAD
```

---

## Task 10: The review's full history is exportable in its own right

**Type:** feature. §6.3.1's fourth requirement.

**Files:**
- Create: `apps/api/src/routes/history.ts`, `apps/api/test/reviewHistory.pg.test.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/test/authz.route.test.ts`
- Create: `src/lib/api/history.ts`, `src/features/review/exportHistoryCsv.ts` and its test

**Interfaces:**
- Consumes: `readDispositionEvents` (`apps/api/src/dispositions/service.ts`) — **read it; the per-finding query is there and this route is the per-review one, so extract the shared shape rather than writing a second one**; `dispositionHistoryLine` (Task 4).
- Produces: `GET /v1/reviews/:id/history?after=<id>&limit=<n>` → `{ events: (DispositionEventView & FindingKey & { clauseTitle?: string })[]; nextCursor?: number; hasMore: boolean }`, **oldest first** (a chronology reads forward; the per-finding panel reads backward, and both are right for their reader).

**Why it exists.** §6.3.1: *"reconstruct what this report would have said on the day it was signed"* is a question a firm will eventually ask, and only the history can answer it. The current row answers only *as of right now*.

- [ ] **Step 1: The failing tests, including the two that matter**

```ts
it('returns every change in the review, oldest first, with the clause it belongs to', async () => { … });

it('pages rather than returning a year of history in one response', async () => {
  const page = await get(`/v1/reviews/${id}/history?limit=2`);
  expect(page.events).toHaveLength(2);
  expect(page.hasMore).toBe(true);
  expect(page.nextCursor).toBe(page.events[1].id);
});

it('refuses a review in another workspace rather than returning an empty history', async () => {
  // An empty history is indistinguishable from a review nobody has touched.
  // 404, the same shape `readFindings` already takes.
  await expect(get(otherWorkspaceReview)).rejects.toMatchObject({ status: 404 });
});

it('names a clause that is no longer in the playbook, rather than dropping the row', async () => {
  // A clause removed from a later playbook version still had judgements made
  // about it. Dropping the row would make the history quietly shorter than
  // what happened; the title falls back to the clause id, labelled as such.
  expect(page.events.some(e => e.clauseId === removedClauseId)).toBe(true);
});
```

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- reviewHistory`.

- [ ] **Step 3: Implement, with the `ROUTE_POLICY` line and its reasoning**

```ts
  // The review's whole disposition history (§6.3.1). `reviewer`: it is the
  // same facts the per-finding history route already returns at the same
  // bar, gathered for one review. A higher bar here would mean a reviewer
  // could see each change one at a time and not all of them together, which
  // is a distinction with no reader.
  'GET /v1/reviews/:id/history': 'reviewer',
```

- [ ] **Step 4: The CSV, through the same wording function**

`exportHistoryCsv` renders each row through `dispositionHistoryLine` plus its own columns (review, clause, from, to, cause, who, when). It carries the same `dispositionsAsAtLine` stamp as Task 9's exports — a history export is *also* a point-in-time claim, because the history can grow after it is taken.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm test
git add apps/api/src/routes/history.ts apps/api/src/server.ts apps/api/src/auth/routeTable.ts \
  apps/api/test/reviewHistory.pg.test.ts apps/api/test/authz.route.test.ts \
  src/lib/api/history.ts src/features/review/exportHistoryCsv.ts src/features/review/exportHistoryCsv.test.ts
git commit -m "feat: a review s full disposition history, readable and exportable"
git show --stat HEAD
```

---

## Task 11: `audit_event` — migration 011, insert-only by grant, partitioned monthly

**Type:** feature. P23's deferral, closed. P37.

**Files:**
- Create: `apps/api/migrations/011_audit_event.sql`
- Create: `apps/api/src/audit/write.ts`, `apps/api/src/audit/actions.ts`
- Create: `apps/api/test/auditEvent.pg.test.ts`
- Modify: `apps/api/src/routes/playbooks.ts`, `matters.ts`, `documents.ts`, `runs.ts`, `workspaceSettings.ts` (the first writers), `apps/api/test/grants.pg.test.ts`

**Interfaces:**
- Consumes: `runMigrations` (**an applied file is immutable — add `011`, never edit `005`–`010`**); the role names in `apps/api/migrations/000_preconditions.sql`; `Tx`. **Read `apps/api/migrations/008_runs.sql` and `006_dispositions.sql` for the grant idiom this project uses, including R-S3B1's lesson that a column-level `REVOKE` does not touch a table grant.**
- Produces:
  ```ts
  // apps/api/src/audit/actions.ts — a CLOSED set. A string not in it fails to compile.
  export const AUDIT_ACTIONS = [
    'matter.created', 'matter.deleted',
    'document.added', 'document.deleted',
    'playbook.published', 'playbook.imported',
    'review.created', 'review.deleted',
    'run.started', 'run.cancelled',
    'assignment.created', 'assignment.resolved',
    'workspace.settings_changed',
    'user.role_changed',
  ] as const;
  export type AuditAction = (typeof AUDIT_ACTIONS)[number];

  // apps/api/src/audit/write.ts — THE ONE WRITER.
  export async function appendAudit(t: Tx, e: {
    workspaceId: string; actorUserId: string; action: AuditAction;
    subjectType: string; subjectId: string;
    matterId?: string; reviewId?: string; detail?: Record<string, unknown>;
  }): Promise<void>;
  ```

**What is deliberately NOT in that list: any disposition action.** S22: *"A disposition change is recorded once, in `finding_disposition_event`, and is not also written to `audit_event`."* Two append-only records of one fact is this project's most repeated defect placed exactly where a divergence would be least likely to be noticed and most damaging — between what a lawyer reads on the card and what the firm exports as evidence. **Task 12's scanner asserts the absence.**

- [ ] **Step 1: The migration, with the grant that is the guarantee**

```sql
-- 011_audit_event.sql
-- §6.5, S11. Append-only BY GRANT, not by convention: "a mistaken audit row
-- cannot be corrected, only annotated by a later row -- which is what
-- append-only means and why it is evidence."
--
-- PARTITIONED MONTHLY (§6.5). Declarative partitioning by `at`, so retention
-- is a DETACH rather than a DELETE over a table nobody may delete from --
-- which is the only way a retention policy and an insert-only grant can both
-- be true. A partition is created ahead of time by the same mechanism; a
-- write with no partition FAILS LOUDLY rather than being dropped, and the
-- test below is what proves it does.
create table audit_event (
  id            bigint generated always as identity,
  workspace_id  uuid not null references workspace(id),
  at            timestamptz not null default now(),
  actor_user_id uuid not null references app_user(id),
  action        text not null,
  subject_type  text not null,
  subject_id    text not null,
  matter_id     text,
  review_id     text,
  detail        jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(detail) = 'object'),
  primary key (id, at)
) partition by range (at);

create index audit_event_ws_at_idx on audit_event (workspace_id, at desc);
create index audit_event_matter_idx on audit_event (workspace_id, matter_id, at desc);

-- INSERT and SELECT. Nothing else, to any application role.
grant insert, select on audit_event to lexprompt_app;
-- The worker gets NOTHING, not even select: it performs no act that belongs
-- in an audit log, and a grant it does not need is a grant nobody will
-- notice becoming load-bearing.
```

**The implementer must check, against the real database, that `grant insert, select` on a partitioned parent reaches its partitions**, and if it does not, grant on each partition at creation and say so in the report. R-S3B1 is this project's own precedent: the brief's `revoke update (findings)` was a **no-op** because Postgres keeps column privileges in `attacl` and table privileges in `relacl`, and nothing errored. Assume nothing about grant propagation; ask the catalogue.

- [ ] **Step 2: The grant tests, and the mutation that proves they bite**

```ts
it('refuses every application role an UPDATE or a DELETE on audit_event', async () => {
  for (const verb of ['update audit_event set action = $1', 'delete from audit_event']) {
    await expect(asApp(verb)).rejects.toMatchObject({ code: '42501' });
  }
  // The companion positive: the same role CAN insert and select, or the two
  // refusals above would pass against a role with no grants at all.
  await expect(asApp('insert into audit_event …')).resolves.toBeDefined();
});

it('has not been handed the grant by anything outside the migrations', async () => {
  // The catalogue read, not the behaviour. This is the one that notices a
  // grant made to a role the app role inherits from — the check that caught
  // Stage 3's missing `finding_disposition` coverage.
  const acl = await catalogueGrantsFor('audit_event');
  expect(acl.filter(g => /UPDATE|DELETE|TRUNCATE/.test(g.privilege))).toEqual([]);
});

it('fails loudly rather than silently when no partition covers the instant', async () => {
  await expect(insertAt(farFuture)).rejects.toThrow(/no partition of relation/);
});
```

**The mutation §14 names:** add `grant update on audit_event to lexprompt_app` to the live database outside the migrations and confirm the first two go red. Revoke and confirm they return. Stage 3's report shows why this matters — the obvious behavioural test stayed green with and without the grant.

- [ ] **Step 3: `appendAudit` takes a `Tx`, for `appendEvent`'s reason**

An audit row committed while the act it records rolled back is a log that says something happened which did not. Same signature discipline, same rationale, and the two live side by side so the next reader sees the pattern rather than inventing a second one.

- [ ] **Step 4: The first writers, and no more than the first writers**

Add `appendAudit` to the acts in `AUDIT_ACTIONS` and nothing else. Do not "instrument everything": an action with no reader is an action nobody has decided the wording of, and the closed set is what stops the list becoming a log of function calls.

- [ ] **Step 5: Gates and commit**

```bash
npm run test:pg && npm run typecheck && npm test
git add apps/api/migrations/011_audit_event.sql apps/api/src/audit \
  apps/api/test/auditEvent.pg.test.ts apps/api/test/grants.pg.test.ts apps/api/src/routes
git commit -m "feat: audit_event, append-only by grant, with its first writers"
git show --stat HEAD
```

---

## Task 12: The activity feed reads three sources and names people

**Type:** feature. The clause of `CLAUDE.md` that this task makes false, and edits.

**Files:**
- Create: `apps/api/src/routes/activity.ts`, `apps/api/test/activity.pg.test.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/test/authz.route.test.ts`
- Modify: `src/lib/matterActivity.ts`, `src/lib/matterActivity.test.ts`, `src/features/matters/MatterActivity.tsx` and its test
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `audit_event` (Task 11), `finding_disposition_event`, the `run` table; `ActivityEntry` / `ActivityKind` / `matterActivity` (`src/lib/matterActivity.ts` — **read it in full, including R-G9's "nothing is stored" reasoning, which this task partly supersedes**); `userName` (Task 2).
- Produces:
  ```ts
  // src/lib/matterActivity.ts
  export interface ActivityEntry {
    at: number;
    kind: ActivityKind;
    clauseTitle?: string;
    reviewName: string;
    /** Who did it. `undefined` for an actor the directory does not hold —
     *  rendered as "someone no longer in this workspace", never as an id and
     *  never as you. */
    byUserId?: string;
    /** Kept, and now DERIVED from byUserId rather than being the only fact
     *  available. Every existing renderer keeps working. */
    byYou: boolean;
  }
  export function activityEntries(rows: ActivityRow[], localUserId: string, limit?: number): ActivityEntry[];
  ```

**What changes and what does not.** R-G9's reasoning — *"derived at read time from data that already carries an author and a timestamp; nothing is stored: an event log would be a second account of what happened, free to drift"* — was right and is now **half** right. Disposition changes and audited acts have their own append-only records *because they are the record*, not a second account of one. What must not appear is a third: an `activity` table. The route is a `UNION` over three tables that exist for their own reasons (S22), computed per request.

- [ ] **Step 1: The failing tests**

```ts
it('reads a disposition change from finding_disposition_event, not from audit_event', async () => {
  const feed = await get(`/v1/matters/${matterId}/activity`);
  expect(feed.entries.some(e => e.kind === 'rejected' && e.byUserId === partnerId)).toBe(true);
  // S22's absence, asserted rather than assumed: the same act must not be in
  // the audit log too, or the feed shows it twice and an auditor reconciling
  // two logs finds a discrepancy that is really a duplicate.
  const audits = await db.query("select 1 from audit_event where action like 'finding%'");
  expect(audits).toHaveLength(0);
});

it('names both people in a contested finding, not just the local one', async () => {
  const kinds = feed.entries.filter(e => e.clauseTitle === 'Liability cap');
  expect(new Set(kinds.map(e => e.byUserId))).toEqual(new Set([traineeId, partnerId]));
});

it('drops an entry with no timestamp rather than dating it now', async () => {
  // R-G9's rule, carried over verbatim: "a feed whose ordering is invented is
  // worse than a feed with a gap."
  expect(feed.entries.every(e => Number.isFinite(e.at))).toBe(true);
});

it('scopes to the matter and to the workspace, in one statement each', async () => { … });
```

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- activity`.

- [ ] **Step 3: One `UNION`, three sources, ordered and limited in SQL**

Not three queries merged in TypeScript: a limit applied after a merge reads the whole of every source. Written as one literal for `workspaceScope.test.ts`, with each arm carrying its own `workspace_id` predicate.

- [ ] **Step 4: `ActivityEntry` gains its actor, and `byYou` survives**

`byYou` stays, derived as `byUserId === localUserId`, so `MatterActivity.tsx`'s existing rendering keeps working and the diff is additive. The renderer gains one branch: an entry that is not yours names its actor through `userName`; an actor the directory does not hold renders as *"someone no longer in this workspace"* — R-GP5's rule, unchanged in substance.

- [ ] **Step 5: Edit `CLAUDE.md`, in this commit (P38)**

In "Deliberate non-features", the sentence *"the activity feed's entry type (`ActivityEntry.byYou: boolean`) can express only 'you did this' or 'someone did this' — it has no field a second person's name could occupy. Do not add one to answer a UI request for 'who else is on this matter'; that question has no honest answer in a single-browser app."* becomes:

> **As of Stage 4 the activity feed names people, because there are people to name.** `ActivityEntry` carries `byUserId` alongside `byYou`, resolved to a name through the workspace directory (`src/lib/api/users.ts`, the only id→name resolver). An actor the directory does not hold renders as "someone no longer in this workspace" — never as an id, and never as you. What is still not built: the assignee chip and the "assigned to me" counter, which are Stage 5 (S18), and `⌘K` and the Report tab, which stay deferred (R-G14, R-G11).

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm test
git add apps/api/src/routes/activity.ts apps/api/src/server.ts apps/api/src/auth/routeTable.ts \
  apps/api/test/activity.pg.test.ts apps/api/test/authz.route.test.ts \
  src/lib/matterActivity.ts src/lib/matterActivity.test.ts \
  src/features/matters/MatterActivity.tsx src/features/matters/MatterActivity.test.tsx CLAUDE.md
git commit -m "feat: the activity feed names people, and reads the records that already exist"
git show --stat HEAD
```

---

## Task 13: Part 4A gate — the record is honest, proven with two accounts on a running stack

**Type:** verification. **Part 4B does not begin until this passes.**

**Files:**
- Create: `apps/api/test/stage4aDoD.test.ts`, `apps/api/test/stage4aDoD.pg.test.ts`
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/part-4a-report.md`

- [ ] **Step 1: The searched checks, each with its sanity check**

```ts
it('has exactly one home for every piece of disposition wording', () => {
  expect(filesDeclaring(/export function dispositionLabel|export function dispositionHistoryLine/))
    .toEqual(['src/lib/findingOutcome.ts', 'src/lib/findingOutcome.ts']);
  expect(filesScanned()).toBeGreaterThan(60);
});

it('renders no disposition anywhere without going through that wording', () => {
  // The scanner: any component that renders a VerificationState directly,
  // other than StateChip (which renders the WORD and is paired with the
  // label line beside it), is a second place deciding what a disposition
  // says. Named exclusions, never a relaxed pattern.
  expect(componentsRenderingRawState().filter(f => f !== 'src/components/StateChip.tsx')).toEqual([]);
  expect(componentsScanned()).toBeGreaterThan(20);
});

it('has exactly one id-to-name resolver', () => {
  expect(filesDeclaring(/export function userName/)).toEqual(['src/lib/api/users.ts']);
});

it('writes no disposition act into audit_event (S22)', () => {
  const src = codeOf('apps/api/src/audit/actions.ts');
  expect(src).not.toMatch(/finding\.|disposition/);
  expect(src).toMatch(/playbook\.published/);      // the sanity check
});

it('still polls — the socket is Task 16, not this part', () => {
  expect(codeOf('src/lib/api/runs.ts')).toContain('setTimeout');
  expect(grepRepo('new WebSocket')).toEqual([]);
  expect(grepRepo('@fastify/websocket')).toEqual([]);
});

it('has no presence and no assignment yet — Tasks 22 and 24, not before', () => {
  expect(grepRepo('presence', { under: ['src', 'apps/api/src'] })).toEqual([]);
  expect(existsSync('apps/api/migrations/012_assignment.sql')).toBe(false);
});
```

The last two are the part boundary **enforced rather than remembered**, exactly as `stage3aDoD.test.ts` was. Tasks 16, 19, 22 and 24 each edit this file when they land, and that is the intent.

- [ ] **Step 2: The live checks, with two accounts, in order, results written down**

1. `npm run compose:up`; all services healthy.
2. Both accounts sign in through the test client; `GET /v1/matters` unauthenticated is still `401 sign_in_required`, **not an empty list**.
3. `GET /v1/workspace/users` as the trainee lists both people; as an unauthenticated caller it is 401.
4. The trainee verifies a clause. The findings read, **as the partner**, carries the trainee's id, `changedCount: 1`, and a `last` event with `fromState: 'unchecked'`.
5. The partner rejects it with a reason. The findings read, **as the trainee**, now names the partner, `changedCount: 2`, `last.fromState: 'verified'`.
6. Both submit against version 2 concurrently: one 200, one 409 carrying the winner's row. The refused one re-applies against the new version and a **third** history row exists.
7. `GET /v1/reviews/:id/history` lists all three, oldest first, with both names.
8. A DOCX and a CSV are generated from that review and **read back**: the "as at" instant, the changed-from line, and the can-change sentence are in both, byte-identical between them.
9. The matter's activity feed names both people.
10. `docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com'` — **still fails.** §5's central claim is a network fact; a new route group landed, so it is re-checked rather than inherited.
11. Everything this gate created is deleted (rule 7).

- [ ] **Step 3: Say what you could not do**

Browser automation is expected to be unavailable. **Say so plainly rather than implying otherwise.** Name specifically: nobody has *seen* the card change attribution; the rendered strings are asserted by `mount.tsx` tests and by nothing that has looked at a screen.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/stage4aDoD.test.ts apps/api/test/stage4aDoD.pg.test.ts \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/part-4a-report.md
git commit -m "test: Part 4A s definition of done, with two accounts on a running stack"
git show --stat HEAD
```

---

# PART 4B — the change arrives without asking, and you can see who else is here

---

## Task 14: Spike 3, executed locally, at two replicas

**Type:** spike, with an answer as its output and a pinned deployment as its side effect (P41)

**Files:**
- Modify: `docker-compose.yml` (`api` at two replicas behind the proxy), `infra/nginx/web.conf` (upstream resolution across replicas)
- Modify: `infra/modules/containerApps.bicep` (`maxReplicas`, pinned, with its reason)
- Create: `apps/api/test/replicaFanout.compose.test.ts` (**it will fail at the end of this task, deliberately** — Task 18 turns it green)
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/spike-3-report.md`

**Interfaces:**
- Consumes: `docker-compose.yml`'s `api` service and the `internal` network; `infra/nginx/web.conf`'s `resolver` / `set $api_upstream` block — **read the whole file and its comments**, which record why the upstream is resolved per request and why `api` publishes no host port. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: an answer, in the report: does fan-out have to cross replicas, and what is the minimum-replica recommendation for Azure.

**Why this is Task 14 and not Task 20.** Every task after this one either assumes an in-process hub is sufficient or assumes it is not, and Tasks 16 and 18 are shaped differently by the answer. §15 says a spike's output is an answer rather than code that is kept. This one keeps the compose change and the failing test.

**What this spike can and cannot answer (P41).** It answers the half that matters for correctness: *does a client connected to one replica see a write made on another*. It does **not** answer the Container Apps half — ingress idle timeouts, scale-to-zero wake behaviour, whether ingress pins a socket to a replica — because no Azure environment has been reachable for three stages. **Both halves go in the report, one with a result and one with the word "unanswered".**

- [ ] **Step 1: Two replicas in compose, which §5.1 row 6 already asks for**

`docker compose up --scale api=2` with nginx resolving `api` per request through Docker's embedded DNS — the shipped config already does this, and the comment explaining why is the reason it will work: *"nginx resolves a literal `proxy_pass` hostname once, at config-load time … a variable in `proxy_pass` defers resolution to request time."* With two containers behind one DNS name, successive requests land on different replicas, which is exactly the condition to test under.

Record in the report: whether the health checks pass at two replicas, whether the migration advisory lock does the right thing when two replicas start together (`runMigrations` runs under `pg_advisory_xact_lock`, so it should — **check it rather than assuming**, and say what you saw), and whether `API_DATABASE_POOL_MAX × 2` still fits the database's `max_connections`. That last one is a declared cap with a new multiplier and it is exactly the tier the Stage 3 plan added to the caps table.

- [ ] **Step 2: The test that fails, and says why it fails**

```ts
// apps/api/test/replicaFanout.compose.test.ts
it('delivers a write made on one replica to a socket held on the other', async () => {
  const { trainee, partner } = await twoAccounts();
  // Two sockets, opened until they land on DIFFERENT replicas. Each replica
  // reports its own instance id on the socket's `hello` frame (Task 16), so
  // this is a fact rather than a hope; if twenty attempts all land on one
  // replica, FAIL saying so rather than passing vacuously.
  const [a, b] = await twoSocketsOnDifferentReplicas(trainee, partner);

  await put(partner, DISPOSITION_URL, { state: 'rejected', reason: 'Cap', version: 1 });

  const seen = await a.waitFor('finding.disposition_changed', { timeoutMs: 5_000 });
  expect(seen.payload.state).toBe('rejected');
  expect(seen.payload.byUserId).toBe(partner.userId);
});
```

**It is expected to fail at the end of this task** — that failure IS the spike's answer, and it is the evidence Redis-or-not rests on. Mark it `it.fails(...)` or skip it with a comment naming Task 18, so the suite is green and the reason is in the source rather than in someone's memory.

- [ ] **Step 3: Take the branch explicitly**

**If a write on one replica does not reach a socket on another** (the expected result with an in-process hub): Task 18 builds the outbox-by-cursor fan-out with `pg_notify` as its doorbell (P39). **No Redis**, because Postgres already holds the durable record and already delivers a transactional notification; adding a container to every environment for a property the database has is a dependency bought with nothing.

**If a candidate fan-out cannot be made to work over Postgres** — measured, with a number, not an impression: `LISTEN` unavailable in the managed service, notification loss under load, or a latency that makes the app feel worse than the poll it replaced — **stop and report.** §5.1 row 6 already describes the Redis shape and it is one compose service plus one configuration row. Do not improvise a third mechanism.

- [ ] **Step 4: Pin the Azure replica count, with the reason in the file**

```bicep
      // Pinned by Stage 4 Task 14 (P41). Fan-out across replicas is
      // <the answer>, so `api` may run at <n>. Raising this without the
      // cross-replica fan-out test passing means a reviewer connected to one
      // replica silently stops seeing a colleague's changes -- in the
      // deployed environment only, which is where nobody is watching.
      scale: { minReplicas: 1, maxReplicas: <n> }
```

Whatever the answer, the number is now *chosen* rather than inherited from a template default. That alone is worth the task.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml infra/nginx/web.conf infra/modules/containerApps.bicep \
  apps/api/test/replicaFanout.compose.test.ts \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/spike-3-report.md
git commit -m "spike: does fan-out cross replicas, answered locally with a failing test"
git show --stat HEAD
```

---

## Task 15: One outbox, one vocabulary — nine event types, three subscriptions

**Type:** feature. P40.

**Files:**
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `apps/api/src/run/events.ts`, `apps/api/test/events.pg.test.ts`
- Modify: `apps/api/src/routes/findings.ts`, `apps/api/src/run/queue.ts`, `apps/api/src/routes/runs.ts` (populate `matter_id`; append the new events)
- Modify: `src/lib/api/runs.ts` (the `RunEvent.runId` narrowing)

**Interfaces:**
- Consumes: `RUN_EVENT_TYPES`, `isRunEventType`, `RunEvent`, `RunEventPage`, `RunEventPayload` (`packages/core/src/api/records.ts`); `appendEvent`, `fromEventRow`, `readEvents`, `pruneEvents` (`apps/api/src/run/events.ts`); `event`'s DDL in `apps/api/migrations/008_runs.sql`. **Read every one. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  export const EVENT_TYPES = [
    // The five Stage 3 shipped. UNCHANGED, and not renamed (interface note 3).
    'run.started', 'finding.running', 'finding.done', 'finding.error', 'run.finished',
    // The four Stage 4 adds.
    'finding.disposition_changed', 'note.added', 'assignment.created', 'assignment.resolved',
  ] as const;
  export type EventType = (typeof EVENT_TYPES)[number];

  /** §8: "carries the whole new finding_disposition row plus the
   *  finding_disposition_event that produced it, so a client applies one
   *  push and has both the current state and the fact that it changed." */
  export interface DispositionChangedPayload {
    reviewId: string; findingsKey: string; clauseId: string;
    disposition: DispositionView;
    event: DispositionEventView;
    /** finding_disposition.version. THE SAME NUMBER the stale-change refusal
     *  turns on (§8, Stage 3's interface note 1). Not a second version. */
    version: number;
  }
  export interface NoteAddedPayload { reviewId: string; findingsKey: string; clauseId: string; note: Note }

  /** `runId` is ABSENT on an event that belongs to no run — a disposition
   *  change, a note, an assignment. Not `''`, which is what `fromEventRow`
   *  returns today and which reads to a client as a run whose id is empty. */
  export interface AppEvent {
    id: number; type: EventType; at: number;
    workspaceId: string; matterId: string; reviewId?: string; runId?: string;
    payload: EventPayload;
  }
  ```

**No migration.** `event` already has nullable `matter_id`, `review_id` and `run_id`, and already indexes `(workspace_id, review_id, id)`. What is missing is a *matter* index and the population of `matter_id`. Add the index in Task 24's migration alongside `assignment` if one is needed — **measure first**; a matter subscription over a workspace with one matter needs no index and an index nobody reads is a row in the caps table with no reader.

- [ ] **Step 1: The failing tests**

```ts
it('appends a disposition change with no run, and reads it back with no runId key', async () => {
  await db.tx(t => appendEvent(t, { workspaceId: WS, matterId: M, reviewId: R,
    type: 'finding.disposition_changed', payload }));
  const [e] = (await readEvents(db, { workspaceId: WS, subscription: { review: R }, after: 0, limit: 10 })).events;
  expect(e.type).toBe('finding.disposition_changed');
  expect('runId' in e).toBe(false);      // absent, not ''
  expect(e.matterId).toBe(M);
});

it('still refuses a type nobody registered', async () => {
  await db.query("insert into event (workspace_id, review_id, type, payload) values ($1,$2,'finding.exploded','{}')", [WS, R]);
  await expect(readEvents(db, { workspaceId: WS, subscription: { review: R }, after: 0, limit: 10 }))
    .rejects.toThrow(/not one of the/);
  // The closed set survives the widening. An event nothing reads is a hole a
  // client cannot see, and the refusal is what makes it visible instead.
});

it('serves a review subscription every event of that review, run events included', async () => {
  const page = await readEvents(db, { workspaceId: WS, subscription: { review: R }, after: 0, limit: 100 });
  expect(page.events.map(e => e.type)).toContain('finding.done');
  expect(page.events.map(e => e.type)).toContain('finding.disposition_changed');
});

it('serves a matter subscription events from every review in that matter, and no other', async () => { … });

it('keeps resyncRequired measured against the whole table, not this subscription', async () => {
  // The shipped reasoning, re-asserted after the predicate changed: ids are
  // monotonic and the pruner deletes by AGE, so everything below min(id) is
  // gone. Comparing against a subscription's own oldest event would report a
  // resync to every client that connected before its first event -- which is
  // every client.
});

it('populates matter_id on every event a run writes', async () => {
  const rows = await db.query('select type from event where matter_id is null');
  expect(rows).toEqual([]);
  expect((await db.query('select 1 from event')).length).toBeGreaterThan(0);   // sanity
});
```

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- events`.

- [ ] **Step 3: Widen, and keep every refusal**

`EventToAppend.runId` becomes optional; `readEvents` takes `subscription: { review: string } | { matter: string } | { run: string }` and builds **one predicate per shape, each as a whole literal** for `workspaceScope.test.ts`. `fromEventRow` keeps its throw and returns `runId` as an absent key rather than `''`.

`src/lib/api/runs.ts`'s `watchRun` narrows on `event.type === 'run.finished'` and does not read `runId`, so the narrowing costs nothing there — **check it rather than assuming**, and if something does read `event.runId`, it is now optional and TypeScript will say so.

- [ ] **Step 4: The disposition route and the note route append their events**

Both **inside the transaction that already writes the row** (`appendEvent` takes a `Tx`, and that signature is the rule). A push that commits while its write rolls back is a client told about a judgement that does not exist.

**The disposition event carries the row and the event that produced it** — §8, verbatim — so the client gets "Rejected by R. Okafor" *and* "was Verified" from one frame, with no second query and no duplicated column.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm test
git add packages/core/src/api/records.ts packages/core/src/index.ts apps/api/src/run/events.ts \
  apps/api/src/routes/findings.ts apps/api/src/routes/runs.ts apps/api/src/run/queue.ts \
  apps/api/test/events.pg.test.ts src/lib/api/runs.ts
git commit -m "feat: one outbox, nine event types, three subscriptions"
git show --stat HEAD
```

---

## Task 16: The WebSocket — authenticated before it is upgraded, replayed from the cursor

**Type:** feature. §8's transport.

**Files:**
- Create: `apps/api/src/realtime/hub.ts`, `apps/api/src/realtime/socket.ts`
- Create: `packages/core/src/api/socket.ts` (the frame union, shared by both sides)
- Create: `apps/api/test/socket.pg.test.ts`, `apps/api/test/socketAuth.test.ts`, `apps/api/test/helpers/wsClient.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/api/src/config.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/package.json`
- Modify: `apps/api/test/authz.route.test.ts`, `apps/api/test/configSurface.test.ts`, `apps/api/test/divergence.json`, `apps/api/test/caps.test.ts`, `apps/api/test/stage4aDoD.test.ts` (invert the "no socket yet" guard — P30)

**Interfaces:**
- Consumes: `requireUser` / the token verifier (`apps/api/src/server.ts`); `resolveActor` (`apps/api/src/auth/actor.ts`); `readEvents` (Task 15); `ROUTE_POLICY`. **Read `server.ts`'s `requireUser` hook and `oidc.test.ts`'s route-discovery scanner** — that scanner matches routes registered a particular way, and a socket route registered differently would be **silently absent from the 401 sweep**, which is the shape of a test that cannot fail.
- Produces:
  ```ts
  // packages/core/src/api/socket.ts — one union, both directions, both sides.
  export type ClientFrame =
    | { t: 'subscribe'; sub: SubscriptionRef; lastEventId: number }
    | { t: 'unsubscribe'; sub: SubscriptionRef }
    | { t: 'presence'; sub: SubscriptionRef; screen: string; clauseId?: string }
    | { t: 'pong' };
  export type ServerFrame =
    | { t: 'hello'; instanceId: string; userId: string }
    | { t: 'event'; sub: SubscriptionRef; event: AppEvent }
    | { t: 'caught_up'; sub: SubscriptionRef; cursor: number }
    | { t: 'resync_required'; sub: SubscriptionRef }
    | { t: 'presence'; sub: SubscriptionRef; members: PresenceMember[] }
    | { t: 'refused'; sub?: SubscriptionRef; reason: string }
    | { t: 'ping' };

  // apps/api/src/realtime/hub.ts — the interface §8 requires, with no transport in it.
  export interface Hub {
    join(conn: Connection, sub: SubscriptionRef): void;
    leave(conn: Connection, sub: SubscriptionRef): void;
    publish(sub: SubscriptionRef, frame: ServerFrame): void;
    close(conn: Connection): void;
  }
  ```

**Authentication, and why it is a subprotocol rather than a query string or a ticket (a ruling to record).** A browser cannot set an `Authorization` header on a `WebSocket`. Three options: a token in the query string, which lands in every proxy access log and would make §14's *"no log line contains a credential"* false at the one hop nginx logs by default; a single-use ticket, which needs shared state across replicas and so becomes a table holding a credential; or the token in `Sec-WebSocket-Protocol`, which is a header, is not in nginx's `combined` log format, needs no state, and works identically at any replica count. **Take the third.**

```ts
// The browser: new WebSocket(url, ['lexprompt.v1', `bearer.${token}`])
//
// THE SERVER MUST ECHO BACK exactly one accepted subprotocol -- 'lexprompt.v1'
// -- or the browser closes the connection immediately with no error a
// developer can read. This is the single most common way this pattern is
// shipped broken, and it fails identically to a network problem.
```

And the bypass rule (S29): **the token is verified and the actor resolved BEFORE the upgrade is accepted.** A socket that upgrades first and authenticates on the first frame is an unauthenticated connection that exists, however briefly, and it is an authentication bypass wearing a different protocol.

- [ ] **Step 1: The failing tests, auth first**

```ts
// apps/api/test/socketAuth.test.ts
it('refuses an upgrade with no token, before upgrading', async () => {
  const res = await rawUpgrade('/v1/ws', { protocols: ['lexprompt.v1'] });
  expect(res.statusCode).toBe(401);
  expect(res.headers.upgrade).toBeUndefined();     // it never became a socket
});

it('refuses a token from the other issuer', async () => { … });

it('has no bypass — and this is mutation-tested', () => {
  // §14: "add a SKIP_AUTH path and the auth suite must fail". Add an
  // `if (process.env.WS_ALLOW_ANON)` branch to realtime/socket.ts and
  // confirm THIS test goes red. Restore.
  expect(codeOf('apps/api/src/realtime/socket.ts')).not.toMatch(/SKIP|ANON|allowAnonymous|process\.env/);
  expect(codeOf('apps/api/src/realtime/socket.ts')).toMatch(/verify|actor/);   // sanity
});

it('is in ROUTE_POLICY like every other route, and the authz sweep sees it', () => {
  expect(ROUTE_POLICY['GET /v1/ws']).toBe('reviewer');
  expect(discoveredRoutes()).toContain('GET /v1/ws');   // the scanner actually finds it
});

it('echoes exactly one subprotocol', async () => {
  const res = await rawUpgrade('/v1/ws', { protocols: ['lexprompt.v1', `bearer.${token}`] });
  expect(res.headers['sec-websocket-protocol']).toBe('lexprompt.v1');
});
```

```ts
// apps/api/test/socket.pg.test.ts
it('replays from the cursor and then says caught_up', async () => {
  const ws = await connect(token);
  ws.send({ t: 'subscribe', sub: { review: R }, lastEventId: 3 });
  const frames = await ws.collectUntil(f => f.t === 'caught_up');
  expect(frames.filter(f => f.t === 'event').map(f => f.event.id)).toEqual([4, 5, 6]);
  expect(frames.at(-1)).toMatchObject({ t: 'caught_up', cursor: 6 });
});

it('says resync_required rather than a silently short replay', async () => {
  ws.send({ t: 'subscribe', sub: { review: R }, lastEventId: 1 });   // pruned
  expect(await ws.next()).toMatchObject({ t: 'resync_required' });
  // The mutation: make the replay return what survives and NOT send this
  // frame. Every happy-path test still passes and the client silently has a
  // hole. This is the assertion that catches it.
});

it('refuses a subscription to another workspace s review, with a sentence', async () => {
  ws.send({ t: 'subscribe', sub: { review: otherWorkspaceReview }, lastEventId: 0 });
  expect(await ws.next()).toMatchObject({ t: 'refused' });
  // NOT silence, and NOT an empty stream: a subscription that is quietly
  // never fed is indistinguishable from a review where nothing is happening.
});

it('refuses more than API_WS_MAX_SUBSCRIPTIONS, naming the cap', async () => { … });
it('closes a socket that does not answer two pings', async () => { … });
```

- [ ] **Step 2: Run and watch fail.** Add `@fastify/websocket` first. **Check its peer range against the shipped `fastify@^5.2.0` before installing**; if it refuses Fastify 5, stop and report rather than pinning an older Fastify — the branch is to use `ws` directly on the server's own `upgrade` event, which is more code and no new peer, and that is a decision to record rather than take silently.

- [ ] **Step 3: Implement, with replay before live**

The order is load-bearing and is the one thing a naive implementation gets wrong: **join the hub first, buffer what arrives, then replay from the cursor, then flush the buffer, then `caught_up`.** Replaying first and joining second drops every event that lands in between — a gap of exactly the width of the replay, invisible, and worst on the busiest review.

De-duplicate by id when the buffer overlaps the replay. The client's version guard would drop the duplicate anyway, and that is the point: **two independent guards, because this is the one place a dropped event leaves a human judgement on screen that the database does not hold** (§8).

- [ ] **Step 4: The hub holds no transport**

`hub.ts` knows about connections and subscriptions; `socket.ts` knows about frames and sockets; `feed.ts` (Task 18) knows about the outbox. Three files, three concerns, and the interface is what lets Task 18 change fan-out without touching either of the others — §8's *"the hub is written behind an interface either way, so the answer changes one implementation and no call sites."*

- [ ] **Step 5: Invert Part 4A's boundary guard (P30), add the caps and the divergence rows**

`stage4aDoD.test.ts`'s *"still polls — the socket is Task 16, not this part"* inverts to assert the socket exists and is registered. Add `API_WS_PING_MS`, `API_WS_MAX_CONNECTIONS`, `API_WS_MAX_SUBSCRIPTIONS`, `API_WS_MAX_FRAME_BYTES` to `config.ts` **and to `divergence.json` as `sameEverywhere`, in this commit**, or `configSurface.test.ts` fails in both directions.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm test && npm run build
git add apps/api/src/realtime apps/api/src/server.ts apps/api/src/main.ts apps/api/src/config.ts \
  apps/api/src/auth/routeTable.ts apps/api/package.json package-lock.json \
  packages/core/src/api/socket.ts packages/core/src/index.ts \
  apps/api/test/socket.pg.test.ts apps/api/test/socketAuth.test.ts apps/api/test/helpers/wsClient.ts \
  apps/api/test/authz.route.test.ts apps/api/test/configSurface.test.ts apps/api/test/divergence.json \
  apps/api/test/caps.test.ts apps/api/test/stage4aDoD.test.ts
git commit -m "feat: the WebSocket, authenticated before upgrade and replayed from the cursor"
git show --stat HEAD
```

---

## Task 17: The proxy hop — the handshake through nginx, and through Container Apps

**Type:** infrastructure, with a test that runs where the defect would be

**Files:**
- Modify: `infra/nginx/web.conf`
- Create: `apps/api/test/wsProxy.compose.test.ts`
- Modify: `apps/api/test/divergence.json` (the socket location is a row 9 divergence, not a new row)

**Interfaces:**
- Consumes: the shipped `location /api/` block and its comments. **Read them.** They record why the upstream is a variable, why `client_max_body_size` is 0, and why buffering is off for the streaming route — every one of which matters here.

**Why this is its own task.** The shipped block sets `proxy_http_version 1.1` and **no `Upgrade` or `Connection` header**, so a WebSocket handshake through it fails today. It fails at the *one hop local development can exercise*, which is exactly the class of defect Stage 1 shipped and fixed with `client_max_body_size` and which the file's own comments describe: *"an app that works in compose and is broken on the first click in Azure, at the one layer local development cannot exercise."* Here the layer *can* be exercised, so it is, in the container.

- [ ] **Step 1: The failing test, run through the proxy and not against `api`**

```ts
// apps/api/test/wsProxy.compose.test.ts
it('completes a WebSocket handshake through the web tier, on the browser s own origin', async () => {
  // localhost:3005 -- the PUBLISHED port. `api` publishes none by
  // construction (the internal network drops host traffic both ways), so a
  // test that connects to api directly proves nothing about what a browser
  // can do.
  const ws = new WebSocket('ws://localhost:3005/api/v1/ws', ['lexprompt.v1', `bearer.${token}`]);
  await expect(opened(ws)).resolves.toBe(true);
  expect(ws.protocol).toBe('lexprompt.v1');
});

it('holds the socket open past the proxy read timeout, on pings alone', async () => {
  // API_WS_PING_MS is 25s and nginx's shipped proxy_read_timeout is 600s, so
  // this is fine TODAY -- and it is asserted rather than assumed because the
  // relationship between two numbers in two files is exactly what silently
  // inverts when somebody tunes one of them. The caps table names both.
  await ws.idleFor(API_WS_PING_MS * 2 + 5_000);
  expect(ws.readyState).toBe(WebSocket.OPEN);
});
```

- [ ] **Step 2: Add the socket location, with its reasoning in the file**

```nginx
  # The WebSocket hop (Stage 4, §8). A SEPARATE location, before /api/, so
  # the upgrade headers apply to the socket and to nothing else -- adding
  # `Upgrade` to the whole /api/ block would set it on every ordinary
  # request, where `$http_upgrade` is empty and the resulting
  # `Connection: ""` header has bitten enough deployments to be folklore.
  #
  # `proxy_http_version 1.1` is already set below and is REQUIRED here:
  # HTTP/1.0 has no upgrade. The map for $connection_upgrade is the standard
  # form and is written out rather than referenced, because a reader of this
  # file should not have to know it.
  location /api/v1/ws {
    resolver ${NGINX_RESOLVER} valid=10s ipv6=off;
    set $api_upstream ${API_UPSTREAM};
    rewrite ^/api/(.*)$ /$1 break;
    proxy_pass http://$api_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    # Below API_WS_PING_MS this would kill every idle socket and the app
    # would look like a network with a fault. Declared in the caps table
    # beside the ping interval it must exceed.
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
```

- [ ] **Step 3: The Azure half, stated rather than tested**

`containerApps.bicep` already sets `transport: 'auto'` on the `web` ingress, which is what Container Apps needs for WebSockets, and `api`'s internal ingress is `transport: 'http'` — **check whether an internal ingress at `http` passes an upgrade**, and if the documentation is ambiguous, say so in the report rather than guessing. This is Spike 3's unanswered half and it stays named as such.

- [ ] **Step 4: Gates and commit**

```bash
npm run test:compose
git add infra/nginx/web.conf apps/api/test/wsProxy.compose.test.ts apps/api/test/divergence.json
git commit -m "fix: the web tier passes a WebSocket upgrade, proven through the proxy"
git show --stat HEAD
```

---

## Task 18: Fan-out across replicas — the outbox is the delivery, the notification is the doorbell

**Type:** feature. P39, and Task 14's failing test turns green.

**Files:**
- Create: `apps/api/src/realtime/feed.ts`, `apps/api/test/feed.pg.test.ts`
- Modify: `apps/api/src/realtime/hub.ts`, `apps/api/src/main.ts`, `apps/api/src/config.ts`
- Modify: `apps/api/src/run/events.ts` (the `pg_notify`, in the same transaction)
- Modify: `apps/api/test/replicaFanout.compose.test.ts` (un-skip it), `apps/api/test/divergence.json`, `apps/api/test/caps.test.ts`

**Interfaces:**
- Consumes: `readEvents` (Task 15), `Hub` (Task 16), `makePool` / `Db` (`apps/api/src/db/pool.ts`), `appendEvent`. **Read `pool.ts` before writing the listener** — a `LISTEN` issued on a pooled client is lost when the client returns to the pool, so the feed needs its own dedicated `pg.Client`, and that is a fact about `pg` rather than a preference.
- Produces:
  ```ts
  export interface EventFeed { start(): Promise<void>; stop(): Promise<void> }
  export function startEventFeed(deps: {
    db: Db; hub: Hub; listenerUrl: string; tickMs: number;
  }): EventFeed;
  ```

**The design, and why it needs no Redis (P39).** Every event is already written to `event` in the same transaction as the row it describes, already carries a monotonic id, and is already read by cursor. So each replica keeps one cursor per subscription it holds, and reads forward from the outbox. `pg_notify`, issued **in the same transaction as the insert**, wakes it immediately; a replica that misses a notification catches up on the next `API_HUB_TICK_MS` tick.

> **The notification is a doorbell, never a delivery.** Nothing that matters rides in the payload, so a lost notification costs latency and never content. That is the difference between this and a message bus, and it is what makes the mechanism correct without any delivery guarantee at all.

Presence is the exception and is Task 22's: it is never persisted (S6), so it has no outbox to read, and its payload *does* ride the notification. A lost presence beat is corrected by the next heartbeat within ten seconds, which is what a TTL is for.

- [ ] **Step 1: The failing tests**

```ts
it('delivers an event appended by another connection, within a tick, with no notification at all', async () => {
  // The notification is DISABLED for this test, deliberately: the tick alone
  // must be sufficient. If this only passes with notify on, the outbox is
  // not the delivery and a dropped LISTEN would be a silent hole.
  const feed = startEventFeed({ ...deps, notify: false, tickMs: 200 });
  await appendFromElsewhere();
  await expect(hub.delivered()).resolves.toHaveLength(1);
});

it('delivers within milliseconds when the notification arrives', async () => { … });

it('delivers each event exactly once across a notification and a tick', async () => {
  // The cursor is what makes this true. The mutation: advance the cursor
  // before publishing instead of after, and watch an event go missing under
  // a publish that throws.
});

it('recovers its listener when the connection drops, and says so', async () => {
  await killListenerConnection();
  await appendFromElsewhere();
  await expect(hub.delivered()).resolves.toHaveLength(1);   // via the tick, then the listener returns
  expect(logged()).toContain('event listener reconnected');
});
```

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- feed`.

- [ ] **Step 3: Implement, and put the `pg_notify` inside `appendEvent`**

Not beside it, not in the route: `appendEvent` is already the one writer, it already takes a `Tx`, and a `pg_notify` issued in the same transaction fires **on commit** and not before. A notification sent outside the transaction can wake a replica that then reads the outbox *before* the insert commits, finds nothing, and never comes back — a lost event that no test written against a single process would ever produce.

- [ ] **Step 4: Un-skip Task 14's test and watch it go green**

`npm run test:compose -- replicaFanout`, at two replicas. **Record the latency**, both with and without the notification — a number, in the report, exactly as Spike 1's brief demanded. If the tick-only latency is above about a second, say so: that is the floor a dropped listener degrades to, and a reviewer will feel it.

- [ ] **Step 5: The mutation that proves the fan-out is doing the work**

Replace `startEventFeed` with a no-op and confirm `replicaFanout.compose.test.ts` goes red — and confirm that the single-replica socket tests **stay green**, because they are served by the local hub. If they also go red, the hub and the feed are entangled and the interface §8 asks for is not really there.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm run test:compose
git add apps/api/src/realtime/feed.ts apps/api/src/realtime/hub.ts apps/api/src/run/events.ts \
  apps/api/src/main.ts apps/api/src/config.ts apps/api/test/feed.pg.test.ts \
  apps/api/test/replicaFanout.compose.test.ts apps/api/test/divergence.json apps/api/test/caps.test.ts
git commit -m "feat: fan-out reads the outbox by cursor; the notification is only a doorbell"
git show --stat HEAD
```

---

## Task 19: The browser's socket — one connection per tab, and `watchRun` keeps its signature

**Type:** feature. Stage 3's interface note 3, honoured.

**Files:**
- Create: `src/lib/api/socket.ts`, `src/lib/api/socket.test.ts`
- Modify: `src/lib/api/runs.ts`, `src/lib/api/runs.test.ts`, `src/App.tsx`
- Modify: `apps/api/test/stage4aDoD.test.ts` (invert the "still polls" guard)

**Interfaces:**
- Consumes: `ClientFrame` / `ServerFrame` (Task 16); `watchRun`'s shipped signature and its `WatchOptions` (`src/lib/api/runs.ts` — **read the whole file, including the comment saying Stage 4 replaces the transport inside this function and changes no caller**); the token source in `src/lib/auth/`. **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  export type ConnectionState = 'connecting' | 'live' | 'stale';
  export interface Subscription { close(): void }
  export function subscribe(sub: SubscriptionRef, handlers: {
    onEvent(e: AppEvent): void;
    onResync(): void;
    onPresence?(members: PresenceMember[]): void;
  }): Subscription;
  export function onConnectionState(fn: (s: ConnectionState) => void): () => void;
  export function closeSocket(): void;      // sign-out and tests
  ```

**One connection per tab, multiplexed** (§8). Not one per screen and not one per subscription: a review screen with a document viewer and an activity panel would otherwise hold three, each with its own backoff, each reporting its own staleness, and the user would see three different answers to "am I connected?".

- [ ] **Step 1: The failing tests, against a fake transport**

```ts
it('opens one socket for two subscriptions', async () => {
  subscribe({ review: 'r1' }, h1); subscribe({ matter: 'm1' }, h2);
  expect(fakeSockets.length).toBe(1);
});

it('re-subscribes every subscription with its own cursor after a reconnect', async () => {
  // The cursor is PER SUBSCRIPTION (§8: "the client keeps the highest id it
  // has applied, per subscription"). One shared cursor across two
  // subscriptions would replay one of them from the other's position, which
  // is a silent gap on the busier of the two.
  fakeSockets[0].drop();
  await flushUntil(() => fakeSockets.length === 2);
  expect(fakeSockets[1].sent).toEqual([
    { t: 'subscribe', sub: { review: 'r1' }, lastEventId: 7 },
    { t: 'subscribe', sub: { matter: 'm1' }, lastEventId: 2 },
  ]);
});

it('drops an event whose version is not newer than what it holds', async () => {
  // §8's idempotence rule -- what makes replay safe and makes your own
  // write's echo a no-op. The mutation: remove the guard and confirm this
  // fails; without it a reader watches a finding go from done back to
  // running on every reconnect.
});

it('backs off with jitter, and never spins', async () => { … });

it('reports the run s events through watchRun s existing callback shape', async () => {
  // The whole point of interface note 3: App.tsx does not change shape.
  const stop = watchRun('run-1', onEvent, onError);
  deliver({ type: 'finding.done', … });
  expect(onEvent).toHaveBeenCalled();
  stop();
});
```

- [ ] **Step 2: Run and watch fail.** `npx vitest run src/lib/api/socket.test.ts`.

- [ ] **Step 3: Implement, and keep `watchRun`'s signature exactly**

`watchRun(runId, onEvent, onError, options)` becomes a thin adapter over `subscribe({ run: runId }, …)`. Its `onResync` still fires; its three-strikes `onError` becomes connection-state-driven (Task 20). **`App.tsx`'s `attachRun` should need no change at all**; if it does, the adapter is not faithful and that is a finding to report before changing `App.tsx`.

- [ ] **Step 4: The token, and the sign-out path**

The socket authenticates with the access token in its subprotocol at connect time. **A token expiring mid-connection closes the socket**; the client refreshes and reconnects, which is the same path as any other drop. Do not attempt to re-authenticate a live socket — one path, exercised constantly, beats two of which one is exercised hourly.

`closeSocket()` on sign-out, or the next user's tab inherits the previous one's subscriptions.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/lib/api/socket.ts src/lib/api/socket.test.ts src/lib/api/runs.ts \
  src/lib/api/runs.test.ts src/App.tsx apps/api/test/stage4aDoD.test.ts
git commit -m "feat: one socket per tab, multiplexed, behind watchRun s existing signature"
git show --stat HEAD
```

---

## Task 20: The fourth load state — stale, and the controls that go dead when it arrives

**Type:** feature. §3's fourth state, §8's safety rule, and §19's *"the defect this design is most likely to ship in the app"*. P42.

**Files:**
- Create: `src/components/StalePanel.tsx` and its test
- Modify: `src/lib/loadError.ts`, `src/lib/loadError.test.ts`, `src/components/LoadErrorPanel.tsx`
- Modify: `src/features/review/VerificationControls.tsx` and its test, `src/features/review/FindingCard.tsx`, `src/features/review/NetPositionPanel.tsx`, `src/features/review/NotesPanel.tsx`
- Modify: `src/App.tsx`, `src/index.css`

**Interfaces:**
- Consumes: `onConnectionState` (Task 19); `describeLoadError` (`src/lib/loadError.ts` — **read it; it is a function over an error, and `stale` is not an error**, so the addition is a sibling rather than a new branch inside it); `VerificationControlsProps` (which already has `busy`). **Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: `VerificationControlsProps` gains `stale?: boolean`; `LoadErrorPanelProps` unchanged; `StalePanel` is new and separate.

**Why `stale` is not `busy`, and why the controls say why.** `busy` means *your* write is in flight and will land. `stale` means the app cannot vouch for what is on screen, and a change submitted against a version that may be minutes old **would be refused anyway** (§8). Rendering the two identically would tell a reviewer to wait for something that is not coming. Two attributes, two sentences.

**And why it is disabled rather than hidden.** A hidden control is indistinguishable from a finding that cannot be verified — the `isVerifiable` case, which already hides them. Disabled-with-a-reason is the only rendering that says *"you may do this, but not right now, and here is why."*

- [ ] **Step 1: The failing tests**

```tsx
it('disables every disposition control while stale, and says why', () => {
  const { container } = mountOnce(<VerificationControls verification={unchecked()} stale onChange={noop} />);
  for (const b of container.querySelectorAll('button')) expect(b.disabled).toBe(true);
  expect(container.textContent).toContain('LexPrompt has lost touch with this review');
  expect(container.textContent).toContain('Your judgement would not be saved');
});

it('distinguishes stale from busy, in the words as well as the attribute', () => {
  const busy = mountOnce(<VerificationControls verification={unchecked()} busy onChange={noop} />);
  expect(busy.container.textContent).not.toContain('lost touch');
});

it('renders stale, broken, empty and in-flight as four distinct things', () => {
  // §3, and `loadStates` in §14. The mutation: make the stale branch fall
  // through to LoadErrorPanel and confirm this fails -- "stale" is not
  // "broken", and a reviewer told the review failed to load will reload a
  // review that is fine.
  expect(new Set([renderOf('loading'), renderOf('error'), renderOf('empty'), renderOf('stale')]).size).toBe(4);
});

it('says it is refreshing during a resync, and stops saying it afterwards', async () => {
  emit('resync');
  await flushUntil(() => text().includes('Reconnecting - refreshing this review'));
  emit('live');
  await flushUntil(() => !text().includes('Reconnecting'));
});

it('keeps the findings on screen while stale, rather than blanking them', () => {
  // Blanking is the OTHER failure: a reviewer who loses their place because
  // the wifi blinked. The rule is "never show disconnected data AS THOUGH IT
  // WERE CURRENT", not "show nothing".
  expect(container.querySelectorAll('[data-finding]').length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement, with a persistent non-modal indicator**

§8: *"a persistent, non-modal stale indicator."* Non-modal because a reviewer reading a finding must be able to keep reading it; persistent because a toast that fades leaves the app looking normal while it is not — which is the entire defect §19 names.

Add the colour role to `src/index.css` **in this commit** if none fits. `--color-risk-med` is amber and already means "attention, not failure", which is what stale is; use it rather than minting a role for one banner, and say in the report which you chose and why. A new role goes in `index.css` in the same commit that first uses it, never after.

- [ ] **Step 4: Every human-authored write goes dead, not just the disposition**

Notes and net-position confirmations are human-authored state too (§3's list is explicit: *"not for a disposition change, a note, a net-position confirmation, or an assignment"*). All of them, one flag, one sentence.

- [ ] **Step 5: The threshold, and why it is not "on close"**

`stale` on two unanswered pings (`WS_STALE_AFTER_MS`), not on the first `close` event: a socket that closes and reconnects inside 300 ms would otherwise flash a banner at a reviewer for no reason, and a banner that appears spuriously is a banner people learn to ignore — which is how this state gets shipped and then ignored, arriving at §19's outcome by a different road.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/components/StalePanel.tsx src/components/StalePanel.test.tsx \
  src/lib/loadError.ts src/lib/loadError.test.ts src/components/LoadErrorPanel.tsx \
  src/features/review/VerificationControls.tsx src/features/review/VerificationControls.test.tsx \
  src/features/review/FindingCard.tsx src/features/review/NetPositionPanel.tsx \
  src/features/review/NotesPanel.tsx src/App.tsx src/index.css
git commit -m "feat: the fourth load state, and the controls a stale client must not offer"
git show --stat HEAD
```

---

## Task 21: Someone else's write arrives, and the card changes without a reload

**Type:** feature. **§18 item 5's headline clause**, and the one task in Part 4B that may not be cut.

**Files:**
- Modify: `src/App.tsx` (the push handler), `src/lib/api/findings.ts`
- Modify: `src/features/review/pendingUpdate.ts` (the push path calls Task 8's guard — **it does not get a second copy**)
- Create: `src/App.livePush.test.tsx`
- Create: `apps/api/test/livePush.compose.test.ts`

**Interfaces:**
- Consumes: `subscribe` (Task 19); `DispositionChangedPayload` / `NoteAddedPayload` (Task 15); `mayApplyNow` (Task 8); `applyToFinding` / `humanWritesRef` / `refreshFindings` (`src/App.tsx`); `dispositionVersionFor` (`src/lib/api/findings.ts`). **Read all of them. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces: no new exported type. This task is where five existing pieces are wired together, and the absence of a new abstraction is deliberate.

**The five rules this handler obeys, each of which is a defect if dropped:**

1. **Version guard first.** An event whose `version` is not newer than what the client holds is **dropped** (§8). That is what makes replay safe, makes your own write's echo a no-op, and makes out-of-order delivery survivable. It is one comparison and it is the load-bearing line in the file.
2. **Apply from the payload, not by re-fetching.** §8 says the payload carries the whole new disposition row **and** the event that produced it, precisely so *"was Rejected"* is on hand without a second query. A handler that re-fetches on every push turns a forty-cell run into forty reads and will be optimised away later, taking the sentence with it.
3. **Never over a decision in progress.** `mayApplyNow` (Task 8) — the same function, not a second copy.
4. **A note arrives as a note.** `note.added` appends; it never replaces the notes array from a stale local copy.
5. **A `run.*` event still routes to `refreshFindings`**, exactly as it does today. The engine's events describe the model's output; the disposition events describe a person's judgement. They arrive on one socket and they are applied by two paths, because they are two kinds of fact.

- [ ] **Step 1: The failing component test — the trainee's card, and the partner's name on it**

```tsx
// src/App.livePush.test.tsx
it('shows the partner s name and time on the trainee s open card, with no reload', async () => {
  const { container } = await openReviewAs(trainee);
  expect(container.textContent).toContain('Verified by A. Trainee, 15:12');

  deliver({ type: 'finding.disposition_changed', payload: {
    reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', version: 2,
    disposition: { state: 'rejected', byUserId: 'u2', at: T_1604, changedCount: 2, … },
    event: { fromState: 'verified', toState: 'rejected', cause: 'human', byUserId: 'u2', at: T_1604, … },
  }});

  await flushUntil(() => container.textContent!.includes('Rejected by R. Okafor'));
  expect(container.textContent).toContain('Rejected by R. Okafor, 16:04 - was Verified');
  expect(fetchCalls()).toHaveLength(0);      // rule 2: no re-fetch
});

it('drops an event whose version is not newer, including the echo of your own write', async () => {
  await verifyAs(trainee);                    // renders from the HTTP response, version 2
  deliver(sameChangeAtVersion(2));
  // No flicker: the assertion is that the rendered text never changed, which
  // a spy on the state setter proves and a text comparison does not.
  expect(renderCount()).toBe(before);
});

it('holds a push while the reject-reason modal is open, and applies it on close', async () => { … });

it('appends an arriving note rather than replacing the list', async () => { … });
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: The compose test — two real sockets, two real people**

```ts
// apps/api/test/livePush.compose.test.ts
it('reaches a second person s socket within a second of the first person s write', async () => {
  const { trainee, partner } = await twoAccounts();
  const socket = await connect(trainee.token);
  socket.send({ t: 'subscribe', sub: { review: R }, lastEventId: 0 });
  await socket.waitFor('caught_up');

  const started = Date.now();
  await put(partner, DISPOSITION_URL, { state: 'rejected', reason: 'Cap is uncapped', version: 1 });
  const frame = await socket.waitFor('finding.disposition_changed', { timeoutMs: 5_000 });

  expect(frame.event.payload.disposition.byUserId).toBe(partner.userId);
  expect(frame.event.payload.event.fromState).toBe('verified');
  // A NUMBER in the report, not an impression. §18.5 says "immediately", and
  // the only honest thing a test can say about that word is how long it took.
  report(`disposition push latency: ${Date.now() - started} ms`);
});
```

**This test plus Task 5's render test are, together, the whole of what can be claimed for §18 item 5's headline clause without a browser.** Task 26 says so in those words.

- [ ] **Step 4: The mutation that matters**

Remove the version guard and confirm *"drops an event whose version is not newer"* goes red. Restore. Then remove the `mayApplyNow` call and confirm the modal test goes red. Two guards, two mutations, both named.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm test && npm run test:compose
git add src/App.tsx src/App.livePush.test.tsx src/lib/api/findings.ts \
  src/features/review/pendingUpdate.ts apps/api/test/livePush.compose.test.ts
git commit -m "feat: another person s change reaches the card, attributed, without a reload"
git show --stat HEAD
```

---

## Task 22: Presence — ephemeral, advisory, and gone within its TTL

**Type:** feature. §8's heartbeat, S6.

**Files:**
- Create: `apps/api/src/realtime/presence.ts`, `apps/api/test/presence.pg.test.ts`, `apps/api/test/presence.compose.test.ts`
- Modify: `apps/api/src/realtime/socket.ts`, `apps/api/src/realtime/feed.ts`, `apps/api/src/config.ts`
- Modify: `apps/api/test/configSurface.test.ts`, `apps/api/test/divergence.json`, `apps/api/test/caps.test.ts`, `apps/api/test/stage4aDoD.test.ts` (invert the "no presence yet" guard)

**Interfaces:**
- Consumes: `Hub`, `Connection`, `ClientFrame`/`ServerFrame` (Task 16); the `pg_notify` channel (Task 18) — **presence rides the notification payload, which is the one place it does**, because presence has no outbox to read from and `NOTIFY` stores nothing.
- Produces:
  ```ts
  export interface PresenceMember {
    userId: string; initials: string;
    /** Which screen they are on, coarse: 'review' | 'matter' | 'playbook'. */
    screen: string;
    /** The clause they are looking at, when they are looking at one (§8). */
    clauseId?: string;
    /** When their last heartbeat arrived. The client renders nothing from
     *  this; it exists so a roster can be reasoned about in a test. */
    at: number;
  }
  export interface PresenceRegistry {
    beat(m: PresenceMember, sub: SubscriptionRef): void;
    leave(userId: string, sub: SubscriptionRef): void;
    roster(sub: SubscriptionRef): PresenceMember[];
    sweep(now: number): SubscriptionRef[];   // the subs whose roster changed
  }
  ```

**Never persisted, and the test says so rather than the comment** (S6). *"A stale 'Priya is here' row surviving a crash is a lie the app would tell indefinitely."* And **advisory**: it locks nothing, blocks nothing, gates no write. Its whole job is to let two people see each other and not collide.

- [ ] **Step 1: The failing tests**

```ts
it('drops a member whose last beat is older than the TTL, and broadcasts the change', async () => {
  registry.beat(priya, SUB);
  registry.sweep(now + API_PRESENCE_TTL_MS + 1);
  expect(registry.roster(SUB)).toEqual([]);
  expect(broadcasts()).toContainEqual({ t: 'presence', sub: SUB, members: [] });
  // The mutation: raise the TTL to Infinity and confirm this fails. A roster
  // that never expires claims a colleague is present forever, which is the
  // exact lie S6 exists to prevent -- and it looks completely normal.
});

it('writes presence nowhere — not Postgres, not the blob store', () => {
  const code = codeOf('apps/api/src/realtime/presence.ts');
  expect(code).not.toMatch(/insert into|update |blobStore|upload/i);
  expect(code).toMatch(/roster/);           // the sanity check, or an empty file passes
});

it('has no presence row anywhere in the database after a session', async () => {
  await runAPresenceSession();
  const tables = await db.query(
    "select tablename from pg_tables where schemaname = 'public' and tablename ilike '%presence%'");
  expect(tables).toEqual([]);
});

it('gates no write: a disposition change succeeds while another person is present on that clause', async () => {
  // The assertion that keeps presence advisory. Somebody will eventually
  // propose "warn before overwriting while another person is on the clause",
  // and the day that becomes a REFUSAL is the day presence stops being
  // advisory. This test is what makes that a deliberate change.
  registry.beat(priya, SUB);
  await expect(put(partner, DISPOSITION_URL, { state: 'rejected', reason: 'x', version: 1 }))
    .resolves.toMatchObject({ status: 200 });
});

it('is gone from every replica s roster within the TTL after a socket closes', async () => { … });
```

- [ ] **Step 2: Run and watch fail.** `npm run test:pg -- presence`.

- [ ] **Step 3: Implement, in memory, with a sweeper**

10-second heartbeat, 15-second TTL (§8), both from `config.ts` and both in the caps table. The roster broadcasts **on change only** — a broadcast every heartbeat would be one frame per person per ten seconds per subscription for a roster that has not moved.

Across replicas, a beat is published on the notification channel and each replica merges it into its own view. **A replica that misses a beat loses that person from its roster for at most one TTL and gets them back on the next beat** — the correct failure for an advisory signal, and it is why presence is the one thing allowed to ride the notification payload.

- [ ] **Step 4: Gates and commit**

```bash
npm run typecheck && npm run test:pg && npm run test:compose
git add apps/api/src/realtime/presence.ts apps/api/src/realtime/socket.ts \
  apps/api/src/realtime/feed.ts apps/api/src/config.ts \
  apps/api/test/presence.pg.test.ts apps/api/test/presence.compose.test.ts \
  apps/api/test/configSurface.test.ts apps/api/test/divergence.json apps/api/test/caps.test.ts \
  apps/api/test/stage4aDoD.test.ts
git commit -m "feat: presence, ephemeral by construction and advisory by rule"
git show --stat HEAD
```

---

## Task 23: Who else is here, on screen and down to the clause

**Type:** feature. The `CLAUDE.md` clause about the header avatar becomes false here, and is edited here.

**Files:**
- Create: `src/components/PresenceRoster.tsx` and its test
- Modify: `src/lib/api/socket.ts` (the heartbeat), `src/App.tsx`, `src/features/review/ResultsView.tsx`, `src/features/review/ClauseIndex.tsx`, `src/index.css`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `onPresence` (Task 19), `PresenceMember` (Task 22), `userName` / `userInitials` (Task 2). **Read the header component that renders the local profile's initials — find it before writing; it is the thing this task changes the meaning of.**
- Produces: `PresenceRosterProps { members: PresenceMember[]; audience: DispositionAudience }`.

- [ ] **Step 1: The failing tests**

```tsx
it('shows a colleague s initials, and never your own', async () => {
  // You already know you are here. A roster that includes you is a roster
  // that is always non-empty, which makes "is anyone else here?" unanswerable
  // at a glance -- the one question it exists to answer.
  expect(text()).toContain('RO');
  expect(text()).not.toContain(myInitials);
});

it('marks the clause a colleague is looking at', async () => {
  expect(clauseRow('c14').querySelector('[data-presence]')).not.toBeNull();
});

it('shows nobody when the roster is empty, rather than a placeholder', async () => {
  expect(container.querySelector('[data-presence-roster]')).toBeNull();
});

it('names an unknown user id as unknown, never as a raw id', async () => {
  expect(text()).not.toContain(strangerId);
});

it('stops claiming somebody is here once the roster says they are not', async () => {
  emitPresence([]);
  await flushUntil(() => container.querySelector('[data-presence]') === null);
  // A presence indicator that is stale must not claim someone is there. The
  // client renders the SERVER's roster and never its own last known one.
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement, with the class map written out**

Presence needs a colour role. Add it to `src/index.css` **in this commit** — `--color-presence` and `--color-presence-tint` — and map the complete class strings in a `Record`. Do not build `bg-presence-${…}` by interpolation: the utility would never be generated and the dot would render invisible with no error and no failing test.

- [ ] **Step 4: The heartbeat, and what it carries**

`{ userId, initials, screen, clauseId? }` every `API_PRESENCE_HEARTBEAT_MS`, from the client, on the socket it already has. `clauseId` is the clause the reader has **selected**, not the one nearest the top of the viewport: a scroll-derived presence would broadcast a stream of clause changes and would tell a colleague something the reader never chose to say.

- [ ] **Step 5: Edit `CLAUDE.md`, in this commit (P38)**

The sentence *"the header avatar shows the local profile's own initials, never a stranger's"* becomes:

> **As of Stage 4 other people appear on screen, because there are other people.** The header avatar is still your own; what is new is the presence roster on a review — a colleague's initials while they are connected, and a marker on the clause they have selected. Presence is **never persisted, locks nothing, blocks nothing and gates no write** (S6): it exists so two people can see each other and not collide. It expires on a 15-second TTL, and a client renders the server's roster rather than its own last known one — a presence indicator that is stale must not claim someone is there.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/components/PresenceRoster.tsx src/components/PresenceRoster.test.tsx \
  src/lib/api/socket.ts src/App.tsx src/features/review/ResultsView.tsx \
  src/features/review/ClauseIndex.tsx src/index.css CLAUDE.md
git commit -m "feat: who else is here, down to the clause"
git show --stat HEAD
```

---

## Task 24: The `assignment` table and its routes

**Type:** feature. S17's replacement for `Verification.assigneeId`, which Stage 3 dropped (P24).

**Files:**
- Create: `apps/api/migrations/012_assignment.sql`, `apps/api/src/routes/assignments.ts`, `apps/api/test/assignments.pg.test.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/auth/routeTable.ts`, `apps/api/test/authz.route.test.ts`, `apps/api/test/grants.pg.test.ts`
- Modify: `packages/core/src/api/records.ts`, `packages/core/src/index.ts`
- Modify: `apps/api/test/stage4aDoD.test.ts` (invert the "no assignment yet" guard)

**Interfaces:**
- Consumes: §6.3's `assignment` shape; `FindingKey` (`apps/api/src/findings/rows.ts`); `appendAudit` (Task 11); `appendEvent` (Task 15); the grant idiom in `005`–`011`. **Read `006_dispositions.sql` for how a table keyed by `(review_id, findings_key, clause_id)` is declared and constrained here. Where the shipped source disagrees with this brief, the shipped source wins.**
- Produces:
  ```ts
  export interface AssignmentView {
    id: string; reviewId: string; findingsKey: string; clauseId: string;
    assigneeUserId: string; assignedByUserId: string;
    message?: string; createdAt: number;
    resolvedAt?: number; resolvedByUserId?: string;
  }
  ```
  Routes: `POST /v1/reviews/:id/findings/:findingsKey/:clauseId/assignments`; `POST /v1/assignments/:id/resolve`; `GET /v1/assignments?state=open` (the assignee's own).

**An assignment is a request, not a disposition** (§6.3). *"Overriding a disposition and asking someone to check one are different acts, and the app keeps them different."* So: assigning changes no disposition, writes no `finding_disposition_event`, and clears nothing. It is the trainee's escape hatch — verify the ones you are sure of, hand the rest to someone who can decide — and that is the owner's own framing.

- [ ] **Step 1: The migration**

```sql
-- 012_assignment.sql — §6.3, S17.
create table assignment (
  id                  text primary key,
  review_id           text not null,
  findings_key        text not null,
  clause_id           text not null,
  workspace_id        uuid not null references workspace(id),
  assignee_user_id    uuid not null references app_user(id),
  assigned_by_user_id uuid not null references app_user(id),
  message             text,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by_user_id uuid references app_user(id),
  foreign key (review_id, findings_key, clause_id)
    references finding (review_id, findings_key, clause_id) on delete cascade,
  -- Resolution is a pair or neither. A resolved_at with no resolver is an
  -- assignment that closed itself, which nothing does.
  check ((resolved_at is null) = (resolved_by_user_id is null))
);

-- ONE OPEN ASSIGNMENT PER FINDING PER ASSIGNEE. Not one per finding: two
-- people can each be asked to look at the same clause, and the day that is
-- true a unique constraint on the finding alone would refuse the second
-- request with a constraint name.
create unique index assignment_open_idx
  on assignment (review_id, findings_key, clause_id, assignee_user_id)
  where resolved_at is null;

create index assignment_assignee_idx
  on assignment (workspace_id, assignee_user_id, created_at desc) where resolved_at is null;

grant select, insert, update on assignment to lexprompt_app;
-- The worker gets nothing. It performs no act that assigns anything, and a
-- grant it does not need is a grant nobody notices becoming load-bearing.
```

- [ ] **Step 2: The failing tests, including the refusals**

```ts
it('refuses an assignee who is not in this workspace', async () => { … });
it('refuses an assignment to a finding this review does not cover', async () => { … });
it('refuses a second OPEN assignment to the same person for the same clause', async () => {
  await expect(assign(partner)).rejects.toMatchObject({ status: 409 });
});
it('allows a second open assignment to a DIFFERENT person', async () => { … });
it('changes no disposition, and writes no disposition event', async () => {
  const before = await readHistory(db, KEY);
  await assign(partner);
  expect(await readHistory(db, KEY)).toEqual(before);
  expect((await readDisposition(db, KEY)).version).toBe(before.version);
  // §6.3: "a request, not a disposition". This is the assertion that keeps
  // the two acts apart, and it is the one a later "assign and flag in one
  // click" feature would quietly break.
});
it('records the assignment in audit_event, since it is an act with no other record', async () => {
  // Unlike a disposition change (S22), an assignment has no append-only log
  // of its own — the row is mutable (it resolves). So it belongs in the
  // audit log, and that asymmetry is deliberate.
  expect(await auditRowsFor('assignment.created')).toHaveLength(1);
});
it('lets the assignee resolve it, and lets the assigner withdraw it', async () => { … });
```

- [ ] **Step 3: `ROUTE_POLICY`, with its reasoning**

```ts
  // Asking a colleague to look at a clause is a request, not a disposition
  // (§6.3), so it sits at the same `reviewer` bar as the disposition it does
  // NOT change. A partner-only gate here would invert the owner's own case:
  // it is the TRAINEE who assigns, when they are not sure.
  'POST /v1/reviews/:id/findings/:findingsKey/:clauseId/assignments': 'reviewer',
  'POST /v1/assignments/:id/resolve': 'reviewer',
  'GET /v1/assignments': 'reviewer',
```

- [ ] **Step 4: Gates and commit**

```bash
npm run test:pg && npm run typecheck && npm test
git add apps/api/migrations/012_assignment.sql apps/api/src/routes/assignments.ts \
  apps/api/src/server.ts apps/api/src/auth/routeTable.ts \
  apps/api/test/assignments.pg.test.ts apps/api/test/authz.route.test.ts \
  apps/api/test/grants.pg.test.ts apps/api/test/stage4aDoD.test.ts \
  packages/core/src/api/records.ts packages/core/src/index.ts
git commit -m "feat: the assignment table — a request, and never a disposition"
git show --stat HEAD
```

---

## Task 25: An assignment reaches a person

**Type:** feature. §18 item 5's last clause, and the owner's trainee-and-partner story, end to end.

**Files:**
- Create: `src/features/assignments/AssignPanel.tsx`, `src/features/assignments/AssignedToMe.tsx` and their tests
- Create: `src/lib/api/assignments.ts`
- Modify: `src/features/review/FindingCard.tsx`, `src/App.tsx`
- Create: `apps/api/test/assignmentReaches.compose.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the three routes (Task 24); `subscribe` and `assignment.created` / `assignment.resolved` (Tasks 15, 19); `userName` (Task 2); `Modal`.
- Produces: no new shared type.

**What this ships, and what it deliberately does not.** §13 puts *"assignee chips, 'assigned to me', actors in the feed"* in **Stage 5**, and §18 item 5 requires *"an assignment reaches the assignee"* in **Stage 4**. Those two sentences overlap, and this plan rules between them (recorded in Task 26's spec-versus-spec list):

- **Stage 4 ships:** the assign action on a finding; the assignment's own record; a push to the assignee; and a place the assignee can see what has been asked of them **within the review they are in**.
- **Stage 5 keeps:** the assignee **chip** on a card in a list, the **"assigned to me" counter** on the home screen, and firm-wide search — all of which are cross-matter aggregations over a mechanism that now exists. S18 binds until the mechanism is real; the mechanism is real as of Task 24, and the aggregations are still Stage 5 because they are a different screen, not a different truth.

- [ ] **Step 1: The failing tests**

```tsx
it('lets a reviewer flag a clause and hand it to a colleague in one flow', async () => {
  // The owner's own sentence: "a trainee verifies one clause and is happy;
  // they flag another for a partner and assign it." Two acts, deliberately
  // two clicks, because they are two different facts (§6.3) — but reachable
  // from the same place, because they are one intention.
  click(flagButton); await flushUntil(() => text().includes('Flagged by'));
  click(assignButton); type(messageField, 'Not sure the cap survives 14.2.');
  click(pick('R. Okafor')); click(submit);
  await flushUntil(() => text().includes('Asked R. Okafor to look at this'));
});

it('never assigns without an assignee, and says which field is missing', async () => { … });

it('shows the assigner and the message to the assignee, not just a badge', async () => {
  // "R. Okafor asked you to look at this" plus the message. A bare marker
  // makes the assignee open every clause to find out what was wanted.
  expect(text()).toContain('A. Trainee asked you to look at this');
  expect(text()).toContain('Not sure the cap survives 14.2.');
});

it('is disabled while the client is stale, like every other human-authored write', async () => {
  // §3's list names an assignment explicitly.
});
```

- [ ] **Step 2: The compose test — it reaches the other person**

```ts
it('reaches the assignee s open socket, and their list, within a second', async () => {
  const socket = await connect(partner.token);
  socket.send({ t: 'subscribe', sub: { review: R }, lastEventId: 0 });
  await socket.waitFor('caught_up');
  await assign(trainee, { assignee: partner.userId, message: 'Not sure the cap survives 14.2.' });
  const frame = await socket.waitFor('assignment.created', { timeoutMs: 5_000 });
  expect(frame.event.payload.assignedByUserId).toBe(trainee.userId);
  expect((await get(partner, '/v1/assignments?state=open')).assignments).toHaveLength(1);
});
```

- [ ] **Step 3: Implement, and keep flag and assign two acts**

Flagging records a judgement about the answer; assigning asks a person to look. Doing both in one click would write a disposition the person may not have meant, and §6.3 keeps the acts apart on purpose. Reachable from one panel; recorded as two facts.

- [ ] **Step 4: Edit `CLAUDE.md`, in this commit (P38)**

The clause *"there is no assignee chip, no assign action, no firm tag, and no 'assigned to me' counter anywhere"* becomes:

> **As of Stage 4 there is an assign action, because assignment now reaches a real person with a real account.** A reviewer can ask a colleague to look at a clause, with a message; the request is a row in `assignment` with an assigner, a time and a resolution (S17), it reaches the assignee over the socket, and **it changes no disposition** — asking someone to check something and overriding their judgement are different acts and the app keeps them different (§6.3). Still **not** built, and still Stage 5 (S18): the assignee **chip** on a card in a list, the **"assigned to me"** counter, and firm-wide search. Still deferred: `⌘K` (R-G14) and the Report tab (R-G11). There is still no firm tag.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm test && npm run build && npm run test:compose
git add src/features/assignments src/lib/api/assignments.ts src/features/review/FindingCard.tsx \
  src/App.tsx apps/api/test/assignmentReaches.compose.test.ts CLAUDE.md
git commit -m "feat: an assignment reaches the person it was addressed to"
git show --stat HEAD
```

---

## Task 26: Stage 4's definition of done, the rulings, and what Stage 5 inherits

**Type:** verification and documentation

**Files:**
- Create: `apps/api/test/stage4DoD.test.ts`, `apps/api/test/stage4DoD.compose.test.ts`
- Modify: `README.md`, `docs/superpowers/redesign/rulings.md`, `CLAUDE.md`
- Create: `.superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/stage-4-report.md`

- [ ] **Step 1: §18 item 5, clause by clause, in the three categories P44 requires**

```ts
it('pushes a disposition change to a second person s socket, attributed', async () => { /* Task 21, re-run */ });
it('refuses a stale change, shows what replaced it, and offers it again', async () => { /* Task 7, re-run */ });
it('shows no disposition anywhere without its actor and its time', () => {
  expect(componentsRenderingRawState().filter(f => f !== 'src/components/StateChip.tsx')).toEqual([]);
  expect(componentsScanned()).toBeGreaterThan(20);        // sanity
});
it('stamps every export with the instant its dispositions were read', async () => { /* Task 9, over bytes */ });
it('disables a stale client s disposition controls', () => { /* Task 20, re-run */ });
it('delivers an assignment to its assignee', async () => { /* Task 25, re-run */ });

it('has one version number doing both jobs, not two', () => {
  // §8: "the stale-change refusal and the realtime version guard are the same
  // number doing two jobs, and they must not be allowed to become two
  // numbers." The scanner: no source declares a second version field on a
  // disposition shape.
  expect(grepRepo(/dispositionVersion2|pushVersion|liveVersion/)).toEqual([]);
  expect(grepRepo(/dispositionVersions/).length).toBeGreaterThan(3);   // sanity
});

it('writes no disposition change into audit_event (S22)', () => { /* Task 13, re-run */ });
it('persists no presence anywhere (S6)', async () => { /* Task 22, re-run */ });
it('has no authentication bypass, on the socket either (S29)', () => { /* Task 16, re-run */ });
```

- [ ] **Step 2: The live pass, with two accounts, results written down**

The whole of Part 4A's gate (Task 13 Step 2), plus: two sockets on two replicas; a disposition change on one reaching the other, with its latency **as a number**; a note; an assignment; presence appearing and expiring; the socket surviving a `docker compose restart api` and resubscribing from its cursor; a client whose socket is severed showing stale and recovering; and `docker compose exec api sh -lc 'wget -qO- --timeout=3 https://example.com'` **still failing**, because a new dependency arrived this stage and §5's central claim is a network fact that is re-checked rather than inherited.

- [ ] **Step 3: The README**

Replace what is no longer true and add what a reader now needs: a disposition can be changed by any reviewer at any time and every change is recorded with who and when; a card names the person who set the state it shows; an export states the instant it was true and that it can change; changes and presence arrive live and a disconnected client says so and stops offering to change anything; an assignment is a request that reaches a colleague and changes no judgement; **and `audit_event` now exists, so P23's disclosure changes** — run starts and cancels from before this release are on the `run` row and not in the append-only log, and an audit export covering that period says where its run history came from. Keep that sentence; do not delete it because the table now exists. The gap is historical and permanent.

- [ ] **Step 4: The rulings**

Into `rulings.md`, in its established format, in a section for this stage: **P29–P44 as executed**, with any that changed recorded as amended-with-a-dated-note rather than edited away; **every ruling an implementer took mid-task**, with its cost; and the disagreements below.

- [ ] **Step 5: The disagreements, recorded rather than smoothed**

1. **§8 says fan-out is in-process "while `api` runs as a single replica"; the shipped Bicep scales `api` to three.** Stage 3's P27 repeated the single-replica premise. Resolved by P39 and P41: the fan-out is replica-safe, and `maxReplicas` is pinned deliberately. **A genuine gap between the spec and the shipped infrastructure, not a misreading.**
2. **§8 says the finding read returns the current disposition and its most recent event; the shipped read returns neither.** Resolved in Task 3. A reader of §8 alone would have believed it already worked.
3. **§6.3 requires every disposition to name its actor; the API has no route that resolves another user's name.** Resolved by P32's directory.
4. **§13 puts "actors in the feed" in Stage 5, while §13's own Stage 4 paragraph puts the feed reading `audit_event` and `finding_disposition_event` in Stage 4.** A feed that queries those tables and discards the actor column would be a feed built to be incomplete, and §6.3's attribution requirement is unqualified. **Ruled for Stage 4** (Task 12). Stage 5 keeps the chips, the counters and firm-wide search.
5. **§13's Stage 5 list says "assignee chips" while §18 item 5 requires an assignment to reach its assignee in Stage 4.** Ruled in Task 25: the action, the record and the delivery are Stage 4; the chip and the counter are Stage 5.
6. **§8's `matter:{id}` subscription has no data behind it** — the `event` table's `matter_id` was never populated. Fixed in Task 15 rather than worked around.
7. **§14 requires MSW for the App tests' "DB mock becomes an HTTP-and-WebSocket mock"; this plan uses a fake transport instead.** The socket client's seam (`subscribe`) is narrower than a WebSocket and MSW's socket support would be a second thing to keep true. **Recorded as a deviation**; if a later stage adds MSW for HTTP, the socket fake stays.
8. **§20's estimate does not carry Spike 3's local infrastructure or the two-account harness.** Recorded in the scope check at the top of this plan, and in the report as the reason this stage ran at the top of its band.

- [ ] **Step 6: What only a human at a browser can confirm — the list, not an apology**

Browser automation has been unavailable for this whole project (the Chrome extension disconnects; the Playwright MCP times out). These need a person, and they are named rather than implied:

1. Two browser profiles, two accounts, one review: the trainee's card visibly changing attribution when the partner overrides, with no reload. **This is §18 item 5's headline clause and only its mechanism has been proven.**
2. Presence: a colleague appearing, appearing on a clause, and going within the TTL.
3. The stale banner appearing on a cut network, the controls going dead, and the recovery reading as a recovery.
4. Whether a live update arriving mid-scroll is disruptive, and whether the "changed while you were writing" notice is noticed.
5. The refusal notice: whether a reviewer understands what happened and what the re-apply button will do.
6. The deployed two-account pass (§18 item 9), Entra's group claim and its overage case.
7. Container Apps ingress behaviour for a long-lived WebSocket (Spike 3's unanswered half), and Spike 2's Azure half, both still open.

**If they cannot be done, say so plainly rather than implying they were** — `CLAUDE.md`'s rule, and it applies to this report as much as to any other.

- [ ] **Step 7: Commit**

```bash
git add apps/api/test/stage4DoD.test.ts apps/api/test/stage4DoD.compose.test.ts \
  README.md docs/superpowers/redesign/rulings.md CLAUDE.md \
  .superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/stage-4-report.md
git commit -m "test: Stage 4 s definition of done, and the rulings it took"
git show --stat HEAD
```

---

## Interfaces Stage 5 and later must honour

Recorded here so a later stage extends rather than duplicates. Each is a thing this stage built that a later one will be tempted to build again.

1. **`finding_disposition.version` is still one number doing two jobs** — the stale-change refusal and the realtime version guard (§8). Stage 5 must not add a second.
2. **`dispositionLabel` / `dispositionHistoryLine` in `src/lib/findingOutcome.ts` are the only place disposition wording lives**, beside `verificationLabel` and `exportSummaryLine`. Five callers already; a sixth calls them rather than composing a string.
3. **`src/lib/api/users.ts` is the only id→name resolver.** An event payload never carries a display name (P32). An assignee chip resolves through the directory like everything else.
4. **The event vocabulary is `packages/core`'s and there are nine types.** Adding one adds it to `EVENT_TYPES` and to `fromEventRow`'s exhaustive switch; the closed-set refusal stays, because an event nothing reads is a hole a client cannot see.
5. **The hub, the socket and the feed are three files with three concerns** (§8's interface). Redis, if it is ever needed, replaces `feed.ts` and touches neither of the others — and Task 18's mutation (a no-op feed reddening only the cross-replica test) is what proves that is still true.
6. **`pg_notify` is a doorbell, never a delivery** (P39). Anything durable goes through the outbox and is read by cursor. Presence is the sole exception, and it is the sole exception *because* it is never persisted.
7. **Presence is advisory: it locks nothing, blocks nothing, gates no write** (S6). The test that asserts a disposition change succeeds while somebody else is present on that clause is what stops a warning becoming a refusal.
8. **An assignment is a request and never a disposition** (§6.3). Assigning writes no `finding_disposition_event` and clears nothing, and a test asserts it. A future "flag and assign in one click" must keep them two facts.
9. **`audit_event` does not restate a disposition change** (S22). The feed and the audit export `UNION` three sources. Adding a disposition row to the audit log is the drift that would put two numbers in front of an auditor.
10. **`audit_event` is partitioned monthly and insert-only by grant.** Retention is a `DETACH`, never a `DELETE`. A new action goes into the closed `AUDIT_ACTIONS` set.
11. **`ROUTE_POLICY` has no default and a route with no entry fails registration — the socket included.** Check that `oidc.test.ts`'s route scanner still discovers every route after any registration-shape change; a route it cannot see is silently exempt from the 401 sweep.
12. **`mayApplyNow` is the only place "may this arriving change be applied now?" is decided** (P36). The poll path and the push path both call it.
13. **`api`'s `maxReplicas` is pinned by Task 14's answer**, with the reason in the Bicep. Raising it without the cross-replica test passing silently stops a reviewer seeing a colleague's changes, in the deployed environment only.
14. **The Keycloak test client is local-only and the app client still has no direct access grants** (P43), asserted by a test. The concession must not spread to the client it was carved out to protect.
15. **`findingOutcome.ts` has still not moved to `packages/core`** (P33), and §6.3 says it should when a server-side export needs it. A plan, not an omission.
16. **`packages/core` still holds only the review closure** (P20), not §5's full inventory. Unchanged by this stage.
17. **Every migration file is immutable once applied.** Add `013_…`; never edit `011_…`.
18. **Spike 2's Azure half, §18 item 10(c), and Spike 3's Container Apps half are all still unproven.** Three, now, and Task 26's report names all three together.

---

## What Stage 4 deliberately leaves to Stage 5

Named, not omitted.

**Stage 5 (the superseded surfaces):** the assignee **chip** on a card in a list and the **"assigned to me"** counter on the home screen — cross-matter aggregations over the mechanism Task 24 built (S18 binds until a mechanism is real, and it now is); **firm-wide search** and `⌘K` (R-G14, still deferred); the **Report tab** (R-G11, still deferred); the admin screens for `role_mapping` and for providers, which Stage 3 also left; the **workspace-wide audit export** (§12 Q3) — the per-review history export ships here (Task 10) and the workspace-wide one is an admin screen over `audit_event` plus `finding_disposition_event`, which is Stage 5's shape; and a **notification outside the app** for an assignment, which nothing in this design has proposed and which would be a new subprocessor rather than a feature.

**Neither, and still open:** §17 Q3 (retention, including precedent retention) — an owner decision, now sharper because `audit_event` is partitioned and its retention is a `DETACH` somebody has to schedule; §17 Q4 (which providers, and the declared jurisdiction set); **§17 Q6 (GDPR erasure versus a permanent disposition history)** — a DPO question Stage 3 made concrete and Stage 4 makes *larger*, because `audit_event` is now a second insert-only table with no application path to erasure, and the two together are the whole of what a firm would have to answer; §17 Q12 (does an export state where the review was processed — the `run` row can answer it and Task 9 did not add it, deliberately, because it is a different fact from a disposition's instant); §17 Q13 (production hosting off Azure); Spike 2's Azure half; Spike 3's Container Apps half; §18 item 10(c).

---

## Self-review

### 1. Spec coverage

Every Stage 4 requirement, with the task that implements it.

| Requirement | Source | Task |
|---|---|---|
| WebSocket, one connection per tab, multiplexed over subscriptions | §8 | 16, 19 |
| Subscriptions are `matter:{id}` and `review:{id}` (and `run` for compatibility) | §8 | 15, 16 |
| Every event carries the monotonic `event.id`; the client keeps the highest applied, per subscription | §8 | 15, 19 |
| Reconnect replays from `lastEventId` and then sends `caught_up` | §8 | 16, 19 |
| A cursor past retention gets `resync_required`, **and the UI says so while it refetches** | §8, §3 | 16, 20 |
| Events are idempotent and version-guarded; an event not newer is dropped | §8 | 19, 21 |
| `finding.disposition_changed` carries the row **and** the event that produced it | §8 | 15, 21 |
| The stale-change refusal and the realtime version guard are **one number** | §8 | 3, 7, 26 |
| A disconnected client shows itself stale and **must not offer to change a disposition** | §8, §3 | 20 |
| Presence: 10 s heartbeat, 15 s TTL, `{userId, initials, screen, clauseId?}`, broadcast on change | §8 | 22, 23 |
| Presence is never persisted and locks nothing | §8, S6 | 22 |
| Fan-out behind an interface; Spike 3 decides Redis | §8, §15 | 14, 16, 18 |
| One person changing another's disposition, resolved visibly | §6.3, S4, §18.5 | 1, 7, 21 |
| A `409` naming who changed it, when, and offering the change again | §6.3 | 7 |
| A repeat of a refused change writes a second history row | §6.3 | 7 |
| Every disposition shown with its actor and its time | §6.3 | 3, 4, 5 |
| A never-touched disposition names nobody | §6.3 | 3, 4, 5 |
| `changedCount > 0` shown inline, history reachable in one action | §6.3 | 5, 6 |
| The immediately preceding state named on the card | §6.3 | 4, 5 |
| A `rerun_reset` reads as a re-run, not as a person un-verifying | §6.3 | 4, 5, 6 |
| `dispositionLabel` / `dispositionHistoryLine` beside `verificationLabel` | §6.3 | 4 (P33) |
| The export carries its "as at" instant | §6.3.1 | 9 |
| The export carries "was X" and "changed N times" | §6.3.1 | 9 |
| The export states that a disposition can change | §6.3.1 | 9 |
| The full history is exportable, per review | §6.3.1 | 10 |
| The `assignment` table with assigner, message and resolution | §6.3, S17 | 24 |
| An assignment reaches the assignee | §18.5 | 25 |
| Assignment is a request, not a disposition | §6.3 | 24, 25 |
| `audit_event`, insert-only by grant, partitioned monthly | §6.5, S11 | 11 |
| A disposition change is **not** also written to `audit_event` | S22 | 11, 12, 13, 26 |
| The activity feed reads `audit_event` + `finding_disposition_event` + `run` | §13, S22 | 12 |
| Actors in the feed | §6.3, §3.1 | 12 (ruled; see disagreement 4) |
| The fourth load state, rendering distinctly from the other three | §3 | 20 |
| `await-then-apply`; no optimistic update for any human-authored state | §3, S8 | 7, 21, global |
| Your own write's echo is dropped by version guard | §3, §8 | 21 |
| Nothing derives a human judgement; the worker still holds no grant | §3, §9.1 | global; 26 asserts it |
| R-G1's affordances land only where the mechanism is real | §3.1, S18 | 12, 23, 25 (each edits `CLAUDE.md`) |
| No authentication bypass, on the socket either | S29 | 16 |
| Every route in `ROUTE_POLICY`; the API refuses what the UI hides | §7 | 2, 10, 12, 24 |
| `workspace_id` on every new table, every query scoped | §6, S9 | 11, 24 |
| The divergence list stays exact | S30, §18.10 | 14, 16, 17, 22 |
| Two accounts, seeded locally, for every collaborative check | §5.1, §14 | 1, 13, 26 |
| Mutation tests on everything load-bearing | §14 | 4, 7, 8, 11, 16, 18, 20, 21, 22 |
| `tsc` clean, tests pass, build clean | §18.1 | global; every task's gate |

**Requirements I could not assign to a task, and why:**

- **The workspace-wide audit export (§12 Q3).** The per-review history export ships (Task 10). The workspace-wide one is an admin screen over two tables, and §13 puts admin screens in Stage 5. Named there.
- **§14's MSW.** Deviated from deliberately (disagreement 7), with the reason recorded.
- **Spike 3's Container Apps half, Spike 2's Azure half, §18 item 10(c).** Unreachable environments. Named in Task 26's report, all three together, as Stage 3 named two.
- **§17 Q3, Q4, Q6, Q12, Q13.** Owner and DPO decisions. Q6 is materially larger after Task 11 and the report says so.

### 2. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `fill in`, `appropriate error handling`, `similar to Task`, `and so on`, `etc.` in step bodies, and for test steps with no test. Found and fixed inline. What remains, and why each is a **deliberate delegation** rather than a placeholder:

- **Task 14's Bicep block carries `<n>` and `<the answer>`.** It is a spike; writing a number there would be pre-deciding the thing the task exists to measure, and a plan that pre-decides a spike's answer has not planned a spike.
- **Task 16's replay-then-flush ordering is described precisely and not transcribed as code.** The frame union, the ordering rule and the de-duplication are all stated; the loop that implements them depends on `@fastify/websocket`'s connection object, which this plan has not run. Inventing its shape is the exact failure mode Stages 1–3 each suffered, and Step 2 tells the implementer to check the peer range before installing.
- **Task 12's `UNION` is specified by its three arms, its ordering and its scoping rather than transcribed.** Three near-identical `select … from` arms would be lines a reader skims and an implementer copies wrong; the constraint that matters (one statement, each arm scoped, limit in SQL) is stated as a constraint.
- **Task 24's routes are given with their bodies' meaning rather than their handler code.** The migration — where the constraints are, and where a mistake is a data problem — is written out in full.

### 3. Type and name consistency

Checked across all 26 tasks:

- **`DispositionView` / `DispositionEventView` / `DispositionWriteResult` / `DispositionHistory`** — shipped in `packages/core/src/api/records.ts`; **reused, never redeclared.**
- **`DispositionWithHistory { disposition, last? }`** — Task 3, used in 4, 5, 6, 7, 8, 9, 21. `last` is **absent**, never `null`, when `changedCount === 0`.
- **`DispositionAudience { nameOf, timeOf }`** — Task 4, passed to `dispositionLabel`, `dispositionHistoryLine`, `FindingCard`, `DispositionHistory`, `ConflictNotice`, and both exporters. Injected, never imported, so `findingOutcome.ts` stays pure.
- **`dispositionLabel(d, audience)` / `dispositionHistoryLine(event, audience)`** — Task 4, in `src/lib/findingOutcome.ts` and nowhere else, asserted by Tasks 13 and 26.
- **`dispositionsAsAtLine(at, timeZone)` / `dispositionsMayChangeLine()`** — Task 9, same module, both exporters.
- **`userName(id)` / `userInitials(id)` / `loadDirectory()` / `forgetDirectory()`** — Task 2, `src/lib/api/users.ts`, the only resolver. Returns **`undefined`** for an unknown id; never a fabricated label and never a raw id.
- **`WorkspaceUser` / `WorkspaceUsers`** — Task 2, `packages/core`.
- **`EVENT_TYPES` (nine) / `EventType` / `AppEvent` / `EventPayload`** — Task 15. `RUN_EVENT_TYPES`'s five names are **unchanged and not renamed** (Stage 3's interface note 3). `AppEvent.runId` is optional and **absent**, never `''`.
- **`DispositionChangedPayload` / `NoteAddedPayload`** — Task 15. The first carries `disposition`, `event` and `version`; `version` is `finding_disposition.version` and there is no second version field anywhere (Task 26 scans for one).
- **`SubscriptionRef = { review: string } | { matter: string } | { run: string }`** — Task 15, used by `readEvents`, the hub, the socket and the browser client. One shape, four consumers.
- **`ClientFrame` / `ServerFrame`** — Task 16, `packages/core/src/api/socket.ts`, both directions, both sides. `t` is the discriminant (not `type`, which `AppEvent` already uses for a different vocabulary — two `type` fields nested one inside the other is how a switch statement ends up reading the wrong one).
- **`Hub` / `Connection`** — Task 16, `apps/api/src/realtime/hub.ts`. No transport in it.
- **`EventFeed` / `startEventFeed(deps)`** — Task 18, started in `main.ts` beside the worker pool and the reaper.
- **`PresenceMember` / `PresenceRegistry`** — Task 22. `PresenceMember.at` is server-side only; the client renders no time from it.
- **`ConnectionState = 'connecting' | 'live' | 'stale'`** — Task 19. **Three values**, and `stale` is the load state Task 20 renders. Not four; a `reconnecting` value would be `connecting` with a different name and two of them would be rendered inconsistently.
- **`mayApplyNow(state)` / `HeldUpdate`** — Task 8, `src/features/review/pendingUpdate.ts`, called by the poll path and the push path.
- **`AssignmentView` / `AUDIT_ACTIONS` / `AuditAction` / `appendAudit(t, e)`** — Tasks 24 and 11. `appendAudit` takes a `Tx`, exactly as `appendEvent` does, for the same reason.
- **`ActivityEntry`** — Task 12: gains `byUserId?`, **keeps** `byYou` derived from it, so every shipped renderer keeps working.
- **Migration file names** — `011_audit_event`, `012_assignment`. Applied in filename order; immutable once applied. Never edit `005`–`010`.
- **New config keys** — the eight in the Declared surfaces table, all `sameEverywhere`, all in `apps/api/src/config.ts` and nowhere else, all added to `divergence.json` in the commit that introduces them.
- **Decision labels** — this plan's are **P29–P44**, continuing P1–P5, P6–P16, P17–P28. `rulings.md`'s owner decisions are **D1–D5**; its execution rulings are lettered. No label here collides.

### 4. What I would check first if this plan turns out to be wrong

In order of how likely the failure is and how quiet it would be:

1. **The version guard dropped, or applied the wrong way round.** `>` versus `>=` on a push is the difference between dropping your own echo and dropping the partner's override — and the second one is silent, permanent for that session, and looks exactly like a colleague who has not done anything yet. Task 21's mutation is the guard; **run it, do not assume it.**
2. **The socket joining the hub *after* the replay rather than before.** Every event that lands in between is lost, the gap is exactly the width of the replay, and it is worst on the busiest review. Task 16 Step 3 states the order; nothing else in the codebase would catch it, because a single-client test never has anything arriving mid-replay.
3. **`pg_notify` issued outside the transaction.** A replica woken before the commit reads the outbox, finds nothing, and never comes back — one lost event, no error, and unreproducible on a single process. Task 18 Step 3 puts it inside `appendEvent` for exactly this reason.
4. **The stale state shipped as a toast, or entered on the first close.** §19 names this as the defect most likely to ship *in the app*, and both of those are how it gets shipped while looking finished. Task 20's four-distinct-renderings test and its threshold rule are the guards.
5. **A card rendering a state chip without the label line beside it.** The card still looks complete — the chip says "Verified" — and the only thing that goes red is Task 5's `not.toMatch(/Verified(?!\s+by)/)`. Check that assertion exists and that it bites.
6. **The refusal softened into a retry.** Someone hits the `409` under load, decides the click is annoying, and adds one automatic re-apply. That re-creates last-write-wins with a history row that says a person decided it. P25 and P35 both forbid it, and Task 7 Step 5 asserts the **absence** as well as the refusal — because an absence that is only stated in prose is an absence nobody is holding. Confirm that test exists and that its mutation reddens it.
7. **`audit_event` gaining a disposition row.** It reads like completeness. It produces two append-only accounts of one fact, in front of an auditor, and the divergence would appear at the worst possible moment. Task 13's and Task 26's scanners are the guard, and both need their sanity checks confirmed.
8. **A presence warning becoming a presence refusal.** "Priya is on this clause — are you sure?" is one code review away from blocking the write, and S6 says presence gates nothing. Task 22's "gates no write" test is the only thing standing between the two.
