# Redesign sub-project B — Verified Findings and Inline Evidence: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every finding accountable — a human-set verification state, attributed inline evidence with a document/page pin, notes, and exports that say plainly what was and was not checked.

**Architecture:** `Finding.citations` becomes `Citation[]` (quote + documentId + optional page/clauseRef) and gains `verification: Verification` and `notes: Note[]`. Page numbers are *derived* from the `[Page N]` markers already present in a PDF's extracted text — never invented, never guessed, and never by touching the verified `findQuoteRects` matcher. Old reviews migrate on read. The state machine, page derivation, citation repair and progress counting each live in their own leaf module so the two exporters, the card and the matter home cannot drift apart.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6, Tailwind 4, Vitest 3 + jsdom, `fake-indexeddb`, `idb` 8, `docx` 9.

**Spec:** `docs/superpowers/specs/2026-08-27-redesign-b-verified-findings.md`

**Builds on:** sub-project A (`docs/superpowers/plans/2026-08-26-redesign-a-persistence-and-matters.md`), complete at 414 tests.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Fail loudly rather than answer quietly wrong.** An unchecked finding must never render or export as though someone had checked it.
- **Re-running a clause resets its verification to `unchecked` and says so.** The spec calls this "the single most important rule in this sub-project."
- **`rejected` requires a reason.** A rejected finding without one is a silent disagreement, useless to whoever reads the export.
- **State is set only by a human action.** Nothing derives it from risk level, confidence, or re-running.
- **Export is never blocked. It is labelled.** A rejected finding is included *with its reason*, never omitted.
- **`page` is derived, not invented.** Where it cannot be derived, `page` is absent. A wrong page pin is worse than no pin.
- **Do not refactor `findQuoteRects`.** `src/lib/citations.ts`'s matcher is verified end-to-end and keeps its `item.height || 12` fallback. Extract the `quote` from a `Citation` and pass a `string[]` in, exactly as today.
- **Backend-free**, static build, everything in the visitor's browser.
- **Extract on the second copy, not the third.** Six sibling-drift findings so far in this project.
- **Mutation-test anything load-bearing**; a green suite is not evidence. Mutation-test at minimum: the re-run reset, the reject-reason requirement, and the export labels.
- **Never delete what cannot be read.** Malformed citation data is repaired, never dropped.
- **Gates:** `npx tsc --noEmit` clean, `npm test` green, `npm run build` clean.
- **Not to be touched:** `src/lib/citations.ts`'s matcher, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/db/*` except where a field is added, `PdfCanvas.tsx`, and `src/features/assistant/`.

### Component tests: this project has no `@testing-library/react`

**Read this before writing any component test in Tasks 6, 7, 8, 9 or 13.**

Those tasks' test bodies were drafted using `render` / `screen` / `fireEvent` from `@testing-library/react`. **That library is not a dependency of this project and is not going to become one.** Five existing test files carry the comment *"No @testing-library/react in this project — see Toast.test.tsx for the precedent this follows: drive a real react-dom root directly."* That is a deliberate, repeated, documented convention, and adding a second testing style beside it is exactly the sibling-drift pattern that has produced six findings in this codebase already.

**The assertions in those task bodies are correct and are what you must assert. Only the mechanism changes.** Task 6 Step 0 creates one shared harness, `src/test/mount.tsx`, and every component test in this sub-project uses it. Translate mechanically:

| Drafted as | Write instead |
|---|---|
| `render(<X />)` | `const c = mount(<X />)` |
| `screen.getByText(/foo/i)` | `expect(c.textContent).toMatch(/foo/i)` |
| `screen.queryByText(/foo/i)` is null | `expect(c.textContent).not.toMatch(/foo/i)` |
| `screen.getByRole('button', { name: /verify/i })` | `buttonNamed(c, /verify/i)` |
| `screen.getAllByRole('button')` | `buttons(c)` |
| `fireEvent.click(el)` | `click(el)` |
| `screen.getByRole('textbox')` | `textbox(c)` |
| `fireEvent.change(el, { target: { value: 'x' } })` | `type(el, 'x')` |
| `screen.getByRole('status')` | `c.querySelector('[role="status"]')` |
| `screen.getByRole('dialog')` | `c.querySelector('[role="dialog"]')` |
| `screen.getAllByTestId('note-text')` | `Array.from(c.querySelectorAll('[data-testid="note-text"]'))` |
| `expect(el.hasAttribute('disabled')).toBe(true)` | unchanged |
| `unmount()` / `cleanup()` | handled by the harness's own `afterEach`; use `mountOnce` where a test needs to unmount mid-test |
| `rerender(<X ... />)` | `mount` a fresh tree — these components are stateless enough that re-mounting asserts the same thing |

`Harness` wrappers used in Task 13's hook tests keep their shape; only `render` becomes `mount` and `fireEvent.keyDown(window, {...})` becomes `keyDown({...})` from the harness.

### Standing rulings (made without owner review, per the spec's authorisation)

- **R-B1 — `runReview.ts` may be touched, minimally.** The spec lists `runReview`'s *orchestration* as unchanged. `Finding` gains two required fields, so the five `Finding` object literals inside `runReview.ts` will not compile without them. Task 4 adds `verification: unchecked()` and `notes: []` to those literals and changes nothing else. Cost if wrong: a trivial diff to revert.
- **R-B2 — verification writes are await-then-apply, not optimistic.** The UI shows the new state only after `saveReview` resolves. Spec §9 forbids a UI state that was not persisted; a single-record IndexedDB write is milliseconds, and revert-on-failure has a wider race surface than simply waiting. Cost if wrong: a perceptible pause on a slow disk, fixable by switching to optimistic-with-revert later.
- **R-B3 — notes live on the `Finding`, not in their own object store.** The spec's §7 data model puts `notes: Note[]` on `Finding`; they then persist, migrate and export with the review that owns them, and a review reopened from a cold load carries its notes with no second read. Cost if wrong: a notes store becomes a later migration.
- **R-B4 — the CSV's header summary is its first row, a single field.** The spec requires a header summary in both exports. A one-field first row opens as a title line in Excel and does not disturb the header row beneath it. Cost if wrong: a stricter CSV consumer needs the first row skipped.
- **R-B5 — page derivation reads the `[Page N]` markers in `DocumentRecord.text`, not the PDF.** `parsePdf` already writes `[Page N]\n` before each page's text and that text is what persists, what the model was shown, and what survives a reload. Deriving from it needs no pdfjs, works before the viewer ever opens, and leaves the matcher untouched. Cost if wrong: pages are absent (never wrong) for documents whose markers were lost.

---

## File Structure

**New leaf modules** (no imports beyond types and each other; each is one responsibility, each is unit-testable without a DOM):

| File | Responsibility |
|---|---|
| `src/lib/verification.ts` | The state machine. `unchecked()`, `applyVerification()`, `requiresReason()`, `resetVerification()`. Nothing else decides what a legal transition is. |
| `src/lib/citationPage.ts` | `derivePage(documentText, quote)` — the *only* place a page number is produced. Returns `undefined` rather than guessing. |
| `src/lib/citationRepair.ts` | `repairCitations(raw, documentId, documentText?)` — turns anything (a `string[]` from v1/A, a partial `Citation[]`, junk) into a valid `Citation[]`. Shared by the model-output path and the read-time migration, so the two can never disagree. |
| `src/lib/reviewProgress.ts` | `verificationCounts(findings)` — one counter shared by the results header and the matter home. |
| `src/lib/db/reviewMigration.ts` | `migrateReviewRecord(review)` — read-time upgrade of a persisted review to the current `SCHEMA_VERSION`. |

**Modified:**

| File | Change |
|---|---|
| `src/types.ts` | `Citation`, `Verification`, `VerificationState`, `Note`; `Finding.citations: Citation[]`, `+verification`, `+notes`; `SCHEMA_VERSION` 3 to 4. |
| `src/lib/pageSegments.ts` | `+pageSegmentsWithNumbers()`; existing `pageSegments()` reimplemented on top of it (one splitter, not two). |
| `src/lib/findingOutcome.ts` | `+verificationLabel()`, `+exportSummaryLine()`. Both exporters read them; neither invents its own wording. |
| `src/features/review/extractClause.ts` | Builds `Citation[]` via `repairCitations`; every `Finding` literal gains `verification`/`notes`. |
| `src/features/review/runReview.ts` | Five `Finding` literals gain `verification: unchecked()`, `notes: []` (ruling R-B1). Orchestration untouched. |
| `src/features/review/FindingCard.tsx` | Hover tooltip becomes inline `EvidenceList`; `StateChip` alongside `RiskChip`; verification controls; notes. |
| `src/features/review/ResultsView.tsx` | Verification progress header; verification/note handlers threaded to cards; keyboard loop. |
| `src/features/review/exportDocx.ts` | Header summary paragraph; per-clause verification row; rejected reason carried. |
| `src/features/tabular/csv.ts` | Header summary row; per-cell verification prefix. |
| `src/features/tabular/CellDetail.tsx` | Passes the new handlers through to `FindingCard`. |
| `src/features/matters/MatterHome.tsx` | Per-review verification progress; drops its private counter for the shared one. |
| `src/lib/db/reviews.ts` | `getReview`/`listReviews` run records through `migrateReviewRecord`. |
| `src/App.tsx` | Verification/note persistence (await-then-apply); retry clears verification and says so. |
| `src/components/RiskBadge.tsx` to `src/components/RiskChip.tsx` | Renamed (spec Scope item 5). |
| `src/components/StateChip.tsx` | New. |
| `README.md` | Verification and export-labelling behaviour. |

**New components:** `src/features/review/EvidenceList.tsx`, `src/features/review/VerificationControls.tsx`, `src/features/review/RejectReasonModal.tsx`, `src/features/review/NotesPanel.tsx`, `src/features/review/useVerifyKeys.ts`.

---

### Task 1: Types and the verification state machine

**Files:**
- Modify: `src/types.ts`
- Create: `src/lib/verification.ts`
- Test: `src/lib/verification.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Citation`, `VerificationState`, `Verification`, `Note`, `Finding` (upgraded), `SCHEMA_VERSION = 4`; and from `src/lib/verification.ts`: `unchecked(): Verification`, `applyVerification(current, change, byUserId, at): Verification`, `requiresReason(state): boolean`, `resetVerification(current): Verification`, `findingKey(documentId, clauseId): string`, `makeNote(...): Note`, `VerificationError`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/verification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  unchecked, applyVerification, requiresReason, resetVerification,
  findingKey, makeNote, VerificationError,
} from './verification';

describe('unchecked', () => {
  it('starts with no attribution and no timestamp', () => {
    expect(unchecked()).toEqual({ state: 'unchecked' });
  });
});

describe('requiresReason', () => {
  it('is true only for rejected', () => {
    expect(requiresReason('rejected')).toBe(true);
    expect(requiresReason('verified')).toBe(false);
    expect(requiresReason('flagged')).toBe(false);
    expect(requiresReason('unchecked')).toBe(false);
  });
});

describe('applyVerification', () => {
  it('records who and when on verify', () => {
    const v = applyVerification(unchecked(), { state: 'verified' }, 'user-1', 1000);
    expect(v).toEqual({ state: 'verified', byUserId: 'user-1', at: 1000 });
  });

  it('carries the reason on reject', () => {
    const v = applyVerification(unchecked(), { state: 'rejected', reason: 'Wrong clause' }, 'user-1', 1000);
    expect(v).toEqual({ state: 'rejected', byUserId: 'user-1', at: 1000, reason: 'Wrong clause' });
  });

  it('refuses to reject without a reason', () => {
    expect(() => applyVerification(unchecked(), { state: 'rejected' }, 'user-1', 1000))
      .toThrow(VerificationError);
  });

  it('refuses to reject with a whitespace-only reason', () => {
    expect(() => applyVerification(unchecked(), { state: 'rejected', reason: '   ' }, 'user-1', 1000))
      .toThrow(VerificationError);
  });

  it('trims the reason it stores', () => {
    const v = applyVerification(unchecked(), { state: 'rejected', reason: '  bad  ' }, 'u', 1);
    expect(v.reason).toBe('bad');
  });

  it('drops a stale reason when moving off rejected', () => {
    const rejected = applyVerification(unchecked(), { state: 'rejected', reason: 'bad' }, 'u', 1);
    const verified = applyVerification(rejected, { state: 'verified' }, 'u', 2);
    expect(verified.reason).toBeUndefined();
    expect(verified.state).toBe('verified');
  });

  it('preserves assigneeId across a state change', () => {
    const assigned = { ...unchecked(), assigneeId: 'someone' };
    const v = applyVerification(assigned, { state: 'flagged' }, 'u', 5);
    expect(v.assigneeId).toBe('someone');
  });

  it('allows every state to reach every other state', () => {
    const states = ['unchecked', 'verified', 'flagged', 'rejected'] as const;
    for (const from of states) {
      for (const to of states) {
        const start = applyVerification(
          unchecked(),
          from === 'rejected' ? { state: from, reason: 'r' } : { state: from },
          'u', 1,
        );
        const next = applyVerification(
          start,
          to === 'rejected' ? { state: to, reason: 'r' } : { state: to },
          'u', 2,
        );
        expect(next.state).toBe(to);
      }
    }
  });
});

describe('resetVerification', () => {
  it('returns a bare unchecked verification, dropping attribution and reason', () => {
    const rejected = applyVerification(unchecked(), { state: 'rejected', reason: 'bad' }, 'u', 1);
    expect(resetVerification(rejected)).toEqual({ state: 'unchecked' });
  });

  it('keeps assigneeId, which is about the clause and not about the run', () => {
    const v = { state: 'verified' as const, byUserId: 'u', at: 1, assigneeId: 'someone' };
    expect(resetVerification(v)).toEqual({ state: 'unchecked', assigneeId: 'someone' });
  });
});

describe('findingKey', () => {
  it('combines both ids, since neither alone is unique within a review', () => {
    expect(findingKey('doc-1', 'clause-2')).toBe('doc-1::clause-2');
    expect(findingKey('doc-1', 'clause-2')).not.toBe(findingKey('doc-2', 'clause-1'));
  });
});

