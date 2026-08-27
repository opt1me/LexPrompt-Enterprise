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
