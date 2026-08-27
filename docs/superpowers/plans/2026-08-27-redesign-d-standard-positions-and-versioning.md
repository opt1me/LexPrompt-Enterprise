# Redesign sub-project D — Standard positions and playbook versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a playbook clause the firm's own answer ("we ask for a 6-month break notice"), have every review say whether the document *meets*, *deviates* from, or is *unclear* against it, and make playbooks versioned so a review from four months ago still reads against the positions that actually produced it.

**Architecture:** `Playbook` splits into an identity record (id, name, `currentVersionId`, mutable `draft`) and immutable `PlaybookVersion` content records in a new IndexedDB store. Deviation evaluation rides along in the existing extraction call — no second model pass. Position health is derived at read time from verified findings, never stored. `Template.mode` retires: the presence of a standard position, not a flag, decides whether a clause is compared or merely extracted.

**Tech Stack:** React 19, TypeScript 5.8 (strict), Vite 6, Tailwind 4, Vitest 3 + jsdom, `fake-indexeddb`, `idb` 8, `docx` 9.

**Spec:** `docs/superpowers/specs/2026-08-27-redesign-d-standard-positions-and-versioning.md`

---

## Global Constraints

Copied verbatim from the spec and CLAUDE.md. Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** Prefer a loud, specific, recoverable failure over anything that could be mistaken for a successful empty result.
- **`unclear` is a first-class outcome, not a failure.** A missing or unrecognised outcome becomes `unclear`, **never `meets`**.
- **`deviates` without a rationale becomes `unclear`** with a note saying the model gave no reason.
- **A clause with no standard position gets no outcome at all** — absent, not `unclear`. "We have no house rule here" and "we have one and could not tell" are different facts.
- **A version is immutable once published.** Editing a published version is not offered; editing produces a new version.
- **Staleness is derived, never stored.** Only **verified** findings count toward position health.
- **A deviation is an observation, not a verdict** — still subject to B's human verification.
- **Repair, never drop.** Corrupt stored data is quarantined or repaired, never discarded. The migration never deletes its source.
- **Three chips is the limit.** State, risk, and position outcome are three separate questions. Never merge two.
- `SCHEMA_VERSION` 5 → **6**. `DB_VERSION` 2 → **3**.
- **Gates for every task:** `npx tsc --noEmit` clean, `npm test` green, `npm run build` clean with no externalization warning.
- **Mutation-test anything load-bearing.** Break the implementation, confirm the test fails, restore. A green suite is not evidence.
- **`toEqual` does not distinguish an absent key from an `undefined` one.** When *absence* is the assertion, write `expect('positionOutcome' in finding).toBe(false)`.
- **No `@testing-library/react`.** New component tests use `src/test/mount.tsx` (`mount`, `mountOnce`, `click`, `type`, `keyDown`).
- **Do not touch:** `src/lib/citations.ts`, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/verification.ts`, `src/lib/citationPage.ts`, `PdfCanvas`, `src/features/assistant/`.
- **Stage commits by name.** Never `git add -A` / `.` / `src` / `-u` — a previous task's fix agent swept four files belonging to a concurrent agent.

---

## Rulings made while writing this plan

Recorded here and to be copied into `docs/superpowers/redesign/rulings.md` by Task 13.

**R-D1 — After `mode` retires, the risk block is emitted when the clause has `riskCriteria` OR the version has `riskTolerance`.** Today `buildClausePrompt` gates it on `template.mode === 'risk'`. A migrated `mode: 'risk'` playbook retains `riskTolerance`, so it keeps emitting the block and produces the same review — spec §11's requirement. **But** an `extraction`-mode playbook may carry a stale non-empty `riskTolerance` string (the editor hides the field outside risk mode; it never clears it), which would silently gain risk criteria it never had. So **the migration clears `riskTolerance` on an `extraction`-mode playbook.** Cost if wrong: an extraction playbook loses a `riskTolerance` string that was never used in a prompt anyway.

**R-D2 — Position health is a pure function over findings the caller already loaded.** `positionHealth(publishedAt, findings)` takes an array; the editor supplies it by filtering `listReviews()` to reviews whose `playbookVersionId` belongs to this playbook. Keeps the derivation pure and testable and keeps the store read out of it. Cost if wrong: the editor does one broad review read it could have scoped.

**R-D3 — `extractCollectionClause` gains the same two fields, compared against the net position it synthesises.** The spec scopes evaluation to "the extraction call" and is silent on collections. Leaving it out would mean a user sets a position, runs a collection review, and gets no comparison and no explanation — exactly the "correct mechanism with no path to it" shape that produced seven separate defects in sub-project C. Cost if wrong: one extra prompt block and two extra schema fields on a path the spec did not require.

**R-D4 — `Review.playbookVersionId` is optional.** Spec §4 declares it required; §5 requires it absent for a review whose playbook was deleted. The constraint wins over the declaration — a required field would force the migration to invent an id. Cost if wrong: callers must handle `undefined`, which they must anyway for pre-D reviews.

**R-D5 — `Clause` is renamed to `PlaybookClause` with no back-compat alias.** A type alias left behind is exactly this project's "sibling drift" failure in slow motion. One mechanical sweep in Task 1, then the old name does not exist. Cost if wrong: a large but purely mechanical diff.

**R-D7 — The pre-D playbook conversion runs once at startup via `migrateIfNeeded`, never lazily from a read path.** An earlier draft of this plan had `listPlaybooks`/`getPlaybook` publish the migrated v1 on first read. That races: two concurrent reads both see no `currentVersionId`, both publish, and the playbook gets v1 *and* v2 holding identical content — in the sub-project whose whole purpose is making "which version did this review run against" answerable. `migrate.ts` already provides a durable-flag, startup-ordered, never-rejecting migration; D adds a **separately flagged** step to it, so a user already migrated by sub-project A still runs D's. Read paths stay pure. Cost if wrong: the conversion runs at startup instead of on demand, costing one pass over the playbook store on the first load after upgrade.

**R-D6 — `generateTemplate`'s wire schema keeps its `prompt` key; only the domain field is renamed.** `generateTemplate.ts:139` reads `generated.prompt` — that is the *model's* output field, described to the model in a JSON schema, not our domain type. Renaming it would change what the model is asked to produce, on a path whose output quality nothing in this plan tests. The rename stops at the boundary: the wire key stays `prompt` and is mapped to `extractPrompt` when the `PlaybookClause` is constructed. Cost if wrong: one field name is inconsistent between the wire format and the domain type, which is normal and is what a boundary is for.

---

## File Structure

**Create:**
- `src/lib/positionOutcome.ts` — the `meets | deviates | unclear` normaliser. Pure. The only place the `unclear` defaults live.
- `src/lib/positionOutcome.test.ts`
- `src/lib/positionHealth.ts` — `held | conceded | untested | no-position` derivation. Pure, verified-findings-only.
- `src/lib/positionHealth.test.ts`
- `src/lib/db/playbookVersions.ts` — the immutable version store.
- `src/lib/db/playbookVersions.test.ts`
- `src/lib/db/playbookMigration.ts` — pre-D playbook → identity + one published v1.
- `src/lib/db/playbookMigration.test.ts`
- `src/components/PositionChip.tsx` — third chip, alongside `StateChip` and `RiskChip`.
- `src/components/PositionChip.test.tsx`
- `src/features/review/PositionComparison.tsx` — "we ask for" vs "this lease says".
- `src/features/review/PositionComparison.test.tsx`
- `src/features/templates/StandardPositionField.tsx` — the per-clause editor field with its provenance line.
- `src/features/templates/StandardPositionField.test.tsx`
- `src/features/templates/VersionHistory.tsx` — the timeline.
- `src/features/templates/VersionHistory.test.tsx`
- `src/features/templates/PublishDialog.tsx` — change-summary-required publish.
- `src/features/templates/PublishDialog.test.tsx`

**Modify:**
- `src/types.ts` — `StandardPosition`, `PositionOrigin`, `PlaybookClause`, `PlaybookVersion`, `Playbook` reshape, `Finding` +2 fields, `Review.playbookVersionId`, `SCHEMA_VERSION` → 6, `mode` removed.
- `src/lib/db/schema.ts` — `DB_VERSION` → 3, `playbookVersions` store + `byPlaybook` index.
- `src/lib/db/open.ts` — one more `if (!contains)` block in `upgrade`.
- `src/lib/db/playbooks.ts` — identity-record repository; version content moves out.
- `src/lib/db/reviewMigration.ts` — `playbookVersionId` back-fill.
- `src/lib/db/reviews.ts` — record `playbookVersionId` on save.
- `src/features/review/extractClause.ts` — schema + prompt + normaliser wiring; `mode` gate replaced.
- `src/features/review/extractCollectionClause.ts` — same, against the net position (R-D3).
- `src/features/review/FindingCard.tsx` — the comparison block above the evidence.
- `src/features/templates/TemplateEditor.tsx` — position field, draft/publish, mode toggle removed.
- `src/features/templates/CreateTemplateDialog.tsx`, `generateTemplate.ts`, `buildMegaPrompt.ts`, `MegaPromptModal.tsx` — rename + mode removal.
- `src/lib/findingOutcome.ts` — `positionOutcomeLabel`, `positionRationaleLines`.
- `src/features/tabular/csv.ts`, `src/features/review/exportDocx.ts` — carry them.
- `src/features/tabular/TabularReview.tsx` — `deviates` count chip.
- `src/App.tsx` — plumbing.
- `README.md`, `CLAUDE.md`, `docs/superpowers/redesign/rulings.md`.

---

## Task 1: Types and the `extractPrompt` rename

Purely mechanical, no behaviour change. The suite must be green at the end with **no test assertions changed except the field name**. Nothing in this task touches `mode`, versioning, or migration.

**Files:**
- Modify: `src/types.ts`
- Modify: every file referencing `Clause` or `clause.prompt` — find them with `grep -rn "clause\.prompt\|\bClause\b" src/`
- Modify: `src/lib/db/playbooks.ts` (`migrateClause`, around line 44)

**Interfaces:**
- Consumes: nothing.
- Produces: `PositionOrigin`, `StandardPosition`, `PlaybookClause` (with `extractPrompt: string`). `Clause` no longer exists.

- [ ] **Step 1: Add the new types to `src/types.ts`**

Replace the `Clause` interface with:

```ts
export type PositionOrigin = 'authored' | 'ai-drafted' | 'learned';

