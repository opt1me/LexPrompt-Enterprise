# Spike 2 — Is a text diff over `parsePdf` output good enough to locate which clause changed?

**Date:** 2026-08-27
**For:** sub-project F (`docs/superpowers/specs/2026-08-27-redesign-f-learning-from-redlines.md` §3)
**Status:** Answered. **Go**, with two mandatory preprocessing steps and a confidence label.
**Method:** the real extracted text of `openrent_standard_ast.pdf` (41,048 chars, 20 pages) read out of the app's own IndexedDB — i.e. genuine `parsePdf` output, not a reconstruction — then a synthetic "second version" built from it with controlled perturbations, diffed by LCS over several unit choices and normalisations.

---

## Finding 0 — `parsePdf` output has no line structure, so a line diff is impossible

The 20-page document extracts to **61 lines, 40 of them non-empty**, with a median non-empty line length of **217 characters** and a 90th percentile of **3,483** (max 4,055). A "line" is a page or a large block, not a visual line. There are 320 runs of two-or-more spaces — pdfjs joins text items with variable spacing rather than preserving layout.

So the unit of comparison **must** be sentence- or clause-level. A line-level diff over this output would mark an entire page as changed for a one-word amendment, which is not "locating which clause changed" in any useful sense. Rule that approach out before it is tried.

Sentence splitting on `/(?<=\.)\s+(?=[A-Z0-9"“(])/` after stripping `[Page N]` markers yields **214 units** for this document — a workable granularity.

## Finding 1 — results

Three genuine clause edits were planted. Perturbations were layered to simulate a re-typeset second version. Recall is "did the diff flag all three real edits".

| # | Second version differs by | Normalisation | Units flagged | Precision | Recall |
|---|---|---|---|---|---|
| A | whitespace reflow only | collapse whitespace | 3 | **1.00** | **1.00** |
| B | + hyphenation at new line breaks | collapse whitespace | 78 | 0.038 | 1.00 |
| C | + hyphenation | collapse **and de-hyphenate** | 3 | **1.00** | **1.00** |
| D | + inserted headings, + deleted sentences | collapse whitespace | 85 | 0.035 | 1.00 |
| E | full (all of the above) | collapse **and de-hyphenate** | 10 | 0.30 | **1.00** |

## Finding 2 — recall is 1.00 in every scenario

A changed sentence always differs from its predecessor, so a text diff **never misses an amended clause**. This is the property that actually matters for F: the diff does not have to understand the change, only point at it — the model then reads the clause text. A tool that over-flags is triaged; a tool that under-flags silently omits an amendment, which is the failure this project cannot ship.

## Finding 3 — two preprocessing steps are mandatory, and one is not obvious

- **Collapse whitespace.** Without it, precision is ~0.03. pdfjs's variable multi-space runs mean that essentially every sentence differs between two renderings of the same text. This one is predictable.
- **De-hyphenate across line breaks.** This is the non-obvious one: hyphenation *alone*, with whitespace already collapsed, drops precision from **1.00 to 0.038** (row B). A word broken as `pro-\nvided` in one typesetting and not the other makes its whole sentence differ. Anyone implementing this who normalises whitespace and stops will conclude that PDF diffing does not work, and they will be wrong.

Both are cheap, order-independent string operations. Neither needs a library.

## Finding 4 — the residual false positives are real changes, not phantoms

In the realistic case (row E) 10 units are flagged for 3 planted edits. The other 7 are the **inserted headings** and the neighbours of the **deleted sentences** — genuine structural differences between the two documents, not artefacts. "Precision 0.30" therefore understates the method: nothing was flagged that is actually identical in both documents.

That distinction matters for how F presents this. The honest label is not "70% of these are wrong", it is **"these places differ; some are amendments and some are re-typesetting"** — which is exactly why the next stage is a model reading the clause, and exactly why F §4 requires a confidence label on anything derived this way.

---

## Recommendation

**Go.** The PDF-pair fallback is viable for its actual job — pointing at the clauses that changed so a model can read them.

Requirements for the implementation:

1. **Sentence-level units. Never line-level.** (Finding 0.)
2. **Normalise before comparing: collapse whitespace *and* de-hyphenate across line breaks.** Both, not either. (Finding 3.)
3. **Compare against `doc.text`, not `usableText` output.** CLAUDE.md's existing rule applies — `usableText` strips `[Page N]` markers and drops sparse pages, so it cannot be used where page fidelity matters, and a diff needs to say *where* a change is.
4. **Attach a confidence label distinguishing this path from tracked changes.** A tracked-changes read knows an edit was made and by whom; a PDF diff knows only that two documents differ at this point. F §2's rule ("frequency is evidence, not proof, and the app must say which it has") applies just as much to *how* a difference was detected. A position inferred from a PDF diff must never be presented with the same confidence as one read from a `<w:del>`.
5. **Say when the diff was structural.** If a flagged unit has no counterpart at all (an inserted heading, a deleted clause), report it as a structural difference rather than an amendment, so the model is not asked to explain a change that is really a re-typesetting.

## What this does NOT establish

Stated plainly, because a spike that overclaims is worse than one that reports less.

- **The second version was synthetic** — derived from the first with controlled perturbations. No genuine pair of "same lease, two drafts" PDFs was tested, because none is available in the repo (`test_docs/` holds three unrelated agreements). Real pairs will differ in ways not modelled here: reordered schedules, renumbered clauses, different fonts changing pdfjs's tokenisation, and defined terms changed globally.
- **Sentence splitting was not stress-tested.** Legal drafting is full of `Clause 12.2.1`, `Ltd.`, `No. 4` and quoted definitions ending in a full stop. The regex used here is adequate for measuring diff behaviour but is **not** the splitter F should ship without its own tests.
- **Scans were not tested.** A scanned second version has no text layer; the whole approach is unavailable there and must decline honestly rather than diff empty text against real text — which would flag every clause as deleted.
- **No reordering case.** LCS handles insertion and deletion; a moved schedule will read as a large deletion plus a large insertion. Whether that matters depends on F's UI and is worth checking before relying on it.
- **Cost was not measured.** LCS is O(n·m); at 214 units it is instant, but a 200-page lease at ~2,000 units is 4M cells per pair. Fine, but worth a bound rather than an assumption.

## Effect on F's spec

§3's second gating question is closed. The fallback is viable, so F's scope does not narrow — but F must carry the confidence label of requirement 4 into its data model, and the "never guess a position from silence" rule in F §2 now has a concrete second application: **a PDF pair that cannot be diffed (a scan) yields no positions at all, not an empty set of changes.**
