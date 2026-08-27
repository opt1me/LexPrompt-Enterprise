# Redesign sub-project C — Collections and Net Positions: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a lease and the documents that amend it be read together as one source, and produce a per-clause net position that a human confirms before anything relies on it.

**Architecture:** A `Collection` (one base document plus ordered amendments) becomes a review target alongside plain documents. A collection review makes **one model call per clause** over the combined, document-labelled text, returning a per-document derivation trail plus a proposed net position. Net positions start unconfirmed and follow sub-project B's verification discipline exactly — the same await-then-apply writes, the same reset-on-re-run, the same export labelling.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6, Tailwind 4, Vitest 3 + jsdom, `fake-indexeddb`, `idb` 8, `docx` 9.

**Spec:** `docs/superpowers/specs/2026-08-27-redesign-c-collections-and-net-positions.md`

**Builds on:** sub-project B (`docs/superpowers/plans/2026-08-27-redesign-b-verified-findings.md`), complete at 55 files / 588 tests, all gates green.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** A net position is text no document contains, describing a legal position. It is the most dangerous output this app produces.
- **A net position starts `unconfirmed` and says so, everywhere it appears.** Only a human confirms it. Nothing derives confirmation from the model's confidence, the document count, or a low risk level.
- **Re-running a clause resets its net-position confirmation**, exactly as it resets a verification. Same rule, same reason, and it is mutation-tested in both places.
- **An unconfirmed net position exports labelled**, never blocked and never silently.
- **A citation attributed to the wrong document is worse than a lost one.** A citation naming a document that was not in the call is dropped; one whose document number is unreadable is recovered by matching its quote against each document's text, and only then dropped.
- **The standalone path must not change.** A review over plain documents must produce byte-identical findings to today. `extractClause` is not modified; collection extraction is a new function beside it.
- **Extract on the second copy, not the third.** Existing extractions: `seq.ts`, `pageSegments.ts`, `findingOutcome.ts`, `modelContext.ts`, `describeLoadError`, `verification.ts`, `citationRepair.ts`, `citationPage.ts`, `reviewProgress.ts`, `findingMerge.ts`, `uid.ts`, `src/test/mount.tsx`.
- **Mutation-test anything load-bearing.** Six tests in sub-project B passed against broken code and were caught only by breaking the implementation. A green suite is not evidence.
- **Gates:** `npx tsc --noEmit` clean, `npm test` green, `npm run build` clean with no externalization warning.
- Never write an API key literal into any file. `.env` holds one and is gitignored — leave it alone.

### Component-test conventions — read before writing any test

**This project has no `@testing-library/react` and is not getting one.** Component tests drive `createRoot`/`act` directly. New test files import the shared harness at `src/test/mount.tsx` (`mount`, `mountOnce`, `buttons`, `buttonNamed`, `textbox`, `click`, `type`, `keyDown`, `keyDownOn`). **Existing test files keep the harness they already hand-rolled** — do not sweep them.

Two traps that cost real time in sub-project B:

- **`toEqual` does not distinguish an absent key from an `undefined` one.** When absence is what you mean, assert `expect('k' in obj).toBe(false)`. This is load-bearing: `structuredClone`, which is how IndexedDB writes every record, preserves the key.
- **Two live `mount()`s in one test leave two competing global listeners.** Use `mountOnce` with an explicit unmount when a test needs a second tree.

### Verified facts about the current codebase — checked against the files, do not re-derive

- `DB_VERSION` is **1**, and `open.ts`'s `upgrade(db)` guards every store with `if (!db.objectStoreNames.contains(...))`, so adding a store is a clean additive bump to **2**.
- `deleteMatter` opens ONE readwrite transaction over `[matters, documents, blobs, reviews]` and deletes by `byMatter` index. Collections must join that transaction, not get their own.
- `Review` today has `documentIds: string[]` and `findings: Record<docId, Record<clauseId, Finding>>`.
- `migrateReviewRecord(raw, documentText?)` in `src/lib/db/reviewMigration.ts` is the single read-time funnel, invoked from `stripSeq` in `reviews.ts`. Extend it; do not add a second migration.
- `extractClause(doc, clause, template, settings, signal)` never rejects and returns one `Finding`. `assessDocument(doc, modelSupportsImages)` returns `{ kind, text, useImages }`; `contextBudgetChars(modelContextLength)` gives the budget.
- `usableText` strips `[Page N]` markers and drops sparse pages. **Anything needing real page numbers reads `doc.text`.** This cost a wrong ruling in sub-project B — do not repeat it.
- `notify(message, variant?)` accepts only `'success' | 'error'`. There is no `'info'`.
- There is no component-scoped `userId` in `App.tsx`; async handlers do `const profile = await getProfile()`.

### Standing rulings for this sub-project

- **R-C1. A collection review keys its findings by the collection id.** `findings[collectionId][clauseId]`. A collection produces ONE position per clause, not one per document, so keying by document would force an arbitrary choice of which document "owns" the finding. A tiny helper resolves the key from the target so no caller re-derives it. *Cost if wrong: a read-time migration of the findings map.*
- **R-C2. Collection extraction is a NEW function, not a change to `extractClause`.** The spec protects the standalone path, and a standalone review must stay byte-identical. *Cost if wrong: two extraction paths to keep honest — mitigated by both returning the same `Finding` shape and sharing `repairCitations`.*
- **R-C3. Amendment order is explicit, not derived from `documentDate`.** A date can be missing, wrong, or ambiguous, and the order in which amendments take effect is a legal judgement. `documentDate` is displayed; `variesDocumentIds` order governs. *Cost if wrong: the user reorders by hand, which they can already do.*
- **R-C4. Suggested grouping proposes, never creates.** The filename/date heuristic renders a dismissible suggestion. Nothing is grouped without a click. *Cost if wrong: an extra click.*

---

## File Structure

**New leaf modules:**

