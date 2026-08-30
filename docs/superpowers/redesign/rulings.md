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
- **R-B7 — CLOSED (2026-08-27). `jszip` is now a declared dependency.** Superseded by R-F2 and closed by the tracked-changes detection fix: `detectDocxMarkup` unzips `word/document.xml` in app code, so the library is no longer test-only and could not honestly stay undeclared. Declared as a `dependency` (not a devDependency as this ruling anticipated) at the version already resolved transitively, `3.10.1`, so the lockfile change is two lines. It is imported lazily from inside `detectDocxMarkup`, so it lands in its own 97 kB chunk and never reaches the initial bundle. The original ruling (left undeclared because declaring it rewrites the lockfile, and a break would be a loud import error at test time) held only while nothing but a test used it. *Cost if wrong: ~97 kB in a lazily-loaded ingest chunk.*
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
- **R-E2 — The few-shot privacy disclosure sits on the picker, not in Settings.** Spec §10 requires it at the point of selection. Everything else in this app sends only the document under review; this sends *other matters'* content to the chosen model. The disclosure names that plainly, next to the checkboxes, and is not dismissible. Cost if wrong: one line of copy someone finds redundant.
- **R-E3 — SUPERSEDED during execution. `Save as v1` calls D's atomic `publishAndPoint`.** The premise below was true when E was planned and is false now: sub-project D's Task 9 fix round made `publishAndPoint` a single readwrite transaction over both stores, so there is no window to orphan a version and nothing to clean up. Original reasoning, kept for the record: Two writes cannot be one transaction across two stores here, so the order is chosen so the failure mode is recoverable: an identity with no version renders as a playbook with nothing in it, which is worse than nothing at all. Cost if wrong: a rare orphan record on a storage failure mid-save.
- **R-E4 — Navigating away warns via an in-app guard, not `beforeunload` alone.** `beforeunload` covers a tab close and a reload; it does not fire on an in-app route change, which is the far likelier way to lose a draft. Both are wired. Cost if wrong: one confirm the user finds mildly annoying.
- **R-E5 — `edited` is computed by comparing fields, never set by an onChange firing.** A focus-and-blur, or an edit typed and undone, must not count as "a human engaged with this". `edited: true` is a claim about how much a person actually did, and it feeds provenance. Cost if wrong: a clause reads as edited when it was only touched.
- **R-E6 — The disabled learn-from-redlines card is rendered, not hidden.** Spec §6. The handoff frames three parallel routes; hiding one misrepresents what the product is going to be. It says "not built yet" rather than being mysteriously inert. Cost if wrong: a visible affordance that does nothing yet, which is the honest state of affairs.
- **R-F1. The DOCX tracked-changes detection fix is split out ahead of F and does not belong to it.** Spike 1 found that the shipped app reviews every marked-up `.docx` as though all changes were accepted, silently. F would inherit that; it is also a live defect worth fixing on its own account. *Cost if wrong: one small piece of work sequenced earlier than needed.*
- **R-F2 — DONE (2026-08-27). `jszip` is declared as a real dependency,** closing R-B7. Detection needs an unzip, and hand-rolling a zip read over `DecompressionStream` to save ~100 KB in a path that already lazy-loads pdfjs (479 KB) trades a maintained library for fiddly binary parsing in an app whose whole discipline is not being subtly wrong. *Cost if wrong: ~100 KB in the ingest chunk.*
- **R-D7. The pre-D playbook conversion runs once at startup through `migrateIfNeeded`, never lazily from a read path.** A draft of D's plan had `listPlaybooks`/`getPlaybook` publish the migrated v1 on first read, "mirroring `reviewMigration`". The analogy was false — `reviewMigration` is a pure repair that writes nothing — and the design races: two concurrent reads both see no `currentVersionId`, both publish, and the playbook ends up with v1 and v2 holding identical content, in the one sub-project whose purpose is making "which version did this review run against" answerable. `migrate.ts` already offers a durable-flag, startup-ordered, never-rejecting migration; D adds a separately flagged step so a user already migrated by sub-project A still runs D's. *Cost if wrong: one pass over the playbook store on the first load after upgrade.*
- **R-F3 — DONE. `w:moveFrom`/`w:moveTo` are read as a move and labelled, never rendered as an unrelated deletion plus insertion.** `docxRedlines.ts` gives a move its own `RedlineEditKind` (`'moved'`), taking `w:moveFrom`'s text from `w:delText` and `w:moveTo`'s from `w:t` exactly as Word itself encodes them, rather than letting either fall through to the ordinary insertion/deletion handling. A clause relocated within a document, presented as "deleted here, inserted there," invites a reader to infer a negotiation — a change of substance — that never happened; a move is Word's own distinct signal that nothing about the wording changed, only its position. Mutation-tested: dropping the dedicated `moved` handling makes the test asserting zero `deletion`-kind edits from a move fixture fail. *Cost if wrong: one extra edit kind to render, which is what shipped.*
- **R-F4 — DONE. A chain, and a document's role within it, is never auto-confirmed however strong the heuristic.** `chains.ts`'s `proposeRole` has no code path that returns `inferred: false` — an "executed" or "their draft" hit in a filename is exactly as provisional as a filename it cannot classify at all, so the UI's "what is this?" prompt fires on every document, not just the ambiguous ones. Chain grouping is correspondingly conservative: two filenames chain together only when they reduce to the exact same stem once every role/version word is stripped, never by fuzzy match — a wrongly-merged chain would feed `strength.ts` votes from a document that was never part of that negotiation. *Cost if wrong: one confirmation click on a chain and role that were, in fact, obvious.*
- **R-F5 — DONE. Evidence grouping is the model's job; evidence counting is not.** `inferPositions.ts` asks the model only for `clause_title`/`statement`/`edit_ids`/`opposing_edit_ids` — no `strength`, `supporting`, or `total` field exists in the schema the model can populate, and one returned anyway is never read. `resolveGroup` resolves the model's `edit_ids` against the caller's real edit list itself; an id the model invented or that does not resolve is silently dropped rather than trusted into the basis, and a group left with zero resolvable edits is dropped entirely rather than kept as a position with an empty basis — which would be silence wearing a position's clothes. `buildChangeset.ts`'s `resolveItem` mirrors the identical split for the changeset path. *Cost if wrong: a group loses an edit the model meant to include, which can only understate a position's strength — the safe direction to be wrong in.*

The three below belong to the tracked-changes prerequisite, not to sub-project F. They were written as `R-F3`–`R-F5`, which F's own plan had already assigned to different decisions (a Word move's rendering, never auto-confirming a chain, and evidence grouping versus counting). Renumbered `R-TC*` on merge so the two sets cannot be read as one — see `R-F3`–`R-F5` above (added at Task 11) for what those numbers actually record in F itself.

- **R-TC1. `detectDocxMarkup` also matches `w:moveFrom`/`w:moveTo`, one marker beyond the fix brief's three.** A move is a tracked change that produces neither a `w:ins` nor a `w:del`, and mammoth has no handler for either element, so a moved clause is exactly the "text whose provenance the app quietly changed" the fix exists to disclose. Spike 1 named moves as a gap to be stated rather than silently mis-rendered; one regex states it. It cannot make the notice wrong — the notice describes what happens to a moved passage too. *Cost if wrong: a document containing only a move shows a caveat that is arguably over-broad, on the loud side of the failure.*
- **R-TC2. The notice is stored on the record, not re-derived on read.** Re-checking every document's blob on every list render is not proportionate, and the alternative — back-filling old records — would mean guessing on their behalf. Documents added before the check carry no field, and the README says why. *Cost if wrong: pre-existing documents stay unchecked until re-added.*
- **R-TC3. `markupNotice` does not reach the DOCX/CSV exports in this change.** The brief scoped the disclosure to the two screens where someone reads findings; an export column is a wording decision that belongs with `findingOutcome.ts`, whose rule is that export wording lives in exactly one place. Naming it here so it is a known gap rather than an oversight. *Cost if wrong: a report emailed onward does not carry the caveat the app shows on screen — which is a real gap, and the reason this is recorded rather than dropped.*


---

# Sub-project C, fix round 2 — rulings made without owner review (2026-08-27)

The owner ruled on all seven re-review findings directly. These are the sub-decisions taken inside those rulings.

- **R-C2R1. A trail step that names an UNAVAILABLE member is discarded, not counted and not rendered.** The owner's ruling required alignment over the present members; it did not say what to do with a step for an absent one. Discarding it is not leniency: the model was never sent that document's text, so the sentence can only be invented, and printing invented text as a document's own legal effect inside a derivation is the failure the derivation exists to prevent. The app's deterministic "this document is unavailable" wording replaces it. Every misalignment C1 named still fails. *Cost if wrong: a model's guess about a document nobody has is dropped in favour of a statement of fact.*
- **R-C2R2. `buildCollectionPrompt` now asks for one entry per document whose text was SENT, and says not to write one for an UNAVAILABLE member.** The request has to match the contract the response is checked against, or a compliant model fails every clause — which is how MJ1 happened in the other direction. *Cost if wrong: a model that emits the extra entry anyway is covered by R-C2R1.*
- **R-C2R3. Accepting a stringified DOCUMENT number tightens the CITATION path as well as loosening the step path.** `"9"` on a citation used to be unreadable and fall through to quote-match recovery; it is now an explicit out-of-range claim and is dropped, exactly as `9` always was. That is the point of the two paths sharing one helper, and the doc comment already said an explicit wrong claim is not recovered by guessing. *Cost if wrong: one quote lost from a response that both stringified its numbers and got one wrong.*
- **R-C2R4. `truncationLabel` is gated on `isVerifiable`, so an error finding exports no truncation caveat.** A caveat qualifies an answer and an error finding has none; its own "could not be reviewed" text is already the loud failure, and `FindingCard`'s error branch returns before the truncation notice, so screen and export agree. *Cost if wrong: a reader of an errored clause is not told the source text was also cut short, having already been told the clause was not reviewed.*
- **R-C2R5. mn6 was fixed, not documented.** The owner offered either. Carrying truncation into both exports through the shared wording module was chosen because the DOCX is what leaves the app — a reader of one cannot check the screen — and because §11 names a silently truncated deed of variation as the way a collection produces a confidently wrong answer. A README limitation would have left the most dangerous case visible only to the person who ran the review. *Cost if wrong: one more caveat row in a report, on findings that carry the flag.*
- **R-C2R6. `safeFileName` lives in `findingOutcome.ts` beside `collectionExportLabel`.** A filename is not "wording", but a second home for export naming is exactly the drift that produced mn4. *Cost if wrong: one general-purpose helper sits in a module named for findings.*


## Sub-project C — residuals adjudicated at close (2026-08-27)

- **R-C3R1. `FindingCard`'s truncation sentence and `truncationLabel`'s export caveat are allowed to stay separate.** Raised by the fix-round-2 agent as "two statements of one fact", which is normally this project's most repeated defect. Adjudicated as acceptable because the thing that must not drift — *whether* a caveat appears, and *which* documents it names — is single-sourced on the `Finding` (`truncated`, `truncatedDocuments`), and both read it. What differs is register: an ALL-CAPS bracketed export caveat is wrong inside a styled UI panel, and a UI sentence is wrong in a spreadsheet cell. `verificationLabel` exists because the DOCX and CSV — two *exports* — disagreed about a rule; this is one export and one screen agreeing on the rule and differing in voice. *Cost if wrong: the two wordings drift in phrasing while continuing to agree on when to appear; a reader sees the caveat either way.*
- **R-C3R2. The `markupNotice` from the tracked-changes prerequisite does not yet reach the exports (R-TC3), and that stays open into the next piece of work.** A DOCX emailed onward still carries findings derived from accepted-changes text with no caveat. It belongs in `findingOutcome.ts` beside the labels that already single-source export wording. Recorded here rather than parked silently, because it is the same class of gap C spent two review rounds closing for net positions. *Cost if wrong: the most dangerous export the app produces omits a caveat the screen shows.*
- **R-D8. `PlaybookVersion` and `Playbook` carry `schemaVersion`, which D's spec §4 interfaces omit.** Raised by Task 2's reviewer as brief-vs-spec drift, and it is drift — I added it when writing the plan without noting that the spec had not. Kept, because the spec itself bumps `SCHEMA_VERSION` 5 → 6 for this sub-project, and a version bump means nothing unless the records it governs record which version wrote them; the pre-D `Template` carried one, and every repair-on-read path in this codebase (`migrateReviewRecord`, `migrateDocumentRecord`, `migratePlaybookRecord`) exists to upgrade records that do. Omitting it would make D the first persisted shape with no way to tell when it was written, in the sub-project whose entire subject is knowing which version produced something. *Cost if wrong: one field per record that nothing reads until the next migration needs it.*
- **R-D1 — CORRECTED during execution (Task 3).** As I wrote it, the migration gated `riskTolerance` on `t.mode === 'risk'`, treating a missing mode as extraction. But `migrateDraft` also repairs **post-D** records on read — drafts and published versions, which have no `mode` at all, because `mode` was retired. So the rule as specified would have silently stripped `riskTolerance` from every already-migrated playbook on every read, compounding on each one. The correct gate is `!hadMode || mode === 'risk'`: every pre-D record carries an explicit mode (the old `playbooks.ts` `migrate()` wrote one on every read), so modeless implies post-D implies keep. Caught by the implementer trusting the code over my brief. *Cost if wrong: as originally written, cumulative silent loss of a user's risk tolerance.*
- **R-D9. The pre-D conversion is one readwrite transaction over BOTH stores, with the record re-read inside it.** R-D7 moved the conversion out of read paths to stop two concurrent reads publishing twice. That was necessary and insufficient: the implementer's browser verification showed two `migrateIfNeeded()` calls on the same tick — React StrictMode's double-invoked mount effect, or a second tab — both publishing, leaving one playbook holding v1 and v2 with identical content. The durable flag cannot defend this, because both calls read it before either writes. The transaction can. It also adopts an orphaned version left by an older build rather than publishing a second copy of the same content, and preserves `_seq`, `createdAt` and `updatedAt`, because converting a playbook is not the user editing it and must not reorder their library. Required splitting `publishVersion` into a store-handle form (`publishVersionIn`, the `seq.ts` pattern) so the allocation logic is not duplicated. *Cost if wrong: none identified; it is strictly stronger than the flag alone.*


---

# Sub-project D, Task 3 fix round — rulings made without owner review (2026-08-27)

The owner ruled on eight of the ten review findings directly. These are the
sub-decisions taken inside those rulings, plus the two left to my judgement.

- **R-D1 — EXTENDED to `clause.riskCriteria` (M1).** The ruling cleared a stale
  playbook-level `riskTolerance` on an `extraction`-mode record because the pre-D
  editor hid that field without ever clearing it. The per-clause "Risk Scorer"
  field sat inside the *same* `{isRiskMode && …}` guard and was never cleared
  either, so the reasoning applies verbatim one level down. `migrateClause` now
  takes the same `keepsRisk` decision, defaulting to KEEP so a modeless (post-D)
  record is untouched. *Cost if wrong: an extraction playbook loses a per-clause
  string that was never used in a prompt.*
- **R-D10. The `'General commercial reasonableness.'` default is materialised at
  migration, not restored as a fallback in `riskCriteriaBlock` (Minor 4).**
  Pre-D the whole risk block was gated on `mode`, so a `mode: 'risk'` playbook
  with no tolerance and no clause criteria still sent that generic block. It
  cannot be a fallback in `riskCriteriaBlock`, because presence is what decides
  post-D and a fallback there would switch the block on for every playbook
  authored after `mode` retired. `migrateDraft` writes it onto the
  `riskTolerance` of a record that carried an explicit `mode: 'risk'`, which
  reproduces the pre-D prompt exactly — clause criteria still win, and a clause
  without any gets the default. `DEFAULT_RISK_TOLERANCE` lives in `riskBlock.ts`,
  where risk-block wording lives. *Cost if wrong: a migrated risk playbook that
  genuinely wanted no criteria sends a generic sentence it did not ask for —
  which is what it sent yesterday.*
- **R-D11. `getPlaybookContent` throws rather than returning `null` for a record
  still carrying pre-D content keys (M3).** `null` means "never published" and
  the editor answers it with a blank draft, whose next Save publishes an empty
  v1 and `put`s the real clauses away. The editor cannot tell that apart from
  "has content that was never converted", so the store does:
  `carriesUnconvertedContent` reads the RAW record (a migrated one has the
  evidence stripped) and `UnconvertedPlaybookError` joins `DbBlockedError` on
  `describeLoadError`'s pass-through side, because it names a specific
  recoverable situation. Not reachable today — the conversion is atomic and
  `migrateIfNeeded` failing blocks the app — but it is the one thing standing
  between a mis-ordered statement in `migrate.ts` and a user's playbook being
  silently emptied. *Cost if wrong: a playbook that somehow carries both a
  version pointer and pre-D keys would still open, since the pointer wins the
  guard.*
- **R-D12. `publishAndPoint` is the one path that publishes a version (Minor 1,
  Minor 2).** `publishVersion` then `savePlaybook` were two transactions in both
  everyday paths, and for `importPlaybook` a failure between them left a version
  with **no identity record at all** — permanently unreachable, since the only
  thing that adopts orphans is the startup conversion and it only looks at
  playbooks that exist. Extracted at two, not at three. `seq.ts`'s `SeqStore`
  gained a `TxStores` parameter (defaulting to `[StoreName]`) so a `_seq` can be
  allocated inside a two-store transaction — the same widening `publishVersionIn`
  already carries; a readonly handle and a `db`-level wrapper are still compile
  errors, checked. Publishing also CONSUMES `Playbook.draft`: dormant until Task
  9 wires `saveDraft`, and live the moment it does. `publishVersion` is kept as
  the unit the `playbookVersions` suite exercises for spec §9, with a docstring
  sending app callers to `publishAndPoint`. *Cost if wrong: one more function on
  the store, and a publish that also clears a draft nobody wrote yet.*
- **R-D13. `deletePlaybook` cascades to the playbook's versions (Minor 6, left to
  my judgement).** They were unreachable — nothing enumerates versions except
  through a playbook that no longer exists — and unbounded. The cascade is
  `deleteMatter`'s shape: one transaction, the record plus what only it owns. It
  does not conflict with "never delete what you cannot read", which quarantines
  data we cannot make sense of, not readable records whose owner the user
  explicitly discarded; and it loses no review history, because a `Review`
  carries its own `playbookSnapshot` — exactly what spec §5 means by "a review
  whose playbook was deleted still opens on its snapshot", and why R-D4 makes
  `Review.playbookVersionId` optional. *Cost if wrong: a future "restore a
  deleted playbook" feature has nothing to restore, and Task 8's version history
  cannot show versions of a playbook the user deleted.*
- **R-D14. The migration-blocked screen names a store per failed step (Minor 5).**
  `MigrationResult` gained `phase`. Step 1 reads v1's localStorage, which is
  never deleted; step 2 converts records already in IndexedDB and is safe
  because each conversion is one all-or-nothing transaction. With no phase — the
  defensive catch around a rejecting `migrateIfNeeded` — the wording names no
  store at all rather than guessing. *Cost if wrong: a user reads a slightly
  vaguer reassurance in the one case where no step could be identified.*
- **The M2 reset is keyed on LEAVING the route, not on reopening (M2).** The
  owner asked for `handleOpenTemplate`'s old reset restored "in whatever form
  suits the new routing". Putting it back on the open would have covered the
  library card and nothing else; keying it on `playbookRouteId` becoming null
  covers the Close control and the browser Back button, and both have a test.
  The two route effects are mutually exclusive on that same value, so neither
  can clobber the other however they are later reordered — the hazard CLAUDE.md
  names. *Cost if wrong: an unsaved draft is dropped by a navigation the discard
  prompt did not cover, which is the prompt's bug, not this one's.*

- **R-D15. `Review.playbookVersionId` may DANGLE, not merely be absent, and every reader must treat it that way.** Task 3's Minor 6 made deleting a playbook cascade to its versions (right on the merits — the versions were otherwise unreachable and unbounded, and spec §5's snapshot rule means no review history is lost). The consequence its re-review caught: a review that ran against a deleted playbook's v3 still carries an id that now resolves to nothing. D's spec §5 contemplated an id being *absent* where the playbook never existed; it never contemplated a *stale pointer*. So "ran against v4" must never be rendered from the id's presence alone — the version has to be fetched and the miss handled honestly ("the playbook version this ran against has been deleted"), exactly as a review whose document was deleted still opens on its snapshot. Falls to Task 4, which introduces the field, and Task 10, which renders the header link. *Cost if wrong: a review header asserts a version that no longer exists, or a version-history link leads nowhere.*
- **R-E7. `AuthoringDraft` carries no `systemPrompt`/`formatPrompt`, and `toPlaybookDraft` supplies the same defaults a brand-new playbook gets.** A real gap in E's spec §4, found by Task 1's implementer rather than by me: D's `PlaybookDraft` requires both fields and E's authoring object defines neither, so the conversion had to invent something. Defaulting is the right answer *as the spec stands* — §5 says the generation call returns a **clause list**, not review instructions, and D's editor (Task 9) is where a user changes a playbook's persona and format rules afterwards. The alternative, having the model draft them too, is a scope increase E never asked for and would put un-reviewed model text into the instructions every future review runs on — the precise thing E's save gate exists to prevent. The constants are defined locally rather than imported from `db/playbooks.ts`, which would drag IndexedDB's connection module into a deliberately pure module. **Task 2 (generation) should confirm it does not intend to produce these fields**; if it does, this ruling is superseded. *Cost if wrong: a drafted playbook starts with generic review instructions the author edits, instead of tailored ones.*
- **R-D16. Draft persistence is wired on explicit intent, never per keystroke — and the deferral is recorded here rather than in a gitignored report.** Task 9 shipped five draft mechanisms with no writer (`saveDraft`, `Playbook.draft`, `loadPlaybookForEdit`'s draft preference, publish-consumes-draft, and `TemplateLibrary`'s "Unpublished changes" badge, which could therefore never appear). Its implementer deferred wiring them and its reasoning was sound — per-keystroke persistence contradicts the in-memory discard semantics Task 3's fix round established, which five App tests cover. But the deferral lived only in a `.superpowers/` report, which is gitignored and disposable, so nothing durable recorded that a shipped badge was unreachable. Task 9A wires it on explicit intent: a `Save draft` control, and a three-way leave prompt (Keep / Discard / Cancel) where **Discard clears the stored draft too** — otherwise "discard" leaves the rejected edits durable and the next open resurrects them, which is the defect Task 3's M2 fixed in memory, one layer down. *Cost if wrong: a draft survives a reload only when the author asked for it to.*
- **R-D17. A standard position's health is dated from the version in which that clause's position TEXT last changed, not from the current version's `publishedAt`.** `positionHealth` discards verifications older than the date it is given, so dating from the current version would report `UNTESTED` for a position tested for months every time an unrelated clause is republished — publishing v5 to change clause B would silently erase clause A's evidence. This is the difference between "nobody has tested this" and "we forgot what we knew", and the first is a claim the app would be making falsely. *Cost if wrong: computing the dating is more expensive than reading one timestamp; the documented fallback is the earliest version containing the current text, stated rather than silently substituted.*

