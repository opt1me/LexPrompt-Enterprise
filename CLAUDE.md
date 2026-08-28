# LexPrompt — working notes for Claude

A browser-only AI contract-review app. Pick a contract type, generate a review template (a "playbook") of clauses, run it over documents, read findings as cards whose citations highlight the exact quoted passage in a document viewer alongside.

No backend. No accounts. The user supplies their own OpenRouter API key.

## The one rule that outranks the others

**Fail loudly rather than answer quietly wrong.**

This app tells lawyers what is in contracts. A visible error costs someone a retry; a confident wrong answer costs them a mistake in advice. Nearly every serious defect found in this codebase has been a variant of the same thing — something incorrect, incomplete or stale presented as if it were correct and complete:

- A scanned PDF reviewed by a text-only model returning "the agreement is silent on this point" for every clause.
- A marked-up DOCX reviewed as though every tracked change had been accepted, with the deletions silently gone — the counterparty's redline read back as the contract. Worse than the scan above in one respect: a scan yields visibly empty text, this yields fluent, plausible, wrong text.
- The chat panel answering questions about a document whose text it never received.
- An SSE parser silently dropping the last token of every streamed answer, and returning *nothing* on servers using CRLF.
- A CSV export writing unreviewed clauses as blank cells — which reads in a spreadsheet as "checked, nothing found".
- A failed storage migration rendering an empty library, indistinguishable from a fresh install.
- A model returning schema-valid but empty summaries, recorded as completed findings.
- An abandoned run reopening with every cell spinning forever, unfinishable.

When you are deciding how something should behave on failure, that list is the prior. Prefer a loud, specific, recoverable failure over anything that could be mistaken for a successful empty result.

## Architecture

**Persistence** — `src/lib/db/` over IndexedDB via `idb`. `open.ts` owns the connection; one repository per store (`matters`, `documents`, `blobs`, `reviews`, `playbooks`, `profile`). `src/lib/storage.ts` keeps **settings only**, synchronously, in `localStorage` — deliberately, because they are a few hundred bytes read in render paths and moving them would make every caller async.

**AI** — `src/lib/openrouter.ts` is the only route to a provider: `chat`, `chatStream`, `chatJson`, `listModels`. Retries **only** on 429 and 5xx; fails fast on 400/401/402/403. `parseJsonLoose` is the fallback for models that wrap JSON in prose.

**Review engine** — `extractClause(doc, clause, template, settings)` returns one `Finding` and **never rejects**; `runReview` fans it across a document × clause matrix with bounded concurrency. The card view and the tabular grid are two *renderers* over one `findings` map. Never build a second pipeline for a second view.

**Citations** — `src/lib/citations.ts` matches verbatim quotes to page coordinates. Pure, no React, no pdf.js. Verified end to end: 4/4 citations landed exactly after a full reload.

## Conventions that were expensive to learn

**Load paths must distinguish "empty" from "broken".** Every screen that loads from IndexedDB uses a dedicated error state, distinguishes `DbBlockedError` by type, renders an error branch *instead of* the content, and offers a retry. Never fall back to an empty list. Use `describeLoadError` / `LoadErrorPanel`; do not hand-roll a new one.

**Never delete what you cannot read.** Corrupt stored data is quarantined, not discarded. The migration never deletes its `localStorage` source — that backup is deliberate and disclosed in the README.

**Page images are never persisted.** Original file bytes are stored as Blobs; page images are derived data (base64, ~⅓ larger than the source) regenerated on demand and cached in-session with an LRU bound.

**Scan detection is per page, not per document.** `SCAN_TEXT_THRESHOLD` applied to each `[Page N]` segment. A document-wide check lets one typed cover page carry a scanned body over the bar. This blind spot has had to be fixed three times.

**Model capability is checked before calling.** `modelContext.ts` decides whether to send text, images, or decline. A model that cannot read images must not be handed a scan.

**Snapshot what a review claims to have checked.** `Review.playbookSnapshot` is a deep copy. Editing a playbook afterwards must not rewrite history.

**Verification state is set only by a human action; nothing derives it.** A finding's `Verification` is a person's judgement about a specific answer, not a status the engine infers. `extractClause` never writes anything but `unchecked()`; the only writers are the verify/flag/reject controls and the reset below.

**Re-running a clause resets its verification.** The verification described a specific piece of output; once that output is replaced, keeping the old verification would let an export claim a human checked text they never saw. This is load-bearing and mutation-tested — break the reset in `resetVerification` or in `retryCell`'s use of it and a test should fail.

