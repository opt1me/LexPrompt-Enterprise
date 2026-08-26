# Redesign sub-project A — Persistence and the matter model

**Date:** 2026-08-26
**Status:** Approved for planning (authorised by the repository owner to proceed without review)
**Builds on:** `docs/superpowers/specs/2026-08-26-lexprompt-core-design.md` (v1, complete, 238 tests)
**Source handoff:** `design_handoff_lexprompt_redesign/` — digested to `.superpowers/redesign/{requirements,ui}-digest.md`
**Rulings made without review:** `.superpowers/redesign/rulings.md`

## 1. Why this sub-project exists, and why it is first

The redesign reorganises LexPrompt around a **matter** — documents, reviews, findings and notes stop being an ephemeral session and become durable things a lawyer returns to. Every other part of the redesign assumes that. The verification states of sub-project B are meaningless if findings vanish on reload; collections in C are relationships between documents that must persist to be relationships at all; playbook versioning in D and the learning pipeline in E both write durable artifacts.

So A is the foundation, and it is deliberately unglamorous: a storage engine, an entity, routing, and a migration. It ships no new review capability. What it ships is the ability for anything else to be remembered.

The handoff underestimates one part of this. `IMPLEMENTATION.md` §4 says to "bump `TEMPLATE_SCHEMA_VERSION` (2) to a new `SCHEMA_VERSION` (3) and write the migration in `src/lib/storage.ts`". Today's `storage.ts` is a synchronous `localStorage` wrapper with hand-written corrupt-data quarantining. IndexedDB is asynchronous, transactional and versioned. This is a module rewrite, and treating it as a version bump is how it becomes a mid-sprint surprise (ruling R3).

## 2. Scope

**In:**

1. An IndexedDB storage engine replacing the `localStorage` implementation, behind the existing interface.
2. A `Matter` entity, a matters list, and a matter home screen.
3. Real routing — matters, reviews and playbooks addressable by URL.
4. Durable documents: original file bytes persisted; page images regenerated on demand.
5. Durable reviews: a completed review is reopenable after a reload.
6. A local user profile supplying the identity substrate (ruling R1).
7. Migration of existing `localStorage` templates and settings, losslessly.

**Explicitly out, and belonging to later sub-projects:** verification states and export gating (B); attributed `Citation[]`, notes on findings, the three-pane review ledger (B); collections, net positions, the variation trail (C); standard positions and deviation evaluation (D); playbook versioning, the authoring wizard, learning from redlines, changesets (D and E); the comparison grid; the first-run intake wizard; mobile layouts; the visual reskin.

**Out and staying out:** genuine multi-user, sync, and assignment-as-workflow (ruling R1). The identity *fields* land here; the collaboration does not.

