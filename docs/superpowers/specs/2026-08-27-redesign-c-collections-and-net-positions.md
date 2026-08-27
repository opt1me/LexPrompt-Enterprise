# Redesign sub-project C — Collections and net positions

**Date:** 2026-08-27
**Status:** Approved for planning (owner authorised proceeding through the whole redesign without check-ins)
**Builds on:** sub-project A (persistence and matters) and sub-project B (verified findings and attributed citations)
**Source handoff:** `design_handoff_lexprompt_redesign/`, digested to `docs/superpowers/redesign/`
**Rulings without owner review:** `docs/superpowers/redesign/rulings.md`

## 1. What this sub-project is for

A lease is rarely one document. It is a lease, a deed of variation, a licence to alter, and a side letter, and the answer to "what is the break date?" is in none of them individually — it is in all of them, read in order.

Today LexPrompt reviews each document independently and produces one row per document. Ask it about the break date across a lease and its deed of variation and it will tell you, confidently and separately, two different answers. Both are correct about their own document. Neither is the answer.

This sub-project adds the object that fixes that — a **collection**: one base document plus the documents that amend it, read together as one source. And it adds the thing a collection produces — a **net position** per clause: the model proposes what the documents, read in order, actually say now, and a human confirms it before anything relies on it.

It also draws a distinction the app has never drawn. A portfolio of eleven separate tenancy agreements is not a collection; it is eleven documents that happen to share a playbook, and the right surface for it is a comparison grid where risk reads down a column and verification reads across a row. Those are two genuinely different jobs, and the redesign is right that conflating them is why today's tabular view serves neither well.

## 2. The rule this sub-project inherits and extends

Sub-project B established: **nothing leaves the app claiming to be checked when it isn't.**

A net position is the sharpest possible test of that rule. It is a *synthesis* — text no document contains, assembled by a model from several documents, describing the legal position a lawyer will act on. If any output in this app must never be presented as fact until a human has said so, it is this one.

So the same discipline applies, deliberately mirrored so the two cannot drift:

- A net position starts **unconfirmed** and says so, everywhere it appears.
- Only a human confirms it. Nothing derives confirmation from the model's confidence, from the number of documents, or from the clause being low-risk.
- **Re-running a clause resets its net-position confirmation**, exactly as it resets a verification. A confirmation attached to superseded synthesis is the same lie in a more dangerous place.
- An unconfirmed net position exports **labelled**, never blocked and never silently.

## 3. Scope

**In:**

1. **`Collection`** — an ordered set of documents, one `base` and N `varies`, belonging to a matter.
2. **Document roles** — `DocumentRecord` gains `role: 'base' | 'varies' | 'standalone'` and `collectionId?`, plus an optional `documentDate` that orders a variation trail.
3. **Grouping and ungrouping** in the matter home: select documents, make a collection, name it, set the base, order the rest. Ungrouping returns every member to `standalone` and never deletes a document.
4. **Suggested grouping** — a filename-and-date heuristic that *proposes* a collection and never creates one. The user confirms or dismisses.
5. **Collection-aware extraction** — one model call per clause over the collection's combined, document-labelled text, returning per-document citations and a proposed net position.
6. **`NetPosition`** — the proposal, its confirmation state, who confirmed and when, and an amended text where the human rewrote it.
7. **The variation trail** — original, varied-by, net: a readable derivation with each step's own quote and citation, and the confirm/amend action on the terminal card.
8. **Export honesty for net positions** — DOCX and CSV both mark an unconfirmed net position, and both carry the derivation, not just the conclusion.
9. **The comparison grid rebuilt** — today's `TabularReview` becomes a triage surface for genuinely separate documents: a sentence per cell, verification and risk both visible and never conflated, a risk mini-bar per clause column, and "open in review" as the handoff.

**Out, and belonging to later sub-projects:** standard positions and deviation evaluation (D); playbook versioning, the authoring wizard, changesets (D); learning from redlines (E).

**Out and staying out:** the intake wizard as a whole screen (`1f`), mobile layouts, the visual reskin, and the `Compare` segmented-control tab — which the handoff names but never draws, and which cannot be specified from a name (see §11).

**Unchanged and not to be touched:** `src/lib/citations.ts`'s matcher, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/citationPage.ts`, `src/lib/verification.ts`, `PdfCanvas`, and `src/features/assistant/`.

## 4. Why B had to come first