**`verificationLabel` in `findingOutcome.ts` is the only place export wording lives.** The DOCX and CSV exporters have drifted apart on this once before (a CSV wrote unreviewed clauses as blank cells while the DOCX said "could not be reviewed") — both exporters now call this and `exportSummaryLine` rather than composing their own strings.

**`derivePage` is the only place a citation page number is produced.** It reads the `[Page N]` markers already in a document's extracted text and returns `undefined` rather than guessing. A wrong page pin sends a reader to the wrong part of a contract with apparent authority, which is worse than no pin.

**Verification and note writes are await-then-apply.** The UI updates its own state only after the store confirms the write, never optimistically — the reviewer must never see a state the store did not actually take.

**A net position is synthesised text no document contains.** It describes what a collection's documents, read in order, say now — not what any one of them literally says — so it is the most dangerous output this app produces, and starts unconfirmed for the same reason a finding starts `unchecked()`. Only a human confirms it, or amends it (a stronger claim than confirming: a person wrote every word).

**Re-running a clause resets its net position, exactly as it resets a verification.** The confirmation described a specific synthesis; once the clause is re-derived, that synthesis no longer exists, so keeping the old confirmation would let an export present text a person never saw as accepted. `resetPosition` mirrors `resetVerification` for the same reason, and both are mutation-tested.

**`positionOutcome.ts` is the only place a `positionOutcome` is produced, and its default is `unclear`, never `meets`.** A missing or unrecognised outcome from the model becomes `unclear` — the safe default is the one that sends a human to look, not the one that reads as settled. `deviates` with no rationale is downgraded to `unclear` too, with a note saying the model gave no reason; `meets` is not downgraded the same way, because an unexplained agreement asserts nothing a reader would act on.

**Absent is not `unclear`.** A clause with no standard position gets no `positionOutcome`/`positionRationale` keys at all — "we have no house rule here" and "we have one and could not tell" are different facts, and only the first should produce no comparison. `structuredClone` (how IndexedDB writes every record) preserves an `undefined`-valued key, so returning `{ positionOutcome: undefined }` would persist a claim that a comparison was attempted.

**Position health counts only `verified` findings, and only ones tested against the position's current wording.** `positionHealth`/`buildPositionHealthMap` are the same "nothing derives a human judgement" rule as `Verification` above — an unverified `meets` is the model agreeing with itself, and counting it would close the loop this app exists to keep open. Health is also scoped to reviews whose playbook version carried the position's exact current text, checked alongside (not instead of) requiring the verification be dated at or after that wording was published: one filter catches a verification made late against wording since superseded, the other catches one made early against wording since reverted to, and dropping either lets the editor report a position as tested by a review that never saw the sentence it currently has.

**`findingsKeyFor` is the only place a findings key is derived.** A collection review keys its findings by the *collection* id, not by a document — it produces one position per clause however many documents fed it, and keying by a document would force an arbitrary choice of which one "owns" the answer. Six separate defects in sub-project C came from code that keyed by document id directly instead: an empty findings pane, human writes (a verification, a note) landing under a key nothing read, a silently empty DOCX and CSV export, and a retry that would have re-run the single-document extractor and overwritten a synthesised net position with a one-document answer. If you are reading `run.findings[...]`, go through `findingsKeyFor`.

**`orderedMembers` is the only place collection reading order is decided, and `documentDate` never sorts it.** A date can be missing, wrong, or ambiguous; the order in which amendments take effect is a legal judgement someone recorded when they built the collection, not something to re-derive on every render. `documentDate` is displayed to the reader — it never governs order.

**Collection extraction is a separate function from `extractClause`.** `extractCollectionClause` has its own prompt, its own schema, and its own per-citation document resolution, so the standalone single-document path can't drift by sharing code that later has to special-case a collection.

**Collection membership is read from the collection record, not from `document.role`.** The two are written non-atomically — grouping and ungrouping touch the collection record and the member documents' `role` as separate writes — so `role` can briefly disagree with the record and is treated as a denormalised convenience; `Collection.baseDocumentId`/`variesDocumentIds` is authoritative.