| File | Responsibility |
|---|---|
| `src/lib/collectionOrder.ts` | `orderedMembers(collection, documents)` — base first, then amendments in effect order, with any member whose document is missing surfaced rather than dropped. The single source of "what order do these read in". |
| `src/lib/reviewTarget.ts` | `findingsKeyFor(target)`, `targetDocumentIds(target)`, `isCollectionTarget(target)`. Ruling R-C1's helper, so no caller re-derives the key. |
| `src/lib/netPosition.ts` | The confirm/amend state machine — `unconfirmedPosition()`, `confirmPosition()`, `amendPosition()`, `resetPosition()`. Mirrors `verification.ts` deliberately. |
| `src/lib/collectionPrompt.ts` | `buildCollectionPrompt(members, clause, template, budget)` — document labelling, effect ordering, and which documents got truncated **by name**. Pure; no model call. |
| `src/lib/collectionSuggest.ts` | `suggestCollections(documents)` — the filename/date heuristic. Proposes only. |
| `src/lib/db/collections.ts` | The `collections` repository, mirroring `matters.ts`/`documents.ts` including its `_seq` discipline. |

**New feature files:** `src/features/review/extractCollectionClause.ts`, `src/features/review/NetPositionPanel.tsx`, `src/features/review/VariationTrailModal.tsx`, `src/features/matters/CollectionCard.tsx`, `src/features/matters/GroupDocumentsDialog.tsx`.

**Modified:** `src/types.ts`, `src/lib/db/schema.ts`, `src/lib/db/open.ts`, `src/lib/db/matters.ts`, `src/lib/db/reviewMigration.ts`, `src/lib/findingOutcome.ts`, `src/features/review/runReview.ts`, `src/features/review/ResultsView.tsx`, `src/features/review/exportDocx.ts`, `src/features/tabular/csv.ts`, `src/features/tabular/TabularReview.tsx`, `src/features/matters/MatterHome.tsx`, `src/App.tsx`, `README.md`, `CLAUDE.md`.

---

### Task 1: The data model, the store, and the review target

**Files:**
- Modify: `src/types.ts`, `src/lib/db/schema.ts`, `src/lib/db/open.ts`
- Create: `src/lib/reviewTarget.ts`, `src/lib/db/collections.ts`
- Test: `src/lib/reviewTarget.test.ts`, `src/lib/db/collections.test.ts`

**Interfaces produced:** `Collection`, `NetPosition`, `TrailStep`, `ReviewTarget`; `DocumentRecord` gains `role`/`collectionId?`/`documentDate?`; `Review` gains `target`; `Finding` gains `netPosition?`; `SCHEMA_VERSION` 4 → 5; `DB_VERSION` 1 → 2; `findingsKeyFor`, `targetDocumentIds`, `isCollectionTarget`; the collections repository.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/reviewTarget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findingsKeyFor, targetDocumentIds, isCollectionTarget } from './reviewTarget';

const docs = { kind: 'documents' as const, documentIds: ['d1', 'd2'] };
const coll = { kind: 'collection' as const, collectionId: 'c1', documentIds: ['d1', 'd2', 'd3'] };

