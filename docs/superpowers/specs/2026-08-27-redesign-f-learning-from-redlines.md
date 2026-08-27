# Redesign sub-project F — Learning from redlines, and changesets

**Date:** 2026-08-27
**Status:** Spec written; **both gating spikes are answered (see §3a) and neither narrowed the scope**. A prerequisite fix was split out ahead of this sub-project (§3b).
**Builds on:** A, B, C, D (standard positions and versioning), E (playbook authoring — F reuses its draft-review gate)
**Source handoff:** `design_handoff_lexprompt_redesign/` turns 3 and 4, digested to `docs/superpowers/redesign/`

## 1. What this sub-project is for

A firm's house rules are not in anyone's head in a form you can dictate. They are in the redlines — the fact that on four leases out of four, someone struck the landlord's right to withhold consent unreasonably. Ask a lawyer to *describe* their standard position and you get a plausible summary. Show them what they actually did, four times, and you get the real one.

This sub-project reads a firm's own negotiated documents and proposes standard positions from them, with the evidence attached. Then it keeps doing it: a playbook is fed a new deal, and produces a reviewable changeset — confirm, drift, or new clause — that publishes a new version only where a human agreed.

## 2. The rule this sub-project inherits, and the new one it needs

The standing rule holds: nothing is adopted because a model inferred it. Everything here is a *proposal* with a *basis*, accepted one at a time.

But this sub-project needs a rule of its own, because it is the first to reason about evidence *strength*:

**Frequency is evidence, not proof, and the app must say which it has.** A position struck once is a weak signal — it may have been a trade on that deal, not a policy. A position struck every single time is a house rule. The handoff's own banner is the right framing and should be close to verbatim in the product: *these are observations about what you did, not advice.*

And a second, sharper one:

**Never guess a position from silence.** If every lease had a break clause and none was ever amended, that is not "the firm accepts standard break clauses." It is a question the redlines cannot settle, and it belongs in an open-questions list, not in the playbook. This is the same distinction sub-project D drew between `unclear` and no-position, and it is the one most likely to be quietly lost in implementation.

## 3. The two spikes, and why this spec is provisional

The requirements digest flags three capabilities as **research-needed**, and it is right to. Two of them gate everything else here, so this sub-project starts with two spikes whose outputs are answers, not code kept:

**Spike 1 — DOCX tracked changes.** Can `mammoth` reach `<w:ins>`/`<w:del>` and `comments.xml` at all, or does it flatten them? `mammoth` is already a dependency and is used for plain text extraction. If it flattens (likely — it targets clean HTML/text output), the question becomes whether reading the OOXML directly from the `.docx` zip is proportionate: a `.docx` is a zip of XML, `<w:ins>`/`<w:del>` are well-specified, and the app already unzips these files. The spike's output is a recommendation with a worked example on a real tracked-changes document, not a parser.

**Spike 2 — PDF-pair diffing.** When there are no tracked changes, the fallback is diffing an earlier PDF against a later one. The spike establishes whether a text-level diff over `parsePdf`'s output is good enough to locate *which clause changed* (which is all that is needed — the model reads the clause text, the diff only has to point at it), and what the false-positive rate looks like on reflowed text. The output is a go/no-go plus a confidence label to attach to anything derived this way.

**Both spikes' findings amend this spec before planning continues.** Sections 5 and 6 below are written against the assumption that tracked changes are reachable; if Spike 1 says otherwise, the scope narrows to what Spike 2 supports and this document is revised rather than quietly over-promised.

### 3a. Spike outcomes (2026-08-27) — both closed, both go

Full write-ups: `docs/superpowers/redesign/spike-1-docx-tracked-changes.md` and `spike-2-pdf-pair-diffing.md`.

**Spike 1 — answered: `mammoth` cannot reach tracked changes; read the OOXML.** `mammoth` reads `<w:ins>` straight through so insertions arrive as ordinary unmarked text, and has `<w:del>` and `<w:commentRangeStart/End>` in its `ignoreElements` map — the list dropped *without* even the "unrecognised element was ignored" warning. Verified on a purpose-built `.docx`: deletions gone, insertions indistinguishable, comments absent, `messages: []`. It produces the accepted-changes view and says nothing.

