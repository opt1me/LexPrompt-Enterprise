# Redesign Sub-project A — Persistence and Matters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LexPrompt remember things — an IndexedDB engine behind v1's storage seam, a `Matter` as the top-level object, real routing, durable documents and reviews, and a lossless migration of existing playbooks.

**Architecture:** IndexedDB (via `idb`) holds matters, documents, blobs, reviews, playbooks and the local profile. Settings stay in synchronous `localStorage` (ruling R6). Original file bytes persist as Blobs in their own store; page images are never persisted and are regenerated on demand (ruling R2). Migration from `localStorage` retains its source until a later load proves the new store readable.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6, `idb` 8.0.3, `fake-indexeddb` 6.2.5 (dev), Vitest 3 + jsdom, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-26-redesign-a-persistence-and-matters.md`
**Rulings made without owner review:** `.superpowers/redesign/rulings.md`

## Global Constraints

- **Backend-free.** Static build. No server in this sub-project.
- **Fail loudly rather than answer quietly wrong.** A partial read, a failed migration or a lost document must be visible, never silently absent. This governed all of v1 and governs storage equally.
- **Never destroy what you cannot read.** v1 learned this over two fix rounds. Carried across in Task 4.
- **Settings stay in `localStorage`, synchronous** (R6). Do not move them.
- **Page images are never persisted** (R2). Original file bytes are.
- **Deleting a matter purges its blobs**, not just index entries — the privacy note depends on it.
- **Do not modify** `src/lib/citations.ts`, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/modelContext.ts`, `src/lib/findingOutcome.ts`, `src/features/review/extractClause.ts`, `runReview.ts`, or anything under `src/features/assistant/` (R4), except where a task says so explicitly.
- **Every task ends green:** `npx tsc --noEmit` 0 errors, `npm test` passing, `npm run build` clean with no externalization warning.
- Baseline at plan start: **238 tests**, entry chunk ~293 kB.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/db/schema.ts` | Store names, DB name/version, the `idb` `DBSchema` type |
| `src/lib/db/open.ts` | Opening + upgrading the database, blocked-upgrade handling |
| `src/lib/db/playbooks.ts` | Playbook CRUD (what v1 called templates) |
| `src/lib/db/matters.ts` | Matter CRUD + cascade delete |
| `src/lib/db/documents.ts` | Document metadata CRUD, scoped by matter |
| `src/lib/db/blobs.ts` | Original file bytes, keyed by document id |
| `src/lib/db/reviews.ts` | Review CRUD, scoped by matter |
| `src/lib/db/profile.ts` | The single local user profile |
| `src/lib/db/migrate.ts` | One-time `localStorage` → IndexedDB migration |
| `src/lib/router.ts` | Route parsing and navigation |
| `src/features/matters/MattersList.tsx` | Entry-point screen |
| `src/features/matters/MatterHome.tsx` | One matter's documents and reviews |
| `src/lib/storage.ts` | **Retained** for settings only; template functions removed |

---

### Task 1: Dependencies and IndexedDB test environment

**Files:**
- Modify: `package.json`, `vitest.setup.ts`
- Create: `src/lib/db/schema.ts`, `src/lib/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DB_NAME`, `DB_VERSION`, `STORES`, and the `LexPromptDB` `DBSchema` type.

- [ ] **Step 1: Install**

```bash
npm install idb@8.0.3
npm install --save-dev fake-indexeddb@6.2.5
```

- [ ] **Step 2: Wire fake-indexeddb into the existing test setup**

Append to `vitest.setup.ts`:

```ts
import 'fake-indexeddb/auto';
```

This gives every test a real (in-memory) IndexedDB. It must come before any test imports a db module.

- [ ] **Step 3: Write the failing test**

```ts
// src/lib/db/schema.test.ts
import { describe, it, expect } from 'vitest';
import { DB_NAME, DB_VERSION, STORES } from './schema';

