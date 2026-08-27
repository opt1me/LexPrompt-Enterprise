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

---

# Sub-project C — rulings made without owner review (2026-08-27)

Execution ledger: `.superpowers/sdd/2026-08-27-redesign-c-collections-and-net-positions/progress.md` (gitignored, disposable).

## Design decisions that still bind

- **R-C1. `Review.target.documentIds` is re-derived from `Review.documentIds` on every read.** `Review` holds the document list twice, and two copies of one fact is this project's most repeated defect shape. Rebuilding on read means they cannot drift no matter what wrote them. *Cost if wrong: a stored target's document list is ignored, which is the intent.*
- **R-C2. Collection membership is authoritative on the `Collection` record, never on `document.role`.** Grouping and ungrouping touch the record and the members' `role` as separate, non-atomic writes, so `role` is a denormalised convenience that can briefly disagree. *Cost if wrong: a stale `role` shows on a document chip.*
- **R-C3. `documentDate` never sorts a collection.** The order amendments take effect is a legal judgement someone recorded when they built the collection, not something to re-derive from dates that can be missing, wrong, or ambiguous. The date is displayed, never obeyed. *Cost if wrong: a user must reorder by hand.*
- **R-C4. `orderedMembers` and `buildCollectionPrompt` are generic over the document type.** Both were briefly forced through `as unknown as CollectionMember<DocumentRecord>[]` — an assertion true only because the function happened to read three shared fields, and one that would keep compiling the day someone read a field only one shape has. Widening the generic deleted the cast. *Cost if wrong: none; the cast was the risk.*
- **R-C5. A collection review keys findings by the collection id, through `findingsKeyFor`.** One position per clause however many documents fed it; keying by a document would force an arbitrary choice of which one "owns" the answer. *Cost if wrong: it was wrong six times, see below.*
- **R-C6. `extractCollectionClause` is a separate function from `extractClause`,** with its own prompt, schema and per-citation document resolution, so the single-document path cannot drift by sharing code that later special-cases collections. *Cost if wrong: two functions to keep honest instead of one.*

## Rulings I made that were later overturned by evidence

- **F-C7. The controller may revert a file while an agent is live.** It may not. I ran `git checkout -- src/lib/collectionPrompt.ts` to undo a mutation test while an implementer was working in the same tree, and took its prepared fix with it. **Standing rule: the controller runs no `git checkout --`, `git restore`, `git stash` or `git clean` while any agent is live.** Copy the file aside and back instead.
- **F-C25. `git add` may be given a directory.** It may not. A fix agent's `git add` swept four files belonging to a concurrently-running agent. **Stage by name; verify with `git show --stat HEAD`.**
- **A "focused tests only" policy is safe.** It stopped shared-tree contamination but removed the check that catches cross-suite regressions — a jsdom `scrollIntoView` gap broke 21 tests unnoticed. The controller must still run the full suite on a clean tree with nothing in flight.

## The defect record, for whoever plans D

- **Seven separate defects in C were one shape:** a correct mechanism with no path to it, or a key changed on the write side and not on the read side. Findings written under the collection id but read by document id produced an empty findings pane, human writes landing under a key nothing read, silently empty DOCX and CSV exports, and a retry that would have overwritten a synthesis with a one-document answer. **When you change how something is keyed, grep for every reader before you claim it is done.**
- **Browser verification found four more defects that 800 passing unit tests did not**, and one was Critical: the review migration rebuilt a `Finding` field by field and had never been taught about `netPosition`, so every reopened collection review silently discarded the entire output of this sub-project while the record on disk stayed perfectly intact. **A field-by-field rebuild needs a test per field.** The others: a citation click that ignored the citation's own `documentId` and so reported "couldn't locate this quote" about a quote one tab away; a raw user id printed at the reader; and a retry on a reopened review that re-runs against view-hydrated documents carrying no page images.
- **`documentFileForViewing` results are as unfit for extraction as raw `DocumentRecord`s** — both lack page images. The rule in CLAUDE.md named the type; it needed to name the hydration mode.
- **One of my own tests was vacuous and was deleted rather than kept.** It asserted behaviour an unrelated effect already guaranteed, so it passed against the unguarded implementation too. Deleting it with a comment saying why is better than a green assertion that proves nothing.