/** The firm's own answer to a clause — "we ask for a 6-month break notice,
 *  no conditions." Its presence is what turns a finding from a summary into
 *  a comparison; `Template.mode` used to decide that and no longer exists. */
export interface StandardPosition {
  text: string;
  origin: PositionOrigin;
  /** True once a human has read and accepted it. An AI-drafted position
   *  nobody has read is not the firm's position — it is a suggestion, and
   *  the editor says so. */
  reviewedByHuman: boolean;
  /** Free text naming where it came from ("Commercial Lease — Tenant v4",
   *  "6 redlines across 4 documents"). Presentational; nothing resolves it. */
  provenance?: string;
}

export interface PlaybookClause {
  id: string;
  title: string;
  /** Was `Clause.prompt`. Renamed because a clause now carries more than one
   *  prompt-shaped field. */
  extractPrompt: string;
  riskCriteria?: string;
  standardPosition?: StandardPosition;
}
```

Change `Template.clauses` to `PlaybookClause[]`.

- [ ] **Step 2: Make `migrateClause` read both names, write only the new one**

In `src/lib/db/playbooks.ts`:

```ts
function migrateClause(input: unknown): PlaybookClause {
  const c = (input ?? {}) as Partial<PlaybookClause> & { prompt?: unknown };
  // Both names are read on migration; only the new one is written (spec §5).
  // A pre-D record has `prompt`; anything already migrated has
  // `extractPrompt`. Reading both is what makes this idempotent.
  const extractPrompt =
    typeof c.extractPrompt === 'string' ? c.extractPrompt :
    typeof c.prompt === 'string' ? c.prompt : '';
  return {
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    title: typeof c.title === 'string' ? c.title : 'Untitled clause',
    extractPrompt,
    riskCriteria: typeof c.riskCriteria === 'string' ? c.riskCriteria : undefined,
    standardPosition: migratePosition(c.standardPosition),
  };
}

/** A position that cannot be read is dropped rather than repaired to an
 *  empty one: an empty-text position would render as "we ask for: (nothing)"
 *  and would make a clause claim a house rule it does not have. Absent is
 *  the honest answer, and it is the same answer a clause that never had a
 *  position gives. */
function migratePosition(input: unknown): StandardPosition | undefined {
  const p = (input ?? {}) as Partial<StandardPosition>;
  if (typeof p.text !== 'string' || p.text.trim() === '') return undefined;
  const origin: PositionOrigin =
    p.origin === 'ai-drafted' || p.origin === 'learned' ? p.origin : 'authored';
  return {
    text: p.text,
    origin,
    // Unreadable provenance defaults to NOT reviewed. Same reasoning as
    // `readStatus` in sub-project B: the safe default is the one that
    // prompts a human to look.
    reviewedByHuman: p.reviewedByHuman === true,
    provenance: typeof p.provenance === 'string' ? p.provenance : undefined,
  };
}
```

- [ ] **Step 3: Write the failing test for the dual read**

Append to `src/lib/db/playbooks.test.ts` — **read that file first** and match its existing import style, DB reset and helpers rather than inventing new ones.

```ts
it('reads a pre-D clause `prompt` into `extractPrompt`', async () => {
  await savePlaybook({ ...newPlaybook('legacy'), id: 'pb-legacy',
    clauses: [{ id: 'c1', title: 'Break', prompt: 'Find the break clause' } as never] });
  const got = await getPlaybook('pb-legacy');
  expect(got!.clauses[0].extractPrompt).toBe('Find the break clause');
  expect('prompt' in got!.clauses[0]).toBe(false);
});

it('drops an empty-text standard position rather than repairing it to empty', async () => {
  await savePlaybook({ ...newPlaybook('p'), id: 'pb-empty',
    clauses: [{ id: 'c1', title: 'T', extractPrompt: 'x',
      standardPosition: { text: '   ', origin: 'authored', reviewedByHuman: true } }] });
  const got = await getPlaybook('pb-empty');
  expect('standardPosition' in got!.clauses[0]).toBe(false);
});

it('defaults an unreadable reviewedByHuman to false, never true', async () => {
  await savePlaybook({ ...newPlaybook('p'), id: 'pb-rev',
    clauses: [{ id: 'c1', title: 'T', extractPrompt: 'x',
      standardPosition: { text: 'We ask for 6 months', origin: 'nonsense',
        reviewedByHuman: 'yes' } as never }] });
  const got = await getPlaybook('pb-rev');
  expect(got!.clauses[0].standardPosition).toEqual({
    text: 'We ask for 6 months', origin: 'authored', reviewedByHuman: false, provenance: undefined,
  });
});
```

- [ ] **Step 4: Run it, confirm it fails**

Run: `npx vitest run src/lib/db/playbooks.test.ts`
Expected: FAIL — `extractPrompt` is `undefined` before Step 2's edit lands, or `migratePosition` is not defined.

- [ ] **Step 5: Sweep every call site**

These were enumerated against the tree at plan time, not from memory. Verify with `grep -rln "\bClause\b" src/` before you start; if the list differs, trust the tree.

**20 files reference the `Clause` type** — rename each to `PlaybookClause`:

```
src/types.ts                                    src/features/review/FindingCard.tsx
src/lib/db/playbooks.ts                         src/features/review/FindingCard.test.tsx
src/lib/collectionPrompt.ts                     src/features/review/ResultsView.tsx
src/lib/collectionPrompt.test.ts                src/features/tabular/CellDetail.tsx
src/features/review/extractClause.ts            src/features/tabular/csv.test.ts
src/features/review/extractClause.test.ts       src/features/templates/buildMegaPrompt.ts
src/features/review/extractCollectionClause.ts  src/features/templates/generateTemplate.ts
src/features/review/extractCollectionClause.test.ts  src/features/templates/generateTemplate.test.ts
src/features/assistant/draftEmail.ts            src/features/templates/TemplateEditor.tsx
src/features/assistant/suggestRevision.ts       src/features/assistant/RevisionModal.tsx
```

Note the three `src/features/assistant/` files. That directory is on the **do-not-touch** list for behaviour — a type rename is not a behaviour change and is required for the build, so rename the type there and change nothing else in those files.

**Exactly 6 non-test sites read or write the clause's `prompt` field:**

```
src/features/review/extractClause.ts:71     INSTRUCTION: ${clause.prompt}
src/lib/collectionPrompt.ts:152             INSTRUCTION: ${clause.prompt}
src/features/templates/buildMegaPrompt.ts:16    - Instruction: ${c.prompt}
src/features/templates/buildMegaPrompt.ts:53    instruction: c.prompt
src/features/templates/TemplateEditor.tsx:136   value={clause.prompt}
src/lib/db/playbooks.ts:46                  prompt: typeof c.prompt === 'string' ...
```

**Two traps. A blind `sed s/\.prompt/\.extractPrompt/` breaks both:**

1. **`src/lib/openrouter.ts:358,392`** contain `pricing.prompt` and `promptPrice`. Unrelated to clauses, and that file is on the **do-not-touch** list. Leave it entirely alone.
2. **`src/features/templates/generateTemplate.ts:139`** is `prompt: generated.prompt` — the left side is ours, the right side is the **model's** output field, described to the model in a JSON schema. Per **R-D6** the wire key stays `prompt`; only the left side becomes `extractPrompt`. Do not rename the field in the generation schema or in the prompt text that asks for it.

**26 test files** contain `prompt:` in fixtures; `generateTemplate.test.ts` (11), `runReview.test.ts` (6) and `reviews.test.ts` (6) are the heaviest. Most are `Clause` literals that simply need the key renamed — but check each, because `generateTemplate.test.ts`'s are largely wire-format fixtures that must keep `prompt` per R-D6.

- [ ] **Step 6: Run the gates**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 0 type errors, all tests pass, build clean with no externalization warning.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/lib/db/playbooks.ts src/lib/db/playbooks.test.ts <every file the sweep touched, by name>
git show --stat HEAD
git commit -m "refactor: rename Clause to PlaybookClause and prompt to extractPrompt"
```

(`git show --stat HEAD` runs *after* the commit to verify nothing unrelated was swept in. If it shows a file you did not touch, `git reset --soft HEAD~1` and re-stage by name.)

---

## Task 2: The immutable `PlaybookVersion` store

**Files:**
- Modify: `src/types.ts`, `src/lib/db/schema.ts`, `src/lib/db/open.ts`
- Create: `src/lib/db/playbookVersions.ts`, `src/lib/db/playbookVersions.test.ts`

**Interfaces:**
- Consumes: `PlaybookClause` (Task 1).
- Produces: `PlaybookVersion`, `PlaybookDraft`, `Playbook` (reshaped), `publishVersion(playbookId, draft, byUserId): Promise<PlaybookVersion>`, `getVersion(id): Promise<PlaybookVersion | null>`, `listVersions(playbookId): Promise<PlaybookVersion[]>` (newest first).

- [ ] **Step 1: Add the types**

In `src/types.ts`, replacing `export type Playbook = Template`:

```ts
/** The content of a playbook at one published moment. Immutable: nothing
 *  overwrites a version once published, because a review that says "ran
 *  against v4" has to be able to prove what v4 was. */
export interface PlaybookVersion {
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
  schemaVersion: number;
}

/** The mutable working copy: a version's content minus everything only a
 *  publish can assign. */
export type PlaybookDraft =
  Omit<PlaybookVersion, 'id' | 'playbookId' | 'version' | 'publishedAt' | 'publishedByUserId' | 'schemaVersion'>;

```