Reading the zip directly is the only route and is **more proportionate than it sounded**: F needs one function over `word/document.xml` plus `word/comments.xml`, not a general OOXML parser. `<w:ins>`/`<w:del>` are stable and carry `w:author`/`w:date` (which §4.2's chain detection and §5's basis list want anyway); deleted text lives in `<w:delText>` rather than `<w:t>`, so insertions and deletions separate trivially; and one pass yields both the original and the final text, which is exactly what §4.7's "the workings" view needs. **Sections 5 and 6 stand unchanged; scope does not narrow.**

**Spike 2 — answered: PDF-pair diffing is viable, with two mandatory preprocessing steps.** Measured against the real extracted text of a 20-page AST.
- `parsePdf` emits **61 lines for 20 pages** (median 217 chars, max 4,055), so a line-level diff is structurally useless — it would mark a whole page changed for a one-word amendment. **Sentence-level units, never line-level.**
- **Recall was 1.00 in every scenario tested.** A text diff never misses a changed clause, which is the property that matters: the diff only has to point, and the model reads.
- Precision depends entirely on normalisation. Collapsing whitespace is the predictable half; **de-hyphenating across line breaks is not** — hyphenation alone drops precision from 1.00 to 0.038. Anyone who normalises whitespace and stops will conclude PDF diffing does not work and will be wrong.
- In the realistic case precision reads 0.30, but every residual flag was an inserted heading or a deleted sentence — real differences, not artefacts. Nothing identical in both documents was ever flagged.

`RedlineEdit.source: 'tracked' | 'diff'` in §5 already carries the confidence distinction this requires and needs no change. Two additions to the implementation requirements:
- A flagged unit with **no counterpart at all** (an inserted heading, a removed clause) is reported as a *structural* difference, not an amendment, so the model is never asked to explain a re-typesetting as if it were a negotiation.
- A second version that is a **scan** has no diffable text. It yields **no positions at all** — never an empty set of changes, which would read as "nothing was negotiated". This is §2's "never guess a position from silence" rule, in its second concrete application.

### 3b. One prerequisite this sub-project acquired, and does not own

Spike 1 found a defect in the **shipped app**, unrelated to anything F builds: `src/lib/documents.ts` parses every `.docx` with `mammoth.extractRawText`, so **a marked-up draft uploaded today is reviewed with every deletion removed and every insertion treated as final, and the reader is never told.** Contract review is precisely where marked-up drafts live, so this is the normal case rather than an edge one, and it is this project's founding failure verbatim — worse than the scanned-PDF case it belongs beside, because a scan yields visibly empty text while this yields fluent, plausible, wrong text.

**Detecting tracked changes at ingest and disclosing them is a prerequisite to F, and is being done ahead of and separately from it** (brief: `.superpowers/sdd/tracked-changes-detection-brief.md`). F assumed the existing DOCX path was neutral about markup; it is not, it actively discards it, and anything F builds on that path would inherit the problem. F's own work begins from a `.docx` reader that already knows markup is present.

## 4. Scope

**In (subject to §3):**

1. **Precedent ingestion** — documents brought in to *learn from*, distinct from documents under review. They are read once and are **not stored with the playbook** (the handoff says so explicitly, and it is the right call: a playbook is house rules, not a document archive).
2. **Chain detection** — grouping "their draft → our markup → executed" from filenames, dates and content overlap. Proposed, never assumed; every chain and every document role is user-confirmable, and an ambiguous document asks rather than guesses.
3. **Tracked-changes reading** — insertions, deletions, and margin comments, attributed to the document and clause they came from.
4. **Inferred positions with strength** — `consistent` (n of n), `mixed` (n of m), `weak` (one instance) — plus a basis list naming each document that supports or contradicts it.
5. **Contradiction surfacing** — where redlines disagree, say so and require a deliberate decision rather than picking a side.
6. **Open questions** — things the redlines could not settle, listed as questions, never as positions.
7. **The workings** — for one inferred position, the actual redline text: deletions struck, insertions underlined, in the same sentence, with any margin comment shown alongside.
8. **Adopt / reword / not-a-house-rule**, per position, feeding into E's draft-review surface and D's publish path.
9. **Changesets** — a new deal read against a live playbook version, classified `confirm | drift | new_clause`, each item accepted, reworded or declined, and publishing creating a new version from **only the accepted subset**.
10. **Position health made actionable** — D derives `held`/`conceded`/`untested`; this sub-project gives the drop zone that re-tests them and the changeset that resolves a drift.

