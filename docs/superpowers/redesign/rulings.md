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

The server design's own rulings (S1–S27, after the 2026-08-28 revisions below) live in that
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
gateway refuses to START on either misconfiguration or with no log sink configured. Surfacing
still happens, at two altitudes — the operator sees jurisdiction where the choice is made, and
the model picker labels EVERY model with its provider and jurisdiction, never only the non-UK
ones, because a badge shown only on the bad entries makes its ABSENCE carry meaning, which is
the blank-CSV-cell defect exactly.

**A no-Azure deployment is first-class, and the design says exactly how far that reaches.**
Same gateway, same allowlist, same jurisdiction refusal, same per-call log with the same
fields — a local deployment does not get to skip the record because it is small, and one that
did would teach its operator to expect a gateway that does not log. What it does not get is
the no-key property, and the README and admin screen say so in that deployment rather than
repeating a sentence true only elsewhere. **What the design does NOT yet give it is identity
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