**Extraction takes `DocumentFile`s hydrated *for review* — the hydration mode matters as much as the type.** A `DocumentRecord` carries no page images by design (derived data, regenerated on demand, never stored), and **a `documentFileForViewing` result is missing exactly the same field**. The two hydrations are each correct in their own place: `documentFileForViewing` for the viewer pane, which renders the PDF itself through `PdfCanvas` and needs no base64 images; `documentFileForReview` for anything that will be handed to `extractClause`/`extractCollectionClause`, which regenerates them only for a document that needs them and caches them per session. Reviewing from either a raw record or a view-hydrated file reviews a scanned document as though it said nothing — this project's founding defect. It has now reopened twice: once one level up (a collection of records), and once one level sideways, when a retry on a *reopened* review extracted from `openReview`'s view-hydrated `documents`. `openReview` still hydrates for viewing, deliberately — most reviews are opened to read, and regenerating every scan's images on every open is the cost that function exists to avoid — so `handleRetryCell` re-hydrates for review lazily, at the moment of retry, through `hydrateRecordForReview`/`hydrateIdForReview` (App.tsx's only route from persisted document to something the engine may see). Hydration reports its own failures as `parseError`, and a retry that hits one says the file could not be re-read rather than letting the extractor blame the document for having no content.

**`Template.mode` is gone; the risk block is gated on `clause.riskCriteria || version.riskTolerance` (`riskBlock.ts`), never on a flag.** Presence, not a mode toggle, decides whether a review asks for a risk assessment. The migration clears a stale `riskTolerance`/`riskCriteria` only on a record whose explicit `mode` was `'extraction'`, because the pre-D editor hid those fields outside risk mode without ever clearing them — left alone, an extraction playbook would silently gain risk criteria it never had. A record with no `mode` at all (anything post-D) keeps everything it has: the gate got this wrong twice before it shipped — first by treating "no mode" as extraction, which would have stripped `riskTolerance` from every already-migrated playbook on every subsequent read; then by fixing only the playbook-level tolerance and leaving the identical bug live one level down, on each clause's own `riskCriteria`.

**`publishAndPoint` publishes a version and points the playbook's identity record at it in one readwrite transaction spanning both stores.** Two separate transactions — publish, then save — left an orphaned version on any failure between them, and for an imported playbook an orphan with no identity record at all: permanently unreachable, since nothing but the startup migration adopts orphans, and that only looks at playbooks that still exist. `publishVersion` mints a fresh `uid()` on every call and never reuses one, so a published version's immutability is a property of how ids are allocated, not a check that could be forgotten.

**The pre-D playbook→version migration runs once at startup, behind its own flag, and converts each playbook inside its own transaction spanning both stores.** The flag alone was tried and was not enough: two concurrent `migrateIfNeeded()` calls — React StrictMode's double-invoked mount effect, or a second tab — both read no flag and both published, and a browser run caught the result, one playbook holding v1 *and* v2 with byte-identical content, in the one sub-project whose whole purpose is making "which version did this review run against" answerable. The transaction is what actually closes it: IndexedDB serialises overlapping readwrite transactions, so a second pass re-reads `currentVersionId` inside its own transaction and finds the first pass already wrote it.

**`authoringDraft.ts` holds the save gate, and the gate is the whole feature.** A drafted playbook cannot be saved while any clause is `unreviewed`, and a draft with no `kept` clause cannot be saved even once every clause has a disposition — an all-`cut` draft, or an empty one, is vacuously "nothing left to review", not "reviewed". `canSaveDraft` is re-checked inside `saveDraftAsV1` itself rather than trusted from the Save button's `disabled` attribute: a gate whose only enforcement is a greyed-out button is a suggestion, not a gate. The old one-click path to this same destination — `CreateTemplateDialog` plus `generateTemplate`, which handed a user a `PlaybookDraft` to save with no review at all — was **deleted**, not left standing beside the new route (ruling R-E8): a documented gate with an undocumented door around it protects nothing.

**An `AuthoringDraft` is never persisted — not IndexedDB, not `localStorage`, not a URL.** It is a different type from D's `PlaybookDraft` on purpose (ruling R-E1): D's is the mutable working copy written to IndexedDB, this one must never reach the store, and giving the two the same name is how someone writes half-reviewed model output into persistence while believing the type forbids it. A draft that survives a reload is a playbook nobody agreed to, so losing it is the correct behaviour, not a bug — guarded by `useUnsavedDraftGuard`'s two exits, since `beforeunload` alone covers a tab close but not the far likelier way to lose one, an in-app navigation click.

