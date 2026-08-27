# Redesign rulings — decisions made while the repository owner was away

## R1. Identity / multi-user (blocks everything)
See the main ledger. Build SCHEMA-READY, SINGLE-USER-IN-PRACTICE: a local profile supplies identity, every ownerId/assigneeId/byUserId field exists and is populated from it, the UI renders those names honestly rather than inventing colleagues, and anything needing genuine cross-user visibility is built as a single-user view of the local store and labelled as such. FLAGGED for review — the mockups promise a collaborative product and I am deliberately building its single-user substrate.

## R2. What replaces DocumentFile.file (digest open question 4)
The handoff drops the live `File` handle implicitly and never says what replaces it. A `File` cannot be persisted or rehydrated, but PdfCanvas needs real PDF bytes to render after a reload.
Ruling: persist the ORIGINAL FILE BYTES as a Blob in IndexedDB, and do NOT persist page images at all.
Reasoning: IndexedDB stores Blobs natively and efficiently. Page images are currently base64 strings, which are ~33% larger than the bytes they encode, and they are DERIVED data — given the original PDF we can regenerate them on demand with the same code that produced them at ingest. Persisting both the source and its derivative would be the single largest storage cost in the app for no benefit, and it is precisely the cost the handoff worries about. Storing the source also keeps the door open for OCR-at-ingest (already agreed as the first post-v1 feature) to re-derive whatever it needs.
Cost if wrong: regenerating page images for a scanned document after a reload costs a few seconds of render time on first view rather than being instant. If that proves annoying, page images become a cache keyed on the document id — an addition, not a rework.

## R3. The storage rewrite is a rewrite (digest open question 8)
IMPLEMENTATION.md says to "bump TEMPLATE_SCHEMA_VERSION (2) to a new SCHEMA_VERSION (3) and write the migration in storage.ts". The digest is right that this undersells it: today's storage.ts is a synchronous localStorage wrapper with hand-written quarantine-on-corruption logic, and IndexedDB is asynchronous, transactional and versioned. This is a module rewrite, not a version bump.
Ruling: treat it as a rewrite with its own tasks, and keep the existing narrow interface as the seam. The current API is already Promise-returning specifically so this swap would not touch callers — that holds, and it is why this is a contained rewrite rather than an app-wide one. The corrupt-data quarantine behaviour proven in v1 must be carried across, not dropped: IndexedDB fails differently but it still fails.
Cost if wrong: none identified; the alternative (pretending it is a version bump) is how this becomes a mid-sprint surprise.

## R4. The assistant module's disposition (digest open question 9)
Neither handoff document mentions src/features/assistant/ at all — no decision on whether chat, draft-email and suggest-revision survive, change or are cut. The digest flags this as a real gap in an otherwise systematic "what changes / what stays" table.
Ruling: KEEP the assistant module, unchanged in this sub-project. It is built, tested, browser-verified, and it declines honestly on unreadable documents — which took two fix rounds to get right. Nothing in the redesign contradicts it, and silently dropping a working feature because a document forgot to mention it would be the wrong reading of an omission. It will need one adaptation later so chat is scoped to a matter rather than a loose set of documents; that belongs with the matter work, not here.
Cost if wrong: if the owner wanted it cut, deleting it later is trivial and the tests come out with it.

## R5. Persisting contract text — CONFIRMED BY THE OWNER (2026-08-26)
The spec's §4 flagged that persisting contract text reverses v1's stated privacy position and asked for confirmation rather than proceeding on my own reading. The owner confirmed: "persisting is fine". Also granted explicit authorisation to carry on through the entire redesign without further check-ins.
This means §4's obligations are now binding rather than provisional: everything stays in the visitor's own browser; deleting a matter must genuinely purge blobs rather than only the index entry; and the Settings privacy note and README are updated within sub-project A, not deferred.

## R6. Settings stay in localStorage (spec §5.1 deviation)
The spec's store table lists `settings` as an IndexedDB store. On inspection that is wrong. `loadSettings`/`saveSettings` are SYNCHRONOUS and are read in render paths across App.tsx, SettingsPanel, the review path and ChatPanel. IndexedDB is asynchronous, so moving settings there would make every one of those call sites async for a payload of a few hundred bytes that has no capacity problem.
Ruling: settings remain in localStorage, synchronous, untouched. IndexedDB takes only the data that actually outgrew localStorage — matters, documents, blobs, reviews, playbooks, profile.
This also repairs an overstatement in the spec's own framing: v1's storage interface is not entirely swap-transparent after all. It is transparent for the Promise-returning half (templates), and the synchronous half (settings) is precisely the part that should not move. Recognising that now avoids a pointless async cascade through the UI.
Cost if wrong: if settings ever grow large or need to be shared per-matter, moving them later is a contained change to two functions and their call sites.