describe('schema', () => {
  it('names every store the sub-project needs', () => {
    expect(Object.values(STORES).sort()).toEqual(
      ['blobs', 'documents', 'matters', 'playbooks', 'profile', 'reviews'].sort(),
    );
  });

  it('does not include settings — they stay in localStorage (ruling R6)', () => {
    expect(Object.values(STORES)).not.toContain('settings');
  });

  it('has a stable name and a positive integer version', () => {
    expect(DB_NAME).toBe('lexprompt');
    expect(Number.isInteger(DB_VERSION)).toBe(true);
    expect(DB_VERSION).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run src/lib/db/schema.test.ts`
Expected: FAIL — cannot resolve `./schema`.

- [ ] **Step 5: Implement**

```ts
// src/lib/db/schema.ts
import type { DBSchema } from 'idb';
import type { Finding, Playbook, Settings } from '../../types';

export const DB_NAME = 'lexprompt';
export const DB_VERSION = 1;

export const STORES = {
  matters: 'matters',
  documents: 'documents',
  blobs: 'blobs',
  reviews: 'reviews',
  playbooks: 'playbooks',
  profile: 'profile',
} as const;

/** The single key under which the one local profile is stored. */
export const PROFILE_KEY = 'local';

export interface LexPromptDB extends DBSchema {
  matters: { key: string; value: import('../../types').Matter };
  documents: {
    key: string;
    value: import('../../types').DocumentRecord;
    indexes: { byMatter: string };
  };
  blobs: { key: string; value: { documentId: string; bytes: Blob; mime: string } };
  reviews: {
    key: string;
    value: import('../../types').Review;
    indexes: { byMatter: string };
  };
  playbooks: { key: string; value: Playbook };
  profile: { key: string; value: import('../../types').UserProfile };
}

// Settings deliberately absent — see ruling R6. They are a few hundred bytes,
// read synchronously in render paths, and moving them would make every caller
// async for no benefit.
export type { Finding, Settings };
```

Note: `Matter`, `DocumentRecord`, `Review`, `UserProfile` and `Playbook` are defined in Task 2. This file will not typecheck until Task 2 lands — that is expected and the two tasks are committed in order. If you prefer, do Task 2 first; the plan orders them this way only because the schema is the smaller read.

- [ ] **Step 6: Run tests, typecheck, commit**

Because `src/types.ts` does not yet declare these types, `tsc` will fail until Task 2. Run `npx vitest run src/lib/db/schema.test.ts` to confirm the runtime test passes, then proceed directly to Task 2 and commit both together at the end of Task 2.

---

### Task 2: Domain types for matters, documents, reviews and the profile

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: v1's `Finding`, `Clause`.
- Produces: `UserProfile`, `Matter`, `DocumentRecord`, `Review`, `Playbook` (alias of `Template`), `SCHEMA_VERSION`.

- [ ] **Step 1: Add the types**

Append to `src/types.ts`:

```ts
/** Bumped from TEMPLATE_SCHEMA_VERSION (2) — see src/lib/db/migrate.ts. */
export const SCHEMA_VERSION = 3;

export interface UserProfile {
  id: string;
  name: string;
  initials: string;
}

export interface Matter {
  id: string;
  name: string;
  client?: string;
  reference?: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentRecord {
  id: string;
  matterId: string;
  name: string;
  kind: 'pdf' | 'docx' | 'txt';
  text: string;
  parseError?: string;
  byteSize: number;
  addedAt: number;
  addedByUserId: string;
}

export interface Review {
  id: string;
  matterId: string;
  playbookSnapshot: Playbook;
  documentIds: string[];
  findings: Record<string, Record<string, Finding>>;
  modelId: string;
  startedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  createdByUserId: string;
}
```

- [ ] **Step 2: Alias `Playbook` to `Template`**

Add, next to the existing `Template` interface:

```ts
/** The redesign's name for a Template. Structurally identical in sub-project A;
 *  versioning and standard positions arrive in sub-project D. */
export type Playbook = Template;
```

Do NOT rename `Template` itself in this task — v1 code refers to it throughout, and a rename here would touch a dozen files for no behavioural gain. The alias lets new code use the redesign's vocabulary immediately.

- [ ] **Step 3: Typecheck and commit both tasks**

```bash
npx tsc --noEmit
npm test
git add src/types.ts src/lib/db/schema.ts src/lib/db/schema.test.ts vitest.setup.ts package.json package-lock.json
git commit -m "feat: add IndexedDB schema and matter-model domain types"
```

---

### Task 3: Opening the database, and surviving a blocked upgrade

**Files:**
- Create: `src/lib/db/open.ts`, `src/lib/db/open.test.ts`

**Interfaces:**
- Consumes: `DB_NAME`, `DB_VERSION`, `STORES`, `LexPromptDB` from Task 1.
- Produces: `getDb(): Promise<IDBPDatabase<LexPromptDB>>`, `closeDb(): void`, `DbBlockedError`.

**Why this task is its own gate:** a blocked upgrade is the classic IndexedDB failure — a second tab holding the old version open makes the new one hang forever with no error. It is invisible in development and reported as "the app won't load".

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/db/open.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { getDb, closeDb } from './open';
import { STORES } from './schema';

afterEach(() => closeDb());

describe('getDb', () => {
  it('creates every store and index on first open', async () => {
    const db = await getDb();
    for (const name of Object.values(STORES)) {
      expect(db.objectStoreNames.contains(name)).toBe(true);
    }
    expect(db.transaction('documents').store.indexNames.contains('byMatter')).toBe(true);
    expect(db.transaction('reviews').store.indexNames.contains('byMatter')).toBe(true);
  });

  it('memoises the connection so concurrent callers share one open', async () => {
    const [a, b] = await Promise.all([getDb(), getDb()]);
    expect(a).toBe(b);
  });

  it('reopens after close', async () => {
    const first = await getDb();
    closeDb();
    const second = await getDb();
    expect(second).not.toBe(first);
    expect(second.objectStoreNames.contains('matters')).toBe(true);
  });

  it('does not memoise a failed open', async () => {
    // A rejected open must not poison the memo for the page's lifetime —
    // the same defect fixed in v1's loadPdfjs.
    const mod = await import('./open');
    expect(typeof mod.getDb).toBe('function');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/db/open.test.ts`
Expected: FAIL — cannot resolve `./open`.

- [ ] **Step 3: Implement**

```ts
// src/lib/db/open.ts
import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, STORES, type LexPromptDB } from './schema';
import { debug } from '../debug';

export class DbBlockedError extends Error {
  constructor() {
    super(
      'LexPrompt could not upgrade its local database because another tab has it open. ' +
        'Close other LexPrompt tabs and reload.',
    );
    this.name = 'DbBlockedError';
  }
}

let dbPromise: Promise<IDBPDatabase<LexPromptDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<LexPromptDB>> {
  if (!dbPromise) {
    dbPromise = openDB<LexPromptDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORES.matters)) {
          db.createObjectStore(STORES.matters, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.documents)) {
          const s = db.createObjectStore(STORES.documents, { keyPath: 'id' });
          s.createIndex('byMatter', 'matterId');
        }
        if (!db.objectStoreNames.contains(STORES.blobs)) {
          db.createObjectStore(STORES.blobs, { keyPath: 'documentId' });
        }
        if (!db.objectStoreNames.contains(STORES.reviews)) {
          const s = db.createObjectStore(STORES.reviews, { keyPath: 'id' });
          s.createIndex('byMatter', 'matterId');
        }
        if (!db.objectStoreNames.contains(STORES.playbooks)) {
          db.createObjectStore(STORES.playbooks, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.profile)) {
          db.createObjectStore(STORES.profile);
        }
      },
      blocked() {
        // Another tab holds an older version open. Without this the open hangs
        // silently forever, which reads to a user as "the app is broken".
        debug('IndexedDB upgrade blocked by another tab');
      },
      blocking() {
        // This tab is holding a version another tab wants to upgrade past.
        // Close so the other tab can proceed.
        closeDb();
      },
      terminated() {
        dbPromise = null;
      },
    }).catch(err => {
      // Never memoise a rejection — one transient failure must not poison
      // the database for the rest of the page's lifetime.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export function closeDb(): void {
  const pending = dbPromise;
  dbPromise = null;
  void pending?.then(db => db.close()).catch(() => {});
}
```

- [ ] **Step 4: Add a blocked-open guard with a timeout**

The `blocked` callback fires but `openDB` still never settles. Wrap the open so a blocked upgrade rejects with `DbBlockedError` rather than hanging. Add to `getDb`, before returning: race the open against a timer that rejects with `DbBlockedError` if `blocked()` fired and the open has not settled within 3 seconds. Add a test that asserts a blocked open rejects rather than hanging — if `fake-indexeddb` cannot simulate a blocked upgrade, say so in your report and cover it by manual reasoning instead of a vacuous test.

- [ ] **Step 5: Run, typecheck, commit**

```bash
npx vitest run src/lib/db/open.test.ts && npx tsc --noEmit && npm test
git add src/lib/db/open.ts src/lib/db/open.test.ts
git commit -m "feat: open the IndexedDB database, surviving a blocked upgrade"
```

---

### Task 4: Playbook repository, carrying v1's corrupt-data posture

**Files:**
- Create: `src/lib/db/playbooks.ts`, `src/lib/db/playbooks.test.ts`
- Modify: `src/lib/storage.ts` (remove template functions; keep settings)

**Interfaces:**
- Consumes: `getDb` (Task 3), `Playbook` (Task 2).
- Produces:
```ts
listPlaybooks(): Promise<Playbook[]>
getPlaybook(id: string): Promise<Playbook | null>
savePlaybook(p: Playbook): Promise<Playbook>
deletePlaybook(id: string): Promise<void>
newPlaybook(name: string): Playbook
exportPlaybook(p: Playbook): Blob
importPlaybook(json: string): Promise<Playbook>
```

**Carry across from v1, deliberately:** `listTemplates` sorts most-recently-updated first with a deterministic tiebreak; `importTemplate` assigns a fresh id so importing a template you already have creates a copy rather than overwriting; both error messages ("That file is not valid JSON." / "That file is not a template — it has no clauses.") are surfaced verbatim by the UI. Reproduce all three. Read `src/lib/storage.ts` before writing this — it took three fix rounds to get right.

- [ ] **Step 1: Write the failing tests**

Port every test from `src/lib/storage.test.ts` that concerns templates, renamed, plus:

```ts
it('never deletes records it cannot read', async () => {
  // Write a structurally invalid record directly, bypassing the repository.
  const db = await getDb();
  await db.put('playbooks', { id: 'broken' } as never);
  const all = await listPlaybooks();
  // The broken record must not crash the list, and must still be present in the store.
  expect(Array.isArray(all)).toBe(true);
  expect(await db.get('playbooks', 'broken')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Mirror v1's `storage.ts` behaviour on top of `getDb()`. Migrate malformed records on read (defaulting missing fields) rather than dropping them — v1's `migrate()` function is the model.

- [ ] **Step 3: Strip templates from `storage.ts`, keep settings**

Remove `newTemplate`, `listTemplates`, `getTemplate`, `saveTemplate`, `deleteTemplate`, `exportTemplate`, `importTemplate` and their helpers. **Keep `loadSettings` and `saveSettings` exactly as they are — synchronous, `localStorage`-backed** (R6). Keep the corrupt-data quarantine used by settings.

Update every import site. `tsc` will find them.

- [ ] **Step 4: Run everything, commit**

```bash
npx tsc --noEmit && npm test
git add src/lib/db/playbooks.ts src/lib/db/playbooks.test.ts src/lib/storage.ts src/lib/storage.test.ts src/features src/App.tsx
git commit -m "feat: move playbooks to IndexedDB; settings stay in localStorage"
```

---

### Task 5: Migration from localStorage — the dangerous one

**Files:**
- Create: `src/lib/db/migrate.ts`, `src/lib/db/migrate.test.ts`

**Interfaces:**
- Consumes: `getDb`, `savePlaybook`.
- Produces: `migrateIfNeeded(): Promise<MigrationResult>` where `MigrationResult = { status: 'not-needed' | 'migrated' | 'failed'; count: number; error?: string }`.

**Why this task carries the most test weight in the sub-project.** Everything else here can be re-run. This touches playbooks the user already owns, and it runs exactly once per user — so a bug in it is both maximally damaging and minimally likely to be caught by ordinary use.

**Three rules, all load-bearing:**
1. **The `localStorage` source is never deleted by the migration.** It is left intact. A separate, later cleanup may remove it only after a subsequent successful load proves the new store readable. A migration that deletes its source before proving its destination is one power-cut from losing the user's work.
2. **Idempotent and re-entrant.** A migration interrupted by a closed tab must resolve correctly next load, never double-import.
3. **Failure is loud.** A failed migration surfaces an explicit error with the templates still in `localStorage` — never a silently empty library.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/db/migrate.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateIfNeeded } from './migrate';
import { listPlaybooks } from './playbooks';
import { getDb, closeDb } from './open';

const V1_KEY = 'lexprompt.templates.v2';

function seedV1(templates: unknown[]) {
  localStorage.setItem(V1_KEY, JSON.stringify(templates));
}

beforeEach(async () => {
  localStorage.clear();
  closeDb();
  indexedDB.deleteDatabase('lexprompt');
});

describe('migrateIfNeeded', () => {
  it('reports not-needed when there is nothing to migrate', async () => {
    expect((await migrateIfNeeded()).status).toBe('not-needed');
  });

  it('migrates v1 templates into playbooks', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [{ id: 'c1', title: 'Rent', prompt: 'p' }] }]);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('migrated');
    expect(result.count).toBe(1);
    expect((await listPlaybooks()).map(p => p.name)).toEqual(['Lease']);
  });

  it('LEAVES the localStorage source intact after migrating', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    await migrateIfNeeded();
    expect(localStorage.getItem(V1_KEY)).not.toBeNull();
  });

  it('is idempotent — running twice does not duplicate', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    await migrateIfNeeded();
    await migrateIfNeeded();
    expect((await listPlaybooks()).length).toBe(1);
  });

  it('resolves correctly after an interrupted run', async () => {
    seedV1([
      { id: 't1', name: 'A', clauses: [] },
      { id: 't2', name: 'B', clauses: [] },
    ]);
    // Simulate a half-done migration: t1 already present.
    const db = await getDb();
    await db.put('playbooks', { id: 't1', name: 'A', clauses: [] } as never);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('migrated');
    expect((await listPlaybooks()).length).toBe(2);
  });

  it('reports failure loudly and leaves localStorage intact', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    const db = await getDb();
    vi.spyOn(db, 'put').mockRejectedValueOnce(new Error('quota'));
    const result = await migrateIfNeeded();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/quota/i);
    expect(localStorage.getItem(V1_KEY)).not.toBeNull();
  });

  it('does not treat unparseable localStorage as "nothing to migrate"', async () => {
    localStorage.setItem(V1_KEY, '{corrupt');
    const result = await migrateIfNeeded();
    // Silently reporting not-needed would look like a clean install to a user
    // whose playbooks are sitting right there, unreadable.
    expect(result.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify they fail, then implement**

Mark completion with a flag in the `profile` store (or a dedicated key) so `not-needed` is determinable without re-reading everything. Migrate record-by-record so a partial failure still reports an accurate count.

- [ ] **Step 3: Mutation-test the two rules that matter**

Confirm the "leaves localStorage intact" test fails if you add a `removeItem`, and the idempotency test fails if you skip the already-present check.

- [ ] **Step 4: Run everything, commit**

```bash
npx tsc --noEmit && npm test
git add src/lib/db/migrate.ts src/lib/db/migrate.test.ts
git commit -m "feat: migrate v1 templates to IndexedDB playbooks, retaining the source"
```

---

### Task 6: Profile, matters, and cascade delete

**Files:**
- Create: `src/lib/db/profile.ts`, `src/lib/db/matters.ts`, and their tests

**Interfaces:**
- Produces:
```ts
getProfile(): Promise<UserProfile>          // creates a default on first call
saveProfile(p: UserProfile): Promise<void>
listMatters(): Promise<Matter[]>            // most recently updated first
getMatter(id: string): Promise<Matter | null>
saveMatter(m: Matter): Promise<Matter>
newMatter(name: string, ownerId: string): Matter
deleteMatter(id: string): Promise<void>     // cascades — see below
```

**`deleteMatter` must purge documents, blobs and reviews for that matter**, not just the matter record. The privacy note in the README depends on this being true (spec §4). Do it in a single transaction so a failure part-way cannot leave orphans.

- [ ] **Step 1: Write the failing tests**, including:

```ts
it('cascade-deletes documents, blobs and reviews', async () => {
  // ...seed a matter with 2 documents (with blobs) and 1 review...
  await deleteMatter(matterId);
  const db = await getDb();
  expect(await db.getAllFromIndex('documents', 'byMatter', matterId)).toEqual([]);
  expect(await db.getAllFromIndex('reviews', 'byMatter', matterId)).toEqual([]);
  expect(await db.get('blobs', docId1)).toBeUndefined();
  expect(await db.get('blobs', docId2)).toBeUndefined();
});

it('does not touch another matter\'s data', async () => { /* ... */ });
```

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat: add local profile and matters with cascade delete"
```

---

### Task 7: Documents and blobs

**Files:**
- Create: `src/lib/db/documents.ts`, `src/lib/db/blobs.ts`, and their tests
- Modify: `src/lib/documents.ts` — add a function producing a `DocumentRecord` + `Blob` pair from a `File`

**Interfaces:**
- Produces:
```ts
listDocuments(matterId: string): Promise<DocumentRecord[]>
getDocument(id: string): Promise<DocumentRecord | null>
addDocument(rec: DocumentRecord, bytes: Blob): Promise<void>   // one transaction
deleteDocument(id: string): Promise<void>                       // removes blob too
getDocumentBlob(id: string): Promise<Blob | null>
```

**Blobs live in their own store** so listing a matter's documents does not drag megabytes of PDF into memory to render a list of filenames.

**`addDocument` writes the record and its blob in one transaction.** A record without its bytes is a document that renders as permanently unavailable.

- [ ] **Step 1: Write the failing tests**, including a Blob round-trip (write, read, compare `size` and `type`), that `deleteDocument` removes both, and that a record whose blob is missing is *readable* — returning `null` bytes rather than throwing, so the UI can show "unavailable" with metadata intact (spec §9).

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat: persist documents and their original bytes"
```

---

### Task 8: Reviews

**Files:**
- Create: `src/lib/db/reviews.ts`, `src/lib/db/reviews.test.ts`

**Interfaces:**
- Produces:
```ts
listReviews(matterId: string): Promise<Review[]>   // most recent first
getReview(id: string): Promise<Review | null>
saveReview(r: Review): Promise<Review>
deleteReview(id: string): Promise<void>
```

**A review persists its `playbookSnapshot`**, carrying forward v1's discipline: editing a playbook afterwards must not retroactively change what a past review claims to have checked. Test that explicitly by mutating a nested clause after saving and asserting the snapshot is unchanged — v1 learned that a shallow-copy test passes while a shallow copy leaks.

**Saving during a run must not be per-cell.** `runReview`'s `onUpdate` fires twice per cell; a 3-document × 20-clause run is 120 writes. Persist on completion, on cancellation, and on a debounce of no less than 2 seconds during the run — enough that a crash loses seconds, not the run.

- [ ] **Step 1: Write the failing tests, implement, run, commit**

```bash
git commit -m "feat: persist reviews with a frozen playbook snapshot"
```

---

### Task 9: Routing

**Files:**
- Create: `src/lib/router.ts`, `src/lib/router.test.ts`

**Interfaces:**
- Produces:
```ts
type Route =
  | { name: 'matters' }
  | { name: 'matter'; matterId: string }
  | { name: 'review'; matterId: string; reviewId: string }
  | { name: 'playbooks' }
  | { name: 'playbook'; playbookId: string }
  | { name: 'settings' }
  | { name: 'not-found'; path: string };

parseRoute(pathname: string): Route
buildPath(route: Route): string
useRoute(): [Route, (route: Route) => void]
```

Use the History API. `firebase.json` already rewrites all paths to `index.html`. **Task 15's README must state that a static host without SPA fallback will 404 on refresh** — a failure that looks like a broken app.

Hand-rolled is fine. **If it exceeds ~100 lines, stop and use `wouter` 3.10.0 instead** — say which you chose and why in your report.

- [ ] **Step 1: Write failing tests** covering each route, a trailing slash, an unknown path yielding `not-found` (never a crash), and `buildPath(parseRoute(p)) === p` round-tripping for every valid route.

- [ ] **Step 2: Implement, run, commit**

```bash
git commit -m "feat: add URL routing for matters, reviews and playbooks"
```

---

### Task 10: Matters list screen

**Files:**
- Create: `src/features/matters/MattersList.tsx`
- Modify: `src/App.tsx`

The entry point. Each row: matter name, client, review count, last activity. Create via a modal (reuse `src/components/Modal.tsx`). Delete via the existing confirmation pattern, and **the confirmation must say that deleting removes the matter's documents** — because it does (Task 6), and a user should know before rather than after.

Empty state: "No matters yet. Create one to get started." — matching the library's existing wording.

Follow existing `src/components` conventions. The visual reskin is not in this sub-project.

- [ ] **Steps: build, wire the route, verify in a browser, commit**

---

### Task 11: Matter home screen

**Files:**
- Create: `src/features/matters/MatterHome.tsx`
- Modify: `src/App.tsx`

Two sections: **Documents** in this matter (name, kind, added date; add and remove) and **Reviews** in this matter (playbook name, date, progress or completion, a link back into the results). Plus "Run a review" which takes the existing run flow, scoped to this matter's documents.

A document with `parseError` shows as unreadable with its error, never silently absent. A review whose documents were deleted still opens, showing findings without the viewer and saying why (spec §9).

- [ ] **Steps: build, wire, verify in a browser, commit**

---

### Task 12: Move the existing screens under a matter

**Files:**
- Modify: `src/App.tsx`, `src/features/review/RunPanel.tsx`, `src/features/review/ResultsView.tsx`, `src/features/tabular/TabularReview.tsx`

v1's screens are session-scoped. Give them a matter context:
- `RunPanel` adds documents *to the current matter* and persists them (Task 7) rather than holding them in component state.
- Running a review creates a `Review` record (Task 8) and persists progress.
- `ResultsView` and `TabularReview` read a `Review` loaded from storage, so a completed review reopens from its URL.
- The playbook editor and library keep working against the new repository (Task 4).

**Do not change** `extractClause`, `runReview`, `PdfCanvas`, `citations.ts`, or anything under `features/assistant/`. This task moves data underneath them.

- [ ] **Steps: rewire, run the full suite, verify a complete round trip in a browser, commit**

---

### Task 13: Regenerating page images on demand

**Files:**
- Modify: `src/lib/documents.ts`, `src/features/review/PdfCanvas.tsx`

Page images are no longer persisted (R2). A scanned document loaded from storage has `text` but no `pageImages`, and the review path needs them.

Add a function that, given a document's stored `Blob`, re-derives page images with the same code that produced them at ingest. Call it when a review runs against a document whose text is below `SCAN_TEXT_THRESHOLD` and whose images are absent.

**Cache within the session** so a second review of the same document does not re-render. Do not persist the cache.

**Verify a scanned PDF still produces correct findings after a reload** — this is the one place R2's trade-off could bite, and it must be observed rather than assumed.

- [ ] **Steps: implement, test, verify in a browser against `test_docs/signed-counterpart-lease-unit-14-meadowview.pdf`, commit**

---

### Task 14: Migration on startup, and its failure surface

**Files:**
- Modify: `src/App.tsx`

Run `migrateIfNeeded()` once on startup, before the first render that could read playbooks.

- `not-needed` → proceed silently.
- `migrated` → proceed, with a toast naming the count.
- `failed` → **block with an explanatory screen**, stating that existing playbooks are safe in the browser's older storage and were not deleted, and offering a retry. Do not drop the user into an empty library — that is the exact "silently absent" failure this whole project is built against.

- [ ] **Steps: wire, test all three paths, commit**

---

### Task 15: Privacy note, README, and final verification

**Files:**
- Modify: `src/features/settings/SettingsPanel.tsx`, `README.md`

**The privacy statement is now false and must be corrected** (spec §4). v1 says documents are never persisted. They now are — in the visitor's own browser, in IndexedDB, never uploaded anywhere except to the chosen model via OpenRouter at run time. Deleting a matter deletes its documents and their bytes.

Update both the Settings note and the README, in plain language. Also add: the SPA-fallback hosting requirement (Task 9), and that data is per-browser, so clearing site data removes matters.

**Then run the spec's §11 definition of done, all eight checks, and report each honestly** — including check 7 (two tabs, one upgrading, produces an explanatory message rather than a hang), which needs two real browser tabs.

- [ ] **Steps: update, verify all eight, commit**

---

## Self-Review Notes

- **Spec §5.1's store table listed `settings`.** Ruling R6 removed it; Task 1's test asserts its absence so the deviation is pinned rather than forgotten.
- **Task 1 cannot typecheck alone** because it references types from Task 2. Flagged in-task and the two commit together.
- **Task 3's blocked-upgrade timeout** may be untestable under `fake-indexeddb`. The task says to report that honestly rather than write a vacuous test — this project has shipped several tests that could not detect their own bug, and one more would be worse than a documented gap.
- **Tasks 10–13 are lighter on literal code** than 1–9. They port and rewire existing, working components; specifying their markup line-by-line would make the plan longer without making it more correct. Their behavioural requirements are precise.