**Do NOT reshape `Playbook` in this task.** Leave `export type Playbook = Template` exactly as it is, and leave `Template` alone.

This matters for a concrete reason rather than tidiness: `src/lib/db/playbooks.ts` implements the *old* `Playbook` shape (`contractType`, `systemPrompt`, `clauses`, …) and **Task 3 is what rewrites it**. Reshaping the type here would break that file's compilation, and this task's own gate is `npx tsc --noEmit` clean — so Task 2 could not pass its own gate. `publishVersion` needs only `PlaybookDraft` and `PlaybookVersion`, both of which are new names that collide with nothing.

The identity reshape belongs to Task 3, together with the repository rewrite that satisfies it:

```ts
/** Task 3 adds this, not Task 2. A playbook's identity; its content lives
 *  in `PlaybookVersion` records. */
export interface Playbook {
  id: string;
  /** Mirrors the current version's name, for listing without a second read. */
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Absent until the first publish. */
  currentVersionId?: string;
  /** Present when there are unpublished edits. */
  draft?: PlaybookDraft;
  schemaVersion: number;
}
```

- [ ] **Step 2: Bump the DB and add the store**

`src/lib/db/schema.ts`: `DB_VERSION = 3`; add `playbookVersions: 'playbookVersions'` to `STORES`; add to `LexPromptDB`:

```ts
  playbookVersions: {
    key: string;
    value: import('../../types').PlaybookVersion;
    indexes: { byPlaybook: string };
  };
```

`src/lib/db/open.ts`, inside `upgrade(db)`, following the existing `if (!contains)` idiom exactly:

```ts
        if (!db.objectStoreNames.contains(STORES.playbookVersions)) {
          const s = db.createObjectStore(STORES.playbookVersions, { keyPath: 'id' });
          s.createIndex('byPlaybook', 'playbookId');
        }
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/db/playbookVersions.test.ts`. **Read `src/lib/db/collections.test.ts` first** and copy its `fake-indexeddb` setup and DB reset verbatim rather than inventing one.

Write a local `draft(overrides)` helper returning a complete `PlaybookDraft`.

```ts
it('assigns monotonic version numbers per playbook', async () => {
  const v1 = await publishVersion('pb1', draft({ changeSummary: '' }), 'u1');
  const v2 = await publishVersion('pb1', draft({ changeSummary: 'added break clause' }), 'u1');
  const other = await publishVersion('pb2', draft({ changeSummary: '' }), 'u1');
  expect(v1.version).toBe(1);
  expect(v2.version).toBe(2);
  expect(other.version).toBe(1); // per playbook, not per store
});

it('refuses a change summary that is missing after v1', async () => {
  await publishVersion('pb1', draft({ changeSummary: '' }), 'u1');
  await expect(publishVersion('pb1', draft({ changeSummary: '  ' }), 'u1'))
    .rejects.toThrow(/change summary/i);
});

it('allows an empty change summary on v1 only', async () => {
  const v1 = await publishVersion('pb1', draft({ changeSummary: '' }), 'u1');
  expect(v1.changeSummary).toBe('');
});

it('never overwrites a published version', async () => {
  const v1 = await publishVersion('pb1', draft({ name: 'original' }), 'u1');
  await publishVersion('pb1', draft({ name: 'later', changeSummary: 'renamed' }), 'u1');
  const reread = await getVersion(v1.id);
  expect(reread!.name).toBe('original');
  expect(reread!.version).toBe(1);
});

it('lists versions newest first', async () => {
  await publishVersion('pb1', draft({}), 'u1');
  await publishVersion('pb1', draft({ changeSummary: 'b' }), 'u1');
  await publishVersion('pb1', draft({ changeSummary: 'c' }), 'u1');
  const got = await listVersions('pb1');
  expect(got.map(v => v.version)).toEqual([3, 2, 1]);
});

it('two concurrent publishes do not collide on a version number', async () => {
  await publishVersion('pb1', draft({}), 'u1');
  const [a, b] = await Promise.all([
    publishVersion('pb1', draft({ changeSummary: 'a' }), 'u1'),
    publishVersion('pb1', draft({ changeSummary: 'b' }), 'u1'),
  ]);
  expect(new Set([a.version, b.version]).size).toBe(2);
});
```

- [ ] **Step 4: Run, confirm failure**

Run: `npx vitest run src/lib/db/playbookVersions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

Create `src/lib/db/playbookVersions.ts`:

```ts
import { getDb } from './open';
import { STORES } from './schema';
import { SCHEMA_VERSION, type PlaybookDraft, type PlaybookVersion } from '../../types';
import { uid } from '../uid';

const STORAGE_FULL_MESSAGE =
  'Could not save — your browser storage is full. Try deleting an old playbook, or exporting and removing some data.';

/**
 * Freezes a draft into an immutable published version.
 *
 * The read of the current max version number and the write of the new
 * record share ONE readwrite transaction — the same discipline
 * `playbooks.ts`'s `savePlaybook` uses for `_seq`, and for the same reason:
 * two concurrent publishes must not both read the same max before either
 * has written. `matters.ts` once reproduced that allocation *without* the
 * transaction scoping while claiming in its docstring to mirror it, which
 * is this project's canonical sibling-drift defect. Nothing non-IDB is
 * awaited between the index read and the put, which is what keeps
 * IndexedDB from auto-committing the transaction early.
 *
 * A version id is minted fresh on every call and never reused, so a `put`
 * can never land on an existing version — immutability is a property of how
 * ids are allocated, not a check that could be forgotten.
 */
export async function publishVersion(
  playbookId: string,
  draft: PlaybookDraft,
  byUserId: string,
): Promise<PlaybookVersion> {
  const db = await getDb();
  try {
    const tx = db.transaction(STORES.playbookVersions, 'readwrite');
    const existing = await tx.store.index('byPlaybook').getAll(playbookId);
    const nextVersion = existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;

    // A version history whose entries do not say what changed is a list of
    // dates (spec §4). v1 is exempt: there is no previous version for it to
    // have changed from.
    const summary = draft.changeSummary?.trim() ?? '';
    if (nextVersion > 1 && summary === '') {
      throw new Error('A change summary is required when publishing a new version.');
    }

    const record: PlaybookVersion = {
      ...draft,
      changeSummary: summary,
      id: uid(),
      playbookId,
      version: nextVersion,
      publishedAt: Date.now(),
      publishedByUserId: byUserId,
      schemaVersion: SCHEMA_VERSION,
    };
    await tx.store.put(record);
    await tx.done;
    return record;
  } catch (error) {
    // The change-summary rejection is a caller error, not a storage failure
    // — rethrowing it as "storage is full" would send the user off to delete
    // data to fix a missing text field.
    if (error instanceof Error && /change summary/i.test(error.message)) throw error;
    throw new Error(STORAGE_FULL_MESSAGE);
  }
}

export async function getVersion(id: string): Promise<PlaybookVersion | null> {
  const db = await getDb();
  return (await db.get(STORES.playbookVersions, id)) ?? null;
}

/** Newest first. */
export async function listVersions(playbookId: string): Promise<PlaybookVersion[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex(STORES.playbookVersions, 'byPlaybook', playbookId);
  return all.sort((a, b) => b.version - a.version);
}
```

- [ ] **Step 6: Run, confirm pass, then mutation-test**

Run: `npx vitest run src/lib/db/playbookVersions.test.ts` — expect PASS.

- Mutation A: change `nextVersion > 1` to `nextVersion > 2`. Expect "refuses a change summary that is missing after v1" to FAIL. Restore.
- Mutation B: replace the transaction with two separate `db.getAllFromIndex` / `db.put` calls. Expect the concurrent-publish test to FAIL. Restore.
- Mutation C: change `id: uid()` to `` id: `${playbookId}-v${nextVersion}` `` and drop the increment so a republish reuses an id. Expect "never overwrites a published version" to FAIL. Restore.

Record each mutation's observed failure in the report. **A mutation that does not produce a failure means the test proves nothing — say so rather than moving on.**

- [ ] **Step 7: Run the gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/types.ts src/lib/db/schema.ts src/lib/db/open.ts src/lib/db/playbookVersions.ts src/lib/db/playbookVersions.test.ts
git commit -m "feat: immutable playbook versions in their own store"
git show --stat HEAD
```

---

## Task 3: Playbook migration and the retirement of `mode`

The most invasive migration since sub-project A, and it touches playbooks the user already owns. Spec §11: the largest share of the test effort belongs here.

**Files:**
- Create: `src/lib/db/playbookMigration.ts`, `src/lib/db/playbookMigration.test.ts`
- Modify: `src/lib/db/playbooks.ts`, `src/lib/db/reviewMigration.ts`, `src/types.ts` (remove `Template` and `mode`)