describe('reviewTarget', () => {
  it('keys a document review by each document', () => {
    expect(findingsKeyFor(docs, 'd2')).toBe('d2');
  });

  it('keys a collection review by the collection, whichever document is passed', () => {
    expect(findingsKeyFor(coll, 'd1')).toBe('c1');
    expect(findingsKeyFor(coll, 'd3')).toBe('c1');
  });

  it('keys a collection review even with no document supplied', () => {
    expect(findingsKeyFor(coll)).toBe('c1');
  });

  it('refuses to key a document review with no document — there is no single answer', () => {
    expect(() => findingsKeyFor(docs)).toThrow();
  });

  it('exposes the flat document list for both kinds', () => {
    expect(targetDocumentIds(docs)).toEqual(['d1', 'd2']);
    expect(targetDocumentIds(coll)).toEqual(['d1', 'd2', 'd3']);
  });

  it('discriminates the two kinds', () => {
    expect(isCollectionTarget(coll)).toBe(true);
    expect(isCollectionTarget(docs)).toBe(false);
  });
});
```

Create `src/lib/db/collections.test.ts`, following `src/lib/db/documents.test.ts`'s setup exactly (read it first — it has the `fake-indexeddb` beforeEach/afterEach pattern and a `getDb`/`closeDb`/`STORES` import you must reuse):

```ts
describe('collections repository', () => {
  it('saves and reads a collection back', async () => { /* … */ });
  it('lists a matter's collections, most recent first', async () => { /* … */ });
  it('rejects rather than resolving to [] when the database fails', async () => { /* … */ });
  it('deleting a collection leaves its member documents intact', async () => { /* … */ });
  it('deleting a matter deletes its collections', async () => { /* … */ });
  it('deleting a matter still leaves no orphaned documents, blobs or reviews', async () => { /* … */ });
});
```

Write those bodies fully against that file's fixtures. The last two matter most: `deleteMatter` is the one operation that destroys data the user owns.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reviewTarget.test.ts src/lib/db/collections.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Add the types**

In `src/types.ts`, add above `Review`:

```ts
/** An ordered set of documents read together as one source: one base
 *  document plus the documents that amend it. A lease and its deed of
 *  variation answer a clause together; asked separately they give two
 *  confident answers and neither is the answer. */
export interface Collection {
  id: string;
  matterId: string;
  name: string;
  baseDocumentId: string;
  /** The amending documents, in the order they take effect. Ordered
   *  EXPLICITLY rather than derived from `documentDate` (ruling R-C3): a
   *  date can be missing, wrong or ambiguous, and the order in which
   *  amendments bite is a legal judgement, not a sort. */
  variesDocumentIds: string[];
  createdAt: number;
  createdByUserId: string;
}

export type NetPositionState = 'unconfirmed' | 'confirmed';

/** One document's contribution to a clause's derivation. */
export interface TrailStep {
  documentId: string;
  kind: 'original' | 'varies';
  /** What this document does to this clause, in the model's words. */
  effect: string;
  citations: Citation[];
}

/**
 * What the documents, read in order, say now — synthesised text that no
 * single document contains. It is therefore the most dangerous output this
 * app produces, and starts `unconfirmed` for the same reason a finding
 * starts `unchecked`.
 */
export interface NetPosition {
  proposed: string;
  /** Present when a human rewrote it. Shown and exported in preference to
   *  `proposed`, which is kept so the trail can show what changed. An
   *  amended position is a STRONGER claim than a confirmed one, not a
   *  weaker one — a person wrote it. */
  amended?: string;
  state: NetPositionState;
  byUserId?: string;
  at?: number;
  /** The argument for the conclusion, one step per contributing document,
   *  in effect order. A net position without it is an assertion. */
  trail: TrailStep[];
}

export type ReviewTarget =
  | { kind: 'documents'; documentIds: string[] }
  | { kind: 'collection'; collectionId: string; documentIds: string[] };
```

`DocumentRecord` gains three fields:

```ts
  /** 'standalone' unless the document belongs to a collection. */
  role: 'base' | 'varies' | 'standalone';
  collectionId?: string;
  /** When the document takes effect, where it was read from the document or
   *  entered by the user. Absent rather than guessed — displayed, never used
   *  to order amendments (ruling R-C3). */
  documentDate?: number;
```

`Finding` gains one:

```ts
  /** Present only on a finding produced by a collection-aware run. A
   *  standalone finding has none and must NOT be given an empty one:
   *  absence means "this question did not arise", where an empty net
   *  position would read as "we tried and found nothing". */
  netPosition?: NetPosition;
```

`Review` gains `target: ReviewTarget` and **keeps `documentIds`** for now — every existing consumer reads it, and Task 5's migration fills `target` from it. Bump `SCHEMA_VERSION` to `5`.

- [ ] **Step 4: Add the store**

`schema.ts`: `DB_VERSION = 2`, add `collections: 'collections'` to `STORES`, and to `LexPromptDB`:

```ts
  collections: {
    key: string;
    value: import('../../types').Collection;
    indexes: { byMatter: string };
  };
```

`open.ts`: add the guarded creation alongside the others — the existing `upgrade(db)` is already idempotent, so this is purely additive:

```ts
        if (!db.objectStoreNames.contains(STORES.collections)) {
          const s = db.createObjectStore(STORES.collections, { keyPath: 'id' });
          s.createIndex('byMatter', 'matterId');
        }
```

- [ ] **Step 5: Write `reviewTarget.ts`**

```ts
import type { ReviewTarget } from '../types';

export function isCollectionTarget(
  target: ReviewTarget,
): target is Extract<ReviewTarget, { kind: 'collection' }> {
  return target.kind === 'collection';
}

/** Every document the review covers, whichever kind of target it is. The
 *  viewer's tab strip, the exporters and the hydration path all need the
 *  flat list and must not each unpack the union themselves. */
export function targetDocumentIds(target: ReviewTarget): string[] {
  return target.documentIds;
}

/**
 * The key a finding is stored under in `Review.findings`.
 *
 * A document review keys by document — one finding per document per clause,
 * as it always has. A collection review keys by the COLLECTION (ruling
 * R-C1), because it produces one position per clause however many documents
 * fed it; keying by document would force an arbitrary choice of which
 * document "owns" the answer, and every consumer would have to make the
 * same choice the same way.
 *
 * Throws rather than guessing when a document review is asked for a key
 * with no document: there is genuinely no single answer, and returning
 * something plausible would put findings under a key nothing reads.
 */
export function findingsKeyFor(target: ReviewTarget, documentId?: string): string {
  if (isCollectionTarget(target)) return target.collectionId;
  if (!documentId) {
    throw new Error('A document review needs a document id to key a finding by.');
  }
  return documentId;
}
```

- [ ] **Step 6: Write the collections repository**

Create `src/lib/db/collections.ts` mirroring `src/lib/db/documents.ts` — **read that file first and follow its shape**, including its `_seq` tie-breaking via `nextSeq`/`seqOf` from `./seq` and its rule that a genuine database failure rejects rather than resolving to `[]`. Export `listCollections(matterId)`, `getCollection(id)`, `saveCollection(c)`, `deleteCollection(id)`, `newCollection(matterId, name, baseDocumentId, userId)`.

`deleteCollection` deletes **only the collection record**. Its member documents are untouched and their `role`/`collectionId` are cleared by the caller (Task 3's ungroup), because clearing them is a matter-level operation over documents, not a collections-store one.

- [ ] **Step 7: Extend the cascade delete**

In `src/lib/db/matters.ts`, add `STORES.collections` to `deleteMatter`'s transaction list and delete the matter's collections inside that same transaction, using the `byMatter` index like the others. **One transaction, not two** — this is the operation that must not half-succeed, and the existing function is already written that way.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/lib/reviewTarget.test.ts src/lib/db/collections.test.ts src/lib/db/matters.test.ts src/lib/db/open.test.ts`
Expected: PASS. `matters.test.ts` and `open.test.ts` are included because you changed the cascade and the schema version — their existing assertions must still hold.

`npx tsc --noEmit` will now be red across the app: `Review` gained a required `target` and `DocumentRecord` gained a required `role`. Expected; Tasks 2-10 clear it. **Never loosen a type to quiet it.**

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/lib/db/schema.ts src/lib/db/open.ts src/lib/db/matters.ts src/lib/reviewTarget.ts src/lib/reviewTarget.test.ts src/lib/db/collections.ts src/lib/db/collections.test.ts
git commit -m "feat(c): Collection, NetPosition and ReviewTarget types, plus the collections store"
```

---

### Task 2: The net-position state machine

**Files:**
- Create: `src/lib/netPosition.ts`
- Test: `src/lib/netPosition.test.ts`

**Interfaces produced:** `unconfirmedPosition(proposed, trail)`, `confirmPosition(pos, userId, at)`, `amendPosition(pos, text, userId, at)`, `resetPosition(pos)`, `positionText(pos)`, `NetPositionError`.

This deliberately mirrors `src/lib/verification.ts`. **Read that file first** and follow its shape, its comment density and its reasoning style — the two state machines answer the same question about different objects, and a reader who has understood one should recognise the other immediately.

- [ ] **Step 1: Write the failing test**

Create `src/lib/netPosition.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  unconfirmedPosition, confirmPosition, amendPosition, resetPosition,
  positionText, NetPositionError,
} from './netPosition';
import type { TrailStep } from '../types';