`Citation` already carries `documentId`. That is not incidental — it is the whole reason collection-aware extraction is expressible at all. A single model call over four documents returns evidence from several of them at once, and without a document id on each quote there is no way to say which document each piece of evidence came from, no way to highlight it in the right viewer tab, and no way to build a derivation.

Sub-project B put that field there for this.

## 5. Data model

```ts
interface Collection {
  id: string;
  matterId: string;
  name: string;              // "Lease as varied"
  baseDocumentId: string;
  /** The amending documents, in the order they take effect. Ordered
   *  explicitly rather than derived from `documentDate`, because a date can
   *  be missing, wrong, or ambiguous, and the order is a legal judgement. */
  variesDocumentIds: string[];
  createdAt: number;
  createdByUserId: string;
}

type NetPositionState = 'unconfirmed' | 'confirmed';

interface NetPosition {
  /** The model's synthesis: what the documents, read in order, say now. */
  proposed: string;
  /** Set when a human rewrote it. When present this is what is shown and
   *  exported; `proposed` is kept so the trail can show what was changed. */
  amended?: string;
  state: NetPositionState;
  byUserId?: string;
  at?: number;
  /** One step per document that contributed, in effect order. The trail is
   *  the argument for the conclusion; a net position without it is an
   *  assertion. */
  trail: TrailStep[];
}

interface TrailStep {
  documentId: string;
  /** 'original' for the base, 'varies' for each amendment. */
  kind: 'original' | 'varies';
  /** What this document says on this clause, in the model's words. */
  effect: string;
  citations: Citation[];
}
```

`Finding` gains one optional field:

```ts
  /** Present only on a finding produced by a collection-aware run. A
   *  finding over a standalone document has no net position and must not be
   *  given an empty one — absence means "this question did not arise", and
   *  an empty net position would read as "we tried and found nothing". */
  netPosition?: NetPosition;
```

`DocumentRecord` gains:

```ts
  role: 'base' | 'varies' | 'standalone';
  collectionId?: string;
  /** The date the document takes effect, where it could be read from the
   *  document or was entered by the user. Absent rather than guessed. */
  documentDate?: number;
```

`Review` gains a target discriminator, replacing the bare `documentIds`:

```ts
  target:
    | { kind: 'documents'; documentIds: string[] }
    | { kind: 'collection'; collectionId: string; documentIds: string[] };
```

`documentIds` is retained inside both arms rather than removed. Every existing consumer — the viewer's tab strip, the exporters, the hydration path in `App.tsx` — needs the flat list, and a collection review needs it too. A read-time migration turns a stored `documentIds` into `{ kind: 'documents', documentIds }`, following sub-project B's `migrateReviewRecord` exactly and extending the same function rather than adding a second one.

`SCHEMA_VERSION` bumps 4 → 5.

## 6. Collection-aware extraction

This changes the extraction contract, and it is the riskiest part of the sub-project.

**One call per clause, not one per clause per document.** The documents are read together because that is the only way the answer emerges. Sending them separately and merging afterwards would be a second, worse synthesis step with no evidence to work from.

**The prompt labels every document.** Each document's text is introduced by its name, its role, and its date where known, so a citation can be attributed and an effect can be ordered:

```
DOCUMENT 1 (BASE) — "Lease.pdf", dated 12 March 2019
<text>

DOCUMENT 2 (VARIES) — "Deed of Variation.pdf", dated 4 June 2024
<text>
```

**The response is a trail, not a paragraph.** The model returns, per clause: one `effect` and its citations per contributing document, plus a proposed net position. A model that returns only a conclusion is returning an assertion, and the schema does not permit it.

**Citations attribute themselves.** Each returned citation names the document it came from by its number, which `repairCitations` maps back to a real `documentId`. A citation naming a document that was not in the call is dropped — attributing evidence to the wrong document is worse than losing it. A citation with a valid quote but an unreadable document number is attributed to the document whose text actually contains the quote, which the app can check for itself with `normalizeForMatch`; only where that also fails is the citation dropped.

**The context budget is the hard constraint.** Four documents in one call is four times the text. `contextBudgetChars` already exists and already tells the model plainly when text was truncated. That machinery is reused unchanged, with one addition: when a collection cannot fit, the app says which documents were truncated, by name. "The deed of variation was cut short" is actionable; "the text was truncated" is not.

**A collection whose base document is unreadable fails the clause, loudly.** The existing `assessDocument` decline is per-document; for a collection the rule is that a missing base is fatal to the synthesis (there is nothing to vary), while a missing amendment produces a net position explicitly marked as derived from an incomplete set. Neither silently proceeds.

## 7. Screens

