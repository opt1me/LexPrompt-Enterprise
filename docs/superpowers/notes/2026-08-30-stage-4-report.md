# Stage 4 — the live-change stage. Definition of done, honestly accounted.

**Branch:** `lexprompt-server`. Tasks 1–26 complete.
**Gates at close:** `npm run typecheck` clean (4 projects); `npx vitest run` exit 0,
**224 files / 3075 tests**, 0 unhandled; `npm run test:pg` **41 files / 598 tests**;
`npm run test:compose` **14 files / 56 tests**; `npm run build` clean, no externalization
warning.

---

## §18 item 5, clause by clause, in the three categories P44 requires

§18 item 5: *"Two people work on one review: one changes a disposition the other set; the
change is refused if stale, resolved visibly, and reaches the other person; an assignment
reaches the assignee."*

### Met by mechanism — proved against the running stack or a real Postgres

| Clause | Evidence | Limit |
|---|---|---|
| A disposition can be changed by any reviewer, at any time, and changed back | `dispositionRoutes.pg.test.ts`, `stage4DoD.compose.test.ts` — trainee verifies, partner rejects, trainee re-verifies, three history rows | none |
| Every change is recorded with who and when, append-only | `006_dispositions.sql`'s grants (no `update`/`delete` to any application role), `dispositions.pg.test.ts`, `grants.pg.test.ts` | none |
| A stale change is REFUSED, never merged | `dispositionRace.pg.test.ts` (two concurrent writers, one wins), `stage4DoD.compose.test.ts` (`409` on the running stack) | none |
| The refusal carries the row that replaced it | `stage4DoD.compose.test.ts` asserts `current.byUserId` is the partner and `current.state` is `rejected`, over the real envelope | The *sentence* built from it is a rendered string — see below |
| A repeat of a refused change writes a SECOND history row | `stage4DoD.compose.test.ts` reads the history after the re-apply | none |
| Nothing retries automatically | `stage4aDoD.test.ts` asserts the ABSENCE of a retry path; Task 7's mutation reddens it | none |
| The winner's change reaches the loser's socket, attributed | `livePush.compose.test.ts` (**9–40 ms**), `replicaFanout.compose.test.ts` (**2–30 ms across two replicas**), `stage4DoD.compose.test.ts` | none |
| An event not newer is dropped (the echo of your own write) | `socket.test.ts`, `App.livePush.test.tsx`; Task 21's mutation | Browser-side, in jsdom |
| One version number does both jobs | `stage4DoD.test.ts` scans for a second (`dispositionVersion2`/`pushVersion`/`liveVersion`), with a sanity check that it can find the one that exists | none |
| An assignment reaches the assignee | `assignmentReaches.compose.test.ts` — **33-36 ms** to their socket, and in `GET /v1/assignments?state=open` | none |
| An assignment changes no disposition | `assignments.pg.test.ts` (row, version AND history unchanged); `assignmentReaches.compose.test.ts` compares the served findings bytes before and after | none |
| Presence is never persisted | `presence.pg.test.ts` (the live catalogue: no table, no column), `stage4DoD.test.ts` (no migration names it; the module imports no database) | none |
| Presence expires within its TTL | `presence.compose.test.ts` — **15.7-19.4 s** in the running process with nobody prompting it (15 s TTL + a sweep interval) | none |
| Presence gates no write | `presence.pg.test.ts` (through the route, real DB) and `presence.compose.test.ts` (two real tokens) | none |
| No authentication bypass, on the socket either | `socketAuth.test.ts`, `oidc.test.ts`'s 401 sweep (**69 routes**), `stage4DoD.compose.test.ts` | none |
| `audit_event` holds no disposition change (S22) | `auditEvent.pg.test.ts`, `stage4DoD.compose.test.ts` over the feed | none |
| The worker holds no grant on any of it | `grants.pg.test.ts` attempts each write AS the worker role | none |

### Met by rendered string — a component test in jsdom, and nobody has seen it

| Clause | Evidence | Limit |
|---|---|---|
| "R. Okafor changed this to Rejected at 14:22, after you loaded it" | `ConflictNotice.test.tsx` | **Nobody has seen it.** Whether it reads as an *error* rather than as a *decision* is unanswered |
| A card names who set the state it shows, and what it was before | `FindingCard.test.tsx`, `findingOutcome.test.ts`; `stage4DoD.test.ts` asserts no component renders a `StateChip` without an actor line | One surface is exempt and named — see the gap below |
| A push held under an open control is announced | `FindingCard.test.tsx`, `pendingUpdate.test.ts` | **Nobody has seen it.** Whether the line is noticed mid-sentence is unanswered |
| A stale client says so and stops offering to change anything | `StalePanel.test.tsx`, `VerificationControls.test.tsx`, `AssignPanel.test.tsx`; `stage4DoD.test.ts` checks each write control reads and disables on `stale` | **Nobody has seen** the banner appear on a cut network, or the recovery read as a recovery |
| An export states the instant, what each state was, and that it can change | `exportDocx.test.ts`, `csv.test.ts`, `exportHistoryCsv.test.ts` — over the produced bytes | **Nobody has opened the produced file** |
| Presence appears, and on the clause | `PresenceRoster.test.tsx`, `ClauseIndex` | **Nobody has seen a face.** Whether it reads as "looking" rather than "checked" is the question that matters and it is unanswered |
| "A. Trainee asked you to look at this", with the message | `AskedOfYou.test.tsx`, `FindingCard.test.tsx` | **Nobody has seen it** |
| The feed names people | `MatterActivity.test.tsx`, `activity.pg.test.ts` | **Nobody has seen it** |