**Interfaces:**
- Consumes: `publishVersion` (Task 2), `PlaybookDraft`, `PlaybookVersion`.
- Produces: the reshaped **`Playbook`** identity interface (moved here from Task 2 — see that task's Step 1 for the exact shape and why it could not live there), `migratePlaybookRecord(raw: unknown): { playbook: Playbook; version: PlaybookDraft | null }`, `IMPORTED_SUMMARY`, `migrateDraft`, `migrateClause`, `migratePosition`, and `listPlaybooks`/`getPlaybook` returning the reshaped `Playbook`.
- **This task defines `Playbook` and rewrites `db/playbooks.ts` in the same commit.** They cannot be split: the type and its only implementation must change together or neither compiles.

- [ ] **Step 1: Write the failing tests first**

Create `src/lib/db/playbookMigration.test.ts`. Copy the DB setup from `src/lib/db/reviewMigration.test.ts` verbatim.

```ts
const preD = {
  id: 'pb1', name: 'Commercial Lease', contractType: 'Lease',
  mode: 'risk', systemPrompt: 'sys', formatPrompt: 'fmt',
  riskTolerance: 'We are risk-averse on uncapped liability.',
  clauses: [{ id: 'c1', title: 'Break', prompt: 'Find the break clause', riskCriteria: 'Must be unconditional' }],
  createdAt: 1000, updatedAt: 2000, schemaVersion: 2,
};

it('turns a pre-D playbook into an identity plus one published v1', () => {
  const { playbook, version } = migratePlaybookRecord(preD);
  expect(playbook.id).toBe('pb1');
  expect(playbook.name).toBe('Commercial Lease');
  expect(version!.changeSummary).toBe('Imported from before versioning.');
  expect(version!.clauses[0].extractPrompt).toBe('Find the break clause');
});

it('retains riskTolerance for a risk-mode playbook so it reviews identically', () => {
  const { version } = migratePlaybookRecord(preD);
  expect(version!.riskTolerance).toBe('We are risk-averse on uncapped liability.');
  expect(version!.clauses[0].riskCriteria).toBe('Must be unconditional');
});

it('clears a stale riskTolerance on an extraction-mode playbook (R-D1)', () => {
  const { version } = migratePlaybookRecord({ ...preD, mode: 'extraction' });
  // The editor hides the field outside risk mode but never clears it, so a
  // leftover string would silently start emitting risk criteria that this
  // playbook's reviews never had.
  expect(version!.riskTolerance).toBeUndefined();
});

it('invents no standard position from a risk tolerance', () => {
  const { version } = migratePlaybookRecord(preD);
  expect('standardPosition' in version!.clauses[0]).toBe(false);
});

it('drops the mode flag entirely', () => {
  const { playbook, version } = migratePlaybookRecord(preD);
  expect('mode' in playbook).toBe(false);
  expect('mode' in version!).toBe(false);
});

it('is idempotent — a migrated playbook migrates to itself with no new version', () => {
  const alreadyMigrated = {
    id: 'pb1', name: 'X', createdAt: 1, updatedAt: 2,
    currentVersionId: 'v-abc', schemaVersion: 6,
  };
  const { playbook, version } = migratePlaybookRecord(alreadyMigrated);
  expect(version).toBeNull();
  expect(playbook.currentVersionId).toBe('v-abc');
});

it('repairs a malformed record rather than dropping it', () => {
  const { playbook, version } = migratePlaybookRecord({ clauses: 'not an array' });
  expect(playbook.id).toBeTruthy();
  expect(playbook.name).toBe('Untitled playbook');
  expect(version!.clauses).toEqual([]);
});

it('repairs null without throwing', () => {
  expect(() => migratePlaybookRecord(null)).not.toThrow();
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/db/playbookMigration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `playbookMigration.ts`**

```ts
import { SCHEMA_VERSION, type Playbook, type PlaybookClause, type PlaybookDraft,
  type PositionOrigin, type StandardPosition } from '../../types';
import { uid } from '../uid';

export const IMPORTED_SUMMARY = 'Imported from before versioning.';

/**
 * Brings a playbook record of any earlier shape up to D's identity+versions
 * split. Returns the identity record and, when the input was a pre-D
 * content-carrying record, the draft that should be published as its v1.
 *
 * Repair, never drop (sub-project A): a record that cannot be fully read is
 * repaired to a sane default, and the source is never deleted. A `version`
 * of `null` means "already migrated" — publishing another v1 for it would
 * duplicate the user's history on every app start, which is what makes the
 * idempotency test load-bearing rather than decorative.
 */
export function migratePlaybookRecord(
  input: unknown,
): { playbook: Playbook; version: PlaybookDraft | null } {
  const t = (input ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const id = typeof t.id === 'string' && t.id ? t.id : uid();
  const name = typeof t.name === 'string' && t.name ? t.name : 'Untitled playbook';
  const createdAt = typeof t.createdAt === 'number' ? t.createdAt : now;
  const updatedAt = typeof t.updatedAt === 'number' ? t.updatedAt : now;

  const playbook: Playbook = {
    id, name, createdAt, updatedAt,
    schemaVersion: SCHEMA_VERSION,
    ...(typeof t.currentVersionId === 'string' ? { currentVersionId: t.currentVersionId } : {}),
    ...(t.draft && typeof t.draft === 'object' ? { draft: migrateDraft(t.draft, name) } : {}),
  };

  // Already migrated: it has a version pointer, so its content lives in the
  // versions store and there is nothing here to publish.
  if (playbook.currentVersionId) return { playbook, version: null };

  return { playbook, version: migrateDraft(t, name) };
}

export function migrateDraft(input: unknown, fallbackName: string): PlaybookDraft {
  const t = (input ?? {}) as Record<string, unknown>;
  // R-D1: `mode: 'risk'` keeps its risk tolerance so the migrated playbook
  // emits the same RISK CRITERIA block and produces the same review it does
  // today. `mode: 'extraction'` clears it: the editor hides the field
  // outside risk mode but never clears it, so a leftover string would make
  // an extraction playbook start emitting criteria it never had. A missing
  // mode is treated as extraction, matching the pre-D default.
  const wasRisk = t.mode === 'risk';
  const riskTolerance =
    wasRisk && typeof t.riskTolerance === 'string' && t.riskTolerance.trim() !== ''
      ? t.riskTolerance
      : undefined;

  return {
    name: typeof t.name === 'string' && t.name ? t.name : fallbackName,
    contractType: typeof t.contractType === 'string' ? t.contractType : 'Custom',
    systemPrompt: typeof t.systemPrompt === 'string' ? t.systemPrompt : '',
    formatPrompt: typeof t.formatPrompt === 'string' ? t.formatPrompt : '',
    riskTolerance,
    clauses: Array.isArray(t.clauses) ? t.clauses.map(migrateClause) : [],
    changeSummary: typeof t.changeSummary === 'string' && t.changeSummary
      ? t.changeSummary
      : IMPORTED_SUMMARY,
  };
}
```

**Move `migrateClause` and `migratePosition` here** from `playbooks.ts` (Task 1 put them there) and export them; `playbooks.ts` imports them from this module. Two copies of clause repair is exactly the sibling drift CLAUDE.md names.

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run src/lib/db/playbookMigration.test.ts` — expect PASS.

- [ ] **Step 5: Run the conversion ONCE at startup — never from a read path (R-D7)**

An earlier draft of this plan said to publish the migrated v1 lazily from `listPlaybooks`/`getPlaybook`, "mirroring how `reviewMigration.ts` is invoked". **That was wrong, and it would have corrupted the user's own version history.** `reviewMigration` is a *pure repair applied on read that writes nothing*; publishing a version is a write. A read path that writes races itself: two components calling `listPlaybooks()` on the same tick both see no `currentVersionId`, both call `publishVersion`, and the playbook ends up with **v1 and v2 holding identical content** — in the one sub-project whose entire purpose is making "which version did this review run against" answerable.

Use the mechanism that already exists for exactly this. `src/lib/db/migrate.ts` has `migrateIfNeeded()`: a one-time, startup-ordered migration guarded by a **durable flag** in IndexedDB (`readFlag`/`writeFlag`), which already reports failure by returning `{ status: 'failed' }` rather than rejecting. Read it in full before writing anything.

Two facts verified against the code before this was written, so build on them rather than re-deriving them:

- `migrateIfNeeded()` is awaited **once at App startup, before `AppShell` renders** (`src/App.tsx:2237`). It therefore runs before anything can read a playbook, which is precisely the ordering this needs.
- Its flag is a **keyed** record in the `profile` store — `MIGRATION_FLAG_KEY = 'migration:v1-templates'` (`migrate.ts:15`). The `migration:<name>` convention already anticipates more than one, so add:

```ts
const PLAYBOOK_VERSIONS_FLAG_KEY = 'migration:d-playbook-versions';
```

Add a second, **separately flagged** step to it — do not reuse the v1-localStorage flag, or a user who migrated in sub-project A will skip this one entirely:

```ts
/** D: convert every pre-D playbook into an identity record plus one
 *  published v1. Separately flagged from the v1-localStorage migration —
 *  a user already migrated by sub-project A must still run this. */
async function migratePlaybooksToVersions(db: IDBPDatabase<LexPromptDB>): Promise<number>
```

For each stored playbook, run the pure `migratePlaybookRecord`; where it returns a non-null draft, `publishVersion` it and write the identity record back with `currentVersionId` set. Follow `migrateIfNeeded`'s existing contract exactly: never reject, count what was converted, and report a partial count from a mid-loop failure.

`listPlaybooks`/`getPlaybook` then stay **pure reads**. They still call `migratePlaybookRecord` defensively — a record can always be malformed — but they never write, so calling them twice concurrently is harmless.

Requirements this adds to Step 1's tests:

```ts
it('converts a pre-D playbook exactly once, even if the migration runs twice', async () => {
  await savePlaybookRaw(preD);
  await migrateIfNeeded();
  await migrateIfNeeded();
  expect((await listVersions('pb1')).map(v => v.version)).toEqual([1]);
});

it('does not skip D\'s conversion for a user already migrated by sub-project A', async () => {
  // Sub-project A's flag is set; D's is not. The playbook must still convert.
  await writeV1Flag(db, 0);
  await savePlaybookRaw(preD);
  await migrateIfNeeded();
  expect((await getPlaybook('pb1'))!.currentVersionId).toBeTruthy();
});

it('two concurrent listPlaybooks calls publish nothing', async () => {
  // The read path must not write at all — this is the race the lazy design
  // would have lost.
  await savePlaybookRaw(preD);
  await Promise.all([listPlaybooks(), listPlaybooks()]);
  expect(await listVersions('pb1')).toEqual([]);
});
```

Mutation-test the first and third: make the conversion unflagged (expect duplicate v1/v2), and make `getPlaybook` publish lazily (expect the concurrency test to fail).

Add:
- `getPlaybookContent(playbookId): Promise<PlaybookVersion | null>` — the current version.
- `saveDraft(playbookId, draft: PlaybookDraft): Promise<void>`.

Preserve `_seq` handling exactly as it is — it still breaks same-millisecond ties on the identity records.

- [ ] **Step 6: Remove `Template` and `mode`**

Delete `export interface Template` and `export const TEMPLATE_SCHEMA_VERSION` from `src/types.ts` if nothing outside playbooks uses them; otherwise replace each `Template` type reference with `PlaybookVersion`. Run `grep -rn "Template\b" src/` to find them all — note `TemplateEditor`, `TemplateLibrary`, `CreateTemplateDialog` and `generateTemplate` are *file* names, which this task does **not** rename.

`Review.playbookSnapshot` becomes `PlaybookVersion`. Update `reviewMigration.ts` to repair a pre-D snapshot through the exported `migrateDraft`.

- [ ] **Step 7: Mutation-test the migration**

- Mutation A: make `migrateDraft` retain `riskTolerance` unconditionally. Expect "clears a stale riskTolerance" to FAIL. Restore.
- Mutation B: remove the `if (playbook.currentVersionId) return { …, version: null }` early return. Expect the idempotency test to FAIL. Restore.
- Mutation C: make `migratePosition` return `{ text: '', origin: 'authored', reviewedByHuman: true }` for unreadable input. Expect Task 1's "drops an empty-text standard position" to FAIL. Restore.

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/lib/db/playbookMigration.ts src/lib/db/playbookMigration.test.ts src/lib/db/playbooks.ts src/lib/db/playbooks.test.ts src/types.ts src/lib/db/reviewMigration.ts <other files by name>
git commit -m "feat: migrate pre-D playbooks to versioned form and retire mode"
git show --stat HEAD
```

---

## Task 4: A review records the version it ran against

**Files:**
- Modify: `src/types.ts`, `src/lib/db/reviews.ts`, `src/lib/db/reviewMigration.ts`, `src/App.tsx`
- Modify: `src/lib/db/reviewMigration.test.ts`, `src/lib/db/reviews.test.ts`

**Interfaces:**
- Consumes: `listVersions` (Task 2), `IMPORTED_SUMMARY` (Task 3).
- Produces: `Review.playbookVersionId?: string`; `migrateReviewRecord` gains a `versionIndex` parameter.

- [ ] **Step 1: Add the field**

In `src/types.ts`, on `Review`:

```ts
  /** The playbook version this review ran against. Optional (R-D4): a review
   *  whose playbook was deleted before D has no version to point at, and a
   *  required field would force the migration to invent one.
   *  `playbookSnapshot` remains what makes such a review readable at all;
   *  this id is what lets the app show "ran against v4" and link to it. */
  playbookVersionId?: string;
```

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/db/reviewMigration.test.ts` — read the file first and match its helpers.

```ts
it('points a pre-D review at the migrated v1 of the playbook its snapshot names', async () => {
  // versionIndex maps playbookId -> its v1 version id
  const migrated = migrateReviewRecord(legacyReview, { pb1: 'v1-of-pb1' });
  expect(migrated.playbookVersionId).toBe('v1-of-pb1');
});

it('leaves playbookVersionId absent when the playbook no longer exists', async () => {
  const migrated = migrateReviewRecord(
    { ...legacyReview, playbookSnapshot: { ...snapshot, id: 'deleted-pb' } },
    { pb1: 'v1-of-pb1' },
  );
  expect('playbookVersionId' in migrated).toBe(false);
  // and it still opens on its snapshot
  expect(migrated.playbookSnapshot.clauses).toHaveLength(1);
});

it('does not overwrite a version id a review already has', async () => {
  const migrated = migrateReviewRecord(
    { ...legacyReview, playbookVersionId: 'v4' }, { pb1: 'v1-of-pb1' });
  expect(migrated.playbookVersionId).toBe('v4');
});
```

Append to `src/lib/db/reviews.test.ts`:

```ts
it('reopening a review reads the version it ran against, not the current one', async () => {
  // publish v1, save a review carrying v1's id, publish v2, reopen
  const reopened = await getReview(reviewId);
  const version = await getVersion(reopened!.playbookVersionId!);
  expect(version!.version).toBe(1);
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `npx vitest run src/lib/db/reviewMigration.test.ts src/lib/db/reviews.test.ts`
Expected: FAIL — `playbookVersionId` is `undefined`.

- [ ] **Step 4: Implement**

Extend `migrateReviewRecord`'s signature with `versionIndex: Record<string, string>` (playbookId → its v1 version id), built once by the caller from `listVersions`. Do **not** make the migration reach into the store itself — it is a pure repair function and the existing tests depend on that. Default the parameter to `{}` so existing call sites keep compiling, then update them.

In `reviews.ts`, `saveReview` writes `playbookVersionId` through unchanged; the run launcher in `App.tsx` sets it from the version it snapshotted.

- [ ] **Step 5: Mutation-test**

Mutation: make the back-fill overwrite an existing `playbookVersionId`. Expect "does not overwrite a version id a review already has" to FAIL. Restore.

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/types.ts src/lib/db/reviews.ts src/lib/db/reviewMigration.ts src/App.tsx src/lib/db/reviewMigration.test.ts src/lib/db/reviews.test.ts
git commit -m "feat: reviews record the playbook version they ran against"
git show --stat HEAD
```

---

## Task 5: `positionOutcome.ts` — the `unclear` defaults

The single most load-bearing piece of judgement in this sub-project. It is the only place the defaults live, for the same reason `verificationLabel` is the only place export wording lives.

**Files:**
- Create: `src/lib/positionOutcome.ts`, `src/lib/positionOutcome.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `StandardPosition`.
- Produces: `PositionOutcome`, `PositionOutcomeFields`, `normalisePositionOutcome(position, rawOutcome, rawRationale)`, `NO_RATIONALE_NOTE`.

- [ ] **Step 1: Add the `Finding` fields and the outcome type**

```ts
export type PositionOutcome = 'meets' | 'deviates' | 'unclear';
```

and on `Finding`:

```ts
  /** Present only when the clause carried a standard position. Absent means
   *  "no position to compare against" — never `unclear`, which means "there
   *  was a position and the model could not tell." The distinction is the
   *  whole point: "we have no house rule here" and "we have one and could
   *  not tell" are different facts. */
  positionOutcome?: PositionOutcome;
  positionRationale?: string;
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/positionOutcome.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalisePositionOutcome, NO_RATIONALE_NOTE } from './positionOutcome';
import type { StandardPosition } from '../types';

const position: StandardPosition = { text: 'We ask for 6 months', origin: 'authored', reviewedByHuman: true };

describe('normalisePositionOutcome', () => {
  it('yields no outcome at all when the clause has no standard position', () => {
    const out = normalisePositionOutcome(undefined, 'meets', 'because');
    expect('positionOutcome' in out).toBe(false);
    expect('positionRationale' in out).toBe(false);
  });

  it('passes a well-formed meets through', () => {
    expect(normalisePositionOutcome(position, 'meets', 'six months exactly'))
      .toEqual({ positionOutcome: 'meets', positionRationale: 'six months exactly' });
  });

  it('turns a missing outcome into unclear, never meets', () => {
    expect(normalisePositionOutcome(position, undefined, 'x').positionOutcome).toBe('unclear');
  });

  it('turns an unrecognised outcome into unclear, never meets', () => {
    expect(normalisePositionOutcome(position, 'satisfies', 'x').positionOutcome).toBe('unclear');
    expect(normalisePositionOutcome(position, null as never, 'x').positionOutcome).toBe('unclear');
    expect(normalisePositionOutcome(position, 42 as never, 'x').positionOutcome).toBe('unclear');
  });

  it('accepts a case-mismatched outcome from a loose-JSON model', () => {
    expect(normalisePositionOutcome(position, 'DEVIATES', 'shorter').positionOutcome).toBe('deviates');
  });

  it('turns deviates with no rationale into unclear and says why', () => {
    const out = normalisePositionOutcome(position, 'deviates', '   ');
    expect(out.positionOutcome).toBe('unclear');
    expect(out.positionRationale).toBe(NO_RATIONALE_NOTE);
  });

  it('leaves meets with no rationale as meets', () => {
    // Only `deviates` is downgraded: a deviation nobody can see the argument
    // for is not actionable, whereas an unexplained agreement asserts nothing
    // a reader would act on.
    const out = normalisePositionOutcome(position, 'meets', '');
    expect(out.positionOutcome).toBe('meets');
    expect(out.positionRationale).toBeUndefined();
  });

  it('never returns meets for any input the model did not clearly say meets', () => {
    for (const raw of [undefined, null, '', '  ', 'unknown', 'MEETS?', 0, [], {}]) {
      const out = normalisePositionOutcome(position, raw as never, 'r');
      expect(out.positionOutcome).not.toBe('meets');
    }
  });
});
```

- [ ] **Step 3: Run, confirm failure**

Run: `npx vitest run src/lib/positionOutcome.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
import type { PositionOutcome, StandardPosition } from '../types';

export const NO_RATIONALE_NOTE =
  'The model reported a deviation but gave no reason, so this is recorded as unclear.';

const OUTCOMES: PositionOutcome[] = ['meets', 'deviates', 'unclear'];

export interface PositionOutcomeFields {
  positionOutcome?: PositionOutcome;
  positionRationale?: string;
}

/**
 * The ONLY place a `positionOutcome` is produced. Three rules, each of which
 * exists because the alternative is a confident wrong answer:
 *
 *  - A missing or unrecognised outcome becomes `unclear`, NEVER `meets`.
 *    This mirrors `readStatus` in sub-project B's migration deliberately:
 *    the safe default is the one that prompts a human to look. A default of
 *    `meets` would let a clause nobody could evaluate report that the firm's
 *    house rule was satisfied.
 *  - `deviates` with no rationale becomes `unclear`, and says so. A
 *    deviation nobody can see the argument for is not actionable, and
 *    presenting it as one invites a lawyer to act on nothing. `meets` is NOT
 *    downgraded the same way: an unexplained agreement asserts nothing a
 *    reader would act on.
 *  - A clause with no standard position gets no outcome at all — the keys
 *    are absent, not `undefined`. `structuredClone` (how IndexedDB writes
 *    every record) preserves an `undefined`-valued key, so returning
 *    `{ positionOutcome: undefined }` would persist a key that reads as
 *    "there was a position" to anything doing an `in` check.
 */
export function normalisePositionOutcome(
  position: StandardPosition | undefined,
  rawOutcome: unknown,
  rawRationale: unknown,
): PositionOutcomeFields {
  if (!position) return {};

  const rationale = typeof rawRationale === 'string' && rawRationale.trim() !== ''
    ? rawRationale.trim()
    : undefined;

  // Case-insensitive for the same reason `extractClause` matches risk levels
  // that way: a mismatched case can only arrive via `parseJsonLoose`'s
  // fallback for models that don't honour the strict schema — exactly the
  // models most likely to emit 'DEVIATES'.
  const outcome = typeof rawOutcome === 'string'
    ? OUTCOMES.find(o => o === rawOutcome.toLowerCase())
    : undefined;

  if (outcome === 'deviates' && !rationale) {
    return { positionOutcome: 'unclear', positionRationale: NO_RATIONALE_NOTE };
  }
  if (!outcome) {
    return rationale
      ? { positionOutcome: 'unclear', positionRationale: rationale }
      : { positionOutcome: 'unclear' };
  }
  return rationale ? { positionOutcome: outcome, positionRationale: rationale } : { positionOutcome: outcome };
}
```

- [ ] **Step 5: Run, confirm pass, then mutation-test**

- Mutation A: change the `!outcome` fallback to `'meets'`. Expect "turns a missing outcome into unclear" and "never returns meets for any input" to FAIL. Restore.
- Mutation B: delete the `deviates && !rationale` branch. Expect "turns deviates with no rationale into unclear" to FAIL. Restore.
- Mutation C: change `if (!position) return {}` to `return { positionOutcome: 'unclear' }`. Expect "yields no outcome at all" to FAIL. Restore.

All three are named in the spec's mutation list. If any does not fail, the test proves nothing — report it rather than moving on.

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/types.ts src/lib/positionOutcome.ts src/lib/positionOutcome.test.ts
git commit -m "feat: positionOutcome normaliser with unclear-by-default"
git show --stat HEAD
```

---

## Task 6: Deviation evaluation in the extraction call

Evaluation happens **in the extraction call**, not a second pass (spec §6): the model is already reading the clause text with the document in front of it, and a second call would compare a summary against a position rather than the document against a position.

**Files:**
- Modify: `src/features/review/extractClause.ts`, `src/features/review/extractClause.test.ts`
- Modify: `src/features/review/extractCollectionClause.ts`, `src/features/review/extractCollectionClause.test.ts` (R-D3)

**Interfaces:**
- Consumes: `normalisePositionOutcome` (Task 5), `PlaybookVersion` (Task 2).
- Produces: findings carrying `positionOutcome`/`positionRationale`; `clauseSchema(clause)` replacing the module-level `CLAUSE_SCHEMA` for the call path.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/review/extractClause.test.ts`, using the file's existing `chatJson` mock and fixtures — **read it first**.

```ts
it('asks for a position outcome only when the clause has a standard position', () => {
  const withPos = buildClausePrompt(doc, { ...clause, standardPosition: pos }, version);
  const without = buildClausePrompt(doc, clause, version);
  expect(withPos).toContain('OUR STANDARD POSITION');
  expect(withPos).toContain('We ask for a 6-month break notice');
  expect(without).not.toContain('OUR STANDARD POSITION');
  expect(without).not.toContain('position_outcome');
});

it('records a deviation with its rationale', async () => {
  mockChatJson({ summary: 'The lease gives 9 months.', citations: [], risk_level: 'Medium',
    risk_analysis: 'x', position_outcome: 'deviates', position_rationale: 'Nine months, not six.' });
  const f = await extractClause(doc, { ...clause, standardPosition: pos }, version, settings);
  expect(f.positionOutcome).toBe('deviates');
  expect(f.positionRationale).toBe('Nine months, not six.');
});

it('leaves the outcome absent for a clause with no position', async () => {
  mockChatJson({ summary: 'x', citations: [], risk_level: 'Low', risk_analysis: 'y',
    position_outcome: 'meets', position_rationale: 'z' });
  const f = await extractClause(doc, clause, version, settings);
  // The model volunteered an outcome for a clause with no house rule. It is
  // dropped, not recorded: there was nothing to compare against.
  expect('positionOutcome' in f).toBe(false);
});

it('records unclear when the model omits the outcome', async () => {
  mockChatJson({ summary: 'x', citations: [], risk_level: 'Low', risk_analysis: 'y' });
  const f = await extractClause(doc, { ...clause, standardPosition: pos }, version, settings);
  expect(f.positionOutcome).toBe('unclear');
});

it('keeps the outcome on a no-content finding', async () => {
  // A model that gave an outcome and an empty summary still gave an
  // outcome; dropping it would lose the one thing it did say.
  mockChatJson({ summary: '  ', citations: [], risk_level: 'Low', risk_analysis: 'y',
    position_outcome: 'deviates', position_rationale: 'Nine months.' });
  const f = await extractClause(doc, { ...clause, standardPosition: pos }, version, settings);
  expect(f.status).toBe('error');
  expect(f.noContent).toBe(true);
  expect(f.positionOutcome).toBe('deviates');
});

it('emits the risk block from riskCriteria or riskTolerance now that mode is gone (R-D1)', () => {
  expect(buildClausePrompt(doc, { ...clause, riskCriteria: 'Must be unconditional' }, versionNoTolerance))
    .toContain('RISK CRITERIA: Must be unconditional');
  expect(buildClausePrompt(doc, clause, { ...version, riskTolerance: 'Risk-averse' }))
    .toContain('RISK CRITERIA: Risk-averse');
  expect(buildClausePrompt(doc, clause, versionNoTolerance)).not.toContain('RISK CRITERIA');
});
```

Add the equivalents to `extractCollectionClause.test.ts`, where the comparison is against the synthesised net position.

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/features/review/extractClause.test.ts src/features/review/extractCollectionClause.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the prompt and schema changes**

In `extractClause.ts`, replace the `mode` gate in `buildClausePrompt`:

```ts
  // R-D1: `Template.mode` is gone. The block is emitted when there is
  // anything to say — a clause-level criterion or a playbook-level
  // tolerance. A migrated `mode: 'risk'` playbook retains its
  // `riskTolerance` and so emits exactly the block it does today; a
  // migrated `mode: 'extraction'` playbook had its stale tolerance cleared
  // by the migration, so it emits nothing, as today.
  const riskSource = clause.riskCriteria || version.riskTolerance;
  const riskBlock = riskSource ? `\nRISK CRITERIA: ${riskSource}` : '';

  const positionBlock = clause.standardPosition
    ? `\n\nOUR STANDARD POSITION ON THIS CLAUSE:\n${clause.standardPosition.text}\n\n` +
      'Compare what the document says against that position.'
    : '';
```

The `Return:` list gains, only when a position is present:

```
- position_outcome: one of "meets", "deviates", "unclear". Use "unclear" if you cannot tell — do not guess.
- position_rationale: why. For "deviates", say what the difference is.
```

Build the JSON schema per call rather than as a module constant, so `position_outcome`/`position_rationale` are `required` only when the clause has a position:

```ts
export function clauseSchema(clause: PlaybookClause) { … }
```

Keep the existing exported `CLAUSE_SCHEMA` constant for any test that imports it; have `extractClause` call `clauseSchema(clause)`.

Then, where the `done` finding is built:

```ts
    const positionFields = normalisePositionOutcome(
      clause.standardPosition, raw.position_outcome, raw.position_rationale,
    );
```

Spread `...positionFields` into the returned `done` finding **and** into the `noContent` error branch.

Apply the same three changes to `extractCollectionClause.ts`, with the prompt phrased against the net position: "Compare the NET POSITION you have just derived against our standard position."

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Mutation-test**

- Mutation A: emit the position block unconditionally. Expect "asks for a position outcome only when the clause has a standard position" to FAIL. Restore.
- Mutation B: hardcode the risk gate to `false`. Expect the R-D1 test to FAIL. Restore.
- Mutation C: drop `...positionFields` from the `noContent` branch. Expect "keeps the outcome on a no-content finding" to FAIL. Restore.

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/features/review/extractClause.ts src/features/review/extractClause.test.ts src/features/review/extractCollectionClause.ts src/features/review/extractCollectionClause.test.ts
git commit -m "feat: evaluate a clause against its standard position during extraction"
git show --stat HEAD
```

---

## Task 7: The third chip and the comparison block

Three chips, three questions, never merged (spec §11).

**Files:**
- Create: `src/components/PositionChip.tsx`, `src/components/PositionChip.test.tsx`
- Create: `src/features/review/PositionComparison.tsx`, `src/features/review/PositionComparison.test.tsx`
- Modify: `src/features/review/FindingCard.tsx`, `src/features/review/FindingCard.test.tsx`

**Interfaces:**
- Consumes: `PositionOutcome`, `StandardPosition`, `Finding`.
- Produces: `<PositionChip outcome={…} />`, `<PositionComparison position={…} finding={…} />`.

- [ ] **Step 1: Read `src/components/StateChip.tsx` and `src/components/RiskChip.tsx` first**

Match their prop shape, sizing and Tailwind idiom exactly. Do not invent a third styling convention.

- [ ] **Step 2: Write the failing tests**

`src/components/PositionChip.test.tsx`, using `src/test/mount.tsx`:

```ts
it('renders one label per outcome and never conflates two', () => {
  expect(text(<PositionChip outcome="meets" />)).toMatch(/meets/i);
  expect(text(<PositionChip outcome="deviates" />)).toMatch(/deviates/i);
  expect(text(<PositionChip outcome="unclear" />)).toMatch(/unclear/i);
});

it('renders nothing when there is no outcome', () => {
  // Absent means "no position to compare against". A chip here would put a
  // question on the card that was never asked.
  expect(html(<PositionChip outcome={undefined} />)).toBe('');
});
```

`src/features/review/PositionComparison.test.tsx`:

```ts
it('shows we-ask-for against what the document says', () => {
  const out = text(<PositionComparison position={pos} finding={deviatingFinding} />);
  expect(out).toContain('We ask for');
  expect(out).toContain('We ask for a 6-month break notice');
  expect(out).toContain('This document says');
  expect(out).toContain('The lease gives 9 months.');
});

it('shows the rationale', () => {
  expect(text(<PositionComparison position={pos} finding={deviatingFinding} />))
    .toContain('Nine months, not six.');
});

it('says a position is only a suggestion when no human has reviewed it', () => {
  const unreviewed = { ...pos, origin: 'ai-drafted' as const, reviewedByHuman: false };
  const out = text(<PositionComparison position={unreviewed} finding={deviatingFinding} />);
  // An AI-drafted position nobody has read is not the firm's position.
  expect(out).toMatch(/not (yet )?reviewed|suggestion/i);
});
```

`FindingCard.test.tsx`:

```ts
it('shows the comparison above the evidence when the clause has a position', () => {
  const out = html(card({ clause: { ...clause, standardPosition: pos }, finding: deviatingFinding }));
  expect(out).toContain('We ask for');
  expect(out.indexOf('We ask for')).toBeLessThan(out.indexOf(<the evidence list's real marker>));
});

it('shows no comparison block for a clause with no position', () => {
  expect(html(card({ clause, finding: doneFinding }))).not.toContain('We ask for');
});

it('renders the position chip alongside the state and risk chips, not instead of them', () => {
  const out = html(card({ clause: { ...clause, standardPosition: pos }, finding: verifiedDeviation }));
  expect(out).toMatch(/deviates/i);
  expect(out).toMatch(/verified/i);   // state chip survives
  expect(out).toMatch(/medium/i);     // risk chip survives
});
```

The third test is the one that catches a merge. **Read `FindingCard.tsx` for the real chip markup and the real evidence-list marker before writing these assertions** — do not invent a `data-testid` that does not exist. (A test written against assumed fixtures has bitten this project once already.)

- [ ] **Step 3: Run, confirm failure. Step 4: Implement. Step 5: Run, confirm pass.**

- [ ] **Step 6: Mutation-test**

Mutation: render `PositionChip` in place of `RiskChip` rather than beside it. Expect "renders the position chip alongside the state and risk chips" to FAIL. Restore.

- [ ] **Step 7: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/components/PositionChip.tsx src/components/PositionChip.test.tsx src/features/review/PositionComparison.tsx src/features/review/PositionComparison.test.tsx src/features/review/FindingCard.tsx src/features/review/FindingCard.test.tsx
git commit -m "feat: position outcome chip and the standard-position comparison block"
git show --stat HEAD
```

---

## Task 8: `positionHealth.ts` — derived, verified-only

**Files:**
- Create: `src/lib/positionHealth.ts`, `src/lib/positionHealth.test.ts`

**Interfaces:**
- Consumes: `Finding`, `PositionOutcome`.
- Produces: `PositionHealth`, `positionHealth(publishedAt, findings, opts?): PositionHealth`, `positionHealthLabel(h): string`.

- [ ] **Step 1: Write the failing tests**

Build `verified(outcome, at)` and `unchecked(outcome)` finding helpers locally in the test file — read `src/lib/verification.ts` for the real `Verification` shape rather than guessing it.

```ts
it('is UNTESTED when no verified finding has tested it', () => {
  expect(positionHealthLabel(positionHealth(0, []))).toBe('UNTESTED');
  expect(positionHealthLabel(positionHealth(0, [unchecked('meets'), unchecked('deviates')]))).toBe('UNTESTED');
});

it('counts only verified findings — an unchecked meets does not strengthen a position', () => {
  // The model agreeing with itself is not evidence. Letting it count would
  // close the loop this app exists to keep open.
  const h = positionHealth(0, [verified('meets'), unchecked('meets'), unchecked('meets')]);
  expect(positionHealthLabel(h)).toBe('HELD 1 of 1');
});

it('is HELD n of m when every verified finding met it', () => {
  expect(positionHealthLabel(positionHealth(0, [verified('meets'), verified('meets')]))).toBe('HELD 2 of 2');
});

it('is CONCEDED once a verified deviation lands after the version was published', () => {
  expect(positionHealthLabel(positionHealth(50, [verified('meets', 100), verified('deviates', 120)])))
    .toBe('CONCEDED 1 times');
});

it('ignores a verified deviation from before this version was published', () => {
  // The position changed; a concession against the old wording says nothing
  // about the new one.
  expect(positionHealthLabel(positionHealth(200, [verified('deviates', 100), verified('meets', 250)])))
    .toBe('HELD 1 of 1');
});

it('does not count a verified unclear as either held or conceded', () => {
  expect(positionHealthLabel(positionHealth(0, [verified('unclear')]))).toBe('UNTESTED');
});

it('is NO POSITION when the clause has no standard position', () => {
  expect(positionHealthLabel(positionHealth(0, [], { hasPosition: false }))).toBe('NO POSITION');
});

it('an empty history is UNTESTED, not an error', () => {
  expect(() => positionHealth(0, [])).not.toThrow();
});
```

- [ ] **Step 2: Run, confirm failure. Step 3: Implement. Step 4: Run, confirm pass.**

Only findings with `verification.state === 'verified'` **and** a `positionOutcome` count. A verified finding whose outcome is `unclear` is neither held nor conceded — it tested nothing.

- [ ] **Step 5: Mutation-test**

- Mutation A: drop the `verification.state === 'verified'` filter. Expect "counts only verified findings" to FAIL. Restore. (Named in the spec's mutation list.)
- Mutation B: drop the `at >= publishedAt` filter. Expect "ignores a verified deviation from before this version" to FAIL. Restore.

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add src/lib/positionHealth.ts src/lib/positionHealth.test.ts
git commit -m "feat: derive position health from verified findings only"
git show --stat HEAD
```

---

## Task 9: The playbook editor — positions, drafts, publishing

**Files:**
- Create: `src/features/templates/StandardPositionField.tsx` + test
- Create: `src/features/templates/PublishDialog.tsx` + test
- Modify: `src/features/templates/TemplateEditor.tsx` + test, `src/features/templates/CreateTemplateDialog.tsx`, `generateTemplate.ts`, `buildMegaPrompt.ts`, `MegaPromptModal.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: `publishVersion`, `saveDraft`, `positionHealth`, `PlaybookDraft`.
- Produces: an editor that edits a **draft** and publishes versions.

- [ ] **Step 1: Remove the mode toggle**

Delete the Standard/Risk Mode button pair and `isRiskMode`. The risk-tolerance field and the per-clause Risk Scorer field become **always visible**, with the tolerance field's help text saying it applies to every clause and that an empty value means no risk criteria are sent. This is the honest replacement: the fields still exist, and R-D1 makes their presence — not a flag — decide the prompt.

Update `buildMegaPrompt`'s `includeRisk` default to `Boolean(version.riskTolerance || clauses.some(c => c.riskCriteria))` rather than reading `mode`, and have it emit each clause's standard position when one is set. `MegaPromptModal`'s toggle stays a user choice.

- [ ] **Step 2: Write the failing editor tests**

```ts
it('edits into the draft, never into the published version', async () => {
  const onSaveDraft = vi.fn();
  const el = mount(<TemplateEditor version={publishedV1} draft={undefined} onSaveDraft={onSaveDraft} … />);
  type(titleInput(el), 'Renamed');
  await flush();
  expect(onSaveDraft).toHaveBeenCalled();
  // the published version object handed in is untouched
  expect(publishedV1.name).toBe('Commercial Lease');
});

it('shows an unpublished-changes state when a draft exists', () => {
  expect(text(mount(<TemplateEditor version={publishedV1} draft={someDraft} … />)))
    .toMatch(/unpublished changes/i);
});

it('refuses to publish without a change summary after v1', async () => {
  const onPublish = vi.fn();
  const el = mount(<PublishDialog nextVersion={2} onPublish={onPublish} … />);
  click(publishButton(el));
  await flush();
  expect(onPublish).not.toHaveBeenCalled();
  expect(text(el)).toMatch(/change summary/i);
});

it('marks an AI-drafted position no human has read as a suggestion', () => {
  const el = mount(<StandardPositionField position={{ text: 'x', origin: 'ai-drafted', reviewedByHuman: false }} … />);
  expect(text(el)).toMatch(/drafted by AI/i);
  expect(text(el)).not.toMatch(/reviewed by you/i);
});

it('says the field is optional and what it enables when empty', () => {
  const el = mount(<StandardPositionField position={undefined} … />);
  expect(text(el)).toMatch(/optional/i);
  expect(text(el)).toMatch(/deviation/i);
});
```

`StandardPositionField`'s provenance line, per spec §8:
- `origin: 'authored'` → "Written by you"
- `origin: 'ai-drafted'`, `reviewedByHuman: false` → "Drafted by AI — not yet reviewed"
- `origin: 'ai-drafted'`, `reviewedByHuman: true` → "Drafted by AI, reviewed by you"
- `origin: 'learned'` → "Learned from redlines", plus `provenance` when present

- [ ] **Step 3: Clause reordering saves into the draft**

The editor already reorders with the `moveClause` up/down chevrons. Spec §8 asks for drag-based reordering. Keep the chevrons — they are keyboard-reachable and a drag handle is not — and add drag as a second affordance on the same `moveClause` path, so both write through one function into the **draft**.

```ts
it('reordering clauses writes into the draft, not the published version', async () => {
  const onSaveDraft = vi.fn();
  const el = mount(<TemplateEditor version={twoClauseV1} draft={undefined} onSaveDraft={onSaveDraft} … />);
  click(moveDownButton(el, 0));
  await flush();
  expect(onSaveDraft.mock.calls.at(-1)![0].clauses.map((c: PlaybookClause) => c.id)).toEqual(['c2', 'c1']);
  expect(twoClauseV1.clauses.map(c => c.id)).toEqual(['c1', 'c2']); // untouched
});
```

If drag proves to need a dependency, **do not add one** — ship the chevrons, and report it as a concern. A drag library is not worth a new runtime dependency in a static-hostable app, and the reordering itself works either way.

- [ ] **Step 4: Run, confirm failure. Step 5: Implement. Step 6: Run, confirm pass.**

- [ ] **Step 7: Mutation-test**

Mutation: make the editor's `onChange` write into the version object rather than the draft. Expect "edits into the draft, never into the published version" **and** "reordering clauses writes into the draft" to FAIL. Restore. (Version immutability is named in the spec's mutation list.)

- [ ] **Step 7: Gates and commit**

```bash
npx tsc --noEmit && npm test && npm run build
git add <every file above, by name>
git commit -m "feat: playbook editor edits a draft, publishes immutable versions"
git show --stat HEAD
```

---

## Task 10: Version history

**Files:**
- Create: `src/features/templates/VersionHistory.tsx` + test
- Modify: `src/features/templates/TemplateLibrary.tsx`, `src/features/review/ResultsView.tsx` (header link), `src/App.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it('lists every version with its number, date, author and change summary', () => {
  const out = text(mount(<VersionHistory versions={[v2, v1]} matterNamesByVersion={{}} … />));
  expect(out).toContain('v2');
  expect(out).toContain('Added a break-notice position');
  expect(out).toContain('v1');
});

it('names the matters that used each version', () => {
  const out = text(mount(<VersionHistory versions={[v1]} matterNamesByVersion={{ [v1.id]: ['Acme HQ lease'] }} … />));
  expect(out).toContain('Acme HQ lease');
});

it('says plainly when no matter has used a version yet', () => {
  // A blank cell reads as a rendering failure; "not used by any review yet"
  // reads as the fact it is.
  expect(text(mount(<VersionHistory versions={[v1]} matterNamesByVersion={{}} … />)))
    .toMatch(/not used|no reviews/i);
});

it('offers no way to edit a published version', () => {
  // Editing a published version is not offered (spec §2). Editing produces
  // a new version, because a review that says "ran against v4" must be able
  // to prove what v4 was.
  expect(html(mount(<VersionHistory versions={[v1, v2]} … />))).not.toMatch(/edit this version/i);
});

it('renders an error branch instead of the list when loading failed', () => {
  // Every screen that loads from IndexedDB distinguishes "empty" from
  // "broken" and offers a retry (CLAUDE.md). Use `describeLoadError` /
  // `LoadErrorPanel`; do not hand-roll one.
  const el = mount(<VersionHistory error={new Error('boom')} versions={[]} … />);
  expect(text(el)).not.toMatch(/no versions yet/i);
  expect(text(el)).toMatch(/try again|retry/i);
});
```

The review header gains "Ran against v1" linking to this screen, read from `run.playbookVersionId`; when that id is absent it reads "Ran against a playbook version that is no longer recorded" rather than showing nothing.

- [ ] **Steps 2–4: Run / implement / run.**

- [ ] **Step 5: Gates and commit** (`git add` by name; `git show --stat HEAD` after committing).

---

## Task 11: Exports carry the outcome and its rationale

`findingOutcome.ts` is the only place export wording lives — the DOCX and CSV exporters have drifted apart on exactly this kind of thing before.

**Files:**
- Modify: `src/lib/findingOutcome.ts` + test, `src/features/tabular/csv.ts` + test, `src/features/review/exportDocx.ts` + test

**Interfaces:**
- Produces: `positionOutcomeLabel(finding): string | null`, `positionRationaleLines(finding): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('positionOutcomeLabel', () => {
  it('labels a deviation', () => {
    expect(positionOutcomeLabel({ …, positionOutcome: 'deviates' }))
      .toBe('DEVIATES FROM OUR STANDARD POSITION');
  });
  it('labels an unclear outcome as unclear, never as met', () => {
    expect(positionOutcomeLabel({ …, positionOutcome: 'unclear' }))
      .toBe('UNCLEAR AGAINST OUR STANDARD POSITION');
  });
  it('returns null for meets — a label there would be a caveat where there is none', () => {
    expect(positionOutcomeLabel({ …, positionOutcome: 'meets' })).toBeNull();
  });
  it('returns null when there is no position at all', () => {
    expect(positionOutcomeLabel({ … })).toBeNull();
  });
});

it('the CSV carries the label and the rationale', () => {
  const csv = buildTabularCsv(runWithDeviation, docs);
  expect(csv).toContain('DEVIATES FROM OUR STANDARD POSITION');
  expect(csv).toContain('Nine months, not six.');
});

it('the DOCX and the CSV use the same wording for the same finding', () => {
  // They disagreed once before, and the CSV is the one that opens straight
  // into Excel.
  const label = positionOutcomeLabel(f)!;
  expect(buildTabularCsv(runWithDeviation, docs)).toContain(label);
  expect(buildReportRows(runWithDeviation, docs).flat().join(' ')).toContain(label);
});
```

Wire the label into `cellText`'s existing label array in `csv.ts` (it already joins `verificationLabel`, `netPositionLabel`, `netPositionAmendmentLabel`) and into the DOCX's equivalent, so all four caveats appear in one bracketed run **in a fixed order** before the possibly-truncated summary. The rationale joins the `extras` list beside `noteLines` and `trailLines`.

`positionOutcomeLabel` is ASCII-only, for the same reason `exportSummaryLine` is: the CSV is written with no BOM and Excel's default Windows import reads it as ANSI.

- [ ] **Steps 2–4: Run / implement / run. Step 5: Gates and commit.**

---

## Task 12: The clause index counts deviations

**Files:**
- Modify: `src/features/tabular/TabularReview.tsx` + test (and wherever the existing count chips live — `grep` for them rather than assuming)

- [ ] **Step 1: Write the failing test**

```ts
it('counts deviations alongside the existing count chips', () => {
  const out = text(mount(<TabularReview run={runWithTwoDeviations} … />));
  expect(out).toMatch(/2\s*deviates/i);
});

it('shows no deviation count when no clause carries a position', () => {
  expect(text(mount(<TabularReview run={plainRun} … />))).not.toMatch(/deviates/i);
});
```

- [ ] **Steps 2–4: Run / implement / run. Step 5: Gates and commit.**

---

## Task 13: Documentation and rulings

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/redesign/rulings.md`

- [ ] **Step 1: `rulings.md`** — copy R-D1 … R-D5 from this plan's "Rulings" section verbatim, each with its cost-if-wrong, into the format that file already uses. Read it first.

- [ ] **Step 2: `README.md`** — a `## Standard positions` section (what a position is, that `unclear` is a real answer, that only verified findings move a position's health) and a `## Playbook versions` section (editing produces a draft; publishing freezes a version; a review reads the version it ran on). Add a Known-limitations bullet: the `Standard positions` global nav tab is not built, on the same reasoning as C's `Compare` tab.

- [ ] **Step 3: `CLAUDE.md`** — add these conventions, in the file's existing voice:

- **`positionOutcome.ts` is the only place a position outcome is produced, and its default is `unclear`.** A missing or unrecognised outcome becomes `unclear`, never `meets` — the safe default is the one that prompts a human to look. `deviates` with no rationale is downgraded to `unclear` and says why; `meets` is not, because an unexplained agreement asserts nothing a reader would act on.
- **Absent is not `unclear`.** A clause with no standard position gets no `positionOutcome` key at all. `structuredClone` preserves an `undefined`-valued key, so returning one would persist a claim that a comparison was attempted.
- **A published version is immutable, and that is a property of id allocation, not a check.** `publishVersion` mints a fresh `uid()` on every call, so a `put` can never land on an existing version.
- **Position health is derived from verified findings only.** An unchecked `meets` is the model agreeing with itself; counting it would close the loop the app exists to keep open.
- **`Template.mode` is gone; the risk block is gated on `riskCriteria || riskTolerance` (R-D1).** The migration clears a stale `riskTolerance` on an `extraction`-mode playbook, because the editor hid that field without ever clearing it.
- Add `positionOutcome.ts`, `positionHealth.ts`, `db/playbookVersions.ts`, `db/playbookMigration.ts` to the extraction-points list.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/redesign/rulings.md
git commit -m "docs: standard positions, playbook versioning, and sub-project D's rulings"
git show --stat HEAD
```

- [ ] **Step 5: Browser verification — the controller's own, not a subagent's**

Spec §10.10 and CLAUDE.md's "Verify UI work in a browser". Unit tests did not catch "Run a review" showing zero documents, nor a failed review becoming permanently unopenable — both surfaced only by driving the real app.

1. Open an existing matter and confirm its playbooks survived the migration with their prompts intact and no invented positions.
2. Open a playbook, add a standard position to one clause, confirm the provenance reads "Written by you".
3. Confirm the editor shows "unpublished changes" and that Publish refuses an empty change summary.
4. Publish v2 with a summary; confirm version history lists v1 and v2 with their summaries.
5. Run a review against v2 over a document that plainly deviates from the position; confirm the finding shows the outcome chip, the two-column comparison, and the rationale — **and that the state and risk chips are still there**.
6. Confirm a clause with no position shows no comparison block at all.
7. Verify the deviation; reload; confirm both the verification and the outcome survived.
8. Re-run that clause; confirm the verification resets (B's rule) and the outcome is re-derived.
9. Export DOCX and CSV; confirm both carry the deviation label and its rationale, in the same words.
10. Publish v3, reopen the earlier review, and confirm its header still says it ran against v2 and that it reads against v2's clauses.

If any step cannot be driven, say so plainly rather than implying it was.