---

# Sub-project D, Task 9 fix round + Task 9A — rulings made without owner review (2026-08-27)

Task 9's review found 4 Major and 8 Minor, and that three things D's spec
and DoD require were owned by no task in the 13-task plan. R-D16 and R-D17
were written by the controller before this work; these are the decisions
taken inside them, plus the ones the fixes required.

- **R-D17 was implemented in full, not by its documented fallback.**
  `positionPublishedAt` walks back from the newest version while the
  clause's position text is unchanged, so a position is dated from the
  version its own wording last changed in. Recording this because R-D17
  required the fallback (the earliest version containing the current text)
  to be *stated* rather than silently substituted; it was not needed.
  *Cost if wrong: one pass over a playbook's versions per editor open.*
- **R-D18. `saveDraft` takes the identity RECORD, not a playbook id.** The
  brief's tests call `saveDraft('pb-1', draft)`, but the id-only form reads
  the store and throws "that playbook no longer exists" when it finds
  nothing — which is the *common* case, not a rare one: a playbook created
  in this session is not written until its first save, so every brand-new
  playbook (including one that has just cost a ~30s paid AI generation)
  would have been refused. The value form mirrors `publishAndPoint`, which
  takes the identity for exactly this reason, and the old guard's stated
  worry ("a draft nothing can publish") does not survive the change, since
  `publishAndPoint` would publish the recreated record normally. Its test
  is deleted with the reasoning in place. *Cost if wrong: a playbook
  deleted in another tab is recreated, carrying the draft its editor was
  still open on, rather than the edits being lost with a message.*
- **R-D19. The three-way leave prompt is two native confirms, not a modal.**
  `confirmDiscardIfDirty` is also `useRoute`'s popstate guard, and a Back
  press has already moved the address bar by the time it runs — so the
  answer must be synchronous and there is no await to be had. One
  implementation serves the Close control, a nav click and Back alike;
  giving the two async-capable paths a modal would be two guards to keep
  honest. Both writes (Keep's save, Discard's clear) are therefore fired
  without being awaited and report failure through their own toast.
  *Cost if wrong: two stacked browser dialogs where a designed one would
  read better, and a save whose failure is reported after the screen has
  changed.*
- **R-D20. `VersionHistory.tsx` is STARTED by Task 9A, not duplicated.**
  Spec §8's editor link needs a destination and Task 10 owns the screen, so
  Task 9A writes the file Task 10 extends rather than a temporary block
  Task 10 must remember to delete. Two things it deliberately omits, both
  Task 10's: `matterNamesByVersion`, and each version's author — the record
  carries `publishedByUserId`, and a raw user id printed at the reader is a
  defect this project has already shipped once, so resolving it belongs
  with the screen that has the profile to hand. Its `error` prop is a
  `string` rather than the plan's `unknown`, matching every other load site
  in `App.tsx`, which classifies through `describeLoadError` first.
  *Cost if wrong: Task 10 widens a prop instead of writing a file.*
- **R-D21. `PublishDialog`'s `busy` guard was deleted rather than tested.**
  The review mutation-confirmed the test covering it was vacuous: `Button`
  sets `disabled = disabled || loading`, so the button refuses the click
  before the guard is reached. The guard could not have covered the race it
  appeared to either — `busy` is a prop, so it is still false for the whole
  tick in which a double-click lands. An in-flight ref, written
  synchronously, closes the real race, and the deleted test's reasoning is
  left in the file (the precedent is `playbooks.test.ts`). *Cost if wrong:
  a publish is refused while an earlier one is still in flight, which is
  the intent.*
- **R-D22. Publish is gated on the draft's serialised content differing from
  the version's, compared WHOLE rather than field by field.** A field-by-
  field comparison that forgot a field added later would report "no
  changes" over a real edit and leave Publish disabled with no explanation —
  the user could not publish at all. Stringifying both through
  `draftFromVersion` puts anything the comparison does not understand on
  the "changed" side, which is the safe direction. *Cost if wrong: a draft
  whose key order differs from the version's is treated as edited, which is
  what it was treated as before.*
- **R-D23. `StandardPositionField` renders `provenance` for every origin,
  not only `learned` (m5).** Spec §8 attaches provenance to learned
  positions; the field shows it wherever it is set. Kept as-is and recorded
  rather than narrowed: provenance is free text naming where a position came
  from, and hiding it on an authored or suggested position would withhold
  something the author themselves wrote. *Cost if wrong: one line of
  presentational text appears on positions the spec did not anticipate it
  on.*
- **R-D24. `TemplateEditor`'s `onSaveDraft` is renamed `onDraftChange`, and
  the new persisting callback is `onPersistDraft`.** The old name described
  an in-memory setter, which is how a future reader wires a `Save draft`
  button to the wrong callback. Both `onPersistDraft` and
  `onShowVersionHistory` are REQUIRED props, not optional ones: an optional
  callback is exactly how five draft mechanisms and a version-history link
  came to ship with nothing behind them. *Cost if wrong: a mechanical
  rename across one component and its tests.*

## Task 9A re-review fixes (2026-08-27)

- **R-D25. A finding counts towards a standard position only if BOTH the
  version its review ran against carried that exact wording AND the
  verification is dated at or after the wording was published.** Spec §7
  states the second half only, and `buildPositionHealthMap` shipped with the
  first half missing: it filtered reviews by playbook membership alone, so a
  reviewer who opened an old review and verified a finding produced under
  v1's "Six months." passed both filters after v2 published "Nine months.",
  and the editor reported **HELD 1 of 1** for a sentence no document had ever
  been measured against. R-D17 closed the false-`UNTESTED` direction
  (evidence wrongly discarded); this is the opposite one, and it is worse —
  evidence wrongly *counted* is the app stating a confident falsehood about
  the firm's own standard, on the screen whose whole purpose is answering
  "has this position ever been tested". Neither filter subsumes the other:
  the wording filter catches a verification made LATE against superseded
  text, the date filter catches one made EARLY against text since reverted
  to, and each has a test that fails when the other is removed. *Cost if
  wrong: one `find` per clause per relevant review on each editor open; and
  in the conservative direction only — a review whose version cannot be
  resolved counts for nothing, which reads `UNTESTED`, which is true.*
- **R-D26. `LoadErrorPanel.onRetry` is optional, and the MESSAGE is the
  invariant part.** Two call sites guarded their error branch on
  `error && onRetry`, so a caller with a failure and no retry handler fell
  through to its EMPTY state — "Nothing published yet" over a playbook with
  published versions, and health chips as though the scan had succeeded and
  found nothing. That is the empty-versus-broken confusion produced by the
  guard written to prevent it. Rather than making the callback required at
  each site (R-D24's remedy, which does not survive a caller passing
  `undefined` and does not generalise to the next component), the shared
  panel now renders its Retry only when there is something to retry, and
  every error branch turns on the error alone. Every call site in the app
  today still passes a retry. *Cost if wrong: a load error somewhere could
  render as a dead end with no retry button — visible, specific and
  recoverable by reloading, where the behaviour it replaces was an empty
  state that read as a fact.*

## Known, recorded, not closed here

- **A stored draft comes back from `migrateDraft` with `changeSummary` set
  to `IMPORTED_SUMMARY` when it was saved empty.** `migrateDraft` invents
  that string for a content record with no summary, which is right for the
  pre-D conversion it was written for and wrong for a round-tripped draft.
  The visible effect is small — a reopened draft compares as differing from
  its version even if the user undid every edit, so Publish stays enabled —
  and changing `migrateDraft` touches the pre-D conversion, so it is
  recorded rather than fixed at the end of a fix round.

  **It reaches export, which this entry originally missed. Task 11 owns the
  fix at the latest.** `handleExportTemplate` serialises the draft verbatim
  (`exportPlaybook`), so a playbook with a stored draft exports
  `"changeSummary": "Imported from before versioning."`, and `importPlaybook`
  keeps any non-empty summary — so an export→import round trip publishes a
  **v1 whose change summary claims a provenance that never happened**, in the
  sub-project built to make version history trustworthy. Still Minor: v1's
  summary is optional and cosmetic, and `handlePublishTemplate` overrides the
  draft's summary with the dialog's, so the string can never reach a
  published version by any path inside this browser. *Cost if wrong: a
  reopened draft compares as differing from its version even after the user
  undoes every edit, so Publish stays enabled; and an imported playbook's v1
  states a false origin.*
- **`discardDraft` bumps `updatedAt`, so discarding a draft reorders the
  library.** The row then reads "Updated <today>" over content published
  weeks ago. Kept deliberately: the alternative is a second writer
  duplicating `savePlaybook`'s transaction-scoped `_seq` allocation, which is
  precisely the sibling drift CLAUDE.md names (`matters.ts` reproducing
  `playbooks.ts`'s sequence allocation *without* its transaction scoping is
  the recorded example). A discard IS a write to that playbook, so the
  timestamp is not false — only uninformative. *Cost if wrong: a library row
  sorts a few places higher than the reader expects; nothing about the
  playbook's content is misstated.*
- **`positionHealth`'s `no-position` kind is unreachable from the UI, and
  stays.** `buildPositionHealthMap` omits a clause with no standard position
  from the map entirely rather than giving it a `no-position` entry: the
  editor renders a chip per entry, and "we have no house rule here" is the
  absence of the question rather than an answer to it — a `NO POSITION` chip
  on every unpositioned clause would be noise. The union member is NOT
  deleted. It is the honest fourth state, `positionHealthLabel` must stay
  exhaustive for the type to compile, and a later surface (a firm-wide
  positions report, say) may well need to say it out loud. *Cost if wrong: a
  union member and two unit tests that no screen currently reaches.*
- **Nothing in this round was verified in a browser.** Draft persistence,
  the three-way leave prompt, the health chips and the version-history modal
  are unit-tested only. Task 13's browser checklist gains steps for all of
  them.
- **R-E8. The old `CreateTemplateDialog` + `generateTemplate` path is DELETED, not left beside E's route.** E Task 6's implementer removed all three files when the route chooser took over `Create Template`, and the reasoning is stronger than "nothing calls them any more". `generateTemplate` returned a `PlaybookDraft` **directly**: a user could generate a playbook with AI and save it with one click, never seeing a clause. That is precisely what E exists to make impossible — its spec says *an AI first pass is a draft, never a saved playbook, until the lawyer has been through every clause* — so leaving the old dialog in place would have left a documented gate with an undocumented way around it. Verified before accepting: zero references remain anywhere in `src/`, and the AI-generation capability survives in `generateDraft`, which routes through the review screen. *Cost if wrong: recoverable with `git checkout 21cbc36 -- <paths>`; the capability is not lost, only its ungated entrance.*


---

# Sub-project G — rulings made without owner review (2026-08-28)

Full reasoning lives in `docs/superpowers/specs/2026-08-28-redesign-g-visual-reskin.md`;
these are the decisions that bind. Three genuine scope forks were NOT ruled on and are
put to the owner as decision points in that spec §17: phone parity in G or a
sub-project H; the two-to-three-pane review relayout; and whether the `Standard
positions` nav tab is built at all.

Recorded in `docs/superpowers/redesign/rulings.md`'s format. Each carries its
cost-if-wrong.

- **R-G1. Every multi-user affordance in the prototypes is dropped or resolved to the
  local profile, per §7's table.** Dropped: the "assigned to me" counter and badge, the
  assignee chip and assign action, the firm tag, the mobile `Assigned` tab, and
  "flagged *for* X" phrasing. Kept and resolved single-user: attribution ("Rejected by
  you"), the avatar (local initials), and the activity feed as a derived, single-actor,
  never-stored matter history that renders an explicit empty state rather than a
  placeholder row. *Cost if wrong: the app photographs less like a firm-wide product.
  The opposite error has a lawyer waiting on a review nobody was asked for — a silence
  the app manufactured — which is why the asymmetry decides it.*
- **R-G2. Colour tokens live in two layers, and the palette layer is deliberately
  unreachable from components.** Raw values are plain `:root` custom properties
  (`--lex-*`) that generate no Tailwind utilities; only the semantic layer sits in
  `@theme` (`--color-risk-high`, `--color-accent`, `--color-ink-4`, …) and therefore
  only semantic names exist as utilities. `bg-oxblood` is not a class anyone can type.
  This mirrors `seq.ts`'s type-enforcement idiom: make the wrong thing fail rather than
  documenting that it is wrong. Arbitrary-value escapes are closed by the palette guard
  test. *Cost if wrong: one extra indirection in `index.css`, and a role must be named
  before it can be used — which is the point.*
- **R-G3. Fonts are self-hosted from `public/fonts/`, never hotlinked from Google.**
  The app's own disclosure states that nothing leaves the browser except calls to
  OpenRouter; a font `<link>` to a third-party CDN would make that sentence false for
  every page view, in an app whose founding rule is not being quietly wrong. Latin
  subset, woff2, `font-display: swap`, real fallback stacks, total budget ≤350 KB. No
  npm dependency: the files are vendored. *Cost if wrong: ~350 KB of static assets in
  the deploy and a manual step to update a font version.*
- **R-G4. Semantic roles are named by meaning, not appearance, and `verified` uses the
  accent teal (`#14574f`) while `low risk` uses the green (`#2c6448`).** The handoff is
  explicit and the distinction is load-bearing: teal means a human confirmed something;
  green means the model rated something low. *Cost if wrong: two nearby colours a user
  may read as one — which is exactly why they also differ in chip shape (R-G16).*
- **R-G5. Copy carrying a disclosure or a failure state is frozen (§8.4), and where a
  prototype's wording differs, the shipped wording wins.** Uppercase presentation is a
  CSS decision; the string is not, because several frozen strings are printed into a
  DOCX or a CSV cell where the chip's styling does not exist. *Cost if wrong: some
  screens read slightly less like the mockups.*
- **R-G6. The permitted copy changes in G are enumerated, and each is a declared test
  change.** They are: the nav's `Library` → `Playbooks`; the playbook editor's derived
  coverage line ("*n* of *m* clauses have a standard position"); the export-gate
  banner (§10.3); the intake wizard's step labels; and the `Standard positions` tab's own
  strings. Everything else in §8.4 is frozen. *Cost if wrong: a handful of test
  assertions updated in commits that declare themselves as copy changes rather than
  restyles.*
- **R-G7. One palette. No dark theme, no theme toggle.** The redesign is a paper
  aesthetic and the whole point is legal prose that reads like a document. A toggle
  would double every contrast check and every browser verification. *Cost if wrong:
  users who preferred the dark app lose it; adding a theme later is a second set of
  values under a `[data-theme]` selector, which the two-layer token structure makes
  cheap — that is much of why the structure is worth having.*
- **R-G8. The comparison grid (`1e`) was already rebuilt in sub-project C; G restyles
  it and must not rebuild it.** The brief that commissioned this spec lists `1e` as a
  deferred screen. It is not: `TabularReview.tsx` already has the per-column risk
  mini-bar, the un-truncated sentence per cell, separated risk and verification, and
  "Open in review". Recorded loudly because rebuilding it would silently discard C's
  `findingsKeyFor` collection handling — the source of six defects in C. *Cost if wrong:
  none; verified by reading the component.*
- **R-G9. The activity feed is derived at read time and never stored.** Its inputs
  (`verification.at`, `Note.at`, `netPosition.confirmedAt`, `Review.startedAt`) already
  exist and already carry an author. Storing an event log would create a second account
  of what happened that can drift from the findings themselves. *Cost if wrong: the
  feed shows only what the current data model timestamps — no "you opened this" events —
  which is the honest subset anyway.*
- **R-G10. The matter stat row renders an empty form when no review has completed, and
  is replaced by the load-error panel when reviews fail to load — never three zeroes.**
  Zero verified of zero is not a fact about a matter's safety; it is the "empty
  indistinguishable from broken" shape CLAUDE.md's load rule exists to prevent, at the
  top of the screen that exists to say how checked the matter is. *Cost if wrong: one
  extra branch per stat card.*
- **R-G11. The `Report` segmented tab is dropped; export stays a button producing a
  file.** A `Report` tab advertises a live report view the app does not have, and the
  handoff never draws one. *Cost if wrong: a segmented control with two options rather
  than three.*
- **R-G12. The intake wizard ships without the AI playbook suggestion.** The mockup's
  "These look like a commercial lease…" banner is a model call with a prompt contract,
  a cost, and a failure mode (a confidently wrong playbook choice at the moment the
  user is least able to judge it). None of that is a styling decision. Step 3 lists the
  user's playbooks, most-recently-used first. *Cost if wrong: one fewer convenience on
  the first-run path; adding it later is additive and belongs with E's generation code.*
- **R-G13. No OCR progress UI.** The app does not OCR. Drawing a progress bar for work
  it does not perform is precisely the failure §2 forbids. A scanned document says it is
  scanned and says a vision-capable model is needed — the fact `modelContext.ts` already
  enforces, stated once before the run rather than once per clause after it. *Cost if
  wrong: the intake screen looks less capable than the mockup, and is more honest.*
- **R-G14. `⌘K` global search is deferred, and G renders no search box.** It is a
  cross-entity index over matters, clauses and findings — a subsystem, not a style. A
  visible-but-dead search box is worse than none. *Cost if wrong: the top bar has a gap
  where the mockup has a control.*
- **R-G15. `Compare to v3` (playbook version diff) is dropped.** Named as an action in
  `4c`, drawn nowhere. `VersionHistory` already carries each version's human-authored
  change summary, which is the account that means something; a structured diff of two
  prompt strings asserts less than it appears to. *Cost if wrong: a version history
  without a diff view, which is what ships today.*
- **R-G16. The three chips differ in shape, not only in hue.** `RiskChip` is a filled
  dot plus a label with no border; `StateChip` is a lucide icon plus a label in a
  hairline-bordered chip fill; `PositionChip` is a label inside a 1px coloured border on
  a transparent fill. The handoff's palette gives rejected and high-risk the same
  oxblood, and flagged and medium-risk the same amber, so colour alone cannot carry the
  distinction between "a person disagreed", "the model rated it risky", and "it departs
  from our house rule". *Cost if wrong: three chips that look slightly less uniform than
  a single badge family would — which is the intent.*
- **R-G17. G lands on one branch and merges whole; the seams in §12.2 are for review
  and bisection, not for shipping intermediate states.** Route-by-route release would
  require a transitional dual palette costing more than the reskin. Said plainly rather
  than promising incrementality the shared primitives make impossible. *Cost if wrong: a
  longer-lived branch, mitigated by every step passing tsc, tests and build on its own.*
- **R-G18. The `Standard positions` tab is built, and it is the only undrawn screen
  that G invents.** It passes §10's test — it answers "which of our house rules are
  drifting", a question no per-playbook screen answers — and it needs no new data,
  writes, or model calls, because D's `positionHealth` already derives everything it
  shows. *Cost if wrong: a read-only index nobody opens; deleting it costs nothing
  because nothing else links to it.*
- **R-G19. Failure, disclosure and warning text may never use `ink-4` or below.** The
  paper palette is deliberately soft and its lower ink steps are decorative-grade
  contrast. A warning rendered in `ink-5` is a warning the reader's eye skips. *Cost if
  wrong: some metadata rows are slightly darker than the mockup.*
- **R-G20. Busy states must be legible without motion.** Under `prefers-reduced-motion`
  the pulse becomes a static tinted bar and the word "extracting" remains. A busy state
  whose only signal is an animation is invisible to a reader who turned animation off,
  which is the "cell spinning forever, unfinishable" defect in a different disguise.
  *Cost if wrong: a slightly less elegant reduced-motion rendering.*
- **R-G21. Spacing stays on Tailwind's default 4px grid; the prototype's ladder is
  snapped to it.** The handoff lists 5 / 6 / 7 / 9 / 11 / 14 / 18 / 22 / 26 / 34px, which
  is an artefact of hand-authored inline HTML rather than a designed scale. Re-basing
  `--spacing` to 2px to reproduce it exactly would silently change the meaning of every
  spacing utility already written across ~788 `className` sites — a change with no
  visual review surface and enormous blast radius. Radii and type sizes are *not*
  snapped: those are named roles with explicit values, so they reproduce the prototype
  exactly. *Cost if wrong: padding differs from the mock by up to 2px in places.*
- **R-G22. A "frozen copy" list transcribed at spec-writing time goes stale as later
  fix rounds rewrite the copy it froze — verify the shipped source before applying it,
  not the spec.** An audit (`.superpowers/sdd/2026-08-28-redesign-g-visual-reskin/frozen-copy-audit.md`)
  found the spec's §8.2/§8.3/§8.4/§9.4 and the plan's Task 9/11/20 sections quoting three
  strings sub-project D's honesty review had since moved past: `ReviewVersionLine`'s
  first branch (spec/plan quoted "Ran against a playbook version that is no longer
  recorded.", which D's review rejected as a false claim — a review that predates
  versioning never recorded a version to begin with — and replaced with "This review
  predates playbook versioning, so it does not record which version it ran against.",
  guarded by a live test asserting the old phrase never reappears); `positionHealthLabel`'s
  `CONCEDED` string (D fixed "CONCEDED 1 times" to pluralise correctly — "CONCEDED 1
  time" / "CONCEDED 2 times" — but the spec/plan still quoted the unconditional "CONCEDED
  n times" template, which reads identically to the correct form at every count except
  one); and `PositionComparison`'s second column, which the spec transcribed from the
  owner's lease-specific mockup as "This lease says" when the shipped, deliberately
  generic component (this app reviews any contract type) has always said "This document
  says" — `git log -S` shows the lease wording never existed in the file. Task 9 had
  already run by the time of the audit and its implementer caught the `ReviewVersionLine`
  divergence by hand, correctly keeping the shipped sentence rather than reverting to the
  spec's stale quote — but the source documents were never corrected, so a later reader
  (Task 24's documentation pass, or any of the fifteen G tasks still to run that touch
  these three strings) re-deriving "what does the frozen copy say" from the spec or plan
  themselves would get the wrong answer again. Corrected in both documents, everywhere
  they appeared, plus Task 20's drafted test (which asserted only `count: 2` — a value
  that cannot distinguish the correct pluralised form from a regression to the
  unconditional template — now also asserts `count: 1` renders "CONCEDED 1 time" and not
  "CONCEDED 1 times"). A standing note added at spec §8.4 makes the general instruction
  explicit for every string in that list, not only these three. *Cost if wrong: a
  restyle task reads its own spec as authoritative, "fixes" the already-correct shipped
  string back to the stale wording, and reintroduces a rejected false claim, a grammar
  defect, or lease-specific wording into a generic component — each requiring a test
  edit to do it, which this project's own process treats as the signal that a "pure
  restyle" commit quietly changed behaviour or copy.*