---

# Sub-project B — rulings made without owner review (2026-08-27)

The full execution ledger lives at `.superpowers/sdd/2026-08-27-redesign-b-verified-findings/progress.md`, which is **gitignored and disposable**. These are the decisions from it that outlive the sub-project, recorded here because this file is the durable home for "decided without review, with cost-if-wrong".

## Design decisions that still bind

- **R-B1. `runReview.ts` may be touched, minimally.** The spec lists its orchestration as unchanged, but `Finding` gained two required fields so its object literals would not compile. Only those literals changed. *Cost if wrong: a trivial diff to revert.*
- **R-B2. Verification writes are await-then-apply, not optimistic.** The UI shows a new state only after `saveReview` resolves. Spec §9 forbids showing a state that was not persisted. *Cost if wrong: a perceptible pause on slow disks.*
- **R-B3. Notes live on the `Finding`, not in their own store.** They persist, migrate and export with the review that owns them. *Cost if wrong: a notes store becomes a later migration.*
- **R-B4. The CSV's header summary is its first row, a single field.** Opens as a title line in Excel without disturbing the header row beneath. *Cost if wrong: a stricter CSV consumer must skip row 1.*
- **R-B5. Page numbers are derived from the `[Page N]` markers in `DocumentRecord.text`.** Not from the PDF. That text is what the model saw, what persists, and what survives a reload — so derivation needs no pdfjs and leaves the verified matcher untouched. **Specifically NOT from `readability.text`**: `usableText` splits on those markers and discards them, then drops sub-threshold pages, so its numbers would be absent-or-renumbered. *Cost if wrong: pages are absent, never wrong.*
- **R-B6. `exportSummaryLine` is ASCII-only.** It is the CSV's first row; `csv.ts` writes no BOM, and Excel's default Windows import reads a BOM-less file as ANSI, so an em-dash would arrive as mojibake in the first thing a reader sees. *Cost if wrong: the DOCX header reads slightly plainer.*
- **R-B7. `jszip` is left as a transitive dependency of `docx`, used only by a test.** Declaring it means editing `package.json` and running `npm install`, which rewrites the lockfile — not done unattended. A break would be a loud import error at test time, never a silent wrong answer, and it never reaches the bundle. **Recommended to close with a one-line devDependency at integration.** *Cost if wrong: one failing test and a one-line edit.*
- **R-B8. Component tests follow this project's own `createRoot`/`act` harness; `@testing-library/react` was NOT added.** Five existing test files state the convention explicitly. The harness they had each hand-rolled is now extracted to `src/test/mount.tsx`; existing files keep their own. *Cost if wrong: adding the library later is a devDependency and a mechanical translation.*
- **R-B9. The README was corrected rather than the tabular grid.** The grid's cells show no verification state; its rebuild belongs to sub-project C, and widening B's scope at the final gate was the wrong trade. The limitation is documented. *Cost if wrong: C closes it.*

## Rulings I made that were later overturned by evidence — recorded because they are instructive

- **`toEqual` distinguishes absent from `undefined`.** It does not. Vitest treats an `undefined`-valued key as equivalent to an absent one, so a mutation-test step of mine proved nothing. This is load-bearing: `structuredClone` — how IndexedDB writes every record — **preserves** the key. Assert `'key' in obj` when absence is what you mean.
- **Derive citation pages from `readability.text`.** Wrong; see R-B5. Following it would have made every page pin `undefined` forever.
- **Two `RejectReasonModal` mounts are safe because they share a component.** They diverged on `initialReason` **inside this same sub-project**. Two mounts of one component still need one source for their inputs.
- **The debounced-save race is "a separate design decision".** Overstated; it was closed with one `scheduleSave` per direct write, because `activeRunSaverRef` was already in scope and the saver is arm-once/latest-payload-wins.

## The defect record, for whoever plans C

- Both Criticals were found only by the **whole-branch** review; every task had passed its own. One was an *incomplete fix to a defect already diagnosed and believed closed*; the other existed because one rule ("is this finding verifiable?") lived in two places that diverged. That rule is now extracted as `isVerifiable`.
- **Six tests passed against broken code** and were caught by mutation testing rather than by running them. A green suite was not evidence, exactly as `CLAUDE.md` says.
- The plan's *source* code held up; its *test* code and *integration* assumptions did not — they were drafted from memory of conventional idioms rather than from the files they would touch. **For C, D, E and F: draft test bodies against the file they will be appended to.**