**Matter home** gains a collection card in the documents list — name, base row, varies rows in effect order, and `Ungroup`. Selecting two or more standalone documents offers `Group as a collection`. Where the filename heuristic finds a likely group, a dismissible suggestion appears above the list; it never groups anything on its own.

**The review workspace**, when the review targets a collection: the document pane gains one tab per member document, and a finding with a net position shows the net position first — with its state chip — above the evidence, with `See the variation trail`.

**The variation trail** is a modal over the review: a vertical timeline of `original` and `varies` steps, each with its document, date, effect and quoted citation, terminating in the net position card with `Confirm` and `Amend`. Confirming records who and when. Amending opens the text for editing and marks the result as amended-by-a-human, which is a stronger claim than confirmed, not a weaker one.

**The comparison grid** replaces today's `TabularReview` for `{ kind: 'documents' }` reviews: one row per document, one column per clause, a full sentence per cell, a `StateChip` and `RiskChip` per cell (never merged), a risk mini-bar in each column header, and `Open in review` as the way out of triage into the ledger. A collection review does not get a grid — there is one position, not a comparison — and asking for one says so rather than rendering an empty table.

## 8. Error handling

- A collection whose base document was deleted renders as broken with its members intact and an explicit repair action (choose a new base, or ungroup). It never silently promotes an amendment to base.
- A net position write that fails must surface and must not leave a confirmed state on screen — the await-then-apply rule from sub-project B, reused, not reimplemented.
- A trail step naming a document not in the collection is dropped with a visible note, not rendered against the wrong document.
- Ungrouping never deletes documents. Deleting a collection never deletes documents. Deleting a *matter* still deletes everything in it, as sub-project A established.
- Load paths use `describeLoadError`/`LoadErrorPanel`.

## 9. Testing

| Suite | Covers |
|---|---|
| `collections` | create, name, set base, reorder varies, ungroup; ungroup leaves documents intact; deleting a collection leaves documents intact |
| `collectionPrompt` | document labelling, effect ordering, truncation naming the truncated document |
| `collectionExtraction` | trail returned per document; citation-to-document attribution; a citation naming an absent document is dropped; a citation with an unreadable number is recovered by quote match |
| `netPosition` | starts unconfirmed; confirm records who and when; amend supersedes proposed and is marked as such; **re-run resets to unconfirmed** |
| `reviewTarget` migration | a stored `documentIds` becomes `{ kind: 'documents' }`; a collection review round-trips |
| `export` | an unconfirmed net position is labelled in both DOCX and CSV; the trail is exported, not just the conclusion |
| `comparisonGrid` | a cell shows state and risk separately; a collection review is refused a grid with an explanation |

Mutation-test: the re-run reset, the citation-to-document attribution, and the unconfirmed export label.

## 10. Definition of done

1. `tsc --noEmit` clean; tests pass; build clean.
2. Two documents can be grouped into a collection with a base and an ordered amendment, and ungrouped again with both documents intact.
3. A review over a collection produces, per clause, a trail with one step per contributing document and a proposed net position.
4. Each citation in that trail highlights in the correct document's viewer tab.
5. A net position can be confirmed, and amended, and both survive a full reload with attribution.
6. Re-running a clause resets its net position to unconfirmed and says so visibly.
7. A DOCX and a CSV export both label an unconfirmed net position and both carry the derivation.
8. A portfolio of separate documents opens in the rebuilt comparison grid with verification and risk shown separately per cell.
9. Verified in a browser with a real key on a genuine base-plus-variation pair: run, read the trail, confirm one net position, amend another, reload, export, and read both in the exported file.

## 11. Risks

**The extraction contract changes.** Sub-projects A and B moved data underneath the run engine without touching it. This one changes what a run *asks for*. It is the first time `runReview`'s contract genuinely moves, and the existing per-document path must keep working untouched alongside it — a standalone review must produce byte-identical findings to today.

**Synthesis is the app's most dangerous output.** A net position is text no document contains, describing a legal position. Everything in §2 exists because of that, and the confirm-before-relying rule is not negotiable for a demo or for convenience.

**Context budget.** Four documents in one call will exceed smaller models. The failure must be legible — naming the truncated document — because a silently truncated deed of variation produces a net position that is confidently wrong about exactly the thing the user grouped the documents to find out.

**The `Compare` tab cannot be specified.** The handoff names a `Review / Compare / Report` segmented control and draws only `Review`. `Compare` is left out of this sub-project rather than invented; building a guess at a named-but-undrawn screen is how a redesign acquires a feature nobody asked for.