const trail: TrailStep[] = [
  { documentId: 'd1', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
  { documentId: 'd2', kind: 'varies', effect: 'Notice cut to 6 months.', citations: [] },
];

describe('unconfirmedPosition', () => {
  it('starts unconfirmed, with no attribution', () => {
    const p = unconfirmedPosition('Break on 6 months notice.', trail);
    expect(p.state).toBe('unconfirmed');
    expect(p.byUserId).toBeUndefined();
    expect(p.at).toBeUndefined();
    expect(p.trail).toHaveLength(2);
  });

  it('does not invent an amendment', () => {
    expect('amended' in unconfirmedPosition('x', trail)).toBe(false);
  });
});

describe('confirmPosition', () => {
  it('records who and when', () => {
    const p = confirmPosition(unconfirmedPosition('x', trail), 'u1', 99);
    expect(p).toMatchObject({ state: 'confirmed', byUserId: 'u1', at: 99 });
  });

  it('keeps the trail — the argument survives the conclusion being accepted', () => {
    expect(confirmPosition(unconfirmedPosition('x', trail), 'u1', 99).trail).toHaveLength(2);
  });
});

describe('amendPosition', () => {
  it('stores the human text and marks it confirmed — a person wrote it', () => {
    const p = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 5);
    expect(p.amended).toBe('human text');
    expect(p.state).toBe('confirmed');
    expect(p.byUserId).toBe('u1');
  });

  it('keeps `proposed` so the trail can show what was changed', () => {
    const p = amendPosition(unconfirmedPosition('model text', trail), 'human text', 'u1', 5);
    expect(p.proposed).toBe('model text');
  });

  it('refuses an empty or whitespace-only amendment', () => {
    const p = unconfirmedPosition('model text', trail);
    expect(() => amendPosition(p, '', 'u1', 5)).toThrow(NetPositionError);
    expect(() => amendPosition(p, '   ', 'u1', 5)).toThrow(NetPositionError);
  });

  it('trims what it stores', () => {
    expect(amendPosition(unconfirmedPosition('m', trail), '  h  ', 'u1', 5).amended).toBe('h');
  });
});

describe('positionText', () => {
  it('prefers the human amendment over the model proposal', () => {
    const p = amendPosition(unconfirmedPosition('model', trail), 'human', 'u1', 1);
    expect(positionText(p)).toBe('human');
  });

  it('falls back to the proposal when unamended', () => {
    expect(positionText(unconfirmedPosition('model', trail))).toBe('model');
  });
});