---

# `getDb` open-timeout backstop (2026-08-28)

A previous agent correctly escalated rather than deciding alone: `src/lib/db/open.ts`'s
existing 3s guard rejects with `DbBlockedError` only `if (blockedFlag)` — i.e. only when
another tab's `blocked()` callback fired. An IndexedDB open that never succeeds, never
errors, and never fires `blocked()` (a bare browser- or disk-level fault) leaves the timer
do nothing at all, and `getDb()` pending forever. Every screen awaiting it then sits on its
loading state with no error and no retry, indistinguishable from "still working" —
`CLAUDE.md`'s founding rule in miniature.

- **R-DB1. The fix is a separate, generous 30s backstop, not a widened short guard.**
  Widening the existing 3s (or similar) guard to reject on *any* unsettled open would abort
  a legitimately slow first open on a large database, breaking the app for exactly the
  users with the most data. Instead `OPEN_TIMEOUT_MS = 30000` races alongside the unchanged
  `BLOCKED_TIMEOUT_MS = 3000` guard: whichever of the four ways the race can settle fires
  first (success, failure, blocked-timeout, open-timeout) clears the other timers, so
  nothing is left running once the open has settled either way. The rejection is a new,
  specific `DbOpenTimeoutError` — not `DbBlockedError` and not a generic failure — whose
  message says what happened and what to do ("LexPrompt's local database did not respond.
  Your data has not been lost — try again."). *Cost if wrong: a genuinely slow open on a
  very large database is aborted after 30s and the user sees an error with a Retry, rather
  than eventually loading. That is visible and recoverable — the infinite spinner it
  replaces is neither.*
- **Left open:** `DbOpenTimeoutError` is not yet wired into `describeLoadError`
  (`src/lib/loadError.ts`), which is the mechanism that lets `DbBlockedError`'s own message
  reach the UI instead of each call site's generic fallback string. This task's scope was
  restricted to `src/lib/db/open.ts` and its test, to avoid a shared-tree conflict with a
  concurrent agent working in `src/test/`. Until `describeLoadError` adds
  `DbOpenTimeoutError` alongside `DbBlockedError` on its pass-through side, a caller loading
  through `App.tsx` sees its generic "could not be loaded" message rather than the specific,
  reassuring one — mechanically correct (a loud, recoverable error, not a silent hang) but
  not yet the exact wording this ruling specifies. One-line addition when picked up.

---

# `publishChangeset`'s stale-base lost update (2026-08-28)

Flagged by the implementer who built `publishChangeset` (sub-project F) and correctly left
for a ruling rather than deciding alone: the function built the new version's clause list
from `changeset.fromVersionId` — the version the changeset was built against — never
re-checking whether the playbook had since moved on. If anyone published a newer version in
the meantime (from the playbook editor, or from another changeset), that version's clauses
were absent from the draft this function was about to publish, and it published anyway,
presenting the result as authoritative. Nobody was told. No test covered it. This is a lost
update wearing the clothes of a normal publish — CLAUDE.md's founding rule in a new shape:
something incomplete presented as though it were complete.

- **R-F6. `publishChangeset` REFUSES rather than merges when the playbook has moved on.**
  At publish time it re-reads the playbook and compares `Playbook.currentVersionId` against
  `Changeset.fromVersionId`. On a mismatch it throws `ChangesetStaleBaseError` — a
  distinguishable type, not a generic `Error` — before touching `playbookVersions` or
  `changesets` at all, so nothing is written on this path and the changeset's own recorded
  decisions are left exactly as they were, mirroring the existing "a failed publish preserves
  every decision" guarantee. The message says the playbook has moved on, that the decisions
  recorded on the changeset are safe, and that it needs to be rebuilt against the current
  version. Reconciling the two — merging the changeset's proposals against clauses it never
  saw — was deliberately NOT attempted: that would produce a version no human ever reviewed,
  which is a worse failure than making someone rebuild it. Mutation-tested in
  `changesets.test.ts`: with the `currentVersionId` comparison removed, publishing proceeds,
  builds v3 from the stale `fromVersionId`'s clause list, and the test fails by showing the
  independently-published "Force Majeure" clause missing from the playbook's new current
  version — the assertion is about the published version's contents, not merely that an error
  was thrown, so it demonstrates what the guard actually prevents. *Cost if this ruling is
  wrong: someone with a legitimately stale changeset has to rebuild it — visible, recoverable,
  and their decisions are still there. Cost of the behaviour it replaces: another person's
  published house position vanishes from the playbook with no trace and no error.*
- **R-F7. `ChangesetItem.title` is now an explicit, optional field, populated by
  `buildChangeset.ts`'s `resolveItem`.** Previously `ChangesetItem` carried no title at all;
  both `changesets.ts`'s `newClauseTitle` and `ChangesetReview.tsx`'s `itemTitle` derived one
  from `item.basis[0]?.clauseRef`, relying on `resolveItem` never producing an empty `basis`
  — an implicit contract between three files, the shape this project keeps paying for. Made
  explicit without disturbing Task 8's committed surface: the field is optional so a changeset
  persisted before this change (with no `title`) still reads correctly, since both derivation
  sites fall back to the old `basis[0]?.clauseRef` read when `title` is absent. No schema
  version bump — additive optional field on a store already documented as "additive only"
  (`SCHEMA_VERSION` 6→7's own note), with no migration needed because absence is handled at
  read time exactly as `rewordedText`'s absence already is. *Cost if wrong: one optional field
  nothing yet requires, and a fallback branch in two readers that stays live indefinitely for
  pre-existing changesets.*

- **R-G11a. Two additive labels on the review screen are declared copy, extending R-G6.**
  Task 8 introduced `Show in document` on each citation and a `Disposition` row label. Neither
  existed in the app before; both come from the handoff's own review screen (`1b`), and Task 8's
  brief styled `Show in document` as though it were already there. They are **additions**, not
  edits to the frozen disclosure and failure copy R-G6 protects, and no existing assertion
  changed — the suite stayed green with no test edited. Recording them anyway, because R-G6's
  list is meant to be exhaustive and an undeclared string is how the "a restyle edits no copy"
  gate goes soft. Any test asserting on them is a new test, never an edited one.
  *Cost if wrong: two labels a later reviewer must either keep or remove deliberately, rather
  than discovering them in a diff and wondering whether they were intended.*

- **R-F8 (Task 10A-fix). "Learn from redlines" publishes a genuine v1 through E's draft
  review; it never mints a playbook or publishes an empty version first.** Task 10A routed
  the flow into F's changeset mechanism, which requires a live `PlaybookVersion`, so it
  minted a playbook, published an **empty v1**, and published the adopted positions as v2.
  That empty v1 is a false entry in an audit trail every review cites ("ran against vN"), it
  orphaned a playbook whenever the flow was abandoned after intake, it made
  `confirm`/`drift`/`new_clause` degenerate (everything is `new_clause` against an empty
  version), and it cost a second model call to produce that empty classification. Spec §4.8
  has two entry points, not one: a NEW playbook from redlines feeds "E's draft-review surface
  and D's publish path" (`positionsToDraft` → `DraftReview` → `saveDraftAsV1`), and the
  changeset mechanism belongs to the OTHER one — an EXISTING playbook fed a new deal, where
  the classification is meaningful because there is a real prior version. F's three screens
  now write nothing at all; the first and only durable write in the flow is E's publish.
  `ChangesetReview`/`publishChangeset` are left committed, tested and **unreached** rather
  than reached through a fabricated version, and no button leads to them — that entry point
  needs scoping as its own task. *Cost if wrong: F's changeset path sits unused until that
  task lands. Cost of the behaviour it replaces: a version recording a state the playbook was
  never in, in the one record this app offers as proof of what a review ran against.*
- **R-F9 (Task 10A-fix). Three small shapes of the redlines→draft conversion, chosen without
  review.** (a) The draft's `contractType` — which `handleSaveDraftAsV1` also uses as the
  playbook's NAME — is the constant `'Learned from redlines'`; this flow asks for neither, and
  naming it after where it came from is the one thing certainly true. The name is editable in
  D's editor immediately after the publish, which is where the flow lands. (b) Each learned
  clause's `extractPrompt` starts from a plainly-derived default ("What does this agreement say
  about <title>? Quote the operative wording") rather than a second model call — the redlines
  say what the firm's POSITION is, nothing about how to go looking for the clause, and E's save
  gate forces a person to read and keep every clause before anything is published. (c)
  `standardPosition.reviewedByHuman` starts `false` and only a REWORD (not an adopt) sets
  `edited`/`positionEdited`; `toPlaybookDraft` flips `reviewedByHuman` at the moment of publish,
  which is the moment a person read the text being published. *Cost if wrong: (a) two
  AI-suggestion prompts in the editor read "Contract type: Learned from redlines"; (b) a generic
  extraction instruction someone waved through, visible and editable on the screen where it must
  be reviewed; (c) provenance under-claims — "accepted unchanged by a person in the draft
  review" rather than also crediting the earlier adopt.*

## Sub-project F, Task 11 — documentation pass (2026-08-28)

F's plan reserved `R-F6` for "a learning session is session-only, exactly as E's
`AuthoringDraft` is" — but by the time Task 11 ran, execution had already spent `R-F6`
on the unrelated `publishChangeset` stale-base refusal above (found and ruled on
mid-implementation, before the planned rulings were ever transcribed here). Renumbered
`R-F10` on write, the same move the tracked-changes prerequisite's own `R-F3`–`R-F5`
made for the identical reason — so neither number is read as belonging to two decisions.

- **R-F10 (plan's `R-F6`) — DONE. A learning session is session-only, exactly as E's
  `AuthoringDraft` is.** Precedent documents, their parsed edits, and every inferred
  position live in `App.tsx`'s `redlinesDocs`/`redlinesFilesRef`/`redlinesPositions`
  React state and die with the tab — verified directly: nothing in
  `src/features/redlines/` or the `App.tsx` wiring calls `addDocument` or a blob-store
  write, and `App.redlines.test.tsx` asserts `addDocumentMock` is never invoked across a
  full session. Only a `Changeset`, or a playbook published through E's draft review,
  outlives the tab. Leaving an in-progress session is guarded by the same
  `useUnsavedDraftGuard` E's `AuthoringDraft` uses (`redlinesSessionDirty` in `App.tsx`),
  not a second hand-rolled guard. *Cost if wrong: a long intake-and-inference session lost
  to an accidental reload — which is why the guard is reused rather than skipped.*

---

# Sub-project G, Task 24 — closing rulings and the browser-verification record (2026-08-28)

G's plan (`docs/superpowers/plans/2026-08-28-redesign-g-visual-reskin.md`) recorded ten
rulings and three owner decisions while it was being written, ahead of any implementation,
under the heading "Rulings made while writing this plan." They bind exactly as R-G1–R-G22
above do, and are transcribed here because that plan is task-by-task execution scratch,
not this project's durable record of "decided without review, with cost-if-wrong." Checked
against the shipped source before transcription, not copied blind from the plan — three
(R-GP1, R-GP2, R-GP9) are called out below with the file that confirms them.

## The three owner decisions of spec §17

- **D1 — Phone parity is NOT in G; it is sub-project H, to be specced separately.** G ships
  ≥768px responsive behaviour of every existing screen and no phone-specific screen. Recorded
  here so a later reader finds this scheduled rather than inferring it was forgotten.
- **D2 — The three-pane review ledger (`1b`) IS in G**, sequenced last as Task 23, in its own
  commit boundary, deliberately reachable by `git revert` without touching any other task.
- **D3 — The `Standard positions` nav tab IS built** (R-G18, Task 20). It reads entirely from
  D's existing derived `positionHealth`/`buildPositionHealthMap`: no new stored data, no new
  writes, no model call.

## R-GP1 through R-GP10

- **R-GP1. `PdfCanvas.tsx`'s highlight overlay divs are restyled; its canvas draw calls are
  not touched.** The spec calls `PdfCanvas` a partial exception and exempted the whole file
  from the palette guard, but the citation highlight is DOM, not a canvas draw call —
  `backgroundColor`/`borderBottom` inline styles carrying the old hardcoded yellow
  (`rgba(255, 235, 59, 0.35)` / `rgba(255, 193, 7, 0.8)`), not the design's tokens. Left alone,
  the one graphic the spec's own verification checklist names would have shipped in the wrong
  colour, hidden behind a guard exemption covering an entire file. Those two style values
  become `var(--color-highlight-fill)`/`var(--color-highlight-edge)`; confirmed present at
  `PdfCanvas.tsx:100-101` in the shipped source. *Cost if wrong: two lines of a file the spec
  called untouched are touched, in the direction the spec's own token table asks for.*
- **R-GP2. `[role="status"]` means "a chip", and nothing else in this app may claim it. Busy
  elements and the toast carry `aria-live` + a `data-*` hook instead.** The spec's own
  guidance — `role="status"` on every busy element and on the toast — is unsafe here for a
  reason the spec could not have known: roughly 21 assertions across three test files already
  read `[role="status"]` positionally to mean "the Nth chip on screen." A busy element takes
  `data-busy="true"` + `aria-live="polite"`; `Toast.tsx` (confirmed at
  `src/components/Toast.tsx:48-53`) carries `data-toast` + `aria-live` (`assertive` for an
  error, `polite` otherwise) and no `role` at all — the spec's claim that `Toast` "keeps
  `role="status"`" is factually wrong about the current source, since it never had one.
  `role="status"` is defined as exactly `aria-live="polite"` + `aria-atomic="true"`, so the
  announcement behaviour a screen reader gives the user is identical either way. *Cost if
  wrong: a busy region and a toast are announced by `aria-live` rather than by an implicit
  role — the same announcement — and `[role="status"]` keeps meaning "a chip," which is what
  21 assertions already assume.*
- **R-GP3. The busy card's `Extracting…` label is the one string R-G6's enumerated copy
  changes gains.** R-G20 requires a busy state to stay legible with motion off; `FindingCard`'s
  running branch previously showed a spinner and pulsing skeleton bars with no word at all,
  which under `prefers-reduced-motion` is a dimmed card indistinguishable from an empty one.
  Confirmed present at `FindingCard.tsx:153`. *Cost if wrong: one more string than R-G6
  enumerated, in service of a ruling (R-G20) R-G6 does not override.*
- **R-GP4. The contrast test asserts three tiers, `ink-5`/`ink-6` included, against a
  documented decorative floor rather than an exemption list.** `ink-5` on `paper` is ~2.3:1 by
  design and would fail either a 4.5:1 or 3:1 WCAG threshold; an exemption list is how a
  palette silently drifts to invisible instead. Every declared pair is asserted at the tier
  its role assigns (`body` ≥ 4.5, `chip`/`large` ≥ 3.0, `decorative` ≥ 2.2, and a fourth
  `disabled` tier at ≥ 1.7 added for `ink-6`, one member only) — confirmed in
  `src/test/contrast.test.ts`'s 47-pair `PAIRS` table, all 47 passing. R-G19 (no failure,
  disclosure, or warning text at `ink-4` or below) is the rule arithmetic cannot check, and is
  enforced by review, not by this test. *Cost if wrong: the decorative tier is a documented
  floor rather than a WCAG threshold, which is what "decorative" means.*
- **R-GP5. An activity entry whose `byUserId` does not match the local profile renders with
  no actor, never an invented one.** There is no store of other display names — `profile.ts`
  holds exactly one record — so a mismatch can only arise from a re-created profile pointing
  at a dead id. The honest rendering omits the actor ("Rejected · 21 Aug 11:02") rather than
  inventing "by someone else" or a placeholder initial. *Cost if wrong: a handful of
  pre-existing entries lose the word "you"; the alternative is naming a colleague who does not
  exist.*
- **R-GP6. The `Review / Compare` control is absent both for a collection review and for a
  standalone review with fewer than two documents.** `TabularReview` already refused a
  collection target outright; the single-document half needed its own gate, since a
  one-document review would otherwise render a one-column grid. Confirmed in
  `ResultsView.tsx`: `onOpenTabular` is optional and the control renders only when the caller
  supplies it. *Cost if wrong: a one-document review loses a grid view that showed one
  column.*
- **R-GP7. The chat panel moves into the finding column's header as a two-way segmented
  control (`Finding` / `Assistant`), not out of the app.** The three-pane ledger (Task 23)
  left no room for a rail-level tab pair, and dropping the assistant module would be a
  behaviour change smuggled into a layout task. Every prop `ChatPanel` receives is unchanged;
  confirmed in `ResultsView.tsx` (the `Finding`/`Assistant` segmented control, `ChatPanel`
  still lazy-loaded). *Cost if wrong: the assistant is one click further from the document
  pane than it was.*
- **R-GP8. R-G6's `Library` → `Playbooks` rename covers every user-facing string that names
  the tab, not only the tab control itself.** `App.tsx`'s `Back to Library` button and
  `MatterHome.tsx`'s "Create one in the Library first…" sentence both named the same control
  and would otherwise have directed a user to a tab that no longer exists after the rename.
  Neither is asserted by any test, which is exactly why nothing would ever have forced their
  discovery. *Cost if wrong: two screens confidently name a control that does not exist.*
- **R-GP9. `accent-strong` is a real darkened teal, not an alias of `accent`.** An early draft
  set `--color-accent-strong: var(--lex-teal)` — identical to `--color-accent` — while several
  components used `hover:bg-accent-strong`/`hover:text-accent-strong`, which would have made
  every primary button's and every link's hover state change nothing, invisible to the whole
  suite. Confirmed in `src/index.css:23`: `--lex-teal-strong: #0e3f39`, the same hue roughly
  25% darker, asserted as its own foreground pair in the contrast test so it cannot drift back
  to an alias. *Cost if wrong: one more palette-layer value than the handoff's token table
  lists, in a hue the handoff already fixes.*
- **R-GP10. A test that cannot fail is deleted or replaced, never kept for coverage.** Three
  cases caught in the plan's own self-review asserted nothing — a banner mounted without the
  prop that would create the control it claimed to check, a "no write affordance" case on a
  component whose only controls are buttons, and an "excludes `.css`" case against a walker
  that only ever collects `.tsx?` files. Each was replaced with an assertion of the behaviour
  it actually names, and every new test the plan introduced was required to state the mutation
  that makes it fail. *Cost if wrong: three fewer assertions, each of which was worth
  nothing.*

## Three places the spec described source that does not exist

Not rulings and not disagreements — the spec describing code that was never there, recorded
so nobody "fixes" working code to match a mistaken description.

1. **`NetPosition` has no `confirmedAt`/`confirmedBy`.** The spec derives part of the activity
   feed from those field names; the real fields are `at` and `byUserId` (`src/types.ts`).
   `matterActivity.ts` (Task 16) uses the real names and is correct as shipped. *If
   unrecorded: someone renames working code to match a spec typo, or writes a migration for
   fields that never existed.*
2. **`Toast` has no `role="status"`.** Covered above under R-GP2 — the spec's claim that it
   "keeps" the role is wrong about the current source, since `Toast.tsx` never carried one.
3. **`title="Retry"` belongs to `TabularReview`'s four per-cell retry controls, not to
   `LoadErrorPanel`.** The spec lists it as a structural contract without saying where it
   lives. Task 4 additionally hardened both `LoadErrorPanel` variants to carry the same
   attribute, which is why an App-level `querySelector('button[title="Retry"]')` could now
   match either, though none of the three existing assertions that read it mounts a
   `LoadErrorPanel`.

Also recorded: the plan's first draft described the stack as "TypeScript 5.8 (strict)".
`tsconfig.json` sets neither `strict` nor `noUnusedLocals` — confirmed by reading the file —
so `tsc --noEmit` catches shape and name errors but not an unread optional field or an unused
prop. Every task's "gates: tsc clean" is a real but materially weaker check than that phrasing
implied.

## R-G23 — the review screen keeps every finding card rendering; the clause index is an added way to move the same cursor, not a replacement renderer

Task 23's brief called for the review screen's middle column to show only the active clause's
card, matching the handoff's mockup. Implemented literally, that breaks two existing,
unedited tests: `App.rerunResets.test.tsx`'s "leaves the verification of other findings
alone" reads two different findings' `[role="status"]` chips with no keyboard movement at
all, and `ResultsView.test.tsx`'s "a standalone review still renders exactly as before" reads
a second clause's summary text, also with no navigation — both require every card present
simultaneously. The implementer flagged this rather than editing either assertion, kept the
finding column exactly as the two-pane layout had it (every clause's card renders, in
template order), and made `ClauseIndex` a genuine second way to move the same `focusIndex`
keyboard cursor `useVerifyKeys` already owns — a rail row click jumps/scrolls to that card
exactly as `j`/`k` do.

**Ruling: this stands.** Those two tests pin real behaviour — that verifying or re-running one
clause leaves every other clause's state visibly intact, checked without requiring any
navigation to prove it — and rewriting regression coverage to accommodate a layout preference
is the wrong trade. *Cost if wrong: the review screen keeps a continuously scrolling finding
column rather than the single-card column the handoff's mockup shows; if the single-card
version is later wanted, `App.rerunResets.test.tsx` and `ResultsView.test.tsx`'s two
assertions above must first be replaced with equivalents that do not depend on simultaneous
rendering — deliberately, as their own reviewed change, not as a side effect of a layout
task.*

## Browser verification

The owner drove the running app directly and confirmed, on 2026-08-28: the light palette
across matters, playbooks, review, and the redlines intake; the export-gate banner; the
`Standard positions` tab reading `HELD 1 of 1` for a position published, reviewed, and
verified by hand; and the document pane after the `PdfCanvas` restyle (R-GP1) — the gutter,
toolbar, page shadow, and highlight colour all confirmed in the running app, not only in the
unit suite. That is the extent of the verification performed for this record; it is not a
claim that every item this sub-project's spec asks to be checked in a browser (fonts blocked,
reduced motion, 768px/1024px across every screen, a scanned PDF and a marked-up DOCX through
the intake wizard, every load-error branch forced live, a run mid-flight, cancellation, and a
reopened interrupted review) was independently re-verified here — several of those were
verified by individual task implementers and reported in their own task reports
(`.superpowers/sdd/2026-08-28-redesign-g-visual-reskin/task-*-report.md`, gitignored scratch),
most thoroughly by Task 23's own live-app pass (keyboard loop, citation highlighting, and the
responsive collapse at ~992px and ~700px). This entry does not repeat or re-attest to those;
it records only what was verified in the course of writing this documentation, attributed
accurately.

