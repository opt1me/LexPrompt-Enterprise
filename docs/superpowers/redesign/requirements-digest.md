# LexPrompt Redesign — Requirements Digest

Source documents: `design_handoff_lexprompt_redesign/README.md` (visual/behavioural spec) and
`design_handoff_lexprompt_redesign/IMPLEMENTATION.md` (mapping onto `src/`). `.dc.html` prototypes
and `support.js` were not read (out of scope for this digest). Current codebase verified directly:
`src/types.ts`, `src/lib/storage.ts`, and the `src/` file tree.

---

## 1. Product thesis

LexPrompt stops being a single-session "load documents, run a template, read a results grid" tool
and becomes a **persistent, matter-centric review workspace**: a lawyer opens a matter, sees how
much of the review has actually been *human-verified* (not just extracted), and works a review as a
disposition queue (verify/flag/reject) rather than a one-shot report. Two new higher-order objects
appear — **collections** (a base document plus its variations, resolved to a lawyer-confirmed *net
position*) and **playbooks with standard positions** that can be authored by AI, by hand, or
*learned from the firm's own past redlines*, and later re-taught from new deals via a reviewable
changeset. The day-to-day shift is: findings are no longer disposable output of a run — they are
durable, assignable, auditable records that persist across sessions and gate what can be exported
as "checked."

---

## 2. Capabilities (numbered, exhaustive)