---

# Sub-projects D, E, F — rulings made while planning (2026-08-27)

Full reasoning lives in each sub-project's plan; these are the decisions that bind across sub-projects.

- **R-D1. With `Template.mode` retired, the risk block is gated on `clause.riskCriteria || version.riskTolerance`,** and the migration **clears** a stale `riskTolerance` on an `extraction`-mode playbook. A risk-mode playbook keeps its tolerance and so reviews identically; an extraction-mode one would otherwise silently gain criteria it never had, because the editor hid that field without ever clearing it. *Cost if wrong: an extraction playbook loses a string that was never used in a prompt.*
- **R-D2. Position health is a pure function over findings the caller already loaded,** not a store read. *Cost if wrong: one broader review read than strictly needed.*
- **R-D3. `extractCollectionClause` evaluates standard positions too,** against the net position it synthesises. The spec is silent on collections; leaving it out would mean a user sets a position, runs a collection review, and gets no comparison and no explanation — the "correct mechanism with no path to it" shape that produced seven defects in C. *Cost if wrong: one prompt block and two schema fields on a path the spec did not require.*
- **R-D4. `Review.playbookVersionId` is optional.** D's spec declares it required in §4 and requires it absent in §5 for a review whose playbook was deleted; the constraint wins, because a required field would force the migration to invent an id. *Cost if wrong: callers handle `undefined`, which they must anyway for pre-D reviews.*
- **R-D5. `Clause` becomes `PlaybookClause` with no back-compat alias.** A left-behind alias is sibling drift in slow motion. *Cost if wrong: a large but purely mechanical diff.*
- **R-D6. `generateTemplate`'s wire schema keeps its `prompt` key; only the domain field becomes `extractPrompt`.** `generateTemplate.ts:139`'s `prompt: generated.prompt` has our field on the left and the **model's** output field on the right — renaming the latter changes what the model is asked to produce, on a path nothing in D's plan tests. *Cost if wrong: the wire format and the domain type differ by one name, which is what a boundary is for.*
- **R-E1. E's session-only authoring object is `AuthoringDraft`, not `PlaybookDraft`.** D already claims `PlaybookDraft` for the mutable working copy persisted on `Playbook.draft`. The two have **opposite persistence rules** — D's is written to IndexedDB, E's must never be — so sharing a name is how someone writes half-reviewed model output into the store while believing the type forbids it. D keeps the name; D is planned and "a draft of a version" is the accurate reading. *Cost if wrong: a rename in E before it is implemented.*
- **R-F1. The DOCX tracked-changes detection fix is split out ahead of F and does not belong to it.** Spike 1 found that the shipped app reviews every marked-up `.docx` as though all changes were accepted, silently. F would inherit that; it is also a live defect worth fixing on its own account. *Cost if wrong: one small piece of work sequenced earlier than needed.*
- **R-F2. `jszip` is to be declared as a real dependency,** closing R-B7. Detection needs an unzip, and hand-rolling a zip read over `DecompressionStream` to save ~100 KB in a path that already lazy-loads pdfjs (479 KB) trades a maintained library for fiddly binary parsing in an app whose whole discipline is not being subtly wrong. *Cost if wrong: ~100 KB in the ingest chunk.*
- **R-D7. The pre-D playbook conversion runs once at startup through `migrateIfNeeded`, never lazily from a read path.** A draft of D's plan had `listPlaybooks`/`getPlaybook` publish the migrated v1 on first read, "mirroring `reviewMigration`". The analogy was false — `reviewMigration` is a pure repair that writes nothing — and the design races: two concurrent reads both see no `currentVersionId`, both publish, and the playbook ends up with v1 and v2 holding identical content, in the one sub-project whose purpose is making "which version did this review run against" answerable. `migrate.ts` already offers a durable-flag, startup-ordered, never-rejecting migration; D adds a separately flagged step so a user already migrated by sub-project A still runs D's. *Cost if wrong: one pass over the playbook store on the first load after upgrade.*
