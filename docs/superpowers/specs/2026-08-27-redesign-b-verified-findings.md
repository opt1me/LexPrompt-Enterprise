# Redesign sub-project B — Verified findings and inline evidence

**Date:** 2026-08-27
**Status:** Approved for planning (owner authorised proceeding through the whole redesign without check-ins)
**Builds on:** sub-project A (`docs/superpowers/specs/2026-08-26-redesign-a-persistence-and-matters.md`) — complete, 414 tests
**Source handoff:** `design_handoff_lexprompt_redesign/`, digested to `docs/superpowers/redesign/`
**Rulings without owner review:** `docs/superpowers/redesign/rulings.md`

## 1. Why this is the redesign's thesis

Sub-project A made findings durable. This one makes them *accountable*.

The handoff's second and third changes are the product's actual argument: **every finding carries a verification state set by a human**, and **evidence is inline quoted text with a document and page pin** rather than something hidden in a hover tooltip. Together they change what the app is for. Today it produces AI output that looks authoritative and carries no record of whether anyone checked it. After this, a finding is either checked or visibly not, and an export says which.

That matters more here than in most software. A contract review that leaves the building is advice. The handoff's own phrasing is the requirement: *nothing leaves the app claiming to be checked when it isn't.*

This also completes an arc the codebase has been on since v1. Every serious defect found in this project has been the same shape — something incorrect or incomplete presented as if it were correct and complete. Verification state is that principle made into a first-class field: the app stops implying a confidence it has no basis for, and says plainly what a human has and has not confirmed.

## 2. Scope

**In:**

1. **`Citation[]` replacing `string[]`** — attributed evidence carrying its quote, document id, and page where derivable.
2. **A verification state machine per finding** — `unchecked | verified | flagged | rejected`, recording who and when, and a reason on `rejected`.
3. **Notes on findings** — free text, attributed, timestamped, multiple per finding.
4. **Inline evidence** — the quoted text visible in the finding, with its document/page pin, not a hover tooltip.
5. **`StateChip` and `RiskChip` as distinct components** — verification state and risk level must never be conflated in one badge.
6. **Export labelling** — DOCX and CSV both mark unverified, flagged and rejected findings as such. Export is never blocked; it is honest.
7. **Verification progress surfaced** — per review, and on the matter home.
8. **The review workspace evolved toward the ledger** — clause index, finding, document, with keyboard navigation for the verify loop.

**Out, and belonging to later sub-projects:** collections and net positions (C); standard positions and deviation evaluation (D); playbook versioning, the authoring wizard, learning from redlines, changesets (D and E); the comparison grid's rebuild as a triage surface (C, once collections exist); the intake wizard; mobile layouts; the full visual reskin.

**Out and staying out:** assignment as a workflow that reaches another person, and the activity feed as a cross-user record (ruling R1). An `assigneeId` field may exist; nothing may imply it notifies anyone.

**Unchanged and not to be touched:** `src/lib/citations.ts`'s matcher (the fuzzy-match algorithm is verified and stays), `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/db/*` except where a field is added, `runReview`'s orchestration, `PdfCanvas`, and `src/features/assistant/`.

## 3. Constraints inherited, which still bind

- **Fail loudly rather than answer quietly wrong.** Verification state is the strongest form of this yet: an unchecked finding must never render or export as though someone had checked it.
- **Backend-free**, static build, everything in the visitor's browser.
- **Extract on the second copy, not the third.** Six drift findings so far.
- **Mutation-test anything load-bearing**; a green suite is not evidence.
- **Verify UI work in a browser** — unit tests have twice missed defects in the app's central flow.
- **Gates:** `tsc --noEmit` clean, tests pass, build clean.

## 4. The citation upgrade is the risky part

`Finding.citations` is `string[]` today and is consumed by the card, the tabular cell detail, the DOCX exporter, the CSV exporter, and the viewer's highlight path. It becomes:

```ts
interface Citation {
  quote: string;
  documentId: string;
  page?: number;      // where derivable from the match
  clauseRef?: string; // e.g. "14.2", when the model supplies one
}
```

Three things make this delicate:

**Existing reviews must survive.** Reviews persisted by sub-project A hold `citations: string[]`. They migrate on read — each string becomes a `Citation` with its `quote` and the review's single document id. `SCHEMA_VERSION` bumps. The migration follows sub-project A's discipline: repair rather than drop, never delete what cannot be read.

**The matcher must not change.** `findQuoteRects` takes quotes and returns rectangles; it is verified end to end (4/4 citations exact after reload) and has its own hard-won behaviour, including an `item.height || 12` fallback that a previous refactor nearly broke. Extract the `quote` and pass it. Do not refactor the matcher to accept `Citation`.

