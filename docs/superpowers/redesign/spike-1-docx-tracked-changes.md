# Spike 1 — Can `mammoth` reach DOCX tracked changes?

**Date:** 2026-08-27
**For:** sub-project F (`docs/superpowers/specs/2026-08-27-redesign-f-learning-from-redlines.md` §3)
**Status:** Answered. **No** — and the answer exposes a live defect in the shipped app, unrelated to F.
**Method:** mammoth 1.12.1 source inspection, then a real `.docx` built with `<w:ins>`, `<w:del>` and a margin comment, run through the repo's own mammoth. Throwaway script and sample retained in the session scratchpad, not the repo.

---

## The answer

**`mammoth` cannot reach tracked changes, and it drops them silently.**

From `node_modules/mammoth/lib/docx/body-reader.js`:

- **Line 434:** `"w:ins": readChildElements` — an insertion's children are read straight through. Inserted text appears in the output as ordinary text, with nothing marking it as an insertion.
- **Line 711:** `"w:del": true` inside the `ignoreElements` map — a deletion is discarded. That map is specifically the list of elements that are dropped *without* the "An unrecognised element was ignored" warning mammoth emits for anything else, so there is no diagnostic either.
- **Lines 709–710:** `"w:commentRangeStart"` and `"w:commentRangeEnd"` are in the same map. Margin comments are unreachable by the same route.

Confirmed empirically. Input paragraph:

> Consent may be ~~withheld at the Landlord's absolute discretion~~<ins>withheld only where it is reasonable to do so</ins>.

plus a second paragraph carrying a margin comment reading "We never accept an uncapped costs indemnity."

Both `extractRawText` and `convertToHtml` returned:

```
"Consent may be withheld only where it is reasonable to do so.\n\nThe Tenant shall pay all costs.\n\n"
messages: []
```

| | result |
|---|---|
| deleted text present | **no** |
| inserted text present | yes — **indistinguishable from ordinary text** |
| comment text present | **no** |
| markup distinguishing an insertion | **none** |
| warning or message of any kind | **none** |

mammoth produces the *accepted-changes* view of the document and says nothing about having done so.

---

## The part that is not about sub-project F

`src/lib/documents.ts:149` parses **every** `.docx` the app ingests with `mammoth.extractRawText`. So today, in the shipped product:

> A lawyer uploads a marked-up draft. LexPrompt reads it with every deletion removed and every insertion silently accepted, reviews *that* text, and tells them what the contract says — without ever mentioning that what it read is not what is in front of them.

That is this project's founding failure verbatim: *something incorrect, incomplete or stale presented as if it were correct and complete*. It belongs on CLAUDE.md's list beside "a scanned PDF reviewed by a text-only model returning 'the agreement is silent on this point'", and it is worse in one respect — a scan at least yields visibly empty text, whereas this yields fluent, plausible, wrong text.

It is also **not hypothetical for the target user**. Contract review is where marked-up drafts live; a firm reviewing a counterparty's redline is the normal case, not an edge one.

**This should be fixed before F, and independently of F.** F needs to *read* tracked changes; the app needs, first, to stop pretending they are not there.

---

## Recommendation

### Now, and separately from F: detect and say so

Minimum honest behaviour: at ingest, detect whether a `.docx` contains tracked changes or comments, and if it does, surface it the way the app already surfaces a scan it cannot read — a specific, loud, non-blocking warning on the document, carried into the review so a reader meets it beside the findings.

Wording should say what was actually done, not merely that something was found:

> This document contains tracked changes. The text reviewed below is the document **with all changes accepted** — deletions were removed and insertions treated as final. Review the original if the markup matters.

Detection is a substring test for `<w:ins ` / `<w:del ` / `<w:commentRangeStart` in `word/document.xml`. It needs an unzip.

**Dependency note.** `jszip@3.10.1` is already in `node_modules` as a transitive dependency of `docx`, but is **not declared** (ruling R-B7 flagged exactly this and recommended closing it at integration). Using it in app code means declaring it properly — `npm install jszip` — which rewrites the lockfile. That is a deliberate step, not a side effect, and it was not taken while another agent held the tree.

The alternative — hand-rolling a zip central-directory read over `DecompressionStream('deflate-raw')` — avoids ~100 KB of bundle in the ingest path but replaces a maintained library with fiddly binary parsing in an app whose whole discipline is "do not be subtly wrong". **Recommend declaring `jszip`.** Ingest already lazy-loads pdfjs (479 KB) and mammoth; the marginal cost is not the deciding factor, and the correctness is.

### For F: read the OOXML directly

Going through the zip is not merely acceptable, it is the only route. It is also **more proportionate than it sounds**:

- `<w:ins>` and `<w:del>` are well specified (ECMA-376 Part 1, §17.13.5), stable across Word versions, and carry `w:author` and `w:date` attributes — which F's spec needs anyway for its basis list and chain detection.
- Deleted text lives in `<w:delText>`, not `<w:t>`, so insertions and deletions are trivially separable rather than needing reconstruction.
- `word/comments.xml` is a flat list of `<w:comment>` keyed by `w:id`, joined to the body by `<w:commentRangeStart/End>` — exactly the shape F §4.3 wants ("insertions, deletions, and margin comments, attributed to the document and clause they came from").
- The same read yields the *original* text (base + `delText`) and the *final* text (base + `ins`) from one pass, which is what F §4.7 ("the workings": deletions struck and insertions underlined in the same sentence) needs to render.

So F does **not** need a general OOXML parser. It needs one function over one XML part, returning per-paragraph runs tagged `kept | inserted | deleted` plus a comment list. That is a well-bounded unit with a clear interface, and it is testable without a browser using exactly the synthetic `.docx` this spike built.

**Verdict: go.** F §5–6's assumption that tracked changes are reachable holds — via the zip, not via mammoth. F's spec does not need to narrow.

---

## What this changes in F's spec

- §3 Spike 1's open question is closed: mammoth flattens; read the OOXML.
- Add to F's scope, or split out ahead of it: the ingest-time detection and warning described above. F's spec assumed the app's existing DOCX handling was neutral about tracked changes. It is not — it actively discards them — and anything F builds on top of that path inherits the problem.
- F's `PrecedentDocument.role` inference gains a real signal it can use honestly: a document containing `<w:ins>`/`<w:del>` authored by someone is *evidence* of `our-markup` or `their-draft`, and `w:author` is available. Still proposed, never assumed (F §4.2), but it is a better basis than filename heuristics.

## What was NOT established

- Nothing here measures how *well* a model reads a paragraph rendered as struck-plus-inserted text. That is a prompt-quality question for F's implementation, not a feasibility question.
- Word's `w:moveFrom`/`w:moveTo` (a move recorded as a paired delete/insert) was not tested. It should be treated as a known gap in F's first implementation and named in the UI rather than silently mis-rendered as an unrelated deletion and insertion.
- Spike 2 (PDF-pair diffing) is untouched and still gates the no-tracked-changes fallback.