At Task 24's own commit: `npx tsc --noEmit` clean; `npx vitest run` — 130 test files, 1710
tests, 0 skipped, all green; the palette scanner's `SCAN_EXEMPT` list is empty and the guard
passes at zero violations repo-wide; the contrast test's 47 declared role pairs all pass at
their assigned tier; the font payload totals 354,180 bytes, inside the 350 KiB (358,400-byte)
budget `src/test/fonts.test.ts` enforces.

# Sub-project G, behaviour-fix round — rulings made without owner review (2026-08-28)

Closing the final behaviour review's H1, L3 and L4, plus the collection-card gap left open
under the honesty review's Major 3. Five decisions were mine.

## R-GB1 — the finding column narrows at `lg`; the rail keeps its 258px

H1's document pane was starved because 258px of rail and 470px of finding column were both
`shrink-0` at every width from `md` up. The fix makes the finding column flexible instead:
it takes the leftover below `lg` (where the document pane is a toggled overlay, so a fixed
470px merely left dead space beside it), 380px at `lg`, and its full design width of 470px
at `xl`. The clause-index rail is untouched at 258px.

380px is chosen, not arbitrary: it is the widest the column can be while the document pane
at 1024px still fits a whole page at the zoom control's own floor (50%, 306px). That
property is asserted by a test rather than left as a comment, so a later widening of either
pane fails loudly instead of quietly re-starving the document.

*Cost if wrong: between 1024px and 1279px a finding card reads 90px narrower than the
handoff's mockup — roughly six characters per line. If the owner would rather have the
mockup's width there, the number to change is one, in `ResultsView`, and the test that
guards the zoom-floor property will say so.*

## R-GB2 — the app shell is `h-screen`, not `min-h-screen`

L4 asked for the hardcoded `calc(100vh - 64px)` to stop naming a header height that
`flex-wrap` had made content-dependent. Replacing it with `h-full` alone did NOT work, and
the browser said so: under `min-h-screen` the shell's height is auto-with-a-floor, a
percentage height on a child of the `flex-1` `main` resolves to auto, and the review screen
grew to 19,473px with the WINDOW doing the scrolling. `h-screen` makes the shell's height
definite, `main` exactly the header's leftover, and `h-full` resolve as written.

This was not a free change: `PlaybookLibrary` and `TemplateEditor` were already written
against `h-full` and were already degrading the same way, so the app has been scrolling at
the window on those screens rather than inside `main`, as their own markup intended. It now
scrolls inside `main` everywhere. Verified live at 1278px on the matters list, the playbook
library, the template editor and a real PDF review, including a forced header wrap
(56px to 79px: `main` shrank to match, no window scrollbar appeared).

*Cost if wrong: every screen now scrolls inside `main` rather than at the window, so the
scrollbar sits below the header instead of beside it and the browser's own
scroll-restoration no longer applies to a screen's content. If that is unwanted, reverting
to `min-h-screen` means every `h-full` screen wrapper needs a definite height again — the
arithmetic L4 removed.*

## R-GB3 — the findings scroller is `relative` (a defect found while verifying L4, not one the review reported)

Verifying L4 in the browser turned up a second, unrelated cause of the very scrollbar L4
warns about. Every finding card's icon-only Retry button carries an `sr-only` label, and
Tailwind's `sr-only` is `position: absolute`; with no positioned ancestor its containing
block is the page, so a label 14,000px down the scrolled finding column extended the
DOCUMENT to 14,570px and gave the review screen a whole-window scrollbar over blank space.
Positioning the scroller puts those labels inside the box that clips them
(`document.scrollingElement.scrollHeight` drops to the viewport's own 1,352px, and the
window scrollbar disappears).

Fixed here rather than filed, because it is one class, it was measured before and after,
and shipping an L4 fix while the app still grew a second scrollbar would have read as the
fix not working.

*Cost if wrong: none identified — `relative` on a scroll container with no absolutely
positioned children of its own changes nothing else. It was not, however, swept for
repo-wide: other screens may have the same `sr-only`-escapes-its-scroller pattern, and
nothing guards against a new one.*

## R-GB4 — L1 is left alone, because it could not be reproduced

`PositionComparison`'s `return null` for a `done` finding with no `positionOutcome` is
unreachable from any path in the running app. `FindingCard` renders the comparison only in
its `done` branch, and both extractors call `normalisePositionOutcome(clause.standardPosition,
…)` — the same field the render is gated on — which defaults to `unclear` whenever a
standard position exists. `carryHumanState` spreads the whole finding, so no snapshot merge
drops the field, and `reviewMigration` preserves whatever was stored. Reaching the branch
needs a persisted review whose snapshot clause carries a `standardPosition` while its
finding carries no outcome; both fields arrived in sub-project D, and no code path since has
written one without the other. The brief's instruction was explicit — do not "fix" what
cannot be demonstrated — so the code and its comment stand unchanged.

*Cost if wrong: if such a record does exist somewhere (a build deployed mid-D, say), a
clause with a house rule opens looking like a clause without one. The failure is silent, and
nothing tests the branch.*

## R-GB5 — the H1 test is a geometry model plus a repo-wide guard, not a rendered measurement

jsdom has no layout engine, so no test in this suite can measure a box. The two new cases
read the geometry the components DECLARE — the pane widths, the scroller's padding, whether
it centres its cross axis — and compute the unreachable strip from those numbers, which is
reading a class list as data rather than asserting a class as style. A third case
generalises it: no container anywhere in `src/` may both declare horizontal scrolling and
centre its cross axis. All three fail against the pre-fix code (252px unreachable at 1024px,
306px minimum page against a 230px content box). The pixels themselves were confirmed in a
real browser on a real review, recorded in the fix report.

*Cost if wrong: the model encodes one CSS rule by hand. If a future layout puts the document
pane somewhere the model does not describe — a grid, say, or a pane whose width is not a
`w-[Npx]` utility — `paneWidth` throws rather than passing, which is the intended direction,
but the test then needs updating with the layout rather than merely re-running.*

---

# R1 / R-G1 superseded (2026-08-28) — LexPrompt Server

**R1** ("build SCHEMA-READY, SINGLE-USER-IN-PRACTICE") and its sub-project-G
restatement **R-G1** ("every multi-user affordance in the prototypes is dropped or
resolved to the local profile") are **superseded** by
`docs/superpowers/specs/2026-08-28-lexprompt-server-design.md` §3.1.

Both were correct while assignment reached nobody: an assignee chip in an app with no
accounts manufactures a silence, and R-G1's own cost-if-wrong says so. The server design
removes that condition — real Entra accounts, a real assignment that reaches a real
person, and an activity feed read from a stored audit log rather than derived from one
browser's own actions — so assignee chips, an "assigned to me" counter, actors in the
feed and "flagged for X" phrasing become honest.

**R-G1 continues to bind until the mechanism behind each affordance ships.** The server
design's Stages 1–3 (gateway, storage and auth, server-side engine) must not add a
collaborative affordance ahead of Stage 4, which is what makes one true. A reader finding
R-G1 in a Stage 1–3 diff should treat it as live, not as history.

**R1's schema-readiness is what makes the migration cheap**, and it is worth recording as
a ruling that paid for itself: `Matter.ownerId`, `DocumentRecord.addedByUserId`,
`Collection.createdByUserId`, `Review.createdByUserId`, `PlaybookVersion.publishedByUserId`,
`Changeset.createdByUserId`, `Note.byUserId`, `Verification.byUserId` and
`NetPosition.byUserId` all already exist and are already populated. They become foreign
keys to an `app_user` table and are otherwise untouched. The one identity field that does
NOT survive is `Verification.assigneeId`, retired in favour of an `assignment` table
(design ruling S17): a real assignment needs an assigner, a time and a resolution, none of
which a single id can carry.

*Cost if wrong: if the server design is not built, R-G1 stands unchanged and this entry is
a note about a road not taken. If it is built but a collaborative affordance ships ahead of
its mechanism, the failure is exactly the one R-G1 named — a lawyer waiting on a review
nobody was asked for — which is why the supersession is staged rather than immediate.*

The server design's own rulings (S1–S31, after the 2026-08-28 revisions below) live in that
spec's §16 rather than being duplicated here, because they are design rulings awaiting owner
review, not decisions taken during execution without it. Anything decided without review
while BUILDING it belongs here, in this file's format, as every sub-project's did.

---

# Owner decisions, 2026-08-28 — three parts of the server design change

All three are the owner's, taken after the spec was written and recorded here because this
file is the decision log: a reader must be able to see that the position CHANGED, not find a
document that always said the new thing. The spec
(`docs/superpowers/specs/2026-08-28-lexprompt-server-design.md`) has been rewritten to
match, and its own S4, S19, S2 and S15 carry the same supersession notes rather than being
edited away.

## D1 — verification is mutable, and a Partner may override it

The owner: *"Partner may override a verification (and something can change from Verified,
back to another state, at any time)."*

**Superseded, 2026-08-28: design ruling S4's original form** — "a finding carries at most
one verification (insert-once, first wins) plus append-only challenges", resolved by
`INSERT … ON CONFLICT DO NOTHING`, with the loser told who won. That shape was built on an
earlier answer, "first to verify wins", which no longer holds. `finding_verification` and
`finding_challenge` (with its `withdrawn_at`) are both gone. **Superseded, not deleted:**
anyone reading an earlier draft of the spec, or a plan written against it, needs to be able
to tell that the model changed rather than that they misread it.

**The new model.** A finding carries ONE current disposition — `unchecked`, `verified`,
`flagged` or `rejected` — and a COMPLETE append-only history of every change to it: who,
when, from what state, to what state, and why where a reason exists. Any authorised user
may change it at any time, in any direction, including back from `verified` to `unchecked`.
Nothing is locked by having been verified once. A change submitted against a stale version
is REFUSED with the current row and shown to the changer, never silently applied — the same
posture S20 already takes for free text.

The power is deliberately not Partner-only. The owner named a Partner because that is the
case that prompted the question, but the mechanism is mutability, not hierarchy: a trainee
who verifies the wrong finding must be able to undo it without waiting for a Partner, and
building that wait would be the app manufacturing a silence again — the exact failure R-G1
was written against. Narrowing it to Partners later is a role check on one route, because
the history already records who did what.

Three consequences, all of them load-bearing rather than incidental:

**The audit trail stops being decorative.** When a disposition can change at any time,
"who says this was checked, and as of when" is answerable ONLY from the history. The
current row answers "as of right now" and nothing more. So the history ships NEVER LATER
than the mutability — in the spec's staging it lands a stage earlier, with findings-as-rows,
because the re-run reset needs it — and the attribution and export surfaces that make it
visible ship in the same stage as change-by-others. Mutability without a visible history is
not a smaller version of this decision, it is the quiet lie the app exists to prevent with
the evidence written somewhere nobody is shown. It is recorded ONCE, in
`finding_disposition_event`, and deliberately NOT
also written to `audit_event`: two append-only copies of one fact is this project's most
repeated defect placed exactly where a divergence would matter most and be noticed least —
between the history a lawyer reads on a card and the history the firm exports as evidence.

**An export is a point-in-time claim and must stop implying permanence.** Under insert-once,
"Verified by Priya" aged well because the row could not change. It no longer does, and the
failure is silent: an exported DOCX looks identical whether or not the disposition it
reports still holds. Every export therefore carries the instant its dispositions were read,
carries the same "was Rejected" and "changed twice" facts the card carries, and says in its
own words that a disposition can change and that LexPrompt's history is authoritative over
any printed copy. The full history is exportable in its own right, because "what would this
report have said on the day it was signed" is a question a firm will eventually ask.

**Attribution on the current state is not enough.** `by_user_id` is who set the state now
shown — never who set the first one. A card reading "Verified by A. Trainee" for a finding
a Partner reverted and re-verified would be a quiet lie of the exact kind on `CLAUDE.md`'s
list. So: a disposition is never shown without its actor and time; a changed disposition
says so on the face of the card and names the state it came from; the full history is one
action away; and a disposition cleared by a re-run reads as a re-run, not as a person
un-verifying by hand.

**What does NOT change.** Verification is still set only by a human action and nothing
derives it — mutable and derived are different axes, and conflating them is the easiest
mistake available while reading the new §6.3. The one write that is not a fresh human
judgement is the re-run reset, and it is constrained by check constraint to move a
disposition only TO `unchecked`, never to `verified`: a rule that can only remove a claim of
human checking cannot manufacture one. **The re-run reset itself is untouched and still
reads correctly** — re-running a clause still clears its disposition and its net position,
because the judgement described a specific answer and that answer is gone. If anything the
argument strengthens: the reset is now an ordinary disposition change rather than a
deletion, so the fact that the clause WAS verified survives in the history instead of
vanishing with the row, and an export of a re-reviewed clause can say "unchecked — re-run
by A. Gray at 11:07, previously verified by R. Okafor". Assignment is untouched and remains
the way to ask a colleague to look.

*Cost if wrong: a colleague can now move a judgement you made, and the only thing between
that and a quiet overwrite is the history — written, shown on the card, and carried into the
export. If any one of those three is skipped or shipped a stage later than the mutability,
the app tells a lawyer "verified" with no way to find out by whom, when, or over what, which
is WORSE than the insert-once model it replaced rather than better. If instead the firm
decides overriding should have been Partner-only after all, that is a role check on one
route and a UI gate — cheap, because the history already answers "who".*

## D2 — precedent documents may be stored server-side

The owner: *"Precedent documents can be stored server-side."* This answers the spec's open
question 9.

**Amended, 2026-08-28: design ruling S19.** S19 moved parsing server-side and left precedent
documents to that open question; the spec's §11 offered "parsed in memory, never written to
Postgres or Blob, asserted by a test (no row, no blob)" as the likely shape. That test is now
INVERTED rather than written: there is a row and there is a blob. What the tests assert
instead is that a precedent is distinguishable from a matter document and can never be
reviewed as one.

**The app's current on-screen promise becomes false, and the copy changes in the same stage
as the storage — never after.** `src/features/redlines/PrecedentIntake.tsx` renders, at the
top of the intake screen, **"Read once to learn from. Never stored."** That sentence is TRUE
today and false the moment the first precedent byte reaches Blob Storage. Its own code
comment explains that it was deliberately strengthened from a narrower phrasing because
"understating a privacy promise is the one direction it must never drift" — which is the
argument for changing it now, not for leaving it. Shipping the storage while that sentence is
still on screen would be this project's founding defect in its purest form, shown to a lawyer
at the moment they are choosing which of their client's documents to hand over.

