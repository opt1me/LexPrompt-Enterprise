# Redesign sub-project D — Standard positions and playbook versioning

**Date:** 2026-08-27
**Status:** Approved for planning (owner authorised proceeding through the whole redesign without check-ins)
**Builds on:** A (persistence and matters), B (verified findings), C (collections and net positions)
**Source handoff:** `design_handoff_lexprompt_redesign/`, digested to `docs/superpowers/redesign/`
**Rulings without owner review:** `docs/superpowers/redesign/rulings.md`

## 1. What this sub-project is for

Everything so far tells a lawyer what a contract *says*. This one tells them whether it says what their firm asks for.

A **standard position** is the firm's own answer to a clause — "we ask for a 6-month break notice, no conditions" — recorded on the playbook clause alongside the prompt that extracts it. With one present, a finding stops being a summary and becomes a comparison: *meets*, *deviates*, or *unclear*, with the reasoning shown as "we ask for" against "this lease says."

And because a firm's positions change, a playbook stops being a mutable document and becomes a **versioned** one. A review records the version it ran against, so a finding from four months ago can still be read against the positions that actually produced it — rather than against whatever the playbook has since become, which would silently rewrite history.

## 2. The rule this sub-project inherits

B established that nothing leaves the app claiming to be checked when it isn't. C extended it to synthesis. D extends it to judgement:

- **`unclear` is a first-class outcome, not a failure.** A model that cannot tell whether a clause meets a position must say so. Forcing a binary produces a confident *meets* on a clause nobody actually read, which is the exact failure this project has spent its whole history removing.
- **A deviation is an observation, not a verdict.** It is still subject to B's human verification. `deviates` + `unchecked` is a claim; `deviates` + `verified` is a finding.
- **A version is immutable once published.** Editing a published version is not offered. Editing produces a new version, because a review that says "ran against v4" must be able to prove what v4 was.
- **Staleness is derived, never stored.** How well-tested a position is, is a function of the reviews that have run against it. Storing it would let it drift from the evidence it claims to summarise.

## 3. Scope

**In:**

1. **`StandardPosition` on a playbook clause** — the position text, where it came from, and whether a human has reviewed it.
2. **Deviation evaluation during extraction** — a clause with a standard position returns `meets | deviates | unclear` plus a rationale, in the same call that extracts it.
3. **The comparison on the finding** — "we ask for" against "this lease says," with the outcome chip, never merged with the risk chip or the state chip.
4. **`PlaybookVersion`** — immutable published versions with a `changeSummary`; `Playbook` becomes the identity and its versions the content.
5. **`Review.playbookVersionId`** — every review records the version it ran against, and reopening it reads that version.
6. **Editing a playbook produces a draft, publishing produces a version.** A draft is mutable and unpublished; publishing freezes it.
7. **The playbook editor extended** — standard-position field per clause, provenance shown honestly ("written by you", "drafted by AI, reviewed by you", "learned from redlines" once E exists), and clause reordering.
8. **Version history** — a timeline of versions with their change summaries and which matters used each.
9. **Position health, derived** — per position: how many reviews tested it, how many met it, when it was last tested. Rendered as `held`, `conceded`, `untested`, or `no position`, computed from reviews at read time.
10. **`mode` retires.** `Template.mode: 'extraction' | 'risk'` collapses: a clause with a standard position is compared against it; one without is extracted only. The flag becomes derivable and is removed, with a migration.

**Out, and belonging to sub-project E:** the AI-drafted playbook flow (`2a`/`2b`), manual authoring with per-field AI assist (`2c`), learning positions from redlines (`3a`–`3c`), and changeset generation and publishing (`4b`).

**Out and staying out:** the `Standard positions` global nav tab — named in the handoff's navigation model with no screen drawn for it (see §10); mobile layouts; the visual reskin.

**Unchanged and not to be touched:** `src/lib/citations.ts`, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/verification.ts`, `src/lib/citationPage.ts`, `PdfCanvas`, and `src/features/assistant/`.

## 4. Data model

```ts
type PositionOrigin = 'authored' | 'ai-drafted' | 'learned';