describe('makeNote', () => {
  it('trims the text and records attribution against the composite key', () => {
    const note = makeNote('doc-1', 'clause-2', '  check the cap  ', 'user-1', 99, 'note-1');
    expect(note).toEqual({
      id: 'note-1',
      findingId: 'doc-1::clause-2',
      text: 'check the cap',
      byUserId: 'user-1',
      at: 99,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/verification.test.ts`
Expected: FAIL with `Failed to resolve import "./verification"`.

- [ ] **Step 3: Add the types**

In `src/types.ts`, insert this block immediately above the existing `export interface Finding {`:

```ts
/** One piece of attributed evidence. Replaces v1's bare quote string: a
 *  quote alone cannot say which document it came from (a review can cover
 *  several) or where in that document to look. */
export interface Citation {
  /** Verbatim substring of the document text, as the model returned it.
   *  This is what `findQuoteRects` matches on — the matcher still takes
   *  plain strings and is not to be changed. */
  quote: string;
  documentId: string;
  /** Derived from the `[Page N]` markers in the document's extracted text
   *  where the quote can be located, absent where it cannot. Never guessed:
   *  a wrong page pin sends a reader to the wrong part of a contract with
   *  apparent authority, which is worse than no pin at all. */
  page?: number;
  /** e.g. "14.2", when the model supplies one. Presentational only —
   *  nothing navigates by it. */
  clauseRef?: string;
}

export type VerificationState = 'unchecked' | 'verified' | 'flagged' | 'rejected';

/** What a *human* concluded about a finding. Deliberately separate from
 *  `Finding.status`, which describes what the *run* produced. A finding can
 *  be `status: 'done'` and `state: 'rejected'` at the same time — the model
 *  answered, and a person disagreed. */
export interface Verification {
  state: VerificationState;
  /** The local profile's id (ruling R1) — this app has one user. */
  byUserId?: string;
  at?: number;
  /** Required when `state` is 'rejected'. A rejection with no reason is a
   *  silent disagreement, useless to whoever reads the export. */
  reason?: string;
  /** Exists so the field survives into later sub-projects. Reaches nobody:
   *  there is no second user and nothing notifies (ruling R1). */
  assigneeId?: string;
}

export interface Note {
  id: string;
  /** `${documentId}::${clauseId}` — see `findingKey` in
   *  `src/lib/verification.ts`. Stored on the note so a note stays
   *  self-describing if notes are ever lifted into their own store. */
  findingId: string;
  text: string;
  byUserId: string;
  at: number;
}
```

Then inside `Finding`, replace the line `citations: string[];` with:

```ts
  /** Was `string[]` before sub-project B. Reviews persisted with the old
   *  shape are upgraded on read — see `src/lib/db/reviewMigration.ts`. */
  citations: Citation[];
  /** Always present. Every finding starts `unchecked`: there is no implicit
   *  verification, and a finding is never "probably fine". */
  verification: Verification;
  /** May be empty. */
  notes: Note[];
```

And replace the `SCHEMA_VERSION` declaration and its comment with:

```ts
/** 3 to 4: `Finding.citations` became `Citation[]`, and `Finding` gained
 *  `verification` and `notes` (sub-project B). Reviews written at 3 are
 *  upgraded on read — see `src/lib/db/reviewMigration.ts`. */
export const SCHEMA_VERSION = 4;
```

- [ ] **Step 4: Write the state machine**

Create `src/lib/verification.ts`:

```ts
import type { Note, Verification, VerificationState } from '../types';

/** Thrown when a transition would produce an invalid `Verification` — today
 *  that means exactly one thing: a rejection with no reason. Thrown rather
 *  than returned so a caller cannot accidentally persist the invalid value
 *  by ignoring a result; the UI catches it and keeps the reason dialog open.
 */
export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

export function unchecked(): Verification {
  return { state: 'unchecked' };
}

/** Only `rejected` demands a reason. A flag says "look at this"; a rejection
 *  says "this is wrong", and the reader of an export needs to know why. */
export function requiresReason(state: VerificationState): boolean {
  return state === 'rejected';
}

export interface VerificationChange {
  state: VerificationState;
  reason?: string;
}

/**
 * Every state can reach every other state — a reviewer who verified in error
 * must be able to flag it, and a rejection can be withdrawn. What is NOT
 * free-form is the shape of the result: attribution and timestamp are always
 * rewritten by the human action that caused the change, a reason is required
 * on `rejected` and dropped on everything else (a stale "wrong clause" left
 * hanging on a now-verified finding would read as if it still applied), and
 * `assigneeId` — which is about the clause, not this decision — survives.
 */
export function applyVerification(
  current: Verification,
  change: VerificationChange,
  byUserId: string,
  at: number,
): Verification {
  const reason = change.reason?.trim();

  if (requiresReason(change.state) && !reason) {
    throw new VerificationError('A rejected finding needs a reason.');
  }

  const next: Verification = { state: change.state, byUserId, at };
  if (requiresReason(change.state) && reason) next.reason = reason;
  if (current.assigneeId !== undefined) next.assigneeId = current.assigneeId;
  return next;
}

/**
 * Clears a verification because the thing it was about has changed — the
 * clause was re-run and the finding is new content. Attribution, timestamp
 * and reason all go: they described a judgement about text that no longer
 * exists, and keeping them would let an export claim a human checked
 * something they never saw. This is the single most important rule in this
 * sub-project. `assigneeId` stays because it points at a clause, not at a
 * particular run's output.
 */
export function resetVerification(current: Verification): Verification {
  const next = unchecked();
  if (current.assigneeId !== undefined) next.assigneeId = current.assigneeId;
  return next;
}

/** The stable key identifying one finding across a review: a review holds
 *  `findings[documentId][clauseId]`, so neither id alone is unique. */
export function findingKey(documentId: string, clauseId: string): string {
  return `${documentId}::${clauseId}`;
}

export function makeNote(
  documentId: string,
  clauseId: string,
  text: string,
  byUserId: string,
  at: number,
  id: string,
): Note {
  return { id, findingId: findingKey(documentId, clauseId), text: text.trim(), byUserId, at };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/verification.test.ts`
Expected: PASS (15 tests).

`npx tsc --noEmit` now reports errors across the app — every `Finding` literal is missing `verification` and `notes`, and every `citations` consumer expects `string[]`. That is expected at this point and is fixed by Tasks 3-5 and 7-12. Do NOT "fix" them here by loosening the types or by making the new fields optional; a `verification` that can be absent is a finding that can quietly claim nothing about itself, which is the failure this whole sub-project exists to remove.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/lib/verification.ts src/lib/verification.test.ts
git commit -m "feat(b): Citation, Verification and Note types plus the state machine"
```

---

### Task 2: Page derivation from the document's own page markers

**Files:**
- Modify: `src/lib/pageSegments.ts`
- Create: `src/lib/citationPage.ts`
- Test: `src/lib/citationPage.test.ts`

**Interfaces:**
- Consumes: `normalizeForMatch` from `src/lib/citations.ts` (an existing export; the matcher itself is untouched).
- Produces: `pageSegmentsWithNumbers(text): { page: number; text: string }[]` from `src/lib/pageSegments.ts`; `derivePage(documentText, quote): number | undefined` from `src/lib/citationPage.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/citationPage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { derivePage } from './citationPage';
import { pageSegments, pageSegmentsWithNumbers } from './pageSegments';

const THREE_PAGES =
  '[Page 1]\nThe Supplier shall deliver the Goods.\n\n' +
  '[Page 2]\nLiability is capped at the Charges paid.\n\n' +
  '[Page 3]\nGoverning law is England and Wales.\n\n';

describe('pageSegmentsWithNumbers', () => {
  it('returns one entry per page, carrying the page number', () => {
    const segments = pageSegmentsWithNumbers(THREE_PAGES);
    expect(segments.map(s => s.page)).toEqual([1, 2, 3]);
    expect(segments[1].text).toContain('Liability is capped');
  });

  it('returns an empty array when there are no page markers', () => {
    expect(pageSegmentsWithNumbers('just some docx text')).toEqual([]);
  });

  it('honours the page numbers written in the markers, not the ordinal', () => {
    const segments = pageSegmentsWithNumbers('[Page 7]\nseven\n\n[Page 8]\neight\n\n');
    expect(segments.map(s => s.page)).toEqual([7, 8]);
  });

  it('leaves the existing pageSegments contract intact', () => {
    expect(pageSegments(THREE_PAGES)).toEqual(pageSegmentsWithNumbers(THREE_PAGES).map(s => s.text));
    expect(pageSegments('no markers here')).toEqual(['no markers here']);
  });

  it('is repeatable — the shared regex does not carry lastIndex between calls', () => {
    expect(pageSegmentsWithNumbers(THREE_PAGES)).toEqual(pageSegmentsWithNumbers(THREE_PAGES));
  });
});

describe('derivePage', () => {
  it('finds the page a quote sits on', () => {
    expect(derivePage(THREE_PAGES, 'Liability is capped at the Charges paid.')).toBe(2);
  });

  it('matches through punctuation and whitespace differences', () => {
    expect(derivePage(THREE_PAGES, 'liability  is capped, at the charges paid')).toBe(2);
  });

  it('returns undefined when the quote is not in the document', () => {
    expect(derivePage(THREE_PAGES, 'Force majeure suspends performance.')).toBeUndefined();
  });

  it('returns undefined for a document with no page markers rather than guessing page 1', () => {
    expect(derivePage('Liability is capped at the Charges paid.', 'Liability is capped')).toBeUndefined();
  });

  it('returns undefined for a quote too short to be located reliably', () => {
    expect(derivePage(THREE_PAGES, 'the')).toBeUndefined();
  });

  it('returns the first page a repeated quote appears on', () => {
    const repeated = '[Page 1]\nNotices in writing.\n\n[Page 2]\nNotices in writing.\n\n';
    expect(derivePage(repeated, 'Notices in writing.')).toBe(1);
  });

  it('returns undefined for empty input', () => {
    expect(derivePage('', 'anything')).toBeUndefined();
    expect(derivePage(THREE_PAGES, '')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/citationPage.test.ts`
Expected: FAIL with `Failed to resolve import "./citationPage"`.

- [ ] **Step 3: Add the numbered splitter**

In `src/lib/pageSegments.ts`, keep the existing file-level doc comment, and replace the `pageSegments` function with the following two functions:

```ts
const PAGE_MARKER = /\[Page (\d+)\]\n/g;

/**
 * The same split as `pageSegments`, but keeping the page number each segment
 * was labelled with. `parsePdf` (`documents.ts`) writes each page as
 * `[Page N]\n<pageText>\n\n`, so N is the real page number — read it rather
 * than counting segments, because a document whose first page produced no
 * text still gets its marker, and an ordinal would then be off by one for
 * everything after it.
 *
 * Returns `[]` — not one unnumbered segment — for text with no markers
 * (docx, txt). A caller that needs a page number must be able to tell "this
 * document has no page information" apart from "page 1", and inventing a
 * page is the one thing citation pinning must never do.
 */
export function pageSegmentsWithNumbers(text: string): { page: number; text: string }[] {
  const markers = [...text.matchAll(PAGE_MARKER)];
  if (markers.length === 0) return [];

  return markers.map((match, i) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < markers.length ? (markers[i + 1].index ?? text.length) : text.length;
    return { page: Number(match[1]), text: text.slice(start, end) };
  });
}

export function pageSegments(text: string): string[] {
  const numbered = pageSegmentsWithNumbers(text);
  return numbered.length > 0 ? numbered.map(s => s.text) : [text];
}
```

`PAGE_MARKER` carries the `g` flag because `matchAll` requires it. `String.prototype.matchAll` clones the regex internally rather than advancing the original's `lastIndex`, so the shared module-level constant is safe across calls — the "is repeatable" test above exists to keep that true if anyone swaps `matchAll` for a manual `exec` loop.

- [ ] **Step 4: Write the page derivation**

Create `src/lib/citationPage.ts`:

```ts
import { normalizeForMatch } from './citations';
import { pageSegmentsWithNumbers } from './pageSegments';

/** Below this many normalized characters a quote matches too much to pin a
 *  page on — the same floor `findQuoteRects` applies before it will try to
 *  locate a quote at all (its `MIN_QUOTE_LENGTH`). Duplicated as a constant
 *  here rather than imported because the matcher is not to be touched and
 *  does not export it. */
const MIN_QUOTE_LENGTH = 5;

/**
 * The one place a citation's page number is produced.
 *
 * Reads the `[Page N]` markers `parsePdf` writes into a PDF's extracted
 * text — the same text the model was shown and the same text that persists
 * in `DocumentRecord.text`, so this works at extraction time, at migration
 * time, and after a cold reload, without pdfjs and without touching the
 * verified `findQuoteRects` matcher.
 *
 * Normalization is `normalizeForMatch` — the matcher's own — so a quote the
 * viewer will successfully highlight derives the same page the viewer will
 * scroll to. Anything this cannot locate returns `undefined`: a wrong page
 * pin sends a reader to the wrong part of a contract with apparent
 * authority, which is strictly worse than no pin.
 */
export function derivePage(documentText: string, quote: string): number | undefined {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_LENGTH) return undefined;

  for (const segment of pageSegmentsWithNumbers(documentText)) {
    if (normalizeForMatch(segment.text).includes(needle)) return segment.page;
  }
  return undefined;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/citationPage.test.ts src/lib/modelContext.test.ts src/lib/documents.test.ts`
Expected: PASS. The two existing suites are included because they are `pageSegments`'s current consumers — its contract must be unchanged by this refactor.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pageSegments.ts src/lib/citationPage.ts src/lib/citationPage.test.ts
git commit -m "feat(b): derive citation page numbers from the document's page markers"
```

---

### Task 3: Citation repair — the one shape-fixer both the model path and the migration use

**Files:**
- Create: `src/lib/citationRepair.ts`
- Test: `src/lib/citationRepair.test.ts`

**Interfaces:**
- Consumes: `derivePage` (Task 2); `Citation` (Task 1).
- Produces: `repairCitations(raw: unknown, documentId: string, documentText?: string): Citation[]`.

This module exists because two callers need exactly the same conversion and the project has been bitten six times by the same shape being rebuilt twice: `extractClause` turning fresh model output into citations (Task 4), and `migrateReviewRecord` turning a stored `string[]` into citations (Task 5). Writing it once, first, is the whole point.

- [ ] **Step 1: Write the failing test**

Create `src/lib/citationRepair.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { repairCitations } from './citationRepair';

const PAGED = '[Page 1]\nThe Supplier shall deliver.\n\n[Page 2]\nLiability is capped at the Charges.\n\n';

describe('repairCitations', () => {
  it('turns v1 quote strings into attributed citations', () => {
    const out = repairCitations(['Liability is capped at the Charges.'], 'doc-1', PAGED);
    expect(out).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 },
    ]);
  });

  it('omits page when the quote cannot be located, rather than guessing', () => {
    const out = repairCitations(['Force majeure suspends performance.'], 'doc-1', PAGED);
    expect(out).toEqual([{ quote: 'Force majeure suspends performance.', documentId: 'doc-1' }]);
  });

  it('omits page when no document text is available at all', () => {
    const out = repairCitations(['Liability is capped at the Charges.'], 'doc-1');
    expect(out).toEqual([{ quote: 'Liability is capped at the Charges.', documentId: 'doc-1' }]);
  });

  it('passes through citations that are already the new shape', () => {
    const existing = [{ quote: 'q', documentId: 'doc-9', page: 4, clauseRef: '14.2' }];
    expect(repairCitations(existing, 'doc-1', PAGED)).toEqual(existing);
  });

  it('repairs a citation object missing its documentId rather than dropping it', () => {
    const out = repairCitations([{ quote: 'Liability is capped at the Charges.' }], 'doc-1', PAGED);
    expect(out).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 },
    ]);
  });

  it('keeps a clauseRef the model supplied', () => {
    const out = repairCitations([{ quote: 'The Supplier shall deliver.', clauseRef: '3.1' }], 'doc-1', PAGED);
    expect(out[0].clauseRef).toBe('3.1');
  });

  it('discards a non-numeric or non-finite stored page rather than carrying it forward', () => {
    const out = repairCitations(
      [{ quote: 'The Supplier shall deliver.', documentId: 'doc-1', page: 'two' }],
      'doc-1',
      PAGED,
    );
    expect(out[0].page).toBe(1); // re-derived, not the junk value
    const noText = repairCitations(
      [{ quote: 'somewhere else entirely', documentId: 'doc-1', page: Number.NaN }],
      'doc-1',
    );
    expect(noText[0].page).toBeUndefined();
  });

  it('drops entries with no usable quote, and only those', () => {
    const out = repairCitations(
      ['', '   ', null, 42, { documentId: 'doc-1' }, 'The Supplier shall deliver.'],
      'doc-1',
      PAGED,
    );
    expect(out).toEqual([{ quote: 'The Supplier shall deliver.', documentId: 'doc-1', page: 1 }]);
  });

  it('returns an empty array for anything that is not an array', () => {
    expect(repairCitations(undefined, 'doc-1')).toEqual([]);
    expect(repairCitations(null, 'doc-1')).toEqual([]);
    expect(repairCitations('a quote', 'doc-1')).toEqual([]);
    expect(repairCitations({ 0: 'a quote' }, 'doc-1')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = [{ quote: 'The Supplier shall deliver.' }];
    repairCitations(input, 'doc-1', PAGED);
    expect(input).toEqual([{ quote: 'The Supplier shall deliver.' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/citationRepair.test.ts`
Expected: FAIL with `Failed to resolve import "./citationRepair"`.

- [ ] **Step 3: Write the repair**

Create `src/lib/citationRepair.ts`:

```ts
import { derivePage } from './citationPage';
import type { Citation } from '../types';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Normalises anything into a valid `Citation[]`, and is the ONLY place that
 * conversion happens. Two callers need it and they must never disagree:
 * `extractClause` (fresh model output, which is `string[]` under the JSON
 * schema but arrives unvalidated from models that ignore the schema) and
 * `migrateReviewRecord` (a stored review written before sub-project B, whose
 * citations are `string[]`).
 *
 * Repair, never delete — the storage posture this project settled on in
 * sub-project A. A citation object missing its `documentId` gets the
 * document it was found under; a stored `page` that is not a finite number
 * is re-derived rather than carried forward; a `page` that cannot be derived
 * is simply absent. The only thing discarded is an entry with no usable
 * quote at all, because a citation with no quote cites nothing: it cannot be
 * displayed, cannot be matched by `findQuoteRects`, and cannot be pinned.
 *
 * `documentText` is optional so a caller with no text to hand (a review
 * whose document was deleted from the matter) still gets valid citations —
 * just without pages.
 */
export function repairCitations(
  raw: unknown,
  documentId: string,
  documentText?: string,
): Citation[] {
  if (!Array.isArray(raw)) return [];

  const out: Citation[] = [];

  for (const entry of raw) {
    const quote = typeof entry === 'string'
      ? asString(entry)
      : asString((entry as { quote?: unknown } | null)?.quote);
    if (!quote) continue;

    const source = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<Citation>;

    const citation: Citation = {
      quote,
      documentId: asString(source.documentId) ?? documentId,
    };

    // A stored page is trusted only when it is a finite number. Anything
    // else is re-derived from the text, and stays absent if it cannot be.
    const storedPage = typeof source.page === 'number' && Number.isFinite(source.page)
      ? source.page
      : undefined;
    const page = storedPage ?? (documentText ? derivePage(documentText, quote) : undefined);
    if (page !== undefined) citation.page = page;

    const clauseRef = asString(source.clauseRef);
    if (clauseRef) citation.clauseRef = clauseRef;

    out.push(citation);
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/citationRepair.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Mutation-test the repair**

This module decides what evidence survives, so a green suite is not evidence. Make each of these edits one at a time, run `npx vitest run src/lib/citationRepair.test.ts`, confirm at least one test FAILS, then revert:

1. Change `if (!quote) continue;` to `if (quote === undefined) continue;` — should still pass (equivalent); if a test fails, the test is over-specified, fix the test.
2. Change `asString(source.documentId) ?? documentId` to `documentId` — "passes through citations that are already the new shape" must fail.
3. Change `Number.isFinite(source.page)` to `true` — "discards a non-numeric or non-finite stored page" must fail.
4. Delete the `if (page !== undefined)` guard so `page` is always assigned — the resulting citation carries `page: undefined` rather than no `page` key at all.

   **Vitest's `toEqual` does NOT distinguish those two**: it treats a key whose value is `undefined` as equivalent to an absent key, so every `toEqual` assertion in this suite passes under that mutation. This was found by mutation-testing this exact step, and it is the reason the step exists. Add a test that asserts the key's absence directly:

   ```ts
   it('leaves the page key absent, not present-and-undefined', () => {
     const out = repairCitations(['Force majeure suspends performance.'], 'doc-1', PAGED);
     expect('page' in out[0]).toBe(false);
   });
   ```

   The distinction matters beyond tidiness: `structuredClone` — which is how IndexedDB writes every record — preserves a `page: undefined` key, so an unguarded assignment would persist a `page` property on every citation that has no page, and any later `'page' in citation` check would then be wrong about every one of them.

Record in the task report which mutations were caught and which needed a new test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/citationRepair.ts src/lib/citationRepair.test.ts
git commit -m "feat(b): repairCitations, shared by the model path and the read-time migration"
```

---

### Task 4: The extraction path produces attributed citations and an unchecked verification

**Files:**
- Modify: `src/features/review/extractClause.ts`
- Modify: `src/features/review/runReview.ts`
- Test: `src/features/review/extractClause.test.ts` (extend), `src/features/review/runReview.test.ts` (extend)

**Interfaces:**
- Consumes: `repairCitations` (Task 3), `unchecked` (Task 1).
- Produces: every `Finding` this codebase creates now satisfies the Task 1 type — `citations: Citation[]`, `verification: Verification`, `notes: Note[]`.

Ruling R-B1 applies: `runReview.ts` gains two fields on five object literals and nothing else. Do not restructure its orchestration.

- [ ] **Step 1: Write the failing test**

Append to `src/features/review/extractClause.test.ts` (keep the file's existing imports and mocking pattern — read the top of the file first and follow it exactly):

```ts
describe('extractClause citations and verification', () => {
  it('attributes each citation to the document and pins a page where derivable', async () => {
    const doc = makeDoc({
      id: 'doc-42',
      text: '[Page 1]\nThe Supplier shall deliver.\n\n[Page 2]\nLiability is capped at the Charges.\n\n',
    });
    mockChatJson({
      summary: 'Liability is capped.',
      citations: ['Liability is capped at the Charges.'],
      risk_level: 'Medium',
      risk_analysis: 'Standard cap.',
    });

    const finding = await extractClause(doc, clause, template, settings);

    expect(finding.citations).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-42', page: 2 },
    ]);
  });

  it('starts every finding unchecked with no notes', async () => {
    mockChatJson({ summary: 'Found it.', citations: [], risk_level: 'Low', risk_analysis: 'Fine.' });
    const finding = await extractClause(makeDoc(), clause, template, settings);
    expect(finding.verification).toEqual({ state: 'unchecked' });
    expect(finding.notes).toEqual([]);
  });

  it('starts an error finding unchecked too — a failure is not a judgement', async () => {
    const finding = await extractClause(
      makeDoc({ parseError: 'corrupt' }), clause, template, settings,
    );
    expect(finding.status).toBe('error');
    expect(finding.verification).toEqual({ state: 'unchecked' });
    expect(finding.notes).toEqual([]);
  });

  it('drops junk citation entries without dropping the good ones', async () => {
    mockChatJson({
      summary: 'Found it.',
      citations: ['', 'The Supplier shall deliver.', null],
      risk_level: 'Low',
      risk_analysis: 'Fine.',
    });
    const doc = makeDoc({ id: 'doc-7', text: '[Page 1]\nThe Supplier shall deliver.\n\n' });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([
      { quote: 'The Supplier shall deliver.', documentId: 'doc-7', page: 1 },
    ]);
  });
});
```

Append to `src/features/review/runReview.test.ts`:

```ts
describe('runReview finding scaffolding', () => {
  it('seeds every pending cell unchecked with no citations and no notes', () => {
    const run = emptyRun(template, [docA, docB]);
    for (const byClause of Object.values(run.findings)) {
      for (const finding of Object.values(byClause)) {
        expect(finding.status).toBe('pending');
        expect(finding.citations).toEqual([]);
        expect(finding.verification).toEqual({ state: 'unchecked' });
        expect(finding.notes).toEqual([]);
      }
    }
  });
});
```

Adapt the helper names (`makeDoc`, `mockChatJson`, `clause`, `template`, `settings`, `docA`, `docB`) to whatever those two existing suites already use; do not introduce a second set of fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/review/extractClause.test.ts src/features/review/runReview.test.ts`
Expected: FAIL — citations come back as bare strings, `verification` is undefined.

- [ ] **Step 3: Update the extraction path**

In `src/features/review/extractClause.ts`:

Add to the imports:

```ts
import { repairCitations } from '../../lib/citationRepair';
import { unchecked } from '../../lib/verification';
```

Change the `base` literal:

```ts
  const base: Finding = {
    clauseId: clause.id,
    status: 'error',
    citations: [],
    verification: unchecked(),
    notes: [],
  };
```

Replace the `const citations = ...` line with:

```ts
    // `repairCitations` is shared with the read-time review migration
    // (`src/lib/db/reviewMigration.ts`) precisely so fresh model output and
    // migrated v1 output can never end up in different shapes. It also
    // derives each quote's page from the document's `[Page N]` markers —
    // and leaves `page` absent where the quote cannot be located, rather
    // than guessing.
    //
    // `doc.text`, NOT `readability.text`. It is tempting to pass the text
    // the model was actually shown, but `readability.text` comes from
    // `usableText`, which splits on the page markers (discarding them) and
    // drops any page below `SCAN_TEXT_THRESHOLD` before rejoining. So it
    // has no markers to read, and its pages would be renumbered even if it
    // did. `doc.text` keeps every marker and every page, which makes its
    // numbers the real ones — the same numbers `findQuoteRects` will scroll
    // the viewer to. A page pin that disagrees with the viewer is worse
    // than no pin.
    const citations = repairCitations(raw.citations, doc.id, doc.text);
```

Add `verification: unchecked(), notes: [],` to the `'cancelled'` literal in the catch block:

```ts
      return { clauseId: clause.id, status: 'cancelled', citations: [], verification: unchecked(), notes: [] };
```

And to the successful `'done'` return:

```ts
    return {
      clauseId: clause.id,
      status: 'done',
      summary,
      citations,
      riskLevel: level,
      riskAnalysis,
      truncated: truncated || undefined,
      verification: unchecked(),
      notes: [],
    };
```

The `noContent` early return already spreads `base`, so it inherits `verification`/`notes` from there — verify that by reading it rather than assuming.

- [ ] **Step 4: Update runReview's finding literals**

In `src/features/review/runReview.ts`, add the import:

```ts
import { unchecked } from '../../lib/verification';
```

and add `verification: unchecked(), notes: []` to each of the five `Finding` object literals (in `emptyRun`, the cancellation path, the running-cell path, and both in `retryCell`). Change nothing else in this file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/review/extractClause.test.ts src/features/review/runReview.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/review/extractClause.ts src/features/review/runReview.ts src/features/review/extractClause.test.ts src/features/review/runReview.test.ts
git commit -m "feat(b): extraction produces attributed citations and an unchecked verification"
```

---

### Task 5: Read-time migration of reviews written before sub-project B

**Files:**
- Create: `src/lib/db/reviewMigration.ts`
- Modify: `src/lib/db/reviews.ts`
- Test: `src/lib/db/reviewMigration.test.ts`, `src/lib/db/reviews.test.ts` (extend)

**Interfaces:**
- Consumes: `repairCitations` (Task 3), `unchecked` (Task 1), `Review`/`Finding` (Task 1).
- Produces: `migrateReviewRecord(raw: unknown, documentText?: (documentId: string) => string | undefined): Review` from `src/lib/db/reviewMigration.ts`.

The document text needed to derive pages is not inside the review record — it lives in the `documents` store. Rather than make this migration reach into another store (and become async, and become untestable in isolation), it takes an optional lookup function. `getReview`/`listReviews` pass nothing, so a migrated review's citations carry no page; the review *screen* has the documents loaded and re-derives pages there. This is deliberate: an old review opens correctly and immediately, and gains its page pins the moment the document it cites is on screen.

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/reviewMigration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { migrateReviewRecord } from './reviewMigration';

function legacyReview() {
  return {
    id: 'rev-1',
    matterId: 'matter-1',
    playbookSnapshot: { id: 'pb', name: 'PB', contractType: 'NDA', mode: 'extraction', systemPrompt: '', formatPrompt: '', clauses: [], createdAt: 0, updatedAt: 0, schemaVersion: 2 },
    documentIds: ['doc-1'],
    findings: {
      'doc-1': {
        'clause-1': {
          clauseId: 'clause-1',
          status: 'done',
          summary: 'Capped at the Charges.',
          citations: ['Liability is capped at the Charges.'],
          riskLevel: 'Medium',
          riskAnalysis: 'Standard.',
        },
      },
    },
    modelId: 'some/model',
    startedAt: 10,
    completedAt: 20,
    createdByUserId: 'user-1',
  };
}

describe('migrateReviewRecord', () => {
  it('upgrades string citations to attributed citations against their own document', () => {
    const review = migrateReviewRecord(legacyReview());
    expect(review.findings['doc-1']['clause-1'].citations).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-1' },
    ]);
  });

  it('derives pages when a document text lookup is supplied', () => {
    const review = migrateReviewRecord(legacyReview(), () =>
      '[Page 1]\nIntro.\n\n[Page 2]\nLiability is capped at the Charges.\n\n');
    expect(review.findings['doc-1']['clause-1'].citations[0].page).toBe(2);
  });

  it('marks every migrated finding unchecked — nothing was ever verified before B existed', () => {
    const review = migrateReviewRecord(legacyReview());
    expect(review.findings['doc-1']['clause-1'].verification).toEqual({ state: 'unchecked' });
    expect(review.findings['doc-1']['clause-1'].notes).toEqual([]);
  });

  it('leaves an already-migrated review untouched, including its verification', () => {
    const current = legacyReview() as unknown as Record<string, never>;
    const finding = {
      clauseId: 'clause-1',
      status: 'done',
      summary: 'Capped.',
      citations: [{ quote: 'q', documentId: 'doc-1', page: 3 }],
      verification: { state: 'verified', byUserId: 'user-1', at: 55 },
      notes: [{ id: 'n1', findingId: 'doc-1::clause-1', text: 'ok', byUserId: 'user-1', at: 56 }],
    };
    const input = { ...legacyReview(), findings: { 'doc-1': { 'clause-1': finding } } };
    void current;
    const review = migrateReviewRecord(input);
    expect(review.findings['doc-1']['clause-1'].verification).toEqual({ state: 'verified', byUserId: 'user-1', at: 55 });
    expect(review.findings['doc-1']['clause-1'].citations).toEqual([{ quote: 'q', documentId: 'doc-1', page: 3 }]);
    expect(review.findings['doc-1']['clause-1'].notes).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = migrateReviewRecord(legacyReview());
    const twice = migrateReviewRecord(once);
    expect(twice).toEqual(once);
  });

  it('repairs a malformed finding rather than dropping it', () => {
    const input = {
      ...legacyReview(),
      findings: { 'doc-1': { 'clause-1': { summary: 'orphaned', citations: 'not an array' } } },
    };
    const finding = migrateReviewRecord(input).findings['doc-1']['clause-1'];
    expect(finding.summary).toBe('orphaned');
    expect(finding.clauseId).toBe('clause-1');   // recovered from its own key
    expect(finding.status).toBe('error');        // unknown status is not silently 'done'
    expect(finding.citations).toEqual([]);
    expect(finding.verification).toEqual({ state: 'unchecked' });
  });

  it('keeps an unrecognised finding status out of done', () => {
    const input = {
      ...legacyReview(),
      findings: { 'doc-1': { 'clause-1': { clauseId: 'clause-1', status: 'weird', citations: [] } } },
    };
    expect(migrateReviewRecord(input).findings['doc-1']['clause-1'].status).toBe('error');
  });

  it('survives a findings map that is missing or not an object', () => {
    expect(migrateReviewRecord({ ...legacyReview(), findings: undefined }).findings).toEqual({});
    expect(migrateReviewRecord({ ...legacyReview(), findings: 'nope' }).findings).toEqual({});
  });

  it('does not mutate the record it was given', () => {
    const input = legacyReview();
    migrateReviewRecord(input);
    expect(input.findings['doc-1']['clause-1'].citations).toEqual(['Liability is capped at the Charges.']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/reviewMigration.test.ts`
Expected: FAIL with `Failed to resolve import "./reviewMigration"`.

- [ ] **Step 3: Write the migration**

Create `src/lib/db/reviewMigration.ts`:

```ts
import { repairCitations } from '../citationRepair';
import { unchecked } from '../verification';
import type { Finding, Note, Review, Verification } from '../../types';

const STATUSES: Finding['status'][] = ['pending', 'running', 'done', 'error', 'cancelled'];
const STATES: Verification['state'][] = ['unchecked', 'verified', 'flagged', 'rejected'];

/** A stored status this version does not recognise becomes `error`, never
 *  `done`. A finding whose status cannot be read is a finding nobody can
 *  vouch for, and the one thing it must not do is render as a completed,
 *  trustworthy result. */
function readStatus(v: unknown): Finding['status'] {
  return STATUSES.includes(v as Finding['status']) ? (v as Finding['status']) : 'error';
}

/** A stored verification is trusted only when its state is one this version
 *  knows AND a rejection carries its reason. Anything else falls back to
 *  `unchecked` — the honest answer for "we cannot tell what a human
 *  concluded here" — because a half-read verification that renders as
 *  `verified` is exactly the false confidence this sub-project exists to
 *  remove. */
function readVerification(v: unknown): Verification {
  if (!v || typeof v !== 'object') return unchecked();
  const src = v as Partial<Verification>;
  if (!STATES.includes(src.state as Verification['state'])) return unchecked();
  if (src.state === 'rejected' && (typeof src.reason !== 'string' || src.reason.trim() === '')) {
    return unchecked();
  }

  const out: Verification = { state: src.state as Verification['state'] };
  if (typeof src.byUserId === 'string') out.byUserId = src.byUserId;
  if (typeof src.at === 'number' && Number.isFinite(src.at)) out.at = src.at;
  if (src.state === 'rejected' && typeof src.reason === 'string') out.reason = src.reason.trim();
  if (typeof src.assigneeId === 'string') out.assigneeId = src.assigneeId;
  return out;
}

function readNotes(v: unknown): Note[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((n): Note[] => {
    if (!n || typeof n !== 'object') return [];
    const src = n as Partial<Note>;
    if (typeof src.text !== 'string' || src.text.trim() === '') return [];
    return [{
      id: typeof src.id === 'string' ? src.id : `${src.findingId ?? 'note'}-${src.at ?? 0}`,
      findingId: typeof src.findingId === 'string' ? src.findingId : '',
      text: src.text,
      byUserId: typeof src.byUserId === 'string' ? src.byUserId : '',
      at: typeof src.at === 'number' && Number.isFinite(src.at) ? src.at : 0,
    }];
  });
}

function migrateFinding(
  raw: unknown,
  documentId: string,
  clauseId: string,
  documentText: string | undefined,
): Finding {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Finding> & Record<string, unknown>;

  const finding: Finding = {
    clauseId: typeof src.clauseId === 'string' && src.clauseId ? src.clauseId : clauseId,
    status: readStatus(src.status),
    citations: repairCitations(src.citations, documentId, documentText),
    verification: readVerification(src.verification),
    notes: readNotes(src.notes),
  };

  if (typeof src.summary === 'string') finding.summary = src.summary;
  if (typeof src.riskLevel === 'string') finding.riskLevel = src.riskLevel as Finding['riskLevel'];
  if (typeof src.riskAnalysis === 'string') finding.riskAnalysis = src.riskAnalysis;
  if (typeof src.error === 'string') finding.error = src.error;
  if (src.edited === true) finding.edited = true;
  if (src.authError === true) finding.authError = true;
  if (src.truncated === true) finding.truncated = true;
  if (src.noContent === true) finding.noContent = true;

  return finding;
}

/**
 * Upgrades a persisted review to the current schema on read.
 *
 * Reviews written by sub-project A hold `citations: string[]` and have no
 * `verification` or `notes` at all. They must open — the work in them is
 * real — and they must open honestly: every finding comes back `unchecked`,
 * because nothing in the app could have verified anything before this
 * sub-project existed.
 *
 * The same posture the storage layer took in sub-project A applies here:
 * repair rather than drop. A finding whose status is unreadable becomes an
 * `error` finding that says so, not a `done` one; a verification that cannot
 * be read in full becomes `unchecked`, not a guess. Nothing is discarded
 * except a citation with no quote (which cites nothing) and a note with no
 * text.
 *
 * `documentText` is an optional lookup rather than a required argument so
 * this stays synchronous and independently testable, and so `getReview` need
 * not read the `documents` store to return a review. Callers that already
 * have the document text loaded (the review screen) pass it and get page
 * pins; callers that do not (a matter's review list) get correct citations
 * without pages.
 */
export function migrateReviewRecord(
  raw: unknown,
  documentText?: (documentId: string) => string | undefined,
): Review {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Review> & Record<string, unknown>;

  const findings: Review['findings'] = {};
  const rawFindings = src.findings;
  if (rawFindings && typeof rawFindings === 'object' && !Array.isArray(rawFindings)) {
    for (const [documentId, byClause] of Object.entries(rawFindings)) {
      if (!byClause || typeof byClause !== 'object') continue;
      const text = documentText?.(documentId);
      findings[documentId] = {};
      for (const [clauseId, finding] of Object.entries(byClause as Record<string, unknown>)) {
        findings[documentId][clauseId] = migrateFinding(finding, documentId, clauseId, text);
      }
    }
  }

  return { ...(src as Review), findings };
}
```

- [ ] **Step 4: Wire it into the read path**

In `src/lib/db/reviews.ts`, add the import:

```ts
import { migrateReviewRecord } from './reviewMigration';
```

and change `stripSeq` so every read goes through the migration in one place:

```ts
function stripSeq(record: StoredReview): Review {
  const { _seq, ...review } = record;
  void _seq;
  // Every read path — `getReview`, `listReviews` — funnels through here, so
  // a review written before sub-project B is upgraded exactly once, in one
  // place, no matter which screen asked for it. Deliberately no document
  // text: see `migrateReviewRecord`'s own note on why pages are derived at
  // the screen instead.
  return migrateReviewRecord(review);
}
```

- [ ] **Step 5: Extend the reviews suite**

Append to `src/lib/db/reviews.test.ts` (follow the file's existing `fake-indexeddb` setup):

```ts
it('returns a pre-B review with its citations upgraded and every finding unchecked', async () => {
  const legacy = {
    ...makeReview({ id: 'rev-legacy' }),
    findings: {
      'doc-1': {
        'clause-1': { clauseId: 'clause-1', status: 'done', summary: 's', citations: ['a quote here'] },
      },
    },
  };
  const db = await getDb();
  await db.put(STORES.reviews, legacy as never);

  const read = await getReview('rev-legacy');
  expect(read!.findings['doc-1']['clause-1'].citations)
    .toEqual([{ quote: 'a quote here', documentId: 'doc-1' }]);
  expect(read!.findings['doc-1']['clause-1'].verification).toEqual({ state: 'unchecked' });
});

it('migrates on listReviews too, not only on getReview', async () => {
  const legacy = {
    ...makeReview({ id: 'rev-legacy-2', matterId: 'matter-legacy' }),
    findings: { 'doc-1': { 'clause-1': { clauseId: 'clause-1', status: 'done', citations: ['another quote'] } } },
  };
  const db = await getDb();
  await db.put(STORES.reviews, legacy as never);

  const [read] = await listReviews('matter-legacy');
  expect(read.findings['doc-1']['clause-1'].citations)
    .toEqual([{ quote: 'another quote', documentId: 'doc-1' }]);
});
```

Adapt `makeReview` to the fixture helper that suite already has; if it has none, build the record inline from the `Review` shape rather than adding a second fixture style.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/db/reviewMigration.test.ts src/lib/db/reviews.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation-test the migration**

This runs exactly once per stored review and can silently misrepresent a human judgement. Make each edit, run `npx vitest run src/lib/db/reviewMigration.test.ts`, confirm a FAILURE, revert:

1. In `readStatus`, change the fallback from `'error'` to `'done'` — "keeps an unrecognised finding status out of done" must fail.
2. In `readVerification`, delete the rejected-needs-a-reason check — add a test if none fails: a stored `{ state: 'rejected' }` with no reason must come back `unchecked`.
3. In `migrateFinding`, change the `clauseId` fallback to `''` — "repairs a malformed finding rather than dropping it" must fail.
4. In `migrateReviewRecord`, return `src as Review` unchanged when `src.findings` already looks migrated — "is idempotent" should still pass but "does not mutate" must fail; this proves the tests distinguish a real pass-through from a short-circuit.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/reviewMigration.ts src/lib/db/reviewMigration.test.ts src/lib/db/reviews.ts src/lib/db/reviews.test.ts
git commit -m "feat(b): migrate pre-B reviews on read, repairing rather than dropping"
```

---

### Task 6: StateChip, and RiskBadge becomes RiskChip

**Files:**
- Create: `src/components/StateChip.tsx`
- Create: `src/components/RiskChip.tsx` (from `src/components/RiskBadge.tsx`)
- Delete: `src/components/RiskBadge.tsx`
- Modify: every importer of `RiskBadge`
- Test: `src/components/StateChip.test.tsx`

**Interfaces:**
- Consumes: `VerificationState`, `RiskLevel`.
- Produces: `StateChip({ verification }: { verification: Verification })`, `RiskChip({ level }: { level: RiskLevel | undefined })`.

The spec requires these be distinct components because "verification state and risk level must never be conflated in one badge." They are separate today only by accident of naming; naming them as a pair now is cheaper than renaming after sub-projects C, D and E reference them — the same reasoning that renamed `Template` to `Playbook` in sub-project A.

- [ ] **Step 0: Create the shared component-test harness**

Every component test in this sub-project uses this. It is extracted rather than copied because five existing test files have each hand-rolled the same `mount` function already — this project's own rule is to extract on the second copy, and this is the sixth.

The five existing files are **not** rewritten to use it. They work, they are the thing that catches regressions, and sweeping them for no behavioural gain is churn with real risk. New tests use the shared harness; old ones stay as they are.

Create `src/test/mount.tsx`:

```tsx
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

// The precedent this follows is Toast.test.tsx: there is no
// @testing-library/react in this project, so component tests drive a real
// react-dom root directly. This module is that pattern extracted, after
// five separate test files had each written their own copy of it.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { container: HTMLDivElement; root: Root }[] = [];

/** Mounts a tree and returns its container. Unmounted automatically after
 *  the test — a leaked root keeps rendering into a detached DOM and turns
 *  a later test's failure into a mystery. */
export function mount(node: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  mounted.push({ container, root });
  return container;
}

/** Same, but hands back an explicit unmount for a test that needs to prove
 *  something about teardown (e.g. that a global listener was removed). */
export function mountOnce(node: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return {
    container,
    unmount: () => { act(() => { root.unmount(); }); container.remove(); },
  };
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => { root.unmount(); });
    container.remove();
  }
});

export function buttons(container: ParentNode): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

/** The button whose visible text matches. Also checks `aria-label`, so an
 *  icon-only button is findable by the name a screen reader would announce
 *  — which is the name it should be findable by. */
export function buttonNamed(container: ParentNode, name: RegExp): HTMLButtonElement | undefined {
  return buttons(container).find(b =>
    name.test(b.textContent || '') || name.test(b.getAttribute('aria-label') || ''));
}

export function textbox(container: ParentNode): HTMLTextAreaElement | HTMLInputElement | null {
  return container.querySelector('textarea, input[type="text"]');
}

export function click(element: Element | null | undefined): void {
  if (!element) throw new Error('click() was given nothing to click — the query above it found no element.');
  act(() => { (element as HTMLElement).click(); });
}

/**
 * Types into a controlled React input.
 *
 * Setting `.value` directly does not work: React installs its own value
 * setter on the element instance and reads from its internal tracker, so a
 * plain assignment updates the DOM but leaves React believing nothing
 * changed, and the `input` event is then treated as a no-op. Going through
 * the prototype's setter is what makes React see the change — this is the
 * standard workaround and the reason this helper exists rather than each
 * test doing it by hand.
 */
export function type(element: HTMLTextAreaElement | HTMLInputElement | null, value: string): void {
  if (!element) throw new Error('type() was given nothing to type into.');
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('No value setter on the element prototype.');
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A keydown on `window`, for hooks that bind global shortcuts. */
export function keyDown(init: KeyboardEventInit): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });
}

/** A keydown on a specific element, for proving a shortcut is ignored while
 *  the user is typing. */
export function keyDownOn(element: Element, init: KeyboardEventInit): void {
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });
}
```

Verify it works before relying on it: `npx vitest run src/features/review/FindingCard.test.tsx` must still pass (it uses its own harness and must be unaffected), and the `StateChip` tests below are the harness's first real exercise.

- [ ] **Step 1: Write the failing test**

Create `src/components/StateChip.test.tsx`, using the harness from Step 0 and the translation table in Global Constraints:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StateChip } from './StateChip';

describe('StateChip', () => {
  it('says plainly that an unchecked finding is unverified', () => {
    render(<StateChip verification={{ state: 'unchecked' }} />);
    expect(screen.getByText(/unverified/i)).toBeTruthy();
  });

  it('renders something for every state — none is silent', () => {
    for (const state of ['unchecked', 'verified', 'flagged'] as const) {
      const { unmount } = render(<StateChip verification={{ state }} />);
      expect(screen.getByRole('status').textContent?.trim()).not.toBe('');
      unmount();
    }
    const { unmount } = render(<StateChip verification={{ state: 'rejected', reason: 'wrong' }} />);
    expect(screen.getByRole('status').textContent?.trim()).not.toBe('');
    unmount();
  });

  it('exposes the reason on a rejected chip', () => {
    render(<StateChip verification={{ state: 'rejected', reason: 'Cites the wrong clause' }} />);
    expect(screen.getByRole('status').getAttribute('title')).toContain('Cites the wrong clause');
  });

  it('does not render a risk level — the two must never be one badge', () => {
    render(<StateChip verification={{ state: 'verified' }} />);
    expect(screen.queryByText(/high|medium|low|info/i)).toBeNull();
  });
});
```

If `@testing-library/react` is not already a devDependency, check first: the existing `FindingCard.test.tsx` renders components, so follow whatever it imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/StateChip.test.tsx`
Expected: FAIL with `Failed to resolve import "./StateChip"`.

- [ ] **Step 3: Rename RiskBadge to RiskChip**

```bash
git mv src/components/RiskBadge.tsx src/components/RiskChip.tsx
```

In `src/components/RiskChip.tsx`, rename the exported function `RiskBadge` to `RiskChip` and the `RISK_CLASSES` constant stays as-is. Add above it:

```tsx
/** The risk level the *model* assigned. Its counterpart is `StateChip`,
 *  which shows what a *human* concluded. They are deliberately two
 *  components and must never be merged into one badge: a High-risk finding
 *  nobody has checked and a High-risk finding a lawyer has verified are
 *  different things, and a single badge cannot say which is which. */
```

Then update every importer. Find them with:

```bash
grep -rn "RiskBadge" src
```

At the time of writing that is `src/features/review/FindingCard.tsx` and `src/features/tabular/TabularReview.tsx` — verify with the grep rather than trusting this list.

- [ ] **Step 4: Write StateChip**

Create `src/components/StateChip.tsx`:

```tsx
import React from 'react';
import { CircleDashed, CheckCircle2, Flag, XCircle } from 'lucide-react';
import type { Verification, VerificationState } from '../types';

const CHIP: Record<VerificationState, { label: string; classes: string; Icon: typeof CircleDashed }> = {
  // "Unverified" rather than "Unchecked": the chip is read by someone
  // deciding whether to rely on the finding, and "unverified AI output" is
  // the phrase the export uses. The two must say the same thing.
  unchecked: { label: 'Unverified', classes: 'bg-white/5 text-gray-400 border-white/10', Icon: CircleDashed },
  verified: { label: 'Verified', classes: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20', Icon: CheckCircle2 },
  flagged: { label: 'Flagged', classes: 'bg-amber-500/15 text-amber-300 border-amber-500/20', Icon: Flag },
  rejected: { label: 'Rejected', classes: 'bg-red-500/15 text-red-300 border-red-500/20', Icon: XCircle },
};

/**
 * What a *human* concluded about this finding. Always rendered — there is no
 * "no chip" state, because an absent chip would read as "fine", and the
 * whole point of this sub-project is that an unchecked finding says so.
 *
 * Its counterpart is `RiskChip`, which shows the model's risk level. They
 * are separate components on purpose (spec Scope item 5).
 */
export function StateChip({ verification }: { verification: Verification }) {
  const { label, classes, Icon } = CHIP[verification.state] ?? CHIP.unchecked;
  const title = verification.state === 'rejected' && verification.reason
    ? `Rejected: ${verification.reason}`
    : label;

  return (
    <span
      role="status"
      title={title}
      className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold border inline-flex items-center gap-1 ${classes}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {label}
    </span>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/StateChip.test.tsx src/features/review/FindingCard.test.tsx`
Expected: `StateChip` PASS. `FindingCard` may still fail on the Task 1 type change — that is Task 7's job. `npx tsc --noEmit` must report no *new* errors mentioning `RiskBadge`.

- [ ] **Step 6: Commit**

```bash
git add -A src/components src/features/review/FindingCard.tsx src/features/tabular/TabularReview.tsx
git commit -m "feat(b): add StateChip and rename RiskBadge to RiskChip"
```

---

### Task 7: Inline evidence with a document and page pin

**Files:**
- Create: `src/features/review/EvidenceList.tsx`
- Modify: `src/features/review/FindingCard.tsx`
- Test: `src/features/review/EvidenceList.test.tsx`, `src/features/review/FindingCard.test.tsx` (extend)

**Interfaces:**
- Consumes: `Citation` (Task 1), `StateChip`/`RiskChip` (Task 6).
- Produces: `EvidenceList({ citations, documentNames, onCiteClick })`; `FindingCardProps` gains `documentNames?: Record<string, string>`, and its `onCiteClick` signature is unchanged (`(quotes: string[]) => void`) so `ResultsView` and `CellDetail` keep working.

The spec's requirement is blunt: evidence is "the quoted text visible in the finding, with its document/page pin, not a hover tooltip." Today the quote is only visible on `:hover` over a "Ref 1" button — invisible on touch, invisible to a keyboard user, invisible in a screenshot, and invisible to anyone reading the screen rather than probing it. Clicking still drives the viewer's highlight; that behaviour is verified and does not change.

- [ ] **Step 1: Write the failing test**

Create `src/features/review/EvidenceList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EvidenceList } from './EvidenceList';

const CITATIONS = [
  { quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 },
  { quote: 'Notices must be in writing.', documentId: 'doc-1' },
];

describe('EvidenceList', () => {
  it('shows each quote as readable text, not only on hover', () => {
    render(<EvidenceList citations={CITATIONS} documentNames={{ 'doc-1': 'MSA.pdf' }} onCiteClick={() => {}} />);
    expect(screen.getByText(/Liability is capped at the Charges\./)).toBeTruthy();
    expect(screen.getByText(/Notices must be in writing\./)).toBeTruthy();
  });

  it('pins a citation to its document and page', () => {
    render(<EvidenceList citations={CITATIONS} documentNames={{ 'doc-1': 'MSA.pdf' }} onCiteClick={() => {}} />);
    expect(screen.getByText(/MSA\.pdf.*p\.\s*2/)).toBeTruthy();
  });

  it('says the document name alone when no page could be derived', () => {
    render(<EvidenceList citations={[CITATIONS[1]]} documentNames={{ 'doc-1': 'MSA.pdf' }} onCiteClick={() => {}} />);
    const pin = screen.getByText(/MSA\.pdf/);
    expect(pin.textContent).not.toMatch(/p\./);
  });

  it('falls back to the document id when the name is unknown', () => {
    render(<EvidenceList citations={[CITATIONS[1]]} documentNames={{}} onCiteClick={() => {}} />);
    expect(screen.getByText(/doc-1/)).toBeTruthy();
  });

  it('shows a clauseRef when the model supplied one', () => {
    render(
      <EvidenceList
        citations={[{ quote: 'q that is long enough', documentId: 'doc-1', clauseRef: '14.2' }]}
        documentNames={{ 'doc-1': 'MSA.pdf' }}
        onCiteClick={() => {}}
      />,
    );
    expect(screen.getByText(/14\.2/)).toBeTruthy();
  });

  it('hands the clicked quote to the viewer', () => {
    const onCiteClick = vi.fn();
    render(<EvidenceList citations={CITATIONS} documentNames={{}} onCiteClick={onCiteClick} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(onCiteClick).toHaveBeenCalledWith(['Liability is capped at the Charges.']);
  });

  it('renders nothing at all when there are no citations', () => {
    const { container } = render(<EvidenceList citations={[]} documentNames={{}} onCiteClick={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
```

Append to `src/features/review/FindingCard.test.tsx`:

```tsx
describe('FindingCard verification and evidence', () => {
  it('always shows a state chip, including on an unchecked finding', () => {
    render(<FindingCard {...baseProps} finding={doneFinding({ verification: { state: 'unchecked' } })} />);
    expect(screen.getByText(/unverified/i)).toBeTruthy();
  });

  it('shows the quote text inline without any hover interaction', () => {
    const finding = doneFinding({
      citations: [{ quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 }],
    });
    render(<FindingCard {...baseProps} finding={finding} />);
    expect(screen.getByText(/Liability is capped at the Charges\./)).toBeTruthy();
  });

  it('still drives the viewer highlight from a click', () => {
    const onCiteClick = vi.fn();
    const finding = doneFinding({ citations: [{ quote: 'a quote here', documentId: 'doc-1' }] });
    render(<FindingCard {...baseProps} finding={finding} onCiteClick={onCiteClick} />);
    fireEvent.click(screen.getByRole('button', { name: /a quote here/i }));
    expect(onCiteClick).toHaveBeenCalledWith(['a quote here']);
  });
});
```

**Checked against the file:** `FindingCard.test.tsx` has a `CLAUSE` const, its own `mount(node)` helper, and a `hasRetryButton(container)` helper. It has **no** `baseProps`, and its `doneFinding` is a local `const` inside one test, not a factory. Add both at module scope in that file, beside `CLAUSE`, and leave the existing tests untouched:

```tsx
function doneFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    clauseId: 'c1',
    status: 'done',
    summary: 'The agreement is governed by English law.',
    citations: [],
    verification: { state: 'unchecked' },
    notes: [],
    ...overrides,
  };
}

const baseProps = {
  clause: CLAUSE,
  onCiteClick: () => {},
  onRetry: () => {},
};
```

Keep that file's own `mount`, not the shared `src/test/mount.tsx` — the Task 6 rule is that existing test files keep the harness they already have. The existing local `const doneFinding` inside the interrupted-prop test will now shadow the module-scope factory; rename that local to `finding` so the two do not collide, and change nothing else about that test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/review/EvidenceList.test.tsx src/features/review/FindingCard.test.tsx`
Expected: FAIL — module not found, and `FindingCard` still renders the hover tooltip.

- [ ] **Step 3: Write EvidenceList**

Create `src/features/review/EvidenceList.tsx`:

```tsx
import React from 'react';
import { Quote } from 'lucide-react';
import type { Citation } from '../../types';

export interface EvidenceListProps {
  citations: Citation[];
  /** documentId to display name. A review can span several documents, so a
   *  quote's own document has to be named on the quote. */
  documentNames: Record<string, string>;
  /** Unchanged from the previous citation buttons: hands the viewer the one
   *  quote to highlight and scroll to. `findQuoteRects` takes plain strings
   *  and is not being changed, so this stays `string[]`. */
  onCiteClick: (quotes: string[]) => void;
}

/** "MSA.pdf - p. 2 - cl. 14.2", with each part omitted when it is not known.
 *  A page is only ever present when it was derived from the document's own
 *  page markers, never guessed (`src/lib/citationPage.ts`). */
function pinLabel(citation: Citation, documentNames: Record<string, string>): string {
  const parts = [documentNames[citation.documentId] ?? citation.documentId];
  if (citation.page !== undefined) parts.push(`p. ${citation.page}`);
  if (citation.clauseRef) parts.push(`cl. ${citation.clauseRef}`);
  return parts.join(' · ');
}

/**
 * The evidence behind a finding, readable on the page.
 *
 * This replaces a hover tooltip. The quote was previously visible only while
 * a pointer rested on a "Ref 1" button — so it was absent on touch, absent
 * for keyboard users, and absent from any screenshot of a review. Evidence
 * that has to be hunted for is evidence most readers never see, and a
 * finding whose support is invisible is indistinguishable from one with no
 * support at all.
 *
 * The whole block is still the click target that drives the document
 * viewer's highlight, so nothing is lost: reading is free, and locating the
 * passage is one click, exactly as before.
 */
export function EvidenceList({ citations, documentNames, onCiteClick }: EvidenceListProps) {
  if (citations.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1">
        <Quote className="w-3 h-3" aria-hidden="true" /> Evidence
      </div>
      {citations.map((citation, i) => (
        <button
          key={`${citation.documentId}-${i}`}
          type="button"
          onClick={() => onCiteClick([citation.quote])}
          className="w-full text-left bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/15 rounded-lg p-2.5 transition-colors group"
        >
          <p className="text-[11px] text-gray-300 leading-relaxed italic">&ldquo;{citation.quote}&rdquo;</p>
          <span className="mt-1.5 block text-[10px] text-gray-500 group-hover:text-violet-300 transition-colors">
            {pinLabel(citation, documentNames)}
          </span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Rewire FindingCard**

In `src/features/review/FindingCard.tsx`:

- Replace the `RiskBadge` import with `RiskChip`, and add `import { StateChip } from '../../components/StateChip';` and `import { EvidenceList } from './EvidenceList';`.
- Drop `MousePointerClick` from the lucide import if nothing else uses it.
- Add to `FindingCardProps`:

```tsx
  /** documentId to display name, for the pin on each piece of evidence. A
   *  review can cover several documents; a quote has to say which one it is
   *  from. Optional so the tabular cell detail (single document) can omit
   *  it — `EvidenceList` falls back to the id. */
  documentNames?: Record<string, string>;
```

- In the `done` branch, render the `StateChip` next to the existing `RiskChip` in the card header row, and replace the whole `{finding && finding.citations.length > 0 && (...)}` block — the one containing the `group-hover:block` tooltip — with:

```tsx
        {finding && (
          <EvidenceList
            citations={finding.citations}
            documentNames={documentNames ?? {}}
            onCiteClick={onCiteClick}
          />
        )}
```

- The `pending`, `running`, `error` and `cancelled` branches keep their current shape; they gain no chip. A finding with no result is not a finding anyone can verify, and a chip there would invite verifying an error.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/review/EvidenceList.test.tsx src/features/review/FindingCard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/review/EvidenceList.tsx src/features/review/EvidenceList.test.tsx src/features/review/FindingCard.tsx src/features/review/FindingCard.test.tsx
git commit -m "feat(b): inline evidence with document and page pins, replacing the hover tooltip"
```

---

### Task 8: Verification controls and the reject-reason dialog

**Files:**
- Create: `src/features/review/VerificationControls.tsx`
- Create: `src/features/review/RejectReasonModal.tsx`
- Modify: `src/features/review/FindingCard.tsx`
- Test: `src/features/review/VerificationControls.test.tsx`

**Interfaces:**
- Consumes: `applyVerification`, `requiresReason`, `VerificationError` (Task 1); `Modal` from `src/components/Modal.tsx`; `Button` from `src/components/Button.tsx`.
- Produces: `VerificationControls({ verification, busy, onChange })` where `onChange: (change: VerificationChange) => void`; `RejectReasonModal({ open, initialReason, onCancel, onConfirm })`.
  `FindingCardProps` gains `onVerify?: (change: VerificationChange) => void` and `verifyBusy?: boolean`.

`VerificationControls` is presentational: it collects the human's intent and calls `onChange`. It does not build the `Verification` object and it does not persist — Task 10 owns both, because persistence failure handling belongs where the store is (spec section 9).

- [ ] **Step 1: Write the failing test**

Create `src/features/review/VerificationControls.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VerificationControls } from './VerificationControls';

const unchecked = { state: 'unchecked' as const };

describe('VerificationControls', () => {
  it('offers verify, flag and reject', () => {
    render(<VerificationControls verification={unchecked} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /verify/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /flag/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reject/i })).toBeTruthy();
  });

  it('reports a verify with no reason', () => {
    const onChange = vi.fn();
    render(<VerificationControls verification={unchecked} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    expect(onChange).toHaveBeenCalledWith({ state: 'verified' });
  });

  it('reports a flag with no reason', () => {
    const onChange = vi.fn();
    render(<VerificationControls verification={unchecked} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /flag/i }));
    expect(onChange).toHaveBeenCalledWith({ state: 'flagged' });
  });

  it('does not reject immediately — it asks for a reason first', () => {
    const onChange = vi.fn();
    render(<VerificationControls verification={unchecked} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('refuses to confirm a rejection with an empty reason', () => {
    const onChange = vi.fn();
    render(<VerificationControls verification={unchecked} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('refuses a whitespace-only reason', () => {
    const onChange = vi.fn();
    render(<VerificationControls verification={unchecked} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the rejection once a reason is given', () => {
    const onChange = vi.fn();
    render(<VerificationControls verification={unchecked} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cites the wrong clause' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onChange).toHaveBeenCalledWith({ state: 'rejected', reason: 'Cites the wrong clause' });
  });

  it('lets a set state be cleared back to unchecked', () => {
    const onChange = vi.fn();
    render(<VerificationControls verification={{ state: 'verified', byUserId: 'u', at: 1 }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith({ state: 'unchecked' });
  });

  it('disables every action while a write is in flight', () => {
    render(<VerificationControls verification={unchecked} busy onChange={() => {}} />);
    for (const name of [/verify/i, /flag/i, /reject/i]) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/review/VerificationControls.test.tsx`
Expected: FAIL with `Failed to resolve import "./VerificationControls"`.

- [ ] **Step 3: Write the reason dialog**

Create `src/features/review/RejectReasonModal.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface RejectReasonModalProps {
  open: boolean;
  initialReason?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * A rejection is the one verification state that cannot be set silently.
 * `applyVerification` throws without a reason, and this is where the reason
 * is collected — so the throw is a backstop, never the user's experience of
 * the rule.
 *
 * Confirm stays disabled until there is non-whitespace text. The rule is
 * enforced here as well as in the state machine because a disabled button
 * explains itself and a thrown error does not.
 */
export function RejectReasonModal({ open, initialReason = '', onCancel, onConfirm }: RejectReasonModalProps) {
  const [reason, setReason] = useState(initialReason);

  // Reopening the dialog for a different finding must not inherit the last
  // one's text — a reason attached to the wrong rejection is worse than a
  // blank box.
  useEffect(() => {
    if (open) setReason(initialReason);
  }, [open, initialReason]);

  const trimmed = reason.trim();

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      title="Reject this finding"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(trimmed)} disabled={trimmed === ''}>
            Confirm rejection
          </Button>
        </>
      }
    >
      <p className="text-xs text-gray-400 leading-relaxed">
        A rejected finding is still exported, with this reason attached. Say what is wrong with it
        so whoever reads the report knows why it was not relied on.
      </p>
      <AutoResizeTextarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Cites the indemnity, not the liability cap"
        className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-sm text-white outline-none"
      />
    </Modal>
  );
}
```

**Verified facts about the components this uses** — these were checked against the real files, so do not "correct" them:

- `Modal`'s open prop is **`isOpen`**, not `open`. Its full contract is `{ isOpen, title, onClose, children, footer?, size? }`, and it returns `null` when closed. The action buttons go in the `footer` slot — that is what every other dialog in this app does, and the slot already supplies the right border and spacing.
- `Button` extends `React.ButtonHTMLAttributes`, so **`disabled` works** and already renders `disabled:opacity-50 disabled:cursor-not-allowed`. It also has a `danger` variant, used above.
- `AutoResizeTextarea` takes `value: string` and passes everything else through to the `<textarea>`.
- **`Modal` does NOT set `role="dialog"` today.** Add it to `Modal`'s panel div, together with `aria-modal="true"` — the test depends on it, and every dialog in the app gains a correct accessibility role from one three-word change. This is the one edit to a shared component this task makes; make it in `Modal.tsx` and nowhere else.

- [ ] **Step 4: Write the controls**

Create `src/features/review/VerificationControls.tsx`:

```tsx
import React, { useState } from 'react';
import { CheckCircle2, Flag, XCircle, RotateCcw } from 'lucide-react';
import type { Verification } from '../../types';
import type { VerificationChange } from '../../lib/verification';
import { RejectReasonModal } from './RejectReasonModal';

export interface VerificationControlsProps {
  verification: Verification;
  /** True while a verification write for this finding is in flight. Every
   *  action is disabled: the UI must not offer a second state change before
   *  the first is known to have persisted (spec section 9). */
  busy?: boolean;
  onChange: (change: VerificationChange) => void;
}

const ACTION = 'text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1';

/**
 * The human's four moves on a finding: verify, flag, reject-with-reason, and
 * clear back to unchecked.
 *
 * Purely presentational — it reports intent and never builds a
 * `Verification` or writes anything. Persisting is Task 10's job in
 * `App.tsx`, because that is where a failed write can be surfaced, and a
 * verification that displays without persisting is the single worst failure
 * this feature can have.
 */
export function VerificationControls({ verification, busy = false, onChange }: VerificationControlsProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const active = verification.state;

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange({ state: 'verified' })}
          className={`${ACTION} ${active === 'verified' ? 'bg-emerald-500/25 text-emerald-200 border-emerald-500/30' : 'bg-white/5 text-gray-400 border-white/10 hover:text-emerald-300'}`}
        >
          <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Verify
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange({ state: 'flagged' })}
          className={`${ACTION} ${active === 'flagged' ? 'bg-amber-500/25 text-amber-200 border-amber-500/30' : 'bg-white/5 text-gray-400 border-white/10 hover:text-amber-300'}`}
        >
          <Flag className="w-3 h-3" aria-hidden="true" /> Flag
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRejectOpen(true)}
          className={`${ACTION} ${active === 'rejected' ? 'bg-red-500/25 text-red-200 border-red-500/30' : 'bg-white/5 text-gray-400 border-white/10 hover:text-red-300'}`}
        >
          <XCircle className="w-3 h-3" aria-hidden="true" /> Reject
        </button>
        {active !== 'unchecked' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onChange({ state: 'unchecked' })}
            className={`${ACTION} bg-transparent text-gray-500 border-transparent hover:text-gray-300`}
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Clear
          </button>
        )}
      </div>

      <RejectReasonModal
        open={rejectOpen}
        initialReason={verification.state === 'rejected' ? verification.reason ?? '' : ''}
        onCancel={() => setRejectOpen(false)}
        onConfirm={(reason) => {
          setRejectOpen(false);
          onChange({ state: 'rejected', reason });
        }}
      />
    </>
  );
}
```

- [ ] **Step 5: Mount them on the card**

In `src/features/review/FindingCard.tsx`, add to `FindingCardProps`:

```tsx
  /** Reports the human's verification intent. Optional: a card rendered
   *  somewhere with no way to persist (a preview) simply shows the state
   *  chip and no controls, rather than offering an action that goes
   *  nowhere. */
  onVerify?: (change: VerificationChange) => void;
  /** True while this card's verification write is in flight. */
  verifyBusy?: boolean;
```

and in the `done` branch, below the evidence list:

```tsx
        {finding && onVerify && (
          <VerificationControls
            verification={finding.verification}
            busy={verifyBusy}
            onChange={onVerify}
          />
        )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/features/review/VerificationControls.test.tsx src/features/review/FindingCard.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutation-test the reason requirement**

Make each edit, run `npx vitest run src/features/review/VerificationControls.test.tsx src/lib/verification.test.ts`, confirm a FAILURE, revert:

1. In `RejectReasonModal`, change `disabled={trimmed === ''}` to `disabled={reason === ''}` — "refuses a whitespace-only reason" must fail.
2. In `VerificationControls`, make the Reject button call `onChange({ state: 'rejected' })` directly — "does not reject immediately" must fail.
3. In `applyVerification`, delete the `requiresReason` throw — a test in `verification.test.ts` must fail. (This is the backstop; both layers must hold independently.)

- [ ] **Step 8: Commit**

```bash
git add src/features/review/VerificationControls.tsx src/features/review/RejectReasonModal.tsx src/features/review/VerificationControls.test.tsx src/features/review/FindingCard.tsx
git commit -m "feat(b): verification controls with a mandatory rejection reason"
```

---

### Task 9: Notes on findings

**Files:**
- Create: `src/features/review/NotesPanel.tsx`
- Modify: `src/features/review/FindingCard.tsx`
- Test: `src/features/review/NotesPanel.test.tsx`

**Interfaces:**
- Consumes: `Note` (Task 1).
- Produces: `NotesPanel({ notes, authorName, busy, onAddNote })` where `onAddNote: (text: string) => void`; `FindingCardProps` gains `onAddNote?: (text: string) => void`, `noteBusy?: boolean`, `authorInitials?: string`.

- [ ] **Step 1: Write the failing test**

Create `src/features/review/NotesPanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotesPanel } from './NotesPanel';

const NOTES = [
  { id: 'n1', findingId: 'doc-1::clause-1', text: 'Check against the side letter.', byUserId: 'u', at: 1700000000000 },
  { id: 'n2', findingId: 'doc-1::clause-1', text: 'Counsel agreed.', byUserId: 'u', at: 1700000100000 },
];

describe('NotesPanel', () => {
  it('lists every note, oldest first', () => {
    render(<NotesPanel notes={NOTES} authorInitials="AG" onAddNote={() => {}} />);
    const texts = screen.getAllByTestId('note-text').map(n => n.textContent);
    expect(texts).toEqual(['Check against the side letter.', 'Counsel agreed.']);
  });

  it('shows when each note was written', () => {
    render(<NotesPanel notes={[NOTES[0]]} authorInitials="AG" onAddNote={() => {}} />);
    expect(screen.getByTestId('note-meta').textContent).not.toBe('');
  });

  it('adds a note', () => {
    const onAddNote = vi.fn();
    render(<NotesPanel notes={[]} authorInitials="AG" onAddNote={onAddNote} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New note' } });
    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(onAddNote).toHaveBeenCalledWith('New note');
  });

  it('refuses an empty or whitespace-only note', () => {
    const onAddNote = vi.fn();
    render(<NotesPanel notes={[]} authorInitials="AG" onAddNote={onAddNote} />);
    const add = screen.getByRole('button', { name: /add note/i });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(onAddNote).not.toHaveBeenCalled();
  });

  it('clears the box after a successful add', () => {
    render(<NotesPanel notes={[]} authorInitials="AG" onAddNote={() => {}} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'New note' } });
    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(box.value).toBe('');
  });

  it('disables adding while a write is in flight', () => {
    render(<NotesPanel notes={[]} authorInitials="AG" busy onAddNote={() => {}} />);
    expect(screen.getByRole('button', { name: /add note/i }).hasAttribute('disabled')).toBe(true);
  });

  it('shows no note list when there are none, but still offers the box', () => {
    render(<NotesPanel notes={[]} authorInitials="AG" onAddNote={() => {}} />);
    expect(screen.queryAllByTestId('note-text')).toHaveLength(0);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/review/NotesPanel.test.tsx`
Expected: FAIL with `Failed to resolve import "./NotesPanel"`.

- [ ] **Step 3: Write the panel**

Create `src/features/review/NotesPanel.tsx`:

```tsx
import React, { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { Note } from '../../types';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface NotesPanelProps {
  notes: Note[];
  /** The local profile's initials, shown against a note the user is about to
   *  write. Attribution is real but local — there is one user (ruling R1). */
  authorInitials: string;
  busy?: boolean;
  onAddNote: (text: string) => void;
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * Free-text notes against one finding. A verification state says *whether* a
 * reviewer accepted a finding; a note says *what they thought* — the caveat,
 * the cross-reference, the thing to ask the client. Both persist with the
 * review, so a reviewer returning to a matter reads their own reasoning
 * rather than reconstructing it.
 *
 * Ordered oldest-first, deliberately: notes read as a thread, and a thread
 * that starts at the end is unreadable.
 */
export function NotesPanel({ notes, authorInitials, busy = false, onAddNote }: NotesPanelProps) {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();

  const ordered = [...notes].sort((a, b) => a.at - b.at);

  return (
    <div className="space-y-2 pt-2 border-t border-white/5">
      {ordered.length > 0 && (
        <ul className="space-y-1.5">
          {ordered.map(note => (
            <li key={note.id} className="bg-white/[0.03] rounded-lg p-2 border border-white/5">
              <p data-testid="note-text" className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap">
                {note.text}
              </p>
              <span data-testid="note-meta" className="mt-1 block text-[10px] text-gray-600">
                {formatWhen(note.at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <AutoResizeTextarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a note as ${authorInitials}`}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg p-2 text-[11px] text-white outline-none"
        />
        <Button
          variant="ghost"
          disabled={busy || trimmed === ''}
          onClick={() => { onAddNote(trimmed); setDraft(''); }}
          className="text-[10px] shrink-0"
        >
          <MessageSquarePlus className="w-3 h-3" aria-hidden="true" /> Add note
        </Button>
      </div>
    </div>
  );
}
```

`Button` extends `React.ButtonHTMLAttributes`, so `disabled` is already supported and already styled (`disabled:opacity-50 disabled:cursor-not-allowed`) — verified against the file. Use it directly; no passthrough is needed.

- [ ] **Step 4: Mount on the card**

In `FindingCard`, add the three props from the Interfaces block above and render, below the verification controls in the `done` branch:

```tsx
        {finding && onAddNote && (
          <NotesPanel
            notes={finding.notes}
            authorInitials={authorInitials ?? 'ME'}
            busy={noteBusy}
            onAddNote={onAddNote}
          />
        )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/review/NotesPanel.test.tsx src/features/review/FindingCard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/review/NotesPanel.tsx src/features/review/NotesPanel.test.tsx src/features/review/FindingCard.tsx
git commit -m "feat(b): notes on findings"
```

---

### Task 10: Persistence, failure surfacing, and the re-run reset

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/features/review/ResultsView.tsx`
- Modify: `src/features/tabular/CellDetail.tsx`
- Modify: `src/features/tabular/TabularReview.tsx`
- Test: `src/App.verification.test.tsx` (new), `src/App.rerunResets.test.tsx` (new)

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: `ResultsViewProps` gains `onVerify?: (docId, clauseId, change) => Promise<void>`, `onAddNote?: (docId, clauseId, text) => Promise<void>`, `verifyBusyKey?: string | null`, `authorInitials?: string`, `documentNames?: Record<string, string>`. `CellDetailProps` gains the same, scoped to its one document.

This is the task the spec's section 9 is about. Ruling R-B2 governs it: **await the write, then apply**. A verification the user can see but the store never took is precisely the false confidence this sub-project exists to remove, and it is worse than a moment's delay.

- [ ] **Step 1: Write the failing tests**

Create `src/App.verification.test.tsx`, following the setup pattern in the existing `src/App.reviewSaveError.test.tsx` (which already mocks the db layer and renders the app into a review):

```tsx
describe('verification persistence', () => {
  it('persists a verification and shows it only after the write resolves', async () => {
    // Arrange: a saved review with one done finding, opened in the app.
    // Act: click Verify.
    // Assert: saveReview was called with verification.state === 'verified',
    //         and the chip reads Verified once it resolves.
  });

  it('does not show a verification the store rejected, and says so', async () => {
    // Arrange: saveReview rejects with a quota error.
    // Act: click Verify.
    // Assert: the chip still reads Unverified, and an error toast names the failure.
  });

  it('records the local profile id and a timestamp against the verification', async () => {
    // Assert: the persisted verification carries byUserId from the profile and a numeric `at`.
  });

  it('persists a note the same way, and does not show one the store rejected', async () => {
    // Same two shapes, for onAddNote.
  });
});
```

Create `src/App.rerunResets.test.tsx`:

```tsx
describe('re-running a clause clears its verification', () => {
  it('resets a verified finding to unchecked when its clause is retried', async () => {
    // Arrange: a review with a finding verified by the user.
    // Act: click Retry on that clause.
    // Assert: the finding's verification is { state: 'unchecked' } both in
    //         the persisted review and on screen.
  });

  it('tells the user their verification was cleared', async () => {
    // Assert: a toast/notice names the clause and says its verification was cleared.
  });

  it('leaves the verification of other findings alone', async () => {
    // Assert: a second verified finding in the same review is untouched.
  });

  it('keeps notes across a re-run, deleting none of them', async () => {
    // Assert: notes survive a re-run — they are commentary by a human, not a
    // claim about the current output, so they are kept while the
    // verification is not.
  });
});
```

Write these out fully against the real component tree — the comments above are the assertions to make, not placeholders to leave in. Read `src/App.reviewSaveError.test.tsx` first and reuse its harness exactly; it already solves mounting the app with a stubbed database.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/App.verification.test.tsx src/App.rerunResets.test.tsx`
Expected: FAIL — no handlers exist yet.

- [ ] **Step 3a: Facts about `App.tsx` this task depends on — checked against the file**

These were verified before this task was dispatched. Do not re-derive them, and do not write code that assumes otherwise:

- **There is no component-scoped `userId` or `profile`.** `userId` is a `let` local inside `handleStartRun`, assigned from `await getProfile()`. The established pattern for a handler that needs an id is `const profile = await getProfile();` then `profile.id` — that is exactly what `handleRetryCell` and `handleAddMatterDocuments` already do. Both new handlers are `async`, so follow it.
- **`notify`'s signature is `(message: string, variant: ToastVariant = 'success')` and `ToastVariant` is `'success' | 'error'` only.** There is no `'info'`. For the re-run notice, call `notify(message)` with no variant.
- **There is no `uid()` in `App.tsx`.** See Step 3b.
- **`authorInitials` needs a render-time profile**, and an `await` cannot supply one. Add `const [profile, setProfile] = useState<UserProfile | null>(null);` and load it in the existing bootstrap effect that already runs `migrateIfNeeded`. Use `profile?.initials ?? 'ME'` for display. Keep using `await getProfile()` inside the write handlers — display can tolerate a null for one frame; a write must not.

- [ ] **Step 3b: Extract `uid()` — it exists seven times, byte-identical**

`uid()` is defined separately in `runReview.ts`, `generateTemplate.ts`, `matters.ts`, `migrate.ts`, `playbooks.ts`, `profile.ts` and `documents.ts`. All seven bodies are byte-identical (verified by hashing each). This project's own rule is to extract on the *second* copy; this is the seventh, and this task needs an eighth caller for note ids.

Create `src/lib/uid.ts`:

```ts
/** A short, collision-resistant-enough id for a local-only app: random
 *  suffix plus a timestamp, so ids are unique within a session and roughly
 *  ordered across them. Extracted after the same four lines had been
 *  written out seven times in this codebase, byte-identical each time. */
export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
```

Then replace all seven local definitions with `import { uid } from '<relative path>/lib/uid';`. The bodies are identical, so this is a pure move with no behavioural change — but run the full suite afterwards anyway, because "no behavioural change" is a claim and the suite is how it gets checked.

Test-local `uid()` helpers inside `*.test.ts` files are left alone; a test's own fixture helper is not production duplication.

- [ ] **Step 3: Add the verification handler to App.tsx**

Near `handleRetryCell`, add (note `profile` comes from `await getProfile()`, per Step 3a):

```tsx
  /** Key of the finding whose verification or note write is in flight, as
   *  `findingKey(docId, clauseId)`. One at a time is enough: these are
   *  single-record writes and a user verifies one finding at a time. */
  const [verifyBusyKey, setVerifyBusyKey] = useState<string | null>(null);

  /**
   * Await the write, then apply (ruling R-B2, spec section 9). The UI must
   * never show a verification the store did not take: a reviewer who marks
   * twenty findings verified, whose writes all fail, and whose export then
   * claims verification no store holds, is the worst outcome this feature
   * has. A single IndexedDB record write is milliseconds; correctness is
   * worth them.
   *
   * `latestRunRef` is updated alongside `run` state because a live run's
   * debounced saver reads from it — without this, the next mid-run
   * auto-save would write a snapshot taken before this verification and
   * silently undo it.
   */
  const handleVerify = async (docId: string, clauseId: string, change: VerificationChange) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[docId]?.[clauseId];
    if (!existing) return;

    const profile = await getProfile();

    let verification: Verification;
    try {
      verification = applyVerification(existing.verification, change, profile.id, Date.now());
    } catch (e) {
      notify(e instanceof Error ? e.message : 'That verification is not valid.', 'error');
      return;
    }

    const updated = withUpdatedFinding(current, docId, clauseId, { ...existing, verification });

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, profile.id));
      latestRunRef.current = updated;
      setRun(updated);
    } catch (e) {
      notify(
        e instanceof Error
          ? `This verification was not saved: ${e.message}`
          : 'This verification was not saved.',
        'error',
      );
    } finally {
      setVerifyBusyKey(null);
    }
  };

  const handleAddNote = async (docId: string, clauseId: string, text: string) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[docId]?.[clauseId];
    if (!existing) return;

    const profile = await getProfile();
    const note = makeNote(docId, clauseId, text, profile.id, Date.now(), uid());
    const updated = withUpdatedFinding(current, docId, clauseId, {
      ...existing,
      notes: [...existing.notes, note],
    });

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, profile.id));
      latestRunRef.current = updated;
      setRun(updated);
    } catch (e) {
      notify(e instanceof Error ? `This note was not saved: ${e.message}` : 'This note was not saved.', 'error');
    } finally {
      setVerifyBusyKey(null);
    }
  };
```

Add the shared immutable updater beside `reviewFromRun` at module scope — it is used by both handlers and by the retry reset, so it is written once:

```tsx
/** Replaces one finding in a run, copying only the two objects on the path
 *  to it. Extracted rather than inlined three times: this project has six
 *  sibling-drift findings on record, and three hand-rolled copies of a
 *  nested-map update is exactly how the seventh happens. */
function withUpdatedFinding(
  run: ReviewRun,
  docId: string,
  clauseId: string,
  finding: Finding,
): ReviewRun {
  return {
    ...run,
    findings: {
      ...run.findings,
      [docId]: { ...run.findings[docId], [clauseId]: finding },
    },
  };
}
```

Import what these need at the top of `App.tsx`:

```tsx
import { applyVerification, findingKey, makeNote, resetVerification } from './lib/verification';
import type { VerificationChange } from './lib/verification';
import type { Finding, Verification } from './types';
import { saveReview } from './lib/db/reviews';
import { uid } from './lib/uid';
```

`saveReview` and `getProfile` are already imported by `App.tsx` — check before adding a duplicate. `uid` comes from the new `src/lib/uid.ts` (Step 3b). There is **no** `userId` in scope; every write handler gets it from `await getProfile()`, per Step 3a.

- [ ] **Step 3c: Stop a live run from overwriting a verification — `carryHumanState`**

**This is a defect the plan originally shipped, found by re-reading `runReview` after Step 3 was written. Read this before implementing, because the handlers above are not sufficient on their own.**

`runReview` holds its *own* copy of the run and calls `onUpdate` with a full snapshot roughly twice per cell — once when a cell starts, once when it resolves. A verification written by `handleVerify` lands in `latestRunRef` and React state, but `runReview` knows nothing about it. So the very next `onUpdate` — fired by some *other* cell finishing — carries a snapshot in which that finding is still `unchecked`, `setRun` applies it, and the debounced saver persists the loss.

The user sees a finding go verified and then quietly un-verify itself. That is the exact failure mode this whole sub-project exists to remove, arriving through the back door.

Create `src/lib/findingMerge.ts`:

```ts
import type { ReviewRun } from '../types';

/**
 * Re-applies the human-authored parts of a run — verification and notes —
 * onto a snapshot produced by the run engine.
 *
 * `runReview` owns its own copy of the run and emits a full snapshot on
 * every cell transition. It never sets a verification: every `Finding` it
 * builds carries `unchecked()`. So without this, a verification made while
 * a run is still going is overwritten by the next unrelated cell finishing,
 * and the debounced save persists the loss — the user watches a finding go
 * verified and then silently un-verify itself.
 *
 * Two different rules, because verification and notes are different claims:
 *
 * - **Verification carries over only while the status is unchanged.** A
 *   verification is a judgement about specific output. If the status moved,
 *   the cell was re-run or is new, so the output changed and the judgement
 *   no longer applies — `unchecked` is then the honest answer.
 * - **Notes always carry over.** A note is a human's own commentary
 *   ("check this against the side letter"), not a claim about the current
 *   output, and it stays useful across a re-run. This matches the rule in
 *   Step 4, which clears verification on retry and deliberately keeps notes.
 */
export function carryHumanState(previous: ReviewRun | null, incoming: ReviewRun): ReviewRun {
  if (!previous) return incoming;

  let changed = false;
  const findings: ReviewRun['findings'] = {};

  for (const [docId, byClause] of Object.entries(incoming.findings)) {
    findings[docId] = {};
    for (const [clauseId, finding] of Object.entries(byClause)) {
      const before = previous.findings[docId]?.[clauseId];
      if (!before) {
        findings[docId][clauseId] = finding;
        continue;
      }

      const keepVerification =
        before.status === finding.status && before.verification.state !== 'unchecked';
      const keepNotes = before.notes.length > 0 && finding.notes.length === 0;

      if (!keepVerification && !keepNotes) {
        findings[docId][clauseId] = finding;
        continue;
      }

      changed = true;
      findings[docId][clauseId] = {
        ...finding,
        verification: keepVerification ? before.verification : finding.verification,
        notes: keepNotes ? before.notes : finding.notes,
      };
    }
  }

  // Returning `incoming` unchanged when nothing was carried keeps React's
  // identity check meaningful for the overwhelmingly common case.
  return changed ? { ...incoming, findings } : incoming;
}
```

Test it in `src/lib/findingMerge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { carryHumanState } from './findingMerge';
import type { Finding, ReviewRun } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}

function run(findings: ReviewRun['findings']): ReviewRun {
  return { id: 'r', templateSnapshot: { clauses: [] } as never, documentIds: ['d1'], findings, startedAt: 1 };
}

describe('carryHumanState', () => {
  it('keeps a verification when the status has not moved', () => {
    const before = run({ d1: { c1: finding({ verification: { state: 'verified', byUserId: 'u', at: 1 } }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding() } }));
    expect(after.findings.d1.c1.verification.state).toBe('verified');
  });

  it('drops a verification when the status moved — the output it judged is gone', () => {
    const before = run({ d1: { c1: finding({ verification: { state: 'verified', byUserId: 'u', at: 1 } }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ status: 'running' }) } }));
    expect(after.findings.d1.c1.verification).toEqual({ state: 'unchecked' });
  });

  it('keeps notes even when the status moved', () => {
    const note = { id: 'n1', findingId: 'd1::c1', text: 'check the side letter', byUserId: 'u', at: 2 };
    const before = run({ d1: { c1: finding({ notes: [note] }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ status: 'running' }) } }));
    expect(after.findings.d1.c1.notes).toEqual([note]);
  });

  it('does not resurrect notes the incoming snapshot already has', () => {
    const older = { id: 'n1', findingId: 'd1::c1', text: 'old', byUserId: 'u', at: 1 };
    const newer = { id: 'n2', findingId: 'd1::c1', text: 'new', byUserId: 'u', at: 2 };
    const before = run({ d1: { c1: finding({ notes: [older] }) } });
    const after = carryHumanState(before, run({ d1: { c1: finding({ notes: [newer] }) } }));
    expect(after.findings.d1.c1.notes).toEqual([newer]);
  });

  it('passes a finding through untouched when there is nothing human to carry', () => {
    const incoming = run({ d1: { c1: finding() } });
    expect(carryHumanState(run({ d1: { c1: finding() } }), incoming)).toBe(incoming);
  });

  it('passes the snapshot through when there is no previous run', () => {
    const incoming = run({ d1: { c1: finding() } });
    expect(carryHumanState(null, incoming)).toBe(incoming);
  });

  it('leaves a finding that is new in this snapshot alone', () => {
    const before = run({ d1: { c1: finding() } });
    const after = carryHumanState(before, run({ d1: { c1: finding(), c2: finding({ clauseId: 'c2' }) } }));
    expect(after.findings.d1.c2.verification).toEqual({ state: 'unchecked' });
  });
});
```

Then in `App.tsx`'s `handleUpdate`, wrap the incoming snapshot:

```tsx
      const merged = carryHumanState(latestRunRef.current, updated);
      latestRunRef.current = merged;
      setRun(merged);
      if (matterId && reviewSaver) {
        reviewSaver.scheduleSave(reviewFromRun(merged, matterId, settings.modelId, userId));
      }
```

(`userId` here is `handleStartRun`'s own local, which *does* exist in that closure — see Step 3a. It is only the new handlers that lack one.)

Add a test to `src/App.verification.test.tsx`:

```
it('does not lose a verification to the next update from a live run', ...)
// Arrange: a live run; verify a completed finding; then fire another onUpdate
//          from runReview carrying an unchecked snapshot of that same finding.
// Assert:  the finding is still verified on screen and in what was persisted.
```

- [ ] **Step 4: Reset verification on retry**

**Read `handleRetryCell` as it stands before writing anything.** It currently calls `retryCell(run, doc, clauseId, settings, setRun)` — passing `setRun` *directly* as the update callback. Two consequences follow, and both are traps:

1. **`latestRunRef` is never updated during a retry.** Since `handleVerify` and `handleAddNote` read `latestRunRef.current ?? run`, a stale ref would win over fresh state, and a verification made just after a retry would be computed against the wrong run.
2. **`retryCell` is given the `run` closure variable.** A `cleared` run built and passed to `setRun` would be immediately overwritten by `retryCell`'s first update, which is derived from the `run` it was handed. The reset would appear on screen for one frame and then vanish — worse than not resetting at all, because it would look like it worked.

So the reset must be threaded *into* the call, not merely set alongside it. Rewrite the head of `handleRetryCell`:

```tsx
    const current = latestRunRef.current ?? run;
    const existing = current.findings[docId]?.[clauseId];

    // The single most important rule in this sub-project: a verification
    // describes a judgement about specific content, and re-running the
    // clause replaces that content. Keeping the verification would let an
    // export claim a human checked text they never saw.
    //
    // `cleared` is what gets handed to `retryCell` — not just pushed into
    // state alongside it. `retryCell` derives every snapshot it emits from
    // the run it was given, so passing the un-cleared `run` here would let
    // its first update restore the verification we just removed.
    let cleared = current;
    if (existing && existing.verification.state !== 'unchecked') {
      cleared = withUpdatedFinding(current, docId, clauseId, {
        ...existing,
        verification: resetVerification(existing.verification),
      });
      const clauseTitle = current.templateSnapshot.clauses.find(c => c.id === clauseId)?.title ?? 'This clause';
      notify(`${clauseTitle} is being re-run, so its verification was cleared.`);
    }

    latestRunRef.current = cleared;
    setRun(cleared);

    // Was `setRun` passed directly. It must go through the ref as well, or
    // `handleVerify`/`handleAddNote` read a stale `latestRunRef.current`
    // for the rest of the session.
    const onRetryUpdate = (updated: ReviewRun) => {
      latestRunRef.current = updated;
      setRun(updated);
    };

    retryCell(cleared, doc, clauseId, settings, onRetryUpdate)
```

The rest of `handleRetryCell` — its `.then`, the deleted-matter guard, the `getProfile`/`saveReview` pair, the `.catch` — is unchanged. Note that `onRetryUpdate` does **not** call `carryHumanState`: `retryCell` was handed `cleared`, which already holds every other finding's verification, so its snapshots carry them correctly. Applying the merge here would additionally fight the reset this step just made.

Notes are **not** cleared. A note is a human's own commentary — "check this against the side letter" — and stays useful across a re-run. A verification is a claim about output that no longer exists, and does not.

- [ ] **Step 5: Thread the handlers through**

`ResultsView` gains the props listed in the Interfaces block and passes each `FindingCard`:

```tsx
              onVerify={onVerify ? (change) => onVerify(activeDocId, clause.id, change) : undefined}
              onAddNote={onAddNote ? (text) => onAddNote(activeDocId, clause.id, text) : undefined}
              verifyBusy={verifyBusyKey === findingKey(activeDocId, clause.id)}
              noteBusy={verifyBusyKey === findingKey(activeDocId, clause.id)}
              documentNames={documentNames}
              authorInitials={authorInitials}
```

Build `documentNames` in `ResultsView` from its `documents` prop with a `useMemo`, so `EvidenceList` can name a citation's document:

```tsx
  const documentNames = useMemo(
    () => Object.fromEntries(documents.map(d => [d.id, d.name])),
    [documents],
  );
```

`ResultsView` imports `findingKey` from `../../lib/verification` for the two busy comparisons above. It must NOT re-template `` `${docId}::${clauseId}` `` inline: that is a second copy of the key format, and a second copy of a shape is how six of this project's findings started.

`CellDetail` takes and forwards the same handlers for its single document. `TabularReview` passes them down to `CellDetail`. `App.tsx` supplies `onVerify={handleVerify}`, `onAddNote={handleAddNote}`, `verifyBusyKey`, and `authorInitials={profile.initials}` to both `ResultsView` and `TabularReview`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/App.verification.test.tsx src/App.rerunResets.test.tsx src/App.test.tsx src/App.reviewSaveError.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutation-test the re-run reset**

Make each edit, run the two new suites, confirm a FAILURE, revert:

1. Delete the reset block in `handleRetryCell` — "resets a verified finding to unchecked" must fail.
2. Change `resetVerification` to return `current` unchanged — same test must fail.
3. In `handleVerify`, move `setRun(updated)` above the `await saveReview(...)` — "does not show a verification the store rejected" must fail.
4. In `handleVerify`, drop the `latestRunRef.current = updated` line — add a test if none fails: a mid-run verification must survive the next debounced auto-save.
5. In `carryHumanState`, change `before.status === finding.status` to `true` so a verification survives a status change — the "drops a verification when the status moved" test must fail. This is the rule that stops a re-run inheriting a stale judgement, and it is the same rule Step 4 enforces from the other direction.
7. In `handleRetryCell`, pass `current` (or `run`) to `retryCell` instead of `cleared` — the "resets a verified finding to unchecked" test must fail. This is the trap Step 4 describes: the reset lands in state and is then overwritten by retryCell first update.
6. In `handleUpdate`, remove the `carryHumanState` wrap — the "does not lose a verification to the next update from a live run" test must fail. If it does not, that test is not exercising a real `onUpdate`, and it needs rewriting rather than accepting.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/App.verification.test.tsx src/App.rerunResets.test.tsx src/features/review/ResultsView.tsx src/features/tabular/CellDetail.tsx src/features/tabular/TabularReview.tsx
git commit -m "feat(b): persist verification and notes, and clear verification on re-run"
```

---

### Task 11: Export labelling — DOCX and CSV say what was checked

**Files:**
- Modify: `src/lib/findingOutcome.ts`
- Modify: `src/features/review/exportDocx.ts`
- Modify: `src/features/tabular/csv.ts`
- Test: `src/lib/findingOutcome.test.ts` (extend), `src/features/review/exportDocx.test.ts` (extend), `src/features/tabular/csv.test.ts` (extend)

**Interfaces:**
- Consumes: `Finding`, `Verification` (Task 1).
- Produces, from `src/lib/findingOutcome.ts`: `verificationLabel(finding): string | null`, `verificationCounts(findings): VerificationCounts`, `exportSummaryLine(findings): string`. `ReportRow` in `exportDocx.ts` gains `verificationLabel: string | null` and `citations: Citation[]`.

Both exporters already share `describeFindingOutcome` for exactly this reason: they disagreed once, and the CSV — the one that opens straight into Excel — was the one that got it wrong. Labelling lives in the same module for the same reason.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/findingOutcome.test.ts`:

```ts
import { verificationLabel, verificationCounts, exportSummaryLine } from './findingOutcome';

function finding(state: Verification['state'], reason?: string): Finding {
  return {
    clauseId: 'c', status: 'done', summary: 's', citations: [], notes: [],
    verification: reason ? { state, reason } : { state },
  } as Finding;
}

describe('verificationLabel', () => {
  it('labels an unchecked finding as unverified AI output', () => {
    expect(verificationLabel(finding('unchecked'))).toBe('UNVERIFIED AI OUTPUT');
  });

  it('labels a flagged finding', () => {
    expect(verificationLabel(finding('flagged'))).toBe('FLAGGED');
  });

  it('carries the reason on a rejected finding', () => {
    expect(verificationLabel(finding('rejected', 'Wrong clause'))).toBe('REJECTED: Wrong clause');
  });

  it('returns null for a verified finding — a label there would be noise', () => {
    expect(verificationLabel(finding('verified'))).toBeNull();
  });

  it('labels a missing finding as unverified rather than saying nothing', () => {
    expect(verificationLabel(undefined)).toBe('UNVERIFIED AI OUTPUT');
  });

  it('never returns an empty string for a rejection with no readable reason', () => {
    const f = { ...finding('rejected'), verification: { state: 'rejected' as const } };
    expect(verificationLabel(f)).toBe('REJECTED: no reason recorded');
  });
});

describe('verificationCounts and exportSummaryLine', () => {
  const findings = {
    'doc-1': {
      a: finding('verified'), b: finding('unchecked'),
      c: finding('flagged'), d: finding('rejected', 'no'),
    },
    'doc-2': { a: finding('verified'), b: finding('unchecked') },
  };

  it('counts every finding across every document', () => {
    expect(verificationCounts(findings)).toEqual({
      total: 6, verified: 2, unchecked: 2, flagged: 1, rejected: 1,
    });
  });

  it('summarises in one line naming how many were verified', () => {
    expect(exportSummaryLine(findings)).toBe(
      '6 findings: 2 verified, 2 unverified, 1 flagged, 1 rejected.',
    );
  });

  it('handles an empty review without dividing by zero or saying nothing', () => {
    expect(exportSummaryLine({})).toBe('0 findings: 0 verified, 0 unverified, 0 flagged, 0 rejected.');
  });
});
```

Append to `src/features/review/exportDocx.test.ts`:

```ts
it('carries a verification label onto every row that needs one', () => {
  const run = runWith({ 'clause-1': doneFinding({ verification: { state: 'unchecked' } }) });
  const [row] = buildReportRows(run, 'doc-1');
  expect(row.verificationLabel).toBe('UNVERIFIED AI OUTPUT');
});

it('includes a rejected finding with its reason rather than dropping it', () => {
  const run = runWith({
    'clause-1': doneFinding({
      summary: 'Cap is 100% of Charges.',
      verification: { state: 'rejected', reason: 'Cites the indemnity' },
    }),
  });
  const [row] = buildReportRows(run, 'doc-1');
  expect(row.summary).toContain('Cap is 100% of Charges.');
  expect(row.verificationLabel).toBe('REJECTED: Cites the indemnity');
});

it('leaves a verified row unlabelled', () => {
  const run = runWith({ 'clause-1': doneFinding({ verification: { state: 'verified', byUserId: 'u', at: 1 } }) });
  expect(buildReportRows(run, 'doc-1')[0].verificationLabel).toBeNull();
});

it('labels an unreviewed clause as unverified too', () => {
  const run = runWith({});
  const [row] = buildReportRows(run, 'doc-1');
  expect(row.summary).toContain('could not be reviewed');
  expect(row.verificationLabel).toBe('UNVERIFIED AI OUTPUT');
});

it('renders each citation with its page pin', () => {
  const run = runWith({
    'clause-1': doneFinding({
      citations: [{ quote: 'Capped at the Charges.', documentId: 'doc-1', page: 4 }],
    }),
  });
  expect(buildReportRows(run, 'doc-1')[0].citations[0]).toEqual({
    quote: 'Capped at the Charges.', documentId: 'doc-1', page: 4,
  });
});
```

Append to `src/features/tabular/csv.test.ts`:

```ts
it('opens with a one-field summary row naming how many findings were verified', () => {
  const csv = buildTabularCsv(runWith({ 'clause-1': doneFinding({ verification: { state: 'verified' } }) }), docs);
  const [first] = csv.split('\r\n');
  expect(first).toBe('"1 findings: 1 verified, 0 unverified, 0 flagged, 0 rejected."');
});

it('prefixes an unverified cell so a spreadsheet cannot read it as checked', () => {
  const csv = buildTabularCsv(runWith({ 'clause-1': doneFinding({ verification: { state: 'unchecked' } }) }), docs);
  expect(csv).toContain('[UNVERIFIED AI OUTPUT]');
});

it('carries a rejection reason into the cell', () => {
  const csv = buildTabularCsv(
    runWith({ 'clause-1': doneFinding({ verification: { state: 'rejected', reason: 'Wrong clause' } }) }),
    docs,
  );
  expect(csv).toContain('[REJECTED: Wrong clause]');
});

it('leaves a verified cell unprefixed', () => {
  const csv = buildTabularCsv(runWith({ 'clause-1': doneFinding({ verification: { state: 'verified' } }) }), docs);
  expect(csv).not.toContain('[UNVERIFIED');
  expect(csv).not.toContain('[FLAGGED]');
});

it('still escapes a prefixed cell that would otherwise start a formula', () => {
  const csv = buildTabularCsv(
    runWith({ 'clause-1': doneFinding({ summary: '=1+1', verification: { state: 'verified' } }) }),
    docs,
  );
  expect(csv).toContain('"\'=1+1"');
});

it('agrees with the DOCX exporter on every label', () => {
  for (const state of ['unchecked', 'flagged', 'rejected', 'verified'] as const) {
    const verification = state === 'rejected' ? { state, reason: 'r' } : { state };
    const run = runWith({ 'clause-1': doneFinding({ verification }) });
    const label = buildReportRows(run, 'doc-1')[0].verificationLabel;
    const csv = buildTabularCsv(run, docs);
    if (label === null) continue;
    expect(csv).toContain(`[${label}]`);
  }
});
```

**The `runWith` and `doneFinding` helpers used above do not exist yet — checked against both files.** Today `exportDocx.test.ts` has module-level `const template` / `const run`, and `csv.test.ts` has `template(clauses)` and `doc(id, name)` factories and builds its runs inline. Add these two small factories to **each** of the two test files, matching that file's local style, rather than importing one from the other (a test helper reaching across feature folders is worse than two four-line factories):

```ts
function doneFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    clauseId: 'clause-1',
    status: 'done',
    summary: 'Capped at the Charges.',
    citations: [],
    verification: { state: 'unchecked' },
    notes: [],
    ...overrides,
  };
}

function runWith(findings: Record<string, Finding>): ReviewRun {
  return {
    id: 'run-1',
    templateSnapshot: /* the file's existing template value or template([...]) factory */,
    documentIds: ['doc-1'],
    findings: { 'doc-1': findings },
    startedAt: 1,
  };
}
```

In `exportDocx.test.ts`, `runWith` uses the file's existing `template` const. In `csv.test.ts` it calls the existing `template([...])` factory with a single clause whose id is `clause-1`, and the existing `docs` array is what `buildTabularCsv`'s second argument takes — reuse it rather than declaring another.

The "agrees with the DOCX exporter on every label" test lives in `csv.test.ts` and calls `buildReportRows`, so that file needs `import { buildReportRows } from '../review/exportDocx';`. That cross-import is deliberate: the whole point of the test is that the two exporters cannot disagree, and it cannot make that assertion from inside one of them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/findingOutcome.test.ts src/features/review/exportDocx.test.ts src/features/tabular/csv.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the labelling to findingOutcome.ts**

Append to `src/lib/findingOutcome.ts`:

```ts
import type { Review } from '../types';

/**
 * How an export names what a human concluded about a finding — the only
 * place that wording exists, so the DOCX report and the CSV can never
 * disagree about it. They disagreed once before, over exactly this kind of
 * thing (a CSV wrote unreviewed clauses as blank cells while the DOCX said
 * "could not be reviewed"), and the CSV is the one that opens straight into
 * Excel.
 *
 * `null` means "no label" and is returned for exactly one case: a verified
 * finding. Everything else — including a finding that is simply missing —
 * is labelled, because an unlabelled export row reads as checked, and the
 * spec's rule is that nothing leaves the app claiming to be checked when it
 * isn't.
 *
 * Export is never blocked by any of these. A rejected finding is exported
 * WITH its reason: silently dropping it would hide a human judgement from
 * whoever reads the report.
 */
export function verificationLabel(finding: Finding | undefined): string | null {
  const state = finding?.verification?.state ?? 'unchecked';

  if (state === 'verified') return null;
  if (state === 'flagged') return 'FLAGGED';
  if (state === 'rejected') {
    const reason = finding?.verification?.reason?.trim();
    // A rejection whose reason went missing (a record written before the
    // requirement existed, or repaired by the migration) still says it was
    // rejected. Silence here would be the worst of both: a rejected finding
    // exported as though nobody had objected.
    return `REJECTED: ${reason && reason !== '' ? reason : 'no reason recorded'}`;
  }
  return 'UNVERIFIED AI OUTPUT';
}

export interface VerificationCounts {
  total: number;
  verified: number;
  unchecked: number;
  flagged: number;
  rejected: number;
}

/** Counts findings by verification state across every document in a review.
 *  Shared by the exporters' header summary and by the on-screen progress
 *  indicators (`src/lib/reviewProgress.ts` re-exports it) so a report and
 *  the screen it was generated from can never quote different numbers. */
export function verificationCounts(findings: Review['findings']): VerificationCounts {
  const counts: VerificationCounts = { total: 0, verified: 0, unchecked: 0, flagged: 0, rejected: 0 };
  for (const byClause of Object.values(findings ?? {})) {
    for (const finding of Object.values(byClause ?? {})) {
      counts.total++;
      counts[finding?.verification?.state ?? 'unchecked']++;
    }
  }
  return counts;
}

/** The one-line header every export carries. Reading it should be enough to
 *  know how much of the report a human has actually stood behind.
 *
 *  Deliberately ASCII-only. This same string goes into the CSV, which is
 *  written with no byte-order mark, and Excel's default import on Windows
 *  reads a BOM-less file as ANSI — so an em-dash here would arrive as
 *  mojibake in the first thing a reader sees. The line has to survive its
 *  most fragile consumer, and typography is not worth a garbled export. */
export function exportSummaryLine(findings: Review['findings']): string {
  const c = verificationCounts(findings);
  return `${c.total} findings: ${c.verified} verified, ${c.unchecked} unverified, ${c.flagged} flagged, ${c.rejected} rejected.`;
}
```

- [ ] **Step 4: Label the DOCX report**

In `src/features/review/exportDocx.ts`:

- Import `verificationLabel` and `exportSummaryLine` from `../../lib/findingOutcome`, and `Citation` from `../../types`.
- Change `ReportRow`: `citations: Citation[]` and add `verificationLabel: string | null;`.
- In `buildReportRows`, add `verificationLabel: verificationLabel(finding),` to **both** returned shapes (the not-done branch and the done branch), and pass `finding.citations` straight through in the done branch.
- In `exportDocx`, after the "Generated by LexPrompt on ..." paragraph, add:

```ts
    new Paragraph({
      children: [new TextRun({ text: exportSummaryLine(run.findings), bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
```

- Inside the per-row table build, immediately after the header row and before the summary row, add:

```ts
    // A labelled row for anything a human has not verified. Placed above the
    // summary, not below the evidence, because a reader skimming the report
    // must meet the caveat before they read the claim.
    if (row.verificationLabel) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: row.verificationLabel, bold: true })] })],
            columnSpan: 2,
            shading: { fill: 'FFF4CC' },
            margins: cellMargins,
          }),
        ],
      }));
    }
```

- In the citations loop, change `row.citations.forEach((cite, idx) =>` so `cite` is a `Citation`, rendering `cite.quote` in the italic cell and, where `cite.page !== undefined`, appending a plain-text pin. Replace the two-cell body with:

```ts
            new TableCell({
              children: [new Paragraph({
                children: [
                  new TextRun({ text: `"${cite.quote}"`, italics: true }),
                  ...(cite.page !== undefined
                    ? [new TextRun({ text: `  (p. ${cite.page})`, italics: false, color: '666666' })]
                    : []),
                ],
              })],
              width: { size: 85, type: WidthType.PERCENTAGE },
              margins: { top: 50, bottom: 50, left: 50, right: 50 },
            }),
```

- [ ] **Step 5: Label the CSV**

In `src/features/tabular/csv.ts`, import `exportSummaryLine, verificationLabel` alongside `describeFindingOutcome`, and change the cell builder and the row assembly:

```ts
/** One cell's text: the outcome, prefixed with a verification label when
 *  there is one. The prefix goes at the START of the cell because a
 *  spreadsheet truncates cell display at the column width — a caveat at the
 *  end of a long summary is a caveat nobody reads.
 *
 *  Note the prefix is applied BEFORE `escapeCsvField`, so a summary
 *  beginning with `=`, `+`, `-` or `@` is still caught by the formula
 *  guard — the guard inspects the first character of whatever it is
 *  handed, and a verified cell (no prefix) is exactly the unprefixed case
 *  it was written for. */
function cellText(finding: Finding | undefined): string {
  const outcome = describeFindingOutcome(finding);
  const label = verificationLabel(finding);
  return label ? `[${label}] ${outcome}` : outcome;
}
```

and in `buildTabularCsv`:

```ts
  // Ruling R-B4: a single-field first row. Excel opens it as a title line
  // above the table, and every export — DOCX and CSV alike — has to say how
  // much of it a human actually stood behind.
  const summary = escapeCsvField(exportSummaryLine(run.findings));
  const header = ['Document', ...clauses.map(c => c.title)].map(escapeCsvField).join(',');

  const rows = run.documentIds.map(docId => {
    const doc = documents.find(d => d.id === docId);
    const fields = [
      doc?.name ?? docId,
      ...clauses.map(c => cellText(run.findings[docId]?.[c.id])),
    ];
    return fields.map(escapeCsvField).join(',');
  });

  return [summary, header, ...rows].join('\r\n');
```

Import `Finding` in `csv.ts` for `cellText`'s parameter type.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/findingOutcome.test.ts src/features/review/exportDocx.test.ts src/features/tabular/csv.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation-test the labels**

Make each edit, run all three suites, confirm a FAILURE, revert:

1. In `verificationLabel`, return `null` for `'unchecked'` — "labels an unchecked finding" and "prefixes an unverified cell" must both fail.
2. In `verificationLabel`, drop the reason from the rejected string — "carries the reason" and "carries a rejection reason into the cell" must fail.
3. In `verificationLabel`, return a label for `'verified'` too — "leaves a verified cell unprefixed" must fail.
4. In `csv.ts`, apply the prefix AFTER `escapeCsvField` — "still escapes a prefixed cell that would otherwise start a formula" must fail (this is the one that proves the formula guard survives the change).
5. In `exportDocx.ts`, drop the `verificationLabel` row from the table — a DOCX test must fail; if none does, the DOCX tests only cover `buildReportRows` and a test asserting the row reaches the document is missing. Add one, or record in the report why the `docx` construction is not usefully testable and what covers it instead.

- [ ] **Step 8: Commit**

```bash
git add src/lib/findingOutcome.ts src/lib/findingOutcome.test.ts src/features/review/exportDocx.ts src/features/review/exportDocx.test.ts src/features/tabular/csv.ts src/features/tabular/csv.test.ts
git commit -m "feat(b): label unverified, flagged and rejected findings in both exports"
```

---

### Task 12: Verification progress on the review and on the matter home

**Files:**
- Create: `src/lib/reviewProgress.ts`
- Modify: `src/features/review/ResultsView.tsx`
- Modify: `src/features/matters/MatterHome.tsx`
- Test: `src/lib/reviewProgress.test.ts`, `src/features/matters/MatterHome.test.tsx` (extend)

**Interfaces:**
- Consumes: `verificationCounts` (Task 11).
- Produces: `verificationCounts` re-exported, plus `progressLabel(findings): string` and `progressPercent(findings): number`.

`MatterHome` currently has its own private `reviewProgress` counting done/total. That stays — it answers a different question (how much of the run finished). The new counter answers "how much has a human stood behind", and lives in a shared module from the outset because two screens need it and the exporters already quote the same numbers.

- [ ] **Step 1: Write the failing test**

Create `src/lib/reviewProgress.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { progressLabel, progressPercent, verificationCounts } from './reviewProgress';
import type { Finding, Review } from '../types';

function f(state: Finding['verification']['state']): Finding {
  return { clauseId: 'c', status: 'done', citations: [], notes: [], verification: { state } } as Finding;
}

const FINDINGS: Review['findings'] = {
  'doc-1': { a: f('verified'), b: f('verified'), c: f('unchecked'), d: f('flagged') },
};

describe('reviewProgress', () => {
  it('re-exports the same counter the exports use', () => {
    expect(verificationCounts(FINDINGS).verified).toBe(2);
  });

  it('says how many of how many are verified', () => {
    expect(progressLabel(FINDINGS)).toBe('2 of 4 verified');
  });

  it('reports a percentage for a progress bar', () => {
    expect(progressPercent(FINDINGS)).toBe(50);
  });

  it('reports 0 percent rather than NaN for an empty review', () => {
    expect(progressPercent({})).toBe(0);
    expect(progressLabel({})).toBe('0 of 0 verified');
  });

  it('counts only verified toward progress — a flag is not a pass', () => {
    expect(progressPercent({ 'doc-1': { a: f('flagged'), b: f('rejected') } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reviewProgress.test.ts`
Expected: FAIL with `Failed to resolve import "./reviewProgress"`.

- [ ] **Step 3: Write the module**

Create `src/lib/reviewProgress.ts`:

```ts
import { verificationCounts } from './findingOutcome';
import type { Review } from '../types';

export { verificationCounts };
export type { VerificationCounts } from './findingOutcome';

/**
 * How much of a review a human has actually stood behind, for the two places
 * that show it: the review workspace header and each review row on the
 * matter home.
 *
 * Only `verified` counts. A flagged finding is one someone wants a second
 * look at and a rejected one is a finding someone disagreed with — neither
 * is progress toward a report anybody can rely on, and rolling them in
 * would make the number say the opposite of what a reader assumes it says.
 */
export function progressLabel(findings: Review['findings']): string {
  const { verified, total } = verificationCounts(findings);
  return `${verified} of ${total} verified`;
}

export function progressPercent(findings: Review['findings']): number {
  const { verified, total } = verificationCounts(findings);
  return total === 0 ? 0 : Math.round((verified / total) * 100);
}
```

- [ ] **Step 4: Show it in the review workspace**

In `ResultsView`, in the header row beside the document switcher, render:

```tsx
          <span className="shrink-0 text-[11px] text-gray-400" title="Findings a human has verified">
            {progressLabel(run.findings)}
          </span>
```

with a thin bar beneath the tab strip:

```tsx
        <div className="h-1 bg-white/5 shrink-0" role="progressbar" aria-valuenow={progressPercent(run.findings)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-emerald-500/60 transition-all" style={{ width: `${progressPercent(run.findings)}%` }} />
        </div>
```

- [ ] **Step 5: Show it on the matter home**

In `MatterHome`, in each review row beneath `reviewStatusLabel(review)`, add:

```tsx
                  <span className="text-[11px] text-gray-500">{progressLabel(review.findings)}</span>
```

Leave the existing `reviewProgress`/`reviewStatusLabel` alone — "18/20 clauses reviewed" and "4 of 20 verified" answer different questions and a reader needs both.

Append to `src/features/matters/MatterHome.test.tsx`:

```tsx
it('shows how many findings in a review a human has verified', () => {
  // render MatterHome with a review whose findings are 2 verified of 4,
  // assert the row shows '2 of 4 verified' alongside its run status.
});

it('shows verification progress separately from run progress', () => {
  // assert both '4/4 clauses reviewed' (or whatever reviewStatusLabel
  // produces) and '2 of 4 verified' appear for the same review.
});
```

Write these fully against the existing fixtures in that file. **Checked against it:** `MatterHome.test.tsx` already has its own `mount(node)` helper and a `makeMatter()` factory, and uses the `createRoot`/`act` pattern directly. Use that file's own `mount`, **not** the shared `src/test/mount.tsx` harness — the rule set in Task 6 is that existing test files keep the harness they have; only new files take the shared one. There is no review fixture in that file yet, so add a small local one producing a `Review` whose `findings` map has the verified/unchecked mix each test needs.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reviewProgress.test.ts src/features/matters/MatterHome.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/reviewProgress.ts src/lib/reviewProgress.test.ts src/features/review/ResultsView.tsx src/features/matters/MatterHome.tsx src/features/matters/MatterHome.test.tsx
git commit -m "feat(b): show verification progress on the review and the matter home"
```

---

### Task 13: Keyboard navigation for the verify loop

**Files:**
- Create: `src/features/review/useVerifyKeys.ts`
- Modify: `src/features/review/ResultsView.tsx`
- Test: `src/features/review/useVerifyKeys.test.tsx`

**Interfaces:**
- Consumes: `VerificationChange` (Task 1).
- Produces: `useVerifyKeys({ enabled, count, index, onIndexChange, onVerify })`.

Verification is a repetitive pass over a list. A mouse-only loop — move, aim, click, scroll, repeat, thirty times — will not be used, and an unused verification feature is the same as no verification feature. **Four actions and next/previous. Not a command palette.**

- [ ] **Step 1: Write the failing test**

Create `src/features/review/useVerifyKeys.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useVerifyKeys } from './useVerifyKeys';

function Harness(props: Parameters<typeof useVerifyKeys>[0] & { withInput?: boolean }) {
  useVerifyKeys(props);
  return props.withInput ? <textarea data-testid="box" /> : null;
}

afterEach(cleanup);

describe('useVerifyKeys', () => {
  it('moves to the next finding on j and ArrowDown', () => {
    const onIndexChange = vi.fn();
    render(<Harness enabled count={3} index={0} onIndexChange={onIndexChange} onVerify={() => {}} />);
    fireEvent.keyDown(window, { key: 'j' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('moves to the previous finding on k and ArrowUp', () => {
    const onIndexChange = vi.fn();
    render(<Harness enabled count={3} index={2} onIndexChange={onIndexChange} onVerify={() => {}} />);
    fireEvent.keyDown(window, { key: 'k' });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('stops at the ends rather than wrapping', () => {
    const onIndexChange = vi.fn();
    const { rerender } = render(<Harness enabled count={3} index={0} onIndexChange={onIndexChange} onVerify={() => {}} />);
    fireEvent.keyDown(window, { key: 'k' });
    expect(onIndexChange).not.toHaveBeenCalled();
    rerender(<Harness enabled count={3} index={2} onIndexChange={onIndexChange} onVerify={() => {}} />);
    fireEvent.keyDown(window, { key: 'j' });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('verifies on v and flags on f', () => {
    const onVerify = vi.fn();
    render(<Harness enabled count={3} index={1} onIndexChange={() => {}} onVerify={onVerify} />);
    fireEvent.keyDown(window, { key: 'v' });
    expect(onVerify).toHaveBeenCalledWith(1, { state: 'verified' });
    fireEvent.keyDown(window, { key: 'f' });
    expect(onVerify).toHaveBeenCalledWith(1, { state: 'flagged' });
  });

  it('asks for a rejection rather than rejecting outright on r', () => {
    const onVerify = vi.fn();
    render(<Harness enabled count={3} index={1} onIndexChange={() => {}} onVerify={onVerify} />);
    fireEvent.keyDown(window, { key: 'r' });
    expect(onVerify).toHaveBeenCalledWith(1, { state: 'rejected' });
  });

  it('ignores keys while the user is typing', () => {
    const onVerify = vi.fn();
    const { getByTestId } = render(
      <Harness withInput enabled count={3} index={0} onIndexChange={() => {}} onVerify={onVerify} />,
    );
    const box = getByTestId('box');
    box.focus();
    fireEvent.keyDown(box, { key: 'v' });
    expect(onVerify).not.toHaveBeenCalled();
  });

  it('ignores keys with a modifier held, so browser shortcuts still work', () => {
    const onVerify = vi.fn();
    render(<Harness enabled count={3} index={0} onIndexChange={() => {}} onVerify={onVerify} />);
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    expect(onVerify).not.toHaveBeenCalled();
  });

  it('does nothing at all when disabled', () => {
    const onVerify = vi.fn();
    const onIndexChange = vi.fn();
    render(<Harness enabled={false} count={3} index={0} onIndexChange={onIndexChange} onVerify={onVerify} />);
    fireEvent.keyDown(window, { key: 'v' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(onVerify).not.toHaveBeenCalled();
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const onVerify = vi.fn();
    const { unmount } = render(<Harness enabled count={3} index={0} onIndexChange={() => {}} onVerify={onVerify} />);
    unmount();
    fireEvent.keyDown(window, { key: 'v' });
    expect(onVerify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/review/useVerifyKeys.test.tsx`
Expected: FAIL with `Failed to resolve import "./useVerifyKeys"`.

- [ ] **Step 3: Write the hook**

Create `src/features/review/useVerifyKeys.ts`:

```ts
import { useEffect } from 'react';
import type { VerificationChange } from '../../lib/verification';

export interface UseVerifyKeysOptions {
  enabled: boolean;
  count: number;
  index: number;
  onIndexChange: (index: number) => void;
  /** `{ state: 'rejected' }` carries no reason on purpose — the caller opens
   *  the reason dialog. A keyboard shortcut must not be able to reject
   *  something silently. */
  onVerify: (index: number, change: VerificationChange) => void;
}

/** True when focus is somewhere the user is composing text. Without this, a
 *  reviewer typing "flag the cap" into a note would verify, flag and reject
 *  four findings on the way. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/**
 * The verify loop's keyboard bindings: j/ArrowDown and k/ArrowUp to move,
 * v to verify, f to flag, r to open the rejection dialog.
 *
 * Deliberately six bindings and no more. Verification is a repetitive pass
 * — thirty findings, one decision each — and a loop that requires aiming a
 * mouse at a small button thirty times is a loop nobody completes. That is
 * the entire justification; it is not the beginning of a command palette,
 * and anything beyond next/previous plus the three state actions belongs in
 * a later sub-project with its own argument for existing.
 *
 * Movement stops at the ends rather than wrapping: a reviewer working down a
 * list needs to know when they have reached the bottom, and silently jumping
 * back to the top hides that.
 */
export function useVerifyKeys({ enabled, count, index, onIndexChange, onVerify }: UseVerifyKeysOptions): void {
  useEffect(() => {
    if (!enabled) return;

    function handle(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          if (index + 1 < count) { event.preventDefault(); onIndexChange(index + 1); }
          return;
        case 'k':
        case 'ArrowUp':
          if (index > 0) { event.preventDefault(); onIndexChange(index - 1); }
          return;
        case 'v':
          event.preventDefault();
          onVerify(index, { state: 'verified' });
          return;
        case 'f':
          event.preventDefault();
          onVerify(index, { state: 'flagged' });
          return;
        case 'r':
          event.preventDefault();
          onVerify(index, { state: 'rejected' });
          return;
        default:
      }
    }

    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [enabled, count, index, onIndexChange, onVerify]);
}
```

- [ ] **Step 4: Wire it into ResultsView**

In `ResultsView`:

- `const [focusIndex, setFocusIndex] = useState(0);`
- **Reset it to `0` in two places — checked against the file.** There is no effect keyed on `activeDocId`; the existing `useEffect` is keyed on `run.id` (it re-points a stale `activeDocId` when a fresh run replaces this one), and the document switch happens in `handleSwitchDoc`. Add `setFocusIndex(0)` to **both**: `handleSwitchDoc`, beside its existing `setHighlights([])`, and the `run.id` effect. Missing the first leaves the keyboard cursor pointing at clause 12 of a document the user just switched away from.
- Call the hook, enabled only on the findings tab with a handler that routes `rejected` to the card's dialog rather than persisting directly:

```tsx
  const clauses = run.templateSnapshot.clauses;

  useVerifyKeys({
    enabled: tab === 'findings' && Boolean(onVerify),
    count: clauses.length,
    index: focusIndex,
    onIndexChange: setFocusIndex,
    onVerify: (i, change) => {
      const clause = clauses[i];
      if (!clause || !onVerify) return;
      if (change.state === 'rejected') { setRejectClauseId(clause.id); return; }
      void onVerify(activeDocId, clause.id, change);
    },
  });
```

- Give the focused card a visible ring (`focusIndex === i ? 'ring-1 ring-violet-500/40' : ''` on its wrapper) and scroll it into view when `focusIndex` changes — a keyboard loop with no visible cursor is unusable.
- Render one `RejectReasonModal` at `ResultsView` level, opened by `rejectClauseId`, confirming into `onVerify(activeDocId, rejectClauseId, { state: 'rejected', reason })`.
- Add a one-line hint under the tab strip: `j/k move · v verify · f flag · r reject`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/review/useVerifyKeys.test.tsx src/features/review/ResultsView.test.tsx`
Expected: PASS. (`ResultsView.test.tsx` may not exist; if not, do not create one here — Task 14's browser verification covers the wiring, and the hook itself is fully covered above.)

- [ ] **Step 6: Commit**

```bash
git add src/features/review/useVerifyKeys.ts src/features/review/useVerifyKeys.test.tsx src/features/review/ResultsView.tsx
git commit -m "feat(b): keyboard navigation for the verify loop"
```

---

### Task 13A: Sweep the remaining stale `Finding` fixtures

**This task exists because the plan had a hole.** `Finding` gained two required fields in Task 1, and the plan assigned every *source* file that broke to a task — but four **test** files carry their own `Finding` object literals and were assigned to nobody:

- `src/features/review/runReview.test.ts`
- `src/App.interrupted.test.tsx`
- `src/App.authRedirect.test.tsx`
- `src/features/tabular/TabularReview.interrupted.test.tsx`

They pass at runtime, because Vitest does not typecheck. But `npm run build` is `tsc && vite build`, so `tsc` fails and the build gate in the definition of done cannot be met. The hole was invisible for exactly the reason this project distrusts a green suite: the tests were green the whole time.

**Files:** the four above, plus whatever `npx tsc --noEmit` still reports at this point.

- [ ] **Step 1: Take an inventory**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -oE "^src/[^(]+" | sort | uniq -c
```

Write the list into your report *before* changing anything.

**Expected to be clear by now, because a task owned them:** `ResultsView.tsx`, `exportDocx.ts`, `exportDocx.test.ts`, `csv.test.ts`, `findingOutcome.test.ts`. Anything still listed from those is a **regression to report, not to quietly patch here** — say so in your report rather than absorbing it.

**Expected to still be listed, and yours to fix:** `FindingCard.test.tsx`. Task 7 cleared `FindingCard.tsx` (the component) and repaired the three literals that would otherwise have crashed at runtime once `StateChip` started reading `finding.verification`. Its brief scoped it to the component, not that file's remaining `pending`/`running`/`error`/`cancelled` fixtures, so roughly four errors there are expected. This paragraph exists because Task 7's implementer spotted the two briefs disagreeing and flagged it rather than guessing — the disagreement is resolved in favour of the sweep owning them.

- [ ] **Step 2: Fix each stale fixture**

For every `Finding` object literal missing the new fields, add:

```ts
      verification: { state: 'unchecked' },
      notes: [],
```

or, where the file already imports from `src/lib/verification`, `verification: unchecked(), notes: []`. Prefer whichever the surrounding file already does; do not introduce an import into a file for two words.

Where a literal has `citations: ['some quote']`, it must become `citations: [{ quote: 'some quote', documentId: '<the doc id that test uses>' }]`. **Use the real document id from that test's own fixtures** — a citation attributed to the wrong document is the defect `repairCitations` exists to prevent, and a test fixture that models it wrongly will happily assert wrong behaviour later.

**Change nothing else.** Do not "improve" these tests, do not rename anything, do not add assertions. This is a type-fixture sweep, and every line beyond it makes the diff harder to trust.

- [ ] **Step 3: Prove it**

```bash
npx tsc --noEmit          # must be completely clean, zero errors
npm test                  # full suite, must be green
npm run build             # must complete, with no externalization warning
```

All three are gates. If `tsc` is clean but a test now fails, you have changed behaviour rather than fixtures — revert and report it.

- [ ] **Step 4: Commit**

**Stage only the files you actually changed, by name.** Do **not** use `git add -A`, `git add .`, `git add src` or `git add -u`. During this sub-project another agent's `git add` swept four files belonging to a concurrently-running task into its commit; it was caught and corrected, but a contaminated commit that goes unnoticed attributes one task's work to another and corrupts every review package downstream of it.

```bash
git add src/features/review/runReview.test.ts src/App.interrupted.test.tsx src/App.authRedirect.test.tsx src/features/tabular/TabularReview.interrupted.test.tsx
# ...adjusted to exactly the files your inventory in Step 1 named
git commit -m "chore(b): update stale Finding fixtures in tests the plan missed"
git show --stat HEAD   # confirm the file list is exactly yours, and nothing else
```

If `git show --stat HEAD` lists a file you did not touch, **stop and report it** rather than attempting a correction.

### Task 14: Documentation, full gates, and browser verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `src/features/settings/SettingsPanel.tsx` (privacy note, if it describes findings)

- [ ] **Step 1: Run every gate**

```bash
npx tsc --noEmit
npm test
npm run build
```

All three must be clean. Fix anything they surface before continuing — a task that ends with a red gate is not done.

- [ ] **Step 2: Update the README**

**Two edits, not one — checked against the file.** The README's `## What it does` section describes the core loop in four numbered steps, and **step 4 ("Read the findings") is now wrong by omission**: it describes risk badges and citations as the whole of what a finding carries. Amend that step to say a finding also carries a verification state a human sets, and that citations are now shown inline with their document and page rather than needing a hover. Do not bolt the new behaviour on as a section at the bottom while the description of the core loop still describes the old one — a reader takes the numbered steps as the product.

Then add a section describing, in the user's terms:

- Every finding starts unverified, and says so on screen and in every export.
- A reviewer can verify, flag, or reject a finding; a rejection requires a reason and is exported with it.
- Re-running a clause clears its verification, because the verification described output that no longer exists.
- Notes are kept against a finding and survive a re-run.
- Evidence is shown inline with the document it came from and, for PDFs where the quote could be located, its page.
- Exports are never blocked. A DOCX or CSV export carries a one-line summary of how many findings were verified, and labels every finding that was not.

- [ ] **Step 3: Update CLAUDE.md**

Add to the conventions section:

- Verification state is set only by a human action; nothing derives it.
- Re-running a clause resets its verification. This is load-bearing and mutation-tested.
- `verificationLabel` in `findingOutcome.ts` is the only place export wording lives — the DOCX and CSV exporters have drifted apart once before.
- `derivePage` is the only place a citation page number is produced, and it returns `undefined` rather than guessing.
- Verification and note writes are await-then-apply: the UI never shows a state the store did not take.

Add to the extraction-points list: `verification.ts`, `citationRepair.ts`, `citationPage.ts`, `reviewProgress.ts`, `findingMerge.ts`, `uid.ts` (extracted at its *seventh* byte-identical copy — recorded as a failure to follow the rule, not a success), and `src/test/mount.tsx`.

**Add these to the "Environment quirks that will waste your time" section.** Every one was found the hard way during this sub-project, and each cost real time:

- **`toEqual` does not distinguish an absent key from an `undefined` one.** Vitest treats `{ a: 1 }` and `{ a: 1, b: undefined }` as equal. When *absence* is the thing you mean, assert `expect('b' in obj).toBe(false)`. This matters beyond tidiness: `structuredClone` — which is how IndexedDB writes every record — **preserves** an `undefined`-valued key, so a guard that looks decorative is load-bearing.
- **Component tests drive `createRoot`/`act` directly; there is no `@testing-library/react`.** New component tests import the shared harness at `src/test/mount.tsx`. Existing test files keep the harness they hand-rolled — they work, and rewriting them buys no behaviour.
- **Setting `.value` on a controlled React input does nothing useful.** React reads from its own internal tracker, so a plain assignment updates the DOM and leaves React believing nothing changed. Go through the prototype's value setter, then dispatch `input`. `mount.tsx`'s `type()` does this; use it rather than rediscovering it.
- **`runReview` owns its own copy of the run and emits a full snapshot roughly twice per cell.** Anything a human writes onto a finding from outside the engine — a verification, a note — is invisible to it and will be overwritten by the next unrelated cell finishing. `carryHumanState` re-applies it; `handleUpdate` must keep using it.
- **`retryCell` derives every snapshot from the run it is handed.** Mutating state *alongside* the call does not survive; the changed run has to be passed *into* it.
- **`usableText` strips the `[Page N]` markers and drops sparse pages.** Anything that needs real page numbers must read `doc.text`, not the readability-filtered text.

**Add a line to the sibling-drift section**: this sub-project extracted `uid()` after finding seven byte-identical copies in source. The rule says extract on the second. Seven is what it looks like when nobody does.

- [ ] **Step 4: Browser verification with a real key**

`npm run dev`, then in the browser:

1. Create a matter, add a PDF, run a review with a real OpenRouter key.
2. Confirm each finding's evidence is readable inline, with the document name and — for quotes the matcher can locate — a page number. Click one and confirm the viewer still highlights and scrolls to the right passage.
3. Verify two findings, flag one, reject one with a reason.
4. Fully reload the browser. Confirm all four states survived, with their reason and attribution.
5. Retry one of the verified clauses. Confirm its chip returns to Unverified and the app says why.
6. Export the DOCX and the CSV. Open both. Confirm the header summary is present and correct in each, that the rejected finding appears **with its reason**, and that unverified findings are labelled in both.
7. Work the keyboard loop: j/k to move, v/f/r to act. Confirm typing in a note box does not trigger any of them.
8. Open a review created before this sub-project (or hand-write one into IndexedDB at the old shape) and confirm it opens with citations intact and every finding unchecked.

Record the outcome of each of the eight in the task report. A step that could not be completed is reported as not completed, never as passed.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md src/features/settings/SettingsPanel.tsx
git commit -m "docs(b): describe verification, evidence pins and export labelling"
```

---

## Self-Review

Run against the spec after the plan is written; findings are fixed inline.

**Spec coverage.** Spec section 2's eight in-scope items map to: (1) `Citation[]` — Tasks 1, 3, 4, 5; (2) the state machine — Tasks 1, 8, 10; (3) notes — Tasks 1, 9, 10; (4) inline evidence — Task 7; (5) `StateChip`/`RiskChip` — Task 6; (6) export labelling — Task 11; (7) verification progress — Task 12; (8) the workspace and keyboard loop — Tasks 7, 8, 9, 13. Section 10's five test suites map to Tasks 3+5 (migration), 1+8+10 (state), 9 (notes), 11 (export labelling), 10 (persistence). Section 11's nine definition-of-done items map to Task 14 step 1 (1), Task 10 (2, 8), Task 10 step 4 (3), Task 7 (4), Task 11 (5), Task 12 (6), Task 5 (7), Task 14 step 4 (9). No gaps.

**Placeholder scan.** The four test bodies written as comment outlines — `App.verification.test.tsx`, `App.rerunResets.test.tsx`, and the two `MatterHome` cases — are deliberate and flagged as such in their steps: they must be written against the harness in the existing suite they extend, and inventing a fixture shape here that does not match that harness would be worse than naming the assertions precisely and saying where the harness comes from. Every other code block is complete and runnable.

**Type consistency.** `Citation`, `Verification`, `VerificationState`, `Note` are defined in Task 1 and used unchanged thereafter. `VerificationChange` is defined in Task 1's `verification.ts` and consumed in Tasks 8, 10, 13. `verificationCounts`/`VerificationCounts` are defined in Task 11's `findingOutcome.ts` and re-exported by Task 12's `reviewProgress.ts` — one definition, two import paths, no second implementation. `findingKey(docId, clauseId)` produces `doc::clause`, and Task 10's `verifyBusyKey` comparison in `ResultsView` uses the same template literal — a reviewer should check these agree, and they do. `repairCitations(raw, documentId, documentText?)` has one signature, used identically in Tasks 4 and 5.

**Ordering.** Tasks 1-3 leave `tsc` red on purpose and Task 1 says so explicitly; the tree is type-clean again from Task 5 onward for the library and from Task 10 for the app. No task depends on a later one.