**Unchanged and not to be touched:** `src/lib/citations.ts`, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/features/review/extractClause.ts`, `runReview.ts`, `PdfCanvas.tsx`, and the whole of `src/features/assistant/` (ruling R4). These are v1 code, tested and browser-verified. This sub-project moves data underneath them; it does not rewrite them.

## 3. Constraints inherited from v1, which still bind

- **Backend-free.** Static build, deployable to any static host. No server in this sub-project.
- **Fail loudly rather than answer quietly wrong.** This governed every v1 decision and governs storage equally: a partial read, a failed migration or a lost document must be visible, never silently absent.
- **The user's own OpenRouter key**, stored in the browser, sent only to OpenRouter.
- **`tsc --noEmit` clean; the full suite green; no CDN references; the entry chunk kept lean** with heavy dependencies lazily loaded.

## 4. The privacy position changes, deliberately and visibly

v1's spec states that contract text is the most sensitive thing the app handles and is therefore never written to disk. This sub-project reverses that, because a matter that forgets its documents is not a matter.

The reversal is bounded and must be stated plainly in the product, not just here:

- Everything stays in **the visitor's own browser**, in IndexedDB. Nothing is uploaded anywhere except to the model the user chose, via OpenRouter, at the moment they run a review.
- **Deleting a matter deletes its documents and their bytes**, not just its index entry. A purge that leaves orphaned blobs behind would make the privacy note false.
- **The Settings privacy note and the README are updated in this sub-project**, not later. A stale privacy statement is worse than none, and v1's is about to become inaccurate.

## 5. Storage design

### 5.1 Engine

IndexedDB via the `idb` wrapper (small, well-maintained, promise-based). Raw IndexedDB is usable but its event-based API invites subtle transaction bugs, and this module holds the user's work.

Object stores:

| Store | Key | Holds |
|---|---|---|
| `matters` | `id` | Matter records |
| `documents` | `id` | Document metadata + extracted text, indexed by `matterId` |
| `blobs` | `documentId` | Original file bytes as a `Blob` |
| `reviews` | `id` | Review records including the findings map, indexed by `matterId` |
| `playbooks` | `id` | What v1 called templates |
| `profile` | fixed key | The local user profile |
| `settings` | fixed key | As today |

`blobs` is a separate store from `documents` deliberately: listing a matter's documents must not drag megabytes of file bytes into memory to render a list of filenames.

### 5.2 Documents, and what replaces `File` (ruling R2)

A `File` handle cannot survive a reload. The handoff drops it without saying what replaces it.

**Original file bytes are persisted as a `Blob`. Page images are not persisted at all.** Page images are derived data — base64 strings roughly a third larger than the bytes they encode — and given the original PDF they are regenerable by the same code that produced them at ingest. Storing both source and derivative would be the largest storage cost in the app for no benefit, and it is precisely the cost the handoff worries about.

Consequence, accepted: a scanned document re-renders its page images on first view after a reload rather than instantly. If that proves annoying, page images become a cache keyed on document id — an addition, not a rework.

### 5.3 Corrupt-data behaviour carries across

v1 learned, at the cost of two fix rounds, that a storage layer must not destroy what it cannot read. `readAll()` quarantines an unparseable blob to a timestamped backup key before returning empty, and the quarantine write is itself guarded so a full disk cannot block startup.

IndexedDB fails differently — a version mismatch, a blocked upgrade, a corrupted object store — but it still fails. The engine must carry the same posture: **never delete what it cannot read; surface the problem; keep the app openable.**

### 5.4 Migration

On first load after upgrade, existing `localStorage` templates and settings migrate into IndexedDB.

- **The `localStorage` data is not deleted on migration.** It is left in place until a subsequent successful load confirms the new store is readable. A migration that deletes its source before proving its destination is one power-cut away from losing the user's playbooks.
- Migration is idempotent and re-entrant — a half-completed migration interrupted by a closed tab must resolve correctly next load, not double-import.
- A failed migration surfaces an explicit error with the templates still intact in `localStorage`, never a silently empty library.

## 6. Data model

Extending v1's types rather than replacing them where possible.

```ts
interface UserProfile { id: string; name: string; initials: string }

interface Matter {
  id: string;
  name: string;
  client?: string;
  reference?: string;
  ownerId: string;            // from the local profile (R1)
  createdAt: number;
  updatedAt: number;
}

interface DocumentRecord {
  id: string;
  matterId: string;
  name: string;
  kind: 'pdf' | 'docx' | 'txt';
  text: string;
  parseError?: string;
  byteSize: number;
  addedAt: number;
  addedByUserId: string;      // R1
  // no `file`, no `pageImages` — see 5.2
}