So, as acceptance conditions and not as a note: the migration that adds
`document.kind = 'precedent'` and the copy change land together, in the same change; the
replacement sentence lives in `src/lib/privacyCopy.ts`, the extracted single home for
disclosure wording (R-G5), not inline; it is still said ONCE, in the strong form, by
`PrecedentIntake`'s header, with `PrecedentUploadPanel.tsx` continuing to say only what is
READ ("Marked-up .docx files are read for tracked changes; anything else, including PDFs, can
be compared against another version instead"), because two wordings of one promise was
already a real defect on this exact screen; the tests that assert the old promise
(`src/App.redlines.test.tsx`, which counts `'Never stored'` and has a describe block titled
"a precedent document is read and never stored") are REWRITTEN, not deleted, since a deleted
promise test is how the next reader learns there was never a promise; the stale comments
carrying it are corrected too (`App.tsx`'s `redlinesDocs` note, `PrecedentUploadPanel.tsx`'s
docstring, `types.ts`'s remark that a changeset keeps a durable basis because the sources
"are read, never stored"); and the README's §Learning from redlines bullet — "stores none of
them: not in IndexedDB, not in `localStorage`, not in the URL" — is replaced in the spec's
"what becomes untrue" table alongside it.

**Sub-project F's spec is superseded on this point and left standing.**
`docs/superpowers/specs/2026-08-27-redesign-f-learning-from-redlines.md` §4.1 and §11 state
the non-storage promise as a design commitment. Correct when written; superseded here, and
not edited, for the same reason this file exists.

**Retention now applies to them, and the matter-file schedule does not reach them.** A
precedent belongs to no matter. A set is likely to hold ANOTHER client's executed documents,
and a house position adopted from it may be relied on for years after the set would otherwise
have been disposed of. The spec's open question 3 (retention) is extended to ask this
explicitly, with the trade named rather than defaulted: delete the set and a position's basis
becomes unresolvable — and must SAY so, not show an empty evidence panel — or keep it and the
firm holds another client's papers for as long as the playbook lives.

**Three things get better, and the third changes what the feature can claim.** Inference
re-runs without re-uploading eight `.docx` files. The workings — the actual redline text
behind each proposed position, with its margin comments and authors — can be revisited after
the session. And a position's basis stays inspectable once the tab closes: "learning from
redlines" asserts that an inferred house position is EVIDENCED, and session-only storage made
that assertion true for about ninety seconds. A durable basis is what makes "a lawyer can
check the evidence behind an inferred house position" a property of the app rather than of
one sitting.

**Precedent documents are distinguished from matter documents, in storage and in the UI.**
Ruled, not left open: `document.kind` is `matter` or `precedent`, NOT NULL, with a check
constraint tying a precedent to a precedent set and a NULL `matter_id`; every review-target,
collection-member and matter-document query filters on it; precedent sets live on the
playbook side of the app and never in a matter's documents; a precedent open in the viewer is
labelled as one. The reason is not tidiness. A precedent is another party's deal, usually
still carrying an opposing party's markup, and if it can be opened as though it were the deal
under review it can be reviewed, collected and CITED — a citation with apparent authority
pointing into the wrong client's document, which is `derivePage`'s failure mode one level up.

*Cost if wrong: storing them puts another client's papers into a database whose access model,
retention schedule and deletion cascade were all designed around matter files, and the query
that forgets the `kind` predicate fails by showing too MUCH, with nothing on screen looking
wrong. The separation and its tests are the guard. If the firm instead decides precedents
must not be stored after all, reverting is cheap in code — the session-only path is what
exists today — but the on-screen promise would then have changed twice, and a privacy
sentence that has flip-flopped is worth less than one that never moved.*

## D3 — the inference gateway is multi-provider, not Azure-Foundry-only

The owner: *"I think we probably want different AI layers — Foundry, OpenRouter, Claude,
OpenAI, Azure OpenAI etc. And they choose. That's particularly useful for any smaller firms
or individuals running it locally who won't have Azure infrastructure."*

**Superseded, 2026-08-28: design ruling S2's second sentence** — "There are no provider API
keys anywhere in the system." That was TRUE, and it was true only of the case the design then
had: one provider, Azure AI Foundry, reached by Entra managed identity. With OpenAI,
Anthropic or OpenRouter configurable, an operator API key exists. **Superseded, not deleted:**
the sentence was memorable, it appeared in several places, and a reader of an earlier draft
must be able to see that it was retired deliberately rather than lost in an edit. S15 is
AMENDED rather than superseded — its allowlist survives with a different entry shape.

**The security guarantee is restated, not weakened, and the restatement is two sentences that
must never become one:**

> **No credential ever leaves the gateway, and every call is logged with its provider and its
> jurisdiction, whichever backend is configured.**

> **Separately: an Azure-only deployment authenticating by Entra managed identity retains the
> stronger property — no key exists at all — and that is the recommended posture for a firm
> with Azure infrastructure.**

Both are true. The first is ARCHITECTURAL: it holds in every deployment, a Risk reviewer
verifies it once, and `apps/web` and `apps/api` never see a credential in any configuration.
The second is a DEPLOYMENT CHOICE and must be checked per environment. **Merging them into
the old shorthand would state a security property that is false for half the deployments** —
telling a firm there is nothing to steal in a system holding an operator API key, which is not
an overstated benefit but a false control, and a false control is worse than a missing one
because nobody looks for it. The spec's new §12.0 makes the split a TABLE rather than a
phrasing, so re-merging requires deleting a row instead of tightening a sentence; the pressure
to re-merge is permanent, because one sentence is shorter and sounds better.

**Four things follow, all decided here rather than left to the implementation.**

**One adapter interface, one registration point, and the gateway core keeps everything that
is not provider-specific.** An adapter owns credential acquisition, request shaping, response
parsing, stream-frame mapping and error classification. The allowlist check, the jurisdiction
check, the purpose check, budgets, the prompt-size cap, the timeout, the retry policy and the
call log live in the core and run ONCE, around every adapter. Adding a sixth provider touches
the registry and no call site. This is stated in the strongest terms the spec has (S25) and
enforced by an import-boundary test, because five parallel implementations of one idea would
be this project's most expensive recurring defect at a factor of five, in the component whose
entire purpose is to be the one describable egress — and the divergence would be between what
the firm believes it logs, retries and allowlists and what it actually does for the one
provider nobody exercised.

**Every allowlist entry declares its processing jurisdiction, and the entry is provider+model,
not a Foundry deployment.** Jurisdiction is recorded on every call-log line, returned on every
gateway response, and stored on the `run` row as a SNAPSHOT — never re-derived from current
configuration, because a firm that later changes its allowlist must not silently rewrite where
last March's review was processed. That is `playbookSnapshot`'s rule applied to the one fact a
data-protection question turns on. A user still cannot name an arbitrary model; the PROVIDER
became a choice, the USER's ability to name one did not.

**A disallowed jurisdiction is REFUSED, not merely surfaced (S27), and the reasoning is
recorded because this is the decision most likely to be reopened.** Refusing is the same
mechanism the allowlist already is, so surfacing would create a second, weaker class of rule
inside one check. A surfaced warning is enforcement by attentiveness, and every defect on
`CLAUDE.md`'s list is something incorrect that read as correct — a "US processing" badge is
exactly a thing read past at 17:40. The person seeing the badge cannot give the consent it
asks for: a cross-border transfer of privileged client text is a firm-level decision — DPIA,
engagement terms, possibly the client's own instructions — and a record of a lawyer appearing
to authorise one is worse than no record. And the costs are asymmetric with only one of them
recoverable: refuse wrongly and a call fails loudly with a 403 naming the provider, its
declared jurisdiction and the allowed set — one config change, minutes, nothing lost; surface
wrongly and the text has already crossed a border and cannot be un-sent. **Fail closed on
UNDECLARED**: an entry with no jurisdiction is refused, there is no default allow-set, and the
gateway refuses to START on either misconfiguration. Surfacing
still happens, at two altitudes — the operator sees jurisdiction where the choice is made, and
the model picker labels EVERY model with its provider and jurisdiction, never only the non-UK
ones, because a badge shown only on the bad entries makes its ABSENCE carry meaning, which is
the blank-CSV-cell defect exactly.

*(Revised, 2026-08-28, on the Stage 1 gateway plan: this passage originally added "or with no
log sink configured" to the gateway's startup refusals, grouped with the jurisdiction
misconfigurations because both were framed as things a startup check refuses. The audit log
has no configuration to refuse on — see S26's amendment note below and spec §10.5 — so that
clause is retired here rather than carried forward. The jurisdiction refusals above are
unchanged.)*

**A no-Azure deployment is first-class, and the design says exactly how far that reaches.**
Same gateway, same allowlist, same jurisdiction refusal, same per-call log with the same
fields, written to stdout with no configuration surface to disable it — a local deployment
does not get to skip the record because it is small, and none can, because none has the means
to. What it does not get is the no-key property, and the README and admin screen say so in
that deployment rather than repeating a sentence true only elsewhere. **What the design does
NOT yet give it is identity
and storage**: Postgres and blob substitute cleanly, but the spec's §7 is Entra-only by S10,
and a firm with no Azure tenant has no Entra tenant either. Stage 1 is unaffected; Stages 2
onward are. The spec's new open question 11 asks the owner what "running it locally" is meant
to reach rather than letting the answer be assumed — claiming a deployment mode that was never
specified is the same failure as claiming a security property that holds in only half of them.

**Streaming is where this will actually break.** The suite already carries a regression for an
SSE parser that dropped the final token and returned NOTHING against a CRLF server. That bug
class now has one instance per adapter. The structural answer: ONE transport decoder in
`packages/core` — line splitting, CRLF, chunk boundaries, the final frame with no trailing
newline, all of it, once — plus a thin per-adapter frame mapper, plus a conformance suite that
is table-driven over every registered adapter so a new adapter with no fixture entry FAILS THE
BUILD. The assertion that matters is the one the original defect failed: the concatenated
stream deltas equal the non-streamed completion, byte for byte. This is named as the
highest-risk part of Stage 1, because its failure is quiet — a truncated clause analysis reads
as a model that had little to say.

**AMENDED, 2026-08-28 by D5 — the jurisdiction reasoning above is restated, and its mechanisms
are not.** As written, the jurisdiction bullets read as the system protecting an operator from
their own provider choice: US processing framed as a hazard, and the refusal justified by "a
cross-border transfer is a firm-level decision the lawyer cannot take" as a claim about what is
ACCEPTABLE. The owner corrected that framing (D5). Everything mechanical here survives
verbatim — refusal rather than surfacing, fail closed on UNDECLARED, no default allow-set, the
startup refusal, the per-call record, the run-row snapshot, the unconditional labelling. What
changes is the AUTHORITY: the gateway enforces the operator's DECLARED policy, arrived at from
the contracts and data provisions they hold with each provider, rather than a view about what a
law firm ought to want. Read every bullet above with that substitution. Note also that this
paragraph's "there is no default allow-set" was already correct on 2026-08-28 and the Stage 1
plan nonetheless defaulted the variable to `UK,EU`; D5 makes the spec say so explicitly and in
the places an implementer reads.

*Cost if wrong: the design's central claim — the gateway is the only egress, nothing else can
call a model — is untouched and still architectural, so what is at risk here is the SECOND
claim, the one about keys and jurisdiction. If the two sentences are ever merged, a firm is
told a control exists that does not, in the document its Risk function relies on. If the
adapters grow their own logging, retries or allowlist checks, the firm's description of its own
egress becomes true of some providers and not others, and nobody would find out until they
switched provider. If a jurisdiction is surfaced rather than refused, privileged client text
crosses a border on a lawyer's misread badge and there is no retry that un-sends it. If the
local path skips logging or the allowlist, the smallest deployments — the ones with no Risk
function at all — are the ones running without a record. Against all of that: if the owner
decides after all that only Foundry will ever be configured, everything here still holds and
the extra cost was one interface, four unused adapters and a quarter of a sub-project in
Stage 1.*

---

# Owner decision, 2026-08-28 — a fourth part of the server design changes

Recorded separately from D1–D3 because it was taken after them, against a spec they had
already rewritten. Same reason for recording it here: this file is the decision log, and a
reader must be able to see that the position CHANGED rather than find a document that always
said the new thing.

## D4 — one system, two environments: a firm deployment and a laptop are the same code

The owner, answering the spec's open question 11: *"I want it to work cohesively when
deployed within a firm, but also make it easy for someone to build and test on their own
machine for testing. So ideally best of both."*

**Q11 offered three options and the owner took none of them, because the question was framed
wrongly.** It asked which DEPLOYMENT MODE the local path is: (a) the inference path only,
with the multi-user app remaining Azure/Entra; (b) a single-user local build, effectively
today's app with a gateway in front; (c) a full local deployment with a non-Entra identity
provider. The answer is that **local is not a deployment mode at all. It is a development
environment for the one system the spec specifies** — so (a) is too little to build Stages 2
onward against, (b) reopens R1 and could not exercise a single collaborative feature, and
(c) buys a subsystem to solve a problem the owner did not have. What was asked for is that a
developer can build and test THE WHOLE THING on a laptop, and the way to give them that is to
make the local stack faithful, not to make it a second product.

**One authentication path — OIDC — with two issuers.** Entra ID IS an OIDC provider. The
application validates OIDC tokens against a CONFIGURED issuer and reads group claims from a
CONFIGURED claim; it never special-cases Entra. Locally, a lightweight OIDC issuer runs in
`docker compose` with seeded users and groups.

**This GENERALISES S10 rather than reversing it, and the distinction is the whole point.**
The three-role model survives untouched, and so do the group-to-role mapping, the absence of
per-matter ACLs, custom roles and deny rules, and the refusal of SAML, Okta and any password
the APPLICATION holds. Only "the issuer is Entra" becomes "the issuer is configured, and is
Entra in the firm deployment". S10 carries a dated amendment note in the spec's §16 rather
than being edited away, so a later reader does not conclude that "no SSO beyond Entra" was
quietly abandoned. It was not: **a second ISSUER is not a second MECHANISM.**

**There is no development bypass, and the reasoning matters more than the rule.** No
`SKIP_AUTH`, no local anonymous mode, no trusted header. Two counts, and the second is the
decisive one for this project. First, a bypass is a DEPLOYMENT LIABILITY: the recurring
industry failure is precisely that such a flag reaches production enabled, and this system
holds privileged client material — a control that depends on a flag never being set is a
control held by discipline, and `CLAUDE.md`'s list is a record of what discipline loses to.
Second, **a bypass TESTS A DIFFERENT CODE PATH FROM THE ONE THAT SHIPS**, which is the same
class of error as a test that passes against unfixed code — the worst kind of test this
project has shipped. A green local run under a bypass would prove nothing whatever about the
deployed system, which would remove the only reason to have a faithful local stack at all.
The cost of having no bypass is that a developer runs one more container.

**The local issuer seeds SEVERAL users, across all three roles — a trainee, a partner, an
admin, and a fourth in no mapped group.** This is not convenience. Every collaborative
behaviour in the design is UNOBSERVABLE WITH ONE USER: first-to-verify, a Partner override,
the stale-version refusal, assignment, presence, and a card changing attribution without a
reload each need two browsers signed in as two different people. A single-user local mode
could not exercise the features Stages 3 to 5 exist to build — it would not be a cheaper
version of this, it would be a local stack that runs green on the half of the system that
does not need testing. The fourth account exists because "told plainly that you have no
access" is itself a load-bearing behaviour and needs an account to test with.

**The same principle extends to the whole stack: local dependencies are FAITHFUL EMULATORS
of the deployed services, not near-equivalents.** Azurite — Microsoft's own Blob emulator —
never MinIO and never anything merely "S3-compatible", and the spec says so explicitly,
because that phrase names exactly the class of near-equivalence that produces a defect
visible only in production: the local run is green and the difference is in a header, an
error code or a consistency guarantee nobody read. Postgres container for Postgres Flexible
Server. Redis container for Azure Cache for Redis — with `api` at two replicas locally, or
the fan-out path is never exercised at all. **The gateway with a keyed provider against the
gateway with Foundry and managed identity is a GENUINE difference, and it is already ruled
(D3/S2): it is named as the single deliberate divergence, so a reader knows the enumerated
list is exhaustive rather than optimistic.**

**What local deployment does NOT prove is written down, and being honest about the boundary
is the point of listing it.** Managed-identity acquisition; Entra's group-claim shape,
consent and the group-overage case; Azure networking and private endpoints; Postgres
Flexible Server's own behaviour; Azurite's own gaps; real provider latency, rate limits and
streams. **A developer must not read "it works on my machine" as "it will work in the
tenant"**, and the list sits in the spec's §5.1 and in the README rather than in a place
only a designer reads, because the person who needs it is the developer who has just had a
green local run.

**Three consequences the owner did not have to decide, recorded because they follow and
somebody will otherwise rediscover them the hard way.** MSAL is Entra's library, so the
browser uses a standards-only OIDC client instead — the alternative is two sign-in paths,
this project's most repeated defect placed at the front door. `app_user`'s identity becomes
`(issuer, subject)` rather than `entra_object_id`, and `role_mapping` is keyed by issuer and
group value rather than by an Entra group object id. And Entra's GROUP OVERAGE — a user in
too many groups gets no `groups` claim at all, just a pointer to Graph — reads naively as
"in no mapped group", so a partner in forty groups would be told they have no access: a
wrong answer delivered confidently, which is the shape this project exists to prevent. It is
specified as its own detected error, and it is un-reproducible locally, which is exactly why
it is specified rather than discovered.

**The local issuer is Keycloak (spec ruling S31).** Criteria: a container, standard OIDC
discovery, static users carrying group claims, small. Keycloak meets the first three and
fails only the last (~450 MB, ~20 s cold start). Dex is an order of magnitude smaller and its
static users carry NO GROUPS AT ALL, which is disqualifying when every role is read from a
group claim. A configurable token mock is smaller still and worse: it mints whatever claims
it is asked for, making it a PERMISSIVE ORACLE, and testing the shipped authentication path
against something that cannot refuse is the no-bypass error wearing a different hat.

**The sequencing is forced, not chosen: the local issuer ships in STAGE 1.** Stage 1 is the
first stage that requires a signed-in user, and with no bypass to stand in for one, Stage 1
is otherwise a stage nobody can run on a laptop. It ships with its full seeded set, because
seeding one account in Stage 1 and three in Stage 3 is two edits to one file for no benefit.

**Spec Q11 is marked ANSWERED, and a NEW Q13 is opened for the half it conflated.** Q11 ran
"local development" and "a no-Azure production deployment" together. The owner's answer
settles the first. The identity half of the second turns out to be smaller than it looked —
Entra ID does not require an Azure subscription, so a firm with no Azure infrastructure still
deploys against its own Entra tenant with a keyed gateway — but the storage and residency
half is untouched, and Azurite says nothing about it, because Azurite is a development
emulator and not a deployment target. Opening Q13 rather than letting Q11's closure imply an
answer is the same posture the spec takes everywhere else: claiming a deployment mode that
was never specified is the failure this decision exists to prevent.

*Cost if wrong: the generalisation of S10 fails LOUDLY, at sign-in, in whichever environment
is misconfigured — and if instead the app had special-cased Entra and a second issuer were
ever needed, the cost would be a rewrite of the auth section rather than an edit to a
configuration file. The no-bypass decision costs a developer one more container; the opposite
error costs a green local run that proves nothing, in a system holding privileged client
material, with a flag that only has to reach production once. The faithful-emulator decision
costs a heavier Blob emulator and two boundary tests; the opposite error is a defect that
only appears in the firm's tenant, found by a lawyer rather than by CI. The enumerated
divergence list is the fragile part — everything else here is enforced by a test, but a list
can rot, so the spec's §18 checks it mechanically (no module branches on the environment; the
configuration key diff equals the table; the same suites run against both environments)
rather than by asking anyone to keep it current. If the list is allowed to drift, "the same
code runs in both" quietly becomes a comforting sentence, and it would be discovered on a
first deployment, which is the most expensive place to discover anything.*

---

# Owner decision, 2026-08-28 — a fifth, and it corrects a framing error rather than adding

Recorded separately from D1–D4 for the same reason they were recorded separately from each
other: this file is the decision log, and a reader must be able to see that a position CHANGED
rather than find a document that always said the new thing. D5 is different from its
predecessors in one way worth naming — it changes NO MECHANISM. Every rule the spec's §10.3
enforces after D5 is a rule it enforced before it. What changes is whose authority those rules
are exercised under, which is the kind of error that survives a review precisely because
nothing in the code would look different.

## D5 — the gateway enforces the operator's declared policy; it does not protect them from their provider

The owner: *"It's basically for the person running the solution to be happy with the provider
they're using, and the associated contracts and data provisions that those providers will give
them (the API key is just the interface into the service, backed by those guarantees)."*

**What was wrong.** The 2026-08-28 revision (D3) built the jurisdiction rules as though the
system were evaluating a jurisdiction on the operator's behalf — US processing as a hazard to
be defended against, `UK,EU` as the safe default the deployment template shipped, and the
refusal justified as "a cross-border transfer of privileged text needs a firm-level consent a
lawyer at their desk cannot give", stated as a claim about what is ACCEPTABLE rather than about
who sets policy. That is not the operator's position and the spec had no standing to take it.
A firm may hold entirely sound provisions with a US provider — standard contractual clauses, a
data processing agreement, negotiated retention and training terms — settled with legal input
long before anyone opens a deployment configuration. **The API key is the interface into a
service whose guarantees live in the contract behind it, not in the key.** The system's
authority was misplaced: it should enforce WHAT THE OPERATOR DECLARED, not what the spec's
author assumed a law firm ought to want.

**The default allow-set is removed, and removing it makes fail-closed STRONGER, not weaker.**
`GATEWAY_ALLOWED_JURISDICTIONS` ships UNSET — not `UK,EU`, not anything — and the gateway
REFUSES TO START when it is absent, naming the variable and saying what it is for. A default
encodes an assumption about one particular firm's contracts, and a default that happens to
match a firm's policy is indistinguishable at a glance from a firm that declared one. With the
default gone, UNCONFIGURED IS AN ERROR RATHER THAN A GUESS, which is the same posture as the
API's refusal to start with no issuer configured (the gateway's audit log takes the same
fail-closed spirit further still: S26's amendment note records that it has no log-sink
configuration for any deployment to leave unset, so there is nothing there for a startup
check to refuse on). The
deployment template carries `UK,EU` as a COMMENTED EXAMPLE with its reasoning written beside
it, so an operator reads why the line exists and then types their own. The spec's §14 adds a
mutation for it — reintroduce `?? 'UK,EU'` and the `jurisdiction` suite must fail — because a
default is the one mutation that leaves every happy-path test green while silently substituting
a guess for a policy. That makes two absences this design mutation-tests; the other is S29's
authentication bypass, and they fail the same way if nobody guards them.

**The refusal survives verbatim; only its reasoning is restated.** The gateway still refuses to
route outside the declared set and still fails closed on an undeclared entry. It is no longer
"a lawyer cannot authorise a cross-border transfer" as a statement about acceptability; it is
"the operator has declared which providers they hold provisions for, and a request outside that
set is a MISCONFIGURATION, not a decision to re-take at request time" — to be fixed in
configuration by whoever owns the policy, not by a click from whoever is next to the keyboard.
The asymmetry argument is untouched and is still the load-bearing half: refuse wrongly and a
call fails loudly with a 403 naming the provider, its jurisdiction and the declared set — one
config change, minutes, nothing lost; route wrongly and text has gone somewhere the operator
did not declare and cannot be un-sent. Enforcement by warning would put a written-down policy
in the hands of whoever happened to be concentrating, which is the same bet every defect on
`CLAUDE.md`'s list lost.

**`dataHandling` is the operator's record, not the system's assessment.** The per-provider note
records the retention, training and sub-processing terms THIS OPERATOR HOLDS — published
defaults or a negotiated DPA, whichever it is — with the date they were last checked, so it can
be shown to a reviewer and re-read when it ages. The staleness marker prompts the operator to
re-read THEIR OWN CONTRACT; it never means the provider has become less trustworthy, and no
code path grades, scores or decides anything from the note. Stored, displayed, dated.

**The labels are factual, never evaluative.** Every allowlisted model still shows its provider
and jurisdiction, ALWAYS — that ruling is unchanged and so is its reason, that a badge shown
only on some entries makes its ABSENCE carry meaning, which is the blank-CSV-cell defect
exactly. What changes is that the label states WHERE PROCESSING OCCURS, in the same neutral
form for every entry, and never implies one allowlisted option is safer than another. It could
not honestly imply otherwise: by the time a model reaches the picker the operator has already
declared its jurisdiction acceptable under contracts the picker knows nothing about.

**What must NOT be lost to over-correction, listed because the pressure runs both ways.** The
per-call record of provider and jurisdiction. The snapshot on the `run` row, so a past review's
processing location cannot be rewritten by a later config change. The refusal to start when
misconfigured. The exhaustive labelling. The refusal to route outside the declared set. None of
those was the framing error, and a later reader trimming them "because the operator decides
anyway" would be making the opposite mistake at the same location.

**Where it landed.** Spec Revision 3 rewrites §10.3 and amends §10.1, §4's Out list, §12.0,
§12 Q5, §14, §17 Q4, §18 and §19. Spec rulings S15, S26 and S27 carry dated amendment notes
rather than being edited away. D3 above carries one too. **The Stage 1 gateway plan defaults
`GATEWAY_ALLOWED_JURISDICTIONS` to `UK,EU` in its config loader, its compose file and its
`.env.example`, and that must follow this decision** — it was already inconsistent with D3's
own "there is no default allow-set" sentence before D5 sharpened it.

*Cost if wrong: nothing mechanical, which is exactly what makes it easy to get wrong twice.
If the correction is over-applied and the refusal is softened into a warning, privileged text
routes somewhere the operator never declared on a badge nobody read, and no retry un-sends it.
If it is under-applied and a default allow-set creeps back — in a config loader, a compose
file, a `.env.example`, or a later edit that finds an unset variable inconvenient — the system
runs on the spec author's guess about a firm's contracts while presenting it as the firm's
declared policy, which is a false control of the same family as the merged no-keys sentence
D3 exists to keep apart: it reads as a decision, it is a guess, and nobody looks behind it. And
if the framing itself is left uncorrected, the document tells a firm's Risk function that the
system has judged their provider, which is a claim this design cannot support and which would
be read as assurance by exactly the reader least able to check it.*

---

# Stage 1 (gateway) — rulings made without owner review (2026-08-29)

The execution ledger lives at
`.superpowers/sdd/2026-08-28-lexprompt-server-stage-1-gateway/progress.md`, which is
**gitignored and disposable**. These are the decisions from it that outlive the stage,
recorded here because this file is the durable home for "decided without review, with
cost-if-wrong" — and because several of them **corrected an earlier mistake**, including
two of the repository owner's own. That is the useful half of the record and it is kept
intact; none of these is written as an achievement.

**A note on the identifiers.** The ledger numbered its rulings by the task that raised
them (`L1`, `T1`, `A1`, `F1`, `R1`, `E1`, `H1`, `E2`, `O1`, `S1`), and two of those names
collide with names already in use: this file's **R1** is the identity/multi-user ruling at
the top, and the server spec's **S1** is "the gateway is the only component permitted to
egress". The ledger's `R1` and `S1` below are neither. They keep their original names so
the ledger and this file can be read against each other, and the collision is stated
rather than silently renamed away.

## Rulings taken during execution

- **L1 (Task 6, the log sink) — the spec was stale and the plan was right.** §10.5, §12,
  §14, §18 and spec ruling S26 all say the gateway "refuses to start with no log sink
  configured". The implementation has **no log-sink configuration at all**:
  `JsonlAuditSink` writes JSON lines to stdout unconditionally, in every environment, and
  a runtime write failure refuses the call (P3). There is therefore no configuration in
  which the sink is absent, missing or disabled, and nothing for a startup check to check.
  The **spec** was corrected, with S26 gaining a dated amendment note rather than being
  edited away. The property is now held by construction rather than by validation — with
  no configuration there is nothing to misconfigure, which removes the failure mode
  instead of detecting it — and a `stage1DoD` assertion forbids any
  `GATEWAY_*LOG*`/`*SINK*` key appearing in the gateway's configuration surface.
  *Cost if wrong: a spec that under-promises. The logging floor itself does not move. But
  if a later stage adds a configurable sink — a collector endpoint, a second destination —
  this ruling is void and §10.5's startup refusal must actually be written; recorded here
  rather than left implicit, because otherwise §18.2's line is satisfied vacuously and
  nobody would notice it had stopped being true.*

- **T1 (Task 7) — the typecheck gate was checking three fewer projects than anyone
  believed.** Task 7 reported two type errors that its own gate surfaced and the
  supervising gate did not. The cause was worse than two bad casts: `npm run typecheck`
  named its projects by hand and the list had three holes — it never checked
  `packages/core` at all, and it chained a nonexistent `apps/api/tsconfig.json` (so the
  script exited non-zero regardless of the code, and would have until Task 16) — while the
  gate actually being run between tasks was the ROOT `tsc --noEmit`, which does not cover
  the gateway's test files. Two real errors survived two task reviews. The list was
  replaced with **discovery** over `packages/*` and `apps/*`, and the script now reports
  every failing project instead of stopping at the first.
  *Cost if wrong: the script runs `tsc` on a tsconfig that was not meant to be a project
  root, which fails loudly and visibly on the next run. Against that: a list has to be
  updated by whoever adds a workspace, and discovery cannot be forgotten.*

- **A1 (after Task 9) — a flattened error status made permanent failures retryable.**
  Task 9's implementer flagged, without resolving it, that `decodeEvent` flattened every
  mid-stream Anthropic error except `overloaded_error` to 502. Since `isRetryableStatus`
  is `429 || >= 500`, the flattening made `authentication_error`, `permission_error` and
  `invalid_request_error` **retryable**: the gateway would have retried calls that can
  never succeed and then reported a permanent misconfiguration as a transient provider
  fault — the loud specific failure arriving late and under the wrong name — and Task 11
  was about to build the retry policy on top of it. It was also sibling drift:
  `openaiCompatible` already used the provider's own status where it had one. Fixed with a
  lookup, unknown types still falling back to 502; the tests assert the retry
  **consequence** (`isRetryableStatus(401) === false`) beside the status, so they cannot
  keep passing if the retry predicate changes underneath them.
  *Cost if wrong: a status mapped one step off sends a retryable failure to a fail-fast
  path or the reverse — visible immediately in the conformance suite and in the retry
  tests.*

