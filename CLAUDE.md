# LexPrompt — working notes for Claude

A browser-only AI contract-review app. Pick a contract type, generate a review template (a "playbook") of clauses, run it over documents, read findings as cards whose citations highlight the exact quoted passage in a document viewer alongside.

No backend. No accounts. The user supplies their own OpenRouter API key.

## The one rule that outranks the others

**Fail loudly rather than answer quietly wrong.**

This app tells lawyers what is in contracts. A visible error costs someone a retry; a confident wrong answer costs them a mistake in advice. Nearly every serious defect found in this codebase has been a variant of the same thing — something incorrect, incomplete or stale presented as if it were correct and complete:

- A scanned PDF reviewed by a text-only model returning "the agreement is silent on this point" for every clause.
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

## Sibling drift — the recurring failure

Six separate findings in this project came from two implementations of the same idea drifting apart. Once, `matters.ts` reproduced `playbooks.ts`'s sequence-allocation *without* its transaction scoping, while its docstring claimed to mirror it.

**When you find yourself writing a second copy of something, extract it then.** Not after the third. Existing extractions: `seq.ts` (type-enforced so a wrong-mode store fails to compile), `pageSegments.ts`, `findingOutcome.ts`, `modelContext.ts`, `describeLoadError`, `verification.ts`, `citationRepair.ts`, `citationPage.ts`, `reviewProgress.ts`, `findingMerge.ts`, `uid.ts`, `src/test/mount.tsx`.

`uid()` is the cautionary case: it was extracted only after the same four lines turned up **seven** byte-identical times across the codebase. That is not a success story for the rule above — it's what it looks like when nobody follows it. Treat "not after the third" as a real number, not a rhetorical one.

## Testing

`npm test` (Vitest + jsdom). Gates for any change: `npx tsc --noEmit` clean, tests pass, `npm run build` clean with no externalization warning.

**Mutation-test anything load-bearing.** Break the implementation, confirm the test fails, restore. This project has shipped several tests that passed against unfixed code and proved nothing — the worst were an idempotency test that reseeded identical data (so a `put` upsert made a broken implementation indistinguishable) and an abort test that exercised a code path the fix didn't touch. A green suite is not evidence; a test that fails when you break the thing is.

**Environment quirks that will waste your time:**
- Blobs do **not** round-trip through `fake-indexeddb` with jsdom's `Blob` — Node's `structuredClone` mangles it to `{}` silently. Use `node:buffer`'s `Blob` in tests.
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