interface Review {
  id: string;
  matterId: string;
  playbookSnapshot: Playbook;   // v1's templateSnapshot discipline, renamed
  documentIds: string[];
  findings: Record<string, Record<string, Finding>>;
  modelId: string;
  startedAt: number;
  completedAt?: number;
  cancelledAt?: number;         // v1 added this; it stays
  createdByUserId: string;      // R1
}
```

`Template` is renamed `Playbook` with no structural change in this sub-project — versioning, standard positions and `extractPrompt` belong to D. Renaming now and extending later is cheaper than renaming after three sub-projects reference it.

`Finding` is unchanged here. Verification state, notes and attributed citations are B's work.

## 7. Routing

Matters, reviews and playbooks become addressable. v1's `view` string in `App.tsx` cannot express "this matter, that review".

Use the History API rather than hash routing: `firebase.json` already rewrites all paths to `index.html`, and every mainstream static host offers the same SPA fallback. The README must state that requirement, since a host without it will 404 on refresh — a failure that looks like a broken app.

Routes: `/`, `/matters/:matterId`, `/matters/:matterId/reviews/:reviewId`, `/playbooks`, `/playbooks/:playbookId`, `/settings`.

A tiny hand-rolled router is sufficient and avoids a dependency; if it exceeds roughly 100 lines, take `wouter` instead.

## 8. Screens

**Matters list** — the entry point. Name, client, last activity, review count. Create and delete, delete confirming and purging blobs (§4).

**Matter home** — documents in the matter, reviews in the matter, and a way to start a new review. This replaces v1's run panel as the entry to a review; the run panel becomes "add documents and run" *within* a matter.

**Existing screens move under a matter.** The review workspace, results cards, tabular grid and playbook editor are v1 code and keep working; they gain a matter context and lose their session-scoped assumptions.

The visual reskin is not in this sub-project. These screens should follow existing `src/components` conventions and look like the current app.

## 9. Error handling

- A document whose blob is missing renders as unavailable with its metadata intact — never a blank viewer, never a crash.
- A review referencing a deleted document degrades to showing the finding text without the viewer, and says why.
- Quota exhaustion on write surfaces plainly, naming what could not be saved. IndexedDB quota is large but not infinite, and contract PDFs are the biggest thing here.
- A blocked IndexedDB upgrade (another tab holding the old version open) must produce an explanatory message, not a hang. This is the classic IndexedDB failure and it is invisible until it happens to someone.

## 10. Testing

`fake-indexeddb` for the engine, so the storage layer is testable in the existing jsdom setup.

| Suite | Covers |
|---|---|
| `storage/engine.test.ts` | CRUD per store, transactions, indexes, blocked-upgrade handling |
| `storage/migration.test.ts` | v1 templates migrate losslessly; source retained; idempotent; interrupted migration resolves; failure leaves `localStorage` intact |
| `storage/blobs.test.ts` | Blob round-trip; delete-matter purges blobs; missing blob degrades |
| `matters.test.ts` | Matter CRUD; cascade delete; documents and reviews correctly scoped |
| `router.test.ts` | Route parsing, unknown routes, deep-link into a matter and a review |

Migration is the priority. It is the one operation that can destroy work the user already has, and it runs exactly once per user — so a bug in it is both maximally damaging and minimally likely to be caught by ordinary use.

## 11. Definition of done

1. `tsc --noEmit` clean; full suite green; build clean; entry chunk not materially larger.
2. A v1 user's existing templates appear as playbooks after upgrade, with `localStorage` still intact.
3. A matter can be created, documents added, a review run, the browser fully reloaded, and that review reopened with its findings intact.
4. A PDF added before a reload still renders in the viewer afterwards, with citations still highlighting correctly.
5. Deleting a matter removes its documents, blobs and reviews — verified by inspecting IndexedDB, not by the UI appearing empty.
6. A deep link to a matter and to a review both work from a cold load.
7. Two tabs open, one upgrading, produces an explanatory message rather than a hang.
8. The Settings privacy note and README accurately describe the new persistence behaviour.

## 12. Risks

**The migration is the dangerous part.** Everything else in this sub-project can be re-run; migration touches data the user already owns. Hence retaining the source, idempotency, and the largest share of the test effort.

**Persisting contract text is a policy reversal.** It is bounded to the visitor's own browser and made visible in the product (§4), but the repository owner should confirm they are comfortable with it — this spec proceeds on the reading that a matter-centric redesign requires it, which the handoff states plainly.

**The identity substrate will look like more than it is.** Fields exist, names render, but assignment reaches nobody (R1). The UI must not imply otherwise.