### Unmet, or met with a stated limit

1. **The comparison grid shows a disposition state without its actor.** `TabularReview`
   renders a `StateChip` per cell with no actor line; the attribution is one click away in
   the cell detail panel, which mounts the ordinary `FindingCard`. §6.3's requirement is
   unqualified, so this is a **limit, not a pass**: named in `stage4DoD.test.ts` as the one
   exempt surface, with its counterpart asserted, and recorded as R-S4E10.
2. **Nothing notifies anybody outside the app.** An assignment reaches a person who opens
   LexPrompt. No email, no chat, no push. Deliberate (a new subprocessor, not a feature),
   and named in `CLAUDE.md`.
3. **The assignee chip in a list and the "assigned to me" counter are absent**, and
   `stage4DoD.test.ts` asserts their continued absence. Stage 5 (S18).
4. **Two people have never used the app at once in a browser.** The mechanism is proved
   with two real tokens; the experience is not proved at all.

---

## What only a person at a browser can confirm — the list, not an apology

Browser automation has been unavailable for this entire project. Checked again at the
close of this stage: `list_connected_browsers` returns `[]`, and the Playwright MCP timed
out at session start. These need a person:

1. **Two browser profiles, two accounts, one review**: the trainee's card visibly changing
   attribution when the partner overrides, with no reload. *This is §18 item 5's headline
   clause and only its mechanism has been proven.*
2. **Presence**: a colleague appearing, appearing on a clause, and going within the TTL —
   and, above all, whether a face on a clause reads as *looking* rather than *checked*.
3. **The stale banner** appearing on a cut network, the controls going dead, and the
   recovery reading as a recovery.
4. Whether a live update arriving **mid-scroll** is disruptive, and whether the *"changed
   while you were writing"* notice is **noticed**.
5. **The refusal notice**: whether a reviewer understands what happened and what the
   re-apply button will do.
6. **The deployed two-account pass** (§18 item 9), Entra's group claim and its overage case.
7. **Container Apps ingress for a long-lived WebSocket** (Spike 3's unanswered half) and
   **Spike 2's Azure half**. Both still open, alongside §18 item 10(c).

---

## Defects this stage's own gates found

- **`assignment.created` audit rows were invisible to the activity feed.** The feed's
  audit arm reads `where matter_id = $1`; the route wrote a `review_id` and no matter. The
  row existed, the query could not reach it, nothing went red. Found by `stage4DoD.compose.
  test.ts`, fixed at the one writer (`appendAudit` now resolves the matter from the review
  in its insert, as `appendEvent` already did). R-S4E9.
- **A guard fired on a substring.** `stage2DoD`'s collaboration-affordance scanner matched
  `usePresence` inside `ClausePresence` and reported the shipped presence marker as a
  forbidden hook. Word boundaries added, with a negative case pinned. R-S4E8.
- **`feed.pg.test.ts`'s listener-kill matched a pinned query string.** Adding a second
  `LISTEN` made `pg_stat_activity.query` read `listen lexprompt_presence`, so the kill
  matched nothing — caught only because that suite asserts a backend WAS terminated.
- **Two `vi.mock` factories for `lib/api/users` omitted exports** a component now
  resolves through. A factory mock replaces the whole module, so the omission is a hard
  failure inside the component rather than a silent fallback.
- **Assignment audit assertions counted across the whole workspace.** `test:pg` and
  `test:compose` share one database, so rows the compose suites committed made the counts
  depend on what else had run. Scoped to the suite's own review.

## Mutation tests run, and the named test each killed

| Mutation | Test that went red |
|---|---|
| `sweep` never expires a beat (`if (false && …)`) | `presence.pg.test.ts` › *drops a member whose last beat is older than the TTL, and broadcasts the change* (and *keeps a member whose beat is exactly one TTL old…*) |
| A presence face drawn in `text-state-verified` and titled "verified this" | `PresenceRoster.test.tsx` › *says VIEWING in words, and never a disposition word*; › *draws itself in the presence ink and never a state or outcome ink* |
| `clearPresence()` removed from the socket's `onclose` | `socket.test.ts` › *claims nobody the moment the socket goes* |
| The assignment route's `appendEvent` disabled (unit) | `assignments.pg.test.ts` › *pushes assignment.created onto the outbox, carrying the whole row* |
| The assignment route's `appendEvent` disabled (rebuilt container) | `assignmentReaches.compose.test.ts` › *reaches the assignee s open socket, and their list, within a second* |
| The assignment route also moves the disposition | `assignments.pg.test.ts` › *changes no disposition, and writes no disposition event* |

---

## Interfaces Stage 5 inherits

Unchanged from the plan's list, with three additions from these tasks:

19. **`PresenceMember` carries no name and no timestamp** (R-S4E1). A display name here
    would be a second copy of a mutable field; a timestamp is what a "last seen" would be
    built out of, and the TTL makes any such claim false.
20. **Presence is the sole exception to "the notification is a doorbell"** (P39, R-S4E4),
    on its own channel, and it is the exception *because* it is never persisted. Anything
    that acquires durability must move to the outbox.
21. **`appendAudit` and `appendEvent` resolve `matter_id` at the writer** (R-S4E9). A
    denormalised key resolved at the call site is a key the fifth call site forgets.