**Out and staying out:** mobile layouts; the visual reskin; storing precedent documents.

## 5. Data model

Everything here is **session-scoped except the changeset**. A learning session is a workspace, not a record.

```ts
type PrecedentRole = 'their-draft' | 'our-markup' | 'executed' | 'unknown';

interface PrecedentDocument {
  id: string;
  name: string;
  role: PrecedentRole;
  /** Set by the user or read from the document; absent rather than guessed. */
  documentDate?: number;
  /** Set only when the role was inferred rather than stated, so the UI can
   *  ask instead of asserting. */
  roleInferred: boolean;
  chainId?: string;
}

interface RedlineEdit {
  documentId: string;
  kind: 'insertion' | 'deletion' | 'comment';
  text: string;
  /** The surrounding sentence, so an edit can be read in context. */
  context: string;
  clauseRef?: string;
  /** 'tracked' where read from OOXML; 'diff' where inferred by comparing two
   *  documents. A diff-derived edit is weaker evidence and is labelled as
   *  such everywhere it appears. */
  source: 'tracked' | 'diff';
  author?: string;
  at?: number;
}

type PositionStrength = 'consistent' | 'mixed' | 'weak';

interface InferredPosition {
  id: string;
  clauseTitle: string;
  /** The claim, in the model's words. */
  statement: string;
  strength: PositionStrength;
  supporting: number;
  total: number;
  /** Every document that bears on this, and which way. The claim is not
   *  displayable without it — a position with no basis is an opinion. */
  basis: { documentId: string; supports: boolean; edits: RedlineEdit[] }[];
  contradicted: boolean;
  disposition: 'undecided' | 'adopted' | 'reworded' | 'rejected';
  /** Present when reworded. */
  rewordedText?: string;
}

interface OpenQuestion {
  id: string;
  clauseTitle: string;
  /** "Every lease you sent had a break clause, but you never amended one.
   *  Do you have a position?" */
  question: string;
  answer?: string;
}
```

The changeset is the one durable artifact:

```ts
type ChangeKind = 'confirm' | 'drift' | 'new_clause';

interface ChangesetItem {
  id: string;
  kind: ChangeKind;
  clauseId?: string;          // absent for new_clause
  currentText?: string;       // what the live version says
  proposedText: string;
  /** Why, citing the deals it came from. A proposal without a reason is not
   *  reviewable. */
  rationale: string;
  basis: RedlineEdit[];
  decision: 'open' | 'accepted' | 'reworded' | 'declined';
  rewordedText?: string;
}

interface Changeset {
  id: string;
  playbookId: string;
  fromVersionId: string;
  sourceSummary: string;      // "Brookvale Retail Park — our markup + executed, Jul 2026"
  items: ChangesetItem[];
  createdAt: number;
  createdByUserId: string;
  publishedVersionId?: string;  // set on publish
}
```

`SCHEMA_VERSION` bumps for `Changeset` alone; nothing else here persists.

## 6. Inference

**The evidence is assembled deterministically; only the claim is a model call.** Which edits exist, which document each came from, and how many documents support a pattern — those are counted in code, from parsed edits. The model's job is to *state* the position the edits imply and to group edits that are about the same thing. Letting the model count would let it be confidently wrong about "4 of 4," which is the single number the whole feature's credibility rests on.

**Strength is computed, not asked for.** `supporting === total` is `consistent`; `total === 1` is `weak`; anything else is `mixed`. The model never returns a strength.

**Contradiction is detected, not judged.** Where the basis contains both supporting and opposing edits, `contradicted` is set and the UI says the redlines disagree. The app does not resolve it.

**Diff-derived edits are labelled everywhere.** A position resting only on `source: 'diff'` edits carries lower confidence in the UI, because it is inferred from text comparison rather than read from what someone actually marked up.

## 7. Screens