describe('resetPosition', () => {
  it('returns to unconfirmed and drops attribution', () => {
    const p = resetPosition(confirmPosition(unconfirmedPosition('m', trail), 'u1', 1));
    expect(p.state).toBe('unconfirmed');
    expect(p.byUserId).toBeUndefined();
    expect('at' in p).toBe(false);
  });

  it('drops a human amendment too — it described superseded synthesis', () => {
    const amended = amendPosition(unconfirmedPosition('m', trail), 'human', 'u1', 1);
    expect('amended' in resetPosition(amended)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/netPosition.test.ts` — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/netPosition.ts`. Key reasoning to carry in the comments:

- `unconfirmedPosition` is the only constructor, and it never takes a state — there is no way to build a confirmed position without going through a human action, by construction.
- `amendPosition` sets `state: 'confirmed'` because a human wrote the text; an amended position is a stronger claim than a confirmed one, not a weaker one.
- `resetPosition` drops `amended` as well as the confirmation. The amendment described a synthesis of documents against output that has now been re-derived; keeping it would let a report present a human's words as describing text they never saw. This is the same rule as `resetVerification`, for the same reason.
- Reject an empty amendment the way `applyVerification` rejects a reasonless rejection: throw, so a caller cannot persist the invalid value by ignoring a result.

- [ ] **Step 4: Run and pass**

Run: `npx vitest run src/lib/netPosition.test.ts` — 12 tests.

- [ ] **Step 5: Mutation-test the reset**

The reset is load-bearing. Make each edit, run the suite, confirm a FAILURE, revert:

1. `resetPosition` returns `current` unchanged — "returns to unconfirmed" must fail.
2. `resetPosition` keeps `amended` — "drops a human amendment too" must fail.
3. `amendPosition` leaves `state` as it found it — "marks it confirmed" must fail.
4. `amendPosition` drops the empty-text throw — the two refusal tests must fail.

Report which bit and which needed a new test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/netPosition.ts src/lib/netPosition.test.ts
git commit -m "feat(c): the net-position confirm/amend state machine"
```

---

### Task 3: Reading order, and the grouping suggestion

**Files:**
- Create: `src/lib/collectionOrder.ts`, `src/lib/collectionSuggest.ts`
- Test: `src/lib/collectionOrder.test.ts`, `src/lib/collectionSuggest.test.ts`

**Interfaces produced:** `orderedMembers<T extends { id: string }>(collection, documents: T[]): CollectionMember<T>[]`, where `CollectionMember<T = DocumentRecord>` is `{ document: T | null; documentId: string; kind: 'original' | 'varies'; position: number }`; and `suggestCollections(documents): CollectionSuggestion[]`.

**Generic over the document shape, on purpose.** Two callers need different shapes and neither converts to the other:

- The matter home and the variation trail hold persisted `DocumentRecord`s, which by design carry **no page images** — sub-project A ruled page images are derived data, regenerated on demand, never stored.
- Extraction holds hydrated `DocumentFile`s, **with** page images where a document is a scan.

Pinning this to `DocumentRecord` would force Task 5 to either bypass this function or give up the image fallback, and a collection containing a scanned deed of variation would then be reviewed as though that document said nothing. That is this project's founding defect — a scanned PDF on a text-only model answering "the agreement is silent on this point" for every clause — reopened one level up.

- [ ] **Step 1: Write the failing tests**

`src/lib/collectionOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { orderedMembers } from './collectionOrder';
import type { Collection, DocumentRecord } from '../types';

function doc(id: string, name: string): DocumentRecord {
  return { id, matterId: 'm1', name, kind: 'pdf', text: '', byteSize: 1, addedAt: 1, addedByUserId: 'u1', role: 'standalone' };
}
const collection: Collection = {
  id: 'c1', matterId: 'm1', name: 'Lease as varied',
  baseDocumentId: 'lease', variesDocumentIds: ['dov', 'licence'],
  createdAt: 1, createdByUserId: 'u1',
};

describe('orderedMembers', () => {
  it('puts the base first, then amendments in their stored order', () => {
    const out = orderedMembers(collection, [doc('licence','L.pdf'), doc('lease','Lease.pdf'), doc('dov','DoV.pdf')]);
    expect(out.map(m => m.documentId)).toEqual(['lease', 'dov', 'licence']);
    expect(out.map(m => m.kind)).toEqual(['original', 'varies', 'varies']);
  });

  it('numbers positions from 1 in reading order', () => {
    const out = orderedMembers(collection, [doc('lease','L'), doc('dov','D'), doc('licence','X')]);
    expect(out.map(m => m.position)).toEqual([1, 2, 3]);
  });

  it('ignores documentDate — order is the stored order, not a sort', () => {
    const docs = [
      { ...doc('lease','L'), documentDate: 3000 },
      { ...doc('dov','D'), documentDate: 1000 },
      { ...doc('licence','X'), documentDate: 2000 },
    ];
    expect(orderedMembers(collection, docs).map(m => m.documentId)).toEqual(['lease', 'dov', 'licence']);
  });

  it('surfaces a missing member rather than dropping it', () => {
    const out = orderedMembers(collection, [doc('lease','L'), doc('licence','X')]);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ documentId: 'dov', document: null });
  });

  it('surfaces a missing BASE rather than promoting an amendment', () => {
    const out = orderedMembers(collection, [doc('dov','D'), doc('licence','X')]);
    expect(out[0]).toMatchObject({ documentId: 'lease', document: null, kind: 'original' });
    expect(out[1].kind).toBe('varies');
  });

  it('ignores documents that are not members', () => {
    const out = orderedMembers(collection, [doc('lease','L'), doc('dov','D'), doc('licence','X'), doc('stray','S')]);
    expect(out.map(m => m.documentId)).not.toContain('stray');
  });
});
```

`src/lib/collectionSuggest.test.ts` — the heuristic **proposes** and must be conservative. Assert at minimum: a base plus a clearly-named amendment is proposed; two unrelated documents are not; a single document is never proposed as a collection; and every suggestion names which document it thinks is the base. Write these fully.

- [ ] **Step 2: Run and confirm failure.** `npx vitest run src/lib/collectionOrder.test.ts src/lib/collectionSuggest.test.ts`

- [ ] **Step 3: Implement `orderedMembers`**

The comment that matters:

> Order comes from `variesDocumentIds`, never from `documentDate` (ruling R-C3). A date can be missing, wrong, or ambiguous, and the order in which amendments take effect is a legal judgement someone made — not something to re-derive on every render. `documentDate` is shown to the reader; it does not sort.
>
> A member whose document is missing comes back with `document: null` rather than being filtered out. The caller must be able to say "the deed of variation is gone" — silently reading a two-document collection as complete is exactly the quietly-wrong failure this project exists to prevent.

- [ ] **Step 4: Implement `suggestCollections`**

Conservative by construction (ruling R-C4). Reasonable signals: a shared stem with an amendment word (`deed of variation`, `licence to alter`, `side letter`, `supplemental`, `amendment`, `addendum`), or a shared stem plus a version/turn marker. **Never** group on filename similarity alone — two unrelated leases in a portfolio share almost every word.

Each suggestion carries `{ baseDocumentId, variesDocumentIds, name, reason }`, where `reason` is shown to the user so they can judge it. A suggestion nobody can evaluate is a guess wearing a UI.

- [ ] **Step 5: Run and pass. Step 6: Commit**

```bash
git add src/lib/collectionOrder.ts src/lib/collectionOrder.test.ts src/lib/collectionSuggest.ts src/lib/collectionSuggest.test.ts
git commit -m "feat(c): collection reading order and a conservative grouping suggestion"
```

---

### Task 4: The combined-text prompt

**Files:**
- Create: `src/lib/collectionPrompt.ts`
- Test: `src/lib/collectionPrompt.test.ts`

**Interfaces produced:** `buildCollectionPrompt(members, clause, template, budgetChars): { prompt: string; truncated: string[] }` — `truncated` naming the documents that were cut, **by name**.

**Consumes:** `orderedMembers`' output (Task 3); `assessDocument`/`contextBudgetChars` from `src/lib/modelContext.ts`.

- [ ] **Step 1: Write the failing test**

Assert:
- Each document is introduced by its **number, role and name**, and its date when present, so a returned citation can be attributed and an effect can be ordered.
- Documents appear in reading order, base first.
- The clause instruction and any risk criteria appear once, after the documents — not repeated per document.
- The response contract asks for a per-document `effect` **and** a proposed net position; a model returning only a conclusion is returning an assertion, and the prompt must not invite that.
- **When the budget forces truncation, the returned `truncated` array names the affected documents, and the prompt says so by name.** "The deed of variation was cut short" is actionable; "the text was truncated" is not.
- A member with `document: null` is described as unavailable in the prompt rather than silently omitted — the model must know the set is incomplete.
- Budget is divided so no single long document starves the others; the base is never truncated to nothing while an amendment is sent whole.

- [ ] **Step 2: Run and confirm failure. Step 3: Implement. Step 4: Run and pass.**

The prompt shape:

```
DOCUMENT 1 (BASE) — "Lease.pdf", dated 12 March 2019
<text>

DOCUMENT 2 (VARIES) — "Deed of Variation.pdf", dated 4 June 2024
<text>
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/collectionPrompt.ts src/lib/collectionPrompt.test.ts
git commit -m "feat(c): the combined-text prompt, naming any document it had to truncate"
```

---

### Task 5: Collection-aware extraction

**Files:**
- Create: `src/features/review/extractCollectionClause.ts`
- Test: `src/features/review/extractCollectionClause.test.ts`
- Modify: `src/features/review/runReview.ts`

**Interfaces produced:** `extractCollectionClause(members: CollectionMember<DocumentFile>[], clause, template, settings, signal): Promise<Finding>` — never rejects, exactly as `extractClause` never rejects.

**Note the member type.** Extraction takes **hydrated** `DocumentFile`s, not persisted `DocumentRecord`s, so a scanned member still gets its page-image fallback via `assessDocument`. A persisted record has no page images, and reviewing a scanned amendment as though it were empty is the defect this whole app was built around. `App.tsx` already hydrates documents for a run (`documentFileForReview`); pass those.

**This is the riskiest task in the sub-project.** It changes what a run *asks for*, where A and B only moved data underneath the engine.

- [ ] **Step 1: Write the failing tests**

Follow `src/features/review/extractClause.test.ts`'s existing mocking pattern — **read it first**; it already mocks `chatJson` and has document/clause/template/settings fixtures to reuse. Do not build a second set.

Assert:
- A trail step per contributing document, in reading order, each with its `effect`.
- A citation naming document 2 is attributed to document 2's real id.
- **A citation naming a document that was not in the call is dropped**, and the finding still returns with the rest.
- **A citation whose document number is unreadable is recovered by matching its quote against each document's text** (using `normalizeForMatch`), and only dropped if that also fails.
- Pages are derived per document from that document's own `doc.text`, via `repairCitations` — **not** from `readability.text`, which strips the markers.
- The net position starts `unconfirmed`, and the finding's `verification` starts `unchecked`.
- A model returning a conclusion but no trail yields `status: 'error'` with a message saying so — an assertion is not a derivation.
- **A missing base document fails the clause loudly** ("there is nothing to vary"), while a missing amendment produces a net position explicitly marked as derived from an incomplete set.
- The function never rejects: an aborted call resolves to `status: 'cancelled'`, an API failure to `status: 'error'` with `authError` where applicable — mirroring `extractClause`'s existing behaviour exactly.

- [ ] **Step 2: Run and confirm failure. Step 3: Implement.**

Reuse rather than reimplement: `repairCitations` for every citation, `unchecked()` for the verification, `unconfirmedPosition()` for the position, `assessDocument`/`contextBudgetChars` for readability and budget, `isAuthError` for the auth path.

- [ ] **Step 4: Wire it into `runReview` — minimally**

`runReview` gains a branch: when the run's target is a collection, each clause runs **once** through `extractCollectionClause` over the ordered members, and the result is stored under `findingsKeyFor(target)`. When it is not, the existing per-document fan-out runs **completely unchanged**.

Keep the change small and legible. The concurrency, abort handling, progressive `onUpdate` emission and `retryCell` all stay as they are — a collection run is a different *shape of work list*, not a different engine.

- [ ] **Step 5: Prove the standalone path did not move**

Run the full existing review suite: `npx vitest run src/features/review/ src/lib/`. Every pre-existing assertion must pass untouched. If any needed editing, that is a behaviour change to report, not to absorb.

- [ ] **Step 6: Mutation-test the attribution rules**

1. Attribute every citation to the base document regardless of its number — the document-2 test must fail.
2. Keep a citation naming an absent document — that test must fail.
3. Remove the quote-match recovery — the unreadable-number test must fail.
4. Let a trail-less response through as `done` — that test must fail.
5. Pass `readability.text` to `repairCitations` instead of `doc.text` — the page-derivation test must fail. *(This mutation exists because the equivalent instruction was wrong in sub-project B and cost a fix round.)*

- [ ] **Step 7: Commit**

```bash
git add src/features/review/extractCollectionClause.ts src/features/review/extractCollectionClause.test.ts src/features/review/runReview.ts
git commit -m "feat(c): collection-aware extraction — one call per clause, per-document trail"
```

---

### Task 6: Migrating existing reviews onto the target

**Files:**
- Modify: `src/lib/db/reviewMigration.ts`, `src/lib/db/documents.ts`
- Test: `src/lib/db/reviewMigration.test.ts` (extend)

Every stored `Review` predates `target`, and every stored `DocumentRecord` predates `role`.

- [ ] **Step 1: Write the failing tests**

Extend `src/lib/db/reviewMigration.test.ts` — it already has `legacyReview()` and the migration's existing assertions; reuse them.

Assert:
- A stored review with `documentIds` and no `target` migrates to `{ kind: 'documents', documentIds }`.
- `documentIds` is **retained** alongside `target` — every existing consumer reads it.
- **`target.documentIds` is ALWAYS rebuilt from `Review.documentIds` on read**, even when a `target` is already stored. Assert this directly: a record whose stored `target.documentIds` disagrees with its `Review.documentIds` comes back with the two in agreement, taking `Review.documentIds` as authoritative.

  This is ruling F-C1 and it is not decoration. `Review` now holds the document list twice — once at the top level and once inside `target` — and two copies of one fact is the defect shape this project has recorded six times. Rebuilding on every read means the two *cannot* drift no matter what writes them, and `targetDocumentIds()` stays a safe accessor. The alternative, trusting both to stay in step, is how the six became six.
- A review already carrying a `collection` target keeps its `kind` and its `collectionId` — only its `documentIds` are re-derived.
- A review with neither `target` nor `documentIds` gets `{ kind: 'documents', documentIds: [] }` rather than an absent target — an unreadable target must not crash the screen, and an empty document list is visibly empty.
- **Idempotent**, and it **does not mutate** the input. Both already have precedents in that file; follow them.
- A `DocumentRecord` with no `role` reads back as `'standalone'`, and one already in a collection keeps its role.

- [ ] **Step 2: Run, confirm failure, implement, pass.**

Extend the **existing** `migrateReviewRecord` — do not add a second migration function. It is already the single funnel through `stripSeq`, and a second one is precisely the sibling drift this project keeps recording. Do the same for documents: one read-time normaliser in `documents.ts`, applied wherever a `DocumentRecord` is read.

- [ ] **Step 3: Mutation-test**

1. Drop `documentIds` when writing `target` — the retention test must fail.
2. Overwrite an existing `collection` target with a `documents` one — that test must fail.
2b. Trust a stored `target.documentIds` instead of rebuilding it from `Review.documentIds` — the F-C1 disagreement test must fail. This is the mutation that proves the two lists cannot drift.
3. Default a missing `role` to `'base'` instead of `'standalone'` — the document test must fail. *(A document silently becoming a collection's base is not a cosmetic default.)*

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/reviewMigration.ts src/lib/db/reviewMigration.test.ts src/lib/db/documents.ts
git commit -m "feat(c): migrate stored reviews onto ReviewTarget and documents onto role"
```

---

### Task 7: Grouping and ungrouping on the matter home

**Files:**
- Create: `src/features/matters/CollectionCard.tsx`, `src/features/matters/GroupDocumentsDialog.tsx`
- Modify: `src/features/matters/MatterHome.tsx`, `src/App.tsx`
- Test: `src/features/matters/CollectionCard.test.tsx`, `src/features/matters/GroupDocumentsDialog.test.tsx`

**Verified facts — checked against the files:**
- `MatterHome.tsx` has its **own** `mount(node)` helper and a `makeMatter()` factory in its test file, and uses `createRoot`/`act` directly. **New test files take `src/test/mount.tsx`; `MatterHome.test.tsx` keeps its own.**
- `Modal`'s open prop is **`isOpen`**, its contract is `{ isOpen, title, onClose, children, footer?, size? }`, and its action buttons go in the `footer` slot. It sets `role="dialog"` and `aria-modal="true"` (added in sub-project B).
- `Button` extends `React.ButtonHTMLAttributes`, so `disabled` works and is styled. It has a `danger` variant.
- `notify(message, variant?)` takes only `'success' | 'error'`.
- Async handlers in `App.tsx` get their user id via `const profile = await getProfile()`; there is no component-scoped `userId`.

- [ ] **Step 1: Write the failing tests**

`CollectionCard.test.tsx` — assert the card names the collection, shows the base row labelled BASE and each amendment labelled VARIES **in reading order**, offers `Ungroup`, and — importantly — **renders a member whose document is missing as unavailable rather than omitting it**, with the collection marked broken and a repair action offered.

`GroupDocumentsDialog.test.tsx` — assert: at least two documents are required before the confirm enables; exactly one base is chosen and it defaults to the first selected; amendments keep the order the user put them in; a name is required; and cancelling changes nothing.

- [ ] **Step 2: Run, confirm failure, implement.**

`MatterHome` gains, in its documents section: collection cards above the standalone document rows; a `Group as a collection` action enabled once two or more standalone documents are selected; and — above the list — a **dismissible** suggestion when `suggestCollections` proposes one, showing its `reason`. The suggestion never groups anything on its own (ruling R-C4).

`App.tsx` gains `handleCreateCollection`, `handleUngroupCollection` and `handleRepairCollection`. Follow the await-then-apply discipline sub-project B established: the UI reflects a change only after the store confirms it, and a failure surfaces via `notify(..., 'error')`.

**Ungrouping never deletes documents.** It deletes the collection record and clears `role`/`collectionId` on each member. **Deleting a collection likewise never deletes documents.** Deleting a *matter* still deletes everything in it, as sub-project A established and Task 1 extended.

- [ ] **Step 3: Run and pass. Step 4: Commit**

```bash
git add src/features/matters/CollectionCard.tsx src/features/matters/CollectionCard.test.tsx src/features/matters/GroupDocumentsDialog.tsx src/features/matters/GroupDocumentsDialog.test.tsx src/features/matters/MatterHome.tsx src/App.tsx
git commit -m "feat(c): group and ungroup documents into a collection"
```

---

### Task 8: The net position on screen, and the variation trail

**Files:**
- Create: `src/features/review/NetPositionPanel.tsx`, `src/features/review/VariationTrailModal.tsx`
- Modify: `src/features/review/FindingCard.tsx`, `src/features/review/ResultsView.tsx`, `src/App.tsx`
- Test: `src/features/review/NetPositionPanel.test.tsx`, `src/features/review/VariationTrailModal.test.tsx`

- [ ] **Step 1: Write the failing tests**

`NetPositionPanel.test.tsx`:
- An unconfirmed position **says it is unconfirmed**, visibly, with no interaction. There is no "no chip" state, for the same reason `StateChip` has none.
- A confirmed position shows who confirmed it and when.
- An amended position shows the **human** text, and marks it as amended by a person — a stronger claim than confirmed, not a weaker one.
- `Confirm` and `Amend` are offered on an unconfirmed position; `Amend` on a confirmed one.
- **Everything is disabled while a write is in flight** (`busy`), exactly as `VerificationControls` does — the UI must not offer a second change before the first is known to have persisted.
- A finding with **no** net position renders **nothing at all** — absence means the question did not arise, and an empty panel would read as "we tried and found nothing".
- `See the variation trail` is offered only when there is a trail.

`VariationTrailModal.test.tsx`:
- One step per contributing document, **in reading order**, each labelled ORIGINAL or VARIES with its document name and date where known.
- Each step shows its effect and its quoted citations.
- The terminal card shows the net position with `Confirm` / `Amend`.
- A step whose document is missing renders as unavailable, not omitted.
- Amending requires non-empty text; the confirm stays disabled on whitespace. *(This mirrors `RejectReasonModal` — read it and follow its shape rather than inventing a second dialog idiom.)*

- [ ] **Step 2: Run, confirm failure, implement.**

`FindingCard` renders `NetPositionPanel` **above** the evidence when `finding.netPosition` is present — the reader meets the position and its confirmation state before the supporting quotes.

`App.tsx` gains `handleConfirmNetPosition` and `handleAmendNetPosition`. **Both follow B's established path exactly**: build the updated run with `withUpdatedFinding`, `await saveReview(...)`, and only then `setRun` and update `latestRunRef` — and route the snapshot through `carryHumanState` so a live run cannot overwrite the confirmation. Reuse those helpers; do not write a third copy of that pattern.

**Re-running a clause resets its net position**, alongside the verification, in `handleRetryCell`. The `cleared` run must be threaded **into** `retryCell`, exactly as B does — `retryCell` derives every snapshot from the run it is handed, so setting state alongside the call does not survive.

- [ ] **Step 3: Mutation-test the reset and the persistence**

1. Remove the net-position reset from `handleRetryCell` — the reset test must fail.
2. `setRun` before `await saveReview` — a "does not show a confirmation the store rejected" test must fail.
3. Drop `carryHumanState` from the confirm path — a mid-run confirmation must be shown to survive the next `onUpdate`.

- [ ] **Step 4: Commit**

```bash
git add src/features/review/NetPositionPanel.tsx src/features/review/NetPositionPanel.test.tsx src/features/review/VariationTrailModal.tsx src/features/review/VariationTrailModal.test.tsx src/features/review/FindingCard.tsx src/features/review/ResultsView.tsx src/App.tsx
git commit -m "feat(c): net position on the finding, and the variation trail"
```

---

### Task 9: Export honesty for net positions

**Files:**
- Modify: `src/lib/findingOutcome.ts`, `src/features/review/exportDocx.ts`, `src/features/tabular/csv.ts`
- Test: those three suites

**`findingOutcome.ts` is the only place export wording lives.** The DOCX and CSV exporters drifted apart once before; every label added here goes in that module and both exporters read it. There is already a test asserting the two agree — extend it, do not write a parallel one.

- [ ] **Step 1: Write the failing tests**

- `netPositionLabel(finding)` returns `'UNCONFIRMED NET POSITION'` for an unconfirmed one, `null` for a confirmed one, and `null` when there is no net position at all. **The three cases are distinct** and a test must show it: no-position is not the same as confirmed, and conflating them would export a synthesis as though a human had signed it off.
- **The derivation is exported, not just the conclusion.** A test asserts each trail step's document and effect reach both the DOCX bytes and the CSV text. A net position without its trail is an assertion, and an export carrying only the conclusion is exactly that.
- An **amended** position exports the human text and says it was amended by a person.
- The DOCX/CSV agreement test covers the new labels too.

- [ ] **Step 2: Implement, run, pass.**

- [ ] **Step 3: Mutation-test**

1. `netPositionLabel` returns `null` for unconfirmed — both exporters' tests must fail.
2. Export only the conclusion, dropping the trail — the derivation test must fail in both.
3. Export `proposed` in preference to `amended` — the amended test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/lib/findingOutcome.ts src/lib/findingOutcome.test.ts src/features/review/exportDocx.ts src/features/review/exportDocx.test.ts src/features/tabular/csv.ts src/features/tabular/csv.test.ts
git commit -m "feat(c): export an unconfirmed net position labelled, and with its derivation"
```

---

### Task 10: The comparison grid, as a triage surface

**Files:**
- Modify: `src/features/tabular/TabularReview.tsx`, `src/features/tabular/CellDetail.tsx`
- Test: `src/features/tabular/TabularReview.test.tsx` (new)

The grid is for a portfolio of **genuinely separate** documents. A collection has one position, not a comparison, so a collection review is refused a grid **with an explanation** rather than rendering an empty table.

Sub-project B's final review found the grid's cells show **no verification state**, so a rejected and a verified cell look identical. That is this task's job.

- [ ] **Step 1: Write the failing tests**

- A cell shows its verification state **and** its risk level, as two separate indicators. Never merged — three questions, three answers, exactly as `StateChip` and `RiskChip` are kept apart on the card.
- A cell renders a readable sentence, not a truncated blob.
- Each clause column header carries a risk mini-bar summarising that column.
- `Open in review` hands off to the ledger for the clicked cell.
- **A collection review renders an explanation instead of a grid**, naming why.
- An errored cell still shows its error and its retry, as today.

- [ ] **Step 2: Implement, run, pass.**

Reuse `StateChip` and `RiskChip` — do not draw new indicators. Reuse `verificationCounts` for the column summaries rather than counting inline.

- [ ] **Step 3: Commit**

```bash
git add src/features/tabular/TabularReview.tsx src/features/tabular/TabularReview.test.tsx src/features/tabular/CellDetail.tsx
git commit -m "feat(c): the comparison grid shows verification and risk separately"
```

---

### Task 11: Documentation, gates, and browser verification

- [ ] **Step 1: Run every gate**

```bash
npx tsc --noEmit      # 0 errors
npm test              # green
npm run build         # clean, no externalization warning
```

- [ ] **Step 2: README**

The `## What it does` numbered steps are the product as a reader understands it — **amend them, do not only append.** Step 3 ("Run it over one document or a batch") is now wrong by omission: documents can be read *together* as a collection. Then add a section covering collections, net positions, confirming and amending, and the fact that an unconfirmed position exports labelled.

Add to `## Known limitations`: a collection review produces one position per clause and is not shown in the comparison grid; and the grid is for genuinely separate documents.

- [ ] **Step 3: CLAUDE.md**

Add to the conventions:
- A net position is synthesised text no document contains; it starts unconfirmed and only a human confirms it.
- Re-running a clause resets its net position as well as its verification. Both are mutation-tested.
- `findingsKeyFor` is the only place a findings key is derived (ruling R-C1).
- `orderedMembers` is the only place collection reading order is decided; `documentDate` never sorts it (ruling R-C3).
- Collection extraction is a separate function from `extractClause` so the standalone path cannot drift.

Add to the extraction-points list: `reviewTarget.ts`, `netPosition.ts`, `collectionOrder.ts`, `collectionPrompt.ts`, `collectionSuggest.ts`.

- [ ] **Step 4: Browser verification**

`npm run dev`, then, against a genuine base-plus-variation pair:

1. Group two documents into a collection, naming it and choosing the base.
2. Confirm the card shows BASE and VARIES in reading order.
3. Run a review over the collection.
4. Confirm each clause shows a net position marked **unconfirmed**, with a trail.
5. Open the variation trail; confirm one step per contributing document, each with its own quotes.
6. Click a citation from an **amendment** and confirm the viewer opens **that** document's tab and highlights the right passage — not the base's.
7. Confirm one net position; amend another. Reload; confirm both survived with attribution.
8. Re-run a clause whose position was confirmed; confirm it returns to unconfirmed and says so.
9. Export DOCX and CSV; confirm the unconfirmed position is labelled and the derivation is present in both.
10. Ungroup the collection; confirm both documents survive as standalone.

Report each of the ten individually. **A step that could not be completed is reported as not completed, never as passed.**

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(c): describe collections, net positions and the variation trail"
```

---

## Self-Review

**Spec coverage.** Spec §3's nine in-scope items map to: (1) `Collection` — Task 1; (2) document roles — Tasks 1, 6; (3) grouping/ungrouping — Task 7; (4) suggested grouping — Tasks 3, 7; (5) collection-aware extraction — Tasks 4, 5; (6) `NetPosition` — Tasks 1, 2, 8; (7) the variation trail — Task 8; (8) export honesty — Task 9; (9) the comparison grid — Task 10. Spec §9's seven suites map to Tasks 1, 4, 5, 2+8, 6, 9, 10. Spec §10's ten definition-of-done items map to Task 11 step 1 (1), Task 7 (2), Task 5 (3), Task 8 step 4 item 6 (4), Task 8 (5), Task 8 (6), Task 9 (7), Task 10 (8), Task 11 step 4 (9). No gaps.

**Placeholder scan.** Tasks 3, 7, 8 and 10 give their test bodies as itemised assertions rather than literal code, with an explicit instruction to write them against the fixtures in the file being extended. That is deliberate and is the lesson sub-project B taught: four of its defects came from test code drafted from memory of idioms rather than from the target file. Every code block that *is* given is complete.

**Type consistency.** `ReviewTarget`, `Collection`, `NetPosition` and `TrailStep` are defined once in Task 1 and used unchanged. `findingsKeyFor(target, documentId?)` has one signature, used in Tasks 5, 8 and 10. `orderedMembers`' `CollectionMember` shape is produced in Task 3 and consumed in Tasks 4, 7 and 8. `unconfirmedPosition`/`confirmPosition`/`amendPosition`/`resetPosition` are defined in Task 2 and used in 5 and 8.

**Ordering.** Task 1 leaves `tsc` red on purpose and says so. The library is type-clean from Task 6, the app from Task 8. No task depends on a later one.