**A `DraftClause`'s `edited` and `positionEdited` are computed by comparing field values, never set by an onChange firing (R-E5).** A focus-and-blur, or an edit typed and undone, is not a person engaging with a clause, and `edited` feeds straight into the sentence a saved standard position's provenance carries — "rewritten and accepted" over text nobody actually touched is exactly the confidently-wrong claim this app exists not to make. `positionEdited` is deliberately **narrower** than `edited`: rewriting a risk criterion is not evidence anyone touched the standard position, so `toPlaybookDraft` reads `positionEdited`, never the clause-wide `edited`, when it decides whether a kept AI position stays "drafted, accepted unchanged" or becomes "rewritten and accepted".

**Few-shot material for drafting a playbook uses `verified` findings only** — the same rule as position health, one layer earlier. An unverified finding is the model's own output; feeding a prior matter's unverified findings back into a new playbook's generation prompt would launder a guess into a house rule, at the one place in the app another matter's content is sent to a model as *style material* rather than as a document under review. `buildFewShot`/`verifiedFindings` (`fewShot.ts`) is the only place that filter is applied.

## Sibling drift — the recurring failure

Six separate findings in this project came from two implementations of the same idea drifting apart. Once, `matters.ts` reproduced `playbooks.ts`'s sequence-allocation *without* its transaction scoping, while its docstring claimed to mirror it.

**When you find yourself writing a second copy of something, extract it then.** Not after the third. Existing extractions: `seq.ts` (type-enforced so a wrong-mode store fails to compile), `pageSegments.ts`, `findingOutcome.ts`, `modelContext.ts`, `describeLoadError`, `verification.ts`, `citationRepair.ts`, `citationPage.ts`, `reviewProgress.ts`, `findingMerge.ts`, `uid.ts`, `src/test/mount.tsx`, `reviewTarget.ts`, `netPosition.ts`, `collectionOrder.ts`, `collectionPrompt.ts`, `collectionSuggest.ts`, `db/collections.ts`, `positionOutcome.ts`, `positionHealth.ts`, `positionHealthMap.ts`, `riskBlock.ts`, `db/playbookVersions.ts`, `db/playbookMigration.ts`, `authoringDraft.ts`, `generateDraft.ts`, `fewShot.ts`, `suggestField.ts`.

`uid()` is the cautionary case: it was extracted only after the same four lines turned up **seven** byte-identical times across the codebase. That is not a success story for the rule above — it's what it looks like when nobody follows it. Treat "not after the third" as a real number, not a rhetorical one.

## Testing

`npm test` (Vitest + jsdom). Gates for any change: `npx tsc --noEmit` clean, tests pass, `npm run build` clean with no externalization warning.

**Mutation-test anything load-bearing.** Break the implementation, confirm the test fails, restore. This project has shipped several tests that passed against unfixed code and proved nothing — the worst were an idempotency test that reseeded identical data (so a `put` upsert made a broken implementation indistinguishable) and an abort test that exercised a code path the fix didn't touch. A green suite is not evidence; a test that fails when you break the thing is.