**Precedent intake** — chain cards ("3 turns: their draft → our markup → executed") and standalone cards, with role chips on each document and an explicit "what is this?" prompt on anything ambiguous. A running summary ("7 documents · 1 chain · 146 tracked edits to read"). Nothing proceeds on a guessed role.

**What we learned** — the observations banner from §2, positions sorted by strength, each with its badge, statement, basis list, contradiction callout where present, and adopt / reword / not-a-house-rule / see-the-redlines. A separate open-questions block with answer or skip. `Accept all consistent` exists as a bulk action **only for `consistent` positions** — the ones where the evidence is unanimous — and never for mixed or weak ones.

**The workings** — one position's actual redline text, per document: deletions struck through and insertions underlined inline in the same sentence, margin comments shown with their author and date, executed-document language highlighted. Adopt or reword directly from here. The handoff's reasoning is exactly right and worth keeping in the code comments: *a lawyer will not adopt a position they cannot see the workings for.*

**The changeset** — the version transition ("v4 → v5 proposed"), the source line, a running tally, and category counts. Per item: for `drift`, v4 against proposed side by side with the rationale and the underlying redlines; for `new_clause`, why it was never covered; for `confirm`, a compact "held again" row. **Nothing changes in the live version until publish**, said on the screen. Publishing creates a new version through D's publish path containing only accepted and reworded items.

## 8. Error handling

- A document whose tracked changes cannot be read is reported by name, with the diff fallback offered explicitly rather than substituted silently.
- A chain the user rejects is ungrouped, not re-proposed.
- Zero inferred positions is a real outcome and says so ("the redlines did not settle anything we could state as a position"), not an empty screen.
- Discarding a learning session or a changeset confirms first.
- A publish that fails leaves the changeset intact with its decisions recorded — the review work is the expensive part and must not be lost to a write failure.

## 9. Testing

| Suite | Covers |
|---|---|
| `docxRedlines` | insertions, deletions and comments parsed with their context; a file with no tracked changes reports so rather than returning empty |
| `chainDetection` | a filename/date chain is proposed; an ambiguous document is left `unknown` and never auto-assigned; a rejected chain stays ungrouped |
| `inference` | strength computed from counts, never from the model; contradiction set when the basis disagrees; **silence never produces a position** |
| `openQuestions` | an un-amended universal clause becomes a question, not a position |
| `changeset` | classification into confirm/drift/new_clause; publish includes only accepted and reworded items; a declined item never reaches the version |
| `publish` | publishing goes through D's path and produces an immutable version; a failed publish preserves every decision |

Mutation-test: the strength computation, the never-guess-from-silence rule, and the accepted-subset-only publish.

## 10. Definition of done

1. `tsc --noEmit` clean; tests pass; build clean.
2. Both spikes are reported, with their findings folded back into this spec before the implementation tasks run.
3. A set of precedent documents can be brought in, chained, and role-tagged, with anything ambiguous asked rather than assumed.
4. Tracked changes are read and attributed, and a document without them falls back visibly rather than silently.
5. Positions are inferred with strength computed from counts, each with a basis naming its documents.
6. A contradicted position says the redlines disagree and requires a deliberate decision.
7. Something the redlines cannot settle appears as an open question, never as a position.
8. The workings show real redline text with deletions struck and insertions underlined.
9. A changeset classifies a new deal against a live version, and publishing produces a new version containing only what was accepted.
10. Verified in a browser with a real key on genuine tracked-changes documents.

## 11. Risks

**This is the highest-risk sub-project in the redesign, and the digest says so.** Two of its foundations are unproven in this codebase. The spikes exist so that is discovered in an afternoon rather than in week three.

**Inference from small samples is the feature's central hazard.** Four documents is not a sample size, and the app must never let a `weak` position wear the same clothes as a `consistent` one. Strength being computed in code rather than requested from the model is the structural defence.

**Silence is the subtle failure.** "Never amended" reading as "accepted" would quietly write a position the firm never held into an instrument every future review runs against. It is called out in §2, tested in §9, and mutation-tested — because it is the one that would be easiest to get wrong and hardest to notice.

**Precedent documents are read but not stored.** That is a deliberate promise the UI makes. It has to be true in the implementation, not just in the copy.