interface StandardPosition {
  /** "We ask for a 6-month break notice with no conditions." */
  text: string;
  origin: PositionOrigin;
  /** True once a human has read and accepted it. An AI-drafted position
   *  that nobody has read is not the firm's position — it is a suggestion,
   *  and the editor says so. */
  reviewedByHuman: boolean;
  /** Free text naming where it came from ("Commercial Lease — Tenant v4",
   *  "6 redlines across 4 documents"). Presentational; nothing resolves it. */
  provenance?: string;
}

interface PlaybookClause {
  id: string;
  title: string;
  /** Was `Clause.prompt`. Renamed because a clause now carries more than
   *  one prompt-shaped field. */
  extractPrompt: string;
  riskCriteria?: string;
  standardPosition?: StandardPosition;
}

interface PlaybookVersion {
  id: string;
  playbookId: string;
  /** 1, 2, 3 … Monotonic per playbook. */
  version: number;
  name: string;
  contractType: string;
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance?: string;
  clauses: PlaybookClause[];
  /** One line saying what changed from the previous version. Required on
   *  every version after the first: a version history whose entries do not
   *  say what changed is a list of dates. */
  changeSummary: string;
  publishedAt: number;
  publishedByUserId: string;
}

interface Playbook {
  id: string;
  name: string;               // mirrors the current version's, for listing
  createdAt: number;
  updatedAt: number;
  currentVersionId?: string;  // absent until the first publish
  /** The mutable working copy. Present when there are unpublished edits. */
  draft?: Omit<PlaybookVersion, 'id' | 'playbookId' | 'version' | 'publishedAt' | 'publishedByUserId'>;
}
```

`Finding` gains two optional fields:

```ts
  /** Present only when the clause carried a standard position. Absent means
   *  "no position to compare against" — never `unclear`, which means "there
   *  was a position and the model could not tell." */
  positionOutcome?: 'meets' | 'deviates' | 'unclear';
  positionRationale?: string;