1. **Matter object as top-level container** — a matter holds documents, collections, reviews, findings, notes. *(new)*
2. **Matter list / matters home screen (`1a`)** — status board leading with verification %, replaces `TemplateLibrary.tsx` as the entry point. *(new; replaces current entry point)*
3. **Real client-side routing** (`react-router` suggested) with deep-linkable URLs per matter/review/clause/playbook/version/changeset. *(new — current app uses a flat `useState` view enum)*
4. **Per-finding verification state machine**: `unchecked/verified/flagged/rejected`, recording who/when, reject-reason, optional assignee. *(new)*
5. **Export gating on verification** — export never blocked, but unverified findings are labelled as such in the export artifact. *(modification of `exportDocx.ts` / whatever export exists)*
6. **Review ledger screen (`1b`)** — 3-pane clause index / finding / document view, keyboard nav (`J/K/V/F/R`), pinned disposition bar. *(new; replaces `ResultsView.tsx` + `FindingCard.tsx`)*
7. **Notes on findings** (private, per-author, timestamped). *(new)*
8. **Attributed, structured citations** — `Citation {quote, documentId, page?, clauseRef?}` replacing `citations: string[]`; multi-document colour-coded pins. *(modification — extends `src/lib/citations.ts` usage, not the fuzzy-matcher itself)*
9. **Standard positions on playbook clauses** — "what we ask for," compared against extraction to produce `meets/deviates/unclear` + rationale. *(new)*
10. **Collections** — one `base` doc + N `varies` docs read together. *(new)*
11. **Collection-aware extraction** — single combined-text model call per clause returning per-document citations + a proposed net position. *(new; changes the extraction contract in `runReview.ts`)*
12. **Net position + variation trail (`1d`)** — original → varied-by → net, human-confirmed, amendable. *(new — `NetPosition` entity)*
13. **Comparison grid (`1e`)** — rebuilt `TabularReview.tsx`/`CellDetail.tsx` as a triage surface (sentence cells, verification+risk both shown, "Open in review" handoff). *(modification)*
14. **First-run / intake flow (`1f`)** — drop documents, auto-detect collection membership, suggest a matching playbook. *(new; replaces `RunPanel.tsx`)*
15. **Playbook entity replacing Template**, versioned (`Playbook`/`PlaybookVersion`), with `changeSummary` per version. *(modification/rename with structural change — adds versioning)*
16. **Playbook editor (`1g`)** — reskin of `TemplateEditor.tsx` plus standard-position fields, provenance chips, drag reorder. *(modification)*
17. **AI-drafted playbook flow (`2a`→`2b`)** — form (contract type, acting-for, free text, "learn from" existing playbooks/matters, clause-count/answer-length controls) producing a non-persisted `PlaybookDraft`, then a per-clause keep/edit/cut review screen. *(new)*
18. **Manual playbook authoring (`2c`)** — add clauses one at a time, per-field "draft this for me" suggestions (independent small model calls). *(new, though closest to today's `TemplateEditor.tsx` manual flow)*
19. **Learning a playbook from redlines (`3a`-`3c`)** — ingest precedent documents, detect "chains" (their draft → our markup → executed), infer standard positions with strength (`consistent/mixed/weak`) and a basis list, surface open questions never guessed positions, drill into "the workings" (rendered redline diff). *(new — needs new `src/lib/redlines.ts`)*
20. **DOCX tracked-changes parsing** (`<w:ins>`/`<w:del>`, comments in `comments.xml`). *(new — extends `src/lib/documents.ts`)*
21. **PDF-pair diffing fallback** for redlines when no tracked-changes are available (text diff, lower confidence). *(new)*
22. **Chain detection** for precedent documents (filename/version heuristics, user-confirmed). *(new)*
23. **Playbook maintenance / re-learning (`4a`)** — living playbook view with staleness/health chips (`HELD`, `CONCEDED`, `UNTESTED`, `NO POSITION`), derived not stored. *(new)*
24. **Changeset generation and publishing (`4b`)** — classify new precedent against a live playbook version into `confirm/drift/new_clause`, human decides per item, publish creates a new immutable version. *(new — needs `src/features/playbooks/changeset.ts`)*
25. **Playbook version history (`4c`)** — timeline of versions, each review references the version it ran on. *(new)*
26. **Full mobile parity** — every desktop action available on a 390px layout, distinct stacked screens for matter board / finding / variation trail. *(new — no current mobile treatment)*
27. **New design token system / full visual reskin** (light paper/ink/teal palette replacing the current dark theme; three Google-Fonts families; new `Button`/`RiskChip`/`StateChip`/`Modal`/`Toast` treatments). *(modification — total replacement, not additive)*
28. **RiskBadge split into two components** (`RiskChip` for risk level, `StateChip` for verification state) — explicitly not to be conflated. *(modification)*
29. **Assignment of findings to a user** (`assigneeId`, "Assigned to me" filter on matter rail). *(new — implies a `User`/multi-person model; see §5)*
30. **Activity feed on matter home** (verbs: flagged/verified/rejected/run-started, actor + clause + timestamp). *(new — implies an event/audit log)*
31. **Persistent, durable reviews** — a `Review` (was `ReviewRun`) survives across sessions, is reopenable, keeps `findings` keyed by target × clause as today. *(modification — same shape, different lifecycle: persisted not ephemeral)*
32. **Persistent document text per matter** (IndexedDB). *(new policy — see §4, currently explicitly NOT persisted)*
33. **Migration of `Template`→`Playbook` and `ReviewRun`→`Review`**, including legacy citations (`string[]`→`Citation[]`) and a bump to `SCHEMA_VERSION`. *(new — one-time migration logic in `storage.ts`)*
34. **Storage backend move from `localStorage` to IndexedDB** for matters/playbooks/reviews/document text; API key stays in `localStorage`. *(modification — architecture change, same module boundary)*
35. **Existing PDF rendering + citation highlighting** (`PdfCanvas.tsx`, `citations.ts` fuzzy match). *(unchanged mechanism, restyled chrome only)*
36. **Existing progressive-fill run engine** (`runReview.ts`, `concurrency.ts`, `onUpdate`, `retryCell`, abort handling). *(unchanged mechanism)*
37. **"DIY mode" mega-prompt export** (`buildMegaPrompt.ts`). *(unchanged, kept reachable from playbook editor)*
38. **OpenRouter provider** (`openrouter.ts` — chat/listModels/model capability detection). *(unchanged)*
39. **Settings panel** (API key, model, concurrency). *(unchanged in substance)*

Not mentioned anywhere in either document, but present in the current `src/features/assistant/` tree
(`ChatPanel.tsx`, `draftEmail.ts`, `suggestRevision.ts`, `EmailModal.tsx`, `RevisionModal.tsx`): no
disposition is given for this assistant/chat/email-drafting feature. See Open Question 1.

---

## 3. Data model implied by the redesign

**Survive unchanged:** `Settings`, `RiskLevel`, `DEFAULT_SETTINGS`, the general shape of
`DocumentFile`-as-parsed-text (renamed/extended, see below).

**Extended:**
- `Finding` — current: `{clauseId, status, summary?, citations: string[], riskLevel?, riskAnalysis?, error?, edited?}`. Redesign adds `verification: Verification`, `notes: Note[]`, `standardPositionOutcome?`, `standardPositionRationale?`, `editedAt?`, `editedByUserId?`, and upgrades `citations` to `Citation[]` (`{quote, documentId, page?, clauseRef?}`).
- `DocumentFile` → `DocumentRecord` — adds `matterId`, `role: 'base'|'varies'|'standalone'`, `collectionId?`, `documentDate?`, `revisions?: Revision[]`; drops the raw `file: File` handle implicitly (not addressed — see Open Question 4) since persisted records can't hold a `File` object across sessions.
- `Clause`/`Template` → `PlaybookClause`/`Playbook`/`PlaybookVersion` — `prompt` renamed `extractPrompt`; `mode: 'extraction'|'risk'` collapses into standard-position presence; adds `standardPosition?: StandardPosition`, `origin`, `reviewedByHuman`, and version history (`versions: PlaybookVersion[]`, `currentVersion`).
- `ReviewRun` → `Review` — adds `matterId`, `playbookVersion`, `target: {kind:'documents'|'collection', ...}`, `netPositions?`, `modelId`. `templateSnapshot` → `playbookSnapshot` (same discipline).

**Wholly new entities:** `User`, `Matter`, `Collection`, `Verification`, `Note`, `NetPosition`,
`StandardPosition`, `PositionEvidence`, `PlaybookDraft`, `Revision`, `PrecedentDocument`,
`InferredPosition`, `OpenQuestion`, `LearningSession`, `Changeset`, `ChangesetItem`.

**Replaced:** `Template` (by `Playbook`+`PlaybookVersion`), `ReviewRun` (by `Review`), bare-string
`citations` (by `Citation[]`).

**Cannot be cleanly expressed in the current `localStorage`-only architecture:**
- Document *text* persisted per matter (potentially many MB per matter × many matters) exceeds
  practical `localStorage` quota (~5-10MB/origin). IMPLEMENTATION.md concedes this explicitly:
  > "`localStorage` will not hold matters with document text. Move to IndexedDB behind the existing `storage.ts` interface."
  This is a real architecture change, not a tuning knob — `storage.ts` today is synchronous
  (`localStorage.getItem`/`setItem`); IndexedDB is asynchronous, so every call site consuming
  `storage.ts` needs to become async-aware (most already are, since the current API returns
  Promises, but this was previously a formality over sync code).
- `DocumentRecord.pageImages` (base64 page renders for scanned docs) persisted per matter compounds
  the storage-size problem further — these are the most storage-heavy artifact in the app and the
  README's `1f` screen explicitly shows OCR/scan handling as a first-class first-run case.
- Multi-user fields (`ownerId`, `assigneeId`, `byUserId`, `confirmedByUserId`, "Assigned to me")
  imply a stable identity concept. There is no `User` store or auth today — see §5.

---

## 4. Persistence policy change (documents & reviews currently in-memory only)

This is flagged prominently per instructions: **today, `DocumentFile` text/images and `ReviewRun`
findings are deliberately NOT persisted** — only `Template`/`Clause` and `Settings` survive a reload
(confirmed directly in `src/lib/storage.ts`: only `TEMPLATES_KEY` and `SETTINGS_KEY` exist). The
redesign requires this to invert:

- IMPLEMENTATION.md §4: *"Persistence: matters, playbooks and reviews outgrow `localStorage` quickly — move to IndexedDB... Document text should be persisted per matter."*
- README.md's whole premise — "Runs stop being ephemeral," a matter home showing verification
  progress across sessions, a review ledger you can navigate back to, an activity feed, assignment
  workflows — is **impossible without persisting document text and finding data**, since none of it
  can survive a reload otherwise.

This is a policy reversal on a currently-deliberate privacy stance (contract text, which is client-
confidential legal material, is presently kept in-memory-only specifically so it never touches disk).
The one place the documents partially acknowledge this tension is the *learning* feature, where
precedent documents are explicitly NOT persisted (see §6/Q2) — but ordinary matter documents under
review **are** intended to be persisted, and no document discusses retention limits, encryption at
rest, purge/delete-matter flows, or whether this requires updating whatever privacy representation
the app currently makes to users. `IMPLEMENTATION.md` does say "keep the security note in Settings
truthful" — implying awareness that the note needs to change, but not what it should say.

---

## 5. Backend / server / multi-user / shared-state pressure

The current app is single-visitor, backend-free, `localStorage`-only. Several redesign requirements
strain or break that model, and neither document acknowledges the tension directly:

- **Assignment** (`assigneeId` on `Verification`, "Assigned to me" rail filter, `4b`'s named
  reviewers) presumes more than one person can be a target of assignment — i.e. a team, not a solo
  user. With no backend, "assigning" a finding to a colleague on a `localStorage`/IndexedDB-only app
  does nothing observable to that colleague (their browser doesn't see it) unless data is somehow
  shared. Neither document says how "R. Hume" or "M. Okafor" (both named in the mock copy) would
  ever see a matter that "algray01" created.
- **`ownerId` on Matter**, **`publishedByUserId`/`confirmedByUserId`/`byUserId`** everywhere in
  `types.ts` imply a `User` directory. No `User` store, login, or identity mechanism is specified —
  `User { id, name, initials }` is declared as a type but nothing describes where instances come
  from (hardcoded single user? a settings-entered name? multi-profile local switching?).
  IMPLEMENTATION.md's §9 "Suggested build order" never introduces a phase for this.
  → **This is the single largest architectural gap in the handoff**: the whole visual language
  (avatars, "R. Hume, 21 Aug 10:48", activity feed with multiple actor names) depicts a multi-user
  product, but the stated target stack (React+localStorage/IndexedDB) is fundamentally single-
  browser, single-user. There is no mention of a server, sync, or even export/import between users.
- **"used in N matters" (`4c`)** cross-references playbooks against matters at the firm level — firm-
  wide analytics require a shared store across users/browsers, which nothing in the stack provides.
- **Playbook "LEARN FROM" list of "existing playbooks and signed-off matters" (`2a`)** implies a
  firm-wide corpus of past matters visible to whoever is drafting a new playbook — again cross-user
  visibility with no described mechanism.

None of this is flagged as an open question in the source documents themselves — it is presented as
settled UI. It is the most consequential gap for a from-scratch implementer to notice on their own.

---

## 6. Open questions and ambiguities

1. **Multi-user/identity mechanism is entirely unaddressed** (see §5). No document proposes even
   a stub (e.g., "single hardcoded local user with an editable display name") for `User`,
   `ownerId`, `assigneeId`, or the "Assigned to me" filter. An implementer must guess.

2. **Precedent-document non-retention vs. matter-document retention appear at odds in spirit, and
   the mechanics of the former aren't specified.** README.md: *"Precedent documents used to learn a
   playbook are read once and not stored with the playbook... This was confirmed with the user and
   is a privacy requirement, not an implementation convenience."* But nothing describes *when* the
   discard happens relative to browser reloads/tab closes mid-session (if a `LearningSession` is
   itself state that could be persisted for resumability, does that violate the "read once" rule?),
   nor whether the same standard should apply to ordinary matter documents (it explicitly does not
   per §4, and no document explains why matter documents get long-term retention while precedent
   documents used for the *same kind of proposal-with-basis* pattern do not).

3. **DOCX tracked-changes parsing and PDF-pair diffing are both described as clear approaches but
   with no confidence bar, no library named, and no fallback UI spec for partial failure.**
   IMPLEMENTATION.md §6 says PDF-pair diffing is "Lower confidence — reflect that in the inferred
   position's strength" but doesn't say how (a new `strength` value? capped at `weak`? a numeric
   discount?). This is realistically a research spike, not a build task — see §7.

4. **`DocumentFile.file: File` is dropped implicitly.** The current type holds a live `File` handle
   (used presumably for re-parsing or download). `DocumentRecord` in IMPLEMENTATION.md's model has
   no equivalent field, which is *necessary* if documents are to survive a reload (a `File` object
   cannot be persisted/rehydrated as such), but neither document states this decision or what
   replaces the capability (e.g., re-generating a PDF for the `PdfCanvas` view from stored bytes
   vs. stored text only — and if only text is kept, the "real PDF rendering" requirement for `1b`'s
   document pane is unclear on where the page image bytes come from after a reload).

5. **Chain detection confirmation UX vs. accuracy is unspecified beyond "a suggestion, never an
   assumption."** IMPLEMENTATION.md §6: *"cluster on shared tokens in filenames plus version
   markers... always show the inferred roles for confirmation in `3a`."* No thresholds, no example
   heuristic weighting, no behaviour when zero or multiple candidate chains are found beyond the
   `help-circle` "role can't be inferred" row shown in `3a`.

6. **Collection extraction cost/limits.** IMPLEMENTATION.md §5.3 flags collections as "much larger"
   calls and suggests *"consider counting a collection clause as two units against the limit"* —
   phrased as a suggestion ("consider"), not a rule. No number of documents-per-collection ceiling,
   token-budget guidance, or behaviour when a collection's combined text exceeds a model's context
   window is given.

7. **Export format/content for the verification-labelled export is unspecified.** README.md says
   *"the exported document labels unverified findings as unverified AI output"* but never specifies
   where in the current `exportDocx.ts`-style output this label goes, nor whether the redesign
   changes export format beyond this label (DOCX only? the mock's "Export report" button implies a
   possibly different/richer output than today's).

8. **IndexedDB migration mechanics are asserted, not designed.** IMPLEMENTATION.md §4 says to
   "Bump `TEMPLATE_SCHEMA_VERSION` (2) to a new `SCHEMA_VERSION` (3) and write the migration in
   `src/lib/storage.ts`" but the current `storage.ts` is a synchronous `localStorage` wrapper with
   its own quarantine-on-corruption logic (see `readAll()`); moving to IndexedDB is an async,
   transactional, versioned-database rewrite of that entire module, not a version-number bump —
   the document undersells the size of this specific piece of work.

9. **The existing assistant/chat/email-drafting feature (`src/features/assistant/`) is never
   mentioned in either document.** No decision is stated on whether it survives, is redesigned, or
   is cut. This is a real gap in the "what changes / what stays" table (IMPLEMENTATION.md §1-§2),
   which is otherwise systematic about every other current file.

10. **No document contradiction was found between README.md and IMPLEMENTATION.md** on any point
    both cover — IMPLEMENTATION.md is presented explicitly as the technical companion to README.md
    and is consistent with it everywhere checked (verification states, net position confirmation,
    citation shape, design-token deferral, etc).

---

## 7. Relative size per capability

| # | Capability | Size |
|---|---|---|
| 1 | Matter object | Small |
| 2 | Matter home screen | Medium |
| 3 | Real routing | Medium |
| 4 | Verification state machine | Small |
| 5 | Export gating/labelling | Small |
| 6 | Review ledger (3-pane, keyboard nav) | Large |
| 7 | Notes on findings | Small |
| 8 | Attributed citations upgrade | Medium |
| 9 | Standard positions + meets/deviates evaluation | Medium |
| 10 | Collections entity | Small |
| 11 | Collection-aware extraction (combined-text call) | Medium |
| 12 | Net position + variation trail UI | Medium |
| 13 | Comparison grid rebuild | Medium |
| 14 | First-run intake flow w/ auto-detected collections | Medium |
| 15 | Playbook versioning entity | Medium |
| 16 | Playbook editor reskin+extend | Medium |
| 17 | AI-drafted playbook flow (2a/2b) | Large |
| 18 | Manual authoring w/ per-field AI suggestions | Medium |
| 19 | Learning from redlines end-to-end (3a-3c) | **Research-needed** |
| 20 | DOCX tracked-changes parsing | **Research-needed** |
| 21 | PDF-pair diffing fallback | **Research-needed** |
| 22 | Chain detection heuristic | Medium (research-flavoured) |
| 23 | Playbook maintenance / staleness derivation | Medium |
| 24 | Changeset generation & publish | Large |
| 25 | Version history UI | Small |
| 26 | Full mobile parity (3 screens) | Large |
| 27 | Full design-token/visual reskin | Large |
| 28 | RiskChip/StateChip split | Small |
| 29 | Assignment of findings | **Research-needed** (blocked on identity model, §5) |
| 30 | Activity feed | Medium (Small if single-user, harder if cross-user) |
| 31 | Durable/reopenable reviews | Medium |
| 32 | Persisted document text/images | Large (storage-engineering, not just a flag flip) |
| 33 | Template/ReviewRun migration | Medium |
| 34 | localStorage → IndexedDB migration of storage.ts | Large |
| 35-39 | Unchanged mechanisms (PdfCanvas, runReview, mega-prompt, OpenRouter, Settings) | Unchanged |

Overall largest single risk items: **(19-21) learning-from-redlines pipeline**, **(34) the storage
engine rewrite it's built on top of**, and **(29, and §5 generally) the unaddressed multi-user/
identity model** that several visible UI affordances depend on.

---

**Capability count:** 39 distinct capabilities enumerated in §2 (plus one unaddressed feature —
the assistant/chat module — flagged separately as it has no disposition in either document).