**`page` must be derived, not invented.** The matcher already knows which page a quote matched. Where it does not match, `page` is absent rather than guessed. A wrong page pin is worse than no pin — it sends a reader to the wrong part of a contract with apparent authority.

## 5. The verification state machine

```ts
type VerificationState = 'unchecked' | 'verified' | 'flagged' | 'rejected';

interface Verification {
  state: VerificationState;
  byUserId?: string;   // the local profile (R1)
  at?: number;
  reason?: string;     // required when rejected
  assigneeId?: string; // exists; reaches nobody (R1)
}
```

- Every finding starts `unchecked`. There is no implicit verification — a finding is never "probably fine".
- `rejected` **requires** a reason. A rejected finding without one is a silent disagreement, useless to whoever reads the export.
- State is set only by a human action. Nothing derives it from risk level, confidence, or re-running.
- Re-running a clause **resets its verification to `unchecked`** and says so. A verification attached to superseded content is a lie; this is the single most important rule in this sub-project.

## 6. Export honesty

Export is never blocked. It is labelled:

- A `verified` finding exports normally.
- An `unchecked` finding is labelled **unverified AI output**.
- A `flagged` finding carries its flag and any note.
- A `rejected` finding is included **with its reason**, not omitted — silently dropping a rejected finding hides a human judgement from the reader.
- Every export carries a header summary: how many findings, how many verified.

Both exporters share `findingOutcome.ts` already; the labelling belongs there so DOCX and CSV cannot disagree. They have disagreed before — a CSV once wrote unreviewed clauses as blank cells while the DOCX said "could not be reviewed".

## 7. Data model changes

```ts
interface Note {
  id: string;
  findingId: string;   // clauseId + docId composite, or a stable finding key
  text: string;
  byUserId: string;
  at: number;
}

interface Finding {
  // ... existing fields unchanged ...
  citations: Citation[];      // was string[]
  verification: Verification; // new, always present
  notes: Note[];              // new, may be empty
}
```

`Finding` keeps every existing field — `status`, `noContent`, `truncated`, `authError`, `cancelled` — each of which encodes a lesson. None are replaced by verification state; they describe what *the run* produced, while verification describes what *a human* concluded.

## 8. Screens

**The review workspace** gains: the verification control on each finding, inline evidence with pins, notes, and a progress indicator. Keyboard navigation for the verify loop — next/previous finding, verify, flag, reject — because verification is a repetitive pass and a mouse-only loop will not be used.

**The matter home** gains verification progress per review.

The full three-pane ledger and the visual reskin are not in this sub-project; this is the existing workspace evolved, following existing `src/components` conventions.

## 9. Error handling

- A verification write that fails must surface and **must not** leave the UI showing a state that was not persisted. This is the failure that would matter most: a user marks twenty findings verified, the writes fail, and an export claims verification that no store holds.
- Notes follow the same rule.
- Load paths use `describeLoadError`/`LoadErrorPanel` as established.

## 10. Testing

| Suite | Covers |
|---|---|
| `citations` migration | `string[]` → `Citation[]`; page derived where matched, absent where not; malformed repaired not dropped |
| verification state | every transition; reason required on reject; re-run resets to unchecked |
| notes | add, list, attribution, timestamps |
| export labelling | each state's label in **both** DOCX and CSV; the header summary count |
| persistence | verification and notes survive a reload; a failed write does not leave a false UI state |

Mutation-test: the re-run reset, the reject-reason requirement, and the export labels.

## 11. Definition of done

1. `tsc --noEmit` clean; tests pass; build clean.
2. A finding can be verified, flagged, or rejected-with-reason; the state persists across a reload.
3. Re-running a clause resets its verification and says so visibly.
4. Evidence is readable inline with a document/page pin, and clicking still highlights the right passage.
5. A DOCX and a CSV export both label unverified, flagged and rejected findings, and both carry the header summary.
6. Verification progress is visible per review and on the matter home.
7. A review created before this sub-project opens with its citations migrated and every finding `unchecked`.
8. A failed verification write surfaces and does not leave a false state on screen.
9. Verified in a browser with a real key: run a review, verify some findings, flag one, reject one with a reason, reload, export, and read the labels in the exported file.

## 12. Risks

**The citation migration touches five consumers.** It is the widest-reaching change in the sub-project and the one most likely to break the verified highlighting path.

**Verification is trust-bearing.** A state that displays but does not persist, or survives a re-run it should not, produces exactly the false confidence this feature exists to remove. Both are explicitly tested.

**Keyboard navigation invites scope creep.** Four actions and next/previous. Not a command palette.