**Environment quirks that will waste your time:**
- Blobs do **not** round-trip through `fake-indexeddb` with jsdom's `Blob` — Node's `structuredClone` mangles it to `{}` silently. Use `node:buffer`'s `Blob` in tests.
- **…but which `Blob` you want depends on where it is going, and the two cases conflict.** The rule above is about *storing* a Blob. For a Blob that gets *parsed* — a `.docx` through `jszip`, or anything else reading bytes — `node:buffer`'s `Blob` is the wrong one: its `arrayBuffer()` returns an `ArrayBuffer` from a different realm, so `jszip`'s `instanceof ArrayBuffer` check fails and the parse dies with a confusing type error. Use jsdom's global `Blob` there. jsdom's `Blob` has no `arrayBuffer()` at all, so `vitest.setup.ts` polyfills `Blob.prototype.arrayBuffer` once, globally; call sites are not expected to provide it. A test that both parses a Blob *and* stores it needs both forms — convert deliberately rather than reaching for whichever import is already at the top of the file.
- `idb`'s convenience reads open their own incidental transactions, which skews spy-based atomicity assertions. Filter on mode.
- A tool being unable to reach something is not the same as it being untestable — `window.confirm` can't be clicked by browser automation but mocks fine in jsdom.
- **`toEqual` does not distinguish an absent key from an `undefined` one.** Vitest treats `{ a: 1 }` and `{ a: 1, b: undefined }` as equal. When *absence* is the thing you actually mean to assert, write `expect('b' in obj).toBe(false)` instead. This is more than tidiness: `structuredClone` — how IndexedDB writes every record — **preserves** an `undefined`-valued key, so a guard that looks decorative in a test is load-bearing against real persisted data.
- **Component tests drive `createRoot`/`act` directly; there is no `@testing-library/react` in this project.** New component tests import the shared harness at `src/test/mount.tsx` (`mount`, `mountOnce`, `click`, `type`, `keyDown`). Existing test files keep the harness they hand-rolled before this existed — they work, and rewriting them buys no behaviour.
- **Two live `mount()`s in one test leave two competing global listeners.** `mount()` accumulates mounted trees and only tears them down in its shared `afterEach`, so a test that calls `mount()` twice to compare before/after states has both trees alive at once — and for a hook that binds to `window` (`useVerifyKeys`), the first tree's listener still fires alongside the second's. Use `mountOnce` and unmount explicitly when a test genuinely needs a second tree. Found the hard way: a test that looked like it proved keyboard movement stops at the list's ends was actually being answered by a stale listener from the first mount.
- **Setting `.value` on a controlled React input is a silent no-op.** React installs its own setter on the element instance and reads from an internal tracker, so a plain `el.value = x` updates the DOM but leaves React believing nothing changed — the subsequent `input` event is then treated as a no-op. Go through the prototype's value setter, then dispatch `input`. `mount.tsx`'s `type()` does this already; use it rather than rediscovering it.
- **`runReview` owns its own copy of the run and emits a full snapshot roughly twice per cell.** Anything a human writes onto a finding from outside the engine — a verification, a note — is invisible to the engine and gets silently overwritten the next time an unrelated cell finishes. `carryHumanState` re-applies human-authored state onto each new snapshot; `handleUpdate` (and anything else consuming run snapshots) must keep calling it.
- **`retryCell` derives every snapshot from the run it is handed, not from ambient state.** Mutating component state alongside the call does not survive — the changed run has to be passed *into* `retryCell`, or the retry silently reverts it.
- **`usableText` strips `[Page N]` markers and drops sparse pages** (it's tuned for model readability, not page fidelity). Anything that needs real page numbers — `derivePage`, citation repair — must read `doc.text`, never the readability-filtered text.
- **jsdom has no `Element.prototype.scrollIntoView`.** Calling it un-stubbed throws `TypeError: ... is not a function` in any component test that scrolls a citation into view. Stubbed once, globally, in `vitest.setup.ts` — call sites are not expected to guard against its absence themselves.
- **A test that waits a fixed number of microtask ticks is measuring the code under test, not the test.** Sub-project F's `DB_VERSION` 3 -> 4 bump added one tick to App's review-open path — the first `getDb()` in a suite now runs an upgrade transaction before any read resolves — and pushed two collection tests one tick past their `await flush(8)`. They failed as "no Retry button" and as an empty findings pane: symptoms that read as defects in the feature, when the screen was still on "Loading review…". Wait on the condition, with `flushUntil` from `src/test/mount.tsx`, so a load that genuinely never settles fails saying so.
- **React runs effects in declaration order.** An effect that resets state on mount will silently undo an earlier effect that set it, because the earlier effect's set is applied and then immediately clobbered by the later one in the same commit. Guard a "the run changed" effect on the id actually changing rather than relying on where it sits in the file — the next person to reorder two effects would otherwise break something with no test failing near their change.

## Verify UI work in a browser

Unit tests did not catch: "Run a review" showing zero documents (the app's central flow), or a review that failed once becoming permanently unopenable. Both surfaced only by driving the real app. If you cannot, say so plainly rather than implying you did.

## Where things live

- `docs/superpowers/specs/` — designs, the binding authority for each sub-project
- `docs/superpowers/plans/` — task-by-task implementation plans
- `docs/superpowers/redesign/` — the redesign digests, and **`rulings.md`**: every decision made without owner review, with its cost-if-wrong
- `design_handoff_lexprompt_redesign/` — the owner's redesign brief and HTML prototypes (reference, not code to copy)
- `.superpowers/` — SDD execution scratch, gitignored, safe to delete

## Deliberate non-features

Multi-user is **schema-ready but not built** (`rulings.md` R1): identity fields exist and populate from a local profile, but assignment reaches nobody and no UI promises otherwise. Do not add an affordance implying collaboration the app cannot deliver.