```

`Review` gains `playbookVersionId: string` alongside the existing `playbookSnapshot`. The snapshot stays: it is what makes a review readable after a playbook is deleted, and sub-project A's discipline on it holds. The version id is what lets the app show "ran against v4" and link to it.

`SCHEMA_VERSION` bumps 5 → 6.

## 5. Migration

The most invasive migration since sub-project A, and it touches data the user already owns.

- Every existing `Playbook` (structurally still v1's `Template`) becomes a `Playbook` with **one published version, v1**, whose `changeSummary` is "Imported from before versioning." Nothing is lost and nothing is invented.
- `Clause.prompt` becomes `PlaybookClause.extractPrompt`. Both names are read on migration; only the new one is written.
- `mode: 'risk'` becomes `riskTolerance` retained and no standard positions — a risk-mode template was never a position, and inventing one from a risk tolerance would fabricate the firm's own house rules. `mode: 'extraction'` migrates identically. The flag is then dropped.
- Existing `Review` records get their `playbookVersionId` pointed at the migrated v1 of the playbook their snapshot names, where that playbook still exists, and left absent where it does not — a review whose playbook was deleted still opens on its snapshot, as it does today.
- Repair, never drop, per sub-project A. Extend `migrateReviewRecord` and add a sibling for playbooks; do not write a second migration framework.

## 6. Deviation evaluation

Evaluation happens **in the extraction call**, not in a second pass. The model is already reading the clause text with the document in front of it; asking a second model call to compare a summary against a position would compare a summary against a position, not the document against a position.

The schema gains two fields, required only when the clause has a standard position:

```
- position_outcome: one of "meets", "deviates", "unclear".
- position_rationale: why. For "deviates", say what the difference is.
```

Three rules govern the result:

- **A missing or unrecognised outcome becomes `unclear`,** never `meets`. This mirrors `readStatus` in sub-project B's migration, deliberately: the safe default is the one that prompts a human to look.
- **`deviates` without a rationale becomes `unclear` with a note saying the model gave no reason.** A deviation nobody can see the argument for is not actionable, and presenting it as one invites a lawyer to act on nothing.
- **A clause with no standard position gets no outcome at all.** Not `unclear` — absent. The distinction is the whole point: "we have no house rule here" and "we have one and could not tell" are different facts.

## 7. Position health

Derived at read time from the reviews in scope, never stored:

| Rendered | Derivation |
|---|---|
| `HELD n of m` | m findings verified against this position, n of them `meets` |
| `CONCEDED n times` | at least one verified `deviates` since the position's version was published |
| `UNTESTED` | no verified finding has ever tested it |
| `NO POSITION` | the clause has no standard position |

Only **verified** findings count. An unchecked `meets` is the model agreeing with itself, and letting it strengthen a house rule would close the loop the app exists to keep open.

## 8. Screens

**The playbook editor** gains, per clause: the standard-position field with its provenance line, and an explicit "optional — enables deviation flagging" note where empty. Playbook-level, it gains a `Publish` action that requires a change summary, an "unpublished changes" state, and a link to version history. Reordering clauses is drag-based and saves into the draft, not into the published version.

**The review workspace**: a finding whose clause carries a position shows an "against our standard position" block above the evidence — the outcome chip, "we ask for" and "this lease says" side by side, and the rationale. The outcome chip is its own component alongside `StateChip` and `RiskChip`; three chips, three questions, never merged.

**Version history**: a timeline of published versions, each with its number, date, author, change summary, and the matters that used it. A review's header links to the version it ran against.

**The clause index** gains `deviates` to its existing count chips.

## 9. Testing

| Suite | Covers |
|---|---|
| `playbookVersions` | publish creates an immutable version; editing a published version is impossible; version numbers are monotonic; a change summary is required after v1 |
| `playbookMigration` | a pre-D playbook becomes one published v1 losslessly; `prompt` → `extractPrompt`; `mode: 'risk'` invents no position; idempotent; malformed repaired not dropped |
| `positionOutcome` | a missing outcome becomes `unclear`; `deviates` with no rationale becomes `unclear` and says why; no position yields no outcome at all |
| `positionHealth` | only verified findings count; held/conceded/untested/no-position each derive correctly; an empty history is `UNTESTED`, not an error |
| `reviewVersionBinding` | a review records its version; reopening reads that version, not the current one |
| `export` | a deviation is exported with its rationale; an `unclear` says it is unclear |

Mutation-test: the `unclear` defaults, the verified-only rule in position health, and version immutability.

## 10. Definition of done

1. `tsc --noEmit` clean; tests pass; build clean.
2. A playbook clause can carry a standard position; a clause without one behaves exactly as today.
3. Running a review over a clause with a position produces `meets`, `deviates` or `unclear` with a rationale, shown as a two-column comparison.
4. Editing a playbook produces a draft; publishing requires a change summary and produces an immutable version.
5. A review records its playbook version, and reopening it four versions later still reads the version it ran on.
6. Version history lists every version with its change summary and the matters that used it.
7. Position health renders from verified findings only — an unverified `meets` does not strengthen a position.
8. A pre-D playbook survives migration as v1 with its prompts intact and no invented positions.
9. Exports carry the outcome and its rationale.
10. Verified in a browser with a real key: add a position, run a review, see a deviation, verify it, publish a new version, confirm the old review still reads against the old version.

## 11. Risks

**The migration touches the user's own playbooks.** It is the second migration in this redesign to do so. Sub-project A's rules apply unchanged: repair rather than drop, never delete the source, idempotent, and the largest share of the test effort.

**`mode` retiring is a real behavioural change.** Today `mode: 'risk'` changes the prompt. After this, the presence of a standard position does. A risk-mode template must produce the same review it does today after migration — that is a test, not an assumption.

**Three chips is the limit.** State, risk, and position outcome are three separate questions with three separate answers, and the handoff is explicit that conflating any two is a defect. A fourth chip would make the card unreadable; anything further belongs in the detail, not the header.

**The `Standard positions` nav tab cannot be specified.** The handoff's navigation model lists it as a top-level tab and never draws a screen for it. Left out rather than invented, on the same reasoning as C's `Compare` tab.