- **F1 (Task 10) — every stream fixture is synthetic, and says so.** The brief wants
  fixtures captured from live provider responses. **There are no provider API keys in this
  environment**, so all five are hand-authored from each provider's published wire format
  and all five are marked `synthetic: true`; no fixture header claims a live capture. A
  synthetic fixture wearing a recording date would make the suite look stronger than it is
  and destroy the only thing the flag is for. The suite still catches what it exists for: a
  dropped final event, CRLF framing, split chunk boundaries, and provider-isolated decoder
  regressions.
  *Cost if wrong: a fixture that misstates a provider's real wire format passes the suite
  and fails against the live provider — which is precisely the failure §19 calls the
  highest-risk code in Stage 1, so this is a known gap rather than a covered one.*
  **Open follow-up: re-record all five against live providers once keys exist, and flip
  `synthetic` to false only for the ones actually captured.**

- **R1 (Task 11; NOT this file's R1) — a placeholder rate limiter, named so it cannot be
  mistaken for a policy.** The brief's `CallContext` requires `limiter: RateLimiter` and
  imports it from a file Task 14 creates, so Task 11 as written could not typecheck. Task
  11 creates the interface, Task 14 the implementation; the `limiter.check`/
  `limiter.record` call sites stay exactly where the brief puts them, because they are
  integral to `callModel`'s shape and re-threading "the one call path" in a later task is
  exactly what must not happen. The placeholder is named **`unlimitedRateLimiter`**, never
  `defaultRateLimiter`: it enforces nothing, and a limiter that silently permits
  everything while calling itself "default" is a correct mechanism with no path to it —
  this project's single most repeated defect. The self-describing name is the guard.
  *Cost if wrong: the gateway does not rate-limit between Tasks 11 and 14, a window inside
  one stage with no deployment in it.*

- **E1 (after Task 13) — a scheme branch that held by convention, not by construction.**
  `transport.ts` branches on the endpoint URL's **scheme**: anything not http(s) is read
  from the filesystem, which is how the `recorded` provider replays a fixture without
  becoming a second code path chosen by an environment flag. The design is right, but it
  was safe only while no other adapter could produce a non-http URL — and `config.ts`
  validated `endpoint` with a non-empty-string check and nothing else. An endpoint written
  `api.openai.com/v1` (a missing scheme, the likeliest typo in that file) would have sent
  a real provider call into `readFileSync`: an ENOENT blaming a fixture for a malformed
  endpoint, or — if the path happened to exist — a local file parsed as a model response.
  Now required `https://`, or `http://` on loopback only, mirroring the rule §7 already
  applies to the API's OIDC issuer. Same distinction as L1: a property everyone must
  remember to uphold is weaker than one that cannot be violated.
  *Cost if wrong: a legitimate endpoint form is refused at startup, loudly, naming the
  entry.*

- **H1 (after Task 15) — the `/healthz` auth exclusion is mode-dependent, and its comment
  said otherwise.** The implementer flagged, without resolving it, that with
  `rejectUnauthorized: true` a certless caller fails the TLS handshake before Fastify
  routes anything, so `server.ts`'s `/healthz` exclusion never runs for it — contradicting
  its own comment. Investigated: the exclusion is not dead code, it is mode-dependent.
  `main.ts` applies TLS options **only** when `mode === 'mtls'`; in `entra` mode the
  server is plain HTTP behind internal-only ingress, the platform's probe reaches
  `/healthz` with no token, and the exclusion is load-bearing. In `mtls` mode the
  handshake rejects first, and the consequence is concrete: **a compose healthcheck written
  without `--cert` reports the gateway permanently unhealthy while it is fine**, restarting
  a healthy container on a schedule and looking exactly like a crash loop. The comment now
  states both cases; no behaviour changed.
  *Cost if wrong: none to running code. The carried obligation — that the compose
  healthcheck presents the client certificate — was discharged in Task 24 and is written
  into `docker-compose.yml`'s own comment.*

- **E2 (after Task 16) — a variable named `loopback` for a check that was not.**
  (a) `assertIssuerUsable` permitted plaintext `http` for loopback **or any dotless
  hostname**, and stored that in a variable called `loopback`. The widening is necessary —
  compose reaches Keycloak at `http://keycloak:8080`, a container-network name that is not
  loopback and cannot be made so from inside another container — but the identifier claimed
  a stricter check than the code performed, which is how the next reader concludes plaintext
  is impossible off localhost. Renamed `plaintextPermitted`, with the error naming which
  form the host failed to be. (b) `apps/api/src/config.ts` had **no tests at all**,
  including the path where S29's issuer refusal runs; a refusal nothing exercises is one
  nobody would notice losing. Eleven cases added and mutation-tested.
  *Cost if wrong: (a) is naming and documentation, no behaviour change.*
  **Open question for the owner, and it is a real one:** a single-label hostname is
  unroutable on the internet but **is** resolvable on a corporate network, so `http://sso`
  in a firm deployment would pass this check. That is wider than §7/S29's words. It should
  be a decision — accept it, or ship a dev CA so https is required everywhere — rather
  than a discovery.

- **O1 (after Task 20) — Tasks 21 and 22 swapped, and a live credential left at rest.**
  Task 21's guard asserts no call site passes `modelId`, while Task 21's own snippet reads
  `settings.modelChoiceId` — a rename belonging to Task 22. Running 21 first would have
  forced a broken assertion, a relaxed guard, or a dishonest bridge. Reordering also closed
  sooner a finding Task 20 raised and rightly refused to fix from its own files:
  **`openrouter.ts` was deleted and no request could carry a user key, but Settings still
  asked for one, still wrote it to `localStorage`, and `isConfigured` still required it.**
  A user pastes a valid key, is told they are configured, and every review fails for a
  reason the screen never names — a confidently-wrong UI over a live credential sitting at
  rest for nothing. Task 22 therefore also **actively purges** an already-stored key: a key
  typed last week does not vanish when the field does.
  *Cost if wrong: Task 21 runs against a settings shape that has already moved, which fails
  loudly at typecheck rather than silently.*

- **S1 (after Task 23; NOT the spec's S1) — one sentence, five copies, three workspaces,
  and a network in the middle.** Task 23's implementer flagged that `ResultsView`
  classifies a finding's failure by **matching the gateway's exact wording** with a regex.
  Searched rather than assumed, and it was worse than the one coupling flagged: five copies
  of the same sentence across three workspaces, four writers and one reader, with nothing
  making them agree. Reword any one and the browser silently stops classifying — no error,
  no failing test, just a firm-configuration fault shown to a lawyer as an ordinary one
  they might fix. Sibling drift with a network in the middle, the version nothing catches
  by accident. `SERVICE_CONFIG_HINT` now lives in `packages/core` and every writer and the
  one reader use it. **Demonstrated, not asserted:** rewording the constant leaves the full
  suite green, because they all move together.
  *Cost if wrong: the sentence becomes a shared vocabulary rather than per-surface copy. If
  a surface ever needs its own wording it takes its own constant, visibly.*

## Rulings taken in Task 26, the closing sweep

- **The composition-root exemption is three files, not two.** `configSurface` permits
  `process.env` in the three typed config modules and in the composition roots, and the
  plan named two — the `main.ts` of each service. The shipped gateway has a third entry
  point, `smoke.ts`, with its own `main()`, its own `loadConfig` call and its own npm
  script. The honest options were to name it or to exempt its whole file from the scan, and
  **a file-level scanner exemption hides everything in that file, not just the part you
  meant to protect** — the `PdfCanvas` lesson, which cost three hidden dark-palette states.
  Naming it also held it to the pass-through rule, which is what caught it reading
  `process.env.USER` directly; that now goes through `config.readEnv`, so all three roots
  hand the environment to `loadConfig` and read no key themselves. The list is asserted to
  be exactly those three.
  *Cost if wrong: a fourth entry point has to be added to a list and justified in review,
  rather than arriving unnoticed. The exemption is the one part of this guard that can be
  widened to make a failure go away, so it has a test of its own.*

- **`GATEWAY_PUBLIC_ORIGIN` is a divergence, not a same-everywhere value.** Azure sets it
  from the web app's provisioned FQDN; the compose stack has no provisioned FQDN and falls
  back to the code default. The plan filed it under "same everywhere", which the
  both-directions check disproves. It is tabled under §5.1 row 9 (ingress) instead — the
  alternative was to invent a local value and set it in `docker-compose.yml`, which would
  have made the table say the two environments agree about something they do not.
  *Cost if wrong: one row in a table is longer than it needed to be. The opposite error — a
  real difference filed as "no difference" — is the exact rot §19 says §5.1 is exposed to.*

- **A third configuration category: read by a module, set by neither environment.** Eight
  gateway values (prompt-size cap, request timeout, four rate limits, default max tokens,
  recorded-fixture directory) are read by `config.ts` and set in no environment file at all
  — they are code defaults. Left unclassified they are invisible to the divergence check
  entirely, which is how one of them could later be set in one environment only and become
  an undeclared divergence. They are listed, and asserted to be set by **neither** side.
  They are **not** the same case as `GATEWAY_ALLOWED_JURISDICTIONS`: a size cap or a
  timeout is a property of the software's own behaviour, which the software is entitled to
  have an opinion about; which jurisdictions a firm permits is a property of that firm's
  contracts, which it is not.
  *Cost if wrong: eight names in a JSON file to keep current. Against that, a value that
  silently starts differing between environments with no row naming it.*

- **The sweep searches comment-stripped source, not raw text.** §18 says "searched for, not
  assumed" four times, and the naive search does not work on this codebase: it explains its
  own rules at length in prose — why nothing reads `process.env`, why the app does not use
  MSAL, why `storage.ts` deletes an `apiKey`, why `openrouter.ts`'s old contract retired —
  and a raw text scan reports every one of those notes as a violation of the rule it exists
  to explain. An executor meeting that either relaxes the pattern until it stops biting or
  exempts the file, and both end with a guard that no longer searches for the thing it
  names. Comments are removed first, by the TypeScript parser rather than by a regex that
  cannot tell `//` inside a string from `//` starting a comment. Where an exemption is
  genuinely needed it is ONE NAMED FILE and the list is asserted to be exactly that file —
  `storage.ts` for `apiKey` (it deletes one) and `privacyCopy.ts` for `openrouter.ai` (it
  tells a user to go and revoke a key, because deleting a key from a browser is not
  revoking it).
  *Cost if wrong: a violation written inside a comment is not flagged — the correct trade,
  since a comment is not a code path, and the alternative demonstrably ends in a guard
  nobody trusts.*

- **Every scanner asserts it found something before anything is asserted with it.** A
  scanner that silently matches nothing passes vacuously and reads as coverage. Each one
  here is preceded by a check that it walks a realistic number of files, that its patterns
  match a known-positive sample, and — for the audit-record AST walk — that both record
  literals were actually found.
  *Cost if wrong: a handful of extra assertions. Against that, this project has shipped
  tests that passed against unfixed code and proved nothing, more than once.*

- **The API refuses to start when it cannot authenticate to the gateway.** Task 25 raised
  this as an OPEN finding it could not fix from its own files: `main.ts` called
  `makeGatewayClient(config)` with no `getGatewayToken`, so under
  `GATEWAY_CALLER_AUTH=entra` — the Azure configuration — the gateway would have refused
  **every** call from the API. The two ways to close it were to wire managed-identity token
  acquisition, or to make the gap loud. **Made loud**, deliberately: wiring it needs
  `@azure/identity` in `apps/api`, a gateway-audience value this service is not given, and
  a real tenant to test against — none of which exists here, and shipping unverifiable
  authentication code into the one path that protects the credential boundary is the worse
  of the two mistakes. `makeGatewayClient` now throws a `ConfigError` when it has neither a
  client certificate nor a token source, inside `main.ts`'s startup guard, naming both
  caller-auth modes and the missing wiring. The check is written as "some credential
  exists", never as "mTLS is configured", so Stage 2 supplies `getGatewayToken` and edits
  nothing else.
  *Cost if wrong: `azd up` provisions successfully and the `api` container then fails its
  startup, loudly, until the token wiring lands — where before it would have started
  cleanly, reported itself healthy, and had every model call refused. A crash-looping
  container with an explanatory log line is a far cheaper failure than a healthy-looking
  service whose model calls silently never succeed, and it is the one this project's own
  rule prefers.*

- **The Task 26 brief's reference code was wrong in five places, and was corrected against
  the shipped files rather than adopted.** It named `API_OIDC_ISSUER` and four siblings
  that no code reads (the real names carry no `_OIDC_` infix); it tabled the identity keys
  as divergences when their NAMES are identical in both environments and only their VALUES
  differ; it listed eleven `sameEverywhere` keys that appear in neither environment; its
  compose parser read only `environment:` blocks, so the web app's four `VITE_*` build
  arguments — the only place the browser's configuration exists, in either environment —
  were invisible to it; and it asked for five doc comments naming `openrouter.ts` to be
  corrected in five files that do not contain the string. **Before applying anything a
  brief calls current, diff it against the shipped source.**
  *Cost if wrong: a divergence check that passes while asserting half of what it claims —
  the specific failure §18 item 10(b) exists to prevent, reintroduced by the document that
  specifies it.*

## The plan's own rulings, as executed

Recorded because they were taken while planning this stage, without owner review, and they
bind anything that extends it. The spec's S1–S31 are not restated here; only what execution
decided.

- **P1. One SSE event splitter in `packages/core`; each adapter contributes only a pure
  `decodeEvent`; `apps/api` parses nothing.** *Cost if wrong: five copies of a parser this
  project has already fixed twice, at a boundary where the failure is a short answer rather
  than an error.*
- **P2. A stream that ends without a terminator frame is an error, not a short answer.**
  *Cost if wrong: a truncated answer about a contract, indistinguishable from a complete
  one — which a lawyer would find and a test would not.*
- **P3. The audit record is written before the upstream call, and a sink failure refuses
  the call.** *Cost if wrong: an unlogged egress, which is the one thing the gateway exists
  to prevent, and "what of ours went where" stops being answerable.*
- **P4. The jurisdiction gate has no default anywhere, and its absence is mutation-tested
  in all six of its homes** — the gateway's config loader, `docker-compose.yml`,
  `.env.example`, both Bicep files, and `main.parameters.json`. *Cost if wrong: an operator
  types one variable before the gateway starts. Against that, the absence of a default is
  invisible to every happy-path test — with one restored the gateway starts, the gate still
  refuses an undeclared model, the banner still prints its table, and nothing looks wrong —
  so a later, entirely well-meant "sensible default" would slip in green, and the system
  would then enforce one firm's contractual scope as though it were a property of the
  software.*
- **P5. Every provider's stream decoding is proved by one conformance battery over recorded
  fixtures; a provider with no fixture fails the build; a synthetic fixture says so in the
  file.** *Cost if wrong: a provider changes its event shape and the suite stays green. See
  F1 — all five fixtures are currently synthetic.*
- **S25, narrowed deliberately.** §10.2's interface has six members and S25 lists five
  adapter-owned concerns; the shipped `ProviderAdapter` has three functions. Two moved:
  **credential acquisition** to `credentials/resolve.ts`, because which of four sources a
  credential comes from is a property of the deployment and not of the provider's wire
  protocol; and **error classification** to `isRetryableStatus` in `packages/core`, applied
  once in `callModel.ts`, because §10 itself says the retry policy runs once in the core.
  *Cost if wrong: retryability is read off the HTTP status alone, which is correct for all
  six current providers (Anthropic's 529 falls under `>= 500`) and wrong for any provider
  that signals it in a response body. The remedy is named in `adapters/types.ts` so it is
  not improvised: such a provider adds an optional `classifyError?` to the interface. It
  never becomes an `if` on a provider id in the core, which `stage1DoD` forbids and which
  would be the duplication S25 exists to prevent, inverted.*

---

# Server Stage 2 — storage and authentication (2026-08-29 → 2026-08-30)

Twenty-seven tasks, in two parts with a gate between 18 and 19. Postgres and Blob Storage
behind the nine repositories' existing interfaces; sign-in as the real gate, with roles the
API refuses on; precedent documents stored server-side; and a one-release uploader that
moves a browser's data and names what it could not.

The plan's decision labels are **P6–P16**, continuing Stage 1's P1–P5. As with Stage 1,
nothing here restates the spec's S-rulings; only what planning and execution decided
without owner review, each with what it would cost if it turned out wrong.

**Several of these corrected an earlier mistake, and two of the mistakes were the
supervisor's own.** They are recorded that way rather than as achievements, because a
ledger that only lists what went right is a ledger nobody consults when something goes
wrong.

## The pre-flight rulings, taken before Task 1

These are the four spec/shipped-code disagreements ruled on before any code was written.
The ledger for this stage was created at **Setup**, deliberately: Stage 1's was
reconstructed at Task 7 and its Tasks 1–6 rulings were lost.

- **P12 — document parsing stays in the browser this stage, and `parse_state` is stored
  from the day the column exists.** §11 says parsing moves server-side; §13 puts the
  engine that needs it in Stage 3. Both are right about different things, and a reader of
  §11 alone would expect a parse worker here. Moving it now would change
  `addDocument(rec, bytes)`'s contract — the caller change R3's seam exists to prevent —
  for a queue that does not yet exist. Stage 3 changes **who writes those columns**, not
  what they are; `'pending'` is already in the check constraint and unused, and the
  "Reading…" state §11 asks for renders from it.
  *Cost if wrong: a scanned PDF is parsed on a laptop rather than on a server, which is
  where it has been parsed since this project started. The failure this defers is a
  latency one, not a correctness one. Against that: the moment a second writer of
  `parse_state` exists, "who last wrote this column" stops being obvious, and Stage 3 has
  to answer it explicitly rather than inherit it.*

- **P13 — `position_basis` keys on `(playbook_id, clause_id)`, because `StandardPosition`
  has no id.** §6.5 writes `position_basis(standard_position_id, …)` and **that cannot be
  satisfied literally**: a standard position is a field on a clause inside an immutable
  `PlaybookVersion`, and it has no identity of its own. Keying on the version id was the
  obvious alternative and is worse than wrong — it would make a firm's evidence vanish on
  every publish, which is the exact opposite of §11.1's argument for storing precedents at
  all. Ruled: key on the clause's identity across versions, and additionally record
  `adopted_in_version_id` and the position text **as adopted**, so a panel can say *the
  wording has moved* rather than implying four leases support today's sentence.
  *Cost if wrong: a clause id reused for a different clause in a later version would
  attach one clause's evidence to another. Against that, keying on anything version-scoped
  makes the evidence disappear on a publish, silently, which is the failure a lawyer would
  meet and a test would not.*

- **Nine repository modules, eight tables.** §6.1 lists nine IndexedDB stores as tables
  including `blobs -> (none)`, and §13's Stage 2 sentence says "the nine repositories".
  `blobs.ts` becomes a route over Blob Storage rather than a table. Recorded so a later
  reader counting tables does not conclude one is missing.

- **Four places R3's seam does not hold** — named in advance as findings rather than as
  silent widenings: `publishVersionIn`'s `idb`-typed parameter; `Matter` and its siblings
  gaining an optional `version`; `Settings` losing its model fields; and the nine
  `await getProfile()` write paths in `App.tsx` that can now reject.
  **Four was the number to check the execution against, and the answer is five.** Tasks
  9–10 found a fifth the pre-flight had not predicted: **`ownerId` becomes
  server-authoritative.** A client may no longer name a matter's owner; the API takes it
  from the token. That is a contract change at a public signature, it is correct, and it
  was not foreseen. Task 16 also found the fourth was undercounted — nine `getProfile()`
  call sites claimed, eleven actual, and **five of them carried a real unhandled-rejection
  bug**, the same class as the flake that made the suite intermittently exit 1 with every
  test passing.
  *Cost of having been wrong about the count: none directly — each break was found by the
  compiler or by a test. The cost is to the confidence the number was offered with, which
  is why it is corrected here rather than quietly updated.*

## P6–P16, as executed

- **P6. Record ids stay `text` and client-minted by `uid()`; only `workspace.id` and
  `app_user.id` are `uuid` and server-minted.** Executed as written. *Cost if wrong: a
  client can choose a colliding id. It is scoped by `workspace_id` and refused by a
  primary key, which is a loud failure. Against that: making every id server-minted would
  have broken the uploader, which has to carry a browser's existing ids across unchanged
  or nothing that references them survives.*
- **P7. One idempotent `PUT /v1/<thing>/{id}` per repository `save*`; no create/update
  split.** Executed as written. *Cost if wrong: a `PUT` that creates is unusual REST. It is
  also what makes the uploader safe to run twice, which is P15's whole property.*
- **P8. `src/lib/db/` keeps its path and its file names; the bodies become HTTP.**
  Executed. The seam held for all nine repositories' **public signatures** and broke in the
  five places above. *Cost if wrong: every caller in `App.tsx` changes at once. It did not
  happen, and the five exceptions are each a declared finding.*
- **P9. Every mutable record carries `version bigint not null default 1`; a stale write is
  refused `409` with the current row.** Executed. The **409 already returns the current
  row**, so Stage 4's *"Priya changed this to Rejected at 14:22, after you loaded it"*
  needs no second round trip. *Cost if wrong: the stale-change refusal and the realtime
  version guard must remain one number doing two jobs; two numbers is the failure §8 names.*
- **P10. Two Postgres roles — `lexprompt_migrator` owns the schema, `lexprompt_app` runs
  every request — and the grants are part of the migration, not a runbook.**
  *Amended, 2026-08-30 (Task 24).* The **grants** are in the migration, as ruled. The
  **roles themselves** cannot be: `infra/postgres/init.sql` creates them locally, and in
  Azure they are one `psql` run by the Flexible Server admin, because a role needs a
  password the template must never see. That is a runbook step, it is named in the README,
  and `000_preconditions.sql` refuses the migration with a message naming it rather than
  letting a `GRANT` fail with "role does not exist". Recorded as an amendment rather than
  edited away: the ruling's *intent* — that a grant is not something a human remembers to
  apply — survives intact.
- **P11. Findings stay a `jsonb` column on `review`; they become rows in Stage 3.**
  Executed. The column holds the exact `Record<findingsKey, Record<clauseId, Finding>>`
  shape `types.ts` declares, so Stage 3's migration is a `jsonb_each` shred and not a
  translation. *Cost if wrong: no per-finding query until Stage 3, which nothing needs yet.*
- **P12 / P13.** Above.
- **P14. Blob credentials are resolved from an explicitly configured *source*, never
  inferred from which value happens to be set, and the sources never fall back to one
  another.** Executed, and it is the strongest small ruling in this stage. A fallback means
  the system used a different identity than the operator configured and said nothing.
  *Cost if wrong: a misconfigured deployment refuses to start instead of limping. That is
  the trade this project makes everywhere.*
- **P15. The uploader is a route, not a modal, and it is idempotent.** Executed. It ships
  for one release; the release that removes it is the release that deletes the local
  IndexedDB database, **after the owner confirms the server copy is good**, and that is
  also when `fake-indexeddb` and the `node:buffer` Blob workaround finally go.
  *Cost if wrong: a modal cannot be linked to, reloaded, or returned to half way, and this
  screen is the one place a firm's entire working history passes through.*
- **P16. Every attribution field in uploaded data is rewritten to the uploading user's
  `app_user.id`, and the report says how many were rewritten and where.** Executed.
  *Cost if wrong: a verification attributed to a local profile id that names nobody, which
  is worse than one attributed to the person who actually did the upload — but only just,
  which is why the report says the rewrite happened rather than performing it silently.*

## Rulings taken during execution

- **C1 (Part 2A review) — a review became permanently read-only the moment any document it
  covered was removed from its matter, and the fix had to not open the hole the check
  existed to close.** `routes/reviews.ts` ran "every document the target names must be in
  this matter" **unconditionally**, on the upsert path as well as on create. Deleting a
  document is one click that touches no review; from that moment every save of every review
  that covered it answered 400 — verify, flag, reject, add a note, confirm a net position,
  amend one, retry a cell, the debounced auto-save — **forever**, with no UI anywhere able
  to edit a stored review's `documentIds`. The review still *opened* (§9, deliberately) and
  was then silently unwritable, which is this project's founding failure shape at a new
  layer: a screen that looks fine and quietly refuses to record what a person just decided.
  **Resolved by scoping the check to the ids a write INTRODUCES**: the stored row's
  `document_ids` union the incoming `documentIds` are read inside the same transaction and
  grandfathered, and anything not already on the row is checked exactly as before. A review
  is the record of what was examined, and the matter's membership having changed since does
  not make that record false. Dropping the check outright was rejected — it exists so a
  review cannot be **created** citing another client's contract. The union is read through
  one function (`documentIdsIn`) used for both sides, and `PUT /v1/collections/:id` got the
  same treatment when its sibling defect was closed, so the two cannot drift apart.
  *Cost if wrong: a review walked into another matter could have foreign ids re-read as
  native there. It cannot: `matter_id` is deliberately **not** in the `DO UPDATE` list, and
  an id can only be on the stored row by having passed this same check on the write that
  first put it there. Both halves have their own test.*

- **The precedent promise reversal — S19 is amended, and the sentence had to change in the
  same commit as the storage.** The app told a lawyer, on the screen where they choose
  which of their client's marked-up documents to bring in, *"Read once to learn from. Never
  stored."* That was **true when it was written**. Owner decision D2 made it false. §11.1
  states the ordering as an acceptance condition — *there is no release in which the
  storage exists and the sentence does* — and Task 19 shipped both in one commit
  (`6eeb067`), with the replacement in `privacyCopy.ts` and rendered once, on the same
  header the old sentence occupied.
  **The reversal is the point, not the storage.** A promise a firm relied on was withdrawn,
  and the record of it being withdrawn is more useful than a clean statement of the new
  rule. `CLAUDE.md`'s precedent paragraph was **inverted** in that same commit for the same
  reason.
  The search for the old promise is a **suite**, not a grep run once
  (`src/test/precedentPromise.test.ts`), and it covers the **test suite** as well as `src/`
  and the README — because a test still asserting the old promise is a test somebody
  restores by treating red as a regression. It found a **seventh** place the task brief's
  own grep could not have: `App.tsx`'s `REDLINES_DIRTY_MESSAGE`, the modal a person reads
  at the moment of leaving, said leaving *"loses the documents you brought in"* — the same
  false claim in words the pattern did not contain.
  *Cost if wrong: the app shows a lawyer "Never stored" while storing their client's
  papers. S24 calls that the founding defect of this project in its purest form, and it
  would have been shipped deliberately.*

- **`document.doc_type` versus `document.kind` — two different facts that share one word in
  the TypeScript, named apart in the schema.** `types.ts`'s `DocumentRecord.kind` is the
  *file* type (`pdf`/`docx`/`txt`); §11.1's matter-versus-precedent distinction is also
  called `kind`. In SQL the file type is `doc_type` and the §11.1 fact is `kind`; on the
  wire the §11.1 fact is `storedAs`. Task 19's brief asserted `doc.kind === 'precedent'`,
  which cannot be satisfied against the shipped types and would have re-conflated them.
  *Cost if wrong: a query filtering `kind = 'pdf'` and one filtering `kind = 'matter'` both
  compile, and one of them is catastrophic — it shows another client's papers where a
  lawyer expects the deal in hand, and nothing on screen looks wrong. §19 names this as the
  thing to watch in this whole stage.*

- **Two tests that could not fail, found by mutation and not by review (Tasks 11–15).**
  A `for update` assertion did not fail when the lock was removed, because
  `unique (playbook_id, version_number)` refuses the duplicate with or without it — so a
  uniqueness-only assertion passes over a route with no serialisation at all. And
  `authz.route.test.ts` stayed green when the partner gate was downgraded, because its
  matrix ran against a **fixture** policy rather than the shipped table.
  *Recorded because both were written in good faith and both read as coverage. The Stage 2
  DoD sweep now asserts that `authz.route.test.ts` imports `ROUTE_POLICY` from
  `../src/auth/routeTable.ts`, and that assertion is itself mutation-tested.*

- **The advisory lock in the migration runner was proved by running it, not asserted.**
  Without it, 6 of 11 concurrent runs applied the same file twice; with it, 0 of 11. And a
  genuinely broken migration was dropped into the real image to confirm the refusal:
  `lexprompt-api-1` exited(1) naming the file and the syntax error.
  *Recorded because "the lock is there" and "the lock works" are different claims, and only
  the second is evidence.*

- **`stage1DoD`'s credential guard was narrowed, deliberately and to one file (Task 10).**
  `DefaultAzureCredential` came off the forbidden-pattern list for `apps/api`, because S1/S2
  is about **model provider** credentials and a managed identity for the firm's own
  document store is a different fact — §6.5 says in as many words that the bytes are
  "reachable only through the API's managed identity", so the pattern as written made §6.5
  unimplementable. Scoped rather than removed: the exemption is asserted to be exactly
  `apps/api/src/blob/store.ts`, and that one file is held to the **full** provider-credential
  pattern list and to holding no other credential machinery.
  *Cost if wrong: a file-level exemption hides everything in that file, not just the part
  you meant to protect — the `PdfCanvas` lesson. The second half is what keeps this from
  being a hole.*

- **Task 24 — `AZURE_CLIENT_ID`, a key no configuration module reads and without which
  nothing works in Azure.** `apps/api/src/blob/store.ts` constructs
  `new DefaultAzureCredential()` with no options. The managed-identity leg of that chain
  resolves a **user-assigned** identity's client id from `process.env.AZURE_CLIENT_ID` and
  from nowhere else (@azure/identity 4.13.1, `createDefaultManagedIdentityCredential` —
  read in this repository's own `node_modules`, not assumed). The api Container App has a
  user-assigned identity and **no system-assigned one**, so without that variable the chain
  asks for a token that does not exist and every document byte read and write fails at
  runtime, in a deployment whose entire test suite is green. It is tabled in
  `divergence.json` by hand and given a test of its own, because every classification check
  in `configSurface` is blind to a key no config module reads.
  *Same class as Stage 1's `oidcRequiredClaims`-given-as-JSON: visible only against a real
  tenant, and found by reading the loader rather than by trusting the name. Cost if wrong:
  the firm's documents are unreachable on the first deployment, and the error names an
  identity rather than a missing variable.*

- **Task 24 — holding every credential in Key Vault costs a two-phase first deployment,
  and that is the trade being made.** The Postgres admin password and the two application
  role passwords are read with `getSecret()` from the vault this template creates, so the
  **first** `azd provision` against a fresh subscription fails: the vault is created empty.
  The failure is loud and names the vault and the secret, and the README walks the sequence.
  The alternative — a `@secure()` parameter fed from the azd environment — would put three
  live database credentials in `.azure/<env>/.env` on somebody's laptop.
  *Cost if wrong: a deployer meets a failure on their first run and has to read a README.
  Against that: a credential on a laptop is a credential in a backup, in a screen share, and
  in whatever syncs that folder.*

- **Task 24 — a VNet arrived and the egress sentence did not change.** Integrating the
  Container Apps environment with a VNet is what makes the two private endpoints resolve.
  It does **nothing** to `api`'s outbound traffic: Container Apps still gives every replica
  default outbound internet access unless a route table, a NAT gateway or a firewall is put
  in front of it, and none of those is created here. Spike 2 is still open and the README
  still says so.
  *Cost if wrong: exactly the sentence §19 warns about — a security claim that becomes true
  in a reader's head because a related thing arrived. "The environment is now VNet
  integrated, therefore api cannot egress" is false, and it is the kind of false that gets
  written into a Risk answer.*

- **Task 24 — three undeclared caps had already bitten this project, so this one is
  declared.** Fastify's 1 MiB `bodyLimit`, nginx's 1 MiB `client_max_body_size` and
  busboy's `fieldSize` were each a library default nobody had written down, and all three
  were on the scanned-document path. A Flexible Server's `max_connections` is the same
  shape — derived from the SKU, invisible unless named, and exceeded it refuses new
  connections outright rather than degrading. It is now declared explicitly in **both**
  environments, with the arithmetic written beside it
  (`API_DATABASE_POOL_MAX` x replicas + headroom <= `max_connections`), and Postgres
  auto-grow is off against an explicit storage size for the same reason.
  *Cost if wrong: two numbers to keep in step instead of one inherited default. Against
  that: an inherited default is a number nobody can see until it is exceeded.*

- **Task 26 — two of §2's rows said Stage 1 had already rewritten a sentence, and it had
  not.** "No backend, no server-side anything" was still in the README's "How it's built"
  verbatim, and privacy bullet 2 had been rewritten around the **gateway** when documents
  go to the **API**. This is `CLAUDE.md`'s frozen-copy rule biting in the direction it
  warns about: a spec quoting a file is transcribing what shipped when it was written.
  *The shipped wording wins on a mismatch, in both directions — including when the spec
  claims something was already fixed.*

- **Task 26 — two false sentences §2's table does not list, found by reading rather than by
  following it.** `SOURCE_PRIVACY` said *"the model you have chosen"* (the model choice
  became workspace configuration an administrator sets in Task 18) and *"the only place
  another matter's content leaves your browser"* — a frame that was exact when every matter
  lived in one browser's IndexedDB and is now wrong in the **understating** direction,
  since the matters are already server-side. The claim that survived the move is narrower
  and is what it now says: the one place a matter *other than the one under review* reaches
  a model.
  *Cost if wrong: a disclosure that understates where a firm's content sits is the same
  category of defect as one that overstates a guarantee, and it is harder to notice because
  it reads as reassuring.*

- **Task 27 — a DoD sweep must not restate what a real-database suite already proves.**
  Most of §18 item 3 is carried by a suite that runs the real thing — a real Postgres, real
  Azurite, a real Fastify with the shipped policy table. Re-asserting those here would give
  each property a second home that never touches a database, and the weaker home is the one
  that stays green when the property breaks. So the sweep asserts the **structural** facts
  those suites cannot check about themselves: that each suite is wired to a runner, that
  every table in the migrations has a named home for its round trip, and that the
  authorisation matrix reads the shipped table. Twenty-six mutations were run and every one
  killed a **named** test.
  *Cost if wrong: a sweep that looks comprehensive and proves less than the suites it
  summarises — which is the shape §19 warns will be proposed for deletion, and would
  deserve it.*

- **Task 27 — one of this sweep's own assertions could not fail, and was found by
  mutating it.** The blob round-trip check read `blobStore.compose.test.ts` as raw text and
  asserted it contained `0x00` and `0xFF`; the file's own **comment** explains why those two
  bytes were chosen, so replacing the payload with ordinary text left the assertion green.
  Fixed by reading comment-stripped source. Recorded because this stage has already shipped
  several assertions that could not bite, and the only reason this one did not join them is
  that the mutation was actually run.

## Spec-versus-plan disagreements, recorded rather than smoothed

Three, each already resolved above but named here so a reader of the spec alone is not
surprised:

1. **§11 says parsing moves server-side; §13 puts the engine that needs it in Stage 3.**
   Resolved by P12. The spec is not wrong — the two sections are about different things —
   but a reader of §11 alone would expect a parse worker in this stage.
2. **§6.5 writes `position_basis(standard_position_id, …)`; `types.ts`'s
   `StandardPosition` has no id.** Resolved by P13. **This is a genuine spec/code
   disagreement and the spec cannot be satisfied literally.**
3. **§6.1 lists nine IndexedDB stores as tables including `blobs -> (none)`, and §13's
   Stage 2 sentence says "the nine repositories".** There are nine repository *modules* and
   eight tables.

## What this stage could not verify, and what that means

**Nothing in the server rebuild past the sign-in redirect has been watched in a browser,
by anyone, at any point in this stage.** Browser automation was unavailable throughout: the
Chrome extension disconnected part way (it is how Stage 1's OIDC scope defect was found)
and Playwright's driver times out at connect. The four-account walkthroughs, the uploader
screen, the precedent intake sentence and the standard-position evidence panel are covered
by unit, integration, real-Postgres and real-token HTTP tests — and by nothing that has
looked at a screen. **Task 22 step 5 in particular — running the uploader against a browser
holding real data and comparing the report record by record against what arrived — was not
done.**

This is recorded as a ruling because it is a decision, not an accident: the stage was
completed and reported with the gap named rather than held open indefinitely or papered
over. `CLAUDE.md` says two of this project's worst defects — "Run a review" showing zero
documents, and a review that failed once becoming permanently unopenable — were invisible
to thousands of passing tests and surfaced only by driving the real app. C1 above is a
third of exactly that kind, and it was found by review rather than by a browser.

*Cost if wrong: a defect of that class ships. The remedy is not more tests; it is a person
signing in as each of the four seeded accounts and using the app. Entering credentials is
out of scope for automation regardless, so this gap cannot be closed by trying harder.*

**Also not done, and named for the same reason:** Entra itself has never been exercised —
group-claim shape, group overage, admin consent and conditional access have no local
analogue, and `roles.pg.test.ts` proves only that the same lookup handles both **shapes**
offline. No `az`, `azd` or `bicep` CLI was available and there is no Azure subscription, so
**no template in `infra/` has been compiled, validated or deployed.**

---

# Server Stage 3, Part 3A — the gate (2026-08-30)

Part 3A's claim is that it is **shippable with no user-visible change**: the engine
exists, rows are shadow-written and reconciled, the workers run — and the browser is
still authoritative and still orchestrates. Task 13 checked both halves.
`apps/api/test/stage3aDoD.test.ts` and `apps/api/test/stage3aDoD.pg.test.ts` are the
suite; the narrative record lives in the stage's SDD directory, which is gitignored, so
what survives a clean checkout is here.

**Two §18 item 4 clauses are deliberately NOT met by Part 3A**, and the gate suite
guards them from arriving early rather than letting them drift in: the server-side
re-run reset in one transaction (Task 16), and the deletion of `carryHumanState`
(Task 21). A green Part 3A gate is not a green Stage 3 gate, and the table saying so is
in the suite itself.

## R-S3A1 — `markup_notice` staying browser-derived is not a Part 3A gate failure

P12 is closed for `text`, `parse_state` and `parse_error` and **open** for the
tracked-changes disclosure: detecting tracked changes needs `src/lib/docxMarkup.ts`,
which needs `jszip`, which is not a `packages/core` dependency. Ruled not a failure,
because Part 3A's claim is that nothing a user can see changed and this is precisely a
place where nothing did — the browser still derives the notice and still sends it,
exactly as in Stage 2. What would make it a failure is the server being **able to blank
it**, and the worker's `update` grant on `document` names `text, parse_state,
parse_error` and does not name that column. The gate enforces both halves: no grant
naming it, and no SQL write of it outside the two upload routes that take it from a
browser's body. Both mutation-tested.

**It becomes a gate item in Part 3B**, when Task 18 moves orchestration server-side and
it stops being safe to assume every upload came from a browser that read the file
itself. The fix is a task (move `docxMarkup.ts` into `packages/core`), not a footnote.

*Cost if wrong: a `.docx` whose tracked changes are never disclosed — the counterparty's
redline read back as the contract, which is the second entry on `CLAUDE.md`'s list and
the worst-consequence one, because the output is fluent and plausible.*

## R-S3A2 — the engine's workspace scoping is checked in the DoD suite, not by extending `workspaceScope.test.ts`

`workspaceScope.test.ts` walks `apps/api/src/routes` only, and the `src/run/*` modules
issue many statements against `run`, `run_cell`, `event` and `finding`. Extending that
file was rejected for the reason its own author gave: the reaper legitimately sweeps
**across** workspaces, so it would need an exemption, and a file-level exemption hides
everything in the file — the `PdfCanvas` lesson this repository has already paid for.

So the check lives in `stage3aDoD.test.ts`, and it is narrower and honest about being
narrower: the one module sweeping across workspaces is **the reaper, named as a file**,
and every other engine module's statements against a scoped table must name
`workspace_id` somewhere in the module. That is weaker than the `routes/` check — which
insists the predicate appear in the filtering clause — and deliberately so: the engine
reads by ids it claimed itself rather than by an id from a URL, and pretending otherwise
produces a guard nobody can keep green.

*Cost if wrong: a future engine module reads across tenants and the guard reports the
module as scoped because the words appear elsewhere in the file. The mitigation is that
the check fails loudly for a module with no workspace predicate at all, which is the
shape a new module actually arrives in.*

## R-S3A3 — a sixth guard found not to be guarding, and it was one of the tenant-isolation guards

`workspaceScope.test.ts` pulled string literals with
`` /`[^`]*`|'[^']*'|"[^"]*"/g ``, which does not honour a backslash. One apostrophe in
one error message — `routes/ingest.ts`'s `'document\'s contents with another\'s.'` —
terminated its own literal early and desynchronised every literal after it in that file.

Measured: **six clauses against tenant-scoped tables were invisible to the scanner** —
all three in `routes/ingest.ts`, three in `routes/documents.ts`. All six carry
`workspace_id`, so nothing in the app was wrong; the guard whose only job is to notice a
missing `workspace_id` simply was not looking at them, and it reported green because its
`>= 4` sanity bound was met by the eleven route modules that still parsed.

`statementsIn` is now escape-aware and lives in `sourceScan.ts` (two suites need it —
`CLAUDE.md`'s "extract it then", applied at two rather than at seven). The new test
compares what the extractor sees against the same clauses found in the **raw**
comment-stripped source, which needs no quote pairing, so a scanner that loses a
statement is a failure rather than a smaller number nobody counts. It is still a regex
and not a parser; the note on the function says what it would still miss and that the
AST is the real fix when it is next found wrong.

*Cost if wrong: a missing `and workspace_id = $2` reaches production unnoticed — §19's
"a fact about a contract they were never entitled to see", with nothing on screen looking
wrong.*

## What Part 3A's gate could not check

**No browser was driven** (the Chrome extension is disconnected, Playwright times out),
and **no request was made over HTTP as a signed-in user** — the shipped realm has
`directAccessGrantsEnabled: false` and enabling it temporarily, the route the previous
batch used, was refused to that session. So the shadow write was exercised through its
shipped handler against a real Postgres and through `writeFindingRows` against the
running database, but the HTTP hop was not re-walked in this gate. It was walked in the
previous batch and `routes/reviews.ts` is unchanged since.

*Cost if wrong: a defect between the wire and the handler — a body shape, a header, an
error mapping — would not have been seen. Recorded rather than implied away, on Stage
2's precedent.*

# Server Stage 3, Part 3B — the flip, the freeze and the close (2026-08-30)

Tasks 14–26. The engine moved server-side in Part 3A behind a shadow write; Part 3B
flipped the reader, flipped the writer, deleted `carryHumanState`, froze the findings
blob and closed the stage.

## P17–P28, as executed

- **P17 — shadow-write then flip.** Held for the whole of Part 3A and retired here:
  `writeFindingRows` is deleted with the blob write it shadowed (Task 22). It did its
  job — there was never only one copy of a judgement inside the change that altered it.
- **P18 — the blob is frozen, never dropped.** Executed as migration `010`, and **not in
  the form the plan wrote**. See R-S3B1.
- **P19 — census first.** Ran, and censused nothing, because the database has never held
  a review. See "What this stage could not verify".
- **P20/P21 — the review closure and the extractors in `packages/core`.** Unchanged.
- **P22 — five event types, in `packages/core/src/api/records.ts`.** Unchanged.
- **P23 — no `audit_event` in this stage.** Held. Recorded in the README rather than left
  for an auditor: run starts and cancellations are on the `run` row, which can be
  updated; a disposition's history is append-only and complete. The two have different
  guarantees and an audit export covering this period has to say so.
- **P24 — `Verification.assigneeId` retires with a record.** Executed (Task 22). The
  field is gone from the type, from `applyVerification`, from `resetVerification` (which
  now takes no argument, because that field was the only thing it carried across) and
  from the legacy-record reader. Two modules still name it and both are right to:
  `findings/backfill.ts`, which NAMES every finding that carried one in the migration
  report, and `upload/attribution.ts`, which rewrites every person-naming key in an
  uploaded record's raw JSON — where the key still exists in data exported before this.
- **P25 — the debounced saver's sticky 409 is removed by deletion, not by a fix.** Held.
- **P26 — two concurrency tiers.** Unchanged.
- **P27 — the worker is in-process, behind an interface, leased.** Unchanged.
- **P28 — no attribution surface in this stage.** Held and now asserted:
  `stage3DoD.test.ts` fails on a `dispositionLabel`, a `dispositionHistoryLine`, a
  *"Dispositions as at"* stamp, a *"was Rejected"* line or a *"changed N times"* string
  anywhere in `src`, `apps` or `packages`.

## R-S3B1 — `revoke update (findings)` does nothing, so the freeze is a revoke-then-grant

The plan's migration was `revoke update (findings) on review from lexprompt_app`. **That
statement is a no-op** against the table-level `UPDATE` migration 002 granted: Postgres
keeps table privileges in `relacl` and column privileges in `attacl`, and a column-level
revoke only removes from the second. No error. No warning. Verified against this
project's own database before `010` was written:

```
grant select, insert, update, delete on _probe to lexprompt_app;
revoke update (b) on _probe from lexprompt_app;
select has_column_privilege('lexprompt_app','_probe','b','update');  -- t
```

So `010` revokes the table-level grant and names every column except `findings` (and
`seq`, which is `generated always as identity` and updatable by nobody). A column added
to `review` by a later migration is therefore **not updatable until its own migration
grants it**, which fails loudly rather than quietly — and `frozenBlob.pg.test.ts` asserts
the updatable set as a whole, so the new column's absence is a named failure.

*Cost if wrong: a freeze that froze nothing, with a suite full of tests asserting about a
grant that was still there — the exact shape of the seven guards this stage found not
guarding.*

## R-S3B2 — INSERT on `review.findings` is deliberately NOT revoked

The brief's Interfaces block says Task 22 produces *"a `review.findings` column that no
application role can write"*. `010` revokes `UPDATE` and leaves `INSERT` table-level, and
the gap is named rather than papered over.

The verb that can destroy a pre-migration backup is `UPDATE`; an `INSERT` can only write
that column on a row being **created**, which has no backup to lose. And the suites that
reconcile the frozen blob — the tool P18 keeps the column for — have to be able to
construct one inside the rolled-back app-role transaction they all run in. Making that
impossible would leave `reconcileFindings` testable only through the migrator connection,
outside every one of those suites' isolation.

The route no longer names `findings` in its `INSERT` either (the column default applies),
and `stage3DoD.test.ts` scans for any source statement that does.

*Cost if wrong: a future insert path writes a blob nobody reads, on a row created after
the freeze. It cannot reach an existing row's backup.*

## R-S3B3 — findings in a PUT body are IMPORTED on a create and REFUSED on an update

Task 22 Step 2 says a body carrying a non-empty `findings` answers `400`, because
accept-and-ignore is the shape of a client that believes it saved sixty findings and did
not. **The brief did not account for the uploader.** `upload/run.ts` moves an exported
dataset into a workspace a review at a time, through `saveReview`, and an exported
review's findings carry verifications, rejection reasons and notes.

A plain refusal would have left the uploader unable to move a review at all; `saveReview`
silently dropping the key — which is what it does for every other caller — would have
moved a review into a new workspace with every judgement gone. That is the first entry on
`CLAUDE.md`'s list, wearing a different hat.

So: a body carrying findings for a review that **already exists** is refused with a `400`
naming the reason (the old-tab-across-a-deploy case, which is the dangerous one); a body
carrying them for a review this workspace has **never seen** is an import, and
`findings/import.ts` writes them as **rows**. The frozen column is written by neither.
`importReview` in `src/lib/db/reviews.ts` is the one browser call that sends them and its
only caller is the uploader.

*Cost if wrong: an import path that writes judgements. It is built from
`readFindingsBlob`, `toFindingRow` and `setDisposition` rather than beside them, so it
cannot land a disposition with no history behind it — asserted in
`dispositionWriters.test.ts`.*

## R-S3B4 — the reconciler answers "did the migration lose anything?" AS AT THE FREEZE

A consequence of P18 that neither the spec nor the plan states. From `010` onward the
rows move and the blob does not, so a review created afterwards has findings its backup
does not describe, and `reconcileFindings` correctly reports every one as *"a row the
blob no longer has"*. A sweep in six months will print a long list that means "these
post-date the freeze", not "the shred lost something".

Recorded three ways rather than left to be rediscovered: as a test in
`frozenBlob.pg.test.ts` that asserts the post-freeze shape is expected, as the scoping of
`stage3DoD.pg.test.ts`'s corpus sweep to reviews whose blob is non-empty, and here.

*Cost if wrong: a future operator reads a long discrepancy list as a lost migration, or —
worse — a future maintainer "fixes" the reconciler to stop reporting them and destroys
the one question it exists to answer.*

## R-S3B5 — `carryHumanState`'s deletion left one window, closed by a re-read and not a merge

The gate for deleting `carryHumanState` was the grant, and it held: `lexprompt_worker` is
refused every verb on both disposition tables, proved by attempting them. But the browser
kept one seam the rows do not close by themselves — a `getFindings` read already **in
flight** when a human write commits was assembled before it, and applying it puts a
judgement a lawyer has just made back to "Not checked" until the next poll.

Closed by **discarding and reissuing** the read (`humanWritesRef` in `App.tsx`), never by
merging: nothing from the browser's copy is put back on top of the store's answer, and
the second read is issued after the write so it carries the judgement itself.

*Cost if wrong: a sub-second flicker in which a verification appears to vanish. Not data
loss — the store has it — but it is the exact symptom `carryHumanState` existed to
prevent, and shipping the deletion with it visible would have read as the deletion being
wrong.*

## R-S3B6 — five web tests were modelling a server that no longer exists

Deleting `carryHumanState` turned five tests red, and every one of them was asserting
against a fixture whose premise Task 19 had already retired: a findings map answering
`unchecked` with no notes for a finding the server had just stored a verification and a
note on. Their comments said so in as many words — *"until Task 19 a verification reaches
the store through the review record, not through the findings rows"*.

The fixtures now answer what the store answers. The claim each test makes is unchanged;
what changed is that the server in the fixture is the one that shipped. The deleted
assertion — a stale map overwriting a fresh judgement — is replaced by a test of the
in-flight window above, which the old fixture could not express.

*Cost if wrong: a test suite that passes because its fixture is generous. Named here
because "the fixture was wrong" is exactly what somebody says when they have quietly
weakened a test.*

## R-S3B7 — Task 23 required no production change, and that is the answer

The card view, the tabular grid, the DOCX exporter and the CSV exporter were not touched.
They already read the assembled findings map through `findingsKeyFor`,
`verificationLabel`/`exportSummaryLine` are unchanged, and no `dispositionLabel` exists.
Verified by mutation rather than by reading: keying either exporter by a document id
instead turns named tests red in both.

## R-S3B8 — R-S3A2 is superseded (2026-08-30)

R-S3A2 ruled that the engine's workspace scoping would be checked in the DoD suite rather
than by extending `workspaceScope.test.ts`, because the reaper legitimately sweeps across
workspaces and a file-level exemption hides everything in the file.

**Task 25 extended the scanner instead**, and the reasoning that made the earlier ruling
necessary turned out to be avoidable. `workspaceScope.test.ts` now walks every file under
`apps/api/src` and covers `finding`, `note`, `finding_disposition` and
`finding_disposition_event` alongside the nine it had. The 34 statements that came back
are in three named categories, each with a reason and each asserted to still apply:

- **unscoped by design** — the engine (`run/worker.ts`, `run/reaper.ts`, `run/events.ts`,
  `parse/parseWorker.ts`) acts on the whole database on nobody's behalf, and the
  migration and the reconciliation are corpus-wide. Named as an exact module list; every
  api file is asserted to be either scanned or on it, so the list cannot be joined by
  accident;
- **scoped by key** — `dispositions/service.ts`'s two statements identify a row by a
  finding's primary key that `requireFinding` has already proved is in this workspace.
  That gate is now asserted rather than assumed;
- **unreadable by the scanner** — two statements interpolate `FINDING_COLUMNS` through a
  `.map()` whose callback holds its own template literal, which `statementsIn`'s own
  docstring says it cannot parse. They get a **different assertion** against the raw
  source rather than an exemption.

The earlier ruling is left in place above, dated and superseded, rather than edited away.

*Cost if wrong: the exemption lists rot. Each entry is asserted to still match something
and still be a statement the guard would otherwise flag, so an entry that has stopped
applying fails rather than silently covering whatever moves under it next.*

## R-S3B9 — a real defect found by the compose gate, not by any unit test

`runWorker.compose.test.ts` failed with four cells at `error` whose findings were still
`pending` — a terminal cell over a card that spins forever, on a run whose banner says it
finished. The state-machine invariant could not see it: that assertion only reads cells
which are `done`.

Two causes. The suite's own seed inserted the run, its cells and its findings in three
separate `psql -c` calls — three transactions, against a database whose pool polls every
second — so the pool claimed the first four cells in the gap. `createRun` writes all three
in one transaction and cannot produce that state. And `leaseCell` read the finding's new
version as `Number(updated[0]?.version ?? 0)`, so a cell with no finding row was leased
anyway, ran a real model call, and failed at `writeCellResult` with no row to close.

Both fixed. The lease now refuses such a cell, closes it with a message naming the actual
condition, settles the run, and asks nothing of the model.

*Cost if wrong: this is the defect the queue is named after — "an abandoned run reopening
with every cell spinning forever, unfinishable" — and it was reachable in production only
through a path `createRun` does not take. The fixture was wrong; the silence was not.*

## R-S3B10 — a "Read it again" route, which the plan did not ask for

§11 says a failed parse shows *"the `parse_error`, with a retry"*. There was no retry:
the failure message told a reviewer to *"add the file again"*, which loses the document's
id and with it its collection membership and its place in every review that names it.

`POST /v1/documents/:id/reparse` puts the stored bytes back in the queue. Refused by name
on a `parsed` document — re-reading one blanks the text every review of it was run
against, which is the founding defect reachable from a button — and on a `pending` one,
which is already queued and where a `200` that changed nothing would read as progress.

*Cost if wrong: a new write path on `parse_state`, which the parse worker is otherwise
the only writer of. It moves `failed` to `pending` and nothing else, and the two refusals
are asserted against a real database.*

## The spec-versus-shipped disagreements, recorded rather than smoothed

1. **§5's `packages/core` inventory does not exist** and §9 tells the worker to run
   extractors from it. Resolved by P20: the review closure moved, the rest is named for a
   later stage (interface note 13). A genuine gap between the spec and the repository.
2. **`extractClause` imported its model client**, so §9's *"a model client that points at
   the gateway"* was not expressible without a signature change. Resolved by P21.
3. **§6.2 and §6.5 give the same cell two state machines** (`finding.status`,
   `run_cell.state`) and do not say which governs. Ruled in Task 8 Step 2, pinned by
   `assertStatesAgree`, and it is what caught R-S3B9.
4. **§6.3 states the attribution requirements in the present tense; §13 puts those
   surfaces in Stage 4.** Ruled by P28 in favour of §13, and now asserted rather than
   intended. A reader of §6.3 alone would build them here.
5. **§6.5's `run.provider`/`model`/`jurisdiction` cannot be non-null at creation** — a
   queued run has called nothing. Nullable, filled from the gateway's own answer.
6. **`Note.findingId` is `findingKey(documentId, clauseId)`**, a `::`-joined string that
   does not match `(review_id, findings_key, clause_id)`. Re-keyed by position, checked by
   parsing, refused on disagreement (Task 6).
7. **`Verification.assigneeId` has no home in the new schema.** Dropped with a record
   (P24, R-S3B and Task 22).
8. **§14's `runLifecycle` suite and §18 item 4 overlap but are not the same list.** Both
   covered; `stage3DoD.test.ts` maps each §18 clause to the suite that carries it rather
   than restating it.
9. **§18 item 4's `REVOKE UPDATE (findings)` does not do what it says.** R-S3B1.
10. **Task 22's refusal would have broken the uploader.** R-S3B3.

## What this stage could not verify

**No browser was driven.** The Chrome extension is disconnected and the Playwright MCP
times out, as it has for two entire stages. Everything Part 3B put on screen is untested
by anything that has looked at a screen: the progressive fill as cells finish, picking a
run back up after a mid-run reload, *"Still being read"* on a freshly added document and
the moment it becomes reviewable, "Read it again" on a failed parse, a verification made
while a run is going, a retry clearing one, and a cancel stopping the cells. Named in the
README as well as here.

**No request was made over HTTP as a signed-in user.** The shipped realm has
`directAccessGrantsEnabled: false`, so the only route to a token is the authorisation-code
flow, which needs a browser. Every route in this part was exercised through its shipped
handler against a real Postgres, and the wire hop was not re-walked.

**The migration has never seen real data.** `finding_migration_report` says *"Migrated 0
findings; 0 human-authored records censused"*: the census, the shred, the key-by-key
reconciliation and the freeze have all been driven by fixtures, because the database has
never held a review. The corpus sweep in `stage3DoD.pg.test.ts` therefore reconciles zero
reviews and says so out loud rather than passing quietly.

**The compose stack runs a stale `api` image.** Migration `010` was applied to the
compose database directly (the migrations run at container start, from the image's own
copy), so the running container's code predates the freeze and Tasks 21–25. `test:compose`
passes because nothing it drives goes through the review upsert; a rebuild is needed
before that container is trusted again.

*Cost if wrong: the part of this rebuild whose correctness matters most has the least
real evidence behind it, and no test can change that — only a person with a browser.*

---

# Stage 4 (the live-change stage), Tasks 22–26

Every ruling below was taken without owner review, in the four tasks that close Stage 4:
presence (22, 23), assignment (24, 25) and the definition of done (26). P29–P44 as
executed are recorded in `.superpowers/sdd/2026-08-30-lexprompt-server-stage-4-live-change/`;
what is here is the decisions the implementer made inside those tasks, each with its cost
if wrong.

## R-S4E1 — `PresenceMember` carries no name, no initials and no timestamp

The plan's interface was `{ userId, initials, screen, clauseId?, at }`. What ships is
`{ userId, screen, clauseId? }`, and the two removals are separate decisions.

**No name or initials**, because P32 says an id becomes a name in exactly one place
(`src/lib/api/users.ts`) and an event payload never carries a display name — a name on
the wire is a second copy of a mutable field, refreshed at a different moment from the
first. The plan's own Task 23 test *"names an unknown user id as unknown, never as a raw
id"* only makes sense if the client is resolving, so the brief disagreed with itself; the
shipped rule wins.

**No timestamp.** The server holds one — the sweep needs it — and it stops at the server.
A `PresenceMember.at` on the wire is the field a *"last seen 3 minutes ago"* would be
built out of, and the roster expires at fifteen seconds, so no such claim can ever be
true. Removing it also makes "broadcast on change only" mean something: with `at` in the
comparison, every heartbeat is a change and the rule silently does nothing.

*Cost if wrong: a roster that renders a stale name, which is the one lie this feature can
tell — a reviewer deferring to a colleague who left ten minutes ago.*

## R-S4E2 — the presence beat carries no identity, and the server refuses one on an unjoined subscription

The brief's heartbeat was `{ userId, initials, screen, clauseId? }` from the client. A
frame that names a user is a frame that can put a colleague's face on a clause. `userId`
comes from the token the socket was upgraded with, and from nowhere else.

A beat on a subscription this socket has not joined is **refused with a sentence** rather
than dropped: `subscribe` is where a subscription is checked for existence and for
workspace, so presence on an unchecked ref would let a signed-in caller appear on any
review id they can guess — and a silently dropped beat looks exactly like a review nobody
else is in.

*Cost if wrong: presence becomes a way to assert where somebody was, on a surface whose
whole claim is that it asserts nothing.*

## R-S4E3 — `hello` carries the heartbeat interval the server asks for

`API_PRESENCE_HEARTBEAT_MS` reaches the browser on the `hello` frame, and the client beats
at what it is told (falling back to 10s until the first `hello`). The alternative — a
constant compiled into the bundle — makes the TTL and the beat two numbers that can be
changed independently, and the failure mode is a roster expiring between beats: every
colleague flickering on and off, which reads as people opening and closing the review and
which nobody reports as a fault. `loadConfig` also refuses a TTL below 1.5 heartbeats
(`assertPresenceOutlivesBeat`).

*Cost if wrong: the feature is lost while the app looks like it is working.*

## R-S4E4 — presence rides its own `pg_notify` channel, and the payload IS the delivery

P39 says the notification is a doorbell and never a delivery. Presence is the sole
exception, and it is the exception *because* it is never persisted: there is no outbox to
read a beat forward from and there must not be one (S6). It uses a **separate channel**
(`lexprompt_presence`) rather than a discriminated payload on `lexprompt_event`, because
that channel's handler reads nothing from its payload by design and giving it a payload
to parse is precisely how a doorbell becomes a delivery.

A replica that misses a beat loses that person for at most one TTL and gets them back on
the next beat — the correct failure for an advisory signal.

*Cost if wrong: the one durable-delivery rule in the system acquires an exception nobody
can see the boundary of.*

## R-S4E5 — the migration is `013_assignment.sql`, not the plan's `012`

`011_close_unused_finding_grants.sql` landed in Stage 3's fix round and `012` is Task 11's
`audit_event`. An applied migration is immutable, so the number moves and the file does
not. `stage4aDoD.test.ts` checks this **by pattern** rather than by number, for the reason
its own comment already gave about the pre-Task-24 guard: a check pinned to a number
passes for the wrong reason forever.

## R-S4E6 — one open assignment per finding PER ASSIGNEE, and resolution is a pair or neither

Not one per finding: two people can each be asked to look at the same clause — a second
opinion is a normal thing to want — and a unique constraint on the finding alone would
refuse the second request with a constraint name. What is forbidden is asking the *same*
person twice while the first request is open, which would put the same row in front of
them twice.

`check ((resolved_at is null) = (resolved_by_user_id is null))`: an assignment that closed
itself is a thing nothing does, and every close is a person — the assignee having looked,
or the assigner withdrawing.

## R-S4E7 — `resolve` is authorised INSIDE the handler, not by a role

`ROUTE_POLICY` puts all three assignment routes at `reviewer`, which is the owner's own
case rather than a convenience: it is the *trainee* who assigns, when they are not sure,
so a partner-only gate would take the escape hatch away from the person it exists for.
Closing a request is then narrowed in the handler to the two people party to it. A role is
the wrong instrument for *"is this yours"* — every reviewer holds the same one and only
two of them are party to any request — and a third person closing it would make *"this was
dealt with"* a claim neither of them made.

*Cost if wrong: a request marked handled by somebody who did not handle it.*

## R-S4E8 — the panel is `AskedOfYou`, not the plan's `AssignedToMe`

`stage2DoD.test.ts` and `stage3DoD.test.ts` both forbid the phrase *assigned to me*
anywhere in `src/`, so Stage 5's cross-matter counter cannot arrive quietly. A component
wearing the reserved name would have forced both guards to be relaxed for a thing that is
not what they forbid — and the relaxation, not the component, is what would have cost
something. The heading it renders is *"Asked of you"*, which is what it is.

The same guard also gained **word boundaries** in this stage: its `usePresence` pattern
matched the substring inside `ClausePresence` and reported the shipped presence marker as
a forbidden hook. A scanner that fires on a substring of an unrelated identifier is one
that gets relaxed until it stops biting.

## R-S4E9 — `appendAudit` resolves `matter_id` from the review, in the insert

**A real defect, found by Task 26's own definition-of-done test rather than by review.**
The activity feed's audit arm reads `where a.matter_id = $1`, and Task 24 wrote its
`assignment.created` rows with a `review_id` and no matter. The row existed, the query
could not reach it, and nothing anywhere went red: an audited act no reader could ever
see.

Fixed at the ONE WRITER rather than at the call site, exactly as `appendEvent` already
resolves it — `coalesce($6, (select matter_id from review where id = $7 …))` — because
adding `matterId:` to each caller is one more place to forget it a sixth time.

*Cost if wrong: the audit log is complete and the feed built on it is not, which is the
worse half of an incomplete log: it looks complete.*

## R-S4E10 — the comparison grid shows a state without an actor, and that is named rather than fixed

§6.3 requires every disposition to be shown with its actor. `TabularReview` — the
comparison grid — renders a `StateChip` per cell and no actor line: many documents × many
clauses, one small cell each, and a name per cell would be unreadable and would be the
only place in the app rendering a person at that density. The attribution is one click
away, in the cell detail panel, which mounts the ordinary `FindingCard` with the ordinary
disposition.

`stage4DoD.test.ts` names that one surface and asserts its counterpart (the detail panel
really does carry the disposition), rather than exempting the file — a file-level
exemption hides everything in the file, not the part you meant to protect.

**This is a real limit of §18 item 5 on that surface** and the report says so: on the
grid, a disposition is shown without its actor until a reader opens the cell.

## R-S4E11 — the assignments read fails onto its own panel, not into a toast

`getOpenAssignments` rejects rather than resolving to an empty list, and `App` renders the
failure on the panel it is about with a retry. A toast was tried first and was wrong twice
over: it competes with whatever else the screen is trying to say (an expired sign-in, a
refused jurisdiction — `App.authRedirect.test.tsx` caught exactly that), and it disappears
on a timer, which is not somewhere to put a fact a person has to act on.

Its role is `alert` and not `status`: it renders above the cards, and the review screen's
own state-chip assertion is a positional `[role="status"]` query that found it first.

## The spec-versus-plan disagreements from these tasks, recorded rather than smoothed

1. **The plan's `PresenceMember` disagreed with the plan's own Task 23 test.** R-S4E1.
2. **The plan's presence heartbeat carried a client-supplied identity.** R-S4E2.
3. **The plan's migration number was already taken.** R-S4E5.
4. **The plan's `AssignedToMe` filename is a string two shipped guards forbid.** R-S4E8.
5. **The plan's task pathspecs omitted files the task had to change** — `feed.pg.test.ts`
   and `gatewayCallerAuth.test.ts` (Task 22), `stage2DoD.test.ts` and `contrast.test.ts`
   (Task 23), `stage2DoD.test.ts`, `stage3aDoD.test.ts` and `oidc.test.ts` (Task 24),
   `ResultsView.tsx` and two `vi.mock` factories (Task 25). Committed with the task that
   required them.
6. **§13 puts "assignee chips" in Stage 5 while §18 item 5 requires an assignment to reach
   its assignee in Stage 4.** Ruled as the plan ruled it: the action, the record and the
   delivery are Stage 4; the chip and the counter are Stage 5, and `stage4DoD.test.ts`
   asserts their continued absence.

## What Tasks 22–26 could not verify

**No browser was driven, for the fourth consecutive stage.** The Chrome extension reports
no connected browsers and the Playwright MCP times out. Everything these tasks put on
screen is untested by anything that has looked at a screen: a presence face, a marker on a
clause, whether either reads as "looking" rather than "checked", the assign panel, the
"asked of you" panel, and two people using the app at once. The API halves are proved
live with two real tokens; the screen halves are proved as rendered strings in jsdom,
which is a weaker claim.

**Spike 3's Azure half is still unanswered.** Cross-replica fan-out — and now
cross-replica presence, which travels a different way — is proved locally at two replicas
through nginx. Whether a Container Apps *internal* ingress at `transport: 'http'` passes a
WebSocket upgrade is not settled by the documentation and no reachable environment can be
asked.

*Cost if wrong: the same as it has been for three stages — two of this project's worst
defects were invisible to thousands of passing tests and appeared only when somebody drove
the real app.*
